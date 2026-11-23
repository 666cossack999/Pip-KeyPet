import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const page=readFileSync('docs/index.html','utf8');
const code=[...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(code, 'web module present');
new vm.Script(code,{filename:'docs/index.html'});
for(const id of ['firmwareChoice','firmwareFile','bleFlash','bleProg','bleFlashState','flash'])
  assert.ok(page.includes('id="'+id+'"'), 'missing control: '+id);
assert.ok(code.includes("await flashBleOta(fw,"), 'OTA must use the user-selected image');
assert.ok(code.includes("firmwareBusy(true)"), 'selector must freeze while OTA runs');
assert.ok(code.includes("firmwareBusy(false)"), 'selector must unlock after OTA');
assert.ok(code.includes("$('bleFlash').disabled = !hasWebBluetooth;"), 'BLE availability independent from USB');
assert.ok(code.includes("firmwareMeta.id === 'stable'"), 'downgrade needs explicit warning');
assert.ok(code.includes("firmware/catalog.json"), 'stable/PR catalog retained');
console.log('ok: firmware selector, BLE OTA, browser gating, version-choice safety');
