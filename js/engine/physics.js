// Bike physics and the virtual gearbox.
// All SI units internally: m, s, kg, W, m/s. Grade as a fraction (0.05 = 5%).

export const G = 9.80665;
export const RHO = 1.2; // air density kg/m3

// Zwift-style 24 virtual gears, ratio = chainring / cog.
export const GEAR_RATIOS = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.40,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];

/** Resistive force on the virtual bike at speed v (m/s) on grade (fraction). */
export function resistForce(v, grade, p) {
  const th = Math.atan(grade);
  const m = p.riderKg + p.bikeKg;
  const gravity = m * G * Math.sin(th);
  const rolling = m * G * Math.cos(th) * p.crr;
  const aero = 0.5 * RHO * p.cda * v * v;
  return gravity + rolling + aero;
}

/** Steady-state power needed to hold speed v on grade. */
export function powerAt(v, grade, p) {
  return resistForce(v, grade, p) * v;
}

/** Steady-state speed for power P on grade (bisection). */
export function speedForPower(P, grade, p) {
  if (P <= 0) return 0;
  let lo = 0, hi = 30;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (powerAt(mid, grade, p) > P) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Virtual bike with a freewheel. Speed is locked to cadence x gear while the
 * rider is pedalling fast enough to drive the wheel; otherwise it coasts.
 */
export class VirtualBike {
  constructor(params) {
    this.p = params;
    this.v = 0;          // m/s
    this.dist = 0;       // m
    this.engaged = false;
  }

  /** Development: metres travelled per crank revolution in a given gear. */
  dev(ratio) { return ratio * this.p.wheelCirc; }

  /**
   * Sim-mode tick. Speed is integrated from the measured power (so inertia is
   * real); the gear decides how fast the pedals turn at that speed. While the
   * rider's pedal speed keeps up with the wheel the drivetrain is engaged and
   * the rider feels the full road force; if they stop or spin slower than the
   * wheel, the freewheel disengages and the trainer goes light.
   * Returns { v, force, engaged, vPed }.
   */
  stepSim(dt, power, cadence, grade, ratio) {
    const vPed = (cadence / 60) * this.dev(ratio);
    this.stepPower(dt, power, grade);
    if (cadence < 5) this.engaged = false;
    else if (vPed >= this.v * 0.97 - 0.1) this.engaged = true;
    else if (vPed < this.v * 0.9 - 0.3) this.engaged = false;
    const force = this.engaged ? resistForce(Math.max(this.v, vPed * 0.5), grade, this.p) : 0;
    return { v: this.v, force, engaged: this.engaged, vPed };
  }

  /** ERG/power-driven tick: integrate speed from measured power. */
  stepPower(dt, power, grade) {
    const m = this.p.riderKg + this.p.bikeKg;
    const vEff = Math.max(this.v, 1.0);
    const a = (power / vEff - resistForce(this.v, grade, this.p)) / m;
    this.v = Math.max(0, this.v + a * dt);
    if (power <= 0 && this.v < 0.05) this.v = 0;
    this.dist += this.v * dt;
    return { v: this.v };
  }
}

/**
 * Convert the virtual-bike demand into the grade we send the trainer.
 * The trainer models force = Mt * g * grade at its own wheel speed vr, so its
 * power = Mt*g*Gs*vr. We want that to equal F_virtual * v_virtual. With
 * k = v_virtual / vr = devVirtual / devReal, Gs = k * F / (Mt * g).
 */
export function gradeToSend(force, k, trainerMassKg) {
  return (k * force) / (trainerMassKg * G);
}

/** Running estimator of the real (physical) development the trainer sees. */
export class DevEstimator {
  constructor(initial) { this.dev = initial; this.n = 0; }
  update(speedMs, cadence) {
    if (cadence < 45 || speedMs < 3) return this.dev;
    const sample = speedMs / (cadence / 60);
    if (sample < 2 || sample > 12) return this.dev; // reject junk
    const alpha = this.n < 20 ? 0.2 : 0.03;
    this.dev += alpha * (sample - this.dev);
    this.n++;
    return this.dev;
  }
}

/** Estimates the mass the trainer assumes in sim mode, from its response. */
export class TrainerMassEstimator {
  constructor(initial) { this.m = initial; this.n = 0; }
  update(power, sentGrade, trainerSpeedMs) {
    if (sentGrade < 0.03 || trainerSpeedMs < 3 || power < 60) return this.m;
    const sample = power / (G * sentGrade * trainerSpeedMs);
    if (sample < 30 || sample > 200) return this.m;
    this.m += 0.01 * (sample - this.m);
    this.n++;
    return this.m;
  }
}
