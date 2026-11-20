// Screenshot harness for CSS work that must not change what anyone sees (code-health plan step 7).
//   npm run visual -- --baseline   capture into .visual/baseline (run this on the commit you compare against)
//   npm run visual                 capture into .visual/current and compare with .visual/baseline, pixel for pixel
//   npm run visual -- --only ride  only scenes whose name contains "ride" (any number of --only)
// Every home tab (and a few states of them), every panel, the builder, the ride page and the ride screen (ERG, slope,
// paused), at desktop 1280 and phone 390, light and dark. Fixed clock (Wed Nov 18 2026, 9:00), seeded rides, plan,
// WHOOP and workouts, seeded Math.random (demo trainer noise), no network, CSS animations and transitions finished
// before each shot (Playwright animations: 'disabled'), caret hidden. Captures run one at a time: real-time animations
// lag under load. Exit 1 on any differing pixel; diff images (changed pixels red over a faded copy) go to .visual/diff.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';
import { buildRide } from '../js/stats.js';
import { flatten } from '../js/engine/workout.js';
import { DEFAULT_REPO } from '../js/sync.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : []));
const baselineRun = args.includes('--baseline');
const compareOnly = args.includes('--compare'); // no capture: compare what .visual/current holds
const outDir = path.join(root, '.visual', baselineRun ? 'baseline' : 'current');
const baseDir = path.join(root, '.visual', 'baseline');
const diffDir = path.join(root, '.visual', 'diff');

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
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none', '--disable-gpu', '--disable-partial-raster', '--disable-lcd-text', '--force-color-profile=srgb'] });

// ---------------------------------------------------------------- seeded data (same week as the smoke test's Today run)
const NOW = new Date(2026, 10, 18, 9, 0); // Wed: Sweet spot planned
const DAY_AT = { workout: NOW, done: new Date(2026, 10, 17, 20, 0), rest: new Date(2026, 10, 19, 9, 0) };
const PLAN = {
  name: 'Visual week', ftp: 200,
  days: { '2026-11-16': 'z2-60', '2026-11-17': 'vo2-30-15', '2026-11-18': 'sweetspot-3x12', '2026-11-19': 'rest', '2026-11-20': 'strength', '2026-11-21': 'sim-rolling-45', '2026-11-22': 'z2-90' },
  optional: ['2026-11-22'],
  notes: { '2026-11-18': 'Steady, not heroic.' },
  daily: { '2026-11-19': { action: 'rest', reason: 'Legs need a day.' } },
};
const rideAt = (d, x) => ({ id: `${d.toLocaleDateString('en-CA')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`, start: d.toISOString(), ftp: 250, ...x });
const VO2 = rideAt(new Date(2026, 10, 17, 18, 30), { name: 'VO2max 30/15 x 3 sets', workoutId: 'vo2-30-15', tags: ['vo2'], durSec: 3300, np: 210, avgP: 180, if: 0.84, kj: 600, tss: 72, avgHr: 150, maxHr: 178, compliance: { avg: 97, min: 93, reps: 30 } });
// older history: ERG rides with intervals, Zone 2 rides with drift, one HR-only import (six weeks, every third day)
const OLDER = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(2026, 10, 15 - i * 3, 18, 0), hrOnly = i === 5, z2 = i % 2 === 1;
  return rideAt(d, {
    name: `Ride ${i + 1}`, tags: hrOnly ? ['imported', 'outdoor'] : [], durSec: 3600 + i * 60, np: hrOnly ? null : 190 + i, if: hrOnly ? null : 0.76, tss: 55 + i * 2, ...(hrOnly ? { tssFrom: 'hr' } : {}), avgHr: 138 + i,
    bests: hrOnly ? {} : { 5: 700 - i * 5, 15: 600, 30: 480, 60: 380, 180: 310, 300: 290, 600: 270, 1200: 255 - i, 3600: 200 },
    zones: hrOnly ? undefined : [300, z2 ? 2700 : 1500, 400, z2 ? 200 : 900, z2 ? 0 : 400, 0, 0],
    compliance: z2 || hrOnly ? null : { avg: 99, min: 96 - (i % 3), reps: 4 }, decoupling: z2 ? 3.1 : null,
  });
});
const FREE = rideAt(new Date(2026, 10, 18, 7, 15), { name: 'Free ride', tags: [], durSec: 1200, np: 150, avgP: 140, if: 0.6, tss: 15, avgHr: 120 });
const WHOOP = { '2026-11-17': { recovery: 70 }, '2026-11-18': { recovery: 25 }, '2026-11-19': { recovery: 55 } };
const MINE = { version: 1, deleted: {}, workouts: [
  { id: 'mine-v-tempo', name: 'My tempo', description: 'Built in the app.', tags: [], updatedAt: '2026-11-01T10:00:00Z', steps: [{ dur: 300, power: 0.5 }, { dur: 600, power: 0.88 }, { dur: 300, power: 0.5 }] },
  { id: 'mine-v-hills', name: 'My hills', description: 'Slope, built in the app.', tags: [], updatedAt: '2026-11-10T10:00:00Z', steps: [{ dur: 300, grade: 0 }, { dur: 600, grade: 5 }] },
] };
// the VO2 ride's synced document (rides/2026/<id>.json), recorded the way Session does
function rideDoc() {
  const wo = JSON.parse(fs.readFileSync(path.join(root, 'workouts/vo2-30-15.json'), 'utf8'));
  const segs = flatten(wo), ftp = 250, t0 = Date.parse(VO2.start), samples = [];
  for (let wt = 0; wt < segs.at(-1).end; wt++) {
    const si = segs.findIndex((s) => wt < s.end), seg = segs[si];
    const target = Math.round((seg.from + (seg.to - seg.from) * ((wt - seg.start) / seg.dur)) * ftp);
    const wob = Math.round(Math.sin(wt / 7) * 6);
    samples.push({ t: t0 + wt * 1000, wt, si, st: wt - seg.start, power: target + wob, target, hr: 120 + Math.round(40 * Math.min(1, wt / 1500)) + (seg.from > 1 ? 12 : 0), cadence: seg.from > 1 ? 98 : 86, speed: 8, distance: wt * 8, grade: 0 });
  }
  const doc = buildRide(samples, { name: wo.name, workoutId: wo.id, tags: wo.tags, ftp, startMs: t0, segs });
  doc.summary.id = VO2.id;
  return doc;
}
const GH = { 'index.json': { rides: [VO2, ...OLDER] }, 'whoop/daily.json': { days: WHOOP }, 'workouts/mine.json': MINE, [`rides/2026/${VO2.id}.json`]: rideDoc() };

// before any page script: theme, sign-in, the cached copies of rodillo-data (so the first draw has them), and a
// seeded Math.random (mulberry32) so the demo trainer's noise and the launch puffs are the same every run
function seed([theme, gh, signedOut]) {
  let a = 0x5eed;
  Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  if (sessionStorage.getItem('visual.seeded')) return; // once per context: the app's own writes stand after that
  sessionStorage.setItem('visual.seeded', '1');
  localStorage.setItem('rodillo.theme', JSON.stringify(theme));
  if (signedOut) return;
  localStorage.setItem('rodillo.sync', JSON.stringify({ token: 'visual-token' }));
  localStorage.setItem('rodillo.remoteIndex', JSON.stringify(gh['index.json'].rides));
  localStorage.setItem('rodillo.whoop', JSON.stringify(gh['whoop/daily.json'].days));
}

async function context(look, { index = GH['index.json'].rides, clock = 'fixed', at = NOW, signedOut = false } = {}) {
  const phone = look.w === 390;
  const ctx = await browser.newContext({ viewport: { width: look.w, height: phone ? 844 : 800 }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, timezoneId: 'America/Chicago', locale: 'en-US' });
  const gh = { ...GH, 'index.json': { rides: index } };
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route((url) => url.pathname.endsWith('/plans/current.json'), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAN) }));
  await ctx.route((url) => url.href.startsWith(`https://api.github.com/repos/${DEFAULT_REPO}/contents/`), (r) => {
    const f = gh[decodeURIComponent(new URL(r.request().url()).pathname.split('/contents/')[1])];
    return f === undefined ? r.fulfill({ status: 404, body: '' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'visual', content: Buffer.from(JSON.stringify(f)).toString('base64') }) });
  });
  await ctx.addInitScript(seed, [look.theme, gh, signedOut]);
  if (clock === 'paused') await ctx.clock.install({ time: at });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${look.w} ${look.theme}: ${e.message}`));
  if (clock === 'fixed') await page.clock.setFixedTime(at);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#today .hero') && document.querySelectorAll('#workout-list .wo').length, null, { timeout: 8000 });
  return { ctx, page, phone };
}

const settle = async (page, ms = 700) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
};
const errors = [];
let shots = 0;
const SETTLE = +(process.env.VISUAL_SETTLE || 700); // ms after the last action: panels that slid in need their layer settled
fs.mkdirSync(outDir, { recursive: true });
if (!compareOnly) for (const f of fs.readdirSync(outDir)) if (!only.length || only.some((o) => f.split('--')[0].includes(o))) fs.rmSync(path.join(outDir, f)); // .png and .styles.json // --only replaces just those scenes
async function shot(page, name, look, { full = false, hover = false } = {}) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  if (!look.phone && !hover) await page.mouse.move(1, 1); // nothing under the pointer: no hover states
  await settle(page, SETTLE);
  await page.screenshot({ path: path.join(outDir, `${name}--${look.w}-${look.theme}.png`), fullPage: full, animations: 'disabled', caret: 'hide' });
  await styles(page, `${name}--${look.w}-${look.theme}`);
  shots++;
}
/** Computed style of every element (and its ::before / ::after when they have content), in document order: catches what a
 *  screenshot can't see (below a panel's fold, hidden states, a property that happens to draw the same). Elements with a
 *  running animation are marked "anim" (their values move). The server's port and auto-numbered SVG ids are normalized
 *  (they change from run to run); stored gzipped, so a difference names the property. */
async function styles(page, file) {
  const dump = await page.evaluate(() => {
    const norm = (v) => v.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '').replace(/#([a-z-]+?)\d+\b/gi, '#$1N');
    const text = (cs, pre = '') => { let s = ''; for (let k = 0; k < cs.length; k++) s += `${pre}${cs[k]}:${cs.getPropertyValue(cs[k])};`; return s; };
    // inside an <svg> (chart bars, gradients: half the elements) only what CSS here sets on SVG shapes
    const SVG = ['display', 'visibility', 'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
      'transform', 'transform-origin', 'filter', 'color', 'font-family', 'font-size', 'font-weight', 'font-stretch', 'stop-color', 'stop-opacity', 'vector-effect', 'pointer-events', 'cursor', 'animation-name'];
    const svgText = (cs) => SVG.map((k) => `${k}:${cs.getPropertyValue(k)};`).join('');
    const uniq = new Map(); // most rows, bars and labels share their computed style: send each text once
    const ref = (t) => { if (!uniq.has(t)) uniq.set(t, uniq.size); return uniq.get(t); };
    const rows = [...document.querySelectorAll('body *')].map((el, i) => {
      const id = norm(`${i} ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).filter((c) => c !== 'ink-ready').join('.') : ''}`);
      const shown = el.getClientRects().length ? 1 : 0;
      if (el.getAnimations().some((a) => a.playState === 'running')) return [id, 'anim', shown];
      if (el.ownerSVGElement) return [id, ref(norm(svgText(getComputedStyle(el)))), shown];
      let s = text(getComputedStyle(el));
      for (const p of ['::before', '::after']) { const c = getComputedStyle(el, p); if (c.content !== 'none' && c.content !== 'normal') s += text(c, p.slice(2) + '.'); }
      return [id, ref(norm(s)), shown];
    });
    return { texts: [...uniq.keys()], rows };
  });
  fs.writeFileSync(path.join(outDir, `${file}.styles.json.gz`), zlib.gzipSync(JSON.stringify(dump)));
}
const want = (...names) => !only.length || names.some((n) => only.some((o) => n.includes(o) || o.startsWith(n))); // a scene group runs when --only names it or one of its scenes
const tab = async (page, t) => { await page.click(`#tabs button[data-tab="${t}"]`); await settle(page, 400); };
const rowOf = (page, list, name) => page.$$eval(`${list} .wo`, (rows, n) => rows.find((r) => r.querySelector('.wo-name').childNodes[0].textContent.trim() === n)?.dataset.i, name);

// ---------------------------------------------------------------- scenes
async function homeScenes(look) {
  const { ctx, page } = await context(look);
  look.phone = look.w === 390;
  await shot(page, 'home-today', look, { full: true });
  await tab(page, 'workouts');
  await shot(page, 'home-workouts-erg', look, { full: true });
  const ss = await rowOf(page, '#workout-list', 'Sweet spot 3 x 12');
  await page.click(`#workout-list .wo[data-i="${ss}"] .wo-name`);
  await shot(page, 'home-workouts-open', look, { full: true });
  await page.click('#wo-kind button[data-kind="slope"]');
  await shot(page, 'home-workouts-slope', look, { full: true });
  const climb = await rowOf(page, '#slope-list', JSON.parse(fs.readFileSync(path.join(root, 'workouts/climb-el-durazno.json'), 'utf8')).name);
  if (climb !== undefined) { await page.click(`#slope-list .wo[data-i="${climb}"] .wo-name`); await shot(page, 'home-workouts-climb-open', look, { full: true }); }
  await page.click('#wo-kind button[data-kind="mine"]');
  await shot(page, 'home-workouts-mine', look, { full: true });
  await page.click('#wo-kind button[data-kind="erg"]');
  await tab(page, 'calendar');
  await shot(page, 'home-calendar', look, { full: true });
  await tab(page, 'training');
  await shot(page, 'home-training', look, { full: true });
  // a row opens the ride page (the synced document from rodillo-data)
  if (want('ridepage')) {
    await page.click(look.phone ? `#ride-table .rl[data-ride="${VO2.id}"] .rl-name` : `#ride-table tr[data-ride="${VO2.id}"] td`);
    await page.waitForSelector('#rd .rd-nav', { timeout: 5000 });
    await page.waitForFunction(() => !/Loading/.test(document.querySelector('#rd').textContent), null, { timeout: 5000 });
    await shot(page, 'ridepage', look, { full: true });
    await page.click('#rd [data-rd="back"]');
  }
  await tab(page, 'today');
  if (!look.phone && want('hover-')) { // hover states (desktop only): a Next days card, the hero's Free ride, a library row, a calendar day
    const hov = async (sel, n) => { await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' })); await page.hover(sel); await shot(page, n, look, { hover: true }); };
    await hov('#week-strip .day:nth-child(3)', 'hover-day');
    await hov('#btn-free', 'hover-hero-free');
    await tab(page, 'workouts');
    await hov(`#workout-list .wo[data-i="${ss}"] .wo-name`, 'hover-wo');
    await tab(page, 'calendar');
    await hov('.cal-cell:nth-child(12)', 'hover-cal-cell');
    await tab(page, 'today');
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // panels, from the top bar on Today
  if (want('panel-settings')) {
    await page.click('#btn-settings');
    for (const t of ['rider', 'ride', 'road', 'trainer', 'sync']) {
      await page.click(`#set-tabs [data-stab="${t}"]`);
      await shot(page, `panel-settings-${t}`, look);
    }
    await page.click('#set-tabs [data-stab="rider"]');
    if (want('focus-settings')) { await page.focus('#settings-form input'); await shot(page, 'focus-settings-input', look); await page.evaluate(() => document.activeElement.blur()); }
    await page.click('#settings [data-close]');
  }
  if (want('panel-garage')) {
    await page.click('#btn-garage');
    await shot(page, 'panel-garage-bikes', look);
    await page.click('#gar-tabs [data-gtab="gearing"]');
    await shot(page, 'panel-garage-gearing', look);
    await page.click('#gar-tabs [data-gtab="bikes"]');
    await page.click('#garage [data-close]');
  }
  if (want('panel-controls')) {
    await page.click('#btn-controls');
    await shot(page, 'panel-controls', look);
    await page.click('#controls [data-close]');
  }
  if (want('panel-connections', 'panel-log')) {
    await page.click('#btn-devices');
    await shot(page, 'panel-connections', look);
    await page.click('#btn-log');
    await shot(page, 'panel-log', look);
    await page.click('#log [data-close]');
    await page.click('#btn-devices').catch(() => {});
    await page.click('#devpop-close').catch(() => {});
  }
  if (want('builder')) {
    await tab(page, 'workouts');
    await page.click('#wo-kind button[data-kind="mine"]');
    await page.click('#btn-new-wo');
    await shot(page, 'builder-new', look);
    await page.click('#b-close');
    await settle(page, 300);
    if (await page.isVisible('#modal')) await page.click('#modal-ok');
    await page.click('#wo-kind button[data-kind="erg"]');
    await page.click(`#workout-list .wo[data-i="${ss}"] .wo-name`).catch(() => {});
    await settle(page, 400);
    const copy = await page.$(`#workout-list .wo[data-i="${ss}"] [data-copy]`);
    if (copy) { await copy.click(); await shot(page, 'builder-copy', look); }
  }
  await ctx.close();
}

// Today on the day after a ride (done hero) and on a coach rest day
async function todayStates(look) {
  if (!want('home-today-done', 'home-today-rest', 'home-today-free', 'home-signedout')) return;
  for (const [name, at, index] of [['home-today-done', DAY_AT.done, [VO2, ...OLDER]], ['home-today-rest', DAY_AT.rest, [VO2, ...OLDER]], ['home-today-free', NOW, [FREE, VO2, ...OLDER]]]) {
    const { ctx, page } = await context(look, { at, index });
    await shot(page, name, look, { full: true });
    await ctx.close();
  }
  if (want('home-signedout')) { // public plan, no history: the locked Training tab, no Mine
    const { ctx, page } = await context(look, { signedOut: true });
    await shot(page, 'home-signedout-today', look, { full: true });
    await tab(page, 'training');
    await shot(page, 'home-signedout-training', look, { full: true });
    await ctx.close();
  }
}

// the ride screen on demo rides, clock paused and moved only by runFor() (like the smoke test's desktop ride run)
async function rideScenes(look) {
  if (!want('ride-')) return;
  const ride = async (kind, name, secs) => {
    const { ctx, page } = await context(look, { clock: 'paused', at: new Date(2026, 10, 18, 18, 0) });
    const run = (ms) => page.clock.runFor(ms);
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.click('#btn-devices'); await page.click('#btn-demo'); await page.keyboard.press('Escape');
    await page.click('#tabs button[data-tab="workouts"]');
    await page.click(`#wo-kind button[data-kind="${kind}"]`);
    const list = kind === 'erg' ? '#workout-list' : '#slope-list';
    const i = await rowOf(page, list, name);
    await page.click(`${list} .wo[data-i="${i}"] .wo-name`);
    await run(800);
    await page.click(`${list} button[data-start="${i}"]`);
    for (let k = 0; k < 60 && !(await page.evaluate(() => document.querySelector('#ride.active') && window.rodillo.session?.started && !window.rodillo.launching)); k++) { await run(250); await page.waitForTimeout(40); }
    await run(secs * 1000);
    return { ctx, page, run };
  };
  const shotRide = async (page, run, n) => { await run(500); if (only.length && !only.some((o) => n.includes(o))) return; await page.mouse.move(1, 1).catch(() => {}); await page.screenshot({ path: path.join(outDir, `${n}--${look.w}-${look.theme}.png`), animations: 'disabled', caret: 'hide' }); await styles(page, `${n}--${look.w}-${look.theme}`); shots++; };
  if (want('ride-erg', 'ride-paused')) {
    const { ctx, page, run } = await ride('erg', 'Sweet spot 3 x 12', 400);
    await shotRide(page, run, 'ride-erg'); // always run its tick: the pause screens are timed after it
    if (want('ride-paused')) {
      await page.keyboard.press(' '); await run(1500); await shotRide(page, run, 'ride-paused');
      // the pause screen's panels keep the ride look (the premium look is home only)
      const open = async (btn, n, close) => { await page.click(btn); await run(800); await shotRide(page, run, n); if (close) { await page.click(close); await run(800); } };
      await open('#pz-devices', 'ride-paused-connections');
      await open('#btn-log', 'ride-paused-log', '#log [data-close]');
      if (await page.isVisible('#devpop')) { await page.click('#devpop-close'); await run(800); }
      await open('#pz-controls', 'ride-paused-controls', '#controls [data-close]');
      await open('#pz-bike', 'ride-paused-garage-bikes');
      await page.click('#gar-tabs [data-gtab="gearing"]'); await run(800);
      await shotRide(page, run, 'ride-paused-garage-gearing');
      await page.click('#gar-tabs [data-gtab="bikes"]'); await page.click('#garage [data-close]'); await run(800);
      await open('#pz-settings', 'ride-paused-settings-rider');
      for (const t of ['trainer', 'sync']) { await page.click(`#set-tabs [data-stab="${t}"]`); await run(800); await shotRide(page, run, `ride-paused-settings-${t}`); }
      await page.click('#set-tabs [data-stab="rider"]'); await page.click('#settings [data-close]'); await run(800);
    }
    await ctx.close();
  }
  if (want('ride-slope')) {
    const { ctx, page, run } = await ride('slope', 'Climb repeats 4 x 6 min at 6%', 400);
    await shotRide(page, run, 'ride-slope');
    await ctx.close();
  }
}

// ---------------------------------------------------------------- capture, then compare
const LOOKS = [{ w: 1280, theme: 'light' }, { w: 1280, theme: 'dark' }, { w: 390, theme: 'light' }, { w: 390, theme: 'dark' }];
try {
  if (compareOnly) { await compare(); process.exit(process.exitCode || 0); }
  for (const look of LOOKS) {
    look.phone = look.w === 390;
    await homeScenes(look);
    await todayStates(look);
    await rideScenes(look);
    console.log(`captured ${look.w} ${look.theme}`);
  }
  console.log(`${shots} screenshots in ${path.relative(root, outDir)}`);
  if (errors.length) { console.error('Errors in the page:\n' + errors.join('\n')); process.exitCode = 1; }
  if (!baselineRun) await compare();
} finally {
  await browser.close();
  server.close();
}

async function compare() {
  if (!fs.existsSync(baseDir)) { console.log('no .visual/baseline yet: run npm run visual -- --baseline on the commit to compare against'); return; }
  fs.rmSync(diffDir, { recursive: true, force: true });
  const cur = fs.readdirSync(outDir).filter((f) => f.endsWith('.png') && (!only.length || only.some((o) => f.split('--')[0].includes(o)))).sort();
  const old = fs.readdirSync(baseDir).filter((f) => f.endsWith('.png') && (!only.length || only.some((o) => f.split('--')[0].includes(o))));
  const missing = old.filter((f) => !cur.includes(f)), added = cur.filter((f) => !old.includes(f));
  const page = await browser.newPage();
  const bad = [];
  for (const f of cur.filter((x) => old.includes(x))) {
    const a = fs.readFileSync(path.join(baseDir, f)), b = fs.readFileSync(path.join(outDir, f));
    if (a.equals(b)) continue; // same PNG bytes: same pixels
    const r = await page.evaluate(async ([x, y]) => {
      const img = async (b64) => { const i = new Image(); i.src = `data:image/png;base64,${b64}`; await i.decode(); return i; };
      const [ia, ib] = [await img(x), await img(y)];
      if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} -> ${ib.width}x${ib.height}` };
      const cv = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return [c, g.getImageData(0, 0, i.width, i.height)]; };
      const [ca, da] = cv(ia), [, db] = cv(ib);
      let n = 0, max = 0;
      const out = new ImageData(ia.width, ia.height);
      for (let p = 0; p < da.data.length; p += 4) {
        const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(da.data[p + k] - db.data[p + k])));
        if (d) { n++; max = Math.max(max, d); out.data.set([255, 0, 0, 255], p); } else out.data.set([da.data[p], da.data[p + 1], da.data[p + 2], 50], p);
      }
      if (!n) return { n };
      ca.getContext('2d').putImageData(out, 0, 0);
      return { n, max, png: ca.toDataURL('image/png').split(',')[1] };
    }, [a.toString('base64'), b.toString('base64')]);
    if (!r.n && !r.size) continue;
    bad.push(`${f}: ${r.size || `${r.n} pixels differ (largest channel difference ${r.max})`}`);
    if (r.png) { fs.mkdirSync(diffDir, { recursive: true }); fs.writeFileSync(path.join(diffDir, f), Buffer.from(r.png, 'base64')); }
  }
  const summary = new Map(), hiddenOnly = [];
  const readStyles = (d, f) => {
    const p = path.join(d, f.replace(/\.png$/, '.styles.json.gz'));
    if (!fs.existsSync(p)) return null;
    const { texts, rows } = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
    // Chrome lists custom properties in no fixed order: compare the declarations sorted
    // custom properties are left out: whatever a token changes shows up in the real properties that use it
    const sorted = texts.map((t) => t.replace(/;$/, '').split(/;(?=[\w.-]+:)/).filter((d) => d && !/^(before\.|after\.)?--/.test(d)).sort().join(';'));
    return rows.map(([id, t, shown]) => [id, t === 'anim' ? t : sorted[t], shown]);
  };
  // a chart can draw a few more or fewer SVG shapes run to run without a visible change; compare the rest then
  const SVG_TAGS = /^\d+ (svg|g|path|line|polyline|polygon|rect|circle|ellipse|text|tspan|defs|lineargradient|radialgradient|stop|pattern|clippath|mask|use|title)\b/;
  const outsideSvg = (rows) => rows.filter((r) => !SVG_TAGS.test(r[0])).map((r, i) => [r[0].replace(/^\d+/, i), r[1], r[2]]);
  const props = (t) => Object.fromEntries(t.split(/;(?=[\w.-]+:)/).filter(Boolean).map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]));
  for (const f of cur.filter((x) => old.includes(x))) {
    let [a, b] = [readStyles(baseDir, f), readStyles(outDir, f)];
    if (!a || !b) continue;
    const sf = f.replace(/\.png$/, '');
    if (a.length !== b.length || a.some((r, i) => r[0] !== b[i][0])) [a, b] = [outsideSvg(a), outsideSvg(b)];
    if (a.length !== b.length || a.some((r, i) => r[0] !== b[i][0])) { const i = a.findIndex((r, k) => r[0] !== b[k]?.[0]); bad.push(`${sf}: the DOM differs (${a.length} -> ${b.length} elements; first at ${a[i]?.[0]} / ${b[i]?.[0]})`); continue; }
    const diff = a.map((r, i) => [r, b[i]]).filter(([r, q]) => r[1] !== 'anim' && q[1] !== 'anim' && r[1] !== q[1]);
    if (!diff.length) continue;
    const what = diff.slice(0, 4).map(([r, q]) => {
      const [pa, pb] = [props(r[1]), props(q[1])];
      const ks = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => pa[k] !== pb[k]);
      return `${r[0].replace(/^\d+ /, '')}${r[2] ? '' : ' (unrendered)'} ${ks.slice(0, 3).map((k) => `${k}: ${pa[k]} -> ${pb[k]}`).join('; ')}`;
    });
    const shown = diff.filter(([r, q]) => r[2] || q[2]);
    for (const [r, q] of diff) {
      const [pa, pb] = [props(r[1]), props(q[1])];
      for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((x) => pa[x] !== pb[x])) {
        const key = `${r[2] || q[2] ? 'rendered  ' : 'unrendered'} ${r[0].replace(/^\d+ /, '')} { ${k}: ${pa[k]} -> ${pb[k]} }`;
        summary.set(key, [...(summary.get(key) || []), sf]);
      }
    }
    if (!shown.length && !process.env.VISUAL_STRICT) { hiddenOnly.push(`${sf} (${diff.length})`); continue; }
    bad.push(`${sf}: computed style differs on ${shown.length} rendered, ${diff.length - shown.length} unrendered elements\n      ${what.join('\n      ')}`);
  }
  if (summary.size) fs.writeFileSync(path.join(root, '.visual', 'styles-diff.txt'), [...summary].sort().map(([k, v]) => `${k}   [${v.length} shots: ${v.slice(0, 3).join(', ')}${v.length > 3 ? ', ...' : ''}]`).join('\n') + '\n');
  if (hiddenOnly.length) console.log(`visual: computed style differs only on unrendered elements in ${hiddenOnly.length} shots (not a failure; VISUAL_STRICT=1 makes it one): ${hiddenOnly.slice(0, 8).join(', ')}${hiddenOnly.length > 8 ? ', ...' : ''}`);
  if (summary.size) console.log(`visual: every style difference, grouped: .visual/styles-diff.txt (${summary.size} lines)`);
  for (const f of missing) bad.push(`${f}: in the baseline, not captured now`);
  for (const f of added) bad.push(`${f}: captured now, not in the baseline`);
  if (bad.length) { console.error(`visual: ${bad.length} of ${cur.length} differ from the baseline\n  ${bad.join('\n  ')}`); process.exitCode = 1; }
  else console.log(`visual: all ${cur.length} screenshots pixel-identical to the baseline`);
}
