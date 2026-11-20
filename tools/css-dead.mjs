// Lists selectors in css/app.css that can never match: a class or id they need appears nowhere in the HTML pages or the
// JS (templates, classList, querySelector strings). Conservative: a name counts as used if it appears as a whole word in
// any of those files, so this misses dead rules whose names also appear for other reasons; it never flags a live one
// unless a class name is built from pieces (check those by hand: `int-${x}`, 'is-' + y). Report only; edits are by hand.
//   node tools/css-dead.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = [...fs.readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => path.join(root, f)), ...walk(path.join(root, 'js')).filter((f) => f.endsWith('.js'))];
const text = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const used = new Set(text.match(/[A-Za-z_][\w-]*/g));

const css = fs.readFileSync(path.join(root, 'css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
// selector preludes with their line numbers (skips @keyframes steps and at-rule preludes)
const rules = [];
let depth = 0, start = 0, inKeyframes = -1;
for (let i = 0; i < css.length; i++) {
  const c = css[i];
  if (c === '{') {
    const prelude = css.slice(start, i).trim();
    if (prelude.startsWith('@keyframes')) inKeyframes = depth;
    else if (!prelude.startsWith('@') && inKeyframes < 0) rules.push({ prelude, line: css.slice(0, i).split('\n').length });
    depth++; start = i + 1;
  } else if (c === '}') {
    depth--; start = i + 1;
    if (depth === inKeyframes) inKeyframes = -1;
  } else if (c === ';' && depth > 0) start = i + 1;
}
const names = (sel) => [...sel.replace(/\[[^\]]*\]/g, '').replace(/url\([^)]*\)/g, '').matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] + m[2]);
let n = 0;
for (const r of rules) {
  const sels = r.prelude.split(/,(?![^(]*\))/).map((x) => x.trim());
  const dead = sels.filter((sel) => names(sel).some((nm) => !used.has(nm.slice(1))));
  if (!dead.length) continue;
  n += dead.length;
  console.log(`${r.line}: ${dead.length === sels.length ? 'RULE' : 'part'}  ${dead.join(', ')}   [missing: ${[...new Set(dead.flatMap((s) => names(s).filter((nm) => !used.has(nm.slice(1)))))].join(' ')}]`);
}
console.log(`${n} dead selectors in ${rules.length} rules`);
