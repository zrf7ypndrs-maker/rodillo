# rodillo: instructions for Claude

Agustín's own Zwift replacement (vanilla JS web app on GitHub Pages). Private data and the training plan live in the sibling repo zrf7ypndrs-maker/rodillo-data; clone both side by side.

**Project docs (`claude/rodillo-*.md`) live in the claude.ai Rodillo project, not in a repo.** Engineering sessions start from `claude/rodillo-code-status.md` (status, rules, what's left). `claude/rodillo-code-map.md` has the module, test and tooling detail behind the rules below; `claude/rodillo-code-health.md` is the archive (look things up there, don't append). This file holds current rules only: feature detail goes in the feature's project doc, not here.

## Deploy and build stamp
- `.github/workflows/pages.yml` ("Deploy") runs the checks, stamps and deploys on every push to main (Pages source = "GitHub Actions"). The build stamp is a cache-busting id on the CSS and every JS import; without it Bluefy can load new HTML with stale JS and freeze the ride screen. Only the deploy adds it, on its own copy: the code in the repo has no `?v=` (npm test fails if it does), so never run `tools/stamp.mjs` locally or write an import with `?v=`.
- Any failing check blocks the deploy, so after pushing run `gh run list -R zrf7ypndrs-maker/rodillo -L 3` and watch your run to `completed success`.
- The deploy step retries once by itself after 60 s. A red run saying "Fetching artifact metadata failed" after both tries is GitHub's side: start a fresh run.
- A run still `queued` 5 minutes after the push is stuck: `gh workflow run Deploy -R zrf7ypndrs-maker/rodillo --ref main` (works from Claude sessions; `gh run cancel` doesn't). A newer run cancels older ones; a run whose commit isn't the head of main skips the deploy (job `current`). If the fresh run also stalls, tell Agustín right away instead of reporting the change as live.

## Checks and when to run them
- `npm run check` (~4 min): lint (unused names are errors), `npm run typecheck`, unit tests with a coverage floor (lines 90, branches 78, functions 85), browser smoke test in Chrome (test/smoke.mjs). Deploy runs the same four.
- **Match the checking to the risk.** Default: `npm run check` once before pushing. CSS or screen change: `npm run visual -- --baseline` on the commit to compare against, `npm run visual -- --only <scenes>` after each change (`--only ride` for ride screen code), the full 172 shots once at the end (pixel-exact, not in CI). Old-vs-new oracles, planted bugs and per-commit rechecks only for behavior-critical refactors (ride engine, controller, sync, importer). Docs-only changes: one `npm run check`.
- Recorded rides (test/rides.mjs, in `npm test`): 7 seeded rides replayed tick by tick against js/engine/session.js, compared exactly. A change not meant to alter ride behavior must pass them untouched; one that is meant to: `npm run rides:record` and paste its "What changed" list in the commit message. New ride behavior: add it to a ride's script in test/rides/scenarios.mjs and re-record.
- New logic: a pure function with a unit test. New screen, panel or ride control: a smoke step (the smoke test is the only automatic check of js/app.js, ui.js, garage.js, settings.js and the DOM halves of training, library and today).
- Don't lower the coverage floor to get a push through. Bugs found along the way: own commit, with a test.
- Type checking: `checkJs` on for every file in js/ (each starts with `// @ts-check`), `strict` off. Shared shapes are JSDoc `@typedef`s in js/types.js: use them and add a field there when the code starts writing one. No blanket `any`; `@ts-expect-error` only with a reason. A checker error is fixed in code only when it's a real bug (own commit + test). Ride and Bluetooth code: casts and JSDoc only, so the parsed program stays the same. Web Bluetooth types: types/web-bluetooth.d.ts (no new packages).

## Module rules
- A screen module exports `initX(deps)`, called from js/app.js; its deps are only app state and app.js hooks, typed by a Deps type in js/types.js (a new dep goes in the Deps type first).
- `npm run lint` enforces: no import of js/app.js, no `alert` / `confirm` / `prompt`, no local copy of a day-key helper, complexity 25 per function.
- Never import js/app.js from a module. DOM helpers (`$`, `$$`, `esc`, `toast`, `fld`, ...) come from js/ui.js, which never reads `app`. Day keys (`dkey`, `dayDate`, `addDays`, `mondayOf`) come from js/dates.js: never keep a local copy.
- Pure renderers (data in, markup out) are plain exports with unit tests, not deps. When they need theme colors or the phone layout they take a `look` argument; when they also need app state, one view argument `v` built at draw time. They never read app.js.
- Settings never calls another screen's renderer: a change other screens show goes through `refreshAfterSettings()` in app.js.
- Controller and keyboard: every button, key, verb and screen is a row in the pure table in js/controls.js and in test/controls.mjs's hand-written tables, never an `if` in a handler.
- `renderRide()` / `renderPhone()` run on every engine tick (4 Hz): never add per-tick work there.
- Ids saved in settings or plans (drivetrain presets, `BIKE_MODELS`, `BUILTIN_GEARINGS`, bike weight presets, workout ids) are never renamed.

## Product rules (hard)
- Never use `alert()`, `confirm()` or `prompt()`: use `tell(text, title)` / `await ask(text, { title, ok, danger })` from js/app.js (in-app modal, works with keyboard and the Ride controllers).
- No em dashes in anything written for Agustín. Summaries to him: short, plain language.
- No spending beyond the Claude subscription: no API-billed or paid-service features.
- **Signed-out privacy gate:** without access to rodillo-data (`signedIn()` / `syncClient()`) nothing personal is drawn, even from a cached copy. A new localStorage key or store with the rider's data goes in `PRIVATE_KEYS` / `forgetHere()` and behind the same gate. `plans/current.json` (public) is an empty sample: never put a real plan or FTP there. Bike photos stay in rodillo-data `garage/`, never in this public repo.
- Phone must never change desktop: phone styles sit only in the one `PHONE_MQ` phone block of css/app.css; the base rules are the desktop look. A desktop-only rule, if ever needed, uses the `@media not (...)` query in `claude/rodillo-code-map.md` (the smoke test fails on any other phone / desktop query). Home-look rules for panels, builder and Log stay behind `html:has(#home.active)` so the pause screen keeps the ride look.
- Training data and coach rules live in rodillo-data: read `rodillo-data/CLAUDE.md`, then `coach/PROGRAM.md` and `coach/DAILY.md` before touching the plan or workouts; log every plan change in PROGRAM.md. Agustín's own workouts (`workouts/mine.json`, ids `mine-*`) are his: the plan may use them, but don't edit them without asking. Coach tools here: `tools/daily.mjs` (morning brief, `--check` validator), `tools/scale.mjs`, `tools/review.mjs`.
- Never write to a friend's repo from a Claude session.
- Never push while Agustín is riding. Ask before pushing ride or Bluetooth code. If add_repo (push) is refused, work on a read-only clone and retry after he says push.

## Index (feature area: code, project doc)
- Today, Calendar, overview, home nav: js/today.js, js/app.js (`setTab`); `claude/rodillo-home-redesign.md` (current state section), `claude/rodillo-ux-roadmap.md`.
- Look (tokens, glow rule, phone vs desktop): css/app.css; `claude/rodillo-premium-look.md` (last section).
- Workouts library and groups: js/library.js; `claude/rodillo-home-redesign.md` (library), `claude/rodillo-ux-roadmap.md` item 10.
- Workout profiles and readout: js/profile.js; `claude/rodillo-status.md` (profile readout).
- Training tab, ride load: js/training.js, js/stats.js; `claude/rodillo-home-redesign.md` (ride load).
- Desktop ride screen, pause screen, slope aim, ramp test, rep scoring: js/ride.js, js/testcoach.js, js/engine/session.js; `claude/rodillo-ride-screen.md`.
- Phone ride screen: js/ridephone.js; `claude/rodillo-ride-screen.md`.
- End of ride and ride page: js/ridepage.js, js/sync.js (`rideSources()`); `claude/rodillo-ride-screen.md`.
- Workout format and timed messages: js/engine/workout.js; `claude/rodillo-workout-messages.md`.
- Controller and keyboard: js/controls.js; `claude/rodillo-code-map.md`, `claude/rodillo-fix-queue.md` (holds).
- Bike garage: js/garage.js, js/engine/garage.js; `claude/rodillo-bike-garage.md`.
- Gearing (Garage's Gearing tab, mid-ride switch): js/garage.js, js/engine/drivetrain.js; `claude/rodillo-bike-gearing-split.md` (wins over the garage doc), `claude/rodillo-gearing-trainer.md`.
- Bike weight: js/engine/bikes.js; `claude/rodillo-bike-weight.md`.
- Trainer grade range: js/engine/trainers.js, js/settings.js; `claude/rodillo-gearing-trainer.md`.
- Virtual shifting in the trainer (Zwift protocol): js/ble/zwifthub.js, js/ble/trainer.js; `claude/rodillo-zwift-protocol.md`.
- Bluetooth reconnects and drops: js/ble/*; `claude/rodillo-ble-drops.md`.
- Real climbs and slope profiles: js/engine/climb.js, tools/climb.mjs; `claude/rodillo-slope-elevation.md`.
- Settings panel and settings sync, FTP prompt: js/settings.js, js/settings-sync.js; `claude/rodillo-settings-sync.md`.
- GitHub sign-in: js/auth.js, auth-worker/; `claude/rodillo-github-signin.md`.
- Signed-out gate: js/app.js (`leaveData`, `forgetHere`); `claude/rodillo-privacy.md`.
- Friends on this app: js/app.js (`dataRepo`, `starterPlan`); `claude/rodillo-friend-setup.md`.
- Ride history import: js/importer.js, js/settings.js; `claude/rodillo-history-import.md`.
- Workout builder and Mine: js/builder.js, js/mine.js; `claude/rodillo-workout-builder.md`.
- WHOOP: whoop.html, rodillo-data workflow; `claude/rodillo-status.md` (WHOOP), recovery-only display in `claude/rodillo-home-redesign.md`.
