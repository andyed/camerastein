# Camerastein

**[Live Demo](https://andyed.github.io/camerastein/)** | **[Tasks Vision Demo](https://andyed.github.io/camerastein/?tasks-vision)**

Camera body signal detection platform — head, body, and hands via MediaPipe.

Camerastein is a testbed for the MediaPipe motion detection system used in [Psychodeli+](https://psychodeli.com) (closed source). It extracts the detection, signal processing, and event bus architecture into a standalone web app for:

- **Iterating on motion representations** — stick figure rendering, signal sparklines, landmark visualization
- **Testing face gesture recognizers** — live feature/phase inspection plus isolated deterministic rehearsals for mouth, brow, lean, nod, shake, and scream
- **Performance benchmarking** — model load times, per-frame detection latency (P50/P95/P99), memory usage
- **Encouraging extension** — gaze tracking, facial expression analysis, gesture vocabularies, or whatever you want to wire into the MotionBus

## Quick Start

```bash
npm start
# opens http://localhost:8081
```

No build step. No bundler. Just an HTTP server.

For provider-neutral face features and the Gesture Lab, open
`http://localhost:8081/?tasks-vision`, enable **Head**, then click
**gestures**. Every recognizer also has a camera-free **rehearse** action.

## What It Does

Three MediaPipe detectors track your body through a webcam:

| Detector | Input | Key Signals |
|----------|-------|-------------|
| **Head** | Face Mesh (468 landmarks) | Head orientation, bob frequency, beat sync, mouth activity, lean detection |
| **Body** | Pose (33 landmarks) | Sway, bounce, arm spread, torso lean, energy level, gesture recognition |
| **Hand** | Hands (21 landmarks × 2) | Finger spread, pinch, fist closure, palm facing, two-hand distance |

All signals flow through **MotionBus** — a subscribe/emit/state event bus. Consumers read `window.MotionBus.state.rhythm`, `.body`, or `.hand`.

### Detection Concurrency Model

The camera runs a single video stream. SharedCameraManager enforces a two-tier scheduling model:

**Primary slot (exclusive):** Head and Body share one processing slot — only one runs at a time. Activating Body stops Head, and vice versa. When both modes have been used in a session, auto-switch engages: if the active detector's confidence drops below 0.3 for 2+ seconds (face leaves frame, body turns away), it switches to the other. Cooldown prevents rapid oscillation (5s between switches).

**Overlay slot (concurrent):** Hands run alongside whichever primary is active, but throttled — every 6th paced tick on desktop, every 12th on mobile. Because the skip counter advances per *paced* tick (not per rAF frame), the achieved hand rate is `targetFPS / skip`: ~2.8 Hz on desktop (17 fps loop ÷ 6), but only ~0.83 Hz on mobile (10 fps loop ÷ 12) — and half that again under render pressure. That's up to 1.2–2.4 s of gesture latency on mobile.

This is the current implementation boundary: automation switches **Head ↔ Body**. Hands are manually enabled as either the throttled overlay or the dedicated detector; hand activity does not yet participate in automatic switching.

```
Skip (default):   [Head] [Head] [Head] [Head] [Head] [Hand+Head] [Head] ...
                                                       ↑ overlay every Nth paced tick

Interleave:       [Head] [Head] [Hand] [Head] [Head] [Hand] [Head] ...
                                  ↑ one model per tick, ratio 2:1
```

**Experimental: interleave scheduler.** Set `window.__handInterleave = true` (ratio via `window.__handInterleaveRatio`, default 2) to alternate primary and hand inference across paced ticks instead of starving hands. Each tick runs exactly one model, so the 0.85 overlay FPS tax is skipped — on mobile at 12 fps with ratio 2 that yields primary ~8 Hz / hands ~4 Hz versus the default 10 Hz / 0.83 Hz. The body-probe window suspends interleaving (its velocity math assumes consecutive pose frames). Off by default until validated on a real device via the tracking stats below.

**Tracking telemetry.** `camera-tracking-stats.js` times every `send()` per channel (`face` / `pose` / `hand`) into a shared `window.CameraTrackingStats` singleton. `sharedCameraManager.getTrackingStats()` returns the scheduler mode, planned vs. achieved per-channel rates, p50/p95 inference latency, and `loadMsPerSec` — total inference milliseconds per wall-clock second, the honest "what does tracking cost the main thread" number. Currently a console/diagnostic API; not yet folded into the bench panel export.

Both MediaPipe models stay loaded in memory (~7 MB total) for instant switching. The latency on mode switch is the frame processing time, not a model reload.

### Direction: attention-aware mobile scheduling

Camerastein is the portability boundary for more ambitious camera resource policy. The next scheduler should separate two decisions:

1. An **attention arbiter** promotes face, hand, or body from low-rate scouting to foreground quality based on presence and meaningful activity. The first target is face↔hand: face at roughly 10–12 Hz with hands scouting near 2 Hz, then hands at 8–12 Hz while an active gesture is sustained and face drops to a watchdog rate.
2. A **deadline scheduler** budgets work using measured inference cost per model, device class, render FPS, visibility, and constrained/thermal state. Fixed frame skips remain safe defaults, not the final policy. `CameraTrackingStats` now supplies the measured-cost input, and the interleave scheduler is the first concrete step past fixed skips.

Promotion needs dwell and hysteresis (`FACE_FOREGROUND → HAND_CANDIDATE → HAND_FOREGROUND`), a cooldown, and a user override. Model residency should be independently configurable: keep models warm when memory permits, unload inactive models on constrained devices. Exported benchmarks should include scheduler state, transitions, inference cost, and missed deadlines so Psychodeli and native iOS can adopt a policy already tested here.

## Architecture

```
Camera → SharedCameraManager → MediaPipe models → Detectors → MotionBus → UI
              ↑                      ↑                ↓
        single stream         primary + overlay    init(deps)
        shared by all         scheduling model   (dependency injection)
```

The detection files use a `_dep(name)` pattern with window fallback. Call `init()` with only the deps your app provides — missing deps degrade gracefully (no crash, just no side effects). This is how Camerastein runs the same detector code as Psychodeli+ without any of its audio/visual systems.

### Files

```
js/lib/           # Detection library (shared with Psychodeli+)
  motion-bus.js           # Event bus — subscribe/emit/state
  mediapipe-base-loader.js # CDN model loading with timeout + fallback
  mediapipe-loader.js     # FaceMesh singleton
  pose-loader.js          # Pose singleton
  hands-loader.js         # Hands singleton
  camera-resource-policy.js # Pure pacing policy — FPS targets, frame skip, interleave slots
  camera-tracking-stats.js  # Per-channel inference latency + achieved-rate telemetry
  shared-camera-manager.js # Single camera stream, multi-detector
  head-bob-detector.js    # Face/head signal processing
  body-motion-detector.js # Body/pose signal processing
  hand-pose-detector.js   # Hand gesture signal processing

js/               # Camerastein app
  init.js                 # DI wiring with no-op stubs
  init-tasks-vision.js    # Tasks Vision + FaceFeatures/FaceGestures wiring
  app.js                  # Main entry, component wiring
  gesture-lab.js          # Live recognizer inspector + deterministic rehearsals
  skeleton-renderer.js    # Canvas 2D stick figures
  timeline-panel.js       # Sparkline signal history
  controls-ui.js          # Detection toggles, camera picker
  benchmark-harness.js    # Performance measurement + export
```

## MotionBus API

```js
// Subscribe to processed signals
window.MotionBus.subscribe('rhythmSync', (data) => {
    // data.headYaw, data.intensity, data.leanAmount, ...
});

window.MotionBus.subscribe('bodyMotion', (data) => {
    // data.swayAmplitude, data.energyLevel, data.armSpread, ...
});

window.MotionBus.subscribe('handPose', (data) => {
    // data.pinchStrength, data.fistClosure, data.fingerSpread, ...
});

// Subscribe to provider-neutral face geometry. Tasks Vision currently emits
// 478 normalized landmarks (including irises) and canonical connection tables.
window.MotionBus.subscribe('faceLandmarks', (frame) => {
    if (!frame) return; // null means no face is currently detected
    const { landmarks, allFaces, topology, imageSize, source, t } = frame;
    // topology.tessellation, topology.contours, topology.lips, ...
});

// Tasks Vision only: provider-neutral semantic evidence and gesture lifecycles.
window.MotionBus.subscribe('faceFeatures', (features) => {
    // expression.jawOpen, browRaiseL/R; pose.pitch/yaw/proximity; dynamics...
});

window.MotionBus.subscribe('faceGestures', (gestures) => {
    // tracks.mouth/brow/leanIn/leanOut; cycles.nod/shake;
    // compound.scream; edge events[] with stable lifecycle phases
});

// Poll current state
const rhythm = window.MotionBus.state.rhythm; // null when inactive
const body = window.MotionBus.state.body;
const hand = window.MotionBus.state.hand;
```

## Extending

To add a new detector (e.g., gaze tracking):

1. Create your detector class with `init(deps)` + `_dep(name)` pattern
2. Emit to MotionBus: `window.MotionBus.emit('gazeTracking', { x, y, confidence })`
3. Wire it in `init.js`
4. Subscribe in your UI: `window.MotionBus.subscribe('gazeTracking', handler)`

The MotionBus doesn't care what you emit — any channel name works.

Run `npm test` for the portable face-mesh contract, renderer checks, pacing-policy math (interleave slots, planned rates, hysteresis), and tracking-stats telemetry.

## Benchmarking

Click **bench** in the top bar to open the performance panel. Metrics:

- **Model load times** — first-load latency per MediaPipe model
- **Detection latency** — P50/P95/P99 per-frame processing time per detector
- **Render FPS** — main loop frame rate
- **Memory** — JS heap usage (Chrome only)

Export as JSON for comparison across devices/browsers.

## Relationship to Psychodeli+

The `js/lib/` detection files are shared with [Psychodeli+](https://psychodeli.com) (closed source). In Psychodeli+, these detectors feed an AI director that maps body movement to real-time fractal visuals. Here they run standalone for testing and development.

Changes flow upstream: improvements made here get merged back into Psychodeli+.

## Further Reading

- [Related Projects & Libraries](docs/RELATED_PROJECTS.md) — open source projects, UX patterns, and platform adoption of camera-based input
- [Testing Plan](docs/TESTING_PLAN.md) — video replay testing, signal comparison, benchmark regression
- [Face Gesture Contract](docs/FACE_GESTURE_CONTRACT.md) — shared provider-neutral lifecycle API and current tuning
- [Face Gesture Lab](docs/FACE_GESTURE_LAB.md) — operator guide, live test script, failure triage, and extension checklist

## License

MIT
