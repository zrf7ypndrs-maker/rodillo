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
   * Sim-mode tick. While the rider pedals fast enough to drive the wheel, the drivetrain
   * is engaged and wheel speed = pedal speed x gear (the trainer's real flywheel supplies
   * the inertia). When the rider stops or spins slower than the wheel, the freewheel
   * disengages and the virtual bike coasts on road physics until the pedals catch up.
   * Returns { v, force, engaged, vPed }.
   */
  stepSim(dt, power, cadence, grade, ratio) {
    const m = this.p.riderKg + this.p.bikeKg;
    const vPed = (cadence / 60) * this.dev(ratio);
    if (this.engaged) {
      this._slow = cadence < 5 || vPed < this.v - 0.6 ? (this._slow || 0) + dt : 0;
      if (this._slow > 0.75) this.engaged = false;
    } else if (cadence >= 5 && vPed >= this.v - 0.15) this.engaged = true;
    if (this.engaged) {
      this.v += (vPed - this.v) * Math.min(1, dt * 4); // light smoothing of cadence noise
    } else {
      this.v = Math.max(0, this.v - (resistForce(this.v, grade, this.p) / m) * dt);
      if (this.v < 0.05 && grade >= 0) this.v = 0;
    }
    this.dist += this.v * dt;
    const force = this.engaged ? resistForce(this.v, grade, this.p) : 0;
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
