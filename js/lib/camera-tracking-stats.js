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
 *
 * TRANSPORT SPLIT (2026-08-07, worker-offload Phase 0). One wall-clock number
 * stopped being enough the moment inference could leave the main thread. Inline,
 * the send duration IS the main-thread stall the 60fps renderer pays for. Behind
 * a worker the same duration is asynchronous round-trip latency that costs the
 * renderer almost nothing. Averaging those into one loadMsPerSec would let a
 * worker A/B look like a win (or a loss) for reasons that are pure bookkeeping.
 *
 * So record() now also accepts a structured outcome and keeps the components
 * apart: frame acquisition, inference, round trip, and the synchronous
 * main-thread slice. loadMsPerSec() is derived from the main-thread slice ONLY,
 * so it keeps meaning exactly what it always meant. summary() is untouched —
 * existing exports and tests depend on its {p50,p95,hz,n} shape. The richer view
 * lives in detail().
 *
 * See docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md § 11.
 */
(function () {
    'use strict';

    // Ring buffers per channel. 120 samples ≈ 12s at 10fps — long enough for a stable
    // p95, short enough that a rate change shows up within a couple of seconds.
    const MAX_SAMPLES = 120;
    const CHANNELS = ['face', 'pose', 'hand'];

    /** First finite argument, or null. Keeps a partial outcome from poisoning a ring. */
    function firstFinite(...vals) {
        for (const v of vals) if (Number.isFinite(v)) return v;
        return null;
    }

    function percentile(sorted, p) {
        if (!sorted.length) return 0;
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    }

    /** {p50,p95,n} for one ring, rounded like summary(). Empty rings report zeros. */
    function pct(ring) {
        const sorted = ring.slice().sort((a, b) => a - b);
        return {
            p50: Math.round(percentile(sorted, 50) * 10) / 10,
            p95: Math.round(percentile(sorted, 95) * 10) / 10,
            n: sorted.length,
        };
    }

    class CameraTrackingStats {
        constructor() {
            this.reset();
        }

        reset() {
            this._ms = {};        // channel → headline durations (ms) — round trip
            this._ticks = {};     // channel → completion timestamps (ms)
            this._parts = {};     // channel → {acquire,inference,roundTrip,main} rings
            this._counts = {};    // channel → {completed, dropped, reasons{}}
            this._transport = {}; // channel → 'inline' | 'worker' (last seen)
            this._delegate = {};  // channel → 'CPU' | 'GPU' (last seen; per channel,
                                  // because the adapter retries per channel on CPU)
            this._resultCount = {}; // channel → raw detections in the last completed result
            for (const c of CHANNELS) {
                this._ms[c] = [];
                this._ticks[c] = [];
                this._parts[c] = { acquire: [], inference: [], roundTrip: [], main: [] };
                this._counts[c] = { completed: 0, dropped: 0, reasons: {} };
                this._transport[c] = null;
                this._delegate[c] = null;
                this._resultCount[c] = null;
            }
        }

        /**
         * Record one send.
         *
         * Two call shapes, both supported on purpose:
         *   record('face', 12.4)          — legacy: a bare wall-clock duration, read
         *                                   as a completed inline inference.
         *   record('face', { ...outcome }) — structured, see the outcome fields below.
         *
         * The legacy shape stays first-class: the interleave pacing tests and any
         * caller that only has a stopwatch keep working unchanged, and inline
         * duration genuinely IS main-thread time, so the reading is accurate.
         *
         * Outcome fields (all optional except completed):
         *   transport 'inline' | 'worker'   delegate 'CPU' | 'GPU'
         *   completed bool                  dropped bool
         *   dropReason 'busy'|'stale'|'capture-failed'|'inference-error'|'no-input'
         *   frameAcquireMs  queueMs  inferenceMs  roundTripMs  mainThreadMs
         *
         * DROPS DO NOT TICK THE RATE. A dropped frame produced no result, so counting
         * it would inflate achieved Hz — the exact number the worker A/B turns on.
         * Drops increment their own counters instead.
         *
         * @param {string} channel 'face' | 'pose' | 'hand'
         * @param {number|Object} outcome duration in ms, or a structured outcome
         * @param {number} [now] completion timestamp; defaults to performance.now()
         */
        record(channel, outcome, now) {
            const ms = this._ms[channel];
            if (!ms) return; // unknown channel — drop rather than grow an unbounded map
            const t = Number.isFinite(now)
                ? now
                : (typeof performance !== 'undefined' ? performance.now() : Date.now());

            // ── Legacy scalar: a completed inline inference ──────────────────
            if (typeof outcome !== 'object' || outcome === null) {
                if (!Number.isFinite(outcome) || outcome < 0) return; // NaN guard
                this._commit(channel, t, outcome, {
                    transport: 'inline',
                    roundTripMs: outcome,
                    mainThreadMs: outcome,
                    inferenceMs: outcome,
                });
                return;
            }

            // ── Structured outcome ───────────────────────────────────────────
            const counts = this._counts[channel];
            if (outcome.transport) this._transport[channel] = outcome.transport;
            if (outcome.delegate) this._delegate[channel] = outcome.delegate;
            if (Number.isFinite(outcome.resultCount) && outcome.resultCount >= 0) {
                this._resultCount[channel] = Math.floor(outcome.resultCount);
            }

            if (outcome.completed === false || outcome.dropped === true) {
                counts.dropped++;
                const why = outcome.dropReason || 'unknown';
                counts.reasons[why] = (counts.reasons[why] || 0) + 1;
                return; // no sample, no tick — see the note above
            }

            // Headline stays the round trip so summary()/hz keep their meaning. Fall
            // back through the components rather than dropping a sample on a partial
            // outcome; a missing field is a reporting gap, not a failed inference.
            const headline = firstFinite(outcome.roundTripMs, outcome.inferenceMs, outcome.mainThreadMs);
            if (headline === null || headline < 0) return;
            this._commit(channel, t, headline, outcome);
        }

        /** Push one completed sample across every ring. Internal. */
        _commit(channel, t, headline, o) {
            const push = (arr, v) => {
                if (!Number.isFinite(v) || v < 0) return;
                arr.push(v);
                if (arr.length > MAX_SAMPLES) arr.shift();
            };

            push(this._ms[channel], headline);

            const p = this._parts[channel];
            push(p.roundTrip, firstFinite(o.roundTripMs, headline));
            push(p.inference, o.inferenceMs);
            push(p.acquire, o.frameAcquireMs);
            // Inline blocking is main-thread time by definition; a worker outcome must
            // state its own, because its round trip is mostly idle waiting.
            push(p.main, firstFinite(o.mainThreadMs, o.transport === 'worker' ? null : headline));

            this._counts[channel].completed++;

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
         * Total MAIN-THREAD milliseconds per second of wall time, per channel and summed.
         * This is the honest "what is tracking costing the main thread" number — and the
         * one that settles whether the 0.85 overlay tax was ever justified.
         *
         * Reads the main-thread ring, not the headline round trip. Inline they are the
         * same value, so this is unchanged for every reading taken to date. Behind a
         * worker they diverge sharply, and charging idle round-trip wait to the main
         * thread would make the offload look free-then-expensive for no real reason.
         */
        loadMsPerSec() {
            const out = { total: 0 };
            for (const c of CHANNELS) {
                // Read the main ring ONLY. No fallback to the headline: a worker
                // outcome that omits mainThreadMs must report zero rather than have
                // its round-trip wait quietly booked as renderer cost — that fallback
                // would defeat the entire reason this split exists. The legacy scalar
                // path fills this ring itself, so inline readings are unaffected.
                const s = this._parts[c].main;
                const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
                const v = Math.round(mean * this.hz(c) * 10) / 10;
                out[c] = v;
                out.total = Math.round((out.total + v) * 10) / 10;
            }
            return out;
        }

        /**
         * Worker compute milliseconds per second — the mirror of loadMsPerSec for time
         * spent inside the worker. Zero inline, which is correct: there is no worker.
         */
        workerComputeMsPerSec() {
            const out = { total: 0 };
            for (const c of CHANNELS) {
                const s = this._transport[c] === 'worker' ? this._parts[c].inference : [];
                const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
                const v = Math.round(mean * this.hz(c) * 10) / 10;
                out[c] = v;
                out.total = Math.round((out.total + v) * 10) / 10;
            }
            return out;
        }

        /**
         * Median main-thread cost of one send on a channel, or null with no samples.
         *
         * The cheap accessor for policy decisions that must not build the whole
         * detail() object every frame — e.g. deciding whether a burst of inference
         * is affordable before starting one.
         */
        mainThreadP50(channel) {
            const ring = this._parts[channel]?.main;
            if (!ring || !ring.length) return null;
            return percentile(ring.slice().sort((a, b) => a - b), 50);
        }

        /**
         * The transport-aware view: what each channel ran on, and where its time went.
         *
         * summary() deliberately stays the old shape for existing consumers; this is
         * the one to read when comparing an inline baseline against a worker run.
         */
        detail() {
            const out = { channels: {}, mainThreadMsPerSec: this.loadMsPerSec(), workerComputeMsPerSec: this.workerComputeMsPerSec() };
            for (const c of CHANNELS) {
                const p = this._parts[c];
                const k = this._counts[c];
                const attempts = k.completed + k.dropped;
                out.channels[c] = {
                    transport: this._transport[c],
                    delegate: this._delegate[c],
                    resultCount: this._resultCount[c],
                    hz: Math.round(this.hz(c) * 100) / 100,
                    frameAcquire: pct(p.acquire),
                    inference: pct(p.inference),
                    roundTrip: pct(p.roundTrip),
                    mainThread: pct(p.main),
                    completed: k.completed,
                    dropped: k.dropped,
                    dropRate: attempts ? Math.round((k.dropped / attempts) * 1000) / 1000 : 0,
                    dropReasons: { ...k.reasons },
                };
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
