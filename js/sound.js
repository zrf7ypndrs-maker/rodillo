// @ts-check
// Tap feedback on the home screens (Nov 26): three short sounds and, on phones, a haptic tick. Never on the ride screen
// (pause included): there only the countdown plays. Sounds: sounds/tap-{navigate,click,back}.wav, the "Haptic" set
// Agustín picked (rendered by tools/sounds.py). Settings > Ride > Taps: 'all' | 'sound' | 'haptic' | 'off'.
//
// What plays: a click on a control plays the role of that control (roleOf: navigate, click or back); a controller or
// keyboard action that clicks nothing plays its own (actionSound). One sound per action: a second one within 50 ms
// is dropped (a Ride A press that clicks a button, a click that also closes a panel).
//
// Haptics. Android: navigator.vibrate. iPhone: WebKit has no vibrate, and since iOS 26.5 the only haptic a page can get
// is the system tick of a native <input type=checkbox switch> toggled by the user's own tap (a .click() from script
// no longer ticks). So on an iPhone every tappable control carries an invisible <label for> pointing at one shared
// hidden switch: the finger lands on the label, the switch toggles and ticks, and the label hands the tap to the control
// with control.click() (same target, same handlers, still inside the user's gesture). Controller presses have no tap,
// so they never tick on an iPhone. Pure half tested in test/sound.mjs; the DOM half in the smoke test.

/** @typedef {import('./types.js').SoundDeps} SoundDeps */
/** @typedef {'navigate' | 'click' | 'back'} TapRole */

export const ROLES = /** @type {TapRole[]} */ (['navigate', 'click', 'back']);
/** The Settings select's value for a stored choice. */
export const tapChoice = (v) => (v === 'sound' || v === 'haptic' || v === 'off' ? v : 'all');
/** Sounds wanted: by the setting, never on the ride screen. */
export const soundWanted = (choice, screen) => screen !== 'ride' && (tapChoice(choice) === 'all' || tapChoice(choice) === 'sound');
/** Haptics wanted: by the setting, never on the ride screen. */
export const hapticWanted = (choice, screen) => screen !== 'ride' && (tapChoice(choice) === 'all' || tapChoice(choice) === 'haptic');

/** How this device can tick: 'vibrate' (Android), 'switch' (iPhone, the label overlays), or 'none' (desktop, iPad).
 * @param {{ phone: boolean, vibrate: boolean, ios: boolean }} d */
export function hapticKind({ phone, vibrate, ios }) {
  if (!phone) return 'none';
  if (vibrate) return 'vibrate';
  return ios ? 'switch' : 'none';
}

// Controls, by what they do. A click anywhere inside one counts (closest()). Inputs, selects and the ride screen: none.
const BACK = '[data-close], #devpop-close, #b-close, #modal-cancel, [data-rd="back"], #scrim';
const NAV = '#tabs button, #cal-prev, #cal-next, #cal-today, [data-scroll], #set-tabs button, #gar-tabs button';
const TAP = 'button, a[href], .wo, .day[data-day], .cal-cell[data-day], .info-btn, [data-open-gearing], [data-open-garage]';
const NONE = '#ride, input, select, textarea, .hx';
/** The sound for a click on el: 'navigate' (moves you around), 'back' (closes or leaves), 'click' (anything else you
 *  can press), or null (not a control, a form field, the ride screen).
 * @param {Element | null} el */
export function roleOf(el) {
  if (!el?.closest || el.closest(NONE)) return null;
  if (el.id === 'modal' || el.closest(BACK)) return 'back'; // #modal itself = a tap on the dimmed backdrop: cancels
  if (el.closest(NAV)) return 'navigate';
  return el.closest(TAP) ? 'click' : null;
}

// Controller and keyboard actions (js/controls.js) that click nothing and so play their own sound. pick, modalPress and
// pageSelect click an element: that click plays. Ride actions: none.
const ACTION_SOUND = /** @type {Record<string, TapRole>} */ ({
  focusPrev: 'navigate', focusNext: 'navigate', tabPrev: 'navigate', tabNext: 'navigate', modalFirst: 'navigate', modalLast: 'navigate',
  pagePrev: 'navigate', pageNext: 'navigate', pageUp: 'navigate', pageDown: 'navigate',
  closePanels: 'back', closeBuilder: 'back', modalCancel: 'back', pageBack: 'back',
});
/** The sound an action plays: focus moves only when the ring moved, closePanels only when something was open.
 * @param {string | null} name @param {{ moved?: boolean, open?: boolean }} [st] @returns {TapRole | null} */
export function actionSound(name, { moved = true, open = true } = {}) {
  const s = (name && ACTION_SOUND[name]) || null;
  if ((name === 'focusPrev' || name === 'focusNext') && !moved) return null;
  if (name === 'closePanels' && !open) return null;
  return s;
}

/** Whether a sound plays now: one per action (DEDUPE ms), and navigate no faster than every NAV_GAP ms. */
export const DEDUPE = 50, NAV_GAP = 30;
/** @param {TapRole} role @param {number} now @param {{ any: number, nav: number }} last */
export function shouldPlay(role, now, last) {
  if (now - last.any < DEDUPE) return false;
  return role !== 'navigate' || now - last.nav >= NAV_GAP;
}

// ------------------------------------------------------------------ the DOM half
/** @type {SoundDeps['app']} */
let app;
/** @type {SoundDeps['makeAudio']} */
let makeAudio;
/** @type {SoundDeps['isPhone']} */
let isPhone;
/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let out = null;
/** @type {Partial<Record<TapRole, ArrayBuffer>>} */
const raw = {};
/** @type {Partial<Record<TapRole, AudioBuffer>>} */
const buffers = {};
const last = { any: -1e9, nav: -1e9 };
const IDLE_MS = 10000;
let idle = 0;
/** @type {{ role: TapRole, at: number }[]} what played, for the smoke test */
const played = [];
/** @type {HTMLInputElement | null} */
let sw = null;
let kind = 'none';
const choice = () => tapChoice(app.settings.taps);

/** For the smoke test: what played since the last call (and clears it), how this device ticks, the overlays armed. */
export function soundLog() {
  const list = played.splice(0).map((p) => p.role);
  return { played: list, kind, armed: document.querySelectorAll('.hx').length, switchToggles: sw ? +(sw.dataset.n || 0) : 0 };
}

/** Plays a role's sound (and, on Android, a short buzz). Safe to call anywhere: checks the setting and the screen.
 * @param {TapRole | null} role */
export function tap(role) {
  if (!app || !role) return;
  const now = performance.now();
  if (!shouldPlay(role, now, last)) return;
  last.any = now;
  if (role === 'navigate') last.nav = now;
  if (kind === 'vibrate' && hapticWanted(choice(), app.screen)) navigator.vibrate?.(role === 'navigate' ? 6 : 10);
  if (!soundWanted(choice(), app.screen)) return;
  played.push({ role, at: now });
  const buf = buffers[role];
  if (!ctx || !out || !buf) return;
  if (ctx.state !== 'running') ctx.resume().catch(() => {}); // a suspended context plays it as it wakes
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (role === 'navigate') src.detune.value = (Math.random() * 2 - 1) * 15; // repeats never sound robotic
  src.connect(out);
  src.start();
  clearTimeout(idle);
  idle = setTimeout(() => ctx?.suspend().catch(() => {}), IDLE_MS); // an idle running context keeps the audio hardware awake
}

/** Fetches the three files (once, shortly after load: no audio context needed yet). */
function fetchSounds() {
  return Promise.all(ROLES.map((r) => fetch(`sounds/tap-${r}.wav`).then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((b) => { if (b) raw[r] = b; }).catch(() => {})));
}
/** First tap or key: browsers only start sound from one. Decodes the files into the new context. */
function unlock() {
  if (!soundWanted(choice(), app.screen)) return;
  if (!ctx) {
    ctx = makeAudio();
    out = ctx.createGain();
    out.gain.value = 0.7;
    out.connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  for (const r of ROLES) {
    const b = raw[r];
    if (!b || buffers[r]) continue;
    delete raw[r]; // decodeAudioData takes the buffer
    ctx.decodeAudioData(b).then((d) => { buffers[r] = d; }, () => {});
  }
}

// ---- iPhone: the shared switch and the label overlays
const ARM = 'button, a[href], .wo-top, .day[data-day], .cal-cell[data-day], .info-btn';
/** Puts a label over every tappable control that has none (not on the ride screen, not in disabled buttons). */
function arm() {
  if (kind !== 'switch') return;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ARM))) {
    if (el.querySelector(':scope > .hx') || el.closest('#ride, .hx')) continue;
    const l = document.createElement('label');
    l.className = 'hx';
    l.htmlFor = 'hx-switch';
    l.setAttribute('aria-hidden', 'true');
    el.classList.add('hx-host');
    el.append(l); // last child: a first one would shift :first-child styles (Next days cards moved 3 px)
  }
}
/** The element under a tap, skipping the labels, inside the label's control (else the control itself).
 * @param {MouseEvent} e @param {HTMLElement} host */
export function underFinger(e, host) {
  const hit = document.elementsFromPoint?.(e.clientX, e.clientY) || [];
  return hit.find((x) => !x.classList.contains('hx') && host.contains(x)) || host;
}
function setupSwitch() {
  sw = document.createElement('input');
  sw.type = 'checkbox';
  sw.setAttribute('switch', '');
  sw.id = 'hx-switch';
  sw.tabIndex = -1;
  sw.setAttribute('aria-hidden', 'true');
  sw.className = 'hx-switch';
  // the switch's own click (sent by the label) is not a tap on anything: it stops here
  sw.addEventListener('click', (e) => { e.stopPropagation(); sw.dataset.n = String(+(sw.dataset.n || 0) + 1); });
  document.body.append(sw);
  // a tap on a label: the label's click stops (the switch still toggles: that's the label's default action), and what
  // the finger is really on gets the tap as a click of its own (same target as without the label: a Start button inside
  // a day card, the text inside a button), synchronously, so it keeps the user's gesture (audio, Bluetooth)
  document.addEventListener('click', (e) => {
    const l = /** @type {Element} */ (e.target).closest?.('label.hx');
    if (!l) return;
    e.stopPropagation();
    if (!hapticWanted(choice(), app.screen)) e.preventDefault(); // haptics off: no tick
    // a click event, not .click(): what's under the finger can be an SVG icon (no .click()); keeps the tap's position
    underFinger(e, /** @type {HTMLElement} */ (l.parentElement)).dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    }));
  }, true);
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; arm(); }); } })
    .observe(document.body, { childList: true, subtree: true });
  arm();
}

/** @param {SoundDeps} deps */
export function initSound(deps) {
  ({ app, makeAudio, isPhone } = deps);
  const ios = /iPhone|iPod/.test(navigator.userAgent) || deps.forceSwitch === true;
  kind = hapticKind({ phone: isPhone(), vibrate: typeof navigator.vibrate === 'function' && !deps.forceSwitch, ios });
  if (kind === 'switch') setupSwitch();
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, unlock, { capture: true, passive: true });
  // capture: some controls stop their click from bubbling (Connections); the label's own click maps to no sound
  document.addEventListener('click', (e) => tap(roleOf(/** @type {Element} */ (e.target))), true);
  setTimeout(fetchSounds, 1500);
}
