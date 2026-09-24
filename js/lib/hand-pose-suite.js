/**
 * Hand Pose Suite — one-hand held poses, declared as data.
 *
 * Every pose here is the same recognizer with a different criteria list. The
 * lifecycle (dwell, hysteresis, refractory, discontinuity, coasting) comes from
 * HeldPoseRecognizer; the vocabulary comes from `handShape()`. Adding a pose is
 * a `definePose()` call, not a new class.
 *
 * ## What is NOT here
 *
 * Motion. Hands run in the overlay slot at ~2.8 Hz desktop and ~0.83 Hz mobile,
 * so a swipe or a wave happens entirely between two samples. Everything in this
 * file is a pose you hold. The one transient gesture camerastein does detect —
 * the air-drum strike — lives in `hand-pose-detector.js`, reads raw per-frame
 * wrist velocity, and needs a dedicated hand mode to sample fast enough. It is
 * a different family and deliberately does not use this engine.
 *
 * ## Mutual exclusivity
 *
 * The poses are declared so that no two can match the same hand at once — a
 * fist requires a tucked thumb precisely so a thumbs-up is not also a fist.
 * That is asserted in `tests/hand-pose-suite.test.js` rather than resolved at
 * runtime by priority arbitration: a set of definitions that cannot collide is
 * easier to reason about than a scoring rule that decides which collision wins.
 *
 * @see docs/HAND_GESTURE_SUITE.md
 */

import { handShape } from './hand-pose-features.js';
import {
    HeldPoseRecognizer,
    HELD_POSE_DEFAULTS,
    passes,
    satisfaction,
} from './held-pose-recognizer.js';

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;

/**
 * Threshold shapes. `enter` gates a new episode, `exit` is the looser bound an
 * open one must stay inside, `full` is where the meter reads 1.
 *
 * Long fingers are measured by wrist reach (`fingerReach`, OptiGest's rule).
 * On a live guided run (2026-09-24) extended fingers read ≥ 0.93 and curled
 * ones ≤ 0.41 in every pose; synthetic hands read 0.96–1.00 and 0.19–0.39. The
 * EXTENDED and CURLED bands below sit inside that gap. The thumb is still
 * measured by straightness, and THUMB_TUCKED is still calibrated on fixtures
 * only — a real thumb across a fist reads 0.84–0.92, which is why fist does not
 * yet fire live (see tests/hand-live-fixtures.test.js).
 */
const EXTENDED = Object.freeze({ enter: 0.85, exit: 0.72, full: 1.0, dir: 1 });
const CURLED = Object.freeze({ enter: 0.55, exit: 0.66, full: 0.15, dir: -1 });
// The thumb folds across the palm rather than into it, so it keeps more of its
// length when tucked than a finger does — a looser bar, from the same fixtures.
const THUMB_TUCKED = Object.freeze({ enter: 0.55, exit: 0.68, full: 0.30, dir: -1 });
/**
 * Not edge-on — a precondition of every pose here, not a stylistic preference.
 *
 * This gate was written for straightness (`fingerExtension`), which is
 * direction-dependent: a fully curled finger read **0.16** palm-on and **0.71**
 * edge-on, so a "curled" threshold for one orientation was meaningless in the
 * other. Wrist reach, which the long fingers now use, is far less so — the
 * same finger reads 0.20 palm-on and 0.39 edge-on, both well inside CURLED.
 * The gate stays for now because the thumb is still on straightness; whether
 * it can be relaxed is a question for more live clips, not this one.
 *
 * (Pray is unaffected: its hands are edge-on by definition and its `flatness`
 * bounds were derived there, where 2D and 3D agree exactly.)
 */
const FACING = Object.freeze({ enter: 0.45, exit: 0.30, full: 0.85, dir: 1 });
/**
 * Not pitched — the half of "facing the camera" that FACING never checked.
 *
 * FACING bounds aspect from below (not edge-on). Nothing bounded it from above,
 * so a relaxed hand hanging in view, back to the camera and fingers drooping,
 * passed as an open palm: its fingers are loosely straight and its palm reads
 * wide and short. On the 2026-09-24 run a real open palm read aspect 0.46–0.48
 * (ratio ≈ 2.1) and hanging hands at rest read ≥ 1.14 in 95% of frames (ratio
 * ≤ 0.88). Enter at ratio 0.9 (aspect ≤ 1.11), hold down to 0.75.
 */
const NOT_PITCHED = Object.freeze({ enter: 0.9, exit: 0.75, full: 1.6, dir: 1 });
const THUMB_UP = Object.freeze({ enter: 0.45, exit: 0.25, full: 1.0, dir: 1 });
const THUMB_DOWN = Object.freeze({ enter: -0.45, exit: -0.25, full: -1.0, dir: -1 });

const label = {
    palmLengthRatio: 'not pitched',
    thumbExtension: 'thumb', indexExtension: 'index', middleExtension: 'middle',
    ringExtension: 'ring', pinkyExtension: 'pinky',
};

function fingers(spec, names) {
    return Object.fromEntries(names.map((name) => [`${name}Extension`, spec]));
}

/**
 * @param {string} kind
 * @param {object} pose
 * @param {string} pose.title     shown in the lab
 * @param {string} pose.cue       how to perform it
 * @param {string[]} [pose.extended]
 * @param {string[]} [pose.curled]
 * @param {object} [pose.extra]   further criteria, keyed by handShape field
 * @param {number} [pose.holdMs]
 */
function definePose(kind, { title, cue, extended = [], curled = [], extra = {}, holdMs = 500 }) {
    return {
        kind,
        title,
        cue,
        prefix: kind,
        config: Object.freeze({
            ...HELD_POSE_DEFAULTS,
            holdMs,
            criteria: Object.freeze({
                ...fingers(EXTENDED, extended),
                ...fingers(CURLED, curled),
                ...extra,
            }),
        }),
        // Human-readable criterion names for the lab, derived rather than typed
        // twice — a renamed criterion cannot drift out of sync with its label.
        criteriaLabels: (name) => label[name] ?? name,
    };
}

export const HAND_POSE_SPECS = Object.freeze({
    openPalm: definePose('openPalm', {
        title: 'Open palm',
        cue: 'All five fingers straight, hand facing the camera.',
        extended: ['thumb', 'index', 'middle', 'ring', 'pinky'],
        // Only openPalm is gated on pitch: it is the pose a relaxed hand falls
        // into. thumbsUp/Down are legitimately side-on (aspect 1.0–1.5 live).
        extra: { aspect: FACING, palmLengthRatio: NOT_PITCHED },
    }),
    fist: definePose('fist', {
        title: 'Fist',
        cue: 'All four fingers curled, thumb tucked across them.',
        curled: ['index', 'middle', 'ring', 'pinky'],
        // The tucked thumb is what keeps a thumbs-up from also being a fist.
        extra: { thumbExtension: THUMB_TUCKED, aspect: FACING },
    }),
    point: definePose('point', {
        title: 'Point',
        cue: 'Index finger out, the other three curled, hand facing the camera.',
        extended: ['index'],
        curled: ['middle', 'ring', 'pinky'],
        extra: { aspect: FACING },
    }),
    peace: definePose('peace', {
        title: 'Peace',
        cue: 'Index and middle out, ring and pinky curled, hand facing the camera.',
        extended: ['index', 'middle'],
        curled: ['ring', 'pinky'],
        extra: { aspect: FACING },
    }),
    horns: definePose('horns', {
        title: 'Horns',
        cue: 'Index and pinky out, middle and ring curled, hand facing the camera.',
        extended: ['index', 'pinky'],
        curled: ['middle', 'ring'],
        extra: { aspect: FACING },
    }),
    thumbsUp: definePose('thumbsUp', {
        title: 'Thumbs up',
        cue: 'Fist with the thumb out and pointing up, hand facing the camera.',
        extended: ['thumb'],
        curled: ['index', 'middle', 'ring', 'pinky'],
        extra: { thumbUpness: THUMB_UP, aspect: FACING },
    }),
    thumbsDown: definePose('thumbsDown', {
        title: 'Thumbs down',
        cue: 'Fist with the thumb out and pointing down, hand facing the camera.',
        extended: ['thumb'],
        curled: ['index', 'middle', 'ring', 'pinky'],
        extra: { thumbUpness: THUMB_DOWN, aspect: FACING },
    }),
});

export const HAND_POSE_IDS = Object.keys(HAND_POSE_SPECS);

/**
 * A one-hand held pose.
 *
 * Either hand may perform it: every frame is measured for both hands and the
 * first that satisfies the criteria wins. When neither does, the report comes
 * from the first hand, so `blockedBy` always names something concrete.
 */
export class HandPoseRecognizer extends HeldPoseRecognizer {
    constructor(spec, overrides = {}) {
        super({ kind: spec.kind, baseConfig: spec.config, prefix: spec.prefix }, overrides);
        this.spec = spec;
    }

    _onReset() {
        this.hand = null;   // index of the hand currently satisfying the pose
    }

    _weigh(now, hands, confidence, bound) {
        const cfg = this.config;
        const names = this.criteriaNames;
        const blank = { ok: false, value: 0, degraded: false, blockedBy: [] };

        if (num(confidence) < cfg.minConfidence) {
            return { ...blank, reason: 'low-confidence' };
        }
        if (hands.length === 0) {
            this.hand = null;
            return this._coastOr(now, { ...blank, reason: 'no-hands' });
        }

        let fallback = null;
        for (let index = 0; index < hands.length && index < 2; index++) {
            const shape = handShape(hands[index]);
            if (!shape) continue;

            const blockedBy = names.filter(
                (name) => !passes(shape[name], cfg.criteria[name], bound));
            if (blockedBy.length === 0) {
                this.features = shape;
                this.hand = index;
                this._missingSince = null;
                this._lastGoodT = now;
                return {
                    ok: true,
                    value: Math.min(...names.map(
                        (name) => satisfaction(shape[name], cfg.criteria[name]))),
                    degraded: false,
                    reason: 'ok',
                    blockedBy: [],
                };
            }
            if (!fallback) fallback = { shape, blockedBy };
        }

        if (!fallback) {
            // Hands were reported but no palm frame survived — landmarks
            // missing or the hand too degenerate to measure. Not the same as
            // "no hands", and worth its own name in the tally.
            this.hand = null;
            return this._coastOr(now, { ...blank, reason: 'frame-collapsed' });
        }

        // A hand we can see that does not match is contrary evidence, not
        // missing evidence: report it rather than coasting on a stale reading.
        this.features = fallback.shape;
        this.hand = null;
        this._missingSince = null;
        this._lastGoodT = now;
        return { ...blank, reason: 'blocked', blockedBy: fallback.blockedBy };
    }
}

/** One recognizer per pose, keyed by kind. */
export function createHandPoseRecognizers(overrides = {}) {
    return Object.fromEntries(HAND_POSE_IDS.map(
        (kind) => [kind, new HandPoseRecognizer(HAND_POSE_SPECS[kind], overrides[kind])]));
}

/**
 * Which poses a single hand satisfies right now, ignoring dwell and hysteresis.
 *
 * Used by the exclusivity test and by the lab's "what am I holding" readout.
 * More than one name coming back means two declarations overlap.
 */
export function matchingPoses(landmarks) {
    const shape = handShape(landmarks);
    if (!shape) return [];
    return HAND_POSE_IDS.filter((kind) => {
        const { criteria } = HAND_POSE_SPECS[kind].config;
        return Object.keys(criteria).every(
            (name) => passes(shape[name], criteria[name], 'enter'));
    });
}
