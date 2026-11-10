# rodillo: instructions for Claude

Agustín's own Zwift replacement (vanilla JS web app on GitHub Pages). Private data and the training plan live in the sibling repo zrf7ypndrs-maker/rodillo-data; clone both side by side.

- **Build stamp (cache-busting id on CSS and every JS import; without it Bluefy can load new HTML with stale JS and freeze the ride screen):** `.github/workflows/pages.yml` runs tests, stamps and deploys on every push to main (Pages source = "GitHub Actions" since Nov 10). Don't run `tools/stamp.mjs` before pushing and don't resolve `?v=` conflicts by hand: take either side, the deploy re-stamps. A failing test blocks the deploy, so check `gh run list -R zrf7ypndrs-maker/rodillo -L 3` after pushing.
- `npm test` before pushing JS changes.
- Phone layout must never change desktop: phone styles sit behind the `PHONE_MQ` media query in js/app.js.
- Training work (plan, workouts, coaching decisions): read `rodillo-data/CLAUDE.md`, then `rodillo-data/coach/PROGRAM.md` and `coach/DAILY.md`. Log every plan change in PROGRAM.md.
- Ride history import (Strava / Garmin export, loose FIT/GPX/TCX): `js/importer.js`, UI in Settings > Sync, one commit through `GitHubSync.pushRides()`. Imported rides carry the tag `imported` plus `indoor`/`outdoor`/`mtb`/`gravel`; rides without power have `np: null` and `tssFrom: "hr"`, so never assume a summary has power.
- Workout builder (`js/builder.js`, logic in `js/mine.js`): Agustín's own workouts live in rodillo-data `workouts/mine.json` (`{ workouts, deleted }`, ids `mine-*`, newest `updatedAt` wins). Signed-in only (GitHub sign-in or token, `signedIn()` in js/app.js): signed out there is no Mine section, no New workout, no Edit a copy. They show in their own "Mine" section of the Workouts tab, never in the ERG / Slope lists. They're his, not coach workouts: the plan may use their ids, but don't edit them without asking. `daily.mjs --check` reads them.
- Coach tools here: `tools/daily.mjs` (morning brief, `--check` validator), `tools/scale.mjs` (scaled workout copies), `tools/review.mjs` (history).
- Never use `alert()`, `confirm()` or `prompt()`: they open browser windows. Use `tell(text, title)` / `await ask(text, { title, ok, danger })` from js/app.js (in-app modal, works with keyboard and the Ride controllers).
- No spending beyond the Claude subscription. No em dashes in anything written for Agustín.
