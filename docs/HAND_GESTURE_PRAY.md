# Pray Gesture (v1)

Anjali mudra — palms flat, pressed together, fingers up — recognized as a
**held two-hand pose** with the same lifecycle vocabulary the face channel uses.

- Features: `js/lib/hand-pose-features.js`
- Recognizer: `js/lib/pray-recognizer.js`
- Bus wiring: `js/lib/pray-channel.js`
- Fixtures: `js/lib/hand-pose-fixtures.js`
- Tests: `tests/pray-recognizer.test.js`, `tests/pray-channel.test.js`
- Debug lab: `js/hand-gesture-lab.js` (the **hands** toggle in the control bar)
- Live protocol: [PRAY_TEST_SCRIPT.md](PRAY_TEST_SCRIPT.md)
- The other eight gestures: [HAND_GESTURE_SUITE.md](HAND_GESTURE_SUITE.md)
- Channel: `MotionBus.state.handPose` → `MotionBus.state.prayGesture`
- Flag: `window.__prayChannel` (default on; set `false` to disable)

## Why a held pose

Hands run in the overlay slot, not the primary one: roughly **2.8 Hz on desktop
and 0.83 Hz on mobile** (README, Detection Concurrency Model), halving again
under render pressure. A swipe or a wave cannot survive that sampling rate — a
mobile frame is 1.2 s of wall clock, and the whole gesture happens between two
samples. A pose held for most of a second can.

Two rules follow, and they are contract, not tuning:

1. **The dwell is measured in milliseconds, never in frames.** Four frames means
   1.4 s on desktop and 4.8 s on mobile. Time is the only portable unit.
2. **A dropped frame must not end an episode.** Pressed palms occlude each other
   by construction, so losing a hand mid-pray is the normal case, not the edge
   case.

## Layering

```text
MediaPipe Hands (21 landmarks × 2)
  → handPoseDetector  (publishes landmarks + landmarks2 on MotionBus)
  → hand-pose-features  palm frames, scale-relative two-hand geometry
  → PrayRecognizer      hysteretic episode + dwell + lifecycle events
  → host                acts on start / peak / release
```

The recognizer is a **consumer of the bus, not a patch to the detector**.
`handPoseDetector` already broadcasts both hands' raw landmarks, so nothing in
the 1343-line detector that Psychodeli+ shares had to change.

## Features

All five criteria are position-, scale-, and depth-invariant. That matters more
than it sounds: `handPoseDetector.state.twoHandDistance` normalizes wrist-to-
wrist by **screen width**, so leaning toward the camera changes it even when the
hands never move relative to each other. A "palms touching" test cannot be built
on it. `separation` divides by the hands' own scale instead.

| Feature | Meaning | Pray reads |
|---|---|---:|
| `separation` | palm-centre distance ÷ hand length | ~0.32 |
| `palmOpposition` | thumbs' agreement; −1 opposed, +1 same way, ~0 unreadable | ~−1.0 |
| `foreshortening` | projected palm width ÷ length, worse hand | ~0.07 |
| `axisAlignment` | finger directions dotted; +1 = same way | ~1.0 |
| `flatness` | min over both hands of mean finger extension | ~1.0 |
| `uprightness` | mean −axis.y; +1 = fingers straight up | ~1.0 |

Palm frame per hand: centre = mean of wrist + the four MCPs; scale =
**palm length only**, `|wrist → middleMCP|`; axis = unit wrist→middleMCP. All
image-plane.

**Why length and not width.** A hand-size proxy that includes palm *width*
shrinks **1.75×** as the palm turns edge-on — which is exactly what pressing two
palms together does. Separation divides by that proxy, so it inflated by the
same factor in the pose it exists to recognize, and its threshold was chasing a
denominator that moved with the gesture. Palm length lies along the finger axis
and is untouched by rotation about it. (Same proxy `map-gesture-controls` uses.)

**Why nothing here uses z.** MediaPipe's z is a relative depth estimate, not
metrically comparable to x and y and far noisier. Scramble z alone on a
perfectly held pose and a 3D palm-centre separation inflates 6.6× (0.031 →
0.202) while the image-plane one does not move at all — the recognizer would
read the hands as flying apart while they sat still.

**Why each criterion.** `palmOpposition` alone cannot separate pray from a
handshake — both oppose the palms exactly; `axisAlignment` rejects the
handshake. `flatness` rejects an interlocked clasp. `foreshortening` rejects two
flat palms held close but facing the camera, which passes `separation` and
`palmOpposition` on its own merits. Each criterion carries a rejection no other
one covers, and `tests/pray-recognizer.test.js` holds one case per rejection.

**`palmOpposition` is a veto, not a demand.** A truly edge-on palm hides its
thumb's sideways offset in depth, so the reading weakens toward 0 exactly as the
pose perfects itself — a perfect synthetic pray reads only −0.28 before
normalization. An earlier version required ≤ −0.35 and therefore rejected the
ideal case. The criterion earns its place by rejecting a clear **+1** (two palms
facing the same way); ambiguity has to pass, or it fails hardest precisely where
the gesture is most correct.

**The palm normal is reported but never gates.** `(indexMCP − wrist) ×
(pinkyMCP − wrist)` is mirror-sensitive: it points out of the palm on a right
hand and out of the *back* on a left one. A real left/right pair in prayer
therefore reads `normalDot` ≈ **+1**, and when occlusion makes MediaPipe label
both hands the same chirality it flips to −1. Two ways to be confidently wrong.
`palmOpposition` reads the same evidence off the thumbs, which are large
image-plane landmarks, and is unchanged by either failure. The cost:
`palmOpposition` cannot tell palms-facing-each-other from backs-of-hands-
pressed-together — both read −1. That is an accepted false positive.

## Lifecycle

| Phase | Meaning |
|---|---|
| `idle` | nothing, or bleeding off an abandoned attempt |
| `rising` | criteria met, dwell charging, **no events yet** |
| `holding` | dwell complete, episode open |
| `falling` | criteria failing, inside the release window |

| Event | Fires when |
|---|---|
| `start` | dwell reaches 1.0 — the pose has been *held*, not passed through |
| `peak` | `value` falls `velEps` below its peak, or at release if never emitted |
| `release` | criteria fail continuously for `releaseMs`, or the hands are lost past `nilToleranceMs` |

`Event.id` is `pray:<episodeId>:<phase>`, stable within a run. Events are edge
notifications on the frame the transition occurred — not a queue. Deduplicate by
`id`, not by time.

Every `start` gets a matching `release`. That holds even across a sampling
blackout: the release is then stamped at the resuming frame but **dated to the
last frame actually observed**, and carries `reason: 'discontinuity'`.

## Tuning reference (v1)

`enter` gates a new episode; `exit` is the looser bound an open episode must
stay inside; `full` is where the meter reads 1.0. `value` is the **minimum**
across criteria — the weakest link — so `PrayGesture.status()` names the
criterion actually holding the gesture back instead of an average that hides it.

| Criterion | Enter | Exit | Full |
|---|---:|---:|---:|
| `separation` | ≤ 0.85 | ≤ 1.30 | 0.30 |
| `palmOpposition` | ≤ 0.35 | ≤ 0.60 | −1.00 |
| `foreshortening` | ≤ 0.55 | ≤ 0.72 | 0.20 |
| `axisAlignment` | ≥ 0.80 | ≥ 0.60 | 0.97 |
| `flatness` | ≥ 0.86 | ≥ 0.74 | 0.96 |
| `uprightness` | ≥ 0.45 | ≥ 0.15 | 0.85 |

| Timing | Default | Purpose |
|---|---:|---|
| `holdMs` | 700 | dwell before `start` |
| `releaseMs` | 160 | criteria must fail this long to close |
| `nilToleranceMs` | 400 | coast through occlusion / dropped frames |
| `refractoryMs` | 600 | after release, before recharging |
| `maxFrameGapMs` | 1500 | longer is a discontinuity, not a hold |
| `armMs` | 1200 | how long one qualifying frame vouches for the next |
| `soloDriftMax` | 1.2 | hand-lengths per second a soloing hand may drift |
| `decayTau` | 0.35 s | abandoned-attempt bleed-off |

Live tuning: `window.__prayHoldMs`, `__prayNilToleranceMs`,
`__praySeparationEnter`, `__prayForeshorteningExit`, …
(`__pray<Criterion><Bound>`), plus `__prayOcclusionAssist` and `__prayArmMs`.
The debug panel writes these and calls `retune()`.

### Occlusion: three tiers of evidence

Pressing two palms together makes each hand hide the other, so MediaPipe
routinely reports one hand at the moment the pose is complete. The recognizer
grades what a frame can prove:

| Tier | Evidence | May start an episode? |
|---|---|---|
| two hands | all six criteria | yes — and only this tier opens the window |
| armed single hand | `flatness`, `uprightness`, `foreshortening` at exit bounds, **plus stillness** | no, only sustain |
| coasting | the last good reading, re-checked at exit bounds | no |

A qualifying two-hand frame arms the recognizer for `armMs`. While armed, a lone
hand that is still flat, upright, edge-on **and holding still** keeps the dwell
charging, keeps an open episode alive, and **refreshes the window** — so the
solo stretch is open-ended. That matters because in this pose occlusion is not a
blip to be coasted over, it is the steady state: each palm hides the other for
as long as you hold the gesture. Capping the solo stretch at `armMs` capped the
gesture at 1.2 seconds.

What keeps open-ended solo safe is **stillness**, not a timer. `soloDriftMax`
bounds the lone hand's palm-centre drift at 1.2 hand-lengths per second — a rate,
so it means the same at 2.8 Hz and at 0.83 Hz. Holding a pose sways well under
0.3; lowering a hand is several times the bound. A hand that moves ends the
episode, and so does one that stops being flat or upright.

A single hand still cannot *open* the window: only two hands do that, and
`tests/pray-recognizer.test.js` asserts it. Arming and the drift anchor are both
cleared on release and on a discontinuity. Switch the whole tier off with
`window.__prayOcclusionAssist = false` or the lab's checkbox.

**Contrary evidence is not coasted over.** A frame with no usable read coasts
through `nilToleranceMs`; a frame that can see the hand and reports it moving or
no longer matching is a *failure*, and goes straight to the release timer.
Coasting exists to bridge silence, not to paper over a reading that disagrees.

Every frame carries `quality.reason` — `ok`, `blocked`, `one-hand`,
`one-hand-armed`, `one-hand-blocked`, `one-hand-collapsed`, `frame-collapsed`,
`one-hand-moving`, `coasting`, `low-confidence`, `no-hands` — and
`quality.blockedBy` names every failing criterion. The lab tallies these over the
last 90 frames; whichever reason dominates is the diagnosis.

### Why `maxFrameGapMs` exists

A frame vouches for the interval since the previous one. A paused detector, a
backgrounded tab, or a Head↔Body mode switch produces **no updates at all**, and
without a bound the first frame after the blackout credits the entire gap to the
dwell and fires on arrival. Anything longer than one tolerated sampling interval
therefore closes the open episode and restarts the charge from zero, crediting
the resuming frame with nothing. `nilToleranceMs` handles *frames that arrive
with no hands*; `maxFrameGapMs` handles *frames that never arrive*. They are
different failures and need different handling.

## Validation

```bash
npm test    # 77 cases; recognizer + channel are camera-free and deterministic
```

Camera-free rehearsal in the browser, no webcam and no lighting:

```js
const { makePrayPose, makeOpenPalmsPose } = await import('/js/lib/hand-pose-fixtures.js');
window.addEventListener('camerastein:pray', e => console.log(e.detail.phase));
let t = performance.now();
const feed = (hands, n) => { for (let i = 0; i < n; i++) {
  window.MotionBus.emit('handPose', { t, timestamp: t, confidence: 0.9,
    handCount: hands.length, landmarks: hands[0] || null, landmarks2: hands[1] || null });
  t += 360; } };
feed(makeOpenPalmsPose(), 2); feed(makePrayPose(), 8); feed(makeOpenPalmsPose(), 3);
// → start, peak, release
```

A rehearsal proves the state machine. It does **not** prove landmark extraction
from a real camera. Interpret failures by layer:

| Symptom | Likely layer |
|---|---|
| `status().features` is null with two hands up | palm frame collapsed — landmarks unusable |
| Reason tally dominated by `one-hand` | MediaPipe is losing a hand before anything can arm |
| Episode ends while you are still holding | `one-hand-moving` — raise `soloDriftMax`, or you are swaying |
| Reason tally dominated by `blocked: X` | criterion X — read its measured value against its bound |
| Features move but no `start` | thresholds, or the dwell never completing at the mobile rate |
| `start` fires on hands merely passing through | `holdMs` too low |
| Episode ends mid-pray | `nilToleranceMs` below the achieved hand rate |
| Rehearsal passes, live never fires | landmark extraction or hand-rate, not the recognizer |

## Live validation still owed

Everything above is verified against synthetic landmarks and in-browser bus
traffic. **It has not been run against a real webcam.** The specific risk is
structural, not incidental: when two palms press flat together, each hand
occludes the other, and MediaPipe's landmark confidence and handedness both
degrade in exactly that pose. The design absorbs some of this — `nilToleranceMs`
coasting, `exit` bounds looser than `enter`, `separation` tolerant out to 0.85
hand-widths so a deliberate gap still reads as pray — but whether MediaPipe
holds two hands at all in full anjali mudra is an empirical question the fixtures
cannot answer. Expect to relax `separation` and `normalDot` after the first live
session, and record what moved. [PRAY_TEST_SCRIPT.md](PRAY_TEST_SCRIPT.md) is
the protocol for that session; its Step 1 tests the occlusion assumption
directly, before any threshold is touched.

## Prior art

The palm-local normalization (palm center from wrist + four MCPs, scale from
palm width and length, inter-hand distance divided by mean hand scale) follows
the feature construction in
[argyrios-dev/AirControll](https://github.com/argyrios-dev/AirControll)
(`Sources/AirControll/FeatureExtractor.swift`, MPL-2.0). Reimplemented, not
copied — different language, and extended to 3D, since Apple Vision has no
usable depth and MediaPipe does, which is why AirControll has no palm-normal
feature and this recognizer's central criterion could not exist there.

Two more ideas carried over from that repo's `GestureRecognizer.swift`: weighting
absolute palm position to near zero so a gesture is recognized anywhere in frame,
and requiring several consecutive matching frames with a require-release latch
before firing again — which arrives here as `holdMs` plus `refractoryMs`.

AirControll's own architecture is a **template learner** (record 24+ stable
samples, match by variance-weighted distance against an auto-derived threshold),
not a hand-written recognizer. That approach is worth revisiting if the hand
vocabulary grows past a handful of poses; it trades explicit, inspectable
lifecycles for zero threshold tuning.
