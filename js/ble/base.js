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
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    return this.connect();
  }

  async attach(device) {
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    return this.connect();
  }

  async connect() {
    this._wantConnected = true;
    this.setState('connecting');
    try {
      this.server = await this.device.gatt.connect();
      await this.readInfo();
      await this.setup();
      this.setState('connected');
      logMsg(this.kind, `connected to ${this.name}`);
    } catch (e) {
      logMsg(this.kind, `connect failed: ${e.message}`);
      this.setState('disconnected');
      throw e;
    }
  }

  async disconnect() {
    this._wantConnected = false;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.setState('disconnected');
  }

  async _onDisconnect() {
    this.setState('disconnected');
    logMsg(this.kind, 'disconnected');
    if (!this._wantConnected) return;
    for (let i = 0; i < 8 && this._wantConnected; i++) {
      await new Promise((r) => setTimeout(r, 1000 * Math.min(8, 1 + i)));
      try { await this.connect(); return; } catch { /* retry */ }
    }
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
