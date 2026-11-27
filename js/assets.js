// @ts-check
// Files the app fetches itself (the sounds) carry the deploy's build id too, so a browser never keeps playing an old
// copy after a deploy (Nov 26: new countdown sounds were live but the browser kept the old WAVs under the same name).
// The deploy puts ?v=<id> on every import, so this module's own URL has it; locally (no id) the path is used as is.

const V = new URL(import.meta.url).searchParams.get('v');
/** The path with this build's id, e.g. sounds/countdown-work.wav plus the same ?v= id the imports carry. @param {string} path */
export const assetUrl = (path) => (V ? `${path}?v=${encodeURIComponent(V)}` : path);
