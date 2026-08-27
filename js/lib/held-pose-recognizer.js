/**
 * Held Pose Recognizer — the lifecycle every hand pose shares.
 *
 * A held pose is: measure the hands, check the measurements against enter/exit
 * bounds, charge a dwell in milliseconds, then emit `start → peak → release`.
 * All of that is identical whether the pose is anjali mudra or a raised fist,
 * so it lives here once and each recognizer supplies only `_weigh()` — the
 * decision about what a given frame proves.
 *
 * Clock-explicit like the face gesture channel: it advances only when
 * `update()` is called, uses the caller's `t`, and owns no timers.
 *
 * Why held poses and not motions: hands run in the overlay slot at ~2.8 Hz on
 * desktop and ~0.83 Hz on mobile (README, Detection Concurrency Model). A swipe
 * cannot survive that sampling rate — the whole gesture happens between two
 * samples. A pose held for most of a second can, provided the dwell is measured
 * in milliseconds and a dropped frame does not end the episode. Transient
 * gestures (the air-drum strike) therefore do NOT use this engine; they read
 * raw per-frame velocity in the detector and need a dedicated hand mode.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 * @see docs/HAND_GESTURE_SUITE.md
 */

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;
const clamp = (x, lo, hi) => (x < lo ? lo : (x > hi ? hi : x));
const clamp01 = (x) => clamp(num(x), 0, 1);

export const HELD_POSE_CONTRACT_VERSION = 1;

/** Timing shared by every held pose. A recognizer may override any of it. */
export const HELD_POSE_DEFAULTS = Object.freeze({
    holdMs: 700,          // dwell before `start` — suppresses hands passing through
    releaseMs: 160,       // criteria must fail this long before `release`
    nilToleranceMs: 400,  // coast through dropped frames
    refractoryMs: 600,    // after release, before a new episode may charge
    maxFrameGapMs: 1500,  // longer than this is a sampling discontinuity, not a hold
    decayTau: 0.35,       // dwell decay time constant, seconds
    velEps: 0.10,         // value must fall this far below peak to emit `peak`
    minConfidence: 0.30,
});

export function passes(value, spec, bound) {
    const limit = spec[bound];
    return spec.dir < 0 ? value <= limit : value >= limit;
}

/** 0 at the `exit` bound, 1 at `full`, clamped. Direction-aware. */
export function satisfaction(value, spec) {
    const span = spec.full - spec.exit;
    if (Math.abs(span) < 1e-9) return value === spec.full ? 1 : 0;
    return clamp01((value - spec.exit) / span);
}

/** Live tuning: window.__<prefix>HoldMs, __<prefix>SeparationEnter, … */
export function tunedValue(key, fallback) {
    if (typeof window === 'undefined') return fallback;
    const value = window[key];
    return Number.isFinite(value) ? value : fallback;
}

export function resolveHeldPoseConfig(base, prefix, overrides = {}) {
    const criteria = {};
    for (const name of Object.keys(base.criteria)) {
        const spec = base.criteria[name];
        const capital = name[0].toUpperCase() + name.slice(1);
        criteria[name] = {
            ...spec,
            enter: tunedValue(`__${prefix}${capital}Enter`, spec.enter),
            exit: tunedValue(`__${prefix}${capital}Exit`, spec.exit),
            ...(overrides.criteria?.[name] ?? {}),
        };
    }

    const config = { ...base, ...overrides, criteria };
    for (const key of Object.keys(HELD_POSE_DEFAULTS)) {
        const capital = key[0].toUpperCase() + key.slice(1);
        config[key] = overrides[key] ?? tunedValue(`__${prefix}${capital}`, base[key]);
    }
    return config;
}

function makeTrack() {
    return {
        phase: 'idle',      // idle | rising | holding | falling
        active: false,
        value: 0,
        dwell: 0,           // 0..1 charge toward `start`
        episodeId: 0,
        startedAt: 0,
        peak: 0,
        durationMs: 0,
        peakEmitted: false,
    };
}

export class HeldPoseRecognizer {
    /**
     * @param {object} options
     * @param {string} options.kind      gesture name, stamped on every event
     * @param {object} options.baseConfig criteria + timing defaults
     * @param {string} options.prefix    window.__<prefix>… tuning namespace
     */
    constructor({ kind, baseConfig, prefix }, overrides = {}) {
        this.kind = kind;
        this.baseConfig = baseConfig;
        this.prefix = prefix;
        this.criteriaNames = Object.keys(baseConfig.criteria);
        this.config = resolveHeldPoseConfig(baseConfig, prefix, overrides);
        this._overrides = overrides;
        this.reset();
    }

    /**
     * Re-read the `window.__*` tuning flags without disturbing an open episode.
     * Live threshold tuning is the point of the debug lab: the config is
     * resolved once at construction, so a slider that only wrote the flag would
     * appear to do nothing.
     */
    retune(overrides = this._overrides) {
        this._overrides = overrides;
        this.config = resolveHeldPoseConfig(this.baseConfig, this.prefix, overrides);
        return this.config;
    }

    reset() {
        this.track = makeTrack();
        this.features = null;
        this._nextEpisodeId = 1;
        this._lastT = null;
        this._failingSince = null;
        this._missingSince = null;
        // -Infinity, not 0: the caller owns the clock and nothing guarantees it
        // starts above zero. A 0 sentinel silently refracts every frame of a
        // clock that begins negative.
        this._refractoryUntil = -Infinity;
        this._lastGoodT = null;
        this.reason = 'no-hands';
        this.blockedBy = [];
        this._onReset();
    }

    /** Hook for subclass state. */
    _onReset() {}

    /**
     * Decide what this frame proves, and say why when it proves nothing.
     * @returns {{ok, value, degraded, reason, blockedBy}}
     */
    _weigh() {
        throw new Error(`${this.kind}: _weigh() not implemented`);
    }

    /**
     * Advance one frame.
     *
     * @param {object} frame
     * @param {number} frame.t            monotonic ms; the recognizer owns no clock
     * @param {Array}  frame.hands        0–2 arrays of 21 landmarks
     * @param {number} [frame.confidence] tracker confidence, 0..1
     * @returns {object} gesture frame, with `events` carrying only this frame's edges
     */
    update({ t, hands = [], confidence = 1 } = {}) {
        const now = num(t);
        const events = [];
        const cfg = this.config;
        const dt = this._lastT === null ? 0 : Math.max(0, now - this._lastT);
        this._lastT = now;

        // A frame vouches for the interval since the previous one — but only if
        // that interval is plausibly continuous. A paused detector, a
        // backgrounded tab, or a Head↔Body mode switch produces no updates at
        // all, and the frame that lands afterwards must not be able to credit
        // the whole blackout to the dwell and fire on arrival.
        const gapped = dt > cfg.maxFrameGapMs;
        const credited = gapped ? 0 : dt;
        if (gapped) this._breakContinuity(now, events);

        const bound = this.track.active || this.track.phase === 'rising' ? 'exit' : 'enter';
        const evidence = this._weigh(now, hands, confidence, bound);
        this.reason = evidence.reason;
        this.blockedBy = evidence.blockedBy;

        if (evidence.ok) {
            this._failingSince = null;
            this._advanceHolding(now, credited, evidence.value, events);
        } else {
            if (this._failingSince === null) this._failingSince = now;
            this._advanceFailing(now, credited, events);
        }

        return this._frame(now, confidence, hands.length, evidence.degraded, events);
    }

    /**
     * No usable read this frame. Hold the last one briefly rather than ending
     * the episode: at 0.83 Hz on mobile a single miss is 1.2 s of wall clock.
     * Coasting bridges silence — a frame that can see the hand and disagrees is
     * a failure, not something to paper over, and must not come through here.
     */
    _coastOr(now, verdict) {
        const cfg = this.config;
        if (this._missingSince === null) this._missingSince = now;
        const coasting = (now - this._missingSince) <= cfg.nilToleranceMs;

        if (!coasting) {
            this.features = null;
            return { ...verdict, degraded: false };
        }
        if (!this.features) return { ...verdict, degraded: true };

        // Re-weigh the held reading against the exit bounds, so coasting cannot
        // keep alive a pose that had already stopped qualifying.
        const held = this.features;
        const blockedBy = this.criteriaNames.filter(
            (name) => !passes(held[name], cfg.criteria[name], 'exit'));
        if (blockedBy.length > 0) return { ...verdict, degraded: true, blockedBy };

        return {
            ok: true,
            value: Math.min(...this.criteriaNames.map(
                (name) => satisfaction(held[name], cfg.criteria[name]))),
            degraded: true,
            reason: 'coasting',
            blockedBy: [],
        };
    }

    /**
     * Close an episode whose continuity we cannot vouch for.
     *
     * The release is stamped at `now` but dated to the last frame actually
     * observed, so a consumer that acted on `start` always sees a matching
     * `release` and never has to invent an end time.
     */
    _breakContinuity(now, events) {
        const track = this.track;
        if (track.active) {
            if (!track.peakEmitted) {
                track.peakEmitted = true;
                this._event(events, 'peak', now, track.peak);
            }
            this._event(events, 'release', now, track.peak, {
                durationMs: Math.max(0, num(this._lastGoodT) - track.startedAt),
                reason: 'discontinuity',
            });
        }
        const episodeCounter = this._nextEpisodeId;
        this.track = makeTrack();
        this._nextEpisodeId = episodeCounter;
        this.features = null;
        this._failingSince = null;
        this._missingSince = null;
        this._onBreak();
    }

    /** Hook for subclass state that must not survive a discontinuity. */
    _onBreak() {}

    _advanceHolding(now, dt, value, events) {
        const cfg = this.config;
        const track = this.track;
        track.value = value;

        if (!track.active) {
            if (now < this._refractoryUntil) {
                track.dwell = 0;
                track.phase = 'idle';
                return;
            }
            track.phase = 'rising';
            track.dwell = cfg.holdMs > 0 ? clamp01(track.dwell + dt / cfg.holdMs) : 1;
            if (track.dwell < 1) return;

            track.active = true;
            track.phase = 'holding';
            track.episodeId = this._nextEpisodeId++;
            track.startedAt = now;
            track.peak = value;
            track.peakEmitted = false;
            this._event(events, 'start', now, value);
            return;
        }

        track.durationMs = now - track.startedAt;
        if (value > track.peak) track.peak = value;
        if (!track.peakEmitted && track.peak - value > cfg.velEps) {
            track.peakEmitted = true;
            this._event(events, 'peak', now, track.peak);
        }
    }

    _advanceFailing(now, dt, events) {
        const cfg = this.config;
        const track = this.track;

        if (!track.active) {
            // An abandoned attempt bleeds off instead of banking progress, so a
            // hand drifting past the camera cannot accumulate a confirmation.
            const decay = cfg.decayTau > 0 ? Math.exp(-(dt / 1000) / cfg.decayTau) : 0;
            track.dwell = track.dwell * decay;
            if (track.dwell < 0.01) track.dwell = 0;
            track.value = 0;
            track.phase = track.dwell > 0 ? 'rising' : 'idle';
            return;
        }

        track.phase = 'falling';
        track.durationMs = now - track.startedAt;
        if (now - this._failingSince < cfg.releaseMs) return;

        if (!track.peakEmitted) {
            track.peakEmitted = true;
            this._event(events, 'peak', now, track.peak);
        }
        this._event(events, 'release', now, track.peak, { durationMs: track.durationMs });
        this._refractoryUntil = now + cfg.refractoryMs;
        this.track = makeTrack();
        this._failingSince = null;
        this._onBreak();
    }

    _event(events, phase, t, strength, extra = {}) {
        events.push({
            id: `${this.kind}:${this.track.episodeId}:${phase}`,
            kind: this.kind,
            phase,
            episodeId: this.track.episodeId,
            t: num(t),
            strength: clamp01(strength),
            ...extra,
        });
    }

    _frame(t, confidence, handsPresent, degraded, events) {
        const track = this.track;
        return {
            v: HELD_POSE_CONTRACT_VERSION,
            t,
            quality: {
                confidence: clamp01(confidence),
                handsPresent,
                degraded,           // true when the read is partial or coasted
                reason: this.reason, // why this frame did or did not qualify
                blockedBy: [...this.blockedBy],
                armed: this._isArmed ? this._isArmed(t) : false,
                staleMs: this._lastGoodT === null ? 0 : t - this._lastGoodT,
            },
            track: {
                kind: this.kind,
                phase: track.phase,
                active: track.active,
                value: clamp01(track.value),
                dwell: clamp01(track.dwell),
                episodeId: track.episodeId,
                startedAt: track.startedAt,
                peak: clamp01(track.peak),
                durationMs: track.durationMs,
            },
            features: this.features ? { ...this.features } : null,
            events,
        };
    }
}
