// @ts-check
// Shared shapes for type checking (npm run typecheck). Types only: JSDoc @typedef, nothing runs.
// A module uses one with   /** @typedef {import('./types.js').Settings} Settings */
// Write them without the `?v=` build stamp. The browser never loads this file; if tools/stamp.mjs ever stamps an
// import() type in a comment, npm run typecheck takes the stamp off again.
//
// Fields are listed as the code writes them. Optional (`?`) = not always there; `null` = written as null on purpose.

// ------------------------------------------------------------------ settings (js/engine/session.js DEFAULT_SETTINGS)

/**
 * @typedef {object} BikeSpec What a bike weight estimate is built from (js/engine/bikes.js).
 * @property {string} type
 * @property {string} material
 * @property {number} front Fork travel, mm.
 * @property {number} rear Rear travel, mm.
 * @property {string} build
 */

/**
 * @typedef {object} CustomDrivetrain A typed gearing (js/engine/drivetrain.js).
 * @property {number[]} rings Chainring teeth, big first.
 * @property {number[]} cogs Cassette teeth, smallest first.
 * @property {number} [wheel] Not used by rides (the bike's wheel is).
 */

/**
 * @typedef {object} GarageBike A bike in the Garage (js/engine/garage.js): weight and wheel only.
 * @property {string} id
 * @property {string} name
 * @property {string} [model] Built-in model id (BIKE_MODELS).
 * @property {number} bikeKg
 * @property {BikeSpec | null} bikeSpec
 * @property {number} [wheel] Wheel circumference, m.
 */

/**
 * @typedef {object} Gearing One of the rider's own gearings (settings.gearings).
 * @property {string} id
 * @property {string} name
 * @property {string} drivetrain Preset id or 'custom'.
 * @property {CustomDrivetrain | null} [customDrivetrain]
 * @property {string} [shiftStyle]
 * @property {boolean} [builtin] One of BUILTIN_GEARINGS (never stored).
 */

/**
 * @typedef {object} Settings The rider's settings (localStorage `rodillo.settings`, synced to rodillo-data).
 * @property {number} ftp
 * @property {number} riderKg
 * @property {number} bikeKg
 * @property {BikeSpec | null} bikeSpec
 * @property {number} cda
 * @property {number} crr
 * @property {number} wheelCirc
 * @property {number} realDev
 * @property {number} [gradeTrim] Learned closed-loop grade trim (fraction), saved after a slope ride (Session.learned()).
 * @property {number} trainerMassKg
 * @property {number} maxSendGrade
 * @property {number} minSendGrade
 * @property {string} trainerModel
 * @property {number} gradeScale
 * @property {string} drivetrain
 * @property {CustomDrivetrain | null} customDrivetrain
 * @property {string} shiftStyle 'sram' | 'shimano' | 'right' | 'left'.
 * @property {Gearing[] | null} gearings
 * @property {boolean} ergCadenceGuard
 * @property {number} autoPauseSec
 * @property {string} riderName
 * @property {string} trainerShifting 'auto' | 'app'.
 * @property {GarageBike[] | null} garage
 * @property {string} bike
 * @property {Record<string, number>} climbDetail
 */

// ------------------------------------------------------------------ workouts (js/engine/workout.js)

/**
 * @typedef {object} WorkoutMessage A timed message in a workout file.
 * @property {number | string} [at] Seconds from the start, negative = before the end, or "50%".
 * @property {number | string | (number | string)[]} [rep] Rep number, "first", "last" or a list.
 * @property {string} text
 */

/**
 * @typedef {object} WorkoutStep One step of a workout file (or a repeat block holding steps).
 * @property {number} [dur] Seconds.
 * @property {number} [dist] Metres (slope steps by distance).
 * @property {number} [power] ERG steady, fraction of FTP.
 * @property {number} [from] ERG ramp start, fraction of FTP.
 * @property {number} [to] ERG ramp end, fraction of FTP.
 * @property {number} [watts] ERG steady, absolute watts.
 * @property {number} [grade] Slope, %.
 * @property {boolean} [free] Slope at 0% (free ride).
 * @property {number | string | number[]} [aim] Slope power target (fraction of FTP, percent, range).
 * @property {number | string} [cadence] 90, "80-90" or "100+".
 * @property {string} [label]
 * @property {string} [text]
 * @property {boolean} [untilFail] Ramp test step.
 * @property {WorkoutMessage[]} [messages]
 * @property {number} [repeat] Repeat block: times.
 * @property {WorkoutStep[]} [steps] Repeat block: its steps.
 */

/**
 * @typedef {object} Workout A workout file (workouts/*.json, coach/workouts.json, workouts/mine.json, an imported .zwo).
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {WorkoutStep[]} steps
 * @property {string} [updatedAt] Mine workouts: newest wins.
 * @property {string} [basedOn] Mine workouts made with Edit a copy: the coach workout's id.
 * @property {boolean} [imported] Imported .zwo (local only).
 * @property {ClimbProfile} [profile] Real climbs (tools/climb.mjs): the road the steps are cut from.
 * @property {number} [detail] Real climbs: the detail level the steps are cut at (withDetail() in js/engine/climb.js).
 * @property {'coach' | 'mine'} [_source] In app.library only: coach/workouts.json or workouts/mine.json (applyLibrary()).
 */

/**
 * @typedef {object} ClimbProfile A real climb's road (js/engine/climb.js re-cuts it at the rider's detail level).
 * @property {number[]} elev Elevation every `every` metres.
 * @property {number} every
 * @property {number} length Metres.
 * @property {number} [detail] The climb's default detail level.
 * @property {string} [source]
 * @property {WorkoutStep[]} [lead] Steps before the climb (warm-up roll), left out of previews.
 */

/** @typedef {{ i: number, of: number }} Rep Which rep of a repeat block a segment is. */
/** @typedef {{ lo: number, hi: number, label: string }} CadenceTarget rpm range (parseCadence). */
/** @typedef {{ lo: number, hi: number, mid: number }} Aim Slope power target, fractions of FTP (parseAim). */

/**
 * @typedef {object} Segment A flattened step (flatten()): what the engine, charts and stats work on.
 * @property {'erg' | 'sim'} kind
 * @property {number} dur Seconds (estimated for distance steps).
 * @property {number | null} dist Metres, or null.
 * @property {number} start Seconds from the start of the workout.
 * @property {number} end
 * @property {string} label
 * @property {string} text
 * @property {number | string} cadence As written in the file.
 * @property {CadenceTarget | null} cad
 * @property {Rep | null} rep
 * @property {number} [from] ERG, fraction of FTP.
 * @property {number} [to] ERG, fraction of FTP.
 * @property {number} [watts] ERG absolute watts.
 * @property {number} [grade] Slope, fraction (0.06 = 6%).
 * @property {boolean} [free]
 * @property {Aim} [aim]
 * @property {boolean} [untilFail]
 * @property {boolean} [estDur] dur is an estimate (distance step).
 * @property {{ t: number, text: string }[]} msgs
 */

/**
 * @typedef {object} TrackPart One segment's stretch of road (track()).
 * @property {number} d0 Metres.
 * @property {number} d1
 * @property {number} h0 Elevation, m.
 * @property {number} h1
 */

/** @typedef {{ parts: TrackPart[], D: number, lo: number, hi: number, ascent: number }} Track A slope workout laid out as a road. */

// ------------------------------------------------------------------ the plan (coach/plan.json in rodillo-data, plans/current.json)

/**
 * @typedef {object} DailyDecision The daily coach run's call for a day (plan.daily[key]).
 * @property {string} [action]
 * @property {string} [reason]
 */

/**
 * @typedef {object} Plan
 * @property {string} [name]
 * @property {Record<string, string>} [days] Day key -> workout id, 'rest' or 'strength'.
 * @property {Record<string, string>} [notes] Day key -> coach note.
 * @property {string[]} [optional] Day keys that are optional.
 * @property {Record<string, DailyDecision>} [daily]
 * @property {number} [ftp]
 * @property {string} [ftpSetAt]
 * @property {Partial<Settings>} [settings]
 * @property {string} [settingsSetAt]
 */

// ------------------------------------------------------------------ rides

/**
 * @typedef {object} Sample One second of a ride (Session.samples), also what importer.js toSamples() makes.
 * @property {number} t Epoch ms.
 * @property {number} power
 * @property {number} [hr]
 * @property {number} cadence
 * @property {number} [speed] m/s.
 * @property {number} [distance] m.
 * @property {number} [altitude]
 * @property {number} [grade] %.
 * @property {number} [target] W sent to the trainer.
 * @property {number} [gear] Ratio.
 * @property {number} [plan] Planned W at effort 100% (ERG).
 * @property {number} [eff] Effort multiplier when not 1.
 * @property {number} [sent] Grade sent to the trainer, %.
 * @property {number} [trim] Closed-loop trim, %.
 * @property {number} [zp] 1 = trainer shifting (Zwift protocol).
 * @property {number} [wt] Workout time, s.
 * @property {number} [wx] Chart position, s.
 * @property {number} [si] Segment index.
 * @property {number} [st] Seconds into the segment.
 */

/** @typedef {{ avg: number, min: number, reps: number }} Compliance */

/**
 * @typedef {object} RideSummary A ride's summary (rides/index.json in rodillo-data, buildRide().summary).
 * @property {string} id Local start time 'YYYY-MM-DDTHHMM' (rideIdFor()).
 * @property {string} start ISO time.
 * @property {string} name
 * @property {string | null} [workoutId]
 * @property {string[]} tags
 * @property {string} source 'rodillo' or the importer's source.
 * @property {number} ftp
 * @property {number} durSec
 * @property {number} [elapsedSec] Imported rides.
 * @property {number} distKm
 * @property {number | null} kj
 * @property {number | null} avgP
 * @property {number | null} np Null on heart-rate-only imports.
 * @property {number | null} if
 * @property {number} tss
 * @property {'hr'} [tssFrom] TSS from heart rate (no power).
 * @property {number} [lthr]
 * @property {number | null} avgHr
 * @property {number | null} maxHr
 * @property {number | null} avgCad
 * @property {number | null} ef
 * @property {number | null} decoupling
 * @property {Record<string, number>} bests Seconds -> best W.
 * @property {number[] | null} zones Seconds per Coggan zone.
 * @property {Compliance | null} compliance
 * @property {number} slopeSec
 * @property {string} [bike]
 * @property {string} [gearing]
 */

/**
 * @typedef {object} IntervalResult One step as ridden (intervalResults()).
 * @property {number} i Segment index.
 * @property {string} label
 * @property {'erg' | 'sim'} kind
 * @property {string} [rep] "2/5".
 * @property {number} dur
 * @property {number} [dist]
 * @property {number} done Seconds counted.
 * @property {number} avgP
 * @property {number} [avgHr]
 * @property {number} avgCad
 * @property {string} [cadTarget]
 * @property {number} [cadInRange] %.
 * @property {number} [target] W.
 * @property {number} [pct] avgP / target, %.
 * @property {number} [effort] Average effort over the rep, %, when not 100.
 * @property {number} [grade] Slope, %.
 * @property {boolean} work
 */

/**
 * @typedef {object} RideDoc A ride document (rides/YYYY/<id>.json in rodillo-data, buildRide()).
 * @property {RideSummary} summary
 * @property {IntervalResult[]} intervals
 * @property {Partial<Segment>[]} [segs] Steps as ridden when they differ from the workout (ramp test).
 * @property {Record<string, number[]>} streams power, hr, cadence, grade, speed, target, gear, seg; plan, sent, trim, zp when used.
 */

/**
 * @typedef {object} RideRow A row of the ride history (trainingRows() in js/today.js).
 * @property {RideSummary} summary
 * @property {boolean} synced
 * @property {LocalRide} [local] This device's recording (IndexedDB `rides`).
 * @property {boolean} [demo]
 * @property {boolean} [interrupted]
 */

/**
 * @typedef {object} LocalRide A recording on this device (IndexedDB `rides`, saveRide() in js/app.js). rides.list() leaves out `samples`.
 * @property {number} id Start time, epoch ms.
 * @property {string} name
 * @property {string} status 'done' | 'interrupted' | ...
 * @property {boolean} demo
 * @property {boolean} synced
 * @property {Sample[]} [samples]
 * @property {any[]} [laps]
 * @property {import('./stats.js').RideMeta} [meta]
 * @property {RideSummary} summary
 * @property {IntervalResult[]} intervals
 * @property {boolean} [discarded]
 */

/** @typedef {{ date: string, tss: number, ctl: number, atl: number, tsb: number }} LoadRow A day of loadSeries(). */

/**
 * @typedef {object} WhoopDay A day of whoop/daily.json in rodillo-data. Only `recovery` is shown (Agustín, Nov 13).
 * @property {number} [recovery] %.
 * @property {number} [hrv]
 * @property {number} [rhr]
 */

// ------------------------------------------------------------------ app state (js/app.js `app`)

/**
 * @typedef {object} AppState The one state object js/app.js passes to every module as `app`.
 * @property {Settings} settings
 * @property {any} trainer Trainer, the demo sim or null.
 * @property {any} hr Heart rate strap or null.
 * @property {any[]} controllers Zwift Ride hoods.
 * @property {boolean} demo
 * @property {Workout[]} library
 * @property {Plan | null} plan
 * @property {any} session The ride in progress (engine/session.js Session) or null.
 * @property {string | null} rideId
 * @property {string} screen 'home' | 'ride' | 'ridepage'.
 * @property {string} tab 'today' | 'workouts' | 'calendar' | 'training'.
 * @property {number} focus
 * @property {string} woKind 'erg' | 'slope' | 'mine'.
 * @property {Record<string, WhoopDay> | null} [whoop]
 * @property {RideRow[]} [rows]
 * @property {string} [theme]
 * @property {boolean} [usedNav]
 * @property {boolean} [launching]
 * @property {string} [phoneView] 'chart' | 'list'.
 * @property {string | null} [calMonth] Calendar month shown, 'YYYY-MM' (null = this month).
 * @property {string | null} [calSel] Calendar day selected, day key (null = today).
 * @property {Workout[]} [baseLibrary] The public workouts/*.json (loadCoachData()).
 * @property {Plan | null} [basePlan] The public plans/current.json.
 * @property {Plan | null} [coachPlan] rodillo-data coach/plan.json (or its cached copy).
 * @property {Workout[]} [coachWorkouts] rodillo-data coach/workouts.json.
 * @property {MineDoc | null} [mineDoc] rodillo-data workouts/mine.json.
 * @property {string | null} [coachError] Why the coach data didn't load.
 * @property {string | null} [coachNoRepo] The data repo that couldn't be reached.
 * @property {number} [_segI] The desktop ride screen's current segment (js/ride.js).
 * @property {number} [_rpSegI] The phone ride screen's current segment (js/ridephone.js).
 */

/**
 * @typedef {object} MineDoc workouts/mine.json in rodillo-data (js/mine.js).
 * @property {number} version
 * @property {Workout[]} workouts
 * @property {Record<string, string>} deleted Workout id -> when it was deleted.
 */

// ------------------------------------------------------------------ DOM events (type checking only)

/**
 * A listener's event whose target is an HTML element (clicks, delegated handlers); `ElementEvent<KeyboardEvent>` for keys.
 * @template {Event} [E=PointerEvent]
 * @typedef {E & { target: HTMLElement }} ElementEvent
 */
/**
 * A listener's event on a form field (input / change on an input or a select).
 * @template {Event} [E=Event]
 * @typedef {E & { target: HTMLInputElement }} FieldEvent
 */

// ------------------------------------------------------------------ the ride in progress

/**
 * The ride in progress as the ride screens see it: an engine Session plus what beginSession() in js/app.js adds
 * (`test`, the ramp test's coach state: cues given so far, the last test's best minute, the result once it ends).
 * @typedef {import('./engine/session.js').Session & { test?: { st: { ftpCrossed?: boolean, prevPassed?: boolean, warned?: boolean }, prevBest: number | null, result?: ReturnType<typeof import('./testcoach.js').resultCue> } | null }} RideSession
 */

// ------------------------------------------------------------------ views and looks (built at draw time in js/app.js / js/ride.js)

/** @typedef {(f: number) => string} ZoneHex Fraction of FTP -> zone color. */
/** @typedef {(g: number) => string} GradeHex Grade (fraction) -> grade color. */

/** @typedef {{ ftp: number, zoneHex: ZoneHex, gradeHex: GradeHex }} ProfileLook profileLook(): what js/profile.js draws with. */

/**
 * @typedef {object} ChartLook chartLook(): the Training charts' colors and layout (js/training.js).
 * @property {boolean} phone
 * @property {string} INK
 * @property {string} MUTED
 * @property {string} RULE
 * @property {string} FAINT
 * @property {string} UNDERLAY
 * @property {string} FITNESS
 * @property {string} FATIGUE
 * @property {Record<string, string>} TOK Theme tokens.
 * @property {Record<string, string>} ZC Zone colors by name.
 * @property {ZoneHex} zoneHex
 */

/** @typedef {{ INK: string, MUTED: string, RULE: string, FTP_LINE: string, HR_LINE: string, TOK: Record<string, string> }} RideLook rideLook(): the ride screen's colors. */

/**
 * @typedef {object} LibView libView(): what the Workouts rows (js/library.js) draw with.
 * @property {Settings} settings
 * @property {Plan | null} plan
 * @property {string} today Day key.
 * @property {boolean} signedIn
 * @property {string[]} GRADE Grade colors.
 * @property {Record<string, string>} ZC
 * @property {ProfileLook} prof
 */

/**
 * @typedef {object} TodayView todayView(): what Today and Calendar (js/today.js) draw with.
 * @property {Plan | null} plan
 * @property {Workout[]} library
 * @property {RideRow[]} rows
 * @property {Record<string, WhoopDay> | null} whoop
 * @property {Settings} settings
 * @property {string} today Day key.
 * @property {GradeHex} gradeHex
 * @property {ZoneHex} zoneHex
 * @property {ProfileLook} prof
 */

/**
 * @typedef {RideLook & { ftp: number, riderKg: number, hrBpm?: number, track: Track | null, zoneHex: ZoneHex, gradeHex: GradeHex }} RideView
 * rideView(s) in js/ride.js, built once per draw; the phone screen uses the same one.
 */

// ------------------------------------------------------------------ initX(deps): what js/app.js passes each moved module

/**
 * @typedef {object} ControlsDeps initControls() in js/controls.js.
 * @property {AppState} app
 * @property {() => boolean} modalOpen
 * @property {() => boolean} devPopOpen
 * @property {(open: boolean, where?: string) => void} setDevPop
 * @property {(tab: string) => void} setTab
 * @property {string[]} TABS
 * @property {(w: Workout, effort?: number, btn?: Element) => void} startWorkout
 * @property {(name: string) => void} rideAction
 * @property {(name: string) => void} modalAction
 * @property {() => void} renderRide
 * @property {() => boolean} tooShort
 * @property {(save?: boolean) => any} endSession
 */

/**
 * @typedef {object} GarageDeps initGarage() in js/garage.js.
 * @property {AppState} app
 * @property {Function} numField
 * @property {() => void} saveSettings
 * @property {(text: string, opts?: object) => Promise<boolean>} ask
 * @property {() => any} syncClient
 * @property {(open: boolean, where?: string) => void} setDevPop
 */

/**
 * @typedef {object} LibraryDeps initLibrary() in js/library.js.
 * @property {AppState} app
 * @property {() => LibView} view
 * @property {() => void} saveSettings
 * @property {() => void} refreshPlanViews
 * @property {(w: Workout, effort?: number, btn?: Element) => void} startWorkout
 * @property {() => Element[]} focusables
 * @property {() => void} applyFocus
 * @property {() => boolean} signedIn
 */

/**
 * @typedef {object} TodayDeps initToday() in js/today.js.
 * @property {AppState} app
 * @property {() => TodayView} view
 * @property {() => boolean} isPhone
 * @property {() => any} syncClient
 * @property {() => string} syncHint
 * @property {(btn?: Element) => void} startFree
 * @property {(w: Workout, effort?: number, btn?: Element) => void} startWorkout
 * @property {(id: string) => void} openRide
 * @property {(tab: string) => void} setTab
 */

/**
 * @typedef {object} BuilderDeps initBuilder() in js/builder.js.
 * @property {(text: string, opts?: object) => Promise<boolean>} ask
 * @property {() => number} ftp
 * @property {ZoneHex} zoneHex
 * @property {GradeHex} gradeHex
 * @property {number} maxMinutes
 * @property {(w: Workout) => any} onSave
 * @property {(w: Workout) => any} onDelete
 * @property {(w: Workout) => any} onRide
 * @property {(id: string) => string[]} plannedOn
 * @property {() => boolean} signedIn
 */

/**
 * @typedef {object} RideDeps initRide() in js/ride.js.
 * @property {AppState} app
 * @property {() => boolean} isPhone
 * @property {(s: any) => void} renderPhone
 * @property {(open: boolean, where?: string) => void} setDevPop
 * @property {() => RideLook} look
 * @property {ZoneHex} zoneHex
 * @property {GradeHex} gradeHex
 * @property {(el: HTMLElement, c: string) => void} setZc
 * @property {string} NUM_FONT
 */

/**
 * @typedef {object} RidePhoneDeps initRidePhone() in js/ridephone.js.
 * @property {AppState} app
 * @property {() => boolean} isPhone
 * @property {() => RideLook} look
 * @property {ZoneHex} zoneHex
 * @property {GradeHex} gradeHex
 * @property {(el: HTMLElement, c: string) => void} setZc
 * @property {(theme?: string) => void} setTheme
 * @property {string} NUM_FONT
 */

/**
 * @typedef {object} SettingsDeps initSettings() in js/settings.js.
 * @property {AppState} app
 * @property {() => void} saveSettings
 * @property {(text: string, opts?: object) => Promise<boolean>} ask
 * @property {(text: string, title?: string) => Promise<void> | void} tell
 * @property {(open: boolean, where?: string) => void} setDevPop
 * @property {() => string} dataRepo
 * @property {() => any} syncClient
 * @property {() => string} syncHint
 * @property {() => any} loadCoachData
 * @property {() => any} syncPending
 * @property {() => any} refreshAfterSettings
 * @property {(revoke: boolean, keepsAccess?: boolean) => any} leaveData
 */

/**
 * @typedef {object} TrainingDeps initTraining() in js/training.js.
 * @property {AppState} app
 * @property {() => ChartLook} look
 * @property {() => Promise<RideRow[]>} trainingRows
 * @property {() => any} syncClient
 * @property {() => string} dataRepo
 * @property {() => string} syncHint
 * @property {() => any} syncPending
 * @property {(key: string) => WhoopDay | undefined} whoopDay
 * @property {(pct: number) => string} recZone
 * @property {(id: string) => void} openRide
 * @property {(ride: any) => any} downloadFit
 * @property {(text: string, opts?: object) => Promise<boolean>} ask
 */

export {};
