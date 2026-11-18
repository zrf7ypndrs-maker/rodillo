// Browser smoke test: the whole app in Chrome, demo trainer, no Bluetooth or network.
// Opens every home screen and panel, rides a demo workout (start, skip, end), opens the ride page,
// and fails on any uncaught error or console error. Covers js/app.js, which the unit tests don't load.
// Needs Chrome: CHROME_PATH, or /usr/bin/google-chrome (GitHub's ubuntu-latest has it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

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

async function run(viewport, label) {
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

  if (label === 'desktop') {
    for (const btn of ['#btn-settings', '#btn-controls', '#btn-garage', '#btn-devices']) {
      await page.click(btn);
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    ok(`${label}: Settings, Controls, Garage, Connections open and close`);

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
