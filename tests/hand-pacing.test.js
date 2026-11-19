import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/lib/hand-pacing.js', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source, context);
const { createHandPacer, DEFAULTS } = context.CameraHandPacing;

// Drive a pacer at a fixed tick rate; `seen(t)` says whether a hand is in the
// result of a hand inference that ran at time t.
function run(pacer, { fps = 17, seconds = 4, seen = () => false, start = 0 } = {}) {
    const dt = 1000 / fps;
    const rows = [];
    for (let t = start; t < start + seconds * 1000; t += dt) {
        const plan = pacer.tick(t);
        if (plan.hand) pacer.observe(t, seen(t) ? 1 : 0);
        rows.push({ t, ...plan });
    }
    return rows;
}
const rate = (rows, key, from, to) =>
    rows.filter((r) => r[key] && r.t >= from && r.t < to).length / ((to - from) / 1000);

test('scouting: primary every tick, hands near scoutHz', () => {
    const rows = run(createHandPacer(), { seconds: 5 });
    assert.ok(rows.every((r) => r.primary && r.phase === 'scouting'));
    const hz = rate(rows, 'hand', 1000, 5000);
    assert.ok(hz >= 3 && hz <= DEFAULTS.scoutHz + 0.5, `scout rate ${hz}`);
});

test('a seen hand switches to present: hands every tick, primary on the watchdog', () => {
    const rows = run(createHandPacer(), { seconds: 4, seen: (t) => t >= 1000 });
    const present = rows.filter((r) => r.t >= 1500);
    assert.ok(present.every((r) => r.phase === 'present' && r.hand));
    const primaryShare = present.filter((r) => r.primary).length / present.length;
    assert.ok(Math.abs(primaryShare - 1 / DEFAULTS.primaryEveryWhilePresent) < 0.05, `primary share ${primaryShare}`);
});

test('the primary runs on the first present tick, so the face never goes dark at once', () => {
    const p = createHandPacer({ primaryEveryWhilePresent: 4 });
    p.tick(0); p.observe(0, 1);
    const first = p.tick(10);
    assert.equal(first.phase, 'present');
    assert.equal(first.primary, true);
    assert.equal(p.tick(20).primary, false);
});

test('present holds presentHoldMs after the hand leaves, then scouts again', () => {
    const p = createHandPacer({ presentHoldMs: 2000 });
    const rows = run(p, { seconds: 6, seen: (t) => t >= 500 && t < 1500 });
    const at = (ms) => rows.find((r) => r.t >= ms);
    assert.equal(at(3000).phase, 'present');   // 1.5 s after the last sighting
    assert.equal(at(4200).phase, 'scouting');  // more than 2 s after
    assert.equal(p.state().transitions, 2);
});

test('a hand that flickers out for one result does not drop the phase', () => {
    let k = 0;
    const rows = run(createHandPacer(), { seconds: 3, seen: (t) => t >= 300 && (k++ % 5 !== 0) });
    assert.ok(rows.filter((r) => r.t >= 1000).every((r) => r.phase === 'present'));
});

test('plannedRates follows the phase', () => {
    const p = createHandPacer();
    p.tick(0);
    assert.deepEqual({ ...p.plannedRates(17) }, { primary: 17, hand: 4 });
    p.observe(0, 2); p.tick(10);
    assert.deepEqual({ ...p.plannedRates(17) }, { primary: 8.5, hand: 17 });
});

test('reset returns to scouting; bad options fall back to defaults', () => {
    const p = createHandPacer({ scoutHz: NaN, presentHoldMs: -5, primaryEveryWhilePresent: 0 });
    assert.equal(p.options.scoutHz, DEFAULTS.scoutHz);
    assert.equal(p.options.presentHoldMs, 0);
    assert.equal(p.options.primaryEveryWhilePresent, 1);
    p.tick(0); p.observe(0, 1); p.tick(1);
    p.reset();
    assert.equal(p.tick(2).phase, 'scouting');
});
