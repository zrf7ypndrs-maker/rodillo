// npm run typecheck: TypeScript over every file in js/ (tsconfig.json, checkJs).
//
// The code in the repo has no ?v= build stamps (only the deploy adds them, see tools/stamp.mjs), so TypeScript reads
// js/ as it is. This wrapper only runs tsc and prints a one-line summary.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const r = spawnSync(tsc, ['-p', root, '--pretty', 'false', ...process.argv.slice(2)], { cwd: root, encoding: 'utf8' });
const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
if (text) console.log(text);
const errors = (text.match(/error TS\d+/g) || []).length;
const checked = fs.readdirSync(path.join(root, 'js'), { recursive: true }).filter((f) => f.endsWith('.js')); // checkJs: all of them
console.log(r.status === 0 ? `typecheck: ${checked.length} files checked, no errors`
  : `typecheck: ${errors} error(s)`);
process.exit(r.status ?? 1);
