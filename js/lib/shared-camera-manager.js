/**
 * Shared Camera Manager
 *
 * Manages a single camera stream shared between HeadBobDetector and BodyMotionDetector.
 * Pre-loads both MediaPipe models for instant switching between modes.
 *
 * Benefits:
 * - Single camera permission request
 * - Instant switching between head/body modes (no reload delay)
 * - Both models stay resident (~7MB total)
 *
 * @see docs/BODY_MOTION_SPEC.md
 * @see docs/HEAD_BOB_DETECTION.md
 */

class SharedCameraManager {
    constructor() {
        this.videoElement = null;
        this.stream = null;
        this.active = false;
        this.preferredDeviceId = null;
        try {
            this.preferredDeviceId = localStorage.getItem('camera.preferredDeviceId') || null;
        } catch (_) {
            this.preferredDeviceId = null;
        }

        // Model references (stay loaded once initialized)
        this.faceMesh = null;
        this.pose = null;
        this.hands = null;
        this.faceMeshLoaded = false;
        this.poseLoaded = false;
        this.handsLoaded = false;

        // Current active processor
        this.activeMode = null;  // 'head' | 'body' | null (primary mode, exclusive)
        this._previousMode = null;  // Track previous mode for transition events

        // Hand tracking state — overlay (throttled) or primary (full rate)
        this._handOverlayActive = false;
        this._handOverlayCallback = null;
        this._handFrameCounter = 0;
        this._handPrimaryMode = false; // true when hands are the only active detector
        // Process hands every Nth frame in overlay mode. ~3Hz at 20fps base.
        // Mobile gets slower rate to preserve battery.
        this._handFrameSkip = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 12 : 6;

        // Callbacks for frame processing
        this.onFaceMeshResults = null;
        this.onPoseResults = null;

        // Frame processing
        this.animationFrameId = null;
        this.lastFrameTime = 0;
        // Mobile devices get lower base FPS to reduce GPU contention with main render loop.
        // 20fps is fine for desktop but causes frame drops/crashes on Android tablets.
        this._isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        this._baseFPS = this._isMobile ? 12 : 20;
        this.targetFPS = this._baseFPS;
        this._lastAdaptiveCheck = 0; // Timestamp for periodic FPS adaptation
        this.isManualMode = false; // Tracks if user explicitly chose a mode

        // Loading state
        this.loading = false;
        this.loadPromise = null;

        // Auto-switch state (only active if user has tried both modes)
        this.hasUsedHead = false;
        this.hasUsedBody = false;
        this.autoSwitchEnabled = false;  // True once both modes used

        // Confidence tracking for auto-switch
        this.currentConfidence = 1.0;
        this.lowConfidenceStart = null;  // Timestamp when confidence dropped
        this.lastSwitchTime = 0;         // Prevent rapid switching

        // Auto-switch config
        this.autoSwitchConfig = {
            confidenceThreshold: 0.3,    // Below this = low confidence
            sustainedLowMs: 2000,        // Must be low for this long to switch
            cooldownMs: 5000,            // Wait this long after switch before allowing another
            enabled: true,               // Master enable (was false)
            bodyProbeIntervalMs: 3000    // How often to peek at pose while in face mode
        };

        // Periodic body probe state — detects arm-waving while in face mode
        this._lastBodyProbeTime = 0;

        // Multi-Toggle Permission State
        // Both true = Auto-Switch
        // Only one true = Forced Mode
        // Both false = Disabled (idle at startup)
        this.permissions = {
            head: false,
            body: false,
            hand: false
        };

        // Dependencies injected via init() after all scripts load
        this._deps = {};
    }

    /**
     * Inject dependencies. Called from motion-init.js after all singletons exist.
     * Fallback: _dep() returns window[name] if init() hasn't been called yet.
     */
    init(deps = {}) {
        this._deps = deps;
    }

    /** Safe dependency access with window fallback */
    _dep(name) { return this._deps[name] || window[name]; }

    async listVideoInputs() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            return [];
        }

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d && d.kind === 'videoinput');
        } catch (_) {
            return [];
        }
    }

    getPreferredDeviceId() {
        return this.preferredDeviceId;
    }

    async setPreferredDeviceId(deviceId) {
        const nextId = deviceId || null;
        if (this.preferredDeviceId === nextId) {
            return;
        }

        this.preferredDeviceId = nextId;
        try {
            if (nextId) localStorage.setItem('camera.preferredDeviceId', nextId);
            else localStorage.removeItem('camera.preferredDeviceId');
        } catch (_) { }

        if (!this.activeMode) {
            return;
        }

        const mode = this.activeMode;
        const callback = this._getCallbackForMode(mode);

        this._stopStream();

        try {
            await this._startStream();
        } catch (err) {
            this._dep('debugManager')?.warn?.('Camera switch failed:', err?.message || String(err));
            throw err;
        }

        if (callback) {
            if (mode === 'head') {
                this.onFaceMeshResults = callback;
            } else if (mode === 'body') {
                this.onPoseResults = callback;
            }
        }
    }

    /**
     * Get the results callback for a given mode from the detector singletons.
     * This avoids relying on stored callbacks that get nulled during stopMode().
     * @param {'head' | 'body'} mode
     * @returns {Function|null}
     */
    _getCallbackForMode(mode) {
        if (mode === 'head') return this._dep('headDetector')?._onResults || null;
        if (mode === 'body') return this._dep('bodyDetector')?._onResults || null;
        return null;
    }

    /**
     * Emit a cameraModeChange event to the audio reactivity bus (and DOM for backward compat).
     * Camera transitions are instant + certain — no hysteresis needed.
     * @param {string|null} from - Previous mode ('head' | 'body' | null)
     * @param {string|null} to - New mode ('head' | 'body' | null)
     * @param {'manual' | 'auto-switch' | 'disabled'} reason
     */
    _emitModeChangeEvent(from, to, reason) {
        const payload = {
            from,
            to,
            reason,
            handOverlay: this._handOverlayActive,
            userEnergy: window.MotionBus?.state?.body?.energyLevel || window.MotionBus?.state?.rhythm?.energyLevel || 0,
            resistance: window.__skewMotionResistance || 0,
            t: performance.now()
        };

        // Bus event for AE consumption
        if (this._dep('audioBus')?.emit) {
            this._dep('audioBus').emit('cameraModeChange', payload);
        }

        // DOM event for backward compat
        window.dispatchEvent(new CustomEvent('camera-mode-switch', { detail: payload }));

        this._dep('debugManager')?.logTransition?.('camera', 'mode-change', { from: from || 'off', to: to || 'off', reason });
    }

    /**
     * Toggle permission for a specific mode.
     * Delegates to detector start()/stop() methods so internal detector state
     * (face size calibration, body state history, indicators) is properly managed.
     * @param {'head' | 'body'} mode
     */
    async togglePermission(mode) {
        // Hand tracking — can run as primary (full rate) or overlay (throttled)
        if (mode === 'hand') {
            this.permissions.hand = !this.permissions.hand;

            if (this.permissions.hand) {
                // Start hand detector
                try {
                    await this._dep('handDetector').start();
                } catch (err) {
                    this._dep('debugManager')?.warn?.('Hand tracking start failed:', err?.message || String(err));
                    this.permissions.hand = false;
                }

                // If no primary mode active, hands run at full frame rate (primary slot)
                if (!this.activeMode) {
                    this._handPrimaryMode = true;
                    this._dep('debugManager')?.info?.('🖐️ Hand tracking as primary (full frame rate)');
                }
            } else {
                this._dep('handDetector')?.stop();
                this._handPrimaryMode = false;

                // If no primary mode and no hand, stop the camera
                if (!this.activeMode) {
                    this.stopMode();
                }
            }

            // Sync activeEffects for UI
            if (this._dep('commandRegistry')?.activeEffects) {
                this._dep('commandRegistry').activeEffects['Hand Tracking'] = this.permissions.hand;
            }

            const status = this.permissions.hand ? 'ON' : 'OFF';
            const rate = this._handPrimaryMode ? 'primary' : 'overlay';
            const primaryLabel = this.activeMode || (this._handPrimaryMode ? 'hand' : 'off');
            if (this._dep('commandRegistry')?.showParameterIndicator) {
                this._dep('commandRegistry').showParameterIndicator(
                    `🖐️ Hand Tracking: ${status} (${rate}, ${primaryLabel})`
                );
            }
            return;
        }

        if (mode !== 'head' && mode !== 'body') return;

        // Toggle the specific permission
        this.permissions[mode] = !this.permissions[mode];

        const head = this.permissions.head;
        const body = this.permissions.body;

        this._dep('debugManager')?.info?.(`🎥 Camera Permissions Updated: Head=${head}, Body=${body}`);

        // 1. Both Enabled -> Auto-Switch
        if (head && body) {
            this._dep('debugManager')?.info?.('🔄 Both modes enabled -> Auto-Switch Active');
            const prevMode = this._previousMode;
            this.setAutoSwitch(true);
            this.hasUsedHead = true;
            this.hasUsedBody = true;
            this.autoSwitchEnabled = true;
            if (!this.activeMode) {
                // Nothing active yet — start head tracking via detector
                await this._startDetectorForMode('head');
            }
            this._emitModeChangeEvent(prevMode, this.activeMode, 'manual');
            // If already active, auto-switch is now on (set above)
            return;
        }

        // 2. Only Head Enabled -> Force Head
        if (head && !body) {
            this._dep('debugManager')?.info?.('👤 Only Head enabled -> Forcing Head Mode');
            const prevMode = this.activeMode;
            this.setAutoSwitch(false);
            if (this.activeMode === 'body') {
                this._stopDetectorState('body');
            }
            if (this.activeMode !== 'head') {
                await this._startDetectorForMode('head');
            }
            if (prevMode !== 'head') {
                this._emitModeChangeEvent(prevMode, 'head', 'manual');
            }
            return;
        }

        // 3. Only Body Enabled -> Force Body
        if (!head && body) {
            this._dep('debugManager')?.info?.('🕺 Only Body enabled -> Forcing Body Mode');
            const prevMode = this.activeMode;
            this.setAutoSwitch(false);
            if (this.activeMode === 'head') {
                this._stopDetectorState('head');
            }
            if (this.activeMode !== 'body') {
                await this._startDetectorForMode('body');
            }
            if (prevMode !== 'body') {
                this._emitModeChangeEvent(prevMode, 'body', 'manual');
            }
            return;
        }

        // 4. Both Disabled -> Stop Tracking
        if (!head && !body) {
            this._dep('debugManager')?.info?.('🛑 All modes disabled -> Stopping Camera');
            const prevMode = this.activeMode;
            this.setAutoSwitch(false);
            // Stop whichever detector is active
            if (this.activeMode === 'head' && this._dep('headDetector')?.active) {
                this._dep('headDetector').stop();
            } else if (this.activeMode === 'body' && this._dep('bodyDetector')?.active) {
                this._dep('bodyDetector').stop();
            } else {
                this.stopMode();
            }

            // If hand tracking is still active, promote to primary (full frame rate)
            if (this.permissions.hand && this._handOverlayActive) {
                this._handPrimaryMode = true;
                this.targetFPS = this._baseFPS;
                this._dep('debugManager')?.info?.('🖐️ Hand tracking promoted to primary (full frame rate)');
            } else if (!this.permissions.hand) {
                // No hand tracking either — stop camera entirely
                this.stopMode();
            }

            // Sync with Electron immediately if available
            if (this._dep('electronBridge') && typeof this._dep('electronBridge').reportEffectState === 'function') {
                this._dep('electronBridge').reportEffectState();
            }

            if (prevMode) {
                this._emitModeChangeEvent(prevMode, null, 'disabled');
            }
            return;
        }

        // Trigger report for any other state changes
        if (this._dep('electronBridge') && typeof this._dep('electronBridge').reportEffectState === 'function') {
            this._dep('electronBridge').reportEffectState();
        }
    }

    /**
     * Start a detector for the given mode, delegating to the detector's start()
     * which handles internal state setup and calls startMode() with the correct callback.
     * @param {'head' | 'body'} mode
     */
    async _startDetectorForMode(mode) {
        try {
            // Demote hands from primary to overlay when a head/body mode starts
            if (this._handPrimaryMode) {
                this._handPrimaryMode = false;
                this._dep('debugManager')?.info?.('🖐️ Hand tracking demoted to overlay (primary mode starting)');
                // Reduce FPS slightly for overlay sharing
                this.targetFPS = Math.max(10, Math.round(this._baseFPS * 0.85));
            }

            if (mode === 'head') {
                // HeadBobDetector.start() calls SharedCameraManager.startMode('head', this._onResults)
                await this._dep('headDetector').start();
            } else if (mode === 'body') {
                // BodyMotionDetector.start() calls SharedCameraManager.startMode('body', this._onResults)
                // It also stops head detector if active
                await this._dep('bodyDetector').start();
            }
        } catch (err) {
            this._dep('debugManager')?.warn?.(`Failed to start ${mode} detector:`, err?.message || String(err));
        }
    }

    /**
     * Stop a detector's internal state without killing the camera stream.
     * Used when switching modes via the permission system.
     * @param {'head' | 'body'} mode
     */
    _stopDetectorState(mode) {
        if (mode === 'head' && this._dep('headDetector')) {
            this._dep('headDetector').active = false;
            this._dep('headDetector').enabled = false;
            this._dep('headDetector').faceStates = [];
            this._dep('headDetector').faceSizeHistory = [];
            this._dep('headDetector').faceSizeCalibrated = false;
            this._dep('headDetector')._showIndicator?.(false);
            window.MotionBus?.emit('rhythmSync', null);
        } else if (mode === 'body' && this._dep('bodyDetector')) {
            this._dep('bodyDetector').active = false;
            this._dep('bodyDetector').enabled = false;
            this._dep('bodyDetector').bodyStates = [];
            this._dep('bodyDetector')._swayHistory = null;
            this._dep('bodyDetector')._bounceHistory = null;
            this._dep('bodyDetector')._showIndicator?.(false);
            window.MotionBus?.emit('bodyMotion', null);
        }
    }

    /**
     * Check if camera is available
     */
    isAvailable() {
        if (!navigator.mediaDevices?.getUserMedia) {
            this._dep('debugManager')?.warn?.('SharedCameraManager: getUserMedia not supported');
            return false;
        }

        // Check WebGL (required by MediaPipe)
        if (!SharedCameraManager._webglAvailable) {
            try {
                const c = document.createElement('canvas');
                SharedCameraManager._webglAvailable = !!(c.getContext('webgl2') || c.getContext('webgl'));
            } catch (_) {
                SharedCameraManager._webglAvailable = false;
            }
        }
        if (!SharedCameraManager._webglAvailable) {
            this._dep('debugManager')?.warn?.('SharedCameraManager: WebGL not available');
            return false;
        }

        return true;
    }

    /**
     * Initialize camera and load both models
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.active) return;

        if (this.loading) {
            return this.loadPromise;
        }

        this.loading = true;
        this.loadPromise = this._doInitialize();

        try {
            await this.loadPromise;
        } catch (err) {
            // 2026-06-11: a failed init left the persistent "Loading Face Tracking..."
            // indicator up forever and the failure invisible (console.warn is suppressed
            // here) — the user-facing half of the stuck-startup bug. Replace it with a
            // visible, non-persistent failure message; the retry path is a fresh
            // toggle (loading/loadPromise are cleared below, so it actually retries).
            try {
                this._dep('commandRegistry')?.showParameterIndicator?.(
                    `📷 Camera failed: ${err?.message || 'unknown error'} — toggle tracking to retry`, false);
            } catch (_) { }
            throw err;
        } finally {
            this.loading = false;
            this.loadPromise = null;
        }
    }

    _isFatalFrameError(error) {
        const details = [
            error?.name,
            error?.message,
            error?.stack,
            String(error)
        ]
            .filter(Boolean)
            .join(' | ')
            .toLowerCase();

        if (!details) {
            return false;
        }

        return (
            details.includes('abort(') ||
            details.includes('graph has errors') ||
            details.includes('calculatorgraph::run() failed') ||
            details.includes('roi width and height must be > 0') ||
            details.includes('input_frames_gpu was not ok') ||
            details.includes('teximage2d: no video') ||
            details.includes('framebuffer is incomplete')
        );
    }

    async _doInitialize() {
        this._dep('debugManager')?.logTransition('camera', 'initializing');
        const startTime = performance.now();

        if (!this.isAvailable()) {
            throw new Error('Camera not available on this device');
        }

        // Load models sequentially to avoid locateFile callback conflicts
        // (MediaPipe models share global state, parallel loading causes wrong CDN paths)
        this._dep('debugManager')?.logTransition('camera', 'model-load-facemesh', null, { minIntervalMs: 300 });
        if (!this.faceMeshLoaded && this._dep('commandRegistry')?.showParameterIndicator) {
            this._dep('commandRegistry').showParameterIndicator('Loading Face Tracking...', true);
        }
        this.faceMesh = await this._loadFaceMesh();
        this.faceMeshLoaded = !!this.faceMesh;

        this._dep('debugManager')?.logTransition('camera', 'model-load-pose', null, { minIntervalMs: 300 });
        if (!this.poseLoaded && this._dep('commandRegistry')?.showParameterIndicator) {
            this._dep('commandRegistry').showParameterIndicator('Loading Body Tracking...', true);
        }
        this.pose = await this._loadPose();
        this.poseLoaded = !!this.pose;

        this.active = true;

        const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
        this._dep('debugManager')?.logTransition('camera', 'ready', {
            loadSeconds: Number(loadTime),
            faceMesh: this.faceMeshLoaded,
            pose: this.poseLoaded
        }, {
            minIntervalMs: 300
        });
    }

    async _startStream() {
        if (this.stream && this.videoElement) {
            return;
        }

        this._dep('debugManager')?.logTransition('camera', 'stream-starting');

        const deviceInputs = await this.listVideoInputs();
        const deviceIds = (Array.isArray(deviceInputs) ? deviceInputs : [])
            .map(d => d?.deviceId)
            .filter(Boolean);

        const uniqueDeviceIds = [];
        const seen = new Set();
        if (this.preferredDeviceId) {
            uniqueDeviceIds.push(this.preferredDeviceId);
            seen.add(this.preferredDeviceId);
        }
        deviceIds.forEach(id => {
            if (!seen.has(id)) {
                seen.add(id);
                uniqueDeviceIds.push(id);
            }
        });

        const streamAttempts = [];
        uniqueDeviceIds.forEach(deviceId => {
            streamAttempts.push({
                constraints: {
                    video: {
                        deviceId: { exact: deviceId },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                },
                deviceId
            });
        });

        streamAttempts.push(
            {
                constraints: {
                    video: {
                        facingMode: { ideal: 'user' },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                },
                deviceId: null
            },
            {
                constraints: {
                    video: {
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                },
                deviceId: null
            },
            { constraints: { video: true }, deviceId: null }
        );

        let lastError = null;
        let lastNotFound = false;
        let preferredWasInvalid = false;

        for (let i = 0; i < streamAttempts.length; i++) {
            const attempt = streamAttempts[i];
            try {
                this.stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);

                this.videoElement = document.createElement('video');
                this.videoElement.srcObject = this.stream;
                this.videoElement.playsInline = true;
                this.videoElement.muted = true;
                this.videoElement.autoplay = true;
                this.videoElement.setAttribute('autoplay', '');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.style.position = 'fixed';
                this.videoElement.style.left = '-9999px';
                this.videoElement.style.top = '0';
                this.videoElement.style.width = '1px';
                this.videoElement.style.height = '1px';
                this.videoElement.style.opacity = '0';
                this.videoElement.style.pointerEvents = 'none';

                if (!this.videoElement.parentNode && document.body) {
                    document.body.appendChild(this.videoElement);
                }

                await new Promise((resolve, reject) => {
                    // 2026-06-11: TIMEOUT added — this wait had no failure path, and a
                    // stream that opens but never delivers metadata (camera half-held by
                    // another app/tab, post-sleep camera zombie) parked it FOREVER. With
                    // initialize() caching loadPromise, one hang poisoned every retry
                    // until reload — the "stuck in waiting for" bug. A rejection here
                    // flows into the attempt loop's existing catch (stream stopped, next
                    // constraint attempt tried, errors surfaced).
                    const metaTimeout = setTimeout(() => {
                        reject(new Error('Camera stream metadata never arrived (8s) — device busy or zombie stream'));
                    }, 8000);
                    this.videoElement.onloadedmetadata = () => {
                        clearTimeout(metaTimeout);
                        const playPromise = this.videoElement.play();
                        if (playPromise && typeof playPromise.then === 'function') {
                            playPromise.then(resolve).catch(reject);
                        } else {
                            resolve();
                        }
                    };
                });

                await new Promise((resolve, reject) => {
                    const start = performance.now();
                    const timeoutMs = 5000;

                    const checkReady = () => {
                        if (!this.videoElement) {
                            reject(new Error('Camera video element unavailable'));
                            return;
                        }

                        const hasDimensions = this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0;
                        const hasDecodedFrame = this.videoElement.currentTime > 0 || this.videoElement.readyState >= 3;

                        if (hasDimensions && hasDecodedFrame) {
                            resolve();
                            return;
                        }

                        if (performance.now() - start >= timeoutMs) {
                            reject(new Error('Camera stream started but produced no valid frames (0x0)'));
                            return;
                        }

                        requestAnimationFrame(checkReady);
                    };

                    checkReady();
                });

                if (attempt.deviceId) {
                    if (this.preferredDeviceId && attempt.deviceId !== this.preferredDeviceId) {
                        preferredWasInvalid = true;
                    }
                    this.preferredDeviceId = attempt.deviceId;
                    try {
                        localStorage.setItem('camera.preferredDeviceId', attempt.deviceId);
                    } catch (_) { }
                } else if (preferredWasInvalid) {
                    try {
                        localStorage.removeItem('camera.preferredDeviceId');
                    } catch (_) { }
                    this.preferredDeviceId = null;
                }

                this._dep('debugManager')?.logTransition('camera', 'stream-ready', {
                    width: this.videoElement.videoWidth,
                    height: this.videoElement.videoHeight,
                    currentTime: Number(this.videoElement.currentTime || 0)
                }, {
                    minIntervalMs: 300
                });

                return;
            } catch (err) {
                lastError = err;
                const errorDetails = [err?.name, err?.message, String(err)]
                    .filter(Boolean)
                    .join(' | ')
                    .toLowerCase();
                const isNotFound = err?.name === 'NotFoundError' || /Requested device not found/i.test(err?.message || '');
                const isPermissionDenied = (
                    err?.name === 'NotAllowedError' ||
                    err?.name === 'PermissionDeniedError' ||
                    errorDetails.includes('permission denied') ||
                    errorDetails.includes('notallowederror') ||
                    errorDetails.includes('denied')
                );
                const isNoFrames = /produced no valid frames/i.test(err?.message || '');

                this._stopStream();
                lastNotFound = isNotFound;

                if (isPermissionDenied) {
                    this._dep('debugManager')?.logTransition('camera', 'permission-denied', {
                        attempt: i + 1,
                        totalAttempts: streamAttempts.length,
                        name: err?.name || 'UnknownError',
                        message: err?.message || 'Camera permission denied'
                    }, {
                        minIntervalMs: 300
                    });
                    this._dep('debugManager')?.warn?.(
                        'Camera permission denied. Check macOS Settings > Privacy & Security > Camera and ensure Psychodeli+ is allowed.'
                    );
                    throw err;
                }

                if ((isNotFound || isNoFrames) && attempt.deviceId && attempt.deviceId === this.preferredDeviceId) {
                    try {
                        localStorage.removeItem('camera.preferredDeviceId');
                    } catch (_) { }
                    this.preferredDeviceId = null;
                }

                if (!(isNotFound || isNoFrames) || i === streamAttempts.length - 1) {
                    this._dep('debugManager')?.logTransition('camera', 'stream-failed', {
                        attempt: i + 1,
                        totalAttempts: streamAttempts.length,
                        name: err?.name || 'UnknownError',
                        message: err?.message || String(err)
                    }, {
                        minIntervalMs: 300
                    });
                    throw err;
                }

                this._dep('debugManager')?.logTransition('camera', 'stream-fallback', {
                    attempt: i + 2,
                    reason: err?.message || err?.name || 'NotFoundError'
                }, {
                    minIntervalMs: 300
                });
            }
        }

        if (!this.stream) {
            if (lastNotFound && this.preferredDeviceId) {
                try {
                    localStorage.removeItem('camera.preferredDeviceId');
                } catch (_) { }
                this.preferredDeviceId = null;
            }
            throw lastError || new Error('Failed to acquire camera stream');
        }
    }

    _deactivateTrackingCommandForMode(mode) {
        try {
            if (mode === 'head') {
                const command = this._dep('commandRegistry')?.commands?.['*'];
                if (command && typeof command.deactivate === 'function') {
                    command.deactivate({ silent: true });
                } else {
                    this._dep('headDetector')?.stop?.();
                }
                if (this._dep('commandRegistry')?.activeEffects) {
                    this._dep('commandRegistry').activeEffects['Head Tracking'] = false;
                }
            } else if (mode === 'body') {
                const command = this._dep('commandRegistry')?.commands?.['&'];
                if (command && typeof command.deactivate === 'function') {
                    command.deactivate({ silent: true });
                } else {
                    this._dep('bodyDetector')?.stop?.();
                }
                if (this._dep('commandRegistry')?.activeEffects) {
                    this._dep('commandRegistry').activeEffects['Body Tracking'] = false;
                }
            }
        } catch (_) {
            // Best-effort cleanup
        }
    }

    _stopStream() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.srcObject = null;
            if (this.videoElement.parentNode) {
                this.videoElement.parentNode.removeChild(this.videoElement);
            }
            this.videoElement = null;
        }

    }

    /**
     * Get frame source for MediaPipe processing.
     *
     * Passes the <video> element directly to MediaPipe instead of copying
     * each frame to an intermediate canvas. MediaPipe's .send({ image })
     * accepts HTMLVideoElement natively, which:
     * - Eliminates a drawImage() call per frame (CPU + GPU savings)
     * - Avoids allocating a persistent offscreen canvas (~1.2MB at 640x480)
     * - Reduces GPU memory pressure on mobile (fixes Android tablet crashes)
     * - Lets MediaPipe handle its own texture upload path (more efficient)
     */
    _getFrameSource() {
        if (!this.videoElement) {
            return null;
        }

        const width = this.videoElement.videoWidth || 0;
        const height = this.videoElement.videoHeight || 0;
        if (width <= 0 || height <= 0) {
            return null;
        }

        // MediaPipe accepts <video> elements directly — no canvas copy needed
        return this.videoElement;
    }

    /**
     * Load Face Mesh model
     */
    async _loadFaceMesh() {
        try {
            const faceMesh = await this._dep('MediaPipeLoader').load();
            faceMesh.onResults((results) => {
                if (this.activeMode === 'head' && this.onFaceMeshResults) {
                    this.onFaceMeshResults(results);
                }
            });
            return faceMesh;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Face Mesh:', e.message);
            return null;
        }
    }

    /**
     * Load Pose model
     */
    async _loadPose() {
        try {
            const pose = await this._dep('PoseLoader').load();
            pose.onResults((results) => {
                // Allow results if explicitly in Body Mode OR if we are Probing Body for activity
                if ((this.activeMode === 'body' || this.isProbingBody) && this.onPoseResults) {
                    this.onPoseResults(results);
                }
            });
            return pose;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Pose:', e.message);
            return null;
        }
    }

    /**
     * Load Hands model (lazy — only called on first ^ press).
     */
    async _loadHands() {
        try {
            if (!this._dep('HandsLoader')) {
                throw new Error('HandsLoader not available');
            }
            const hands = await this._dep('HandsLoader').load();
            hands.onResults((results) => {
                if (this._handOverlayActive && this._handOverlayCallback) {
                    this._handOverlayCallback(results);

                    // Feed debug canvas if enabled
                    if (this._dep('handDetector')?.drawDebug) {
                        this._dep('handDetector').drawDebug(results);
                    }
                }
            });
            return hands;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Hands:', e.message);
            return null;
        }
    }

    /**
     * Start hand overlay — runs concurrently with primary head/body mode.
     * Hands model is loaded lazily on first call.
     * @param {Function} resultsCallback - HandPoseDetector._onResults
     */
    async _startHandOverlay(resultsCallback) {
        if (this._handOverlayActive) return;

        // Ensure camera is streaming. If no primary mode has initialized,
        // just start the stream without loading face/pose models — hand-only
        // mode doesn't need them.
        if (!this.active) {
            if (!this.isAvailable()) {
                throw new Error('Camera not available on this device');
            }
            // Mark active without full initialize (skip face/pose model loading)
            this.active = true;
        }
        await this._startStream();

        // Lazy-load hands model on first activation
        if (!this.handsLoaded) {
            if (this._dep('commandRegistry')?.showParameterIndicator) {
                this._dep('commandRegistry').showParameterIndicator('Loading Hand Tracking...', true);
            }
            this.hands = await this._loadHands();
            this.handsLoaded = !!this.hands;
        }

        if (!this.handsLoaded || !this.hands) {
            throw new Error('Hand tracking model failed to load');
        }

        this._handOverlayCallback = resultsCallback;
        this._handOverlayActive = true;
        this._handFrameCounter = 0;

        if (!this.activeMode) {
            // No primary mode — hands run as primary at full frame rate.
            // Start the frame loop (normally started by startMode for head/body).
            this._handPrimaryMode = true;
            this.targetFPS = this._baseFPS;
            if (!this.animationFrameId) {
                this._startFrameLoop();
            }
            this._dep('debugManager')?.info?.('🖐️ Hand tracking started as primary (full frame rate)');
        } else {
            // Primary mode active — hands run as throttled overlay
            this._handPrimaryMode = false;
            this.targetFPS = Math.max(10, Math.round(this._baseFPS * 0.85));
        }

        this._dep('debugManager')?.logTransition?.('hand', 'overlay-started', { frameSkip: this._handFrameSkip });
    }

    /**
     * Stop hand overlay — primary mode continues unaffected.
     */
    _stopHandOverlay() {
        if (!this._handOverlayActive) return;

        this._handOverlayActive = false;
        this._handOverlayCallback = null;
        this._handFrameCounter = 0;

        // Restore primary FPS
        this.targetFPS = this._baseFPS;

        this._dep('debugManager')?.logTransition?.('hand', 'overlay-stopped');
    }

    /**
     * Start processing frames with specified mode
     * @param {'head' | 'body'} mode
     * @param {Function} resultsCallback
     * @param {boolean} isAutoSwitch - True if triggered by auto-switch (skip cooldown reset)
     */
    async startMode(mode, resultsCallback, isAutoSwitch = false) {
        if (!this.active) {
            await this.initialize();
        }

        await this._startStream();

        // Respect permission toggles — never activate a mode the user disabled.
        // permissions are set by togglePermission() BEFORE startMode() is called,
        // so this is safe even for the initial activation path.
        if (this.permissions[mode] === false) {
            this._dep('debugManager')?.info?.(`🚫 startMode('${mode}') blocked: permission disabled`);
            return;
        }

        // Apply manual intent immediately
        this.isManualMode = !isAutoSwitch;

        // -------------------------------------------------------------------------
        // ACTIVE PEEK LOGIC: Verify Body Activity before full switch
        // -------------------------------------------------------------------------
        // Before switching from Head → Body, briefly suppress face mesh and run
        // a few pose frames to verify the user is actually making big arm movements.
        // This prevents shoulder micro-movements and head weaving from triggering
        // body mode while seated.
        //
        // Works for BOTH manual toggle and auto-switch attempts.
        // Auto-switch gets a shorter probe window (500ms) since it's already
        // waited through the confidence timeout.
        // Only probe when both modes are permitted (auto-switch scenario).
        // When the user explicitly chose body-only (permissions.head=false),
        // skip the probe — don't make them prove they're dancing.
        if (mode === 'body' && this.activeMode === 'head' && !this.isProbingBody
            && this.permissions.head && this.permissions.body) {
            const probeTimeout = isAutoSwitch ? 500 : 1000;
            this._dep('debugManager')?.info?.(`👀 Peeking Body Mode (${isAutoSwitch ? 'auto' : 'manual'}, ${probeTimeout}ms window)...`);
            this.isProbingBody = true;
            this.probeStartTime = performance.now();
            this._probeIsAutoSwitch = isAutoSwitch;

            // Hook up results callback temporarily so we get data
            this.onPoseResults = resultsCallback;

            // Auto-cancel probe if no big arm activity found
            setTimeout(() => {
                if (this.isProbingBody) {
                    this._dep('debugManager')?.info?.('❌ Peek failed: No significant body action. Reverting.');
                    this.isProbingBody = false;
                    this._probeIsAutoSwitch = false;
                    // Reset low-confidence timer so we don't immediately re-trigger
                    this.lowConfidenceStart = null;
                    this.lastSwitchTime = performance.now();
                    // If we were in head mode AND it's still permitted, ensure it's fully active
                    if (this.activeMode === 'head' && this.permissions.head) {
                        this._syncDetectorState('head');
                    }
                }
            }, probeTimeout);
            return; // Exit here. Loop will handle the probe.
        }

        // Validate mode is available BEFORE setting active state
        // This prevents "Stuck Mode" where activeMode is set but model fails to load/run
        if (mode === 'head' && !this.faceMeshLoaded) {
            throw new Error('Face Mesh model not available');
        }
        if (mode === 'body' && !this.poseLoaded) {
            throw new Error('Pose model not available');
        }

        // Apply mode
        const wasActive = this.activeMode !== null;
        this._previousMode = this.activeMode;
        this.activeMode = mode;

        // If we were probing, we are now committed to a mode.
        if (this.isProbingBody) {
            this.isProbingBody = false;
        }

        // Sync detector states (wakes up HeadBobDetector or BodyMotionDetector)
        this._syncDetectorState(mode);

        // Track which modes user has tried (for auto-switch eligibility)
        if (mode === 'head') {
            this.hasUsedHead = true;
            this.onFaceMeshResults = resultsCallback;
        } else {
            this.hasUsedBody = true;
            this.onPoseResults = resultsCallback;
        }

        // Enable auto-switch once user has tried both modes
        if (this.hasUsedHead && this.hasUsedBody && !this.autoSwitchEnabled) {
            this.autoSwitchEnabled = true;
            this._dep('debugManager')?.logTransition('camera', 'auto-switch-eligible');
        }

        // Reset confidence tracking on mode change
        this.currentConfidence = 1.0;
        this.lowConfidenceStart = null;
        this.lastBodyActivity = null; // Reset inactivity timer

        if (!isAutoSwitch) {
            this.lastSwitchTime = performance.now();
        }

        // Start frame processing if not already running.
        // Always restart if the loop died (animationFrameId cleared).
        if (!wasActive || !this.animationFrameId) {
            this._startFrameLoop();
        }

        const switchType = isAutoSwitch ? 'auto-switch' : (this.isManualMode ? 'manual switch' : 'instant switch');
        this._dep('debugManager')?.logTransition('camera', 'mode-changed', {
            mode,
            switchType,
            manual: this.isManualMode
        }, {
            minIntervalMs: 300
        });
    }

    /**
     * Unify detector state synchronization
     * @param {'head' | 'body' | null} mode 
     */
    _syncDetectorState(mode) {
        // Handle Head Mode
        if (this._dep('headDetector')) {
            const shouldBeActive = mode === 'head';
            if (this._dep('headDetector').active !== shouldBeActive) {
                this._dep('headDetector').active = shouldBeActive;
                this._dep('headDetector').enabled = shouldBeActive;
                this._dep('headDetector')._showIndicator?.(shouldBeActive);
                if (!shouldBeActive) window.MotionBus?.emit('rhythmSync', null);
            }
        }

        // Handle Body Mode
        if (this._dep('bodyDetector')) {
            const shouldBeActive = mode === 'body' || this.isProbingBody;
            if (this._dep('bodyDetector').active !== shouldBeActive) {
                this._dep('bodyDetector').active = shouldBeActive;
                this._dep('bodyDetector').enabled = shouldBeActive;
                this._dep('bodyDetector')._showIndicator?.(shouldBeActive);
                if (!shouldBeActive) window.MotionBus?.emit('bodyMotion', null);
            }
        }
    }

    /**
     * Stop current mode (keep models loaded).
     * Callbacks are preserved so they survive stop/restart cycles.
     * They are only nulled in shutdown().
     */
    stopMode() {
        this._previousMode = this.activeMode;
        this.activeMode = null;
        this.isManualMode = false;
        this._syncDetectorState(null);

        // NOTE: Do NOT null callbacks here — they need to survive mode switches.
        // Callbacks are only nulled in shutdown().

        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        this._stopStream();

        this._dep('debugManager')?.logTransition('camera', 'paused', 'models-cached');
    }

    /**
     * Fully shutdown and release all resources
     */
    shutdown() {
        this.stopMode();

        // Stop hand overlay if active
        this._stopHandOverlay();
        this._dep('handDetector')?.stop();

        // Null callbacks only on full shutdown (not in stopMode)
        this.onFaceMeshResults = null;
        this.onPoseResults = null;

        // Stop camera stream (full shutdown)
        this._stopStream();

        // Unload models
        if (this._dep('MediaPipeLoader')) {
            this._dep('MediaPipeLoader').unload();
        }
        if (this._dep('PoseLoader')) {
            this._dep('PoseLoader').unload();
        }
        if (this._dep('HandsLoader')) {
            this._dep('HandsLoader').unload();
        }

        this.faceMesh = null;
        this.pose = null;
        this.hands = null;
        this.faceMeshLoaded = false;
        this.poseLoaded = false;
        this.handsLoaded = false;
        this.active = false;
        this.lastFrameTime = 0;

        this._dep('debugManager')?.logTransition('camera', 'shutdown');
    }

    /**
     * Frame processing loop
     */
    _startFrameLoop() {
        const processFrame = async () => {
            if (!this.activeMode && !this._handOverlayActive) {
                // No active mode and no overlay — stop loop.
                // But if permissions are still on, keep polling so toggling works
                // without needing to restart the loop from scratch.
                if (this.permissions.head || this.permissions.body) {
                    this.animationFrameId = requestAnimationFrame(processFrame);
                }
                return;
            }
            if (!this.videoElement) {
                this.animationFrameId = requestAnimationFrame(processFrame);
                return;
            }

            if (
                this.videoElement.readyState < 2 ||
                this.videoElement.videoWidth <= 0 ||
                this.videoElement.videoHeight <= 0 ||
                (this.videoElement.currentTime <= 0 && this.videoElement.readyState < 3)
            ) {
                this.animationFrameId = requestAnimationFrame(processFrame);
                return;
            }

            const now = performance.now();

            // Adaptive camera FPS: reduce processing rate when main render FPS drops.
            // Check every 2 seconds to avoid thrashing.
            if (now - this._lastAdaptiveCheck > 2000) {
                this._lastAdaptiveCheck = now;
                let mainFPS = 0;
                if (typeof window.getFPS === 'function') {
                    const f = window.getFPS();
                    if (typeof f === 'number' && isFinite(f)) mainFPS = f;
                }
                if (mainFPS > 0 && mainFPS < 50) {
                    // Under 50 FPS: halve camera rate to reduce CPU/GPU contention
                    this.targetFPS = Math.max(5, Math.round(this._baseFPS / 2));
                } else {
                    // FPS healthy: restore base rate
                    this.targetFPS = this._baseFPS;
                }
            }

            const frameInterval = 1000 / this.targetFPS;

            if (now - this.lastFrameTime >= frameInterval) {
                this.lastFrameTime = now;

                const frameSource = this._getFrameSource();
                if (!frameSource) {
                    this.animationFrameId = requestAnimationFrame(processFrame);
                    return;
                }

                try {
                    // Head Mode (Primary) - Only run if NOT probing body
                    if (this.activeMode === 'head' && this.faceMesh && !this.isProbingBody) {
                        await this.faceMesh.send({ image: frameSource });

                        // Periodic body probe: while in face mode with auto-switch on,
                        // peek at pose every few seconds to detect arm-waving.
                        // Without this, face→body switch only triggers on low face confidence,
                        // meaning waving arms while face is visible never triggers a switch.
                        if (this.autoSwitchEnabled && this.autoSwitchConfig.enabled &&
                            this.permissions.head && this.permissions.body &&
                            this.poseLoaded && this.pose &&
                            now - this._lastBodyProbeTime > this.autoSwitchConfig.bodyProbeIntervalMs &&
                            now - this.lastSwitchTime > this.autoSwitchConfig.cooldownMs) {
                            this._lastBodyProbeTime = now;

                            // Trigger a 300ms burst of body frames (handled by the "Probing" block below)
                            // This provides consecutive frames for velocity calculation (dt ~50ms),
                            // unlike the single-frame snapshot which result in dt ~3000ms.
                            if (!this.isProbingBody) {
                                this._dep('debugManager')?.info?.('👀 Triggering periodic body probe (300ms)...');
                                this.isProbingBody = true;
                                this.probeStartTime = now;
                                this._probeIsAutoSwitch = true;

                                // Hook up callback
                                const poseCallback = this._getCallbackForMode('body');
                                if (poseCallback) this.onPoseResults = poseCallback;

                                // Auto-cancel after 300ms (handled by existing timeout logic in startMode? 
                                // No, we need to set the timeout here since we aren't calling startMode yet)
                                setTimeout(() => {
                                    if (this.isProbingBody) {
                                        // console.log('❌ Probe finished (no switch triggered).'); 
                                        this.isProbingBody = false;
                                        this._probeIsAutoSwitch = false;
                                        // Restore Head callback if we didn't switch
                                        if (this.activeMode === 'head') {
                                            this._syncDetectorState('head');
                                        }
                                    }
                                }, 500);
                            }
                        }
                    }

                    // Body Mode OR Probing - Run Pose
                    if ((this.activeMode === 'body' || this.isProbingBody) && this.pose) {
                        await this.pose.send({ image: frameSource });

                        // Active Probe Logic: Check results immediately
                        if (this.isProbingBody) {
                            const bs = this._dep('bodyDetector')?.state;

                            // Align thresholds with strict auto-switch logic
                            // If sitting, we need huge movement (2.5+) to confirm it's not just typing/jitter.
                            // If standing, 0.8 is fine.
                            const sittingNoise = bs?.isSitting ? 2.5 : 0.8;
                            const elbowThreshold = sittingNoise * 0.4;

                            const isSignificantMove = (bs?.wristVelocity > sittingNoise) && (bs?.elbowVelocity > elbowThreshold);

                            if (bs && (isSignificantMove || bs.armsRaised)) {
                                const wasAutoSwitch = this._probeIsAutoSwitch;
                                this._probeIsAutoSwitch = false;
                                this._dep('debugManager')?.info?.(`✅ Peek confirmed: Switching to Body Mode! (${wasAutoSwitch ? 'auto' : 'manual'})`);
                                // Commit to switch — pass isAutoSwitch through so cooldown is set correctly
                                this.startMode('body', this.onPoseResults, wasAutoSwitch);
                            }
                        }
                    }

                    // Hand tracking — full rate when primary, throttled when overlay.
                    // Separate try/catch so hand errors never affect primary tracking.
                    if (this._handOverlayActive && this.hands) {
                        // Primary mode: process every frame. Overlay mode: every Nth frame.
                        const shouldProcess = this._handPrimaryMode
                            || (++this._handFrameCounter >= this._handFrameSkip && (this._handFrameCounter = 0, true));
                        if (shouldProcess) {
                            try {
                                await this.hands.send({ image: frameSource });
                            } catch (handErr) {
                                const msg = handErr?.message || String(handErr);
                                if (this._isFatalFrameError(handErr)) {
                                    this._dep('debugManager')?.warn?.('🖐️ Hand tracking fatal error, disabling:', msg);
                                    this._stopHandOverlay();
                                    this.permissions.hand = false;
                                    this._handPrimaryMode = false;
                                    this._dep('handDetector')?.stop();
                                }
                            }
                        }
                    }
                } catch (e) {
                    const errorMessage = e?.message || String(e);
                    const isFatal = this._isFatalFrameError(e);

                    if (isFatal) {
                        const failedMode = this.activeMode;
                        this._dep('debugManager')?.warn?.('Fatal frame processing error; stopping tracking mode:', errorMessage);
                        this.shutdown();
                        this._deactivateTrackingCommandForMode(failedMode);
                        return;
                    }

                    this._dep('debugManager')?.warn?.('Frame processing error:', errorMessage);
                }
            }

            this.animationFrameId = requestAnimationFrame(processFrame);
        };

        this.animationFrameId = requestAnimationFrame(processFrame);
    }

    /**
     * Report confidence from current detector
     * Called by HeadBobDetector or BodyMotionDetector each frame
     * @param {number} confidence - 0 to 1 confidence value
     */
    reportConfidence(confidence) {
        this.currentConfidence = confidence;
        const now = performance.now();

        // If Manual Mode is set, we still process the confidence but we treat
        // it as a "Permission" (we don't shut down the camera).
        // However, we still allow auto-switching between modes if inactive.
        if (this.isManualMode) {
            // No early return here - let auto-switch logic run so user isn't "stuck"
        }

        // Only run auto-switch logic when both modes are permitted.
        // If the user has explicitly disabled a mode via permissions toggle,
        // respect that choice — don't auto-switch into a disabled mode.
        if (!this.permissions.head || !this.permissions.body) {
            return;
        }
        if (this.activeMode !== 'body' && (!this.autoSwitchEnabled || !this.autoSwitchConfig.enabled)) {
            return;
        }

        const config = this.autoSwitchConfig;

        // Check cooldown
        if (now - this.lastSwitchTime < config.cooldownMs) {
            return;
        }

        // Smart posture-based switching (sitting/standing detection)
        // Body mode: if sitting detected, switch to head (better for desk use)
        // Head mode: if low confidence (face not visible), switch to body
        let shouldSwitch = false;
        let switchReason = '';

        if (this.activeMode === 'body') {
            // Auto-return to Face Mode if arms are inactive
            const bodyState = this._dep('bodyDetector')?.state;

            // Activity check for auto-switch must be ABOVE the sitting noise floor.
            // MediaPipe pose jitter produces wristVelocity ~0.3-0.8 when sitting still,
            // especially with shoulder micro-movements and breathing. We need a much
            // higher bar than the visual reactivity thresholds to avoid keeping users
            // stuck in body mode when they're just sitting at their desk.
            // armActivity threshold is too sensitive for switch decisions — it's meant
            // for visual reactivity where false positives are fine.
            // UPDATE: Typing can hit ~1.9 wrist velocity. Raised to 2.5.
            const sittingNoise = bodyState?.isSitting ? 2.5 : 0.8;
            // NEW: Require ELBOW movement too.
            // Typing = High Wrist Vel, Low Elbow Vel.
            // Dancing = High Wrist Vel, High Elbow Vel.
            // Elbow threshold can be lower (shoulders/elbows move less than wrists)
            // UPDATE: Increased elbow requirement ratio to 0.4.
            const elbowThreshold = sittingNoise * 0.4;

            const isArmActivity = (bodyState?.wristVelocity > sittingNoise) && (bodyState?.elbowVelocity > elbowThreshold);
            const isActive = isArmActivity || bodyState?.armsRaised;

            if (isActive) {
                // console.log(`[AutoSwitch] ACtive! Vel: ${bodyState?.wristVelocity.toFixed(3)} (>${sittingNoise}), Sitting: ${bodyState?.isSitting}`);
                this.lastBodyActivity = now;
            } else {
                // Initialize if missing
                if (!this.lastBodyActivity) this.lastBodyActivity = now;

                // Adaptive Timeout: 
                // Sitting: 2.5s (was 1.5s) - give more breathing room
                // Standing: 5s 
                const isSitting = bodyState?.isSitting;
                const timeout = isSitting ? 2500 : 5000;

                // Debug log every second to see countdown
                if (Math.random() < 0.05) {
                    this._dep('debugManager')?.info?.(`[AutoSwitch] Inactive for ${(now - this.lastBodyActivity).toFixed(0)}ms (Timeout: ${timeout}ms). Vel: ${bodyState?.wristVelocity?.toFixed(3)}`);
                }

                if (now - this.lastBodyActivity > timeout) {
                    shouldSwitch = true;
                    switchReason = isSitting ? 'sitting inactive' : 'arms inactive';
                }
            }

            // Sit detection explicitly ignored (handled by inactivity above)
            this.sittingDetectedStart = null;

            // Check low confidence as fallback
            if (confidence < config.confidenceThreshold) {
                if (!this.lowConfidenceStart) {
                    this.lowConfidenceStart = now;
                } else if (now - this.lowConfidenceStart >= config.sustainedLowMs) {
                    shouldSwitch = true;
                    switchReason = 'low confidence';
                }
            } else {
                this.lowConfidenceStart = null;
            }
        } else if (this.activeMode === 'head') {
            // Head mode: switch to body on low confidence (face not visible)
            if (confidence < config.confidenceThreshold) {
                if (!this.lowConfidenceStart) {
                    this.lowConfidenceStart = now;
                } else if (now - this.lowConfidenceStart >= config.sustainedLowMs) {
                    shouldSwitch = true;
                    switchReason = 'face not visible';
                }
            } else {
                this.lowConfidenceStart = null;
            }
        }

        if (shouldSwitch) {
            this._triggerAutoSwitch(switchReason);
        }
    }

    /**
     * Trigger automatic mode switch
     * @param {string} reason - Why the switch is happening
     */
    _triggerAutoSwitch(reason = 'low confidence') {
        const newMode = this.activeMode === 'head' ? 'body' : 'head';

        // Respect user's permission toggles — never switch into a disabled mode
        if (!this.permissions[newMode]) {
            return;
        }

        // Check if target mode is available
        if (newMode === 'head' && !this.faceMeshLoaded) return;
        if (newMode === 'body' && !this.poseLoaded) return;

        // Perform the switch via startMode (isAutoSwitch = true)
        // Use _getCallbackForMode to lazily fetch from detector instances (survives stopMode nulling)
        const callback = this._getCallbackForMode(newMode) || (newMode === 'head' ? this.onFaceMeshResults : this.onPoseResults);
        this.startMode(newMode, callback, true).catch(err => {
            this._dep('debugManager')?.warn?.(`[AutoSwitch] Failed to switch to ${newMode}:`, err?.message || String(err));
            // Optional: Disable auto-switch if it keeps failing?
            // this.setAutoSwitch(false); 
        });

        // Emit transition event (bus + DOM)
        this._emitModeChangeEvent(this._previousMode, newMode, 'auto-switch');
    }

    /**
     * Enable/disable auto-switching
     * @param {boolean} enabled
     */
    setAutoSwitch(enabled) {
        this.autoSwitchConfig.enabled = enabled;
        this._dep('debugManager')?.logTransition('camera', `auto-switch-${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            active: this.active,
            mode: this.activeMode,
            faceMeshLoaded: this.faceMeshLoaded,
            poseLoaded: this.poseLoaded,
            handsLoaded: this.handsLoaded,
            handOverlay: this._handOverlayActive,
            videoReady: !!this.videoElement?.srcObject,
            autoSwitch: {
                eligible: this.autoSwitchEnabled,
                enabled: this.autoSwitchConfig.enabled,
                confidence: this.currentConfidence,
                hasUsedHead: this.hasUsedHead,
                hasUsedBody: this.hasUsedBody
            }
        };
    }
}

// Global singleton
window.SharedCameraManager = new SharedCameraManager();
