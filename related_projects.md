# Related Projects & Libraries

Open source projects with permissive licenses relevant to camerastein's development. Organized by immediate utility.

## Tier 1 — Bootstrap Now

### One Euro Filter
- **Repo:** https://github.com/casiez/OneEuroFilter
- **License:** Public domain / academic
- **Stars:** ~196
- **npm:** `1eurofilter`, `@david18284/one-euro-filter`
- **Use:** Landmark jitter smoothing. Adaptive: aggressive filtering when stationary, reduced smoothing during fast movement. Essential for any real-time landmark visualization.
- **Key params:** `min_cutoff=1.0` (stationary jitter), `beta=0.007` (movement lag)
- **Status:** Active, canonical implementation

### KalidoKit
- **Repo:** https://github.com/yeemachine/kalidokit
- **License:** MIT
- **Stars:** ~5,600
- **Use:** Blendshape + kinematics solver for MediaPipe face/pose/hand. `Face.solve()` converts 468 face landmarks into euler rotations + blendshapes (mouth shapes A/E/I/O/U, pupil tracking, head rotation). `Pose.solve()` and `Hand.solve()` similarly. The math for converting raw landmarks into meaningful parameters — exactly what camerastein needs for dedicated per-recognizer models.
- **Status:** Archived (Feb 2022), but math is stable and extractable

### HandWave (Electron reference)
- **Repo:** https://github.com/JumppanenTomi/HandWave
- **License:** MIT
- **Stars:** ~6
- **Use:** Most complete Electron + MediaPipe + React/TS reference. Vite frontend, Sequelize/SQLite for gesture-to-action mappings, nut-js for HID events. 18-gesture dataset (18k augmented images). Clean IPC bridge with preload/renderer/worker separation.
- **Status:** January 2024
- **Architecture pattern:** Event-driven pipeline: camera frame → gesture recognition → action mapping → HID emission. Best template for wrapping camerastein in Electron.

## Tier 2 — Extract Specific Code

### mediapipe-pose-estimation (new API reference)
- **Repo:** https://github.com/sumitsahoo/mediapipe-pose-estimation
- **License:** MIT
- **Stars:** ~1
- **Use:** Uses the **newest** `@mediapipe/tasks-vision` API (PoseLandmarker, FaceLandmarker). React 19 + Vite 7. Custom hooks (`usePoseDetection`, `useFaceExpression`). Face mesh glow effects. Mobile camera switching. Migration path for camerastein when we move off the legacy MediaPipe API.
- **Status:** March 2026, actively maintained

### js-ai-body-tracker
- **Repo:** https://github.com/szczyglis-dev/js-ai-body-tracker
- **License:** MIT
- **Stars:** ~74
- **Use:** Single-file JS supporting MoveNet, PoseNet, BlazePose. Canvas 2D + ScatterGL 3D rendering. Hook/event system for pluggable detection pipeline — compare with our MotionBus pattern. Supports webcam, video files, IPTV streams.
- **Status:** August 2024

### jwc-mediapipe (smoothing filters)
- **Repo:** https://github.com/JDBar/jwc-mediapipe
- **License:** MIT
- **Stars:** ~2
- **Use:** TypeScript wrapper with EWMA and Kalman Filter smoothing for landmarks. `getLandmarkSmootherEWMA()` and `getLandmarkSmootherKalman()` as interchangeable strategies. Clean Kalman implementation in `lib/KalmanFilter.ts`. Alternative to One Euro Filter.
- **Status:** March 2024

### mediapipe-pose-smooth
- **Repo:** https://github.com/yousufkalim/mediapipe-pose-smooth
- **License:** MIT
- **Stars:** ~13
- **Use:** Dead simple frame-averaging: 8 frames, drop 2 highest/lowest, average remaining 4. `smoothLandmarks(results)` API. Good for quick prototyping before implementing One Euro.
- **Status:** January 2023

## Tier 3 — Reference & Inspiration

### hand-gesture-recognition-mediapipe
- **Repo:** https://github.com/kinivi/hand-gesture-recognition-mediapipe
- **License:** Apache 2.0
- **Stars:** ~2,000+
- **Use:** Two-stage pipeline: MediaPipe detects raw landmarks, then a lightweight MLP classifies the gesture. The "landmarks → derived features → classifier" pattern is the architecture for adding gesture recognition to camerastein.
- **Status:** Active

### threejs-handtracking-101
- **Repo:** https://github.com/collidingScopes/threejs-handtracking-101
- **License:** MIT
- **Stars:** ~147
- **Use:** Three.js + WebGL + MediaPipe Hands. Pinch controls sphere size, proximity triggers color. Good reference for mapping hand landmarks to 3D interaction.
- **Status:** Recent

### MediaPipe-in-JavaScript (demos)
- **Repo:** https://github.com/LintangWisesa/MediaPipe-in-JavaScript
- **License:** Not specified (demo code)
- **Stars:** ~114
- **Use:** Minimal vanilla JS implementations of all MediaPipe solutions. No frameworks. Good for understanding the raw API without abstraction layers.

### mediapipe-js-demos
- **Repo:** https://github.com/pjbelo/mediapipe-js-demos
- **License:** Apache 2.0
- **Stars:** ~47
- **Use:** Eight demos covering all MediaPipe solution types. Consistent structure per demo. Template for multi-mode detection app.

### Gesto (Electron gesture control)
- **Repo:** https://github.com/anurag-deore/Gesto-Electron-Gesture-Control
- **License:** ISC
- **Stars:** ~3
- **Use:** Electron 33 + MediaPipe Hands + Web Workers for ML inference. Demonstrates preload/renderer/worker architecture for keeping main thread responsive.
- **Status:** November 2024

### MediaPipe for OBS
- **Repo:** https://github.com/UUoocl/MediaPipe_for_OBS
- **License:** Not specified
- **Stars:** ~10
- **Use:** Electron app sending landmark data to OBS via WebSocket. Interesting data serialization format (X/Y/Z + visibility). PTZ camera support.
- **Status:** April 2024

### tfjs-models/pose-detection
- **Repo:** https://github.com/tensorflow/tfjs-models/tree/master/pose-detection
- **License:** Apache 2.0
- **Stars:** ~13k (parent repo)
- **Use:** Unified API across MoveNet (fastest, 50+ FPS), BlazePose, PoseNet. Demo folder has clean Canvas 2D skeleton rendering. MoveNet Lightning is the performance benchmark to beat.
- **Status:** Actively maintained

### Handsfree.js (archived)
- **Repo:** https://github.com/MIDIBlocks/handsfree
- **License:** Apache 2.0
- **Stars:** ~1k+ (original)
- **Use:** Plugin system for composing handsfree experiences. `new Handsfree({ hands: true, pose: true })` configuration pattern. Wraps MediaPipe + TensorFlow.js + Jeeliz Weboji.
- **Status:** Archived May 2024

## Tier 4 — Future Features

### VitalLens.js (physiological signals from camera)
- **Repo:** https://github.com/Rouast-Labs/vitallens.js
- **License:** MIT
- **Stars:** ~14
- **Use:** Heart rate, HRV, and respiratory rate estimation from face video. Works in browser and Node.js. Includes local rPPG algorithms (POS, CHROM, G) that don't need an API key. Bundles its own fast face detector.
- **API:** Web Component (`<vitallens-scan>`) and programmatic (`new VitalLens()`)
- **Status:** March 2026, actively maintained
- **Camerastein relevance:** Physiological signal detection from the same camera feed. Stress, engagement, arousal detection. Could feed into MotionBus as a new channel.
- **Psychodeli+ relevance:** Heart rate and stress reactivity as audio-visual input signals. Imagine visuals that respond to your heart rate syncing with the beat. The rPPG algorithms work from the same face mesh landmarks we already capture.

### understanding-mediapipe-facemesh-output
- **Repo:** https://github.com/lschmelzeisen/understanding-mediapipe-facemesh-output
- **Use:** Reference for which of the 468 face landmarks correspond to which facial features. Useful for building simplified face visualizations and expression extraction.

## Migration Notes

### Legacy → New MediaPipe API
Our extracted detection files use the legacy `@mediapipe/pose`, `@mediapipe/hands`, `@mediapipe/face_mesh` packages loaded from CDN. The new API is `@mediapipe/tasks-vision` with `PoseLandmarker`, `HandLandmarker`, `FaceLandmarker`. Key differences:
- Unified API across all tasks
- Better performance (WASM + WebGPU backends)
- Active development (legacy packages are maintenance-only)
- `sumitsahoo/mediapipe-pose-estimation` is the cleanest reference for the new API

This migration is a natural Phase 2 for camerastein after the MVP ships.
