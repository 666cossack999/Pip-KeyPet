// No hardware required: exercise the exact browser-side BLE OTA protocol.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
globalThis.crypto = webcrypto;

const js = readFileSync('docs/ble-ota.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

function release(bytes) {
  return {parts: [{address: 0x20000, data: Buffer.from(bytes).toString('base64')}]};
}
function example() {
  const b = Buffer.alloc(512, 0x42);
  b[0] = 0xe9;
  return b;
}
assert.deepEqual(mod.appImageFromRelease(release(example())), new Uint8Array(example()));
assert.throws(() => mod.appImageFromRelease({parts: []}), /не найден/);
assert.throws(() => mod.appImageFromRelease(release(Buffer.alloc(512))), /Некорректный/);
assert.deepEqual(mod.parseOtaStatus(new DataView(Uint8Array.of(2,0, 0x10,0,0,0, 0x20,0,0,0).buffer)),
  {state: 2, error: 0, received: 16, expected: 32});
assert.throws(() => mod.parseOtaStatus(new DataView(new ArrayBuffer(2))), /статус/);

async function scenario({mtu = 160, batteryError = false, flashError = false} = {}) {
  const packet = example();
  const steps = [];
  let state = 0, error = 0, expected = 0, received = 0;
  let expectedHash = new Uint8Array(32);
  let hashMask = 0;
  let connected = false;
  let rebooted = false;
  const ctrl = {
    async writeValueWithResponse(bytes) {
      const x = new Uint8Array(bytes);
      steps.push('ctl:' + x[0]);
      if (x[0] === 1) {
        if (batteryError) {state = 3; error = 3; throw Error('denied');}
        assert.equal(x.length, 5);
        expected = new DataView(x.buffer,x.byteOffset,x.byteLength).getUint32(1,true);
        state = 1;
      } else if (x[0] === 5 || x[0] === 6) {
        assert.equal(x.length, 17);
        const ix=x[0]===5?0:16;
        expectedHash.set(x.subarray(1),ix);
        hashMask |= x[0]===5?1:2;
      } else if (x[0] === 2) {
        assert.equal(hashMask,3);
        assert.equal(received,expected);
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', packet));
        assert.deepEqual(expectedHash,hash);
        state = 2;
      } else if (x[0] === 3) {state = 0;} 
      else if (x[0] === 4) {assert.equal(state,2); rebooted = true;}
    }
  };
  const data = {
    async writeValueWithResponse(bytes) {
      const x = new Uint8Array(bytes);
      if (x.length > mtu) throw Error('GATT length');
      if (flashError && received > 100) {state=3;error=6;throw Error('Flash write failed');}
      assert.equal(state,1);
      assert.equal(hashMask,3);
      assert.deepEqual(x,new Uint8Array(packet.subarray(received, received+x.length)));
      received += x.length;
      steps.push('data:' + x.length);
    }
  };
  const status = {
    async readValue() {
      const a=new Uint8Array(10);a[0]=state;a[1]=error;
      new DataView(a.buffer).setUint32(2,received,true);
      new DataView(a.buffer).setUint32(6,expected,true);
      return new DataView(a.buffer);
    }
  };
  const svc = {async getCharacteristic(uuid) {
    if (uuid.endsWith('00000002')) return ctrl;
    if (uuid.endsWith('00000003')) return data;
    if (uuid.endsWith('00000004')) return status;
    throw Error('unknown characteristic');
  }};
  const gatt = {
    get connected() {return connected;},
    async connect(){connected=true;return this;},
    disconnect(){connected=false;},
    async getPrimaryService(uuid){assert.equal(uuid,mod.OTA_UUID);return svc;}
  };
  const device = {gatt};
  globalThis.navigator = {bluetooth: {
    async requestDevice(x){assert.deepEqual(x.optionalServices,[mod.OTA_UUID]);return device;}
  }};
  const progress=[];
  let failure=null;
  try {await mod.flashBleOta(release(packet),x=>progress.push(x));}
  catch(e){failure=e;}
  return {steps,progress,failure,received,rebooted};
}
const normal=await scenario();
assert.equal(normal.failure,null);
assert.equal(normal.received,512);
assert.equal(normal.rebooted,true);
assert.equal(normal.progress.at(-1),100);
assert.deepEqual(normal.steps.filter(x=>x.startsWith('ctl:')),[ 'ctl:1','ctl:5','ctl:6','ctl:2','ctl:4']);
const tiny=await scenario({mtu:20});
assert.equal(tiny.failure,null);
assert.equal(tiny.rebooted,true);
assert.ok(tiny.steps.some(x=>x === 'data:20'));
const battery=await scenario({batteryError:true});
assert.match(battery.failure.message,/50%/);
assert.equal(battery.rebooted,false);
const flash=await scenario({flashError:true});
assert.match(flash.failure.message,/Flash/);
assert.equal(flash.rebooted,false);
assert.ok(flash.steps.includes('ctl:3'));
console.log('ok: BLE OTA validation, 160/20 byte chunks, denied battery, error abort');
