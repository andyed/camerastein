# Camerastein TODO

## Features

- [ ] **High-precision hand mode** — When hands are the only active detector (no head/body), promote from overlay (~3Hz) to primary slot (full frame rate ~20fps). Demote back to overlay when head/body activates. Also unlock higher numHands or confidence thresholds with the extra compute budget. Benchmark FPS/latency difference first.

- [ ] **Blendshape visualization** — Display the 52 face expression weights in the UI (bar chart or heatmap). Data is already flowing via `MotionBus.state.blendshapes`.

- [ ] **Multi-person pose** — Set `numPoses > 1` in PoseLandmarker, render multiple skeletons, track crowd energy/synchrony.

- [ ] **Capture tool** — Record camera feed + MotionBus signals for replay testing (see docs/TESTING_PLAN.md).

- [ ] **Replay tool** — Feed pre-recorded video through detectors for deterministic testing.

- [ ] **Native provider contract (ARKit / Vision / LiDAR) — roadmap, filed 2026-10-01.** Psychodeli's native iOS app now has a Capacitor plugin (`PsychodeliVision`) that owns the front camera through ARKit and emits a provider-neutral `VisionFrame` (478-slot face landmarks mapped onto MediaPipe indices, 52 ARKit blendshapes, metric head transform, Vision 21-joint hands, Vision body → 33-slot pose) which a pure decoder turns into Tasks-Vision-shaped results for the shared publishers. Contract: `psychodeli-webgl-port/docs/IOS_NATIVE_VISION.md`. Camerastein should adopt the same contract as a third provider beside inline/worker MediaPipe: (1) port `js/tasks-vision/native/native-frame-decoder.js` (DOM-free, fixture-tested) and accept `VisionFrame` JSON through the Replay tool, so native-provider behaviour is testable here with recorded device frames and no hardware; (2) a Camerastein Capacitor shell becomes the place ARKit/Vision/LiDAR providers get dogfooded before they ship in Psychodeli, matching the "scheduling belongs in Camerastein" direction in Psychodeli's NATIVE_FACE_CAPTURE_SPEC §6; (3) the rear-camera `depthScene` LiDAR channel (8×8 metric depth grid + per-joint metric z) is the first signal MediaPipe cannot produce at all. Blocked on the Psychodeli device verdict (TrueDepth + non-TrueDepth), not on code.

- [ ] **GestureRecognizer** — Tasks Vision has a separate gesture task (thumbs up, pointing, victory). Add as a 4th MotionBus channel.

## Verification

- [ ] **Dogfood the Face Gesture Lab with a real camera before tuning or releasing.**
  Open `?tasks-vision`, enable **Head**, open **gestures**, and wait for
  **baseline ready**. Test mouth, left/right/both brows, lean in/out, nod,
  shake, and scream three times at conversational amplitude, then once slowly
  and once near threshold. Exercise the negative controls: ordinary speech,
  brow-only and mouth-only must not scream, slow posture drift must not nod,
  and a turn-and-return without an opposite lobe must not shake. Confirm
  lifecycles do not chatter, held gestures do not repeat, and face loss clears
  within the freshness window. Reset baseline after changing seat, framing, or
  camera. Record false positives, misses, evidence peaks, and lifecycle order
  before changing thresholds. After recognition passes here, audition
  Psychodeli Self separately with music for visual amplitude and timing.

## Bugs / Polish

- [ ] **Remove legacy mode** — Make Tasks Vision the only path, remove A/B toggle and init.js legacy wiring.

- [ ] **NORM_RECT warning** — Tasks Vision warns about non-square ROI. Investigate IMAGE_DIMENSIONS option to suppress.
