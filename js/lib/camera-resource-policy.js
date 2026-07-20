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

    /**
     * Apply stable sharing cost first, then transient render pressure.
     *
     * The 0.85 overlay tax pre-compensates for hands sharing the loop. Under the
     * INTERLEAVE scheduler that tax is wrong by construction: interleaving runs one
     * model per tick instead of stacking two, so the per-tick cost does not rise and
     * there is nothing to pre-pay. Pass interleaved=true to skip it.
     */
    function targetFPS(base, hasOverlay, constrained, interleaved) {
        const configured = (hasOverlay && !interleaved)
            ? Math.max(5, Math.round(base * 0.85))
            : base;
        return constrained
            ? Math.max(5, Math.round(configured / 2))
            : configured;
    }

    /**
     * INTERLEAVE SCHEDULER — which model gets this paced tick.
     *
     * The legacy scheme starves hands: mobile runs the loop at 10fps (12 base × 0.85)
     * and fires hands every 12th tick → ~0.83Hz, i.e. up to 1.2s of gesture latency
     * (2.4s when render pressure halves the loop). Verified 2026-07-19 against
     * shared-camera-manager.js:1427, where the skip counter advances per PACED tick,
     * not per rAF tick. The documented "~3Hz" was always the desktop number (17/6).
     *
     * Interleaving alternates instead of starving. With ratio N the primary claims N
     * of every N+1 ticks and hands take the remainder — the same one-inference-per-tick
     * cost, redistributed. On mobile at 12fps with ratio 2: primary 8Hz, hands 4Hz,
     * versus today's 10Hz / 0.83Hz. Hands get ~4.8× fresher for a 20% primary haircut.
     *
     * @param {number} tick monotonic paced-tick counter
     * @param {number} ratio primary ticks per hand tick (>=1)
     * @returns {'primary'|'hand'}
     */
    function interleaveSlot(tick, ratio) {
        const n = Math.max(1, Math.round(Number(ratio) || 1));
        const period = n + 1;
        // Non-negative modulo so a wrapped or negative counter can't skew the phase.
        const phase = ((Math.round(tick) % period) + period) % period;
        return phase < n ? 'primary' : 'hand';
    }

    /**
     * Achieved per-channel rates for a given plan — the arithmetic the audit had to do
     * by hand. Exposed so tests and getTrackingStats() agree on what a config *should* yield.
     */
    function plannedRates(fps, mode, ratio, frameSkip) {
        if (mode === 'interleave') {
            const n = Math.max(1, Math.round(Number(ratio) || 1));
            return { primary: (fps * n) / (n + 1), hand: fps / (n + 1) };
        }
        return { primary: fps, hand: fps / Math.max(1, frameSkip || 1) };
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
        interleaveSlot,
        plannedRates,
    };

    if (typeof window !== 'undefined') window.CameraResourcePolicy = api;
    if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
        globalThis.CameraResourcePolicy = api;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
