# SlideGest — Chrome Web Store Listing

## Name

SlideGest — Hands-Free Slide Control

## Summary (132 char max)

Wave your hand to advance slides. Works with Google Slides, Reveal.js, and any web presentation. No remote needed.

## Description

### Your webcam is a presentation remote.

SlideGest detects hand swipes through your laptop camera and sends arrow key presses to advance or rewind slides. That's it. No phone pairing, no training step, no account.

### How it works

1. Open your presentation (Google Slides, Reveal.js, Slidev, Prezi, etc.)
2. Click the SlideGest icon to enable
3. Swipe your hand left or right in front of the webcam
4. Slides advance or rewind

### Who it's for

- **Conference speakers** — no dongle to forget, no Bluetooth to pair
- **Teachers** — walk around the room, wave to advance
- **Video calls** — presenting in Zoom or Meet with a shared tab, wave to advance without alt-tabbing
- **Trade shows** — hands-free kiosk slide deck

### What it doesn't do

SlideGest does one thing well. It doesn't control your cursor, scroll pages, or require a gesture vocabulary. Swipe left, swipe right. Done.

### Privacy

- Camera processing happens entirely in your browser using MediaPipe. No video frames leave your device.
- No analytics, no accounts, no server.
- Camera is only active when you enable detection.

### Technical details

- Uses MediaPipe Hands (WASM + GPU) for real-time hand landmark detection
- Displacement-based swipe detection with homing-motion rejection
- Injects standard KeyboardEvent (ArrowLeft/ArrowRight) — works anywhere arrow keys work
- Adjustable sensitivity via the popup

### Permissions

- **Camera** — hand detection via webcam (offscreen document, Manifest V3)
- **Active tab** — sends arrow key events to the current tab

## Category

Productivity

## Language

English

## Screenshots needed

1. SlideGest popup showing "Detecting hand swipes..." with toggle active
2. Hand mid-swipe with Google Slides in background, arrow indicator visible
3. Before/after: hand position left → hand position right, slide advanced

## Promotional images needed

- Small tile: 440x280
- Marquee: 1400x560 (use OG image adapted)
