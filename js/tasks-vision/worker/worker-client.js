/**
 * TasksVisionWorkerClient — main-thread half of the worker transport.
 *
 * Owns worker lifecycle, request correlation, the one-frame-in-flight rule,
 * generation invalidation, timeouts and crash handling. It deliberately does NOT
 * publish results: the adapter above it does that on the main thread, so the
 * worker never needs MotionBus or detectors and provider behaviour stays testable.
 *
 * Both the Worker constructor and the frame factory are injectable. That is what
 * lets the whole state machine be unit-tested — backpressure, correlation,
 * timeouts, stale generations, crash — with no browser worker and no camera.
 *
 * See docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md §§ 5.5, 8, 9, 12.
 */

import {
    PROTOCOL_VERSION, REQ, RES, CODE, makeError, validateResponse, sanitizeMs,
} from './protocol.js';

/** Named so a wedged stage is identifiable from a log line, not a magic number. */
export const TIMEOUTS = Object.freeze({
    init: 15000,        // cold start incl. WASM instantiate
    loadModel: 20000,   // matches the existing tolerance for slow camera startup
    firstFrame: 10000,  // GPU graph warm-up; Simulator measured 3.78-4.99 s
    frame: 2000,        // a frame this old is unusable even if the worker recovers
    shutdown: 500,      // then force-terminate
});

const DEFAULT_WORKER_URL = new URL('./vision-worker.js', import.meta.url).href;

/**
 * Build the main-thread frame acquisition function used by the worker client.
 *
 * iOS WKWebView cannot be trusted to preserve the camera pixels when an
 * HTMLVideoElement is passed directly to createImageBitmap(). Physical build 62
 * proved the exact failure mode: bitmap acquisition succeeded, 104 worker-GPU
 * inferences completed with no drops, yet every result contained no usable face
 * and throughput collapsed to 0.4 Hz. WebKit's iOS ImageBitmap tests likewise
 * distinguish the failing video-source path from the working canvas-source path.
 *
 * Bridge only native iOS video frames through one reusable 2D canvas. That makes
 * the decoded, correctly oriented RGBA pixels explicit before transfer. Web,
 * Electron, Android, synthetic probes and non-video sources retain the direct
 * ImageBitmap path, so this correction does not tax already-working profiles.
 */
export function createWorkerFrameFactory({
    platform = (typeof window !== 'undefined' ? window.__PSYDELI_PLATFORM : null),
    bitmapFactory = (source) => createImageBitmap(source),
    canvasFactory = () => document.createElement('canvas'),
} = {}) {
    const bridgeVideo = platform === 'ios';
    let canvas = null;
    let context = null;
    let probeTick = 0;

    return async (source) => {
        const isVideo = source && (
            source.tagName === 'VIDEO' || source.nodeName === 'VIDEO' ||
            (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement)
        );
        if (!bridgeVideo || !isVideo) return bitmapFactory(source);

        const width = Number(source.videoWidth) || 0;
        const height = Number(source.videoHeight) || 0;
        if (width <= 0 || height <= 0) {
            throw new Error('iOS worker frame source has no decoded dimensions');
        }

        if (!canvas) canvas = canvasFactory();
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        if (!context) {
            context = canvas.getContext('2d', { alpha: false, desynchronized: true });
            if (!context) throw new Error('iOS worker frame canvas has no 2D context');
        }
        context.drawImage(source, 0, 0, width, height);

        // QA-only physical proof of the shared camera source. Sampling five
        // pixels every 30 frames is enough to separate a live image from the
        // all-black WKWebView failure without putting getImageData on the hot path.
        if (typeof window !== 'undefined' && window.__PSYDELI_WORKER_QA_DIAGNOSTIC === true
            && typeof context.getImageData === 'function' && (probeTick++ % 30) === 0) {
            try {
                const points = [
                    [0.2, 0.2], [0.8, 0.2], [0.5, 0.5], [0.2, 0.8], [0.8, 0.8],
                ];
                const levels = points.map(([px, py]) => {
                    const x = Math.min(width - 1, Math.max(0, Math.floor(width * px)));
                    const y = Math.min(height - 1, Math.max(0, Math.floor(height * py)));
                    const data = context.getImageData(x, y, 1, 1).data;
                    return Math.round((Number(data[0]) + Number(data[1]) + Number(data[2])) / 3);
                });
                const min = Math.min(...levels);
                const max = Math.max(...levels);
                window.__PSYDELI_WORKER_FRAME_PROBE = {
                    luma: Math.round(levels.reduce((sum, value) => sum + value, 0) / levels.length),
                    range: max - min,
                };
            } catch (_) { /* a probe must never break camera acquisition */ }
        }
        return bitmapFactory(canvas);
    };
}

export class TasksVisionWorkerClient {
    /**
     * @param {object} deps
     *   workerFactory  () => Worker            — injectable for tests
     *   frameFactory   (source) => Promise<ImageBitmap>
     *   onFatal        (error) => void         — transport died; caller tears down
     *   now            () => number
     */
    constructor({ workerFactory, frameFactory, onFatal = null, now = null } = {}) {
        // Track whether the caller supplied the factory: an injected one means they
        // own construction, so the global Worker capability check does not apply.
        this._usingDefaultWorker = !workerFactory;
        this._workerFactory = workerFactory || (() => new Worker(DEFAULT_WORKER_URL));
        // Native iOS camera video needs the canvas-backed compatibility path above.
        // Other profiles still call createImageBitmap(source) directly.
        this._frameFactory = frameFactory || createWorkerFrameFactory();
        this._onFatal = onFatal;
        this._now = now || (() => performance.now());

        this._worker = null;
        this._generation = 0;
        this._nextId = 1;
        this._pending = new Map();   // requestId -> {resolve, reject, timer, channel}
        this._inFlightFrame = null;  // requestId of the ONE frame allowed at a time
        this._dead = false;
        this._fatalReason = null;
        this._delegates = Object.create(null);
        this._topology = Object.create(null);
        // MediaPipe GPU graphs do real lazy work on their first inference even
        // after loadModel() resolves. Keep the ordinary freshness deadline once
        // each channel has produced one result, but do not mistake that one-time
        // warm-up for a wedged transport.
        this._warmedChannels = new Set();
    }

    get generation() { return this._generation; }
    get dead() { return this._dead; }
    get fatalReason() { return this._fatalReason; }
    delegateFor(channel) { return this._delegates[channel] || null; }
    topologyFor(channel) { return this._topology[channel] || null; }

    /* ── request plumbing ─────────────────────────────────────────────────── */

    /** requestId may be pre-allocated by the caller so it can track the request
     *  before awaiting — do not go back to peeking at _nextId, which silently
     *  breaks if anything else issues a request across an await. */
    _send(type, payload, { timeout, transfer, requestId: preAllocated } = {}) {
        if (this._dead) {
            return Promise.reject(makeError(CODE.WORKER_CRASHED, this._fatalReason || 'worker is dead', { phase: type }));
        }
        const requestId = preAllocated ?? this._nextId++;
        const msg = { type, protocolVersion: PROTOCOL_VERSION, requestId, generation: this._generation, ...payload };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(requestId);
                if (this._inFlightFrame === requestId) this._inFlightFrame = null;
                // INIT timing out means the worker is alive but slow (cold WASM compile) —
                // distinct from WORKER_START_FAILED, which means the Worker never
                // constructed at all. Other non-frame requests (load-model, etc.) keep the
                // existing label; only INIT's timeout was being misread as "failed to start".
                const code = type === REQ.FRAME
                    ? CODE.FRAME_TIMEOUT
                    : (type === REQ.INIT ? CODE.INIT_TIMEOUT : CODE.WORKER_START_FAILED);
                const err = makeError(code, `${type} timed out after ${timeout}ms`, { phase: type });
                // A frame timeout means the graph may be wedged. Do not let the next
                // frame pile onto it — invalidate the transport.
                if (code === CODE.FRAME_TIMEOUT) this._fail(err);
                reject(err);
            }, timeout);
            this._pending.set(requestId, { resolve, reject, timer, type });
            try {
                this._worker.postMessage(msg, transfer || []);
            } catch (e) {
                clearTimeout(timer);
                this._pending.delete(requestId);
                reject(makeError(CODE.WORKER_CRASHED, `postMessage failed: ${e?.message || e}`, { phase: type }));
            }
        });
    }

    _settle(msg) {
        const entry = this._pending.get(msg.requestId);
        if (!entry) return;   // late arrival after timeout/teardown — discard silently
        clearTimeout(entry.timer);
        this._pending.delete(msg.requestId);
        if (this._inFlightFrame === msg.requestId) this._inFlightFrame = null;
        if (msg.type === RES.ERROR) {
            entry.reject(makeError(msg.code, msg.message, { channel: msg.channel, phase: msg.phase, fatal: msg.fatal }));
            return;
        }
        entry.resolve(msg);
    }

    /** Transport is unusable. Reject everything outstanding exactly once. */
    _fail(error) {
        if (this._dead) return;
        this._dead = true;
        this._fatalReason = error?.message || String(error);
        this._generation++;   // invalidate anything still in flight
        for (const [, entry] of this._pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this._pending.clear();
        this._inFlightFrame = null;
        try { this._worker?.terminate(); } catch (_) { /* already gone */ }
        this._worker = null;
        try { this._onFatal?.(error); } catch (_) { /* caller's problem, not ours */ }
    }

    /* ── lifecycle ────────────────────────────────────────────────────────── */

    async start(assets, delegate = 'CPU') {
        if (this._usingDefaultWorker && typeof Worker === 'undefined') {
            throw makeError(CODE.WORKER_UNSUPPORTED, 'Worker is not available in this runtime', { phase: 'init' });
        }
        try {
            this._worker = this._workerFactory();
        } catch (e) {
            throw makeError(CODE.WORKER_START_FAILED, e?.message || String(e), { phase: 'init' });
        }
        this._worker.onmessage = (ev) => {
            const msg = ev.data;
            const bad = validateResponse(msg);
            if (bad) {
                // A protocol-version mismatch is not recoverable by retrying.
                if (bad === 'protocol-version') this._fail(makeError(CODE.PROTOCOL_MISMATCH, `worker speaks v${msg?.protocolVersion}`));
                return;
            }
            if (msg.type === RES.RESULT && msg.generation !== this._generation) return;  // stale
            this._settle(msg);
        };
        this._worker.onerror = (ev) => this._fail(makeError(CODE.WORKER_CRASHED, ev?.message || 'worker error'));
        this._worker.onmessageerror = () => this._fail(makeError(CODE.WORKER_CRASHED, 'message could not be deserialized'));

        await this._send(REQ.INIT, { assets, delegate }, { timeout: TIMEOUTS.init });
        return this;
    }

    async loadModel(channel, options) {
        const res = await this._send(REQ.LOAD_MODEL, { channel, options }, { timeout: TIMEOUTS.loadModel });
        this._warmedChannels.delete(channel);
        if (res.delegate) this._delegates[channel] = res.delegate;
        if (res.topology) this._topology[channel] = res.topology;
        return res;
    }

    async unloadModel(channel) {
        if (this._dead) return null;      // nothing to unload; not an error
        const res = await this._send(REQ.UNLOAD_MODEL, { channel }, { timeout: TIMEOUTS.loadModel });
        this._warmedChannels.delete(channel);
        return res;
    }

    /**
     * Send one frame.
     *
     * ONE IN FLIGHT, GLOBALLY — across face, pose and hand. If busy, no
     * ImageBitmap is created at all; the send resolves as a drop. Freshness beats
     * throughput here: a late result is worse for embodied control than a skipped
     * camera frame, and a queue would guarantee late results under load.
     */
    async sendFrame(channel, source) {
        if (this._dead) {
            return { channel, transport: 'worker', completed: false, dropped: true, dropReason: 'stale' };
        }
        if (this._inFlightFrame !== null) {
            // Note: no bitmap is allocated on this path. That is the point.
            return { channel, transport: 'worker', delegate: this._delegates[channel] || null,
                completed: false, dropped: true, dropReason: 'busy' };
        }

        // CLAIM THE SLOT SYNCHRONOUSLY, before the first await. Acquiring the
        // bitmap is async, so claiming afterwards leaves a window in which two
        // sends issued in the same tick both pass the busy check, both allocate,
        // and both post — breaking the single-in-flight invariant that is the
        // entire backpressure guarantee. The unit tests missed this because they
        // advanced timers between calls; the end-to-end harness caught it.
        const requestId = this._nextId++;
        this._inFlightFrame = requestId;

        // Captured up front: publication needs the analysed frame's dimensions, and
        // the <video> element may have changed size by the time the result returns.
        const sourceWidth = Number(source?.videoWidth ?? source?.width) || 0;
        const sourceHeight = Number(source?.videoHeight ?? source?.height) || 0;

        const submittedAt = this._now();
        let bitmap;
        const acq0 = this._now();
        try {
            bitmap = await this._frameFactory(source);
        } catch (e) {
            if (this._inFlightFrame === requestId) this._inFlightFrame = null;
            return { channel, transport: 'worker', delegate: this._delegates[channel] || null,
                completed: false, dropped: true, dropReason: 'capture-failed', error: e?.message || String(e) };
        }
        const frameAcquireMs = this._now() - acq0;

        try {
            const timeout = this._warmedChannels.has(channel) ? TIMEOUTS.frame : TIMEOUTS.firstFrame;
            const res = await this._send(REQ.FRAME, {
                channel, bitmap, submittedAt, sourceWidth, sourceHeight,
            }, { timeout, transfer: [bitmap], requestId });

            this._warmedChannels.add(channel);

            return {
                channel, transport: 'worker', delegate: res.delegate || this._delegates[channel] || null,
                completed: true, dropped: false,
                frameAcquireMs, queueMs: 0,
                inferenceMs: sanitizeMs(res.inferenceMs),
                roundTripMs: this._now() - submittedAt,
                result: res.result, submittedAt, sourceWidth, sourceHeight,
            };
        } catch (e) {
            // Ownership note: the bitmap was TRANSFERRED. The worker closes it in a
            // finally, so there is nothing to clean up here even on failure — and
            // touching it would throw.
            if (e.code === CODE.STALE_GENERATION) {
                return { channel, transport: 'worker', completed: false, dropped: true, dropReason: 'stale' };
            }
            if (e.code === CODE.INFERENCE_FAILED) {
                // Matches the inline shims, which swallow inference errors and skip
                // the frame. The worker must not change signal semantics.
                return { channel, transport: 'worker', delegate: this._delegates[channel] || null,
                    completed: false, dropped: true, dropReason: 'inference-error', frameAcquireMs };
            }
            throw e;
        } finally {
            if (this._inFlightFrame === requestId) this._inFlightFrame = null;
        }
    }

    async shutdown() {
        if (!this._worker || this._dead) { this._dead = true; return; }
        this._generation++;
        try {
            await Promise.race([
                this._send(REQ.SHUTDOWN, {}, { timeout: TIMEOUTS.shutdown }),
                new Promise((r) => setTimeout(r, TIMEOUTS.shutdown)),
            ]);
        } catch (_) { /* a wedged worker still gets terminated below */ }
        this._dead = true;
        for (const [, entry] of this._pending) { clearTimeout(entry.timer); }
        this._pending.clear();
        try { this._worker.terminate(); } catch (_) { /* already gone */ }
        this._worker = null;
    }
}
