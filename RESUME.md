# Resume — hand gesture suite

**Branch:** `feat/hand-gesture-suite` (5 commits, unpushed). `npm test` → 119/119.
**Docs:** `docs/HAND_GESTURE_SUITE.md`, `docs/HAND_GESTURE_PRAY.md`, `docs/PRAY_TEST_SCRIPT.md`

## Where it stands

Pray is **live-validated** — Andy tested it on a real webcam across four rounds
and it holds, including sustaining ~10 s on a single occluded hand. Everything
else in the suite has met synthetic landmarks only.

## Pick up here

1. **Live-test the seven one-hand poses.** Open the app, click **Hand**, then
   **hands** (top right). Focus each pose and check the reason tally. The
   thresholds came from a synthetic hand that curls more cleanly than a real one,
   so expect the extension bounds to move. Record what moved and why in
   `HAND_GESTURE_SUITE.md`.
2. **Air-drum strike needs a dedicated Hand mode**, not the throttled overlay.
   The card now measures peak wrist speed against the threshold, so a zero count
   names its own cause. The non-obvious one: a strike fires on the
   *deceleration*, so a stroke that ends while still moving registers nothing.
3. **Decide on the accepted false positive** — backs of hands pressed together,
   fingers up, reads as pray. Detectable in principle; left undone.

## Known gaps, written down so they are not rediscovered

- `spread` and `pinch` are reported but gate nothing. The fixture models neither
  finger splay nor a thumb-to-index touch, so no threshold for them is
  validated. A pose that needs one means building the fixture first.
- `handPoseDetector.state.thumbExtension` is scale-dependent — 0.23 → 1.00
  across camera distance on an unchanged pose. Flagged, not changed: the file is
  shared with Psychodeli+ and its thumb behaviour is shipped and tuned. Dividing
  by `palmLength` would fix it.
- The face Gesture Lab has three text colours below the project's 8:1 contrast
  floor (`#8d899e` 4.41:1, `#928d9f` 4.65:1, `#777286` 3.23:1). A background task
  for this was spun off into `.claude/worktrees/eloquent-jang-21110f` and had not
  reported back when this session ended.

## The lesson worth keeping

Four separate criteria failed in the exact pose they existed to detect — the
palm normal inverted on chirality, the size proxy collapsed 1.75× edge-on, a
threshold was tighter than a perfect pose can produce, and 3D distances inflated
6.6× on depth noise. Calibrate every criterion **at** the gesture, never near it,
and never let a fixture compensate for something the sensor does not.
