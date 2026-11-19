/**
 * Hand motion channel — swipes, pinch clicks, spread and gather on MotionBus.
 *
 * Subscribes to the detector's `handPose` broadcast, the same source as the
 * held-pose channel (hand-pose-channel.js), smooths each hand into a stable
 * track (hand-smoother.js) and runs the motion recognizers
 * (motion-gesture-recognizer.js). Publishes:
 *   MotionBus 'handMotion'  { v, t, events, counts, last, handHz }
 *   window 'camerastein:handmotion' and 'camerastein:<type>' CustomEvents
 *
 * Off with window.__handMotionChannel = false. Inspect with
 * window.HandMotion.status().
 */

import { createHandSmoother } from './hand-smoother.js';
import { createMotionGestures } from './motion-gesture-recognizer.js';

export const HAND_MOTION_CONTRACT_VERSION = 1;
export const HAND_MOTION_TYPES = Object.freeze(['swipe', 'pinch', 'spread', 'gather']);

const num = (x, d = 0) => (typeof x === 'number' && isFinite(x) ? x : d);

/** Hands from a handPose payload, in a form the smoother takes. */
export function handsFromPose(payload) {
    if (!payload) return [];
    const hands = [];
    if (Array.isArray(payload.landmarks)) hands.push({ landmarks: payload.landmarks, world: payload.worldLandmarks || null });
    if (Array.isArray(payload.landmarks2)) hands.push({ landmarks: payload.landmarks2, world: payload.worldLandmarks2 || null });
    return hands;
}

export function initHandMotionChannel() {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.HandMotion?._wired) return w.HandMotion;

    if (bus._channels && !bus._channels.handMotion) {
        bus._channels.handMotion = 'handMotion';
        bus.state.handMotion = null;
    }

    const smoother = createHandSmoother();
    const recognizer = createMotionGestures(w.__handMotionOptions || {});
    const counts = Object.fromEntries(HAND_MOTION_TYPES.map((k) => [k, 0]));
    const last = Object.fromEntries(HAND_MOTION_TYPES.map((k) => [k, null]));
    const flagOn = () => w.__handMotionChannel !== false;
    let lastPayload = null;

    bus.subscribe?.('handPose', (pose) => {
        if (!flagOn()) return;
        const t = num(pose?.t ?? pose?.timestamp, num(w.performance?.now?.()));
        const tracks = smoother(handsFromPose(pose), t);
        const events = recognizer.update(t, tracks);
        for (const e of events) {
            counts[e.type] = (counts[e.type] || 0) + 1;
            last[e.type] = e;
            w.dispatchEvent?.(new CustomEvent('camerastein:handmotion', { detail: e }));
            w.dispatchEvent?.(new CustomEvent(`camerastein:${e.type}`, { detail: e }));
        }
        const handHz = w.SharedCameraManager?.getTrackingStats?.()?.achieved?.hand?.hz ?? null;
        lastPayload = {
            v: HAND_MOTION_CONTRACT_VERSION, t, events,
            counts: { ...counts }, last: { ...last },
            hands: tracks.length, handHz,
        };
        bus.emit('handMotion', lastPayload);
    });

    w.HandMotion = {
        _wired: true,
        contractVersion: HAND_MOTION_CONTRACT_VERSION,
        types: HAND_MOTION_TYPES,
        recognizer,
        smoother,
        read() { return lastPayload; },
        reset() {
            smoother.reset();
            recognizer.reset();
            for (const k of HAND_MOTION_TYPES) { counts[k] = 0; last[k] = null; }
            lastPayload = null;
            bus.emit('handMotion', null);
        },
        status() {
            const status = { flag: flagOn(), counts: { ...counts }, hands: lastPayload?.hands ?? 0, handHz: lastPayload?.handHz ?? null };
            w.debugManager?.info?.('HandMotion', status);
            return status;
        },
    };
    return w.HandMotion;
}
