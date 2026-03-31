/**
 * Camerastein — Dependency Injection
 *
 * Wires detection singletons together with minimal stubs for
 * Psychodeli-specific deps that don't exist in standalone mode.
 * The _dep() fallback in each class means missing deps are safe.
 */

(function () {
    // Minimal debug manager (logs to console in standalone mode)
    const debug = {
        info: (...args) => console.log('[camerastein]', ...args),
        warn: (...args) => console.warn('[camerastein]', ...args),
        logTransition: () => {},
        logSystem: (...args) => console.log('[system]', ...args),
    };

    // No-op stubs for Psychodeli systems that don't exist here
    const noopCollector = { recordPulse() {} };
    const noopBus = { state: {}, emit() {}, subscribe() { return () => {}; } };

    window.SharedCameraManager.init({
        headDetector:    window.HeadBobDetector,
        bodyDetector:    window.BodyMotionDetector,
        handDetector:    window.HandPoseDetector,
        debugManager:    debug,
        MediaPipeLoader: window.MediaPipeLoader,
        PoseLoader:      window.PoseLoader,
        HandsLoader:     window.HandsLoader,
        audioBus:        noopBus,
    });

    window.HeadBobDetector.init({
        cameraManager:   window.SharedCameraManager,
        debugManager:    debug,
        audioBus:        noopBus,
        pulseCollector:  noopCollector,
        mediaPipeLoader: window.MediaPipeLoader,
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

    // Expose debug for other modules
    window.debugManager = debug;
})();
