// Browser smoke test: the whole app in Chrome, demo trainer, no Bluetooth or network.
// Opens every home screen and panel (Today and Calendar also on a seeded week with a fixed clock), rides a demo workout (start, skip, end), opens the ride page,
// drives home and a ride with a fake Zwift Ride (both hoods, real button bytes) and the keyboard, checks the desktop ride
// screen on demo rides with a paused clock (ERG, slope, real climb, free ride, workout messages, the ramp test takeover)
// and the phone ride screen the same way (hero, power gauge, chart and list view, the ··· sheet and its holds),
// and fails on any uncaught error or console error. Covers js/app.js, which the unit tests don't load.
// Needs Chrome: CHROME_PATH, or /usr/bin/google-chrome (GitHub's ubuntu-latest has it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadSeries, loadNow, buildRide } from '../js/stats.js';
import { flatten, mainSet, totalDuration, track, trackDist, trackClimbed, ftpWatts, segTarget, climbsByDist } from '../js/engine/workout.js';
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
// Signed in with a pasted token; the GitHub contents API answers from `files` (path -> JSON, change it to change the
// answers), every other GitHub call gets 404. Register after the catch-all 404 route (the newest route wins).
const TOKEN = JSON.stringify({ token: 'smoke-token' });
async function mockGitHub(ctx, files) {
  await ctx.route((url) => url.href.startsWith(`https://api.github.com/repos/${DEFAULT_REPO}/contents/`), (r) => {
    const f = files[decodeURIComponent(new URL(r.request().url()).pathname.split('/contents/')[1])];
    return f === undefined ? r.fulfill({ status: 404, body: '' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'smoke', content: Buffer.from(JSON.stringify(f)).toString('base64') }) });
  });
}
const rowSel = async (page, list, name) => {
  const i = (await listOf(page, list)).flatMap((s) => s.rows).find((r) => r.name === name)?.i;
  if (i === undefined) throw new Error(`library: no row "${name}" in ${list}`);
  return `${list} .wo[data-i="${i}"]`;
};
/** Point at stretch k of an open row's big chart (mouse on desktop, a tap on the phone) and return the readout. */
async function readout(page, row, k, phone) {
  const { lbl, tgt, time, on } = await profReadout(page, `${row} .wo-prof`, k, phone);
  if (on !== String(k)) throw new Error(`library: readout highlights stretches ${on} instead of ${k}`);
  return { lbl, tgt, time };
}

// ---- workout profile readouts (bindProfileHover: Today's hero, a Calendar day, an open library row)
const fmtDistM = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const isTrackSegs = (segs) => segs.length > 0 && segs.every((g) => g.kind === 'sim');
/**
 * Point at stretch k of a profile chart (`box` = its .prof-hover element; mouse on desktop, a tap on the phone, `top`:
 * near the top of the chart instead of inside the filled area) and return what shows: the readout's three lines, the
 * highlighted stretches, and whether the readout sits inside the chart.
 */
async function profReadout(page, box, k, phone, { top = false } = {}) {
  await page.$eval(box, (el) => el.scrollIntoView({ block: 'center' })); // clear of the phone's nav pill
  const b = await page.locator(`${box} svg [data-i="${k}"]`).boundingBox(), c = await page.locator(`${box} svg`).boundingBox();
  const x = b.x + b.width / 2, y = top ? c.y + 2 : b.y + b.height * 0.75;
  if (phone) await page.touchscreen.tap(x, y); else await page.mouse.move(x, y);
  await page.waitForFunction((s) => document.querySelector(`${s}.hov`), box, { timeout: 3000 });
  return page.$eval(box, (el) => {
    const t = el.querySelector('.prof-tip'), tr = t.getBoundingClientRect(), br = el.getBoundingClientRect();
    return {
      ...Object.fromEntries(['lbl', 'tgt', 'time'].map((n) => [n, t.querySelector(`.pt-${n}`).textContent.replace(/\s+/g, ' ').trim()])),
      on: [...el.querySelectorAll('svg .on')].map((e) => e.dataset.i).join(), inside: tr.left >= br.left - 0.5 && tr.right <= br.right + 0.5,
    };
  });
}
/** What the readout over stretch k of `segs` (flattened at `ftp`) should say, worked out here, not by the app. */
function wantReadout(segs, k, ftp) {
  const g = segs[k], tr = isTrackSegs(segs) ? track(segs) : null;
  const a = Math.round(g.from * ftp), b = Math.round(g.to * ftp), pc = (f) => Math.round(f * 100);
  const tgt = g.kind === 'sim' ? (g.free ? 'Free ride' : `${+(g.grade * 100).toFixed(1)}% grade`) : `${a === b ? a : `${a}-${b}`} W ${g.from === g.to ? pc(g.from) : `${pc(g.from)}-${pc(g.to)}`}% FTP`;
  const m = tr ? Math.round(tr.parts[k].h1 - tr.parts[k].h0) : 0, rise = m ? ` ${m > 0 ? '+' : '−'}${Math.abs(m)} m` : '';
  return {
    lbl: `${g.label}${g.rep ? ` · ${g.rep.i} of ${g.rep.of}` : ''}`, tgt: tgt + rise,
    time: `${g.dist ? `${fmtDistM(g.dist)} (~${fmtTime(g.dur)})` : fmtTime(g.dur)}${g.cadence !== '' ? ` · ${g.cadence} rpm` : ''}${fmtTime(g.start)} to ${fmtTime(g.end)}`,
    on: String(k), inside: true,
  };
}
/** The readout over stretch k matches wantReadout(); the chart is the workout `w` at `ftp`. */
async function checkReadout(page, box, w, k, ftp, phone, fail, what) {
  const got = await profReadout(page, box, k, phone), want = wantReadout(flatten(w, ftp), k, ftp);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what} readout ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
/**
 * How the readout comes and goes. Mouse: only over the filled area (not the empty space above a low stretch), gone
 * when the pointer leaves the chart. Finger: anywhere in a stretch's column counts, and the readout stays after the
 * finger lifts, until a tap elsewhere (`elsewhere` = a selector outside the chart).
 */
async function checkReadoutComesAndGoes(page, box, k, phone, elsewhere, fail, what) {
  const hov = () => page.$eval(box, (el) => el.classList.contains('hov'));
  if (phone) {
    const r = await profReadout(page, box, k, phone, { top: true });
    if (r.on !== String(k)) fail(`${what}: a tap high in stretch ${k}'s column shows ${r.on}`);
    await page.waitForTimeout(400);
    if (!(await hov())) fail(`${what}: the readout went when the finger lifted`);
    await page.locator(elsewhere).scrollIntoViewIfNeeded();
    const e = await page.locator(elsewhere).boundingBox();
    await page.touchscreen.tap(e.x + e.width / 2, e.y + e.height / 2);
    await page.waitForTimeout(200);
    if (await hov() || await page.$eval(box, (el) => el.querySelectorAll('svg .on').length)) fail(`${what}: a tap elsewhere left the readout up`);
    return;
  }
  await profReadout(page, box, k, phone);
  const c = await page.locator(`${box} svg`).boundingBox();
  const b = await page.locator(`${box} svg [data-i="${k}"]`).boundingBox();
  await page.mouse.move(b.x + b.width / 2, c.y + 1); // above the curve, still in the chart
  await page.waitForTimeout(100);
  if (await hov() || await page.$eval(box, (el) => el.querySelectorAll('svg .on').length)) fail(`${what}: the mouse above the curve keeps the readout`);
  await profReadout(page, box, k, phone);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  if (await hov()) fail(`${what}: the readout stays after the mouse leaves`);
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
  await checkReadout(page, `${ss} .wo-prof`, SS, 0, ftp, phone, fail, 'open row stretch 0');
  await checkReadoutComesAndGoes(page, `${ss} .wo-prof`, 0, phone, '#wo-kind button.on', fail, 'open row');
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
/** Builder (new ERG workout: warm-up, 20 min at 75%, cool-down): type into each field of the steady block, then a repeat. */
async function builderFields(page, fail) {
  const ftp = DEFAULT_SETTINGS.ftp;
  await page.click('#b-tl .tl-b[data-p="1"]');
  await page.waitForSelector('#b-steps [data-f="pct"][data-fp="1"]', { timeout: 3000 });
  const info = () => page.textContent('#b-meta .b-selinfo');
  const readout = (p = '1') => page.textContent(`#b-steps [data-w="${p}"]`);
  /** Types v into field f of block p; bad = should it turn red; then info() / readout() are checked by the caller. */
  const put = async (f, v, bad, p = '1') => {
    const sel = `#b-steps [data-f="${f}"][data-fp="${p}"]`;
    await page.fill(sel, v);
    if ((await page.$eval(sel, (el) => el.classList.contains('bad'))) !== bad) fail(`builder ${f} "${v}": ${bad ? 'not' : ''} red`);
  };
  // the builder redraws on input: read until it shows the value (up to 2 s)
  const want = async (what, get, exp) => {
    let got;
    for (let t = 0; t < 20 && (got = await get()) !== exp; t++) await page.waitForTimeout(100);
    if (got !== exp) fail(`builder ${what}: "${got}", want "${exp}"`);
  };
  await want('start', info, `20:00 at 75% (${Math.round(0.75 * ftp)} W)`);
  await put('pct', '90', false); await want('pct 90', readout, `${Math.round(0.9 * ftp)} W`);
  await put('pct', '400', true); await want('pct 400 ignored', info, `20:00 at 90% (${Math.round(0.9 * ftp)} W)`);
  await put('pct', '85,5', false); await want('pct 85,5', readout, `${Math.round(0.855 * ftp)} W`);
  await put('len', '25:00', false); await put('len', '3s', true); await put('len', '7:00:00', true); await put('len', '1:75', true);
  await want('len', info, `25:00 at 86% (${Math.round(0.855 * ftp)} W)`);
  await put('cadence', '', false); await put('cadence', 'fast', true); await put('cadence', '80 - 90', false);
  await put('label', 'Tempo', false); await put('text', '  Smooth  ', false);
  await put('messages', '0:30 Settle in\nlast -0:20 Last one', false); await put('messages', '0:30', true);
  await page.selectOption('#b-steps [data-f="type"][data-fp="1"]', 'ramp'); // redraws the block's fields from what was stored
  const val = (f) => page.inputValue(`#b-steps [data-f="${f}"][data-fp="1"]`);
  await want('cadence stored', () => val('cadence'), '80-90');
  await want('name stored', () => val('label'), 'Tempo');
  await want('cue stored', () => val('text'), '  Smooth  ');
  await want('messages stored', () => val('messages'), '0:30 Settle in\nlast -0:20 Last one');
  await put('from', '50', false); await put('to', '80', false); await put('to', '0', true);
  await want('ramp', readout, `${Math.round(0.5 * ftp)}-${Math.round(0.8 * ftp)} W`);
  await page.selectOption('#b-steps [data-f="type"][data-fp="1"]', 'watts');
  await put('watts', '251.4', false); await want('watts', readout, `${Math.round((251 / ftp) * 100)}% FTP`); await put('watts', '5', true);
  await page.selectOption('#b-steps [data-f="type"][data-fp="1"]', 'grade');
  await put('grade', '4.5', false); await put('grade', '30', true);
  await want('grade', info, '25:00 at 4.5%');
  await page.focus('#builder [data-tile="intervals"]');
  await page.keyboard.press('Enter'); // keyboard add: after the selected block, selected
  await page.waitForSelector('#b-steps [data-f="repeat"][data-fp="2"]', { timeout: 3000 });
  await put('repeat', '2.5', true, '2'); await put('repeat', '6', false, '2');
  await want('repeat', () => page.textContent('#b-steps [data-sum="2"]'), '= 48:00');
  await page.fill('#b-name', 'Smoke fields');
  await page.fill('#b-desc', 'Typed in the smoke test');
}

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

  // builder field edits: every field takes a good value (the block, its readout and the timeline follow) and turns red
  // on a bad one, leaving the block as it was
  await page.click('#btn-new-wo');
  await page.waitForSelector('#builder:not(.hidden)', { timeout: 3000 });
  // a new workout focuses its name field 60 ms after opening: typed before that, a field's text could land in the name
  // (the Nov 25 "builder pct 90: 150 W" failures, about 1 run in 10)
  await page.waitForFunction(() => document.activeElement?.id === 'b-name', null, { timeout: 3000 });
  await builderFields(page, fail);
  await page.click('#b-close');
  await page.waitForTimeout(300);
  if (await page.isVisible('#modal')) await page.click('#modal-ok');
  await page.waitForSelector('#builder.hidden', { state: 'attached', timeout: 3000 });
  ok('desktop: builder fields: good values applied, bad ones red and ignored (length, %, ramp, watts, grade, repeat, cadence, name, cue, messages)');

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
  await page.waitForFunction(() => /Signed out: your plan and history are private/.test(document.querySelector('#today .plan-src')?.textContent || ''), null, { timeout: 3000 })
    .catch(() => fail('Today\'s hero not refreshed after sync was turned off'));
  if (!(await page.isHidden('#builder')) || !(await page.isHidden('#kind-btn-mine')) || await page.locator('#mine-list .wo').count() || (await lsGet(page, 'sync')).token) fail('sync off: builder still open, Mine still offered or the token kept');
  ok('desktop: Settings > Sync, token cleared: builder closed, Mine hidden, Today signed out');

  // Leaving rodillo-data wipes this browser: private caches, ride files and settings go; a ride that never synced
  // is asked about first (Cancel keeps everything, token included)
  const PRIVATE = { remoteIndex: HISTORY, remoteIndexAt: 1, coachPlan: { name: 'Coach', days: {} }, whoop: { '2026-11-18': { recovery: 40 } }, garagePhotos: { x: 'data:' }, settingsBase: {} };
  const seedPrivate = () => page.evaluate(async ([priv, tok]) => {
    for (const [k, v] of Object.entries(priv)) localStorage.setItem(`rodillo.${k}`, JSON.stringify(v));
    localStorage.setItem('rodillo.sync', tok);
    localStorage.setItem('rodillo.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('rodillo.settings') || '{}'), ftp: 262, riderName: 'Smoke' }));
    await new Promise((res, rej) => { const o = indexedDB.open('rodillo', 2); o.onsuccess = () => { const t = o.result.transaction('rides', 'readwrite'); t.objectStore('rides').put({ id: 1, status: 'done', synced: false, summary: { id: '2026-11-18T0900' } }); t.oncomplete = res; t.onerror = rej; }; o.onerror = rej; });
  }, [PRIVATE, TOKEN]);
  const ridesHere = () => page.evaluate(() => new Promise((res) => { const o = indexedDB.open('rodillo', 2); o.onsuccess = () => { const r = o.result.transaction('rides').objectStore('rides').count(); r.onsuccess = () => res(r.result); }; }));
  const clearToken = async () => {
    await page.click('#btn-settings');
    await page.click('#set-tabs button[data-stab="sync"]');
    await page.fill('#set-token', '');
    await page.click('#btn-token');
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 3000 }).catch(() => fail('no question about the ride that never synced'));
    if (!/1 ride\b/.test(await page.textContent('#modal'))) fail(`sign-out question: ${await page.textContent('#modal')}`);
  };
  await seedPrivate();
  await page.reload({ waitUntil: 'load' });
  await clearToken();
  await page.click('#modal-cancel');
  await page.waitForTimeout(200);
  if (!(await lsGet(page, 'sync')).token || !(await lsGet(page, 'remoteIndex')) || await ridesHere() !== 1 || await page.inputValue('#set-token') !== 'smoke-token') fail('Cancel still signed out or wiped');
  await page.click('#settings [data-close]');
  await clearToken();
  await page.click('#modal-ok');
  await page.waitForFunction(() => /Sync turned off/.test(document.querySelector('#token-status').textContent), null, { timeout: 3000 });
  const left = await page.evaluate((keys) => keys.filter((k) => localStorage.getItem(`rodillo.${k}`) !== null), Object.keys(PRIVATE));
  const st = await lsGet(page, 'settings');
  const baseNow = JSON.stringify(await lsGet(page, 'settingsBase')); // rebuilt from the default settings at once
  if (left.filter((k) => k !== 'settingsBase').length || /262|Smoke/.test(baseNow) || await ridesHere() || st.ftp === 262 || st.riderName === 'Smoke') fail(`base ${baseNow}; `+`signed out but left behind: ${left.join()} rides ${await ridesHere()} ftp ${st.ftp} name ${st.riderName}`);
  await page.click('#settings [data-close]');
  await page.click('#tabs button[data-tab="training"]');
  await page.waitForFunction(() => document.querySelector('#tab-training').classList.contains('locked') && /history is private/.test(document.querySelector('#sync-status').textContent), null, { timeout: 3000 })
    .catch(() => fail('Training not locked after sign-out'));
  if (await shownNow(page, '#training-cards')) fail('Training cards show signed out');
  ok('desktop: sign-out asks about an unsynced ride (Cancel keeps all), then wipes caches, rides and settings; Training locked');
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
  const gh = {}; // signed in: history and WHOOP come from the mocked rodillo-data (the plan stays the public one above)
  await mockGitHub(ctx, gh);
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
  await page.evaluate((t) => localStorage.setItem('rodillo.sync', t), TOKEN);
  const seed = (rides) => { // rodillo-data and this browser's cached copy agree, so the first draw already has them
    gh['index.json'] = { rides }; gh['whoop/daily.json'] = { days: WHOOP };
    return page.evaluate(([r, whoop]) => { localStorage.setItem('rodillo.remoteIndex', JSON.stringify(r)); localStorage.setItem('rodillo.whoop', JSON.stringify(whoop)); }, [rides, WHOOP]);
  };
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
  // the profile readout (mouse on desktop, a tap on the phone): the first interval (a ramp, the readout kept inside
  // the chart), the first rep, the last step; how it comes and goes
  const ssSegs = flatten(ss, ftp);
  for (const k of [0, ssSegs.findIndex((g) => g.rep), ssSegs.length - 1]) await checkReadout(page, '#today .hero-prof', ss, k, ftp, phone, fail, `hero stretch ${k}`);
  await checkReadoutComesAndGoes(page, '#today .hero-prof', 0, phone, '#today .hero-name', fail, 'hero');
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
  ok(`${label}: Today on a workout day (fixed clock): hero, recovery call, profile readout (ramp, rep, last step, comes and goes), a free ride done, overview tiles, Next days`);

  // a Next days card opens that day in the Calendar
  await page.click('#week-strip .day[data-day="2026-11-21"]');
  await page.waitForFunction(() => document.querySelector('#home').dataset.tab === 'calendar' && document.querySelector('.cal-cell.sel')?.dataset.day === '2026-11-21', null, { timeout: 3000 });
  if (!/^Saturday, November 21/.test(await text('#cal-detail h3')) || await text('#cal-detail .wo-name') !== W('sim-rolling-45').name || await text('#cal-detail [data-startday]') !== 'Ride it now') fail('Next days card opened the wrong Calendar day');
  // a slope day's elevation profile in the day detail: grade and height gained or lost per stretch, by distance or time
  const roll = W('sim-rolling-45'), rollSegs = flatten(roll, ftp);
  for (const k of [0, rollSegs.findIndex((g, i) => i && g.grade > 0), rollSegs.findIndex((g) => g.grade < 0), rollSegs.length - 1]) await checkReadout(page, '#cal-detail .cal-prof', roll, k, ftp, phone, fail, `Calendar slope day stretch ${k}`);
  await checkReadoutComesAndGoes(page, '#cal-detail .cal-prof', 1, phone, '#cal-detail h3', fail, 'Calendar slope day');

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
  // today's detail chart reads out too (its own copy of the profile, bound when the day opens)
  for (const k of [ssSegs.findIndex((g) => g.rep), ssSegs.length - 1]) await checkReadout(page, '#cal-detail .cal-prof', ss, k, ftp, phone, fail, `Calendar today stretch ${k}`);
  await checkReadoutComesAndGoes(page, '#cal-detail .cal-prof', 0, phone, '#cal-detail h3', fail, 'Calendar today');
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
  ok(`${label}: Calendar (fixed clock): month grid and chips, a day opened from Next days (its elevation profile readout), today's profile readout, done / missed / rest days, ride page and back, month switch`);

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
  // the done hero keeps the workout's profile on desktop, and it reads out (bound only when the ride was this
  // workout); the phone's done card has no profile
  if (phone) { if (await vis('#today .hero-prof')) fail('the phone\'s done hero shows a profile'); } else {
    const vo2w = W('vo2-30-15'), vo2Segs = flatten(vo2w, ftp);
    for (const k of [vo2Segs.findIndex((g) => g.rep), vo2Segs.findLastIndex((g) => g.rep)]) await checkReadout(page, '#today .hero-prof', vo2w, k, ftp, phone, fail, `done hero stretch ${k}`);
    await page.mouse.move(5, 5);
  }
  await toRideAndBack('#hero-see', 'today');
  ok(`${label}: Today on a rest day and a done day (fixed clock): free ride first, coach call, the ride's numbers, the done hero's profile readout (desktop; none on the phone), See ride and back`);
  await ctx.close();
}

// ---- controller and keyboard: action(), the button map, hold to confirm, the keyboard listener (js/app.js)
// A fake Zwift Ride in the page: Web Bluetooth hands out two hoods (left 0x08, right 0x07) whose button service sends
// real RideKeyPadStatus bytes, so a press goes through js/ble/zwiftride.js and onButton() like on the bike.
// window.__ride.press(['a'], 'left' | 'right' | 'both') adds buttons to what that hood holds; .release(side) lets go of all.
function fakeRide() {
  const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  const RIDE = uuid16(0xfc82), ch = (n) => `0000000${n}-19ca-4651-86e5-fa29dcdd09d1`;
  const MASK = { left: 0x1, up: 0x2, right: 0x4, down: 0x8, a: 0x10, b: 0x20, y: 0x40, z: 0x80, shiftUpL: 0x100, shiftDnL: 0x200, powerUpL: 0x400, onOffL: 0x800, shiftUpR: 0x1000, shiftDnR: 0x2000, powerUpR: 0x4000, onOffR: 0x8000 };
  const varint = (v) => { const out = []; while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
  const char = (value = new Uint8Array(0)) => ({
    l: [], addEventListener(_, f) { this.l.push(f); }, async startNotifications() {}, async readValue() { return new DataView(value.buffer); },
    async writeValueWithResponse() {}, async writeValueWithoutResponse() {}, async writeValue() {},
    fire(bytes) { const v = new DataView(new Uint8Array(bytes).buffer); for (const f of this.l) f({ target: { value: v } }); },
  });
  const hoods = {};
  const device = (side) => {
    const asyncC = char();
    const svcs = {
      [RIDE]: { [ch(2)]: asyncC, [ch(3)]: char(), [ch(4)]: char() },
      [uuid16(0x180a)]: { [uuid16(0x2a26)]: char(new TextEncoder().encode('1.2.0')) },
      [uuid16(0x180f)]: { [uuid16(0x2a19)]: char(new Uint8Array([85])) },
    };
    const svc = (u) => ({ uuid: u, async getCharacteristic(c) { if (!svcs[u][c]) throw new Error(`no characteristic ${c}`); return svcs[u][c]; } });
    const server = { async getPrimaryService(u) { if (!svcs[u]) throw new Error(`no service ${u}`); return svc(u); }, async getPrimaryServices() { return Object.keys(svcs).map(svc); } };
    return { name: 'Zwift Ride', id: `smoke-ride-${side}`, held: new Set(), asyncC, addEventListener() {}, gatt: { connected: true, async connect() { return server; }, disconnect() {} } };
  };
  const send = (d) => {
    let v = 0xffffffff; // a 0 bit = pressed
    for (const b of d.held) if (MASK[b]) v -= MASK[b];
    const bytes = [0x23, 0x08, ...varint(v)];
    for (const [b, loc] of [['paddleL', 0], ['paddleR', 1]]) if (d.held.has(b)) bytes.push(0x1a, 5, 0x08, loc, 0x10, 0xc8, 0x01); // analog 100
    d.asyncC.fire(bytes);
  };
  const sides = (side) => (side === 'both' ? ['left', 'right'] : [side]);
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: { async requestDevice(o) { const side = o.filters?.[0]?.manufacturerData?.[0]?.dataPrefix?.[0] === 0x07 ? 'right' : 'left'; return (hoods[side] = device(side)); } },
  });
  window.__ride = {
    press(names, side = 'left') { for (const s of sides(side)) { names.forEach((b) => hoods[s].held.add(b)); send(hoods[s]); } },
    release(side = 'left') { for (const s of sides(side)) { hoods[s].held.clear(); send(hoods[s]); } },
  };
}

async function controlsRun(viewport, label) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.addInitScript(fakeRide);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`controls ${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`controls ${label} console: ${m.text()}`); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#today', { state: 'attached' });
  await page.waitForFunction(() => document.querySelectorAll('#workout-list .wo').length > 0, null, { timeout: 5000 });
  const fail = (what) => { throw new Error(`controls (${label}): ${what}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  const press = (names, side = 'left') => page.evaluate(([n, s]) => window.__ride.press(n, s), [names, side]);
  const release = (side = 'left') => page.evaluate((s) => window.__ride.release(s), side);
  // a press, then let go; onButton() drops the same button again within 90 ms (both hoods), so leave a gap
  const tap = async (names, side = 'left') => { await press(names, side); await wait(40); await release(side); await wait(130); };
  const holdBtn = async (names, ms, side = 'left') => { await press(names, side); await wait(ms); await release(side); await wait(120); };
  const key = async (k) => { await page.keyboard.press(k); await wait(80); };
  const st = () => page.evaluate(() => {
    const app = window.rodillo, s = app.session, q = (sel) => document.querySelector(sel);
    const shown = (sel) => !!q(sel) && !q(sel).classList.contains('hidden') && !q(sel).closest('.hidden');
    return {
      screen: app.screen, tab: app.tab, woKind: app.woKind, modal: shown('#modal'), devpop: shown('#devpop'), controls: shown('#controls'),
      hold: shown('#hold') ? { kind: ['skip', 'end'].find((k) => q('#hold').classList.contains(k)), key: q('#hold-key').textContent, msg: q('#hold-msg').textContent, sub: q('#hold-sub').textContent } : null,
      toast: q('#toast').classList.contains('show') ? q('#toast').textContent : '',
      s: s && { started: s.started, paused: s.paused, mode: s.mode, intensity: s.intensity, grade: s.gradeOffset, seg: s.segIndex, rear: s.gb.rear, front: s.gb.front, nRear: s.gb.nRear, double: s.gb.isDouble, samples: s.samples.length },
    };
  });
  // the home focus ring: which item of the tab's controller list carries .focus (-1 none, -2 more than one)
  const ring = () => page.evaluate(() => {
    const app = window.rodillo, all = (sel) => [...document.querySelectorAll(sel)];
    const list = app.tab === 'today' ? all('#today .hero-btns button')
      : app.tab === 'workouts' ? [...all('#wo-kind button:not(.hidden)'), ...all(app.woKind === 'slope' ? '#slope-list .wo' : '#workout-list .wo')] : [];
    const f = all('#home .focus');
    return { at: f.length === 1 ? list.indexOf(f[0]) : f.length ? -2 : -1, n: list.length };
  });
  const modalRing = () => page.evaluate(() => [...document.querySelectorAll('#modal .modal-btns button:not(.hidden)')].findIndex((b) => b.classList.contains('focus')));
  const expectRing = async (at, what) => { const r = await ring(); if (r.at !== at) fail(`${what}: focus ring on item ${r.at} of ${r.n}, expected ${at}`); };
  const expectTab = async (t, what) => {
    const got = await page.evaluate(() => [document.querySelector('#home').dataset.tab, document.querySelector('#tabs button.active')?.dataset.tab, window.rodillo.tab]);
    if (got.some((x) => x !== t)) fail(`${what}: tab ${got.join(' / ')}, expected ${t}`);
  };

  // connect both hoods from Connections; B (a menu "back") closes the popover
  await page.click('#btn-devices');
  await page.click('[data-connect="controller"]');
  await page.waitForFunction(() => window.rodillo.controllers.filter((c) => c.state === 'connected').length === 1, null, { timeout: 3000 });
  if (!phone) {
    await page.waitForSelector('[data-connect="controllerR"]:not(.hidden)', { timeout: 3000 });
    await page.click('[data-connect="controllerR"]');
    await page.waitForFunction(() => window.rodillo.controllers.filter((c) => c.state === 'connected').length === 2, null, { timeout: 3000 });
  }
  if (!(await st()).devpop) fail('Connections popover not open after connecting');
  await tap(['b']);
  if ((await st()).devpop) fail('B on home did not close the Connections popover');
  ok(`${label}: Ride controller${phone ? '' : 's (both hoods)'} connect through the fake Bluetooth; B closes Connections`);

  // ---- home, controller only (no key pressed yet): tabs, focus ring, select, the modal
  await expectTab('today', 'start');
  await tap(['right'], phone ? 'left' : 'both'); // both hoods send it: counted once
  await expectTab('workouts', 'D-pad right');
  await expectRing(0, 'Workouts tab, controller only'); // the ERG switch; the ring shows without a key ever pressed
  for (const t of ['calendar', 'training', 'today', 'workouts']) { await tap(['right']); await expectTab(t, 'D-pad right'); }
  await tap(['left']); await expectTab('today', 'D-pad left');
  await tap(['left']); await expectTab('training', 'D-pad left wraps');
  await tap(['right']); await tap(['right']); await expectTab('workouts', 'D-pad right');
  const moves = [[['down'], 1], [['paddleR'], 2], [['shiftUpR'], 3], [['shiftDnL'], 2], [['up'], 1], [['shiftUpL'], 0], [['up'], 0], [['paddleL'], 0]];
  for (const [b, at] of moves) { await tap(b, b[0].endsWith('R') && !phone ? 'right' : 'left'); await expectRing(at, `${b} on the Workouts tab`); }
  await holdBtn(['down'], 800); // menus don't repeat a held button (only the ride screen does)
  await expectRing(1, 'D-pad down held 800 ms on home');
  await tap(['a']); // A on the Slope switch
  if ((await st()).woKind !== 'slope') fail('A on the Slope switch did not show the Slope list');
  await expectRing(1, 'after A on the Slope switch');
  await tap(['down']); await expectRing(2, 'first Slope row');
  await tap(['a']); // a row: no trainer yet, so the app asks
  await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 3000 });
  const nBtns = await page.$$eval('#modal .modal-btns button:not(.hidden)', (b) => b.length);
  if (nBtns !== 2 || await modalRing() !== 1) fail(`"No trainer" modal: ${nBtns} buttons, ring on ${await modalRing()}, expected 2 and the last`);
  await tap(['left']); if (await modalRing() !== 0) fail('D-pad left in the modal');
  await tap(['right']); if (await modalRing() !== 1) fail('D-pad right in the modal');
  await tap(['shiftDnL']); if (await modalRing() !== 0) fail('left shifter (easier) in the modal');
  await tap(['b']);
  const afterModal = await st();
  if (afterModal.modal || afterModal.s || afterModal.screen !== 'home') fail(`B in the modal: modal ${afterModal.modal}, session ${!!afterModal.s}, screen ${afterModal.screen}`);
  ok(`${label}: controller on home: tabs both ways, focus ring moved by D-pad, shifters and paddles, A on the switch and a row, the modal, B`);

  // ---- home, keyboard: tabs, focus, Enter, Esc closes a panel
  if (!phone) {
    await key('ArrowRight'); await expectTab('calendar', 'ArrowRight');
    await key('ArrowLeft'); await expectTab('workouts', 'ArrowLeft');
    await key('ArrowDown'); await expectRing(1, 'ArrowDown');
    await key('ArrowUp'); await expectRing(0, 'ArrowUp');
    await key('Enter'); // the ERG switch
    if ((await st()).woKind !== 'erg') fail('Enter on the ERG switch did not show the ERG list');
    await page.click('#btn-controls');
    if (!(await st()).controls) fail('Controls panel did not open');
    await key('Escape');
    if ((await st()).controls) fail('Esc on home did not close the Controls panel');
    ok(`${label}: keyboard on home: arrows, Enter, Esc closes a panel`);
  } else {
    await tap(['up']); await tap(['up']); await expectRing(0, 'back up to the ERG switch');
    await tap(['a']);
    if ((await st()).woKind !== 'erg') fail('A on the ERG switch did not show the ERG list');
  }

  // ---- ride: Demo mode, then A on the first ERG row starts the workout (no launch animation from a row)
  await page.click('#btn-devices');
  await page.click('#btn-demo');
  await tap(['b']);
  await expectRing(0, 'ERG switch before the row');
  await tap(['down']); await tap(['down']); await expectRing(2, 'first ERG row');
  await tap(['a']);
  await page.waitForSelector('#ride.active', { timeout: 5000 });
  await page.waitForFunction(() => window.rodillo.session?.started && !window.rodillo.session.paused, null, { timeout: 10000 });
  let r = await st();
  if (r.s.mode !== 'erg') fail(`first ERG row rides in ${r.s.mode} mode`);

  if (phone) {
    // B held 5 s right away: under 10 s, nothing is saved, back home
    await press(['b']); await wait(400);
    r = await st();
    if (r.hold?.kind !== 'end' || r.hold.key !== 'B' || !/Under 10 s/.test(r.hold.sub)) fail(`hold B overlay ${JSON.stringify(r.hold)}`);
    await wait(5200); await release(); await wait(300);
    r = await st();
    if (r.s || r.screen !== 'home' || r.hold) fail(`B held 5 s under 10 s: screen ${r.screen}, session ${!!r.s}`);
    ok(`${label}: A on a row starts the ride; B held 5 s ends it, under 10 s nothing saved`);
    // again, for A pause, shifters (ERG) and the phone sheet's hold buttons (fill left to right, no ring)
    await tap(['a']);
    await page.waitForFunction(() => window.rodillo.session?.started && !window.rodillo.session.paused, null, { timeout: 10000 });
    await tap(['a']); if (!(await st()).s.paused) fail('A did not pause');
    await tap(['a']); if ((await st()).s.paused) fail('A did not resume');
    await tap(['shiftUpR']); if ((await st()).s.intensity !== 1.01) fail('right shifter in ERG did not raise the effort to 101%');
    await tap(['shiftDnL']); if ((await st()).s.intensity !== 1) fail('left shifter in ERG did not lower the effort to 100%');
    const sheetHold = async (id, ms) => {
      await page.evaluate((x) => document.getElementById(x).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })), id);
      await wait(ms);
      const filling = await page.$eval(`#${id}`, (el) => el.classList.contains('filling'));
      await page.evaluate((x) => document.getElementById(x).dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), id);
      await wait(150);
      return filling;
    };
    await page.click('#rp-more');
    const seg0 = (await st()).s.seg;
    if (!(await sheetHold('rp-skip', 400))) fail('sheet Skip did not fill while held');
    r = await st(); if (r.s.seg !== seg0 || r.hold) fail('sheet Skip let go after 0.4 s still skipped');
    await sheetHold('rp-skip', 1200);
    r = await st(); if (r.s.seg !== seg0 + 1 || r.toast !== 'Skipped') fail(`sheet Skip held 1.2 s: segment ${seg0} -> ${r.s.seg}, toast "${r.toast}"`);
    if (await page.$eval('#rp-sheet', (el) => !el.classList.contains('hidden'))) fail('sheet still open after the skip');
    await page.click('#rp-more');
    await sheetHold('rp-end', 600);
    if (!(await st()).s) fail('sheet End let go after 0.6 s still ended the ride');
    await sheetHold('rp-end', 2300);
    r = await st(); if (r.s || !['home', 'ridepage'].includes(r.screen)) fail(`sheet End held 2.3 s: screen ${r.screen}, session ${!!r.s}`);
    ok(`${label}: ride: A pause, ERG shifters, sheet Skip and End holds (let go early does nothing)`);
    if (await shownNow(page, '#r-tod')) fail('time of day shows on the phone ride screen');
    await ctx.close();
    return;
  }

  // time of day, 12 h, left of the light / dark switch on the same line
  const tod = await page.evaluate(() => { const c = document.querySelector('#r-tod'), t = document.querySelector('#r-theme'); const a = c.getBoundingClientRect(), b = t.getBoundingClientRect(); return { text: c.textContent, left: a.right <= b.left, mid: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) }; });
  if (!/^\d{1,2}:\d{2}\s[AP]M$/.test(tod.text)) fail(`time of day "${tod.text}"`);
  if (!(await shownNow(page, '#r-tod')) || !tod.left || tod.mid > 2) fail(`time of day not beside the theme switch ${JSON.stringify(tod)}`);
  ok(`${label}: ride: time of day (12 h) beside the light / dark switch`);

  // pause / resume with A and Space
  await tap(['a']); r = await st();
  if (!r.s.paused || !(await shownNow(page, '#r-paused'))) fail('A did not pause (or the pause screen is hidden)');
  await tap(['a']); if ((await st()).s.paused) fail('A did not resume');
  await key(' '); if (!(await st()).s.paused) fail('Space did not pause');
  await key(' '); if ((await st()).s.paused) fail('Space did not resume');

  // ERG: easier / harder = effort -/+1% from the shifters, paddles, D-pad, [ ] and the arrows
  const effort = [[['shiftUpR'], 'right', 1.01], [['shiftDnL'], 'left', 1], [['paddleL'], 'left', 0.99], [['paddleR'], 'right', 1], [['shiftDnR'], 'right', 1.01], [['shiftUpL'], 'left', 1], [['up'], 'left', 1.01], [['down'], 'left', 1]];
  for (const [b, side, want] of effort) {
    await tap(b, side); r = await st();
    if (r.s.intensity !== want) fail(`${b} in ERG: effort ${r.s.intensity}, expected ${want}`);
  }
  if (!/^Intensity 100%$/.test(r.toast)) fail(`ERG toast "${r.toast}"`);
  for (const [k, want] of [[']', 1.01], ['[', 1], ['ArrowRight', 1.01], ['ArrowLeft', 1], ['ArrowUp', 1.01], ['ArrowDown', 1]]) {
    await key(k); r = await st();
    if (r.s.intensity !== want) fail(`${k} in ERG: effort ${r.s.intensity}, expected ${want}`);
  }
  // held: repeats after 450 ms, every 120 ms, and stops on release
  const e0 = (await st()).s.intensity;
  await holdBtn(['shiftUpR'], 1000, 'right');
  const e1 = (await st()).s.intensity, up = Math.round((e1 - e0) * 100);
  if (up < 4 || up > 8) fail(`right shifter held 1 s: effort +${up}%, expected 4 to 8 (repeat)`);
  await wait(400);
  if ((await st()).s.intensity !== e1) fail('effort kept changing after the shifter was let go');
  await holdBtn(['down'], 1000);
  const down = Math.round((e1 - (await st()).s.intensity) * 100);
  if (down < 4 || down > 8) fail(`D-pad down held 1 s: effort -${down}%, expected 4 to 8 (repeat)`);
  ok(`${label}: ride, ERG: A / Space pause; shifters, paddles, D-pad, [ ] and arrows change the effort 1%; held repeats`);

  // B / Esc close a panel or Connections opened from the pause screen instead of ending the ride
  await tap(['a']);
  const closes = [['#pz-controls', 'controls', () => tap(['b']), 'B'], ['#pz-controls', 'controls', () => key('Escape'), 'Esc'], ['#pz-devices', 'devpop', () => tap(['b']), 'B']];
  for (const [btn, what, back, name] of closes) {
    await page.click(btn);
    if (!(await st())[what]) fail(`${btn} did not open ${what} on the pause screen`);
    await back();
    r = await st();
    if (r[what] || r.hold || !r.s || r.screen !== 'ride' || !r.s.paused) fail(`${name} with ${what} open on the ride: ${what} ${r[what]}, hold ${JSON.stringify(r.hold)}, screen ${r.screen}, paused ${r.s?.paused}`);
  }
  await wait(600);
  if ((await st()).hold || !(await st()).s) fail('the ride ended or a hold started after closing the panels');
  await tap(['a']); if ((await st()).s.paused) fail('A did not resume after closing the panels');
  ok(`${label}: ride: B / Esc close Controls and Connections from the pause screen, ride kept`);

  // skip: Y (and S) must be held 3 s; letting go early does nothing
  const seg0 = (await st()).s.seg;
  await press(['y'], 'right'); await wait(1000);
  r = await st();
  if (r.hold?.kind !== 'skip' || r.hold.key !== 'Y' || r.hold.sub !== 'Keep holding Y to skip') fail(`hold Y overlay ${JSON.stringify(r.hold)}`);
  await release('right'); await wait(150);
  r = await st();
  if (r.hold || r.s.seg !== seg0) fail(`Y let go after 1 s: overlay ${!!r.hold}, segment ${seg0} -> ${r.s.seg}`);
  await page.keyboard.down('s'); await wait(500);
  r = await st();
  if (r.hold?.key !== 'S') fail(`hold S overlay ${JSON.stringify(r.hold)}`);
  await page.keyboard.up('s'); await wait(150);
  r = await st();
  if (r.hold || r.s.seg !== seg0) fail('S let go after 0.5 s still skipped or left the overlay');
  await holdBtn(['y'], 3400, 'right');
  r = await st();
  if (r.s.seg !== seg0 + 1 || r.toast !== 'Skipped' || r.hold) fail(`Y held 3.4 s: segment ${seg0} -> ${r.s.seg}, toast "${r.toast}"`);
  // end: B (and Esc) let go early keeps riding
  await press(['b'], 'right'); await wait(1500);
  r = await st();
  if (r.hold?.kind !== 'end' || r.hold.key !== 'B' || r.hold.msg !== 'End ride?') fail(`hold B overlay ${JSON.stringify(r.hold)}`);
  await release('right'); await wait(150);
  r = await st();
  if (r.hold || !r.s || r.screen !== 'ride') fail('B let go after 1.5 s ended the ride or left the overlay');
  await page.keyboard.down('Escape'); await wait(800);
  r = await st();
  if (r.hold?.key !== 'Esc' || r.hold.kind !== 'end') fail(`hold Esc overlay ${JSON.stringify(r.hold)}`);
  await page.keyboard.up('Escape'); await wait(150);
  r = await st();
  if (r.hold || !r.s) fail('Esc let go after 0.8 s ended the ride');
  ok(`${label}: ride: skip and end holds: overlay names Y / S and B / Esc; let go early does nothing; Y held 3 s skips`);

  // slope (ERG off with E): shifters change gear by the shift style (SRAM 2x: left + right together = front)
  await key('e');
  if ((await st()).toast !== 'ERG off: slope mode') fail('E did not turn ERG off');
  await page.waitForFunction(() => window.rodillo.session.mode === 'sim', null, { timeout: 2000 });
  r = await st();
  if (!r.s.double) fail('the default bike should be a 2x for this step');
  const r0 = r.s.rear, f0 = r.s.front;
  if (r0 >= r.s.nRear - 1) fail(`rear already in the hardest cog (${r0})`);
  const gear = async (what, rear, front) => { await wait(200); const g = (await st()).s; if (g.rear !== rear || g.front !== front) fail(`${what}: rear ${g.rear} front ${g.front}, expected ${rear} / ${front}`); };
  await tap(['shiftUpR'], 'right'); await gear('right shifter (harder)', r0 + 1, f0);
  await tap(['shiftDnL'], 'left'); await gear('left shifter (easier)', r0, f0);
  await tap(['paddleR'], 'right'); await gear('right paddle', r0 + 1, f0);
  await tap(['paddleL'], 'left'); await gear('left paddle', r0, f0);
  await page.evaluate(() => { window.__ride.press(['shiftUpL'], 'left'); window.__ride.press(['shiftUpR'], 'right'); });
  await wait(60); await release('both'); await gear('left + right together', r0, 1 - f0);
  await key('ArrowRight'); await gear('ArrowRight', r0 + 1, 1 - f0);
  await key('ArrowLeft'); await gear('ArrowLeft', r0, 1 - f0);
  await key(']'); await gear(']', r0 + 1, 1 - f0);
  await key('['); await gear('[', r0, 1 - f0);
  await key('f'); await gear('F', r0, f0);
  await tap(['up']); r = await st();
  if (r.s.grade !== 0.01 || r.toast !== 'Grade 1%') fail(`D-pad up in slope: grade ${r.s.grade}, toast "${r.toast}"`);
  await key('ArrowDown'); if ((await st()).s.grade !== 0) fail('ArrowDown in slope did not lower the grade');
  await key('e');
  if ((await st()).toast !== 'ERG on') fail('E did not turn ERG back on');
  await page.waitForFunction(() => window.rodillo.session.mode === 'erg', null, { timeout: 2000 });
  ok(`${label}: ride, slope: shifters, paddles, left + right (front), arrows, [ ] and F shift; D-pad / arrows change the grade; E toggles ERG`);

  // B held 5 s ends the ride; the done page: D-pad right picks an interval, the ends stop, B clears it, B again closes
  // first ride on until one step has a result for the done page (js/stats.js intervalResults: 10 s after a 5 s ramp-in)
  await page.waitForFunction(() => {
    const s = window.rodillo.session;
    return s.segs.some((g, i) => s.samples.filter((x) => x.si === i && x.st >= (g.dur >= 30 ? 5 : 0)).length >= Math.min(10, g.dur * 0.5));
  }, null, { timeout: 30000, polling: 250 });
  await holdBtn(['b'], 5400, 'right');
  await page.waitForSelector('#ridepage.active', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#rd-ints tr[data-i]').length > 0, null, { timeout: 5000 });
  const sel = () => page.$$eval('#rd-ints tr.sel', (t) => t.map((x) => x.dataset.i).join());
  await tap(['right']);
  const first = await sel();
  if (!first) fail('D-pad right on the done page picked no interval');
  // the ends stop: left on the first stays on it, right on the last stays on it (no deselect, no wrap)
  await tap(['left']);
  if (await sel() !== first) fail(`D-pad left on the first interval: selected "${await sel()}", expected "${first}"`);
  const rows = await page.$$eval('#rd-ints tr[data-i]', (t) => t.map((x) => x.dataset.i));
  for (let k = 1; k < rows.length; k++) await tap(['right']);
  const last = await sel();
  if (last !== rows.at(-1)) fail(`D-pad right to the end: selected "${last}", expected the last row "${rows.at(-1)}"`);
  await tap(['right']);
  if (await sel() !== last) fail(`D-pad right on the last interval: selected "${await sel()}", expected "${last}"`);
  await tap(['b']);
  if (await sel() !== '' || (await st()).screen !== 'ridepage') fail('B on the done page with an interval picked should clear it and stay');
  await tap(['b']);
  await page.waitForSelector('#home.active', { timeout: 3000 });
  ok(`${label}: B held 5 s ends the ride; done page: D-pad picks an interval and stops at the first and last, B clears it, B closes`);
  await ctx.close();
}

// ---- the desktop ride screen on demo rides, the clock paused and moved only by runFor(): interval card, Next card,
// tiles, a slope workout and a real climb, free ride, a workout message and the ramp test takeover. Each ride gets its
// own browser context (and clock). Expected numbers come from the workout files and the engine in Node, plus the
// session's own state for what the rider does (time left, gears, position on the road).
async function rideRun() {
  const FTP = DEFAULT_SETTINGS.ftp;
  const fail = (what) => { throw new Error(`ride screen: ${what}`); };
  let ctx, page;
  const run = (ms) => page.clock.runFor(ms);
  const key = async (k) => { await page.keyboard.press(k); await run(300); };
  const hold = async (k, ms) => { await page.keyboard.down(k); await run(ms); await page.keyboard.up(k); await run(300); };
  /** Open the app on Demo with the clock paused, then `start()`; resolves once the session has started (and a launch animation is over). */
  async function ride(name, start) {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
    await ctx.clock.install({ time: new Date('2026-11-19T18:00:00') });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`ride ${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`ride ${name} console: ${m.text()}`); });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#workout-list .wo').length > 0, null, { timeout: 5000 });
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.click('#btn-devices'); await page.click('#btn-demo'); await page.keyboard.press('Escape');
    await start();
    for (let i = 0; i < 60 && !(await page.evaluate(() => document.querySelector('#ride.active') && window.rodillo.session?.started && !window.rodillo.launching)); i++) { await run(250); await page.waitForTimeout(40); }
    if (!(await page.evaluate(() => window.rodillo.session?.started))) fail(`${name}: the ride did not start`);
  }
  const fromLibrary = (wname, kind) => async () => {
    await page.click('#tabs button[data-tab="workouts"]');
    await page.click(`#wo-kind button[data-kind="${kind}"]`);
    const row = await rowSel(page, kind === 'erg' ? '#workout-list' : '#slope-list', wname);
    await page.click(`${row} .wo-name`);
    await page.click(`${row} button[data-start]`);
  };
  // what the ride screen shows, and the session it shows
  const screen = () => page.evaluate(() => {
    const q = (sel) => document.querySelector(sel), tx = (sel) => q(sel)?.textContent ?? '', s = window.rodillo.session;
    return {
      label: tx('#r-int-label'), text: tx('#r-int-text'), big: tx('#r-int-big'), bar: !q('#r-int-bar').classList.contains('hidden'),
      rep: tx('#r-rep'), nrep: tx('#r-next .nrep'),
      next: { none: q('#r-next').classList.contains('none'), amt: tx('#r-next .amt'), cad: tx('#r-next .cad') },
      pct: q('#r-pct').classList.contains('hidden') ? null : tx('#r-pct'), target: tx('#r-target'),
      aimCls: ['aim-ok', 'aim-bad'].find((c) => q('.tile.power').classList.contains(c)) || '',
      gear: tx('#r-gear'), ratio: tx('#r-ratio'), gearviz: !!q('#r-ratio svg.gearviz'), gearDim: q('.tile.gear').classList.contains('dim'), flash: q('.tile.gear').classList.contains('flash'),
      climbLabel: tx('#r-climb-label'), climb: tx('#r-climb'), climbSub: tx('#r-climbsub'),
      msg: q('#r-msg').classList.contains('show') ? tx('#r-msg') : '',
      takeover: q('#takeover').classList.contains('hidden') ? null : { line: tx('#to-line'), big: tx('#to-big'), sub: tx('#to-sub') },
      segn: tx('#r-segn'), withSegs: q('#r-body').classList.contains('with-segs'),
      s: { seg: s.segIndex, intensity: s.intensity, offset: s.gradeOffset, grade: s.grade, rem: s.segRemaining, elapsed: s.elapsed, chartPos: s.chartPos, climbed: s.climbed, mode: s.mode, gb: { label: s.gb.label, seq: s.gb.seq, ratio: s.gb.ratio, rear: s.gb.rear }, target: s.target, segs: s.segs, aim: s.aimStatus },
    };
  });
  /** Seconds left as the ride screen counts them: on the elapsed clock, so they tick with elapsed. */
  const onClock = (sec, e) => Math.max(0, Math.round(e + sec) - Math.round(e));
  const left = (rem, e) => (rem.sec !== undefined ? fmtTime(onClock(rem.sec, e)) : rem.m < 1000 ? `${Math.round(rem.m)}m` : `${(rem.m / 1000).toFixed(2)}km`);
  const gearText = (gb) => (gb.seq ? gb.label : gb.label.replace('x', '×'));
  const expect = (what, got, want) => { if (got !== want) fail(`${what}: "${got}", expected "${want}"`); };
  /** Climbed / To the top tile on a slope-only workout, from the road laid out in Node. */
  const toTop = (v) => {
    if (!climbsByDist(v.s.segs)) { // timed climbs: the real metres climbed, no estimate
      expect('tile label on timed climbs', v.climbLabel, 'Climbed');
      expect('Climbed on timed climbs', v.climb, `${Math.round(v.s.climbed)}m`);
      expect('Climbed sub line', v.climbSub, '');
      return;
    }
    const tr = track(v.s.segs), d = trackDist(tr, v.s.segs, v.s.chartPos);
    expect('tile label on a slope-only workout', v.climbLabel, 'To the top');
    expect('To the top', v.climb, `${Math.round(Math.max(0, tr.ascent - trackClimbed(tr, d)))}m`);
    expect('To the top, out of the total climb', v.climbSub, `of ${Math.round(tr.ascent)} m`);
  };
  /** A shift: the gear tile shows the new gear (flashing) and its ratio. */
  async function shifts(name) {
    const v0 = await screen();
    if (v0.gearDim || v0.gear !== gearText(v0.s.gb)) fail(`${name}: gear tile "${v0.gear}" (dim ${v0.gearDim}) for gear ${v0.s.gb.label}`);
    await page.keyboard.press(']'); await run(300);
    const v = await screen();
    if (v.s.gb.rear !== v0.s.gb.rear + 1) fail(`${name}: ] did not shift (rear ${v0.s.gb.rear} -> ${v.s.gb.rear})`);
    expect(`${name}: gear tile after a shift`, v.gear, gearText(v.s.gb));
    if (!v.flash) fail(`${name}: the gear tile did not flash on the shift`);
    if (!v.ratio.includes(`ratio ${v.s.gb.ratio.toFixed(2)}`) || v.gearviz === v.s.gb.seq) fail(`${name}: gear ratio line "${v.ratio}"`);
  }

  // ERG workout: Sweet spot 3 x 12 (a ramp warm-up, then 12 min at 90% with a cadence target)
  const ss = flatten(SS);
  await ride('ERG', fromLibrary(SS.name, 'erg'));
  await run(5000);
  let v = await screen();
  expect('ERG card label', v.label, ss[0].label);
  expect('ERG card, ramp', v.big, `Ramp to${Math.round(ss[0].to * FTP)}Win${left(v.s.rem, v.s.elapsed)}`);
  const now = +v.text.match(/^now (\d+) W$/)?.[1];
  if (!(now >= Math.round(ss[0].from * FTP) && now <= Math.round(ss[0].to * FTP))) fail(`ERG card, ramp sub line "${v.text}"`);
  expect('Next card', v.next.amt, `${fmtTime(ss[1].dur)}@${Math.round(ss[1].from * FTP)}W`);
  expect('Next card cadence', v.next.cad, ss[1].cad.label);
  if (v.pct !== null || !v.bar || !v.withSegs || v.segn !== `0/${ss.length}`) fail(`ERG start: effort ${v.pct}, bar ${v.bar}, list ${v.withSegs} ${v.segn}`);
  if (!v.gearDim || v.ratio !== 'ERG: gears not used' || v.climbLabel !== 'Climbed') fail(`ERG tiles: gear dim ${v.gearDim} "${v.ratio}", ${v.climbLabel}`);
  if (!/^target \d+ W$/.test(v.target)) fail(`power tile "${v.target}"`);
  await key('ArrowUp'); // effort 101%
  v = await screen();
  if (v.s.intensity !== 1.01 || v.pct !== '101%') fail(`effort up: ${v.s.intensity}, tile "${v.pct}"`);
  expect('ERG card at 101%', v.big, `Ramp to${Math.round(ss[0].to * FTP * 1.01)}Win${left(v.s.rem, v.s.elapsed)}`);
  expect('Next card at 101%', v.next.amt, `${fmtTime(ss[1].dur)}@${Math.round(ss[1].from * FTP * 1.01)}W`);
  expect('rep counter in the warm-up', v.rep, '');
  expect('Next card rep line before rep 1', v.nrep, 'Rep 1/3');
  await hold('s', 3500); // skip: interval 1 of 3
  await run(3000);
  v = await screen();
  if (v.s.seg !== 1) fail(`hold S: segment ${v.s.seg}`);
  expect('ERG card label after the skip', v.label, ss[1].label);
  expect('rep counter on rep 1', v.rep, 'Rep1/3');
  expect('Next card rep line before the recovery', v.nrep, '');
  expect('ERG card, hold', v.big, `Hold${Math.round(ss[1].from * FTP * 1.01)}Wfor${left(v.s.rem, v.s.elapsed)}`);
  expect('ERG card sub line', v.text, `${Math.round(ss[1].from * 100 * 1.01)}% FTP · ${ss[1].cad.label}`);
  expect('Next card after the skip', v.next.amt, `${fmtTime(ss[2].dur)}@${Math.round(ss[2].from * FTP * 1.01)}W`);
  expect('interval count', v.segn, `1/${ss.length}`);
  ok('desktop: ride, ERG workout: interval card (ramp, hold, cadence), rep counter, Next card and its rep line, effort 101%, hold S skips, tiles');
  await ctx.close();

  // slope workout (timed climbs: Climbed, real metres), a shift, the profile moved up 1%
  const CR = byName('Climb repeats 4 x 6 min at 6%'), cr = flatten(CR);
  await ride('slope', fromLibrary(CR.name, 'slope'));
  await run(20000);
  v = await screen();
  if (v.s.mode !== 'sim' || v.pct !== null) fail(`slope workout in ${v.s.mode} mode, effort tile ${v.pct}`);
  expect('slope card label', v.label, cr[0].label);
  expect('slope card', v.big, `${(cr[0].grade * 100).toFixed(0)}%grade for${left(v.s.rem, v.s.elapsed)}`);
  expect('slope card sub line', v.text, 'use your gears');
  expect('Next card on a slope workout', v.next.amt, `${fmtTime(cr[1].dur)}@${(cr[1].grade * 100).toFixed(0)}%`);
  expect('Next card cadence and power aim', v.next.cad, `${cr[1].cad.label} · ~${Math.round(cr[1].aim.mid * FTP)} W`);
  if (v.aimCls || v.target.startsWith('target')) fail(`warm-up has no aim: power tile ${v.aimCls} "${v.target}"`);
  toTop(v);
  await shifts('slope workout');
  await key('ArrowUp'); // the whole profile +1%
  await hold('s', 3500);
  await run(5000);
  v = await screen();
  if (v.s.seg !== 1 || Math.abs(v.s.offset - 0.01) > 1e-9) fail(`slope: segment ${v.s.seg}, offset ${v.s.offset}`);
  expect('slope card on the climb', v.big, `${((cr[1].grade + 0.01) * 100).toFixed(0)}%grade for${left(v.s.rem, v.s.elapsed)}`);
  expect('slope card sub line on the climb', v.text, `profile +1% · ${ftpWatts(cr[1].text, FTP)} · ${cr[1].cad.label}`);
  if (v.text.includes('FTP')) fail(`slope card still says FTP: "${v.text}"`);
  toTop(v);
  // power aim: 10 s to settle (just the band), then green on target, red with an arrow off it
  const band = `target ${Math.round(cr[1].aim.lo * FTP)}-${Math.round(cr[1].aim.hi * FTP)} W`;
  if (v.s.aim !== null || v.aimCls) fail(`aim while settling: ${v.s.aim}, tile ${v.aimCls}`);
  expect('power tile while settling', v.target, band);
  await run(8000);
  v = await screen();
  if (!v.s.aim) fail('no power aim status 13 s into the climb');
  expect('power tile class', v.aimCls, v.s.aim === 'ok' ? 'aim-ok' : 'aim-bad');
  expect('power tile line', v.target, v.s.aim === 'ok' ? band : v.s.aim === 'low' ? '▲ Push harder' : '▼ Ease off');
  ok('desktop: ride, slope workout: grade card, profile +1%, Next card, gear shown after a shift, Climbed on timed climbs, power aim');
  await ctx.close();

  // a real climb (distance steps; the warm-up roll leaves the chart once ridden)
  await ride('real climb', fromLibrary(CLIMB.name, 'slope'));
  await run(10000);
  toTop(await screen());
  await hold('s', 3500);
  await run(20000);
  v = await screen();
  const g1 = v.s.segs[1];
  if (v.s.seg !== 1 || !g1.dist) fail(`real climb: segment ${v.s.seg} after the skip`);
  expect('real climb card label', v.label, g1.label);
  expect('real climb card', v.big, `${(g1.grade * 100).toFixed(0)}%grade for${left(v.s.rem, v.s.elapsed)}`);
  if (!/m$/.test(v.big)) fail(`real climb card counts metres: "${v.big}"`);
  toTop(v);
  await shifts('real climb');
  ok('desktop: ride, real climb: metres left on the card, To the top out of the total climb, a shift');
  await ctx.close();

  // free ride: grade card, no Next card or list, Climbed
  await ride('free ride', async () => { await page.click('#tabs button[data-tab="today"]'); await page.click('#btn-free'); });
  v = await screen();
  if (v.label !== 'Free ride' || v.big !== '0.0%grade' || v.text !== 'up/down changes the grade by 1%, shift to hold your cadence') fail(`free ride card ${JSON.stringify([v.label, v.big, v.text])}`);
  if (v.bar || !v.next.none || v.withSegs || v.climbLabel !== 'Climbed') fail(`free ride: bar ${v.bar}, next ${!v.next.none}, list ${v.withSegs}, ${v.climbLabel}`);
  await key('ArrowUp'); await key('ArrowUp');
  await run(60000);
  v = await screen();
  expect('free ride card at 2%', v.big, '2.0%grade');
  if (!(v.s.climbed > 0)) fail('free ride at 2% for a minute climbed nothing');
  expect('Climbed tile', v.climb, `${Math.round(v.s.climbed)}m`);
  await shifts('free ride');
  ok('desktop: ride, free ride: grade card, no Next card or list, Climbed, a shift');
  await ctx.close();

  // pain vision: clear for the first two thirds of a VO2 rep, edges blur in the last third (card and tiles above it),
  // gone in the recovery after it
  const VO = LIB.find((w) => w.id === 'vo2-5x4-110'), vo = flatten(VO), rep1 = vo.findIndex((g) => g.kind === 'erg' && g.from >= 1.05);
  await ride('pain vision', fromLibrary(VO.name, 'erg'));
  for (let i = 0; i < rep1; i++) await hold('s', 3500);
  if ((await screen()).s.seg !== rep1) fail(`pain vision: segment ${(await screen()).s.seg}, expected the first VO2 rep (${rep1})`);
  const pain = () => page.evaluate(() => {
    const r = document.querySelector('#ride'), cs = (sel) => getComputedStyle(document.querySelector(sel));
    return { on: r.classList.contains('pain-on'), v: +r.style.getPropertyValue('--pain'), shown: cs('.pain').visibility, card: cs('#r-interval').zIndex, layer: cs('.pain').zIndex };
  });
  await run(100 * 1000);
  let pv = await pain();
  if (pv.on || pv.v !== 0) fail(`pain vision: on ${pv.on} (${pv.v}) 100 s into a 4 min rep`);
  await run(120 * 1000);
  pv = await pain();
  if (!pv.on || !(pv.v > 0.3) || pv.shown !== 'visible') fail(`pain vision: 20 s from the end of the rep ${JSON.stringify(pv)}`);
  if (!(+pv.card > +pv.layer)) fail(`pain vision: interval card (z ${pv.card}) not above the layer (z ${pv.layer})`);
  await run(30 * 1000);
  pv = await pain();
  if (pv.on || pv.v !== 0) fail(`pain vision: still on in the recovery ${JSON.stringify(pv)}`);
  ok('desktop: ride, pain vision: clear early in a VO2 rep, edges blur near its end, gone in the recovery');
  await ctx.close();

  // ramp test: the workout's messages over the chart, then the "Here we go" takeover on step 1
  const RT = LIB.find((w) => w.id === 'ramp-test'), rt = flatten(RT), msgs = RT.steps[0].messages;
  await ride('ramp test', fromLibrary(RT.name, 'erg'));
  await run(1000);
  expect('first workout message', (await screen()).msg, msgs[0].text);
  await run((msgs[1].at + 2) * 1000);
  expect('second workout message', (await screen()).msg, msgs[1].text);
  await hold('s', 3500); await run(1000); await hold('s', 3500);
  v = await screen();
  const step1 = rt.findIndex((g) => g.untilFail);
  if (v.s.seg !== step1) fail(`ramp test: segment ${v.s.seg}, expected the first step (${step1})`);
  expect('ramp test card', v.big, `Hold${Math.round(rt[step1].from * FTP)}Wfor${left(v.s.rem, v.s.elapsed)}`);
  if (!v.takeover || v.takeover.line !== 'Here we go.' || v.takeover.big !== `${Math.round(rt[step1].from * FTP)} W` || !/^\+20 W every minute/.test(v.takeover.sub)) fail(`ramp test takeover ${JSON.stringify(v.takeover)}`);
  await page.waitForFunction(() => document.querySelector('#takeover').classList.contains('hidden'), null, { timeout: 6000 });
  ok('desktop: ride, ramp test: workout messages over the chart, "Here we go" takeover on step 1, then back');
  await ctx.close();
}

// ---- the phone ride screen on demo rides, the clock paused and moved only by runFor(): the top line, the hero card
// (interval, countdown, target), the power gauge and its aim, cadence / effort / gear, the Next line, chart and list
// view, the buttons and the ··· sheet (grade, Skip and End holds, Lap, theme, Close). Each ride its own context (and
// clock), 390 x 844 with touch. Expected numbers come from the workout files and the engine in Node, plus the
// session's own state for what the rider does (time left, progress, gears, power shown).
async function phoneRideRun() {
  const FTP = DEFAULT_SETTINGS.ftp;
  const fail = (what) => { throw new Error(`phone ride screen: ${what}`); };
  let ctx, page;
  const run = (ms) => page.clock.runFor(ms);
  const tapBtn = async (id) => { await page.click(`#${id}`); await run(300); };
  /** A sheet hold button pressed for `ms` (pointer events, the clock moved meanwhile); returns whether it was filling. */
  const sheetHold = async (id, ms) => {
    await page.evaluate((x) => document.getElementById(x).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })), id);
    await run(ms);
    const filling = await page.$eval(`#${id}`, (el) => el.classList.contains('filling'));
    await page.evaluate((x) => document.getElementById(x).dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), id);
    await run(300);
    return filling;
  };
  async function ride(name, start) {
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
    await ctx.clock.install({ time: new Date('2026-11-19T18:00:00') });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`phone ride ${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`phone ride ${name} console: ${m.text()}`); });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#workout-list .wo').length > 0, null, { timeout: 5000 });
    await page.evaluate(() => localStorage.removeItem('rodillo.phoneView'));
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.click('#btn-devices'); await page.click('#btn-demo'); await page.keyboard.press('Escape');
    await start();
    for (let i = 0; i < 60 && !(await page.evaluate(() => document.querySelector('#ride.active') && window.rodillo.session?.started && !window.rodillo.launching)); i++) { await run(250); await page.waitForTimeout(40); }
    if (!(await page.evaluate(() => window.rodillo.session?.started))) fail(`${name}: the ride did not start`);
  }
  const fromLibrary = (wname, kind) => async () => {
    await page.click('#tabs button[data-tab="workouts"]');
    await page.click(`#wo-kind button[data-kind="${kind}"]`);
    const row = await rowSel(page, kind === 'erg' ? '#workout-list' : '#slope-list', wname);
    await page.click(`${row} .wo-name`);
    await page.click(`${row} button[data-start]`);
  };
  const screen = () => page.evaluate(() => {
    const q = (sel) => document.querySelector(sel), tx = (sel) => q(sel)?.textContent ?? '', s = window.rodillo.session;
    const hid = (sel) => q(sel).classList.contains('hidden'), has = (sel, c) => q(sel).classList.contains(c);
    const vis = (sel) => { const r = q(sel).getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(q(sel)).visibility !== 'hidden'; };
    const cv = q('#rp-chart'), px = cv.width ? cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data : [];
    let drawn = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) drawn++;
    const rows = [...q('#rp-segs').children];
    return {
      phone: vis('#rp') && !vis('.tiles'),
      elapsed: tx('#rp-elapsed'), name: tx('#rp-name'), leftK: tx('#rp-left-k'), left: tx('#rp-left'),
      label: tx('#rp-int-label'), rep: tx('#rp-rep'), count: tx('#rp-count'), target: tx('#rp-target'), targetSub: tx('#rp-target-sub'),
      zc: q('#rp').style.getPropertyValue('--zc'), fresh: has('#rp-hero', 'int-fresh'), ending: has('#rp-hero', 'int-ending'),
      power: tx('#rp-power'), gaugeOff: has('#rp-gauge', 'off'), gaugeAt: q('#rp-gauge b').style.left,
      powerCls: ['ok', 'bad'].filter((c) => has('#rp-power-box', c)).join(), powerSub: tx('#rp-power-sub'),
      hr: tx('#rp-hr'), cad: tx('#rp-cad'), cadCls: ['ok', 'bad'].filter((c) => has('#rp-cad-box', c)).join(), cadSub: tx('#rp-cad-sub'),
      m3k: tx('#rp-m3-k'), m3: tx('#rp-m3'), m3sub: tx('#rp-m3-sub'), m3cls: ['up', 'down'].filter((c) => q('#rp-m3').parentElement.classList.contains(c)).join(),
      next: tx('#rp-next'), nextSw: !!q('#rp-next .sw'),
      minus: tx('#rp-minus'), plus: tx('#rp-plus'), pause: tx('#rp-pause'),
      gradeRow: !hid('#rp-grade-row'), skip: !hid('#rp-skip'), lap: !hid('#rp-lap'), erg: !hid('#rp-erg'), ergText: tx('#rp-erg'),
      sheet: !hid('#rp-sheet'), paused: !hid('#r-paused'), pausedSub: tx('#r-paused-sub'),
      noSegs: has('#rp-wrap', 'no-segs'), asList: has('#rp-wrap', 'as-list'), viewOn: [...q('#rp-view-tg').children].filter((b) => b.classList.contains('on')).map((b) => b.dataset.view).join(),
      viewK: tx('#rp-view-k'), chartShown: vis('#rp-chart'), drawn, listShown: vis('#rp-segs'),
      rows: rows.length, current: rows.findIndex((r) => r.classList.contains('current')), checks: rows.filter((r) => r.querySelector('.check')).length,
      toast: q('#toast').classList.contains('show') ? tx('#toast') : '', theme: window.rodillo.theme, themeBtn: tx('#rp-theme'),
      screen: window.rodillo.screen,
      s: s && { seg: s.segIndex, intensity: s.intensity, offset: s.gradeOffset, grade: s.grade, rem: s.segRemaining, progress: s.segProgress, chartPos: s.chartPos,
        mode: s.mode, target: s.target, aim: s.aimStatus, paused: s.paused, elapsed: s.elapsed, dist: s.bike.dist, v: s.bike.v, segs: s.segs, name: s.name,
        gb: { label: s.gb.label, seq: s.gb.seq, isDouble: s.gb.isDouble, front: s.gb.front, rear: s.gb.rear, ring: s.gb.ring, cog: s.gb.cog } },
    };
  });
  const expect = (what, got, want) => { if (got !== want) fail(`${what}: "${got}", expected "${want}"`); };
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
  const onClock = (sec, e) => Math.max(0, Math.round(e + sec) - Math.round(e)); // ticks with elapsed
  const count = (rem, e) => (rem.sec !== undefined ? fmtTime(onClock(rem.sec, e)) : fmtDist(rem.m));
  /** Elapsed and time left on the top line (workouts with no distance steps). */
  const top = (v, name) => {
    expect(`${name}: elapsed`, v.elapsed, fmtTime(v.s.elapsed));
    expect(`${name}: workout name`, v.name, v.s.name);
    expect(`${name}: time left label`, v.leftK, 'Left');
    expect(`${name}: time left`, v.left, fmtTime(onClock(v.s.segs.at(-1).end - v.s.chartPos, v.s.elapsed)));
  };
  /** The gauge's dot: the target in the middle, ±20% at the ends. */
  const gauge = (v, gt, name) => {
    if (v.gaugeOff) fail(`${name}: power gauge off with a target of ${gt} W`);
    const want = Math.max(0, Math.min(1, (+v.power / gt - 0.8) / 0.4)) * 100;
    // the browser keeps 4 decimals of the style's percentage
    if (Math.abs(parseFloat(v.gaugeAt) - want) > 1e-3) fail(`${name}: gauge dot at ${v.gaugeAt}, expected ${want}% for ${v.power} W of ${gt} W`);
  };
  const gearOf = (gb) => (gb.seq ? gb.label : gb.isDouble ? `${gb.front + 1}×${gb.rear + 1}` : `${gb.rear + 1}`);
  /** The third box in slope mode: the gear, ring × cog and the speed. */
  const gearBox = (v, name) => {
    expect(`${name}: third box label`, v.m3k, 'Gear');
    expect(`${name}: gear`, v.m3, gearOf(v.s.gb));
    expect(`${name}: gear sub line`, v.m3sub, v.s.gb.seq ? `${Math.round(v.s.v * 3.6)} km/h` : `${v.s.gb.ring}×${v.s.gb.cog} · ${Math.round(v.s.v * 3.6)} km/h`);
    if (v.m3cls) fail(`${name}: gear box marked ${v.m3cls}`);
    expect(`${name}: minus button`, v.minus, 'Gear −');
    expect(`${name}: plus button`, v.plus, 'Gear +');
  };
  const pct = (x) => Math.round(x * 100);

  // ERG workout: Sweet spot 3 x 12 (a ramp warm-up, then 12 min at 90% with a cadence target)
  const ss = flatten(SS), cadOf = (g) => (g.cad ? ` · ${g.cad.label}` : '');
  await ride('ERG', fromLibrary(SS.name, 'erg'));
  await run(5000);
  let v = await screen();
  if (!v.phone) fail('the phone ride screen is not the one showing (or the desktop tiles show too)');
  top(v, 'ERG');
  expect('ERG hero label', v.label, ss[0].label);
  expect('ERG hero countdown', v.count, count(v.s.rem, v.s.elapsed));
  if (!(v.s.target >= Math.round(ss[0].from * FTP) && v.s.target <= Math.round(ss[0].to * FTP))) fail(`ERG target ${v.s.target} W outside the ramp`);
  expect('ERG hero target', v.target, `${v.s.target} W`);
  expect('ERG hero sub line', v.targetSub, `${pct(segTarget(ss[0], v.s.progress))}% FTP${cadOf(ss[0])}`);
  if (!v.zc) fail('ERG hero has no zone color');
  gauge(v, v.s.target, 'ERG');
  if (v.powerCls || v.powerSub) fail(`ERG power box marked "${v.powerCls}" "${v.powerSub}" (only slope aims mark it)`);
  expect('ERG third box', [v.m3k, v.m3, v.m3sub, v.m3cls].join('|'), 'Effort|100%|as planned|');
  expect('ERG Next line', v.next, `Next ${fmtTime(ss[1].dur)} @ ${Math.round(ss[1].from * FTP)} W${cadOf(ss[1])} · rep 1/3`);
  expect('no rep counter in the warm-up', v.rep, '');
  if (!v.nextSw) fail('ERG Next line has no zone swatch');
  expect('ERG buttons', [v.minus, v.plus, v.pause].join('|'), '−1%|+1%|Pause');
  if (v.gradeRow || !v.skip || v.lap || !v.erg || v.ergText !== 'ERG off') fail(`ERG sheet buttons: grade ${v.gradeRow}, skip ${v.skip}, lap ${v.lap}, erg ${v.erg} "${v.ergText}"`);
  if (v.noSegs || v.asList || v.viewOn !== 'chart' || !v.chartShown || v.listShown) fail(`ERG view: no-segs ${v.noSegs}, list ${v.asList}, on ${v.viewOn}, chart ${v.chartShown}, list shown ${v.listShown}`);
  expect('ERG view label', v.viewK, `Workout · 0/${ss.length} done`);
  if (v.drawn < 1000) fail(`ERG chart drew ${v.drawn} pixels`);
  // +1% from the plus button: effort box, hero and Next line follow
  await tapBtn('rp-plus');
  v = await screen();
  if (v.s.intensity !== 1.01) fail(`plus button in ERG: effort ${v.s.intensity}`);
  expect('effort box at 101%', [v.m3, v.m3sub, v.m3cls].join('|'), '101%|harder than plan|up');
  expect('ERG hero sub line at 101%', v.targetSub, `${pct(segTarget(ss[0], v.s.progress) * 1.01)}% FTP${cadOf(ss[0])}`);
  expect('ERG Next line at 101%', v.next, `Next ${fmtTime(ss[1].dur)} @ ${Math.round(ss[1].from * FTP * 1.01)} W${cadOf(ss[1])} · rep 1/3`);
  gauge(v, v.s.target, 'ERG at 101%');
  // pause / resume from the middle button
  await tapBtn('rp-pause');
  v = await screen();
  if (!v.s.paused || !v.paused || v.pause !== 'Resume' || v.pausedSub !== 'Tap Resume or press A') fail(`pause button: paused ${v.s.paused}, screen ${v.paused}, "${v.pause}", "${v.pausedSub}"`);
  await tapBtn('rp-pause');
  v = await screen();
  if (v.s.paused || v.paused || v.pause !== 'Pause') fail(`resume button: paused ${v.s.paused}, screen ${v.paused}, "${v.pause}"`);
  ok('phone: ride, ERG: top line, hero card (ramp, countdown, target), power gauge, effort box and Next line at 100% and 101%, pause');

  // the ··· sheet: Close; Skip held 0.4 s does nothing, 1.2 s skips and closes the sheet
  await tapBtn('rp-more');
  if (!(await screen()).sheet) fail('··· did not open the sheet');
  await tapBtn('rp-sheet-close');
  if ((await screen()).sheet) fail('Close did not close the sheet');
  await tapBtn('rp-more');
  if (!(await sheetHold('rp-skip', 400))) fail('sheet Skip did not fill while held');
  v = await screen();
  if (v.s.seg !== 0 || !v.sheet) fail(`sheet Skip let go after 0.4 s: segment ${v.s.seg}, sheet ${v.sheet}`);
  await sheetHold('rp-skip', 1200);
  v = await screen();
  if (v.s.seg !== 1 || v.toast !== 'Skipped' || v.sheet) fail(`sheet Skip held 1.2 s: segment ${v.s.seg}, toast "${v.toast}", sheet ${v.sheet}`);
  await run(3000);
  v = await screen();
  expect('ERG hero label after the skip', v.label, ss[1].label);
  expect('rep counter on rep 1', v.rep, 'Rep1/3');
  expect('ERG hero countdown after the skip', v.count, count(v.s.rem, v.s.elapsed));
  expect('ERG hero target, hold', v.target, `${Math.round(ss[1].from * FTP * 1.01)} W`);
  expect('ERG hero sub line, hold', v.targetSub, `${pct(ss[1].from * 1.01)}% FTP${cadOf(ss[1])}`);
  expect('ERG Next line after the skip', v.next, `Next ${fmtTime(ss[2].dur)} @ ${Math.round(ss[2].from * FTP * 1.01)} W${cadOf(ss[2])}`);
  expect('ERG view label after the skip', v.viewK, `Workout · 1/${ss.length} done`);
  if (v.s.target !== Math.round(ss[1].from * FTP * 1.01)) fail(`ERG target ${v.s.target} after the skip`);
  gauge(v, v.s.target, 'ERG hold');
  // list view: every interval, the current one marked, the done one ticked; remembered; back to the chart
  await page.click('#rp-view-tg button[data-view="list"]'); await run(300);
  v = await screen();
  if (!v.asList || v.viewOn !== 'list' || !v.listShown || v.chartShown) fail(`list view: list ${v.asList}, on ${v.viewOn}, shown ${v.listShown}, chart ${v.chartShown}`);
  if (v.rows !== ss.length || v.current !== 1 || v.checks !== 1) fail(`list view: ${v.rows} rows, current ${v.current}, ${v.checks} ticked`);
  if (await lsGet(page, 'phoneView') !== 'list') fail('list view not remembered');
  await page.click('#rp-view-tg button[data-view="chart"]'); await run(300);
  v = await screen();
  if (v.asList || v.viewOn !== 'chart' || !v.chartShown || v.drawn < 1000) fail(`chart view again: list ${v.asList}, on ${v.viewOn}, ${v.drawn} pixels`);
  if (await lsGet(page, 'phoneView') !== 'chart') fail('chart view not remembered');
  // End: let go after 0.6 s keeps riding, 2.3 s ends the ride (more than 10 s ridden: the done page)
  await tapBtn('rp-more');
  await sheetHold('rp-end', 600);
  if (!(await screen()).s) fail('sheet End let go after 0.6 s ended the ride');
  await sheetHold('rp-end', 2300);
  await page.waitForSelector('#ridepage.active', { timeout: 10000 });
  if (await page.evaluate(() => !!window.rodillo.session)) fail('sheet End held 2.3 s: the session is still there');
  ok('phone: ride, ERG: the ··· sheet (Close, Skip held 1 s), hero after the skip, list view and back, End held 2 s');
  await ctx.close();

  // slope workout (a road): grade hero, gear box, the sheet's grade buttons, a gear from the plus button, the power aim
  const CR = byName('Climb repeats 4 x 6 min at 6%'), cr = flatten(CR), tr = track(cr);
  const roadK = (v) => { const d = trackDist(tr, v.s.segs, v.s.chartPos); return `${(d / 1000).toFixed(1)} of ${(tr.D / 1000).toFixed(1)} km · +${Math.round(trackClimbed(tr, d))} of ${Math.round(tr.ascent / 5) * 5} m`; };
  await ride('slope', fromLibrary(CR.name, 'slope'));
  await run(20000);
  v = await screen();
  if (v.s.mode !== 'sim') fail(`slope workout in ${v.s.mode} mode`);
  top(v, 'slope');
  expect('slope hero label', v.label, cr[0].label);
  expect('slope hero countdown', v.count, count(v.s.rem, v.s.elapsed));
  expect('slope hero target', v.target, `${(cr[0].grade * 100).toFixed(0)}%`);
  expect('slope hero sub line', v.targetSub, `grade, use your gears${cadOf(cr[0])}`);
  if (!v.gaugeOff || v.powerCls || v.powerSub) fail(`warm-up has no aim: gauge off ${v.gaugeOff}, box "${v.powerCls}" "${v.powerSub}"`);
  gearBox(v, 'slope');
  expect('slope Next line', v.next, `Next ${fmtTime(cr[1].dur)} @ ${(cr[1].grade * 100).toFixed(0)}%${cadOf(cr[1])} · rep 1/4`);
  if (!v.gradeRow || !v.skip || v.lap || v.erg) fail(`slope sheet buttons: grade ${v.gradeRow}, skip ${v.skip}, lap ${v.lap}, erg ${v.erg}`);
  expect('slope view label (road)', v.viewK, roadK(v));
  if (v.drawn < 1000) fail(`slope road chart drew ${v.drawn} pixels`);
  const rear0 = v.s.gb.rear;
  await tapBtn('rp-plus');
  v = await screen();
  if (v.s.gb.rear !== rear0 + 1) fail(`Gear + did not shift (rear ${rear0} -> ${v.s.gb.rear})`);
  gearBox(v, 'slope after Gear +');
  await tapBtn('rp-minus');
  if ((await screen()).s.gb.rear !== rear0) fail('Gear − did not shift back');
  await tapBtn('rp-more');
  await tapBtn('rp-gup');
  v = await screen();
  if (Math.abs(v.s.offset - 0.01) > 1e-9 || !v.sheet) fail(`Grade +1%: offset ${v.s.offset}, sheet ${v.sheet}`);
  expect('slope hero target, profile +1%', v.target, `${((cr[0].grade + 0.01) * 100).toFixed(0)}%`);
  expect('slope Next line, profile +1%', v.next, `Next ${fmtTime(cr[1].dur)} @ ${((cr[1].grade + 0.01) * 100).toFixed(0)}%${cadOf(cr[1])} · rep 1/4`);
  await tapBtn('rp-gdown');
  if (Math.abs((await screen()).s.offset) > 1e-9) fail('Grade −1% did not put the profile back');
  await sheetHold('rp-skip', 1200);
  await run(5000);
  v = await screen();
  if (v.s.seg !== 1) fail(`slope: segment ${v.s.seg} after the sheet skip`);
  const aim = cr[1].aim, band = `${Math.round(aim.lo * FTP)}-${Math.round(aim.hi * FTP)} W`;
  expect('slope hero on the climb', v.target, `${(cr[1].grade * 100).toFixed(0)}%`);
  expect('slope hero sub line on the climb', v.targetSub, `grade, aim ${Math.round(aim.mid * FTP)} W${cadOf(cr[1])}`);
  expect('slope Next line on the climb', v.next, `Next ${fmtTime(cr[2].dur)} @ ${(cr[2].grade * 100).toFixed(0)}%${cadOf(cr[2])}`);
  gauge(v, aim.mid * FTP, 'slope aim');
  if (v.s.aim !== null || v.powerCls) fail(`aim while settling: ${v.s.aim}, box "${v.powerCls}"`);
  expect('power sub line while settling', v.powerSub, band);
  expect('slope view label on the climb', v.viewK, roadK(v));
  await run(8000);
  v = await screen();
  if (!v.s.aim) fail('no power aim status 13 s into the climb');
  expect('power box class', v.powerCls, v.s.aim === 'ok' ? 'ok' : 'bad');
  expect('power sub line', v.powerSub, v.s.aim === 'ok' ? band : v.s.aim === 'low' ? '▲ push harder' : '▼ ease off');
  gauge(v, aim.mid * FTP, 'slope aim, settled');
  if (v.s.segs[1].cad) {
    const cs = await page.evaluate(() => window.rodillo.session.cadStatus);
    expect('cadence box class', v.cadCls, cs === 'ok' ? 'ok' : cs ? 'bad' : '');
    expect('cadence sub line', v.cadSub, cs === 'low' ? '▲ faster' : cs === 'high' ? '▼ slower' : v.s.segs[1].cad.label);
  }
  ok('phone: ride, slope workout: grade hero, gear box and Gear +/−, the sheet\'s grade buttons, road label, sheet Skip, power aim on the gauge');
  await ctx.close();

  // a real climb (distance steps): metres on the hero, an estimated time left, the road label past the warm-up roll
  await ride('real climb', fromLibrary(CLIMB.name, 'slope'));
  await run(10000);
  await tapBtn('rp-more');
  await sheetHold('rp-skip', 1200);
  await run(20000);
  v = await screen();
  const g1 = v.s.segs[1], ctr = track(v.s.segs);
  if (v.s.seg !== 1 || !g1.dist) fail(`real climb: segment ${v.s.seg} after the skip`);
  expect('real climb hero label', v.label, g1.label);
  expect('real climb hero, metres left', v.count, fmtDist(v.s.rem.m));
  expect('real climb hero target', v.target, `${(g1.grade * 100).toFixed(0)}%`);
  expect('real climb time left (an estimate)', v.left, `~${fmtTime(onClock(v.s.segs.at(-1).end - v.s.chartPos, v.s.elapsed))}`);
  const lead = CLIMB.profile.lead.length, v0 = ctr.parts[lead].d0, up0 = trackClimbed(ctr, v0), d = trackDist(ctr, v.s.segs, v.s.chartPos);
  expect('real climb road label', v.viewK, `${((d - v0) / 1000).toFixed(1)} of ${((ctr.D - v0) / 1000).toFixed(1)} km · +${Math.round(trackClimbed(ctr, d) - up0)} of ${Math.round((ctr.ascent - up0) / 5) * 5} m`);
  if (v.drawn < 1000) fail(`real climb chart drew ${v.drawn} pixels`);
  ok('phone: ride, real climb: metres left on the hero, ~time left, the road label past the warm-up');
  await ctx.close();

  // free ride: grade hero, distance, no list, the sheet's grade buttons, Lap and the theme switch
  await ride('free ride', async () => { await page.click('#tabs button[data-tab="today"]'); await page.click('#btn-free'); });
  v = await screen();
  expect('free ride hero', [v.label, v.count, v.target, v.targetSub].join('|'), 'Free ride|0.0%||D-pad ▲▼ changes the grade');
  expect('free ride top line', [v.leftK, v.left].join('|'), `Distance|${fmtDist(v.s.dist)}`);
  if (!v.gaugeOff || v.powerSub) fail(`free ride gauge off ${v.gaugeOff}, sub "${v.powerSub}"`);
  if (!v.noSegs || v.asList) fail(`free ride view: no-segs ${v.noSegs}, list ${v.asList}`);
  if (v.gradeRow !== true || v.skip || !v.lap || v.erg) fail(`free ride sheet buttons: grade ${v.gradeRow}, skip ${v.skip}, lap ${v.lap}, erg ${v.erg}`);
  gearBox(v, 'free ride');
  await tapBtn('rp-more');
  await tapBtn('rp-gup'); await tapBtn('rp-gup');
  await run(60000);
  v = await screen();
  expect('free ride hero at 2%', v.count, '2.0%');
  expect('free ride Next line', v.next, `${(v.s.v * 3.6).toFixed(1)} km/h · ${fmtDist(v.s.dist)}`);
  if (v.drawn < 1000) fail(`free ride chart drew ${v.drawn} pixels`);
  await tapBtn('rp-lap');
  if ((await screen()).sheet) fail('Lap did not close the sheet');
  if (await page.evaluate(() => window.rodillo.session.laps.length) !== 1) fail('Lap did not close one lap');
  const theme0 = v.theme;
  await tapBtn('rp-more'); await tapBtn('rp-theme');
  v = await screen();
  if (v.theme === theme0 || v.sheet) fail(`theme switch: ${theme0} -> ${v.theme}, sheet ${v.sheet}`);
  await tapBtn('rp-more'); await tapBtn('rp-theme');
  if ((await screen()).theme !== theme0) fail('theme switch did not switch back');
  ok('phone: ride, free ride: grade hero, distance, no list, Grade +1% twice, Lap, the theme switch');
  await ctx.close();
}

async function run(viewport, label) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport, hasTouch: label === 'phone', isMobile: label === 'phone' });
  // nothing leaves the machine: GitHub, WHOOP and fonts CDNs get an empty answer (rodillo-data's index: the history)
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 404, body: '' }));
  const history = { rides: HISTORY };
  // HISTORY[1]'s ride file, so its ride page loads (and can be deleted); HISTORY[2] has none ("details are in rodillo-data")
  const del = HISTORY[1], delAt = Date.parse(del.start);
  const delDoc = buildRide(Array.from({ length: 120 }, (_, t) => ({ t: delAt + t * 1000, wt: t, power: 200, target: 0, hr: 140, cadence: 90, speed: 8, distance: t * 8, grade: 0 })),
    { name: del.name, ftp: 250, startMs: delAt });
  await mockGitHub(ctx, { get 'index.json'() { return history; }, [`rides/${del.id.slice(0, 4)}/${del.id}.json`]: delDoc });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#today', { state: 'attached' });
  ok(`${label}: app loads`);

  // css/app.css: every media query that splits phone from desktop is PHONE_MQ (js/app.js) or its exact complement,
  // so no screen gets both looks or neither (pointer: none, a 760.5 px window); this layout gets exactly one of them
  const phoneQ = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').match(/PHONE_MQ = matchMedia\('([^']+)'\)/)[1];
  const deskQ = `not (${phoneQ.split(', ').map((q) => `(${q})`).join(' or ')})`;
  const queries = [...fs.readFileSync(path.join(root, 'css/app.css'), 'utf8').matchAll(/@media ([^{]+?) \{/g)].map((m) => m[1]).filter((q) => /pointer|761|760/.test(q));
  const stray = queries.filter((q) => q !== phoneQ && q !== deskQ && !q.startsWith('(pointer: coarse) and (max-height: 520px) and'));
  if (stray.length) throw new Error(`css: media queries that are neither PHONE_MQ nor its complement: ${stray.join(' | ')}`);
  const mq = await page.evaluate(([p, d]) => [matchMedia(p).matches, matchMedia(d).matches], [phoneQ, deskQ]);
  if (mq[0] === mq[1] || mq[0] !== phone) throw new Error(`css (${label}): phone query ${mq[0]}, desktop query ${mq[1]}`);
  ok(`${label}: phone and desktop CSS queries are exact complements, this layout gets one`);

  for (const tab of ['workouts', 'calendar', 'training', 'today']) {
    await page.click(`#tabs button[data-tab="${tab}"]`);
    await page.waitForTimeout(150);
  }
  ok(`${label}: Today, Workouts, Calendar, Training`);

  // Training tab (js/training.js): seeded synced history -> stats card, fitness chart, weekly bars, power curve,
  // time in zones and the rides list; then the history is taken away again and the tab shows its empty state
  // signed out first: a cached history must not show (only the sign-in line), then signed in with a token
  await page.evaluate((idx) => localStorage.setItem('rodillo.remoteIndex', JSON.stringify(idx)), HISTORY);
  await page.click('#tabs button[data-tab="today"]');
  await page.click('#tabs button[data-tab="training"]');
  await page.waitForFunction(() => document.querySelector('#tab-training').classList.contains('locked') && /history is private/.test(document.querySelector('#sync-status').textContent), null, { timeout: 3000 })
    .catch(() => { throw new Error(`training (${label}): not locked signed out`); });
  if (await page.locator('#ride-table [data-ride]').count() || await shownNow(page, '#training-cards')) throw new Error(`training (${label}): cached history shows signed out`);
  await page.evaluate((t) => localStorage.setItem('rodillo.sync', t), TOKEN);
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
  // Delete on a synced ride's page (Nov 25): asks (Cancel keeps it), then it leaves the list at once; the git data API
  // isn't mocked, so rodillo-data's copy waits in pendingDeletes for the next sync
  if (await page.locator('#ride-table [data-del]').count()) fail('the rides list still has its own Delete buttons');
  await page.click(`#ride-table ${phone ? '.rl' : 'tr'}[data-ride="${del.id}"] ${phone ? '.rl-name' : 'td'}`);
  const delBtn = '#rd [data-rd="delete"] >> visible=true'; // desktop: top right; phone: at the bottom
  await page.waitForSelector(`#ridepage.active ${delBtn}`, { timeout: 5000 }).catch(() => fail('no Delete on a synced ride\'s page'));
  const askDel = async () => {
    await page.click(delBtn);
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 3000 });
    const t = await page.textContent('#modal');
    if (!/Delete this ride\?/.test(t) || !/from your synced history in rodillo-data/.test(t)) fail(`delete question: ${t}`);
  };
  await askDel();
  await page.click('#modal-cancel');
  if (!(await page.isVisible('#ridepage.active')) || await lsGet(page, 'pendingDeletes')) fail('Cancel on the delete question still deleted the ride');
  await askDel();
  await page.click('#modal-ok');
  await page.waitForSelector('#home.active', { timeout: 3000 });
  if (await page.getAttribute('#home', 'data-tab') !== 'training') fail('Delete did not go back to the Training tab');
  await page.waitForFunction((id) => !document.querySelector(`#ride-table [data-ride="${id}"]`), del.id, { timeout: 3000 }).catch(() => fail('the deleted ride is still in the list'));
  if (await page.locator(`#ride-table ${phone ? '.rl' : 'tr'}[data-ride]`).count() !== HISTORY.length - 1) fail('Delete removed more than one ride from the list');
  await page.waitForFunction((id) => (JSON.parse(localStorage.getItem('rodillo.pendingDeletes') || '[]')).includes(id), del.id, { timeout: 5000 })
    .catch(() => fail('the failed rodillo-data delete was not queued'));
  // deleted on another device (Nov 25): this device's synced recording leaves once a fresh index lacks it (here, on
  // opening Training); one pushed a minute ago and one never synced stay
  const day = new Date(); day.setHours(6, 0, 0, 0);
  const local = ['gone', 'justPushed', 'notSynced'].map((k, i) => {
    const d = new Date(day.getTime() + i * 36e5);
    return { id: d.getTime(), name: k, status: 'done', demo: false, synced: k !== 'notSynced', ...(k === 'justPushed' ? { syncedTo: DEFAULT_REPO, syncedAt: Date.now() - 6e4 } : {}),
      summary: { ...HISTORY[0], id: `${d.toLocaleDateString('en-CA')}T0${6 + i}00`, start: d.toISOString(), name: `Local ${k}` } };
  });
  const idb = (fn, arg) => page.evaluate(([f, a]) => new Promise((res, rej) => { const o = indexedDB.open('rodillo', 2); o.onsuccess = () => { const t = o.result.transaction('rides', 'readwrite'), st = t.objectStore('rides'); const out = new Function('st', 'a', f)(st, a); t.oncomplete = () => res(out?.result); t.onerror = rej; }; o.onerror = rej; }), [fn, arg]);
  await idb('a.forEach((r) => st.put(r));', local);
  await page.click('#tabs button[data-tab="today"]');
  await page.click('#tabs button[data-tab="training"]');
  // the list redraws asynchronously: wait for the two that stay to show, then for the deleted one to be gone (from the
  // list and from IndexedDB); checking absence first would pass before the seeded rides were drawn at all
  const shows = (id) => `#ride-table [data-ride="${id}"]`;
  await page.waitForFunction((sels) => sels.every((q) => document.querySelector(q)), local.slice(1).map((r) => shows(r.summary.id)), { timeout: 5000 })
    .catch(() => fail('a ride pushed a minute ago or never synced left the list'));
  await page.waitForFunction((q) => !document.querySelector(q), shows(local[0].summary.id), { timeout: 5000 })
    .catch(() => fail('a ride deleted on another device still shows'));
  const keys = await page.evaluate(() => new Promise((res) => { const o = indexedDB.open('rodillo', 2); o.onsuccess = () => { const q = o.result.transaction('rides').objectStore('rides').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
  if (keys.includes(local[0].id) || !keys.includes(local[1].id) || !keys.includes(local[2].id)) fail(`recordings left on this device: ${keys}`);
  await idb('a.forEach((k) => st.delete(k));', local.map((r) => r.id));
  history.rides = [];
  await page.evaluate(() => localStorage.removeItem('rodillo.remoteIndex'));
  await page.click('#tabs button[data-tab="today"]');
  await page.click('#tabs button[data-tab="training"]');
  await page.waitForFunction(() => /No rides yet/.test(document.querySelector('#ride-table').textContent), null, { timeout: 3000 });
  await page.click('#tabs button[data-tab="today"]');
  await page.evaluate(() => localStorage.removeItem('rodillo.sync')); // the rest of the run is signed out, as before
  ok(`${label}: Training: locked signed out; signed in: stats card, fitness chart, weekly bars, power curve, zones and rides from synced history; Delete on a ride page (Cancel keeps it, then gone from the list and queued for rodillo-data); a ride deleted on another device leaves this one`);

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
      ['ride', '#set-pain', 'painVision', 'subtle', 'subtle', orig.painVision || 'full'],
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

    // Export .FIT from the done page: the file is named after the local day the ride was ridden
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#rd [data-rd="fit"] >> nth=0')]);
    const day = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    if (!new RegExp(`^rodillo-${day}-[a-z0-9-]+\\.fit$`).test(dl.suggestedFilename())) throw new Error(`.FIT file named ${dl.suggestedFilename()}, expected rodillo-${day}-<name>.fit`);
    ok(`${label}: Export .FIT from the done page, named by the local day`);
  }
  await ctx.close();
}


// ---- WebKit (Safari, Bluefy) can run app.js before css/app.css has loaded (WebKit bug 261655), as after every deploy.
// Chrome waits, so make it act like WebKit: the stylesheet arrives 1.5 s late and doesn't block scripts. Every chart color
// is read from CSS; read too early they came back blank and the charts drew black (Nov 18). Fail on any pure black pixel.
async function lateCssRun(viewport, label) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label} late css: ${e.message}`));
  await page.route('**/rodillo/', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/<link rel="stylesheet" href="([^"]+)">/, '<link rel="stylesheet" href="$1" media="none" onload="this.media=\'all\'">') });
  });
  await page.route('**/css/app.css*', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.goto(base);
  await page.waitForSelector('#btn-demo', { state: 'attached' });
  await page.waitForTimeout(2000);
  await page.click('#btn-devices'); await page.click('#btn-demo'); await page.keyboard.press('Escape');
  await page.click('#btn-free'); await page.waitForSelector('#ride.active');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(400); }
  await page.waitForTimeout(1500);
  const black = await page.evaluate((sel) => {
    const c = document.querySelector(sel), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, drawn = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) drawn++; if (!d[i] && !d[i + 1] && !d[i + 2] && d[i + 3] > 200) n++; }
    return { n, drawn };
  }, phone ? '#rp-chart' : '#r-chart');
  if (!black.drawn) throw new Error(`${label} late css: the free ride chart drew nothing`);
  if (black.n) throw new Error(`${label} late css: ${black.n} pure black pixels in the free ride chart (colors read before the CSS loaded)`);
  ok(`${label}: stylesheet arriving after app.js (WebKit): free ride chart in its real colors`);
  await ctx.close();
}

try {
  await run({ width: 1280, height: 800 }, 'desktop');
  await run({ width: 390, height: 844 }, 'phone');
  await mineRun();
  await todayRun({ width: 1280, height: 800 }, 'desktop');
  await todayRun({ width: 390, height: 844 }, 'phone');
  await controlsRun({ width: 1280, height: 800 }, 'desktop');
  await controlsRun({ width: 390, height: 844 }, 'phone');
  await rideRun();
  await phoneRideRun();
  await lateCssRun({ width: 1280, height: 800 }, 'desktop');
  await lateCssRun({ width: 390, height: 844 }, 'phone');
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('Errors in the page:\n' + errors.join('\n')); process.exit(1); }
console.log(`smoke: ${n} checks passed`);
