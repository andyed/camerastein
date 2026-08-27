import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HAND_GESTURE_DEFINITIONS,
    HAND_GESTURE_IDS,
    runHandRehearsal,
} from '../js/hand-gesture-lab.js';

/** Held poses have a rehearsal; transients (the air-drum strike) do not. */
const REHEARSABLE = HAND_GESTURE_IDS.filter(
    (kind) => HAND_GESTURE_DEFINITIONS[kind].render === 'pose');

test('every held pose rehearsal completes its documented lifecycle', () => {
    assert.ok(REHEARSABLE.length >= 8, `only ${REHEARSABLE.length} poses registered`);
    for (const kind of REHEARSABLE) {
        const def = HAND_GESTURE_DEFINITIONS[kind];
        const result = runHandRehearsal(kind);
        assert.equal(result.passed, true, `${kind}: ${result.phases.join(' → ')}`);
        assert.deepEqual(result.phases, def.expected);
    }
});

test('a transient gesture refuses a rehearsal instead of faking one', () => {
    const transients = HAND_GESTURE_IDS.filter(
        (kind) => HAND_GESTURE_DEFINITIONS[kind].render === 'transient');
    assert.ok(transients.length > 0, 'the strike family should be registered');
    for (const kind of transients) {
        const def = HAND_GESTURE_DEFINITIONS[kind];
        assert.deepEqual(def.expected, [], `${kind} must not claim a lifecycle`);
        assert.deepEqual(def.criteria, [], `${kind} must not claim criteria`);
        assert.throws(() => runHandRehearsal(kind), /has no rehearsal/);
    }
});

test('rehearsals are clock-explicit and camera-independent', () => {
    for (const kind of REHEARSABLE) {
        // Same script, different start time and sampling rate: the lifecycle is
        // in milliseconds, so it must not depend on either.
        const a = runHandRehearsal(kind, 0, 360);
        const b = runHandRehearsal(kind, 900_000, 360);
        assert.deepEqual(a.phases, b.phases);
        assert.ok(a.frames.every((frame, i) => i === 0 || frame.t > a.frames[i - 1].t));
    }
});

test('every registry entry declares what the lab needs to render it', () => {
    for (const kind of HAND_GESTURE_IDS) {
        const def = HAND_GESTURE_DEFINITIONS[kind];
        assert.ok(def.label && def.family && def.cue, `${kind} is missing a label/family/cue`);
        assert.ok(def.channel, `${kind} has no MotionBus channel`);
        assert.equal(typeof def.select, 'function', `${kind} has no channel selector`);
        assert.equal(typeof def.host, 'function');
        assert.ok(['pose', 'transient'].includes(def.render), `${kind}.render`);

        if (def.render === 'pose') {
            assert.ok(def.expected.length > 0 && def.criteria.length > 0);
            assert.equal(typeof def.createRecognizer, 'function');
            assert.equal(typeof def.rehearsal, 'function');
            // Every rendered criterion must exist in the recognizer's config, or
            // the lab silently shows a bound of "undefined".
            for (const { key } of def.criteria) {
                assert.ok(def.defaultConfig.criteria[key], `${kind}.${key} has no config`);
            }
        }
        for (const { flag, base } of def.sliders) {
            assert.match(flag, /^__[a-z][A-Za-z]+$/, flag);
            assert.ok(Number.isFinite(base), `${flag} has no numeric default`);
        }
    }
});

test('the frames a rehearsal produces carry the fields the lab reads', () => {
    const { frames } = runHandRehearsal(REHEARSABLE[0]);
    for (const frame of frames) {
        assert.equal(typeof frame.quality.reason, 'string');
        assert.ok(Array.isArray(frame.quality.blockedBy));
        assert.equal(typeof frame.track.phase, 'string');
        assert.ok(Number.isFinite(frame.track.dwell));
        assert.ok(Number.isFinite(frame.track.value));
    }
});

test('unknown rehearsal names fail loudly instead of running the wrong recognizer', () => {
    assert.throws(() => runHandRehearsal('levitate'), /Unknown hand gesture rehearsal/);
});
