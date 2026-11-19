/**
 * CameraHandPacing — presence-adaptive scheduling for hands beside a primary
 * detector (roadmap item hands-first-tracking).
 *
 * THE PROBLEM. In overlay mode hands run every 6th paced tick (12th on mobile):
 * about 2.5 Hz next to a face on desktop, measured 2026-11-19 in headless
 * Chromium with the worker transport. A held pose survives that; a swipe happens
 * entirely between two samples (held-pose-recognizer.js header).
 *
 * THE POLICY. Two phases, decided by whether a hand was SEEN recently:
 *   scouting  no hand within presentHoldMs: the primary runs every tick and
 *             hands run at scoutHz, cheap enough to notice a hand arriving.
 *   present   a hand was seen within presentHoldMs: hands run every tick and
 *             the primary drops to every Nth tick (a watchdog rate), so the
 *             budget goes where the gesture is.
 * This is the README's attention arbiter in its hand-first form. The rates follow
 * toaster (github.com/StopBanning/toaster, MIT, renderer/tracking.js:86-103):
 * about 30 Hz while hands are present, 8 Hz after 2 s without them, one frame in
 * flight. Here the ceiling is the paced loop's targetFPS (17 desktop / 10 mobile),
 * and the camera manager's serial awaits already keep one frame in flight.
 *
 * Pure: explicit clock (callers pass `now` in ms), no timers, no DOM, no
 * MediaPipe. SharedCameraManager uses it only while window.__handPacing ===
 * 'presence'; unset, the manager's skip / interleave schedulers are unchanged.
 */
(function () {
    'use strict';

    const DEFAULTS = Object.freeze({
        presentHoldMs: 2000,          // a hand seen this recently keeps the 'present' phase
        scoutHz: 4,                   // hand rate while scouting
        primaryEveryWhilePresent: 2,  // primary runs every Nth tick while a hand is present
    });

    const finite = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);

    function createHandPacer(options) {
        const o = Object.assign({}, DEFAULTS, options || {});
        const presentHoldMs = Math.max(0, finite(o.presentHoldMs, DEFAULTS.presentHoldMs));
        const scoutHz = Math.max(0.1, finite(o.scoutHz, DEFAULTS.scoutHz));
        const primaryEvery = Math.max(1, Math.round(finite(o.primaryEveryWhilePresent, DEFAULTS.primaryEveryWhilePresent)));

        let lastSeenAt = -Infinity;   // last time a hand result had >= 1 hand
        let lastHandRunAt = -Infinity; // last time a hand slot was granted
        let presentTick = 0;           // ticks since entering 'present', drives the primary watchdog
        let phase = 'scouting';
        let transitions = 0;

        function phaseAt(now) {
            return now - lastSeenAt <= presentHoldMs ? 'present' : 'scouting';
        }

        return {
            options: Object.freeze({ presentHoldMs, scoutHz, primaryEveryWhilePresent: primaryEvery }),

            /**
             * Which detectors run on this paced tick.
             * @param {number} now  ms, same clock as observe()
             * @returns {{primary: boolean, hand: boolean, phase: 'present'|'scouting'}}
             */
            tick(now) {
                const next = phaseAt(now);
                if (next !== phase) {
                    phase = next;
                    transitions++;
                    presentTick = 0;
                }
                if (phase === 'present') {
                    // The primary's first present tick runs, so a face never goes a
                    // full watchdog period dark at the moment a hand arrives.
                    const primary = presentTick % primaryEvery === 0;
                    presentTick++;
                    lastHandRunAt = now;
                    return { primary, hand: true, phase };
                }
                const hand = now - lastHandRunAt >= 1000 / scoutHz;
                if (hand) lastHandRunAt = now;
                return { primary: true, hand, phase };
            },

            /** Report a completed hand inference. handCount: hands in that result. */
            observe(now, handCount) {
                if (finite(handCount, 0) > 0) lastSeenAt = now;
            },

            /** Planned per-tick rates for a loop running at targetFPS (for getTrackingStats). */
            plannedRates(targetFPS) {
                const fps = Math.max(0, finite(targetFPS, 0));
                return phase === 'present'
                    ? { primary: fps / primaryEvery, hand: fps }
                    : { primary: fps, hand: Math.min(fps, scoutHz) };
            },

            state() {
                return { phase, lastSeenAt: isFinite(lastSeenAt) ? lastSeenAt : null, transitions };
            },

            reset() {
                lastSeenAt = -Infinity;
                lastHandRunAt = -Infinity;
                presentTick = 0;
                phase = 'scouting';
            },
        };
    }

    const api = { DEFAULTS, createHandPacer };

    if (typeof window !== 'undefined') window.CameraHandPacing = api;
    if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
        globalThis.CameraHandPacing = api;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
