import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual USB section of the production browser script, not a duplicate implementation.
const page = fs.readFileSync('docs/index.html', 'utf8');
const fullScript = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(fullScript, 'web flasher module exists');
new vm.Script(fullScript, {filename: 'docs/index.html'});
const start = fullScript.indexOf('let port = null, reader = null, ble = null');
const end = fullScript.indexOf("$('ble').onclick = async () =>", start);
assert.ok(start >= 0 && end > start, 'production USB lifecycle section');
const script = fullScript.slice(start, end);
assert.ok(!/await\s+(?:port|p)\.setSignals\(/.test(script), 'debug connection must not toggle DTR/RTS');
assert.ok(script.includes('navigator.serial.getPorts()'), 'recovery only via previously granted ports');
assert.ok(script.includes("l.startsWith('@C ')"), 'real config response gates connection');

async function simulate({resetsOnOpen = 1} = {}) {
  let opens = 0, closes = 0, writes = [];
  const elements = Object.fromEntries(['state','usb'].map(id => [id, {textContent: '', onclick: null}]));
  const styles = [];
  let pendingRead;
  const reader = {
    read() { return new Promise(resolve => { pendingRead = resolve; }); },
    cancel() { pendingRead?.({done: true}); return Promise.resolve(); },
    releaseLock() {}
  };
  let readable = {getReader() { return reader; }};
  const fakePort = {
    getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; },
    async open({baudRate}) {
      assert.equal(baudRate, 115200);
      opens++;
      if (opens <= resetsOnOpen) throw new Error('NetworkError: device reset/re-enumerated');
      this.readable = readable;
      this.writable = {getWriter: () => ({
        write(data) { writes.push(new TextDecoder().decode(data)); return Promise.resolve(); },
        releaseLock() {}
      })};
    },
    async close() { closes++; this.readable = null; this.writable = null; },
    async setSignals() { throw new Error('Web UI must not toggle DTR/RTS during debug'); }
  };
  const timeouts = new Map(), intervals = new Map();
  let next = 0;
  const context = vm.createContext({
    hasWebSerial: true,
    navigator: {serial: {
      async requestPort() { return fakePort; },
      async getPorts() { return [fakePort]; },
      addEventListener() {}
    }},
    document: {body: {classList: {toggle(...args) { styles.push(args); }}}},
    $: id => elements[id] || {textContent: ''},
    TextEncoder, TextDecoder, Uint8Array, Date, Promise,
    fill() {},
    setTimeout(cb,ms) { const id=++next; timeouts.set(id,{cb,ms}); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(cb,ms) { const id=++next; intervals.set(id,{cb,ms}); return id; },
    clearInterval(id) { intervals.delete(id); },
    console
  });
  vm.runInContext(script, context, {filename: 'usb-section.js'});
  async function tick() {
    const first = timeouts.entries().next().value;
    if (!first) return false;
    const [id,{cb}] = first;
    timeouts.delete(id);
    await cb();
    await Promise.resolve();
    return true;
  }
  return {
    context,elements,fakePort,writes,styles,intervals,timeouts,tick,
    get opens() { return opens; },
    get closes() { return closes; },
    eval(code) { return vm.runInContext(code, context); }
  };
}

// Port.open causes exactly one reset; the page must wait and recover automatically.
{
  const b=await simulate();
  await b.elements.usb.onclick();
  assert.equal(b.opens,1);
  assert.notEqual(b.elements.state.textContent, 'По кабелю', 'must not report connected before ACK');
  assert.ok(await b.tick(), 'queued reconnect after USB reset');
  assert.equal(b.opens,2, 'reopens the authorized port, no second permission prompt');
  assert.ok(b.writes.includes('config\n'), 'asks firmware for config');
  b.eval('onLine(\'@C {"ver":"test","feat":[]}\')');
  assert.equal(b.elements.state.textContent,'По кабелю', 'connected only after device reply');
  assert.equal(b.eval('usbWanted'),true);
  assert.equal(b.eval('usbReopens'),0);
  assert.equal(b.eval('cfg.ver'),'test');
}

// A normal device must connect once and close without triggering recovery.
{
  const b=await simulate({resetsOnOpen:0});
  await b.elements.usb.onclick();
  assert.equal(b.opens,1);
  b.eval('onLine(\'@C {"ver":"normal","feat":[]}\')');
  assert.equal(b.elements.state.textContent,'По кабелю');
  const closing=b.eval('closePort()');
  assert.ok(await b.tick(), 'closePort awaits its internal delay');
  await closing;
  assert.equal(b.closes,1);
  assert.equal(b.eval('usbWanted'),false);
  assert.equal(b.timeouts.size,0);
}

// If every open causes a reset, stop retrying; no endless boot/reconnect loop.
{
  const b=await simulate({resetsOnOpen:99});
  await b.elements.usb.onclick();
  for (let i=0;i<6;i++) if (!(await b.tick())) break;
  assert.equal(b.opens,3, 'initial attempt + at most two automatic reopens');
  assert.equal(b.eval('usbWanted'),false, 'recovery stopped after repeated resets');
  assert.match(b.elements.state.textContent,/Выбери порт ещё раз/);
  assert.equal(b.timeouts.size,0);
}

// Explicit disconnect must never attempt to reconnect, e.g. while handing port to esptool.
{
  const b=await simulate({resetsOnOpen:99});
  await b.elements.usb.onclick();
  assert.equal(b.timeouts.size,1);
  assert.equal(b.eval('port'),null);
  await b.eval('closePort()');
  assert.equal(b.eval('usbWanted'),false);
  assert.equal(b.timeouts.size,0);
  assert.equal(await b.tick(),false);
}

console.log('ok: WebSerial reset recovery, real @C handshake, bounded reopens and explicit close');
