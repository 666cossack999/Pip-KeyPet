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
console.log('ok: selector markup, JS syntax, stable/preview/file and test warning');
