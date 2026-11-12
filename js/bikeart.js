// Side-view line drawings of bikes for the Garage tiles (ink only, currentColor; no brands or logos).
// One builder, a few kinds: 'mtb-fs' (full-suspension 29er, the Lux Trail), 'aero' (aero road, deep rims, the
// Aeroad), 'road', 'gravel', 'mtb-ht' (hardtail). viewBox 0 0 200 120, wheels at y 82.

const KINDS = {
  'mtb-fs': { flat: true, fork: 'sus', rear: 'fs', tire: 4.2, dropper: true },
  'mtb-ht': { flat: true, fork: 'sus', rear: 'ht', tire: 4 },
  aero: { flat: false, fork: 'rigid', rear: 'drop', tire: 2.4, deep: 4.6, aero: true },
  road: { flat: false, fork: 'rigid', rear: 'road', tire: 2.4 },
  gravel: { flat: false, fork: 'rigid', rear: 'road', tire: 3.4, flare: true },
};

const R = 32, RY = 82, RX = 44, FX = 158; // wheel radius, axle height, rear and front axle x

function wheel(x, k) {
  const tireR = R - k.tire / 2;
  let s = `<circle cx="${x}" cy="${RY}" r="${tireR}" stroke-width="${k.tire}"/>`;
  if (k.deep) s += `<circle cx="${x}" cy="${RY}" r="${tireR - k.tire / 2 - 2.4 - k.deep / 2}" stroke-width="${k.deep}"/>`; // deep carbon rim
  else s += `<circle cx="${x}" cy="${RY}" r="${tireR - k.tire / 2 - 1.8}" stroke-width="1.1"/>`;
  return s + `<circle cx="${x}" cy="${RY}" r="1.8" stroke-width="2"/>`;
}

/** SVG markup for a bike kind (unknown kinds draw a road bike). */
export function bikeArt(kind = 'road', cls = 'bike-art') {
  const k = KINDS[kind] || KINDS.road;
  const mtb = k.flat;
  const bb = mtb ? [97, 88] : [99, 87];
  const seatTop = mtb ? [84, 42] : [88, 42];
  const htTop = mtb ? [139, 43] : [141, 40];
  const htBot = mtb ? [145, 58] : [144, 55];
  const ttSeat = mtb ? [86, 50] : [89, 45];
  const tube = k.aero ? 3.6 : mtb ? 3.2 : 2.6;
  const P = (a) => a.join(' ');
  let s = wheel(RX, k) + wheel(FX, k);
  // rear triangle: chainstay and seatstay (low on aero bikes; to a rocker link on the full-suspension)
  const stayTop = k.rear === 'drop' ? [92, 59] : k.rear === 'fs' ? [83, 56] : [seatTop[0] + 1.5, seatTop[1] + 9];
  s += `<path d="M${P(bb)}L${RX} ${RY}L${P(stayTop)}" stroke-width="${tube - 0.6}"/>`;
  // main frame
  s += `<path d="M${P(bb)}L${P(seatTop)}" stroke-width="${tube}"/>`;
  s += `<path d="M${P(ttSeat)}L${P(htTop)}" stroke-width="${tube}"/>`;
  s += `<path d="M${P(htTop)}L${P(htBot)}" stroke-width="${tube + 1.4}"/>`;
  s += `<path d="M${P(bb)}L${P(htBot)}" stroke-width="${tube + (k.aero ? 1.6 : 0.8)}"/>`;
  if (k.rear === 'fs') {
    // rocker on the seat tube, shock from the rocker down to the down tube
    s += `<path d="M${P(stayTop)}L95 52" stroke-width="2.6"/>`;
    s += `<path d="M95 52L112 70" stroke-width="2.4"/><path d="M95 52L103 60.5" stroke-width="5.2"/>`;
  }
  // fork
  if (k.fork === 'sus') s += `<path d="M${P(htBot)}L${htBot[0] + 4} ${htBot[1] + 12}" stroke-width="4.6"/><path d="M${htBot[0] + 3.5} ${htBot[1] + 10}L${FX} ${RY}" stroke-width="2.8"/>`;
  else s += `<path d="M${P(htBot)}Q${htBot[0] + 3} ${htBot[1] + 16} ${FX} ${RY}" stroke-width="${k.aero ? 3.4 : 2.6}"/>`;
  // seatpost and saddle
  const post = [seatTop[0] - 2.5, seatTop[1] - (k.dropper ? 14 : 11)];
  s += `<path d="M${P(seatTop)}L${P(post)}" stroke-width="${k.dropper ? 3 : 2.4}"/>`;
  s += `<path d="M${post[0] - 10} ${post[1] - 1.2}C${post[0] - 3} ${post[1] - 2.4} ${post[0] + 4} ${post[1] - 2.2} ${post[0] + 8} ${post[1] - 0.6}" stroke-width="3"/>`;
  // stem and bars
  if (mtb) s += `<path d="M${P(htTop)}L${htTop[0] + 1} ${htTop[1] - 5}L${htTop[0] + 8} ${htTop[1] - 6.5}" stroke-width="2.8"/><path d="M${htTop[0] + 6} ${htTop[1] - 6}l3 -4.5" stroke-width="3.4"/>`;
  else {
    const sx = htTop[0] + 11, sy = htTop[1] - 3;
    s += `<path d="M${htTop[0] - 0.5} ${htTop[1] - 3}L${sx} ${sy}" stroke-width="2.8"/>`;
    s += `<path d="M${sx} ${sy}c5 0 7.5 2 7.5 6c0 5 ${k.flare ? '1.5 8.5' : '-1 8'} -6 9" stroke-width="2.6"/>`;
  }
  // crank and chainring
  s += `<circle cx="${bb[0]}" cy="${bb[1]}" r="${mtb ? 6 : 8}" stroke-width="1.8"/>`;
  s += `<path d="M${bb[0]} ${bb[1]}L${bb[0] + 6} ${bb[1] + 13}" stroke-width="2.8"/>`;
  return `<svg class="${cls}" viewBox="0 0 200 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${s}</g></svg>`;
}

/** The drawing for a garage bike: its model's, else from its weight spec or gearing. */
export function bikeKind(b, d) {
  if (b.art) return b.art;
  const t = b.bikeSpec?.type;
  if (t === 'aero') return 'aero';
  if (t === 'gravel' || t === 'cx') return 'gravel';
  if (['xc', 'trail', 'enduro', 'dh'].includes(t)) return (b.bikeSpec.rear || 0) > 0 ? 'mtb-fs' : 'mtb-ht';
  if (t) return 'road';
  if (d && !d.seq && d.wheel >= 2.29) return 'mtb-fs';
  if (d && !d.seq && d.wheel >= 2.15) return 'gravel';
  return 'road';
}
