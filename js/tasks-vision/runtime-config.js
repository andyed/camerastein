/**
 * Tasks Vision runtime config — the asset URLs, in one place.
 *
 * CAMERASTEIN'S OWN COPY. Every other file in js/tasks-vision/ is kept
 * byte-identical with Psychodeli+ (see the sync commits); this one differs on
 * purpose. Psychodeli vendors MediaPipe locally so tracking runs offline;
 * Camerastein is a static page on GitHub Pages and loads the same pinned release
 * from jsDelivr and Google's model bucket.
 *
 * Same exports as Psychodeli's runtime-config.js, because the inline adapter
 * (adapter.js) and the worker transport (worker/) both read them: the worker is
 * handed these URLs in its init message, so both transports load byte-identical
 * assets from ONE definition.
 *
 * PINNED to @mediapipe/tasks-vision 0.10.35, the version Psychodeli vendors. The
 * bundle and the WASM fileset must stay on the SAME version. The unpinned URL
 * this replaced resolved to whatever jsDelivr called latest that day.
 */

export const TASKS_VISION_VERSION = '0.10.35';

const CDN_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';

export const WASM_BASE = `${CDN_BASE}/wasm`;
export const VISION_BUNDLE = `${CDN_BASE}/vision_bundle.mjs`;

export const MODEL_URLS = Object.freeze({
    face: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    poseLite: `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    poseHeavy: `${MODEL_BASE}/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
    hands: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
});

/** The asset bundle shape the worker's init message expects. */
export function workerAssets() {
    return {
        visionBundleUrl: VISION_BUNDLE,
        wasmBaseUrl: WASM_BASE,
        models: { ...MODEL_URLS },
    };
}
