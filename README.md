# Pip-KeyPet

Виртуальный питомец для **Waveshare ESP32-S3-Touch-AMOLED-1.75C**: эмоции, мини-игры, уведомления iPhone, BLE, QR-визитка и настройки через браузер.

## Прошивка через браузер

**[Открыть веб-прошивальщик](https://666cossack999.github.io/Pip-KeyPet/)**

1. Подключи брелок к компьютеру кабелем USB-C с передачей данных.
2. Открой страницу в **Chrome** или **Edge** на компьютере.
3. Перейди во вкладку **«Прошить / обновить»**, нажми **«Прошить»** и выбери **USB JTAG/serial**.
4. Дождись окончания прошивки, затем открой **«Настройки»**.

Веб-прошивальщик публикуется автоматически из `main` через GitHub Actions. До первого успешного запуска Actions необходимо включить **Settings → Pages → Source: GitHub Actions**.

Для локального запуска панели скачай архив **`pip-keypet-<версия>-panel.zip`** из [Releases](https://github.com/666cossack999/Pip-KeyPet/releases), распакуй его и запусти `Pip-Windows.bat`, `Pip-Mac.command` или `Pip-Linux.sh`. Для прошивки через локальную панель требуется интернет для загрузки esptool-js с CDN (если файл ещё не закеширован браузером).

> **Внимание:** прошивка предназначена только для ESP32-S3-Touch-AMOLED-1.75C. Сохрани важные данные перед экспериментальной прошивкой. Скрипт использует раздельные образы, чтобы не перезаписывать NVS.

## Релизы

- Каждый push в `main` собирает прошивку и публикует страницу с актуальным образом.
- Тег `vX.Y.Z` запускает сборку и создаёт [GitHub Release](https://github.com/666cossack999/Pip-KeyPet/releases) с бинарниками и архивом панели.
- Версия в теге должна совпадать с `PROJECT_VER` в `firmware/CMakeLists.txt`.
- В pull request сборка проверяется, но релиз и сайт не публикуются.

Создать тег релиза после успешной проверки:
```bash
git checkout main
git pull
git tag v1.1.0
git push origin v1.1.0
```

## Разработка

```bash
git submodule update --init --recursive
# Требуется ESP-IDF 5.5
tools/release.sh
python3 tools/package-release.py
```

Исходники прошивки — `firmware/`; интерфейс — `ui/`; веб-панель — `docs/`; инструменты — `tools/`.

## License / Лицензия

MIT, см. [LICENSE](LICENSE). Уведомление об авторских правах оригинального кода сохранено в файле лицензии.

Сторонние компоненты: [LVGL](https://lvgl.io) (MIT), [esptool-js](https://github.com/espressif/esptool-js) (Apache-2.0), JetBrains Mono и IBM Plex Mono (SIL OFL), Font Awesome Free (SIL OFL / CC BY 4.0).
