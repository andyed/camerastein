#!/usr/bin/env node
/**
 * Replay a recorded guided run through the current pose recognizers.
 *
 *   node scripts/replay-hand-clip.mjs [logs/clips/<run>]   (default: newest)
 *
 * The recorder saved every hand frame's full landmarks, so a threshold or
 * feature change can be scored against a real session without performing it
 * again. For each cued pose's HOLD window: the fraction of frames each pose
 * was active, and the cued pose's dominant blocking reasons.
 *
 * Frames recorded before b735171 carry stale landmarks on handCount-0 frames;
 * replay drops them, as the fixed detector does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAND_POSE_IDS, createHandPoseRecognizers } from '../js/lib/hand-pose-suite.js';
import { createHandSmoother } from '../js/lib/hand-smoother.js';
import { createMotionGestures } from '../js/lib/motion-gesture-recognizer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clipsDir = join(root, 'logs', 'clips');
const clip = process.argv[2]
    ?? join(clipsDir, readdirSync(clipsDir).sort().at(-1));

const unflatten = (flat) => (Array.isArray(flat)
    ? Array.from({ length: flat.length / 3 }, (_, i) => ({
        x: flat[3 * i], y: flat[3 * i + 1], z: flat[3 * i + 2],
    }))
    : null);

const rows = readFileSync(join(clip, 'rows.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.ch === 'hand');

const recognizers = createHandPoseRecognizers();
const byCue = new Map();

for (const row of rows) {
    if (row.nul) {
        for (const kind of HAND_POSE_IDS) recognizers[kind].reset?.();
        continue;
    }
    const hands = row.n > 0
        ? [unflatten(row.lm1), unflatten(row.lm2)].filter(Boolean)
        : [];
    const input = { t: row.t, hands, confidence: row.conf ?? 0 };
    const frames = Object.fromEntries(HAND_POSE_IDS.map((kind) => [
        kind, recognizers[kind].update(input),
    ]));
    if (row.stage !== 'hold') continue;

    const bucket = byCue.get(row.cue) ?? { n: 0, active: {}, reasons: {} };
    byCue.set(row.cue, bucket);
    bucket.n++;
    for (const [kind, frame] of Object.entries(frames)) {
        if (frame.track?.active) bucket.active[kind] = (bucket.active[kind] || 0) + 1;
    }
    const own = frames[row.cue];
    if (own) {
        const why = own.quality.reason === 'blocked'
            ? `blocked: ${own.quality.blockedBy.join(' + ')}`
            : own.quality.reason;
        bucket.reasons[why] = (bucket.reasons[why] || 0) + 1;
    }
}

const pct = (count, n) => `${Math.round((100 * count) / n)}%`;
console.log(`replay ${clip}\n`);
for (const [cue, { n, active, reasons }] of byCue) {
    const on = Object.entries(active).sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind} ${pct(count, n)}`).join(', ') || 'nothing';
    const why = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([reason, count]) => `${reason} ${pct(count, n)}`).join(', ');
    console.log(`${cue.padEnd(11)} n=${String(n).padStart(3)}  active: ${on}`);
    if (why) console.log(`${''.padEnd(18)}own: ${why}`);
}

// ── Motion gestures ────────────────────────────────────────────────────────
// The same hand rows through the One Euro smoother and the motion recognizers
// (swipe, pinch, spread, gather). Counted per cue across READY and HOLD, since a
// motion is an event, not a held state. A motion cue should fire its own type;
// every other cue, held poses and negatives alike, is a false-positive test.
const smoother = createHandSmoother();
const motions = createMotionGestures();
const motionByCue = new Map();
const motionCueOrder = [];
for (const row of rows) {
    if (!Number.isFinite(row.t)) continue;
    const hands = row.nul || !(row.n > 0)
        ? []
        : [
            row.lm1 ? { landmarks: unflatten(row.lm1), world: unflatten(row.wl1) } : null,
            row.lm2 ? { landmarks: unflatten(row.lm2), world: unflatten(row.wl2) } : null,
        ].filter(Boolean);
    const events = motions.update(row.t, smoother(hands, row.t));
    const cue = row.cue ?? '(none)';
    if (!motionByCue.has(cue)) { motionByCue.set(cue, {}); motionCueOrder.push(cue); }
    const bucket = motionByCue.get(cue);
    for (const e of events) {
        const key = e.type === 'swipe' ? `swipe-${e.dir}` : e.type;
        bucket[key] = (bucket[key] || 0) + 1;
    }
}
const recorded = readFileSync(join(clip, 'rows.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.ch === 'motion').length;
console.log(`\nmotion gestures (replayed; ${recorded} live motion rows in the clip)`);
for (const cue of motionCueOrder) {
    const fired = Object.entries(motionByCue.get(cue)).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
    console.log(`${cue.padEnd(11)} ${fired}`);
}
