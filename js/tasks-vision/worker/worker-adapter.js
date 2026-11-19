/**
 * TasksVisionWorkerAdapter — the worker transport wearing the inline adapter's face.
 *
 * Implements exactly the surface TasksVisionAdapter does:
 *   createFaceLoader / createPoseLoader / createHandsLoader
 *     -> { loaded, loading, load(), unload(), setOptions() }
 *   load() -> { onResults(cb), send({image}), setOptions(), close() }
 *
 * SharedCameraManager, the lifecycle machine and every detector keep depending
 * only on that facade, so the transport swap needs no second control path.
 *
 * Publication is done HERE, on the main thread, through result-publishers.js —
 * the same module the inline shims call. That is what makes parity structural
 * instead of aspirational, and it is why the worker never needs MotionBus.
 */

import { TasksVisionWorkerClient } from './worker-client.js';
import { publishFace, publishPose, publishHand } from '../result-publishers.js';

/**
 * One client per adapter instance, shared by all three loaders — NOT one worker
 * per model. Three workers would triplicate WASM init, triple memory, and let
 * three graphs contend for CPU unpredictably.
 */
export class TasksVisionWorkerAdapter {
    /**
     * @param {object} opts
     *   assets    {visionBundleUrl, wasmBaseUrl, models:{face,poseLite,poseHeavy,hands}}
     *   delegate  'CPU' | 'GPU'
     *   onFatal   (error) => void — transport died; the caller tears the generation down
     *   clientFactory  test seam
     */
    constructor({ assets, delegate = 'CPU', onFatal = null, clientFactory = null, frameFactory = null } = {}) {
        this._assets = assets;
        this._delegate = delegate;
        this._onFatal = onFatal;
        // Production leaves this null and the client uses createImageBitmap on the
        // <video> element. Harnesses inject a synthetic source so the transport can
        // be exercised without a camera.
        this._frameFactory = frameFactory;
        this._clientFactory = clientFactory || ((deps) => new TasksVisionWorkerClient(deps));
        this._client = null;
        this._startPromise = null;
    }

    get client() { return this._client; }
    /** Reported per channel: adapter and worker both retry on CPU independently. */
    delegateFor(channel) { return this._client?.delegateFor(channel) || null; }

    /** Deduplicated start. A rejected attempt does not poison later retries. */
    _ensureClient() {
        if (this._client && !this._client.dead) return Promise.resolve(this._client);
        if (this._startPromise) return this._startPromise;

        const client = this._clientFactory({ onFatal: this._onFatal, frameFactory: this._frameFactory || undefined });
        const p = client.start(this._assets, this._delegate).then(() => {
            this._client = client;
            return client;
        });
        this._startPromise = p;
        p.catch(() => { if (this._startPromise === p) this._startPromise = null; });
        return p;
    }

    _createLoader(channel, defaultOptions) {
        const adapter = this;
        let model = null;

        return {
            loaded: false,
            loading: false,

            async load() {
                if (model) return model;
                this.loading = true;
                try {
                    const client = await adapter._ensureClient();
                    const options = { ...defaultOptions };
                    await client.loadModel(channel, options);
                    model = adapter._makeModel(channel, client);
                    this.loaded = true;
                    return model;
                } finally {
                    this.loading = false;
                }
            },

            unload() {
                model?.close();
                model = null;
                this.loaded = false;
            },

            setOptions() {
                // Parity with the inline adapter: Tasks Vision fixes config at
                // creation, so this has always been a no-op and stays one.
            },
        };
    }

    /** The model facade SharedCameraManager drives. */
    _makeModel(channel, client) {
        const adapter = this;
        let callback = null;
        let closed = false;

        return {
            onResults(cb) { callback = cb; },

            /**
             * Returns the same structured outcome shape the inline shims do, so
             * _timedSend and CameraTrackingStats need no transport-specific branch.
             */
            async send({ image }) {
                if (closed) {
                    return { channel, transport: 'worker', completed: false, dropped: true, dropReason: 'stale' };
                }
                const outcome = await client.sendFrame(channel, image);
                if (!outcome.completed) return outcome;

                // MEASURE the main-thread slice rather than omitting it. Offloading
                // inference does not make the worker path free on this thread: it
                // still pays frame acquisition, structured-clone DESERIALIZATION of
                // the result (478 landmarks per face, plus blendshapes — the main
                // thread does that work on receipt, and inline never did), and
                // publication. Reporting nothing made mainThreadMsPerSec read 0,
                // which looks like a total win and is really a blind spot.
                const publishStart = performance.now();

                // Publish on the MAIN thread, via the shared publishers. `t` is
                // submittedAt — the capture instant on the main performance
                // timeline — so round-trip latency never makes downstream dt look
                // fast or slow. Source is labelled distinctly so an A/B capture is
                // honest; no consumer may branch on it.
                if (channel === 'face') {
                    publishFace({
                        result: outcome.result,
                        callback,
                        topology: client.topologyFor('face'),
                        imageSize: { width: outcome.sourceWidth, height: outcome.sourceHeight },
                        t: outcome.submittedAt,
                        source: 'mediapipe-tasks-worker',
                    });
                } else if (channel === 'pose') {
                    publishPose({ result: outcome.result, callback });
                } else {
                    publishHand({ result: outcome.result, callback });
                }

                const publishMs = performance.now() - publishStart;

                // The DTO has served its purpose; do not retain it in telemetry.
                const { result, ...timing } = outcome;
                // Preserve only the raw result count. Physical iOS QA needs to
                // distinguish "FaceLandmarker returned zero" from "publication or
                // HeadBob lost a real face" without retaining 478-point DTOs.
                timing.resultCount = channel === 'face'
                    ? (Array.isArray(result?.faceLandmarks) ? result.faceLandmarks.length : null)
                    : (Array.isArray(result?.landmarks) ? result.landmarks.length : null);
                // Acquisition + publication is what the renderer actually pays here.
                // Deserialization happens before we regain control, so it lands in
                // roundTripMs rather than being separable — noted so the number is
                // not read as the complete main-thread cost.
                timing.publishMs = publishMs;
                timing.mainThreadMs = (Number.isFinite(outcome.frameAcquireMs) ? outcome.frameAcquireMs : 0) + publishMs;
                return timing;
            },

            setOptions() {},

            close() {
                closed = true;
                // Fire and forget: the model is logically gone for this generation
                // whether or not the worker acknowledges, and callers are sync.
                client.unloadModel(channel)?.catch?.(() => { /* teardown is best effort */ });
            },
        };
    }

    createFaceLoader(options = {}) {
        return this._createLoader('face', { numFaces: options.numFaces || 4, outputFaceBlendshapes: true });
    }

    createPoseLoader(options = {}) {
        return this._createLoader('pose', { numPoses: options.numPoses || 1, heavy: !!options.heavy });
    }

    createHandsLoader(options = {}) {
        return this._createLoader('hand', { numHands: options.numHands || 2 });
    }

    /** Tear the whole transport down — one worker, so one shutdown. */
    async dispose() {
        try { await this._client?.shutdown(); } finally {
            this._client = null;
            this._startPromise = null;
        }
    }
}
