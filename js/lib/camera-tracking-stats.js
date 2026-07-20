/**
 * CameraTrackingStats — per-channel inference latency and achieved-rate telemetry.
 *
 * WHY THIS EXISTS: until 2026-07-19 nothing in the tree timed detectForVideo. The
 * scheduler's "overlay sharing costs ~15%" tax (camera-resource-policy.js targetFPS)
 * was a hard-coded guess, and the mobile hand-overlay rate had drifted to ~0.83Hz
 * while the docs still claimed ~3Hz — invisible because no instrument watched it.
 * Every pacing claim (including the interleave scheduler this shipped alongside)
 * needs a before/after number, so the instrument lands first.
 *
 * Pure and DOM-free so unit tests can drive it with a synthetic clock. The manager
 * calls record() around each model send and surfaces the numbers through
 * sharedCameraManager.getTrackingStats() — read that on a real device, since
 * headless has no camera and mobile pacing can't be observed anywhere else.
 *
 * Channels: 'face' | 'pose' | 'hand'.
 */
(function () {
    'use strict';

    // Ring buffers per channel. 120 samples ≈ 12s at 10fps — long enough for a stable
    // p95, short enough that a rate change shows up within a couple of seconds.
    const MAX_SAMPLES = 120;
    const CHANNELS = ['face', 'pose', 'hand'];

    function percentile(sorted, p) {
        if (!sorted.length) return 0;
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    }

    class CameraTrackingStats {
        constructor() {
            this.reset();
        }

        reset() {
            this._ms = {};        // channel → durations (ms)
            this._ticks = {};     // channel → completion timestamps (ms)
            for (const c of CHANNELS) {
                this._ms[c] = [];
                this._ticks[c] = [];
            }
        }

        /**
         * Record one completed inference.
         * @param {string} channel 'face' | 'pose' | 'hand'
         * @param {number} durationMs wall time of the send() call
         * @param {number} [now] completion timestamp; defaults to performance.now()
         */
        record(channel, durationMs, now) {
            const ms = this._ms[channel];
            if (!ms) return; // unknown channel — drop rather than grow an unbounded map
            if (!Number.isFinite(durationMs) || durationMs < 0) return; // NaN guard
            const t = Number.isFinite(now)
                ? now
                : (typeof performance !== 'undefined' ? performance.now() : Date.now());

            ms.push(durationMs);
            if (ms.length > MAX_SAMPLES) ms.shift();

            const ticks = this._ticks[channel];
            ticks.push(t);
            if (ticks.length > MAX_SAMPLES) ticks.shift();
        }

        /**
         * Achieved rate for a channel, derived from the spacing of the retained ticks.
         * Returns 0 until there are two samples to span.
         */
        hz(channel) {
            const ticks = this._ticks[channel];
            if (!ticks || ticks.length < 2) return 0;
            const span = ticks[ticks.length - 1] - ticks[0];
            if (!(span > 0)) return 0;
            return ((ticks.length - 1) / span) * 1000;
        }

        /** Per-channel {p50, p95, hz, n}. Channels with no samples report zeros. */
        summary() {
            const out = {};
            for (const c of CHANNELS) {
                const sorted = this._ms[c].slice().sort((a, b) => a - b);
                out[c] = {
                    p50: Math.round(percentile(sorted, 50) * 10) / 10,
                    p95: Math.round(percentile(sorted, 95) * 10) / 10,
                    hz: Math.round(this.hz(c) * 100) / 100,
                    n: sorted.length,
                };
            }
            return out;
        }

        /**
         * Total inference milliseconds per second of wall time, per channel and summed.
         * This is the honest "what is tracking costing the main thread" number — and the
         * one that settles whether the 0.85 overlay tax was ever justified.
         */
        loadMsPerSec() {
            const out = { total: 0 };
            for (const c of CHANNELS) {
                const s = this._ms[c];
                const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
                const v = Math.round(mean * this.hz(c) * 10) / 10;
                out[c] = v;
                out.total = Math.round((out.total + v) * 10) / 10;
            }
            return out;
        }
    }

    const api = {
        CameraTrackingStats,
        create: () => new CameraTrackingStats(),
    };

    if (typeof window !== 'undefined') {
        window.CameraTrackingStatsAPI = api;
        // Singleton shared by the manager and any telemetry consumer.
        window.CameraTrackingStats = window.CameraTrackingStats || new CameraTrackingStats();
    }
    if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
        globalThis.CameraTrackingStatsAPI = api;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
