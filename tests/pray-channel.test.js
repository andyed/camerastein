import test from 'node:test';
import assert from 'node:assert/strict';

import { makePrayPose, makeOpenPalmsPose } from '../js/lib/hand-pose-fixtures.js';
import { PRAY_CONFIG } from '../js/lib/pray-recognizer.js';

/** Minimal stand-in for MotionBus: subscribe/emit/state, same contract. */
function makeBus() {
    const handlers = new Map();
    return {
        _channels: { handPose: 'hand' },
        state: {},
        emitted: [],
        subscribe(name, handler) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name).add(handler);
        },
        emit(name, payload) {
            const key = this._channels[name];
            if (key) this.state[key] = payload;
            this.emitted.push({ name, payload });
            handlers.get(name)?.forEach((handler) => handler(payload));
        },
    };
}

async function withWindow(run) {
    const previous = globalThis.window;
    const bus = makeBus();
    const events = [];
    globalThis.window = {
        MotionBus: bus,
        dispatchEvent(event) { events.push(event); },
    };
    // The channel module caches nothing across imports beyond window.PrayGesture,
    // which the fresh window clears.
    const { initPrayChannel } = await import(`../js/lib/pray-channel.js?t=${Math.random()}`);
    try {
        return await run({ bus, events, channel: initPrayChannel(), window: globalThis.window });
    } finally {
        globalThis.window = previous;
    }
}

const handPose = (t, hands, confidence = 0.9) => ({
    t,
    confidence,
    handCount: hands.length,
    landmarks: hands[0] ?? null,
    landmarks2: hands[1] ?? null,
});

test('the channel publishes a pray frame for every hand frame', async () => {
    await withWindow(({ bus }) => {
        bus.emit('handPose', handPose(1000, makeOpenPalmsPose()));
        const published = bus.emitted.filter((e) => e.name === 'prayGesture');
        assert.equal(published.length, 1);
        assert.equal(published[0].payload.track.kind, 'pray');
    });
});

test('a held pose reaches the host as a camerastein:pray start event', async () => {
    await withWindow(({ bus, events }) => {
        const pray = makePrayPose();
        // 360 ms per frame ≈ the desktop overlay rate, comfortably inside the
        // discontinuity bound, so the dwell accumulates across real sampling.
        for (let i = 0; i < 6; i++) bus.emit('handPose', handPose(1000 + i * 360, pray));

        const phases = events.map((event) => event.detail.phase);
        assert.deepEqual(phases, ['start']);
        assert.equal(events[0].type, 'camerastein:pray');
        assert.equal(events[0].detail.kind, 'pray');
    });
});

test('a null hand payload clears the channel exactly once', async () => {
    await withWindow(({ bus }) => {
        bus.emit('handPose', handPose(1000, makePrayPose()));
        bus.emit('handPose', null);
        bus.emit('handPose', null);

        const published = bus.emitted.filter((e) => e.name === 'prayGesture');
        assert.equal(published.at(-1).payload, null);
        assert.equal(published.filter((e) => e.payload === null).length, 1,
            'a detached detector must not spam nulls');
    });
});

test('the flag disables the channel without tearing down the wiring', async () => {
    await withWindow(({ bus, window, channel }) => {
        window.__prayChannel = false;
        const pray = makePrayPose();
        for (let i = 0; i < 8; i++) bus.emit('handPose', handPose(1000 + i * 360, pray));
        assert.equal(channel.status().phase, 'idle');

        // status() is clocked against performance.now(), so stamp the resumed
        // frames in the recent past the way a live detector would.
        window.__prayChannel = true;
        const base = performance.now() - 3000;
        for (let i = 0; i < 8; i++) bus.emit('handPose', handPose(base + i * 360, pray));
        assert.equal(channel.status().phase, 'holding');
    });
});

test('status reports the criterion holding the gesture back', async () => {
    await withWindow(({ bus, channel }) => {
        bus.emit('handPose', handPose(performance.now() - 50, makePrayPose({ gap: 1.6 })));
        const status = channel.status();
        assert.equal(status.phase, 'idle');
        assert.ok(status.features.separation > PRAY_CONFIG.criteria.separation.enter,
            'the failing measurement is legible in status()');
    });
});

test('freshness is sized to the mobile overlay rate, not the face bound', async () => {
    await withWindow(({ bus, channel }) => {
        bus.emit('handPose', handPose(performance.now(), makePrayPose()));
        assert.equal(channel.read().fresh, true);
    });
});
