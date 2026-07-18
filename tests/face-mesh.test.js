import test from 'node:test';
import assert from 'node:assert/strict';

import { FaceLandmarkerShim } from '../js/tasks-vision/face-shim.js';
import { SkeletonRenderer } from '../js/skeleton-renderer.js';

function installMotionBusSpy() {
    const emissions = [];
    globalThis.window = {
        MotionBus: {
            emit(channel, payload) {
                emissions.push({ channel, payload });
            },
        },
    };
    return emissions;
}

function fakeCanvas() {
    const calls = [];
    const ctx = {
        clearRect() {},
        beginPath() {},
        moveTo(x, y) { calls.push(['moveTo', x, y]); },
        lineTo(x, y) { calls.push(['lineTo', x, y]); },
        stroke() {},
        arc(x, y, r) { calls.push(['arc', x, y, r]); },
        fill() {},
    };
    return {
        canvas: { width: 200, height: 100, getContext: () => ctx },
        calls,
    };
}

test('face shim emits the complete portable mesh frame and topology', async () => {
    const emissions = installMotionBusSpy();
    const landmarks = Array.from({ length: 478 }, (_, i) => ({
        x: i / 478,
        y: 0.5,
        z: 0,
    }));
    const topology = {
        tessellation: [{ start: 0, end: 1 }],
        contours: [[1, 2]],
    };
    const shim = new FaceLandmarkerShim({
        detectForVideo: () => ({ faceLandmarks: [landmarks] }),
    }, topology);

    await shim.send({ image: {} });

    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].channel, 'faceLandmarks');
    assert.equal(emissions[0].payload.landmarks, landmarks);
    assert.deepEqual(emissions[0].payload.allFaces, [landmarks]);
    assert.equal(emissions[0].payload.topology, topology);
    assert.equal(emissions[0].payload.source, 'mediapipe-tasks');
    assert.equal(typeof emissions[0].payload.t, 'number');
});

test('face shim clears a stale mesh when no face is detected', async () => {
    const emissions = installMotionBusSpy();
    const shim = new FaceLandmarkerShim({
        detectForVideo: () => ({ faceLandmarks: [] }),
    });

    await shim.send({ image: {} });

    assert.deepEqual(emissions, [{ channel: 'faceLandmarks', payload: null }]);
});

test('renderer draws canonical topology and mirrors all mesh vertices', () => {
    const { canvas, calls } = fakeCanvas();
    const renderer = new SkeletonRenderer(canvas);
    const landmarks = Array.from({ length: 468 }, (_, i) => ({
        x: i === 0 ? 0.25 : 0.5,
        y: i === 0 ? 0.2 : 0.5,
        z: 0,
    }));

    renderer.updateFaceMesh({
        landmarks,
        topology: {
            tessellation: [{ start: 0, end: 1 }],
            contours: [[1, 2]],
        },
    });
    renderer.draw();

    assert.equal(calls.filter(([name]) => name === 'lineTo').length, 2);
    assert.equal(calls.filter(([name]) => name === 'arc').length, 468);
    assert.deepEqual(calls.find(([name]) => name === 'moveTo').slice(1), [150, 20]);
});

test('renderer tolerates malformed edges and the early topology spelling', () => {
    const { canvas, calls } = fakeCanvas();
    const renderer = new SkeletonRenderer(canvas);
    const landmarks = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

    renderer.updateFaceMesh({
        landmarks,
        topology: {
            tesselation: [[0, 1], ['1', 2], null, { startIndex: 2, endIndex: 3 }],
            contours: [],
        },
    });
    renderer.draw();

    assert.equal(calls.filter(([name]) => name === 'lineTo').length, 2);
});

test('renderer builds a dense mesh from legacy 468-point results without topology', () => {
    const { canvas, calls } = fakeCanvas();
    const renderer = new SkeletonRenderer(canvas);
    const landmarks = Array.from({ length: 468 }, (_, i) => ({
        x: (i % 26) / 30,
        y: Math.floor(i / 26) / 22,
        z: 0,
    }));

    renderer.updateFace({ multiFaceLandmarks: [landmarks] });
    renderer.draw();

    assert.ok(calls.filter(([name]) => name === 'lineTo').length > 900);
    assert.equal(calls.filter(([name]) => name === 'arc').length, 468);
});
