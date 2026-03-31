/**
 * MediaPipe Pose Lazy Loader
 *
 * Loads MediaPipe Pose library on demand (~4MB) for full body tracking.
 * Mutually exclusive with Face Mesh (gaze mode).
 *
 * Extends MediaPipeBaseLoader for shared CDN/init/timeout logic.
 *
 * @see docs/BODY_MOTION_SPEC.md
 */

class PoseLoader extends MediaPipeBaseLoader {
    constructor() {
        super({
            name: 'Pose',
            cdnPath: '@mediapipe/pose',
            scriptFile: 'pose.js',
            globalName: 'Pose',
            config: {
                modelComplexity: 1,          // 0=lite, 1=full, 2=heavy
                smoothLandmarks: true,
                enableSegmentation: false,   // Don't need background segmentation
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            }
        });

        // Alias for backward compatibility
        this.pose = null;
    }

    async load() {
        const result = await super.load();
        this.pose = this.model;
        return result;
    }

    unload() {
        super.unload();
        this.pose = null;
    }
}

// Global singleton
window.PoseLoader = new PoseLoader();
