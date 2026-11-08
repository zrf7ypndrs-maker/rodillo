// A ride in progress: drives the trainer (ERG or simulated slope with virtual
// gears), tracks intervals, and records 1 Hz samples.

import { VirtualBike, DevEstimator, TrainerMassEstimator, gradeToSend, G } from './physics.js';
import { flatten, segmentAt, segTarget } from './workout.js';
import { Gearbox, DEFAULT_DRIVETRAIN } from './drivetrain.js';
import { Emitter } from '../ble/base.js';

export const DEFAULT_SETTINGS = {
  ftp: 200,
  riderKg: 77,
  bikeKg: 9,
  cda: 0.32,
  crr: 0.004,
  wheelCirc: 2.105,
  realDev: 5.1,          // metres per crank rev the trainer sees (learned)
  trainerMassKg: 75,     // mass the trainer assumes in sim mode (learned)
  maxSendGrade: 0.25,
  gradeScale: 1.0,       // 1.0 = full realism (Zwift default is 0.5)
  drivetrain: DEFAULT_DRIVETRAIN,
  shiftStyle: 'sram',     // 'sram' | 'shimano'
  ergCadenceGuard: true,
};

export class Session extends Emitter {
  constructor({ trainer, hr, settings, workout = null, name }) {
    super();
    this.trainer = trainer;
    this.hr = hr;
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.gb = new Gearbox(this.s.drivetrain);
    this.s.wheelCirc = this.gb.wheel;
    this.workout = workout;
    this.segs = workout ? flatten(workout) : null;
    this.name = name || workout?.name || 'Free slope';
    this.bike = new VirtualBike(this.s);
    this.devEst = new DevEstimator(this.s.realDev);
    this.massEst = new TrainerMassEstimator(this.s.trainerMassKg);

    this.intensity = 1.0;
    this.gradeOffset = 0;      // manual grade in free ride (fraction)
    this.ergOff = false;       // rider forced sim during an ERG interval
    this.paused = true;
    this.started = false;
    this.finished = false;
    this.elapsed = 0;          // active seconds
    this.segOffset = 0;        // time shift from skipped intervals
    this.grade = 0;            // smoothed virtual grade being ridden
    this.altitude = 100;
    this.samples = [];
    this.laps = [];
    this.lapStart = 0;
    this.powerBuf = [];
    this.lastSentGrade = 0;
    this.maxed = false;
    this.mode = 'sim';
    this.target = null;
    this._sampleAcc = 0;
    this._lowCad = 0;
    this._guard = false;
  }

  // ---------- controls ----------
  start() { this.started = true; this.paused = false; this.startMs ||= Date.now(); this.emit('change'); }
  togglePause() { if (!this.started) return this.start(); this.paused = !this.paused; this.emit('change'); }
  /** Rear shift, dir +1 = harder. */
  shift(dir) { if (this.gb.shiftRear(dir)) { this.emit('shift', this.gb.label); this.emit('change'); } }
  shiftFront(dir) { if (this.gb.shiftFront(dir)) { this.emit('shift', this.gb.label); this.emit('change'); } }
  toggleFront() { if (this.gb.toggleFront()) { this.emit('shift', this.gb.label); this.emit('change'); } }
  bump(dir) {
    if (this.mode === 'erg') this.intensity = Math.max(0.5, Math.min(1.5, Math.round((this.intensity + 0.01 * dir) * 100) / 100));
    else this.gradeOffset = Math.max(-0.1, Math.min(0.2, Math.round((this.gradeOffset + 0.01 * dir) * 100) / 100));
    this.emit('change');
  }
  toggleErg() { this.ergOff = !this.ergOff; this.emit('change'); }
  skip() {
    if (!this.segs) return;
    const t = this.elapsed + this.segOffset;
    const i = segmentAt(this.segs, t);
    if (i >= 0) { this.segOffset += this.segs[i].end - t; this.emit('change'); }
  }
  lap() {
    const n = this.samples.length;
    if (n - 1 > this.lapStart) { this.laps.push({ startIdx: this.lapStart, endIdx: n - 1 }); this.lapStart = n; }
    this.emit('lap');
  }
  finish() {
    this.finished = true; this.paused = true;
    if (this.samples.length - 1 > this.lapStart) this.laps.push({ startIdx: this.lapStart, endIdx: this.samples.length - 1 });
    this.trainer.setErg?.(0);
    this.emit('finish');
  }

  // ---------- derived ----------
  get workoutTime() { return this.elapsed + this.segOffset; }
  get segIndex() { return this.segs ? segmentAt(this.segs, this.workoutTime) : -1; }
  get seg() { const i = this.segIndex; return i >= 0 ? this.segs[i] : null; }
  get power3s() { const b = this.powerBuf; return b.length ? b.reduce((a, x) => a + x, 0) / b.length : 0; }
  get ratio() { return this.gb.ratio; }

  /** Called ~4x per second with dt seconds. */
  tick(dt) {
    const td = this.trainer.data || {};
    const power = Math.max(0, td.power || 0);
    const cadence = td.cadence || 0;
    const trainerV = (td.speedKmh || 0) / 3.6;
    const hr = (this.hr && this.hr.bpm) || td.hr || 0;

    this.devEst.update(trainerV, cadence);
    this.powerBuf.push(power);
    while (this.powerBuf.length > Math.round(3 / dt)) this.powerBuf.shift();

    if (this.paused || this.finished) {
      this.emit('tick');
      return;
    }
    this.elapsed += dt;

    // ---- what are we riding right now? ----
    const seg = this.seg;
    let targetGrade = this.gradeOffset;
    let ergTarget = null;
    if (seg) {
      if (seg.kind === 'erg' && !this.ergOff) ergTarget = segTarget(seg, this.workoutTime) * this.s.ftp * this.intensity;
      else if (seg.kind === 'sim') targetGrade = (seg.free ? 0 : seg.grade) + this.gradeOffset;
    } else if (this.segs && !this.workoutDone) {
      this.workoutDone = true;
      this.emit('workoutDone');
    }
    targetGrade *= targetGrade > 0 ? this.s.gradeScale : 1;

    // smooth grade changes (max 1 %/s) so the trainer doesn't lurch
    const maxStep = 0.01 * dt;
    this.grade += Math.max(-maxStep, Math.min(maxStep, targetGrade - this.grade));

    if (ergTarget !== null) {
      this.mode = 'erg';
      // spiral-of-death guard: ease off if cadence collapses
      if (this.s.ergCadenceGuard) {
        if (cadence < 40 && power > 0) this._lowCad += dt; else if (cadence > 60) { this._lowCad = 0; this._guard = false; }
        if (this._lowCad > 3) this._guard = true;
      }
      this.target = Math.round(this._guard ? ergTarget * 0.6 : ergTarget);
      this.trainer.setErg(this.target);
      this.bike.stepPower(dt, power, 0);
      this.maxed = false;
    } else {
      this.mode = 'sim';
      this.target = null;
      const res = this.bike.stepSim(dt, power, cadence, this.grade, this.ratio);
      const k = this.bike.dev(this.ratio) / this.devEst.dev;
      let gs = res.engaged ? gradeToSend(res.force, k, this.massEst.m) : -0.1;
      this.maxed = gs > this.s.maxSendGrade;
      gs = Math.max(-0.1, Math.min(this.s.maxSendGrade, gs));
      if (res.engaged) this.massEst.update(power, this.lastSentGrade, trainerV);
      this.lastSentGrade = gs;
      this.trainer.setGrade(gs);
    }
    this.altitude += this.bike.v * dt * Math.sin(Math.atan(this.grade));

    // ---- record at 1 Hz ----
    this._sampleAcc += dt;
    if (this._sampleAcc >= 1) {
      this._sampleAcc -= 1;
      this.samples.push({
        t: Date.now(), power: Math.round(power), hr: hr ? Math.round(hr) : undefined, cadence: Math.round(cadence),
        speed: this.bike.v, distance: this.bike.dist, altitude: this.altitude,
        grade: this.mode === 'sim' ? this.grade * 100 : 0, target: this.target, gear: Math.round(this.ratio * 100) / 100,
        wt: this.workoutTime,
      });
    }
    this.emit('tick');
  }

  /** Learned calibration values to persist into settings after a ride. */
  learned() { return { realDev: this.devEst.dev, trainerMassKg: this.massEst.m }; }
}

export { G };
