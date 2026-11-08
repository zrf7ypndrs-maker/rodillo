// Simulated trainer + HR strap for testing without hardware.
// The simulated rider holds a chosen power; cadence emerges from the
// resistance the app commands, exactly like on the real trainer.

import { Emitter } from './base.js';
import { G } from '../engine/physics.js';

export class SimTrainer extends Emitter {
  constructor({ realDev = 5.1, trainerMass = 75 } = {}) {
    super();
    this.kind = 'trainer';
    this.name = 'Simulated KICKR';
    this.state = 'connected';
    this.info = { firmware: 'sim' };
    this.realDev = realDev;
    this.trainerMass = trainerMass;
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
      // trainer power = Mt*g*grade*v_r, v_r = cad/60*dev; rider supplies riderPower
      const perRpm = this.trainerMass * G * Math.max(this.grade, 0.004) * (this.realDev / 60) + 0.15;
      const want = this.riderPower > 0 ? Math.min(115, this.riderPower / perRpm) : 0;
      this._cad = (this._cad ?? 85) + (want - (this._cad ?? 85)) * 0.25; // rider + flywheel inertia
      cad = this._cad < 20 ? 0 : this._cad;
      power = cad * perRpm;
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
