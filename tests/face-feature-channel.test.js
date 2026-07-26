import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FaceFeatureExtractor,
    frameFromMediaPipe,
} from '../js/tasks-vision/face-feature-channel.js';

function frame(t, overrides = {}) {
    return {
        provider: 'synthetic',
        t,
        confidence: 1,
        blendshapes: {},
        yaw: 0,
        pitch: 0,
        roll: 0,
        faceScale: 0.2,
        faceCount: 1,
        ...overrides,
    };
}

function faceLandmarks(cornerY = 0.56) {
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    landmarks[1] = { x: 0.5, y: 0.5, z: 0 };   // nose
    landmarks[10] = { x: 0.5, y: 0.3, z: 0 };  // forehead
    landmarks[152] = { x: 0.5, y: 0.7, z: 0 }; // chin
    landmarks[234] = { x: 0.4, y: 0.5, z: 0 }; // left ear
    landmarks[454] = { x: 0.6, y: 0.5, z: 0 }; // right ear
    landmarks[13] = { x: 0.5, y: 0.55, z: 0 }; // upper lip
    landmarks[14] = { x: 0.5, y: 0.57, z: 0 }; // lower lip
    landmarks[61] = { x: 0.46, y: cornerY, z: 0 };
    landmarks[291] = { x: 0.54, y: cornerY, z: 0 };
    return landmarks;
}

test('shared feature channel exposes gesture-grade brow, pitch, and proximity velocity', () => {
    const ex = new FaceFeatureExtractor();
    for (let i = 0; i < 30; i++) ex.update(frame(1000 + i * 33));
    const features = ex.update(frame(3000, {
        blendshapes: {
            browInnerUp: 0.8,
            browOuterUpLeft: 0.8,
            browOuterUpRight: 0.8,
        },
        pitch: 0.35,
        faceScale: 0.25,
    }));

    assert.ok(features.dynamics.browLVel > 0);
    assert.ok(features.dynamics.browRVel > 0);
    assert.ok(features.dynamics.pitchVel > 0);
    assert.ok(features.dynamics.proximityVel > 0);
});

test('corner geometry supplies frown evidence the blendshape pair misses', () => {
    // The shipped mouth-tracking detector fires frowns on corner-vs-midline
    // geometry while mouthFrown stays near zero. Before the negative-half
    // fusion, that frown was invisible to the semantic channel — and therefore
    // to the frown gesture — even though the same face was clearly frowning.
    const ex = new FaceFeatureExtractor();
    // Settle a neutral personal baseline first (bsCount>0 so expressions count).
    for (let i = 0; i < 30; i++) {
        ex.update(frame(1000 + i * 33, { blendshapes: { jawOpen: 0 }, valenceGeom: 0 }));
    }
    const weakBlendshape = ex.update(frame(3000, {
        blendshapes: { mouthFrownLeft: 0.05, mouthFrownRight: 0.05 },
        valenceGeom: -0.7,
    }));
    assert.ok(weakBlendshape.expression.valence < -0.3,
        `geometry frown should carry the axis, got ${weakBlendshape.expression.valence}`);
});

test('MediaPipe landmark adaptation computes the negative mouth-corner valence', () => {
    const frown = faceLandmarks(0.58);
    const canonical = frameFromMediaPipe(
        { t: 99, shapes: { categories: [{ categoryName: 'jawOpen', score: 0 }] } },
        { t: 100, landmarks: frown, allFaces: [frown], source: 'mediapipe-tasks' },
    );

    assert.equal(canonical.blendshapes.mouthFrownLeft, undefined);
    assert.ok(canonical.valenceGeom < -0.75,
        `mouth-corner geometry should produce a strong frown, got ${canonical.valenceGeom}`);
});

test('the smile half is untouched by the geometry fusion', () => {
    const ex = new FaceFeatureExtractor();
    for (let i = 0; i < 30; i++) {
        ex.update(frame(1000 + i * 33, { blendshapes: { jawOpen: 0 }, valenceGeom: 0 }));
    }
    // A positive geometry reading must NOT inflate a blendshape smile, and a
    // negative one must not be able to cancel it either — smile stays bit-identical.
    const withGeom = ex.update(frame(3000, {
        blendshapes: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6 },
        valenceGeom: 0.9,
    }));
    const ex2 = new FaceFeatureExtractor();
    for (let i = 0; i < 30; i++) {
        ex2.update(frame(1000 + i * 33, { blendshapes: { jawOpen: 0 }, valenceGeom: 0 }));
    }
    const noGeom = ex2.update(frame(3000, {
        blendshapes: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6 },
        valenceGeom: 0,
    }));
    assert.equal(withGeom.expression.valence, noGeom.expression.valence);
});

test('absent landmark geometry degrades to blendshape-only valence', () => {
    const ex = new FaceFeatureExtractor();
    for (let i = 0; i < 30; i++) ex.update(frame(1000 + i * 33));
    const f = ex.update(frame(3000, {
        blendshapes: { mouthFrownLeft: 0.5, mouthFrownRight: 0.5 },
    }));   // no valenceGeom field at all
    assert.ok(Number.isFinite(f.expression.valence));
    assert.ok(f.expression.valence < 0);
});
