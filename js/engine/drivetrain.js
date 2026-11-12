// Virtual drivetrains: real chainring/cassette combos (or Zwift's 24 sequential ratios).

const SEQ24 = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.40,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];

// Cassettes (teeth, smallest first). Only real, shipping cassettes.
const C = {
  sh12_1130: [11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 27, 30],
  sh12_1134: [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34],
  sh12_1136: [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 31, 36],
  sh11_1128: [11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 28],
  sh11_1132: [11, 12, 13, 14, 16, 18, 20, 22, 25, 28, 32],
  sr12_1028: [10, 11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 28],
  sr12_1030: [10, 11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30],
  sr12_1033: [10, 11, 12, 13, 14, 15, 17, 19, 21, 24, 28, 33],
  sr12_1036: [10, 11, 12, 13, 15, 17, 19, 21, 24, 28, 32, 36],
  xplr_1044: [10, 11, 13, 15, 17, 19, 21, 24, 28, 32, 38, 44],
  sh12_1045: [10, 12, 14, 16, 18, 21, 24, 28, 32, 36, 40, 45],
  sh12_1051: [10, 12, 14, 16, 18, 21, 24, 28, 33, 39, 45, 51],
  eagle_1050: [10, 12, 14, 16, 18, 21, 24, 28, 32, 36, 42, 50],
  eagle_1052: [10, 12, 14, 16, 18, 21, 24, 28, 32, 36, 42, 52],
  eagle_t_1052: [10, 12, 14, 16, 18, 21, 24, 28, 32, 38, 44, 52], // Eagle Transmission (T-Type) XS-1275 / 1295 / 1299
};

/** Wheel circumference (m) by tire. */
export const WHEELS = [
  [2.105, 'Road 700 x 25c'], [2.136, 'Road 700 x 28c'], [2.155, '700 x 32c'],
  [2.2, 'Gravel 700 x 40c'], [2.298, 'MTB 29 x 2.2'], [2.32, 'MTB 29 x 2.4'],
];
const ROAD = 2.105, GRAVEL = 2.2, MTB = 2.32;

// Ids already saved in settings must keep working: never rename one.
export const DRIVETRAINS = {
  'road-2x12-shimano-50-34': { group: 'Road, Shimano 12-speed', name: 'Shimano 12s, 50/34 + 11-34', rings: [34, 50], cogs: C.sh12_1134, wheel: ROAD },
  'road-2x12-shimano-50-34-1130': { group: 'Road, Shimano 12-speed', name: 'Shimano 12s, 50/34 + 11-30', rings: [34, 50], cogs: C.sh12_1130, wheel: ROAD },
  'road-2x12-shimano-50-34-1136': { group: 'Road, Shimano 12-speed', name: 'Shimano 105 12s, 50/34 + 11-36', rings: [34, 50], cogs: C.sh12_1136, wheel: ROAD },
  'road-2x12-shimano-52-36': { group: 'Road, Shimano 12-speed', name: 'Shimano 12s, 52/36 + 11-30', rings: [36, 52], cogs: C.sh12_1130, wheel: ROAD },
  'road-2x12-shimano-52-36-1134': { group: 'Road, Shimano 12-speed', name: 'Shimano 12s, 52/36 + 11-34', rings: [36, 52], cogs: C.sh12_1134, wheel: ROAD },
  'road-2x12-shimano-54-40': { group: 'Road, Shimano 12-speed', name: 'Shimano Dura-Ace 12s, 54/40 + 11-30', rings: [40, 54], cogs: C.sh12_1130, wheel: ROAD },
  'road-2x12-sram-50-37': { group: 'Road, SRAM AXS 12-speed', name: 'SRAM AXS, 50/37 + 10-28', rings: [37, 50], cogs: C.sr12_1028, wheel: ROAD },
  'road-2x12-sram-50-37-1033': { group: 'Road, SRAM AXS 12-speed', name: 'SRAM AXS, 50/37 + 10-33', rings: [37, 50], cogs: C.sr12_1033, wheel: ROAD },
  'road-2x12-sram-48-35-1030': { group: 'Road, SRAM AXS 12-speed', name: 'SRAM AXS, 48/35 + 10-30', rings: [35, 48], cogs: C.sr12_1030, wheel: ROAD },
  'road-2x12-sram-48-35': { group: 'Road, SRAM AXS 12-speed', name: 'SRAM AXS, 48/35 + 10-33', rings: [35, 48], cogs: C.sr12_1033, wheel: ROAD },
  'road-2x12-sram-46-33': { group: 'Road, SRAM AXS 12-speed', name: 'SRAM AXS, 46/33 + 10-36', rings: [33, 46], cogs: C.sr12_1036, wheel: ROAD },
  'road-2x11-shimano-50-34': { group: 'Road, Shimano 11-speed', name: 'Shimano 11s, 50/34 + 11-32', rings: [34, 50], cogs: C.sh11_1132, wheel: ROAD },
  'road-2x11-shimano-52-36': { group: 'Road, Shimano 11-speed', name: 'Shimano 11s, 52/36 + 11-28', rings: [36, 52], cogs: C.sh11_1128, wheel: ROAD },
  'gravel-2x12-grx-48-31': { group: 'Gravel', name: 'Shimano GRX 2x12, 48/31 + 11-34', rings: [31, 48], cogs: C.sh12_1134, wheel: GRAVEL },
  'gravel-1x12-grx-40': { group: 'Gravel', name: 'Shimano GRX 1x12, 40T + 10-45', rings: [40], cogs: C.sh12_1045, wheel: GRAVEL },
  'gravel-1x12-sram-40': { group: 'Gravel', name: 'SRAM XPLR 1x12, 40T + 10-44', rings: [40], cogs: C.xplr_1044, wheel: GRAVEL },
  'mtb-1x12-sram-34': { group: 'Mountain bike', name: 'SRAM Eagle, 34T + 10-52', rings: [34], cogs: C.eagle_1052, wheel: MTB },
  'mtb-1x12-sram-32': { group: 'Mountain bike', name: 'SRAM Eagle, 32T + 10-52', rings: [32], cogs: C.eagle_1052, wheel: MTB },
  'mtb-1x12-sram-t-32': { group: 'Mountain bike', name: 'SRAM Eagle Transmission, 32T + 10-52', rings: [32], cogs: C.eagle_t_1052, wheel: MTB },
  'mtb-1x12-sram-t-34': { group: 'Mountain bike', name: 'SRAM Eagle Transmission, 34T + 10-52', rings: [34], cogs: C.eagle_t_1052, wheel: MTB },
  'mtb-1x12-sram-32-1050': { group: 'Mountain bike', name: 'SRAM Eagle, 32T + 10-50', rings: [32], cogs: C.eagle_1050, wheel: MTB },
  'mtb-1x12-shimano-32': { group: 'Mountain bike', name: 'Shimano 12s, 32T + 10-51', rings: [32], cogs: C.sh12_1051, wheel: MTB },
  'mtb-1x12-shimano-34': { group: 'Mountain bike', name: 'Shimano 12s, 34T + 10-51', rings: [34], cogs: C.sh12_1051, wheel: MTB },
  'zwift-24': { group: 'Virtual', name: 'Zwift virtual 24-speed (sequential)', seq: SEQ24, wheel: ROAD },
};
export const DEFAULT_DRIVETRAIN = 'road-2x12-shimano-50-34';
export const CUSTOM = 'custom';

/** Teeth from free text ("50/34", "11-12-13 ..."). Returns numbers or null if something isn't a number. */
export function parseTeeth(text) {
  const parts = String(text ?? '').trim().split(/[\s,/\-x\u00d7]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** Checks a chainring/cog spec. Returns { spec } with sorted teeth, or { error }. */
export function checkSpec({ rings, cogs, wheel }) {
  if (!rings?.length) return { error: 'Chainrings: type the teeth, like 50/34 or 40.' };
  if (rings.length > 2) return { error: 'Chainrings: one or two rings.' };
  if (rings.some((t) => t < 20 || t > 60)) return { error: 'Chainrings: each ring between 20 and 60 teeth.' };
  if (new Set(rings).size !== rings.length) return { error: 'Chainrings: the two rings need different sizes.' };
  if (!cogs?.length) return { error: 'Cogs: list every cog, like 11-12-13-14-15-17-19-21-24-27-30-34.' };
  if (cogs.length < 5) return { error: 'Cogs: list every cog, not just the range (at least 5).' };
  if (cogs.length > 14) return { error: 'Cogs: 14 at most.' };
  if (cogs.some((t) => t < 9 || t > 60)) return { error: 'Cogs: each cog between 9 and 60 teeth.' };
  if (new Set(cogs).size !== cogs.length) return { error: 'Cogs: a size is listed twice.' };
  const w = Number(wheel);
  return {
    spec: {
      rings: [...rings].sort((a, b) => a - b),
      cogs: [...cogs].sort((a, b) => a - b),
      wheel: w >= 1.5 && w <= 2.6 ? w : ROAD,
    },
  };
}

const sameTeeth = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The preset id with exactly these teeth and wheel, or null. */
export function presetFor(spec) {
  for (const [id, d] of Object.entries(DRIVETRAINS)) {
    if (!d.seq && sameTeeth(d.rings, spec.rings) && sameTeeth(d.cogs, spec.cogs) && d.wheel === spec.wheel) return id;
  }
  return null;
}

/** "2x12" / "1x12" / "24 gears". */
export function speeds(d) { return d.seq ? `${d.seq.length} gears` : `${d.rings.length}x${d.cogs.length}`; }

/** What a ride uses: a preset id, or the custom spec when settings.drivetrain is "custom". */
export function resolveDrivetrain(settings = {}) {
  if (settings.drivetrain === CUSTOM) {
    const r = checkSpec(settings.customDrivetrain || {});
    if (r.spec) return { ...r.spec, name: `Custom ${r.spec.rings.join('/')} + ${r.spec.cogs[0]}-${r.spec.cogs.at(-1)}` };
    return DEFAULT_DRIVETRAIN;
  }
  return DRIVETRAINS[settings.drivetrain] ? settings.drivetrain : DEFAULT_DRIVETRAIN;
}

export class Gearbox {
  /** id: a preset id, or a spec { rings, cogs, wheel } (custom). */
  constructor(id = DEFAULT_DRIVETRAIN) {
    const spec = typeof id === 'object' && id ? checkSpec(id).spec : null;
    if (spec) { this.id = CUSTOM; this.d = { ...spec, name: id.name || 'Custom' }; }
    else { this.id = DRIVETRAINS[id] ? id : DEFAULT_DRIVETRAIN; this.d = DRIVETRAINS[this.id]; }
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

/** Every gear of a drivetrain as { label, dev } (development in metres per crank turn), easiest first. */
export function gearList(id) {
  const gb = new Gearbox(id), w = gb.wheel;
  const out = gb.seq ? gb.d.seq.map((r, i) => ({ label: String(i + 1), dev: r * w }))
    : gb.d.rings.flatMap((ring) => gb.d.cogs.map((cog) => ({ label: `${ring}\u00d7${cog}`, dev: (ring / cog) * w })));
  return out.sort((a, b) => a.dev - b.dev);
}
