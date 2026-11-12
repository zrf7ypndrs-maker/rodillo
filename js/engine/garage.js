// Bike garage and gearings (Nov 12, Agustín: "bike could just mean weight and wheel size").
//
// A bike is what can't change during a ride: weight and wheel. Picking one copies bikeKg, bikeSpec and wheelCirc
// into settings. bike = { id, name, model?, bikeKg, bikeSpec, wheel }. settings.garage = [bike] (null = the
// built-in two), settings.bike = id in use ('' = none: weight and wheel as set).
//
// Gearing is a separate choice that can change any time, mid-ride too: settings.drivetrain (+ customDrivetrain)
// and settings.shiftStyle. The built-in gearings are the two Canyons' stock drivetrains and Zwift's 24 virtual
// gears; settings.gearings = [gearing] are the rider's own. gearing = { id, name, drivetrain, customDrivetrain,
// shiftStyle }. The gearing in use is whichever one matches settings.drivetrain; no extra key.

import { DRIVETRAINS, CUSTOM, WHEELS, checkSpec } from './drivetrain.js?v=202611102147';
import { cleanSpec } from './bikes.js?v=202611102147';

// Known bikes. Weight = maker's claim for size M plus pedals, when the pedals are known. drivetrain + shiftStyle
// are the bike's stock gearing (a built-in gearing). Ids are saved in settings: never rename one.
export const BIKE_MODELS = {
  'canyon-lux-trail-cf-7': {
    name: 'Canyon Lux Trail CF 7', short: 'Lux Trail CF 7',
    // 2027: SRAM Eagle 90 Transmission, 32T + XS-1275 10-52, Maxxis 29 x 2.4, 12.8 kg (M) + Shimano XT M8100 pedals 0.34 kg
    drivetrain: 'mtb-1x12-sram-t-32', shiftStyle: 'right', bikeKg: 13.1, wheel: 2.32,
    note: "Canyon's spec page (2027): 12.8 kg claimed for size M, plus Shimano XT M8100 pedals", photo: true,
  },
  'canyon-aeroad-cf-slx-7-di2': {
    name: 'Canyon Aeroad CF SLX 7 Di2', short: 'Aeroad CF SLX 7 Di2',
    // Shimano 105 Di2 12s, 52/36 + 11-34, 700 x 26-28c, 7.84 kg (M) + road pedals ~0.25 kg
    drivetrain: 'road-2x12-shimano-52-36-1134', shiftStyle: 'shimano', bikeKg: 8.1, wheel: 2.105,
    note: "Canyon's spec page: 7.84 kg claimed for size M, plus road pedals", photo: true,
  },
};

export const MAX_BIKES = 12;
export const MAX_GEARINGS = 12;
// 2x: 'sram' | 'shimano' (which buttons shift the front). 1x: 'right' | 'left' (the hood the shifter is on).
export const SHIFT_STYLES = ['sram', 'shimano', 'right', 'left'];
/** The style that applies to a drivetrain: a 2x style on a 1x reads as 'right', a 1x side on a 2x as 'sram'. */
export function shiftStyleFor(style, oneX) {
  if (oneX) return style === 'left' ? 'left' : 'right';
  return style === 'shimano' ? 'shimano' : 'sram';
}
const r1 = (x) => Math.round(x * 10) / 10;
const ROAD = 2.105;
const validWheel = (w) => { w = Number(w); return w >= 1.5 && w <= 2.6 ? Math.round(w * 1000) / 1000 : null; };
/** The drivetrain object for a preset id or a custom spec (null if neither works). */
const dtOf = (id, custom) => (id === CUSTOM ? checkSpec(custom || {}).spec || null : DRIVETRAINS[id] || null);
const oneX = (d) => !!d && !d.seq && d.rings.length === 1;

// ---------------------------------------------------------------- bikes

/** A garage bike from a known model. */
export function bikeFromModel(model, id = model) {
  const m = BIKE_MODELS[model];
  if (!m) return null;
  return { id, name: m.name, model, bikeKg: m.bikeKg, bikeSpec: null, wheel: m.wheel };
}

export const DEFAULT_GARAGE = Object.keys(BIKE_MODELS).map((m) => bikeFromModel(m));

/** A bike with known keys; null if it can't be repaired. Old bikes (with gearing) take their wheel from it. */
export function cleanBike(b) {
  if (!b || typeof b !== 'object' || !b.id) return null;
  const m = BIKE_MODELS[b.model];
  const wheel = validWheel(b.wheel) || m?.wheel || validWheel(dtOf(b.drivetrain, b.customDrivetrain)?.wheel) || ROAD;
  const kg = Number(b.bikeKg);
  return {
    id: String(b.id),
    name: String(b.name || 'Bike').trim().slice(0, 40) || 'Bike',
    ...(m ? { model: b.model } : {}),
    bikeKg: kg > 0 && kg < 40 ? r1(kg) : m?.bikeKg ?? 9,
    bikeSpec: b.bikeSpec ? cleanSpec(b.bikeSpec) : null,
    wheel,
  };
}

/** The garage from settings, cleaned. A missing garage is the default one; an empty list stays empty. */
export function garageOf(settings = {}) {
  const g = Array.isArray(settings.garage) ? settings.garage : DEFAULT_GARAGE;
  const seen = new Set();
  return g.map(cleanBike).filter((b) => b && !seen.has(b.id) && seen.add(b.id)).slice(0, MAX_BIKES);
}

/** The bike in use, or null. */
export function currentBike(settings = {}) {
  return garageOf(settings).find((b) => b.id === settings.bike) || null;
}

/** The settings a bike sets. */
export function bikeSetup(b) {
  return { bikeKg: b.bikeKg, bikeSpec: b.bikeSpec || null, wheelCirc: b.wheel };
}

/** Settings changes that put a bike in use ('' = no bike: keep the current weight and wheel). */
export function selectBike(settings, id) {
  const b = garageOf(settings).find((x) => x.id === id);
  return b ? { bike: b.id, ...bikeSetup(b) } : { bike: '' };
}

/** A free id for a new bike (or gearing). */
export function newBikeId(list, base = 'bike') {
  const ids = new Set(list.map((b) => b.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Short tire name: "29 x 2.4", "700 x 25c". */
export function wheelShort(w) {
  const name = WHEELS.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a))[1];
  return name.replace(/^(Road|Gravel|MTB) /, '');
}

/** Short line about a bike: "13.1 kg · 29 x 2.4". */
export function bikeLine(b) {
  return `${b.bikeKg.toFixed(1)} kg · ${wheelShort(b.wheel)}`;
}

// ---------------------------------------------------------------- gearings

/** Built-in gearings: each known bike's stock drivetrain, then Zwift's virtual 24. Ids never renamed. */
export const BUILTIN_GEARINGS = [
  ...Object.entries(BIKE_MODELS).map(([k, m]) => ({ id: k, name: m.short, drivetrain: m.drivetrain, customDrivetrain: null, shiftStyle: m.shiftStyle, builtin: true })),
  { id: 'zwift-24', name: 'Zwift virtual', drivetrain: 'zwift-24', customDrivetrain: null, shiftStyle: 'sram', builtin: true },
];

/** One of the rider's gearings, cleaned; null if its teeth don't work. */
export function cleanGearing(g) {
  if (!g || typeof g !== 'object' || !g.id) return null;
  const custom = g.drivetrain === CUSTOM ? checkSpec(g.customDrivetrain || {}).spec : null;
  const drivetrain = custom ? CUSTOM : DRIVETRAINS[g.drivetrain] ? g.drivetrain : null;
  if (!drivetrain) return null;
  return {
    id: String(g.id),
    name: String(g.name || 'Gearing').trim().slice(0, 40) || 'Gearing',
    drivetrain,
    customDrivetrain: custom,
    shiftStyle: shiftStyleFor(g.shiftStyle, oneX(dtOf(drivetrain, custom))),
  };
}

/** The rider's own gearings (settings.gearings), cleaned. */
export function myGearings(settings = {}) {
  const seen = new Set(BUILTIN_GEARINGS.map((g) => g.id));
  return (Array.isArray(settings.gearings) ? settings.gearings : [])
    .map(cleanGearing).filter((g) => g && !seen.has(g.id) && seen.add(g.id)).slice(0, MAX_GEARINGS);
}

/** Every gearing to pick from: built-ins first, then the rider's own. */
export function gearingsOf(settings = {}) {
  return [...BUILTIN_GEARINGS, ...myGearings(settings)];
}

const sameDt = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** True when the settings ride this gearing (same preset, or the same custom teeth). */
export function usesGearing(settings, g) {
  if (settings.drivetrain !== g.drivetrain) return false;
  if (g.drivetrain !== CUSTOM) return true;
  const s = checkSpec(settings.customDrivetrain || {}).spec;
  return !!s && sameDt([s.rings, s.cogs], [g.customDrivetrain.rings, g.customDrivetrain.cogs]);
}

/** The gearing in use (the rider's own win over a built-in with the same teeth), or null for a loose preset. */
export function currentGearing(settings = {}) {
  const all = gearingsOf(settings);
  return [...all.filter((g) => !g.builtin), ...all.filter((g) => g.builtin)].find((g) => usesGearing(settings, g)) || null;
}

/** Settings changes that put a gearing in use. */
export function selectGearing(settings, id) {
  const g = gearingsOf(settings).find((x) => x.id === id);
  return g ? { drivetrain: g.drivetrain, customDrivetrain: g.customDrivetrain || null, shiftStyle: g.shiftStyle } : {};
}

/** Shifting for a preset picked from the full list: the brand's style on a 2x, the current side on a 1x. */
export function presetStyle(id, prev) {
  const d = DRIVETRAINS[id];
  if (!d) return shiftStyleFor(prev, false);
  if (oneX(d)) return shiftStyleFor(prev, true);
  if (/SRAM/.test(d.name)) return 'sram';
  if (/Shimano/.test(d.name)) return 'shimano';
  return shiftStyleFor(prev, false);
}

/** Settings changes that put a preset from the full list in use. */
export function selectPreset(settings, id) {
  return DRIVETRAINS[id] ? { drivetrain: id, customDrivetrain: null, shiftStyle: presetStyle(id, settings.shiftStyle) } : {};
}

/** "1x12, 32 + 10-52" / "2x12, 52/36 + 11-34" / "24 virtual gears". */
export function gearingLine(g) {
  const d = dtOf(g.drivetrain, g.customDrivetrain);
  if (!d) return '';
  if (d.seq) return `${d.seq.length} virtual gears`;
  return `${d.rings.length}x${d.cogs.length}, ${[...d.rings].reverse().join('/')} + ${d.cogs[0]}-${d.cogs.at(-1)}`;
}

/** Name of what the settings ride: the gearing's name, else the preset's. */
export function gearingName(settings = {}) {
  const g = currentGearing(settings);
  if (g) return g.name;
  return DRIVETRAINS[settings.drivetrain]?.name || gearingLine(settings) || 'Custom';
}

// ---------------------------------------------------------------- moving to the split (Nov 12)

/**
 * Bikes saved before gearing left the bike carry drivetrain / shiftStyle. Returns the settings changes that
 * move them over (custom bikes' gearings become the rider's own gearings, named after the bike), or null when
 * there's nothing to move. The gearing in use doesn't change.
 */
export function migrateGarage(settings = {}) {
  if (!Array.isArray(settings.garage) || !settings.garage.some((b) => b && typeof b === 'object' && 'drivetrain' in b)) return null;
  const mine = myGearings(settings), all = gearingsOf(settings);
  for (const b of settings.garage) {
    if (!b?.drivetrain || BIKE_MODELS[b.model]?.drivetrain === b.drivetrain) continue;
    const g = cleanGearing({ id: `g-${b.id}`, name: b.name, drivetrain: b.drivetrain, customDrivetrain: b.customDrivetrain, shiftStyle: b.shiftStyle });
    if (!g || [...all, ...mine].some((x) => x.id === g.id || usesGearing(g, x))) continue;
    if (mine.length < MAX_GEARINGS) mine.push(g);
  }
  return { garage: settings.garage.map(cleanBike).filter(Boolean), gearings: mine };
}
