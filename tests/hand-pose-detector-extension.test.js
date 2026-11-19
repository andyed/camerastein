import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeHand } from '../js/lib/hand-pose-fixtures.js';

// The detector is a classic script that installs window.HandPoseDetector.
const source = readFileSync(new URL('../js/lib/hand-pose-detector.js', import.meta.url), 'utf8');
function loadDetector(flags = {}) {
    const window = { ...flags };
    const context = { window, console, performance: { now: () => 0 }, navigator: { userAgent: 'node' } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return { detector: window.HandPoseDetector, window };
}

// Settle the detector's smoothing on one hand, then read the extensions.
function extensions(detector, landmarks) {
    for (let i = 0; i < 80; i++) {
        detector._extractThumbExtension(landmarks);
        detector._extractPerFingerExtension(landmarks);
    }
    const s = detector.state;
    return { thumb: s.thumbExtension, index: s.indexExtension, ring: s.ringExtension };
}

// A thumbs-up (thumb out, fingers curled) near and far from the camera.
const thumbsUp = (scale) => makeHand({ scale, curl: { thumb: 0, index: 1, middle: 1, ring: 1, pinky: 1 } });

test('legacy extensions depend on distance to the camera', () => {
    const { detector } = loadDetector();
    const near = extensions(detector, thumbsUp(0.2));
    const far = extensions(loadDetector().detector, thumbsUp(0.07));
    assert.ok(near.thumb - far.thumb > 0.3, `near ${near.thumb} far ${far.thumb}`);
});

test('__handExtensionScaleFree: the same hand reads the same at any distance', () => {
    const near = extensions(loadDetector({ __handExtensionScaleFree: true }).detector, thumbsUp(0.2));
    const far = extensions(loadDetector({ __handExtensionScaleFree: true }).detector, thumbsUp(0.07));
    for (const k of ['thumb', 'index', 'ring']) {
        assert.ok(Math.abs(near[k] - far[k]) < 0.02, `${k}: near ${near[k]} far ${far[k]}`);
    }
});

test('__handExtensionScaleFree: a live fist thumb stays below the confirm floor, a live thumbs-up clears it', () => {
    const live = JSON.parse(readFileSync(new URL('./fixtures/hand-live-2026-09-24.json', import.meta.url)));
    const hand = (pose) => live.poses[pose].map(([x, y, z]) => ({ x, y, z }));
    const fist = extensions(loadDetector({ __handExtensionScaleFree: true }).detector, hand('fist'));
    const up = extensions(loadDetector({ __handExtensionScaleFree: true }).detector, hand('thumbsUp'));
    assert.ok(fist.thumb < 0.45, `fist thumb ${fist.thumb}`);
    assert.ok(up.thumb >= 0.45, `thumbs-up thumb ${up.thumb}`);
    // and the legacy formula is what called that fist's thumb extended
    const legacy = extensions(loadDetector().detector, hand('fist'));
    assert.ok(legacy.thumb > fist.thumb);
});
