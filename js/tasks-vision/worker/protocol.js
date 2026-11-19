/**
 * Tasks Vision worker protocol — message shapes, error codes, validation.
 *
 * Pure and dependency-free ON PURPOSE. It is imported by the main thread AND by
 * the worker, so it must not touch window, document, MotionBus, or any app
 * global. That constraint is what lets the whole protocol be unit-tested without
 * a browser worker.
 *
 * Contract summary (docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md § 8):
 *   - every message carries PROTOCOL_VERSION, requestId and generation
 *   - model-scoped messages also carry channel
 *   - results are plain clone-safe DTOs built here, never raw Tasks Vision
 *     objects, so the wire shape is versioned and explicit
 */

export const PROTOCOL_VERSION = 1;

export const CHANNELS = Object.freeze(['face', 'pose', 'hand']);

/** Main thread -> worker. */
export const REQ = Object.freeze({
    INIT: 'init',
    LOAD_MODEL: 'load-model',
    UNLOAD_MODEL: 'unload-model',
    FRAME: 'frame',
    SHUTDOWN: 'shutdown',
});

/** Worker -> main thread. */
export const RES = Object.freeze({
    READY: 'ready',
    MODEL_LOADED: 'model-loaded',
    MODEL_UNLOADED: 'model-unloaded',
    RESULT: 'result',
    ERROR: 'error',
    SHUTDOWN_ACK: 'shutdown-ack',
});

/**
 * Stable error codes. Parse these, never prose — `_isFatalFrameError` in
 * shared-camera-manager.js classifies the inline path by lowercased substring
 * match, and repeating that mistake across a thread boundary would be worse.
 */
export const CODE = Object.freeze({
    WORKER_UNSUPPORTED: 'WORKER_UNSUPPORTED',
    WORKER_START_FAILED: 'WORKER_START_FAILED',
    // Distinct from WORKER_START_FAILED: the Worker constructed fine, it just never
    // answered the INIT handshake within TIMEOUTS.init (cold WASM compile is the
    // usual cause). Conflating the two used to hide a live-but-slow worker behind
    // a "failed to start" label with no timing information.
    INIT_TIMEOUT: 'INIT_TIMEOUT',
    PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
    ASSET_LOAD_FAILED: 'ASSET_LOAD_FAILED',
    MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
    FRAME_CAPTURE_FAILED: 'FRAME_CAPTURE_FAILED',
    INFERENCE_FAILED: 'INFERENCE_FAILED',
    FRAME_TIMEOUT: 'FRAME_TIMEOUT',
    WORKER_CRASHED: 'WORKER_CRASHED',
    STALE_GENERATION: 'STALE_GENERATION',
});

/**
 * Which failures kill the camera generation, and which are just a lost frame.
 *
 * Spec § 12. Getting this wrong in either direction is bad: too eager and a
 * transient hiccup tears down tracking; too lax and a wedged graph keeps being
 * fed frames. Note that the inline path currently swallows EVERY inference error
 * and skips the frame, so INFERENCE_FAILED stays non-fatal to preserve that
 * behaviour exactly — the worker must not change signal semantics.
 *
 * Hands are special-cased by the caller, not here: a hand model failure suspends
 * hands via the existing HAND_FATAL path without disturbing the primary channel.
 */
export const FATAL_CODES = Object.freeze(new Set([
    CODE.PROTOCOL_MISMATCH,
    CODE.MODEL_LOAD_FAILED,
    CODE.FRAME_TIMEOUT,
    CODE.WORKER_CRASHED,
]));

/** Pre-activation failures select the inline fallback instead of tearing down. */
export const PRE_ACTIVATION_CODES = Object.freeze(new Set([
    CODE.WORKER_UNSUPPORTED,
    CODE.WORKER_START_FAILED,
    CODE.INIT_TIMEOUT,
]));

export function isFatalCode(code) {
    return FATAL_CODES.has(code);
}

/**
 * A typed transport error. Carries `code` as a real property so the classifier
 * can branch on it rather than sniffing the message text.
 */
export function makeError(code, message, { channel = null, phase = null, fatal } = {}) {
    const err = new Error(message || code);
    err.name = 'TasksVisionWorkerError';
    err.code = code;
    err.channel = channel;
    err.phase = phase;
    err.fatal = typeof fatal === 'boolean' ? fatal : isFatalCode(code);
    return err;
}

export function isValidChannel(channel) {
    return CHANNELS.indexOf(channel) !== -1;
}

/**
 * Validate an inbound worker->main message before acting on it.
 * Returns null when acceptable, or a reason string.
 */
export function validateResponse(msg) {
    if (!msg || typeof msg !== 'object') return 'not-an-object';
    if (typeof msg.type !== 'string') return 'missing-type';
    if (msg.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version';
    if (msg.type === RES.RESULT) {
        if (!isValidChannel(msg.channel)) return 'bad-channel';
        if (!msg.result || typeof msg.result !== 'object') return 'missing-result';
    }
    return null;
}

/** Non-finite timing must never poison telemetry — drop it to null instead. */
export function sanitizeMs(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : null;
}

/* ── Clone-safe result DTOs ──────────────────────────────────────────────────
 * Built explicitly rather than posting the Tasks Vision result object. Two
 * reasons: structured-clone safety of the library's exact installed shape is not
 * guaranteed across versions, and an explicit DTO keeps the wire format
 * versioned. Only fields the app actually consumes cross the boundary.
 */

const pt = (p) => ({ x: p.x, y: p.y, z: p.z });
const ptV = (p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility });

/** Face: landmarks + blendshapes. Preserves multi-face ordering. */
export function faceDTO(result) {
    return {
        faceLandmarks: (result?.faceLandmarks || []).map((f) => f.map(pt)),
        // categoryName and displayName both matter downstream; score alone is not enough.
        faceBlendshapes: (result?.faceBlendshapes || []).map((b) => ({
            categories: (b?.categories || []).map((c) => ({
                score: c.score, categoryName: c.categoryName, index: c.index,
            })),
        })),
    };
}

/** Pose: visibility is CRITICAL — BodyMotionDetector gates arm/leg at 0.5. */
export function poseDTO(result) {
    return { landmarks: (result?.landmarks || []).map((p) => p.map(ptV)) };
}

/** Hand: both score AND categoryName survive; the translator reads each. */
export function handDTO(result) {
    return {
        landmarks: (result?.landmarks || []).map((h) => h.map(pt)),
        handedness: (result?.handedness || []).map((h) => (h || []).map((c) => ({
            score: c.score, categoryName: c.categoryName, index: c.index,
        }))),
    };
}

export function buildDTO(channel, result) {
    if (channel === 'face') return faceDTO(result);
    if (channel === 'pose') return poseDTO(result);
    if (channel === 'hand') return handDTO(result);
    return null;
}

/**
 * MediaPipe's connection tables are arrays of {start,end} — already clone-safe,
 * but copied explicitly so a future library change cannot smuggle a class
 * instance across the boundary and throw a DataCloneError at runtime.
 */
export function topologyDTO(topology) {
    if (!topology || typeof topology !== 'object') return null;
    const out = {};
    for (const key of Object.keys(topology)) {
        const table = topology[key];
        out[key] = Array.isArray(table)
            ? table.map((c) => ({ start: c.start, end: c.end }))
            : null;
    }
    return out;
}
