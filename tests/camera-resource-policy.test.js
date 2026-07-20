import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../js/lib/camera-resource-policy.js', import.meta.url),
    'utf8'
);
const context = {};
vm.createContext(context);
vm.runInContext(source, context);
const policy = context.CameraResourcePolicy;

test('mobile policy catches phones, UA hints, and desktop-UA iPads', () => {
    assert.equal(policy.isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone)' }), true);
    assert.equal(policy.isMobileDevice({ userAgentData: { mobile: true } }), true);
    assert.equal(policy.isMobileDevice({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
    }), true);
    assert.equal(policy.isMobileDevice({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
    }), false);
});

test('overlay cost survives healthy adaptive pacing', () => {
    assert.equal(policy.targetFPS(20, false, false), 20);
    assert.equal(policy.targetFPS(20, true, false), 17);
    assert.equal(policy.targetFPS(20, true, true), 9);
    assert.equal(policy.targetFPS(12, true, false), 10);
    assert.equal(policy.targetFPS(12, true, true), 5);
});

test('interleave skips the overlay tax the sharing cost was pre-paying', () => {
    // Same configs as the legacy assertions above, interleaved: no 0.85 haircut.
    assert.equal(policy.targetFPS(20, true, false, true), 20);
    assert.equal(policy.targetFPS(12, true, false, true), 12);
    // Render pressure still halves the interleaved loop.
    assert.equal(policy.targetFPS(12, true, true, true), 6);
    // No overlay → interleaved flag is irrelevant.
    assert.equal(policy.targetFPS(20, false, false, true), 20);
});

test('interleaveSlot gives hands 1 of every ratio+1 ticks, phase-stable', () => {
    // Ratio 2: two primary ticks, then one hand tick, repeating.
    const slots = [0, 1, 2, 3, 4, 5].map((t) => policy.interleaveSlot(t, 2));
    assert.deepEqual(slots, ['primary', 'primary', 'hand', 'primary', 'primary', 'hand']);
    // Degenerate ratios clamp to 1 (strict alternation), never divide by zero.
    assert.equal(policy.interleaveSlot(0, 0), 'primary');
    assert.equal(policy.interleaveSlot(1, 0), 'hand');
    assert.equal(policy.interleaveSlot(1, -3), 'hand');
    // A wrapped/negative counter keeps a valid phase instead of NaN'ing the slot.
    assert.equal(policy.interleaveSlot(-1, 2), 'hand');
    assert.equal(policy.interleaveSlot(-2, 2), 'primary');
});

test('interleaveSlot schedule matches plannedRates arithmetic', () => {
    // Count actual slots over many ticks; the achieved split must equal the plan.
    for (const ratio of [1, 2, 3]) {
        const period = ratio + 1;
        const ticks = period * 100;
        let hand = 0;
        for (let t = 0; t < ticks; t++) {
            if (policy.interleaveSlot(t, ratio) === 'hand') hand++;
        }
        const planned = policy.plannedRates(ticks, 'interleave', ratio, 0);
        assert.equal(hand, planned.hand);
        assert.equal(ticks - hand, planned.primary);
    }
});

test('plannedRates reproduces the audited mobile numbers for both schedulers', () => {
    // Mobile interleave, ratio 2 at 12fps: primary 8Hz, hands 4Hz.
    const inter = policy.plannedRates(12, 'interleave', 2, 12);
    assert.equal(inter.primary, 8);
    assert.equal(inter.hand, 4);
    // Legacy mobile skip: 10fps loop / skip 12 ≈ 0.83Hz — the starvation number.
    const skip = policy.plannedRates(10, 'skip', 2, 12);
    assert.equal(skip.primary, 10);
    assert.ok(Math.abs(skip.hand - 0.833) < 0.001);
    // Skip mode guards a zero/absent frameSkip.
    const guarded = policy.plannedRates(10, 'skip', 2, 0);
    assert.equal(guarded.primary, 10);
    assert.equal(guarded.hand, 10);
});

test('render pressure uses hysteresis instead of threshold thrashing', () => {
    assert.equal(policy.nextConstrained(false, 47), true);
    assert.equal(policy.nextConstrained(true, 52), true);
    assert.equal(policy.nextConstrained(true, 55), false);
    assert.equal(policy.nextConstrained(false, 52), false);
    assert.equal(policy.nextConstrained(true, 0), true);
});
