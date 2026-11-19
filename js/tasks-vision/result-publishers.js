/**
 * Result publishers — the ONE main-thread path from a landmarker result to the
 * app, shared by the inline shims and the worker adapter.
 *
 * WHY THIS EXISTS: parity between transports is a correctness requirement, and
 * the cheap way to get it is to make it structural. If inline and worker each
 * had their own copy of "invoke the callback, then emit blendshapes, then emit
 * landmarks or null", the two would drift and the drift would show up as subtly
 * wrong tracking rather than as a failing test. One function, two callers.
 *
 * Transport-agnostic by construction: it only reads `faceLandmarks`,
 * `faceBlendshapes`, `landmarks` and `handedness`, which the worker DTOs
 * (worker/protocol.js) preserve under exactly those names.
 *
 * Main-thread only. The worker never imports this — it has no MotionBus, no
 * detectors and no DOM, which is what keeps provider behaviour testable without
 * a browser worker.
 */

import { translateFaceResults, translatePoseResults, translateHandResults } from './result-translators.js';

/**
 * Publish one face result.
 *
 * ORDER IS THE CONTRACT and must not be reshuffled:
 *   1. legacy callback (HeadBobDetector) with the translated shape
 *   2. faceBlendshapes, when present
 *   3. faceLandmarks — or an explicit null when no face is present
 *
 * Step 3's null matters as much as the payload: without it consumers keep
 * rendering the last mesh after the face leaves frame, and freshness guards
 * downstream have to compensate for geometry that never expires.
 *
 * @param {object}   result    raw Tasks Vision result OR a worker face DTO
 * @param {function} callback  legacy detector callback, may be null
 * @param {object}   topology  MediaPipe connection tables, or null
 * @param {object}   imageSize { width, height } of the analysed frame
 * @param {number}   t         main-thread timestamp for the CAPTURED frame
 * @param {string}   source    provenance label; diagnostics only
 * @param {object}   extras    OPTIONAL provider extras for the faceLandmarks payload —
 *                             { sparse, sparseTopology, pose, distanceM, faces }. `faces` (per-face metric
 *                             meta, native-frame-decoder.js nativeFaceMeta) also rides the
 *                             legacy callback as a non-enumerable `nativeFaces`. Only the native iOS provider
 *                             passes it (docs/IOS_NATIVE_VISION.md §3.3, §6). Additive:
 *                             absent → the payload is byte-identical to before, which the
 *                             inline/worker parity test pins.
 */
export function publishFace({ result, callback, topology = null, imageSize = null, t = 0, source = 'mediapipe-tasks', extras = null }) {
    if (callback) {
        const legacy = translateFaceResults(result);
        // Native metric side-channel for HeadBobDetector, index-aligned with
        // multiFaceLandmarks, so lean/pose read the MATCHING face's distance without a
        // MotionBus round trip (the bus emit lands after this callback returns).
        // NON-enumerable: the legacy callback payload stays deep-equal to the inline and
        // worker transports' (native-vision-adapter-parity pins it), and nothing that
        // serialises the result picks it up.
        const nf = extras?.faces;
        if (Array.isArray(nf) && nf.length) {
            try { Object.defineProperty(legacy, 'nativeFaces', { value: nf, enumerable: false }); } catch (_) { /* frozen */ }
        }
        callback(legacy);
    }

    const bus = (typeof window !== 'undefined') ? window.MotionBus : null;

    if (result?.faceBlendshapes?.length > 0) {
        bus?.emit('faceBlendshapes', {
            shapes: result.faceBlendshapes[0],
            allFaces: result.faceBlendshapes,
            t,
        });
    }

    if (result?.faceLandmarks?.length > 0) {
        const payload = {
            landmarks: result.faceLandmarks[0],
            allFaces: result.faceLandmarks,
            topology,
            source,
            imageSize: {
                width: Number(imageSize?.width) || 0,
                height: Number(imageSize?.height) || 0,
            },
            t,
        };
        // Extras ride only when supplied, so a provider without them emits exactly
        // the historical shape (no undefined-valued keys to trip a deep-equal).
        // `sparse` matters to geometry consumers (face-mesh-relief skips the mesh);
        // index-based consumers ignore all three.
        if (extras) {
            if (extras.sparse === true) payload.sparse = true;
            // Contour tables over the §3.2 subset only (native-frame-decoder.js
            // SPARSE_FACE_TOPOLOGY): what face-mesh-relief strokes when `topology` is null
            // because the other 450 slots are centroid fill.
            if (extras.sparse === true && extras.sparseTopology) payload.sparseTopology = extras.sparseTopology;
            if (extras.sparse === true && extras.visionContours) payload.visionContours = extras.visionContours;
            if (extras.pose) payload.pose = extras.pose;
            if (Number.isFinite(extras.distanceM)) payload.distanceM = extras.distanceM;
            // Per-face metric extras, aligned with allFaces[i] (FaceFeatureChannel's
            // per-person proximity/gaze). Only when the provider has them.
            if (Array.isArray(extras.faces) && extras.faces.length) payload.nativeFaces = extras.faces;
        }
        bus?.emit('faceLandmarks', payload);
    } else {
        bus?.emit('faceLandmarks', null);
    }
}

/** Pose publishes through the legacy callback only — no MotionBus channel. */
export function publishPose({ result, callback }) {
    if (callback) callback(translatePoseResults(result));
}

/** Hand publishes through the legacy callback only — no MotionBus channel. */
export function publishHand({ result, callback }) {
    if (callback) callback(translateHandResults(result));
}

export const PUBLISHERS = Object.freeze({
    face: publishFace,
    pose: publishPose,
    hand: publishHand,
});

/**
 * Read the analysed frame's dimensions from whatever the caller has.
 * Inline holds the <video> element; the worker path has plain numbers echoed
 * back from the frame request.
 */
export function imageSizeOf(source) {
    return {
        width: Number(source?.videoWidth ?? source?.width) || 0,
        height: Number(source?.videoHeight ?? source?.height) || 0,
    };
}
