/**
 * Body Motion Detector
 *
 * Full-body motion detection via MediaPipe Pose for rich AE signals.
 * Tracks shoulder sway, bounce, arm spread/height, torso lean, and overall energy.
 *
 * Uses SharedCameraManager for instant switching with HeadBobDetector.
 * Both models stay loaded (~7MB total) for seamless mode changes.
 *
 * Mutually exclusive with head tracking (&) - activated via * key (Shift+8).
 *
 * @see docs/BODY_MOTION_SPEC.md
 */

class BodyMotionDetector {
    constructor() {
        this.enabled = false;
        this.active = false;
        // Video/camera managed by SharedCameraManager for instant mode switching

        // MediaPipe Pose landmark indices
        this.LANDMARKS = {
            NOSE: 0,
            LEFT_SHOULDER: 11,
            RIGHT_SHOULDER: 12,
            LEFT_ELBOW: 13,
            RIGHT_ELBOW: 14,
            LEFT_WRIST: 15,
            RIGHT_WRIST: 16,
            LEFT_HIP: 23,
            RIGHT_HIP: 24,

            // Mouth landmarks from Pose model (coarse — HeadBobDetector has finer FaceMesh-based mouth tracking)
            MOUTH_LEFT: 9,
            MOUTH_RIGHT: 10
        };

        // Per-body tracking state
        this.bodyStates = [];
        this.maxBodies = 4;
        this.historyMaxLength = 60;  // ~2 seconds at 30fps

        // Aggregate state (across all bodies)
        this.state = {
            // Sway (lateral)
            swayAmplitude: 0,
            swayFrequency: 0,
            swayPhase: 0,
            swayPosition: 0,

            // Bounce (vertical)
            bounceAmplitude: 0,
            bounceFrequency: 0,
            bouncePhase: 0,
            bouncePosition: 0,

            // Arms
            armSpread: 1,           // Normalized by shoulder width
            armHeight: 0,           // -1 (down) to 1 (raised)
            armsRaised: false,

            // Independent Arms (position relative to shoulder, normalized)
            leftArm: { x: 0, y: 0, vel: 0 },
            rightArm: { x: 0, y: 0, vel: 0 },

            // Torso
            torsoLean: 0,           // -1 (forward) to 1 (back)

            // Asymmetry
            asymmetry: 0,           // -1 (left dominant) to 1 (right dominant)

            // Energy
            energyLevel: 0,

            // Beat sync
            beatSyncScore: 0,
            isEngaged: false,

            // Multi-body
            bodyCount: 0,
            syncedBodies: 0,

            // Classification
            movementStyle: 'still',  // still, ambient, groovy, bouncy, expressive

            confidence: 0,

            // Velocity signals for responsive visual feedback
            swayVelocity: 0,         // Rate of change of sway position
            bounceVelocity: 0,       // Rate of change of bounce position
            wristVelocity: 0,        // Speed of hand movement (for dance/arm activity detection)
            elbowVelocity: 0,        // Speed of elbow movement (to distinguish typing vs dancing)
            armActivity: 0,          // 0-1 continuous arm movement intensity
            energyDelta: 0,          // Rate of change of energy (acceleration)

            // Posture detection for auto-switch
            isSitting: false,        // True if user appears to be sitting (desk mode)
            hipsVisible: false,      // Whether hips are in frame
            faceToBodyRatio: 0       // Higher = face closer = sitting
        };

        // Configuration
        this.config = {
            targetFPS: 20,
            minConfidence: 0.5,
            engagementThreshold: 0.5,
            cooldownMs: 500,
            // Sensitivity multiplier: scales velocity/energy signals before they reach AE
            // Low=0.7 (filters jitter, fewer false triggers), Normal=1.0, High=1.5 (amplifies subtle movements)
            sensitivityMultiplier: parseFloat(localStorage.getItem('psychodeli-motion-sensitivity') || '1.0')
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
     * Start body motion detection
     * Uses SharedCameraManager for instant switching with head tracking.
     */
    async start() {
        if (this.active) return;

        // Stop head bob detector if active (updates its state/indicator)
        if (this._dep('headDetector')?.active) {
            this._dep('debugManager')?.info?.('🔄 Stopping head tracking for body mode');
            this._dep('headDetector').stop();
        }

        this._dep('debugManager')?.info?.('🕺 Starting Body Motion Detector...');

        try {
            if (!this._dep('cameraManager')) {
                throw new Error('SharedCameraManager not available');
            }

            // Use shared camera - this loads both models on first call
            await this._dep('cameraManager').startMode('body', this._onResults);

            this.active = true;
            this.enabled = true;

            this._dep('debugManager')?.info?.('✅ Body Motion Detector active');
            this._showIndicator(true);

        } catch (error) {
            this._dep('debugManager')?.warn?.('Failed to start Body Motion Detector:', error?.message || String(error));
            this.stop();
            throw error;
        }
    }

    /**
     * Stop body motion detection
     * Models stay loaded for instant switching to head mode.
     * @param {boolean} fullShutdown - If true, also stops SharedCameraManager
     */
    stop(fullShutdown = false) {
        if (!this.active) return;

        this._dep('debugManager')?.info?.('🛑 Stopping Body Motion Detector');

        this.active = false;
        this.enabled = false;

        if (this._dep('cameraManager')?.activeMode === 'body') {
            if (fullShutdown) {
                this._dep('cameraManager').shutdown();
            } else {
                this._dep('cameraManager').stopMode();
            }
        }

        this.bodyStates = [];
        this._swayHistory = null;
        this._bounceHistory = null;
        window.MotionBus?.emit('bodyMotion', null);

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

    /**
     * Set motion sensitivity level.
     * @param {'low'|'normal'|'high'} level - Preset name or numeric multiplier
     */
    setSensitivity(level) {
        const presets = { low: 0.7, normal: 1.0, high: 1.5 };
        const multiplier = typeof level === 'number' ? level : (presets[level] || 1.0);
        this.config.sensitivityMultiplier = multiplier;
        localStorage.setItem('psychodeli-motion-sensitivity', String(multiplier));
        this._dep('debugManager')?.info?.(`🎛️ Motion sensitivity: ${level} (${multiplier}x)`);
    }

    // Frame processing now handled by SharedCameraManager

    /**
     * Handle MediaPipe Pose results
     */
    _onResults(results) {
        const now = performance.now();

        if (!results.poseLandmarks) {
            this.state.confidence = 0;
            this.state.bodyCount = 0;
            this.state.swayAmplitude = 0;
            this.state.swayFrequency = 0;
            this.state.swayPhase = 0;
            this.state.swayPosition = 0;
            this.state.bounceAmplitude = 0;
            this.state.bounceFrequency = 0;
            this.state.bouncePhase = 0;
            this.state.bouncePosition = 0;
            this.state.armSpread = 1;
            this.state.armHeight = 0;
            this.state.armsRaised = false;
            this.state.torsoLean = 0;
            this.state.asymmetry = 0;
            this.state.energyLevel = 0;
            this.state.energyDelta = 0;
            this.state.beatSyncScore = 0;
            this.state.isEngaged = false;
            this.state.syncedBodies = 0;
            this.state.movementStyle = 'still';
            this.state.swayVelocity = 0;
            this.state.bounceVelocity = 0;
            this.state.wristVelocity = 0;
            this.state.armActivity = 0;
            window.MotionBus?.emit('bodyMotion', null);
            // Report zero confidence for auto-switch consideration
            this._dep('cameraManager')?.reportConfidence(0);
            return;
        }

        // MediaPipe Pose returns single body, but we structure for future multi-body
        const landmarks = results.poseLandmarks;

        // Check visibility of key landmarks
        const shoulderVis = (landmarks[this.LANDMARKS.LEFT_SHOULDER].visibility +
            landmarks[this.LANDMARKS.RIGHT_SHOULDER].visibility) / 2;

        // HYSTERESIS: Prevent rapid toggling between 0 and 1 body count
        // Enter state (1) if confidence > 0.5
        // Exit state (0) if confidence < 0.35
        // This keeps the person "detected" even if confidence dips momentarily.
        const enterThreshold = this.config.minConfidence; // 0.5
        const exitThreshold = 0.35;

        const wasDetected = this.state.bodyCount > 0;
        const isDetected = wasDetected ? (shoulderVis > exitThreshold) : (shoulderVis > enterThreshold);

        if (!isDetected) {
            this.state.confidence = 0;
            this.state.bodyCount = 0;
            this.state.beatSyncScore = 0;
            this.state.isEngaged = false;
            this.state.syncedBodies = 0;
            this.state.energyLevel = 0;
            this.state.energyDelta = 0;
            this.state.swayVelocity = 0;
            this.state.bounceVelocity = 0;
            this.state.wristVelocity = 0;
            this.state.armActivity = 0;
            window.MotionBus?.emit('bodyMotion', null);
            // Report low confidence for auto-switch consideration
            this._dep('cameraManager')?.reportConfidence(shoulderVis);
            return;
        }

        this.state.confidence = shoulderVis;
        this.state.bodyCount = 1;

        // Extract signals
        this._extractShoulderSway(landmarks, now);
        this._extractShoulderBounce(landmarks, now);
        this._extractArmSignals(landmarks, now); // Pass now for velocity calculation
        this._detectGestures(landmarks);         // Detect gestures (T-Pose, Victory, Prayer)
        this._extractTorsoLean(landmarks);
        this._extractEnergy(landmarks, now);

        // Detect sitting posture (for auto-switch to head mode)
        this._detectSittingPosture(landmarks);

        // Calculate beat sync
        this._calculateBeatSync();

        // Classify movement style
        this._classifyMovementStyle();

        // Emit pulse if engaged
        if (this.state.isEngaged) {
            this._emitPulse(now);
        }

        // Broadcast for visual system
        this._broadcastBodyMotion();

        // Fire granular motion pulses for syntax system
        this._emitMotionPulses(now);

        // Report confidence for auto-switch consideration
        this._dep('cameraManager')?.reportConfidence(this.state.confidence);
    }

    /**
     * Extract shoulder sway (lateral movement)
     */
    _extractShoulderSway(landmarks, now) {
        const leftShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rightShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const midX = (leftShoulder.x + rightShoulder.x) / 2;

        // Initialize history if needed
        if (!this._swayHistory) this._swayHistory = [];

        this._swayHistory.push({ x: midX, t: now });
        if (this._swayHistory.length > this.historyMaxLength) {
            this._swayHistory.shift();
        }

        // Detect oscillation
        const osc = this._detectOscillation(this._swayHistory.map(h => h.x), this._swayHistory.map(h => h.t));
        if (osc) {
            this.state.swayAmplitude = osc.amplitude;
            this.state.swayFrequency = osc.frequency;
            this.state.swayPhase = osc.phase;
        }
        // Calculate velocity (rate of change)
        if (this._swayHistory.length >= 2) {
            const prev = this._swayHistory[this._swayHistory.length - 2];
            const dt = (now - prev.t) / 1000;
            if (dt > 0) {
                this.state.swayVelocity = (midX - prev.x) / dt;
            }
        }
        this.state.swayPosition = midX - 0.5; // Center around 0
    }

    /**
     * Extract shoulder bounce (vertical movement)
     */
    _extractShoulderBounce(landmarks, now) {
        const leftShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rightShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const midY = (leftShoulder.y + rightShoulder.y) / 2;

        if (!this._bounceHistory) this._bounceHistory = [];

        this._bounceHistory.push({ y: midY, t: now });
        if (this._bounceHistory.length > this.historyMaxLength) {
            this._bounceHistory.shift();
        }

        const osc = this._detectOscillation(this._bounceHistory.map(h => h.y), this._bounceHistory.map(h => h.t));
        if (osc) {
            this.state.bounceAmplitude = osc.amplitude;
            this.state.bounceFrequency = osc.frequency;
            this.state.bouncePhase = osc.phase;
        }
        // Calculate velocity (rate of change)
        if (this._bounceHistory.length >= 2) {
            const prev = this._bounceHistory[this._bounceHistory.length - 2];
            const dt = (now - prev.t) / 1000;
            if (dt > 0) {
                this.state.bounceVelocity = (midY - prev.y) / dt;
            }
        }
        this.state.bouncePosition = midY;
    }

    /**
     * Extract arm signals (spread, height, velocity)
     */
    _extractArmSignals(landmarks, now) {
        const leftShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rightShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const leftWrist = landmarks[this.LANDMARKS.LEFT_WRIST];
        const rightWrist = landmarks[this.LANDMARKS.RIGHT_WRIST];

        // Shoulder width for normalization
        const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);

        // Arm spread (wrist to wrist, normalized) - Keep logic simple
        if (leftWrist.visibility > 0.5 && rightWrist.visibility > 0.5) {
            const wristSpread = Math.abs(rightWrist.x - leftWrist.x);
            this.state.armSpread = wristSpread / Math.max(0.01, shoulderWidth);
        }

        // Arm height (how raised are arms)
        const leftArmHeight = leftShoulder.y - leftWrist.y;
        const rightArmHeight = rightShoulder.y - rightWrist.y;
        const avgHeight = (leftArmHeight + rightArmHeight) / 2;
        this.state.armHeight = Math.max(-1, Math.min(1, avgHeight * 3));

        // Arms raised = high overhead gesture (distinct from general arm activity)
        this.state.armsRaised = this.state.armHeight > 0.3;

        // Asymmetry
        this.state.asymmetry = (rightArmHeight - leftArmHeight) * 2;

        // --- WRIST VELOCITY TRACKING ---
        // Detect arm movement intensity for natural dance detection
        if (this._prevLandmarks && ((now - this._prevTime) > 0)) {
            const dt = (now - this._prevTime) / 1000;

            // Reset history if gap is too large (e.g. probe burst start)
            if (dt > 1.0) {
                this._prevLandmarks = landmarks;
                this._prevTime = now;
                return;
            }

            const lPrev = this._prevLandmarks[this.LANDMARKS.LEFT_WRIST];
            const rPrev = this._prevLandmarks[this.LANDMARKS.RIGHT_WRIST];

            if (leftWrist.visibility > 0.5 && rightWrist.visibility > 0.5 &&
                lPrev && rPrev) {

                const lDist = Math.hypot(leftWrist.x - lPrev.x, leftWrist.y - lPrev.y);
                const rDist = Math.hypot(rightWrist.x - rPrev.x, rightWrist.y - rPrev.y);

                // NOISE GATE: TYPING FILTER
                // Typing creates small, rapid movements. We only want to count arm activity
                // if the movement covers significant distance.
                // Sitting produces higher landmark jitter (closer to camera, more zoomed)
                // so we raise the gate significantly when sitting.
                // UPDATED: Increased thresholds to prevent typing from triggering body mode.
                const NOISE_THRESHOLD = this.state.isSitting ? 0.025 : 0.005;

                const lVel = lDist > NOISE_THRESHOLD ? lDist / dt : 0;
                const rVel = rDist > NOISE_THRESHOLD ? rDist / dt : 0;
                const rawVel = (lVel + rVel) / 2;

                // --- NEW: Elbow Velocity (to distinguish typing from dancing) ---
                const lElbow = landmarks[this.LANDMARKS.LEFT_ELBOW];
                const rElbow = landmarks[this.LANDMARKS.RIGHT_ELBOW];
                const lPrevElbow = this._prevLandmarks[this.LANDMARKS.LEFT_ELBOW];
                const rPrevElbow = this._prevLandmarks[this.LANDMARKS.RIGHT_ELBOW];

                let rawElbowVel = 0;
                if (lElbow && rElbow && lPrevElbow && rPrevElbow) {
                    const lElbowDist = Math.hypot(lElbow.x - lPrevElbow.x, lElbow.y - lPrevElbow.y);
                    const rElbowDist = Math.hypot(rElbow.x - rPrevElbow.x, rElbow.y - rPrevElbow.y);
                    const lElbowVel = lElbowDist > NOISE_THRESHOLD ? lElbowDist / dt : 0;
                    const rElbowVel = rElbowDist > NOISE_THRESHOLD ? rElbowDist / dt : 0;
                    rawElbowVel = (lElbowVel + rElbowVel) / 2;
                }

                // Smooth elbow velocity
                const elbowDecay = rawElbowVel < 0.01 ? 0.5 : 0.7;
                this.state.elbowVelocity = (this.state.elbowVelocity || 0) * elbowDecay + rawElbowVel * (1 - elbowDecay);

                // Calculate Vector Velocities for Synchrony detection
                const lVelX = (leftWrist.x - lPrev.x) / dt;
                const lVelY = (leftWrist.y - lPrev.y) / dt;
                const rVelX = (rightWrist.x - rPrev.x) / dt;
                const rVelY = (rightWrist.y - rPrev.y) / dt;

                // Synchrony: Are arms moving symmetrically?
                // We mirror Right Arm X (-rVelX) so that "Expansion" (L goes left, R goes right) becomes correlated.
                // 1.0 = Mirrored (symmetrical dance)
                // -1.0 = Parallel (windshield wiper)
                let sync = 0;
                // Only compute if moving significantly
                if (lVel > 0.05 && rVel > 0.05) {
                    const dot = (lVelX * -rVelX) + (lVelY * rVelY);
                    sync = dot / (lVel * rVel); // Normalize by magnitudes (which are lVel/rVel)
                }
                // Check NaN
                if (isNaN(sync)) sync = 0;

                // Smooth the sync signal
                this.state.armSync = (this.state.armSync || 0) * 0.8 + sync * 0.2;

                // Store independent arm state
                this.state.leftArm = {
                    x: (leftShoulder.x - leftWrist.x), // Relative X from shoulder (positive = left/out)
                    y: (leftShoulder.y - leftWrist.y) * 3, // Relative Y (positive = up)
                    vel: lVel
                };
                this.state.rightArm = {
                    x: (rightWrist.x - rightShoulder.x), // Relative X from shoulder (positive = right/out)
                    y: (rightShoulder.y - rightWrist.y) * 3, // Relative Y (positive = up)
                    vel: rVel
                };

                // Elbow positions (same relative-to-shoulder convention as wrists)
                const leftElbow = landmarks[this.LANDMARKS.LEFT_ELBOW];
                const rightElbow = landmarks[this.LANDMARKS.RIGHT_ELBOW];
                this.state.leftArm.elbowX = (leftShoulder.x - leftElbow.x);
                this.state.leftArm.elbowY = (leftShoulder.y - leftElbow.y) * 3;
                this.state.rightArm.elbowX = (rightElbow.x - rightShoulder.x);
                this.state.rightArm.elbowY = (rightShoulder.y - rightElbow.y) * 3;

                // Smooth global wrist velocity — decay faster when raw is near zero
                // so sitting-still noise doesn't accumulate into phantom velocity
                const decay = rawVel < 0.01 ? 0.5 : 0.7;
                this.state.wristVelocity = (this.state.wristVelocity || 0) * decay + rawVel * (1 - decay);

                // Continuous arm activity score (0-1) replaces boolean isConducting
                // Wrist velocity of 0.5 maps to 1.0 (full activity) usually,
                // but if Sitting, we dampen it significantly to ignore typing events.
                // Typing yields ~1.5 - 2.0 velocity bursts.
                const activityDivisor = this.state.isSitting ? 2.5 : 0.5;
                this.state.armActivity = Math.min(1, this.state.wristVelocity / activityDivisor);
            }
        }
    }

    /**
     * Detect specific semantic gestures
     */
    _detectGestures(landmarks) {
        const lShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const lWrist = landmarks[this.LANDMARKS.LEFT_WRIST];
        const rWrist = landmarks[this.LANDMARKS.RIGHT_WRIST];

        // Ensure visibility
        if (lWrist.visibility < 0.5 || rWrist.visibility < 0.5) {
            this.state.currentGesture = 'none';
            return;
        }

        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const shoulderDist = Math.abs(rShoulder.x - lShoulder.x) || 1;

        let gesture = 'none';

        // 1. Victory (Y-Shape): Wrists high above shoulders, spread
        // Normalized Y: 0 is top, 1 is bottom. Smaller Y = higher.
        if (lWrist.y < lShoulder.y - 0.15 && rWrist.y < rShoulder.y - 0.15) {
            const spread = Math.abs(rWrist.x - lWrist.x) / shoulderDist;
            if (spread > 1.2) gesture = 'victory';
        }

        // 2. T-Pose: Wrists at shoulder height, spread max
        else if (Math.abs(lWrist.y - lShoulder.y) < 0.15 && Math.abs(rWrist.y - rShoulder.y) < 0.15) {
            const spread = Math.abs(rWrist.x - lWrist.x) / shoulderDist;
            if (spread > 2.0) gesture = 't-pose';
        }

        // 3. Reach-Up: Both wrists well above head (higher than victory — full overhead reach)
        else if (lWrist.y < lShoulder.y - 0.3 && rWrist.y < rShoulder.y - 0.3) {
            const midWristY = (lWrist.y + rWrist.y) / 2;
            if (midWristY < shoulderY - 0.35) gesture = 'reach-up';
        }

        // 4. Prayer/Focus: Wrists close together at chest height
        else if (Math.abs(rWrist.x - lWrist.x) < shoulderDist * 0.4) {
            if (lWrist.y > shoulderY && lWrist.y < shoulderY + 0.6) {
                gesture = 'prayer';
            }
        }

        // 5. Wave: One wrist above shoulder with high individual velocity, other arm relatively still
        else if (this.state.leftArm && this.state.rightArm) {
            const lUp = lWrist.y < lShoulder.y - 0.05;
            const rUp = rWrist.y < rShoulder.y - 0.05;
            const lFast = this.state.leftArm.vel > 0.3;
            const rFast = this.state.rightArm.vel > 0.3;
            const lSlow = this.state.leftArm.vel < 0.15;
            const rSlow = this.state.rightArm.vel < 0.15;

            if ((lUp && lFast && rSlow) || (rUp && rFast && lSlow)) {
                gesture = 'wave';
            }
        }

        // 6. Cross-Arms: Wrists crossed past midline (left wrist right of center, right wrist left of center)
        if (gesture === 'none') {
            const midX = (lShoulder.x + rShoulder.x) / 2;
            // MediaPipe: left shoulder has smaller x (left side of image)
            // Cross = left wrist has moved right of center, right wrist left of center
            const lCrossed = lWrist.x > midX + shoulderDist * 0.15;
            const rCrossed = rWrist.x < midX - shoulderDist * 0.15;
            if (lCrossed && rCrossed && lWrist.y > shoulderY && lWrist.y < shoulderY + 0.4) {
                gesture = 'cross-arms';
            }
        }

        // 7. Lean-Point: One arm extended, other close to body, torso leaning in same direction
        if (gesture === 'none' && this.state.leftArm && this.state.rightArm) {
            const lExtended = Math.abs(this.state.leftArm.x) > 0.6 && this.state.leftArm.vel < 0.2;
            const rExtended = Math.abs(this.state.rightArm.x) > 0.6 && this.state.rightArm.vel < 0.2;
            const lTucked = Math.abs(this.state.leftArm.x) < 0.3;
            const rTucked = Math.abs(this.state.rightArm.x) < 0.3;
            const lean = this.state.torsoLean || 0;

            if (lExtended && rTucked && lean < -0.15) gesture = 'lean-point';
            else if (rExtended && lTucked && lean > 0.15) gesture = 'lean-point';
        }

        this.state.currentGesture = gesture;
    }

    /**
     * Extract torso lean
     */
    _extractTorsoLean(landmarks) {
        const leftShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rightShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const leftHip = landmarks[this.LANDMARKS.LEFT_HIP];
        const rightHip = landmarks[this.LANDMARKS.RIGHT_HIP];

        // Only calculate if hips visible
        if (leftHip.visibility > 0.3 && rightHip.visibility > 0.3) {
            const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
            const hipMidY = (leftHip.y + rightHip.y) / 2;
            const torsoLength = hipMidY - shoulderMidY;

            // Lean based on shoulder Z if available
            let rawLean = 0;
            if (leftShoulder.z !== undefined && rightShoulder.z !== undefined) {
                const shoulderZ = (leftShoulder.z + rightShoulder.z) / 2;
                rawLean = Math.max(-1, Math.min(1, shoulderZ * 5));
            } else {
                // Fallback: estimate lean from torso compression
                // When leaning forward, torso appears shorter in 2D projection
                const expectedTorsoLength = 0.35; // Typical normalized torso length
                const compressionRatio = torsoLength / expectedTorsoLength;
                // Shorter torso = leaning forward (negative), taller = leaning back (positive)
                rawLean = Math.max(-1, Math.min(1, (1 - compressionRatio) * 3));
            }

            // Apply Low-Pass Filter (Smoothing) to extract intentional posture from rhythmic bobbing
            const alpha = 0.08; // Slower adaptation (~0.5s) to ignore beat-sync bobs
            if (this._smoothedTorsoLean === undefined) this._smoothedTorsoLean = rawLean;
            this._smoothedTorsoLean = (this._smoothedTorsoLean * (1 - alpha)) + (rawLean * alpha);

            this.state.torsoLean = this._smoothedTorsoLean;
        }
    }

    /**
     * Extract overall energy
     */
    _extractEnergy(landmarks, now) {
        if (!this._prevLandmarks) {
            this._prevLandmarks = landmarks;
            this._prevTime = now;
            return;
        }

        const dt = (now - this._prevTime) / 1000;
        if (dt <= 0) return;

        // Sum velocity of upper body landmarks
        let totalVelocity = 0;
        const upperBodyIndices = [
            this.LANDMARKS.LEFT_SHOULDER, this.LANDMARKS.RIGHT_SHOULDER,
            this.LANDMARKS.LEFT_ELBOW, this.LANDMARKS.RIGHT_ELBOW,
            this.LANDMARKS.LEFT_WRIST, this.LANDMARKS.RIGHT_WRIST
        ];

        for (const idx of upperBodyIndices) {
            const curr = landmarks[idx];
            const prev = this._prevLandmarks[idx];
            if (curr.visibility > 0.3 && prev.visibility > 0.3) {
                const dx = curr.x - prev.x;
                const dy = curr.y - prev.y;
                totalVelocity += Math.sqrt(dx * dx + dy * dy) / dt;
            }
        }

        // Smooth energy and track delta (acceleration)
        const rawEnergy = Math.min(1, totalVelocity / 2);
        const prevEnergy = this.state.energyLevel;
        this.state.energyLevel = this.state.energyLevel * 0.8 + rawEnergy * 0.2;
        this.state.energyDelta = this.state.energyLevel - prevEnergy;

        this._prevLandmarks = landmarks;
        this._prevTime = now;
    }

    /**
     * Detect if user is sitting (desk mode) vs standing
     * Used for auto-switching to head mode when sitting
     */
    _detectSittingPosture(landmarks) {
        const nose = landmarks[this.LANDMARKS.NOSE];
        const leftShoulder = landmarks[this.LANDMARKS.LEFT_SHOULDER];
        const rightShoulder = landmarks[this.LANDMARKS.RIGHT_SHOULDER];
        const leftHip = landmarks[this.LANDMARKS.LEFT_HIP];
        const rightHip = landmarks[this.LANDMARKS.RIGHT_HIP];

        // Check if hips are visible (low visibility = sitting close to camera)
        const hipVisibility = (leftHip.visibility + rightHip.visibility) / 2;
        this.state.hipsVisible = hipVisibility > 0.5;

        // Calculate face-to-body ratio
        // When sitting at desk, face is large relative to shoulder width
        const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
        const noseToShoulderDist = Math.abs(nose.y - ((leftShoulder.y + rightShoulder.y) / 2));

        // Face-to-body ratio: smaller shoulder width + nose close to shoulders = sitting
        // Normalized: higher value = more likely sitting
        this.state.faceToBodyRatio = shoulderWidth > 0.01
            ? noseToShoulderDist / shoulderWidth
            : 0;

        // Sitting detection heuristics:
        // 1. Hips not visible (cropped out when sitting at desk)
        // 2. Shoulders in upper portion of frame (y < 0.4)
        // 3. Large shoulder width relative to frame (close to camera)
        // 4. Face large relative to shoulders (camera close)
        const shouldersMidY = (leftShoulder.y + rightShoulder.y) / 2;
        const shouldersHighInFrame = shouldersMidY < 0.5; // Relaxed from 0.4
        const shouldersWide = shoulderWidth > 0.2; // Relaxed from 0.25
        const faceProminent = this.state.faceToBodyRatio > 0.5;

        // Combine heuristics
        let sittingScore = 0;
        if (!this.state.hipsVisible) sittingScore += 0.4;
        if (shouldersHighInFrame) sittingScore += 0.2;
        if (shouldersWide) sittingScore += 0.4; // Strong indicator
        if (faceProminent) sittingScore += 0.3;

        // Threshold 0.5 means any two weak signals or one strong signal (Wide Shoulders + Hips)
        this.state.isSitting = sittingScore >= 0.5;

        // Log state changes
        if (this.state.isSitting && !this._wasSitting) {
            this._dep('debugManager')?.info?.('🪑 Sitting posture detected - head tracking may be better');
        } else if (!this.state.isSitting && this._wasSitting) {
            this._dep('debugManager')?.info?.('🧍 Standing posture detected - body tracking optimal');
        }
        this._wasSitting = this.state.isSitting;
    }

    /**
     * Detect oscillation in a signal
     */
    _detectOscillation(values, times) {
        if (values.length < 30) return null;

        // Find peaks and troughs
        const peaks = [];
        const troughs = [];

        for (let i = 2; i < values.length - 2; i++) {
            if (values[i] > values[i - 1] && values[i] > values[i + 1] &&
                values[i] > values[i - 2] && values[i] > values[i + 2]) {
                peaks.push(i);
            }
            if (values[i] < values[i - 1] && values[i] < values[i + 1] &&
                values[i] < values[i - 2] && values[i] < values[i + 2]) {
                troughs.push(i);
            }
        }

        if (peaks.length < 2 || troughs.length < 2) return null;

        // Frequency from peak timing
        const peakTimes = peaks.map(i => times[i]);
        let totalDelta = 0;
        for (let i = 1; i < peakTimes.length; i++) {
            totalDelta += peakTimes[i] - peakTimes[i - 1];
        }
        const avgPeriod = totalDelta / (peakTimes.length - 1);
        if (avgPeriod <= 0) return null;

        const frequency = 1000 / avgPeriod;

        // Amplitude
        const avgPeak = peaks.reduce((s, i) => s + values[i], 0) / peaks.length;
        const avgTrough = troughs.reduce((s, i) => s + values[i], 0) / troughs.length;
        const amplitude = Math.abs(avgPeak - avgTrough);

        // Phase
        const lastPeakIdx = peaks[peaks.length - 1];
        const framesSincePeak = values.length - 1 - lastPeakIdx;
        const framesPerCycle = avgPeriod / (1000 / this.config.targetFPS);
        const phase = (framesSincePeak / framesPerCycle) % 1;

        return { frequency, amplitude, phase };
    }

    /**
     * Calculate beat sync score
     */
    _calculateBeatSync() {
        const musicBPM = this._dep('audioBus')?.state?.bpm
            || this._dep('audioUniforms')?.bpm?.value
            || 120;
        const beatFreq = musicBPM / 60;

        // Check both sway and bounce against beat
        const subdivisions = [0.5, 1.0, 2.0];
        let bestSync = 0;

        for (const freq of [this.state.swayFrequency, this.state.bounceFrequency]) {
            if (freq <= 0) continue;
            for (const sub of subdivisions) {
                const targetFreq = beatFreq * sub;
                const ratio = freq / targetFreq;
                const deviation = Math.abs(ratio - 1.0);
                if (deviation < 0.2) {
                    const sync = 1.0 - (deviation / 0.2);
                    bestSync = Math.max(bestSync, sync);
                }
            }
        }

        this.state.beatSyncScore = bestSync;
        this.state.isEngaged = bestSync > this.config.engagementThreshold;
        this.state.syncedBodies = this.state.isEngaged ? 1 : 0;
    }

    /**
     * Classify movement style
     */
    _classifyMovementStyle() {
        const { swayAmplitude, bounceAmplitude, energyLevel, armSpread, armActivity } = this.state;

        if (energyLevel < 0.1) {
            this.state.movementStyle = 'still';
        } else if (energyLevel < 0.3) {
            this.state.movementStyle = 'ambient';
        } else if (swayAmplitude > bounceAmplitude * 1.5) {
            this.state.movementStyle = 'groovy';
        } else if (bounceAmplitude > swayAmplitude * 1.5) {
            this.state.movementStyle = 'bouncy';
        } else if (armSpread > 1.5 || this.state.armsRaised) {
            this.state.movementStyle = 'expressive';
        } else if (armActivity > 0.4) {
            this.state.movementStyle = 'groovy';
        } else {
            this.state.movementStyle = 'groovy';
        }
    }

    /**
     * Emit pulse to SyntaxPulseCollector
     */
    _emitPulse(now) {
        if (now - this.lastPulseTime < this.config.cooldownMs) return;

        if (this._dep('pulseCollector')) {
            this._dep('pulseCollector').recordPulse('camera', 'body-motion');
        }

        this.lastPulseTime = now;
        this._dep('debugManager')?.info?.(`🪩 Body motion synced! Style: ${this.state.movementStyle}, Sync: ${(this.state.beatSyncScore * 100).toFixed(0)}%`);
    }

    /**
     * Emit granular body motion pulses on significant movement events.
     * Separate from beat-sync pulses — these fire on velocity/gesture peaks
     * so the syntax system gets timing data for quick body gestures.
     */
    _emitMotionPulses(now) {
        if (!this._dep('pulseCollector')) return;
        if (!this._lastBodyMotionPulseTime) this._lastBodyMotionPulseTime = 0;

        // 100ms cooldown
        if (now - this._lastBodyMotionPulseTime < 100) return;

        const energy = this.state.energyLevel || 0;
        const delta = Math.abs(this.state.energyDelta || 0);
        const swayVel = Math.abs(this.state.swayVelocity || 0);
        const bounceVel = Math.abs(this.state.bounceVelocity || 0);
        const wristVel = this.state.wristVelocity || 0;

        // Arm burst pulses (Syntax Frequency Learning from Arms)
        // High wrist velocity -> Frequent pulses
        if (wristVel > 0.25) {
            this._dep('pulseCollector').recordPulse('camera', 'arm-burst');
            this._lastBodyMotionPulseTime = now;
            return;
        }

        // New Gesture Pulses
        if (this.state.currentGesture !== 'none' && this.state.currentGesture !== this._prevGesture) {
            this._dep('pulseCollector').recordPulse('camera', `gesture-${this.state.currentGesture}`);

            // Trigger Evolvable Action
            if (this._dep('motionMapper')) {
                this._dep('motionMapper').handleGesture(this.state.currentGesture);
            }

            this._lastBodyMotionPulseTime = now;
        }

        if (delta > 0.15) {
            this._dep('pulseCollector').recordPulse('camera', 'body-energy-spike');
            this._lastBodyMotionPulseTime = now;
        } else if (this.state.armsRaised && !this._prevArmsRaised) {
            this._dep('pulseCollector').recordPulse('camera', 'arms-raised');
            this._lastBodyMotionPulseTime = now;
        } else if (swayVel > 0.4) {
            this._dep('pulseCollector').recordPulse('camera', 'body-sway');
            this._lastBodyMotionPulseTime = now;
        } else if (bounceVel > 0.4) {
            this._dep('pulseCollector').recordPulse('camera', 'body-bounce');
            this._lastBodyMotionPulseTime = now;
        }

        this._prevArmsRaised = this.state.armsRaised;
        this._prevGesture = this.state.currentGesture;
    }

    /**
     * Broadcast body motion for visual system
     */
    _broadcastBodyMotion() {
        const sm = this.config.sensitivityMultiplier;

        const payload = {
            active: true,
            timestamp: performance.now(),

            // Sway (amplitude/velocity scaled, phase/position/frequency unchanged)
            swayAmplitude: this.state.swayAmplitude * sm,
            swayFrequency: this.state.swayFrequency,
            swayPhase: this.state.swayPhase,
            swayPosition: this.state.swayPosition,

            // Bounce (amplitude/velocity scaled)
            bounceAmplitude: this.state.bounceAmplitude * sm,
            bounceFrequency: this.state.bounceFrequency,
            bouncePhase: this.state.bouncePhase,
            bouncePosition: this.state.bouncePosition,

            // Arms (spread/height are positional, not scaled)
            armSpread: this.state.armSpread,
            armHeight: this.state.armHeight,
            armsRaised: this.state.armsRaised,

            // Torso
            torsoLean: this.state.torsoLean,

            // Other (energy scaled, asymmetry is positional)
            asymmetry: this.state.asymmetry,
            energyLevel: Math.min(1, this.state.energyLevel * sm),
            beatSyncScore: this.state.beatSyncScore,
            isEngaged: this.state.isEngaged,
            movementStyle: this.state.movementStyle,

            // Arm activity signals (velocity scaled)
            wristVelocity: this.state.wristVelocity * sm,
            armActivity: Math.min(1, this.state.armActivity * sm),
            armSync: this.state.armSync || 0,

            // Velocity signals (all scaled)
            swayVelocity: this.state.swayVelocity * sm,
            bounceVelocity: this.state.bounceVelocity * sm,
            energyDelta: this.state.energyDelta * sm,

            // Multi-body
            bodyCount: this.state.bodyCount,
            syncedBodies: this.state.syncedBodies
        };

        // Publish via MotionBus
        window.MotionBus?.emit('bodyMotion', payload);

        window.dispatchEvent(new CustomEvent('body-motion-sync', {
            detail: payload
        }));
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
     * Show/hide indicator
     */
    _showIndicator(show) {
        let indicator = document.getElementById('body-motion-indicator');

        if (show) {
            // Respect "disable visual toasts" preference
            if (window.toastsDisabled || localStorage.getItem('disableToasts') === 'true') return;

            if (!indicator) {
                const container = this._getOrCreateIndicatorContainer();
                indicator = document.createElement('div');
                indicator.id = 'body-motion-indicator';
                indicator.innerHTML = '📹';
                indicator.style.cssText = `
                    font-size: 18px;
                    opacity: 0.5;
                    cursor: pointer;
                    user-select: none;
                    transform-origin: center center;
                    line-height: 1;
                `;
                indicator.title = 'Body tracking active - click to disable';
                indicator.onclick = () => this.toggle();
                container.appendChild(indicator);
            }

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
     * Animate indicator based on state
     * 📹 grayscale - no body
     * 🧍 - body detected, still
     * 🕺 yellow - moving, not synced
     * 🪩 green - synced to beat
     */
    _animateIndicator() {
        if (!this.active) return;

        const indicator = document.getElementById('body-motion-indicator');
        if (!indicator) return;

        const now = performance.now();
        const hasBody = this.state.confidence > 0.3;
        const isMoving = this.state.energyLevel > 0.15;
        const isSynced = this.state.isEngaged;
        const bodyCount = this.state.bodyCount;

        // Multi-body indicator badge (0/2) suppressed until improved
        const badge = ''; // bodyCount > 1 ? `<sub>${this.state.syncedBodies}/${bodyCount}</sub>` : '';

        if (isSynced) {
            // Synced - disco ball, bounces with rhythm
            const bouncePeriod = 1000 / Math.max(0.5, this.state.bounceFrequency || 2);
            const phase = (now % bouncePeriod) / bouncePeriod;
            const bounce = Math.sin(phase * Math.PI * 2) * 0.15;

            indicator.style.transform = `scale(${1.1 + bounce}) translateY(${bounce * 8}px)`;
            indicator.style.opacity = '1';
            indicator.style.filter = 'hue-rotate(-60deg) saturate(1.5)';
            indicator.innerHTML = '🪩' + badge;
        } else if (isMoving) {
            // Moving but not synced - dancer, yellow
            const pulse = Math.sin(now / 200) * 0.1;
            indicator.style.transform = `scale(${1.05 + pulse})`;
            indicator.style.opacity = '0.9';
            indicator.style.filter = 'hue-rotate(30deg) saturate(1.3)';
            indicator.innerHTML = '🕺' + badge;
        } else if (hasBody) {
            // Body detected, still
            const pulse = Math.sin(now / 500) * 0.05;
            indicator.style.transform = `scale(${1 + pulse})`;
            indicator.style.opacity = '0.7';
            indicator.style.filter = 'none';
            indicator.innerHTML = (bodyCount > 1 ? '🧍‍🧍' : '🧍') + badge;
        } else {
            // No body
            const breath = Math.sin(now / 1000) * 0.03;
            indicator.style.transform = `scale(${1 + breath})`;
            indicator.style.opacity = '0.4';
            indicator.style.filter = 'grayscale(0.7)';
            indicator.innerHTML = '📹';
        }

        this._indicatorAnimationId = requestAnimationFrame(() => this._animateIndicator());
    }

    getState() {
        return { ...this.state };
    }
}

// Global singleton
window.BodyMotionDetector = new BodyMotionDetector();

// NOTE: & key registration moved to commands-extra.js (SharedCameraManager permission system)
