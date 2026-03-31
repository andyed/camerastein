# MediaPipe Legacy → Tasks Vision Migration

## Current State

Camerastein (and Psychodeli+) use the **legacy** MediaPipe JS packages loaded from CDN:
- `@mediapipe/face_mesh` → FaceMesh (468 landmarks)
- `@mediapipe/pose` → Pose (33 landmarks)
- `@mediapipe/hands` → Hands (21 landmarks × 2)

These are loaded via `mediapipe-base-loader.js` which injects `<script>` tags from jsdelivr/unpkg. Each has its own API shape, initialization pattern, and result format.

## Target: `@mediapipe/tasks-vision`

The official replacement. Single package, unified interface:
- `FaceLandmarker` — replaces FaceMesh
- `PoseLandmarker` — replaces Pose, **supports multi-person natively**
- `HandLandmarker` — replaces Hands

### Why Migrate

1. **Legacy packages are deprecated** — no new features, bug fixes uncertain
2. **Unified API** — all three landmarkers share the same initialization, result format, and lifecycle
3. **Multi-person pose** — PoseLandmarker can detect multiple people without workarounds
4. **Better performance** — GPU delegate support, WebGPU path, optimized WASM backend
5. **Active maintenance** — the only API Google is investing in
6. **npm installable** — proper ES module, no CDN script injection needed

### API Comparison

**Legacy (current):**
```js
// Each model has a different global constructor and result shape
const faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
faceMesh.setOptions({ maxNumFaces: 4, refineLandmarks: true });
faceMesh.onResults((results) => {
    // results.multiFaceLandmarks — array of 468-landmark arrays
});
await faceMesh.send({ image: videoElement });
```

**Tasks Vision (target):**
```js
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
);
const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'face_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 4,
    outputFaceBlendshapes: true,  // NEW: 52 facial expression weights
});

// Synchronous per-frame call (no callback)
const result = faceLandmarker.detectForVideo(videoElement, timestamp);
// result.faceLandmarks — same 468 landmarks
// result.faceBlendshapes — NEW: expression weights (smile, brow, jaw, etc.)
```

### Key Differences

| Aspect | Legacy | Tasks Vision |
|--------|--------|-------------|
| Loading | CDN script injection | npm + WASM fileset |
| Init | Constructor + setOptions + onResults callback | createFromOptions (async factory) |
| Per-frame | `model.send({image})` → callback | `model.detectForVideo(image, ts)` → sync return |
| Results | `results.multiFaceLandmarks` | `result.faceLandmarks` |
| Multi-person pose | Not supported | `numPoses` option |
| Face expressions | Not available | 52 blendshape weights |
| GPU delegate | Limited | Full GPU/WebGPU support |
| Running mode | Always video | IMAGE or VIDEO mode |

### New Capabilities We'd Get

- **Face Blendshapes** — 52 expression weights (browDown, eyeSquint, jawOpen, mouthSmile, etc.). This is the path to giving Claude expression feedback from the user.
- **Multi-person pose** — `numPoses: 6` for crowd detection without model switching
- **Gesture recognition** — `GestureRecognizer` task (thumbs up, pointing, etc.) as a separate landmarker
- **Object detection** — could detect phones, instruments, etc. in frame
- **Image segmentation** — selfie segmentation for background removal

## Migration Plan

### Phase 1: Adapter Layer in Camerastein

Don't rewrite the detectors. Instead, create an adapter that wraps Tasks Vision landmarkers and emits results in the legacy format that our detectors expect.

```
TasksVisionAdapter
  ├── createFaceLandmarker() → emits legacy-shaped results to HeadBobDetector._onResults
  ├── createPoseLandmarker()  → emits legacy-shaped results to BodyMotionDetector._onResults
  └── createHandLandmarker()  → emits legacy-shaped results to HandPoseDetector._onResults
```

This lets us:
- Keep all signal processing logic untouched
- A/B test legacy vs tasks-vision performance
- Migrate incrementally (one landmarker at a time)

### Phase 2: Replace SharedCameraManager Frame Loop

The legacy approach: SharedCameraManager runs a rAF loop, calls `model.send()`, model fires callback.

Tasks Vision is synchronous: `model.detectForVideo(video, timestamp)` returns results immediately. This simplifies the frame loop significantly — no callbacks, no race conditions.

### Phase 3: Add New Signals

Once on Tasks Vision:
- Wire face blendshapes into MotionBus as a new channel (`expressionSync`)
- Enable multi-person pose (`numPoses > 1`)
- Experiment with GestureRecognizer

### Phase 4: Upstream to Psychodeli+

After proving in camerastein, migrate the adapter back to psychodeli-webgl-port. The DI pattern means Psychodeli+ can switch between legacy and tasks-vision via init() config.

## Result Format Translation

### Face Landmarks
- Legacy: `results.multiFaceLandmarks[i]` — array of `{x, y, z}` (0-1 normalized)
- Tasks: `result.faceLandmarks[i]` — array of `{x, y, z}` (0-1 normalized)
- **Translation:** Rename the property. Coordinates are compatible.

### Pose Landmarks
- Legacy: `results.poseLandmarks` — array of `{x, y, z, visibility}` (single person)
- Tasks: `result.landmarks[i]` — array of `{x, y, z, visibility}` (per-person)
- **Translation:** `result.landmarks[0]` → legacy shape. Multi-person is `result.landmarks[1..n]`.

### Hand Landmarks
- Legacy: `results.multiHandLandmarks[i]` — array of `{x, y, z}`
- Tasks: `result.landmarks[i]` — array of `{x, y, z}`
- **Translation:** Rename. Handedness available in `result.handedness[i]`.

## Dependencies

```bash
npm install @mediapipe/tasks-vision
```

WASM files (~4MB) served from CDN or bundled locally. Models (~5-10MB each) downloaded on first use, cached by browser.

## Timeline

Not urgent — the legacy packages work fine for now. This becomes priority when:
1. A legacy package breaks or CDN goes down
2. We need face expressions (blendshapes) for Claude gesture feedback
3. We need multi-person pose for crowd features
4. Performance on mobile needs improvement (GPU delegate)
