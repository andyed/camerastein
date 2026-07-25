# Face Gesture Contract (v1)

Provider-neutral, deterministic gesture lifecycles shared by Psychodeli and
Camerastein. This is the boundary between **what the camera saw** and **what a
product does about it**.

- Features: `js/tasks-vision/face-feature-channel.js`
- Gestures: `js/tasks-vision/face-gesture-channel.js`
- Psychodeli visual responses: downstream and intentionally not shared
- Channels: `MotionBus.state.faceFeatures` → `MotionBus.state.faceGestures`
- Flags: `__faceFeatureChannel === true` and `__faceGestureChannel === true`

The feature and gesture modules, plus this document, must remain byte-for-byte
identical in the two repositories. Psychodeli's
`npm run test:face-sync` enforces that when Camerastein is checked out as its
sibling.

## Layering

```text
MediaPipe / future ARKit
  → canonical frame
  → FaceFeatures: continuous normalized evidence
  → FaceGestures: hysteretic episodes and event phases
  → Psychodeli FacePerformanceConductor: visual micro-scores (product-specific)
```

The shared recognizer never writes visual parameters, invokes commands, or
contains AE policy. That separation lets Camerastein tune recognition without
silently changing the artistic response.

## Recognition families

The v1 vocabulary deliberately contains three different state-machine shapes:

1. **Tracks** (`mouth`, `brow`, `leanIn`, `leanOut`) describe an expression
   that can be entered, held, and released. Consumers may read their continuous
   `value` every frame, but should use lifecycle events for punctuation.
2. **Cycles** (`nod`, `shake`) require ordered motion through pose space. A
   threshold crossing alone is not a completed gesture.
3. **Compounds** (`scream`) combine otherwise-independent evidence. Scream
   requires jaw and brow simultaneously; it does not relabel a large mouth
   episode after the fact.

This distinction is part of the contract. A consumer must not treat
`cycle.active` as proof that a nod or shake completed, and must not reconstruct
scream from raw tracks when the compound state is available.

## Gesture frame

Every trustworthy primary-face feature frame produces:

```js
{
  v: 1,
  t: number,
  quality: { confidence: 0..1, facePresent: 1, calibrated: boolean },
  tracks: {
    mouth:  Track,
    brow:   Track & { side?: 'left' | 'right' | 'both' },
    leanIn: Track,
    leanOut: Track
  },
  cycles: {
    nod:   Cycle,
    shake: Cycle
  },
  compound: {
    scream: {
      active: boolean, episodeId, startedAt, strength: 0..1, durationMs
    }
  },
  authority: 0..1,
  events: Event[]
}
```

`Track` carries `phase` (`idle`, `rising`, `holding`, `falling`), `active`,
current `value` and `velocity`, stable `episodeId`, `startedAt`, `peak`, and
`durationMs`.

`Cycle` carries `phase`, `active`, `episodeId`, `startedAt`, `peak`,
`direction`, and `durationMs`.

Events carry stable `kind`, `phase`, `episodeId`, `t`, and `strength`, with
gesture-specific `direction`, `side`, or `durationMs` when meaningful.

### Event identity and delivery

`Event.id` is stable within a recognizer run:
`<kind>:<episodeId>:<phase>`. Events are edge notifications carried only on the
frame where the transition occurred; they are not a historical queue. Consumers
that perform side effects must deduplicate by `id`, not by time or strength.
Continuous rendering should read tracks/cycles/compound state and use events to
launch or retarget a response.

The recognizer is clock-explicit. It advances only when `update(features)` is
called and uses `features.t`; it owns no timers. Resetting the recognizer clears
neutral calibration, active episodes, and refractory windows.

## Lifecycle semantics

| Gesture | Required sequence | Events |
|---|---|---|
| Mouth | jaw crosses enter threshold, peaks, then crosses release threshold | `start → peak → release` |
| Brow | either/both brows cross enter, peak, release | `start → peak → release` |
| Lean in/out | calibrated proximity crosses the directional threshold, then returns | `start → peak → release` |
| Nod | pitch excursion, velocity reversal, return through neutral | `start → peak → complete` |
| Shake | yaw excursion, reversal, then a real opposite lobe | `start → peak → complete` |
| Scream | jaw and brow jointly enter, then either releases | `start → release` |

A one-sided head turn and return is not a shake. Slow pose drift updates the
adaptive neutral and does not arm a cycle. Hysteresis prevents threshold chatter,
and refractory windows prevent a held expression from repeatedly firing.

Thresholds and time windows are tunable implementation details, not part of the
API. Event names, phase meanings, direction conventions, finite-number guards,
and freshness behavior are the stable contract.

## Current v1 tuning reference

These values document the shipped recognizer so field reports are reproducible.
They may change without a contract-version bump when the lifecycle semantics
above remain intact.

| Recognizer | Enter | Exit / completion | Time guard |
|---|---:|---:|---:|
| Mouth | jaw `0.35` | jaw `0.20` | none |
| Brow | max brow `0.40` | max brow `0.25` | none |
| Lean in/out | signed proximity `0.35` | signed proximity `0.15` | none |
| Nod | pitch excursion `0.12`, velocity `0.18`, arm `300 ms` | reversal `0.10`, neutral band `0.045` | `1100 ms` max, `350 ms` refractory |
| Shake | yaw excursion `0.12`, velocity `0.18`, arm `300 ms` | reversal `0.10`, opposite lobe `0.10` | `1250 ms` max, `500 ms` refractory |
| Scream | jaw `0.65` + brow `0.45` | jaw `<0.35` or brow `<0.25` | `700 ms` refractory |

### Cycle arming (why excursion and velocity need not coincide)

Feature velocity is EMA-smoothed (`velTau` ≈ `0.15 s`), so it lags the excursion
it describes. Requiring threshold excursion **and** threshold velocity **and** a
matching sign within one frame therefore inverted the intent: a decisive nod has
already reversed by the time its smoothed velocity peaks, leaving a coincidence
window one or two frames wide that real sampling rates skip — while a languid
nod, whose velocity has several time constants to settle, entered every time.
The observable symptom was "you have to nod very slowly".

Cycles are therefore armed rather than gated instantaneously. A velocity onset
arms its axis for `armMs`; the cycle starts when the excursion threshold is met
while that arming is still fresh and points the same way. Same-frame coincidence
still qualifies, so every gesture that entered before continues to enter.

Two properties are part of the contract, not tuning:

- Arming is evaluated **before** the current frame's onset is recorded, so the
  fast reversal that ends an outbound leg cannot overwrite the arming it is
  completing.
- Arming is **spent on entry**, so one onset cannot seed a second cycle and a
  timed-out cycle cannot restart itself from a held pose.

Track peak detection uses a `0.12` velocity epsilon (lean uses `0.10`).
Pose neutral drifts with a `2400 ms` time constant only while the corresponding
cycle is inactive and velocity is below `0.08`. This is why slow repositioning
does not become a nod or shake.

## Liveness and scope

The channel clears to `null` when the feature channel clears, the gesture flag
turns off, confidence falls below the gate, or the face disappears.
`FaceGestures.read()` additionally refuses frames older than 400 ms.

v1 recognizes the primary face only. Multi-face features remain available on
`faceFeaturesAll`; per-person gesture machines are an additive future extension.

## Camerastein validation protocol

Camerastein is the recognition workbench. Open `?tasks-vision`, enable Head,
then open **gestures**:

1. Wait for **baseline ready** before judging lean, nod, or shake.
2. Solo one recognizer. Perform the cue three times at ordinary conversational
   amplitude, then once slowly and once near the threshold.
3. Confirm the documented event order. A track should not chatter start/release;
   a nod should complete on return to neutral; a shake should not complete until
   the opposite lobe; scream should not fire from mouth-only or brow-only input.
4. Use **rehearse** to run the deterministic provider-neutral sequence through a
   private recognizer. `rehearsal passed` proves the UI and recognizer lifecycle;
   it does not validate camera feature extraction.
5. Reset the baseline after changing person, seat, camera, or framing.

Interpret failures by layer:

| Symptom | Likely layer |
|---|---|
| Meter never moves | provider/blendshape/landmark extraction |
| Meter moves but lifecycle does not advance | recognizer thresholds, neutral, or velocity |
| Camerastein lifecycle passes but Self response feels weak | Psychodeli `FacePerformanceConductor` or Self geometry |
| Synthetic rehearsal fails | deterministic recognizer/UI regression; block release |
| Live events continue after face loss | freshness/reset regression; block release |

The lab's synthetic recognizer never emits to MotionBus. It cannot launch a
Psychodeli response or alter live calibration.

## Cross-repository release discipline

Any change to this document, `face-feature-channel.js`, or
`face-gesture-channel.js` must be mirrored byte-for-byte. Before integration:

```bash
# Camerastein
npm test

# Psychodeli, with Camerastein checked out as its sibling
npm run test:face-sync
npx vitest run tests/unit/face-feature-channel.test.js \
  tests/unit/face-gesture-channel.test.js \
  tests/unit/face-performance-conductor.test.js \
  tests/unit/face-node-formation.test.js
```

Recognition changes land in Camerastein first. Product choreography remains in
Psychodeli and may change without modifying the shared detector contract.
