// GPX routes: parse, smooth elevation, look up grade by distance.

const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export function parseGpx(xml) {
  const name = (xml.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || 'Route';
  const pts = [];
  const re = /<(?:trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const lat = Number((m[1].match(/lat\s*=\s*"([^"]+)"/) || [])[1]);
    const lon = Number((m[1].match(/lon\s*=\s*"([^"]+)"/) || [])[1]);
    const ele = Number(((m[2] || '').match(/<ele>([^<]+)<\/ele>/) || [])[1] || NaN);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon, ele });
  }
  return buildRoute(name.trim(), pts);
}

export function buildRoute(name, pts) {
  if (pts.length < 2) throw new Error('Route needs at least 2 points');
  // cumulative distance
  let d = 0;
  const raw = pts.map((p, i) => {
    if (i) d += haversine(pts[i - 1], p);
    return { d, ele: Number.isFinite(p.ele) ? p.ele : 0 };
  });
  // resample every 10 m, then smooth elevation over ~60 m to kill GPS noise
  const step = 10, total = raw[raw.length - 1].d;
  const samples = [];
  let j = 0;
  for (let x = 0; x <= total; x += step) {
    while (j < raw.length - 2 && raw[j + 1].d < x) j++;
    const a = raw[j], b = raw[j + 1];
    const f = b.d > a.d ? (x - a.d) / (b.d - a.d) : 0;
    samples.push(a.ele + (b.ele - a.ele) * Math.min(1, Math.max(0, f)));
  }
  const w = 3;
  const ele = samples.map((_, i) => {
    let s = 0, n = 0;
    for (let k = i - w; k <= i + w; k++) if (k >= 0 && k < samples.length) { s += samples[k]; n++; }
    return s / n;
  });
  const grade = ele.map((e, i) => {
    const a = Math.max(0, i - 1), b = Math.min(ele.length - 1, i + 1);
    const g = b > a ? (ele[b] - ele[a]) / ((b - a) * step) : 0;
    return Math.max(-0.25, Math.min(0.25, g));
  });
  let gain = 0;
  for (let i = 1; i < ele.length; i++) gain += Math.max(0, ele[i] - ele[i - 1]);
  return { name, step, total, ele, grade, gain };
}

export function routeAt(route, dist) {
  const i = Math.min(route.grade.length - 1, Math.max(0, Math.floor(dist / route.step)));
  return { grade: route.grade[i], ele: route.ele[i], done: dist >= route.total };
}
