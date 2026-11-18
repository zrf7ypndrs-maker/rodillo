// Browser smoke test: the whole app in Chrome, demo trainer, no Bluetooth or network.
// Opens every home screen and panel, rides a demo workout (start, skip, end), opens the ride page,
// and fails on any uncaught error or console error. Covers js/app.js, which the unit tests don't load.
// Needs Chrome: CHROME_PATH, or /usr/bin/google-chrome (GitHub's ubuntu-latest has it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadSeries, loadNow } from '../js/stats.js';

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
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('Errors in the page:\n' + errors.join('\n')); process.exit(1); }
console.log(`smoke: ${n} checks passed`);
