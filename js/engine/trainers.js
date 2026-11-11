// Smart trainers and the grade range each one can simulate (maker's spec, as fractions).
// Rodillo never sends a grade outside the range of the chosen trainer (Settings > Trainer).
// Brake trainers can't push the rider downhill: below 0% they only get as light as they can,
// but Rodillo still sends small negative grades to cancel the trainer's own drag.

export const TRAINERS = {
  'wahoo-kickr-core': { name: 'Wahoo KICKR CORE', max: 0.16, min: -0.10, match: /kickr\s*core/i },
  'wahoo-kickr': { name: 'Wahoo KICKR (2018 and newer)', max: 0.20, min: -0.10, match: /^kickr(?!\s*(core|snap|move|bike|rollr))/i },
  'wahoo-kickr-move': { name: 'Wahoo KICKR MOVE', max: 0.20, min: -0.10, match: /kickr\s*move/i },
  'wahoo-kickr-snap': { name: 'Wahoo KICKR SNAP', max: 0.12, min: -0.10, match: /kickr\s*snap/i },
  'zwift-hub': { name: 'Zwift Hub', max: 0.16, min: -0.10, match: /zwift\s*hub/i },
  'tacx-neo': { name: 'Tacx NEO 2T / NEO 3M', max: 0.25, min: -0.05, match: /neo/i },
  'tacx-flux': { name: 'Tacx FLUX 2', max: 0.16, min: -0.10, match: /flux/i },
  'elite-direto-xr': { name: 'Elite Direto XR', max: 0.24, min: -0.10, match: /direto/i },
  'elite-suito': { name: 'Elite Suito', max: 0.15, min: -0.10, match: /suito/i },
  'saris-h3': { name: 'Saris H3', max: 0.20, min: -0.10, match: /\bh3\b|saris/i },
};
export const CUSTOM_TRAINER = 'custom';

/** Trainer preset from the Bluetooth name ("KICKR CORE 1A2B"), or null. */
export function matchTrainer(name) {
  if (!name) return null;
  for (const [id, t] of Object.entries(TRAINERS)) if (t.match.test(name)) return id;
  return null;
}

const eq = (a, b) => Math.abs(a - b) < 1e-6;
/** True when min/max is exactly that preset's range. */
export function trainerFits(id, min, max) { const t = TRAINERS[id]; return !!t && eq(t.min, min) && eq(t.max, max); }
/** The first preset whose range is exactly min/max, or null (several trainers share a range). */
export function trainerFor(min, max) {
  for (const id of Object.keys(TRAINERS)) if (trainerFits(id, min, max)) return id;
  return null;
}

/** Clamps a hand-typed range to something any trainer can take. */
export function cleanRange(min, max) {
  const mx = Math.max(0.01, Math.min(0.4, Number.isFinite(max) ? max : 0.16));
  const mn = Math.max(-0.3, Math.min(0, Number.isFinite(min) ? min : -0.1));
  return { min: mn, max: mx };
}
