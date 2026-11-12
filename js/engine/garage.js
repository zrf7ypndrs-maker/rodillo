// Bike garage (Settings > Garage): saved bikes, each with its own gearing and weight.
// Picking a bike copies its setup into the settings the ride uses (drivetrain, customDrivetrain, bikeKg, bikeSpec),
// so the engine needs nothing new. While a bike is selected, edits in Gearing and Rider > Bike save back to it.
//
// settings.garage = [bike], settings.bike = id of the bike in use ('' = none, the loose settings as before).
// bike = { id, name, model?, drivetrain, customDrivetrain, bikeKg, bikeSpec }

import { DRIVETRAINS, CUSTOM, checkSpec } from './drivetrain.js?v=202611102147';
import { cleanSpec } from './bikes.js?v=202611102147';

// Known bikes. Weight = maker's claim for size M plus pedals, when the pedals are known.
// Ids are saved in settings: never rename one.
export const BIKE_MODELS = {
  'canyon-lux-trail-cf-7': {
    name: 'Canyon Lux Trail CF 7',
    // 2027: SRAM Eagle 90 Transmission, 32T + XS-1275 10-52, Maxxis 29 x 2.4, 12.8 kg (M) + Shimano XT M8100 pedals 0.34 kg
    drivetrain: 'mtb-1x12-sram-t-32', bikeKg: 13.1,
  },
  'canyon-aeroad-cf-slx-7-di2': {
    name: 'Canyon Aeroad CF SLX 7 Di2',
    // Shimano 105 Di2 12s, 52/36 + 11-34, 700 x 26-28c, 7.84 kg (M) + road pedals ~0.25 kg
    drivetrain: 'road-2x12-shimano-52-36-1134', bikeKg: 8.1,
  },
};

export const MAX_BIKES = 12;
const r1 = (x) => Math.round(x * 10) / 10;

/** A garage bike from a known model. */
export function bikeFromModel(model, id = model) {
  const m = BIKE_MODELS[model];
  if (!m) return null;
  return { id, name: m.name, model, drivetrain: m.drivetrain, customDrivetrain: null, bikeKg: m.bikeKg, bikeSpec: null };
}

export const DEFAULT_GARAGE = Object.keys(BIKE_MODELS).map((m) => bikeFromModel(m));

/** A bike with known keys and a setup the ride can use; null if it can't be repaired. */
export function cleanBike(b) {
  if (!b || typeof b !== 'object' || !b.id) return null;
  const custom = b.drivetrain === CUSTOM ? checkSpec(b.customDrivetrain || {}).spec : null;
  const drivetrain = custom ? CUSTOM : DRIVETRAINS[b.drivetrain] ? b.drivetrain : BIKE_MODELS[b.model]?.drivetrain;
  if (!drivetrain) return null;
  const kg = Number(b.bikeKg);
  return {
    id: String(b.id),
    name: String(b.name || 'Bike').trim().slice(0, 40) || 'Bike',
    ...(BIKE_MODELS[b.model] ? { model: b.model } : {}),
    drivetrain,
    customDrivetrain: custom,
    bikeKg: kg > 0 && kg < 40 ? r1(kg) : BIKE_MODELS[b.model]?.bikeKg ?? 9,
    bikeSpec: b.bikeSpec ? cleanSpec(b.bikeSpec) : null,
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
  return { drivetrain: b.drivetrain, customDrivetrain: b.customDrivetrain || null, bikeKg: b.bikeKg, bikeSpec: b.bikeSpec || null };
}

/** Settings changes that put a bike in use ('' = no bike: keep the current setup). */
export function selectBike(settings, id) {
  const b = garageOf(settings).find((x) => x.id === id);
  return b ? { bike: b.id, ...bikeSetup(b) } : { bike: '' };
}

/** The garage with the bike in use updated to the current gearing and weight (unchanged if none is in use). */
export function storeSetup(settings) {
  const g = garageOf(settings);
  const i = g.findIndex((b) => b.id === settings.bike);
  if (i < 0) return g;
  const b = cleanBike({ ...g[i], ...bikeSetup(settings) });
  if (b) g[i] = b;
  return g;
}

/** A free id for a new bike. */
export function newBikeId(garage, base = 'bike') {
  const ids = new Set(garage.map((b) => b.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Short line about a bike: "1x12, 32 + 10-52 · 13.1 kg". */
export function bikeLine(b) {
  const d = b.drivetrain === CUSTOM ? b.customDrivetrain : DRIVETRAINS[b.drivetrain];
  const kg = `${b.bikeKg.toFixed(1)} kg`;
  if (!d) return kg;
  if (d.seq) return `Zwift 24 gears · ${kg}`;
  return `${d.rings.length}x${d.cogs.length}, ${[...d.rings].reverse().join('/')} + ${d.cogs[0]}-${d.cogs.at(-1)} · ${kg}`;
}
