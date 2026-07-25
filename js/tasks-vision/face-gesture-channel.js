/**
 * Face Gesture Channel — deterministic gesture lifecycles over FaceFeatures.
 *
 * This file is shared byte-for-byte with Camerastein. Keep product behavior
 * downstream: this layer names what the face did; Psychodeli decides how a
 * named gesture should alter the visual performance.
 *
 * Input:  provider-neutral feature frames (face-feature-channel.js)
 * Output: provider-neutral gesture frames (docs/FACE_GESTURE_CONTRACT.md)
 */

export const GESTURE_CONTRACT_VERSION = 1;

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;
const clamp = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);
const clamp01 = (x) => clamp(num(x), 0, 1);
const sign = (x) => x < 0 ? -1 : 1;

const TRACK_CONFIG = Object.freeze({
    mouth:   { enter: 0.35, exit: 0.20, velEps: 0.12 },
    brow:    { enter: 0.40, exit: 0.25, velEps: 0.12 },
    leanIn:  { enter: 0.35, exit: 0.15, velEps: 0.10 },
    leanOut: { enter: 0.35, exit: 0.15, velEps: 0.10 },
});

const CYCLE_CONFIG = Object.freeze({
    nod: {
        enter: 0.12,
        enterVel: 0.18,
        armMs: 300,
        reverseVel: 0.10,
        returnBand: 0.045,
        maxMs: 1100,
        refractoryMs: 350,
    },
    shake: {
        enter: 0.12,
        opposite: 0.10,
        enterVel: 0.18,
        armMs: 300,
        reverseVel: 0.10,
        maxMs: 1250,
        refractoryMs: 500,
    },
});

function makeTrack() {
    return {
        phase: 'idle',
        active: false,
        value: 0,
        velocity: 0,
        episodeId: 0,
        startedAt: 0,
        peak: 0,
        durationMs: 0,
        peakEmitted: false,
        side: 'none',
    };
}

function makeCycle() {
    return {
        phase: 'idle',
        active: false,
        episodeId: 0,
        startedAt: 0,
        peak: 0,
        direction: 'none',
        durationMs: 0,
    };
}

function copyTrack(track) {
    return {
        phase: track.phase,
        active: track.active,
        value: num(track.value),
        velocity: num(track.velocity),
        episodeId: track.episodeId,
        startedAt: num(track.startedAt),
        peak: num(track.peak),
        durationMs: num(track.durationMs),
        ...(track.side !== 'none' ? { side: track.side } : {}),
    };
}

function copyCycle(cycle) {
    return {
        phase: cycle.phase,
        active: cycle.active,
        episodeId: cycle.episodeId,
        startedAt: num(cycle.startedAt),
        peak: num(cycle.peak),
        direction: cycle.direction,
        durationMs: num(cycle.durationMs),
    };
}

/**
 * Pure, clock-explicit recognizer. State advances only through update(features);
 * no timers, provider objects, DOM, or product behavior live here.
 */
export class FaceGestureRecognizer {
    constructor(opts = {}) {
        this.opts = {
            minConfidence: 0.35,
            neutralTauMs: 2400,
            neutralMaxVel: 0.08,
            screamJawEnter: 0.65,
            screamBrowEnter: 0.45,
            screamJawExit: 0.35,
            screamBrowExit: 0.25,
            screamRefractoryMs: 700,
            ...opts,
        };
        this.reset();
    }

    reset() {
        this._lastT = -Infinity;
        this._nextEpisodeId = 1;
        this._tracks = {
            mouth: makeTrack(),
            brow: makeTrack(),
            leanIn: makeTrack(),
            leanOut: makeTrack(),
        };
        this._cycles = { nod: makeCycle(), shake: makeCycle() };
        this._neutral = { pitch: null, yaw: null };
        this._armed = {
            pitch: { t: -Infinity, dir: 0 },
            yaw: { t: -Infinity, dir: 0 },
        };
        this._refractoryUntil = { nod: 0, shake: 0, scream: 0 };
        this._scream = {
            active: false,
            episodeId: 0,
            startedAt: 0,
            strength: 0,
            durationMs: 0,
        };
        this.gestures = null;
        return this;
    }

    _event(events, kind, phase, t, strength, extra = {}) {
        events.push({
            id: `${kind}:${extra.episodeId || 0}:${phase}`,
            kind,
            phase,
            t,
            strength: clamp01(strength),
            ...extra,
        });
    }

    _updateTrack(name, value, velocity, t, events, meta = {}) {
        const cfg = TRACK_CONFIG[name];
        const tr = this._tracks[name];
        const v = clamp01(value);
        const vel = num(velocity);
        tr.value = v;
        tr.velocity = vel;
        if (meta.side && meta.side !== 'none') tr.side = meta.side;

        if (!tr.active) {
            if (v < cfg.enter) {
                tr.phase = 'idle';
                tr.side = 'none';
                return;
            }
            tr.active = true;
            tr.phase = vel > cfg.velEps ? 'rising' : 'holding';
            tr.episodeId = this._nextEpisodeId++;
            tr.startedAt = t;
            tr.peak = v;
            tr.durationMs = 0;
            tr.peakEmitted = tr.phase !== 'rising';
            this._event(events, name, 'start', t, v, {
                episodeId: tr.episodeId,
                ...(tr.side !== 'none' ? { side: tr.side } : {}),
            });
            if (tr.peakEmitted) {
                this._event(events, name, 'peak', t, v, {
                    episodeId: tr.episodeId,
                    ...(tr.side !== 'none' ? { side: tr.side } : {}),
                });
            }
            return;
        }

        tr.durationMs = Math.max(0, t - tr.startedAt);
        if (v > tr.peak) tr.peak = v;
        const previousPhase = tr.phase;
        tr.phase = vel > cfg.velEps ? 'rising'
            : (vel < -cfg.velEps ? 'falling' : 'holding');

        if (!tr.peakEmitted && previousPhase === 'rising' && tr.phase !== 'rising') {
            tr.peakEmitted = true;
            this._event(events, name, 'peak', t, tr.peak, {
                episodeId: tr.episodeId,
                durationMs: tr.durationMs,
                ...(tr.side !== 'none' ? { side: tr.side } : {}),
            });
        }

        if (v > cfg.exit) return;
        if (!tr.peakEmitted) {
            this._event(events, name, 'peak', t, tr.peak, {
                episodeId: tr.episodeId,
                durationMs: tr.durationMs,
                ...(tr.side !== 'none' ? { side: tr.side } : {}),
            });
        }
        this._event(events, name, 'release', t, tr.peak, {
            episodeId: tr.episodeId,
            durationMs: tr.durationMs,
            ...(tr.side !== 'none' ? { side: tr.side } : {}),
        });
        const episodeId = tr.episodeId;
        Object.assign(tr, makeTrack(), { episodeId });
    }

    _updateNeutral(key, value, velocity, t) {
        const current = this._neutral[key];
        if (current === null) {
            this._neutral[key] = value;
            return;
        }
        const cycle = key === 'pitch' ? this._cycles.nod : this._cycles.shake;
        if (cycle.active || Math.abs(velocity) > this.opts.neutralMaxVel) return;
        const dt = this._lastT > -Infinity ? clamp(t - this._lastT, 0, 250) : 33;
        const k = 1 - Math.exp(-dt / Math.max(1, this.opts.neutralTauMs));
        this._neutral[key] += (value - current) * k;
    }

    _resetCycle(name, keepEpisode = true) {
        const episodeId = keepEpisode ? this._cycles[name].episodeId : 0;
        Object.assign(this._cycles[name], makeCycle(), { episodeId });
    }

    /**
     * Cycle entry evidence, decoupled in time.
     *
     * `velocity` arrives EMA-smoothed from the feature channel, so it LAGS the
     * excursion it belongs to. Requiring threshold excursion AND threshold
     * velocity AND a matching sign in the SAME frame therefore inverted the
     * intent: on a decisive nod the head has already reversed by the time the
     * smoothed velocity peaks, leaving a coincidence window one or two frames
     * wide that real sampling rates routinely skip — while a languid nod, whose
     * velocity has several time constants to settle, passed every time.
     *
     * Arming keeps both thresholds exactly as documented and relaxes only their
     * coincidence: a velocity onset arms the axis for `armMs`, and the cycle
     * starts when the excursion threshold is met while that arming is still
     * fresh and points the same way. Same-frame coincidence still qualifies, so
     * every gesture that entered before continues to enter.
     */
    _cycleArmed(key, rel, velocity, cfg, t) {
        const arm = this._armed[key];
        const heading = sign(rel);
        const fast = Math.abs(velocity) >= cfg.enterVel;
        // Decide from evidence that existed BEFORE this frame's onset is
        // recorded. The reversal that ends an outbound leg is itself fast, and
        // recording it first would overwrite the very arming it is completing.
        const entering = Math.abs(rel) >= cfg.enter
            && ((fast && sign(velocity) === heading)
                || (arm.dir === heading && (t - arm.t) <= cfg.armMs));
        if (fast) {
            arm.t = t;
            arm.dir = sign(velocity);
        }
        return entering;
    }

    /** Spend the arming so one onset cannot seed a second cycle. */
    _disarm(key) {
        this._armed[key].t = -Infinity;
        this._armed[key].dir = 0;
    }

    _updateNod(pitch, velocity, t, events) {
        this._updateNeutral('pitch', pitch, velocity, t);
        const neutral = this._neutral.pitch ?? pitch;
        const rel = clamp(pitch - neutral, -1, 1);
        const c = this._cycles.nod;
        const cfg = CYCLE_CONFIG.nod;

        if (!c.active) {
            if (t < this._refractoryUntil.nod
                || !this._cycleArmed('pitch', rel, velocity, cfg, t)) return;
            this._disarm('pitch');
            c.active = true;
            c.phase = 'outbound';
            c.episodeId = this._nextEpisodeId++;
            c.startedAt = t;
            c.peak = Math.abs(rel);
            c.direction = rel > 0 ? 'down' : 'up';
            this._event(events, 'nod', 'start', t, Math.abs(rel), {
                episodeId: c.episodeId,
                direction: c.direction,
            });
            return;
        }

        c.durationMs = Math.max(0, t - c.startedAt);
        c.peak = Math.max(c.peak, Math.abs(rel));
        const dir = c.direction === 'down' ? 1 : -1;
        if (c.durationMs > cfg.maxMs) {
            this._resetCycle('nod');
            return;
        }
        if (c.phase === 'outbound' && velocity * dir < -cfg.reverseVel) {
            c.phase = 'returning';
            this._event(events, 'nod', 'peak', t, c.peak, {
                episodeId: c.episodeId,
                direction: c.direction,
                durationMs: c.durationMs,
            });
        }
        if (c.phase !== 'returning' || rel * dir > cfg.returnBand) return;
        this._event(events, 'nod', 'complete', t, c.peak, {
            episodeId: c.episodeId,
            direction: c.direction,
            durationMs: c.durationMs,
        });
        this._refractoryUntil.nod = t + cfg.refractoryMs;
        this._resetCycle('nod');
    }

    _updateShake(yaw, velocity, t, events) {
        this._updateNeutral('yaw', yaw, velocity, t);
        const neutral = this._neutral.yaw ?? yaw;
        const rel = clamp(yaw - neutral, -1, 1);
        const c = this._cycles.shake;
        const cfg = CYCLE_CONFIG.shake;

        if (!c.active) {
            if (t < this._refractoryUntil.shake
                || !this._cycleArmed('yaw', rel, velocity, cfg, t)) return;
            this._disarm('yaw');
            c.active = true;
            c.phase = 'outbound';
            c.episodeId = this._nextEpisodeId++;
            c.startedAt = t;
            c.peak = Math.abs(rel);
            c.direction = rel > 0 ? 'right-left' : 'left-right';
            this._event(events, 'shake', 'start', t, Math.abs(rel), {
                episodeId: c.episodeId,
                direction: c.direction,
            });
            return;
        }

        c.durationMs = Math.max(0, t - c.startedAt);
        c.peak = Math.max(c.peak, Math.abs(rel));
        const dir = c.direction === 'right-left' ? 1 : -1;
        if (c.durationMs > cfg.maxMs) {
            this._resetCycle('shake');
            return;
        }
        if (c.phase === 'outbound' && velocity * dir < -cfg.reverseVel) {
            c.phase = 'opposite';
            this._event(events, 'shake', 'peak', t, c.peak, {
                episodeId: c.episodeId,
                direction: c.direction,
                durationMs: c.durationMs,
            });
        }
        // A shake is two lobes, not "turned once and came home".
        if (c.phase !== 'opposite' || rel * dir > -cfg.opposite) return;
        this._event(events, 'shake', 'complete', t, c.peak, {
            episodeId: c.episodeId,
            direction: c.direction,
            durationMs: c.durationMs,
        });
        this._refractoryUntil.shake = t + cfg.refractoryMs;
        this._resetCycle('shake');
    }

    _updateScream(jaw, brow, t, events) {
        const s = this._scream;
        const strength = clamp01((jaw + brow) / 2);
        if (!s.active) {
            if (t < this._refractoryUntil.scream
                || jaw < this.opts.screamJawEnter
                || brow < this.opts.screamBrowEnter) return;
            s.active = true;
            s.episodeId = this._nextEpisodeId++;
            s.startedAt = t;
            s.strength = strength;
            s.durationMs = 0;
            this._event(events, 'scream', 'start', t, strength, {
                episodeId: s.episodeId,
            });
            return;
        }

        s.strength = Math.max(s.strength, strength);
        s.durationMs = Math.max(0, t - s.startedAt);
        if (jaw > this.opts.screamJawExit && brow > this.opts.screamBrowExit) return;
        this._event(events, 'scream', 'release', t, s.strength, {
            episodeId: s.episodeId,
            durationMs: s.durationMs,
        });
        this._refractoryUntil.scream = t + this.opts.screamRefractoryMs;
        const episodeId = s.episodeId;
        Object.assign(s, {
            active: false,
            episodeId,
            startedAt: 0,
            strength: 0,
            durationMs: 0,
        });
    }

    /**
     * @param {Object|null} features FaceFeatureContract v1 frame
     * @returns {Object|null} gesture frame, or null when no trustworthy face
     */
    update(features) {
        const q = features?.quality || {};
        const confidence = clamp01(q.confidence);
        if (!features || !q.facePresent || confidence < this.opts.minConfidence) {
            this.reset();
            return null;
        }

        const t = num(features.t);
        const expression = features.expression || {};
        const pose = features.pose || {};
        const dynamics = features.dynamics || {};
        const events = [];

        const jaw = clamp01(expression.jawOpen);
        const browL = clamp01(expression.browRaiseL);
        const browR = clamp01(expression.browRaiseR);
        const brow = Math.max(browL, browR);
        const browSide = brow <= TRACK_CONFIG.brow.exit
            ? 'none'
            : ((browL >= TRACK_CONFIG.brow.enter && browR >= TRACK_CONFIG.brow.enter)
                ? 'both' : (browL >= browR ? 'left' : 'right'));
        const browVel = Math.abs(browL - browR) < 0.08
            ? (num(dynamics.browLVel) + num(dynamics.browRVel)) / 2
            : (browL > browR ? num(dynamics.browLVel) : num(dynamics.browRVel));
        const proximity = clamp(num(pose.proximity), -1, 1);
        const proximityVel = num(dynamics.proximityVel);

        if (q.hasExpressions) {
            this._updateTrack('mouth', jaw, dynamics.jawVel, t, events);
            this._updateTrack('brow', brow, browVel, t, events, { side: browSide });
            this._updateScream(jaw, brow, t, events);
        } else {
            this._updateTrack('mouth', 0, -1, t, events);
            this._updateTrack('brow', 0, -1, t, events);
            this._updateScream(0, 0, t, events);
        }
        this._updateTrack('leanIn', Math.max(0, proximity), proximityVel, t, events);
        this._updateTrack('leanOut', Math.max(0, -proximity), -proximityVel, t, events);
        this._updateNod(clamp(num(pose.pitch), -1, 1), num(dynamics.pitchVel), t, events);
        this._updateShake(clamp(num(pose.yaw), -1, 1), num(dynamics.yawVel), t, events);

        this._lastT = t;
        this.gestures = {
            v: GESTURE_CONTRACT_VERSION,
            t,
            quality: {
                confidence,
                facePresent: 1,
                calibrated: !!q.calibrated,
            },
            tracks: {
                mouth: copyTrack(this._tracks.mouth),
                brow: copyTrack(this._tracks.brow),
                leanIn: copyTrack(this._tracks.leanIn),
                leanOut: copyTrack(this._tracks.leanOut),
            },
            cycles: {
                nod: copyCycle(this._cycles.nod),
                shake: copyCycle(this._cycles.shake),
            },
            compound: {
                scream: {
                    active: this._scream.active,
                    episodeId: this._scream.episodeId,
                    startedAt: num(this._scream.startedAt),
                    strength: num(this._scream.strength),
                    durationMs: num(this._scream.durationMs),
                },
            },
            authority: clamp01(features.authority),
            events,
        };
        return this.gestures;
    }
}

/**
 * Register faceGestures on MotionBus and expose a freshness-guarded read API.
 * Compute is cheap and live-gated by window.__faceGestureChannel === true.
 */
export function initFaceGestureChannel() {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.FaceGestures?._wired) return w.FaceGestures;

    if (bus._channels && !bus._channels.faceGestures) {
        bus._channels.faceGestures = 'faceGestures';
        bus.state.faceGestures = null;
    }

    const STALE_MS = 400;
    const recognizer = new FaceGestureRecognizer();
    let last = null;
    let wasEmitting = false;
    const flagOn = () => w.__faceGestureChannel === true;
    const clear = () => {
        recognizer.reset();
        last = null;
        if (!wasEmitting) return;
        wasEmitting = false;
        bus.emit('faceGestures', null);
    };

    bus.subscribe?.('faceFeatures', (features) => {
        if (!flagOn() || !features) {
            clear();
            return;
        }
        const gestures = recognizer.update(features);
        if (!gestures) {
            clear();
            return;
        }
        last = gestures;
        wasEmitting = true;
        bus.emit('faceGestures', gestures);
    });

    const readAt = (nowMs) => {
        if (!last || !isFinite(last.t)) {
            return { fresh: false, ageMs: Infinity, gestures: null };
        }
        const ageMs = num(nowMs) - last.t;
        if (!(ageMs >= 0) || ageMs > STALE_MS) {
            return { fresh: false, ageMs: num(ageMs), gestures: null };
        }
        return { fresh: true, ageMs, gestures: last };
    };

    w.FaceGestures = {
        _wired: true,
        contractVersion: GESTURE_CONTRACT_VERSION,
        recognizer,
        read() { return readAt(performance.now()); },
        reset() {
            clear();
            bus.emit('faceGestures', null);
        },
        status() {
            const r = readAt(performance.now());
            const status = {
                flag: flagOn(),
                fresh: r.fresh,
                ageMs: Math.round(num(r.ageMs)),
                active: r.gestures
                    ? Object.entries(r.gestures.tracks)
                        .filter(([, tr]) => tr.active)
                        .map(([name]) => name)
                    : [],
                nod: r.gestures?.cycles?.nod?.phase || 'idle',
                shake: r.gestures?.cycles?.shake?.phase || 'idle',
                events: r.gestures?.events?.map(e => `${e.kind}:${e.phase}`) || [],
            };
            w.debugManager?.info?.('FaceGestures', status);
            return status;
        },
    };
    return w.FaceGestures;
}
