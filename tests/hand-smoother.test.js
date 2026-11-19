import test from 'node:test';
import assert from 'node:assert/strict';
import { oneEuro, createHandSmoother } from '../js/lib/hand-smoother.js';

// Deterministic shimmer: a fixed pseudo-random sequence, about 2 px of 640.
function lcg(seed = 7) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
}
const hand = (cx, cy, jitter = () => 0) =>
    Array.from({ length: 21 }, (_, i) => ({ x: cx + i * 0.004 + jitter() * 0.006, y: cy + i * 0.003 + jitter() * 0.006, z: 0 }));
const std = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

test('oneEuro passes the first sample and a constant through unchanged', () => {
    const f = oneEuro();
    assert.equal(f(0.5, 0), 0.5);
    for (let i = 0; i < 20; i++) assert.ok(Math.abs(f(0.5, 1 / 15) - 0.5) < 1e-12);
});

test('a still hand: shimmer drops by more than half', () => {
    const jitter = lcg();
    const smooth = createHandSmoother();
    const raw = [], filtered = [];
    for (let k = 0; k < 90; k++) {
        const lm = hand(0.5, 0.5, jitter);
        const [h] = smooth([{ landmarks: lm }], k * (1000 / 15));
        if (k > 15) { raw.push(lm[8].x); filtered.push(h.landmarks[8].x); }
    }
    assert.ok(std(filtered) < std(raw) * 0.5, `raw ${std(raw)} filtered ${std(filtered)}`);
});

test('a hand crossing the frame in a second lags by under 3 % of the width', () => {
    const smooth = createHandSmoother();
    let lag = 0;
    for (let k = 0; k <= 15; k++) {
        const x = 0.1 + (0.8 * k) / 15;
        const [h] = smooth([{ landmarks: hand(x, 0.5) }], k * (1000 / 15));
        if (k > 5) lag = Math.max(lag, Math.abs(h.landmarks[0].x - x));
    }
    assert.ok(lag < 0.03, `lag ${lag}`);
});

test('track ids follow the physical hand when the input order swaps', () => {
    const smooth = createHandSmoother();
    const left = () => ({ landmarks: hand(0.2, 0.5) });
    const right = () => ({ landmarks: hand(0.7, 0.5) });
    const a = smooth([left(), right()], 0);
    const b = smooth([right(), left()], 66);
    const idAt = (hands, x) => hands.find((h) => Math.abs(h.landmarks[0].x - x) < 0.05).id;
    assert.equal(idAt(b, 0.2), idAt(a, 0.2));
    assert.equal(idAt(b, 0.7), idAt(a, 0.7));
    assert.ok(b.every((h) => !h.fresh));
});

test('a fast swipe keeps its id: matching uses the predicted wrist, not the last one', () => {
    const smooth = createHandSmoother();
    const ids = new Set();
    // 0.8 of the frame in 0.4 s at 15 Hz: 0.13 per sample, plus a parked second hand.
    for (let k = 0; k <= 6; k++) {
        const x = 0.1 + (0.8 * k) / 6;
        const out = smooth([{ landmarks: hand(x, 0.4) }, { landmarks: hand(0.5, 0.85) }], k * (1000 / 15));
        ids.add(out.find((h) => h.landmarks[0].y < 0.6).id);
    }
    assert.equal(ids.size, 1);
});

test('a short dropout keeps the track; a long one starts a new hand', () => {
    const smooth = createHandSmoother({ keepMs: 400 });
    const [first] = smooth([{ landmarks: hand(0.5, 0.5) }], 0);
    smooth([], 100);
    const [back] = smooth([{ landmarks: hand(0.51, 0.5) }], 300);
    assert.equal(back.id, first.id);
    assert.equal(back.fresh, false);
    smooth([], 400);
    const [later] = smooth([{ landmarks: hand(0.51, 0.5) }], 1000);
    assert.notEqual(later.id, first.id);
    assert.equal(later.fresh, true);
});

test('world landmarks pass through untouched; junk input is ignored', () => {
    const smooth = createHandSmoother();
    const world = [{ x: 0.01, y: 0.02, z: 0.03 }];
    const [h] = smooth([{ landmarks: hand(0.4, 0.4), world }, { landmarks: [] }, null], 0);
    assert.equal(h.world, world);
    assert.equal(smooth([{ landmarks: hand(0.4, 0.4), world }], 66).length, 1);
});
