// Power zones (Coggan), the single source for zone colors, time-in-zone stats and charts.
// `max` is the zone's upper bound as a fraction of FTP, inclusive: 75% is Z2, 76% is Z3.
// Pure data + functions, no DOM: runs in the browser and in Node.

export const ZONES = [
  { z: 1, name: 'Recovery', min: 0, max: 0.55, color: 'z1' },
  { z: 2, name: 'Endurance', min: 0.56, max: 0.75, color: 'z2' },
  { z: 3, name: 'Tempo', min: 0.76, max: 0.9, color: 'z3' },
  { z: 4, name: 'Threshold', min: 0.91, max: 1.05, color: 'z4' },
  { z: 5, name: 'VO2max', min: 1.06, max: 1.2, color: 'z5' },
  { z: 6, name: 'Anaerobic', min: 1.21, max: 1.5, color: 'z6' },
  { z: 7, name: 'Neuromuscular', min: 1.51, max: Infinity, color: 'z6' }, // shares Z6's red
];

const EPS = 1e-6;

/** Zone index (0-6) for a fraction of FTP. */
export const zoneOf = (f) => {
  const i = ZONES.findIndex((z) => f <= z.max + EPS);
  return i < 0 ? ZONES.length - 1 : i;
};

/** Zone index (0-6) for a power in watts at a given FTP. */
export const zoneOfWatts = (w, ftp) => zoneOf(ftp > 0 ? w / ftp : 0);

/** Range label: "56-75%", or in watts when ftp is given ("111-150 W" at 200 W). */
export function zoneRange(i, ftp) {
  const { min, max } = ZONES[i];
  if (!ftp) {
    const pct = (f) => Math.round(f * 100);
    return i === 0 ? `up to ${pct(max)}%` : max === Infinity ? `${pct(min)}%+` : `${pct(min)}-${pct(max)}%`;
  }
  const top = (f) => Math.floor(f * ftp + EPS); // highest whole watt still in the zone
  const lo = i === 0 ? 0 : top(ZONES[i - 1].max) + 1;
  return max === Infinity ? `${lo}+ W` : `${lo}-${top(max)} W`;
}
