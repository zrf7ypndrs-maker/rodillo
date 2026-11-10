// Coach's review: node tools/review.mjs <path-to-rodillo-data> [days=28]
// Prints load, recent rides, interval compliance and decoupling so the plan can be adjusted.
import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, weekly, powerCurve, ftpEstimate, formLabel, zoneTotals } from '../js/stats.js';

const dir = process.argv[2] || '../rodillo-data';
const days = Number(process.argv[3] || 28);
const rides = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).rides.filter((r) => r.source !== 'demo');
if (!rides.length) { console.log('No rides yet.'); process.exit(0); }

const today = loadSeries(rides).at(-1);
console.log(`Load today: CTL ${today.ctl}  ATL ${today.atl}  TSB ${today.tsb} (${formLabel(today.tsb)})`);
console.log('Weeks:', weekly(rides, 6).map((w) => `${w.start}: ${w.hours}h/${w.tss}TSS/${w.rides}r`).join(' | '));
console.log('FTP estimates:', ftpEstimate(rides), ' power curve 90d:', powerCurve(rides, 90));
{
  const z = zoneTotals(rides.filter((r) => Date.now() - Date.parse(r.start) < 28 * 864e5)), tot = z.reduce((a, b) => a + b, 0);
  if (tot) console.log('Time in zones, 28d (Coggan Z1-Z7):', z.map((s, i) => `Z${i + 1} ${Math.round(s / 60)}min ${Math.round((s / tot) * 100)}%`).join('  '));
}
console.log(`\nLast ${days} days:`);
const since = Date.now() - days * 864e5;
for (const r of rides.filter((x) => Date.parse(x.start) >= since)) {
  const c = r.compliance ? ` compliance ${r.compliance.avg}% (min ${r.compliance.min}%, ${r.compliance.reps} reps)` : '';
  const d = r.decoupling != null ? ` drift ${r.decoupling}%` : '';
  console.log(`${r.id}  ${r.name.padEnd(32)} ${Math.round(r.durSec / 60)}min NP ${r.np ?? "-"} IF ${r.if ?? "-"} TSS ${r.tss}${r.tssFrom === "hr" ? " (HR)" : ""} HR ${r.avgHr ?? '-'}${c}${d}  [ftp ${r.ftp}]`);
}

const wpath = path.join(dir, 'whoop', 'daily.json');
if (fs.existsSync(wpath)) {
  const days = Object.entries(JSON.parse(fs.readFileSync(wpath, 'utf8')).days).slice(-14);
  console.log('\nWHOOP (last 14 days):');
  for (const [d, v] of days) console.log(`${d}  recovery ${v.recovery ?? '-'}%  HRV ${v.hrv ?? '-'}  RHR ${v.rhr ?? '-'}  sleep ${v.sleepHours ?? '-'}h`);
}
