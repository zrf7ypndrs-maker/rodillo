# rodillo: instructions for Claude

Agustín's own Zwift replacement (vanilla JS web app on GitHub Pages). Private data and the training plan live in the sibling repo zrf7ypndrs-maker/rodillo-data; clone both side by side.

- **Build stamp (cache-busting id on CSS and every JS import; without it Bluefy can load new HTML with stale JS and freeze the ride screen):** `.github/workflows/pages.yml` runs tests, stamps and deploys on every push to main. Once Pages' source is "GitHub Actions", nobody stamps by hand. Check with `gh run list -R zrf7ypndrs-maker/rodillo -L 3`: if pushes still also start "pages build and deployment", the old branch deploy is still on and races the stamped one, so run `node tools/stamp.mjs` before pushing until Agustín switches it (Settings > Pages > Source).
- `npm test` before pushing JS changes.
- Phone layout must never change desktop: phone styles sit behind the `PHONE_MQ` media query in js/app.js.
- Training work (plan, workouts, coaching decisions): read `rodillo-data/CLAUDE.md`, then `rodillo-data/coach/PROGRAM.md` and `coach/DAILY.md`. Log every plan change in PROGRAM.md.
- Ride history import (Strava / Garmin export, loose FIT/GPX/TCX): `js/importer.js`, UI in Settings > Sync, one commit through `GitHubSync.pushRides()`. Imported rides carry the tag `imported` plus `indoor`/`outdoor`/`mtb`/`gravel`; rides without power have `np: null` and `tssFrom: "hr"`, so never assume a summary has power.
- Coach tools here: `tools/daily.mjs` (morning brief, `--check` validator), `tools/scale.mjs` (scaled workout copies), `tools/review.mjs` (history).
- Never use `alert()`, `confirm()` or `prompt()`: they open browser windows. Use `tell(text, title)` / `await ask(text, { title, ok, danger })` from js/app.js (in-app modal, works with keyboard and the Ride controllers).
- No spending beyond the Claude subscription. No em dashes in anything written for Agustín.
