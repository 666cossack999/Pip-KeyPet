#!/usr/bin/env python3
"""Apply a narrow, fail-closed fix to the pinned Waveshare 1.75C BSP v3.0.0.

The codec driver uses 8-bit I2C addresses (0x80 -> 7-bit 0x40, 0x82 -> 0x41).
The vendor BSP v3.0.0 hardcodes 0x80. Some C boards, including our logged board,
have an ES7210 answering only at 0x41. This build-time patch selects the real
address on the existing I2C bus without copying/replacing the full BSP.

Run AFTER ESP-IDF component resolution ('idf.py reconfigure') and BEFORE build.
If upstream changes the expected source, fail rather than silently flashing
an image that will reboot due to the BSP's assert on codec initialization.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = (
    ROOT / "firmware" / "managed_components"
    / "waveshare__esp32_s3_touch_amoled_1_75c"
    / "esp32_s3_touch_amoled_1_75c.c"
)

ORIGINAL = "#define BSP_ES7210_CODEC_ADDR ES7210_CODEC_DEFAULT_ADDR"
PATCHED = """/* Pip-KeyPet: select the strapped ES7210 I2C address, don't assume 0x40.
 * esp_codec_dev uses 8-bit addresses; i2c_master_probe uses 7-bit addresses.
 * A Waveshare 1.75C board was observed at 0x41, not the BSP's default 0x40.
 * Keep compatibility with 0x40 variants. */
static int bsp_pip_es7210_address(i2c_master_bus_handle_t bus)
{
    if (i2c_master_probe(bus, 0x41, 50) == ESP_OK) return 0x82;
    if (i2c_master_probe(bus, 0x40, 50) == ESP_OK) return 0x80;
    return ES7210_CODEC_DEFAULT_ADDR;
}
#define BSP_ES7210_CODEC_ADDR bsp_pip_es7210_address(i2c_handle)"""


def patch(text: str) -> str:
    if PATCHED in text:
        return text  # idempotent
    if text.count(ORIGINAL) != 1:
        raise ValueError("Waveshare BSP audio codec definition changed; review before building")
    return text.replace(ORIGINAL, PATCHED, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error(f"Managed BSP missing: {args.source}. Run idf.py reconfigure first.")
    original = args.source.read_text(encoding="utf-8")
    modified = patch(original)
    if modified != original:
        args.source.write_text(modified, encoding="utf-8")
    print("Waveshare 1.75C ES7210 address detection: enabled for 0x40 / 0x41")


if __name__ == "__main__":
    main()
