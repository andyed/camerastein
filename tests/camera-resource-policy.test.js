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

test('render pressure uses hysteresis instead of threshold thrashing', () => {
    assert.equal(policy.nextConstrained(false, 47), true);
    assert.equal(policy.nextConstrained(true, 52), true);
    assert.equal(policy.nextConstrained(true, 55), false);
    assert.equal(policy.nextConstrained(false, 52), false);
    assert.equal(policy.nextConstrained(true, 0), true);
});
