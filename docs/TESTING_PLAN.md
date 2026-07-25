# Camerastein Testing Plan

## Core Approach

MediaPipe detectors consume live camera feeds. Repeatable tests need **deterministic video input** — same frames, same person, same lighting, every run. The strategy: record reference clips from the app itself, then replay them through the detectors and compare signal output against saved baselines.

Face gestures add a second deterministic layer that does not require video:
provider-neutral `FaceFeatures` frames can be passed directly into the pure,
clock-explicit `FaceGestureRecognizer`. The in-app
[Face Gesture Lab](FACE_GESTURE_LAB.md) uses those same sequences for each
**rehearse** action, so the operator surface and automated lifecycle tests share
one source of truth.

Keep the two layers separate:

| Layer | Input | Proves | Does not prove |
|---|---|---|---|
| Gesture rehearsal | synthetic `FaceFeatures` | recognizer state machine, event order, UI wiring | camera/provider extraction |
| Video replay | recorded pixels | provider translation + features + recognizer | subjective Psychodeli response |
| Live operator script | real person/camera | calibration, thresholds, false positives, ergonomics | deterministic regression |
| Psychodeli audition | shared gestures + Self | visual choreography and felt amplitude | recognizer correctness by itself |

## Video-as-Source Architecture

SharedCameraManager calls `getUserMedia()` internally, but MediaPipe models accept any `HTMLVideoElement`. The path:

1. **Record reference clips** — capture camera feed + MotionBus signals simultaneously from camerastein itself (a "capture mode" that saves both)
2. **Replay mode** — feed a `<video>` element instead of getUserMedia to the detectors
3. **Compare signals** — diff replayed MotionBus output against saved reference signals

## Reference Clips Needed

| Clip | Duration | Purpose |
|------|----------|---------|
| `head-bob-steady.webm` | 10s | Single person nodding rhythmically — validates bob frequency/amplitude |
| `head-orientation.webm` | 10s | Slow yaw/pitch/roll sweep — validates orientation signals |
| `body-sway.webm` | 15s | Standing person swaying side-to-side — validates sway/bounce |
| `body-arms.webm` | 10s | Arm raises, spread, asymmetric gestures — validates arm signals |
| `hand-gestures.webm` | 15s | Pinch, fist, spread, palm flash sequence — validates all hand signals |
| `multi-person.webm` | 10s | 2 people in frame — validates multi-face/body tracking |
| `crowd-scene.webm` | 15s | 4+ people — validates multi-body limits, face counting, sync detection |
| `empty-room.webm` | 5s | No person — validates null/inactive state, no false detections |
| `enter-exit.webm` | 10s | Person walks in and out of frame — validates face entrance/exit events |
| `low-light.webm` | 10s | Dim conditions — validates graceful degradation |
| `face-gestures.webm` | 20s | neutral → mouth → brow L/R → lean in/out → nod → shake → scream, with negative controls |

## Multi-Person & Crowd Tracking

The detectors already support multiple bodies:
- HeadBobDetector: `maxFaces = 4`, tracks per-face state, emits `faceCountChange` events
- BodyMotionDetector: `maxBodies = 4`, tracks `bodyCount` and `syncedBodies`

### Current Limits
- MediaPipe Pose tracks a single body (multi-person requires running pose multiple times or switching models)
- FaceMesh supports up to 4 faces but performance degrades
- HandPose supports 2 hands (one person's hands)

### Future: Crowd-Scale Detection
MediaPipe and related projects that handle crowds:

- **MediaPipe Holistic** — combined face/pose/hand but single-person only
- **BlazePose Multi** — Google Research, multi-person pose (not yet in standard MediaPipe JS)
- **MoveNet MultiPose** — TensorFlow.js model, up to 6 people, lighter than BlazePose
- **YOLOv8 Pose** — real-time multi-person pose estimation, runs in browser via ONNX
- **OpenPose (via WebAssembly)** — classic multi-person, heavy but comprehensive
- **MediaPipe Tasks (next-gen API)** — `PoseLandmarker` supports multi-person natively, replacing legacy `Pose`

**Recommendation:** When adding crowd support, evaluate MoveNet MultiPose (lightweight, TF.js native) and MediaPipe Tasks PoseLandmarker (official successor). Both run in-browser. The MotionBus architecture already handles this — just emit per-person channels or add a `people` array to the body state.

### Crowd Signals Worth Tracking
- **Crowd energy** — aggregate movement across all detected bodies
- **Synchrony score** — are people moving in sync? (already partially implemented in BodyMotionDetector's `syncedBodies`)
- **Spatial distribution** — clustering, spread, center of mass
- **Entrance/exit rate** — people appearing/disappearing over time

## Implementation Pieces

### 1. Capture Tool (`js/test/capture.js`)
- Button in UI: "Record Reference"
- Captures video via MediaRecorder API (camera feed → webm)
- Simultaneously logs MotionBus signals at 10Hz to JSON
- Saves both: `clips/head-bob-steady.webm` + `clips/head-bob-steady.signals.json`

### 2. Replay Tool (`js/test/replay.js`)
- Load a `.webm` file into a `<video>` element
- Patch SharedCameraManager to use the video element instead of getUserMedia
- Play at 1x speed, let detectors process normally
- Capture output signals to compare against reference

### 3. Signal Comparison (`js/test/compare.js`)
- Load reference `.signals.json` and replay output
- Per-signal tolerance (head yaw within ±0.05, energy within ±0.1)
- Report: pass/fail per signal, max deviation, drift over time
- Visual diff: overlay reference sparkline vs replay sparkline

### 4. Benchmark Regression (`js/test/bench-regression.js`)
- Run same clip across code changes
- Compare P50/P95 latency, memory
- Flag regressions > 10%

## Automated test integration

- `npm test` uses Node's built-in test runner over `tests/*.test.js`.
- **Unit tests** cover provider-neutral face features, gesture state machines,
  camera resource policy, telemetry, and mesh rendering without a camera.
- `tests/gesture-lab.test.js` requires every documented rehearsal to emit its
  exact lifecycle and verifies explicit monotonic clocks.
- **Signal processing tests** should extract pure functions from detectors rather
  than mocking MediaPipe.
- **Integration tests** use replay tool with reference clips
- A future `npm run test:integration` should run replay comparisons once the
  capture/replay tools and checked-in signal references exist.

### Gesture release matrix

For every recognizer change:

1. Positive lifecycle completes with ordinary input.
2. Sub-threshold evidence remains idle.
3. Incomplete cycles do not emit `complete`.
4. Held evidence does not repeat `start`.
5. Refractory windows suppress immediate re-entry.
6. Missing/low-confidence/stale input releases to null.
7. NaN and malformed fields remain finite and non-throwing.
8. Gesture Lab rehearsal reports pass.
9. Live camera script in `FACE_GESTURE_LAB.md` passes.
10. Psychodeli `npm run test:face-sync` confirms shared byte parity.

## Data Storage

- `clips/` directory, gitignored (video files are large)
- `clips/references/` — signal JSON files checked in (small)
- First-run script downloads reference clips from a URL or generates them

## Build Order

1. Capture tool first (need clips before anything else)
2. Replay tool (the SharedCameraManager patch is the tricky part)
3. Signal comparison
4. Vitest unit tests for MotionBus + pure math
5. Bench regression
