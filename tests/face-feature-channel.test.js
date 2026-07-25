import test from 'node:test';
import assert from 'node:assert/strict';

import { FaceFeatureExtractor } from '../js/tasks-vision/face-feature-channel.js';

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
