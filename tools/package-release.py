#!/usr/bin/env python3
"""Validate the web-flasher payload and package all address-aware flash parts."""
import base64
import hashlib
import json
import re
import shlex
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "firmware" / "build-release"
WEB = ROOT / "docs" / "firmware" / "firmware.js"
VERSION_FILE = ROOT / "firmware" / "CMakeLists.txt"

version_match = re.search(r'set\(PROJECT_VER "([^"]+)"\)', VERSION_FILE.read_text())
if not version_match:
    raise SystemExit("PROJECT_VER not found in firmware/CMakeLists.txt")
version = version_match.group(1)

tokens = shlex.split((BUILD / "flash_args").read_text())
parts = []
for i, token in enumerate(tokens[:-1]):
    if re.fullmatch(r"0x[0-9a-fA-F]+", token) and tokens[i + 1].endswith(".bin"):
        relative = Path(tokens[i + 1])
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"Unsafe flash path: {relative}")
        binary = BUILD / relative
        if not binary.is_file():
            raise SystemExit(f"Missing flash image: {binary}")
        raw = binary.read_bytes()
        parts.append({
            "address": int(token, 16),
            "file": str(relative),
            "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
if len(parts) < 3 or not any(p["address"] == 0x20000 for p in parts):
    raise SystemExit(f"Unexpected flash layout: {parts}")

js = WEB.read_text()
marker = "window.PIP_FIRMWARE = "
if marker not in js:
    raise SystemExit("Missing window.PIP_FIRMWARE")
payload = json.loads(js.split(marker, 1)[1].strip().removesuffix(";"))
if payload["version"] != version or len(payload["parts"]) != len(parts):
    raise SystemExit("Web firmware version/parts mismatch")
for binary_part, web_part in zip(parts, payload["parts"]):
    decoded = base64.b64decode(web_part["data"], validate=True)
    if (web_part["address"] != binary_part["address"]
            or hashlib.sha256(decoded).hexdigest() != binary_part["sha256"]):
        raise SystemExit(f"Web payload does not match {binary_part['file']}")

out_dir = ROOT / "dist"
out_dir.mkdir(exist_ok=True)
archive = out_dir / f"pip-keypet-{version}-flash.zip"
manifest = json.dumps({"version": version, "target": "esp32s3", "parts": parts},
                      indent=2, ensure_ascii=False)
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    zf.writestr("manifest.json", manifest + "\n")
    zf.write(BUILD / "flash_args", "flash_args")
    for part in parts:
        zf.write(BUILD / part["file"], part["file"])
panel = out_dir / f"pip-keypet-{version}-panel.zip"
with zipfile.ZipFile(panel, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for name in ("Pip-Windows.bat", "Pip-Mac.command", "Pip-Linux.sh"):
        zf.write(ROOT / name, name)
    for file in sorted((ROOT / "docs").rglob("*")):
        if file.is_file():
            zf.write(file, file.relative_to(ROOT))
print(f"Validated {len(parts)} flash parts; created {archive.name} and {panel.name}")
