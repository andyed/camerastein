import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handShape, fingerExtension, FINGER_CHAINS } from '../js/lib/hand-pose-features.js';
import { matchingPoses } from '../js/lib/hand-pose-suite.js';

/*
 * Real landmarks from a live guided run — the first fixtures in this suite that
 * did not come from makeHand(). The synthetic hand curls its fingers across
 * the image; a real one curls them toward the camera, and that difference is
 * what these exist to keep caught.
 */
const live = JSON.parse(readFileSync(new URL('./fixtures/hand-live-2026-09-24.json', import.meta.url)));
const hand = (pose) => live.poses[pose].map(([x, y, z]) => ({ x, y, z }));

const LONG = ['index', 'middle', 'ring', 'pinky'];
const EXTENDED = {
    openPalm: ['index', 'middle', 'ring', 'pinky'],
    fist: [],
    point: ['index'],
    peace: ['index', 'middle'],
    thumbsUp: [],
    thumbsDown: [],
};

test('live hands: every long finger reads on the right side of the gap', () => {
    for (const [pose, extended] of Object.entries(EXTENDED)) {
        const shape = handShape(hand(pose));
        for (const finger of LONG) {
            const value = shape[`${finger}Extension`];
            if (extended.includes(finger)) {
                assert.ok(value >= 0.85, `${pose} ${finger} should be extended, reads ${value.toFixed(2)}`);
            } else {
                assert.ok(value <= 0.55, `${pose} ${finger} should be curled, reads ${value.toFixed(2)}`);
            }
        }
    }
});

test('live peace: tucked ring and pinky are why straightness was replaced', () => {
    // Curled toward the camera, each projects as a short straight segment —
    // chord ≈ chain, so straightness calls them fully extended. Reach does not.
    const peace = hand('peace');
    for (const finger of ['ring', 'pinky']) {
        assert.ok(fingerExtension(peace, FINGER_CHAINS[finger]) > 0.9,
            `${finger}: straightness is expected to be fooled here`);
        assert.ok(handShape(peace)[`${finger}Extension`] <= 0.55);
    }
});

test('live hands: each pose matches itself and nothing else', () => {
    for (const pose of ['openPalm', 'point', 'peace', 'thumbsUp', 'thumbsDown']) {
        assert.deepEqual(matchingPoses(hand(pose)), [pose], pose);
    }
});

test('live relaxed hand: hanging in view, back to the camera, matches nothing', () => {
    // Loosely straight fingers passed every extension bound; only the palm's
    // pitch (wide and short in projection) says it is not an open palm.
    const shape = handShape(hand('restHanging'));
    assert.ok(shape.palmLengthRatio < 0.9, `palmLengthRatio ${shape.palmLengthRatio.toFixed(2)}`);
    assert.deepEqual(matchingPoses(hand('restHanging')), []);
});

test('live fist: a thumb across the fist is not a thumbs-up (thumbReach)', () => {
    assert.deepEqual(matchingPoses(hand('fist')), ['fist']);
});
