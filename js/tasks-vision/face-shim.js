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

import { publishFace, imageSizeOf } from './result-publishers.js';

export class FaceLandmarkerShim {
    constructor(landmarker, topology = null, delegate = null) {
        this._landmarker = landmarker;
        // delegate is appended, NOT inserted: existing two-arg callers (and
        // tests/unit/face-landmarks-channel.test.js) must keep working unchanged.
        // The delegate that actually loaded. adapter.js retries on CPU per channel
        // when GPU creation throws, so this can differ from what was requested —
        // and that silent downgrade is exactly what telemetry has to surface.
        this._delegate = delegate;
        // Stable MediaPipe connection tables (passed in by the adapter). Kept beside
        // the raw landmark frame so sister projects can render the same portable
        // geometry without importing or duplicating a version-specific topology table.
        this._topology = topology;
        this._callback = null;
        this._lastTimestamp = 0;
    }

    onResults(callback) {
        this._callback = callback;
    }

    /**
     * Returns a structured timing outcome (see camera-tracking-stats.js record()).
     * Publication below is unchanged — the return value is additive, and callers
     * that ignore it behave exactly as before.
     */
    async send({ image }) {
        if (!this._landmarker || !image) {
            return { channel: 'face', transport: 'inline', delegate: this._delegate, completed: false, dropped: true, dropReason: 'no-input' };
        }

        // Tasks Vision requires monotonically increasing timestamps
        const ts = Math.max(performance.now(), this._lastTimestamp + 1);
        this._lastTimestamp = ts;

        const t0 = performance.now();
        let inferenceMs = 0;
        try {
            const result = this._landmarker.detectForVideo(image, ts);
            inferenceMs = performance.now() - t0;

            // Publication lives in result-publishers.js, shared verbatim with the
            // worker adapter. Callback order, the blendshape emit and the
            // null-on-loss clear are the contract; keeping ONE implementation is
            // how the two transports stay in parity structurally rather than by
            // being separately tested and separately drifting.
            //
            // It stays inside this try on purpose: a throwing consumer has always
            // been reported as a skipped frame, and the worker must not change that.
            publishFace({
                result,
                callback: this._callback,
                topology: this._topology,
                imageSize: imageSizeOf(image),
                t: ts,
                source: 'mediapipe-tasks',
            });
        } catch (e) {
            // Silently skip frame on error (matches legacy behavior)
            window.debugManager?.warn?.('FaceLandmarkerShim.send error:', e.message);
            return { channel: 'face', transport: 'inline', delegate: this._delegate, completed: false, dropped: true, dropReason: 'inference-error' };
        }

        // Inline: detectForVideo is synchronous WASM and publication is synchronous
        // too, so the whole send is main-thread time. mainThreadMs is left to the
        // caller's stopwatch, which is the only one that sees the await boundary.
        return {
            channel: 'face',
            transport: 'inline',
            delegate: this._delegate,
            completed: true,
            dropped: false,
            frameAcquireMs: 0,   // the <video> element is passed straight through
            queueMs: 0,
            inferenceMs,
        };
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
