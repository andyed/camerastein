/**
 * Tasks Vision inference worker — CLASSIC worker entry point.
 *
 * MUST be constructed as `new Worker(url)` with no `{type:'module'}`. A module
 * worker cannot load this library: `importScripts()` throws TypeError under
 * module type, MediaPipe's loader falls through to dynamic import, and the
 * Emscripten glue sets a plain `var ModuleFactory` that never reaches `self`
 * under ESM evaluation — it fails at createFromOptions with "ModuleFactory not
 * set." Measured, not assumed; see docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md § 0.
 *
 * Consequence for this file: no top-level `import` statements. Everything is
 * pulled in with dynamic `import()` inside the init handler.
 *
 * This worker owns inference and nothing else. It never touches MotionBus,
 * detectors, debugManager or the DOM — all publication stays on the main thread
 * so provider behaviour remains testable without a browser worker.
 */

/* eslint-env worker */

let P = null;                 // protocol module
let tasksVision = null;       // the Tasks Vision bundle
let fileset = null;           // shared FilesetResolver
let generation = -1;          // current camera generation; stale work is dropped
let assets = null;
let requestedDelegate = 'CPU';

const models = Object.create(null);       // channel -> landmarker
const delegates = Object.create(null);    // channel -> delegate that ACTUALLY loaded
const lastTimestamp = Object.create(null); // channel -> monotonic model timestamp

const CTOR = { face: 'FaceLandmarker', pose: 'PoseLandmarker', hand: 'HandLandmarker' };

function post(msg, transfer) {
    msg.protocolVersion = P ? P.PROTOCOL_VERSION : 1;
    self.postMessage(msg, transfer || []);
}

function postError(requestId, code, message, { channel = null, phase = null } = {}) {
    post({
        type: 'error',
        requestId,
        generation,
        channel,
        phase,
        code,
        // Never ship a stack into consumer telemetry; the message is enough to act on.
        message: String(message || code),
        fatal: P ? P.isFatalCode(code) : true,
    });
}

/** Options must mirror adapter.js exactly — probing a different config proves nothing. */
function optionsFor(channel, opts, delegate) {
    const base = { baseOptions: { delegate }, runningMode: 'VIDEO' };
    if (channel === 'face') {
        return { ...base, baseOptions: { modelAssetPath: assets.models.face, delegate },
            numFaces: opts?.numFaces || 4, outputFaceBlendshapes: true };
    }
    if (channel === 'pose') {
        const url = opts?.heavy ? assets.models.poseHeavy : assets.models.poseLite;
        return { ...base, baseOptions: { modelAssetPath: url, delegate }, numPoses: opts?.numPoses || 1 };
    }
    return { ...base, baseOptions: { modelAssetPath: assets.models.hands, delegate },
        numHands: opts?.numHands || 2 };
}

async function handleInit(msg) {
    assets = msg.assets;
    requestedDelegate = msg.delegate === 'GPU' ? 'GPU' : 'CPU';
    generation = msg.generation;
    try {
        tasksVision = await import(assets.visionBundleUrl);
    } catch (e) {
        return postError(msg.requestId, P.CODE.ASSET_LOAD_FAILED, `bundle import failed: ${e?.message || e}`, { phase: 'init' });
    }
    try {
        fileset = await tasksVision.FilesetResolver.forVisionTasks(assets.wasmBaseUrl);
    } catch (e) {
        return postError(msg.requestId, P.CODE.ASSET_LOAD_FAILED, `wasm fileset failed: ${e?.message || e}`, { phase: 'init' });
    }
    post({ type: 'ready', requestId: msg.requestId, generation, requestedDelegate });
}

async function handleLoadModel(msg) {
    const { channel, requestId } = msg;
    if (!P.isValidChannel(channel)) {
        return postError(requestId, P.CODE.MODEL_LOAD_FAILED, `unknown channel ${channel}`, { phase: 'load' });
    }
    if (models[channel]) {
        return post({ type: 'model-loaded', requestId, generation, channel, delegate: delegates[channel], reused: true });
    }

    // Mirror adapter.js: try the requested delegate, retry once on CPU. The
    // delegate that actually loaded is reported per channel, because after a
    // fallback they can legitimately differ.
    let delegate = requestedDelegate;
    let landmarker = null;
    try {
        landmarker = await tasksVision[CTOR[channel]].createFromOptions(fileset, optionsFor(channel, msg.options, delegate));
    } catch (first) {
        if (delegate === 'CPU') {
            return postError(requestId, P.CODE.MODEL_LOAD_FAILED, first?.message || String(first), { channel, phase: 'load' });
        }
        delegate = 'CPU';
        try {
            landmarker = await tasksVision[CTOR[channel]].createFromOptions(fileset, optionsFor(channel, msg.options, delegate));
        } catch (second) {
            return postError(requestId, P.CODE.MODEL_LOAD_FAILED, second?.message || String(second), { channel, phase: 'load' });
        }
    }

    models[channel] = landmarker;
    delegates[channel] = delegate;
    lastTimestamp[channel] = 0;

    // Face topology travels ONCE per generation, not per frame — it is a large
    // static table and re-sending it every frame would dominate the message cost.
    let topology = null;
    if (channel === 'face') {
        const FL = tasksVision.FaceLandmarker;
        topology = P.topologyDTO({
            tessellation: FL.FACE_LANDMARKS_TESSELATION,
            contours: FL.FACE_LANDMARKS_CONTOURS,
            faceOval: FL.FACE_LANDMARKS_FACE_OVAL,
            lips: FL.FACE_LANDMARKS_LIPS,
            leftEye: FL.FACE_LANDMARKS_LEFT_EYE,
            rightEye: FL.FACE_LANDMARKS_RIGHT_EYE,
            leftEyebrow: FL.FACE_LANDMARKS_LEFT_EYEBROW,
            rightEyebrow: FL.FACE_LANDMARKS_RIGHT_EYEBROW,
            leftIris: FL.FACE_LANDMARKS_LEFT_IRIS,
            rightIris: FL.FACE_LANDMARKS_RIGHT_IRIS,
        });
    }
    post({ type: 'model-loaded', requestId, generation, channel, delegate, topology });
}

/**
 * Run one frame.
 *
 * THE RELEASE GATE: the transferred ImageBitmap is closed in `finally`, on every
 * path — success, stale generation, missing model, inference throw, shutdown
 * race. A single missed close grows graphics memory for the whole camera
 * session, and it will not show up in a short test.
 */
async function handleFrame(msg) {
    const { channel, requestId, bitmap, submittedAt } = msg;
    const startedAt = performance.now();
    try {
        if (msg.generation !== generation) {
            return postError(requestId, P.CODE.STALE_GENERATION, 'generation rolled over', { channel, phase: 'inference' });
        }
        const model = models[channel];
        if (!model) {
            return postError(requestId, P.CODE.INFERENCE_FAILED, `no model loaded for ${channel}`, { channel, phase: 'inference' });
        }

        // Timestamp basis is the MAIN THREAD's performance.now (submittedAt), never
        // the worker's — the two clocks have different origins, and Tasks Vision
        // uses this value for temporal filtering in VIDEO mode. Keeping the inline
        // basis means threading is the only variable in the A/B.
        const ts = Math.max(submittedAt, (lastTimestamp[channel] || 0) + 1);
        lastTimestamp[channel] = ts;

        const t0 = performance.now();
        const raw = model.detectForVideo(bitmap, ts);
        const inferenceMs = performance.now() - t0;

        post({
            type: 'result',
            requestId,
            generation,
            channel,
            delegate: delegates[channel],
            submittedAt,
            inferenceStartedAt: startedAt,
            inferenceMs,
            result: P.buildDTO(channel, raw),
        });
    } catch (e) {
        postError(requestId, P.CODE.INFERENCE_FAILED, e?.message || String(e), { channel, phase: 'inference' });
    } finally {
        try { bitmap?.close?.(); } catch (_) { /* already closed / not a bitmap */ }
    }
}

function handleUnload(msg) {
    const { channel, requestId } = msg;
    try { models[channel]?.close?.(); } catch (_) { /* closing twice is not an error */ }
    delete models[channel];
    delete delegates[channel];
    delete lastTimestamp[channel];
    post({ type: 'model-unloaded', requestId, generation, channel });   // idempotent
}

function handleShutdown(msg) {
    for (const channel of Object.keys(models)) {
        try { models[channel]?.close?.(); } catch (_) { /* best effort */ }
        delete models[channel];
    }
    post({ type: 'shutdown-ack', requestId: msg.requestId, generation });
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    // protocol.js is a sibling of this file in both the dev tree and the packaged
    // renderer, so self-relative resolution is correct in both.
    if (!P) {
        try {
            P = await import(new URL('./protocol.js', self.location.href).href);
        } catch (e) {
            return self.postMessage({ type: 'error', protocolVersion: 1, requestId: msg?.requestId ?? null,
                code: 'ASSET_LOAD_FAILED', fatal: true, message: `protocol import failed: ${e?.message || e}` });
        }
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type !== 'init' && msg.protocolVersion !== P.PROTOCOL_VERSION) {
        // A frame carries a transferred bitmap; refusing it still has to close it.
        try { msg.bitmap?.close?.(); } catch (_) { /* nothing to do */ }
        return postError(msg.requestId, P.CODE.PROTOCOL_MISMATCH, `expected v${P.PROTOCOL_VERSION}, got v${msg.protocolVersion}`);
    }

    switch (msg.type) {
        case 'init': return handleInit(msg);
        case 'load-model': return handleLoadModel(msg);
        case 'frame': return handleFrame(msg);
        case 'unload-model': return handleUnload(msg);
        case 'shutdown': return handleShutdown(msg);
        default: return;
    }
};
