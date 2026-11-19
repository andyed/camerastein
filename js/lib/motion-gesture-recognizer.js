/**
 * Motion gestures — what a hand DOES, beside the held poses (what it IS).
 *
 * Held poses (held-pose-recognizer.js) survive slow sampling because a pose
 * lasts. Motions do not: a swipe is over in 0.4 s. These recognizers assume the
 * hand-first pacing of hand-pacing.js (about 15 Hz while a hand is in view) and
 * the One Euro tracks of hand-smoother.js (stable ids, no shimmer to
 * differentiate). Fed at 2.5 Hz they simply never fire, which is the honest
 * failure: they refuse rather than guess between samples.
 *
 *   swipe    an open hand held still for a moment, then moved fast and level
 *            across the frame, all one way, while any other hand stays put.
 *   pinch    thumb and index held together for 0.2 s: one click per pinch,
 *            released only once the fingers are well apart.
 *   spread / gather   two open hands moving apart / together quickly.
 *
 * After toaster (github.com/StopBanning/toaster, MIT): swipe from
 * renderer/portal.js swipeOf + createSwipes (:126-186), pinch from
 * renderer/pinches.js. Thresholds are toaster's where the geometry matches; the
 * hand-size unit here is palmFrame().scale (wrist → middle MCP, image plane), and
 * pinch prefers the metric world landmarks when present, so an edge-on hand
 * cannot fake a touch by projecting thumb and index on top of each other.
 *
 * Pure: explicit clock (ms), no DOM, no timers. update() returns events.
 */

import { handShape, LONG_FINGERS } from './hand-pose-features.js';

export const MOTION_GESTURE_DEFAULTS = Object.freeze({
    historyMs: 1000,
    // swipe
    swipeWindowMs: 400,         // the move must happen within this
    swipeStillFromMs: 350,      // the "still before" window: this far back …
    swipeStillToMs: 650,        // … to this far back
    swipeMinWidth: 0.2,         // fraction of the frame width …
    swipeMinScales: 1.5,        // … and at least this many hand sizes
    swipeMaxSlope: 0.5,         // |dy| <= slope * |dx|
    swipeMaxBacktrack: 0.35,    // hand sizes of reversal allowed
    swipeOpenShare: 0.6,        // share of move samples with an open hand
    swipeStillMax: 0.5,         // hand sizes of drift allowed while "still"
    swipeOtherMax: 0.4,         // the other hand may move this share of |dx|
    swipeCooldownMs: 600,
    swipeReverseMs: 1500,       // no swipe back the other way this soon (the return stroke)
    mirrored: true,             // the lab shows a selfie view: image right is screen left
    // pinch
    pinchEnter: 0.25,           // thumb-index gap / hand size to count as touching
    pinchRelease: 0.6,          // and to count as let go
    pinchHoldMs: 200,
    pinchGapMs: 1000,           // after a click, none for this long
    pinchLostMs: 300,           // an unseen pinch is forgotten after this
    // spread / gather
    spreadWindowMs: 600,
    spreadMinChange: 2.5,       // palm separation change, in mean hand sizes
    spreadFar: 4,               // a spread must end at least this far apart
    gatherNear: 2.5,            // a gather must end at most this far apart
    spreadCooldownMs: 800,
    // open hand
    openMinFingers: 3,
    openExtension: 0.72,        // the suite's EXTENDED exit bound
});

const finite = (x, d = 0) => (typeof x === 'number' && isFinite(x) ? x : d);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

/** Pinch gap in hand sizes: metric world landmarks when present, else image plane. */
export function pinchGap(landmarks, world, shape) {
    if (Array.isArray(world) && world.length >= 10) {
        const size = dist3(world[0], world[9]);
        if (size > 1e-6) return dist3(world[4], world[8]) / size;
    }
    return finite(shape?.pinch, 1);
}

export function createMotionGestures(options = {}) {
    const o = { ...MOTION_GESTURE_DEFAULTS, ...options };
    const tracks = new Map();   // id → { pts: [{t,x,y,s,open}], seen }
    const pinches = new Map();  // id → { since, done, at, p }
    let swipeAt = -Infinity, swipeDir = 0;
    let lastPinchAt = -Infinity;
    let spreadAt = -Infinity;
    const pairHistory = [];     // [{t, sep}] for the two-hand pair

    const isOpen = (shape) =>
        LONG_FINGERS.filter((f) => finite(shape[`${f}Extension`]) >= o.openExtension).length >= o.openMinFingers;

    function swipeOf(pts, other, now) {
        const go = pts.filter((q) => now - q.t <= o.swipeWindowMs);
        const still = pts.filter((q) => now - q.t > o.swipeStillFromMs && now - q.t <= o.swipeStillToMs);
        if (go.length < 3 || still.length < 2) return 0;
        const a = go[0], b = go[go.length - 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const s = Math.max(...go.map((q) => q.s));
        const dir = Math.sign(dx);
        if (Math.abs(dx) < Math.max(o.swipeMinWidth, o.swipeMinScales * s)) return 0;
        if (Math.abs(dy) > o.swipeMaxSlope * Math.abs(dx)) return 0;
        let far = a.x;
        for (const q of go) {
            if ((q.x - far) * dir > 0) far = q.x;
            else if ((far - q.x) * dir > o.swipeMaxBacktrack * s) return 0;
        }
        if (go.filter((q) => q.open).length < o.swipeOpenShare * go.length) return 0;
        const xs = still.map((q) => q.x), ys = still.map((q) => q.y);
        if (Math.max(...xs) - Math.min(...xs) > o.swipeStillMax * s) return 0;
        if (Math.max(...ys) - Math.min(...ys) > o.swipeStillMax * s) return 0;
        if (other && other.length >= 2) {
            const o0 = other[0], o1 = other[other.length - 1];
            if (dist(o0, o1) > o.swipeOtherMax * Math.abs(dx)) return 0;
        }
        return dir;
    }

    function update(t, hands) {
        const now = finite(t);
        const events = [];
        const present = [];

        for (const hand of hands || []) {
            const shape = handShape(hand?.landmarks);
            if (!shape) continue;
            const id = hand.id;
            let tr = tracks.get(id);
            if (!tr) tracks.set(id, (tr = { pts: [], seen: now }));
            const open = isOpen(shape);
            tr.pts.push({ t: now, x: shape.center.x, y: shape.center.y, s: shape.scale, open });
            while (tr.pts.length && now - tr.pts[0].t > o.historyMs) tr.pts.shift();
            tr.seen = now;
            present.push({ id, shape, open, hand, tr });
        }
        for (const [id, tr] of tracks) if (now - tr.seen > o.historyMs) tracks.delete(id);

        // ── swipe ──
        for (const h of present) {
            const other = present.find((x) => x !== h);
            const otherPts = other ? other.tr.pts.filter((q) => now - q.t <= o.swipeWindowMs) : null;
            const dir = swipeOf(h.tr.pts, otherPts, now);
            if (!dir || now - swipeAt < o.swipeCooldownMs) continue;
            if (dir === -swipeDir && now - swipeAt < o.swipeReverseMs) continue;
            swipeAt = now;
            swipeDir = dir;
            h.tr.pts = h.tr.pts.slice(-1); // one stroke, one swipe
            const imageDir = dir > 0 ? 'right' : 'left';
            const screenDir = o.mirrored ? (dir > 0 ? 'left' : 'right') : imageDir;
            events.push({ type: 'swipe', t: now, handId: h.id, dir: screenDir, imageDir });
            break;
        }

        // ── pinch ──
        for (const h of present) {
            const gap = pinchGap(h.hand.landmarks, h.hand.world, h.shape);
            let p = pinches.get(h.id);
            if (gap <= o.pinchEnter) {
                if (!p) pinches.set(h.id, (p = { since: now, done: false }));
                if (p.since === null) p.since = now;
                p.at = now;
                const lm = h.hand.landmarks;
                p.point = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
                if (!p.done && now - p.since >= o.pinchHoldMs) {
                    p.done = true; // counted now or never: no click later out of the blue
                    if (now - lastPinchAt >= o.pinchGapMs) {
                        lastPinchAt = now;
                        events.push({ type: 'pinch', t: now, handId: h.id, point: p.point, gap });
                    }
                }
            } else if (p) {
                if (gap >= o.pinchRelease) pinches.delete(h.id);
                else p.since = null; // between the bounds: the hold restarts, the click stays spent
            }
        }
        for (const [id, p] of pinches) if (now - finite(p.at, now) > o.pinchLostMs) pinches.delete(id);

        // ── spread / gather ──
        const openPair = present.filter((h) => h.open);
        if (openPair.length === 2) {
            const [a, b] = openPair;
            const meanScale = (a.shape.scale + b.shape.scale) / 2;
            if (meanScale > 1e-6) {
                pairHistory.push({ t: now, sep: dist(a.shape.center, b.shape.center) / meanScale });
            }
        } else {
            pairHistory.length = 0;
        }
        while (pairHistory.length && now - pairHistory[0].t > o.spreadWindowMs) pairHistory.shift();
        if (pairHistory.length >= 3 && now - spreadAt >= o.spreadCooldownMs) {
            const first = pairHistory[0].sep, last = pairHistory[pairHistory.length - 1].sep;
            const change = last - first;
            let type = null;
            if (change >= o.spreadMinChange && last >= o.spreadFar) type = 'spread';
            else if (-change >= o.spreadMinChange && last <= o.gatherNear) type = 'gather';
            if (type) {
                spreadAt = now;
                pairHistory.length = 0;
                events.push({ type, t: now, separation: last, change });
            }
        }

        return events;
    }

    return {
        options: Object.freeze({ ...o }),
        update,
        reset() {
            tracks.clear();
            pinches.clear();
            pairHistory.length = 0;
            swipeAt = -Infinity; swipeDir = 0;
            lastPinchAt = -Infinity;
            spreadAt = -Infinity;
        },
    };
}
