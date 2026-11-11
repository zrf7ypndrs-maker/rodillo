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
//     { "dur": 60, "power": 1.10, "untilFail": true }                   // test step (ramp test), see below
//   ]
// Test steps ("untilFail": true, ERG only): a run of them is open-ended. Finish the last one and
// another step is added at the same increment; the test ends when the rider can't hold the target
// (or holds B), the steps not ridden are dropped and the ride moves on to the step after the run.
// }
//
// Timed messages (shown over the ride chart): any step can carry
//   "messages": [ { "at": 0, "text": "..." },          // seconds from the start of the step
//                 { "at": -30, "text": "..." },        // negative = seconds before the end
//                 { "at": "50%", "text": "..." },      // share of the step
//                 { "at": -20, "rep": "last", "text": "Last one" } ]  // rep: number, "first", "last" or a list
// Text can use {watts} (target now), {ftp}, {rep}, {of} and {left} (reps left after this one).
// Distance steps time their messages on the estimated duration.

import { speedForPower } from './physics.js?v=202611102147';

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
      if (s.untilFail) seg.untilFail = true;
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
      seg.msgs = (s.messages || [])
        .filter((m) => m && String(m.text || '').trim() && repMatches(m.rep, rep))
        .map((m) => ({ t: msgTime(m.at, seg.dur), text: String(m.text).trim() }))
        .sort((a, b) => a.t - b.t);
      out.push(seg);
    }
  };
  walk(workout.steps, null);
  return retime(out);
}

/** Sets start/end of every segment from the durations. */
export function retime(segs) {
  let t = 0;
  for (const s of segs) { s.start = t; t += s.dur; s.end = t; }
  return segs;
}

/** Second within a step (0..dur) at which a message shows. */
export function msgTime(at, dur) {
  let t = 0;
  if (typeof at === 'string' && /^\s*\d+(\.\d+)?\s*%\s*$/.test(at)) t = (parseFloat(at) / 100) * dur;
  else if (Number.isFinite(Number(at))) { const n = Number(at); t = n < 0 ? dur + n : n; }
  return Math.max(0, Math.min(Math.max(0, dur - 1), Math.round(t)));
}

function repMatches(want, rep) {
  if (want == null || want === '') return true;
  const i = rep ? rep.i : 1, of = rep ? rep.of : 1;
  const one = (w) => w === 'first' ? i === 1 : w === 'last' ? i === of : Number(w) === i;
  return Array.isArray(want) ? want.some(one) : one(want);
}

/** Fills {watts} {ftp} {rep} {of} {left} in a message. */
export function fillMessage(text, { seg, watts, ftp }) {
  const rep = seg?.rep;
  const v = { watts: watts != null ? Math.round(watts) : '', ftp: ftp != null ? Math.round(ftp) : '', rep: rep ? rep.i : '', of: rep ? rep.of : '', left: rep ? rep.of - rep.i : '' };
  return text.replace(/\{(watts|ftp|rep|of|left)\}/g, (_, k) => String(v[k]));
}

// ---- builder text form: one message per line, "[first|last|rep 3|rep 1,2] [when] text",
// when = 1:30, -0:20, 45s, -10s or 50% (no when = start of the step)
// a rep filter only counts when a time or a colon follows it, so "Last step. Go" stays plain text
const WHEN = String.raw`(?=-?\d+:[0-5]\d\b|-?\d+s\b|\d{1,3}%)`;
const REP_FIRST_LAST = new RegExp(String.raw`^(first|last)\s*(?::\s*|\s+${WHEN})`, 'i');
const REP_NUM = new RegExp(String.raw`^reps?\s*(\d+(?:\s*,\s*\d+)*)\s*(?::\s*|\s+${WHEN})`, 'i');
export function parseMessageLines(str) {
  const out = [], bad = [];
  String(str || '').split('\n').forEach((raw, n) => {
    let line = raw.trim();
    if (!line) return;
    const m = {};
    let x;
    if ((x = line.match(REP_FIRST_LAST))) { m.rep = x[1].toLowerCase(); line = line.slice(x[0].length); }
    else if ((x = line.match(REP_NUM))) { const r = x[1].split(',').map((n) => +n); m.rep = r.length > 1 ? r : r[0]; line = line.slice(x[0].length); }
    if ((x = line.match(/^(-?)(\d+):([0-5]\d)\b\s*/))) { m.at = (x[1] ? -1 : 1) * (+x[2] * 60 + +x[3]); line = line.slice(x[0].length); }
    else if ((x = line.match(/^(-?)(\d+)s\b\s*/i))) { m.at = (x[1] ? -1 : 1) * +x[2]; line = line.slice(x[0].length); }
    else if ((x = line.match(/^(\d{1,3})%\s*/))) { m.at = `${Math.min(100, +x[1])}%`; line = line.slice(x[0].length); }
    line = line.replace(/^[:\-]\s*/, '').trim();
    if (!line) { bad.push(n + 1); return; }
    out.push({ ...(m.at != null && m.at !== 0 ? { at: m.at } : {}), ...(m.rep != null ? { rep: m.rep } : {}), text: line });
  });
  return { messages: out, bad };
}

export function formatMessageLines(msgs) {
  const t = (at) => {
    if (at == null || at === 0) return '';
    if (typeof at === 'string') return at.trim() + ' ';
    const a = Math.abs(at);
    return `${at < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')} `;
  };
  const r = (rep) => rep == null ? '' : Array.isArray(rep) ? `rep ${rep.join(',')} ` : typeof rep === 'number' ? `rep ${rep} ` : `${rep} `;
  return (msgs || []).map((m) => {
    const when = t(m.at), rep = r(m.rep);
    if (rep && !when) return `${rep.trim()}: ${m.text}`;
    // plain text that would read as a filter or a time gets an explicit 0:00
    if (!rep && !when && (REP_FIRST_LAST.test(m.text) || REP_NUM.test(m.text) || /^(-?\d+:[0-5]\d\b|-?\d+s\b|\d{1,3}%)/i.test(m.text))) return `0:00 ${m.text}`;
    return `${rep}${when}${m.text}`;
  }).join('\n');
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
    // Zwift textevents become timed messages (offset from the block start)
    const evs = [];
    if (m[4]) m[4].replace(/<textevent\b([^>]*)\/?>/g, (_, t) => { const ta = attrs(t); if (ta.message) evs.push({ at: Math.max(0, Math.round(Number(ta.timeoffset) || 0)), text: ta.message }); return ''; });
    const messages = evs.length ? evs : undefined;
    const cad = a.Cadence ? String(a.Cadence) : '';
    switch (tag) {
      case 'Warmup': case 'Cooldown': case 'Ramp':
        steps.push({ dur, from: Number(a.PowerLow), to: Number(a.PowerHigh), label: tag === 'Ramp' ? undefined : tag === 'Warmup' ? 'Warm-up' : 'Cool-down', messages, cadence: cad });
        break;
      case 'SteadyState': case 'SolidState':
        steps.push({ dur, power: Number(a.Power), messages, cadence: cad });
        break;
      case 'IntervalsT': {
        const on = Number(a.OnDuration), off = Number(a.OffDuration), per = on + off || 1;
        const onMsgs = [], offMsgs = [];
        for (const e of evs) {
          const rep = Math.floor(e.at / per) + 1, w = e.at % per;
          (w < on ? onMsgs : offMsgs).push({ at: w < on ? w : w - on, rep, text: e.text });
        }
        steps.push({ repeat: Number(a.Repeat || 1), steps: [
          { dur: on, power: Number(a.OnPower), cadence: a.Cadence || '', messages: onMsgs.length ? onMsgs : undefined },
          { dur: off, power: Number(a.OffPower), cadence: a.CadenceResting || '', messages: offMsgs.length ? offMsgs : undefined },
        ] });
        break;
      }
      case 'FreeRide': case 'MaxEffort':
        steps.push({ dur, free: true, label: tag === 'MaxEffort' ? 'Max effort' : 'Free ride', messages });
        break;
    }
  }
  const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k]; if (o.steps) o.steps.forEach(clean); return o; };
  steps.forEach(clean);
  return { id: 'zwo-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: name.trim(), description: desc.trim(), tags: ['imported'], steps };
}
