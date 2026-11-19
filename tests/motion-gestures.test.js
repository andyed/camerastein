import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHand } from '../js/lib/hand-pose-fixtures.js';
import { createMotionGestures, pinchGap } from '../js/lib/motion-gesture-recognizer.js';
import { handShape } from '../js/lib/hand-pose-features.js';

const HZ = 15, DT = 1000 / HZ;
const open = (x, y, scale = 0.09) => makeHand({ palmCenter: { x, y, z: 0 }, scale });
const fist = (x, y, scale = 0.09) => makeHand({ palmCenter: { x, y, z: 0 }, scale, curl: 1 });
const pinched = (x, y) => {
    const lm = makeHand({ palmCenter: { x, y, z: 0 }, scale: 0.09, curl: { thumb: 0.3, index: 0.4, middle: 0, ring: 0, pinky: 0 } });
    lm[8] = { ...lm[4] }; // index tip onto thumb tip
    return lm;
};
// frames: (k, t) => [{id, landmarks}]; returns the events with the time they fired.
function play(rec, frames, n) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const t = k * DT;
        for (const e of rec.update(t, frames(k, t))) out.push(e);
    }
    return out;
}
// A hand still for `holdFrames`, then a fast level move of `dx` over `moveFrames`.
const swipeTrack = (x0, dx, { holdFrames = 12, moveFrames = 5, y = 0.5, shape = open } = {}) => (k) => {
    const m = Math.min(1, Math.max(0, (k - holdFrames) / moveFrames));
    return [{ id: 1, landmarks: shape(x0 + dx * m, y) }];
};

test('fixtures: makeHand reads open, the curled one does not, and the pinch fixture touches', () => {
    const s = handShape(open(0.5, 0.5));
    assert.ok(['index', 'middle', 'ring', 'pinky'].filter((f) => s[`${f}Extension`] >= 0.72).length >= 3);
    const f = handShape(fist(0.5, 0.5));
    assert.ok(['index', 'middle', 'ring', 'pinky'].filter((x) => f[`${x}Extension`] >= 0.72).length < 3);
    assert.ok(pinchGap(pinched(0.5, 0.5), null, handShape(pinched(0.5, 0.5))) < 0.05);
});

test('swipe: still, then fast and level, fires once with a screen direction', () => {
    const rec = createMotionGestures();
    const ev = play(rec, swipeTrack(0.25, 0.5), 30).filter((e) => e.type === 'swipe');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].imageDir, 'right');
    assert.equal(ev[0].dir, 'left'); // mirrored selfie view
});

test('swipe: no still moment before it (a waving hand) does not fire', () => {
    const rec = createMotionGestures();
    const wave = (k) => [{ id: 1, landmarks: open(0.5 + 0.3 * Math.sin(k / 2), 0.5) }];
    assert.equal(play(rec, wave, 60).filter((e) => e.type === 'swipe').length, 0);
});

test('swipe: a fist moving fast, a slow drift, and a steep move all fail', () => {
    assert.equal(play(createMotionGestures(), swipeTrack(0.25, 0.5, { shape: fist }), 30).length, 0, 'fist');
    assert.equal(play(createMotionGestures(), swipeTrack(0.25, 0.5, { moveFrames: 20 }), 40).length, 0, 'slow');
    const steep = (k) => {
        const m = Math.min(1, Math.max(0, (k - 12) / 5));
        return [{ id: 1, landmarks: open(0.3 + 0.25 * m, 0.2 + 0.4 * m) }];
    };
    assert.equal(play(createMotionGestures(), steep, 30).length, 0, 'steep');
});

test('swipe: the return stroke inside 1.5 s does not count as a swipe back', () => {
    const rec = createMotionGestures();
    const outAndBack = (k) => {
        let x = 0.25;
        if (k >= 12) x = 0.25 + 0.5 * Math.min(1, (k - 12) / 5);
        if (k >= 26) x = 0.75 - 0.5 * Math.min(1, (k - 26) / 5);
        return [{ id: 1, landmarks: open(x, 0.5) }];
    };
    const ev = play(rec, outAndBack, 40).filter((e) => e.type === 'swipe');
    assert.equal(ev.length, 1);
});

test('swipe: a second hand moving at the same time vetoes it', () => {
    const rec = createMotionGestures();
    const both = (k) => {
        const m = Math.min(1, Math.max(0, (k - 12) / 5));
        return [{ id: 1, landmarks: open(0.2 + 0.5 * m, 0.3) }, { id: 2, landmarks: open(0.8 - 0.5 * m, 0.75) }];
    };
    assert.equal(play(rec, both, 30).filter((e) => e.type === 'swipe').length, 0);
});

test('swipe: below 3 samples in the move window (2.5 Hz pacing) it refuses', () => {
    const rec = createMotionGestures();
    let fired = 0;
    for (let k = 0; k < 12; k++) {
        const t = k * 400; // 2.5 Hz
        const x = k < 6 ? 0.25 : 0.75;
        fired += rec.update(t, [{ id: 1, landmarks: open(x, 0.5) }]).filter((e) => e.type === 'swipe').length;
    }
    assert.equal(fired, 0);
});

test('pinch: held 0.2 s clicks once; a flicker shorter than that does not', () => {
    const rec = createMotionGestures();
    const hold = (k) => [{ id: 1, landmarks: k >= 5 ? pinched(0.5, 0.5) : open(0.5, 0.5) }];
    const ev = play(rec, hold, 30).filter((e) => e.type === 'pinch');
    assert.equal(ev.length, 1);
    assert.ok(ev[0].t - 5 * DT >= 200 - 1e-9);

    const rec2 = createMotionGestures();
    const flicker = (k) => [{ id: 1, landmarks: k === 5 || k === 6 ? pinched(0.5, 0.5) : open(0.5, 0.5) }];
    assert.equal(play(rec2, flicker, 30).filter((e) => e.type === 'pinch').length, 0);
});

test('pinch: two clicks need a real release in between and a 1 s gap', () => {
    const rec = createMotionGestures();
    // pinch 0..1 s, open 1..1.6 s, pinch again 1.6..2.5 s
    const seq = (k, t) => [{ id: 1, landmarks: (t < 1000 || t >= 1600) ? pinched(0.5, 0.5) : open(0.5, 0.5) }];
    const ev = play(rec, seq, Math.ceil(2500 / DT)).filter((e) => e.type === 'pinch');
    assert.equal(ev.length, 2);
    // held the whole time: one click only
    const rec2 = createMotionGestures();
    assert.equal(play(rec2, () => [{ id: 1, landmarks: pinched(0.5, 0.5) }], 60).filter((e) => e.type === 'pinch').length, 1);
});

test('pinch: metric world landmarks win over the image plane (an edge-on hand cannot fake one)', () => {
    const lm = pinched(0.5, 0.5);
    const shape = handShape(lm);
    const world = Array.from({ length: 21 }, (_, i) => ({ x: i * 0.01, y: 0, z: 0 }));
    // world: thumb tip (4) and index tip (8) are 4 cm apart on a 9 cm palm
    assert.ok(pinchGap(lm, world, shape) > 0.4);
    assert.ok(pinchGap(lm, null, shape) < 0.05);
});

test('spread and gather: two open hands moving apart, then together', () => {
    const rec = createMotionGestures();
    const pair = (sep) => [
        { id: 1, landmarks: open(0.5 - (sep * 0.09) / 2, 0.5) },
        { id: 2, landmarks: open(0.5 + (sep * 0.09) / 2, 0.5) },
    ];
    const ev = play(rec, (k) => {
        if (k < 8) return pair(1.5);
        if (k < 16) return pair(1.5 + (4.5 * (k - 8)) / 8); // to 6 hand sizes in ~0.5 s
        if (k < 30) return pair(6);
        if (k < 38) return pair(6 - (4.5 * (k - 30)) / 8);
        return pair(1.5);
    }, 50);
    assert.deepEqual(ev.map((e) => e.type), ['spread', 'gather']);
});

test('reset forgets tracks, pinches and cooldowns', () => {
    const rec = createMotionGestures();
    play(rec, swipeTrack(0.25, 0.5), 30);
    rec.reset();
    const again = play(rec, swipeTrack(0.25, 0.5), 30).filter((e) => e.type === 'swipe');
    assert.equal(again.length, 1);
});
