import test from 'node:test';
import assert from 'node:assert/strict';

import { palmFrame, twoHandGeometry, handFlatness } from '../js/lib/hand-pose-features.js';
import {
    makeHand,
    makePrayPose,
    makeOpenPalmsPose,
    makeFlatSandwichPose,
    jitterDepth,
    flattenThumb,
} from '../js/lib/hand-pose-fixtures.js';
import { PrayRecognizer, measurePray, PRAY_CONFIG } from '../js/lib/pray-recognizer.js';

const FRAME_MS = 120;

/** Drive the recognizer over a scripted pose sequence and collect every event. */
function run(recognizer, script, { startT = 1000, frameMs = FRAME_MS } = {}) {
    const events = [];
    const frames = [];
    let t = startT;
    for (const { hands, count = 1, confidence = 1 } of script) {
        for (let i = 0; i < count; i++) {
            const frame = recognizer.update({ t, hands: hands ?? [], confidence });
            frames.push(frame);
            events.push(...frame.events);
            t += frameMs;
        }
    }
    return { events, frames, phases: events.map((event) => event.phase) };
}

// ── Geometry ────────────────────────────────────────────────────────────────

test('palm frame is invariant to where and how large the hand is', () => {
    const near = makeHand({ palmCenter: { x: 0.5, y: 0.5, z: 0 }, scale: 0.16 });
    const far = makeHand({ palmCenter: { x: 0.2, y: 0.8, z: 0 }, scale: 0.05 });

    const a = palmFrame(near);
    const b = palmFrame(far);

    // scale is image-plane, so it tracks the projected size, not the 3D one.
    assert.ok(a.scale > b.scale * 2, `${a.scale} vs ${b.scale}`);
    // Same pose at two sizes and positions: identical orientation.
    for (const key of ['x', 'y']) {
        assert.ok(Math.abs(a.axis[key] - b.axis[key]) < 1e-6, `axis.${key}`);
    }
    for (const key of ['x', 'y', 'z']) {
        assert.ok(Math.abs(a.normal[key] - b.normal[key]) < 1e-6, `normal.${key}`);
    }
});

test('every criterion is immune to depth noise', () => {
    // MediaPipe reports x and y well and z poorly. Scramble only z; nothing the
    // recognizer gates on may move. A 3D palm-centre separation inflates 6.6×
    // under the same jitter, which is why none of these use z.
    const clean = measurePray(...makePrayPose());
    const noisy = measurePray(...jitterDepth(makePrayPose(), 0.4));

    for (const key of ['separation', 'axisAlignment', 'uprightness',
        'foreshortening', 'flatness', 'palmOpposition']) {
        assert.ok(Math.abs(clean[key] - noisy[key]) < 1e-9,
            `${key} drifted ${clean[key]} → ${noisy[key]} on depth noise alone`);
    }
});

test('a real left/right pair in prayer reads normalDot +1, not −1', () => {
    // The original bug in one assertion. The cross product that builds the
    // normal is mirror-sensitive, so it points out of the palm on one hand and
    // out of the back on the other. Asking for −1 asked for the one value the
    // pose cannot produce.
    assert.ok(measurePray(...makePrayPose()).normalDot > 0.9);
});

test('palmOpposition survives both chirality labels landing on the same hand', () => {
    // Occlusion makes MediaPipe mislabel handedness. A criterion built on the
    // chirality-sensitive cross product flips when that happens; one built on
    // the thumbs does not.
    const mislabelled = [
        makePrayPose()[0],
        makeHand({
            chirality: 'right',                       // wrong label for this hand
            palmCenter: { x: 0.4847, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: 1, y: 0, z: 0 },
        }),
    ];
    const correct = measurePray(...makePrayPose());
    const wrong = measurePray(...mislabelled);

    assert.ok(correct.palmOpposition < -0.9 && wrong.palmOpposition < -0.9,
        'opposition holds either way');
    assert.ok(correct.normalDot > 0.9 && wrong.normalDot < -0.9,
        'the normal does not');
});

test('foreshortening separates pressed palms from palms held toward the camera', () => {
    assert.ok(measurePray(...makePrayPose()).foreshortening < 0.2, 'edge-on');
    assert.ok(measurePray(...makeFlatSandwichPose()).foreshortening > 0.8, 'facing the lens');
});

test('separation is measured in hand-widths, not screen-widths', () => {
    // The same pray pose at two camera distances must read the same separation.
    const close = makePrayPose({ scale: 0.16 });
    const distant = makePrayPose({ scale: 0.05 });

    const a = twoHandGeometry(palmFrame(close[0]), palmFrame(close[1]));
    const b = twoHandGeometry(palmFrame(distant[0]), palmFrame(distant[1]));

    assert.ok(Math.abs(a.separation - b.separation) < 1e-6,
        `${a.separation} vs ${b.separation}`);
    // Raw screen distance, which handPoseDetector.twoHandDistance uses, does not.
    const rawClose = Math.hypot(close[0][0].x - close[1][0].x, close[0][0].y - close[1][0].y);
    const rawDistant = Math.hypot(distant[0][0].x - distant[1][0].x, distant[0][0].y - distant[1][0].y);
    assert.ok(rawClose > rawDistant * 2, 'screen-normalized distance is depth dependent');
});

test('flatness separates a flat hand from a curled one, edge-on', () => {
    // Edge-on is the orientation pray is performed in, and the only one where
    // projected extension is honest: the curl happens in the image plane, so
    // the 2D and 3D base-to-tip distances are identical. The bounds below are
    // pray's own, so this fails if the fixture and the thresholds drift apart.
    const edgeOn = (curl) => handFlatness(makeHand({ curl, palmDirection: { x: -1, y: 0, z: 0 } }));
    assert.ok(edgeOn(0) > 0.98, `flat ${edgeOn(0)}`);
    assert.ok(edgeOn(0.5) > PRAY_CONFIG.criteria.flatness.enter,
        `a slightly bent hand should still read as a pray: ${edgeOn(0.5)}`);
    assert.ok(edgeOn(0.7) < PRAY_CONFIG.criteria.flatness.enter, `bent ${edgeOn(0.7)}`);
    assert.ok(edgeOn(1) < PRAY_CONFIG.criteria.flatness.exit, `fisted ${edgeOn(1)}`);
});

test('projected extension is direction-dependent, which is why poses gate on facing', () => {
    // The same fully curled finger, twice. Facing the camera the curl runs into
    // depth and the projection collapses to ~0.16; edge-on it runs across the
    // image, projection is exact, and it reads ~0.71. A "curled" threshold
    // calibrated in one orientation means nothing in the other — which is why
    // every one-hand pose in the suite makes facing the camera a criterion
    // rather than an assumption.
    const facing = makeHand({ curl: 1, palmDirection: { x: 0, y: 0, z: -1 } });
    const edgeOn = makeHand({ curl: 1, palmDirection: { x: -1, y: 0, z: 0 } });

    assert.ok(handFlatness(facing) < 0.35, `facing ${handFlatness(facing)}`);
    assert.ok(handFlatness(edgeOn) > 0.65, `edge-on ${handFlatness(edgeOn)}`);
    assert.ok(palmFrame(facing).aspect > 0.8 && palmFrame(edgeOn).aspect < 0.2,
        'and aspect is what tells them apart');
});
test('measurePray returns null rather than a degenerate reading', () => {
    assert.equal(measurePray(null, makeHand()), null);
    assert.equal(measurePray(makeHand(), undefined), null);
    assert.equal(measurePray([{ x: 0, y: 0, z: 0 }], makeHand()), null);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('a held prayer pose completes start → peak → release', () => {
    const { phases, events } = run(new PrayRecognizer(), [
        { hands: makeOpenPalmsPose(), count: 3 },
        { hands: makePrayPose(), count: 12 },
        { hands: makeOpenPalmsPose(), count: 4 },
    ]);

    assert.deepEqual(phases, ['start', 'peak', 'release']);
    assert.ok(events.every((event) => event.kind === 'pray'));
    assert.ok(events.every((event) => Number.isFinite(event.strength)));
    // Event ids are stable and unique within the episode.
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    assert.equal(events.at(-1).durationMs > 0, true);
});

test('the dwell suppresses hands that only pass through the pose', () => {
    const framesBelowDwell = Math.floor(PRAY_CONFIG.holdMs / FRAME_MS) - 1;
    const { events } = run(new PrayRecognizer(), [
        { hands: makePrayPose(), count: framesBelowDwell },
        { hands: makeOpenPalmsPose(), count: 6 },
    ]);

    assert.deepEqual(events, [], 'a brief pass through the pose must not fire');
});

test('an abandoned attempt bleeds off instead of banking progress', () => {
    const recognizer = new PrayRecognizer();
    const almost = Math.floor(PRAY_CONFIG.holdMs / FRAME_MS) - 1;

    const { frames } = run(recognizer, [
        { hands: makePrayPose(), count: almost },
        { hands: makeOpenPalmsPose(), count: 8 },
    ]);

    const residue = frames.at(-1).track.dwell;
    assert.ok(residue < 0.1, `charge must bleed off, left ${residue}`);

    // A second partial attempt must not complete on the leftovers of the first.
    const second = run(recognizer, [{ hands: makePrayPose(), count: almost }]);
    assert.deepEqual(second.events, []);
});

test('a sampling gap cannot be credited to the dwell', () => {
    const recognizer = new PrayRecognizer();
    // One frame, then a blackout longer than the tolerated sampling interval,
    // then a single frame of a perfect pose. Nothing may fire on arrival.
    recognizer.update({ t: 1000, hands: makePrayPose() });
    const resumed = recognizer.update({
        t: 1000 + PRAY_CONFIG.maxFrameGapMs + 1,
        hands: makePrayPose(),
    });

    assert.deepEqual(resumed.events, []);
    assert.equal(resumed.track.dwell, 0, 'the blackout credits nothing');
});

test('a gap during an episode closes it with a dated release', () => {
    const recognizer = new PrayRecognizer();
    run(recognizer, [{ hands: makePrayPose(), count: 10 }]);
    assert.equal(recognizer.track.active, true);
    const lastGood = recognizer._lastGoodT;

    const resumed = recognizer.update({
        t: lastGood + PRAY_CONFIG.maxFrameGapMs + 500,
        hands: makePrayPose(),
    });

    assert.deepEqual(resumed.events.map((event) => event.phase), ['peak', 'release']);
    const release = resumed.events.at(-1);
    assert.equal(release.reason, 'discontinuity');
    // Dated to the last frame actually observed, not to the resume.
    assert.ok(release.durationMs < PRAY_CONFIG.maxFrameGapMs,
        `release dated to the blackout: ${release.durationMs}`);
    assert.equal(resumed.track.active, false);
});

test('an occluded frame is coasted through, not treated as a release', () => {
    const dropped = Math.floor(PRAY_CONFIG.nilToleranceMs / FRAME_MS);
    const { phases, frames } = run(new PrayRecognizer(), [
        { hands: makePrayPose(), count: 8 },
        { hands: [], count: dropped },
        { hands: makePrayPose(), count: 4 },
        { hands: makeOpenPalmsPose(), count: 4 },
    ]);

    assert.deepEqual(phases, ['start', 'peak', 'release'], 'one episode, not two');
    assert.ok(frames.some((frame) => frame.quality.degraded), 'coasting must be reported');
});

test('losing the hands past the nil tolerance ends the episode', () => {
    const dropped = Math.ceil(PRAY_CONFIG.nilToleranceMs / FRAME_MS) + 4;
    const { phases } = run(new PrayRecognizer(), [
        { hands: makePrayPose(), count: 8 },
        { hands: [], count: dropped },
    ]);

    assert.deepEqual(phases, ['start', 'peak', 'release']);
});

test('the recognizer is clock-explicit and owns no timers', () => {
    // Same frame count, ten times the elapsed time: the dwell is in milliseconds,
    // so the slow sampling completes and a burst of frames in no time does not.
    const slow = run(new PrayRecognizer(), [{ hands: makePrayPose(), count: 4 }], { frameMs: 300 });
    const fast = run(new PrayRecognizer(), [{ hands: makePrayPose(), count: 4 }], { frameMs: 40 });

    assert.deepEqual(slow.phases, ['start']);
    assert.deepEqual(fast.phases, []);
});

test('reset clears the episode, the charge, and the refractory window', () => {
    const recognizer = new PrayRecognizer();
    run(recognizer, [{ hands: makePrayPose(), count: 10 }]);
    assert.equal(recognizer.track.active, true);

    recognizer.reset();
    assert.equal(recognizer.track.active, false);
    assert.equal(recognizer.track.dwell, 0);
    assert.equal(recognizer.features, null);
});

// ── Rejections ──────────────────────────────────────────────────────────────

const REJECTED = {
    'open palms held apart': makeOpenPalmsPose(),
    'palms together but fingers curled': makePrayPose({ curl: 0.7 }),
    'two flat palms held close, facing the camera': makeFlatSandwichPose(),
    'hands a full hand-width apart': makePrayPose({ gap: 1.6 }),
    'hands tipped past horizontal': makePrayPose({ tilt: 1.5 }),
    'one hand only': [makeHand()],
    'no hands': [],
};

for (const [label, hands] of Object.entries(REJECTED)) {
    test(`does not fire on ${label}`, () => {
        const { events } = run(new PrayRecognizer(), [{ hands, count: 20 }]);
        assert.deepEqual(events, [], `${label} produced ${events.map((e) => e.phase)}`);
    });
}

test('a handshake opposes the finger axes and is rejected', () => {
    // Palms face each other exactly as in pray, but the fingers point at each
    // other rather than the same way. normalDot alone cannot tell these apart.
    const hands = [
        makeHand({
            chirality: 'right',
            palmCenter: { x: 0.52, y: 0.5, z: 0 },
            axis: { x: -1, y: 0, z: 0 },
            normal: { x: 0, y: -1, z: 0 },
        }),
        makeHand({
            chirality: 'left',
            palmCenter: { x: 0.48, y: 0.5, z: 0 },
            axis: { x: 1, y: 0, z: 0 },
            normal: { x: 0, y: 1, z: 0 },
        }),
    ];
    const geometry = twoHandGeometry(palmFrame(hands[0]), palmFrame(hands[1]));
    assert.ok(geometry.normalDot < -0.9, 'palms are opposed, like pray');
    assert.ok(geometry.axisAlignment < -0.9, 'but the fingers are not');

    const { events } = run(new PrayRecognizer(), [{ hands, count: 20 }]);
    assert.deepEqual(events, []);
});

test('low tracker confidence never starts an episode', () => {
    const { events } = run(new PrayRecognizer(), [
        { hands: makePrayPose(), count: 20, confidence: 0.1 },
    ]);
    assert.deepEqual(events, []);
});

test('non-finite landmarks are rejected without throwing', () => {
    const broken = makePrayPose();
    broken[0][0] = { x: NaN, y: 0.5, z: 0 };
    const recognizer = new PrayRecognizer();
    assert.doesNotThrow(() => run(recognizer, [{ hands: broken, count: 12 }]));
});

// ── Occlusion ───────────────────────────────────────────────────────────────

test('a pray whose palm normal has inverted still fires', () => {
    // The live failure: depth noise flips normalDot to +1 while the pose is
    // held perfectly. Before foreshortening carried the evidence, this pose
    // could satisfy four criteria out of five and never start.
    const noisy = jitterDepth(makePrayPose(), 0.25);
    assert.ok(measurePray(...noisy).normalDot > 0.9, 'the normal is reporting the opposite');

    const { phases } = run(new PrayRecognizer(), [
        { hands: noisy, count: 10 },
        { hands: makeOpenPalmsPose(), count: 4 },
    ]);
    assert.deepEqual(phases, ['start', 'peak', 'release']);
});

test('two flat palms held close but facing the camera are rejected on foreshortening', () => {
    // Separation alone would accept this — the palms really are close. It is
    // the fact that neither palm is turned away that rules it out.
    const measured = measurePray(...makeFlatSandwichPose());
    assert.ok(measured.separation < PRAY_CONFIG.criteria.separation.enter,
        'close enough to pass separation');

    const frame = new PrayRecognizer().update({
        t: 1000, hands: makeFlatSandwichPose(), confidence: 0.9,
    });
    assert.deepEqual(frame.quality.blockedBy, ['foreshortening']);
});

test('two edge-on hands facing the same way are rejected on palm opposition', () => {
    const sameWay = [
        makeHand({
            chirality: 'right', palmCenter: { x: 0.515, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 }, palmDirection: { x: -1, y: 0, z: 0 },
        }),
        makeHand({
            chirality: 'left', palmCenter: { x: 0.485, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 }, palmDirection: { x: -1, y: 0, z: 0 },
        }),
    ];
    const frame = new PrayRecognizer().update({ t: 1000, hands: sameWay, confidence: 0.9 });
    assert.deepEqual(frame.quality.blockedBy, ['palmOpposition']);
});

test('one hand alone can never start a pray', () => {
    const lone = [makePrayPose()[0]];
    const { events, frames } = run(new PrayRecognizer(), [{ hands: lone, count: 20 }]);

    assert.deepEqual(events, []);
    assert.equal(frames.at(-1).quality.reason, 'one-hand');
});

test('an armed single hand sustains a pose the two-hand frames vouched for', () => {
    const pray = makePrayPose();
    // Two hands long enough to arm, then one hand occludes the other for the
    // rest of the dwell. The episode must still complete.
    const { phases, frames } = run(new PrayRecognizer(), [
        { hands: pray, count: 2 },
        { hands: [pray[0]], count: 6 },
    ]);

    assert.deepEqual(phases, ['start']);
    assert.equal(frames.at(-1).quality.reason, 'one-hand-armed');
    assert.equal(frames.at(-1).quality.degraded, true, 'degraded evidence must say so');
});

test('a still solo hand sustains the pose well past the arming window', () => {
    const pray = makePrayPose();
    // Four times the arming window on one hand alone. Occlusion in this pose
    // is not a blip to be coasted over — it is the steady state, so the solo
    // tier has to be open-ended.
    const longSolo = Math.ceil((PRAY_CONFIG.armMs * 4) / FRAME_MS);
    const { phases, frames } = run(new PrayRecognizer(), [
        { hands: pray, count: 8 },
        { hands: [pray[0]], count: longSolo },
    ]);

    assert.deepEqual(phases, ['start'], 'no release while the hand holds still');
    assert.equal(frames.at(-1).track.active, true);
    assert.equal(frames.at(-1).quality.reason, 'one-hand-armed');
    assert.ok(frames.at(-1).track.durationMs > PRAY_CONFIG.armMs * 3);
});

test('a solo hand that moves ends the episode', () => {
    // Stillness is the other half of the solo evidence. A hand on its way down,
    // or one whose partner has simply left, does not hold this.
    const pray = makePrayPose();
    const drifting = [];
    for (let i = 0; i < 14; i++) {
        drifting.push([makeHand({
            chirality: 'right',
            palmCenter: { x: 0.515 + i * 0.03, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: -1, y: 0, z: 0 },
        })]);
    }

    const recognizer = new PrayRecognizer();
    run(recognizer, [{ hands: pray, count: 8 }]);
    assert.equal(recognizer.track.active, true);

    const moved = run(recognizer, drifting.map((hands) => ({ hands, count: 1 })));
    assert.ok(moved.phases.includes('release'), moved.phases.join(','));
    assert.ok(moved.frames.some((f) => f.quality.reason === 'one-hand-moving'));
});

test('the solo drift gate is a rate, so it means the same at any sampling rate', () => {
    // The same physical movement over the same wall clock, sampled three times
    // as often. A per-frame bound would call the fast sampling still.
    const sweep = (frameMs, speedPerSecond) => {
        const recognizer = new PrayRecognizer();
        run(recognizer, [{ hands: makePrayPose(), count: 8 }], { frameMs });

        const steps = Math.round(600 / frameMs);
        const perFrame = (speedPerSecond * 0.096 * frameMs) / 1000;  // 0.096 ≈ one hand length
        const hands = [];
        for (let i = 0; i < steps; i++) {
            hands.push([makeHand({
                chirality: 'right',
                palmCenter: { x: 0.515 + i * perFrame, y: 0.52, z: 0 },
                axis: { x: 0, y: -1, z: 0 },
                palmDirection: { x: -1, y: 0, z: 0 },
            })]);
        }
        return run(recognizer, hands.map((h) => ({ hands: h, count: 1 })), { frameMs })
            .frames.some((f) => f.quality.reason === 'one-hand-moving');
    };

    assert.equal(sweep(120, 2.5), true, 'moving, sampled slowly');
    assert.equal(sweep(40, 2.5), true, 'the same movement, sampled fast');
    assert.equal(sweep(120, 0.3), false, 'holding, sampled slowly');
    assert.equal(sweep(40, 0.3), false, 'the same hold, sampled fast');
});

test('a lone hand that stops matching the pose ends the episode early', () => {
    const pray = makePrayPose();
    const curled = makeHand({ curl: 1, palmDirection: { x: -1, y: 0, z: 0 } });
    const { phases, frames } = run(new PrayRecognizer(), [
        { hands: pray, count: 8 },
        { hands: [curled], count: 10 },
    ]);

    assert.deepEqual(phases, ['start', 'peak', 'release']);
    assert.ok(frames.at(-1).quality.reason.startsWith('one-hand'));
});

test('occlusion assist can be switched off for strict two-hand behaviour', () => {
    const pray = makePrayPose();
    const recognizer = new PrayRecognizer({ occlusionAssist: false });
    const { phases } = run(recognizer, [
        { hands: pray, count: 2 },
        { hands: [pray[0]], count: 8 },
    ]);

    assert.deepEqual(phases, [], 'without assist, the dwell never completes');
});

test('every frame names why it did or did not qualify', () => {
    const recognizer = new PrayRecognizer();
    const reason = (hands, confidence = 0.9) =>
        recognizer.update({ t: (recognizer._lastT ?? 0) + 120, hands, confidence }).quality.reason;

    assert.equal(reason([]), 'no-hands');
    assert.equal(reason(makeOpenPalmsPose()), 'blocked');
    assert.equal(reason(makePrayPose()), 'ok');
    assert.equal(reason(makePrayPose(), 0.05), 'low-confidence');
});

test('blockedBy names every failing criterion, not just the first', () => {
    const frame = new PrayRecognizer().update({
        t: 1000, hands: makeOpenPalmsPose(), confidence: 0.9,
    });
    assert.ok(frame.quality.blockedBy.includes('separation'));
    assert.ok(frame.quality.blockedBy.includes('foreshortening'));
    assert.equal(frame.track.phase, 'idle');
});


// ── Regressions: measurements that collapsed in the pose they detect ────────

test('the hand size proxy does not change as the palm turns edge-on', () => {
    // A width-based proxy shrinks 1.75× between a palm facing the camera and
    // the same palm edge-on. Separation divides by it, so it inflated by that
    // factor in exactly the pose being recognized — and the threshold was
    // chasing a denominator that moved with the gesture.
    const turned = (deg) => {
        const r = (deg * Math.PI) / 180;
        return palmFrame(makeHand({
            palmDirection: { x: -Math.cos(r), y: 0, z: -Math.sin(r) },
        })).scale;
    };
    const edgeOn = turned(0);
    const facing = turned(90);
    assert.ok(Math.abs(edgeOn - facing) / facing < 0.02,
        `size proxy moved ${edgeOn} → ${facing} on palm rotation alone`);
});

test('a pray whose thumbs are unreadable still fires', () => {
    // An edge-on palm hides its thumb's sideways offset in depth, so palm
    // opposition degrades toward "cannot say" precisely as the pose perfects
    // itself. Ambiguity must pass; only a clear same-way reading may veto.
    const ambiguous = flattenThumb(makePrayPose());
    assert.ok(Math.abs(measurePray(...ambiguous).palmOpposition) < 0.2,
        'the thumbs carry no signal here');

    const { phases } = run(new PrayRecognizer(), [
        { hands: ambiguous, count: 10 },
        { hands: makeOpenPalmsPose(), count: 4 },
    ]);
    assert.deepEqual(phases, ['start', 'peak', 'release']);
});

test('palm opposition still vetoes two palms that clearly face the same way', () => {
    const sameWay = [
        makeHand({
            chirality: 'right', palmCenter: { x: 0.515, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 }, palmDirection: { x: -1, y: 0, z: 0 },
        }),
        makeHand({
            chirality: 'left', palmCenter: { x: 0.485, y: 0.52, z: 0 },
            axis: { x: 0, y: -1, z: 0 }, palmDirection: { x: -1, y: 0, z: 0 },
        }),
    ];
    const frame = new PrayRecognizer().update({ t: 1000, hands: sameWay, confidence: 0.9 });
    assert.deepEqual(frame.quality.blockedBy, ['palmOpposition']);
});

test('separation still measures the gap it is meant to measure', () => {
    const at = (gap) => measurePray(...makePrayPose({ gap })).separation;
    assert.ok(at(0.34) < at(0.8) && at(0.8) < at(1.4), 'monotonic in the gap');
    assert.ok(at(0.34) < PRAY_CONFIG.criteria.separation.enter, 'palms touching passes');
    assert.ok(at(1.4) > PRAY_CONFIG.criteria.separation.enter, 'a hand-length apart does not');
});

test('separation is unchanged by how edge-on the pair is', () => {
    // Same physical gap, palms rotated from edge-on toward the camera.
    const gap = 0.34;
    const pairAt = (deg) => {
        const r = (deg * Math.PI) / 180;
        const half = (gap * 0.09) / 2;
        return [
            makeHand({
                chirality: 'right', palmCenter: { x: 0.5 + half, y: 0.52, z: 0 },
                axis: { x: 0, y: -1, z: 0 },
                palmDirection: { x: -Math.cos(r), y: 0, z: -Math.sin(r) },
            }),
            makeHand({
                chirality: 'left', palmCenter: { x: 0.5 - half, y: 0.52, z: 0 },
                axis: { x: 0, y: -1, z: 0 },
                palmDirection: { x: Math.cos(r), y: 0, z: -Math.sin(r) },
            }),
        ];
    };
    const flat = measurePray(...pairAt(0)).separation;
    const angled = measurePray(...pairAt(35)).separation;
    assert.ok(Math.abs(flat - angled) / flat < 0.02,
        `separation moved ${flat} → ${angled} on palm rotation alone`);
});
