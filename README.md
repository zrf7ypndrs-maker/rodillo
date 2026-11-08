# Rodillo

A Zwift replacement for one rider: a KICKR CORE (Zwift Ride), Zwift Ride handlebar controllers, a heart rate strap, and structured workouts from a coach.

**Open it:** https://zrf7ypndrs-maker.github.io/rodillo in **Google Chrome** (Safari has no Web Bluetooth).

## What it does
- **ERG workouts:** the trainer holds the target power. Intensity can be adjusted in 1% steps from the controller (hold the button to repeat).
- **Slope mode with 24 virtual gears:** grade comes from a structured slope session, or you set it with the D-pad in free slope (1% steps). Up/down also shifts a structured profile by 1%. Gear ratios run 0.75 to 5.49, same range as Zwift.
- **Coach library:** `workouts/*.json`, listed in `workouts/index.json`. The plan in `plans/current.json` puts today's session at the top of the home screen.
- **Imports:** Zwift `.zwo` workouts.
- **Recording:** rides are saved locally (IndexedDB) and exported as `.FIT` virtual rides for Strava or Garmin Connect.

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
    { "repeat": 5, "steps": [ { "dur": 240, "power": 1.12, "cadence": "95-105" }, { "dur": 240, "power": 0.5 } ] },
    { "dur": 360, "grade": 6, "text": "Slope step: grade in %" },
    { "dist": 1500, "grade": 6, "text": "Slope step by distance (metres)" },
    { "dur": 300, "free": true }
  ] }
```
`power`, `from` and `to` are fractions of FTP.

## Development
`npm install && npm test` runs the protocol, physics, workout and FIT tests (no hardware needed). Demo mode on the home screen simulates a trainer and HR strap.
