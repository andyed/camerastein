/**
 * Tasks Vision Adapter — Creates loader objects that mimic the legacy
 * MediaPipeBaseLoader interface but internally use @mediapipe/tasks-vision.
 *
 * SharedCameraManager calls loader.load() → gets a model with
 * .onResults(callback) and .send({image}). The adapter returns shim
 * models that satisfy this interface.
 *
 * Usage:
 *   const adapter = new TasksVisionAdapter();
 *   const faceLoader = adapter.createFaceLoader();
 *   const poseLoader = adapter.createPoseLoader();
 *   const handsLoader = adapter.createHandsLoader();
 *   // Pass these to SharedCameraManager.init() instead of legacy loaders
 */

import { FaceLandmarkerShim } from './face-shim.js';
import { PoseLandmarkerShim } from './pose-shim.js';
import { HandLandmarkerShim } from './hand-shim.js';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';

const MODEL_URLS = {
    face: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    poseLite: `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    poseHeavy: `${MODEL_BASE}/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
    hands: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
};

export class TasksVisionAdapter {
    constructor() {
        this._vision = null;       // Shared FilesetResolver instance
        this._visionPromise = null; // Deduplication
        this._tasksVision = null;   // The imported module
    }

    /** Load the Tasks Vision WASM fileset (shared across all landmarkers). */
    async _ensureVision() {
        if (this._vision) return this._vision;
        if (this._visionPromise) return this._visionPromise;

        this._visionPromise = (async () => {
            // Dynamic import from CDN
            this._tasksVision = await import(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs'
            );
            this._vision = await this._tasksVision.FilesetResolver.forVisionTasks(WASM_CDN);
            return this._vision;
        })();

        return this._visionPromise;
    }

    /**
     * Create a loader that mimics MediaPipeLoader (FaceMesh).
     * Matches the interface: { load(), unload(), setOptions() }
     */
    createFaceLoader(options = {}) {
        const adapter = this;
        let shim = null;
        let loaded = false;

        return {
            loaded: false,
            loading: false,

            async load() {
                if (shim) return shim;
                this.loading = true;

                const vision = await adapter._ensureVision();
                const { FaceLandmarker } = adapter._tasksVision;

                let delegate = 'GPU';
                let landmarker;
                try {
                    landmarker = await FaceLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: MODEL_URLS.face, delegate },
                        runningMode: 'VIDEO',
                        numFaces: options.numFaces || 4,
                        outputFaceBlendshapes: true,
                    });
                } catch (e) {
                    // GPU delegate failed — fall back to CPU
                    window.debugManager?.warn?.('FaceLandmarker GPU failed, falling back to CPU:', e.message);
                    delegate = 'CPU';
                    landmarker = await FaceLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: MODEL_URLS.face, delegate },
                        runningMode: 'VIDEO',
                        numFaces: options.numFaces || 4,
                        outputFaceBlendshapes: true,
                    });
                }

                window.debugManager?.info?.(`FaceLandmarker loaded (${delegate} delegate)`);
                shim = new FaceLandmarkerShim(landmarker, {
                    // MediaPipe's public constant keeps the historical
                    // TESSELATION misspelling. Camerastein's provider-neutral
                    // payload uses the conventional spelling instead.
                    tessellation: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
                    contours: FaceLandmarker.FACE_LANDMARKS_CONTOURS,
                    faceOval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
                    lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
                    leftEye: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
                    rightEye: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
                    leftEyebrow: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
                    rightEyebrow: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
                    leftIris: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
                    rightIris: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
                });
                this.loaded = true;
                this.loading = false;
                return shim;
            },

            unload() {
                shim?.close();
                shim = null;
                this.loaded = false;
            },

            setOptions() {
                // Tasks Vision sets config at creation time
            }
        };
    }

    /**
     * Create a loader that mimics PoseLoader.
     */
    createPoseLoader(options = {}) {
        const adapter = this;
        let shim = null;

        return {
            loaded: false,
            loading: false,

            async load() {
                if (shim) return shim;
                this.loading = true;

                const vision = await adapter._ensureVision();
                const { PoseLandmarker } = adapter._tasksVision;

                const modelUrl = options.heavy ? MODEL_URLS.poseHeavy : MODEL_URLS.poseLite;
                let delegate = 'GPU';
                let landmarker;
                try {
                    landmarker = await PoseLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: modelUrl, delegate },
                        runningMode: 'VIDEO',
                        numPoses: options.numPoses || 1,
                    });
                } catch (e) {
                    window.debugManager?.warn?.('PoseLandmarker GPU failed, falling back to CPU:', e.message);
                    delegate = 'CPU';
                    landmarker = await PoseLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: modelUrl, delegate },
                        runningMode: 'VIDEO',
                        numPoses: options.numPoses || 1,
                    });
                }

                window.debugManager?.info?.(`PoseLandmarker loaded (${delegate} delegate, ${options.heavy ? 'heavy' : 'lite'})`);
                shim = new PoseLandmarkerShim(landmarker);
                this.loaded = true;
                this.loading = false;
                return shim;
            },

            unload() {
                shim?.close();
                shim = null;
                this.loaded = false;
            },

            setOptions() {}
        };
    }

    /**
     * Create a loader that mimics HandsLoader.
     */
    createHandsLoader(options = {}) {
        const adapter = this;
        let shim = null;

        return {
            loaded: false,
            loading: false,

            async load() {
                if (shim) return shim;
                this.loading = true;

                const vision = await adapter._ensureVision();
                const { HandLandmarker } = adapter._tasksVision;

                let delegate = 'GPU';
                let landmarker;
                try {
                    landmarker = await HandLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: MODEL_URLS.hands, delegate },
                        runningMode: 'VIDEO',
                        numHands: options.numHands || 2,
                    });
                } catch (e) {
                    window.debugManager?.warn?.('HandLandmarker GPU failed, falling back to CPU:', e.message);
                    delegate = 'CPU';
                    landmarker = await HandLandmarker.createFromOptions(vision, {
                        baseOptions: { modelAssetPath: MODEL_URLS.hands, delegate },
                        runningMode: 'VIDEO',
                        numHands: options.numHands || 2,
                    });
                }

                window.debugManager?.info?.(`HandLandmarker loaded (${delegate} delegate)`);
                shim = new HandLandmarkerShim(landmarker);
                this.loaded = true;
                this.loading = false;
                return shim;
            },

            unload() {
                shim?.close();
                shim = null;
                this.loaded = false;
            },

            setOptions() {}
        };
    }
}
