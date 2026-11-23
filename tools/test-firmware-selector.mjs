// CI smoke checks for firmware selector HTML/JS without a real device.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('docs/index.html', 'utf8');
const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, 'Expected exactly one main module script');
new vm.Script(scripts[0][1], {filename: 'docs/index.html inline JS'});
const ids = ['firmwareChoice','firmwareFile','firmwareSelected',
  'firmwareWarning','firmwareCatalogStatus','flash','fwinfo'];
for(const id of ids) assert.ok(html.includes('id="' + id + '"'), 'Missing UI id ' + id);
assert.ok(scripts[0][1].includes('fw = validateSelectedFirmware(value)'));
assert.ok(scripts[0][1].includes('firmware/catalog.json'));
assert.ok(scripts[0][1].includes('firmware/previews/'));
assert.ok(scripts[0][1].includes("else if (choice.value === 'file')"));
assert.ok(scripts[0][1].includes('firmwareMeta.experimental'));
// Feature detection must work independently for desktop, iPhone Bluefy and Safari.
const moduleCode = scripts[0][1];
const start = moduleCode.indexOf("const hasWebSerial = ");
const end = moduleCode.indexOf("let fw = window.PIP_FIRMWARE;", start);
assert.ok(start >= 0 && end > start, 'Expected isolated browser feature-detection section');
const browserChecks = moduleCode.slice(start, end);
function simulateBrowser({serial, bluetooth}) {
  const elements = Object.fromEntries(['nobrowser','usb','ble','flash'].map(id => [id, {hidden:false,disabled:false}]));
  const navigator = {};
  if (serial) navigator.serial = {requestPort() {}};
  if (bluetooth) navigator.bluetooth = {requestDevice() {}};
  const result = vm.runInNewContext(
    'const $ = id => elements[id]; ' + browserChecks +
    '; ({hasWebSerial,hasWebBluetooth})',
    {navigator, elements},
  );
  return {result, elements};
}
{
  const {result,elements} = simulateBrowser({serial:false,bluetooth:true}); // Bluefy
  assert.equal(result.hasWebBluetooth,true);
  assert.equal(result.hasWebSerial,false);
  assert.equal(elements.nobrowser.hidden,true);
  assert.equal(elements.usb.hidden,true);
  assert.equal(elements.ble.hidden,false);
  assert.equal(elements.flash.disabled,true);
}
{
  const {elements} = simulateBrowser({serial:true,bluetooth:false}); // desktop without BLE
  assert.equal(elements.nobrowser.hidden,true);
  assert.equal(elements.usb.hidden,false);
  assert.equal(elements.ble.hidden,true);
  assert.equal(elements.flash.disabled,false);
}
{
  const {elements} = simulateBrowser({serial:false,bluetooth:false}); // Safari
  assert.equal(elements.nobrowser.hidden,false);
  assert.equal(elements.usb.hidden,true);
  assert.equal(elements.ble.hidden,true);
}
{
  const {elements} = simulateBrowser({serial:true,bluetooth:true}); // desktop full support
  assert.equal(elements.nobrowser.hidden,true);
  assert.equal(elements.usb.hidden,false);
  assert.equal(elements.ble.hidden,false);
}
assert.ok(html.includes('[hidden]{display:none!important}'), 'CSS must not override hidden');
console.log('ok: selector + Bluefy/USB/Safari capability detection');
