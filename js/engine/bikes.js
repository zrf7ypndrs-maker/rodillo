// Bike weight presets and a simple estimator (Settings > Rider).
// Only slope mode uses the bike's weight (rider + bike = the mass that climbs and coasts); ERG ignores it.
//
// Estimate = frame (carbon weight x material factor) + fork + rest of the bike (wheels, tires, groupset, cockpit,
// brakes, dropper), by type and build level. Size M, no pedals. Calibrated against claimed and measured weights
// of current bikes: carbon road 6.8 (high-end) / 7.9 (mid) / 9.1 kg (entry), aluminum gravel ~10.8, carbon XC
// hardtail ~8.6-10, carbon XC full suspension ~9.5-11, alloy trail ~16, carbon enduro ~15.7, DH ~17.

export const BIKE_TYPES = {
  road: { name: 'Road (race / climbing)', fam: 'road', frame: 1.25, rest: 6.6 },
  aero: { name: 'Aero road', fam: 'road', frame: 1.6, rest: 6.9 },
  endurance: { name: 'Endurance road', fam: 'road', frame: 1.4, rest: 6.9 },
  gravel: { name: 'Gravel', fam: 'road', frame: 1.55, rest: 7.4 },
  cx: { name: 'Cyclocross', fam: 'road', frame: 1.5, rest: 7.0 },
  tt: { name: 'TT / triathlon', fam: 'road', frame: 2.0, rest: 7.4 },
  hybrid: { name: 'Hybrid / fitness', fam: 'road', frame: 1.6, rest: 8.4 },
  xc: { name: 'XC / downcountry', fam: 'mtb', hardtail: 1.0, rest: 7.6, front: 100, rear: 100 },
  trail: { name: 'Trail', fam: 'mtb', hardtail: 1.3, rest: 9.4, front: 140, rear: 130 },
  enduro: { name: 'Enduro', fam: 'mtb', hardtail: 1.5, rest: 10.6, front: 170, rear: 160 },
  dh: { name: 'Downhill', fam: 'mtb', hardtail: 1.6, rest: 11.0, front: 200, rear: 200 },
};

// frame weight relative to carbon
export const MATERIALS = {
  carbon: { name: 'Carbon', k: 1 },
  aluminum: { name: 'Aluminum', k: 1.45 },
  titanium: { name: 'Titanium', k: 1.3 },
  steel: { name: 'Steel', k: 1.9 },
};

// rest-of-bike change from mid-range: entry = Tiagra / Deore + alloy wheels, high-end = Dura-Ace / XX + carbon wheels
export const BUILDS = {
  entry: { name: 'Entry (Tiagra, Deore, alloy wheels)', road: 1.2, mtb: 1.5 },
  mid: { name: 'Mid-range (105, Rival, GX)', road: 0, mtb: 0 },
  high: { name: 'High-end (Dura-Ace, Red, XX, carbon wheels)', road: -1.0, mtb: -1.4 },
};

export const BIKE_PRESETS = {
  'road-carbon': { group: 'Road', name: 'Carbon road', type: 'road', material: 'carbon' },
  'aero-carbon': { group: 'Road', name: 'Carbon aero road', type: 'aero', material: 'carbon' },
  'endurance-carbon': { group: 'Road', name: 'Carbon endurance road', type: 'endurance', material: 'carbon' },
  'road-aluminum': { group: 'Road', name: 'Aluminum road', type: 'road', material: 'aluminum' },
  'road-titanium': { group: 'Road', name: 'Titanium road', type: 'endurance', material: 'titanium' },
  'road-steel': { group: 'Road', name: 'Steel road', type: 'endurance', material: 'steel' },
  'tt-carbon': { group: 'Road', name: 'Carbon TT / triathlon', type: 'tt', material: 'carbon' },
  'gravel-carbon': { group: 'Gravel and cyclocross', name: 'Carbon gravel', type: 'gravel', material: 'carbon' },
  'gravel-aluminum': { group: 'Gravel and cyclocross', name: 'Aluminum gravel', type: 'gravel', material: 'aluminum' },
  'cx-carbon': { group: 'Gravel and cyclocross', name: 'Carbon cyclocross', type: 'cx', material: 'carbon' },
  'xc-ht-carbon': { group: 'Mountain', name: 'Carbon XC hardtail (100 mm)', type: 'xc', material: 'carbon', front: 100, rear: 0 },
  'xc-ht-aluminum': { group: 'Mountain', name: 'Aluminum XC hardtail (100 mm)', type: 'xc', material: 'aluminum', front: 100, rear: 0 },
  'xc-fs-carbon': { group: 'Mountain', name: 'Carbon XC full suspension (100 mm)', type: 'xc', material: 'carbon', front: 100, rear: 100 },
  'downcountry-carbon': { group: 'Mountain', name: 'Carbon downcountry (120 mm)', type: 'xc', material: 'carbon', front: 120, rear: 120 },
  'trail-carbon': { group: 'Mountain', name: 'Carbon trail (140 / 130 mm)', type: 'trail', material: 'carbon', front: 140, rear: 130 },
  'trail-aluminum': { group: 'Mountain', name: 'Aluminum trail (140 / 130 mm)', type: 'trail', material: 'aluminum', front: 140, rear: 130 },
  'enduro-carbon': { group: 'Mountain', name: 'Carbon enduro (170 / 160 mm)', type: 'enduro', material: 'carbon', front: 170, rear: 160 },
  'enduro-aluminum': { group: 'Mountain', name: 'Aluminum enduro (170 / 160 mm)', type: 'enduro', material: 'aluminum', front: 170, rear: 160 },
  'dh-aluminum': { group: 'Mountain', name: 'Aluminum downhill (200 mm)', type: 'dh', material: 'aluminum', front: 200, rear: 200 },
  'hybrid-aluminum': { group: 'Other', name: 'Aluminum hybrid / fitness', type: 'hybrid', material: 'aluminum' },
};
export const BIKE_CUSTOM = 'custom'; // own type / material / travel / build
export const BIKE_EXACT = 'exact';   // typed weight, no estimate

export const MAX_TRAVEL = 220;
const travel = (x) => Math.max(0, Math.min(MAX_TRAVEL, Math.round(Number(x) || 0)));

/** Spec with known keys and travel that fits the type (drop-bar and hybrid bikes have none). */
export function cleanSpec(s = {}) {
  const type = BIKE_TYPES[s.type] ? s.type : 'road';
  const t = BIKE_TYPES[type];
  const mtb = t.fam === 'mtb';
  return {
    type,
    material: MATERIALS[s.material] ? s.material : 'carbon',
    front: mtb ? travel(s.front ?? t.front) : 0,
    rear: mtb ? travel(s.rear ?? t.rear) : 0,
    build: BUILDS[s.build] ? s.build : 'mid',
  };
}

/** Spec for a preset at a build level. */
export function presetSpec(id, build = 'mid') {
  const p = BIKE_PRESETS[id];
  return p ? cleanSpec({ ...p, build }) : null;
}

/** The parts of the estimate in kg: { frame, fork, rest, total } (total rounded to 0.1 kg). */
export function bikeParts(spec) {
  const s = cleanSpec(spec), t = BIKE_TYPES[s.type], k = MATERIALS[s.material].k;
  let frame, fork = 0;
  if (t.fam === 'mtb') {
    // carbon frame incl. rear shock grows with rear travel; suspension fork with front travel (SID SL 100 mm ~1.4 kg, ZEB 170 ~2.3)
    frame = (s.rear > 0 ? 0.5 + 0.0145 * s.rear : t.hardtail) * k;
    fork = s.front > 0 ? 0.07 + 0.0131 * s.front : 0.65;
  } else frame = t.frame * k; // drop-bar frame weights include the fork
  const rest = t.rest + BUILDS[s.build][t.fam];
  return { frame, fork, rest, total: Math.round((frame + fork + rest) * 10) / 10 };
}
export const estimateBikeKg = (spec) => bikeParts(spec).total;

/** The preset matching a spec (build level ignored), or null. */
export function bikePresetFor(spec) {
  const s = cleanSpec(spec);
  for (const id of Object.keys(BIKE_PRESETS)) {
    const p = presetSpec(id, s.build);
    if (p.type === s.type && p.material === s.material && p.front === s.front && p.rear === s.rear) return id;
  }
  return null;
}
