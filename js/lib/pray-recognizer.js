/**
 * Pray Recognizer — anjali mudra as a held two-hand pose.
 *
 * Palms flat, facing each other, fingers aligned and pointing up, held still
 * for a dwell. The lifecycle — dwell, hysteresis, refractory, discontinuity,
 * coasting — lives in HeldPoseRecognizer and is shared with every other hand
 * pose; what is pray-specific is `_weigh()` below and the criteria above it.
 * Emits the Track lifecycle the face channel uses:
 *
 *     start → peak → release
 *
 * Clock-explicit like the face gesture channel: it advances only when
 * `update()` is called, uses the caller's `t`, and owns no timers. Resetting
 * clears the episode, the dwell charge, and the refractory window.
 *
 * Why a held pose and not a motion: hands run in the overlay slot at ~2.8 Hz on
 * desktop and ~0.83 Hz on mobile (see README, Detection Concurrency Model). A
 * swipe cannot survive that sampling rate. A pose held for most of a second can
 * — provided the dwell is measured in milliseconds, never in frames, and
 * provided a dropped frame does not end the episode.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 */

import {
    palmFrame,
    twoHandGeometry,
    singleHandGeometry,
    handFlatness,
} from './hand-pose-features.js';
import {
    HeldPoseRecognizer,
    HELD_POSE_DEFAULTS,
    passes,
    satisfaction,
} from './held-pose-recognizer.js';

export const PRAY_CONTRACT_VERSION = 1;

export const PRAY_CONFIG = Object.freeze({
    criteria: Object.freeze({
        // Palm centres within ~0.85 hand-lengths. Pressed palms measure ~0.32.
        separation: { enter: 0.85, exit: 1.30, full: 0.30, dir: -1 },
        // A VETO, not a demand. −1 opposed, +1 both facing the same way, and
        // near 0 when the image cannot say — which is what a truly edge-on palm
        // produces, because it hides its thumb's sideways offset in depth. An
        // earlier version required ≤ −0.35 and so rejected a perfect pray,
        // whose synthetic best case reads −0.28. The criterion earns its place
        // by rejecting a clear +1 (two palms facing the same way); ambiguity
        // must pass, or the criterion fails hardest exactly where the pose is
        // most correct. See the note below on why the palm normal cannot do
        // this job at all.
        palmOpposition: { enter: 0.35, exit: 0.60, full: -1.0, dir: -1 },
        // Both palms turned away from the camera, which is what pressing them
        // together does. Rejects two flat hands held up side by side.
        foreshortening: { enter: 0.55, exit: 0.72, full: 0.20, dir: -1 },
        // Both hands point the same way — rejects a handshake, which opposes them.
        axisAlignment: { enter: 0.80, exit: 0.60, full: 0.97, dir: 1 },
        // Flat hands. A loose interlocked clasp fails this.
        flatness: { enter: 0.86, exit: 0.74, full: 0.96, dir: 1 },
        // Fingers up. 0.45 still allows roughly 63° of lean.
        uprightness: { enter: 0.45, exit: 0.15, full: 0.85, dir: 1 },
    }),
    ...HELD_POSE_DEFAULTS,
    nilToleranceMs: 400,  // coast through dropped frames; palms occlude each other
    occlusionAssist: true, // let an armed single hand sustain a pose (see _armedUntil)
    armMs: 1200,           // how long one qualifying frame vouches for the next
    // A soloing hand must hold still. Hand-lengths per second of palm-centre
    // drift: holding a pose sways well under 0.3, breaking one is several times
    // this. Rate-based, not per-frame, so it means the same thing at 2.8 Hz and
    // at 0.83 Hz.
    soloDriftMax: 1.2,
});

/*
 * ## Why `normalDot` is reported but never gates
 *
 * The obvious way to say "the palms face each other" is to dot the two palm
 * normals. It was the original criterion here, and it was wrong twice over.
 *
 * 1. **The sign was backwards.** `(indexMCP−wrist) × (pinkyMCP−wrist)` is a
 *    mirror-sensitive construction: on a right hand it points out of the palm,
 *    on a left hand out of the back. A real left/right pair in prayer therefore
 *    reads **+1**, not −1. The recognizer was asking for the one value the pose
 *    can never produce, which is why every other criterion could pass while
 *    this one failed.
 * 2. **It flips with the handedness label.** When occlusion makes MediaPipe
 *    label both hands the same chirality — routine in this pose, since each
 *    palm hides the other — the dot product inverts again. It does not degrade
 *    to uncertainty; it reports the opposite with full confidence.
 *
 * `palmOpposition` replaces it. The thumb base is a large image-plane landmark,
 * so which side of its own palm each thumb sits on is readable without z, and
 * the agreement between the two hands reads the same whichever way either is
 * labelled.
 *
 * What is lost: `palmOpposition` cannot distinguish palms-facing-each-other
 * from backs-of-hands-pressed-together. Both read −1. That pose — flat, fingers
 * up, held still for 700 ms, backs touching — is a yoga posture, not something
 * that happens at a desk, and it is the accepted cost of a criterion that never
 * lies. `normalDot` stays in `features` for diagnosis.
 */

const CRITERIA = Object.keys(PRAY_CONFIG.criteria);

/**
 * Measure the pray criteria from a pair of hands.
 * Returns null when either palm frame is unrecoverable — the common case when
 * two palms press together and one occludes the other.
 */
export function measurePray(handA, handB) {
    const frameA = palmFrame(handA);
    const frameB = palmFrame(handB);
    const geometry = twoHandGeometry(frameA, frameB);
    if (!geometry) return null;

    return {
        separation: geometry.separation,
        palmOpposition: geometry.palmOpposition,
        normalDot: geometry.normalDot,
        axisAlignment: geometry.axisAlignment,
        uprightness: geometry.uprightness,
        foreshortening: geometry.foreshortening,
        flatness: Math.min(handFlatness(handA), handFlatness(handB)),
        scale: geometry.scale,
    };
}

/** The three criteria a lone hand can still speak to. */
export const SINGLE_HAND_CRITERIA = Object.freeze(['flatness', 'uprightness', 'foreshortening']);

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;

export class PrayRecognizer extends HeldPoseRecognizer {
    constructor(overrides = {}) {
        super({ kind: 'pray', baseConfig: PRAY_CONFIG, prefix: 'pray' }, overrides);
    }

    _onReset() {
        this._armedUntil = -Infinity;
        this._soloAnchor = null;
    }

    _onBreak() {
        this._armedUntil = -Infinity;
        this._soloAnchor = null;
    }

    _isArmed(t) {
        return t < this._armedUntil;
    }

    retune(overrides) {
        const config = super.retune(overrides);
        // Two flags outside the criteria/timing namespaces the base resolves.
        config.armMs = this._overrides.armMs
            ?? (typeof window !== 'undefined' && Number.isFinite(window.__prayArmMs)
                ? window.__prayArmMs : PRAY_CONFIG.armMs);
        config.soloDriftMax = this._overrides.soloDriftMax
            ?? (typeof window !== 'undefined' && Number.isFinite(window.__praySoloDriftMax)
                ? window.__praySoloDriftMax : PRAY_CONFIG.soloDriftMax);
        config.occlusionAssist = this._overrides.occlusionAssist
            ?? (typeof window === 'undefined'
                ? PRAY_CONFIG.occlusionAssist
                : window.__prayOcclusionAssist !== false);
        return config;
    }

    /**
     * Three tiers, in descending order of trust:
     *   two hands           — the full criteria set, the only tier that can arm
     *   armed single hand   — the three criteria one hand can speak to, plus
     *                         stillness, and only while a recent frame vouches
     *   coasting            — no read at all, inside the nil tolerance
     */
    _weigh(now, hands, confidence, bound) {
        const cfg = this.config;
        const blank = { ok: false, value: 0, degraded: false, blockedBy: [] };

        if (num(confidence) < cfg.minConfidence) {
            return { ...blank, reason: 'low-confidence' };
        }

        if (hands.length >= 2) {
            const measured = measurePray(hands[0], hands[1]);
            if (!measured) {
                // Two hands reported, but a palm frame collapsed — landmarks
                // missing, or the hand so degenerate the axis is unrecoverable.
                // Distinct from "no hands", and worth its own name.
                return this._coastOr(now, { ...blank, reason: 'frame-collapsed' });
            }

            this.features = measured;
            this._missingSince = null;
            this._lastGoodT = now;

            const blockedBy = CRITERIA.filter(
                (name) => !passes(measured[name], cfg.criteria[name], bound));
            if (blockedBy.length > 0) {
                return { ...blank, reason: 'blocked', blockedBy };
            }

            // Only a two-hand frame may arm from cold. A qualifying single hand
            // can refresh that window afterwards, but can never open it.
            this._armedUntil = now + cfg.armMs;
            this._soloAnchor = null;
            return {
                ok: true,
                value: Math.min(...CRITERIA.map(
                    (name) => satisfaction(measured[name], cfg.criteria[name]))),
                degraded: false,
                reason: 'ok',
                blockedBy: [],
            };
        }

        if (hands.length === 1 && cfg.occlusionAssist) {
            const armed = now < this._armedUntil;
            const single = armed ? singleHandGeometry(hands[0]) : null;
            if (single) {
                const blockedBy = SINGLE_HAND_CRITERIA.filter(
                    (name) => !passes(single[name], cfg.criteria[name], 'exit'));
                if (blockedBy.length > 0) {
                    // Contrary evidence, not missing evidence. Coasting exists
                    // to bridge a frame that says nothing; a frame that says the
                    // pose has broken must not be papered over with a stale
                    // reading. `releaseMs` is the anti-chatter guard here, and
                    // it still requires two consecutive contrary frames.
                    this._soloAnchor = null;
                    return { ...blank, reason: 'one-hand-blocked', blockedBy, degraded: true };
                }

                // Stillness is the second half of the evidence, and it is what
                // makes an open-ended solo stretch safe. A hand genuinely
                // pressed against the other barely moves; a hand whose partner
                // has left, or that is on its way down, does not hold this.
                const drift = this._soloDriftRate(now, single);
                if (drift > cfg.soloDriftMax) {
                    this._soloAnchor = { center: single.center, scale: single.scale, t: now };
                    return { ...blank, reason: 'one-hand-moving', degraded: true };
                }
                this._soloAnchor = { center: single.center, scale: single.scale, t: now };

                // A still, qualifying hand is positive evidence, so it refreshes
                // both staleness and the arming window — which is what lets a
                // pose survive an occlusion that lasts longer than armMs. In
                // this pose occlusion is not a blip, it is the steady state.
                this._missingSince = null;
                this._lastGoodT = now;
                this._armedUntil = now + cfg.armMs;
                return {
                    ok: true,
                    value: Math.min(...SINGLE_HAND_CRITERIA.map(
                        (name) => satisfaction(single[name], cfg.criteria[name]))),
                    degraded: true,
                    reason: 'one-hand-armed',
                    blockedBy: [],
                };
            }
            this._soloAnchor = null;
            return this._coastOr(now, {
                ...blank, reason: armed ? 'one-hand-collapsed' : 'one-hand', degraded: true,
            });
        }

        return this._coastOr(now, {
            ...blank,
            reason: hands.length === 1 ? 'one-hand' : 'no-hands',
        });
    }

    /**
     * How fast the soloing hand is moving, in hand-lengths per second.
     *
     * Returns 0 for the first solo frame — there is nothing to compare against
     * yet, and the two-hand frame that armed it already vouched for the pose.
     */
    _soloDriftRate(now, single) {
        const anchor = this._soloAnchor;
        if (!anchor) return 0;
        const elapsed = (now - anchor.t) / 1000;
        if (!(elapsed > 0)) return 0;
        const unit = Math.max(anchor.scale, single.scale);
        if (!(unit > 1e-6)) return 0;
        const moved = Math.hypot(
            single.center.x - anchor.center.x,
            single.center.y - anchor.center.y,
        ) / unit;
        return moved / elapsed;
    }
}
