// In-app coach chat: talks to Claude through the Anthropic Messages API straight from the browser,
// with tools that read the rider's history and edit the plan and workouts in rodillo-data.

import { flatten, totalDuration, estimateTSS } from './engine/workout.js';
import { loadSeries, weekly, powerCurve, ftpEstimate, formLabel } from './stats.js';

export const PLAN_PATH = 'coach/plan.json';
export const WORKOUTS_PATH = 'coach/workouts.json';

// USD per million tokens. cw = cache write (1.25x input).
export const COACH_MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', in: 2, out: 10, cr: 0.1, cw: 2.5 },
};
export const DEFAULT_MODEL = 'claude-opus-5-5';

export function costOf(usage, model) {
  const p = COACH_MODELS[model] || COACH_MODELS[DEFAULT_MODEL];
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out
    + (usage.cache_read_input_tokens || 0) * p.cr + (usage.cache_creation_input_tokens || 0) * p.cw) / 1e6;
}

// ------------------------------------------------------------------ helpers
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const KINDS = new Set(['rest', 'strength']);
const weekday = (key) => new Date(key + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' });
export const addDaysKey = (key, n) => { const d = new Date(key + 'T12:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

export function workoutBrief(w) {
  const segs = flatten(w);
  const slope = segs.every((s) => s.kind === 'sim');
  return {
    id: w.id, name: w.name, kind: slope ? 'slope' : segs.some((s) => s.kind === 'sim') ? 'mixed' : 'erg',
    minutes: Math.round(totalDuration(w) / 60), tss: slope ? null : estimateTSS(w),
    tags: w.tags || [], source: w._source || 'library',
  };
}

/** Throws a readable error if a workout won't load in the app. */
export function validateWorkout(w) {
  if (!w || typeof w !== 'object') throw new Error('workout must be an object');
  if (!ID_RE.test(w.id || '')) throw new Error('id must be lowercase letters, digits and dashes (2-61 chars)');
  if (!w.name) throw new Error('name is required');
  if (!Array.isArray(w.steps) || !w.steps.length) throw new Error('steps must be a non-empty array');
  const walk = (steps, depth) => {
    for (const s of steps) {
      if (s.repeat != null) {
        if (depth > 0) throw new Error('nested repeats are not supported');
        if (!(s.repeat >= 1 && s.repeat <= 50) || !Array.isArray(s.steps) || !s.steps.length) throw new Error('repeat needs 1-50 and a steps array');
        walk(s.steps, depth + 1);
        continue;
      }
      if (!(s.dur > 0) && !(s.dist > 0)) throw new Error(`every step needs dur (s) or dist (m): ${JSON.stringify(s)}`);
      if (s.dur > 4 * 3600) throw new Error('a single step cannot exceed 4 hours');
      const p = [s.power, s.from, s.to].filter((x) => x != null);
      if (p.some((x) => typeof x !== 'number' || x < 0 || x > 3)) throw new Error('power/from/to are fractions of FTP (0 to 3), e.g. 1.05');
      if (s.grade != null && (typeof s.grade !== 'number' || Math.abs(s.grade) > 20)) throw new Error('grade is in percent, -20 to 20');
      if (s.dist && s.grade == null) throw new Error('distance steps need a grade');
      if (s.watts != null && !(s.watts > 0 && s.watts < 1500)) throw new Error('watts must be 1-1500');
      if (s.from != null && s.to == null) throw new Error('a ramp needs both from and to');
      if (s.power == null && s.from == null && s.watts == null && s.grade == null && !s.free) throw new Error(`step needs power, from/to, watts, grade or free: ${JSON.stringify(s)}`);
    }
  };
  walk(w.steps, 0);
  const total = totalDuration(w);
  if (!(total > 0) || total > 6 * 3600) throw new Error('total duration must be between 0 and 6 hours');
  flatten(w); // last sanity check
  return true;
}

/** Applies a plan edit and returns { plan, changes[] }. Past days are locked. */
export function applyPlanUpdate(plan, input, { today, workoutIds }) {
  const out = clone(plan) || { name: 'Plan', days: {}, notes: {} };
  out.days ||= {}; out.notes ||= {};
  const changes = [];
  if (input.name && input.name !== out.name) { changes.push(`Plan renamed to "${input.name}"`); out.name = input.name; }
  for (const [date, val] of Object.entries(input.days || {})) {
    if (!DATE_RE.test(date)) throw new Error(`bad date ${date}, use YYYY-MM-DD`);
    if (date < today) throw new Error(`${date} is in the past; past days can't be changed`);
    if (val != null && !KINDS.has(val) && !workoutIds.has(val)) throw new Error(`unknown workout id "${val}" on ${date}. Save it with save_workout first, or use "rest"/"strength"`);
    const before = out.days[date] ?? null;
    if (before === val) continue;
    if (val == null) delete out.days[date]; else out.days[date] = val;
    changes.push(`${weekday(date)} ${date.slice(5)}: ${before ?? 'nothing'} → ${val ?? 'nothing'}`);
  }
  for (const [date, note] of Object.entries(input.notes || {})) {
    if (!DATE_RE.test(date)) throw new Error(`bad date ${date}`);
    if (date < today) throw new Error(`${date} is in the past; past notes can't be changed`);
    if ((out.notes[date] || null) === (note || null)) continue;
    if (note) out.notes[date] = note; else delete out.notes[date];
    changes.push(`${weekday(date)} ${date.slice(5)} note ${note ? 'updated' : 'removed'}`);
  }
  out.days = Object.fromEntries(Object.entries(out.days).sort(([a], [b]) => (a < b ? -1 : 1)));
  out.notes = Object.fromEntries(Object.entries(out.notes).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { plan: out, changes };
}

function rideLine(r) {
  return {
    id: r.id, date: r.id.slice(0, 10), name: r.name, workoutId: r.workoutId, min: Math.round(r.durSec / 60),
    np: r.np, avgP: r.avgP, if: r.if, tss: r.tss, avgHr: r.avgHr, maxHr: r.maxHr, avgCad: r.avgCad,
    compliance: r.compliance, decoupling: r.decoupling, ftpAtRide: r.ftp,
  };
}

// ------------------------------------------------------------------ prompt
export const SYSTEM_STATIC = `You are the cycling coach inside Rodillo, a personal indoor-training app. You talk to the rider in a chat panel in the app, usually from a MacBook in front of the bike. You coach one rider, and you can read his training data and edit his plan and workouts with tools. Edits take effect in the app immediately and are saved to his private data repo.

How to work
- When the request is clear, make the change right away with the tools, then confirm in one or two short sentences what changed (dates, workout, key numbers). Don't ask permission for clear requests; the app shows an Undo button on every change.
- Ask one short question only when the request is genuinely ambiguous (e.g. which day he means).
- Before editing, read what you need (get_plan, get_workout, get_history). Don't guess workout contents.
- Never change past days. Today can be changed.
- To make a session easier or harder for a single day, save a new workout with a new id (e.g. "vo2-5x4-108" or "z2-45") and point that day to it, so other days using the original are unaffected. Only overwrite an existing id if he asks for the change everywhere.
- Keep weekly structure sensible: strength days are gym days, don't stack two hard rides back to back, and keep at least one rest day per week unless he asks otherwise.
- Use his data: interval compliance (avg/min % of target per rep), HR drift (decoupling) on steady rides, CTL/ATL/TSB, WHOOP recovery when present. Rules of thumb: if compliance min < 95% on a set, drop the next similar set 3-4%; if all reps >= 99%, raise 2-3%. Z2 drift < 5% means Z2 power can go up ~5 W.
- When he reports a test result or FTP change, use set_ftp.

Style
- Reply in the language he writes in (Spanish or English).
- Short and concrete: numbers, watts, minutes, dates. No preamble, no em dashes. Light markdown only (bold, short bullet lists).

Workout format (power values are fractions of FTP; grade is percent; dur in seconds, dist in metres)
{ "id": "vo2-5x4", "name": "VO2max 5 x 4 min", "description": "One or two sentences on purpose and how to ride it.", "tags": ["vo2"],
  "steps": [
    { "dur": 600, "from": 0.45, "to": 0.70, "label": "Warm-up" },
    { "repeat": 5, "steps": [ { "dur": 240, "power": 1.12, "cadence": 100, "text": "Smooth" }, { "dur": 240, "power": 0.5 } ] },
    { "dur": 360, "grade": 6, "label": "Climb", "cadence": "80-90" },
    { "dist": 1500, "grade": 6 },
    { "dur": 300, "free": true }
  ] }
- "watts": 150 (absolute) is allowed instead of power, but prefer FTP fractions so sessions scale with FTP.
- ERG steps use power, or from/to for ramps. Slope steps use grade (rider shifts the virtual gears). Don't mix ERG and slope steps in one workout.
- cadence is optional: a number (target ±5 rpm), "80-90", or "100+". label is the interval name shown big; text is a short cue.
- Always start with a warm-up and end with a cool-down. No nested repeats.

Plan format: days map dates (YYYY-MM-DD) to a workout id, "rest" or "strength"; notes map dates to a one-line coach note shown on the home screen for that day.`;

export function buildContext(host) {
  const today = host.today();
  const s = host.settings();
  const plan = host.plan() || {};
  const lib = new Map(host.library().map((w) => [w.id, w]));
  const real = host.rides();
  const load = loadSeries(real, new Date(today + 'T23:00'), 1).at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const rec = host.recovery?.() || null;
  const lines = [];
  lines.push(`Now: ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (today = ${today}).`);
  lines.push(`Rider settings: FTP ${s.ftp} W, weight ${s.riderKg} kg.`);
  lines.push(`Load today: CTL ${Math.round(load.ctl)}, ATL ${Math.round(load.atl)}, TSB ${Math.round(load.tsb)} (${formLabel(load.tsb)}). ${real.length} rides in history.`);
  if (rec) lines.push(`WHOOP last days: ${rec.map(([d, v]) => `${d.slice(5)} rec ${v.recovery ?? '-'}% HRV ${v.hrv ?? '-'} sleep ${v.sleepHours ?? '-'}h`).join('; ')}`);
  lines.push(`\nPlan "${plan.name || 'none'}", next 10 days:`);
  for (let i = 0; i < 10; i++) {
    const k = addDaysKey(today, i);
    const e = plan.days?.[k];
    const w = e && lib.get(e);
    lines.push(`${weekday(k)} ${k}: ${e ? (w ? `${e} (${w.name}, ${Math.round(totalDuration(w) / 60)} min)` : e) : '-'}${plan.notes?.[k] ? ` | note: ${plan.notes[k]}` : ''}`);
  }
  const recent = real.filter((r) => r.id.slice(0, 10) >= addDaysKey(today, -14));
  lines.push(`\nRides in the last 14 days: ${recent.length ? '' : 'none'}`);
  for (const r of recent) {
    const c = r.compliance ? ` compliance ${r.compliance.avg}% (min ${r.compliance.min}%)` : '';
    lines.push(`${r.id} ${r.name} ${Math.round(r.durSec / 60)} min, NP ${r.np} W, TSS ${r.tss}, HR ${r.avgHr ?? '-'}${c}${r.decoupling != null ? `, drift ${r.decoupling}%` : ''}`);
  }
  if (host.riding?.()) lines.push('\nThe rider is currently on the ride screen with a session running.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ tools
export const TOOLS = [
  {
    name: 'get_plan',
    description: 'Planned sessions and notes for a date range, with what was actually ridden on past days.',
    input_schema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD, default 7 days ago' }, to: { type: 'string', description: 'YYYY-MM-DD, default 28 days ahead' } } },
  },
  {
    name: 'list_workouts',
    description: 'All workouts available to the plan: id, name, kind (erg/slope), minutes, estimated TSS.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workout',
    description: 'Full JSON of one workout.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_history',
    description: 'Training history: ride summaries, weekly totals, CTL/ATL/TSB trend, power curve and FTP estimates.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'How far back to list rides, default 42' } } },
  },
  {
    name: 'get_ride',
    description: 'One ride in detail, including every interval: target vs actual power, % hit, HR and cadence.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Ride id like 2026-11-08T1115' } }, required: ['id'] },
  },
  {
    name: 'save_workout',
    description: 'Create a workout, or overwrite one with the same id. It becomes available in the app immediately. Use a new id for one-off variants.',
    input_schema: { type: 'object', properties: { workout: { type: 'object', description: 'Workout in the documented format' } }, required: ['workout'] },
  },
  {
    name: 'update_plan',
    description: 'Change planned days and/or notes. Only the dates you pass change. Set a day to null to clear it, a note to "" to remove it.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'object', description: '{ "YYYY-MM-DD": "workout-id" | "rest" | "strength" | null }', additionalProperties: { type: ['string', 'null'] } },
        notes: { type: 'object', description: '{ "YYYY-MM-DD": "one-line note" | "" }', additionalProperties: { type: 'string' } },
        name: { type: 'string', description: 'Optional new plan name' },
      },
    },
  },
  {
    name: 'set_ftp',
    description: "Set the rider's FTP in watts. All ERG targets scale from it.",
    input_schema: { type: 'object', properties: { ftp: { type: 'integer' } }, required: ['ftp'] },
  },
];

export const TOOL_STATUS = {
  get_plan: 'Reading your plan', list_workouts: 'Looking at workouts', get_workout: 'Reading a workout',
  get_history: 'Reading your history', get_ride: 'Looking at a ride', save_workout: 'Saving a workout',
  update_plan: 'Updating your plan', set_ftp: 'Updating FTP',
};
export const WRITE_TOOLS = new Set(['save_workout', 'update_plan', 'set_ftp']);

/**
 * host: {
 *   today(), settings(), plan(), library() (merged, with _source), customWorkouts(), rides() (real summaries),
 *   recovery()?, riding()?, getRide(id), savePlan(plan, msg), saveWorkouts(list, msg), setFtp(ftp)
 * }
 * Returns { result, change? } where change = { label, snapshot } for write tools.
 */
export async function runTool(name, input, host) {
  const today = host.today();
  input ||= {};
  switch (name) {
    case 'get_plan': {
      const from = input.from || addDaysKey(today, -7), to = input.to || addDaysKey(today, 28);
      const plan = host.plan() || {};
      const lib = new Map(host.library().map((w) => [w.id, w]));
      const rides = host.rides();
      const days = [];
      for (let k = from; k <= to; k = addDaysKey(k, 1)) {
        const e = plan.days?.[k] ?? null;
        const ridden = rides.filter((r) => r.id.slice(0, 10) === k).map((r) => ({ name: r.name, workoutId: r.workoutId, tss: r.tss, min: Math.round(r.durSec / 60), compliance: r.compliance }));
        if (!e && !ridden.length && !plan.notes?.[k]) continue;
        days.push({ date: k, day: weekday(k), planned: e, workoutName: lib.get(e)?.name, note: plan.notes?.[k], ridden: ridden.length ? ridden : undefined });
      }
      return { result: { name: plan.name, ftp: host.settings().ftp, today, days } };
    }
    case 'list_workouts':
      return { result: host.library().map(workoutBrief) };
    case 'get_workout': {
      const w = host.library().find((x) => x.id === input.id);
      if (!w) throw new Error(`no workout with id ${input.id}`);
      const { _source, ...rest } = w;
      return { result: { ...rest, source: _source || 'library', minutes: Math.round(totalDuration(w) / 60), tss: estimateTSS(w) } };
    }
    case 'get_history': {
      const days = Math.min(365, input.days || 42);
      const real = host.rides();
      const end = new Date(today + 'T23:00');
      const series = loadSeries(real, end, Math.min(days, 120));
      const step = Math.max(1, Math.round(series.length / 20));
      return {
        result: {
          load: series.filter((_, i) => i % step === 0 || i === series.length - 1).map(({ date, ctl, atl, tsb }) => ({ date, ctl, atl, tsb })),
          weeks: weekly(real, Math.max(2, Math.ceil(days / 7)), end),
          powerCurve90d: powerCurve(real, 90, end.getTime()), ftpEstimates: ftpEstimate(real, end.getTime()),
          rides: real.filter((r) => r.id.slice(0, 10) >= addDaysKey(today, -days)).map(rideLine),
        },
      };
    }
    case 'get_ride': {
      const doc = await host.getRide(input.id);
      if (!doc) throw new Error(`ride ${input.id} not found`);
      const { streams, samples, ...rest } = doc;
      return { result: rest };
    }
    case 'save_workout': {
      const w = clone(input.workout);
      validateWorkout(w);
      delete w._source;
      const snapshot = takeSnapshot(host);
      const custom = clone(host.customWorkouts()) || [];
      const existed = host.library().some((x) => x.id === w.id);
      const list = custom.filter((x) => x.id !== w.id).concat(w);
      await host.saveWorkouts(list, `Coach: ${existed ? 'update' : 'add'} workout ${w.id}`);
      const b = workoutBrief(w);
      return { result: { ok: true, ...b }, change: { label: `${existed ? 'Updated' : 'New'} workout: ${w.name} (${b.minutes} min${b.tss ? `, TSS ~${b.tss}` : ''})`, snapshot } };
    }
    case 'update_plan': {
      const ids = new Set(host.library().map((w) => w.id));
      const { plan, changes } = applyPlanUpdate(host.plan(), input, { today, workoutIds: ids });
      if (!changes.length) return { result: { ok: true, changed: 0, note: 'nothing to change' } };
      const snapshot = takeSnapshot(host);
      await host.savePlan(plan, `Coach: ${changes.join('; ').slice(0, 120)}`);
      return { result: { ok: true, changes }, change: { label: changes.join('\n'), snapshot } };
    }
    case 'set_ftp': {
      const ftp = Math.round(input.ftp);
      if (!(ftp >= 80 && ftp <= 500)) throw new Error('FTP must be between 80 and 500 W');
      const before = host.settings().ftp;
      if (before === ftp) return { result: { ok: true, ftp, note: 'unchanged' } };
      const snapshot = takeSnapshot(host);
      await host.setFtp(ftp);
      return { result: { ok: true, ftp, before }, change: { label: `FTP ${before} → ${ftp} W`, snapshot } };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function takeSnapshot(host) {
  return { plan: clone(host.plan()), custom: clone(host.customWorkouts()) || [], ftp: host.settings().ftp };
}

export async function restoreSnapshot(snap, host) {
  await host.saveWorkouts(snap.custom, 'Coach: undo');
  await host.savePlan(snap.plan, 'Coach: undo');
  if (host.settings().ftp !== snap.ftp) await host.setFtp(snap.ftp);
}

// ------------------------------------------------------------------ API client
export class CoachClient {
  constructor({ apiKey, model = DEFAULT_MODEL, fetchImpl, maxTokens = 4096 }) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  async call(body, attempt = 0) {
    const res = await this.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* raw */ }
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return this.call(body, attempt + 1);
    }
    const err = new Error(res.status === 401 ? 'The Anthropic API key was rejected. Check it in the coach settings.' : `Claude API ${res.status}: ${String(msg).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  /** Cheap request to check the key and model. */
  async test() {
    return this.call({ model: this.model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
  }

  /**
   * One user turn with the tool loop. `messages` is mutated (API format). Calls on({type,...}) for UI:
   * status, change, text, usage.
   */
  async turn(messages, host, on = () => {}) {
    const system = [
      { type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: buildContext(host) },
    ];
    for (let i = 0; i < 10; i++) {
      // cache the conversation prefix up to the latest message
      const msgs = messages.map((m, j) => (j === messages.length - 1 ? withCache(m) : m));
      on({ type: 'status', text: i === 0 ? 'Thinking' : 'Thinking' });
      const res = await this.call({ model: this.model, max_tokens: this.maxTokens, system, tools: TOOLS, messages: msgs });
      on({ type: 'usage', usage: res.usage, model: this.model });
      messages.push({ role: 'assistant', content: res.content });
      const texts = res.content.filter((b) => b.type === 'text' && b.text.trim());
      if (texts.length) on({ type: 'text', text: texts.map((b) => b.text).join('\n\n') });
      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) return res;
      const results = [];
      for (const u of uses) {
        on({ type: 'status', text: TOOL_STATUS[u.name] || u.name });
        try {
          const { result, change } = await runTool(u.name, u.input, host);
          if (change) on({ type: 'change', id: u.id, tool: u.name, ...change });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error('The coach took too many steps. Try a simpler request.');
  }
}

function withCache(m) {
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
  if (!content.length) return m;
  const last = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  return { ...m, content: [...content.slice(0, -1), last] };
}

/** Keep the stored chat bounded: cut at a plain user text message so tool pairs stay intact. */
export function trimHistory(messages, max = 60) {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && (typeof m.content === 'string' || m.content.every((b) => b.type === 'text'))) return messages.slice(i);
  }
  return messages.slice(-2);
}

// ------------------------------------------------------------------ tiny markdown
export function mdToHtml(src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const out = [];
  let list = null;
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.tag}>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<p><b>${inline(h[1])}</b></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.tag}>`);
  return out.join('');
}
