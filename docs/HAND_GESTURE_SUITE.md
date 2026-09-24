# Hand Gesture Suite

Nine gestures in the Hand Gesture Lab, in two families that work differently
enough that pretending otherwise would be a lie.

- Engine: `js/lib/held-pose-recognizer.js`
- Pose vocabulary: `js/lib/hand-pose-features.js` (`handShape`)
- Pose declarations: `js/lib/hand-pose-suite.js`
- Bus wiring: `js/lib/hand-pose-channel.js`, `js/lib/pray-channel.js`
- Lab: `js/hand-gesture-lab.js` (the **hands** toggle)
- Pray in detail: [HAND_GESTURE_PRAY.md](HAND_GESTURE_PRAY.md)

## Two families

| Family | Gestures | Evidence | Survives the overlay rate? |
|---|---|---|---|
| **held pose** | pray, open palm, fist, point, peace, horns, thumbs up, thumbs down | hand *shape*, held for a dwell | yes |
| **commitment** | thumb confirm (Psychodeli+) | shape + placement, latched | yes |
| **transient** | air-drum strike | raw per-frame wrist velocity | **no** — needs a dedicated Hand mode |

Hands run in the overlay slot at roughly **2.8 Hz on desktop and 0.83 Hz on
mobile** (README, Detection Concurrency Model). A pose held for most of a second
survives that. A strike is a sub-80 ms transient, and the detector has to see
both the descent and its deceleration, so it needs consecutive frames *inside*
the stroke. Below about 10 Hz most hits land between samples. That is a sampling
floor, not something a threshold tunes around, and it is why the strike is an
adapter over `hand-pose-detector.js`'s own detection rather than another entry
on the held-pose engine. The lab says so on the strike card.

Motion gestures — swipes, waves — are absent for the same reason, and the
absence is deliberate rather than pending.

## The held-pose engine

Every pose shares one lifecycle, so it lives in `HeldPoseRecognizer` once:

```text
handShape / twoHandGeometry     what the camera saw
  → criteria at enter/exit bounds       hysteresis
  → dwell in milliseconds               holdMs
  → start → peak → release              the face channel's vocabulary
```

Clock-explicit: it advances only when `update()` is called, uses the caller's
`t`, and owns no timers. It also carries the things that only show up in a live
session — coasting through a dropped frame, refusing to credit a sampling
blackout to the dwell, bleeding off an abandoned attempt, a refractory window
after release. A recognizer supplies only `_weigh()`: what a given frame proves.

`PrayRecognizer` overrides `_weigh()` for its three-tier occlusion handling.
Every one-hand pose uses the default.

## The pose vocabulary

`handShape()` returns one flat bag of **image-plane** measurements. Nothing uses
MediaPipe's z — see [HAND_GESTURE_PRAY.md](HAND_GESTURE_PRAY.md) for the
measurements that inflated 6.6× when it did.

| Field | Meaning |
|---|---|
| `thumbExtension` | 0 curled, 1 straight: chord ÷ chain over CMC → TIP (`fingerExtension`) |
| `indexExtension` … `pinkyExtension` | 0 curled, 1 extended: wrist reach (`fingerReach`, OptiGest's rule) |
| `spread` | smallest adjacent fingertip gap ÷ hand length |
| `pinch` | thumb tip ↔ index tip ÷ hand length |
| `aspect` | projected palm width ÷ length; low is edge-on |
| `palmLengthRatio` | 1 ÷ aspect; low is the palm pitched toward or away from the lens |
| `uprightness` | +1 fingers straight up |
| `thumbUpness` | +1 thumb up, −1 thumb down |

**Long fingers are measured by wrist reach**, OptiGest's rule
(optimac `FingerCounter.isExtended`) made continuous: `tip→wrist ÷
max(pip→wrist, mcp→wrist)`, above 1 extended, rescaled so 0.6 → 0 and 1.3 → 1.
It replaced straightness (chord ÷ chain) after the first live run: a finger
curled *toward* the camera projects as a short straight segment, its chord
equals its chain, and straightness called it fully extended. A live peace sign
read its tucked ring and pinky at 1.00 and fired openPalm; a point with the hand
turned read its curled fingers at 0.60–0.78 and fired nothing. Reach only asks
whether the tip got farther from the wrist than the knuckles did.

| | extended | curled |
|---|---|---|
| live run, 2026-09-24, every pose | ≥ 0.93 | ≤ 0.41 |
| synthetic, palm-on and edge-on | 0.96–1.00 | 0.19–0.39 |

Replaying that run (`node scripts/replay-hand-clip.mjs`) moved point from
nothing to 100% and peace from openPalm 93% to peace 100%, with openPalm,
thumbsUp and thumbsDown unchanged at 100%. The real landmarks are kept as
`tests/fixtures/hand-live-2026-09-24.json`.

**The thumb is still on straightness.** Its tip clears its knuckles whether it
is tucked across a fist or not — OptiGest hit the same thing and dropped the
thumb from its fist test — so reach cannot tell a fist from a thumbs-up. Neither
can straightness on a real hand: a thumb across a fist reads 0.84–0.92, above
THUMB_TUCKED, so **fist reads as thumbsUp live**. Fixing it needs a thumb test of
its own (does the tip sit over the fingers, or clear them?).

`fingerExtension` is unchanged, and is still the exact complement of
`handPoseDetector.state.<finger>Curl` — pray's `flatness` and Psychodeli's
thumb gesture use it, and pray was live-validated on it.

**Every one-hand pose requires the hand to face the camera.** The gate was
written for straightness, which was direction-dependent (a fully curled finger
read 0.16 palm-on, 0.71 edge-on). Reach is far less so (0.20 and 0.39), but the
gate stays while the thumb is on straightness.

**`spread` and `pinch` are reported but nothing gates on them.** The synthetic
hand does not model finger splay or a thumb-to-index touch, so no threshold for
them has been validated. Adding a pose that needs one means building the fixture
first.

## Declaring a pose

A pose is data, not a class:

```js
peace: definePose('peace', {
    title: 'Peace',
    cue: 'Index and middle out, ring and pinky curled.',
    extended: ['index', 'middle'],
    curled: ['ring', 'pinky'],
}),
```

`definePose` expands that into criteria the shared engine already understands.
Adding one to the lab is one entry; the rendering knows nothing about any
particular gesture.

| Pose | Declaration |
|---|---|
| Open palm | all five extended, not edge-on |
| Fist | four curled, **thumb tucked**, facing the camera |
| Point | index extended; middle, ring, pinky curled; facing |
| Peace | index, middle extended; ring, pinky curled; facing |
| Horns | index, pinky extended; middle, ring curled; facing |
| Thumbs up | thumb extended and pointing up; four curled; facing |
| Thumbs down | thumb extended and pointing down; four curled; facing |

### Exclusivity instead of arbitration

No two poses can match the same hand. That is a property of the declarations —
a fist requires a *tucked* thumb precisely so that a thumbs-up is not also a
fist — and `tests/hand-pose-suite.test.js` asserts it by running every fixture
past every declaration.

The alternative, which DeskDaemon uses and this deliberately does not, is
priority-arbitrated scoring: let poses overlap and pick a winner. A set of
declarations that cannot collide is easier to reason about than a rule deciding
which collision wins, and a failing exclusivity test names the overlap directly.

Either hand may perform a pose. Every frame is measured for both hands and the
first that satisfies the criteria wins — nothing depends on which hand MediaPipe
reports first, or on its handedness label, both of which occlusion disturbs.

## Thumbs up/down: two implementations, reconciled

Psychodeli+ already has a thumbs gesture — `handPoseDetector`'s `thumbConfirm`
— and the suite now has `thumbsUp` / `thumbsDown`. They are **not** the same
gesture, and should not be:

| | suite `thumbsUp` | `thumbConfirm` |
|---|---|---|
| Reports | **state** — the hand is in this shape now | **a commitment** — approve / reject |
| Lifecycle | `start → peak → release` | one latched event, then re-arm on release |
| Dwell | 500 ms | 1200 ms |
| Placement | anywhere in frame, any distance | centred **and** near the camera |
| Curled-finger bar | extension ≤ 0.55 | extension ≤ 0.45 |
| Output | `MotionBus.state.handPoses.thumbsUp`, `camerastein:thumbsUp` | `onGesture('thumbConfirm', {direction})` |

A commitment gesture should be harder to trigger than a readout, so the
difference in strictness is deliberate. Both are registered in the lab — pick
**Thumb confirm (Psychodeli)** on the focus strip — so the two can be watched
side by side and their disagreements seen rather than guessed at.

### What was genuinely inconsistent, and is now fixed

**The finger chains disagreed.** `handPoseDetector._fingerChains` runs
MCP → PIP → DIP → TIP; `fingerExtension` used to start at the **wrist**. Same
formula, different quantity. Including the palm puts a fixed length in both
halves of the ratio, so a fully curled finger measured **0.5** instead of
**0.16** — most of the dynamic range thrown away, and thresholds that looked
comparable to the detector's while meaning something else. The chains now match
exactly, and the identity holds:

```js
fingerExtension(hand, FINGER_CHAINS.index) === 1 - handPoseDetector.state.indexCurl
```

`tests/hand-pose-suite.test.js` asserts that against the detector's own
arithmetic, at four curl levels, for all five fingers. The 0.55-vs-0.45
difference in the table above is now a real one notch of deliberate slack
rather than an artefact of measuring different things.

**`thumbExtension` still names two different quantities.** The detector's
`state.thumbExtension` is the thumb tip's distance from the palm centre; the
suite's is the thumb's own straightness along its chain. Nothing reads both, so
this is a naming hazard rather than a bug — but it is a real one, and worth
knowing before comparing the two numbers.

### Flagged, not changed: the detector's thumb measures are scale-dependent

`state.thumbExtension` is `(distance(thumbTip, palmCentre) − 0.02) / 0.13` in
**absolute normalized-image units**, and the up/down sign test uses a raw
`|vsep| ≥ 0.06` the same way. Neither divides by hand size, so both change with
how close you are. The identical synthetic thumbs-up, measured at three camera
distances:

| hand scale | `state.thumbExtension` | its own floor is 0.45 |
|---:|---:|---|
| 0.05 (far) | 0.23 | fails |
| 0.09 | 0.53 | passes |
| 0.16 (near) | 1.00 | passes |

A 4.3× swing across the same pose. In practice the `thumbProxMin` gate already
demands a near-camera hand, so the two constraints overlap and the gesture works
where it is meant to — but the extension floor is doing distance-gating rather
than shape-gating, which is not what its name says. This is the same class of
bug that broke pray's `separation` (see
[HAND_GESTURE_PRAY.md](HAND_GESTURE_PRAY.md)); dividing by `palmLength` would
fix it. Left alone here because `hand-pose-detector.js` is shared with
Psychodeli+ and its thumb behaviour is shipped and tuned.

## Consuming

```js
// One channel for the whole suite.
MotionBus.subscribe('handPoses', (poses) => {
    if (poses?.peace?.track?.active) { /* … */ }
});

// Or the punctuation only.
window.addEventListener('camerastein:peace', (e) => console.log(e.detail.phase));
window.addEventListener('camerastein:handpose', (e) => console.log(e.detail.kind, e.detail.phase));
```

`window.HandPoses.status()` reports what is holding and what is blocking
everything else, one criterion at a time:

```js
{ active: ['peace'],
  blocked: { fist: 'indexExtension + middleExtension',
             point: 'middleExtension', … } }
```

Pray keeps its own channel (`prayGesture`, `camerastein:pray`) because it is a
two-hand gesture with its own occlusion tiers.

## Diagnosing a silent strike card

`strikeCount` sitting at zero has three different causes and the count alone
distinguishes none of them, so the lab measures peak downward wrist speed
itself — the detector compares a per-frame `vy` against `__handStrikeThresh`
but publishes neither — and reports it against the bar it has to clear:

```
strikes  0      peak / needed  0.100 / 0.018
```

| What the card says | Cause |
|---|---|
| No hand tracked | Hand mode is off, or no hand is visible. Nothing is measured. |
| Peak below the bar | The hand is tracked and moving too gently. Strike harder or lower the threshold. |
| Fast enough, low hand rate | Most hits are falling between samples. Dedicated Hand mode. |
| Fast enough, rate fine | A strike needs a fast descent **followed by a stop**. A smooth continuous sweep never registers one — the detector fires on the deceleration, not the movement. |

That last row is the non-obvious one and it is real detector behaviour: the
descent sets a flag, and the strike fires on the first frame whose velocity
falls back under the threshold. Ending a stroke while still moving produces no
hit at all.

The peak decays over `max(2 s, 4 frames)` rather than a flat 2 s. At 0.83 Hz a
fixed window erased the reading between samples — at exactly the rate the
readout exists to explain.

## Validation

```bash
npm test    # every recognizer is camera-free and deterministic
```

In the lab, every held pose has a **rehearse** button that runs synthetic
landmarks through a private recognizer — it never touches the live bus. The
strike card has no rehearse button and refuses one if asked: it has no
lifecycle to rehearse, and a button that faked one would be worse than none.

A rehearsal proves the recognizer and the lab. It proves nothing about landmark
extraction from a real camera — that is what
[PRAY_TEST_SCRIPT.md](PRAY_TEST_SCRIPT.md) is for, and the same layer
discipline applies to every pose here.

## Live-test status

One guided run so far (2026-09-24, one subject, desktop webcam, Hand mode at
~18.7 Hz), recorded with the lab's **guided run** and replayed offline:

| pose | live | note |
|---|---|---|
| openPalm, thumbsUp, thumbsDown | ✅ | |
| point, peace | ✅ after reach | straightness failed both |
| fist | ❌ reads thumbsUp | thumb needs its own test |
| horns | untested | performed as bull horns; the prompt now shows the cue |
| pray | ❌ this run | MediaPipe lost both hands, backlit; pray passed earlier runs |

**Relaxed hands read as openPalm — fixed.** Asked to rest, the subject held
both hands in view, backs to the camera, fingers drooping. The fingers were
loosely straight enough to pass every extension bound, and FACING only bounds
aspect from below (not edge-on). A pitched palm is the other side: its length
foreshortens and aspect climbs past 1 (≥ 1.14 in 95% of rest frames, against
0.46–0.48 for a real open palm). openPalm now also requires `palmLengthRatio`
(1 ÷ aspect) ≥ 0.9. Replay: rest went from openPalm 90% to nothing, openPalm
unchanged at 100%. Only openPalm carries this gate — thumbsUp/Down are
legitimately side-on (aspect 1.0–1.5).

The guided run's single "rest" cue is now two negatives with explicit
instructions: **hands out of view** (the no-hand baseline) and **hands in view,
not posing** (let them hang, chin on a hand, fidget — nothing should fire).
