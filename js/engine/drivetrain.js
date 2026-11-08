// Virtual drivetrains: real chainring/cassette combos (or Zwift's 24 sequential ratios).

const SEQ24 = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.40,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];

export const DRIVETRAINS = {
  'road-2x12-shimano-50-34': { name: 'Road 2x12 Shimano, 50/34 + 11-34', rings: [34, 50], cogs: [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34], wheel: 2.105 },
  'road-2x12-shimano-52-36': { name: 'Road 2x12 Shimano, 52/36 + 11-30', rings: [36, 52], cogs: [11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 27, 30], wheel: 2.105 },
  'road-2x12-sram-48-35': { name: 'Road 2x12 SRAM AXS, 48/35 + 10-33', rings: [35, 48], cogs: [10, 11, 12, 13, 14, 15, 17, 19, 21, 24, 28, 33], wheel: 2.105 },
  'road-2x12-sram-46-33': { name: 'Road 2x12 SRAM AXS, 46/33 + 10-36', rings: [33, 46], cogs: [10, 11, 12, 13, 15, 17, 19, 21, 24, 28, 32, 36], wheel: 2.105 },
  'gravel-1x12-sram-40': { name: 'Gravel 1x12 SRAM XPLR, 40T + 10-44', rings: [40], cogs: [10, 11, 13, 15, 17, 19, 21, 24, 28, 32, 38, 44], wheel: 2.2 },
  'mtb-1x12-sram-34': { name: 'MTB 1x12 SRAM Eagle, 34T + 10-52', rings: [34], cogs: [10, 12, 14, 16, 18, 21, 24, 28, 32, 36, 42, 52], wheel: 2.32 },
  'mtb-1x12-shimano-32': { name: 'MTB 1x12 Shimano, 32T + 10-51', rings: [32], cogs: [10, 12, 14, 16, 18, 21, 24, 28, 33, 39, 45, 51], wheel: 2.32 },
  'zwift-24': { name: 'Zwift virtual 24-speed (sequential)', seq: SEQ24, wheel: 2.105 },
};
export const DEFAULT_DRIVETRAIN = 'road-2x12-shimano-50-34';

export class Gearbox {
  constructor(id = DEFAULT_DRIVETRAIN) {
    this.id = DRIVETRAINS[id] ? id : DEFAULT_DRIVETRAIN;
    this.d = DRIVETRAINS[this.id];
    this.seq = !!this.d.seq;
    // rear position 0 = easiest (biggest cog); front 0 = small ring
    this.cogsEasyFirst = this.seq ? [] : [...this.d.cogs].sort((a, b) => b - a);
    this.front = this.seq ? 0 : this.d.rings.length - 1;
    this.rear = 0;
    this.setClosest(this.seq ? 2.4 : this.d.rings.length > 1 ? 2.6 : 2.2);
  }
  get wheel() { return this.d.wheel; }
  get isDouble() { return !this.seq && this.d.rings.length > 1; }
  get nRear() { return this.seq ? this.d.seq.length : this.d.cogs.length; }
  get ring() { return this.seq ? null : this.d.rings[this.front]; }
  get cog() { return this.seq ? null : this.cogsEasyFirst[this.rear]; }
  get ratio() { return this.seq ? this.d.seq[this.rear] : this.ring / this.cog; }
  get label() { return this.seq ? String(this.rear + 1) : `${this.ring}x${this.cog}`; }

  setClosest(target) {
    let best = Infinity;
    for (let r = 0; r < this.nRear; r++) {
      const ratio = this.seq ? this.d.seq[r] : this.ring / this.cogsEasyFirst[r];
      if (Math.abs(ratio - target) < best) { best = Math.abs(ratio - target); this.rear = r; }
    }
  }
  /** dir +1 = harder. Returns true if it moved. */
  shiftRear(dir) {
    const r = Math.max(0, Math.min(this.nRear - 1, this.rear + dir));
    if (r === this.rear) return false;
    this.rear = r;
    return true;
  }
  shiftFront(dir) {
    if (!this.isDouble) return false;
    const f = Math.max(0, Math.min(this.d.rings.length - 1, this.front + dir));
    if (f === this.front) return false;
    this.front = f;
    return true;
  }
  toggleFront() { return this.isDouble ? this.shiftFront(this.front === 0 ? 1 : -1) : false; }
}
