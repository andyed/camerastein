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
