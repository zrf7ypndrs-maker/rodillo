// Sign in with GitHub through the rodillo-auth Cloudflare Worker (auth-worker/worker.js).
// The session (8-hour user token + ~6-month refresh token) lives in this browser's localStorage.
import { ls } from './store.js?v=202611101947';

// The deployed Worker. Empty = sign-in hidden, only the pasted token works.
export const AUTH_URL = 'https://rodillo-auth.zrf7ypndrs.workers.dev';

const KEY = 'ghAuth';
const SKEW = 5 * 60 * 1000; // refresh 5 min before the token expires

export const authEnabled = () => !!AUTH_URL;
export const authSession = () => ls.get(KEY, null);
export function signOut() { localStorage.removeItem(`rodillo.${KEY}`); }

export function startSignIn() {
  const back = location.origin + location.pathname;
  location.href = `${AUTH_URL.replace(/\/$/, '')}/login?return=${encodeURIComponent(back)}`;
}

/** Picks up the session (or error) the Worker put in the URL fragment, then wipes it from the address bar. */
export function takeSignIn() {
  const h = location.hash;
  if (!h.startsWith('#gh=') && !h.startsWith('#gh-error=')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (h.startsWith('#gh-error=')) return { error: decodeURIComponent(h.slice(10)) };
  try {
    const s = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h.slice(4).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    if (!s.access_token) throw new Error('no token');
    ls.set(KEY, s);
    return { login: s.login };
  } catch {
    return { error: 'GitHub sign-in came back unreadable. Try again.' };
  }
}

let inflight = null;
/** A valid access token, refreshed through the Worker when it's close to expiring. `force` refreshes now (after a 401). */
export async function authToken(force = false) {
  const s = authSession();
  if (!s) throw new Error('Not signed in. Sign in with GitHub in Settings.');
  if (!force && (!s.expires_at || s.expires_at - SKEW > Date.now())) return s.access_token;
  inflight ||= refresh(s).finally(() => { inflight = null; });
  return inflight;
}

async function refresh(s) {
  const expired = () => { signOut(); return new Error('GitHub sign-in expired. Sign in again in Settings.'); };
  if (!s.refresh_token || (s.refresh_expires_at && s.refresh_expires_at < Date.now())) throw expired();
  let r;
  try {
    r = await fetch(`${AUTH_URL.replace(/\/$/, '')}/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }), cache: 'no-store',
    });
  } catch (e) { throw new Error(`Sign-in server unreachable: ${e.message}`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    // Another tab may have used the refresh token first (they rotate): take its result if it's newer.
    const cur = authSession();
    if (cur && cur.refresh_token !== s.refresh_token) return cur.access_token;
    if (r.status === 401) throw expired();
    throw new Error(`Sign-in refresh failed: ${body.error_description || body.error || r.status}`);
  }
  ls.set(KEY, { ...body, login: s.login });
  return body.access_token;
}
