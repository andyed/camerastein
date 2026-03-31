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
- **Audio-visual relevance:** Heart rate and stress reactivity as input signals for interactive experiences. The rPPG algorithms work from the same face mesh landmarks we already capture.

### understanding-mediapipe-facemesh-output
- **Repo:** https://github.com/lschmelzeisen/understanding-mediapipe-facemesh-output
- **Use:** Reference for which of the 468 face landmarks correspond to which facial features. Useful for building simplified face visualizations and expression extraction.


## Adoption of Camera for User Input

Camera-based input is crossing from accessibility niche into mainstream platform feature. The signal processing camerastein already does (head orientation, hand landmarks, body pose) is the same foundation these systems build on.

### Platform-level adoption

Apple ships camera input as a first-party accessibility feature on both platforms:
- **macOS Head Pointer** (since Catalina 10.15.4) — head tracking via built-in camera, dwell-click, adjustable sensitivity
- **iOS 18 Eye Tracking** — gaze-based cursor + dwell-click via front camera, iPhone 12+, all on-device

This signals that camera-as-input-device is no longer experimental — it's an OS primitive.

### Open source projects

#### OptiKey
- **Repo:** https://github.com/OptiKey/OptiKey
- **License:** GPL-3.0 | **Stars:** ~4,400
- **Use:** Full keyboard + mouse via eye tracking (Tobii + webcam fallback). Built for ALS/MND users. Dwell-click with visual progress ring. Mature, actively maintained.
- **Status:** Active (March 2026)

#### WebGazer.js (Brown University)
- **Repo:** https://github.com/brownhci/WebGazer
- **License:** Custom | **Stars:** ~3,800
- **Use:** Browser-native gaze estimation. Self-calibrates by watching where users click. Provides x,y gaze coordinates via `setGazeListener()`. Published in IJCAI. All processing client-side.
- **Status:** Active (March 2026)
- **Relevance:** The browser gaze library. Could layer on top of camerastein's FaceMesh detection.

#### Tracky Mouse
- **Repo:** https://github.com/1j01/tracky-mouse
- **License:** MIT | **Stars:** ~58
- **Use:** Head tracking for cursor control. Electron app + embeddable JS library. Hybrid approach: blends optical flow point tracking (responsive, drifts) with 3D head tilt estimation (drift-free, jittery) via a user-adjustable slider. Best UX documentation of any project in this space.
- **Status:** Active (March 2026)
- **Relevance:** The hybrid tracking approach and smoothing patterns are directly applicable to any input mapping from camerastein's head signals.

#### Project Gameface (Google)
- **Repo:** https://github.com/google/project-gameface
- **License:** Apache 2.0 | **Stars:** ~624
- **Use:** Head movement + facial gestures (eyebrow raise, mouth open) via MediaPipe. Co-designed with quadriplegic gamer Lance Carr. Adjustable "gesture size" dead zone.
- **Status:** Archived September 2025

#### Gesture-Controlled Virtual Mouse
- **Repo:** https://github.com/Viral-Doshi/Gesture-Controlled-Virtual-Mouse
- **License:** GPL-3.0 | **Stars:** ~776
- **Use:** Hand gestures via MediaPipe for cursor, click, drag, scroll, volume, brightness. Most fully-featured hand gesture project. Also includes voice assistant.
- **Status:** Active (March 2026)

#### PolyMouse (research)
- **Repo:** https://github.com/trishume/PolyMouse
- **Stars:** ~51
- **Use:** Sensor fusion — combines eye gaze (fast, coarse) with head tracking (slow, precise). Eye gets you to the neighborhood, head gets you to the pixel. Best research on hybrid input approaches.

### Commercial products

| Product | Control Method | Platform | Price | Notes |
|---------|---------------|----------|-------|-------|
| **Talon Voice** | Voice + Tobii eye tracker | Mac/Linux/Windows | Free (Patreon) | Gold standard for hands-free coding. Used by developers with RSI. Requires Tobii hardware. |
| **Cephable** | Head + face + voice (all webcam) | All platforms | Free personal | Most polished consumer product. All on-device. No programming needed for custom actions. |
| **Smyle Mouse** | Head + smile-to-click | Windows | Commercial | 10+ years of refinement. Patented. Professional productivity focus. |
| **SensePilot** | Face + gesture + speech | Cross-platform | $30/mo trial | Multiple accessibility awards (2024-2026). Adapts to user's range of motion. |
| **Neural Lab AirTouch** | 3D hand gestures + gaze intent | Win/Android/Linux | $30/mo | CES 2025. Uses gaze to filter intentional vs. incidental gestures. |
| **Camera Mouse** (Boston College) | Head tracking | Windows | Free | 3.3M+ downloads. Standard recommendation for motor-impaired users. |

### UX patterns for camera input

**Jitter control:** One Euro Filter is the consensus approach (MediaPipe uses it internally). Adaptive cutoff: aggressive smoothing when still, minimal lag when moving. Parameters: `min_cutoff` (stationary jitter), `beta` (movement lag tradeoff).

**Dead zones:** Joystick-style center threshold — input only registers when displacement exceeds a minimum. Project Gameface calls this "gesture size." Essential for any continuous mapping from head/hand position to a control value.

**Dwell activation:** For click/select actions, hold position for N seconds. Visual progress indicator (shrinking circle or filling ring). Adjustable timing. Auto-pause when physical input device detected.

**Sensor fusion:** PolyMouse's insight — combine fast-coarse (gaze) with slow-precise (head) for better targeting than either alone. Generalizes: any two signal sources with complementary speed/precision tradeoffs can be fused.

**Intent detection:** Neural Lab AirTouch's approach — use gaze direction to determine whether a hand gesture is intentional (user looking at screen) vs. incidental (user gesturing while talking). Prevents false positives.

### Observations

1. Camera input has graduated from research/accessibility into platform features (Apple ships it in both OSes).
2. The signal processing is mature — One Euro Filter, dead zones, dwell-click are solved patterns.
3. Hand gesture systems are the most feature-rich but require hands to be visible and free.
4. Head/face tracking works while hands are occupied (typing, holding something, eating).
5. Sensor fusion (gaze + head) outperforms either alone but adds complexity.
6. Intent detection (is this gesture deliberate?) remains an open UX problem — gaze-gating is the best current approach.
7. Most projects focus on cursor positioning and clicking. Other input modalities (scrolling, zooming, panning, text selection) are underexplored relative to the signal richness available from face/hand landmarks.

