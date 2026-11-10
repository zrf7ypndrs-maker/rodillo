# Sign in with GitHub: setup (about 15 minutes)

Three parts, in this order: the Worker first (you need its address for GitHub), then the GitHub App, then the Worker settings.

## 1. Cloudflare Worker
1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Create Worker**.
2. Name it `rodillo-auth`, click **Deploy** (it deploys a Hello World placeholder).
3. Note its address: `https://rodillo-auth.<your-subdomain>.workers.dev`.
4. Click **Edit code**, delete everything, paste all of `auth-worker/worker.js`, click **Deploy**.

## 2. GitHub App
Go to https://github.com/settings/apps/new and fill in:

| Field | Value |
|---|---|
| GitHub App name | `Rodillo` (if taken: `Rodillo sign-in` or similar; anything works) |
| Homepage URL | `https://zrf7ypndrs-maker.github.io/rodillo/` |
| Callback URL | `https://rodillo-auth.<your-subdomain>.workers.dev/callback` |
| Expire user authorization tokens | **checked** (default) |
| Request user authorization (OAuth) during installation | unchecked |
| Enable Device Flow | unchecked |
| Webhook > Active | **uncheck** |
| Repository permissions > Contents | **Read and write** (Metadata read-only gets added automatically) |
| Everything else | leave as is (no access) |
| Where can this GitHub App be installed? | Only on this account |

Click **Create GitHub App**. On the app's page:
1. Copy the **Client ID** (starts with `Iv23`).
2. Click **Generate a new client secret** and copy it (shown only once). You don't need a private key.
3. Left sidebar > **Install App** > **Install** > **Only select repositories** > `rodillo-data` > **Install**.

## 3. Worker settings
Cloudflare > the `rodillo-auth` Worker > **Settings** > **Variables and Secrets** > **Add**:

| Type | Name | Value |
|---|---|---|
| Text | `CLIENT_ID` | the Client ID |
| Secret | `CLIENT_SECRET` | the client secret |
| Text | `ALLOWED_LOGIN` | your GitHub username |

Click **Deploy**. Open the Worker's address in a browser: it should say "Rodillo sign-in is running."

## 4. Turn it on in the app
Set `AUTH_URL` in `js/auth.js` to the Worker's address, stamp, push. Then in each browser: Settings > Sync > **Sign in with GitHub**.

## How it behaves
- The user token lasts 8 hours; the app refreshes it through the Worker without asking. The refresh token lasts about 6 months, so expect to sign in again per browser roughly twice a year.
- Sign out (Settings > Sync) only clears that browser. To cut off every browser at once: GitHub > Settings > Applications > Authorized GitHub Apps > Rodillo > Revoke.
- A pasted fine-grained token still works as a fallback; sign-in wins when both exist.
- The token can only reach repos the app is installed on (rodillo-data), and `ALLOWED_LOGIN` refuses anyone else at the door.
- Cost: Cloudflare Workers free tier (100k requests/day). Rodillo uses a handful.
