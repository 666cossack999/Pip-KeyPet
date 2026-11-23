#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Separate, authenticated BLE firmware OTA service. Existing HID/ANCS/debug
 * GATT handles remain stable: register OTA after the legacy services. */
void ota_ble_register(void);
void ota_ble_disconnected(uint16_t conn);
bool ota_ble_active(void);
