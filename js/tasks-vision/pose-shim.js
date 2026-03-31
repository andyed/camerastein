/**
 * PoseLandmarkerShim — Wraps Tasks Vision PoseLandmarker in the legacy
 * Pose interface that SharedCameraManager expects.
 */

import { translatePoseResults } from './result-translators.js';

export class PoseLandmarkerShim {
    constructor(landmarker) {
        this._landmarker = landmarker;
        this._callback = null;
        this._lastTimestamp = 0;
    }

    onResults(callback) { this._callback = callback; }

    async send({ image }) {
        if (!this._landmarker || !image) return;
        const ts = Math.max(performance.now(), this._lastTimestamp + 1);
        this._lastTimestamp = ts;
        try {
            const result = this._landmarker.detectForVideo(image, ts);
            if (this._callback) {
                this._callback(translatePoseResults(result));
            }
        } catch (e) {
            window.debugManager?.warn?.('PoseLandmarkerShim.send error:', e.message);
        }
    }

    setOptions() {}
    close() { this._landmarker?.close(); this._landmarker = null; }
}
