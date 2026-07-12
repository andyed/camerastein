/**
 * Hand Pose Detector
 *
 * Hand tracking overlay mode for Psychodeli+.
 * Unlike Head/Body (mutually exclusive primary modes), Hands runs CONCURRENTLY
 * with whichever primary mode is active, processing on every Nth frame (~3Hz).
 *
 * Extracts 12+ normalized signals from MediaPipe Hands (21 landmarks × 2 hands):
 * - fingerSpread, pinchDistance, pinchStrength, fistClosure
 * - palmFacing, wristAngle, handProximity, fingerVelocity
 * - handPositionX/Y, thumbExtension, twoHandDistance
 *
 * Two control paradigms:
 * 1. Direct control — deterministic hand→param mappings (Phase 3)
 * 2. Syntax learning — signals feed UserMotionMapper + SyntaxRL (Phase 4)
 *
 * Activated via ^ key. Uses SharedCameraManager overlay mode.
 *
 * @see docs/HAND_TRACKING_INTEGRATION_SPEC.md
 */

class HandPoseDetector {
    constructor() {
        this.enabled = false;
        this.active = false;

        // MediaPipe Hands landmark indices (21 per hand)
        // https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
        this.LANDMARKS = {
            WRIST: 0,
            THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
            INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
            MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
            RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
            PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20
        };

        // Fingertip indices for quick iteration
        this._fingertipIndices = [
            this.LANDMARKS.THUMB_TIP,
            this.LANDMARKS.INDEX_TIP,
            this.LANDMARKS.MIDDLE_TIP,
            this.LANDMARKS.RING_TIP,
            this.LANDMARKS.PINKY_TIP
        ];

        // MCP (knuckle) indices for spread calculation
        this._mcpIndices = [
            this.LANDMARKS.INDEX_MCP,
            this.LANDMARKS.MIDDLE_MCP,
            this.LANDMARKS.RING_MCP,
            this.LANDMARKS.PINKY_MCP
        ];

        // Finger joint chains for per-finger curl computation [MCP, PIP, DIP, TIP]
        this._fingerChains = [
            [this.LANDMARKS.THUMB_CMC, this.LANDMARKS.THUMB_MCP, this.LANDMARKS.THUMB_IP, this.LANDMARKS.THUMB_TIP],
            [this.LANDMARKS.INDEX_MCP, this.LANDMARKS.INDEX_PIP, this.LANDMARKS.INDEX_DIP, this.LANDMARKS.INDEX_TIP],
            [this.LANDMARKS.MIDDLE_MCP, this.LANDMARKS.MIDDLE_PIP, this.LANDMARKS.MIDDLE_DIP, this.LANDMARKS.MIDDLE_TIP],
            [this.LANDMARKS.RING_MCP, this.LANDMARKS.RING_PIP, this.LANDMARKS.RING_DIP, this.LANDMARKS.RING_TIP],
            [this.LANDMARKS.PINKY_MCP, this.LANDMARKS.PINKY_PIP, this.LANDMARKS.PINKY_DIP, this.LANDMARKS.PINKY_TIP]
        ];

        // Per-finger state keys (parallel to _fingerChains)
        this._curlKeys = ['thumbCurl', 'indexCurl', 'middleCurl', 'ringCurl', 'pinkyCurl'];
        this._velKeys = ['thumbVelocity', 'indexVelocity', 'middleVelocity', 'ringVelocity', 'pinkyVelocity'];
        this._extKeys = [null, 'indexExtension', 'middleExtension', 'ringExtension', 'pinkyExtension']; // thumb uses thumbExtension

        // Per-hand tracking history for velocity calculation
        this._handHistories = [[], []]; // [leftHand, rightHand]
        this._historyMaxLength = 40; // ~2s at 20fps overlay rate

        // Low-confidence timeout: stop processing if < 0.3 for > 2s
        this._lowConfidenceStart = null;
        this._lowConfidenceTimeout = 2000;
        this._minConfidence = 0.3;

        // Aggregate state broadcast via MotionBus
        this.state = {
            // Per-hand signals (dominant hand used for single-hand controls)
            fingerSpread: 0,        // 0-1: inter-finger angles at MCP joints
            pinchDistance: 1,       // 0-1: thumb tip ↔ index tip (1=far apart)
            pinchStrength: 0,       // 0-1: inverse of pinchDistance (1=fully pinched)
            fistClosure: 0,         // 0-1: fingertips-to-palm distance inverted
            palmFacing: 0,          // -1 to 1: palm normal · camera Z axis
            wristAngle: 0,          // -1 to 1: flexion/extension
            handProximity: 0,       // 0-1: hand bbox size (closer=larger)
            fingerVelocity: 0,      // 0+: RMS of fingertip velocities
            handPositionX: 0.5,     // 0-1: palm center, screen-normalized
            handPositionY: 0.5,     // 0-1: palm center, screen-normalized
            thumbExtension: 0,      // 0-1: thumb tip distance from palm center

            // Two-hand signals
            twoHandDistance: 0,     // 0-1: wrist-to-wrist when 2 hands visible
            handCount: 0,           // 0, 1, or 2

            // Deltas for edge detection
            pinchDelta: 0,          // Rate of change of pinchStrength
            spreadDelta: 0,         // Rate of change of fingerSpread

            // Per-finger curl (0=extended, 1=fully curled) — MCP-PIP-DIP-TIP chain
            thumbCurl: 0,
            indexCurl: 0,
            middleCurl: 0,
            ringCurl: 0,
            pinkyCurl: 0,

            // Per-finger velocity (individual tip speeds, not RMS aggregate)
            thumbVelocity: 0,
            indexVelocity: 0,
            middleVelocity: 0,
            ringVelocity: 0,
            pinkyVelocity: 0,

            // Per-finger extension (tip distance from palm center)
            indexExtension: 0,
            middleExtension: 0,
            ringExtension: 0,
            pinkyExtension: 0,

            // Derived inter-finger signals
            fingerWave: 0,          // 0-1: phase offset between sequential finger curls
            curlVariance: 0,        // 0-1: how different fingers are from each other
            dominantFinger: 0,      // 0-1: which finger has highest velocity (0=thumb, 0.25=index, etc.)

            // Percussive strike (air-drum): discrete downward-strike events,
            // detected from RAW wrist velocity (bypasses the EMA smoothing).
            lastStrike: null,       // { intensity, hand, t } | null — most recent strike
            strikeCount: 0,         // cumulative strikes this session
            strikeEnergy: 0,        // 0-1: decaying envelope of recent strike intensity.
                                    // UNGATED by confidence — the reliable, intensity-aware
                                    // drumming signal for the engagement/reward loop (handEng
                                    // is confidence-gated + smoothed → flickers off mid-drum).

            // Thumbs-up / thumbs-down deliberate-feedback gesture (geometry only).
            // A held + centered + near-camera thumb pose charges thumbCharge 0→1;
            // at full charge the detector fires onGesture('thumbConfirm', {direction})
            // and the host maps it to user sentiment (up=good, down=bad). The charge
            // also drives a progressive visual cue (see _applyDirectControls).
            thumbDirection: 0,      // +1 = thumb up, -1 = thumb down, 0 = none
            thumbConfidence: 0,     // 0-1: how cleanly the thumb pose reads (geometry)
            thumbCentered: false,   // hand near frame center AND close to camera
            thumbCharge: 0,         // 0-1: progressive dwell toward confirmation

            // Meta
            confidence: 0,
            dominantHand: 0,        // 0=left, 1=right (by larger motion)
            timestamp: 0
        };

        // Previous frame values for delta calculation
        this._prevPinchStrength = 0;
        this._prevFingerSpread = 0;
        this._prevFingerPositions = [null, null]; // Per-hand fingertip positions

        // EMA smoothing factor for continuous signals
        this._ema = 0.85;

        // ── Air-drum strike detection (raw wrist y-velocity, bypasses EMA) ──
        // Percussive downward strikes are <80ms transients the smoothed gesture
        // path can't resolve. Track the dominant hand's wrist (landmark 0)
        // y-velocity un-smoothed and fire on a downward peak + deceleration/reversal
        // (the "hit point" at the bottom of the stroke). Onset detector for hands.
        this._strikePrevWristY = null;  // previous-frame wrist y (normalized, +down)
        this._strikePeakVy = 0;         // peak downward velocity in the current descent
        this._strikeDescending = false; // currently mid downward stroke
        this._lastStrikeTime = 0;       // debounce timestamp

        // Direct control state (Phase 3)
        this._directControlEnabled = true;
        this._lastFistTime = 0;        // Edge trigger cooldown
        this._lastPalmFlashTime = 0;   // Edge trigger cooldown
        this._edgeCooldownMs = 1500;
        this._prevSpreadForFlash = 0;  // For rapid spread detection

        // ── Thumbs-up/down feedback gesture (deliberate, dwell-confirmed) ──
        // Geometry-only classification (extended thumb + curled fingers + vertical
        // sign of the thumb tip). A high-confidence, centered, held pose charges
        // thumbCharge with a time-based envelope; at full charge it fires
        // onGesture('thumbConfirm', {direction}) ONCE, then latches until the user
        // releases the pose (prevents repeat-records while held). Time-based so it
        // behaves identically at the 3.3Hz overlay rate or 20fps dedicated rate.
        // Live tuning via window.__thumb* flags (see _extractThumbPose / _updateThumbCharge).
        this._thumbChargeLastT = 0;
        this._lastThumbConfirmTime = 0;
        this._thumbConfirmCooldownMs = 800;
        this._thumbLatched = false;    // true after a confirm until pose released

        // Bind
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
     * Check availability
     */
    async isAvailable() {
        return this._dep('cameraManager')?.isAvailable() ?? false;
    }

    /**
     * Request hand tracking via the camera machine. DEPRECATED as a lifecycle
     * authority — detectors are pure consumers now; SharedCameraManager calls
     * _activate/_deactivate when ownership actually changes. Overlay vs
     * dedicated arbitration is the machine's job.
     */
    async start() {
        const r = await this._dep('cameraManager')?.setModeDesired?.('hand', true);
        if (!r?.ok) {
            this._dep('commandRegistry')?.showParameterIndicator?.('🖐️ Hand tracking unavailable');
            throw new Error('Hand tracking failed to start');
        }
    }

    /** Release hand tracking via the camera machine. */
    stop() {
        this._dep('cameraManager')?.setModeDesired?.('hand', false);
    }

    /** Machine hook: hands attached (overlay or dedicated). Consumer setup only. */
    _activate() {
        if (this.active) return;
        this.active = true;
        this.enabled = true;
        this._dep('debugManager')?.info?.('✅ Hand Pose Detector active');
        this._showIndicator(true);
    }

    /**
     * Machine hook: hands detached. Clears rolling state and nulls the hand
     * channel — payload contract: null means null. This is the structural fix
     * for the 9152e5dc zombie ({handCount:0} payloads that read eternally live).
     */
    _deactivate() {
        if (!this.active) return;
        this.active = false;
        this.enabled = false;

        this._handHistories = [[], []];
        this._prevFingerPositions = [null, null];
        this._lowConfidenceStart = null;
        window.MotionBus?.emit('handPose', null);

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

    // ─────────────────────────────────────────────────────────────
    // FRAME PROCESSING
    // ─────────────────────────────────────────────────────────────

    /**
     * Handle MediaPipe Hands results.
     * Called by SharedCameraManager on overlay frames (~3Hz).
     */
    _onResults(results) {
        const now = performance.now();

        // Decay the strike-energy envelope every frame (incl. no-hands frames) so it
        // falls off ~1-2s after drumming stops, independent of frame rate.
        this._decayStrikeEnergy(now);

        if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
            // No hands detected
            this.state.confidence = 0;
            this.state.handCount = 0;

            // No hand → thumb gesture inactive; let any in-progress charge bleed off
            // (decays the dwell so a momentary occlusion doesn't bank progress).
            this.state.thumbDirection = 0;
            this.state.thumbConfidence = 0;
            this.state.thumbCentered = false;
            this._updateThumbCharge(now);

            // Low-confidence timeout
            if (!this._lowConfidenceStart) {
                this._lowConfidenceStart = now;
            } else if (now - this._lowConfidenceStart > this._lowConfidenceTimeout) {
                // Sustained no-hands: zero everything, stop broadcasting
                this._zeroState();
                window.MotionBus?.emit('handPose', null);
                return;
            }

            // Decay signals smoothly during brief occlusions
            this.state.fingerVelocity *= 0.5;
            this.state.pinchDelta *= 0.5;
            this.state.spreadDelta *= 0.5;
            this._broadcastState();
            return;
        }

        // Hands detected — reset low-confidence timer
        const wasZero = this.state.handCount === 0;
        this._lowConfidenceStart = null;

        const hands = results.multiHandLandmarks;

        // Log hand appearance/disappearance transitions
        if (wasZero) {
            this._dep('debugManager')?.logTransition?.('hand', 'hands-detected', { count: hands.length });
        }
        const handedness = results.multiHandedness || [];
        this.state.handCount = hands.length;

        // Determine dominant hand (by motion amplitude or handedness label)
        let dominantIdx = 0;
        if (hands.length === 2) {
            // Use the hand with more fingertip velocity as dominant
            const vel0 = this._calcFingerVelocity(hands[0], 0);
            const vel1 = this._calcFingerVelocity(hands[1], 1);
            dominantIdx = vel1 > vel0 ? 1 : 0;
        }
        this.state.dominantHand = dominantIdx;

        const dominant = hands[dominantIdx];
        const confidences = handedness.map(h => h?.score ?? 0.5);
        this.state.confidence = Math.max(...confidences);

        // Store raw landmark positions for visualization (21 {x,y,z} per hand)
        // Use Array.from — MediaPipe landmarks may not be a standard Array
        this.state.landmarks = Array.from(dominant, lm => ({ x: lm.x, y: lm.y, z: lm.z || 0 }));
        if (hands.length === 2) {
            this.state.landmarks2 = Array.from(hands[1 - dominantIdx], lm => ({ x: lm.x, y: lm.y, z: lm.z || 0 }));
        } else {
            this.state.landmarks2 = null;
        }

        // ── Extract signals from dominant hand ──
        this._extractFingerSpread(dominant);
        this._extractPinch(dominant);
        this._extractFistClosure(dominant);
        this._extractPalmFacing(dominant);
        this._extractWristAngle(dominant);
        this._extractHandProximity(dominant);
        this._extractHandPosition(dominant);
        this._extractThumbExtension(dominant);

        // Finger velocity from dominant hand (also populates per-finger velocities)
        this.state.fingerVelocity = this._calcFingerVelocity(dominant, dominantIdx);

        // Air-drum strike detection — raw wrist velocity, independent of the
        // smoothed gesture/velocity signals above (which can't see a strike transient).
        this._detectStrike(dominant, dominantIdx, now);

        // ── Per-finger signals ──
        this._extractPerFingerCurl(dominant);
        this._extractPerFingerExtension(dominant);
        this._extractDerivedSignals();

        // ── Two-hand signals ──
        if (hands.length === 2) {
            this._extractTwoHandDistance(hands[0], hands[1]);
        } else {
            // Decay two-hand distance toward 0 when only one hand visible
            this.state.twoHandDistance *= 0.8;
        }

        // ── Deltas for edge detection ──
        this.state.pinchDelta = this.state.pinchStrength - this._prevPinchStrength;
        this.state.spreadDelta = this.state.fingerSpread - this._prevFingerSpread;
        this._prevPinchStrength = this.state.pinchStrength;
        this._prevFingerSpread = this.state.fingerSpread;

        // ── Update per-hand history ──
        for (let i = 0; i < hands.length && i < 2; i++) {
            this._updateHistory(hands[i], i, now);
        }

        // ── Thumbs-up/down feedback gesture ──
        // Classify AFTER per-finger curls + hand position/proximity are fresh this
        // frame, then advance the dwell charge (may fire onGesture('thumbConfirm')).
        this._extractThumbPose(dominant);
        this._updateThumbCharge(now);

        // ── Direct controls (Phase 3) ──
        if (this._directControlEnabled) {
            this._applyDirectControls(now);
        }

        // ── Emit syntax pulses (Phase 4) ──
        this._emitMotionPulses(now);

        this.state.timestamp = now;
        this._broadcastState();
    }

    // ─────────────────────────────────────────────────────────────
    // SIGNAL EXTRACTION (Phase 1)
    // ─────────────────────────────────────────────────────────────

    /**
     * Finger spread: average angle between adjacent fingers at MCP joints.
     * 0 = fingers together, 1 = fully spread.
     */
    _extractFingerSpread(landmarks) {
        let totalAngle = 0;
        let count = 0;

        for (let i = 0; i < this._mcpIndices.length - 1; i++) {
            const a = landmarks[this._mcpIndices[i]];
            const b = landmarks[this._mcpIndices[i + 1]];
            if (!a || !b) continue;

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            totalAngle += dist;
            count++;
        }

        if (count === 0) return;

        // Normalize: typical spread range ~0.02 (closed) to ~0.12 (open)
        const raw = totalAngle / count;
        const normalized = Math.max(0, Math.min(1, (raw - 0.02) / 0.10));

        this.state.fingerSpread = this._smooth(this.state.fingerSpread, normalized);
    }

    /**
     * Pinch: distance between thumb tip and index tip.
     * pinchDistance = 0-1 (0=touching), pinchStrength = 1 - pinchDistance.
     */
    _extractPinch(landmarks) {
        const thumb = landmarks[this.LANDMARKS.THUMB_TIP];
        const index = landmarks[this.LANDMARKS.INDEX_TIP];
        if (!thumb || !index) return;

        const dx = thumb.x - index.x;
        const dy = thumb.y - index.y;
        const dz = (thumb.z || 0) - (index.z || 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Normalize: ~0.0 (touching) to ~0.15 (far apart)
        const normalized = Math.max(0, Math.min(1, dist / 0.15));

        this.state.pinchDistance = this._smooth(this.state.pinchDistance, normalized);
        this.state.pinchStrength = this._smooth(this.state.pinchStrength, 1 - normalized);
    }

    /**
     * Fist closure: average distance from fingertips to palm center, inverted.
     * 0 = open hand, 1 = tight fist.
     */
    _extractFistClosure(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        if (!wrist || !middleMcp) return;

        // Palm center approximation: midpoint of wrist and middle MCP
        const palmX = (wrist.x + middleMcp.x) / 2;
        const palmY = (wrist.y + middleMcp.y) / 2;

        let totalDist = 0;
        let count = 0;

        for (const tipIdx of this._fingertipIndices) {
            const tip = landmarks[tipIdx];
            if (!tip) continue;
            const dx = tip.x - palmX;
            const dy = tip.y - palmY;
            totalDist += Math.sqrt(dx * dx + dy * dy);
            count++;
        }

        if (count === 0) return;

        const avgDist = totalDist / count;
        // Normalize: ~0.02 (fist) to ~0.15 (open)
        const openness = Math.max(0, Math.min(1, (avgDist - 0.02) / 0.13));
        const closure = 1 - openness;

        this.state.fistClosure = this._smooth(this.state.fistClosure, closure);
    }

    /**
     * Palm facing: dot product of palm normal with camera Z axis.
     * -1 = palm facing away, 0 = edge on, 1 = palm facing camera.
     * Approximated using cross product of two palm vectors.
     */
    _extractPalmFacing(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const indexMcp = landmarks[this.LANDMARKS.INDEX_MCP];
        const pinkyMcp = landmarks[this.LANDMARKS.PINKY_MCP];
        if (!wrist || !indexMcp || !pinkyMcp) return;

        // Vector from wrist to index MCP
        const v1x = indexMcp.x - wrist.x;
        const v1y = indexMcp.y - wrist.y;
        const v1z = (indexMcp.z || 0) - (wrist.z || 0);

        // Vector from wrist to pinky MCP
        const v2x = pinkyMcp.x - wrist.x;
        const v2y = pinkyMcp.y - wrist.y;
        const v2z = (pinkyMcp.z || 0) - (wrist.z || 0);

        // Cross product gives palm normal
        const nx = v1y * v2z - v1z * v2y;
        const ny = v1z * v2x - v1x * v2z;
        const nz = v1x * v2y - v1y * v2x;

        const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (mag < 0.0001) return;

        // Dot with camera Z axis (0, 0, -1) — so just -nz/mag
        const facing = -nz / mag;
        const clamped = Math.max(-1, Math.min(1, facing));

        this.state.palmFacing = this._smooth(this.state.palmFacing, clamped);
    }

    /**
     * Wrist angle: flexion/extension estimated from wrist-to-middle-finger alignment.
     * -1 = flexed (curled down), 1 = extended (bent back).
     */
    _extractWristAngle(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        const middleTip = landmarks[this.LANDMARKS.MIDDLE_TIP];
        if (!wrist || !middleMcp || !middleTip) return;

        // Vectors: wrist→MCP and MCP→tip
        const v1y = middleMcp.y - wrist.y;
        const v2y = middleTip.y - middleMcp.y;

        // If both go same direction = straight/extended, opposite = flexed
        // Normalize by vertical extent of hand
        const handHeight = Math.abs(middleTip.y - wrist.y) || 0.01;
        const angle = (v2y - v1y) / handHeight;
        const clamped = Math.max(-1, Math.min(1, angle * 2));

        this.state.wristAngle = this._smooth(this.state.wristAngle, clamped);
    }

    /**
     * Hand proximity: estimated from bounding box of hand landmarks.
     * Closer hand = larger bbox = higher value.
     */
    _extractHandProximity(landmarks) {
        let minX = 1, maxX = 0, minY = 1, maxY = 0;

        for (const lm of landmarks) {
            if (!lm) continue;
            if (lm.x < minX) minX = lm.x;
            if (lm.x > maxX) maxX = lm.x;
            if (lm.y < minY) minY = lm.y;
            if (lm.y > maxY) maxY = lm.y;
        }

        const bboxArea = (maxX - minX) * (maxY - minY);
        // Normalize: ~0.005 (far) to ~0.1 (very close)
        const normalized = Math.max(0, Math.min(1, (bboxArea - 0.005) / 0.095));

        this.state.handProximity = this._smooth(this.state.handProximity, normalized);
    }

    /**
     * Hand position: palm center in normalized screen coordinates.
     */
    _extractHandPosition(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        if (!wrist || !middleMcp) return;

        const palmX = (wrist.x + middleMcp.x) / 2;
        const palmY = (wrist.y + middleMcp.y) / 2;

        this.state.handPositionX = this._smooth(this.state.handPositionX, Math.max(0, Math.min(1, palmX)));
        this.state.handPositionY = this._smooth(this.state.handPositionY, Math.max(0, Math.min(1, palmY)));
    }

    /**
     * Thumb extension: distance of thumb tip from palm center.
     * 0 = thumb tucked, 1 = fully extended.
     */
    _extractThumbExtension(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        const thumbTip = landmarks[this.LANDMARKS.THUMB_TIP];
        if (!wrist || !middleMcp || !thumbTip) return;

        const palmX = (wrist.x + middleMcp.x) / 2;
        const palmY = (wrist.y + middleMcp.y) / 2;

        const dx = thumbTip.x - palmX;
        const dy = thumbTip.y - palmY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Normalize: ~0.02 (tucked) to ~0.15 (extended)
        const normalized = Math.max(0, Math.min(1, (dist - 0.02) / 0.13));

        this.state.thumbExtension = this._smooth(this.state.thumbExtension, normalized);
    }

    /**
     * Thumbs-up / thumbs-down classification — geometry only, no extra model.
     * A clean thumb gesture = thumb extended + the other four fingers curled +
     * a clear vertical sign of the thumb tip relative to the palm. The hand must
     * ALSO be centered in frame and close to the camera (a deliberate, near-camera
     * placement) to count, which gates out incidental thumbs in the periphery.
     *
     * Must run AFTER _extractPerFingerCurl + _extractHandPosition/_extractHandProximity
     * (reads this.state.{index,middle,ring,pinky}Curl, thumbExtension, handPositionX/Y,
     * handProximity). Sets state.thumbDirection (+1/-1/0), thumbConfidence (0-1),
     * thumbCentered (bool). Up/down is mirror-invariant (vertical axis only).
     *
     * Live tuning: window.__thumbCurlMin (others-curled floor, def 0.55),
     *   __thumbExtMin (thumb-extended floor, def 0.45), __thumbVsep (min tip↔palm
     *   vertical separation, def 0.06), __thumbCenterR (max |pos-0.5| per axis,
     *   def 0.24), __thumbProxMin (min handProximity, def 0.22).
     */
    _extractThumbPose(landmarks) {
        const s = this.state;
        const thumbTip = landmarks[this.LANDMARKS.THUMB_TIP];
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        if (!thumbTip || !wrist || !middleMcp) {
            s.thumbDirection = 0; s.thumbConfidence = 0; s.thumbCentered = false;
            return;
        }

        const CURL_MIN = window.__thumbCurlMin ?? 0.55;
        const EXT_MIN  = window.__thumbExtMin  ?? 0.45;
        const VSEP_MIN = window.__thumbVsep    ?? 0.06;
        const CENTER_R = window.__thumbCenterR ?? 0.24;
        const PROX_MIN = window.__thumbProxMin ?? 0.22;

        // Other four fingers curled (thumb excluded). The WEAKEST finger gates, so a
        // single uncurled finger disqualifies (an open/spread hand ≠ thumbs gesture).
        const othersCurl = Math.min(s.indexCurl, s.middleCurl, s.ringCurl, s.pinkyCurl);
        const thumbExt = s.thumbExtension;

        // Vertical sign: image y increases DOWNWARD, so tip ABOVE the palm ⇒ thumb up.
        const palmY = (wrist.y + middleMcp.y) / 2;
        const vsep = palmY - thumbTip.y;            // +ve ⇒ tip above palm ⇒ up
        let direction = (Math.abs(vsep) >= VSEP_MIN) ? (vsep > 0 ? 1 : -1) : 0;

        // Deliberate placement: centered in frame AND close to the camera.
        const centered =
            Math.abs(s.handPositionX - 0.5) < CENTER_R &&
            Math.abs(s.handPositionY - 0.5) < CENTER_R &&
            s.handProximity > PROX_MIN;

        // Confidence blends how-extended the thumb is, how-curled the others are, and
        // how vertically unambiguous the thumb is. Pose must clear all three floors.
        let conf = 0;
        if (direction !== 0 && thumbExt >= EXT_MIN && othersCurl >= CURL_MIN) {
            const extScore  = Math.min(1, (thumbExt - EXT_MIN) / Math.max(1e-3, 1 - EXT_MIN));
            const curlScore = Math.min(1, (othersCurl - CURL_MIN) / Math.max(1e-3, 1 - CURL_MIN));
            const sepScore  = Math.min(1, (Math.abs(vsep) - VSEP_MIN) / 0.12);
            conf = Math.min(1, 0.34 * extScore + 0.40 * curlScore + 0.26 * sepScore);
        } else {
            direction = 0;
        }

        s.thumbDirection = direction;
        s.thumbConfidence = conf;
        s.thumbCentered = centered;
    }

    /**
     * Calculate RMS fingertip velocity for a given hand.
     * Uses position history for smooth velocity estimation.
     */
    _calcFingerVelocity(landmarks, handIdx) {
        const prev = this._prevFingerPositions[handIdx];
        if (!prev) {
            // Store current positions for next frame
            this._prevFingerPositions[handIdx] = this._fingertipIndices.map(i => ({
                x: landmarks[i]?.x || 0,
                y: landmarks[i]?.y || 0
            }));
            return 0;
        }

        let sumSq = 0;
        let count = 0;
        const current = [];

        for (let i = 0; i < this._fingertipIndices.length; i++) {
            const tip = landmarks[this._fingertipIndices[i]];
            if (!tip || !prev[i]) continue;

            const dx = tip.x - prev[i].x;
            const dy = tip.y - prev[i].y;
            const distSq = dx * dx + dy * dy;
            sumSq += distSq;
            count++;
            current.push({ x: tip.x, y: tip.y });

            // Per-finger velocity (0-1, same scale as aggregate)
            const perVel = Math.min(1, Math.sqrt(distSq) / 0.05);
            this.state[this._velKeys[i]] = this._smooth(this.state[this._velKeys[i]], perVel);
        }

        this._prevFingerPositions[handIdx] = current.length > 0 ? current : prev;

        if (count === 0) return 0;

        // RMS velocity, scaled to 0-1 range (typical max ~0.05 per frame)
        const rms = Math.sqrt(sumSq / count);
        return Math.min(1, rms / 0.05);
    }

    /**
     * Two-hand distance: wrist-to-wrist distance, normalized.
     */
    _extractTwoHandDistance(hand0, hand1) {
        const w0 = hand0[this.LANDMARKS.WRIST];
        const w1 = hand1[this.LANDMARKS.WRIST];
        if (!w0 || !w1) return;

        const dx = w1.x - w0.x;
        const dy = w1.y - w0.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Normalize: 0 (hands together) to 1 (screen width apart)
        const normalized = Math.max(0, Math.min(1, dist));

        this.state.twoHandDistance = this._smooth(this.state.twoHandDistance, normalized);
    }

    // ─────────────────────────────────────────────────────────────
    // PER-FINGER SIGNALS
    // ─────────────────────────────────────────────────────────────

    /**
     * Per-finger curl: ratio of (tip-to-base distance) / (sum of bone lengths).
     * 0 = fully extended, 1 = fully curled.
     * Uses all 21 landmarks — unlocks PIP/DIP joints not used elsewhere.
     */
    _extractPerFingerCurl(landmarks) {
        for (let f = 0; f < this._fingerChains.length; f++) {
            const chain = this._fingerChains[f];
            const joints = chain.map(idx => landmarks[idx]);
            if (joints.some(j => !j)) continue;

            // Sum of bone lengths along the chain
            let boneLength = 0;
            for (let i = 0; i < joints.length - 1; i++) {
                const dx = joints[i + 1].x - joints[i].x;
                const dy = joints[i + 1].y - joints[i].y;
                boneLength += Math.sqrt(dx * dx + dy * dy);
            }

            if (boneLength < 0.001) continue;

            // Direct distance from base to tip
            const base = joints[0];
            const tip = joints[joints.length - 1];
            const directDist = Math.sqrt(
                (tip.x - base.x) ** 2 + (tip.y - base.y) ** 2
            );

            // curl = 1 when tip is close to base (curled), 0 when extended
            const curl = 1 - Math.max(0, Math.min(1, directDist / boneLength));
            this.state[this._curlKeys[f]] = this._smooth(this.state[this._curlKeys[f]], curl);
        }
    }

    /**
     * Per-finger extension: tip distance from palm center, normalized.
     * Same computation as thumbExtension but for index through pinky.
     */
    _extractPerFingerExtension(landmarks) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        const middleMcp = landmarks[this.LANDMARKS.MIDDLE_MCP];
        if (!wrist || !middleMcp) return;

        const palmX = (wrist.x + middleMcp.x) / 2;
        const palmY = (wrist.y + middleMcp.y) / 2;

        // Skip thumb (index 0) — already has thumbExtension
        for (let f = 1; f < this._fingertipIndices.length; f++) {
            const tip = landmarks[this._fingertipIndices[f]];
            if (!tip) continue;

            const dx = tip.x - palmX;
            const dy = tip.y - palmY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const normalized = Math.max(0, Math.min(1, (dist - 0.02) / 0.13));

            const key = this._extKeys[f];
            if (key) {
                this.state[key] = this._smooth(this.state[key], normalized);
            }
        }
    }

    /**
     * Derived inter-finger signals computed from per-finger curls and velocities.
     */
    _extractDerivedSignals() {
        const curls = [
            this.state.thumbCurl,
            this.state.indexCurl,
            this.state.middleCurl,
            this.state.ringCurl,
            this.state.pinkyCurl
        ];

        // fingerWave: how different are sequential finger curls?
        // High when fingers are at different curl stages (wave/roll), low when sync.
        const sequentialCurls = curls.slice(1); // index through pinky (sequential neighbors)
        let maxCurl = -Infinity, minCurl = Infinity;
        for (const c of sequentialCurls) {
            if (c > maxCurl) maxCurl = c;
            if (c < minCurl) minCurl = c;
        }
        const wave = Math.max(0, Math.min(1, maxCurl - minCurl));
        this.state.fingerWave = this._smooth(this.state.fingerWave, wave);

        // curlVariance: statistical variance across all 5 fingers (0-0.25 range → normalize to 0-1)
        const mean = (curls[0] + curls[1] + curls[2] + curls[3] + curls[4]) / 5;
        let sumSq = 0;
        for (const c of curls) sumSq += (c - mean) * (c - mean);
        const variance = sumSq / 5;
        // Max variance when one finger is 1 and rest are 0 → 0.16; normalize by 0.2 for headroom
        this.state.curlVariance = this._smooth(this.state.curlVariance, Math.min(1, variance / 0.2));

        // dominantFinger: which finger has highest velocity? (0=thumb..4=pinky, normalized to 0-1)
        const vels = [
            this.state.thumbVelocity,
            this.state.indexVelocity,
            this.state.middleVelocity,
            this.state.ringVelocity,
            this.state.pinkyVelocity
        ];
        let maxIdx = 0;
        for (let i = 1; i < vels.length; i++) {
            if (vels[i] > vels[maxIdx]) maxIdx = i;
        }
        this.state.dominantFinger = this._smooth(this.state.dominantFinger, maxIdx / 4);
    }

    /**
     * Update per-hand position history for velocity calculation.
     */
    _updateHistory(landmarks, handIdx, now) {
        const wrist = landmarks[this.LANDMARKS.WRIST];
        if (!wrist) return;

        const history = this._handHistories[handIdx];
        history.push({
            x: wrist.x, y: wrist.y, t: now,
            tips: this._fingertipIndices.map(i => ({
                x: landmarks[i]?.x || 0,
                y: landmarks[i]?.y || 0
            }))
        });

        if (history.length > this._historyMaxLength) {
            history.shift();
        }
    }

    // ─────────────────────────────────────────────────────────────
    // DIRECT CONTROLS (Phase 3)
    // ─────────────────────────────────────────────────────────────

    /**
     * Apply direct hand controls. Detection logic stays here;
     * actions are delegated to callbacks injected via init().
     *
     * Callbacks (optional — standalone apps just don't pass them):
     *   onContinuousControl({ controls: [{param, value, source}], state })
     *   onGesture(gestureName, data)
     */
    _applyDirectControls(now) {
        const s = this.state;
        if (s.confidence < 0.3) return;

        // ── Continuous controls (detection + mapping) ──
        const controls = [];

        if (s.pinchStrength > 0.15) {
            const t = (s.pinchStrength - 0.15) / 0.85;
            controls.push({ param: 'postScale', value: 1.0 + t * 1.0, source: 'hand-pinch' });
        }

        if (Math.abs(s.palmFacing) > 0.1) {
            controls.push({ param: 'spiralTwistFactor', value: s.palmFacing * 0.5, source: 'hand-palm' });
        }

        if (s.handCount > 0) {
            const ampBoost = (1 - s.handPositionY) * 0.3;
            controls.push({ param: 'amp1', value: ampBoost, source: 'hand-height', additive: true });
        }

        if (s.fingerSpread > 0.1) {
            controls.push({ param: 'spiralPitch', value: s.fingerSpread * 2.0, source: 'hand-spread' });
        }

        if (s.handCount === 2 && s.twoHandDistance > 0.1) {
            controls.push({ param: 'postScale', value: 0.5 + s.twoHandDistance * 1.5, source: 'hand-two-spread' });
        }

        // Progressive confirmation cue for the thumbs-up/down gesture: as the dwell
        // charges, gently lean an existing visual param (up = in, down = out). Routed
        // through the same protected continuous-control path, so it eases back via the
        // smoother on release and doesn't writer-fight AE. Param/amount are tunable
        // (window.__thumbChargeParam default 'postScale', __thumbChargeAmp default 0.12).
        if (s.thumbCharge > 0.02 && s.thumbDirection !== 0) {
            const param = window.__thumbChargeParam || 'postScale';
            const amp = window.__thumbChargeAmp ?? 0.12;
            controls.push({ param, value: 1.0 + s.thumbDirection * s.thumbCharge * amp, source: 'thumb-charge' });
        }

        // Delegate continuous controls to handler
        if (controls.length > 0) {
            const handler = this._deps.onContinuousControl;
            if (handler) {
                handler({ controls, state: s });
            }
        }

        // ── Edge triggers (detection with cooldowns) ──

        if (s.fistClosure > 0.8 && now - this._lastFistTime > this._edgeCooldownMs) {
            this._lastFistTime = now;
            this._deps.onGesture?.('fist', { closure: s.fistClosure });
        }

        const spreadRate = s.fingerSpread - this._prevSpreadForFlash;
        this._prevSpreadForFlash = s.fingerSpread;
        if (spreadRate > 0.3 && now - this._lastPalmFlashTime > this._edgeCooldownMs) {
            this._lastPalmFlashTime = now;
            this._deps.onGesture?.('palmFlash', { spreadRate });
        }
    }

    /**
     * Set a visual parameter via setParam (unified parameter system).
     */
    _setParam(name, value, source) {
        if (!isFinite(value)) return;

        const setParam = this._dep('setParam');
        if (typeof setParam === 'function') {
            setParam(name, value, source);
        } else if (this._dep('audioUniforms')) {
            this._dep('audioUniforms')[name] = value;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // SYNTAX PULSES (Phase 4)
    // ─────────────────────────────────────────────────────────────

    /**
     * Emit motion pulses for the syntax learning system.
     * Finger velocity spikes, pinch/spread/fist edges → SyntaxPulseCollector.
     */
    _emitMotionPulses(now) {
        const collector = this._dep('pulseCollector');
        if (!collector?.recordPulse) return;

        const s = this.state;

        // Finger velocity spike
        if (s.fingerVelocity > 0.4) {
            collector.recordPulse('camera', 'hand-finger-velocity', s.fingerVelocity);
        }

        // Pinch edge (rapid increase in pinch strength)
        if (s.pinchDelta > 0.2) {
            collector.recordPulse('camera', 'hand-pinch-in', s.pinchStrength);
        } else if (s.pinchDelta < -0.2) {
            collector.recordPulse('camera', 'hand-pinch-out', 1 - s.pinchStrength);
        }

        // Spread edge
        if (s.spreadDelta > 0.15) {
            collector.recordPulse('camera', 'hand-spread-open', s.fingerSpread);
        } else if (s.spreadDelta < -0.15) {
            collector.recordPulse('camera', 'hand-spread-close', 1 - s.fingerSpread);
        }

        // Fist edge
        if (s.fistClosure > 0.8) {
            collector.recordPulse('camera', 'hand-fist', s.fistClosure);
        }
    }

    /**
     * Air-drum strike detection. Reads the dominant hand's wrist (landmark 0)
     * y-position per frame, computes RAW (un-EMA'd) downward velocity, and fires a
     * discrete 'strike' when a downward stroke peaks then decelerates/reverses
     * (the hit point at the bottom). Intensity scales with peak velocity. This is
     * the percussive counterpart to the smoothed continuous gestures, which can't
     * resolve a <80ms strike transient.
     *
     * Only downward motion counts (a wiggle or upward recovery won't fire), and a
     * cooldown debounces double-hits. Emits: a 'hand-strike' input pulse (engagement)
     * + an onGesture('strike', {intensity, hand, peakVelocity}) the host maps to a
     * visual hit. Tuning (live): window.__handStrikeThresh (min peak down-vel/frame,
     * def 0.018), __handStrikeScale (vel→intensity divisor, def 0.06),
     * __handStrikeCooldownMs (min inter-strike gap ms, def 110).
     */
    _detectStrike(landmarks, handIdx, now) {
        const wrist = landmarks && landmarks[0];  // MediaPipe Hands: 0 = wrist
        if (!wrist || typeof wrist.y !== 'number') { this._strikePrevWristY = null; return; }

        const y = wrist.y;  // normalized [0,1], increases DOWNWARD
        if (this._strikePrevWristY == null) { this._strikePrevWristY = y; return; }

        const vy = y - this._strikePrevWristY;  // +ve = moving down
        this._strikePrevWristY = y;

        const THRESH = window.__handStrikeThresh ?? 0.018;
        const SCALE = window.__handStrikeScale ?? 0.06;
        const COOLDOWN = window.__handStrikeCooldownMs ?? 110;

        if (vy > THRESH) {
            // Descending fast — track the peak downward velocity.
            this._strikeDescending = true;
            if (vy > this._strikePeakVy) this._strikePeakVy = vy;
        } else if (this._strikeDescending) {
            // Decelerated/reversed after a qualifying descent → the hit point.
            const peak = this._strikePeakVy;
            this._strikeDescending = false;
            this._strikePeakVy = 0;
            if (peak >= THRESH && (now - this._lastStrikeTime) >= COOLDOWN) {
                this._lastStrikeTime = now;
                const intensity = Math.min(1, peak / SCALE);
                this.state.lastStrike = { intensity: +intensity.toFixed(3), hand: handIdx, t: now };
                this.state.strikeCount = (this.state.strikeCount || 0) + 1;
                // Floor the strike-energy envelope at this hit's intensity (ungated by
                // confidence). Decayed each frame in _decayStrikeEnergy; consumed by the
                // engagement/reward loop. Flag: window.__strikeEnergyEnabled (0/false off).
                if (window.__strikeEnergyEnabled !== false) {
                    this.state.strikeEnergy = Math.max(this.state.strikeEnergy || 0, intensity);
                }
                // minIntervalMs:0 — strikes are already debounced (COOLDOWN ~110ms),
                // so log every one (the default 1000ms transition throttle would hide
                // most hits during drumming).
                this._dep('debugManager')?.logTransition?.('hand', 'strike', { intensity: +intensity.toFixed(2), hand: handIdx, count: this.state.strikeCount }, { minIntervalMs: 0 });
                // Input-rhythm pulse (same path as keyboard/scroll pulses → engagement).
                this._dep('pulseCollector')?.recordPulse?.('camera', 'hand-strike', intensity);
                // Discrete visual hit — host maps this (Psychodeli → SkewEvolution.beatPulse).
                this._deps.onGesture?.('strike', { intensity, hand: handIdx, peakVelocity: +peak.toFixed(4) });
            }
        }
    }

    /**
     * Decay the strike-energy envelope toward 0, time-based (frame-rate independent)
     * so it holds up under steady drumming and falls off ~1-2s after you stop. Runs
     * every frame (incl. no-hands frames). Tunable: window.__strikeEnergyTau (seconds,
     * default 1.0 → ~37% per τ).
     */
    _decayStrikeEnergy(now) {
        if (!(this.state.strikeEnergy > 0)) { this._strikeEnergyLastT = now; return; }
        const last = this._strikeEnergyLastT || now;
        const dt = Math.max(0, (now - last) / 1000);
        this._strikeEnergyLastT = now;
        const tau = Math.max(0.05, window.__strikeEnergyTau ?? 1.0);
        this.state.strikeEnergy *= Math.exp(-dt / tau);
        if (this.state.strikeEnergy < 0.01) this.state.strikeEnergy = 0;
    }

    /**
     * Advance the thumbs-up/down dwell charge. A valid pose (direction set, centered,
     * confidence ≥ __thumbConfMin, hand confidently tracked) builds thumbCharge 0→1
     * over ~__thumbChargeSec seconds; anything else decays it (τ = __thumbChargeTau).
     * At full charge it fires onGesture('thumbConfirm', {direction}) ONCE and latches
     * — the user must release the pose (active→false) before another confirm arms,
     * so a sustained hold records exactly one reaction. Time-based (uses dt), so the
     * 3.3Hz overlay rate and 20fps dedicated rate behave the same.
     *
     * Live tuning: window.__thumbGestureEnabled (false disables), __thumbChargeSec
     *   (build seconds to confirm, def 1.2), __thumbChargeTau (release decay seconds,
     *   def 0.4), __thumbConfMin (min thumbConfidence to build, def 0.6).
     */
    _updateThumbCharge(now) {
        const s = this.state;
        const last = this._thumbChargeLastT || now;
        const dt = Math.max(0, Math.min(0.25, (now - last) / 1000)); // clamp long gaps/tab-blur
        this._thumbChargeLastT = now;

        if (window.__thumbGestureEnabled === false) { s.thumbCharge = 0; this._thumbLatched = false; return; }

        const CONF_MIN = window.__thumbConfMin ?? 0.6;
        const active = s.thumbDirection !== 0 && s.thumbCentered &&
                       s.thumbConfidence >= CONF_MIN && s.confidence > 0.3;

        if (active && !this._thumbLatched) {
            const sec = Math.max(0.2, window.__thumbChargeSec ?? 1.2);
            s.thumbCharge = Math.min(1, (s.thumbCharge || 0) + dt / sec);

            if (s.thumbCharge >= 1 && (now - this._lastThumbConfirmTime) >= this._thumbConfirmCooldownMs) {
                this._lastThumbConfirmTime = now;
                this._thumbLatched = true;          // require a release before next confirm
                const direction = s.thumbDirection;
                s.thumbCharge = 0;                  // drop the visual lean at the moment of commit
                this._dep('debugManager')?.logTransition?.('hand', 'thumb-confirm',
                    { direction, confidence: +s.thumbConfidence.toFixed(2) }, { minIntervalMs: 0 });
                this._deps.onGesture?.('thumbConfirm', { direction, confidence: s.thumbConfidence });
            }
        } else {
            const tau = Math.max(0.05, window.__thumbChargeTau ?? 0.4);
            s.thumbCharge = (s.thumbCharge || 0) * Math.exp(-dt / tau);
            if (s.thumbCharge < 0.01) s.thumbCharge = 0;
            if (!active) this._thumbLatched = false; // pose released → re-arm
        }
    }

    // ─────────────────────────────────────────────────────────────
    // UTILITIES
    // ─────────────────────────────────────────────────────────────

    /**
     * EMA smoothing helper.
     */
    _smooth(prev, current) {
        if (!isFinite(current)) return prev;
        if (!isFinite(prev)) return current;
        return prev * this._ema + current * (1 - this._ema);
    }

    /**
     * Zero all state values.
     */
    _zeroState() {
        this.state.fingerSpread = 0;
        this.state.pinchDistance = 1;
        this.state.pinchStrength = 0;
        this.state.fistClosure = 0;
        this.state.palmFacing = 0;
        this.state.wristAngle = 0;
        this.state.handProximity = 0;
        this.state.fingerVelocity = 0;
        this.state.handPositionX = 0.5;
        this.state.handPositionY = 0.5;
        this.state.thumbExtension = 0;
        this.state.thumbDirection = 0;
        this.state.thumbConfidence = 0;
        this.state.thumbCentered = false;
        this.state.thumbCharge = 0;
        this._thumbLatched = false;
        this.state.twoHandDistance = 0;
        this.state.handCount = 0;
        this.state.pinchDelta = 0;
        this.state.spreadDelta = 0;
        this.state.confidence = 0;

        // Per-finger signals
        this.state.thumbCurl = 0;
        this.state.indexCurl = 0;
        this.state.middleCurl = 0;
        this.state.ringCurl = 0;
        this.state.pinkyCurl = 0;
        this.state.thumbVelocity = 0;
        this.state.indexVelocity = 0;
        this.state.middleVelocity = 0;
        this.state.ringVelocity = 0;
        this.state.pinkyVelocity = 0;
        this.state.indexExtension = 0;
        this.state.middleExtension = 0;
        this.state.ringExtension = 0;
        this.state.pinkyExtension = 0;
        this.state.fingerWave = 0;
        this.state.curlVariance = 0;
        this.state.dominantFinger = 0;
        this.state.landmarks = null;
        this.state.landmarks2 = null;
    }

    /**
     * Broadcast state to global sync object.
     */
    _broadcastState() {
        // Publish via MotionBus
        window.MotionBus?.emit('handPose', { ...this.state });
    }

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
     * Show/hide overlay indicator (small hand icon, same pattern as head/body indicators).
     */
    _showIndicator(show) {
        let indicator = document.getElementById('hand-tracking-indicator');

        if (show) {
            if (!indicator) {
                const container = this._getOrCreateIndicatorContainer();
                indicator = document.createElement('div');
                indicator.id = 'hand-tracking-indicator';
                indicator.innerHTML = '🤚';
                indicator.style.cssText = `
                    font-size: 18px;
                    opacity: 0.8;
                    pointer-events: none;
                    transition: opacity 0.3s;
                    line-height: 1;
                `;
                indicator.title = 'Hand Tracking (Overlay)';
                container.appendChild(indicator);
            }
            indicator.style.opacity = '0.8';
        } else if (indicator) {
            indicator.style.opacity = '0';
            setTimeout(() => indicator?.remove(), 300);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // DEBUG (Phase 5)
    // ─────────────────────────────────────────────────────────────

    /**
     * Draw hand skeleton on debug canvas.
     * Enabled via ?handDebug=true URL param.
     */
    drawDebug(results) {
        if (!this._debugCanvas) {
            if (!new URLSearchParams(window.location.search).has('handDebug')) return;

            this._debugCanvas = document.createElement('canvas');
            this._debugCanvas.width = 320;
            this._debugCanvas.height = 240;
            this._debugCanvas.style.cssText = `
                position: fixed;
                bottom: 10px;
                right: 10px;
                width: 320px;
                height: 240px;
                border: 1px solid rgba(78, 205, 196, 0.5);
                border-radius: 8px;
                z-index: 10000;
                background: rgba(0, 0, 0, 0.7);
                pointer-events: none;
            `;
            document.body.appendChild(this._debugCanvas);
            this._debugCtx = this._debugCanvas.getContext('2d');
        }

        const ctx = this._debugCtx;
        const w = this._debugCanvas.width;
        const h = this._debugCanvas.height;
        ctx.clearRect(0, 0, w, h);

        if (!results?.multiHandLandmarks) return;

        const colors = ['#4ecdc4', '#ff6b6b'];

        for (let hi = 0; hi < results.multiHandLandmarks.length; hi++) {
            const landmarks = results.multiHandLandmarks[hi];
            const color = colors[hi % colors.length];

            // Draw connections
            const connections = [
                [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
                [0, 5], [5, 6], [6, 7], [7, 8],       // Index
                [0, 9], [9, 10], [10, 11], [11, 12],   // Middle
                [0, 13], [13, 14], [14, 15], [15, 16], // Ring
                [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
                [5, 9], [9, 13], [13, 17]              // Palm
            ];

            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            for (const [a, b] of connections) {
                if (!landmarks[a] || !landmarks[b]) continue;
                ctx.beginPath();
                ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
                ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
                ctx.stroke();
            }

            // Draw points
            ctx.fillStyle = color;
            for (const lm of landmarks) {
                if (!lm) continue;
                ctx.beginPath();
                ctx.arc(lm.x * w, lm.y * h, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Draw signal values as text overlay
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        const s = this.state;
        const lines = [
            `pinch: ${s.pinchStrength.toFixed(2)}  spread: ${s.fingerSpread.toFixed(2)}`,
            `fist: ${s.fistClosure.toFixed(2)}  palm: ${s.palmFacing.toFixed(2)}`,
            `vel: ${s.fingerVelocity.toFixed(2)}  prox: ${s.handProximity.toFixed(2)}`,
            `hands: ${s.handCount}  conf: ${s.confidence.toFixed(2)}`
        ];
        lines.forEach((line, i) => {
            ctx.fillText(line, 5, 12 + i * 13);
        });
    }
}

// Global singleton
window.HandPoseDetector = new HandPoseDetector();
