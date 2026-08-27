/**
 * Hand Pose Channel — the pose suite wired to the MotionBus `handPose` channel.
 *
 * One channel for the whole suite rather than one per pose: `handPoses` carries
 * a map of kind → gesture frame, so a consumer subscribes once and seven more
 * poses do not mean seven more subscriptions. Named events still fire per
 * gesture, the way `camerastein:pray` does.
 *
 * Like the pray channel, this is a consumer of the bus and not a detector edit.
 *
 * Flag: `window.__handPoseChannel === true` (default on)
 * Channel: `MotionBus.state.handPose` → `MotionBus.state.handPoses`
 *
 * @see docs/HAND_GESTURE_SUITE.md
 */

import {
    createHandPoseRecognizers,
    HAND_POSE_IDS,
    HAND_POSE_SPECS,
} from './hand-pose-suite.js';
import { HELD_POSE_CONTRACT_VERSION } from './held-pose-recognizer.js';

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;

export function initHandPoseChannel() {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.HandPoses?._wired) return w.HandPoses;

    if (bus._channels && !bus._channels.handPoses) {
        bus._channels.handPoses = 'handPoses';
        bus.state.handPoses = null;
    }

    // Sized to the slowest planned hand rate (~0.83 Hz on mobile), not to the
    // face channel's 400 ms, which would call every mobile frame stale.
    const STALE_MS = 2000;

    const recognizers = createHandPoseRecognizers();
    let last = null;
    let wasEmitting = false;

    const flagOn = () => w.__handPoseChannel !== false;

    const clear = () => {
        for (const kind of HAND_POSE_IDS) recognizers[kind].reset();
        last = null;
        if (!wasEmitting) return;
        wasEmitting = false;
        bus.emit('handPoses', null);
    };

    bus.subscribe?.('handPose', (hand) => {
        if (!flagOn() || !hand) {
            clear();
            return;
        }

        const hands = [];
        if (Array.isArray(hand.landmarks)) hands.push(hand.landmarks);
        if (Array.isArray(hand.landmarks2)) hands.push(hand.landmarks2);

        const t = num(hand.t ?? hand.timestamp);
        const confidence = num(hand.confidence);
        const payload = { v: HELD_POSE_CONTRACT_VERSION, t };

        for (const kind of HAND_POSE_IDS) {
            const frame = recognizers[kind].update({ t, hands, confidence });
            payload[kind] = frame;
            for (const event of frame.events) {
                w.dispatchEvent?.(new CustomEvent('camerastein:handpose', { detail: event }));
                w.dispatchEvent?.(new CustomEvent(`camerastein:${kind}`, { detail: event }));
            }
        }

        last = payload;
        wasEmitting = true;
        bus.emit('handPoses', payload);
    });

    const readAt = (nowMs) => {
        if (!last || !isFinite(last.t)) return { fresh: false, ageMs: Infinity, poses: null };
        const ageMs = num(nowMs) - last.t;
        if (!(ageMs >= 0) || ageMs > STALE_MS) {
            return { fresh: false, ageMs: num(ageMs), poses: null };
        }
        return { fresh: true, ageMs, poses: last };
    };

    w.HandPoses = {
        _wired: true,
        contractVersion: HELD_POSE_CONTRACT_VERSION,
        kinds: HAND_POSE_IDS,
        recognizers,
        recognizer: recognizers[HAND_POSE_IDS[0]],
        read() { return readAt(performance.now()); },
        reset() {
            clear();
            bus.emit('handPoses', null);
        },
        retune() {
            for (const kind of HAND_POSE_IDS) recognizers[kind].retune();
        },
        /** Which poses are holding right now, and what is blocking the rest. */
        status() {
            const r = readAt(performance.now());
            const status = {
                flag: flagOn(),
                fresh: r.fresh,
                ageMs: Math.round(num(r.ageMs)),
                active: HAND_POSE_IDS.filter((kind) => r.poses?.[kind]?.track?.active),
                blocked: Object.fromEntries(HAND_POSE_IDS
                    .filter((kind) => r.poses?.[kind]?.quality?.blockedBy?.length)
                    .map((kind) => [kind, r.poses[kind].quality.blockedBy.join(' + ')])),
            };
            w.debugManager?.info?.('HandPoses', status);
            return status;
        },
        titleOf: (kind) => HAND_POSE_SPECS[kind]?.title ?? kind,
    };
    return w.HandPoses;
}
