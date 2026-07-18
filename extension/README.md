# SlideGest

Chrome extension that detects hand swipes via your webcam and sends arrow keys to advance slides. Works with Google Slides, Reveal.js, Slidev, or anything that responds to arrow keys.

Part of the [Camerastein](https://github.com/andyed/camerastein) camera signal detection platform.

## Install

Not yet on the Chrome Web Store. To load locally:

1. Clone this repo
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" → select the `extension/` directory

## How it works

```
webcam → MediaPipe Hands (WASM/GPU) → wrist landmark tracking
  → displacement-based swipe detection → ArrowLeft/ArrowRight key injection
```

- **Offscreen document** runs camera + MediaPipe (Manifest V3 — content scripts can't access `getUserMedia`)
- **Content script** injects `KeyboardEvent` into the active tab
- **Background service worker** manages lifecycle and routes messages

Detection runs at camera frame rate. Swipe detection uses net wrist displacement (not velocity) with homing-motion rejection to avoid false triggers on the return swing.

## Architecture

```
extension/
├── manifest.json       Manifest V3
├── background.js       Service worker — toggle, offscreen lifecycle, message relay
├── offscreen.html/js   Camera + MediaPipe Hands + swipe detection
├── content.js          Arrow key injection into active tab
├── popup/              Toggle UI + sensitivity slider
└── icons/              Extension icons + generator script
```

## Configuration

Click the extension icon to toggle detection on/off. The sensitivity slider controls the minimum swipe distance (lower = more sensitive, more false positives).

## Detection algorithm

Ported from `demos/swipe-nav.html` in camerastein:

- Track wrist landmark X position over a sliding window (16 samples)
- Require N consecutive samples moving in the same direction
- Net displacement must exceed threshold (~10% of frame width, adjustable)
- After a swipe fires, reject the return-to-rest motion (homing rejection)
- 800ms cooldown between swipes

## Privacy

All processing is local. MediaPipe runs in-browser via WASM + WebGPU. No video frames, landmarks, or telemetry leave your device.

## Limitations

- Manifest V3 offscreen documents can be garbage-collected by Chrome after inactivity — detection may need re-enabling after long idle periods
- Google Slides presentation mode runs in a fullscreen iframe — key injection needs verification
- Single-hand detection only (first hand detected)
- No gesture vocabulary beyond swipe left/right

## Related

- [Camerastein](https://github.com/andyed/camerastein) — the detection platform this is extracted from
- [OptiGest](https://github.com/andyed/optimac) — native macOS gesture controller (Apple Vision framework, broader gesture vocabulary)
- [SLIDE_GESTURE_EXTENSION.md](../docs/SLIDE_GESTURE_EXTENSION.md) — original design spec

## License

MIT
