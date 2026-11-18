// Calendar days, shared by app.js, library.js, training.js and stats.js (one copy, no local twins).
// A day key is the local date "YYYY-MM-DD" (rides, the plan and the calendar all use it); a key turns back into a
// Date at local noon, so stepping a day at a time never skips or repeats one across a DST change.
// Pure, no DOM: runs in the browser and in Node.

/** Local day key, "2026-11-18". */
export const dkey = (d) => d.toLocaleDateString('en-CA');
/** A day key back to a Date, at local noon. */
export const dayDate = (key) => new Date(`${key}T12:00`);
/** A new Date n days later (earlier when n < 0), same time of day. */
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** Monday of d's week, at local noon. */
export const mondayOf = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
