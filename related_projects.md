# Related Projects & Libraries

Open source projects with permissive licenses relevant to camerastein's development. Organized by immediate utility.

## Tier 1 — Bootstrap Now

### One Euro Filter
- **Repo:** https://github.com/casiez/OneEuroFilter
- **License:** Public domain / academic
- **Stars:** ~196
- **npm:** `1eurofilter`, `@david18284/one-euro-filter`
- **Use:** Landmark jitter smoothing. Adaptive: aggressive filtering when stationary, reduced smoothing during fast movement. Essential for any real-time landmark visualization.
- **Key params:** `min_cutoff=1.0` (stationary jitter), `beta=0.007` (movement lag)
- **Status:** Active, canonical implementation

### KalidoKit
- **Repo:** https://github.com/yeemachine/kalidokit
- **License:** MIT
- **Stars:** ~5,600
- **Use:** Blendshape + kinematics solver for MediaPipe face/pose/hand. `Face.solve()` converts 468 face landmarks into euler rotations + blendshapes (mouth shapes A/E/I/O/U, pupil tracking, head rotation). `Pose.solve()` and `Hand.solve()` similarly. The math for converting raw landmarks into meaningful parameters — exactly what camerastein needs for dedicated per-recognizer models.
- **Status:** Archived (Feb 2022), but math is stable and extractable

### HandWave (Electron reference)
- **Repo:** https://github.com/JumppanenTomi/HandWave
- **License:** MIT
- **Stars:** ~6
- **Use:** Most complete Electron + MediaPipe + React/TS reference. Vite frontend, Sequelize/SQLite for gesture-to-action mappings, nut-js for HID events. 18-gesture dataset (18k augmented images). Clean IPC bridge with preload/renderer/worker separation.
- **Status:** January 2024
- **Architecture pattern:** Event-driven pipeline: camera frame → gesture recognition → action mapping → HID emission. Best template for wrapping camerastein in Electron.

## Tier 2 — Extract Specific Code

### mediapipe-pose-estimation (new API reference)
- **Repo:** https://github.com/sumitsahoo/mediapipe-pose-estimation
- **License:** MIT
- **Stars:** ~1
- **Use:** Uses the **newest** `@mediapipe/tasks-vision` API (PoseLandmarker, FaceLandmarker). React 19 + Vite 7. Custom hooks (`usePoseDetection`, `useFaceExpression`). Face mesh glow effects. Mobile camera switching. Migration path for camerastein when we move off the legacy MediaPipe API.
- **Status:** March 2026, actively maintained

### js-ai-body-tracker
- **Repo:** https://github.com/szczyglis-dev/js-ai-body-tracker
- **License:** MIT
- **Stars:** ~74
- **Use:** Single-file JS supporting MoveNet, PoseNet, BlazePose. Canvas 2D + ScatterGL 3D rendering. Hook/event system for pluggable detection pipeline — compare with our MotionBus pattern. Supports webcam, video files, IPTV streams.
- **Status:** August 2024

### jwc-mediapipe (smoothing filters)
- **Repo:** https://github.com/JDBar/jwc-mediapipe
- **License:** MIT
- **Stars:** ~2
- **Use:** TypeScript wrapper with EWMA and Kalman Filter smoothing for landmarks. `getLandmarkSmootherEWMA()` and `getLandmarkSmootherKalman()` as interchangeable strategies. Clean Kalman implementation in `lib/KalmanFilter.ts`. Alternative to One Euro Filter.
- **Status:** March 2024

### mediapipe-pose-smooth
- **Repo:** https://github.com/yousufkalim/mediapipe-pose-smooth
- **License:** MIT
- **Stars:** ~13
- **Use:** Dead simple frame-averaging: 8 frames, drop 2 highest/lowest, average remaining 4. `smoothLandmarks(results)` API. Good for quick prototyping before implementing One Euro.
- **Status:** January 2023

## Tier 3 — Reference & Inspiration

### hand-gesture-recognition-mediapipe
- **Repo:** https://github.com/kinivi/hand-gesture-recognition-mediapipe
- **License:** Apache 2.0
- **Stars:** ~2,000+
- **Use:** Two-stage pipeline: MediaPipe detects raw landmarks, then a lightweight MLP classifies the gesture. The "landmarks → derived features → classifier" pattern is the architecture for adding gesture recognition to camerastein.
- **Status:** Active

### threejs-handtracking-101
- **Repo:** https://github.com/collidingScopes/threejs-handtracking-101
- **License:** MIT
- **Stars:** ~147
- **Use:** Three.js + WebGL + MediaPipe Hands. Pinch controls sphere size, proximity triggers color. Good reference for mapping hand landmarks to 3D interaction.
- **Status:** Recent

### MediaPipe-in-JavaScript (demos)
- **Repo:** https://github.com/LintangWisesa/MediaPipe-in-JavaScript
- **License:** Not specified (demo code)
- **Stars:** ~114
- **Use:** Minimal vanilla JS implementations of all MediaPipe solutions. No frameworks. Good for understanding the raw API without abstraction layers.

### mediapipe-js-demos
- **Repo:** https://github.com/pjbelo/mediapipe-js-demos
- **License:** Apache 2.0
- **Stars:** ~47
- **Use:** Eight demos covering all MediaPipe solution types. Consistent structure per demo. Template for multi-mode detection app.

### Gesto (Electron gesture control)
- **Repo:** https://github.com/anurag-deore/Gesto-Electron-Gesture-Control
- **License:** ISC
- **Stars:** ~3
- **Use:** Electron 33 + MediaPipe Hands + Web Workers for ML inference. Demonstrates preload/renderer/worker architecture for keeping main thread responsive.
- **Status:** November 2024

### MediaPipe for OBS
- **Repo:** https://github.com/UUoocl/MediaPipe_for_OBS
- **License:** Not specified
- **Stars:** ~10
- **Use:** Electron app sending landmark data to OBS via WebSocket. Interesting data serialization format (X/Y/Z + visibility). PTZ camera support.
- **Status:** April 2024

### tfjs-models/pose-detection
- **Repo:** https://github.com/tensorflow/tfjs-models/tree/master/pose-detection
- **License:** Apache 2.0
- **Stars:** ~13k (parent repo)
- **Use:** Unified API across MoveNet (fastest, 50+ FPS), BlazePose, PoseNet. Demo folder has clean Canvas 2D skeleton rendering. MoveNet Lightning is the performance benchmark to beat.
- **Status:** Actively maintained

### Handsfree.js (archived)
- **Repo:** https://github.com/MIDIBlocks/handsfree
- **License:** Apache 2.0
- **Stars:** ~1k+ (original)
- **Use:** Plugin system for composing handsfree experiences. `new Handsfree({ hands: true, pose: true })` configuration pattern. Wraps MediaPipe + TensorFlow.js + Jeeliz Weboji.
- **Status:** Archived May 2024

## Tier 4 — Future Features

### VitalLens.js (physiological signals from camera)
- **Repo:** https://github.com/Rouast-Labs/vitallens.js
- **License:** MIT
- **Stars:** ~14
- **Use:** Heart rate, HRV, and respiratory rate estimation from face video. Works in browser and Node.js. Includes local rPPG algorithms (POS, CHROM, G) that don't need an API key. Bundles its own fast face detector.
- **API:** Web Component (`<vitallens-scan>`) and programmatic (`new VitalLens()`)
- **Status:** March 2026, actively maintained
- **Camerastein relevance:** Physiological signal detection from the same camera feed. Stress, engagement, arousal detection. Could feed into MotionBus as a new channel.
- **Psychodeli+ relevance:** Heart rate and stress reactivity as audio-visual input signals. Imagine visuals that respond to your heart rate syncing with the beat. The rPPG algorithms work from the same face mesh landmarks we already capture.

### understanding-mediapipe-facemesh-output
- **Repo:** https://github.com/lschmelzeisen/understanding-mediapipe-facemesh-output
- **Use:** Reference for which of the 468 face landmarks correspond to which facial features. Useful for building simplified face visualizations and expression extraction.

## Audio Generation & Adaptive Music (for MindState app)

These projects are relevant to the MindState biofeedback meditation app concept (see `psychodeli-webgl-port/docs/MINDSTATE_APP_SPEC.md`), which combines Psychodeli visuals + generated music + camera-based vitals for guided mental state transitions.

### Tier 1 — Foundation Stack

#### Tone.js
- **Repo:** https://github.com/Tonejs/Tone.js
- **License:** MIT | **Stars:** ~14,700
- **Use:** The dominant Web Audio framework. Scheduling, synthesis, effects, transport. Build generative sequences on top of Tone.Transport. Map biofeedback to filter cutoff, tempo, reverb mix, note density. Does not compose for you — you write the generative logic, it handles the audio graph.
- **Status:** Active (March 2026)

#### Tonal.js
- **Repo:** https://github.com/tonaljs/tonal
- **License:** npm packages | **Stars:** ~4,100
- **Use:** Pure functional music theory. Notes, intervals, chords, scales, modes, keys, progressions, roman numeral analysis. Constrain generative note selection to calming scales (Dorian for calm, Mixolydian for energy, Aeolian for sleep). Map biofeedback to harmonic movement.
- **Status:** Active (January 2026)

#### Scribbletune
- **Repo:** https://github.com/scribbletune/scribbletune
- **License:** MIT | **Stars:** ~3,800
- **Use:** Create music with simple strings and arrays. Rhythm patterns as strings (`"x-x-x---"`), chord progressions, clip-based composition. Uses Tonal.js internally, plays via Tone.js. Parameterize pattern density based on biofeedback.
- **Status:** Active (March 2026)

#### Generative.fm / @generative-music
- **Repo:** https://github.com/generativefm/generative.fm (archived) + https://github.com/generativefm/generators
- **License:** MIT | **Stars:** ~1,590 + ~564
- **Use:** Alex Bainter's ~35 ambient generative pieces built on Tone.js. Each is a self-contained generator creating infinite, non-repeating ambient music. Brian Eno-style ambient to drone to melodic. **The single best reference architecture for building generative ambient sequences.** Fork individual generators and add biofeedback parameter inputs.
- **Status:** Archived (2021), but pattern library is gold

### Tier 2 — Adaptive Systems

#### iMusicXML
- **Repo:** https://github.com/hanslindetorp/iMusicXML
- **License:** MIT | **Stars:** ~6
- **Use:** XML syntax + JS parser for adaptive music in HTML. Arrange, loop, randomize, play sections/stems/motifs in sync. Built for vertical layering + horizontal re-sequencing. Define calm/focus/energize stem sets, crossfade layers based on biofeedback. Developed at Royal College of Music, Stockholm.
- **Status:** September 2025

#### barelymusician
- **Repo:** https://github.com/anokta/barelymusician
- **License:** MIT | **Stars:** ~38
- **Use:** Real-time adaptive music engine in C/C++. Smooth transitions between musical patterns for varying emotional states. Unity/VST/native targets. Not directly browser-usable, but the academic paper describes exactly the emotional-state-to-music-transition problem. Architecture patterns are highly relevant.
- **Status:** Active (March 2026)

#### React Native Audio API
- **Repo:** https://github.com/software-mansion/react-native-audio-api
- **License:** MIT | **Stars:** ~729
- **Use:** Web Audio API implemented natively for React Native. Same API surface as browser Web Audio, runs on native iOS/Android. Write generative audio logic once (Tone.js-style), run cross-platform.
- **Status:** Very active (March 2026)

### Tier 3 — ML/AI Music Generation

#### Magenta.js (@magenta/music)
- **Repo:** https://github.com/magenta/magenta-js
- **License:** Apache 2.0 | **Stars:** ~2,100
- **Use:** TensorFlow.js ML models for music: MusicVAE (interpolate between musical phrases), MelodyRNN, DrumsRNN, ImprovRNN. Client-side GPU inference. MusicVAE can interpolate between a "calm" latent vector and a "focus" latent vector, creating smooth musical transitions driven by HRV.
- **Status:** Active (March 2026)

#### MusicLang (ONNX)
- **Repo:** https://huggingface.co/musiclang/musiclang-4k-onnx
- **License:** Open
- **Use:** MIDI generation in ONNX format, compatible with transformers.js. LLAMA2 architecture trained on CC0 MIDI dataset. Generates chord progressions and multi-track MIDI. Pair with Tone.js for synthesis — MIDI generation is much lighter than audio generation. Could run on-device.

#### Stable Audio Open Small
- **Repo:** https://github.com/Stability-AI/stable-audio-tools
- **License:** MIT | **Stars:** ~3,650
- **Model:** https://huggingface.co/stabilityai/stable-audio-open-small
- **Use:** 341M parameter text-to-audio model optimized for Arm CPUs. Generates up to 11s of audio on a smartphone in under 8s. Most realistic path to on-device AI audio generation for mobile. Could generate ambient textures conditioned on mood parameters.

#### ACE-Step 1.5
- **Repo:** https://github.com/ace-step/ACE-Step-1.5
- **License:** MIT | **Stars:** ~8,400
- **Use:** Music foundation model. Full song generation under 4GB VRAM, under 10s on RTX 3090. LoRA fine-tuning from a few songs. Best option for pre-generating a stem library: fine-tune LoRA on calming ambient music, batch-generate hundreds of 30-60s segments.
- **Status:** Very active (March 2026)

#### MusicGPT
- **Repo:** https://github.com/gabotechs/MusicGPT
- **License:** MIT | **Stars:** ~1,400
- **Use:** Rust binary generating music from natural language prompts using local LLMs. Nice CLI for batch-generating meditation segments server-side.

### Binaural Beats / Entrainment

#### Gnaural Web
- **Repo:** https://github.com/Gnaural-Web
- **Use:** Browser-based binaural beat generator. Pure HTML5/JS. Generate beats at target brainwave frequencies (4-8Hz theta for meditation, 12-30Hz beta for focus), layer under generative music.

#### 1ps0/binaural
- **Repo:** https://github.com/1ps0/binaural
- **License:** MIT | **Stars:** ~4
- **Use:** Dashboard for binaural beats, solfeggio frequencies, therapeutic tones. Multiple frequency presets mapped to cognitive states. More complete than BinauralBeatJS.
- **Status:** July 2025

**Note:** Binaural beats are trivial to implement from scratch — two OscillatorNodes with a frequency offset, panned L/R. The library value is in pre-built frequency presets and transition scheduling.

### Competitive Products

#### Endel
- **URL:** https://endel.io/
- **Type:** Commercial (closed source) | **Rating:** 4.6 (31k reviews) | **Price:** $2.99-19.99/mo
- **What:** The reference competitor. Patented "Endel Pacific" AI engine generates real-time soundscapes adapted to time of day, weather, movement, heart rate (Apple Watch). Modes: Focus, Relax, Sleep, Move. iOS/Android/Mac/Apple TV/Vision Pro/Alexa/web.
- **Key insight:** They use rule-based generative systems, not ML. The "AI" is algorithmic composition with parameter mapping. Watch-dependent for biometrics.

#### Wotja
- **Repo:** https://github.com/Intermorphic/wotja-live-generative-music
- **License:** MIT | **Stars:** ~3
- **URL:** https://wotja.com/
- **What:** Cross-platform generative music system (iOS/macOS/Windows/Android). Developer API via URI strings. Real-time root note and tempo control. "AI-free" (algorithmic).

### Research: Adaptive Music + Biofeedback

#### HeartDJ (Dartmouth Thesis, 2024-2025)
- **URL:** https://digitalcommons.dartmouth.edu/masters_theses/205/
- **What:** Directly investigates HRV biofeedback + AI music generation. Used Stable Audio Open + Suno. Key finding: quality and emotional authenticity matter more than novelty. The condition with 4 AI-generated tracks actually **decreased** HRV (heightened sympathetic activation), suggesting naive AI music hurts.
- **Implication:** Rule-based generative systems (like Endel) outperform naive AI for wellness. Biofeedback adaptation should be subtle — gentle parameter evolution, not jarring transitions.

#### GAN-Based HRV Musical Biofeedback
- **Paper:** https://www.sciencedirect.com/science/article/abs/pii/S1746809421006923
- **What:** GAN generating MIDI from HRV signals. Bidirectional feedback loop: HRV feeds GAN, GAN output stimulates listener.

#### iHeartLift
- **Paper:** https://pubmed.ncbi.nlm.nih.gov/22254526/
- **What:** Closed-loop system using music tempo variability to improve HRV. Adjusts BPM based on real-time heart rate.

### Recommended Architecture for MindState

```
Layer 1 — Theory:     Tonal.js (scale/chord constraints) + Scribbletune (pattern templates)
Layer 2 — Synthesis:  Tone.js (browser) + React Native Audio API (mobile native)
Layer 3 — Generation: Custom state machine inspired by Generative.fm. Calm/focus/energize/sleep
                      modes define: scale, tempo range, note density, instrument palette, effects.
                      Biofeedback (HRV, HR) maps to continuous params within mode + triggers transitions.
Layer 4 — Entrainment: Binaural beats (trivial Tone.js oscillators) + isochronic pulses synced
                        to target breathing rate (~0.1Hz for coherence)
Layer 5 — Assets:     ACE-Step 1.5 or Stable Audio Open Small pre-generates ambient stem library
Layer 6 — Optional ML: MusicLang ONNX for on-device MIDI generation, Magenta MusicVAE for
                        mood-space interpolation
```

The HeartDJ thesis finding is critical: **well-crafted rule-based generation beats naive AI for wellness**. Ship Layer 1-4 first, add ML later when it demonstrably improves the experience.

## Migration Notes

### Legacy → New MediaPipe API
Our extracted detection files use the legacy `@mediapipe/pose`, `@mediapipe/hands`, `@mediapipe/face_mesh` packages loaded from CDN. The new API is `@mediapipe/tasks-vision` with `PoseLandmarker`, `HandLandmarker`, `FaceLandmarker`. Key differences:
- Unified API across all tasks
- Better performance (WASM + WebGPU backends)
- Active development (legacy packages are maintenance-only)
- `sumitsahoo/mediapipe-pose-estimation` is the cleanest reference for the new API

This migration is a natural Phase 2 for camerastein after the MVP ships.
