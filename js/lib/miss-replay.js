/**
 * Miss replay — turn "it didn't fire" into a test case.
 *
 * A miss fixture is what HandLabRecorder.captureMiss() saves when you press
 * "missed it" in the Hand Gesture Lab: the last 3 s of hand frames (full image
 * and world landmarks) and the gesture you expected. Dropped into
 * tests/fixtures/misses/, tests/hand-misses.test.js replays it through the
 * current recognizers: a todo while the fixture says status 'open', a hard
 * assertion once someone marks it 'fixed'. Each miss becomes a regression test.
 * (After toaster's misread.js, MIT: report the misread with what was measured.)
 *
 * Pure: no DOM. Replays held poses (hand-pose-suite) and motions
 * (hand-smoother + motion-gesture-recognizer) over the same frames.
 */

import { HAND_POSE_IDS, createHandPoseRecognizers } from './hand-pose-suite.js';
import { createHandSmoother } from './hand-smoother.js';
import { createMotionGestures } from './motion-gesture-recognizer.js';

export const MISS_FIXTURE_VERSION = 1;

const unflatten = (flat) => (Array.isArray(flat)
    ? Array.from({ length: flat.length / 3 }, (_, i) => ({ x: flat[3 * i], y: flat[3 * i + 1], z: flat[3 * i + 2] }))
    : null);

/**
 * @param {{rows: Array<{t, n, conf, lm1, lm2, wl1, wl2}>}} fixture
 * @returns {{poses: Object<string, number>, motions: Object<string, number>, frames: number}}
 *   poses: frames each held pose was active; motions: events per motion type.
 */
export function replayMiss(fixture) {
    const recognizers = createHandPoseRecognizers();
    const smoother = createHandSmoother();
    const motion = createMotionGestures();
    const poses = Object.fromEntries(HAND_POSE_IDS.map((k) => [k, 0]));
    const motions = {};
    let frames = 0;

    for (const row of fixture?.rows || []) {
        if (!Number.isFinite(row?.t)) continue;
        frames++;
        const image = row.n > 0 ? [unflatten(row.lm1), unflatten(row.lm2)].filter(Boolean) : [];
        const world = [unflatten(row.wl1), unflatten(row.wl2)];
        for (const kind of HAND_POSE_IDS) {
            if (recognizers[kind].update({ t: row.t, hands: image, confidence: row.conf ?? 1 }).track?.active) poses[kind]++;
        }
        const tracks = smoother(image.map((landmarks, i) => ({ landmarks, world: world[i] })), row.t);
        for (const e of motion.update(row.t, tracks)) motions[e.type] = (motions[e.type] || 0) + 1;
    }
    return { poses, motions, frames };
}

/** Did the fixture's expected gesture fire in the replay? */
export function missResolved(fixture, replay = replayMiss(fixture)) {
    const kind = fixture?.kind;
    return (replay.poses[kind] || 0) > 0 || (replay.motions[kind] || 0) > 0;
}
