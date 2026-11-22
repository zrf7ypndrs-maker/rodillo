// The simulated trainer, rider and HR strap for the recorded rides (test/rides.mjs). Seeded, so a ride is the same
// every run: the same readings go to the engine, and every command it sends is logged.
// Kept here (not js/ble/sim.js, the demo trainer) so a change to the demo never moves the recordings.

import { G, speedForPower } from '../../js/engine/physics.js';
import { ZP_WHEEL } from '../../js/ble/zwifthub.js';

/** Small seeded PRNG (mulberry32): a number in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A trainer like a KICKR CORE, ridden by a scripted rider. ERG: the rider pedals at `rider.cad` and the trainer holds
 * the target, unless it is over `rider.ergMax` (cadence collapses). Slope over FTMS: its own mass and drag, cadence
 * comes from the grade and the rider's power. Zwift protocol: it brakes for the road grade and virtual gear itself,
 * so cadence comes from the road speed at the rider's power in that gear.
 */
export class ModelTrainer {
  constructor(random, { realDev = 5.1, trainerMass = 75, c1 = 2.9, c3 = 0.51, zwift = false } = {}) {
    this.random = random;
    this.realDev = realDev; this.trainerMass = trainerMass; this.c1 = c1; this.c3 = c3;
    this.zwiftShifting = zwift;
    this.mode = 'erg'; this.erg = 0; this.grade = 0; this.zp = null;
    this.rider = { power: 0, cad: 90, ergMax: Infinity };
    /** Sensor trouble, set by the ride scripts: all = no data at all, power = no power field, cadence = reads 0,
     *  speed = no speed field, spike = one reading of that many watts, hr = the trainer's own HR field,
   *  wobble = cadence rocking up and down that many rpm. */
    this.drop = { all: false, power: false, cadence: false, speed: false, spike: 0, hr: 0, wobble: 0 };
    this.cmds = [];
    this.data = { power: 0, cadence: 0, speedKmh: 0 };
    this._cad = 0; this._v = 0; this._wob = false;
  }
  setErg(w) { this.cmds.push(['erg', w]); this.mode = 'erg'; this.erg = w; }
  setGrade(g) { this.cmds.push(['grade', g]); this.mode = 'sim'; this.grade = g; }
  setZwiftSim(p) { this.cmds.push(['zp', p.grade, p.gearRatio, p.riderKg, p.bikeKg]); this.mode = 'zp'; this.zp = p; }

  _slopePower(c) {
    const vr = (c / 60) * this.realDev;
    return Math.max(0.8 * vr, this.trainerMass * G * this.grade * vr + this.c1 * vr + this.c3 * vr ** 3);
  }

  step(dt) {
    const r = this.rider, k = Math.min(1, dt); // rider + flywheel inertia: about a quarter of the way per 0.25 s
    let cad = 0, power = 0, speed;
    if (this.mode === 'erg') {
      cad = r.power > 0 ? r.cad : 0;
      power = cad ? this.erg : 0;
      if (cad && this.erg > r.ergMax) { cad = 35; power = Math.round(r.ergMax * 0.7); }
      this._cad = cad;
      // the flywheel spins down when the rider stops (time constant 2 s)
      this._v = cad ? (cad / 60) * this.realDev : (this._v || 0) * Math.exp(-dt / 2);
      if (this._v < 0.1) this._v = 0;
      speed = this._v;
    } else if (this.mode === 'sim') {
      let want = 0;
      if (r.power > 0) {
        let lo = 0, hi = 115;
        if (this._slopePower(hi) < r.power) want = hi;
        else { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (this._slopePower(m) > r.power) hi = m; else lo = m; } want = lo; }
      }
      this._cad += (want - this._cad) * k;
      cad = this._cad < 20 ? 0 : this._cad;
      power = cad ? this._slopePower(cad) : 0;
      speed = (cad / 60) * this.realDev;
    } else {
      const p = this.zp, v = r.power > 0 ? speedForPower(r.power, p.grade, { riderKg: p.riderKg, bikeKg: p.bikeKg, crr: 0.004, cda: 0.32 }) : 0;
      const want = Math.min(130, (v / (p.gearRatio * ZP_WHEEL)) * 60);
      this._cad += (want - this._cad) * k;
      cad = this._cad < 20 ? 0 : this._cad;
      power = cad ? r.power : 0;
      speed = cad ? v : 0; // virtual speed: the trainer reports the road's
    }
    if (this.mode !== 'erg') this._v = speed;
    const n1 = this.random() - 0.5, n2 = this.random() - 0.5; // always two draws, so trouble never shifts the stream
    const d = this.drop;
    if (d.all) { this.data = undefined; return; }
    /** @type {any} */
    // cadence in FTMS's 0.5 rpm steps; `wobble` rocks it up and down that many rpm (an uneven pedal stroke)
    const wob = d.wobble ? (this._wob = !this._wob) ? d.wobble : -d.wobble : 0;
    const out = { power: Math.max(0, Math.round(power + n1 * 8)), cadence: Math.max(0, Math.round((cad + n2 * 2 + wob) * 2) / 2), speedKmh: speed * 3.6 };
    if (d.power) out.power = null;
    if (d.cadence) out.cadence = 0;
    if (d.speed) delete out.speedKmh;
    if (d.spike) { out.power = d.spike; d.spike = 0; }
    if (d.hr) out.hr = d.hr;
    this.data = out;
  }
}

/** HR strap: drifts toward 60 + power / 2. `drop` = the strap reads 0 (the engine falls back to the trainer's HR). */
export class ModelHr {
  constructor() { this._bpm = 70; this.bpm = 70; this.drop = false; }
  step(dt, power) {
    this._bpm += (60 + (power || 0) * 0.5 - this._bpm) * Math.min(1, dt / 25);
    this.bpm = this.drop ? 0 : Math.round(this._bpm * 10) / 10;
  }
}
