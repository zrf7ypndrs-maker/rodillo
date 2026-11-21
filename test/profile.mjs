// Workout profiles and the meta line (js/profile.js): the pure parts. Expectations written out by hand at FTP 200
// (or read off the engine's own flatten() / track(), never off the module). bindProfileHover is in test/profile-dom.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  rampStops, previewOf, ELEV_MIN, ascentText, trackSvg, profileSvg, isSim, woMeta, workSummary, tipTarget, riseHtml,
  profileHit, profileTip, profileMid, tipLeft,
} from '../js/profile.js';
import { flatten, track, totalDuration, estimateTSS, mainSet } from '../js/engine/workout.js';
import { zoneOf } from '../js/zones.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const root = path.resolve(new URL('..', import.meta.url).pathname);
const W = (id) => JSON.parse(fs.readFileSync(path.join(root, 'workouts', `${id}.json`), 'utf8'));
const zoneHex = (f) => `Z${zoneOf(f) + 1}`, gradeHex = (g) => `G${Math.round(g * 1000)}`;
const look = { ftp: 200, zoneHex, gradeHex };
const r3 = (x) => Math.round(x * 1000) / 1000;
/** The chart's shapes: tag, data-i, fill and the points (rounded), in order. */
const shapes = (svg) => [...svg.matchAll(/<(polygon|rect|polyline)([^>]*)\/>/g)].map(([, tag, a]) => {
  const at = Object.fromEntries([...a.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  const pts = at.points ? at.points.trim().split(/\s+/).map((p) => p.split(',').map((x) => r3(+x))) : [r3(+at.x), r3(+at.y), r3(+at.width), r3(+at.height)];
  return { tag, i: at['data-i'], fill: at.fill, pts, cls: at.class };
});

// ---- ramp color stops
const st = (a) => a.map(([o, c]) => [r3(o), c]);
assert.deepEqual(st(rampStops(0.5, 1.0, zoneHex)), [[0, 'Z1'], [0.1, 'Z1'], [0.1, 'Z2'], [0.5, 'Z2'], [0.5, 'Z3'], [0.8, 'Z3'], [0.8, 'Z4'], [1, 'Z4']], 'cut at 55, 75 and 90% FTP');
assert.deepEqual(st(rampStops(1.0, 0.5, zoneHex)), [[0, 'Z4'], [0.2, 'Z4'], [0.2, 'Z3'], [0.5, 'Z3'], [0.5, 'Z2'], [0.9, 'Z2'], [0.9, 'Z1'], [1, 'Z1']], 'a ramp down, hardest first');
assert.deepEqual(st(rampStops(0.6, 0.7, zoneHex)), [[0, 'Z2'], [1, 'Z2']], 'inside one zone');
assert.deepEqual(st(rampStops(0.5, 0.55, zoneHex)), [[0, 'Z1'], [1, 'Z1']], 'ending on a zone edge: no cut');
assert.deepEqual(st(rampStops(1.4, 1.7, zoneHex)), [[0, 'Z6'], [r3(1 / 3), 'Z6'], [r3(1 / 3), 'Z7'], [1, 'Z7']], 'past 150%: Z7 (it shares Z6\'s color in app.js)');
assert.deepEqual(rampStops(0.5, 1.0, (f) => `#${f.toFixed(3)}`).map(([, c]) => c), ['#0.525', '#0.525', '#0.650', '#0.650', '#0.825', '#0.825', '#0.950', '#0.950'], 'each stretch takes the color of its middle');
ok('ramp stops: zone cuts in order, either direction, colors from each stretch\'s middle');

// ---- previews, meta line, main set
const climb = W('climb-el-durazno'), lead = climb.profile.lead.length;
assert.equal(previewOf(climb).steps.length, climb.steps.length - lead, 'a real climb\'s preview leaves out its warm-up');
assert.deepEqual(previewOf(climb).steps, climb.steps.slice(lead));
assert.equal(previewOf(climb).id, climb.id);
const ss = W('sweetspot-3x12');
assert.equal(previewOf(ss), ss, 'anything else is drawn as it is');
assert.equal(previewOf(null), null);
assert.equal(previewOf({ steps: [{ dur: 60, power: 0.5 }], profile: { lead: [] } }).steps.length, 1);

const erg = { steps: [{ dur: 1800, power: 0.75 }] };
assert.equal(woMeta(erg), `<span class="n">30</span> min &middot; TSS <span class="n">~${estimateTSS(erg)}</span>`);
assert.equal(woMeta({ steps: [{ dur: 1770, power: 0.75 }] }), `<span class="n">30</span> min &middot; TSS <span class="n">~${estimateTSS({ steps: [{ dur: 1770, power: 0.75 }] })}</span>`, 'minutes rounded');
const byDist = { steps: [{ dur: 600, power: 0.6 }, { dist: 5000, power: 0.8 }] };
assert.equal(woMeta(byDist), `<span class="n">~${Math.round(totalDuration(byDist) / 60)}</span> min &middot; <span class="n">5</span> km`, 'distance steps: ~time and km, no TSS');
assert.equal(woMeta({ steps: [{ dist: 1234, power: 0.8 }] }).split('&middot; ')[1], '<span class="n">1.2</span> km');
const mixed = { steps: [{ dur: 600, power: 0.6 }, { dur: 600, grade: 4 }] };
assert.equal(woMeta(mixed), '<span class="n">20</span> min', 'ERG and slope mixed: no TSS');
const road = { steps: [{ dur: 300, grade: 0 }, { dist: 1000, grade: 5 }, { dur: 200, grade: -2 }] };
const asc = track(flatten(road)).ascent; // 50 m
assert.equal(woMeta(road), `<span class="n">~${Math.round(totalDuration(road) / 60)}</span> min &middot; +${Math.round(asc / 5) * 5} m`, 'slope-only with a distance step: ~time and the ascent');
assert.equal(woMeta({ steps: [{ dur: 600, grade: 3 }] }), `<span class="n">10</span> min &middot; ${ascentText(track(flatten({ steps: [{ dur: 600, grade: 3 }] })).ascent)}`, 'timed road: no ~');
assert.deepEqual([ascentText(87), ascentText(87.6), ascentText(0), ascentText(1234)], ['+85 m', '+90 m', '+0 m', '+1235 m'], 'ascent to 5 m');
assert.deepEqual([isSim(erg), isSim(mixed), isSim(road), isSim({ steps: [] })], [false, true, true, false]);
assert.equal(workSummary(ss, 200), mainSet(ss, 200));
assert.equal(workSummary(ss, 300), mainSet(ss, 300));
assert.notEqual(workSummary(ss, 200), workSummary(ss, 300), 'at the FTP it is given');
assert.equal(workSummary(ss, 200).replace(/\s/g, ' '), '3 x 12 min at 180 W', 'Sweet spot at 90% of 200 W');
ok('previews (a real climb without its warm-up), meta line (ERG, distance, mixed, roads, ascent), main set at the FTP given');

// ---- the ERG / mixed profile chart
const mix = { steps: [{ dur: 600, power: 0.5 }, { dur: 300, from: 0.5, to: 1.0 }, { dur: 150, power: 2.0 }, { dur: 75, grade: 6 }, { dur: 75, grade: -5 }] }; // 1200 s
const svg = profileSvg(mix, look, 1200, 150);
assert.match(svg, /^<svg class="profile" viewBox="0 0 1200 150" preserveAspectRatio="none">/);
const sh = shapes(svg);
assert.deepEqual(sh.map((x) => [x.tag, x.i]), [['polygon', '0'], ['polygon', '1'], ['polygon', '2'], ['rect', '3'], ['rect', '4']], 'one shape per step, by index');
assert.deepEqual(sh[0].pts, [[0, 150], [0, 100], [600, 100], [600, 150]], 'steady 50%: a third of 150% FTP tall');
assert.equal(sh[0].fill, 'Z1');
assert.deepEqual(sh[1].pts, [[600, 150], [600, 100], [900, 50], [900, 150]], 'ramp 50 -> 100%');
const id = sh[1].fill.match(/^url\(#(rmp\d+)\)$/)?.[1];
assert.ok(id, `the ramp is filled by a gradient, ${sh[1].fill}`);
assert.match(svg, new RegExp(`<defs><linearGradient id="${id}"><stop offset="0" stop-color="Z1"/><stop offset="0.1\\d*" stop-color="Z1"/><stop offset="0.1\\d*" stop-color="Z2"/><stop offset="0.5" stop-color="Z2"/><stop offset="0.5" stop-color="Z3"/><stop offset="0.8\\d*" stop-color="Z3"/><stop offset="0.8\\d*" stop-color="Z4"/><stop offset="1" stop-color="Z4"/></linearGradient></defs><polygon data-i="1"`), 'its stops, just before it');
assert.deepEqual([sh[2].pts, sh[2].fill], [[[900, 150], [900, 0], [1050, 0], [1050, 150]], 'Z7'], '200% is drawn at the top (150%), colored by its own zone');
assert.deepEqual([sh[3].pts, sh[3].fill], [[1050, 60, 75, 90], 'G60'], 'a 6% slope step: (6 + 3) / 15 of the height');
assert.deepEqual([sh[4].pts, sh[4].fill], [[1125, 146, 75, 4], 'G-50'], 'downhill: at least 4 tall');
assert.ok(sh.every((x) => x.cls === undefined) && (svg.match(/opacity="\.9"/g) || []).length === 5);
const id2 = shapes(profileSvg(mix, look, 1200, 150))[1].fill;
assert.notEqual(id2, sh[1].fill, 'every chart gets its own gradient ids (several charts on one page)');
// defaults, the rider's FTP for watts steps, tiny steps, the preview
assert.match(profileSvg(erg, look), /viewBox="0 0 340 54"/, '340 x 54 by default (library rows)');
const watts = { steps: [{ dur: 600, watts: 150 }] };
assert.deepEqual(shapes(profileSvg(watts, look, 600, 150))[0].pts, [[0, 150], [0, 75], [600, 75], [600, 150]], '150 W at FTP 200 = 75%');
assert.deepEqual(shapes(profileSvg(watts, { ...look, ftp: 300 }, 600, 150))[0].pts, [[0, 150], [0, 100], [600, 100], [600, 150]], '150 W at FTP 300 = 50%');
assert.equal(shapes(profileSvg({ steps: [{ dur: 3599, power: 0.5 }, { dur: 1, power: 1 }] }, look, 360, 54))[1].pts[2][0], r3(359.9 + 0.5), 'a step thinner than half a unit is drawn half a unit wide');
assert.equal(shapes(profileSvg(climb, look)).filter((x) => x.tag === 'polygon').length, flatten({ ...climb, steps: climb.steps.slice(lead) }).length, 'a real climb is drawn without its warm-up');
assert.equal(profileSvg({ steps: [] }, look), '<svg class="profile" viewBox="0 0 340 54" preserveAspectRatio="none"></svg>', 'nothing to draw');
ok('profile chart: steps by zone, ramps as gradients with their own ids, 150% cap, slope bars, FTP for watts, minimum width, preview');

// ---- slope-only roads (trackSvg through profileSvg)
const rs = flatten(road, 200), tr = track(rs);
const rsvg = profileSvg(road, look, 1000, 100), rsh = shapes(rsvg);
assert.equal(rsvg, trackSvg(rs, 1000, 100, look), 'slope-only workouts draw the road');
assert.deepEqual(rsh.map((x) => [x.tag, x.i, x.fill]), [['polygon', '0', 'G0'], ['polygon', '1', 'G50'], ['polygon', '2', 'G-20'], ['polyline', undefined, undefined]], 'a band per stretch in its grade color, the ink line last');
assert.equal(rsh[3].cls, 'prof-line');
// 50 m climbed is under ELEV_MIN (60 m), so the road is drawn 60 m tall: top 6, floor 14 (100 px chart)
assert.equal(ELEV_MIN, 60);
const X = (d) => r3(+((d / tr.D) * 1000).toFixed(1));
const y50 = r3(+(6 + (1 - 50 / 60) * 80).toFixed(1)); // 19.3
assert.deepEqual(rsh[0].pts, [[0, 100], [0, 86], [r3(X(tr.parts[0].d1) + 0.3), 86], [r3(X(tr.parts[0].d1) + 0.3), 100]], 'flat start on the floor line, 0.3 overlap so no hairline gaps');
assert.deepEqual(rsh[1].pts, [[X(tr.parts[1].d0), 100], [X(tr.parts[1].d0), 86], [r3(X(tr.parts[1].d1) + 0.3), y50], [r3(X(tr.parts[1].d1) + 0.3), 100]], 'the climb up to 50 m of 60');
assert.equal(rsh[2].pts[3][0], r3(1000 + 0.3), 'the last band reaches the right edge');
assert.deepEqual(rsh[3].pts.at(-1), [1000, r3(+(6 + (1 - tr.parts[2].h1 / 60) * 80).toFixed(1))], 'the line ends at the right edge');
assert.equal(rsh[3].pts.length, 4);
const flat = shapes(profileSvg({ steps: [{ dur: 600, grade: 0 }] }, look, 1000, 100));
assert.deepEqual(flat[0].pts.map((p) => p[1]), [100, 86, 86, 100], 'a flat road stays on the floor line');
const big = { steps: [{ dur: 600, grade: 0 }, { dist: 3000, grade: 8 }] }, bt = track(flatten(big));
assert.ok(bt.hi - bt.lo > ELEV_MIN);
assert.equal(shapes(profileSvg(big, look, 1000, 100))[1].pts[2][1], 6, 'a big climb reaches the top line');
ok('roads: a band per stretch by grade over distance, the ink line, 60 m minimum height, floor and top lines');

// ---- the readout's parts
const ws = flatten({ steps: [{ dur: 600, power: 0.5, label: 'Warm <up>' }, { repeat: 2, steps: [{ dur: 120, power: 1.1, cadence: '95-100', label: 'On' }, { dur: 60, power: 0.5 }] }, { dur: 300, from: 0.5, to: 1.0 }, { dur: 300, grade: 6 }] }, 200); // 1560 s
assert.deepEqual([0, 0.2, 600 / 1560, 719.9 / 1560, 720 / 1560, 0.99, 1, 1.5, -0.2].map((f) => profileHit(f, ws, null)), [0, 0, 1, 1, 2, 6, 6, 6, 0], 'a finger: by time, clamped to the chart');
assert.deepEqual([0, 0.4, 0.5, 0.61, 1].map((f) => profileHit(f, rs, tr)), [0, 0, 1, 2, 2], 'on a road: by distance'); // parts end at 44.6% and 60.7% of the road
assert.equal(profileHit(0.4, rs, null), 1, 'the same road by time');
assert.equal(profileTip(ws, 0, 200, null), `<div class="pt-lbl">Warm &lt;up&gt;</div>
        <div class="pt-tgt">100 W <span>50% FTP</span></div>
        <div class="pt-time">10:00<br><span>0:00 to 10:00</span></div>`);
assert.equal(profileTip(ws, 3, 200, null), `<div class="pt-lbl">On &middot; 2 of 2</div>
        <div class="pt-tgt">220 W <span>110% FTP</span></div>
        <div class="pt-time">2:00 &middot; 95-100 rpm<br><span>13:00 to 15:00</span></div>`, 'a rep, with its cadence');
assert.match(profileTip(ws, 4, 300, null), /<div class="pt-lbl">Recovery &middot; 2 of 2<\/div>\s*<div class="pt-tgt">150 W <span>50% FTP/, 'watts at the FTP given');
assert.match(profileTip(ws, 5, 200, null), /<div class="pt-tgt">100-200 W <span>50-100% FTP<\/span><\/div>/, 'a ramp: both ends');
assert.match(profileTip(ws, 6, 200, null), /<div class="pt-lbl">6% climb<\/div>\s*<div class="pt-tgt">6% grade<\/div>/, 'a slope step: grade, no % FTP');
const rise1 = Math.round(tr.parts[1].h1 - tr.parts[1].h0), rise2 = Math.round(tr.parts[2].h1 - tr.parts[2].h0);
assert.deepEqual([rise1, rise2], [50, -49]);
assert.equal(profileTip(rs, 1, 200, tr), `<div class="pt-lbl">5% climb</div>
        <div class="pt-tgt">5% grade <span>+50 m</span></div>
        <div class="pt-time">1.00 km (~4:28)<br><span>5:00 to 9:28</span></div>`, 'a distance stretch on a road: metres up, km and ~time');
assert.match(profileTip(rs, 2, 200, tr), /<div class="pt-tgt">-2% grade <span>&minus;49 m<\/span><\/div>/, 'downhill');
assert.match(profileTip(rs, 0, 200, tr), /<div class="pt-tgt">0% grade<\/div>/, 'flat: no height');
assert.match(profileTip(flatten({ steps: [{ dist: 850, grade: 2, label: 'x' }] }), 0, 200, null), /850 m \(~/);
assert.match(profileTip(flatten({ steps: [{ dur: 60, power: 0.5, cadence: '<90' }] }), 0, 200, null), /&lt;90 rpm/, 'cadence escaped');
assert.deepEqual([tipTarget({ kind: 'erg', from: 1.08, to: 1.08 }, 200), tipTarget({ kind: 'erg', from: 0.5, to: 1 }, 200), tipTarget({ kind: 'erg', from: 0.333, to: 0.333 }, 200)], ['216 W', '100-200 W', '67 W']);
assert.deepEqual([tipTarget({ kind: 'sim', grade: 0.07 }), tipTarget({ kind: 'sim', grade: 0.075 }), tipTarget({ kind: 'sim', grade: -0.02 }), tipTarget({ kind: 'sim', free: true, grade: 0 })], ['7% grade', '7.5% grade', '-2% grade', 'Free ride']);
assert.deepEqual([riseHtml({ h0: 100, h1: 190 }), riseHtml({ h0: 100, h1: 88 }), riseHtml({ h0: 5, h1: 5.4 }), riseHtml({ h0: 5, h1: 5.6 })], [' <span>+90 m</span>', ' <span>&minus;12 m</span>', '', ' <span>+1 m</span>']);
assert.deepEqual([profileMid(ws, 0, null), profileMid(ws, 6, null)].map(r3), [r3(300 / 1560), r3(1410 / 1560)], 'the middle of a stretch, by time');
assert.equal(r3(profileMid(rs, 1, tr)), r3((tr.parts[1].d0 + tr.parts[1].d1) / 2 / tr.D), 'by distance on a road');
assert.deepEqual([tipLeft(500, 60, 1000), tipLeft(20, 60, 1000), tipLeft(990, 60, 1000), tipLeft(-5, 60, 1000)], [500, 60, 940, 60], 'kept inside the chart');
ok('readout parts: which stretch a finger is on, the text (label, rep, watts, % FTP, grade, height, length, cadence, times), where it goes');

console.log(`profile: ${n} tests passed`);
