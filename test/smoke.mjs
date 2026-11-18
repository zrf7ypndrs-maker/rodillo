// Browser smoke test: the whole app in Chrome, demo trainer, no Bluetooth or network.
// Opens every home screen and panel (Today and Calendar also on a seeded week with a fixed clock), rides a demo workout (start, skip, end), opens the ride page,
// and fails on any uncaught error or console error. Covers js/app.js, which the unit tests don't load.
// Needs Chrome: CHROME_PATH, or /usr/bin/google-chrome (GitHub's ubuntu-latest has it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadSeries, loadNow } from '../js/stats.js';
import { flatten, mainSet, totalDuration } from '../js/engine/workout.js';
import { withDetail, defaultDetail, detailLabel, DETAIL_MIN, DETAIL_MAX } from '../js/engine/climb.js';
import { fmtTime } from '../js/ridepage.js';
import { DEFAULT_SETTINGS } from '../js/engine/session.js';
import { DEFAULT_REPO } from '../js/sync.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/rodillo/, '');
  const file = path.join(root, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/rodillo/`;

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const errors = [];
let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };

// 14 synced rides over the last six weeks (newest first, like rodillo-data index.json): ERG rides with intervals,
// Zone 2 rides with drift, one HR-only import (no power, no zones). Never today, so Today's hero is unchanged.
const HISTORY = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(); d.setDate(d.getDate() - 1 - i * 3); d.setHours(18, 30, 0, 0);
  const id = `${d.toLocaleDateString('en-CA')}T1830`, hrOnly = i === 5, z2 = i % 2 === 1;
  return {
    id, start: d.toISOString(), name: `Smoke ride ${i + 1}`, tags: hrOnly ? ['imported', 'outdoor'] : [], ftp: 250, durSec: 3600 + i * 60,
    np: hrOnly ? null : 190 + i, if: hrOnly ? null : 0.76, tss: 55 + i * 2, ...(hrOnly ? { tssFrom: 'hr' } : {}), avgHr: 138 + i,
    bests: hrOnly ? {} : { 5: 700 - i * 5, 15: 600, 30: 480, 60: 380, 180: 310, 300: 290, 600: 270, 1200: 255 - i, 3600: 200 },
    zones: hrOnly ? undefined : [300, z2 ? 2700 : 1500, 400, z2 ? 200 : 900, z2 ? 0 : 400, 0, 0],
    compliance: z2 || hrOnly ? null : { avg: 99, min: 96 - (i % 3), reps: 4 }, decoupling: z2 ? 3.1 : null,
  };
});

// The coach library as the app loads it (workouts/index.json), read here on its own so the checks don't lean on the
// app's code: ERG vs Slope lists, and the groups a few tags must land in (CLAUDE.md, "Workout library").
const LIB = JSON.parse(fs.readFileSync(path.join(root, 'workouts/index.json'), 'utf8')).workouts
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'workouts', f), 'utf8')));
const slopeOnly = (w) => flatten(w).every((s) => s.kind === 'sim');
const ORDER = { erg: ['VO2max', 'Threshold', 'Endurance', 'Tests'], slope: ['Climb intervals', 'Real climbs', 'Endurance', 'Tests'] };
const tagGroup = (w) => { const t = w.tags || []; return t.includes('test') ? 'Tests' : slopeOnly(w) ? (t.includes('real climb') ? 'Real climbs' : null) : t.includes('vo2') ? 'VO2max' : t.includes('threshold') ? 'Threshold' : null; };
const byName = (name) => LIB.find((w) => w.name === name);
const SS = byName('Sweet spot 3 x 12'), CLIMB = LIB.find((w) => w.id === 'climb-el-durazno');
const climbSegs = (lv) => { const c = withDetail(CLIMB, lv); return flatten({ ...c, steps: c.steps.slice(c.profile.lead.length) }); };
const climbText = (lv) => `${detailLabel(CLIMB.profile, lv)} · ${climbSegs(lv).length} steps`;

// Workouts built in the app (rodillo-data workouts/mine.json), served to a signed-in desktop by the mocked GitHub API
const MINE = { version: 1, deleted: {}, workouts: [
  { id: 'mine-smoke-older', name: 'Smoke older tempo', description: 'Built by the smoke test.', tags: [], updatedAt: '2026-11-01T10:00:00Z', steps: [{ dur: 300, power: 0.5 }, { dur: 600, power: 0.88 }, { dur: 300, power: 0.5 }] },
  { id: 'mine-smoke-newer', name: 'Smoke newer hills', description: 'Slope, built by the smoke test.', tags: [], updatedAt: '2026-11-10T10:00:00Z', steps: [{ dur: 300, grade: 0 }, { dur: 600, grade: 5 }] },
] };

/** Library lists as shown: groups in order, each row's library index, name and meta line. */
const listOf = (page, sel) => page.$$eval(`${sel} .wo-sec`, (secs) => secs.map((s) => ({
  g: s.querySelector('.wo-gh').textContent,
  rows: [...s.querySelectorAll('.wo')].map((r) => ({ i: +r.dataset.i, name: r.querySelector('.wo-name').childNodes[0].textContent.trim(), meta: r.querySelector('.wo-meta').textContent })),
})));
const shownNow = (page, sel) => page.$eval(sel, (el) => !el.closest('.hidden') && el.getBoundingClientRect().height > 0);
const kindsShown = (page) => page.evaluate(() => ['erg', 'slope', 'mine'].filter((k) => !document.querySelector(`#kind-${k}`).classList.contains('hidden')).join());
const lsGet = (page, k) => page.evaluate((key) => JSON.parse(localStorage.getItem(`rodillo.${key}`) ?? 'null'), k);
const rowSel = async (page, list, name) => {
  const i = (await listOf(page, list)).flatMap((s) => s.rows).find((r) => r.name === name)?.i;
  if (i === undefined) throw new Error(`library: no row "${name}" in ${list}`);
  return `${list} .wo[data-i="${i}"]`;
};
/** Point at stretch k of an open row's big chart (mouse on desktop, a tap on the phone) and return the readout. */
async function readout(page, row, k, phone) {
  await page.$eval(`${row} .wo-prof`, (el) => el.scrollIntoView({ block: 'center' })); // clear of the phone's nav pill
  const b = await page.locator(`${row} .wo-prof svg [data-i="${k}"]`).boundingBox();
  if (phone) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height * 0.75);
  else await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.75);
  await page.waitForFunction((r) => document.querySelector(`${r} .wo-prof.hov`), row, { timeout: 3000 });
  const tip = await page.$eval(`${row} .prof-tip`, (t) => Object.fromEntries(['lbl', 'tgt', 'time'].map((k) => [k, t.querySelector(`.pt-${k}`).textContent.replace(/\s+/g, ' ').trim()])));
  const on = await page.$$eval(`${row} .wo-prof svg .on`, (els) => els.map((e) => e.dataset.i));
  if (on.join() !== String(k)) throw new Error(`library: readout highlights stretches ${on.join()} instead of ${k}`);
  return tip;
}

// Workouts library (groups, rows, the open row, the ERG / Slope switch, a real climb's detail slider), signed out
async function libraryStep(page, label) {
  const phone = label === 'phone';
  const fail = (what) => { throw new Error(`library (${label}): ${what}`); };
  await page.click('#tabs button[data-tab="workouts"]');
  await page.waitForFunction((n) => (document.querySelector('#library-source')?.textContent || '').startsWith(`${n} workouts`), LIB.length, { timeout: 5000 });
  if (!(await page.isHidden('#kind-btn-mine'))) fail('Mine shows while signed out');

  for (const kind of ['erg', 'slope']) {
    await page.click(`#wo-kind button[data-kind="${kind}"]`);
    if (await kindsShown(page) !== kind) fail(`${kind} switch shows ${await kindsShown(page)}`);
    const sel = await page.$$eval('#wo-kind button', (bs) => bs.filter((b) => b.getAttribute('aria-selected') === 'true' && b.classList.contains('on')).map((b) => b.dataset.kind));
    if (sel.join() !== kind) fail(`${kind} switch selects ${sel.join()}`);
    if (await lsGet(page, 'woKind') !== kind) fail(`${kind} switch not remembered`);
    const list = kind === 'erg' ? '#workout-list' : '#slope-list';
    const secs = await listOf(page, list);
    const heads = secs.map((s) => s.g);
    if (heads.join() !== ORDER[kind].filter((g) => heads.includes(g)).join() || secs.some((s) => !s.rows.length)) fail(`${kind} groups ${heads.join()}`);
    const names = secs.flatMap((s) => s.rows.map((r) => r.name)).sort();
    const want = LIB.filter((w) => slopeOnly(w) === (kind === 'slope')).map((w) => w.name).sort();
    if (names.join('|') !== want.join('|')) fail(`${kind} list has ${names.length} rows, expected ${want.length}`);
    for (const s of secs) {
      for (const r of s.rows) { const g = tagGroup(byName(r.name)); if (g && g !== s.g) fail(`"${r.name}" under ${s.g}, expected ${g}`); }
      // ERG easiest first by TSS, slope by duration (the meta line shows both)
      const keys = s.rows.map((r) => +(kind === 'erg' ? r.meta.match(/TSS ~(\d+)/)?.[1] : r.meta.match(/^~?(\d+) min/)?.[1]));
      if (keys.some((x, j) => Number.isNaN(x) || (j && x < keys[j - 1]))) fail(`${kind} ${s.g} order ${keys.join(' ')}`);
    }
  }

  // the open row: one at a time, facts, Start reachable by keyboard, and the big chart's readout
  await page.click('#wo-kind button[data-kind="erg"]');
  const ss = await rowSel(page, '#workout-list', SS.name);
  await page.click(`${ss} .wo-name`);
  await page.waitForTimeout(600);
  const open = await page.evaluate((r) => {
    const c = document.querySelector(r);
    return {
      expanded: [...document.querySelectorAll('.wo.expanded')].map((x) => x.dataset.i), me: c.dataset.i,
      tabs: [...c.querySelectorAll('.start-row button')].map((b) => [b.textContent, b.tabIndex]),
      closedTabs: [...document.querySelectorAll('.wo:not(.expanded) .start-row button')].filter((b) => b.tabIndex !== -1).length,
      facts: [...c.querySelectorAll('.wo-facts .f')].map((f) => [f.querySelector('.fl').textContent, f.querySelector('.fv')?.textContent.replace(/\s/g, ' ') ?? '']),
      zbar: c.querySelectorAll('.wo-facts .zb i').length, desc: c.querySelector('.wo-desc').textContent,
      tags: [...c.querySelectorAll('.wo-tags .tag')].map((t) => t.textContent), grades: !!c.querySelector('.wo-grades'), detail: !!c.querySelector('.wo-detail'),
    };
  }, ss);
  if (open.expanded.join() !== open.me) fail(`open rows ${open.expanded.join()}`);
  if (JSON.stringify(open.tabs) !== JSON.stringify([['Start', 0]]) || open.closedTabs) fail(`open row buttons ${JSON.stringify(open.tabs)}, ${open.closedTabs} closed-row buttons reachable`);
  const fact = (l) => open.facts.find(([x]) => x === l)?.[1];
  if (!/^3 x 12 min at \d+ W$/.test(fact('Main set') || '') || fact('Time in zones') === undefined || open.zbar < 2) fail(`facts ${JSON.stringify(open.facts)}, ${open.zbar} zone bars`);
  if (open.desc !== SS.description || open.tags.includes('threshold') || open.grades || open.detail) fail(`open row text ${JSON.stringify(open)}`);
  const ftp = (await lsGet(page, 'settings'))?.ftp ?? DEFAULT_SETTINGS.ftp;
  const rep = flatten(SS, ftp)[1];
  const tip = await readout(page, ss, 1, phone);
  const wantTip = { lbl: `${rep.label} · 1 of 3`, tgt: `${Math.round(rep.from * ftp)} W ${Math.round(rep.from * 100)}% FTP`, time: `${fmtTime(rep.dur)}${rep.cadence ? ` · ${rep.cadence} rpm` : ''}${fmtTime(rep.start)} to ${fmtTime(rep.end)}` };
  if (JSON.stringify(tip) !== JSON.stringify(wantTip)) fail(`readout ${JSON.stringify(tip)}, expected ${JSON.stringify(wantTip)}`);
  // another row closes this one; tapping it again closes it too
  const other = `#workout-list .wo[data-i="${(await listOf(page, '#workout-list')).flatMap((s) => s.rows).find((r) => r.name !== SS.name).i}"]`;
  await page.click(`${other} .wo-name`);
  await page.waitForTimeout(400);
  const after = await page.$$eval('.wo.expanded', (els) => els.map((x) => x.dataset.i));
  if (after.join() !== await page.$eval(other, (c) => c.dataset.i) || await page.$eval(`${ss} .start-row button`, (b) => b.tabIndex) !== -1) fail(`opening a second row left ${after.join()} open`);
  await page.click(`${other} .wo-name`);
  await page.waitForTimeout(400);
  if (await page.locator('.wo.expanded').count()) fail('a second tap did not close the row');

  // a real climb: grade range, detail slider (finer = more stretches, saved per climb), readout, Default
  await page.click('#wo-kind button[data-kind="slope"]');
  const cl = await rowSel(page, '#slope-list', CLIMB.name);
  await page.click(`${cl} .wo-name`);
  await page.waitForTimeout(600);
  const climb = () => page.evaluate((r) => {
    const c = document.querySelector(r);
    return {
      text: c.querySelector('.wo-det-v').textContent, slider: c.querySelector('.wo-detail input').value, def: c.querySelector('[data-detdef]').hidden,
      mini: c.querySelectorAll(':scope > .profile polygon').length, big: c.querySelectorAll('.wo-prof polygon').length,
      grades: c.querySelector('.wo-grades')?.textContent.replace(/\s+/g, ' ').trim() || '', meta: c.querySelector('.wo-meta').textContent,
    };
  }, cl);
  const lv0 = defaultDetail(CLIMB), lv = lv0 === DETAIL_MIN + 1 ? DETAIL_MIN + 2 : DETAIL_MIN + 1;
  const sliderFor = (l) => String(DETAIL_MAX + DETAIL_MIN - l);
  const expectClimb = async (l, what) => {
    const c = await climb(), n = climbSegs(l).length;
    if (c.text !== climbText(l) || c.slider !== sliderFor(l) || c.def !== (l === lv0) || c.mini !== n || c.big !== n) fail(`${what}: ${JSON.stringify(c)}, expected "${climbText(l)}" with ${n} stretches`);
    if (!/^Max [\d.]+% Min -?[\d.]+%/.test(c.grades)) fail(`${what}: grade range "${c.grades}"`);
    const saved = (await lsGet(page, 'settings'))?.climbDetail?.[CLIMB.id];
    if (saved !== (l === lv0 ? undefined : l)) fail(`${what}: climbDetail saved ${saved}`);
  };
  await expectClimb(lv0, 'climb opened');
  await page.$eval(`${cl} .wo-detail input`, (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, sliderFor(lv));
  await expectClimb(lv, 'detail slider moved');
  const k = Math.floor(climbSegs(lv).length / 2), g = climbSegs(lv)[k];
  const ctip = await readout(page, cl, k, phone);
  if (ctip.lbl !== g.label || !ctip.tgt.startsWith(`${+(g.grade * 100).toFixed(1)}% grade`) || !ctip.time.includes(`(~${fmtTime(g.dur)})`)) fail(`climb readout ${JSON.stringify(ctip)}, stretch ${k} is ${g.label} at ${g.grade}`);
  await page.click(`${cl} [data-detdef]`);
  await expectClimb(lv0, 'Default');
  await page.click(`${cl} .wo-name`);
  await page.waitForTimeout(400);
  await page.click('#wo-kind button[data-kind="erg"]');
  if (await kindsShown(page) !== 'erg' || await page.locator('.wo.expanded').count()) fail('back on ERG with a row still open');
  await page.click('#tabs button[data-tab="today"]');
  ok(`${label}: Workouts: ERG / Slope switch, groups, open row, readout, real-climb detail slider`);
}

// Mine (desktop): signed in with a token, mine.json from the mocked GitHub API; then signed out and back in
async function mineRun() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route((url) => url.href.startsWith(`https://api.github.com/repos/${DEFAULT_REPO}/contents/workouts/mine.json`),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'smoke', content: Buffer.from(JSON.stringify(MINE)).toString('base64') }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`mine: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`mine console: ${m.text()}`); });
  const fail = (what) => { throw new Error(`mine: ${what}`); };
  const token = (on) => page.evaluate((t) => (t ? localStorage.setItem('rodillo.sync', JSON.stringify({ token: 'smoke-token' })) : localStorage.removeItem('rodillo.sync')), on);
  await page.goto(base, { waitUntil: 'load' });
  await token(true);
  await page.reload({ waitUntil: 'load' });
  await page.click('#tabs button[data-tab="workouts"]');
  await page.waitForFunction(() => document.querySelectorAll('#mine-list .wo').length === 2, null, { timeout: 5000 });
  if (!(await shownNow(page, '#kind-btn-mine'))) fail('no Mine switch while signed in');
  await page.click('#wo-kind button[data-kind="mine"]');
  if (await kindsShown(page) !== 'mine' || await lsGet(page, 'woKind') !== 'mine' || !(await shownNow(page, '#btn-new-wo'))) fail('Mine switch');
  const mine = await page.$$eval('#mine-list .wo', (els) => els.map((r) => r.querySelector('.wo-name').childNodes[0].textContent.trim()));
  if (mine.join() !== 'Smoke newer hills,Smoke older tempo' || await page.locator('#mine-list .wo-sec').count()) fail(`Mine list ${mine.join()} (newest first, one flat list)`);
  const coach = (await listOf(page, '#workout-list')).concat(await listOf(page, '#slope-list')).flatMap((s) => s.rows.map((r) => r.name));
  if (coach.some((x) => x.startsWith('Smoke'))) fail('a Mine workout shows in the ERG or Slope list');
  const first = '#mine-list .wo:first-child';
  await page.click(`${first} .wo-name`);
  await page.waitForTimeout(600);
  const btns = await page.$$eval(`${first} .start-row button`, (bs) => bs.map((b) => b.textContent));
  if (btns.join() !== 'Start,Edit') fail(`Mine row buttons ${btns.join()}`);
  await page.click(`${first} .wo-name`);
  await page.click('#wo-kind button[data-kind="erg"]');
  const ss = await rowSel(page, '#workout-list', SS.name);
  await page.click(`${ss} .wo-name`);
  await page.waitForTimeout(600);
  const cbtns = await page.$$eval(`${ss} .start-row button`, (bs) => bs.map((b) => b.textContent));
  if (cbtns.join() !== 'Start,Edit a copy') fail(`coach row buttons signed in ${cbtns.join()}`);
  await page.click(`${ss} .wo-name`);
  await page.click('#wo-kind button[data-kind="mine"]');
  // signed out: no Mine switch, no Mine rows, ERG shows, but Mine stays remembered for the next sign-in
  await token(false);
  await page.reload({ waitUntil: 'load' });
  await page.click('#tabs button[data-tab="workouts"]');
  await page.waitForFunction(() => document.querySelectorAll('#workout-list .wo').length > 0, null, { timeout: 5000 });
  if (!(await page.isHidden('#kind-btn-mine')) || await kindsShown(page) !== 'erg' || await page.locator('#mine-list .wo').count() || await lsGet(page, 'woKind') !== 'mine') fail('signed out: Mine still offered, or the remembered switch lost');
  await token(true);
  await page.reload({ waitUntil: 'load' });
  await page.click('#tabs button[data-tab="workouts"]');
  await page.waitForFunction(() => document.querySelectorAll('#mine-list .wo').length === 2, null, { timeout: 5000 });
  if (await kindsShown(page) !== 'mine') fail('signed in again: did not land on Mine');
  ok('desktop: Workouts: Mine signed in (seeded token), newest first, Edit; hidden signed out, back on sign-in');

  // Settings > Sync, token cleared while the builder is open: the other screens follow (builder closed, no Mine,
  // Today's hero on the public plan), without Settings knowing which screens those are
  await page.click('#btn-settings');
  await page.click('#set-tabs button[data-stab="sync"]');
  if (await page.inputValue('#set-token') !== 'smoke-token') fail('Sync tab does not show the token');
  await page.fill('#set-token', '');
  // the builder covers Settings (and closes it), so both can't be open by hand; closing the builder when access goes is a
  // safeguard, driven here through the DOM
  await page.$eval('#btn-new-wo', (b) => b.click());
  await page.waitForSelector('#builder:not(.hidden)', { timeout: 3000 });
  await page.$eval('#btn-token', (b) => b.click());
  await page.waitForFunction(() => /Sync turned off/.test(document.querySelector('#token-status').textContent), null, { timeout: 3000 });
  await page.waitForFunction(() => /public copy of the plan/.test(document.querySelector('#today .plan-src')?.textContent || ''), null, { timeout: 3000 })
    .catch(() => fail('Today\'s hero not refreshed after sync was turned off'));
  if (!(await page.isHidden('#builder')) || !(await page.isHidden('#kind-btn-mine')) || await page.locator('#mine-list .wo').count() || (await lsGet(page, 'sync')).token) fail('sync off: builder still open, Mine still offered or the token kept');
  ok('desktop: Settings > Sync, token cleared: builder closed, Mine hidden, Today on the public plan');
  await ctx.close();
}

// ---- Today + Calendar: a plan, rides and WHOOP seeded for one week, the clock fixed on three days of it.
// The public plan (plans/current.json) is replaced by this one, so the checks don't change when the coach edits the plan.
const PLAN = {
  name: 'Smoke week', ftp: 200,
  days: { '2026-11-16': 'z2-60', '2026-11-17': 'vo2-30-15', '2026-11-18': 'sweetspot-3x12', '2026-11-19': 'rest', '2026-11-20': 'strength', '2026-11-21': 'sim-rolling-45', '2026-11-22': 'z2-90' },
  optional: ['2026-11-22'],
  notes: { '2026-11-18': 'Smoke note: steady, not heroic.' },
  daily: { '2026-11-19': { action: 'rest', reason: 'Smoke coach: legs need a day.' } },
};
const rideAt = (day, hh, mm, x) => { const d = new Date(2026, 10, day, hh, mm); return { id: `${d.toLocaleDateString('en-CA')}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`, start: d.toISOString(), ftp: 250, ...x }; };
// newest first, like rodillo-data index.json: a free ride the morning of the workout day, the Tuesday workout done, an older Zone 2
const RIDES = [
  rideAt(18, 7, 15, { name: 'Free ride', tags: [], durSec: 1200, np: 150, avgP: 140, if: 0.6, tss: 15, avgHr: 120 }),
  rideAt(17, 18, 30, { name: 'VO2max 30/15 x 3 sets', workoutId: 'vo2-30-15', tags: ['vo2'], durSec: 3300, np: 210, avgP: 180, if: 0.84, kj: 600, tss: 72, avgHr: 150, maxHr: 178, compliance: { avg: 97, min: 93, reps: 30 } }),
  rideAt(12, 18, 0, { name: 'Zone 2, 60 min', workoutId: 'z2-60', tags: ['z2'], durSec: 3600, np: 160, avgP: 155, if: 0.64, tss: 41, avgHr: 128 }),
];
const WHOOP = { '2026-11-17': { recovery: 70 }, '2026-11-18': { recovery: 25 } };
const DAY_AT = { done: new Date(2026, 10, 17, 20, 0), workout: new Date(2026, 10, 18, 9, 0), rest: new Date(2026, 10, 19, 9, 0) };
const fmtHours = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const W = (id) => LIB.find((w) => w.id === id);

async function todayRun(viewport, label) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route((url) => url.pathname.endsWith('/plans/current.json'), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAN) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`today ${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`today ${label} console: ${m.text()}`); });
  const fail = (what) => { throw new Error(`today (${label}): ${what}`); };
  const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const vis = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none').catch(() => false);
  const at = async (when) => {
    await page.clock.setFixedTime(when);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#today .hero') && document.querySelectorAll('#week-strip .day').length, null, { timeout: 5000 });
  };
  const toRideAndBack = async (sel, tab) => {
    await page.click(sel);
    await page.waitForFunction(() => document.querySelector('#ridepage.active') && /details are in rodillo-data/.test(document.querySelector('#rd').textContent), null, { timeout: 3000 });
    await page.click('#rd [data-rd="back"]');
    await page.waitForSelector('#home.active', { timeout: 3000 });
    if (await page.getAttribute('#home', 'data-tab') !== tab) fail(`Back from a ride page left ${tab}`);
  };
  await page.clock.setFixedTime(DAY_AT.workout);
  await page.goto(base, { waitUntil: 'load' });
  const seed = (rides) => page.evaluate(([r, whoop]) => { localStorage.setItem('rodillo.remoteIndex', JSON.stringify(r)); localStorage.setItem('rodillo.whoop', JSON.stringify(whoop)); }, [rides, WHOOP]);
  await seed(RIDES.slice(1)); // the free ride comes later

  // ---- workout day (Wed Nov 18): planned Sweet spot, red recovery (then a free ride, below)
  await at(DAY_AT.workout);
  const ftp = (await lsGet(page, 'settings')).ftp;
  const ss = W('sweetspot-3x12'), set = mainSet(ss, ftp).replace(/\s+/g, ' ');
  const hero = await page.evaluate(() => {
    const h = document.querySelector('#today .hero'), q = (s) => h.querySelector(s);
    return {
      cls: h.className, name: q('.hero-name')?.textContent.trim(), meta: q('.hero-meta')?.textContent.replace(/\s+/g, ' '), desc: q('.hero-desc')?.textContent,
      btns: [...h.querySelectorAll('.hero-btns button')].map((b) => [b.id, b.className.includes('primary'), b.textContent.trim()]),
      doneLine: q('.hero-done')?.textContent.replace(/\s+/g, ' ').trim(), doneSee: !!q('.hero-done .hero-done-see'),
      bars: h.querySelectorAll('.hero-prof svg [data-i]').length, rec: q('.hero-rec')?.textContent.replace(/\s+/g, ' ').trim(), recDot: q('.hero-rec .rdot')?.className,
      recBtns: [...h.querySelectorAll('.hero-rec [data-rec]')].map((b) => b.dataset.rec), main: q('.hero-nums .hn.main .v')?.textContent,
    };
  });
  if (/nowo|done/.test(hero.cls) || hero.name !== ss.name) fail(`workout day hero ${hero.cls} "${hero.name}"`);
  if (!hero.meta?.includes(set)) fail(`hero meta ${JSON.stringify(hero.meta)} lacks the main set ${JSON.stringify(set)}`);
  if (hero.desc !== `Coach: ${PLAN.notes['2026-11-18']}`) fail(`hero coach note "${hero.desc}"`);
  if (JSON.stringify(hero.btns.map(([id, p]) => [id, p])) !== JSON.stringify([['hero-start', true], ['btn-free', false]]) || !/Start workout/.test(hero.btns[0][2])) fail(`hero buttons ${JSON.stringify(hero.btns)}`);
  if (hero.doneLine) fail(`done line "${hero.doneLine}" before any ride`);
  if (hero.bars !== flatten(ss, ftp).length) fail(`hero profile has ${hero.bars} intervals, expected ${flatten(ss, ftp).length}`);
  if (!/red recovery/i.test(hero.rec || '') || !/red/.test(hero.recDot || '') || hero.recBtns.join() !== 'swap,0.9') fail(`hero recovery line "${hero.rec}" ${hero.recBtns.join()}`);
  // big numbers (premium look, phone Nov 12, desktop Nov 13) replace the meta line on both layouts
  if (!(await vis('#today .hero-nums')) || await vis('#today .hero-meta')) fail('hero shows the meta line instead of the big numbers');
  if (hero.main?.replace(/W$/, '') !== set.match(/at ([\d/]+) W/)[1]) fail(`hero main watts ${hero.main}, set "${set}"`);
  // the profile readout (mouse on desktop, a tap on the phone) on the first interval
  await page.$eval('#today .hero-prof', (el) => el.scrollIntoView({ block: 'center' }));
  const b0 = await page.locator('#today .hero-prof svg [data-i="0"]').boundingBox();
  if (phone) await page.touchscreen.tap(b0.x + b0.width / 2, b0.y + b0.height * 0.8); else await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height * 0.8);
  await page.waitForSelector('#today .hero-prof.hov', { timeout: 3000 });
  if (await text('#today .hero-prof .pt-lbl') !== flatten(ss, ftp)[0].label) fail(`hero readout "${await text('#today .hero-prof .pt-lbl')}"`);
  if (!phone) await page.mouse.move(5, 5);
  // a free ride this morning: the workout stays open (Start still first) with a done line, and the recovery call goes
  await seed(RIDES);
  await at(DAY_AT.workout);
  const free = await page.evaluate(() => ({ name: document.querySelector('#today .hero-name').textContent.trim(), start: !!document.querySelector('#hero-start'), rec: !!document.querySelector('#today .hero-rec'),
    line: document.querySelector('#today .hero-done')?.textContent.replace(/\s+/g, ' ').trim(), see: !!document.querySelector('#today .hero-done .hero-done-see') }));
  if (free.name !== ss.name || !free.start || !/Free ride · 15 TSS/.test(free.line || '') || !free.see || free.rec) fail(`after a free ride ${JSON.stringify(free)}`);

  // overview tiles: recovery, this week (done / planned, optional day left out), form, FTP
  const ov = await page.evaluate(() => {
    const shown = (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
    return {
      tiles: [...document.querySelectorAll('#overview .stat.ov2')].filter(shown).map((t) => [t.querySelector('.ol').textContent, t.querySelector('.v').textContent.replace(/\s+/g, ' ').trim()]),
      dots: [...document.querySelectorAll('#overview .ov-week .wd')].map((d) => d.className.replace('wd ', '')),
      card: [...document.querySelectorAll('#overview .rec-card')].filter(shown).map((c) => c.querySelector('.rc-v').textContent),
    };
  });
  const real = RIDES;
  const ld = loadNow(loadSeries(real, DAY_AT.workout, 90).at(-1));
  const weekKeys = ['16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-11-${d}`);
  const planSec = weekKeys.filter((k) => W(PLAN.days[k]) && !PLAN.optional.includes(k)).reduce((a, k) => a + totalDuration(W(PLAN.days[k])), 0);
  const doneSec = real.filter((r) => weekKeys.includes(r.id.slice(0, 10))).reduce((a, r) => a + r.durSec, 0);
  const tile = (l) => ov.tiles.find(([x]) => x === l)?.[1];
  const labels = ov.tiles.map(([l]) => l).join();
  if (labels !== (phone ? 'This week,Form,FTP' : 'Recovery,This week,Form,FTP')) fail(`overview tiles ${labels}`);
  if (phone ? ov.card.join() !== '25%' : tile('Recovery') !== '25%') fail(`recovery ${phone ? ov.card.join() : tile('Recovery')}`);
  if (tile('This week') !== `${fmtHours(doneSec)} / ${fmtHours(planSec)}`) fail(`this week "${tile('This week')}", expected ${fmtHours(doneSec)} / ${fmtHours(planSec)}`);
  // a day's dot fills once anything is ridden (like the Calendar's check mark), so the free ride fills today's
  if (ov.dots.join() !== 'plan,done,done today,off,off,plan,plan') fail(`week dots ${ov.dots.join()}`);
  if (!tile('Form')?.startsWith(`${ld.form > 0 ? '+' : ''}${ld.form}`)) fail(`form "${tile('Form')}", expected ${ld.form}`);
  if (!tile('FTP')?.startsWith(`${ftp} W`)) fail(`FTP tile "${tile('FTP')}"`);

  // Next days: the 13 days after today, from tomorrow
  const strip = await page.$$eval('#week-strip .day', (ds) => ds.map((d) => [d.dataset.day, d.querySelector('.d-name').textContent, d.querySelector('.d-missed')?.textContent || '']));
  const want = [['2026-11-19', 'Rest', ''], ['2026-11-20', 'Strength', ''], ['2026-11-21', W('sim-rolling-45').name, ''], ['2026-11-22', W('z2-90').name, 'Optional'], ['2026-11-23', 'Nothing planned', '']];
  if (strip.length !== 13 || JSON.stringify(strip.slice(0, 5)) !== JSON.stringify(want)) fail(`Next days ${JSON.stringify(strip.slice(0, 5))} (${strip.length} cards)`);
  if (!(await page.isDisabled('#week [data-scroll="-1"]'))) fail('Next days starts scrolled');
  ok(`${label}: Today on a workout day (fixed clock): hero, recovery call, readout, a free ride done, overview tiles, Next days`);

  // a Next days card opens that day in the Calendar
  await page.click('#week-strip .day[data-day="2026-11-21"]');
  await page.waitForFunction(() => document.querySelector('#home').dataset.tab === 'calendar' && document.querySelector('.cal-cell.sel')?.dataset.day === '2026-11-21', null, { timeout: 3000 });
  if (!/^Saturday, November 21/.test(await text('#cal-detail h3')) || await text('#cal-detail .wo-name') !== W('sim-rolling-45').name || await text('#cal-detail [data-startday]') !== 'Ride it now') fail('Next days card opened the wrong Calendar day');

  // ---- Calendar (same fixed day): month grid, chips, today's detail, then a done, a missed and a rest day opened
  await page.click('#cal-today');
  const cal = await page.evaluate(() => ({
    title: document.querySelector('#cal-title').textContent,
    cells: [...document.querySelectorAll('#cal-grid .cal-cell')].map((c) => [c.dataset.day, c.className.replace(/\s+/g, ' ').trim(), c.querySelector('.cal-chip')?.textContent || '', (c.querySelector('.cal-done, .cal-missed')?.textContent || '').trim()]),
  }));
  const cell = (k) => cal.cells.find(([d]) => d === k);
  const nov = cal.cells.filter(([d]) => d.startsWith('2026-11')).map(([d]) => d);
  if (cal.title !== 'November 2026' || cal.cells[0][0] !== '2026-10-26' || nov.length !== 30 || new Set(nov).size !== 30) fail(`month ${cal.title}, first ${cal.cells[0][0]}, ${nov.length} November days`);
  if (cal.cells.filter(([, c]) => /\btoday\b/.test(c)).map(([d]) => d).join() !== '2026-11-18' || cal.cells.filter(([, c]) => /\bsel\b/.test(c)).map(([d]) => d).join() !== '2026-11-18') fail('today / selected cell');
  const mins = (id) => `${Math.round(totalDuration(W(id)) / 60)}'`;
  const chips = [['2026-11-16', `${W('z2-60').name}${mins('z2-60')}`, 'missed'], ['2026-11-17', `${W('vo2-30-15').name}${mins('vo2-30-15')}`, '✓ 72 TSS'], ['2026-11-18', `${ss.name}${mins(ss.id)}`, '✓ 15 TSS'],
    ['2026-11-19', 'Rest', ''], ['2026-11-20', 'Strength', ''], ['2026-11-22', `${W('z2-90').name}${mins('z2-90')}`, 'optional'], ['2026-11-25', '', '']];
  for (const [k, chip, st] of chips) if (cell(k)[2] !== chip || cell(k)[3] !== st) fail(`${k} cell "${cell(k)[2]}" "${cell(k)[3]}", expected "${chip}" "${st}"`);
  if (!cell('2026-10-26')[1].includes('other')) fail('October days not marked as the other month');
  const det = () => page.evaluate(() => {
    const d = document.querySelector('#cal-detail'), q = (s) => d.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim();
    return { h: q('h3'), name: q('.wo-name'), done: q('.cal-done-name'), sub: q('.cal-done-sub'), stats: d.querySelectorAll('.cal-stats .hs').length, start: q('[data-startday]'), startPrimary: !!d.querySelector('[data-startday].primary'),
      missed: q('.cal-missed-line'), coach: q('.coach-call'), whoop: [...d.querySelectorAll('.cal-ride')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()), text: d.textContent.replace(/\s+/g, ' '), bars: d.querySelectorAll('.cal-prof svg [data-i]').length };
  });
  let dd = await det();
  if (!/^Wednesday, November 18/.test(dd.h) || dd.name !== ss.name || dd.start !== 'Start' || !dd.startPrimary || !dd.text.includes(`Coach: ${PLAN.notes['2026-11-18']}`) || dd.bars !== flatten(ss, ftp).length) fail(`today's detail ${JSON.stringify(dd)}`);
  if (!dd.whoop.some((x) => /WHOOP: recovery 25%/.test(x)) || !dd.whoop.some((x) => /Free ride .*TSS 15.*See ride/.test(x))) fail(`today's detail rides / WHOOP ${JSON.stringify(dd.whoop)}`);
  // a done day: the result first (no Start, no plan note), the ride's numbers, See ride opens it and Back returns here
  await page.click('.cal-cell[data-day="2026-11-17"]');
  dd = await det();
  const vo2 = RIDES[1];
  if (!/^Tuesday, November 17/.test(dd.h) || dd.done !== `Done. ${W('vo2-30-15').name}` || !/^Weakest rep at 93% of target\. Ridden at /.test(dd.sub || '') || dd.stats !== 6 || dd.start) fail(`done day detail ${JSON.stringify(dd)}`);
  if (!dd.text.includes(fmtTime(vo2.durSec)) || !dd.text.includes('210 W') || !dd.text.includes('0.84')) fail('done day numbers');
  await toRideAndBack('#cal-detail .cal-see-main', 'calendar');
  if (await page.$eval('.cal-cell.sel', (c) => c.dataset.day) !== '2026-11-17') fail('Back from the ride page lost the selected day');
  await page.click('.cal-cell[data-day="2026-11-16"]');
  dd = await det();
  if (dd.missed !== 'Missed.' || dd.start !== 'Ride it now' || dd.startPrimary || dd.done) fail(`missed day detail ${JSON.stringify(dd)}`);
  await page.click('.cal-cell[data-day="2026-11-19"]');
  dd = await det();
  if (!dd.text.includes('Rest day.') || !/Rest instead/.test(dd.coach || '') || !dd.coach.includes('Smoke coach') || dd.start) fail(`rest day detail ${JSON.stringify(dd)}`);
  // month switch, a day in another month, back to today
  await page.click('#cal-next');
  if (await text('#cal-title') !== 'December 2026') fail('next month');
  await page.click('#cal-prev'); await page.click('#cal-prev');
  if (await text('#cal-title') !== 'October 2026') fail('previous month');
  await page.click('.cal-cell[data-day="2026-11-01"]'); // a November day shown in October's last row moves the month
  if (await text('#cal-title') !== 'November 2026' || !/^Sunday, November 1/.test((await det()).h)) fail('a next-month cell did not move the month');
  await page.click('#cal-today');
  if (await text('#cal-title') !== 'November 2026' || !/^Wednesday, November 18/.test((await det()).h)) fail('Today button');
  ok(`${label}: Calendar (fixed clock): month grid and chips, a day opened from Next days, done / missed / rest days, ride page and back, month switch`);

  // ---- rest day (Thu Nov 19): no workout, free ride is the main button, the coach's call
  await page.click('#tabs button[data-tab="today"]');
  await at(DAY_AT.rest);
  const rest = await page.evaluate(() => {
    const h = document.querySelector('#today .hero');
    return { cls: h.className, name: h.querySelector('.hero-name').textContent, desc: h.querySelector('.hero-desc')?.textContent, start: !!h.querySelector('#hero-start'), prof: !!h.querySelector('.hero-prof'),
      free: [h.querySelector('#btn-free').className.includes('primary'), h.querySelector('#btn-free').textContent.trim()], rec: h.querySelector('.hero-rec')?.textContent.replace(/\s+/g, ' ').trim() };
  });
  if (!rest.cls.includes('nowo') || rest.name !== 'Rest day' || !/Nothing planned/.test(rest.desc) || rest.start || rest.prof || !rest.free[0] || rest.free[1] !== 'Start free ride') fail(`rest day hero ${JSON.stringify(rest)}`);
  if (!/Rest instead/.test(rest.rec || '') || !rest.rec.includes('Smoke coach')) fail(`rest day coach call "${rest.rec}"`);
  if (await page.$eval('#week-strip .day', (d) => d.dataset.day) !== '2026-11-20') fail('Next days on the rest day does not start tomorrow');

  // ---- done day (Tue Nov 17, evening): the result, the ride's numbers, See ride and back to Today
  await at(DAY_AT.done);
  const done = await page.evaluate(() => {
    const h = document.querySelector('#today .hero'), q = (s) => h.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim();
    return { cls: h.className, name: q('.hero-name'), desc: q('.hero-desc'), stats: [...h.querySelectorAll('.hero-stats .hs .l b')].map((b) => b.textContent), start: !!h.querySelector('#hero-start'),
      btns: [...h.querySelectorAll('.hero-btns button')].map((b) => b.id), bars: h.querySelectorAll('.hero-prof svg [data-i]').length };
  });
  if (!done.cls.includes('done') || done.name !== `Done. ${W('vo2-30-15').name}` || done.desc !== 'Weakest rep at 93% of target.' || done.start) fail(`done day hero ${JSON.stringify(done)}`);
  if (done.stats.join() !== 'Time,NP,TSS,IF,Avg HR,Intervals' || done.btns.join() !== 'hero-see,btn-free' || done.bars !== flatten(W('vo2-30-15'), ftp).length) fail(`done hero stats / buttons ${JSON.stringify(done)}`);
  await toRideAndBack('#hero-see', 'today');
  ok(`${label}: Today on a rest day and a done day (fixed clock): free ride first, coach call, the ride's numbers, See ride and back`);
  await ctx.close();
}

async function run(viewport, label) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport, hasTouch: label === 'phone', isMobile: label === 'phone' });
  // nothing leaves the machine: GitHub, WHOOP and fonts CDNs get an empty answer
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#today', { state: 'attached' });
  ok(`${label}: app loads`);

  for (const tab of ['workouts', 'calendar', 'training', 'today']) {
    await page.click(`#tabs button[data-tab="${tab}"]`);
    await page.waitForTimeout(150);
  }
  ok(`${label}: Today, Workouts, Calendar, Training`);

  // Training tab (js/training.js): seeded synced history -> stats card, fitness chart, weekly bars, power curve,
  // time in zones and the rides list; then the history is taken away again and the tab shows its empty state
  await page.evaluate((idx) => localStorage.setItem('rodillo.remoteIndex', JSON.stringify(idx)), HISTORY);
  await page.click('#tabs button[data-tab="today"]');
  await page.click('#tabs button[data-tab="training"]');
  await page.waitForFunction((n) => document.querySelectorAll('#ride-table [data-ride]').length >= n, HISTORY.length, { timeout: 3000 });
  const tr = await page.evaluate(() => {
    const vis = (el) => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
    const q = (s) => document.querySelector(s);
    return {
      cards: [...document.querySelectorAll('#training-cards .stat')].map((c) => [c.querySelector('.l').textContent, c.querySelector('.v').textContent]),
      load: { vis: vis(q('#chart-load svg')), lines: document.querySelectorAll('#chart-load polyline').length, bars: document.querySelectorAll('#chart-load rect').length, view: q('#chart-load svg')?.getAttribute('viewBox'), text: q('#chart-load').textContent },
      weeks: document.querySelectorAll('#chart-weekly svg > g > title').length, weeklyVis: vis(q('#chart-weekly svg')), weeklyText: q('#chart-weekly').textContent,
      curve: { vis: vis(q('#chart-curve svg')), phone: !!q('#chart-curve svg.pc-phone'), lines: document.querySelectorAll('#chart-curve polyline').length, dots: document.querySelectorAll('#chart-curve circle').length },
      zones: [...document.querySelectorAll('#chart-zones h4')].map((h) => h.textContent), zbars: document.querySelectorAll('#chart-zones .zbars').length, zonesVis: vis(q('#chart-zones .zbars')),
      table: vis(q('#ride-table table')) ? document.querySelectorAll('#ride-table tr[data-ride]').length : 0,
      list: vis(q('#ride-table .ride-list')) ? document.querySelectorAll('#ride-table .rl').length : 0,
      names: [...document.querySelectorAll(vis(q('#ride-table table')) ? '#ride-table tr[data-ride]' : '#ride-table .rl')].map((r) => r.dataset.ride),
      rows: q('#ride-table').textContent,
    };
  });
  const fail = (what) => { throw new Error(`training (${label}): ${what}`); };
  const card = (l) => tr.cards.find(([x]) => x === l)?.[1];
  if (tr.cards.length !== 6) fail(`${tr.cards.length} stat cards`);
  const want = loadNow(loadSeries(HISTORY, new Date(), 90).at(-1));
  if (card('Fitness (CTL)') !== String(want.fitness) || card('Fatigue (ATL)') !== String(want.fatigue) || card('Form (TSB)') !== `${want.form > 0 ? '+' : ''}${want.form}`)
    fail(`fitness / fatigue / form cards ${tr.cards.slice(0, 3).map((c) => c[1]).join(' ')}, expected ${want.fitness} ${want.fatigue} ${want.form}`);
  if (!tr.load.vis || tr.load.lines !== 2 || tr.load.bars < 40 || !tr.load.text.includes('Fitness') || !/Form now/.test(tr.load.text)) fail(`fitness chart ${JSON.stringify(tr.load)}`);
  if (tr.load.view !== (phone ? '0 0 640 440' : '0 0 640 330')) fail(`fitness chart drawn for the wrong layout (${tr.load.view})`);
  if (!tr.weeklyVis || tr.weeks !== (phone ? 8 : 12) || !tr.weeklyText.includes('HR only')) fail(`weekly bars: ${tr.weeks} weeks`);
  if (!tr.curve.vis || tr.curve.lines !== 2 || tr.curve.dots !== 9 || tr.curve.phone !== phone) fail(`power curve ${JSON.stringify(tr.curve)}`);
  if (tr.zbars !== 2 || !tr.zonesVis || !/^Last 4 weeks/.test(tr.zones[1] || '') || !/rides/.test(tr.zones[1])) fail(`time in zones ${JSON.stringify(tr.zones)}`);
  if ((phone ? tr.list : tr.table) !== HISTORY.length || (phone ? tr.table : tr.list) !== 0) fail(`rides list: table ${tr.table} rows, list ${tr.list} cards`);
  if (tr.names.join() !== HISTORY.map((r) => r.id).join()) fail('rides not newest first');
  if (!tr.rows.includes('Smoke ride 3') || !/HR/.test(tr.rows) || !/Drift|%/.test(tr.rows)) fail('ride rows missing names, HR-only TSS or compliance / drift');
  // a row opens its ride page (signed out: the "details are in rodillo-data" note), Back returns to Training
  await page.click(`#ride-table ${phone ? '.rl' : 'tr'}[data-ride="${HISTORY[2].id}"] ${phone ? '.rl-name' : 'td'}`);
  await page.waitForFunction(() => document.querySelector('#ridepage.active') && /details are in rodillo-data/.test(document.querySelector('#rd').textContent), null, { timeout: 3000 });
  await page.click('#rd [data-rd="back"]');
  await page.waitForSelector('#home.active', { timeout: 3000 });
  if (await page.getAttribute('#home', 'data-tab') !== 'training') fail('Back from a ride page left the Training tab');
  await page.evaluate(() => localStorage.removeItem('rodillo.remoteIndex'));
  await page.click('#tabs button[data-tab="today"]');
  await page.click('#tabs button[data-tab="training"]');
  await page.waitForFunction(() => /No rides yet/.test(document.querySelector('#ride-table').textContent), null, { timeout: 3000 });
  await page.click('#tabs button[data-tab="today"]');
  ok(`${label}: Training: stats card, fitness chart, weekly bars, power curve, zones and rides from synced history`);

  await libraryStep(page, label);

  if (label === 'desktop') {
    for (const btn of ['#btn-settings', '#btn-controls', '#btn-garage', '#btn-devices']) {
      await page.click(btn);
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    ok(`${label}: Settings, Controls, Garage, Connections open and close`);

    // Garage (js/garage.js): Bikes / Gearing tabs, a bike's details, a custom bike and a new gearing, both cancelled
    const saved = () => page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('rodillo.settings') || '{}').garage ?? null));
    const before = await saved();
    const shown = (sel) => page.waitForFunction((s) => { const el = document.querySelector(s); return el && !el.closest('.hidden'); }, sel, { timeout: 3000 });
    await page.click('#btn-garage');
    await shown('#garage-form .gar-tile');
    const tiles = await page.locator('#garage-form .gar-tile').count();
    await page.click('#gar-tabs button[data-gtab="gearing"]');
    await shown('#gearing-form #gear-all');
    if (!(await page.isHidden('#garage-form'))) throw new Error('garage: Bikes still showing on the Gearing tab');
    await page.click('#gear-new');
    await shown('#gearing-form #set-gears');
    await page.selectOption('#set-gears', '2x12');
    await page.click('#gear-back');
    await shown('#gearing-form #gear-all');
    await page.click('#gar-tabs button[data-gtab="bikes"]');
    await shown('#garage-form .gar-tile');
    if (!(await page.isHidden('#gearing-form'))) throw new Error('garage: Gearing still showing on the Bikes tab');
    await page.click('#garage-form .gar-more[data-details]');
    await shown('#garage-form .gar-dl');
    await page.click('#gar-back');
    await shown('#garage-form .gar-tile');
    await page.click('#gar-custom');
    await shown('#garage-form #set-gname');
    await page.fill('#set-gname', 'Smoke bike');
    await page.selectOption('#set-bike', 'custom');
    await shown('#garage-form #set-btype');
    await page.selectOption('#set-btype', { index: 1 });
    await page.click('#gar-back'); // Cancel
    await shown('#garage-form .gar-tile');
    if (await page.locator('#garage-form .gar-tile').count() !== tiles) throw new Error('garage: Cancel changed the bike list');
    if (await saved() !== before) throw new Error('garage: Cancel saved something');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#garage.hidden', { state: 'attached', timeout: 3000 });
    ok(`${label}: Garage: Bikes / Gearing, details, custom bike and new gearing cancelled`);

    // Settings: every tab shows only its own pane; a change in each tab is saved, shows again after reopening,
    // and is put back the same way (so the demo ride below rides the usual settings)
    const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('rodillo.settings') || '{}'));
    const onTab = async (tab) => {
      await page.click(`#set-tabs button[data-stab="${tab}"]`);
      await shown(`#settings [data-pane="${tab}"]`);
      const open = await page.$$eval('#settings .stab-pane', (ps) => ps.filter((p) => !p.classList.contains('hidden')).map((p) => p.dataset.pane));
      if (open.join() !== tab) throw new Error(`settings: ${tab} tab shows panes ${open.join(', ')}`);
    };
    const put = async (sel, v) => ((await page.$eval(sel, (el) => el.tagName)) === 'SELECT' ? page.selectOption(sel, v) : page.fill(sel, v));
    const expect = async (key, want, what) => {
      const got = (await settings())[key];
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`settings: ${what}: ${key} saved as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    };
    const orig = await settings();
    // [tab, field, key, new value typed, value saved, typed to put it back]
    const num = (k, mult = 1) => String(+(orig[k] * mult).toFixed(3));
    const edits = [
      ['rider', '#set-name', 'riderName', 'Smoke', 'Smoke', orig.riderName || ''],
      ['rider', '#set-ftp', 'ftp', String(orig.ftp + 7), orig.ftp + 7, num('ftp')],
      ['ride', '#set-autoPauseSec', 'autoPauseSec', String(orig.autoPauseSec + 2), orig.autoPauseSec + 2, num('autoPauseSec')],
      ['ride', '#set-guard', 'ergCadenceGuard', orig.ergCadenceGuard ? '0' : '1', !orig.ergCadenceGuard, orig.ergCadenceGuard ? '1' : '0'],
      ['road', '#set-gradeScale', 'gradeScale', '75', 0.75, num('gradeScale', 100)],
      ['trainer', '#set-gmax', 'maxSendGrade', '12', 0.12, num('maxSendGrade', 100)],
      ['trainer', '#set-shift', 'trainerShifting', orig.trainerShifting === 'app' ? 'auto' : 'app', orig.trainerShifting === 'app' ? 'auto' : 'app', orig.trainerShifting === 'app' ? 'app' : 'auto'],
    ];
    await page.click('#btn-settings');
    await shown('#settings-form .fld');
    for (const [tab, sel, key, typed, want] of edits) { await onTab(tab); await put(sel, typed); await expect(key, want, `${tab} tab`); }
    await onTab('sync');
    const repo = await page.inputValue('#set-repo');
    await page.fill('#set-repo', 'smoke/rodillo-data');
    await page.click('#btn-token');
    await page.waitForFunction(() => /Sync turned off|Syncing with/.test(document.querySelector('#token-status').textContent), null, { timeout: 3000 });
    const sync = await page.evaluate(() => JSON.parse(localStorage.getItem('rodillo.sync') || '{}'));
    if (sync.repo !== 'smoke/rodillo-data') throw new Error(`settings: Sync tab saved repo ${sync.repo}`);
    await page.click('#settings [data-close]');
    await page.waitForSelector('#settings.hidden', { state: 'attached', timeout: 3000 });
    // reopen: back on the Sync tab, every field shows what was saved; then put each one back
    await page.click('#btn-settings');
    await shown('#settings [data-pane="sync"]');
    if (await page.inputValue('#set-repo') !== 'smoke/rodillo-data') throw new Error('settings: reopened Sync tab lost the repo');
    await page.fill('#set-repo', repo);
    await page.click('#btn-token');
    await page.waitForFunction((r) => JSON.parse(localStorage.getItem('rodillo.sync') || '{}').repo === r, repo, { timeout: 3000 });
    for (const [tab, sel, key, typed, , back] of edits) {
      await onTab(tab);
      if (await page.inputValue(sel) !== typed) throw new Error(`settings: reopened ${tab} tab shows ${sel} = ${await page.inputValue(sel)}, saved ${typed}`);
      await put(sel, back);
      await expect(key, orig[key] ?? (key === 'riderName' ? '' : undefined), `${tab} tab put back`);
    }
    // a typed grade range marks the trainer as chosen (trainerModel "" -> a model or "custom"), and the menu has no "none"
    const norm = (s) => JSON.stringify({ ...s, riderName: s.riderName || '', trainerModel: null });
    if (norm(await settings()) !== norm(orig)) throw new Error('settings: putting every field back left other settings changed');
    await page.click('#settings [data-close]');
    await page.waitForSelector('#settings.hidden', { state: 'attached', timeout: 3000 });
    ok(`${label}: Settings: each tab, a change saved in each, reopened and put back`);

    await page.click('#btn-devices');
    await page.click('#btn-demo');
    await page.keyboard.press('Escape');
    await page.click('#tabs button[data-tab="workouts"]');
    await page.click('#workout-list .wo[data-i="0"] .wo-name'); // open the first library row
    await page.waitForTimeout(600);
    await page.click('#workout-list button[data-start="0"]');
    await page.waitForSelector('#ride.active');
    ok(`${label}: demo workout starts`);

    await page.waitForFunction(() => document.querySelector('#ride.active') && /\d:\d\d/.test(document.body.innerText), null, { timeout: 10000 });
    await page.waitForTimeout(13000); // past the 10-sample minimum so the ride is kept
    await page.keyboard.down('s'); await page.waitForTimeout(3500); await page.keyboard.up('s'); // skip is a 3 s hold
    await page.waitForFunction(() => /Skipped/.test(document.body.innerText), null, { timeout: 3000 });
    ok(`${label}: hold S skips an interval`);

    await page.keyboard.down('Escape'); await page.waitForTimeout(5500); await page.keyboard.up('Escape'); // end is a 5 s hold
    await page.waitForSelector('#ridepage.active', { timeout: 10000 });
    await page.waitForFunction(() => /Demo ride/.test(document.querySelector('#ridepage').innerText), null, { timeout: 5000 });
    ok(`${label}: hold Esc ends the ride, done page opens`);
  }
  await ctx.close();
}

try {
  await run({ width: 1280, height: 800 }, 'desktop');
  await run({ width: 390, height: 844 }, 'phone');
  await mineRun();
  await todayRun({ width: 1280, height: 800 }, 'desktop');
  await todayRun({ width: 390, height: 844 }, 'phone');
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('Errors in the page:\n' + errors.join('\n')); process.exit(1); }
console.log(`smoke: ${n} checks passed`);
