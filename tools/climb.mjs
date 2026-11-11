// Real climbs: rewrite each climb workout's "steps" from its "profile" at the default detail, so tools that only read
// steps (daily.mjs, review.mjs) see what the app shows by default.   node tools/climb.mjs [workouts/climb-x.json ...]
import fs from 'node:fs';
import path from 'node:path';
import { withDetail, defaultDetail } from '../js/engine/climb.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(root, 'workouts')).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => path.join(root, 'workouts', f));
for (const f of files) {
  const w = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!w.profile) continue;
  const { detail, ...rest } = withDetail(w, defaultDetail(w));
  const out = { ...w, steps: rest.steps };
  // steps before profile; the elevation list on one line
  const { profile, ...head } = out;
  const json = JSON.stringify({ ...head, profile: { ...profile, elev: '@ELEV@' } }, null, 2)
    .replace('"@ELEV@"', `[${profile.elev.join(', ')}]`);
  fs.writeFileSync(f, json + '\n');
  console.log(`${path.basename(f)}: ${rest.steps.length - (profile.lead || []).length} climb steps at detail ${defaultDetail(w)}`);
}
