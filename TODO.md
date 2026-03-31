# Camerastein TODO

## Features

- [ ] **High-precision hand mode** — When hands are the only active detector (no head/body), promote from overlay (~3Hz) to primary slot (full frame rate ~20fps). Demote back to overlay when head/body activates. Also unlock higher numHands or confidence thresholds with the extra compute budget. Benchmark FPS/latency difference first.

- [ ] **Blendshape visualization** — Display the 52 face expression weights in the UI (bar chart or heatmap). Data is already flowing via `MotionBus.state.blendshapes`.

- [ ] **Multi-person pose** — Set `numPoses > 1` in PoseLandmarker, render multiple skeletons, track crowd energy/synchrony.

- [ ] **Capture tool** — Record camera feed + MotionBus signals for replay testing (see docs/TESTING_PLAN.md).

- [ ] **Replay tool** — Feed pre-recorded video through detectors for deterministic testing.

- [ ] **GestureRecognizer** — Tasks Vision has a separate gesture task (thumbs up, pointing, victory). Add as a 4th MotionBus channel.

## Bugs / Polish

- [ ] **Remove legacy mode** — Make Tasks Vision the only path, remove A/B toggle and init.js legacy wiring.

- [ ] **NORM_RECT warning** — Tasks Vision warns about non-square ROI. Investigate IMAGE_DIMENSIONS option to suppress.
