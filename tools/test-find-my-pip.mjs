// Regression guard for the "Find my Pip" browser UI and command protocol.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('docs/index.html','utf8');
const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'main web panel script');
new vm.Script(script, {filename:'docs/index.html'});
for(const id of ['locateStart','locateStop','locateStatus'])
  assert.ok(html.includes('id="' + id + '"'), 'UI control '+id);
assert.ok(html.includes('id="locateStart" disabled'));
assert.ok(html.includes('id="locateStop" disabled'));
assert.ok(script.includes("cfg?.locate === 1"), 'new firmware capability check');
assert.ok(script.includes("active ? 'locate 1' : 'locate 0'"));
assert.ok(script.includes("l.startsWith('@F ')"), 'acknowledgment handling');
assert.ok(script.includes("typeof s.locating === 'number'"), 'auto-stop observation');
assert.ok(script.includes("if (!(port || ble) || cfg?.locate !== 1"), 'must be connected and supported');
console.log('ok: locator browser UI, command/ack and firmware capability gates');
