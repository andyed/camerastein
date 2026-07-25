import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FaceGestureRecognizer,
    GESTURE_CONTRACT_VERSION,
    initFaceGestureChannel,
} from '../js/tasks-vision/face-gesture-channel.js';

function features(t, overrides = {}) {
    return {
        v: 1,
        t,
        quality: {
            confidence: 1,
            facePresent: 1,
            hasExpressions: 1,
            calibrated: true,
            ...(overrides.quality || {}),
        },
        expression: {
            jawOpen: 0,
            browRaiseL: 0,
            browRaiseR: 0,
            ...(overrides.expression || {}),
        },
        pose: {
            pitch: 0,
            yaw: 0,
            proximity: 0,
            ...(overrides.pose || {}),
        },
        dynamics: {
            jawVel: 0,
            browLVel: 0,
            browRVel: 0,
            pitchVel: 0,
            yawVel: 0,
            proximityVel: 0,
            ...(overrides.dynamics || {}),
        },
        authority: overrides.authority ?? 0,
    };
}

function phases(frame, kind) {
    return frame.events.filter(event => event.kind === kind).map(event => event.phase);
}

function eventsOf(frame, kind) {
    return frame.events.filter(event => event.kind === kind);
}

function assertAllFinite(value, path = 'frame') {
    if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${path} should be finite, got ${value}`);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        assertAllFinite(child, `${path}.${key}`);
    }
}

test('mouth emits one start → peak → release lifecycle with a stable episode id', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    const start = r.update(features(40, {
        expression: { jawOpen: 0.45 },
        dynamics: { jawVel: 1.2 },
    }));
    const rising = r.update(features(80, {
        expression: { jawOpen: 0.82 },
        dynamics: { jawVel: 0.8 },
    }));
    const peak = r.update(features(120, {
        expression: { jawOpen: 0.8 },
        dynamics: { jawVel: 0 },
    }));
    const release = r.update(features(180, {
        expression: { jawOpen: 0.1 },
        dynamics: { jawVel: -1 },
    }));

    assert.equal(start.v, GESTURE_CONTRACT_VERSION);
    assert.deepEqual(phases(start, 'mouth'), ['start']);
    assert.deepEqual(phases(rising, 'mouth'), []);
    assert.deepEqual(phases(peak, 'mouth'), ['peak']);
    assert.deepEqual(phases(release, 'mouth'), ['release']);
    const ids = [
        ...eventsOf(start, 'mouth'),
        ...eventsOf(peak, 'mouth'),
        ...eventsOf(release, 'mouth'),
    ].map(event => event.episodeId);
    assert.equal(new Set(ids).size, 1);
    assert.equal(release.tracks.mouth.phase, 'idle');
});

test('mouth hysteresis prevents threshold chatter and repeats only after release', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    const start = r.update(features(40, {
        expression: { jawOpen: 0.36 },
        dynamics: { jawVel: 0.4 },
    }));
    const nearEnter = r.update(features(80, {
        expression: { jawOpen: 0.34 },
        dynamics: { jawVel: -0.05 },
    }));
    const nearExit = r.update(features(120, {
        expression: { jawOpen: 0.21 },
        dynamics: { jawVel: -0.05 },
    }));
    const release = r.update(features(160, {
        expression: { jawOpen: 0.19 },
        dynamics: { jawVel: -0.3 },
    }));
    const restart = r.update(features(220, {
        expression: { jawOpen: 0.4 },
        dynamics: { jawVel: 0.5 },
    }));

    assert.deepEqual(phases(start, 'mouth'), ['start']);
    assert.deepEqual(phases(nearEnter, 'mouth'), ['peak']);
    assert.deepEqual(phases(nearExit, 'mouth'), []);
    assert.deepEqual(phases(release, 'mouth'), ['release']);
    assert.deepEqual(phases(restart, 'mouth'), ['start']);
    assert.notEqual(
        eventsOf(start, 'mouth')[0].episodeId,
        eventsOf(restart, 'mouth')[0].episodeId
    );
});

test('brow events preserve left/right/both participation through a lifecycle', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    const left = r.update(features(40, {
        expression: { browRaiseL: 0.55, browRaiseR: 0.1 },
        dynamics: { browLVel: 1, browRVel: 0 },
    }));
    const leftRelease = r.update(features(90, {
        dynamics: { browLVel: -1 },
    }));
    const both = r.update(features(150, {
        expression: { browRaiseL: 0.6, browRaiseR: 0.65 },
        dynamics: { browLVel: 1, browRVel: 1 },
    }));

    assert.equal(eventsOf(left, 'brow')[0].side, 'left');
    assert.equal(eventsOf(leftRelease, 'brow').at(-1).side, 'left');
    assert.equal(eventsOf(both, 'brow')[0].side, 'both');
    assert.equal(both.tracks.brow.side, 'both');
});

test('lean-in and lean-out remain separate signed episodes', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    const leanIn = r.update(features(40, {
        pose: { proximity: 0.5 },
        dynamics: { proximityVel: 0.9 },
    }));
    const releaseIn = r.update(features(80, {
        pose: { proximity: 0 },
        dynamics: { proximityVel: -0.9 },
    }));
    const leanOut = r.update(features(120, {
        pose: { proximity: -0.5 },
        dynamics: { proximityVel: -0.9 },
    }));

    assert.deepEqual(phases(leanIn, 'leanIn'), ['start']);
    assert.deepEqual(phases(leanIn, 'leanOut'), []);
    assert.equal(eventsOf(releaseIn, 'leanIn').at(-1).phase, 'release');
    assert.deepEqual(phases(leanOut, 'leanOut'), ['start']);
    assert.deepEqual(phases(leanOut, 'leanIn'), []);
});

test('geometry-only frames suppress mouth, brow, and scream intent', () => {
    const r = new FaceGestureRecognizer();
    const frame = r.update(features(0, {
        quality: { hasExpressions: 0 },
        expression: { jawOpen: 1, browRaiseL: 1, browRaiseR: 1 },
        dynamics: { jawVel: 9, browLVel: 9, browRVel: 9 },
    }));

    assert.equal(frame.tracks.mouth.active, false);
    assert.equal(frame.tracks.brow.active, false);
    assert.equal(frame.compound.scream.active, false);
});

test('shared recognizer completes a nod after reversal and neutral return', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    assert.deepEqual(phases(r.update(features(50, {
        pose: { pitch: 0.16 },
        dynamics: { pitchVel: 0.6 },
    })), 'nod'), ['start']);
    r.update(features(100, {
        pose: { pitch: 0.22 },
        dynamics: { pitchVel: 0.3 },
    }));
    assert.deepEqual(phases(r.update(features(160, {
        pose: { pitch: 0.12 },
        dynamics: { pitchVel: -0.5 },
    })), 'nod'), ['peak']);
    assert.deepEqual(phases(r.update(features(220, {
        pose: { pitch: 0.01 },
        dynamics: { pitchVel: -0.3 },
    })), 'nod'), ['complete']);
});

test('nod does not complete without neutral return and respects refractory time', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    r.update(features(50, {
        pose: { pitch: 0.17 },
        dynamics: { pitchVel: 0.6 },
    }));
    const reverseOnly = r.update(features(120, {
        pose: { pitch: 0.11 },
        dynamics: { pitchVel: -0.5 },
    }));
    const stillAway = r.update(features(180, {
        pose: { pitch: 0.08 },
        dynamics: { pitchVel: -0.1 },
    }));
    const complete = r.update(features(230, {
        pose: { pitch: 0.01 },
        dynamics: { pitchVel: -0.3 },
    }));
    const tooSoon = r.update(features(300, {
        pose: { pitch: 0.18 },
        dynamics: { pitchVel: 0.6 },
    }));
    const rearmed = r.update(features(620, {
        pose: { pitch: 0.18 },
        dynamics: { pitchVel: 0.6 },
    }));

    assert.deepEqual(phases(reverseOnly, 'nod'), ['peak']);
    assert.deepEqual(phases(stillAway, 'nod'), []);
    assert.deepEqual(phases(complete, 'nod'), ['complete']);
    assert.deepEqual(phases(tooSoon, 'nod'), []);
    assert.deepEqual(phases(rearmed, 'nod'), ['start']);
});

test('an overlong incomplete nod times out without a completion event', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    r.update(features(50, {
        pose: { pitch: 0.18 },
        dynamics: { pitchVel: 0.6 },
    }));
    const timedOut = r.update(features(1200, {
        pose: { pitch: 0.2 },
        dynamics: { pitchVel: 0 },
    }));

    assert.deepEqual(phases(timedOut, 'nod'), []);
    assert.equal(timedOut.cycles.nod.active, false);
});

test('shared recognizer requires the opposite yaw lobe for a shake', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    r.update(features(50, {
        pose: { yaw: 0.18 },
        dynamics: { yawVel: 0.6 },
    }));
    r.update(features(100, {
        pose: { yaw: 0.22 },
        dynamics: { yawVel: 0.3 },
    }));
    const home = r.update(features(150, {
        pose: { yaw: 0 },
        dynamics: { yawVel: -0.5 },
    }));
    assert.deepEqual(phases(home, 'shake'), ['peak']);
    assert.equal(home.cycles.shake.active, true);

    const opposite = r.update(features(190, {
        pose: { yaw: -0.13 },
        dynamics: { yawVel: -0.5 },
    }));
    assert.deepEqual(phases(opposite, 'shake'), ['complete']);
    assert.equal(eventsOf(opposite, 'shake')[0].direction, 'right-left');
    assert.equal(opposite.cycles.shake.active, false);
});

test('scream requires jaw and brow together, emits once while held, and rearms after refractory', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    const mouthOnly = r.update(features(50, {
        expression: { jawOpen: 0.85 },
        dynamics: { jawVel: 1 },
    }));
    r.update(features(100));
    const browOnly = r.update(features(150, {
        expression: { browRaiseL: 0.7, browRaiseR: 0.7 },
        dynamics: { browLVel: 1, browRVel: 1 },
    }));
    r.update(features(200));
    const start = r.update(features(250, {
        expression: { jawOpen: 0.8, browRaiseL: 0.6, browRaiseR: 0.6 },
    }));
    const held = r.update(features(320, {
        expression: { jawOpen: 0.9, browRaiseL: 0.7, browRaiseR: 0.7 },
    }));
    const release = r.update(features(400));
    const tooSoon = r.update(features(600, {
        expression: { jawOpen: 0.8, browRaiseL: 0.6, browRaiseR: 0.6 },
    }));
    r.update(features(800));
    const rearmed = r.update(features(1150, {
        expression: { jawOpen: 0.8, browRaiseL: 0.6, browRaiseR: 0.6 },
    }));

    assert.deepEqual(phases(mouthOnly, 'scream'), []);
    assert.deepEqual(phases(browOnly, 'scream'), []);
    assert.deepEqual(phases(start, 'scream'), ['start']);
    assert.deepEqual(phases(held, 'scream'), []);
    assert.deepEqual(phases(release, 'scream'), ['release']);
    assert.deepEqual(phases(tooSoon, 'scream'), []);
    assert.deepEqual(phases(rearmed, 'scream'), ['start']);
});

test('untrustworthy face input clears every in-flight gesture state', () => {
    const r = new FaceGestureRecognizer();
    r.update(features(0));
    r.update(features(50, {
        expression: { jawOpen: 0.8 },
        pose: { yaw: 0.2 },
        dynamics: { jawVel: 1, yawVel: 0.6 },
    }));
    const absent = r.update(features(100, {
        quality: { facePresent: 0, confidence: 0 },
    }));
    const returned = r.update(features(200));

    assert.equal(absent, null);
    assert.equal(returned.tracks.mouth.phase, 'idle');
    assert.equal(returned.cycles.shake.phase, 'idle');
    assert.deepEqual(returned.events, []);
});

test('hostile feature values never produce non-finite gesture output', () => {
    const r = new FaceGestureRecognizer();
    const frame = r.update(features(NaN, {
        quality: { confidence: 1 },
        expression: {
            jawOpen: NaN,
            browRaiseL: Infinity,
            browRaiseR: -Infinity,
        },
        pose: { pitch: NaN, yaw: Infinity, proximity: -Infinity },
        dynamics: {
            jawVel: NaN,
            browLVel: Infinity,
            browRVel: -Infinity,
            pitchVel: -Infinity,
            yawVel: NaN,
            proximityVel: Infinity,
        },
        authority: Infinity,
    }));

    assertAllFinite(frame);
    assert.equal(frame.v, GESTURE_CONTRACT_VERSION);
});

function fakeBus() {
    const handlers = new Map();
    return {
        _channels: { faceFeatures: 'faceFeatures' },
        state: { faceFeatures: null },
        subscribe(name, handler) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name).add(handler);
            return () => handlers.get(name)?.delete(handler);
        },
        emit(name, payload) {
            const stateKey = this._channels[name];
            if (stateKey) this.state[stateKey] = payload;
            for (const handler of handlers.get(name) || []) handler(payload);
        },
    };
}

test('channel registration is idempotent, flag-gated, fresh, and clears on loss', () => {
    const previousWindow = globalThis.window;
    const bus = fakeBus();
    globalThis.window = {
        MotionBus: bus,
        __faceGestureChannel: false,
    };
    try {
        const first = initFaceGestureChannel();
        const second = initFaceGestureChannel();
        assert.equal(first, second);
        assert.equal(bus._channels.faceGestures, 'faceGestures');
        assert.equal(bus.state.faceGestures, null);

        bus.emit('faceFeatures', features(performance.now()));
        assert.equal(bus.state.faceGestures, null);

        globalThis.window.__faceGestureChannel = true;
        bus.emit('faceFeatures', features(performance.now()));
        assert.equal(bus.state.faceGestures.v, GESTURE_CONTRACT_VERSION);
        assert.equal(first.read().fresh, true);

        bus.emit('faceFeatures', features(performance.now() - 1000));
        assert.equal(first.read().fresh, false);

        bus.emit('faceFeatures', null);
        assert.equal(bus.state.faceGestures, null);
        globalThis.window.__faceGestureChannel = false;
        bus.emit('faceFeatures', features(performance.now()));
        assert.equal(bus.state.faceGestures, null);
    } finally {
        if (typeof previousWindow === 'undefined') delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
