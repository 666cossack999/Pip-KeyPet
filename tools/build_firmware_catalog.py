#!/usr/bin/env python3
"""Publish a same-origin GitHub Pages firmware catalog from successful CI artifacts.

Runs only from the trusted main-branch Pages workflow. Pull-request artifacts are
treated as untrusted *data*: JSON payloads are parsed/validated, never executed.
Only successful builds of the CURRENT PR head are listed as previews.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

MAX_ARTIFACT = 100 * 1024 * 1024
MAX_PART = 32 * 1024 * 1024
MARKER = "window.PIP_FIRMWARE = "
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$")


def validate_firmware(content: str) -> dict:
    """Parse a generated JS artifact without evaluating arbitrary JavaScript."""
    start = content.find(MARKER)
    if start < 0:
        raise ValueError("Missing PIP_FIRMWARE marker")
    payload = content[start + len(MARKER):].strip()
    if not payload.endswith(";"):
        raise ValueError("Firmware JS is not terminated by a semicolon")
    try:
        fw = json.loads(payload[:-1])
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid firmware JSON") from exc
    if not isinstance(fw, dict) or not isinstance(fw.get("version"), str) or not VERSION_RE.fullmatch(fw["version"]):
        raise ValueError("Invalid firmware version")
    if not isinstance(fw.get("parts"), list) or not 3 <= len(fw["parts"]) <= 8:
        raise ValueError("Invalid flash parts count")
    addresses = set()
    for part in fw["parts"]:
        if not isinstance(part, dict) or not isinstance(part.get("address"), int) or isinstance(part["address"], bool):
            raise ValueError("Invalid flash address")
        addr = part["address"]
        if addr < 0 or addr >= 0x2000000 or addr in addresses:
            raise ValueError("Duplicate or out-of-range flash address")
        addresses.add(addr)
        data = part.get("data")
        if not isinstance(data, str) or len(data) > MAX_PART * 4 // 3 + 8:
            raise ValueError("Invalid flash data")
        blob = base64.b64decode(data, validate=True)
        if not blob or len(blob) > MAX_PART:
            raise ValueError("Invalid binary part length")
        if addr == 0x20000 and (len(blob) < 256 or blob[0] != 0xe9):
            raise ValueError("Invalid ESP32-S3 application header")
    if 0x20000 not in addresses:
        raise ValueError("Missing application at 0x20000")
    return {"version": fw["version"], "built": str(fw.get("built", ""))[:30], "parts": fw["parts"]}


class Github:
    def __init__(self, repo: str, token: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError("Invalid GH_REPO")
        self.repo, self.token = repo, token

    def get(self, resource: str, binary=False):
        url = f"https://api.github.com/repos/{self.repo}/{resource}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pip-keypet-firmware-catalog",
        })
        with urllib.request.urlopen(req, timeout=60) as response:
            if binary:
                data = response.read(MAX_ARTIFACT + 1)
                if len(data) > MAX_ARTIFACT:
                    raise ValueError("CI artifact is too large")
                return data
            return json.load(response)

    def successful_run(self, branch: str, sha: str | None = None):
        query = urllib.parse.urlencode({"branch": branch, "status": "success", "per_page": 100})
        runs = self.get(f"actions/workflows/release.yml/runs?{query}").get("workflow_runs", [])
        for run in runs:
            if run.get("conclusion") == "success" and (sha is None or run.get("head_sha") == sha):
                return run
        return None

    def firmware_for_run(self, run: dict):
        artifacts = self.get(f"actions/runs/{run['id']}/artifacts?per_page=100").get("artifacts", [])
        artifact = next((a for a in artifacts if a["name"] == "pip-keypet-firmware" and not a.get("expired")), None)
        if not artifact:
            raise ValueError(f"No live firmware artifact for run #{run['id']}")
        zipped = self.get(f"actions/artifacts/{artifact['id']}/zip", binary=True)
        with zipfile.ZipFile(BytesIO(zipped)) as archive:
            paths = [s for s in archive.namelist() if Path(s).name == "firmware.js"]
            if len(paths) != 1:
                raise ValueError("Expected exactly one firmware.js in CI artifact")
            content = archive.read(paths[0]).decode("utf-8")
        return validate_firmware(content), content


def build_catalog(api: Github, site: Path, max_previews: int = 10):
    """Return published catalog; mutate site only after stable artifact validates."""
    stable_run = api.successful_run("main")
    if not stable_run:
        raise ValueError("No successful main firmware build: keep previous Pages deployment")
    stable_fw, stable_js = api.firmware_for_run(stable_run)

    site_fw = site / "firmware"
    previews = site_fw / "previews"
    previews.mkdir(parents=True, exist_ok=True)
    for old in previews.glob("pr-*.json"):
        old.unlink()
    (site_fw / "firmware.js").write_text(stable_js, encoding="utf-8")
    catalog = {
        "schema": 1,
        "versions": [{
            "id": "stable",
            "label": "Стабильная (main)",
            "version": stable_fw["version"],
            "commit": stable_run.get("head_sha", "")[:12],
            "experimental": False,
            "file": None,
        }],
    }
    open_prs = api.get("pulls?state=open&per_page=100")
    previews_added = 0
    for pr in open_prs:
        if previews_added >= max_previews:
            break
        if (pr.get("head", {}).get("repo") or {}).get("full_name") != api.repo:
            continue  # never publish a build of a third-party fork as a trusted preview
        head = pr["head"]
        run = api.successful_run(head["ref"], head["sha"])
        if not run:
            print(f"Skip PR #{pr['number']}: no green build for current head")
            continue
        try:
            fw, _ = api.firmware_for_run(run)
        except (ValueError, KeyError, urllib.error.HTTPError) as exc:
            print(f"Skip PR #{pr['number']}: {exc}")
            continue
        name = f"pr-{pr['number']}.json"
        (previews / name).write_text(json.dumps(fw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        catalog["versions"].append({
            "id": f"pr-{pr['number']}",
            "label": f"Тестовая · PR #{pr['number']}",
            "version": fw["version"],
            "commit": head["sha"][:12],
            "experimental": True,
            "pr": pr["number"],
            "branch": head["ref"],
            "file": f"firmware/previews/{name}",
        })
        previews_added += 1
    (site_fw / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Firmware catalog:", [(v["id"], v["version"], v["commit"]) for v in catalog["versions"]])
    return catalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", default="docs", type=Path)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        parser.error("GH_TOKEN is required to fetch validated CI artifacts")
    build_catalog(Github(args.repo, token), args.site)


if __name__ == "__main__":
    main()
