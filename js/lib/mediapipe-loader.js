/**
 * MediaPipe Face Mesh Lazy Loader
 *
 * Loads MediaPipe Face Mesh library on demand (~3MB) to avoid
 * impacting initial page load. Uses CDN with fallback.
 *
 * Extends MediaPipeBaseLoader for shared CDN/init/timeout logic.
 *
 * @see docs/HEAD_BOB_DETECTION.md
 */

class MediaPipeLoader extends MediaPipeBaseLoader {
    constructor() {
        super({
            name: 'Face Mesh',
            cdnPath: '@mediapipe/face_mesh',
            scriptFile: 'face_mesh.js',
            globalName: 'FaceMesh',
            config: {
                maxNumFaces: 4,          // Support up to 4 people (party mode)
                refineLandmarks: false,  // Skip iris refinement for performance
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            }
        });

        // Alias for backward compatibility
        this.faceMesh = null;
    }

    async load() {
        const result = await super.load();
        this.faceMesh = this.model;
        return result;
    }

    unload() {
        super.unload();
        this.faceMesh = null;
    }
}

// Global singleton
window.MediaPipeLoader = new MediaPipeLoader();
