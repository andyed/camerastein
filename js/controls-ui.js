/**
 * ControlsUI — Wires #controls-bar HTML elements to SharedCameraManager.
 *
 * Manages toggle buttons (head/body/hand), camera device picker,
 * FPS counter, mode indicator, and error display.
 */

export class ControlsUI {
    constructor() {
        // Toggle buttons
        this.btnHead = document.getElementById('btn-head');
        this.btnBody = document.getElementById('btn-body');
        this.btnHand = document.getElementById('btn-hand');

        // Camera picker
        this.cameraSelect = document.getElementById('camera-select');

        // Display elements
        this.fpsDisplay = document.getElementById('fps-display');
        this.modeIndicator = document.getElementById('mode-indicator');
        this.errorDisplay = document.getElementById('error-display');

        // FPS tracking state
        this._frameTimes = [];
        this._lastFpsUpdate = 0;

        this._wireToggleButtons();
        this._wireKeyboardBindings();
        this._wireVideoOverlay();
        this._populateCameraSelect();
        this._startFpsCounter();
        this._startStatePoller();
    }

    // --- Toggle Buttons ---

    _wireToggleButtons() {
        this.btnHead.addEventListener('click', () => this._handleToggle('head'));
        this.btnBody.addEventListener('click', () => this._handleToggle('body'));
        this.btnHand.addEventListener('click', () => this._handleToggle('hand'));
    }

    // --- Keyboard Bindings (shared with Psychodeli+) ---

    _wireKeyboardBindings() {
        if (!window.CameraCommands) return;
        window.CameraCommands.installKeyboardBindings({
            onToggle: ({ perms, message }) => {
                this._syncButtonState();
                this.modeIndicator.textContent = message;
            }
        });
    }

    // --- Video Overlay Toggle ---

    _wireVideoOverlay() {
        const cb = document.getElementById('cb-video-overlay');
        const video = document.getElementById('video-feed');
        if (!cb || !video) return;
        cb.addEventListener('change', () => {
            video.style.display = cb.checked ? '' : 'none';
        });
    }

    async _handleToggle(mode) {
        const mgr = window.SharedCameraManager;
        if (!mgr) return;

        try {
            await mgr.togglePermission(mode);
            this._syncButtonState();
        } catch (err) {
            this._showError(err.message || String(err));
        }
    }

    /**
     * Sync .active class on buttons to match SharedCameraManager state.
     * Head and Body are mutually exclusive for the active visual;
     * Hand can be active alongside either.
     */
    _syncButtonState() {
        const mgr = window.SharedCameraManager;
        if (!mgr) return;

        const perms = mgr.permissions || {};

        // Reflect actual permission state — SharedCameraManager may
        // auto-enable head when hand is toggled on (needs a primary mode)
        this.btnHead.classList.toggle('active', !!perms.head);
        this.btnBody.classList.toggle('active', !!perms.body);
        this.btnHand.classList.toggle('active', !!perms.hand);
    }

    // --- Camera Device Picker ---

    async _populateCameraSelect() {
        const mgr = window.SharedCameraManager;
        if (!mgr) return;

        try {
            const devices = await mgr.listVideoInputs();
            // Keep the placeholder option, add device options after it
            for (let i = 0; i < devices.length; i++) {
                const device = devices[i];
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Camera ${i + 1}`;
                this.cameraSelect.appendChild(option);
            }

            // Pre-select saved preference
            const saved = localStorage.getItem('camera.preferredDeviceId');
            if (saved) {
                this.cameraSelect.value = saved;
            }
        } catch (err) {
            this._showError('Could not list cameras: ' + (err.message || err));
        }

        this.cameraSelect.addEventListener('change', () => {
            const id = this.cameraSelect.value;
            if (mgr) {
                mgr.preferredDeviceId = id;
                if (id) {
                    localStorage.setItem('camera.preferredDeviceId', id);
                } else {
                    localStorage.removeItem('camera.preferredDeviceId');
                }
            }
        });
    }

    // --- FPS Counter ---

    _startFpsCounter() {
        const tick = (now) => {
            this._frameTimes.push(now);

            // Keep only last 30 frame timestamps
            if (this._frameTimes.length > 30) {
                this._frameTimes.shift();
            }

            // Update display every 500ms
            if (now - this._lastFpsUpdate >= 500) {
                this._lastFpsUpdate = now;
                this._updateFpsDisplay();
            }

            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    _updateFpsDisplay() {
        const times = this._frameTimes;
        if (times.length < 2) {
            this.fpsDisplay.textContent = '-- fps';
            return;
        }

        const elapsed = times[times.length - 1] - times[0];
        const fps = ((times.length - 1) / elapsed) * 1000;
        const rounded = Math.round(fps);

        this.fpsDisplay.textContent = `${rounded} fps`;

        // Color by performance tier
        if (fps > 30) {
            this.fpsDisplay.style.color = '#4ecdc4'; // green
        } else if (fps >= 15) {
            this.fpsDisplay.style.color = '#feca57'; // yellow
        } else {
            this.fpsDisplay.style.color = '#ff6b6b'; // red
        }
    }

    // --- State Poller (500ms) ---

    _startStatePoller() {
        setInterval(() => {
            this._syncButtonState();
            this._updateModeIndicator();
        }, 500);
    }

    // --- Mode Indicator ---

    _updateModeIndicator() {
        const mgr = window.SharedCameraManager;
        if (!mgr) {
            this.modeIndicator.textContent = '';
            return;
        }

        const mode = mgr.activeMode;
        if (mode === 'head') {
            this.modeIndicator.textContent = 'Head tracking';
        } else if (mode === 'body') {
            this.modeIndicator.textContent = 'Body tracking';
        } else {
            this.modeIndicator.textContent = '';
        }
    }

    // --- Error Display ---

    _showError(message) {
        this.errorDisplay.textContent = message;
        this.errorDisplay.style.display = '';

        // Auto-hide after 5 seconds
        clearTimeout(this._errorTimeout);
        this._errorTimeout = setTimeout(() => {
            this.errorDisplay.textContent = '';
        }, 5000);
    }
}
