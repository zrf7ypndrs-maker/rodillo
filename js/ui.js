// Shared UI helpers that only touch the DOM, never app state (code-health plan, Nov 17). app.js, builder.js,
// garage.js and the panels moved out of app.js import them from here. Anything that reads `app` (ask / tell
// through controller navigation, numField through app.settings) stays in app.js and is passed in through initX().
// Never import app.js from here.

/** querySelector / querySelectorAll (as an array), optionally inside `r`. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
/** Escapes text for innerHTML and attribute values. */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ toast
let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

// ------------------------------------------------------------------ settings fields
/** One settings field: label on top, control, optional help. Half width unless cls has "full". */
export const fld = (id, label, control, help = '', cls = '') =>
  `<div class="fld${cls ? ` ${cls}` : ''}"><label for="${id}">${label}</label>${control}${help ? `<div class="help">${help}</div>` : ''}</div>`;

// ------------------------------------------------------------------ sliding indicators (ERG/Slope pill, tab underline)
/** Moves a container's indicator (CSS ::before/::after reading --ink-x/--ink-w) under the active element.
 *  The first placement and resizes jump; user switches slide (the .ink-ready class turns the transition on). */
export function placeInk(box, el) {
  if (!box || !el || !el.offsetWidth) return;
  box.style.setProperty('--ink-x', `${el.offsetLeft}px`);
  box.style.setProperty('--ink-w', `${el.offsetWidth}px`);
  if (!box.classList.contains('ink-ready')) requestAnimationFrame(() => box.classList.add('ink-ready'));
}
export const inkObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const { target } of entries) {
    target.classList.remove('ink-ready'); // fonts loading, rotation, tab shown: jump, don't slide
    placeInk(target, target.querySelector('.on, .active'));
  }
}) : null;

/** Fades a newly shown pane in from the side it came from (dir 1 = from the right). */
export function slideIn(el, dir) {
  if (!el) return;
  el.classList.remove('slide-in');
  el.style.setProperty('--from', `${dir * 14}px`);
  void el.offsetWidth; // restart the animation
  el.classList.add('slide-in');
}
