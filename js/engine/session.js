// A ride in progress: drives the trainer (ERG or simulated slope with virtual
// gears), tracks intervals, and records 1 Hz samples.

import { VirtualBike, DevEstimator, G } from './physics.js?v=202611102147';
import { flatten, retime, segTarget, fillMessage } from './workout.js?v=202611102147';
import { Gearbox, DEFAULT_DRIVETRAIN } from './drivetrain.js?v=202611102147';
import { Emitter } from '../ble/base.js?v=202611102147';

export const DEFAULT_SETTINGS = {
  ftp: 200,
  riderKg: 77,
  bikeKg: 9,
  cda: 0.32,
  crr: 0.004,
  wheelCirc: 2.105,
  realDev: 5.1,          // metres per crank rev the trainer sees (learned)
  trainerMassKg: 75,     // mass the trainer assumes in sim mode (feedforward)
  maxSendGrade: 0.25,
  minSendGrade: -0.15,
  gradeScale: 1.0,       // 1.0 = full realism (Zwift default is 0.5)
  drivetrain: DEFAULT_DRIVETRAIN,
  shiftStyle: 'sram',     // 'sram' | 'shimano'
  ergCadenceGuard: true,
  autoPauseSec: 5,       // pause after this long with no pedalling (ERG) or no speed (slope); 0 = off
  riderName: '',         // the coach uses it in messages ({name})
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
    this.segs = workout ? flatten(workout, this.s.ftp) : null;
    this.name = name || workout?.name || 'Free ride';
    this.bike = new VirtualBike(this.s);
    this.devEst = new DevEstimator(this.s.realDev);
    this.gOff = this.s.gradeTrim || 0; // closed-loop grade correction (learned per ride)
    this.cadHist = [];

    this.intensity = 1.0;
    this.gradeOffset = 0;      // manual grade in free ride (fraction)
    this.ergOff = false;       // rider turned ERG off: ERG intervals ride as slope until the rider turns it back on (never automatic)
    this.paused = true;
    this.started = false;
    this.finished = false;
    this.elapsed = 0;          // active seconds
    this.segI = 0;             // current segment
    this.segT0 = 0;            // elapsed time when it started
    this.segD0 = 0;            // distance when it started
    this.segAgg = [];          // running per-segment stats
    this.grade = 0;            // smoothed virtual grade being ridden
    this.altitude = 100;
    this.samples = [];
    this.laps = [];
    this.lapStart = 0;
    this.powerBuf = [];
    this.lastSentGrade = 0;
    this.maxed = false;
    this.mode = this.segs?.[0]?.kind === 'erg' ? 'erg' : 'sim'; // known before the ride starts so the layout is right
    this.target = null;
    this._sampleAcc = 0;
    this._lowCad = 0;
    this._guard = false;
  }

  // ---------- controls ----------
  start() { this.started = true; this.paused = false; this.autoPaused = false; this.startMs ||= Date.now(); this.emit('change'); }
  togglePause() { if (!this.started) return this.start(); this.paused = !this.paused; this.autoPaused = false; this.emit('change'); }
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
    if (!this.seg) return;
    this._extendTest();
    this._advance();
    this.emit('change');
  }
  /** Manual lap (free ride, or after a workout ends). In a workout every interval is its own lap. */
  lap() {
    this._closeLap();
    this.emit('lap');
  }
  _closeLap() {
    const n = this.samples.length;
    if (n - 1 > this.lapStart) { this.laps.push({ startIdx: this.lapStart, endIdx: n - 1 }); this.lapStart = n; }
  }
  finish() {
    this.finished = true; this.paused = true;
    if (this.samples.length - 1 > this.lapStart) this.laps.push({ startIdx: this.lapStart, endIdx: this.samples.length - 1 });
    this.trainer.setErg?.(0);
    this.emit('finish');
  }

  // ---------- open-ended tests (steps with untilFail) ----------
  get inTest() { return !!this.seg?.untilFail; }
  /** Ends the test now: the current step is cut where it is, the test steps not ridden are dropped,
   *  and the ride moves on to what follows them (the cool-down). Returns false outside a test. */
  endTest(reason = 'manual') {
    const g = this.seg;
    if (!g?.untilFail) return false;
    const i = this.segI;
    let j = i + 1;
    while (j < this.segs.length && this.segs[j].untilFail) j++;
    const step = this.segs.slice(0, i + 1).filter((x) => x.untilFail).length;
    g.dur = Math.max(1, Math.round(this.segElapsed));
    g.msgs = g.msgs.filter((m) => m.t < g.dur);
    this.segs.splice(i + 1, j - i - 1);
    retime(this.segs);
    this.segsChanged = true;
    this._failFor = 0; this._stopFor = 0;
    this._noPauseFor = 30;
    this._advance();
    this.emit('testEnd', { reason, step, label: g.label, target: Math.round(g.to * this.s.ftp * this.intensity) });
    this.emit('change');
    return true;
  }
  /** Last test step done and the rider is still holding it: add the next one at the same increment. */
  _extendTest() {
    const i = this.segI, g = this.segs[i];
    if (!g?.untilFail || this.segs[i + 1]?.untilFail) return;
    const prev = this.segs[i - 1];
    const inc = prev?.untilFail && prev.kind === 'erg' ? g.from - prev.from : 0.06;
    const n = this.segs.slice(0, i + 1).filter((x) => x.untilFail).length + 1;
    const next = {
      ...g, label: /^Step \d+$/.test(g.label) ? `Step ${n}` : g.label, rep: null, msgs: [],
      from: Math.round((g.from + inc) * 1000) / 1000, to: Math.round((g.to + inc) * 1000) / 1000,
    };
    if (g.watts != null) next.watts = g.watts + (prev?.untilFail && prev.watts != null ? g.watts - prev.watts : 20);
    this.segs.splice(i + 1, 0, next);
    retime(this.segs);
    this.segsChanged = true;
  }
  /** The test ends on its own when the rider can't hold the target: 3 s power under 85% of it
   *  (or the ERG cadence guard kicked in) for 8 s in a row. */
  _watchTest(dt, ergTarget, power, cadence) {
    if (!this.seg?.untilFail || ergTarget == null) { this._testHard = false; return; }
    // stopped pedalling from 70% FTP up: that's the end, well before auto-pause would kick in.
    // Easier steps: a stop is a break (water, a fan), so auto-pause handles it as usual.
    this._testHard = ergTarget >= 0.7 * this.s.ftp;
    const stopped = this._testHard && cadence < 30 && power < 0.3 * ergTarget;
    this._stopFor = stopped ? (this._stopFor || 0) + dt : 0;
    if (this._stopFor >= 2) { this.endTest('stopped'); return; }
    if (this.segElapsed < 2) return;
    const low = this._guard || this.power3s < 0.85 * ergTarget;
    this._failFor = low ? (this._failFor || 0) + dt : 0;
    if (this._failFor >= 8) this.endTest('fail');
  }

  // ---------- derived ----------
  get workoutTime() { return this.elapsed; }
  get segIndex() { return this.segs && this.segI < this.segs.length ? this.segI : -1; }
  get seg() { const i = this.segIndex; return i >= 0 ? this.segs[i] : null; }
  get segElapsed() { return this.elapsed - this.segT0; }
  get segDist() { return this.bike.dist - this.segD0; }
  /** 0..1 through the current segment, by distance for distance steps, else by time. */
  get segProgress() { const g = this.seg; if (!g) return 1; return g.dist ? this.segDist / g.dist : this.segElapsed / g.dur; }
  /** Remaining in the current segment: { sec } or { m }. */
  get segRemaining() { const g = this.seg; if (!g) return null; return g.dist ? { m: Math.max(0, g.dist - this.segDist) } : { sec: Math.max(0, g.dur - this.segElapsed) }; }
  /** Position on the workout chart's time axis (uses estimated durations for distance steps). */
  get chartPos() {
    const g = this.seg;
    if (g) return g.start + Math.min(1, this.segProgress) * g.dur;
    const last = this.segs?.at(-1);
    return last ? last.end + (this.elapsed - this.segT0) : this.elapsed;
  }
  _advance() {
    this._closeLap(); // auto lap per interval (skips included) in the exported FIT
    this.segI++; this.segT0 = this.elapsed; this.segD0 = this.bike.dist; this.emit('segment', this.segI);
  }
  /** Cadence vs the current segment's target: null (no target / settling), 'ok', 'low' or 'high'. */
  get cadStatus() {
    const g = this.seg;
    if (!g?.cad || this.paused || !this.started || this.segElapsed < 8 || !this.cadBuf?.length) return null;
    const c = this.cadBuf.reduce((a, x) => a + x, 0) / this.cadBuf.length;
    return c < g.cad.lo ? 'low' : c > g.cad.hi ? 'high' : 'ok';
  }
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
    this.cadBuf = this.cadBuf || [];
    this.cadBuf.push(cadence);
    while (this.cadBuf.length > Math.round(3 / dt)) this.cadBuf.shift();
    while (this.powerBuf.length > Math.round(3 / dt)) this.powerBuf.shift();

    if (this._noPauseFor > 0) this._noPauseFor -= dt;
    // ---- auto start / pause / resume ----
    if (!this.finished) {
      const pedalling = cadence > 15 || power > 15;
      this._activeFor = pedalling ? (this._activeFor || 0) + dt : 0;
      if (!this.started && this._activeFor >= 1) { this.start(); this.emit('autostart'); }
      else if (this.paused && this.autoPaused && this._activeFor >= 1) { this.paused = false; this.autoPaused = false; this.emit('autoresume'); }
      else if (!this.paused && this.s.autoPauseSec > 0) {
        const idle = this.mode === 'erg' ? power < 5 && cadence < 5 : this.bike.v < 0.3 && cadence < 5;
        // no auto-pause in the hard part of a test or for 30 s after it ends (the rider is spent; the result is on screen)
        const hold = (this.inTest && this._testHard) || this._noPauseFor > 0;
        this._idleFor = idle && !hold ? (this._idleFor || 0) + dt : 0;
        if (this._idleFor >= this.s.autoPauseSec) {
          this.paused = true; this.autoPaused = true; this._idleFor = 0;
          this.emit('autopause');
        }
      }
    }
    if (this.paused || this.finished) {
      this.emit('tick');
      return;
    }
    this.elapsed += dt;

    // ---- what are we riding right now? ----
    while (this.seg && this.segProgress >= 1) { this._extendTest(); this._advance(); }
    const seg = this.seg;
    let targetGrade = this.gradeOffset;
    let ergTarget = null;
    if (seg) {
      if (seg.kind === 'erg' && !this.ergOff) ergTarget = segTarget(seg, this.segProgress) * this.s.ftp * this.intensity;
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
      this._watchTest(dt, ergTarget, power, cadence);
      // speed and distance: the trainer's own speed (matches the FR970 with the KICKR paired);
      // physics only when the trainer reports none (dropout, or coasting to a stop)
      if (trainerV > 0.3) this.bike.stepTrainer(dt, trainerV);
      else this.bike.stepPower(dt, power, 0);
      this.maxed = false;
    } else {
      this.mode = 'sim';
      this.target = null;
      const res = this.bike.stepSim(dt, power, cadence, this.grade, this.ratio);
      const k = this.bike.dev(this.ratio) / this.devEst.dev;
      const vr = Math.max(trainerV, 2);
      let gs = this.s.minSendGrade;
      if (res.engaged) {
        // feedforward: the grade that makes trainer force x its speed = road force x virtual speed
        const ff = (k * res.force) / (this.s.trainerMassKg * G);
        // feedback: slowly trim the grade until measured power matches the virtual demand.
        // This cancels whatever the trainer adds on its own (built-in drag, different mass).
        this.cadHist.push(cadence);
        if (this.cadHist.length > 8) this.cadHist.shift();
        const cadSteady = this.cadHist.length === 8 && Math.max(...this.cadHist) - Math.min(...this.cadHist) < 6;
        const demand = res.force * res.v;
        if (cadSteady && power > 15 && cadence > 30) {
          const err = demand - power;
          this.gOff += (err / (this.s.trainerMassKg * G * vr)) * (dt / 4);
          this.gOff = Math.max(-0.12, Math.min(0.12, this.gOff));
        }
        gs = ff + this.gOff;
      } else this.cadHist = [];
      this.maxed = gs > this.s.maxSendGrade;
      gs = Math.max(this.s.minSendGrade, Math.min(this.s.maxSendGrade, gs));
      this.lastSentGrade = gs;
      this.trainer.setGrade(gs);
    }
    this.altitude += this.bike.v * dt * Math.sin(Math.atan(this.grade));
    this._messages();

    // ---- record at 1 Hz ----
    this._sampleAcc += dt;
    if (this._sampleAcc >= 1) {
      this._sampleAcc -= 1;
      this.samples.push({
        t: Date.now(), power: Math.round(power), hr: hr ? Math.round(hr) : undefined, cadence: Math.round(cadence),
        speed: this.bike.v, distance: this.bike.dist, altitude: this.altitude,
        grade: this.mode === 'sim' ? this.grade * 100 : 0, target: this.target, gear: Math.round(this.ratio * 100) / 100,
        wt: this.workoutTime, wx: this.chartPos, si: this.segIndex, st: Math.round(this.segElapsed),
      });
      this._aggregate(this.samples.at(-1));
    }
    this.emit('tick');
  }

  /** Emits 'message' (text) for each timed message the rider just reached. Skipped steps stay silent. */
  _messages() {
    const g = this.seg;
    if (!g?.msgs?.length) return;
    const done = (this._msgDone ||= new Set());
    const pos = Math.min(1, this.segProgress) * g.dur;
    g.msgs.forEach((m, k) => {
      const key = `${this.segI}:${k}`;
      if (done.has(key) || pos < m.t) return;
      done.add(key);
      if (pos - m.t <= 15) this.emit('message', fillMessage(m.text, { seg: g, watts: this.target ?? (g.kind === 'erg' ? segTarget(g, this.segProgress) * this.s.ftp * this.intensity : null), ftp: this.s.ftp, name: this.s.riderName }));
    });
  }

  _aggregate(x) {
    if (x.si < 0) return;
    const a = (this.segAgg[x.si] ||= { n: 0, p: 0, hr: 0, hrN: 0, cad: 0 });
    a.n++; a.p += x.power; a.cad += x.cadence;
    if (x.hr) { a.hr += x.hr; a.hrN++; }
  }

  /** Learned calibration values to persist into settings after a ride. */
  learned() { return { realDev: this.devEst.dev, gradeTrim: Math.round(this.gOff * 1000) / 1000 }; }
}

export { G };
