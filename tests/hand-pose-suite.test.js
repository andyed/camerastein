import test from 'node:test';
import assert from 'node:assert/strict';

import {
    handShape,
    fingerExtension,
    FINGER_CHAINS,
} from '../js/lib/hand-pose-features.js';
import { makeHand, jitterDepth } from '../js/lib/hand-pose-fixtures.js';
import {
    HAND_POSE_SPECS,
    HAND_POSE_IDS,
    HandPoseRecognizer,
    createHandPoseRecognizers,
    matchingPoses,
} from '../js/lib/hand-pose-suite.js';

const FACING = { x: 0, y: 0, z: -1 };
const UP = { x: 0, y: -1, z: 0 };
const DOWN = { x: 0, y: 1, z: 0 };
const FIST = { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 };
const curl = (over = {}) => ({ ...FIST, ...over });

/** The canonical hand for each registered pose. */
const POSE_FIXTURES = {
    openPalm: { axis: UP, curl: 0 },
    fist: { axis: UP, curl: curl() },
    point: { axis: UP, curl: curl({ thumb: 0.9, index: 0 }) },
    peace: { axis: UP, curl: curl({ thumb: 0.9, index: 0, middle: 0 }) },
    horns: { axis: UP, curl: curl({ thumb: 0.9, index: 0, pinky: 0 }) },
    thumbsUp: { axis: UP, curl: curl({ thumb: 0 }) },
    thumbsDown: { axis: DOWN, curl: curl({ thumb: 0 }) },
};

const handFor = (kind, extra = {}) =>
    makeHand({ palmDirection: FACING, ...POSE_FIXTURES[kind], ...extra });

function run(recognizer, script, { startT = 1000, frameMs = 150 } = {}) {
    const events = [];
    const frames = [];
    let t = startT;
    for (const { hands, count = 1, confidence = 0.9 } of script) {
        for (let i = 0; i < count; i++) {
            const frame = recognizer.update({ t, hands: hands ?? [], confidence });
            frames.push(frame);
            events.push(...frame.events);
            t += frameMs;
        }
    }
    return { events, frames, phases: events.map((e) => e.phase) };
}

test('the suite registers every pose the lab expects', () => {
    assert.deepEqual(HAND_POSE_IDS, Object.keys(POSE_FIXTURES),
        'a pose was added or renamed without a fixture');
});

test('no two poses can match the same hand', () => {
    // Exclusivity is a property of the declarations, not of a runtime priority
    // rule. If this fails, two poses overlap and one of them needs a criterion
    // the other does not satisfy — a fist requires a tucked thumb for exactly
    // this reason, so that a thumbs-up is not also a fist.
    for (const kind of HAND_POSE_IDS) {
        assert.deepEqual(matchingPoses(handFor(kind)), [kind],
            `${kind} fixture is ambiguous`);
    }
});

test('every pose completes start → peak → release', () => {
    for (const kind of HAND_POSE_IDS) {
        const recognizer = new HandPoseRecognizer(HAND_POSE_SPECS[kind]);
        // A pose that clearly is not the target either side. Note the neutral
        // for openPalm is a fist, not a relaxed hand: a slightly curled palm
        // facing the camera still reads as fully extended in projection.
        const neutral = makeHand({
            palmDirection: FACING, axis: UP, curl: kind === 'openPalm' ? 1 : 0,
        });
        const { phases } = run(recognizer, [
            { hands: [neutral], count: 2 },
            { hands: [handFor(kind)], count: 8 },
            { hands: [neutral], count: 4 },
        ]);
        assert.deepEqual(phases, ['start', 'peak', 'release'], kind);
    }
});

test('a pose fires from either hand', () => {
    // Nothing in the suite depends on which hand MediaPipe reports first, or on
    // its handedness label — both of which occlusion disturbs.
    const recognizer = new HandPoseRecognizer(HAND_POSE_SPECS.peace);
    const other = makeHand({ palmDirection: FACING, axis: UP, curl: 0 });
    const { phases, frames } = run(recognizer, [
        { hands: [other, handFor('peace')], count: 8 },
    ]);
    assert.deepEqual(phases, ['start']);
    assert.equal(frames.at(-1).track.active, true);
});

test('poses are immune to depth noise, like every other hand feature', () => {
    for (const kind of HAND_POSE_IDS) {
        const clean = handShape(handFor(kind));
        const noisy = handShape(jitterDepth([handFor(kind)], 0.4)[0]);
        for (const name of Object.keys(HAND_POSE_SPECS[kind].config.criteria)) {
            assert.ok(Math.abs(clean[name] - noisy[name]) < 1e-9,
                `${kind}.${name} drifted on depth noise alone`);
        }
    }
});

test('the dwell suppresses a hand passing through a pose', () => {
    const spec = HAND_POSE_SPECS.point;
    const belowDwell = Math.floor(spec.config.holdMs / 150) - 1;
    const { events } = run(new HandPoseRecognizer(spec), [
        { hands: [handFor('point')], count: belowDwell },
        { hands: [makeHand({ palmDirection: FACING, axis: UP, curl: 0 })], count: 6 },
    ]);
    assert.deepEqual(events, []);
});

test('a blocked pose names the finger that is wrong', () => {
    const recognizer = new HandPoseRecognizer(HAND_POSE_SPECS.peace);
    // Peace, but with the ring finger straight — one criterion away.
    const nearly = makeHand({
        palmDirection: FACING, axis: UP,
        curl: curl({ thumb: 0.9, index: 0, middle: 0, ring: 0 }),
    });
    const frame = recognizer.update({ t: 1000, hands: [nearly], confidence: 0.9 });
    assert.equal(frame.quality.reason, 'blocked');
    assert.deepEqual(frame.quality.blockedBy, ['ringExtension']);
});

test('low confidence and empty frames are reported, not guessed at', () => {
    const recognizer = new HandPoseRecognizer(HAND_POSE_SPECS.fist);
    assert.equal(
        recognizer.update({ t: 1000, hands: [handFor('fist')], confidence: 0.05 }).quality.reason,
        'low-confidence');
    assert.equal(
        recognizer.update({ t: 1200, hands: [], confidence: 0.9 }).quality.reason,
        'no-hands');
});

test('createHandPoseRecognizers returns one live recognizer per pose', () => {
    const recognizers = createHandPoseRecognizers();
    assert.deepEqual(Object.keys(recognizers), HAND_POSE_IDS);
    for (const kind of HAND_POSE_IDS) {
        assert.equal(recognizers[kind].kind, kind);
        assert.equal(recognizers[kind].track.active, false);
    }
});

test('malformed landmarks are rejected without throwing', () => {
    const recognizer = new HandPoseRecognizer(HAND_POSE_SPECS.fist);
    assert.doesNotThrow(() => {
        recognizer.update({ t: 1000, hands: [[{ x: NaN, y: 0, z: 0 }]], confidence: 0.9 });
        recognizer.update({ t: 1200, hands: [null], confidence: 0.9 });
    });
});

// ── Consistency with handPoseDetector (Psychodeli+) ─────────────────────────

test('finger extension is the exact complement of the detector\'s curl', () => {
    // handPoseDetector computes `curl = 1 - directDist / boneLength` over
    // MCP → PIP → DIP → TIP. `fingerExtension` must be the same ratio over the
    // same chain, or the two implementations quietly disagree about what a
    // curled finger is while using thresholds that look comparable.
    const detectorCurl = (landmarks, chain) => {
        let bone = 0;
        for (let i = 1; i < chain.length; i++) {
            bone += Math.hypot(
                landmarks[chain[i]].x - landmarks[chain[i - 1]].x,
                landmarks[chain[i]].y - landmarks[chain[i - 1]].y,
            );
        }
        const base = landmarks[chain[0]];
        const tip = landmarks[chain.at(-1)];
        const direct = Math.hypot(tip.x - base.x, tip.y - base.y);
        return 1 - Math.max(0, Math.min(1, direct / bone));
    };

    for (const curl of [0, 0.4, 0.7, 1]) {
        const hand = makeHand({ palmDirection: FACING, axis: UP, curl });
        for (const [name, chain] of Object.entries(FINGER_CHAINS)) {
            const mine = fingerExtension(hand, chain);
            const theirs = detectorCurl(hand, chain);
            assert.ok(Math.abs(mine - (1 - theirs)) < 1e-9,
                `${name} at curl ${curl}: extension ${mine} vs 1 - curl ${1 - theirs}`);
        }
    }
});

test('the detector\'s finger chains and ours are the same joints', () => {
    // Mirrors `handPoseDetector._fingerChains`. Starting at the MCP rather than
    // the wrist is what keeps the two measures comparable — including the palm
    // puts a fixed length in both halves of the ratio and compresses a fully
    // curled finger from ~0.16 to ~0.5.
    assert.deepEqual(FINGER_CHAINS.index, [5, 6, 7, 8]);
    assert.deepEqual(FINGER_CHAINS.middle, [9, 10, 11, 12]);
    assert.deepEqual(FINGER_CHAINS.ring, [13, 14, 15, 16]);
    assert.deepEqual(FINGER_CHAINS.pinky, [17, 18, 19, 20]);
    assert.deepEqual(FINGER_CHAINS.thumb, [1, 2, 3, 4]);
});

test('a thumbs-up fist clears the detector\'s curl floor as well as ours', () => {
    // The suite is deliberately one notch looser (0.55 vs 0.45) because it
    // reports state and thumbConfirm commits an action — but a hand that
    // satisfies the suite's thumbs-up must not be one the detector would
    // consider not-a-fist at all, or the two would fire on disjoint gestures.
    const shape = handShape(handFor('thumbsUp'));
    const weakest = Math.max(
        shape.indexExtension, shape.middleExtension,
        shape.ringExtension, shape.pinkyExtension,
    );
    assert.ok(weakest <= 0.45,
        `weakest curled finger reads ${weakest}, above the detector's 0.45 ceiling`);
    assert.ok(shape.thumbExtension >= 0.45, `thumb reads ${shape.thumbExtension}`);
});
