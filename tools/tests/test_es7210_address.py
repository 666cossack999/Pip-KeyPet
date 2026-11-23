"""Regression checks for 1.75C ES7210 address detection, without hardware."""
import runpy
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATCHER = runpy.run_path(str(ROOT / "tools/patch-es7210-address.py"), run_name="test_import")
patch = PATCHER["patch"]
ORIGINAL = PATCHER["ORIGINAL"]
PATCHED = PATCHER["PATCHED"]
MAIN = (ROOT / "firmware/main/main.c").read_text(encoding="utf-8")


class MicAddressTests(unittest.TestCase):
    def test_vendor_default_address_is_patched_to_detection(self):
        generated = patch("before\n" + ORIGINAL + "\nafter")
        self.assertIn(PATCHED, generated)
        self.assertIn("i2c_master_probe(bus, 0x41, 50)", generated)
        self.assertIn("i2c_master_probe(bus, 0x40, 50)", generated)
        self.assertIn("return 0x82", generated)
        self.assertIn("return 0x80", generated)
        self.assertNotIn(ORIGINAL, generated)

    def test_idempotent(self):
        source = patch(ORIGINAL)
        self.assertEqual(patch(source), source)

    def test_upstream_code_change_aborts_build(self):
        with self.assertRaisesRegex(ValueError, "changed"):
            patch("#define BSP_ES7210_CODEC_ADDR 0x82")

    def test_guard_before_vendor_bsp_assert(self):
        method = MAIN.split("static void mic_task(void *arg)", 1)[1].split(
            "static void audio_task(void *arg)", 1)[0]
        self.assertIn("i2c_master_probe(bus, 0x40, 50)", method)
        self.assertIn("i2c_master_probe(bus, 0x41, 50)", method)
        self.assertIn("if (!mic_at_40 && !mic_at_41)", method)
        self.assertLess(method.index("if (!mic_at_40 && !mic_at_41)"),
                        method.index("bsp_audio_codec_microphone_init()"))
        self.assertIn("mic_stop();", method)
        self.assertIn("vTaskDelete(NULL);\n        return;", method)


if __name__ == "__main__":
    unittest.main()
