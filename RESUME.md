# Resume — hands-first tracking

**Branch:** `feat/hands-first-tracking` (unpushed, cut from `main` 660c863).
`npm test` → 156 pass, 0 todo.
**Roadmap:** `hands-first-tracking`, `segmentation-channel` (roadmap.json on `main`).
**Docs:** `docs/HAND_GESTURE_SUITE.md`, `docs/HAND_GESTURE_PRAY.md`, `docs/PRAY_TEST_SCRIPT.md`
**Source of the ideas:** toaster (github.com/StopBanning/toaster, MIT). Each
adapted technique cites its toaster file in a comment.

## What this branch added

| Piece | Files | Evidence |
|---|---|---|
| Tasks Vision in a worker, synced from Psychodeli 7c306e4f1 | `js/tasks-vision/**`, `js/lib/shared-camera-manager.js` | hands alone: worker 18.4 Hz, 0.6 ms main thread; inline 8.8 Hz, 110 ms (headless, CPU) |
| Presence pacing | `js/lib/hand-pacing.js` (+ manager, flag `__handPacing`) | head + hands: hand 2.5 → 15.2 Hz, face 15.1 → 7.6 Hz; scouting 3.6 Hz with no hand |
| World landmarks, One Euro smoother | `protocol.js`, `result-translators.js`, `hand-pose-detector.js`, `js/lib/hand-smoother.js` | palm 0.107 m live; tests |
| Motion gestures | `js/lib/motion-gesture-recognizer.js`, `js/lib/hand-motion-channel.js`, lab motion cards | 12 tests; the 2026-09-24 run (1,949 frames) replays with zero false motions |
| Fist vs thumbs-up by thumb reach | `hand-pose-features.js` (`thumbReach`), `hand-pose-suite.js` | replay: fist 100% fist (was thumbs-up) |
| Scale-free detector extensions | `hand-pose-detector.js`, flag `__handExtensionScaleFree` (lab on, shared default off) | same hand at 0.07 vs 0.2 scale reads the same |
| "missed it" fixtures | `hand-lab-recorder.js` (`captureMiss`), `js/lib/miss-replay.js`, `tests/hand-misses.test.js` | m saved 53 frames / 2.95 s with world landmarks; replays in Node |
| Person mask | `js/lib/person-mask-{channel,worker}.js`, `js/mask-demo.js` | 9.9 Hz, 6.1 ms p50, no measurable cost to hand/face rates |

All rates above are headless Chromium on a busy Mac (load 10–35) with a fake
camera; treat them as relative, not absolute.

## Headless checks (no camera needed)

The scripts that produced the numbers live outside the repo; the method:
Playwright's headless Chromium with `--use-fake-device-for-media-stream` and
`--use-file-for-fake-video-capture=<clip>.mjpeg`. A guided run's JPEG frames
become that MJPEG with `ffmpeg -framerate 5 -i frame_%03d.jpg -vf fps=15 -f mjpeg`.
Read `SharedCameraManager.getTrackingStats()`, `window.__mediapipeTransport()`,
`window.HandMotion.status()`, `window.PersonMask.stats()`.

## Live testing

```bash
node scripts/hand-log-sink.mjs                     # then open ?tasks-vision&handlog=http://127.0.0.1:8792
node scripts/replay-hand-clip.mjs                  # poses AND motions, against current code
```

The guided run now cues swipe, pinch, spread and gather after the poses. A
gesture that should have fired and did not: press **m** with the hands panel
open, move the downloaded `miss-*.json` into `tests/fixtures/misses/`; it runs
as a todo until its `status` is set to `fixed`.

## Pick up here

1. **Record a guided run with the motions** (front-lit). Nothing has shown the
   motions on live hands yet; replay it and tune thresholds from the misses.
2. **Port to Psychodeli** once (1) holds: presence pacing (shared manager
   change is flag-gated), world landmarks, the smoother and motion channel. The
   held-pose suite port is its own Psychodeli session (camerastein-hand-sync).
3. `?frameWidth=` downscaling showed nothing past the noise under load; measure
   on a quiet machine before turning it on.
4. Carried over: pray lost both hands on a backlit run; horns was performed as
   bull horns; backs-of-hands pray false positive still accepted.

## The lesson worth keeping

Calibrate every criterion **at** the gesture, on real landmarks. The synthetic
hand splays its thumb at palm level (reach 1.01 as a thumbs-up); a real one
stands it up (2.01). The thumb-reach bands sit where both agree.
