# Camerastein TODO

## Features

- [ ] **High-precision hand mode** — When hands are the only active detector (no head/body), promote from overlay (~3Hz) to primary slot (full frame rate ~20fps). Demote back to overlay when head/body activates. Also unlock higher numHands or confidence thresholds with the extra compute budget. Benchmark FPS/latency difference first.

- [ ] **Blendshape visualization** — Display the 52 face expression weights in the UI (bar chart or heatmap). Data is already flowing via `MotionBus.state.blendshapes`.

- [ ] **Multi-person pose** — Set `numPoses > 1` in PoseLandmarker, render multiple skeletons, track crowd energy/synchrony.

- [ ] **Capture tool** — Record camera feed + MotionBus signals for replay testing (see docs/TESTING_PLAN.md).

- [ ] **Replay tool** — Feed pre-recorded video through detectors for deterministic testing.

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
