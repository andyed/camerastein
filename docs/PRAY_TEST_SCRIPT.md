# Pray Recognizer — Live Test Script

First live validation of the two-hand pray recognizer. Everything in
[HAND_GESTURE_PRAY.md](HAND_GESTURE_PRAY.md) is verified against synthetic
landmarks and in-browser bus traffic; **none of it has met a real webcam.**
This script is what closes that gap.

Layer discipline, same as [TESTING_PLAN.md](TESTING_PLAN.md):

| Step | Input | Proves | Does not prove |
|---|---|---|---|
| 0 — `npm test` | synthetic landmarks | recognizer state machine, geometry, channel wiring | anything about MediaPipe |
| 1 — rehearse | synthetic landmarks | panel + HUD render the lifecycle | landmark extraction |
| 2–6 — live | your hands | thresholds, occlusion behaviour, false positives | deterministic regression |

## Setup

```bash
cd ~/Documents/dev/camerastein && npm test    # expect 77/77
```

```bash
cd ~/Documents/dev/camerastein && npm start   # http://localhost:8081
```

In the browser:

1. Click **Hand** in the control bar. Grant camera access.
2. Click **hands** (top right) to open the Hand gesture lab. A large HUD appears bottom-left.
3. Confirm **hand rate** in the panel reads above ~2 Hz. Below that, the
   700 ms dwell gets fewer than two samples and nothing will fire reliably —
   the panel warns when this happens.

Sit so both hands fit in frame with room above them. Ordinary room light. Note
your camera (FaceTime, Continuity, external) in the results table — it matters.

## Step 0 — Camera-free sanity (no webcam)

Click **rehearse**. Expect the event log to fill `start → peak → release` and
the verdict to read **rehearsal passed** (~1–2 s of playback). If this fails,
stop: the problem is the recognizer or the panel, not the camera.

The same thing from the console, if you'd rather watch the raw events:

```js
const { makePrayPose, makeOpenPalmsPose } = await import('/js/lib/hand-pose-fixtures.js');
window.addEventListener('camerastein:pray', e => console.log(e.detail.phase, e.detail.strength));
let t = performance.now();
const feed = (hands, n) => { for (let i = 0; i < n; i++) {
  window.MotionBus.emit('handPose', { t, timestamp: t, confidence: 0.9,
    handCount: hands.length, landmarks: hands[0] || null, landmarks2: hands[1] || null });
  t += 360; } };
feed(makeOpenPalmsPose(), 2); feed(makePrayPose(), 8); feed(makeOpenPalmsPose(), 3);
// → start 1  peak 1  release 1
```

## Step 1 — Does MediaPipe see two hands in the pose at all?

**This is the step most likely to fail, and it is not a threshold problem.**
Pressed palms occlude each other; MediaPipe may report one hand, or flip
handedness frame to frame.

Bring your palms together slowly, from a hand-width apart to touching, and watch
the panel's **hands** readout the whole way.

- Stays at `2` all the way to contact → the design assumption holds.
- Drops to `1` near contact → record **at what separation** it drops. That
  number, not the thresholds, is the real ceiling on this gesture, and the
  answer is either to keep a deliberate gap (relax `separation`) or to angle the
  hands slightly toward the camera.

Record the separation reading at the moment it drops.

## Step 2 — Baseline pray

Palms flat, pressed together, fingers up, at chest height. Hold ~2 s. Repeat ×5.

Expect: HUD `idle → rising` (amber) `→ PRAY` (green), dwell bar filling over
700 ms, event log `start`, then `release` when you lower your hands.

Record hits out of 5. **Target for a first session: 4/5.**

If it never starts, read the panel — exactly one criterion will be marked
**fail**, and the HUD says *blocked by \<name\>*. Take that to Step 5.

## Step 3 — Position and distance invariance

The whole point of the palm-local features is that none of this should matter.
Perform pray:

| Variation | Expect |
|---|---|
| far left of frame, then far right | fires identically |
| close to the camera, then at arm's length | fires identically; `separation` barely moves |
| leaning ~30° off vertical | fires; `uprightness` drops but stays above 0.45 |
| tilted ~70° off vertical | does **not** fire (`uprightness` fails) |

If `separation` moves materially with distance, something is wrong with the palm
scale, not with the threshold.

## Step 4 — False positives (the part that actually matters)

Hold each of these for 3 s. **None may fire.** Note the phase the HUD reaches —
`rising` is a near miss worth recording even when nothing starts.

| Pose | Criterion that should stop it |
|---|---|
| Two open palms facing the camera, apart | `separation`, `palms edge-on` |
| Two flat palms held close, both facing the camera | `palms edge-on` — and nothing else |
| Handshake — palms opposed, fingers pointing at each other | `fingers aligned` |
| Fingers interlocked / loose clasp | `hands flat` |
| Clapping | the dwell — 700 ms of stillness |
| Two fists together | `hands flat` |
| Typing, resting hands, gesturing while talking | any |
| Hands together but horizontal (a "sandwich") | `fingers up` |

**Known accepted false positive:** backs of the hands pressed together, fingers
up. `palms opposed` reads the thumbs, which cannot tell facing-each-other from
back-to-back. Confirm it fires; do not treat it as a bug.

Then leave the camera running for 2 minutes of ordinary desk work and confirm
the event log stays empty. A gesture that fires while you type is worse than one
that never fires.

## Step 5 — Tune, if Step 2 missed

Open **live thresholds** in the panel. Change one slider at a time, re-run Step
2, then **re-run Step 4** — every relaxation buys sensitivity with false
positives, and Step 4 is the price check.

Read the **last 90 frames** tally first — whichever reason dominates is the
diagnosis, and it tells you whether tuning is even the right lever.

| Tally / symptom | Move |
|---|---|
| `blocked: separation` at contact | raise **separation enter** toward 1.2 |
| `blocked: palms opposed` | raise **palms-opposed veto** toward 1 — this criterion should rarely block a real pray |
| `blocked: palms edge-on` | raise **edge-on enter** toward 0.7; you may be angling the pair toward the lens |
| `blocked: hands flat` | lower **flatness enter** toward 0.78 |
| `one-hand` dominates | not a threshold problem — see Step 1, and try the tracking-confidence lever below |
| Fires while your hands merely pass through | raise **hold ms** |
| Starts then immediately releases | hand rate too low, or `nilToleranceMs` below the frame interval |

If `one-hand` dominates, MediaPipe is dropping the hand before anything can
arm. Its tracking gate is the upstream lever — in the console, before enabling
Hand mode:

```js
window.__handMinTracking = 0.3;   // default 0.5; lower holds a hand through ambiguity
```

Then toggle Hand off and on so the model reloads with the new option.

Sliders write `window.__pray*` and retune the live recognizer immediately.
**restore defaults** clears them. Anything you keep should land in the tuning
table in `HAND_GESTURE_PRAY.md` with a note on what moved and why.

## Step 6 — Degradation

1. Perform pray, then drop one hand out of frame for ~300 ms and bring it back.
   Expect one continuous episode, not a `release` and a second `start`.
2. **Hold the pose for 20 s.** MediaPipe will usually see only one hand for most
   of that. Expect a single episode the whole time, the lab reading
   `one-hand-armed`, and the HUD counting up past 20 s. If it ends early, note
   the reason it ended on — `one-hand-moving` means the drift gate, anything
   else means the pose stopped matching.
3. Perform pray, then drop both hands for 2 s. Expect `release`.
4. Perform pray on one visible hand, then move that hand sideways without
   breaking its shape. Expect `one-hand-moving` and a prompt `release`.
5. Perform pray, switch to **Head** mode mid-hold, switch back. Expect a single
   `release` carrying `reason: discontinuity` — never a stale episode that
   survived the blackout.

## Results to record

```
date / camera / lighting / distance:
hand rate (Hz):
step 1 — hands stay at 2 down to separation:
step 2 — hits: __/5     median time to start:
step 3 — failures:
step 4 — false positives (pose → phase reached):
step 5 — thresholds changed:
step 6 — 20 s hold survived? / occlusion / loss / mode switch:
```

Paste `window.PrayGesture.status()` at the moment of any surprise — it carries
all five measurements, the bound in force, and the frame age in one line.
