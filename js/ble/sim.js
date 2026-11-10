// Simulated trainer + HR strap for testing without hardware.
// The simulated rider holds a chosen power; cadence emerges from the
// resistance the app commands, exactly like on the real trainer.

import { Emitter } from './base.js?v=202611101959';
import { G } from '../engine/physics.js?v=202611101959';

export class SimTrainer extends Emitter {
  constructor({ realDev = 5.1, trainerMass = 75, c1 = 2.9, c3 = 0.51 } = {}) {
    super();
    this.kind = 'trainer';
    this.name = 'Simulated KICKR';
    this.state = 'connected';
    this.info = {};
    this.realDev = realDev;
    this.trainerMass = trainerMass;
    this.c1 = c1;
    this.c3 = c3;
    this.riderPower = 180;
    this.ergCadence = 90;
    this.mode = 'erg';
    this.erg = 0;
    this.grade = 0;
    this.data = { power: 0, cadence: 0, speedKmh: 0 };
    this.commands = 0;
  }
  setErg(w) { if (this.mode !== 'erg' || this.erg !== w) this.commands++; this.mode = 'erg'; this.erg = w; }
  setGrade(g) { if (this.mode !== 'sim' || this.grade !== g) this.commands++; this.mode = 'sim'; this.grade = g; }

  step() {
    let cad, power;
    if (this.mode === 'erg') {
      cad = this.riderPower > 0 ? this.ergCadence : 0;
      power = cad ? this.erg : 0;
    } else {
      // Like a KICKR in sim mode: its own mass, rolling and aero drag (it ignores the
      // app's crr/cw), and a physical floor because the brake can't go below zero.
      const P = (c) => {
        const vr = (c / 60) * this.realDev;
        return Math.max(0.8 * vr, this.trainerMass * G * this.grade * vr + this.c1 * vr + this.c3 * vr ** 3);
      };
      let want = 0;
      if (this.riderPower > 0) {
        let lo = 0, hi = 115;
        if (P(hi) < this.riderPower) want = hi;
        else { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (P(m) > this.riderPower) hi = m; else lo = m; } want = lo; }
      }
      this._cad = (this._cad ?? 85) + (want - (this._cad ?? 85)) * 0.25; // rider + flywheel inertia
      cad = this._cad < 20 ? 0 : this._cad;
      power = cad ? P(cad) : 0;
    }
    const noise = () => (Math.random() - 0.5) * 2;
    this.data = {
      power: Math.max(0, Math.round(power + noise() * 4)),
      cadence: Math.max(0, cad + noise()),
      speedKmh: ((cad / 60) * this.realDev) * 3.6,
      t: Date.now(),
    };
    this.emit('data', this.data);
  }
  disconnect() {}
}

export class SimHr extends Emitter {
  constructor(trainer) { super(); this.kind = 'hr'; this.name = 'Simulated HRM'; this.state = 'connected'; this.info = {}; this.bpm = 70; this.trainer = trainer; }
  step(dt = 1) {
    const goal = 60 + (this.trainer.data.power || 0) * 0.5;
    this.bpm += (goal - this.bpm) * Math.min(1, dt / 25);
    this.bpm = Math.round(this.bpm * 10) / 10;
    this.emit('data', Math.round(this.bpm));
  }
  disconnect() {}
}
