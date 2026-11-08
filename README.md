# Rodillo

A Zwift replacement for one rider: a KICKR CORE (Zwift Ride), Zwift Ride handlebar controllers, a heart rate strap, and structured workouts from a coach.

**Open it:** https://zrf7ypndrs-maker.github.io/rodillo in **Google Chrome** (Safari has no Web Bluetooth).

## What it does
- **ERG workouts:** the trainer holds the target power. Intensity can be adjusted in 1% steps from the controller (hold the button to repeat).
- **Slope mode with 24 virtual gears:** grade comes from a structured slope session, or you set it with the D-pad in free slope (1% steps). Up/down also shifts a structured profile by 1%. Gear ratios run 0.75 to 5.49, same range as Zwift.
- **Coach library:** `workouts/*.json`, listed in `workouts/index.json`. The plan in `plans/current.json` puts today's session at the top of the home screen.
- **Imports:** Zwift `.zwo` workouts.
- **Coach chat:** the **Coach** button opens a chat with Claude. It reads your rides, load and plan, and edits sessions directly (new workouts, moved days, notes, FTP), each with an Undo. Needs an Anthropic API key (pasted once in the chat panel, billed per use) and the GitHub token for saving.
- **Recording:** rides are saved locally (IndexedDB) and exported as `.FIT` virtual rides for Strava or Garmin Connect.

## Where the plan lives
The coach's edits are saved in the private data repo: `coach/plan.json` and `coach/workouts.json` in rodillo-data. When those exist they win over `plans/current.json` and same-id workouts here. Coach workouts are tagged "from chat" in the library.

## How the virtual gears work
The app runs its own bike physics: mass, rolling resistance, aero and grade. Speed is integrated from measured power. The selected gear sets how fast the pedals turn at that speed, so the trainer is commanded with an equivalent grade:

`grade_sent = k * F_road / (m_trainer * g)`, where `k = gear development / real development`.

That makes trainer power equal road force × virtual speed. The app learns two values while you ride, shown in Settings:
- **Real development:** metres per crank revolution as the trainer sees it. Learned in the first minutes of any ride.
- **Trainer sim mass:** learned on climbs.

## Controls
| Action | Zwift Ride | Keyboard |
|---|---|---|
| Easier / harder gear | Left / right shifters and paddles | ← / → |
| ERG intensity (1%) or free-ride grade (1%), hold to repeat | D-pad up / down | ↑ / ↓ |
| Start / pause | A | Space |
| End ride (twice) | B | Esc |
| Skip interval | Y | S |
| Lap | Z | L |
| ERG off for this interval | Left power-up | E |

**Controller firmware:** don't update the Ride controllers in Zwift Companion. Firmware above 1.2.0 hides the button service until Zwift unlocks it every 24 hours.

## Workout format
```json
{ "id": "vo2-5x4", "name": "VO2max 5 x 4 min", "description": "...",
  "steps": [
    { "dur": 600, "from": 0.45, "to": 0.70, "label": "Warm-up" },
    { "repeat": 5, "steps": [ { "dur": 240, "power": 1.12, "cadence": 100 }, { "dur": 240, "power": 0.5 } ] },
    { "dur": 360, "grade": 6, "text": "Slope step: grade in %" },
    { "dist": 1500, "grade": 6, "text": "Slope step by distance (metres)" },
    { "dur": 300, "free": true }
  ] }
```
`power`, `from` and `to` are fractions of FTP. `cadence` is optional: a number means target ±5 rpm (also accepts "80-90" or "100+").

## Development
`npm install && npm test` runs the protocol, physics, workout and FIT tests (no hardware needed). Demo mode on the home screen simulates a trainer and HR strap.
