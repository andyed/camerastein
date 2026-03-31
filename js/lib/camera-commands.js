/**
 * Camera Commands — Shared keyboard bindings for camera detection toggles.
 *
 * Works in both Psychodeli+ and Camerastein. Keys (Shift+number):
 *   ^ (Shift+6) — Toggle hand tracking overlay
 *   & (Shift+7) — Toggle head tracking
 *   * (Shift+8) — Toggle body tracking
 *   ( (Shift+9) — On/Off (on restores last config, off disables all)
 *
 * Calls SharedCameraManager.togglePermission() for the core action.
 * Optional callbacks for app-specific UI (toasts, permalink state, etc.)
 */

(function () {
    // Saved permission state for (-key restore
    let _savedPermissions = null;

    /**
     * Build a human-readable status string from current permissions.
     */
    function getStatusMessage(perms) {
        let primary = '';
        if (perms.head && perms.body) primary = 'Auto-Switch';
        else if (perms.head) primary = 'Head';
        else if (perms.body) primary = 'Body';
        else primary = 'Off';

        const handLabel = perms.hand ? ' + Hand' : '';
        return primary + handLabel;
    }

    /**
     * Handle a camera toggle key press.
     * @param {string} key - '^', '&', '*', or '('
     * @returns {Promise<{perms: Object, message: string}|null>}
     */
    async function handleCameraKey(key) {
        const mgr = window.SharedCameraManager;
        if (!mgr) return null;

        if (key === '^') {
            await mgr.togglePermission('hand');
        } else if (key === '&') {
            await mgr.togglePermission('head');
        } else if (key === '*') {
            await mgr.togglePermission('body');
        } else if (key === '(') {
            const perms = mgr.permissions;
            const anyActive = perms.head || perms.body || perms.hand;

            if (anyActive) {
                // Save current state, then disable all
                _savedPermissions = { ...perms };
                if (perms.head) await mgr.togglePermission('head');
                if (perms.body) await mgr.togglePermission('body');
                if (perms.hand) await mgr.togglePermission('hand');
            } else if (_savedPermissions) {
                // Restore saved state
                if (_savedPermissions.head) await mgr.togglePermission('head');
                if (_savedPermissions.body) await mgr.togglePermission('body');
                if (_savedPermissions.hand) await mgr.togglePermission('hand');
                _savedPermissions = null;
            } else {
                // No saved state — default to head tracking
                await mgr.togglePermission('head');
            }
        } else {
            return null;
        }

        const perms = mgr.permissions;
        const message = key === '9' && !perms.head && !perms.body && !perms.hand
            ? 'Camera Off'
            : getStatusMessage(perms);

        return { perms, message };
    }

    /**
     * Install keyboard listener. Fires on Shift+6/7/8/9 (producing ^, &, *, ().
     * @param {Object} options
     * @param {Function} [options.onToggle] - Called with {perms, message} after each toggle
     */
    function installKeyboardBindings(options = {}) {
        const CAMERA_KEYS = new Set(['^', '&', '*', '(']);

        document.addEventListener('keydown', async (e) => {
            // Must have shift held (these are shift+number combos)
            if (!e.shiftKey) return;
            // Skip if other modifiers held (Ctrl+Shift+8 etc.)
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            // Skip if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // On macOS, Shift+6 may produce 'Dead' (dead key for circumflex).
            // Fall back to event.code for reliable detection.
            let key = e.key;
            if (key === 'Dead' && e.code === 'Digit6') key = '^';

            if (!CAMERA_KEYS.has(key)) return;

            e.preventDefault();
            const result = await handleCameraKey(e.key);
            if (result && options.onToggle) {
                options.onToggle(result);
            }
        });
    }

    // Export
    window.CameraCommands = {
        handleCameraKey,
        installKeyboardBindings,
        getStatusMessage,
    };
})();
