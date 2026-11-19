/**
 * Camerastein — Tasks Vision Dependency Injection
 *
 * Alternative to init.js that wires Tasks Vision adapter loaders
 * instead of legacy MediaPipe loaders. Same DI pattern, same stubs
 * for Psychodeli-specific deps.
 *
 * Activated via: ?tasks-vision URL parameter
 */

import { DispatchingAdapter } from './tasks-vision/dispatching-adapter.js';
import { TasksVisionWorkerAdapter } from './tasks-vision/worker/worker-adapter.js';
import { createWorkerFrameFactory } from './tasks-vision/worker/worker-client.js';
import { initBlendshapeChannel } from './tasks-vision/blendshape-channel.js';
import { initFaceFeatureChannel } from './tasks-vision/face-feature-channel.js';
import { initFaceGestureChannel } from './tasks-vision/face-gesture-channel.js';

const debug = {
    info: (...args) => console.log('[camerastein:tasks-vision]', ...args),
    warn: (...args) => console.warn('[camerastein:tasks-vision]', ...args),
    logTransition: () => {},
    logSystem: (...args) => console.log('[system]', ...args),
};

const noopCollector = { recordPulse() {} };
const noopBus = { state: {}, emit() {}, subscribe() { return () => {}; } };

// Transport: inference runs in a Web Worker by default, so hand tracking can be
// given its own frame budget without stalling the page (roadmap item
// hands-first-tracking). Psychodeli's DispatchingAdapter decides once per camera
// start and latches to inline for the session if the worker fails. ?worker=0
// (or window.__mediapipeWorker = false before load) forces inline for an A/B.
// Psychodeli itself defaults the worker on only in Electron dev and on iOS; the
// lab defaults it on because measuring it is the point.
{
    const q = new URLSearchParams(location.search).get('worker');
    if (q === '0' || q === 'false') window.__mediapipeWorker = false;
    else if (typeof window.__mediapipeWorker === 'undefined') window.__mediapipeWorker = true;
}
// ?frameWidth=N downscales frames before they go to the worker (0 or absent =
// camera size). Toaster sends 640 px (renderer/tracking.js:96). Measured here
// 2026-11-19 on a 1280x960 fake camera, three alternating pairs under load 28-35:
// no difference the noise could not explain (hand 4.6-13.5 Hz either way), and
// MediaPipe resizes its input itself. So it stays off by default and on hand
// for a measurement on a quiet machine. Landmarks are normalized, and consumers
// read the frame size from the <video> (worker-client.js sourceWidth/sourceHeight).
const FRAME_WIDTH = (() => {
    const q = Number(new URLSearchParams(location.search).get('frameWidth'));
    return Number.isFinite(q) && q > 0 ? q : 0;
})();
const downscaledBitmap = async (source) => {
    const w = Number(source?.videoWidth ?? source?.width) || 0;
    const h = Number(source?.videoHeight ?? source?.height) || 0;
    if (FRAME_WIDTH > 0 && w > FRAME_WIDTH && h > 0) {
        try {
            return await createImageBitmap(source, {
                resizeWidth: FRAME_WIDTH,
                resizeHeight: Math.max(1, Math.round((h * FRAME_WIDTH) / w)),
                resizeQuality: 'low',
            });
        } catch (_) { /* resize options unsupported: send the full frame */ }
    }
    return createImageBitmap(source);
};
const adapter = new DispatchingAdapter({
    workerAdapterFactory: (opts) => new TasksVisionWorkerAdapter({
        ...opts,
        frameFactory: createWorkerFrameFactory({ bitmapFactory: downscaledBitmap }),
    }),
});
// Diagnostics: which transport this session actually runs ({transport, fallbackReason, ...}).
window.__mediapipeTransport = () => adapter.describe();

// Hand pacing: 'presence' (js/lib/hand-pacing.js) gives hands every tick while one
// was seen in the last 2 s and scouts at 4 Hz otherwise. The lab defaults to it;
// ?pacing=skip restores the every-6th-tick overlay for an A/B. Read live, so it
// can also be flipped from the console.
{
    const q = new URLSearchParams(location.search).get('pacing');
    if (q) window.__handPacing = q;
    else if (typeof window.__handPacing === 'undefined') window.__handPacing = 'presence';
}

window.SharedCameraManager.init({
    headDetector:    window.HeadBobDetector,
    bodyDetector:    window.BodyMotionDetector,
    handDetector:    window.HandPoseDetector,
    debugManager:    debug,
    MediaPipeLoader: adapter.createFaceLoader(),
    PoseLoader:      adapter.createPoseLoader(),
    HandsLoader:     adapter.createHandsLoader(),
    audioBus:        noopBus,
});

window.HeadBobDetector.init({
    cameraManager:   window.SharedCameraManager,
    debugManager:    debug,
    audioBus:        noopBus,
    pulseCollector:  noopCollector,
    mediaPipeLoader: adapter.createFaceLoader(), // for setOptions calls (no-op in shim)
});

window.BodyMotionDetector.init({
    cameraManager:  window.SharedCameraManager,
    headDetector:   window.HeadBobDetector,
    debugManager:   debug,
    audioBus:       noopBus,
    pulseCollector: noopCollector,
});

window.HandPoseDetector.init({
    cameraManager:   window.SharedCameraManager,
    debugManager:    debug,
    pulseCollector:  noopCollector,
});

// Register blendshape channel on MotionBus
initBlendshapeChannel();

// Camerastein is the recognition workbench: observe the shared semantic and
// gesture channels by default, while preserving explicit live overrides.
if (typeof window.__faceFeatureChannel === 'undefined') window.__faceFeatureChannel = true;
if (typeof window.__faceGestureChannel === 'undefined') window.__faceGestureChannel = true;

// Semantic face-feature channel (valence/jawOpen/brow/gaze + dynamics), shared
// contract with Psychodeli (FACE_FEATURE_CONTRACT.md). Registration is cheap and
// observation-only; flags can still be flipped live for A/B inspection.
initFaceFeatureChannel();
initFaceGestureChannel();

// Expose debug for other modules
window.debugManager = debug;

debug.info('Tasks Vision adapter initialized — face blendshapes enabled');
