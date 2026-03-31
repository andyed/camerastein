/**
 * Mouth tracking methods for HeadBobDetector
 * Separated for clarity - these methods are added to HeadBobDetector prototype
 */

/**
 * Update mouth state from facial landmarks
 * Calculates MAR (Mouth Aspect Ratio) and detects singing vs speaking
 */
HeadBobDetector.prototype._updateMouthState = function(landmarks, now) {
    try {
        const upperLip = landmarks[this.LANDMARKS.MOUTH_UPPER];
        const lowerLip = landmarks[this.LANDMARKS.MOUTH_LOWER];
        const leftCorner = landmarks[this.LANDMARKS.MOUTH_LEFT];
        const rightCorner = landmarks[this.LANDMARKS.MOUTH_RIGHT];

        if (!upperLip || !lowerLip || !leftCorner || !rightCorner) return;

        // Calculate mouth dimensions
        const mouthHeight = Math.sqrt(
            Math.pow(lowerLip.x - upperLip.x, 2) +
            Math.pow(lowerLip.y - upperLip.y, 2)
        );
        const mouthWidth = Math.sqrt(
            Math.pow(rightCorner.x - leftCorner.x, 2) +
            Math.pow(rightCorner.y - leftCorner.y, 2)
        );

        // Mouth Aspect Ratio (MAR) - similar to EAR for eyes
        const MAR = mouthWidth > 0 ? mouthHeight / mouthWidth : 0;
        
        // Normalize to 0-1 range (typical MAR range is 0-0.8)
        const openness = Math.min(1.0, MAR / 0.8);

        // Track MAR history for activity detection
        this.mouthHistory.push({ MAR, openness, t: now });
        if (this.mouthHistory.length > this.mouthHistoryMaxLength) {
            this.mouthHistory.shift();
        }

        // Calculate mouth activity (variance in recent MAR)
        let activity = 0;
        if (this.mouthHistory.length > 5) {
            const recentMARs = this.mouthHistory.slice(-10).map(h => h.MAR);
            const mean = recentMARs.reduce((a, b) => a + b, 0) / recentMARs.length;
            const variance = recentMARs.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recentMARs.length;
            activity = Math.min(1.0, Math.sqrt(variance) * 10); // Scale variance to 0-1
        }

        // Detect singing vs speaking patterns
        // Singing: sustained openness with moderate activity
        // Speaking: rapid fluctuations with high activity
        const sustainedOpen = openness > 0.3 && activity < 0.5;
        const rapidFluctuation = activity > 0.6;

        // Check if vocal detector agrees (if available)
        const vocalDetector = window.vocalDetector;
        const vocalActive = vocalDetector?.getState?.()?.isActive || false;
        const vocalStyle = vocalDetector?.getState?.()?.vocalStyle;

        // Update state
        this.state.mouthAspectRatio = MAR;
        this.state.mouthOpenness = openness;
        this.state.mouthActivity = activity;
        
        // Singing detection: vocal detector confirmation OR mouth-only fallback
        // Fallback catches singing when mic permission isn't granted
        const vocalConfirmsSinging = vocalActive && vocalStyle === 'singing';
        const mouthOnlySinging = !vocalActive && sustainedOpen && openness > 0.45 && activity > 0.15 && activity < 0.45;
        this.state.isSinging = (sustainedOpen && vocalConfirmsSinging) || mouthOnlySinging;

        // Speaking detection: rapid mouth movement OR vocal detector says speech
        this.state.isSpeaking = !this.state.isSinging && (
            (rapidFluctuation && openness > 0.2) ||
            (vocalActive && vocalStyle === 'speech')
        );

        this._lastMouthMAR = MAR;

        // Smile/frown detection — mouth corner height relative to lip midline
        this._updateSmileValence(landmarks, now);

        // Broadcast via dedicated method (matches _broadcastRhythmSync pattern)
        this._broadcastMouthSync();
    } catch (err) {
        // Silently fail - mouth tracking is optional
        console.warn('Mouth tracking error:', err);
    }
};

/**
 * Smile/frown detection — valence signal paralleling left/right wink feedback.
 * Smile = positive feedback (like right wink), frown = negative (like left wink).
 * Uses mouth corner Y relative to upper/lower lip midline, normalized by face height.
 */
HeadBobDetector.prototype._updateSmileValence = function(landmarks, now) {
    const upperLip = landmarks[this.LANDMARKS.MOUTH_UPPER];
    const lowerLip = landmarks[this.LANDMARKS.MOUTH_LOWER];
    const leftCorner = landmarks[this.LANDMARKS.MOUTH_LEFT];
    const rightCorner = landmarks[this.LANDMARKS.MOUTH_RIGHT];
    const nose = landmarks[this.LANDMARKS.NOSE_TIP];
    const chin = landmarks[this.LANDMARKS.CHIN];

    if (!upperLip || !lowerLip || !leftCorner || !rightCorner || !nose || !chin) return;

    // Midline Y between upper and lower lip centers
    const lipMidY = (upperLip.y + lowerLip.y) / 2;

    // Average corner Y (lower Y = higher on screen in normalized coords,
    // but MediaPipe uses 0=top, 1=bottom, so corners ABOVE midline = smaller Y = smile)
    const avgCornerY = (leftCorner.y + rightCorner.y) / 2;

    // Raw smile signal: negative means corners are above midline (smile)
    // Normalize by face height for scale invariance
    const faceHeight = Math.abs(chin.y - nose.y) || 0.1;
    const rawValence = (lipMidY - avgCornerY) / faceHeight;

    // Scale to roughly -1..+1 (typical smile deflection is ~5-15% of face height)
    const scaled = Math.max(-1, Math.min(1, rawValence * 8));

    // Smooth with asymmetric alpha — fast onset (notice smile quickly), slow release
    const prev = this._smileValence || 0;
    const alpha = Math.abs(scaled) > Math.abs(prev) ? 0.25 : 0.08;
    this._smileValence = prev + (scaled - prev) * alpha;

    // Track history for sustained expression detection
    this._smileHistory.push(this._smileValence);
    if (this._smileHistory.length > this._smileHistoryMax) {
        this._smileHistory.shift();
    }

    // Update state for broadcast
    this.state.smileValence = this._smileValence;

    // Dispatch feedback if expression is sustained and clear
    // Requires: all recent samples agree on direction, minimum magnitude
    if (this._smileHistory.length >= 12) {
        const SMILE_THRESHOLD = 0.35;
        const FROWN_THRESHOLD = -0.3;
        const DEBOUNCE_MS = 3000; // One feedback per 3s (matches wink debounce spirit)

        if (now - this._lastSmileFeedback < DEBOUNCE_MS) return;

        const allSmiling = this._smileHistory.slice(-12).every(v => v > SMILE_THRESHOLD);
        const allFrowning = this._smileHistory.slice(-12).every(v => v < FROWN_THRESHOLD);

        if (allSmiling) {
            this._lastSmileFeedback = now;
            console.log(`😊 Smile feedback: valence ${this._smileValence.toFixed(2)}`);
            if (window.AlgorithmicExploration?.handleBlinkFeedback) {
                window.AlgorithmicExploration.handleBlinkFeedback('right'); // positive, like right wink
            }
        } else if (allFrowning) {
            this._lastSmileFeedback = now;
            console.log(`😟 Frown feedback: valence ${this._smileValence.toFixed(2)}`);
            if (window.AlgorithmicExploration?.handleBlinkFeedback) {
                window.AlgorithmicExploration.handleBlinkFeedback('left'); // negative, like left wink
            }
        }
    }
};

/**
 * Broadcast mouth state to window.mouthSync (matches _broadcastRhythmSync pattern)
 */
HeadBobDetector.prototype._broadcastMouthSync = function() {
    // Expose for AE/Q-learning systems via window
    window.mouthSync = {
        MAR: this.state.mouthAspectRatio,
        openness: this.state.mouthOpenness,
        activity: this.state.mouthActivity,
        isSinging: this.state.isSinging,
        isSpeaking: this.state.isSpeaking,
        smileValence: this.state.smileValence || 0,
        timestamp: performance.now()
    };

    // Also dispatch event for systems that prefer events
    window.dispatchEvent(new CustomEvent('mouth-sync', {
        detail: window.mouthSync
    }));
};

/**
 * Get mouth state for external systems (AE, Q-learning)
 */
HeadBobDetector.prototype.getMouthState = function() {
    return {
        MAR: this.state.mouthAspectRatio,
        openness: this.state.mouthOpenness,
        activity: this.state.mouthActivity,
        isSinging: this.state.isSinging,
        isSpeaking: this.state.isSpeaking,
        smileValence: this.state.smileValence || 0
    };
};
