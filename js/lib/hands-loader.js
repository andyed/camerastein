/**
 * MediaPipe Hands Lazy Loader
 *
 * Loads MediaPipe Hands library on demand (~3MB) for hand tracking.
 * Unlike Head/Body which are mutually exclusive primary modes,
 * Hands is an OVERLAY mode — it runs concurrently with whichever
 * primary mode (head or body) is active, processing on alternating frames.
 *
 * Loaded lazily on first ^ key press to avoid upfront cost.
 *
 * Extends MediaPipeBaseLoader for shared CDN/init/timeout logic.
 *
 * @see docs/HAND_TRACKING_INTEGRATION_SPEC.md
 */

class HandsLoader extends MediaPipeBaseLoader {
    constructor() {
        // Detect mobile for lighter model
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        super({
            name: 'Hands',
            cdnPath: '@mediapipe/hands',
            scriptFile: 'hands.js',
            globalName: 'Hands',
            config: {
                maxNumHands: 2,
                modelComplexity: isMobile ? 0 : 1,  // 0=lite on mobile, 1=full on desktop
                minDetectionConfidence: window.__handMinDetection ?? 0.5,
                // Overridable because two-hand poses that occlude each other —
                // pray, clasped hands — lose tracking at the default gate.
                // Lowering it holds a hand through ambiguity at the cost of
                // more false landmarks elsewhere, so the default is unchanged.
                // Set before enabling Hand mode; the model reads it at load.
                minTrackingConfidence: window.__handMinTracking ?? 0.5
            }
        });

        // Alias for backward compatibility
        this.hands = null;
    }

    async load() {
        const result = await super.load();
        this.hands = this.model;
        return result;
    }

    unload() {
        super.unload();
        this.hands = null;
    }
}

// Global singleton
window.HandsLoader = new HandsLoader();
