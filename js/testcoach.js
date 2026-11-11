// Coach for the ramp test: what to say at each test step and when the test ends.
// Pure: app.js shows the result as a full-screen takeover ({ line, big, sub }) and/or a chart message (msg).

const HARD_LINES = [
  'Stay seated. Keep it smooth.',
  'One more minute. Then one more.',
  "Don't quit mid-step.",
  'This is where the test is decided.',
  'Breathe out hard. Keep turning.',
  'Everything you have left.',
];

/** "Great work{name}" helper: ", Agustín" or "" when no name is set. */
export const withName = (name) => (String(name || '').trim() ? `, ${String(name).trim()}` : '');

/** Best average power over `sec` seconds (1 Hz samples). */
export function bestAvg(power, sec = 60) {
  if (power.length < sec) return power.length ? Math.round(power.reduce((a, b) => a + b, 0) / power.length) : 0;
  let sum = 0, best = 0;
  for (let i = 0; i < power.length; i++) {
    sum += power[i] || 0;
    if (i >= sec) sum -= power[i - sec] || 0;
    if (i >= sec - 1) best = Math.max(best, sum / sec);
  }
  return Math.round(best);
}

/**
 * Cue for the start of test step n (1-based) with target watts. `st` remembers what was already said
 * ({ ftpCrossed, prevPassed, warned }) and is updated in place.
 * prevBest = best minute of the last ramp test, or null.
 * Returns { takeover: { line, big, sub } | null, msg: string | null, finish: string | null }
 * (finish = the 15-seconds-left cue for this step).
 */
export function stepCue({ n, watts, ftp, prevBest = null, name = '', st }) {
  const pct = watts / ftp, nm = withName(name);
  const sub = `Step ${n} · ${Math.round(pct * 100)}% FTP`;
  const big = `${Math.round(watts)} W`;
  const hard = pct >= 1;
  const out = { takeover: null, msg: null, finish: hard ? '15 seconds. Finish the step!' : null };
  if (n === 1) {
    out.takeover = { line: `Here we go${nm}.`, big, sub: '+20 W every minute, until you can’t hold it' };
    return out;
  }
  if (prevBest && watts > prevBest && !st.prevPassed) {
    st.prevPassed = true; st.ftpCrossed ||= hard;
    out.takeover = { line: `New ground${nm}. Past your last test.`, big, sub };
    return out;
  }
  if (hard && !st.ftpCrossed) {
    st.ftpCrossed = true;
    out.takeover = { line: `Past your FTP${nm}. Every step counts now.`, big, sub };
    return out;
  }
  if (hard) {
    const k = Math.round((pct - 1) / 0.08); // about one line per step above FTP
    out.takeover = { line: HARD_LINES[Math.max(0, k) % HARD_LINES.length], big, sub };
    return out;
  }
  if (pct >= 0.9 && !st.warned) { st.warned = true; out.msg = `${big}. Threshold is close. Breathe deep and steady.`; }
  else if (n === 2) out.msg = `${big}. Easy for now, save it for later.`;
  else if (pct >= 0.75 && pct < 0.82) out.msg = `${big}. Getting real now, stay smooth.`;
  return out;
}

/** What the coach says when the test ends: congratulations and the FTP it gives. */
export function resultCue({ best60, ftp, name = '' }) {
  const nm = withName(name);
  const newFtp = Math.round(best60 * 0.75);
  const d = newFtp - ftp;
  const line = d > 0 ? `Huge effort${nm}!` : `Solid effort${nm}.`;
  const sub = d > 0 ? `+${d} W · best minute ${best60} W` : d < 0 ? `${d} W from ${ftp} W · best minute ${best60} W` : `Same as now · best minute ${best60} W`;
  const msg = d > 0 ? `New FTP ${newFtp} W, up ${d} W. Spin easy, then update it on the summary.`
    : `FTP from this test: ${newFtp} W. Spin easy, then choose on the summary.`;
  return { ftp: newFtp, takeover: { line, big: `FTP ${newFtp} W`, sub }, msg };
}
