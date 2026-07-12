/**
 * FaceLandmarkerShim — Wraps Tasks Vision FaceLandmarker in the legacy
 * FaceMesh interface that SharedCameraManager expects.
 *
 * Interface contract:
 *   model.onResults(callback)   — register results callback
 *   model.send({ image })       — process a frame (returns Promise)
 *   model.setOptions(config)    — no-op (Tasks Vision sets config at creation)
 *   model.close()               — cleanup
 */

import { translateFaceResults } from './result-translators.js';

export class FaceLandmarkerShim {
    constructor(landmarker) {
        this._landmarker = landmarker;
        this._callback = null;
        this._lastTimestamp = 0;
    }

    onResults(callback) {
        this._callback = callback;
    }

    async send({ image }) {
        if (!this._landmarker || !image) return;

        // Tasks Vision requires monotonically increasing timestamps
        const ts = Math.max(performance.now(), this._lastTimestamp + 1);
        this._lastTimestamp = ts;

        try {
            const result = this._landmarker.detectForVideo(image, ts);

            // Forward translated results to the registered callback (HeadBobDetector)
            if (this._callback) {
                this._callback(translateFaceResults(result));
            }

            // Emit blendshapes to MotionBus (new capability from Tasks Vision)
            if (result.faceBlendshapes?.length > 0) {
                window.MotionBus?.emit('faceBlendshapes', {
                    shapes: result.faceBlendshapes[0],
                    allFaces: result.faceBlendshapes,
                    t: ts
                });
            }

            // Emit raw 478 face landmarks (includes iris at 468-477) so consumers
            // can crop eye regions, draw landmark overlays, and run their own
            // per-frame geometry. Subscribers: oculens (eye crops + vergence).
            if (result.faceLandmarks?.length > 0) {
                window.MotionBus?.emit('faceLandmarks', {
                    landmarks: result.faceLandmarks[0],
                    allFaces: result.faceLandmarks,
                    t: ts
                });
            }
        } catch (e) {
            // Silently skip frame on error (matches legacy behavior)
            window.debugManager?.warn?.('FaceLandmarkerShim.send error:', e.message);
        }
    }

    setOptions() {
        // Tasks Vision sets config at creation time via createFromOptions.
        // Legacy callers (like HeadBobDetector setting refineLandmarks) are safely ignored.
    }

    close() {
        this._landmarker?.close();
        this._landmarker = null;
    }
}
