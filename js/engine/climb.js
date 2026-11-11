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

/**
 * Detail levels: the climb is cut on a fixed grid of `len` metres, each stretch at its own average grade, then
 * neighbours whose grades are within MERGE of each other are joined (closest pair first, compared on the merged
 * averages), so steady parts become one step and every kick stays its own (Nov 11, Agustín picked this from a
 * side-by-side with the earlier shape-following cut). Level numbers kept their lengths from that first version.
 */
export const DETAIL_LEVELS = [{ len: 25 }, { len: 50 }, { len: 100 }, { len: 150 }, { len: 300 }, { len: 500 }];
export const MERGE = 0.01; // grade difference (fraction) under which neighbouring stretches are joined
export const DETAIL_MIN = 1, DETAIL_MAX = DETAIL_LEVELS.length;
export const clampDetail = (lv) => Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, Math.round(Number(lv)) || 4));
export const defaultDetail = (w) => clampDetail(w?.profile?.detail ?? 4);

/** "150 m grid" for the slider readout. */
export const detailLabel = (profile, lv) => `${DETAIL_LEVELS[clampDetail(lv) - 1].len} m grid`;

/** Elevation at metres d along the profile (linear between points; the last point sits at `length`). */
function heightAt(profile, d) {
  const e = profile.elev, every = profile.every, L = profile.length ?? (e.length - 1) * every;
  const i = Math.min(Math.max(0, Math.floor(d / every)), e.length - 2);
  const x0 = i * every, x1 = i + 1 === e.length - 1 ? L : (i + 1) * every;
  return e[i] + (e[i + 1] - e[i]) * Math.min(1, Math.max(0, (d - x0) / ((x1 - x0) || 1)));
}

/** Stretches [d0, d1, h0, h1] for one detail level. */
export function profileStretches(profile, lv) {
  const { len } = DETAIL_LEVELS[clampDetail(lv) - 1];
  const L = profile.length ?? (profile.elev.length - 1) * profile.every;
  const segs = [];
  for (let d = 0; d < L - 1e-6; d += len) {
    const d1 = Math.min(d + len, L);
    if (d1 - d < len / 2 && segs.length) { const p = segs.pop(); segs.push([p[0], d1, p[2], heightAt(profile, d1)]); continue; } // short tail joins the last stretch
    segs.push([d, d1, heightAt(profile, d), heightAt(profile, d1)]);
  }
  const g = (s) => (s[3] - s[2]) / (s[1] - s[0]);
  for (;;) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < segs.length - 1; k++) {
      const dg = Math.abs(g(segs[k]) - g(segs[k + 1]));
      if (dg <= MERGE + 1e-9 && dg < bd) { bd = dg; best = k; }
    }
    if (best < 0) break;
    const a = segs[best], b = segs[best + 1];
    segs.splice(best, 2, [a[0], b[1], a[2], b[3]]);
  }
  return segs;
}

const km = (m, dec) => (m / 1000).toFixed(dec);

/** Slope steps (distance, grade in %) for one detail level. */
export function profileSteps(profile, lv) {
  return profileStretches(profile, lv).map(([d0, d1, h0, h1]) => {
    const a = Math.round(d0 / 5) * 5, b = Math.round(d1 / 5) * 5;
    const dec = a % 100 || b % 100 ? 2 : 1; // "km 2.0 to 2.6", "km 2.15 to 2.30"
    return { dist: Math.max(5, b - a), grade: Math.round(((h1 - h0) / (d1 - d0)) * 1000) / 10, label: `km ${km(a, dec)} to ${km(b, dec)}` };
  });
}

/** The workout cut at a detail level (a new object; workouts without a profile come back unchanged). */
export function withDetail(w, lv) {
  if (!w?.profile?.elev?.length) return w;
  const level = clampDetail(lv ?? defaultDetail(w));
  return { ...w, steps: [...(w.profile.lead || []), ...profileSteps(w.profile, level)], detail: level };
}
