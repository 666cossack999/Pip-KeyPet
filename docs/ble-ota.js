// Pip BLE OTA client. Web Bluetooth only: Safari requires a compatible Web BLE
// browser (e.g. Bluefy) or extension. USB flashing is handled by docs/index.html.
export const OTA_UUID = '50495044-4f54-412d-4b45-595000000001';
const CONTROL_UUID = '50495044-4f54-412d-4b45-595000000002';
const DATA_UUID = '50495044-4f54-412d-4b45-595000000003';
const STATUS_UUID = '50495044-4f54-412d-4b45-595000000004';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PACKET = 160;

export function appImageFromRelease(firmware) {
  const part = firmware?.parts?.find(p => p.address === 0x20000);
  if (!part?.data) throw new Error('Встроенный образ приложения ota_0 не найден. Пересобери релиз.');
  const bytes = Uint8Array.from(atob(part.data), c => c.charCodeAt(0));
  if (bytes[0] !== 0xe9 || bytes.length < 256 || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Некорректный образ ESP32-S3 или размер превышает 4 МБ.');
  return bytes;
}

export function parseOtaStatus(view) {
  if (view.byteLength < 10) throw new Error('Пип вернул некорректный OTA-статус.');
  return {
    state: view.getUint8(0),
    error: view.getUint8(1),
    received: view.getUint32(2, true),
    expected: view.getUint32(6, true),
  };
}
const errors = {
  2: 'образ слишком большой или отсутствует свободный OTA-раздел',
  3: 'для обновления нужен заряд не ниже 50% или питание USB',
  4: 'не удалось подготовить OTA-раздел',
  5: 'не совпал SHA-256 образа',
  6: 'ошибка записи во Flash',
  7: 'некорректный образ прошивки',
  8: 'неполная или нарушенная передача',
};
export function otaErrorText(status) {
  return errors[status?.error] || 'неизвестная ошибка OTA';
}

async function writeAck(characteristic, data) {
  // Our OTA characteristics expose GATT WRITE, not WRITE_WITHOUT_RESPONSE.
  // A successful write is acknowledgement that ESP32 has written the packet.
  if (typeof characteristic.writeValueWithResponse === 'function')
    return characteristic.writeValueWithResponse(data);
  if (typeof characteristic.writeValue === 'function')
    return characteristic.writeValue(data);
  throw new Error('Браузер не поддерживает подтверждённую запись BLE.');
}

/** Update using the existing published app.bin (not bootloader or partition table).
 * This uses an authenticated BLE connection: confirm the same numeric code
 * on the phone and the keychain with the upper button when asked.
 */
export async function flashBleOta(firmware, progress = () => {}, notify = () => {}) {
  if (!navigator.bluetooth) throw new Error('Нужен браузер с Web Bluetooth (на iPhone — Bluefy).');
  if (!globalThis.crypto?.subtle) throw new Error('Для проверки SHA-256 открой панель по HTTPS.');
  const bytes = appImageFromRelease(firmware);
  notify('Считаю SHA-256 приложения...');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: 'Pip' }],
    optionalServices: [OTA_UUID],
  });
  if (!device) throw new Error('Брелок не выбран.');

  let begun = false;
  let finished = false;
  try {
    notify('Подключаюсь. Если появится код сопряжения, подтверди его верхней кнопкой Пипа.');
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await server.getPrimaryService(OTA_UUID);
    const ctl = await service.getCharacteristic(CONTROL_UUID);
    const data = await service.getCharacteristic(DATA_UUID);
    const stat = await service.getCharacteristic(STATUS_UUID);
    const current = parseOtaStatus(await stat.readValue());
    if (current.state === 1 || current.state === 2)
      throw new Error('На Пипе уже выполняется OTA. Заверши или отмени его перед повтором.');

    // Each control request fits the minimum BLE MTU (23 bytes).
    const begin = new Uint8Array(5);
    begin[0] = 1;
    new DataView(begin.buffer).setUint32(1, bytes.length, true);
    try {
      await writeAck(ctl, begin);
    } catch (error) {
      const state = parseOtaStatus(await stat.readValue());
      if (state.state === 3)
        throw new Error('Пип отказался начинать обновление: ' + otaErrorText(state));
      throw error;
    }
    begun = true;
    await writeAck(ctl, Uint8Array.of(5, ...digest.subarray(0, 16)));
    await writeAck(ctl, Uint8Array.of(6, ...digest.subarray(16, 32)));
    notify('Передаю прошивку. Не закрывай страницу и не выключай Пипа.');
    let offset = 0;
    let packet = DEFAULT_PACKET;
    let lastPct = -1;
    while (offset < bytes.length) {
      const end = Math.min(bytes.length, offset + packet);
      try {
        await writeAck(data, bytes.subarray(offset, end));
        offset = end;
        const pct = Math.floor(offset / bytes.length * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          progress(pct);
          notify('Передаю приложение: ' + pct + '%');
        }
      } catch (error) {
        // Some iOS Web Bluetooth bridges negotiate only MTU 23. Retry the same
        // packet in 20-byte fragments only if the larger size was rejected.
        const state = parseOtaStatus(await stat.readValue());
        if (state.state === 3) throw new Error('Пип сообщил: ' + otaErrorText(state));
        if (packet > 20 && state.received === offset) {
          packet = 20;
          notify('Маленький MTU: продолжаю пакетами по 20 байт.');
          continue;
        }
        throw error;
      }
    }
    notify('Проверяю хэш и целостность записанного приложения...');
    try {
      await writeAck(ctl, Uint8Array.of(2)); // FINISH
    } catch (error) {
      const state = parseOtaStatus(await stat.readValue());
      if (state.state === 3) throw new Error('Пип сообщил: ' + otaErrorText(state));
      throw error;
    }
    const result = parseOtaStatus(await stat.readValue());
    if (result.state !== 2 || result.received !== bytes.length)
      throw new Error('Пип не подтвердил успешную запись и проверку прошивки.');
    finished = true;
    notify('Прошивка проверена. Перезагружаю Пипа...');
    // The ESP32 schedules reboot 1.2 seconds after acknowledging this command.
    await writeAck(ctl, Uint8Array.of(4));
    progress(100);
    notify('Готово! Пип загружает новую прошивку. Подключение Bluetooth прервётся.');
  } catch (error) {
    if (begun && !finished && device.gatt.connected) {
      // If the link still works, abort the inactive OTA slot explicitly.
      try {
        const svc = await device.gatt.getPrimaryService(OTA_UUID);
        await writeAck(await svc.getCharacteristic(CONTROL_UUID), Uint8Array.of(3));
      } catch {}
    }
    throw error;
  } finally {
    // Allow the flash response and scheduled reboot to complete.
    if (device.gatt.connected && !finished) device.gatt.disconnect();
  }
}
