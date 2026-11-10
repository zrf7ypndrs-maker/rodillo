// Workouts Agustín builds in the app (workout builder). Stored in rodillo-data `workouts/mine.json`
// so the Mac and the phone share them, and the coach can schedule them by id.
//
// File: { version: 1, workouts: [ {...workout, updatedAt} ], deleted: { id: isoTime } }
// Each device keeps changes it hasn't written yet in localStorage `rodillo.minePending`:
// { id: { w: workout | null (deleted), at: isoTime } }. Newest change wins, per workout.

export const MINE_PATH = 'workouts/mine.json';
export const emptyMine = () => ({ version: 1, workouts: [], deleted: {} });

const stampOf = (doc, id) => {
  const w = doc.workouts.find((x) => x.id === id);
  return [w?.updatedAt || '', doc.deleted?.[id] || ''].sort().at(-1);
};

/** Writes pending changes into doc (in place) unless the file has a newer change for that workout. Returns the ids handled. */
export function applyMinePending(doc, pending) {
  doc.workouts ||= [];
  doc.deleted ||= {};
  const handled = [];
  for (const [id, x] of Object.entries(pending)) {
    handled.push(id);
    if (stampOf(doc, id) > x.at) continue; // changed later on another device: theirs wins
    doc.workouts = doc.workouts.filter((w) => w.id !== id);
    if (x.w) { doc.workouts.push({ ...x.w, updatedAt: x.at }); delete doc.deleted[id]; }
    else doc.deleted[id] = x.at;
  }
  return handled;
}

/** What this device should show: the file plus its own unsent changes. */
export function mineView(doc, pending = {}) {
  const d = JSON.parse(JSON.stringify(doc || emptyMine()));
  applyMinePending(d, pending);
  return d.workouts;
}

export function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'workout';
}
export const newMineId = (name, now = Date.now()) => `mine-${slug(name)}-${now.toString(36)}`;

/** "4:30" -> 270, "90" -> 5400 (plain numbers are minutes), "1:02:00" -> 3720, "45s" -> 45. NaN if unreadable. */
export function parseDur(s) {
  const str = String(s ?? '').trim().toLowerCase();
  let m;
  if ((m = str.match(/^(\d+(?:\.\d+)?)\s*s$/))) return Math.round(+m[1]);
  if ((m = str.match(/^(\d+(?:\.\d+)?)\s*(m|min)?$/))) return Math.round(+m[1] * 60);
  if ((m = str.match(/^(\d+):(\d{1,2})$/)) && +m[2] < 60) return +m[1] * 60 + +m[2];
  if ((m = str.match(/^(\d+):(\d{1,2}):(\d{1,2})$/)) && +m[2] < 60 && +m[3] < 60) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return NaN;
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

/** Problems that would stop the workout from riding. Empty array = fine. */
export function workoutProblems(w) {
  const out = [];
  if (!String(w.name || '').trim()) out.push('Give it a name.');
  const walk = (steps, where) => {
    if (!steps?.length) { out.push(where ? `${where}: no steps.` : 'Add at least one step.'); return; }
    steps.forEach((s, i) => {
      const at = `${where}${where ? ', ' : ''}step ${i + 1}`;
      if (s.repeat != null) {
        if (!(s.repeat >= 1 && s.repeat <= 50 && Number.isInteger(+s.repeat))) out.push(`${at}: repeat 1 to 50 times.`);
        walk(s.steps, `${at} (repeat)`);
        return;
      }
      if (s.dist != null) { if (!(s.dist >= 50 && s.dist <= 100000)) out.push(`${at}: distance 0.05 to 100 km.`); }
      else if (!(s.dur >= 5 && s.dur <= 6 * 3600)) out.push(`${at}: duration 0:05 to 6:00:00.`);
      if (s.power != null && !(s.power > 0 && s.power <= 3)) out.push(`${at}: power 1 to 300% FTP.`);
      if (s.from != null && !(s.from > 0 && s.from <= 3 && s.to > 0 && s.to <= 3)) out.push(`${at}: ramp 1 to 300% FTP.`);
      if (s.grade != null && !(s.grade >= -10 && s.grade <= 25)) out.push(`${at}: grade -10% to 25%.`);
      if (s.cadence != null && s.cadence !== '' && !/^\s*(\d{2,3}\s*(-\s*\d{2,3}|\+)?)\s*$/.test(String(s.cadence))) out.push(`${at}: cadence like 90, 80-90 or 100+.`);
    });
  };
  walk(w.steps, '');
  return out;
}

/** Drops empty optional fields and builder-only state; numbers become numbers. */
export function cleanWorkout(w) {
  const step = (s) => {
    if (s.repeat != null) return { repeat: +s.repeat, steps: s.steps.map(step) };
    const o = {};
    if (s.dist != null) o.dist = Math.round(+s.dist); else o.dur = Math.round(+s.dur);
    for (const k of ['power', 'from', 'to', 'watts', 'grade']) if (s[k] != null && s[k] !== '') o[k] = Math.round(+s[k] * 1000) / 1000;
    if (s.free) o.free = true;
    if (s.cadence != null && String(s.cadence).trim() !== '') o.cadence = /^\d+$/.test(String(s.cadence).trim()) ? +s.cadence : String(s.cadence).replace(/\s+/g, '');
    if (s.label?.trim()) o.label = s.label.trim();
    if (s.text?.trim()) o.text = s.text.trim();
    return o;
  };
  const out = { id: w.id, name: String(w.name).trim(), tags: [...new Set(w.tags || [])], description: String(w.description || '').trim(), steps: w.steps.map(step) };
  if (w.basedOn) out.basedOn = w.basedOn;
  return out;
}
