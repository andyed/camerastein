# Face Gesture Lab

The Face Gesture Lab is Camerastein's operator surface for the shared
`FaceGestureRecognizer`. It answers two separate questions:

1. Is the camera/provider producing usable semantic evidence?
2. Does that evidence complete the intended gesture lifecycle?

It intentionally does **not** preview Psychodeli's visual response. Recognition
belongs here; choreography belongs in Psychodeli's
`FacePerformanceConductor`.

## Open it

```bash
npm start
# http://localhost:8081/?tasks-vision
```

Enable **Head**, then click **gestures**. Tasks Vision is required for live
blendshapes and the shared `FaceFeatures` channel. Without `?tasks-vision`, the
panel remains useful for synthetic rehearsals and clearly labels itself
**synthetic only**.

The panel sits on the left so it can remain open alongside Camerastein's
benchmark panel on the right. At narrow widths it becomes a single-column
scrolling workbench without introducing page-level horizontal overflow.

## Reading the panel

Each recognizer card shows:

- its state-machine family: `track`, `cycle`, or `compound`;
- the physical cue to perform;
- current phase and normalized evidence/peak strength;
- a meter for the active evidence;
- the lifecycle that constitutes success;
- a **rehearse** control for deterministic validation.

The source line distinguishes:

- **waiting for face** — no trustworthy primary face;
- **live · N% confidence** — real provider output;
- **calibrating… / baseline ready** — whether personal neutral is ready;
- **synthetic rehearsal** — an isolated camera-free recognizer run;
- **synthetic only** — the page was opened without `?tasks-vision`.

Lifecycle event badges use `L` for live input and `S` for synthetic input. The
log is newest-first; the lifecycle printed on the card is chronological.

## Soloing a recognizer

Choose a gesture name in the focus strip. Soloing changes display and logging,
not recognition: the shared live recognizer continues observing its complete
vocabulary so compound and mutual-exclusion behavior stays honest. Choose
**All** to compare simultaneous tracks, especially mouth + brow + scream.

This is important for evaluation. Disabling unrelated recognizers would create
a laboratory state that cannot occur in Psychodeli.

## Deterministic rehearsal

**rehearse** feeds an explicit-timestamp provider-neutral feature sequence into
a new private `FaceGestureRecognizer`. The sequence is defined in
`js/gesture-lab.js`, and the same seam runs under `node --test`.

Rehearsal guarantees:

- no camera or model is required;
- no frame is emitted onto MotionBus;
- live feature calibration is untouched;
- a previous rehearsal is interrupted when a new one begins;
- the verdict compares the actual lifecycle against
  `GESTURE_DEFINITIONS[kind].expected`.

`rehearsal passed` proves the recognizer, event order, and lab wiring agree. It
does not prove that the camera can produce the necessary features under current
lighting, framing, or provider conditions.

## Live test script

Start neutral and stay still until **baseline ready**. Test each gesture three
times at conversational amplitude:

| Focus | Perform | Pass condition | Important negative |
|---|---|---|---|
| Mouth | open, hold, close | `start → peak → release` | resting speech should not chatter |
| Brow | raise one brow, then both | side is correct; one lifecycle per raise | blink alone should not fire |
| Lean in | move closer, pause, return | signed track completes | head pitch without distance change |
| Lean out | move farther, pause, return | signed track completes | a momentary confidence dip |
| Nod | move away from neutral, reverse, return | `start → peak → complete` | slow posture drift |
| Shake | first lobe, reverse, reach the opposite side | `start → peak → complete` | turn-and-return with no opposite lobe |
| Scream | jaw wide + brows raised together | `start → release` | mouth-only and brow-only |

Then repeat each once slowly and once near threshold. The near-threshold run is
where hysteresis chatter and sticky releases appear.

Use **reset baseline** when changing person, camera, seat, lens zoom, or framing.
It resets shared feature calibration and active gesture state, then clears the
lab event log.

## Triage guide

### Meter is flat

Inspect `MotionBus.state.faceFeatures` and the Tasks Vision provider path.
Mouth/brow/scream require blendshapes; lean/nod/shake can operate from geometry.
A geometry-only confidence frame may therefore move pose recognizers while
expression cards stay idle.

### Meter moves, phase stays idle

Compare the evidence with the current thresholds in
`FACE_GESTURE_CONTRACT.md`. For nod/shake, inspect velocity and neutral rather
than excursion alone. Reset the baseline and retest before changing thresholds.

### Starts but never completes

- Track: the evidence did not cross the lower exit threshold.
- Nod: the pose reversed but did not return through the neutral band.
- Shake: the pose reversed but did not reach the opposite lobe.
- Scream: both inputs entered, but neither crossed its exit threshold.

### Repeats while held

That is a recognizer regression. Tracks should sustain one episode, and cycles
and compounds have refractory windows. Capture the event order and exact
feature values before tuning.

### Camerastein passes, Psychodeli feels unresponsive

Do not weaken recognition first. Inspect the product layer:

1. `FacePerformanceConductor.status()`
2. `window.__facePerformance`
3. `window.__facePerformanceGain`
4. `FaceNodeFormation.performanceSignals`
5. Self engagement and `__faceNodeFormation`

This boundary prevents an artistic-amplitude problem from becoming a
false-positive recognition problem.

## Adding a gesture

1. Add the deterministic state machine and event contract to
   `face-gesture-channel.js`.
2. Add pure unit coverage for positive, incomplete, timeout, refractory, stale,
   and hostile-input cases.
3. Add a definition and deterministic rehearsal to `js/gesture-lab.js`.
4. Add a live cue and important negative to this document.
5. Update the shared `FACE_GESTURE_CONTRACT.md` in both repositories.
6. Run Camerastein tests and Psychodeli's byte-parity check.
7. Only then add product choreography downstream.

Do not add product commands, visual parameters, entitlements, or AE policy to
the shared recognizer or the lab.

## Release gate

```bash
npm test
```

The test suite asserts that all seven rehearsals complete their documented
lifecycles, timestamps are monotonic and camera-independent, and unknown
rehearsal names fail loudly. Before merging a shared change, also run from
Psychodeli:

```bash
npm run test:face-sync
```

Finally, perform the live script above. Synthetic success is necessary but not
sufficient for a release that changes thresholds, calibration, or provider
translation.
