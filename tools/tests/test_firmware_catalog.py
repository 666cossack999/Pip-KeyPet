"""Offline tests for Pages firmware catalog and CI artifact validation."""
import base64
import json
import tempfile
import unittest
from pathlib import Path

from tools.build_firmware_catalog import Github, build_catalog, validate_firmware


def firmware(version="1.2.0-rc1"):
    app = bytearray(1024)
    app[0] = 0xE9
    return {
        "version": version,
        "built": "2026-11-23",
        "parts": [
            {"address": 0x0, "data": base64.b64encode(bytes([0xE9] * 256)).decode()},
            {"address": 0x8000, "data": base64.b64encode(bytes(256)).decode()},
            {"address": 0x20000, "data": base64.b64encode(app).decode()},
        ],
    }


def packed(fw):
    return "/* output by trusted CI */\nwindow.PIP_FIRMWARE = " + json.dumps(fw) + ";\n"


class FakeAPI:
    repo = "666cossack999/Pip-KeyPet"

    def successful_run(self, branch, sha=None):
        if branch == "main":
            return {"id": 1, "head_sha": "abc123abc123abc1"}
        if branch == "feature/ble-ota" and sha == "123456abcdef1234":
            return {"id": 2, "head_sha": sha}
        return None

    def firmware_for_run(self, run):
        image = firmware("1.1.0" if run["id"] == 1 else "1.2.0-rc1")
        return image, packed(image)

    def get(self, url):
        if url.startswith("pulls?"):
            return [
                {"number": 3,
                 "head": {"ref": "feature/ble-ota", "sha": "123456abcdef1234",
                          "repo": {"full_name": self.repo}}},
                {"number": 4,
                 "head": {"ref": "feature/unbuilt", "sha": "unbuilt",
                          "repo": {"full_name": self.repo}}},
                {"number": 5,
                 "head": {"ref": "feature/unsafe-fork", "sha": "bad",
                          "repo": {"full_name": "outside/repo"}}},
            ]
        raise AssertionError(url)


class CatalogTests(unittest.TestCase):
    def test_parse_generated_firmware(self):
        self.assertEqual(validate_firmware(packed(firmware()))["version"], "1.2.0-rc1")

    def test_reject_arbitrary_javascript(self):
        with self.assertRaises(ValueError):
            validate_firmware(packed(firmware()) + "\nalert('xss')")

    def test_reject_duplicate_flash_address(self):
        broken = firmware()
        broken["parts"][1]["address"] = 0x20000
        with self.assertRaises(ValueError):
            validate_firmware(packed(broken))

    def test_reject_invalid_app(self):
        broken = firmware()
        broken["parts"][-1]["data"] = base64.b64encode(bytes(1024)).decode()
        with self.assertRaises(ValueError):
            validate_firmware(packed(broken))

    def test_reject_empty_part(self):
        broken = firmware()
        broken["parts"][1]["data"] = ""
        with self.assertRaises(ValueError):
            validate_firmware(packed(broken))

    def test_build_stable_and_only_green_current_pr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = build_catalog(FakeAPI(), root)
            self.assertEqual([e["id"] for e in out["versions"]], ["stable", "pr-3"])
            stable_path = root / "firmware/firmware.js"
            preview_path = root / "firmware/previews/pr-3.json"
            self.assertTrue(stable_path.is_file())
            self.assertTrue(preview_path.is_file())
            self.assertEqual(validate_firmware(stable_path.read_text())["version"], "1.1.0")
            self.assertEqual(json.loads(preview_path.read_text())["version"], "1.2.0-rc1")
            self.assertEqual(json.loads((root / "firmware/catalog.json").read_text()), out)

    def test_main_run_required(self):
        class MissingMain(FakeAPI):
            def successful_run(self, branch, sha=None):
                if branch == "main":
                    return None
                return super().successful_run(branch, sha)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "No successful main"):
                build_catalog(MissingMain(), Path(tmp))


if __name__ == "__main__":
    unittest.main()
