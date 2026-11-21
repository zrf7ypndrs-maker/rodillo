// npm run typecheck: TypeScript over js/ (tsconfig.json), files with // @ts-check only.
//
// Every relative import in js/ carries the build stamp (`./zones.js?v=202611102147`, see tools/stamp.mjs), and
// TypeScript can't resolve a specifier with a query string (`paths` never applies to relative imports). So this
// checks a copy: js/ goes to node_modules/.cache/rodillo-tsc/js with `?v=...` taken off the import specifiers, the
// copy's tsconfig extends the real one, and the errors are printed with the real paths. Line numbers are the same;
// a column after a stamped specifier on an import line is off by the stamp's length.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'node_modules', '.cache', 'rodillo-tsc');
const STAMP = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.js)\?v=[^'"]*\2/g; // the same specifiers stamp.mjs writes

fs.rmSync(out, { recursive: true, force: true });
const copy = (dir) => {
  for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) { copy(rel); continue; }
    if (!d.name.endsWith('.js')) continue;
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    fs.writeFileSync(path.join(out, rel), src.replace(STAMP, (_, kw, q, spec) => `${kw}${q}${spec}${q}`));
  }
};
copy('js');
fs.writeFileSync(path.join(out, 'tsconfig.json'), JSON.stringify({
  extends: path.join(root, 'tsconfig.json'),
  include: ['js/**/*.js'],
}, null, 2));

const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const r = spawnSync(tsc, ['-p', out, '--pretty', 'false', ...process.argv.slice(2)], { cwd: out, encoding: 'utf8' });
const text = `${r.stdout || ''}${r.stderr || ''}`.split(out + path.sep).join('').trim();
if (text) console.log(text);
const errors = (text.match(/error TS\d+/g) || []).length;
const checked = fs.readdirSync(path.join(root, 'js'), { recursive: true })
  .filter((f) => f.endsWith('.js') && /^\s*\/\/ @ts-check/m.test(fs.readFileSync(path.join(root, 'js', f), 'utf8').slice(0, 2000)));
console.log(r.status === 0 ? `typecheck: ${checked.length} files with @ts-check, no errors`
  : `typecheck: ${errors} error(s)`);
process.exit(r.status ?? 1);
