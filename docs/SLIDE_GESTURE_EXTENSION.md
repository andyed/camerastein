# Slide Gesture — Chrome Extension for Webcam Slide Control

## One-line pitch

Wave your hand to advance slides. No remote, no phone pairing, no training step.

## The gap

Existing solutions are overcomplicated:
- **Gesture Presenter** requires pairing with your phone via a code (!?)
- **Gesture Based Scroll** requires a manual training step before use
- **No extension** does the obvious: MediaPipe hand detection → swipe direction → arrow key injection

The simplest possible version: detect hand swipe left/right → send ←/→ arrow keys. Zero config. Works in Google Slides, Reveal.js, Slidev, any web-based presentation tool.

## Why Chrome extension (not native)

- **Google Slides has no native app.** The one major presentation tool where you can't use a Bluetooth clicker reliably. This is the wedge.
- Cross-platform for free (macOS, Windows, Linux, ChromeOS)
- Zero install friction — Chrome Web Store, one click
- Camera access via standard `getUserMedia`
- Arrow key injection via `document.dispatchEvent(new KeyboardEvent(...))`

## Architecture

```
webcam → MediaPipe Hands (WASM) → landmark stream
  → HandSwipeDetector (displacement-based, same algo as OptiGest)
  → arrow key injection into active tab
```

### Key components

1. **Background service worker** — lifecycle, icon badge state
2. **Content script** — injects arrow key events into the page
3. **Offscreen document** (Manifest V3) — runs camera + MediaPipe (content scripts can't access camera)
4. **Popup** — on/off toggle, camera preview, sensitivity slider

### Detection reuse

The swipe detection algorithm is identical to OptiGest's `HandSwipeDetector`:
- Track hand landmark displacement from entry to exit
- Net displacement determines direction (not velocity — velocity is biased by entry patterns)
- Threshold: ~40% of frame width

Port the Swift displacement logic to TypeScript. Same algorithm, same thresholds.

## Activation model

- **Manual toggle** (v1) — click extension icon or keyboard shortcut to enable/disable
- **Presentation mode detection** (v2) — detect fullscreen + slide-like DOM structure, auto-enable
- **Idle activation** (v3) — same as OptiGest, enable after N seconds of no keyboard/mouse

## Scope — what it does NOT do

- No cursor control
- No scrolling (that's a different interaction model)
- No multi-gesture vocabulary
- No per-site configuration (v1)
- No phone pairing, no training, no accounts

## Competitors

| Extension | Mechanism | Friction | Status |
|-----------|-----------|----------|--------|
| Gesture Presenter | Phone camera + pairing code | High — needs two devices | Active |
| Gesture Based Scroll | Webcam + manual training | Medium — training step | Active |
| **Slide Gesture** | Webcam + MediaPipe, zero config | None | Proposed |

## Market angle

"Presentation remote without the remote" — a professor, a conference speaker, anyone standing up and presenting from a laptop. The webcam is already there. The hand is already gesturing. Just detect the swipe.

### Key use cases
- **Conference talks** — no dongle to forget, no Bluetooth to pair
- **Classrooms** — teacher walks around, waves to advance
- **Video calls** — presenting in Zoom/Meet, share tab has Google Slides, wave to advance without alt-tabbing to find the clicker app
- **Kiosk/demo** — trade show booth, hands-free slide deck

## Relationship to OptiGest

Slide Gesture is the **web-only subset** of OptiGest's hand swipe detection. Same algorithm, different platform:

| | OptiGest | Slide Gesture |
|--|---------|---------------|
| Platform | macOS native | Chrome extension |
| Detection | Apple Vision framework | MediaPipe Hands (WASM) |
| Actions | App switch, arrow keys, carousel | Arrow keys only |
| Scope | Full gesture vocabulary | Swipe left/right only |

If Slide Gesture gets traction, it validates the core interaction for OptiGest. If OptiGest ships first, Slide Gesture extends reach to non-Mac users.

## Open questions

- [ ] Manifest V3 camera access via offscreen document — verify this works reliably
- [ ] MediaPipe WASM bundle size (impacts install size / first-load time)
- [ ] Can we inject keyboard events into Google Slides presentation mode? (fullscreen iframe)
- [ ] Latency budget: camera frame → MediaPipe → swipe detection → key event. Target <200ms.

---

*Added 2026-03-31. Related: OptiGest (`optimac/`), camerastein head tracking prototype.*
