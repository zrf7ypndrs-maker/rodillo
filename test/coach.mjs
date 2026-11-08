// Coach chat: tool loop against a scripted fake Anthropic API, plan/workout edits, undo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CoachClient, runTool, restoreSnapshot, validateWorkout, applyPlanUpdate, trimHistory, mdToHtml, buildContext, costOf, TOOLS } from '../js/coach.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
const load = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url)));

const library = load('workouts/index.json').workouts.map((f) => load(`workouts/${f}`));
const TODAY = '2026-11-09';

function makeHost() {
  const st = {
    plan: load('plans/current.json'), custom: [], ftp: 200, saves: [],
  };
  const host = {
    st,
    today: () => TODAY,
    settings: () => ({ ftp: st.ftp, riderKg: 72 }),
    plan: () => st.plan,
    library: () => {
      const c = new Map(st.custom.map((w) => [w.id, { ...w, _source: 'coach' }]));
      const lib = library.map((w) => c.get(w.id) || w);
      for (const [id, w] of c) if (!lib.some((x) => x.id === id)) lib.push(w);
      return lib;
    },
    customWorkouts: () => st.custom,
    rides: () => [
      { id: '2026-11-03T1800', start: '2026-11-03T18:00:00Z', name: 'VO2max 5 x 4 min', workoutId: 'vo2-5x4', durSec: 3540, np: 190, avgP: 165, if: 0.95, tss: 76, avgHr: 150, ftp: 200, compliance: { avg: 97, min: 92, reps: 5 }, bests: { 1200: 205 } },
      { id: '2026-11-05T1800', start: '2026-11-05T18:00:00Z', name: 'Zone 2, 60 min', workoutId: 'z2-60', durSec: 3600, np: 135, avgP: 133, if: 0.68, tss: 46, avgHr: 128, ftp: 200, decoupling: 3.1 },
    ],
    async getRide(id) { return id === '2026-11-03T1800' ? { summary: { id }, intervals: [{ pct: 92 }], streams: { power: [1, 2, 3] } } : null; },
    async savePlan(plan, msg) { st.plan = plan; st.saves.push(['plan', msg]); },
    async saveWorkouts(list, msg) { st.custom = list; st.saves.push(['workouts', msg]); },
    async setFtp(ftp) { st.ftp = ftp; },
  };
  return host;
}

/** Fake Messages API: returns scripted responses in order and records requests. */
function fakeApi(script) {
  const reqs = [];
  const fetchImpl = async (url, opts) => {
    reqs.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    if (next.status) return { ok: false, status: next.status, text: async () => JSON.stringify({ error: { message: next.message || 'err' } }) };
    return { ok: true, json: async () => ({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000 }, ...next }) };
  };
  return { reqs, fetchImpl };
}

await test('every library workout passes validation', () => {
  for (const w of library) validateWorkout(w);
});

await test('validation rejects broken workouts', () => {
  const bad = [
    { id: 'Bad Id', name: 'x', steps: [{ dur: 60, power: 0.5 }] },
    { id: 'ok-id', name: 'x', steps: [] },
    { id: 'ok-id', name: 'x', steps: [{ power: 0.5 }] },
    { id: 'ok-id', name: 'x', steps: [{ dur: 60, power: 112 }] },
    { id: 'ok-id', name: 'x', steps: [{ dur: 60 }] },
    { id: 'ok-id', name: 'x', steps: [{ repeat: 2, steps: [{ repeat: 2, steps: [{ dur: 5, power: 1 }] }] }] },
  ];
  for (const w of bad) assert.throws(() => validateWorkout(w), undefined, JSON.stringify(w));
});

await test('plan update: changes, past-day lock, unknown ids', () => {
  const ids = new Set(library.map((w) => w.id));
  const plan = load('plans/current.json');
  const { plan: p, changes } = applyPlanUpdate(plan, { days: { '2026-11-10': 'z2-60', '2026-11-12': null }, notes: { '2026-11-10': 'Easy, slept badly' } }, { today: TODAY, workoutIds: ids });
  assert.equal(p.days['2026-11-10'], 'z2-60');
  assert.equal(p.days['2026-11-12'], undefined);
  assert.equal(p.notes['2026-11-10'], 'Easy, slept badly');
  assert.equal(changes.length, 3);
  assert.equal(plan.days['2026-11-10'], 'vo2-5x4', 'original untouched');
  assert.throws(() => applyPlanUpdate(plan, { days: { '2026-11-08': 'z2-60' } }, { today: TODAY, workoutIds: ids }), /past/);
  assert.throws(() => applyPlanUpdate(plan, { days: { '2026-11-10': 'nope' } }, { today: TODAY, workoutIds: ids }), /unknown workout/);
});

await test('read tools return compact data', async () => {
  const host = makeHost();
  const plan = (await runTool('get_plan', {}, host)).result;
  assert.ok(plan.days.find((d) => d.date === '2026-11-10' && d.planned === 'vo2-5x4' && d.workoutName));
  assert.ok(plan.days.find((d) => d.date === '2026-11-03' && d.ridden), 'past ride shows up');
  const list = (await runTool('list_workouts', {}, host)).result;
  assert.ok(list.find((w) => w.id === 'sim-climb-repeats' && w.kind === 'slope'));
  const w = (await runTool('get_workout', { id: 'vo2-5x4' }, host)).result;
  assert.equal(w.steps.length, 5);
  const h = (await runTool('get_history', { days: 14 }, host)).result;
  assert.equal(h.rides.length, 2); assert.ok(h.load.length > 0); assert.ok(h.weeks.length >= 2);
  const r = (await runTool('get_ride', { id: '2026-11-03T1800' }, host)).result;
  assert.equal(r.streams, undefined, 'streams stripped');
  await assert.rejects(runTool('get_ride', { id: 'x' }, host), /not found/);
});

await test('write tools save, report a change, and undo restores everything', async () => {
  const host = makeHost();
  const w = { id: 'vo2-5x4-108', name: 'VO2max 5 x 4 at 108%', description: 'd', steps: [{ dur: 600, from: 0.45, to: 0.7 }, { repeat: 5, steps: [{ dur: 240, power: 1.08 }, { dur: 240, power: 0.5 }] }, { dur: 300, power: 0.45 }] };
  const a = await runTool('save_workout', { workout: w }, host);
  assert.ok(a.change.label.startsWith('New workout'));
  const b = await runTool('update_plan', { days: { '2026-11-10': 'vo2-5x4-108' } }, host);
  assert.match(b.change.label, /vo2-5x4 → vo2-5x4-108/);
  const c = await runTool('set_ftp', { ftp: 210 }, host);
  assert.equal(host.st.ftp, 210);
  await restoreSnapshot(a.change.snapshot, host);
  assert.equal(host.st.ftp, 200);
  assert.equal(host.st.custom.length, 0);
  assert.equal(host.st.plan.days['2026-11-10'], 'vo2-5x4');
  assert.ok(c.change);
});

await test('client: tool loop, headers, caching, cost', async () => {
  const host = makeHost();
  const { reqs, fetchImpl } = fakeApi([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'get_plan', input: {} }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'update_plan', input: { days: { '2026-11-10': 'z2-60' } } }, { type: 'tool_use', id: 't3', name: 'get_workout', input: { id: 'missing' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: **Tue** is now Z2 60.' }] },
  ]);
  const client = new CoachClient({ apiKey: 'sk-test', fetchImpl });
  const messages = [{ role: 'user', content: 'make tomorrow easy' }];
  const events = [];
  await client.turn(messages, host, (e) => events.push(e));
  assert.equal(reqs.length, 3);
  const h = reqs[0].headers;
  assert.equal(h['x-api-key'], 'sk-test');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(reqs[0].body.model, 'claude-opus-5-5');
  assert.equal(reqs[0].body.tools.length, TOOLS.length);
  assert.ok(reqs[0].body.system[0].cache_control, 'static system prompt cached');
  assert.match(reqs[0].body.system[1].text, /today = 2026-11-09/);
  const lastMsg = reqs[2].body.messages.at(-1);
  assert.ok(lastMsg.content.at(-1).cache_control, 'conversation prefix cached');
  assert.ok(!messages.at(-1).content.at?.(-1)?.cache_control, 'stored history not polluted with cache_control');
  // tool results fed back, errors flagged
  const results = reqs[2].body.messages.at(-1).content;
  assert.equal(results.find((r) => r.tool_use_id === 't3').is_error, true);
  assert.equal(host.st.plan.days['2026-11-10'], 'z2-60');
  assert.equal(events.filter((e) => e.type === 'change').length, 1);
  assert.equal(events.filter((e) => e.type === 'usage').length, 3);
  assert.equal(messages.length, 6);
  assert.ok(costOf(events[1].usage ?? events.find((e) => e.usage).usage, 'claude-opus-5-5') > 0);
});

await test('client: bad key gives a readable error, overload retries', async () => {
  const host = makeHost();
  const a = fakeApi([{ status: 401 }]);
  await assert.rejects(new CoachClient({ apiKey: 'x', fetchImpl: a.fetchImpl }).turn([{ role: 'user', content: 'hi' }], host), /key was rejected/);
  const b = fakeApi([{ status: 529 }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hola' }] }]);
  const m = [{ role: 'user', content: 'hola' }];
  await new CoachClient({ apiKey: 'x', fetchImpl: b.fetchImpl }).turn(m, host);
  assert.equal(m.at(-1).content[0].text, 'hola');
});

await test('context, history trimming, markdown', () => {
  const ctx = buildContext(makeHost());
  assert.match(ctx, /Tue 2026-11-10: vo2-5x4 \(VO2max 5 x 4 min, 59 min\)/);
  assert.match(ctx, /FTP 200 W/);
  const long = [];
  for (let i = 0; i < 40; i++) {
    long.push({ role: 'user', content: `q${i}` });
    long.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'get_plan', input: {} }] });
    long.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }] });
    long.push({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  }
  const t = trimHistory(long, 60);
  assert.ok(t.length <= 60);
  assert.equal(t[0].role, 'user'); assert.equal(typeof t[0].content, 'string');
  const html = mdToHtml('**Done.** Changes:\n- Tue: `z2-60`\n- Thu: rest\n\n<script>x</script>');
  assert.match(html, /<b>Done.<\/b>/); assert.match(html, /<ul><li>Tue: <code>z2-60<\/code><\/li>/); assert.ok(!html.includes('<script>'));
});

console.log(`\n${passed} coach tests passed`);
