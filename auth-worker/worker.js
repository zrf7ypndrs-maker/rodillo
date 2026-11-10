// Rodillo sign-in: a Cloudflare Worker that lets the Rodillo web app sign in with GitHub.
//
// It does the one step a static page can't do: swap GitHub's sign-in code (and later the
// refresh token) for a user token, which needs the GitHub App's client secret.
// The token it hands back only reaches the repos the GitHub App is installed on (rodillo-data).
//
// Settings (Cloudflare dashboard > the Worker > Settings > Variables and Secrets):
//   CLIENT_ID      text    GitHub App client ID (Iv23...)
//   CLIENT_SECRET  secret  GitHub App client secret
//   ALLOWED_LOGIN  text    optional: only this GitHub username may sign in
//   APP_URL        text    optional: the app's address (default below); comma-separate several
//
// Routes:
//   GET  /login?return=<app url>  -> GitHub sign-in page
//   GET  /callback                -> back to the app with the session in the URL fragment (#gh=...)
//   POST /refresh {refresh_token} -> fresh session JSON (CORS: the app's origin only)

const DEFAULT_APP_URL = 'https://zrf7ypndrs-maker.github.io/rodillo/';
const COOKIE = '__Host-rodillo-auth';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const appUrls = (env.APP_URL || DEFAULT_APP_URL).split(',').map((s) => s.trim()).filter(Boolean);
    try {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return text('Rodillo sign-in: CLIENT_ID and CLIENT_SECRET are not set yet.', 500);
      if (url.pathname === '/login') return login(url, env, appUrls);
      if (url.pathname === '/callback') return await callback(req, url, env, appUrls);
      if (url.pathname === '/refresh') return await refresh(req, env, appUrls);
      return text('Rodillo sign-in is running.');
    } catch (e) {
      return text(`Rodillo sign-in error: ${e.message}`, 500);
    }
  },
};

const gh = (env) => env.GH_BASE || 'https://github.com'; // overridable for local tests only
const api = (env) => env.API_BASE || 'https://api.github.com';
const text = (s, status = 200, headers = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Only send people back to the app itself (any page under one of the APP_URLs).
function pickReturn(ret, appUrls) {
  return appUrls.find((u) => ret && ret.startsWith(u)) ? ret : appUrls[0];
}

function login(url, env, appUrls) {
  const ret = pickReturn(url.searchParams.get('return'), appUrls);
  const state = crypto.randomUUID();
  const auth = new URL(`${gh(env)}/login/oauth/authorize`);
  auth.searchParams.set('client_id', env.CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${url.origin}/callback`);
  auth.searchParams.set('state', state);
  // The state lives in a cookie on this Worker's domain, so a sign-in can only finish in the browser that started it.
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `${COOKIE}=${state}|${encodeURIComponent(ret)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
}

async function callback(req, url, env, appUrls) {
  const raw = (req.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  const [state, retEnc] = raw.split('|');
  const ret = pickReturn(retEnc ? decodeURIComponent(retEnc) : '', appUrls);
  const back = (frag) => new Response(null, {
    status: 302,
    headers: { Location: `${ret.split('#')[0]}#${frag}`, 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`, 'Cache-Control': 'no-store' },
  });
  const fail = (msg) => back(`gh-error=${encodeURIComponent(msg)}`);

  if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || 'Sign-in was cancelled.');
  if (!state || url.searchParams.get('state') !== state) return fail('Sign-in expired or was started in another browser. Try again.');
  const code = url.searchParams.get('code');
  if (!code) return fail('GitHub sent no sign-in code.');

  const tok = await tokenCall(env, { code, redirect_uri: `${url.origin}/callback` });
  if (tok.error) return fail(tok.error_description || tok.error);

  const u = await fetch(`${api(env)}/user`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rodillo-auth' },
  });
  if (!u.ok) return fail(`Could not read your GitHub profile (${u.status}).`);
  const { login: name } = await u.json();
  if (env.ALLOWED_LOGIN && name.toLowerCase() !== env.ALLOWED_LOGIN.toLowerCase()) {
    return fail(`Signed in as ${name}, but this Rodillo only accepts ${env.ALLOWED_LOGIN}.`);
  }
  // Fragment, not query: it never reaches a server log, and the app wipes it from the address bar.
  return back(`gh=${b64url(JSON.stringify({ ...session(tok), login: name }))}`);
}

async function refresh(req, env, appUrls) {
  const origins = appUrls.map((u) => new URL(u).origin);
  const origin = req.headers.get('Origin') || '';
  if (!origins.includes(origin)) return text('Origin not allowed', 403);
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return text('POST only', 405, cors);
  const { refresh_token } = await req.json().catch(() => ({}));
  if (!refresh_token) return Response.json({ error: 'missing refresh_token' }, { status: 400, headers: cors });
  const tok = await tokenCall(env, { grant_type: 'refresh_token', refresh_token });
  if (tok.error) return Response.json({ error: tok.error, error_description: tok.error_description }, { status: 401, headers: cors });
  return Response.json(session(tok), { headers: { ...cors, 'Cache-Control': 'no-store' } });
}

async function tokenCall(env, params) {
  const r = await fetch(`${gh(env)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'rodillo-auth' },
    body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...params }),
  });
  const body = await r.json().catch(() => ({ error: `GitHub returned ${r.status}` }));
  if (!r.ok && !body.error) body.error = `GitHub returned ${r.status}`;
  return body;
}

// GitHub App user tokens last 8 h; the refresh token lasts about 6 months and rotates on every use.
function session(tok) {
  const now = Date.now();
  return {
    access_token: tok.access_token,
    expires_at: tok.expires_in ? now + tok.expires_in * 1000 : null,
    refresh_token: tok.refresh_token || null,
    refresh_expires_at: tok.refresh_token_expires_in ? now + tok.refresh_token_expires_in * 1000 : null,
  };
}
