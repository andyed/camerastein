# Resume — hand gesture suite

**Branch:** `feat/hand-gesture-suite` (unpushed). `npm test` → 122 pass, 1 todo.
**Docs:** `docs/HAND_GESTURE_SUITE.md`, `docs/HAND_GESTURE_PRAY.md`, `docs/PRAY_TEST_SCRIPT.md`

## How live testing works now

No reading numbers off the screen. Start the sink, open the app with it, and
click **guided run** in the hands lab — it cues each pose on the video and
records every frame:

```bash
node scripts/hand-log-sink.mjs                     # then open ?handlog=http://127.0.0.1:8792
node scripts/replay-hand-clip.mjs                  # score the newest run against current code
```

Runs land in `logs/clips/<run>/` (gitignored — frames of a face): JPEG frames at
~5 fps in optimac's clip layout, `rows.jsonl` with full landmarks, and
`manifest.json` with the cued pose per frame. Replay needs only the rows.

## Where it stands (run of 2026-09-24)

openPalm, thumbsUp, thumbsDown, point and peace fire live — point and peace only
after the long fingers moved to wrist reach (OptiGest's rule). Pray passed four
earlier live rounds but lost both hands to MediaPipe on this run (backlit).

## Pick up here

1. **Thumb test for fist vs thumbs-up.** A real thumb across a fist reads 0.84–0.92
   straight and points up, so fist fires thumbsUp. Candidate: is the thumb tip
   over the fingers, or clear of them? `tests/hand-live-fixtures.test.js` holds
   the failing case as a todo.
2. **Re-record front-lit** to confirm pray's hand loss is lighting, and to test
   horns (the prompt now shows each pose's cue).
3. **Relaxed hands at rest read as openPalm** most of the time. Uninvestigated.
4. Carried over: air-drum strike needs a dedicated Hand mode; the backs-of-hands
   pray false positive is still accepted.

## Known gaps

- `spread` and `pinch` are reported but gate nothing — no fixture models them.
- `handPoseDetector.state.thumbExtension` is scale-dependent (0.23 → 1.00 across
  distance). Shared with Psychodeli+; dividing by `palmLength` would fix it.
- `hands-loader.js` is the one shared file where camerastein is ahead of
  Psychodeli (`__handMinDetection` / `__handMinTracking`) — candidate to push up.

## The lesson worth keeping

Calibrate every criterion **at** the gesture, on real landmarks. The synthetic
hand curls its fingers across the image; a real one curls them toward the
camera, and a measure that looked orientation-proof on fixtures called a tucked
finger straight on the first live peace sign.
