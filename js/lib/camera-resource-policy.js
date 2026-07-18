/**
 * CameraResourcePolicy — pure device classification and inference pacing.
 *
 * Kept separate from SharedCameraManager so mobile budgets can be tested and
 * tuned without constructing a camera, DOM, or MediaPipe model.
 */
(function () {
    'use strict';

    function isMobileDevice(nav) {
        const n = nav || {};
        if (n.userAgentData?.mobile === true) return true;
        if (/Android|iPhone|iPad|iPod/i.test(n.userAgent || '')) return true;

        // iPadOS 13+ can request desktop sites and identify as MacIntel.
        return n.platform === 'MacIntel' && Number(n.maxTouchPoints || 0) > 1;
    }

    function baseFPS(nav) {
        return isMobileDevice(nav) ? 12 : 20;
    }

    function handOverlayFrameSkip(nav) {
        return isMobileDevice(nav) ? 12 : 6;
    }

    /** Apply stable sharing cost first, then transient render pressure. */
    function targetFPS(base, hasOverlay, constrained) {
        const configured = hasOverlay
            ? Math.max(5, Math.round(base * 0.85))
            : base;
        return constrained
            ? Math.max(5, Math.round(configured / 2))
            : configured;
    }

    /** Hysteresis avoids pacing changes when render FPS hovers at the boundary. */
    function nextConstrained(current, mainFPS, lowFPS = 48, recoveryFPS = 55) {
        if (!(mainFPS > 0) || !Number.isFinite(mainFPS)) return current;
        if (current) return mainFPS < recoveryFPS;
        return mainFPS < lowFPS;
    }

    const api = {
        isMobileDevice,
        baseFPS,
        handOverlayFrameSkip,
        targetFPS,
        nextConstrained,
    };

    if (typeof window !== 'undefined') window.CameraResourcePolicy = api;
    if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
        globalThis.CameraResourcePolicy = api;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
