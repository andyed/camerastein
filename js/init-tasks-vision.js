/**
 * Camerastein — Tasks Vision Dependency Injection
 *
 * Alternative to init.js that wires Tasks Vision adapter loaders
 * instead of legacy MediaPipe loaders. Same DI pattern, same stubs
 * for Psychodeli-specific deps.
 *
 * Activated via: ?tasks-vision URL parameter
 */

import { TasksVisionAdapter } from './tasks-vision/adapter.js';
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

// Create adapter and loader factories
const adapter = new TasksVisionAdapter();

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
