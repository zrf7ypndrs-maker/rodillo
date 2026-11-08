# rodillo: instructions for Claude

Agustín's own Zwift replacement (vanilla JS web app on GitHub Pages). Private data and the training plan live in the sibling repo zrf7ypndrs-maker/rodillo-data; clone both side by side.

- **Before every push: `node tools/stamp.mjs`.** Without it Bluefy (iPhone) can load new HTML with stale JS and freeze the ride screen.
- `npm test` before pushing JS changes.
- Phone layout must never change desktop: phone styles sit behind the `PHONE_MQ` media query in js/app.js.
- Training work (plan, workouts, coaching decisions): read `rodillo-data/CLAUDE.md`, then `rodillo-data/coach/PROGRAM.md` and `coach/DAILY.md`. Log every plan change in PROGRAM.md.
- Coach tools here: `tools/daily.mjs` (morning brief, `--check` validator), `tools/scale.mjs` (scaled workout copies), `tools/review.mjs` (history).
- No spending beyond the Claude subscription. No em dashes in anything written for Agustín.
