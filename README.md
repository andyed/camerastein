# Camerastein

**[Live Demo](https://andyed.github.io/camerastein/)** | **[Tasks Vision Demo](https://andyed.github.io/camerastein/?tasks-vision)**

Camera body signal detection platform — head, body, and hands via MediaPipe.

Camerastein is a testbed for the MediaPipe motion detection system used in [Psychodeli+](https://psychodeli.com) (closed source). It extracts the detection, signal processing, and event bus architecture into a standalone web app for:

- **Iterating on motion representations** — stick figure rendering, signal sparklines, landmark visualization
- **Performance benchmarking** — model load times, per-frame detection latency (P50/P95/P99), memory usage
- **Encouraging extension** — gaze tracking, facial expression analysis, gesture vocabularies, or whatever you want to wire into the MotionBus

## Quick Start

```bash
npm start
# opens http://localhost:8081
```

No build step. No bundler. Just an HTTP server.

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

**Overlay slot (concurrent):** Hands run alongside whichever primary is active, but throttled — processing every 6th frame on desktop (~3 Hz at 20 FPS base) and every 12th on mobile. This prevents the hand model from starving the primary detector of GPU/CPU time.

```
Frame loop:  [Head] [Head] [Head] [Head] [Head] [Hand+Head] [Head] [Head] ...
                                                  ↑
                                          overlay fires every Nth frame
```

Both MediaPipe models stay loaded in memory (~7 MB total) for instant switching. The latency on mode switch is the frame processing time, not a model reload.

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
  shared-camera-manager.js # Single camera stream, multi-detector
  head-bob-detector.js    # Face/head signal processing
  body-motion-detector.js # Body/pose signal processing
  hand-pose-detector.js   # Hand gesture signal processing

js/               # Camerastein app
  init.js                 # DI wiring with no-op stubs
  app.js                  # Main entry, component wiring
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

## License

MIT
