// Shared Web Bluetooth plumbing: connect, auto-reconnect, serialized writes.

export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); }
  emit(ev, ...a) { for (const f of this.handlers[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }
}

export const log = new Emitter();
export function logMsg(src, msg) { log.emit('log', { t: Date.now(), src, msg }); console.log(`[${src}] ${msg}`); }

export const hex = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// waits between reconnect tries; the last one repeats for as long as it takes
export const RETRY_MS = [1000, 2000, 3000, 5000];

/** Base class for a Web Bluetooth peripheral we keep connected. */
export class BleDevice extends Emitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.device = null;
    this.server = null;
    this.state = 'disconnected'; // disconnected | connecting | connected
    this.info = {};
    this._queue = Promise.resolve();
    this._wantConnected = false;
  }

  get name() { return this.device?.name || this.kind; }

  setState(s) { this.state = s; this.emit('state', s); }

  async pick(options) {
    this.listen(await navigator.bluetooth.requestDevice(options));
    return this.connect();
  }

  async attach(device) {
    this.listen(device);
    return this.connect();
  }

  /** Take `device` and watch it for drops, once per device (re-picking the same strap mid-ride used to stack listeners). */
  listen(device) {
    this.device = device;
    this._heard ||= new WeakSet();
    if (this._heard.has(device)) return;
    this._heard.add(device);
    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
  }

  async connect(quiet = false) {
    this._wantConnected = true;
    this.setState('connecting');
    try {
      this.server = await this.device.gatt.connect();
      await this.readInfo();
      await this.setup();
      this.setState('connected');
      logMsg(this.kind, `connected to ${this.name}`);
    } catch (e) {
      if (!quiet) logMsg(this.kind, `connect failed: ${e.message}`);
      this.setState('disconnected');
      throw e;
    }
  }

  async disconnect() {
    this._wantConnected = false;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.setState('disconnected');
  }

  /**
   * A drop: keep trying until it's back or the rider disconnects it on purpose (Nov 20: the HR strap dropped mid-ride
   * and the old loop gave up after 8 tries, ~40 s, so it never came back). One loop at a time; quiet log after the first tries.
   */
  async _onDisconnect() {
    this.setState('disconnected');
    logMsg(this.kind, 'disconnected');
    if (!this._wantConnected || this._retrying) return;
    this._retrying = true;
    try {
      for (let i = 0; this._wantConnected; i++) {
        await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(i, RETRY_MS.length - 1)]));
        if (!this._wantConnected || (this.state === 'connected' && this.device?.gatt.connected)) return; // re-picked meanwhile
        try { await this.connect(i >= 3); logMsg(this.kind, `back after ${i + 1} tries`); return; } catch { /* retry */ }
      }
    } finally { this._retrying = false; }
  }

  /** Device Information Service, if exposed. */
  async readInfo() {
    try {
      const dis = await this.server.getPrimaryService(uuid16(0x180a));
      const dec = new TextDecoder();
      for (const [key, id] of [['model', 0x2a24], ['firmware', 0x2a26], ['hardware', 0x2a27], ['manufacturer', 0x2a29]]) {
        try { this.info[key] = dec.decode(await (await dis.getCharacteristic(uuid16(id))).readValue()).replace(/\0/g, ''); } catch { /* optional */ }
      }
      logMsg(this.kind, `info ${JSON.stringify(this.info)}`);
    } catch { /* no DIS */ }
    try {
      const bs = await this.server.getPrimaryService(uuid16(0x180f));
      const ch = await bs.getCharacteristic(uuid16(0x2a19));
      this.info.battery = (await ch.readValue()).getUint8(0);
    } catch { /* no battery service */ }
  }

  /** Serialize GATT writes; Web Bluetooth rejects concurrent operations. */
  write(char, bytes, withResponse = true) {
    const run = async () => {
      if (!this.device?.gatt.connected) return;
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (withResponse && char.writeValueWithResponse) await char.writeValueWithResponse(data);
      else if (!withResponse && char.writeValueWithoutResponse) await char.writeValueWithoutResponse(data);
      else await char.writeValue(data);
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch((e) => logMsg(this.kind, `write error: ${e.message}`));
    return p;
  }

  async listServices() {
    try {
      const svcs = await this.server.getPrimaryServices();
      return svcs.map((s) => s.uuid);
    } catch (e) { return [`(${e.message})`]; }
  }

  async setup() { /* override */ }
}
