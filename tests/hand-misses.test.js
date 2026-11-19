import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { makeHand } from '../js/lib/hand-pose-fixtures.js';
import { replayMiss, missResolved } from '../js/lib/miss-replay.js';

const flat = (lm) => lm.flatMap((p) => [p.x, p.y, p.z]);

/*
 * Every fixture saved with "missed it" in the Hand Gesture Lab and moved into
 * tests/fixtures/misses/ is replayed through the current recognizers. A fixture
 * with status 'open' is a todo (the miss is known, not yet fixed); set it to
 * 'fixed' in the same commit as the fix and it becomes a hard assertion.
 */
const dir = new URL('./fixtures/misses/', import.meta.url);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
for (const file of files) {
    const fixture = JSON.parse(readFileSync(new URL(file, dir)));
    const name = `miss ${file}: ${fixture.kind} fires on replay`;
    const run = () => assert.ok(missResolved(fixture), `${fixture.kind} did not fire: ${JSON.stringify(replayMiss(fixture))}`);
    if (fixture.status === 'fixed') test(name, run);
    else test(name, { todo: `open miss (${fixture.capturedAt ?? 'undated'})` }, run);
}

// The pipeline itself, on fixtures built here in the recorder's row format.
const row = (t, landmarks) => ({ t, n: 1, conf: 0.9, lm1: flat(landmarks), lm2: null, wl1: null, wl2: null });

test('replay: a recorded swipe resolves a swipe miss', () => {
    const rows = [];
    for (let k = 0; k < 30; k++) {
        const m = Math.min(1, Math.max(0, (k - 12) / 5));
        rows.push(row(k * 66.7, makeHand({ palmCenter: { x: 0.25 + 0.5 * m, y: 0.5, z: 0 } })));
    }
    const fixture = { v: 1, kind: 'swipe', status: 'open', rows };
    assert.equal(replayMiss(fixture).motions.swipe, 1);
    assert.ok(missResolved(fixture));
});

test('replay: a held fist resolves a fist miss, and does not resolve a thumbs-up one', () => {
    const rows = [];
    for (let k = 0; k < 30; k++) rows.push(row(k * 66.7, makeHand({ curl: 1 })));
    assert.ok(missResolved({ kind: 'fist', rows }));
    assert.equal(missResolved({ kind: 'thumbsUp', rows }), false);
});

test('replay: empty or malformed fixtures replay as nothing, without throwing', () => {
    assert.deepEqual(replayMiss({ rows: [] }).motions, {});
    assert.equal(replayMiss({ rows: [{ t: 'x' }, null, { t: 1, n: 0 }] }).frames, 1);
    assert.equal(missResolved({ kind: 'pinch' }), false);
});
