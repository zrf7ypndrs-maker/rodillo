// Scaled copy of a workout for the daily coach:  node tools/scale.mjs <path-to-rodillo-data> <workout-id> <percent>
// Writes/updates <id>-<pct> in rodillo-data/coach/workouts.json and prints the new id.
// Only work steps (target >= 75% FTP, or watts >= 75% of plan FTP) are scaled.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [dirArg, id, pctArg] = process.argv.slice(2);
const pct = Number(pctArg);
if (!dirArg || !id || !(pct >= 80 && pct <= 105)) { console.error('usage: scale.mjs <rodillo-data> <workout-id> <80-105>'); process.exit(1); }
const dir = path.resolve(dirArg);
const wpath = path.join(dir, 'coach', 'workouts.json');
const store = fs.existsSync(wpath) ? JSON.parse(fs.readFileSync(wpath, 'utf8')) : { version: 1, workouts: [] };
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'coach', 'plan.json'), 'utf8'));
const ftp = plan.ftp || 200;

const pub = path.join(root, 'workouts', `${id}.json`);
const base = store.workouts.find((w) => w.id === id) || (fs.existsSync(pub) && JSON.parse(fs.readFileSync(pub, 'utf8')));
if (!base) { console.error(`unknown workout ${id}`); process.exit(1); }
if (JSON.stringify(base).includes('"grade"') || /^sim-/.test(id)) { console.error('slope-mode workouts cannot be scaled; move or swap instead'); process.exit(1); }

const f = pct / 100;
const r2 = (x) => Math.round(x * 100) / 100;
const scaleStep = (s) => {
  if (s.steps) return { ...s, steps: s.steps.map(scaleStep) };
  const out = { ...s };
  for (const k of ['power', 'from', 'to']) if (typeof out[k] === 'number' && out[k] >= 0.75) out[k] = r2(out[k] * f);
  if (typeof out.watts === 'number' && out.watts >= 0.75 * ftp) out.watts = Math.round(out.watts * f);
  return out;
};
const newId = `${id}-${pct}`;
const scaled = { ...base, id: newId, name: `${base.name.replace(/ \(\d+%\)$/, '')} (${pct}%)`, steps: base.steps.map(scaleStep), scaledFrom: id };
store.workouts = store.workouts.filter((w) => w.id !== newId).concat(scaled);
fs.mkdirSync(path.dirname(wpath), { recursive: true });
fs.writeFileSync(wpath, JSON.stringify(store, null, 2) + '\n');
console.log(newId);
