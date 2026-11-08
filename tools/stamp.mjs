// Cache-busting stamp. Run before every push:  node tools/stamp.mjs
//
// GitHub Pages lets browsers cache files for ~10 minutes, and Bluefy (iPhone) can
// end up with a fresh index.html but a stale app.js, which freezes the ride screen.
// This puts one build id on the CSS, the entry script and every relative JS import,
// so a new index.html always pulls the matching code.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const stamp = process.argv[2] || new Date().toISOString().replace(/\D/g, '').slice(0, 12); // yyyymmddhhmm UTC

const bust = (spec) => `${spec.replace(/\?v=[^'"]*$/, '')}?v=${stamp}`;
let changed = 0;
const rewrite = (file, fn) => {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after !== before) { fs.writeFileSync(p, after); changed++; }
};

for (const html of ['index.html', 'whoop.html']) {
  rewrite(html, (s) => s
    .replace(/(href|src)="((?:css|js)\/[^"?]+\.(?:css|js))(\?v=[^"]*)?"/g, (_, attr, file) => `${attr}="${bust(file)}"`));
}

const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
for (const file of walk('js')) {
  rewrite(file, (s) => s.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.js)(\?v=[^'"]*)?\2/g,
    (_, kw, q, spec) => `${kw}${q}${bust(spec)}${q}`));
}
console.log(`build ${stamp}: ${changed} file(s) updated`);
