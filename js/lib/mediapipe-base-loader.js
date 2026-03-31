/**
 * MediaPipe Base Loader
 *
 * Shared base class for MediaPipe model loaders (FaceMesh, Pose, Hands).
 * Eliminates duplicated CDN loading, WebGL checking, script injection,
 * and initialization logic that was previously copy-pasted across
 * mediapipe-loader.js, pose-loader.js, and hands-loader.js.
 *
 * Adds:
 * - Initialization timeout (prevents silent hangs if model fails to load)
 * - Cached WebGL availability check (avoids creating throwaway canvases)
 * - Script tag cleanup on unload
 * - Consistent debugManager logging (no console.log)
 */

class MediaPipeBaseLoader {
    /**
     * @param {Object} options
     * @param {string} options.name - Human-readable model name (e.g. 'Face Mesh')
     * @param {string} options.cdnPath - CDN package path (e.g. '@mediapipe/face_mesh')
     * @param {string} options.scriptFile - Script filename (e.g. 'face_mesh.js')
     * @param {string} options.globalName - Global constructor name (e.g. 'FaceMesh')
     * @param {Object} options.config - Model configuration options
     * @param {number} [options.initTimeoutMs=30000] - Timeout for model initialization
     */
    constructor({ name, cdnPath, scriptFile, globalName, config, initTimeoutMs = 30000 }) {
        this.name = name;
        this.cdnPath = cdnPath;
        this.scriptFile = scriptFile;
        this.globalName = globalName;
        this.initTimeoutMs = initTimeoutMs;

        this.loaded = false;
        this.loading = false;
        this.loadPromise = null;
        this.model = null;
        this.workingCdnSource = null;
        this._scriptElement = null;  // Track injected script for cleanup

        this.cdnSources = [
            `https://cdn.jsdelivr.net/npm/${cdnPath}`,
            `https://unpkg.com/${cdnPath}`
        ];

        this.config = config || {};
    }

    /**
     * Check if WebGL is available (required for MediaPipe).
     * Result is cached after first check to avoid creating throwaway canvases.
     * @returns {boolean}
     */
    static isWebGLAvailable() {
        if (MediaPipeBaseLoader._webglAvailable !== undefined) {
            return MediaPipeBaseLoader._webglAvailable;
        }
        try {
            const canvas = document.createElement('canvas');
            MediaPipeBaseLoader._webglAvailable = !!(
                canvas.getContext('webgl2') || canvas.getContext('webgl')
            );
        } catch (e) {
            MediaPipeBaseLoader._webglAvailable = false;
        }
        return MediaPipeBaseLoader._webglAvailable;
    }

    /**
     * Load the MediaPipe model.
     * @returns {Promise<Object>} Initialized model instance
     */
    async load() {
        if (this.loaded && this.model) {
            return this.model;
        }

        if (this.loading) {
            return this.loadPromise;
        }

        if (!MediaPipeBaseLoader.isWebGLAvailable()) {
            throw new Error(`WebGL not available - MediaPipe ${this.name} requires WebGL`);
        }

        this.loading = true;
        this.loadPromise = this._doLoad();

        try {
            this.model = await this.loadPromise;
            this.loaded = true;
            return this.model;
        } finally {
            this.loading = false;
        }
    }

    /**
     * Internal load implementation with timeout protection.
     */
    async _doLoad() {
        window.debugManager?.info?.(`📦 Loading MediaPipe ${this.name}...`);
        const startTime = performance.now();

        // Try each CDN source
        let lastError = null;
        for (const baseUrl of this.cdnSources) {
            try {
                await this._loadFromCDN(baseUrl);
                this.workingCdnSource = baseUrl;
                break;
            } catch (e) {
                window.debugManager?.warn?.(`Failed to load ${this.name} from ${baseUrl}:`, e.message);
                lastError = e;
            }
        }

        // Check if constructor is now available
        if (typeof window[this.globalName] === 'undefined') {
            throw lastError || new Error(`Failed to load MediaPipe ${this.name} from all CDN sources`);
        }

        // Initialize model
        const cdnBase = this.workingCdnSource || this.cdnSources[0];
        const ModelConstructor = window[this.globalName];
        const model = new ModelConstructor({
            locateFile: (file) => `${cdnBase}/${file}`
        });

        model.setOptions(this.config);

        // Wait for model to load with timeout protection.
        // Without this, a failed blank-frame init hangs forever.
        await new Promise((resolve, reject) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error(
                        `MediaPipe ${this.name} initialization timed out after ${this.initTimeoutMs}ms`
                    ));
                }
            }, this.initTimeoutMs);

            model.onResults(() => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    resolve();
                }
            });

            // Send a blank frame to trigger initialization
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            model.send({ image: canvas }).catch((err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    reject(err);
                }
            });
        });

        const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
        window.debugManager?.info?.(`✅ MediaPipe ${this.name} loaded in ${loadTime}s`);

        return model;
    }

    /**
     * Load script from CDN.
     * @param {string} baseUrl
     * @returns {Promise<void>}
     */
    _loadFromCDN(baseUrl) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `${baseUrl}/${this.scriptFile}`;
            script.crossOrigin = 'anonymous';

            script.onload = () => {
                this._scriptElement = script;
                window.debugManager?.info?.(`📥 Loaded MediaPipe ${this.name} from ${baseUrl}`);
                resolve();
            };

            script.onerror = () => {
                // Clean up failed script tag
                if (script.parentNode) {
                    script.parentNode.removeChild(script);
                }
                reject(new Error(`Failed to load script from ${baseUrl}`));
            };

            document.head.appendChild(script);
        });
    }

    /**
     * Update configuration options.
     * If model is already loaded, applies options immediately.
     */
    setOptions(options) {
        this.config = { ...this.config, ...options };
        if (this.model) {
            this.model.setOptions(this.config);
        }
        window.debugManager?.info?.(`⚙️ MediaPipe ${this.name} options updated`);
    }

    /**
     * Unload and cleanup, including script tag removal.
     */
    unload() {
        if (this.model) {
            try {
                this.model.close();
            } catch (_) {
                // Best-effort cleanup
            }
            this.model = null;
        }

        // Remove injected script tag to free memory
        if (this._scriptElement && this._scriptElement.parentNode) {
            this._scriptElement.parentNode.removeChild(this._scriptElement);
            this._scriptElement = null;
        }

        this.loaded = false;
        this.loading = false;
        this.loadPromise = null;
        this.workingCdnSource = null;
    }
}

// Cache for WebGL check
MediaPipeBaseLoader._webglAvailable = undefined;

// Export for use by subclass loaders
window.MediaPipeBaseLoader = MediaPipeBaseLoader;
