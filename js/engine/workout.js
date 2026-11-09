// Workout model, parsers and the interval player.
//
// Workout JSON format (what the coach pushes to /workouts):
// {
//   "id": "vo2-5x4", "name": "VO2 5x4", "description": "...",
//   "tags": ["vo2"],
//   "steps": [
//     { "dur": 600, "from": 0.50, "to": 0.75, "label": "Warm-up" },   // ERG ramp (fraction of FTP)
//     { "dur": 300, "power": 0.65 },                                    // ERG steady (fraction of FTP)
//     { "dur": 300, "watts": 150 },                                     // ERG steady, absolute watts
//     { "repeat": 5, "steps": [ { "dur": 240, "power": 1.05 }, { "dur": 240, "power": 0.50 } ] },
//     { "dur": 360, "grade": 7, "cadence": 65, "text": "Seated grind" },   // SIM: grade in %; cadence target ±5 rpm
//     (cadence can also be a range "80-90" or a floor "100+"; omit it for no target)
//     { "dist": 1500, "grade": 6 },                                   // SIM step by distance (metres)
//     { "dur": 300, "free": true, "label": "Free ride" }                 // SIM at 0%
//   ]
// }

import { speedForPower } from './physics.js?v=202611090201';

const EST = { riderKg: 77, bikeKg: 9, cda: 0.32, crr: 0.004 };

export function flatten(workout, ftp = 200) {
  const out = [];
  const walk = (steps, rep) => {
    for (const s of steps) {
      if (s.repeat) {
        for (let i = 0; i < s.repeat; i++) walk(s.steps, { i: i + 1, of: s.repeat });
        continue;
      }
      const seg = {
        dur: s.dur != null ? Number(s.dur) : null,
        dist: s.dist != null ? Number(s.dist) : null,
        label: s.label || defaultLabel(s),
        text: s.text || '',
        cadence: s.cadence ?? '',
        cad: parseCadence(s.cadence),
        rep,
      };
      if (s.grade !== undefined) { seg.kind = 'sim'; seg.grade = Number(s.grade) / 100; }
      else if (s.free) { seg.kind = 'sim'; seg.grade = 0; seg.free = true; }
      else if (s.watts !== undefined) { seg.kind = 'erg'; seg.watts = Number(s.watts); seg.from = seg.to = seg.watts / ftp; }
      else if (s.from !== undefined) { seg.kind = 'erg'; seg.from = Number(s.from); seg.to = Number(s.to); }
      else { seg.kind = 'erg'; seg.from = seg.to = Number(s.power); }
      if (seg.dur == null && seg.dist) {
        // distance step: estimate its duration (for charts and totals) at a steady ~180 W
        const v = speedForPower(seg.kind === 'erg' ? seg.from * 200 : 180, seg.kind === 'sim' ? seg.grade : 0, EST);
        seg.dur = Math.round(seg.dist / Math.max(v, 1));
        seg.estDur = true;
      }
      out.push(seg);
    }
  };
  walk(workout.steps, null);
  let t = 0;
  for (const s of out) { s.start = t; t += s.dur; s.end = t; }
  return out;
}

function defaultLabel(s) {
  if (s.grade !== undefined) return s.grade > 2 ? `${s.grade}% climb` : s.grade < 0 ? 'Descent' : 'Flat';
  if (s.free) return 'Free ride';
  if (s.watts !== undefined) return 'Steady';
  if (s.from !== undefined) return s.from < s.to ? 'Ramp up' : 'Ramp down';
  const p = Number(s.power);
  if (p < 0.56) return 'Recovery';
  if (p < 0.76) return 'Endurance';
  if (p < 0.88) return 'Tempo';
  if (p < 0.95) return 'Sweet spot';
  if (p < 1.06) return 'Threshold';
  if (p < 1.21) return 'VO2max';
  return 'Anaerobic';
}

/** Cadence target: 90 -> 85..95 (±5 rpm), "80-90" -> range, "100+" -> floor. null if none. */
export function parseCadence(c) {
  if (c === undefined || c === null || c === '') return null;
  const str = String(c).trim();
  let m;
  if ((m = str.match(/^(\d+)$/))) { const n = +m[1]; return { lo: n - 5, hi: n + 5, label: `${n} rpm` }; }
  if ((m = str.match(/^(\d+)\s*-\s*(\d+)$/))) return { lo: +m[1], hi: +m[2], label: `${m[1]}-${m[2]} rpm` };
  if ((m = str.match(/^(\d+)\s*\+$/))) return { lo: +m[1], hi: Infinity, label: `${m[1]}+ rpm` };
  return null;
}

export function totalDuration(workout) {
  const segs = flatten(workout);
  return segs.length ? segs[segs.length - 1].end : 0;
}

/** Target as a fraction of FTP at progress p (0..1) through an ERG segment. */
export function segTarget(seg, p) {
  if (seg.kind !== 'erg') return null;
  const x = Math.min(1, Math.max(0, p));
  return seg.from + (seg.to - seg.from) * x;
}

export const hasDistance = (w) => flatten(w).some((s) => s.dist);

export function segmentAt(segs, t) {
  for (let i = 0; i < segs.length; i++) if (t < segs[i].end) return i;
  return -1;
}

/** Simple training stress estimate for the library (ERG parts only). */
export function estimateTSS(workout) {
  const segs = flatten(workout);
  let sum = 0, T = 0;
  for (const s of segs) {
    const n = Math.max(1, Math.round(s.dur / 10));
    for (let i = 0; i < n; i++) {
      const f = s.kind === 'erg' ? s.from + (s.to - s.from) * ((i + 0.5) / n) : 0.7;
      sum += Math.pow(f, 4) * (s.dur / n);
    }
    T += s.dur;
  }
  if (!T) return 0;
  const IF = Math.pow(sum / T, 0.25);
  return Math.round((T / 3600) * IF * IF * 100);
}

// ---------- Zwift .zwo import ----------

function attrs(str) {
  const o = {};
  str.replace(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { o[k] = v; return ''; });
  return o;
}

export function parseZwo(xml) {
  const name = (xml.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || 'Imported workout';
  const desc = (xml.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
  const body = (xml.match(/<workout>([\s\S]*?)<\/workout>/) || [])[1] || '';
  const steps = [];
  const re = /<(Warmup|Cooldown|SteadyState|IntervalsT|Ramp|FreeRide|MaxEffort|SolidState)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1], a = attrs(m[2]);
    const dur = Number(a.Duration || 0);
    const texts = [];
    if (m[4]) m[4].replace(/<textevent\b([^>]*)\/?>/g, (_, t) => { const ta = attrs(t); if (ta.message) texts.push(ta.message); return ''; });
    const text = texts.join(' / ');
    const cad = a.Cadence ? String(a.Cadence) : '';
    switch (tag) {
      case 'Warmup': case 'Cooldown': case 'Ramp':
        steps.push({ dur, from: Number(a.PowerLow), to: Number(a.PowerHigh), label: tag === 'Ramp' ? undefined : tag === 'Warmup' ? 'Warm-up' : 'Cool-down', text, cadence: cad });
        break;
      case 'SteadyState': case 'SolidState':
        steps.push({ dur, power: Number(a.Power), text, cadence: cad });
        break;
      case 'IntervalsT':
        steps.push({ repeat: Number(a.Repeat || 1), steps: [
          { dur: Number(a.OnDuration), power: Number(a.OnPower), cadence: a.Cadence || '', text },
          { dur: Number(a.OffDuration), power: Number(a.OffPower), cadence: a.CadenceResting || '' },
        ] });
        break;
      case 'FreeRide': case 'MaxEffort':
        steps.push({ dur, free: true, label: tag === 'MaxEffort' ? 'Max effort' : 'Free ride', text });
        break;
    }
  }
  const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k]; if (o.steps) o.steps.forEach(clean); return o; };
  steps.forEach(clean);
  return { id: 'zwo-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: name.trim(), description: desc.trim(), tags: ['imported'], steps };
}
