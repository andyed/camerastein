/**
 * PoseLandmarkerShim — Wraps Tasks Vision PoseLandmarker in the legacy
 * Pose interface that SharedCameraManager expects.
 */

import { publishPose } from './result-publishers.js';

export class PoseLandmarkerShim {
    constructor(landmarker, delegate = null) {
        this._landmarker = landmarker;
        this._delegate = delegate;   // resolved, post GPU->CPU fallback
        this._callback = null;
        this._lastTimestamp = 0;
    }

    onResults(callback) { this._callback = callback; }

    /**
     * Returns a structured timing outcome (see camera-tracking-stats.js record()).
     * Publication is unchanged — the return value is additive.
     */
    async send({ image }) {
        if (!this._landmarker || !image) {
            return { channel: 'pose', transport: 'inline', delegate: this._delegate, completed: false, dropped: true, dropReason: 'no-input' };
        }
        const ts = Math.max(performance.now(), this._lastTimestamp + 1);
        this._lastTimestamp = ts;
        const t0 = performance.now();
        let inferenceMs = 0;
        try {
            const result = this._landmarker.detectForVideo(image, ts);
            inferenceMs = performance.now() - t0;
            publishPose({ result, callback: this._callback });
        } catch (e) {
            window.debugManager?.warn?.('PoseLandmarkerShim.send error:', e.message);
            return { channel: 'pose', transport: 'inline', delegate: this._delegate, completed: false, dropped: true, dropReason: 'inference-error' };
        }
        return { channel: 'pose', transport: 'inline', delegate: this._delegate, completed: true, dropped: false,
            frameAcquireMs: 0, queueMs: 0, inferenceMs };
    }

    setOptions() {}
    close() { this._landmarker?.close(); this._landmarker = null; }
}
