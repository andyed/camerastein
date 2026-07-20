import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../js/lib/camera-tracking-stats.js', import.meta.url),
    'utf8'
);

function freshStats() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.CameraTrackingStatsAPI.create();
}

test('summary derives rate and percentiles from explicit timestamps', () => {
    const stats = freshStats();
    // Four face inferences, 100ms apart: 10Hz, durations 10/20/30/40ms.
    [10, 20, 30, 40].forEach((ms, i) => stats.record('face', ms, i * 100));
    const s = stats.summary();
    assert.equal(s.face.n, 4);
    assert.equal(s.face.hz, 10);
    assert.equal(s.face.p50, 20);
    assert.equal(s.face.p95, 40);
    // Untouched channels report zeros rather than being absent. JSON comparison
    // because vm-context objects fail deepStrictEqual's cross-realm prototype check.
    assert.equal(JSON.stringify(s.hand), '{"p50":0,"p95":0,"hz":0,"n":0}');
    assert.equal(JSON.stringify(s.pose), '{"p50":0,"p95":0,"hz":0,"n":0}');
});

test('hz needs two samples and a positive span', () => {
    const stats = freshStats();
    assert.equal(stats.hz('face'), 0);
    stats.record('face', 5, 1000);
    assert.equal(stats.hz('face'), 0);
    // Same timestamp twice → zero span → 0, not Infinity.
    stats.record('face', 5, 1000);
    assert.equal(stats.hz('face'), 0);
    stats.record('face', 5, 1500);
    assert.equal(stats.hz('face'), 4);
});

test('bad input is dropped: unknown channels, NaN, negatives', () => {
    const stats = freshStats();
    stats.record('gaze', 10, 0);        // unknown channel must not grow the map
    stats.record('face', NaN, 100);
    stats.record('face', -5, 200);
    stats.record('face', Infinity, 300);
    const s = stats.summary();
    assert.equal(s.face.n, 0);
    assert.equal('gaze' in s, false);
});

test('ring buffer caps retention so rates track the recent window', () => {
    const stats = freshStats();
    // 200 samples at 10ms spacing; only the last 120 should be retained.
    for (let i = 0; i < 200; i++) stats.record('pose', 8, i * 10);
    const s = stats.summary();
    assert.equal(s.pose.n, 120);
    // 119 intervals across 1190ms → still 100Hz from the retained window.
    assert.equal(s.pose.hz, 100);
});

test('loadMsPerSec is mean duration times achieved rate, summed across channels', () => {
    const stats = freshStats();
    // face: 10ms mean at 10Hz → 100 ms/s of main-thread inference time.
    for (let i = 0; i < 5; i++) stats.record('face', 10, i * 100);
    // hand: 30ms mean at 2Hz → 60 ms/s.
    for (let i = 0; i < 3; i++) stats.record('hand', 30, i * 500);
    const load = stats.loadMsPerSec();
    assert.equal(load.face, 100);
    assert.equal(load.hand, 60);
    assert.equal(load.pose, 0);
    assert.equal(load.total, 160);
});

test('reset clears every channel', () => {
    const stats = freshStats();
    stats.record('face', 10, 0);
    stats.record('hand', 10, 0);
    stats.reset();
    const s = stats.summary();
    assert.equal(s.face.n + s.hand.n + s.pose.n, 0);
    assert.equal(stats.loadMsPerSec().total, 0);
});
