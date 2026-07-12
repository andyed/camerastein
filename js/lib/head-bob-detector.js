/**
 * Head Bob Detector
 *
 * Detects rhythmic head bobbing via webcam to derive engagement signals.
 * When users physically respond to music (bobbing in sync with beat),
 * this indicates high engagement with the current audio-visual state.
 *
 * Uses SharedCameraManager for instant switching with BodyMotionDetector.
 * Both models stay loaded (~7MB total) for seamless mode changes.
 *
 * Feeds into SyntaxPulseCollector as a 'camera' source so beat sync
 * detection works automatically via the existing infrastructure.
 *
 * @see docs/HEAD_BOB_DETECTION.md
 */

class HeadBobDetector {
    constructor() {
        this.enabled = false;
        this.active = false;
        // Video/camera managed by SharedCameraManager for instant mode switching

        this.sensitivityMode = 'normal';

        this.sensitivity = {
            yawGain: 2.2,
            rollGain: 1.0,
            pitchGain: 1.0,
            orientationSmoothing: 0.25,
            orientationVelocitySmoothing: 0.3,
            headVelocitySmoothing: 0.35
        };

        // Key landmark indices for head position
        this.LANDMARKS = {
            NOSE_TIP: 1,
            CHIN: 152,
            FOREHEAD: 10,
            LEFT_EAR: 234,
            RIGHT_EAR: 454,
            // For face size (lean detection)
            LEFT_CHEEK: 234,
            RIGHT_CHEEK: 454,
            TOP_HEAD: 10,
            BOTTOM_CHIN: 152,
            // Iris tracking (requires refineLandmarks: true)
            LEFT_IRIS: 468,
            RIGHT_IRIS: 473,
            // Eye boundaries for EAR/Attention
            LEFT_EYE_INNER: 133,
            LEFT_EYE_OUTER: 33,
            RIGHT_EYE_INNER: 362,
            RIGHT_EYE_OUTER: 263,
            // Mouth landmarks for singing/vocalization detection
            MOUTH_UPPER: 13,      // Upper lip center
            MOUTH_LOWER: 14,      // Lower lip center
            MOUTH_LEFT: 61,       // Left corner
            MOUTH_RIGHT: 291      // Right corner
        };

        // Position history for oscillation detection (per face)
        this.faceStates = [];         // Array of per-face tracking state
        this._nextFaceId = 1;         // Monotonic id so consumers (HeadExtrude slots) track a person across frames
        this.maxFaces = 4;
        this.historyMaxLength = 60;   // ~2 seconds at 30fps
        this.faceTimeout = 3000;      // Remove face tracking if not seen for 3s (was 1s — too aggressive for multi-face occlusion)

        // Aggregate detection state (across all faces)
        this.state = {
            headY: 0,
            headVelocity: 0,
            headAcceleration: 0,
            headJerk: 0,
            headYaw: 0,
            headPitch: 0,
            headRoll: 0,
            headYawVelocity: 0,
            headPitchVelocity: 0,
            headRollVelocity: 0,
            bobFrequency: 0,
            bobAmplitude: 0,
            bobPhase: 0,
            confidence: 0,
            beatSyncScore: 0,
            lastBobTime: 0,
            isEngaged: false,
            faceCount: 0,             // Number of faces currently tracked
            syncedFaces: 0,           // Number of faces synced to beat
            crowdEnergy: 0,           // 0-1 collective sync: a room moving together drives the show harder

            // Lean detection (proximity)
            faceSize: 0,              // Normalized face size (0-1)
            leanAmount: 0,            // -1 (leaning back) to +1 (leaning in)
            baselineFaceSize: 0,      // Calibrated baseline

            // Rhythm sync output (for visual system)
            userRhythmPhase: 0,       // 0-1 phase of user's bob cycle
            userRhythmIntensity: 0,   // 0-1 how strong/confident the rhythm is
            smoothedBobY: 0,          // Smoothed Y position for direct visual sync

            // Mouth state (for singing/vocalization detection)
            mouthAspectRatio: 0,      // MAR: height/width ratio (0 = closed, >0.5 = open)
            mouthOpenness: 0,         // 0-1 normalized openness
            mouthActivity: 0,         // 0-1 recent mouth movement intensity
            isSinging: false,         // Detected sustained vocalization
            isSpeaking: false,        // Detected rapid speech-like movement
            smileValence: 0           // -1 (frown) to +1 (smile) valence signal
        };

        this._lastRhythmHeadY = null;
        this._lastRhythmHeadT = 0;
        this._lastHeadVelocity = 0;
        this._lastHeadAcceleration = 0;

        this._lastYaw = null;
        this._lastPitch = null;
        this._lastRoll = null;

        // Mouth tracking state
        this.mouthHistory = [];
        this.mouthHistoryMaxLength = 30;  // ~1 second at 30fps
        this._lastMouthMAR = 0;
        this._mouthActivityWindow = [];   // Track recent MAR changes

        // Smile/frown tracking — valence feedback paralleling left/right wink
        this._smileValence = 0;           // Smoothed: -1 (frown) to +1 (smile)
        this._smileHistory = [];          // Recent valence samples for sustained detection
        this._smileHistoryMax = 20;       // ~0.7s at 30fps
        this._lastSmileFeedback = 0;      // Debounce timestamp
        this._valenceBaseline = null;     // Personal resting-face valence (warm-started, slow drift)

        // Face presence tracking (entrance/exit events for AE, like instrument changes)
        this.facePresence = {
            isActive: false,
            startTime: 0,
            lastFaceCount: 0,
            candidateEntrance: false,
            entranceFirstSeen: 0,
            candidateExit: false,
            exitFirstSeen: 0
        };
        this.faceHysteresis = {
            sustainedThreshold: 500,      // 500ms sustained detection before entrance
            exitSustainedThreshold: 800,  // 800ms below threshold before exit (longer to handle brief occlusion)
        };

        // Lean detection calibration
        this.faceSizeHistory = [];
        this.faceSizeCalibrated = false;

        // Configuration
        this.config = {
            targetFPS: 20,              // Don't need 60fps for bob detection
            minAmplitude: 0.01,         // Minimum Y movement to count as bob (normalized 0-1)
            minBobFrequency: 0.5,       // Hz — below this is postural drift (~30 BPM)
            maxBobFrequency: 4.0,       // Hz — above this is landmark jitter (~240 BPM)
            minConfidence: 0.5,         // Face detection confidence threshold
            engagementThreshold: 0.6,   // Beat sync score to consider "engaged"
            cooldownMs: 500,            // Min time between pulse emissions
            debugCanvas: false          // Show debug visualization
        };

        this.lastPulseTime = 0;
        this._indicatorAnimationId = null;  // Track animation frame for cleanup

        // Bind methods
        this._onResults = this._onResults.bind(this);

        // Dependencies injected via init() after all scripts load
        this._deps = {};
    }

    /**
     * Inject dependencies. Called from motion-init.js after all singletons exist.
     * Fallback: _dep() returns window[name] if init() hasn't been called yet.
     */
    init(deps = {}) {
        this._deps = deps;
    }

    /** Safe dependency access with window fallback */
    _dep(name) { return this._deps[name] || window[name]; }

    /**
     * Check if camera/MediaPipe are available
     */
    async isAvailable() {
        return this._dep('cameraManager')?.isAvailable() ?? false;
    }

    /**
     * Request head tracking via the camera machine. DEPRECATED as a lifecycle
     * authority — detectors are pure consumers now; SharedCameraManager calls
     * _activate/_deactivate when ownership actually changes. Kept for
     * permalink autostart and external callers; throws on failure so their
     * retry paths (e.g. the headbob= one-shot auto-retry) keep working.
     */
    async start() {
        const r = await this._dep('cameraManager')?.setModeDesired?.('head', true);
        if (!r?.ok) throw new Error('Head tracking failed to start');
    }

    /**
     * Release head tracking via the camera machine.
     * @param {boolean} fullShutdown - also unload models + stop the manager
     */
    stop(fullShutdown = false) {
        this._dep('cameraManager')?.setModeDesired?.('head', false);
        if (fullShutdown) this._dep('cameraManager')?.shutdown?.();
    }

    /**
     * Machine hook: head became the live primary. Pure consumer setup only —
     * no camera/stream authority in here.
     */
    _activate() {
        if (this.active) return;
        if (this._dep('mediaPipeLoader')) {
            this._dep('mediaPipeLoader').setOptions({ refineLandmarks: true });
        }
        this.active = true;
        this.enabled = true;
        this._dep('debugManager')?.info?.('✅ Head Bob Detector active');
        this._showIndicator(true);
    }

    /**
     * Machine hook: head detached. Clears all rolling state and nulls the
     * rhythm channel — payload contract: null means null, no zombie payloads.
     */
    _deactivate() {
        if (!this.active) return;
        this.active = false;
        this.enabled = false;

        // Clear history
        this.faceStates = [];
        this.faceSizeHistory = [];
        this.faceSizeCalibrated = false;

        // Clear mouth/smile tracking state to avoid stale data on restart
        this.mouthHistory = [];
        this._smileHistory = [];
        this._smileValence = 0;
        this._valenceBaseline = null;
        this._mouthActivityWindow = [];
        this.state.mouthAspectRatio = 0;
        this.state.mouthOpenness = 0;
        this.state.mouthActivity = 0;
        this.state.isSinging = false;
        this.state.isSpeaking = false;
        this.state.smileValence = 0;

        // Clear sync state via MotionBus
        window.MotionBus?.emit('rhythmSync', null);
        window.mouthSync = null;

        this._showIndicator(false);
    }

    /**
     * Toggle detection on/off
     */
    async toggle() {
        if (this.active) {
            this.stop();
            return false;
        } else {
            await this.start();
            return true;
        }
    }

    // Frame processing now handled by SharedCameraManager

    /**
     * Handle MediaPipe face detection results (multi-face support)
     */
    _onResults(results) {
        const now = performance.now();

        if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
            // No faces detected - clear old face states
            this.state.confidence = 0;
            this.state.faceCount = 0;
            this.state.syncedFaces = 0;
            this.state.bobFrequency = 0;
            this.state.bobAmplitude = 0;
            this.state.bobPhase = 0;
            this.state.beatSyncScore = 0;
            this.state.isEngaged = false;
            this.state.userRhythmPhase = 0;
            this.state.userRhythmIntensity = 0;
            this.state.smoothedBobY = 0;
            this.state.faceSize = 0;
            this.state.leanAmount = 0;
            this._pruneOldFaces(now);
            // Report zero confidence for auto-switch consideration
            this._dep('cameraManager')?.reportConfidence(0);
            window.MotionBus?.emit('rhythmSync', null);
            return;
        }

        // Process each detected face
        let bestBobState = null;
        let bestSyncScore = 0;
        let syncedCount = 0;
        let primaryFaceSize = 0;
        let primaryHeadY = 0;

        for (let faceIdx = 0; faceIdx < results.multiFaceLandmarks.length; faceIdx++) {
            const landmarks = results.multiFaceLandmarks[faceIdx];

            // Gaze tracking for the primary face
            if (faceIdx === 0 && this._dep('gazeTracker')) {
                this._dep('gazeTracker').update(landmarks, this.LANDMARKS);
            }

            // Mouth tracking for the primary face (singing/vocalization detection)
            if (faceIdx === 0) {
                this._updateMouthState(landmarks, now);
            }

            // Calculate head Y position (average of key points)
            const noseY = landmarks[this.LANDMARKS.NOSE_TIP].y;
            const chinY = landmarks[this.LANDMARKS.CHIN].y;
            const foreheadY = landmarks[this.LANDMARKS.FOREHEAD].y;
            const headY = (noseY + chinY + foreheadY) / 3;

            // Calculate X position for face identification
            const headX = landmarks[this.LANDMARKS.NOSE_TIP].x;

            // Head orientation (yaw/pitch/roll) for immediate control feel
            if (faceIdx === 0) {
                this._updateHeadOrientation(landmarks, now);
            }

            // Calculate face size for lean detection — use largest face (closest person)
            // rather than faceIdx===0 which has no stable identity across frames
            const leftEar = landmarks[this.LANDMARKS.LEFT_EAR];
            const rightEar = landmarks[this.LANDMARKS.RIGHT_EAR];
            const faceWidth = Math.abs(rightEar.x - leftEar.x);
            const faceHeight = Math.abs(chinY - foreheadY);
            const thisFaceSize = (faceWidth + faceHeight) / 2;
            if (thisFaceSize > primaryFaceSize) {
                primaryFaceSize = thisFaceSize;
                primaryHeadY = headY;
            }

            // Find or create face state (match by nose-tip centroid X+Y)
            let faceState = this._findOrCreateFaceState(headX, headY, now);
            faceState.lastSeen = now;
            faceState.headY = headY;

            // Add to this face's history
            faceState.yHistory.push({ y: headY, t: now });
            if (faceState.yHistory.length > this.historyMaxLength) {
                faceState.yHistory.shift();
            }

            // Per-face silhouette (16 feature pts) for the multi-face emboss —
            // HeadExtrude derives THIS face's expression/geometry from it, keyed by
            // faceState.id so each person's relief tracks across frames. faceIdx 0
            // also feeds the legacy single-face field for backward compatibility.
            const sil = this._extractSilhouette(landmarks);
            faceState.silhouette = sil;
            faceState.faceSize = thisFaceSize;
            if (faceIdx === 0) this.state.faceLandmarks = sil;

            // Per-face head velocity (image units/sec) → HeadExtrude's activity gate
            const yh = faceState.yHistory;
            if (yh.length >= 2) {
                const a = yh[yh.length - 2], b = yh[yh.length - 1];
                const dtv = (b.t - a.t) / 1000;
                const vy = dtv > 0 ? (b.y - a.y) / dtv : 0;
                faceState.headVel = (faceState.headVel || 0) * 0.65 + vy * 0.35;
            }

            // Detect bob pattern for this face
            const bobState = this._detectBobForFace(faceState);
            if (bobState) {
                faceState.bobState = bobState;
                // Per-face intensity (confidence × normalized amplitude) → emboss melt/presence
                faceState.intensity = bobState.confidence > 0.3
                    ? bobState.confidence * Math.min(1, bobState.bobAmplitude / 0.03)
                    : (faceState.intensity || 0) * 0.95;
                const syncScore = this._calculateBeatSync(bobState);
                faceState.beatSyncScore = syncScore;

                // Track if this face is synced
                if (syncScore > this.config.engagementThreshold &&
                    bobState.confidence > this.config.minConfidence) {
                    syncedCount++;
                }

                // Keep track of best sync for aggregate state
                if (syncScore > bestSyncScore) {
                    bestSyncScore = syncScore;
                    bestBobState = bobState;
                }
            }
        }

        // Prune faces not seen recently
        this._pruneOldFaces(now);

        // Update aggregate state
        this.state.faceCount = this.faceStates.length;
        this.state.syncedFaces = syncedCount;

        // Crowd energy — a room moving together drives the show harder. 0 with ≤1
        // synced face, ramps to 1 at 4 synced. Smoothed so it eases in/out. Behind
        // __crowdEnergy (default on web/dev). Consumed in the broadcast (intensity lift).
        const rawCrowd = (window.__crowdEnergy ?? true)
            ? Math.max(0, Math.min(1, (syncedCount - 1) / 3))
            : 0;
        this._crowdEnergySm = (this._crowdEnergySm ?? 0);
        this._crowdEnergySm += (rawCrowd - this._crowdEnergySm) * 0.1;
        this.state.crowdEnergy = this._crowdEnergySm;

        // Emit face entrance/exit events to AE (like instrument changes)
        this._trackFacePresence(now);

        if (bestBobState) {
            Object.assign(this.state, bestBobState);
            this.state.beatSyncScore = bestSyncScore;
        } else {
            this.state.bobFrequency = 0;
            this.state.bobAmplitude = 0;
            this.state.bobPhase = 0;
            this.state.beatSyncScore = 0;
            this.state.confidence = 0;
            this.state.userRhythmPhase = 0;
        }

        // Face VISIBILITY confidence (separate from bob detection confidence).
        // For auto-switch decisions, what matters is whether the face is IN FRAME,
        // not whether the user is actively bobbing. A user sitting still with their
        // face visible should NOT trigger a switch to body mode.
        // primaryFaceSize > 0 means FaceMesh found landmarks — face is visible.
        const faceVisibilityConfidence = primaryFaceSize > 0.01 ? 1.0 : 0;

        // Lean detection (face size → proximity)
        this._updateLeanDetection(primaryFaceSize);

        // Rhythm sync output for visual system
        this._updateRhythmSync(primaryHeadY, bestBobState, now);

        // Engaged if ANY face is synced
        const wasEngaged = this.state.isEngaged;
        this.state.isEngaged = syncedCount > 0;

        // Emit pulse if any face synced
        if (this.state.isEngaged) {
            this._emitPulse(now);
        }

        // Broadcast rhythm sync for visual system (pass this frame's timestamp so the
        // emboss render list can gate on freshness, not the 3s identity timeout).
        this._broadcastRhythmSync(now);

        // Fire granular motion pulses for syntax system (velocity spikes, orientation peaks)
        this._emitMotionPulses(now);

        // Report face VISIBILITY for auto-switch (not bob confidence).
        // Bob confidence = 0 when user sits still, but face is clearly visible.
        // Auto-switch should only trigger when face actually leaves the frame.
        this._dep('cameraManager')?.reportConfidence(faceVisibilityConfidence);
    }

    /**
     * Update lean detection based on face size
     * Larger face = user leaning in, smaller = leaning back
     */
    _updateLeanDetection(faceSize) {
        if (faceSize <= 0) return;

        this.state.faceSize = faceSize;

        // Initialize smoothed value
        if (!this._smoothedFaceSize) this._smoothedFaceSize = faceSize;

        // Low-pass filter to separate intentional lean (DC) from rhythmic bobbing (AC)
        // Alpha 0.05 at ~20fps gives ~1s time constant, filtering out beat-sync motions
        const alpha = 0.05;
        this._smoothedFaceSize = (this._smoothedFaceSize * (1 - alpha)) + (faceSize * alpha);

        // Build baseline over first 2 seconds
        this.faceSizeHistory.push(faceSize);
        if (this.faceSizeHistory.length > 40) { // ~2 sec at 20fps
            this.faceSizeHistory.shift();
        }

        // Calibrate baseline after collecting enough samples
        if (!this.faceSizeCalibrated && this.faceSizeHistory.length >= 30) {
            this.state.baselineFaceSize = this._median(this.faceSizeHistory);
            this.faceSizeCalibrated = true;
            this._dep('debugManager')?.info?.(`📏 Lean baseline calibrated: ${this.state.baselineFaceSize.toFixed(3)}`);
        }

        // Calculate lean amount (-1 to +1) based on SMOOTHED size
        if (this.faceSizeCalibrated && this.state.baselineFaceSize > 0) {
            const ratio = this._smoothedFaceSize / this.state.baselineFaceSize;
            // ratio > 1 = leaning in, ratio < 1 = leaning back
            // Map to -1 to +1 range with some dead zone
            const rawLean = (ratio - 1) * 5; // Amplify
            this.state.leanAmount = Math.max(-1, Math.min(1, rawLean));
        }
    }

    /**
     * Update rhythm sync values for visual system
     */
    _updateRhythmSync(headY, bobState, now) {
        // Store raw headY and derive a fast velocity signal for more immediate motion mapping
        this.state.headY = headY;

        const dt = (this._lastRhythmHeadT > 0) ? (now - this._lastRhythmHeadT) : 0;
        const dy = (this._lastRhythmHeadY != null) ? (headY - this._lastRhythmHeadY) : 0;
        const v = (dt > 0) ? (dy / dt) : 0; // normalized units per ms
        const vPerSec = v * 1000;

        // Light smoothing to reduce landmark jitter but keep responsiveness
        const velSmoothing = this.sensitivity.headVelocitySmoothing;
        this.state.headVelocity = this.state.headVelocity * (1 - velSmoothing) + vPerSec * velSmoothing;

        // Derived velocity-change features: acceleration and jerk
        const dtSec = dt > 0 ? (dt / 1000) : 0;
        if (dtSec > 0) {
            const rawAcceleration = (this.state.headVelocity - this._lastHeadVelocity) / dtSec;
            const rawJerk = (rawAcceleration - this._lastHeadAcceleration) / dtSec;

            // Slightly slower smoothing than velocity to keep meaningful change-shape
            this.state.headAcceleration = this.state.headAcceleration * 0.78 + rawAcceleration * 0.22;
            this.state.headJerk = this.state.headJerk * 0.85 + rawJerk * 0.15;

            this._lastHeadVelocity = this.state.headVelocity;
            this._lastHeadAcceleration = this.state.headAcceleration;
        }

        this._lastRhythmHeadY = headY;
        this._lastRhythmHeadT = now;

        // Smooth the head Y position for direct visual sync
        const smoothing = 0.45;
        this.state.smoothedBobY = this.state.smoothedBobY * (1 - smoothing) + headY * smoothing;

        if (bobState && bobState.confidence > 0.3) {
            // User rhythm phase (0-1 cycle)
            this.state.userRhythmPhase = bobState.bobPhase;

            // Intensity based on confidence and amplitude
            this.state.userRhythmIntensity =
                bobState.confidence * Math.min(1, bobState.bobAmplitude / 0.03);
        } else {
            // Fade out intensity when no clear rhythm
            this.state.userRhythmIntensity *= 0.95;
        }
    }

    /**
     * Extract the 16 FEATURE landmarks for one face's expressive smiley (HeadExtrude
     * derives center / axes / roll / per-eye openness / mouth-curve from these). Slots:
     *   0 top(10)  1 chin(152)  2 left(234)  3 right(454)
     *   4-7  left eye:  outer(33)  inner(133)  upperLid(159)  lowerLid(145)
     *   8-11 right eye: outer(263) inner(362)  upperLid(386)  lowerLid(374)
     *   12-15 mouth: leftCorner(61) rightCorner(291) upperLip(13) lowerLip(14)
     * Returns raw (normalized image coords) or null if any point is missing/NaN;
     * HeadExtrude mirrors/maps to pixels.
     */
    _extractSilhouette(landmarks) {
        const FEATURES = [10, 152, 234, 454, 33, 133, 159, 145, 263, 362, 386, 374, 61, 291, 13, 14];
        const out = [];
        for (let i = 0; i < FEATURES.length; i++) {
            const p = landmarks[FEATURES[i]];
            if (!p || !isFinite(p.x) || !isFinite(p.y)) return null;
            out.push({ x: p.x, y: p.y, z: p.z || 0 });
        }
        return out;
    }

    _broadcastRhythmSync(frameNow = performance.now()) {
        // Per-face payload for the multi-face emboss — one entry per CURRENTLY-VISIBLE
        // person, largest (closest) first so faces[0] is the primary. Gate on FRESHNESS,
        // NOT the 3s identity timeout (faceTimeout): a faceState lingers up to faceTimeout
        // so a briefly occluded face keeps its bob HISTORY, but a stale silhouette must not
        // keep stamping a phantom relief once the face is gone — otherwise a transient false
        // detection (reflection, a hand, the head re-acquired at a new spot) ghosts on screen
        // for seconds. Only faces matched within __multiFaceFreshMs of this frame render.
        const freshMs = (window.__multiFaceFreshMs ?? 150);
        const faces = [];
        for (const fs of this.faceStates) {
            if (fs.silhouette && (frameNow - fs.lastSeen) < freshMs) {
                faces.push({
                    id: fs.id,
                    faceLandmarks: fs.silhouette,
                    intensity: fs.intensity || 0,
                    headVelocity: fs.headVel || 0,
                    size: fs.faceSize || 0
                });
            }
        }
        faces.sort((a, b) => b.size - a.size);

        // Collective lift: a synced room pushes the shared visual intensity toward full
        // (clamped to the 0-1 contract existing consumers assume). Per-face emboss reads
        // its own intensity from faces[], so this only lifts the rest of the show.
        const crowd = this.state.crowdEnergy || 0;
        const crowdGain = (window.__crowdEnergyGain ?? 0.5);
        const liftedIntensity = Math.min(1, this.state.userRhythmIntensity * (1 + crowdGain * crowd));

        const payload = {
            phase: this.state.userRhythmPhase,
            intensity: liftedIntensity,
            frequency: this.state.bobFrequency,
            smoothedY: this.state.smoothedBobY,
            headY: this.state.headY,
            headVelocity: this.state.headVelocity,
            headAcceleration: this.state.headAcceleration,
            headJerk: this.state.headJerk,
            headYaw: this.state.headYaw,
            headPitch: this.state.headPitch,
            headRoll: this.state.headRoll,
            headYawVelocity: this.state.headYawVelocity,
            headPitchVelocity: this.state.headPitchVelocity,
            headRollVelocity: this.state.headRollVelocity,
            leanAmount: this.state.leanAmount,
            isEngaged: this.state.isEngaged,
            faceLandmarks: this.state.faceLandmarks || null,
            faces: faces,
            faceCount: this.state.faceCount,
            syncedFaces: this.state.syncedFaces,
            crowdEnergy: crowd,
            timestamp: frameNow
        };

        // Publish via MotionBus
        window.MotionBus?.emit('rhythmSync', payload);

        // Also dispatch event for systems that prefer events
        window.dispatchEvent(new CustomEvent('user-rhythm-sync', {
            detail: payload
        }));
    }

    /**
     * Calculate median of array
     */
    _median(arr) {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _updateHeadOrientation(landmarks, now) {
        try {
            const nose = landmarks[this.LANDMARKS.NOSE_TIP];
            const leftEar = landmarks[this.LANDMARKS.LEFT_EAR];
            const rightEar = landmarks[this.LANDMARKS.RIGHT_EAR];
            const forehead = landmarks[this.LANDMARKS.FOREHEAD];
            const chin = landmarks[this.LANDMARKS.CHIN];

            if (!nose || !leftEar || !rightEar || !forehead || !chin) return;

            const earDx = (rightEar.x - leftEar.x);
            const earDy = (rightEar.y - leftEar.y);
            const earSpan = Math.max(1e-4, Math.sqrt(earDx * earDx + earDy * earDy));

            // Roll: tilt of the ear-line (normalized roughly to -1..1)
            const rollRad = Math.atan2(earDy, earDx);
            let roll = rollRad / (Math.PI / 4);
            roll = Math.max(-1, Math.min(1, roll));

            // Yaw: nose offset from ear midpoint (normalized by ear span)
            const midX = (leftEar.x + rightEar.x) * 0.5;
            let yaw = (nose.x - midX) / earSpan;
            yaw = Math.max(-1, Math.min(1, yaw * this.sensitivity.yawGain));

            // Pitch: nose position between forehead and chin (normalized to -1..1)
            const denomY = Math.max(1e-4, (chin.y - forehead.y));
            let pitch = ((nose.y - forehead.y) / denomY - 0.5) * 2;
            pitch = Math.max(-1, Math.min(1, pitch * this.sensitivity.pitchGain));

            roll = Math.max(-1, Math.min(1, roll * this.sensitivity.rollGain));

            const dt = (this._lastRhythmHeadT > 0) ? (now - this._lastRhythmHeadT) : 0;
            if (dt > 0) {
                if (this._lastYaw != null) {
                    const dyaw = yaw - this._lastYaw;
                    this.state.headYawVelocity = this.state.headYawVelocity * (1 - this.sensitivity.orientationVelocitySmoothing) + (dyaw / dt) * 1000 * this.sensitivity.orientationVelocitySmoothing;
                }
                if (this._lastPitch != null) {
                    const dpitch = pitch - this._lastPitch;
                    this.state.headPitchVelocity = this.state.headPitchVelocity * (1 - this.sensitivity.orientationVelocitySmoothing) + (dpitch / dt) * 1000 * this.sensitivity.orientationVelocitySmoothing;
                }
                if (this._lastRoll != null) {
                    const droll = roll - this._lastRoll;
                    this.state.headRollVelocity = this.state.headRollVelocity * (1 - this.sensitivity.orientationVelocitySmoothing) + (droll / dt) * 1000 * this.sensitivity.orientationVelocitySmoothing;
                }
            }

            // Light smoothing for pose jitter
            const a = this.sensitivity.orientationSmoothing;
            this.state.headYaw = this.state.headYaw * (1 - a) + yaw * a;
            this.state.headPitch = this.state.headPitch * (1 - a) + pitch * a;
            this.state.headRoll = this.state.headRoll * (1 - a) + roll * a;

            this._lastYaw = yaw;
            this._lastPitch = pitch;
            this._lastRoll = roll;
        } catch (_) {
            // Ignore orientation errors; bob detection should still work
        }
    }

    setSensitivityMode(mode) {
        const nextMode = (mode === 'boost') ? 'boost' : 'normal';
        this.sensitivityMode = nextMode;

        if (nextMode === 'boost') {
            this.sensitivity.yawGain = 3.4;
            this.sensitivity.rollGain = 1.6;
            this.sensitivity.pitchGain = 1.35;
            this.sensitivity.orientationSmoothing = 0.38;
            this.sensitivity.orientationVelocitySmoothing = 0.45;
            this.sensitivity.headVelocitySmoothing = 0.5;
        } else {
            this.sensitivity.yawGain = 2.2;
            this.sensitivity.rollGain = 1.0;
            this.sensitivity.pitchGain = 1.0;
            this.sensitivity.orientationSmoothing = 0.25;
            this.sensitivity.orientationVelocitySmoothing = 0.3;
            this.sensitivity.headVelocitySmoothing = 0.35;
        }

        try {
            if (this._dep('commandRegistry')?.showParameterIndicator) {
                this._dep('commandRegistry').showParameterIndicator(`Camera Intensity: ${nextMode === 'boost' ? 'HIGH' : 'NORMAL'}`);
            }
        } catch (_) { }

        return true;
    }

    /**
     * Find existing face state by nose-tip centroid (X+Y), or create new one.
     * Uses Euclidean distance so two faces at similar X but different Y
     * (e.g. standing vs sitting) are correctly distinguished.
     */
    _findOrCreateFaceState(headX, headY, now) {
        const matchThreshold = 0.12; // Euclidean distance in normalized coords
        let bestMatch = null;
        let bestDist = Infinity;

        for (const fs of this.faceStates) {
            const dx = fs.headX - headX;
            const dy = fs.headY - headY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < matchThreshold && dist < bestDist) {
                bestDist = dist;
                bestMatch = fs;
            }
        }

        if (bestMatch) {
            bestMatch.headX = headX;
            bestMatch.headY = headY;
            return bestMatch;
        }

        // Enforce maxFaces cap
        if (this.faceStates.length >= this.maxFaces) {
            // Evict the oldest face
            let oldestIdx = 0;
            for (let i = 1; i < this.faceStates.length; i++) {
                if (this.faceStates[i].lastSeen < this.faceStates[oldestIdx].lastSeen) {
                    oldestIdx = i;
                }
            }
            this.faceStates.splice(oldestIdx, 1);
        }

        // Create new face state
        const newFace = {
            id: this._nextFaceId++,   // stable identity so HeadExtrude tracks this person across frames
            headX,
            headY,
            yHistory: [],
            lastSeen: now,
            bobState: null,
            beatSyncScore: 0,
            silhouette: null,
            intensity: 0,
            headVel: 0,
            faceSize: 0
        };
        this.faceStates.push(newFace);
        return newFace;
    }

    /**
     * Remove faces not seen recently
     */
    _pruneOldFaces(now) {
        this.faceStates = this.faceStates.filter(fs =>
            now - fs.lastSeen < this.faceTimeout
        );
    }

    /**
     * Track face entrance/exit with hysteresis — emits events to AudioReactivityBus
     * so AE can treat face-in/face-out like an instrument change.
     */
    _trackFacePresence(now) {
        const faceCount = this.state.faceCount;
        const bus = window.MotionBus;
        if (!bus) return;

        const h = this.faceHysteresis;
        const t = this.facePresence;

        if (!t.isActive && faceCount > 0) {
            // Candidate entrance
            if (!t.candidateEntrance) {
                t.candidateEntrance = true;
                t.entranceFirstSeen = now;
            } else if (now - t.entranceFirstSeen >= h.sustainedThreshold) {
                t.isActive = true;
                t.startTime = now;
                t.lastFaceCount = faceCount;
                t.candidateEntrance = false;

                bus.emit('faceEntrance', {
                    faceCount,
                    t: now,
                    source: 'HeadBobDetector'
                });
            }
        } else if (!t.isActive) {
            t.candidateEntrance = false;
        }

        if (t.isActive && faceCount === 0) {
            // Candidate exit
            if (!t.candidateExit) {
                t.candidateExit = true;
                t.exitFirstSeen = now;
            } else if (now - t.exitFirstSeen >= h.exitSustainedThreshold) {
                bus.emit('faceExit', {
                    lastFaceCount: t.lastFaceCount,
                    duration: now - t.startTime,
                    t: now,
                    source: 'HeadBobDetector'
                });

                t.isActive = false;
                t.candidateExit = false;
            }
        } else if (t.isActive) {
            t.candidateExit = false;
            // Also emit face count changes (new person joins/leaves while active)
            if (faceCount !== t.lastFaceCount) {
                bus.emit('faceCountChange', {
                    faceCount,
                    previousCount: t.lastFaceCount,
                    t: now,
                    source: 'HeadBobDetector'
                });
                t.lastFaceCount = faceCount;
            }
        }
    }

    /**
     * Detect bob pattern for a specific face
     */
    _detectBobForFace(faceState) {
        if (faceState.yHistory.length < 30) return null;

        const yValues = faceState.yHistory.map(h => h.y);
        const times = faceState.yHistory.map(h => h.t);

        // Find peaks and troughs
        const peaks = this._findPeaks(yValues);
        const troughs = this._findTroughs(yValues);

        if (peaks.length < 2 || troughs.length < 2) return null;

        // Calculate bob frequency from peak-to-peak timing
        const peakTimes = peaks.map(i => times[i]);
        const avgPeriod = this._averageDelta(peakTimes);
        if (avgPeriod <= 0) return null;

        const bobFrequency = 1000 / avgPeriod; // Hz

        // Frequency bounds: reject postural drift and landmark jitter
        if (bobFrequency < this.config.minBobFrequency || bobFrequency > this.config.maxBobFrequency) return null;

        // Calculate amplitude
        const avgPeakY = peaks.reduce((s, i) => s + yValues[i], 0) / peaks.length;
        const avgTroughY = troughs.reduce((s, i) => s + yValues[i], 0) / troughs.length;
        const bobAmplitude = Math.abs(avgPeakY - avgTroughY);

        // Check minimum amplitude
        if (bobAmplitude < this.config.minAmplitude) return null;

        // Calculate current phase (0-1)
        const lastPeakIdx = peaks[peaks.length - 1];
        const framesSincePeak = yValues.length - 1 - lastPeakIdx;
        const framesPerCycle = avgPeriod / (1000 / this.config.targetFPS);
        const bobPhase = (framesSincePeak / framesPerCycle) % 1;

        // Calculate confidence based on regularity
        const confidence = this._calculateConfidence(peaks, troughs, bobAmplitude);

        return {
            bobFrequency,
            bobAmplitude,
            bobPhase,
            confidence
        };
    }

    /**
     * Find local maxima in array
     */
    _findPeaks(arr) {
        const peaks = [];
        for (let i = 2; i < arr.length - 2; i++) {
            if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] &&
                arr[i] > arr[i - 2] && arr[i] > arr[i + 2]) {
                peaks.push(i);
            }
        }
        return peaks;
    }

    /**
     * Find local minima in array
     */
    _findTroughs(arr) {
        const troughs = [];
        for (let i = 2; i < arr.length - 2; i++) {
            if (arr[i] < arr[i - 1] && arr[i] < arr[i + 1] &&
                arr[i] < arr[i - 2] && arr[i] < arr[i + 2]) {
                troughs.push(i);
            }
        }
        return troughs;
    }

    /**
     * Calculate average delta between consecutive values
     */
    _averageDelta(values) {
        if (values.length < 2) return 0;
        let sum = 0;
        for (let i = 1; i < values.length; i++) {
            sum += values[i] - values[i - 1];
        }
        return sum / (values.length - 1);
    }

    /**
     * Calculate confidence based on pattern regularity
     */
    _calculateConfidence(peaks, troughs, amplitude) {
        // More peaks/troughs = more confidence
        const countScore = Math.min(1, (peaks.length + troughs.length) / 8);

        // Larger amplitude = more confidence
        const ampScore = Math.min(1, amplitude / 0.05);

        // Check regularity of peak spacing
        if (peaks.length >= 3) {
            const peakDeltas = [];
            for (let i = 1; i < peaks.length; i++) {
                peakDeltas.push(peaks[i] - peaks[i - 1]);
            }
            const mean = peakDeltas.reduce((a, b) => a + b, 0) / peakDeltas.length;
            const variance = peakDeltas.reduce((s, d) => s + Math.pow(d - mean, 2), 0) / peakDeltas.length;
            const cv = Math.sqrt(variance) / (mean + 0.001);
            const regularityScore = Math.max(0, 1 - cv);

            return (countScore * 0.3 + ampScore * 0.3 + regularityScore * 0.4);
        }

        return countScore * 0.5 + ampScore * 0.5;
    }

    /**
     * Calculate beat sync score
     */
    _calculateBeatSync(bobState) {
        if (!bobState || bobState.confidence < 0.3) return 0;

        // Get music BPM
        const musicBPM = this._dep('audioBus')?.state?.bpm
            || this._dep('audioUniforms')?.bpm?.value
            || 120;

        const beatFrequency = musicBPM / 60; // Hz

        // Match the bob frequency against the beat and its half/double subdivisions
        // via the shared matcher (single source of truth — js/lib/beat-subdivision.js).
        // relativeTo:'matched' reproduces this detector's original convention exactly
        // (deviation measured against k×beatFreq, not against the bob frequency).
        if (window.BeatSubdivision) {
            return window.BeatSubdivision.syncScore(
                bobState.bobFrequency, beatFrequency, 0.2, { relativeTo: 'matched' }
            );
        }

        // Fallback: original inline [0.5, 1, 2] loop (20% tolerance), kept so the
        // detector still works standalone when BeatSubdivision isn't loaded (Camerastein).
        const subdivisions = [0.5, 1.0, 2.0];
        let bestSync = 0;

        for (const sub of subdivisions) {
            const targetFreq = beatFrequency * sub;
            const ratio = bobState.bobFrequency / targetFreq;
            const deviation = Math.abs(ratio - 1.0);

            if (deviation < 0.2) { // 20% tolerance
                const sync = 1.0 - (deviation / 0.2);
                bestSync = Math.max(bestSync, sync);
            }
        }

        return bestSync;
    }

    /**
     * Emit pulse to SyntaxPulseCollector
     */
    _emitPulse(now) {
        // Cooldown check
        if (now - this.lastPulseTime < this.config.cooldownMs) return;

        // Feed into existing pulse system
        if (this._dep('pulseCollector')) {
            this._dep('pulseCollector').recordPulse('camera', 'head-bob');
        }

        this.lastPulseTime = now;
        this.state.lastBobTime = now;

        // Debug log
        this._dep('debugManager')?.info?.(`🎵 Head bob detected! Freq: ${this.state.bobFrequency.toFixed(2)} Hz, Sync: ${(this.state.beatSyncScore * 100).toFixed(0)}%`);
    }

    /**
     * Emit granular motion pulses on velocity spikes and orientation peaks.
     * Separate cooldown from bob detection so the syntax system gets
     * timing data for quick head gestures, not just full bob cycles.
     */
    _emitMotionPulses(now) {
        if (!this._dep('pulseCollector')) return;
        if (!this._lastMotionPulseTime) this._lastMotionPulseTime = 0;

        // 80ms cooldown — fast enough to catch beats, slow enough to avoid flood
        if (now - this._lastMotionPulseTime < 80) return;

        const vel = Math.abs(this.state.headVelocity || 0);
        const yawVel = Math.abs(this.state.headYawVelocity || 0);
        const rollVel = Math.abs(this.state.headRollVelocity || 0);
        const pitchVel = Math.abs(this.state.headPitchVelocity || 0);

        // Velocity spike thresholds (tuned to catch intentional movements, not jitter)
        if (vel > 0.8) {
            this._dep('pulseCollector').recordPulse('camera', 'head-velocity');
            this._lastMotionPulseTime = now;
        } else if (yawVel > 0.6) {
            this._dep('pulseCollector').recordPulse('camera', 'head-yaw');
            this._lastMotionPulseTime = now;
        } else if (rollVel > 0.5) {
            this._dep('pulseCollector').recordPulse('camera', 'head-roll');
            this._lastMotionPulseTime = now;
        } else if (pitchVel > 0.5) {
            this._dep('pulseCollector').recordPulse('camera', 'head-pitch');
            this._lastMotionPulseTime = now;
        }

        // Mouth-open pulse: edge trigger when mouth crosses open threshold
        // Fires when singing/vocalizing — gives syntax system timing of vocal events
        const mouthOpen = (this.state.mouthOpenness || 0) > 0.4;
        if (mouthOpen && !this._prevMouthOpen) {
            this._dep('pulseCollector').recordPulse('camera', 'mouth-open');
            this._lastMotionPulseTime = now;
        }
        this._prevMouthOpen = mouthOpen;
    }

    /**
     * Shared container for all camera tracking indicators (head, body, hand).
     * Creates once, reused by all detectors.
     */
    _getOrCreateIndicatorContainer() {
        let container = document.getElementById('camera-indicator-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'camera-indicator-container';
            container.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                display: flex;
                gap: 4px;
                align-items: center;
                z-index: 10000;
                pointer-events: auto;
            `;
            document.body.appendChild(container);
        }
        return container;
    }

    /**
     * Show/hide webcam indicator
     */
    _showIndicator(show) {
        let indicator = document.getElementById('head-bob-indicator');

        if (show) {
            // Respect "disable visual toasts" preference
            if (window.toastsDisabled || localStorage.getItem('disableToasts') === 'true') return;

            if (!indicator) {
                const container = this._getOrCreateIndicatorContainer();
                indicator = document.createElement('div');
                indicator.id = 'head-bob-indicator';
                indicator.innerHTML = '📹';
                indicator.style.cssText = `
                    font-size: 18px;
                    opacity: 0.5;
                    cursor: pointer;
                    user-select: none;
                    transform-origin: center center;
                    line-height: 1;
                `;
                indicator.title = 'Head tracking active - click to disable';
                indicator.onclick = () => this.toggle();
                container.appendChild(indicator);
            }

            // Start animation loop
            this._animateIndicator();
        } else {
            // Cancel animation frame to prevent memory leak
            if (this._indicatorAnimationId) {
                cancelAnimationFrame(this._indicatorAnimationId);
                this._indicatorAnimationId = null;
            }
            if (indicator) {
                indicator.remove();
            }
        }
    }

    /**
     * Animate indicator to show tracking state
     * - Idle: subtle breathing, grayscale (no face)
     * - Face found: brighter, no filter (face but no bob)
     * - Bobbing: yellow pulse (bobbing but not synced to beat)
     * - Beat synced: green bounce with bob rhythm
     * - Multi-face: shows count badge
     * - Lean: scale increases when leaning in
     */
    _animateIndicator() {
        if (!this.active) return;

        const indicator = document.getElementById('head-bob-indicator');
        if (!indicator) return;

        const now = performance.now();
        const faceCount = this.state.faceCount;
        const syncedCount = this.state.syncedFaces;
        const hasFace = faceCount > 0;
        const isBobbing = this.state.bobFrequency > 0.3 && this.state.bobAmplitude > 0.005;
        const isSynced = syncedCount > 0;
        const lean = this.state.leanAmount || 0;
        const gaze = window.gazeEngagement || {};

        // Lean affects base scale (leaning in = bigger indicator)
        const leanScale = 1 + lean * 0.2;

        // Focus Lock (Psychic / Meditation mode)
        if (gaze.focusLocked) {
            indicator.style.transform = `scale(${1.2 * leanScale})`;
            indicator.style.opacity = '1';
            indicator.style.filter = 'drop-shadow(0 0 10px #8b5cf6) saturate(1.5)';
            indicator.innerHTML = '🧘';
            this._indicatorAnimationId = requestAnimationFrame(() => this._animateIndicator());
            return;
        }

        // Multi-face indicator badge (0/2) suppressed until improved
        const badge = ''; // faceCount > 1 ? `<sub>${syncedCount}/${faceCount}</sub>` : '';

        // Check mouth state for singing/speaking
        const isSinging = this.state.isSinging;
        const isSpeaking = this.state.isSpeaking;

        if (isSynced) {
            // Beat synced - bob with the detected frequency
            const bobPeriod = 1000 / Math.max(0.5, this.state.bobFrequency);
            const phase = (now % bobPeriod) / bobPeriod;
            const bounce = Math.sin(phase * Math.PI * 2) * 0.15;

            indicator.style.transform = `scale(${(1.1 + bounce) * leanScale}) translateY(${bounce * 10}px)`;
            indicator.style.opacity = '1';
            indicator.style.filter = 'hue-rotate(-60deg) saturate(1.5)'; // Green tint
            // Show singing emoji if detected
            indicator.innerHTML = (isSinging ? '🎤🎵' : '🎵') + badge;
        } else if (isBobbing) {
            // Bobbing detected but not synced to beat - yellow pulse
            const pulse = Math.sin(now / 200) * 0.12;
            indicator.style.transform = `scale(${(1.05 + pulse) * leanScale})`;
            indicator.style.opacity = '0.9';
            indicator.style.filter = 'hue-rotate(30deg) saturate(1.3)'; // Yellow
            indicator.innerHTML = (isSinging ? '🎤🎵' : '🎤') + badge;
        } else if (hasFace) {
            // Face detected, waiting for movement
            const pulse = Math.sin(now / 500) * 0.05;
            indicator.style.transform = `scale(${(1 + pulse) * leanScale})`;
            indicator.style.opacity = '0.7';
            indicator.style.filter = 'none';
            // Show mouth state if singing/speaking detected
            let emoji = (faceCount > 1 ? '👥' : '👤');
            if (isSinging) emoji = '🎤';
            else if (isSpeaking) emoji = '💬';
            indicator.innerHTML = emoji + badge;
        } else {
            // Idle - subtle breathing, waiting for face
            const breath = Math.sin(now / 1000) * 0.03;
            indicator.style.transform = `scale(${1 + breath})`;
            indicator.style.opacity = '0.4';
            indicator.style.filter = 'grayscale(0.7)';
            indicator.innerHTML = '📹';
        }

        this._indicatorAnimationId = requestAnimationFrame(() => this._animateIndicator());
    }

    /**
     * Get current state for debugging/monitoring
     */
    getState() {
        return { ...this.state };
    }
}

// Global singleton
window.HeadBobDetector = new HeadBobDetector();

// Camera commands (6/7/8/9 keys) handled by camera-commands.js
// Camera intensity (( key) removed — sensitivity is always normal.
