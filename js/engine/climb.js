// Real climbs (Farellones, Antenas, El Durazno...): the workout carries the climb's full elevation profile and the
// app cuts it into slope steps at the detail the rider picks (Nov 11, asked for by Agustín: a slider with a Default).
//
//   "profile": {
//     "every": 25,                 // metres between elevation points
//     "elev": [1013.9, 1015.7, ...],
//     "detail": 4,                 // default level (index into DETAIL_LEVELS, 1-based)
//     "lead": [{ "dur": 600, "grade": 0, "label": "Warm-up roll" }],   // steps before the climb
//     "source": "Strava segment 11518432 (via bikeclimbs)"
//   }
//
// The workout's own "steps" are the default cut (tools/climb.mjs writes them), so tools that only read steps keep working.

/** tol = Douglas-Peucker tolerance (m of elevation), min = shortest stretch (m). Level 1 keeps every point. */
export const DETAIL_LEVELS = [
  { tol: 0, min: 0 },
  { tol: 0.75, min: 50 },
  { tol: 1.5, min: 100 },
  { tol: 2.5, min: 150 },
  { tol: 4, min: 300 },
  { tol: 6, min: 500 },
  { tol: 10, min: 800 },
];
export const DETAIL_MIN = 1, DETAIL_MAX = DETAIL_LEVELS.length;
export const clampDetail = (lv) => Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, Math.round(Number(lv)) || 4));
export const defaultDetail = (w) => clampDetail(w?.profile?.detail ?? 4);

/** "150 m stretches" / "every 25 m" for the slider readout. */
export function detailLabel(profile, lv) {
  const L = DETAIL_LEVELS[clampDetail(lv) - 1];
  return L.min ? `${L.min} m stretches` : `every ${profile.every} m`;
}

function simplify(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x0, y0] = pts[a], [x1, y1] = pts[b];
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      const d = Math.abs(y - (y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)));
      if (d > best) { best = d; bi = i; }
    }
    if (bi > 0 && best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Stretches [d0, d1, h0, h1] for one detail level: simplify, then merge stretches shorter than min into the neighbour with the closer grade. */
export function profileStretches(profile, lv) {
  const { tol, min } = DETAIL_LEVELS[clampDetail(lv) - 1];
  const e = profile.elev, every = profile.every;
  const pts = e.map((h, i) => [i * every, h]);
  if (profile.length != null && pts.length > 1) pts[pts.length - 1][0] = profile.length; // last point may be closer than `every`
  const v = simplify(pts, tol);
  const segs = [];
  for (let i = 0; i < v.length - 1; i++) segs.push([v[i][0], v[i + 1][0], v[i][1], v[i + 1][1]]);
  const g = (s) => (s[3] - s[2]) / (s[1] - s[0]);
  for (let changed = true; changed && segs.length > 1;) {
    changed = false;
    for (let k = 0; k < segs.length; k++) {
      if (segs[k][1] - segs[k][0] >= min) continue;
      const j = k === 0 ? 1 : k === segs.length - 1 ? k - 1
        : Math.abs(g(segs[k - 1]) - g(segs[k])) <= Math.abs(g(segs[k + 1]) - g(segs[k])) ? k - 1 : k + 1;
      const a = Math.min(k, j), b = Math.max(k, j);
      segs.splice(a, 2, [segs[a][0], segs[b][1], segs[a][2], segs[b][3]]);
      changed = true;
      break;
    }
  }
  return segs;
}

const km = (m) => (m / 1000).toFixed(1);

/** Slope steps (distance, grade in %) for one detail level. */
export function profileSteps(profile, lv) {
  return profileStretches(profile, lv).map(([d0, d1, h0, h1]) => {
    const a = Math.round(d0 / 5) * 5, b = Math.round(d1 / 5) * 5;
    return { dist: Math.max(5, b - a), grade: Math.round(((h1 - h0) / (d1 - d0)) * 1000) / 10, label: `km ${km(a)} to ${km(b)}` };
  });
}

/** The workout cut at a detail level (a new object; workouts without a profile come back unchanged). */
export function withDetail(w, lv) {
  if (!w?.profile?.elev?.length) return w;
  const level = clampDetail(lv ?? defaultDetail(w));
  return { ...w, steps: [...(w.profile.lead || []), ...profileSteps(w.profile, level)], detail: level };
}
