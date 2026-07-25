import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GESTURE_DEFINITIONS,
    createGestureRehearsal,
    runGestureRehearsal,
} from '../js/gesture-lab.js';

test('every gesture lab rehearsal completes its documented lifecycle', () => {
    for (const [kind, definition] of Object.entries(GESTURE_DEFINITIONS)) {
        const result = runGestureRehearsal(kind, 1000);
        assert.equal(result.passed, true, `${kind}: ${result.phases.join(' → ')}`);
        assert.deepEqual(result.phases, definition.expected);
        assert.ok(result.events.every(event => event.kind === kind));
        assert.ok(result.events.every(event => Number.isFinite(event.strength)));
    }
});

test('rehearsal sequences are clock-explicit, ordered, and camera-independent', () => {
    for (const kind of Object.keys(GESTURE_DEFINITIONS)) {
        const frames = createGestureRehearsal(kind, 5000);
        assert.ok(frames.length >= 4);
        assert.equal(frames[0].t, 5000);
        assert.ok(frames.every((frame, index) =>
            index === 0 || frame.t > frames[index - 1].t
        ));
        assert.ok(frames.every(frame => frame.quality.facePresent === 1));
        assert.ok(frames.every(frame => frame.quality.hasExpressions === 1));
    }
});

test('unknown rehearsal names fail loudly instead of exercising the wrong recognizer', () => {
    assert.throws(
        () => createGestureRehearsal('pirouette'),
        /Unknown gesture rehearsal/
    );
});
