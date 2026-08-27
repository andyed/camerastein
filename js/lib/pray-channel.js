/**
 * Pray Channel — PrayRecognizer wired to the MotionBus `handPose` channel.
 *
 * Deliberately a consumer, not a detector edit. `handPoseDetector` already
 * publishes both hands' raw landmarks (`landmarks`, `landmarks2`) alongside its
 * aggregate signals, so a two-hand recognizer can live outside the 1343-line
 * detector that Psychodeli+ shares. Nothing here writes detector state.
 *
 * Flag: `window.__prayChannel === true` (default on; mirrors __faceGestureChannel)
 * Channel: `MotionBus.state.handPose` → `MotionBus.state.prayGesture`
 *
 * Hand-order note: the detector publishes the dominant hand first, and which
 * hand that is flips with motion. Every pray criterion is symmetric under
 * swapping the two hands, so the recognizer never has to care.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 */

import { PrayRecognizer, PRAY_CONTRACT_VERSION } from './pray-recognizer.js';

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;

export function initPrayChannel() {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.PrayGesture?._wired) return w.PrayGesture;

    if (bus._channels && !bus._channels.prayGesture) {
        bus._channels.prayGesture = 'prayGesture';
        bus.state.prayGesture = null;
    }

    // Hands run in the throttled overlay slot — ~2.8 Hz desktop, ~0.83 Hz
    // mobile. A 400 ms freshness bound like the face channel's would call every
    // mobile frame stale, so this one is sized to the slowest planned rate.
    const STALE_MS = 2000;

    const recognizer = new PrayRecognizer();
    let last = null;
    let wasEmitting = false;

    const flagOn = () => w.__prayChannel !== false;

    const clear = () => {
        recognizer.reset();
        last = null;
        if (!wasEmitting) return;
        wasEmitting = false;
        bus.emit('prayGesture', null);
    };

    bus.subscribe?.('handPose', (hand) => {
        if (!flagOn() || !hand) {
            clear();
            return;
        }

        // Both hands or nothing. One-hand frames still advance the recognizer's
        // clock so its nil tolerance can expire an episode on schedule.
        const hands = [];
        if (Array.isArray(hand.landmarks)) hands.push(hand.landmarks);
        if (Array.isArray(hand.landmarks2)) hands.push(hand.landmarks2);

        const frame = recognizer.update({
            t: num(hand.t ?? hand.timestamp),
            hands,
            confidence: num(hand.confidence),
        });

        last = frame;
        wasEmitting = true;
        bus.emit('prayGesture', frame);

        // Named-gesture convenience for hosts that only want the punctuation,
        // matching handPoseDetector's own onGesture('thumbConfirm') shape.
        for (const event of frame.events) {
            w.dispatchEvent?.(new CustomEvent('camerastein:pray', { detail: event }));
        }
    });

    const readAt = (nowMs) => {
        if (!last || !isFinite(last.t)) {
            return { fresh: false, ageMs: Infinity, pray: null };
        }
        const ageMs = num(nowMs) - last.t;
        if (!(ageMs >= 0) || ageMs > STALE_MS) {
            return { fresh: false, ageMs: num(ageMs), pray: null };
        }
        return { fresh: true, ageMs, pray: last };
    };

    w.PrayGesture = {
        _wired: true,
        contractVersion: PRAY_CONTRACT_VERSION,
        recognizer,
        read() { return readAt(performance.now()); },
        reset() {
            clear();
            bus.emit('prayGesture', null);
        },
        status() {
            const r = readAt(performance.now());
            const f = r.pray?.features;
            const status = {
                flag: flagOn(),
                fresh: r.fresh,
                ageMs: Math.round(num(r.ageMs)),
                phase: r.pray?.track?.phase || 'idle',
                dwell: +(r.pray?.track?.dwell ?? 0).toFixed(2),
                value: +(r.pray?.track?.value ?? 0).toFixed(2),
                degraded: r.pray?.quality?.degraded ?? false,
                handsPresent: r.pray?.quality?.handsPresent ?? 0,
                reason: r.pray?.quality?.reason || 'none',
                blockedBy: r.pray?.quality?.blockedBy || [],
                features: f ? {
                    separation: +f.separation.toFixed(2),
                    palmOpposition: +f.palmOpposition.toFixed(2),
                    foreshortening: +f.foreshortening.toFixed(2),
                    axisAlignment: +f.axisAlignment.toFixed(2),
                    flatness: +f.flatness.toFixed(2),
                    uprightness: +f.uprightness.toFixed(2),
                    normalDot: +f.normalDot.toFixed(2),   // diagnostic only
                } : null,
                events: r.pray?.events?.map((e) => `${e.kind}:${e.phase}`) || [],
            };
            w.debugManager?.info?.('PrayGesture', status);
            return status;
        },
    };
    return w.PrayGesture;
}
