/* Pip application-only BLE OTA. The original USB flasher remains the recovery path.
 *
 * GATT UUIDs (append-only service):
 * 50495044-4f54-412d-4b45-595000000001  OTA service
 * 50495044-4f54-412d-4b45-595000000002  Control: write with response
 * 50495044-4f54-412d-4b45-595000000003  Data: write with response, ordered
 * 50495044-4f54-412d-4b45-595000000004  Status: read (10 bytes)
 *
 * BEGIN (0x01) + uint32 LE image size + 32-byte SHA-256
 * FINISH (0x02), ABORT (0x03), REBOOT (0x04)
 * Status: state (0 idle, 1 receiving, 2 ready, 3 error), error code,
 *         received uint32 LE, total uint32 LE.
 *
 * Writes are acknowledged only after esp_ota_write succeeds. SHA-256 validates
 * transfer integrity; firmware authenticity additionally requires Secure Boot,
 * which is NOT enabled by this feature. An authenticated, MITM-protected BLE
 * bond is mandatory for all OTA GATT characteristics.
 */
#include "ota_ble.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_pm.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "host/ble_hs.h"
#include "mbedtls/sha256.h"
#include "shell.h"
#include <string.h>

#define OTA_NONE BLE_HS_CONN_HANDLE_NONE
#define OTA_READY 2
#define OTA_RECEIVING 1
#define OTA_ERROR 3
#define OTA_MIN_BATTERY 50
#define OTA_MAX_PACKET 512

static const char *TAG = "ota_ble";

/* UUID bytes are stored little-endian by NimBLE. */
static const ble_uuid128_t svc_uuid =
    BLE_UUID128_INIT(0x01,0x00,0x00,0x00,0x50,0x59,0x45,0x4b,0x2d,0x41,0x54,0x4f,0x44,0x50,0x49,0x50);
static const ble_uuid128_t ctl_uuid =
    BLE_UUID128_INIT(0x02,0x00,0x00,0x00,0x50,0x59,0x45,0x4b,0x2d,0x41,0x54,0x4f,0x44,0x50,0x49,0x50);
static const ble_uuid128_t data_uuid =
    BLE_UUID128_INIT(0x03,0x00,0x00,0x00,0x50,0x59,0x45,0x4b,0x2d,0x41,0x54,0x4f,0x44,0x50,0x49,0x50);
static const ble_uuid128_t status_uuid =
    BLE_UUID128_INIT(0x04,0x00,0x00,0x00,0x50,0x59,0x45,0x4b,0x2d,0x41,0x54,0x4f,0x44,0x50,0x49,0x50);

/* ble.c claims OTA peers so they cannot be mistaken for ANCS phones. */
extern void ble_ota_claim(uint16_t conn);

static struct {
    uint16_t conn;
    uint8_t state, error;
    uint32_t expected, received;
    uint8_t digest[32];
    const esp_partition_t *partition;
    esp_ota_handle_t handle;
    bool open;
    mbedtls_sha256_context sha;
    esp_pm_lock_handle_t pm_lock;
    bool pm_held;
    esp_timer_handle_t reboot;
} session = {.conn = OTA_NONE};

static uint32_t read_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void write_le32(uint8_t *p, uint32_t n)
{
    for (int i = 0; i < 4; ++i) p[i] = (uint8_t)(n >> (8 * i));
}

bool ota_ble_active(void)
{
    return session.state == OTA_RECEIVING || session.state == OTA_READY;
}

static void release_power(void)
{
    if (session.pm_held) {
        esp_pm_lock_release(session.pm_lock);
        session.pm_held = false;
    }
}

static void clear_session(void)
{
    if (session.open) {
        esp_ota_abort(session.handle);
        mbedtls_sha256_free(&session.sha);
        session.open = false;
    }
    release_power();
    session.conn = OTA_NONE;
    session.partition = NULL;
}

static int fail_update(uint8_t error)
{
    ESP_LOGW(TAG, "OTA failed: code=%u at %lu/%lu bytes",
             (unsigned)error, (unsigned long)session.received,
             (unsigned long)session.expected);
    clear_session();
    session.error = error;
    session.state = OTA_ERROR;
    return BLE_ATT_ERR_UNLIKELY;
}

static void restart_later(void *arg)
{
    (void)arg;
    esp_restart();
}

static int begin(uint16_t conn, const uint8_t *buf, uint16_t len)
{
    if (len != 37 || buf[0] != 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    if (ota_ble_active()) return BLE_ATT_ERR_UNLIKELY;
    clear_session();
    session.state = 0;
    session.error = 0;
    session.expected = read_le32(buf + 1);
    session.received = 0;
    memcpy(session.digest, buf + 5, sizeof session.digest);

    bool charging = false;
    int battery = shell_battery_level(&charging);
    if (!charging && (battery < OTA_MIN_BATTERY)) return fail_update(3);

    session.partition = esp_ota_get_next_update_partition(NULL);
    if (!session.partition || session.partition == esp_ota_get_running_partition() ||
        session.expected < 256 || session.expected > session.partition->size)
        return fail_update(2);

    if (!session.pm_lock && esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "ble_ota", &session.pm_lock) != ESP_OK)
        return fail_update(4);
    if (esp_pm_lock_acquire(session.pm_lock) != ESP_OK) return fail_update(4);
    session.pm_held = true;

    /* Erase a sector at a time while packets arrive, not the entire 4 MB
       partition up front (which can exceed BLE supervision timeout). */
    esp_err_t err = esp_ota_begin(session.partition, OTA_WITH_SEQUENTIAL_WRITES, &session.handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        return fail_update(4);
    }
    session.open = true;
    mbedtls_sha256_init(&session.sha);
    if (mbedtls_sha256_starts(&session.sha, 0) != 0) return fail_update(4);
    session.conn = conn;
    session.state = OTA_RECEIVING;
    ESP_LOGI(TAG, "OTA begin: %lu bytes, slot=%s",
             (unsigned long)session.expected, session.partition->label);
    return 0;
}

static int append(uint16_t conn, const uint8_t *data, uint16_t len)
{
    if (session.state != OTA_RECEIVING || session.conn != conn || !session.open)
        return BLE_ATT_ERR_UNLIKELY;
    if (!len || session.received + (uint32_t)len > session.expected)
        return fail_update(8);
    if (session.received == 0 && data[0] != 0xe9)
        return fail_update(7); /* not an ESP app image */

    esp_err_t err = esp_ota_write(session.handle, data, len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_write: %s", esp_err_to_name(err));
        return fail_update(6);
    }
    if (mbedtls_sha256_update(&session.sha, data, len) != 0)
        return fail_update(6);
    session.received += len;
    return 0;
}

static int finish(uint16_t conn)
{
    if (session.conn != conn || session.state != OTA_RECEIVING)
        return BLE_ATT_ERR_UNLIKELY;
    if (session.received != session.expected) return fail_update(8);

    uint8_t actual[32];
    if (mbedtls_sha256_finish(&session.sha, actual) != 0)
        return fail_update(5);
    if (memcmp(actual, session.digest, sizeof actual) != 0)
        return fail_update(5);

    esp_err_t err = esp_ota_end(session.handle);
    mbedtls_sha256_free(&session.sha);
    session.open = false;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
        return fail_update(7);
    }
    err = esp_ota_set_boot_partition(session.partition);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition: %s", esp_err_to_name(err));
        return fail_update(7);
    }
    session.state = OTA_READY;  /* keep BLE and PM awake until REBOOT */
    ESP_LOGI(TAG, "OTA verified, boot slot=%s", session.partition->label);
    return 0;
}

static int control_access(uint16_t conn, uint16_t attr,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[40];
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof buf, &len) != 0 || !len)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    ble_ota_claim(conn);
    switch (buf[0]) {
    case 1: return begin(conn, buf, len);
    case 2:
        if (len != 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        return finish(conn);
    case 3:
        if (len != 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        if (session.conn != OTA_NONE && session.conn != conn) return BLE_ATT_ERR_UNLIKELY;
        if (session.state == OTA_READY) {
            esp_ota_set_boot_partition(esp_ota_get_running_partition());
        }
        clear_session();
        session.state = session.error = 0;
        session.received = session.expected = 0;
        return 0;
    case 4:
        if (len != 1 || session.conn != conn || session.state != OTA_READY)
            return BLE_ATT_ERR_UNLIKELY;
        if (!session.reboot) {
            const esp_timer_create_args_t opts = {.callback = restart_later, .name = "ota_reboot"};
            if (esp_timer_create(&opts, &session.reboot) != ESP_OK) return fail_update(4);
        }
        return esp_timer_start_once(session.reboot, 1200000) == ESP_OK ? 0 : BLE_ATT_ERR_UNLIKELY;
    default:
        return BLE_ATT_ERR_UNLIKELY;
    }
}

static int data_access(uint16_t conn, uint16_t attr,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[OTA_MAX_PACKET];
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof buf, &len) != 0)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    return append(conn, buf, len);
}

static int status_access(uint16_t conn, uint16_t attr,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_UNLIKELY;
    ble_ota_claim(conn);
    uint8_t out[10] = {session.state, session.error};
    write_le32(out + 2, session.received);
    write_le32(out + 6, session.expected);
    return os_mbuf_append(ctxt->om, out, sizeof out) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

/* This service is registered AFTER existing HID/debug GATT services in ble.c,
 * so their numeric handles do not change for already-bonded iPhones. */
static const struct ble_gatt_svc_def ota_services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &svc_uuid.u,
     .characteristics = (struct ble_gatt_chr_def[]) {
         {.uuid = &ctl_uuid.u, .access_cb = control_access,
          .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN},
         {.uuid = &data_uuid.u, .access_cb = data_access,
          .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN},
         {.uuid = &status_uuid.u, .access_cb = status_access,
          .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN},
         {0}
     }},
    {0}
};

void ota_ble_register(void)
{
    if (ble_gatts_count_cfg(ota_services) || ble_gatts_add_svcs(ota_services))
        ESP_LOGE(TAG, "BLE OTA service registration failed");
}

void ota_ble_disconnected(uint16_t conn)
{
    if (session.conn != conn) return;
    if (session.state == OTA_RECEIVING) {
        clear_session(); /* incomplete image: previous boot slot remains selected */
        session.state = 0;
        session.error = 0;
    } else {
        session.conn = OTA_NONE; /* verified slot stays selected; manual reset will boot it */
        release_power();
    }
}
