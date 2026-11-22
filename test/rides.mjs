// Recorded rides: the ride engine (js/engine/session.js) replayed tick by tick against rides recorded once.
//
//   node test/rides.mjs            replay every ride (part of npm test): any difference fails, with where and what
//   node test/rides.mjs --record   re-record them all and print what changed (npm run rides:record)
//
// Each ride (test/rides/scenarios.mjs) is a seeded simulated trainer and rider with a script of rider actions. For
// every tick the recording keeps the engine's state (the fields that changed since the tick before), the commands
// it sent the trainer, the events it emitted and the 1 Hz samples it recorded; at the end the laps, the per-interval
// stats and the learned calibration. Numbers are compared exactly (JSON keeps every bit of a double).
//
// A change meant to alter ride behavior: re-record, and put the printed "what changed" in the commit message.
// A change not meant to: this must pass untouched.
import fs from 'node:fs';
import { Session } from '../js/engine/session.js';
import { RIDES } from './rides/scenarios.mjs';
import { rng, ModelTrainer, ModelHr } from './rides/model.mjs';

const DIR = new URL('./rides/', import.meta.url);
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0); // the fake wall clock the rides start at (Date.now in the engine)
const file = (name) => new URL(`${name}.json`, DIR);

/** What the engine shows and drives, after a tick. Public fields and getters only, so renaming a private helper
 *  never moves a recording. */
function snapshot(s) {
  return {
    started: s.started, paused: s.paused, autoPaused: !!s.autoPaused, finished: s.finished,
    elapsed: s.elapsed, mode: s.mode, segI: s.segI, segT0: s.segT0, segD0: s.segD0,
    target: s.target, planTarget: s.planTarget ?? null, intensity: s.intensity, ergOff: s.ergOff,
    grade: s.grade, gradeOffset: s.gradeOffset, gOff: s.gOff, sent: s.lastSentGrade, maxed: s.maxed,
    zwiftShifting: !!s.zwiftShifting, altitude: s.altitude, climbed: s.climbed,
    v: s.bike.v, dist: s.bike.dist, engaged: s.bike.engaged, dev: s.devEst.dev,
    gear: s.gb.label, ratio: s.ratio, wheel: s.s.wheelCirc,
    powerShown: s.powerShown, power3s: s.power3s, cadStatus: s.cadStatus, aimStatus: s.aimStatus,
    inTest: s.inTest, chartPos: s.chartPos, remaining: s.segRemaining, laps: s.laps.length,
    workoutDone: !!s.workoutDone, segsChanged: !!s.segsChanged, segs: s.segs,
  };
}

/** Rides one scenario. A library workout comes from the recording `rec` when replaying (editing the library never
 *  moves a recording) and from its file when recording. Returns the recording's content. */
function ride(sc, rec) {
  const workout = !sc.workoutFile ? sc.workout ?? null : rec ? rec.workout
    : JSON.parse(fs.readFileSync(new URL(`../workouts/${sc.workoutFile}`, import.meta.url), 'utf8'));
  const settings = sc.settings;
  const random = rng(sc.seed), jitter = rng(sc.seed * 7919 + 1);
  const tr = new ModelTrainer(random, sc.trainer || {});
  Object.assign(tr.rider, sc.start);
  const hr = sc.hr ? new ModelHr() : null;

  const realNow = Date.now;
  let clock = T0;
  Date.now = () => clock;
  try {
    const s = new Session({ trainer: tr, hr, settings: structuredClone(settings), ...(workout ? { workout: structuredClone(workout) } : {}) });
    const events = [];
    const emit = s.emit.bind(s);
    s.emit = (ev, ...a) => { events.push(a.length ? [ev, ...structuredClone(a)] : [ev]); emit(ev, ...a); };

    const script = [...sc.script];
    const ticks = [];
    let t = 0, k = 0, nextDt = null, prev = {}, nSamples = 0;
    while (t < sc.secs) {
      const act = [];
      while (script.length && script[0][0] <= t) {
        const [, what, fn] = script.shift();
        act.push(what);
        fn({ s, tr, hr, stall: (d) => { nextDt = d; } });
      }
      const dt = nextDt ?? (sc.jitter ? 0.25 + (jitter() - 0.5) * 0.08 : 0.25);
      nextDt = null;
      t += dt; clock = T0 + Math.round(t * 1000);
      tr.step(dt);
      hr?.step(dt, tr.data?.power);
      s.tick(dt);

      const now = JSON.parse(JSON.stringify(snapshot(s)));
      const st = {};
      for (const key of Object.keys(now)) if (JSON.stringify(now[key]) !== JSON.stringify(prev[key])) st[key] = now[key];
      prev = now;
      const x = { k };
      if (dt !== 0.25) x.dt = dt;
      if (act.length) x.act = act;
      if (tr.cmds.length) x.cmd = tr.cmds.splice(0);
      if (events.length) x.ev = events.splice(0);
      x.st = st;
      if (s.samples.length > nSamples) { x.smp = s.samples.slice(nSamples); nSamples = s.samples.length; }
      ticks.push(JSON.parse(JSON.stringify(x)));
      k++;
    }
    const end = JSON.parse(JSON.stringify({
      samples: s.samples.length, laps: s.laps, segAgg: s.segAgg, learned: s.learned(), startMs: s.startMs ?? null, name: s.name,
    }));
    return { format: 1, ride: sc.name, about: sc.about, seed: sc.seed, settings, workout, ticks, end };
  } finally {
    Date.now = realNow;
  }
}

/** One tick per line, so a git diff of a recording points at ticks. */
function serialize(r) {
  const { ticks, end, ...head } = r;
  const h = JSON.stringify(head);
  return `${h.slice(0, -1)},\n"ticks":[\n${ticks.map((x) => JSON.stringify(x)).join(',\n')}\n],\n"end":${JSON.stringify(end)}}\n`;
}

const fmt = (v) => { const j = JSON.stringify(v); return j === undefined ? 'nothing' : j.length > 160 ? `${j.slice(0, 157)}...` : j; };

/** Plain-language differences between a recording and a new ride: [] when they are the same. */
function compare(was, now) {
  const out = [];
  if (was.ticks.length !== now.ticks.length) out.push(`ticks: ${was.ticks.length} recorded, ${now.ticks.length} now`);
  const n = Math.min(was.ticks.length, now.ticks.length);
  const fields = new Map(); // what -> { first tick, count, was, now }
  const note = (what, i, a, b) => {
    const f = fields.get(what);
    if (f) f.count++; else fields.set(what, { i, count: 1, a, b });
  };
  let sa = {}, sb = {};
  for (let i = 0; i < n; i++) {
    const a = was.ticks[i], b = now.ticks[i];
    sa = { ...sa, ...a.st }; sb = { ...sb, ...b.st };
    for (const key of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (JSON.stringify(sa[key]) !== JSON.stringify(sb[key])) note(`state.${key}`, i, sa[key], sb[key]);
    }
    for (const part of ['dt', 'act', 'cmd', 'ev']) {
      if (JSON.stringify(a[part]) !== JSON.stringify(b[part])) note(part === 'cmd' ? 'trainer commands' : part === 'ev' ? 'events' : part, i, a[part], b[part]);
    }
    const pa = a.smp || [], pb = b.smp || [];
    if (pa.length !== pb.length) note('samples recorded', i, pa.length, pb.length);
    const fa = (pa[0] || {}), fb = (pb[0] || {});
    for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (JSON.stringify(fa[key]) !== JSON.stringify(fb[key])) note(`sample.${key}`, i, fa[key], fb[key]);
    }
  }
  const at = (i) => {
    const tk = was.ticks[i], secs = was.ticks.slice(0, i + 1).reduce((a, x) => a + (x.dt ?? 0.25), 0);
    let last = null;
    for (let j = i; j >= 0 && !last; j--) if (was.ticks[j].act) last = was.ticks[j].act.join(', ');
    return `tick ${tk.k} (${secs.toFixed(2)} s${last ? `, after "${last}"` : ''})`;
  };
  for (const [what, f] of [...fields].sort((x, y) => x[1].i - y[1].i)) {
    out.push(`${what}: ${f.count} tick${f.count > 1 ? 's' : ''} differ, first at ${at(f.i)}: was ${fmt(f.a)}, now ${fmt(f.b)}`);
  }
  for (const key of Object.keys({ ...was.end, ...now.end })) {
    if (JSON.stringify(was.end[key]) !== JSON.stringify(now.end[key])) out.push(`end.${key}: was ${fmt(was.end[key])}, now ${fmt(now.end[key])}`);
  }
  return out;
}

const record = process.argv.includes('--record');
let bad = 0, ticks = 0;
const changed = [];
for (const sc of RIDES) {
  const f = file(sc.name);
  const was = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  if (record) {
    const now = ride(sc, null);
    ticks += now.ticks.length;
    const diff = !was ? ['new recording'] : compare(was, now);
    if (!was || serialize(was) !== serialize(now)) fs.writeFileSync(f, serialize(now));
    if (diff.length) changed.push([sc.name, diff]);
    console.log(`${diff.length ? 'recorded' : 'same    '} - ${sc.name} (${now.ticks.length} ticks)`);
    continue;
  }
  if (!was) { bad++; console.log(`not ok - ${sc.name}: no recording. Run npm run rides:record`); continue; }
  const now = ride(sc, was);
  ticks += now.ticks.length;
  const diff = compare(was, now);
  if (!diff.length && serialize(was) !== serialize(now)) diff.push('the recording file differs (header): re-record');
  if (diff.length) {
    bad++;
    console.log(`not ok - recorded ride ${sc.name} rides differently:\n${diff.map((d) => `    ${d}`).join('\n')}`);
  } else console.log(`ok - recorded ride ${sc.name} (${now.ticks.length} ticks)`);
}

if (record) {
  if (changed.length) {
    console.log('\nWhat changed (for the commit message):');
    for (const [name, diff] of changed) console.log(`- ${name}:\n${diff.map((d) => `    ${d}`).join('\n')}`);
  } else console.log('\nNo ride changed.');
} else if (bad) {
  console.log(`\n${bad} recorded ride${bad > 1 ? 's' : ''} differ. If the change is meant to alter ride behavior, run`);
  console.log('npm run rides:record and list what changed in the commit message; otherwise the engine change has a bug.');
  process.exit(1);
} else console.log(`\n${RIDES.length} recorded rides replayed, ${ticks} ticks, identical`);
