/**
 * Hand smoother — One Euro filtering of hand landmarks, with stable track ids.
 *
 * WHY. MediaPipe's points shimmer by a pixel or two between frames while a hand
 * is held still. Held poses tolerate that: they judge each frame's shape and
 * charge a dwell. Motion gestures (swipe, pinch-click) read velocities, and the
 * derivative of shimmer is noise. A One Euro filter (Casiez, Roussel and Vogel,
 * CHI 2012) smooths hard while a point is still and lets go as it speeds up, so
 * a still hand holds steady and a moving one is not dragged behind.
 *
 * Tracks. The tracker lists hands in no fixed order, and HandPoseDetector puts
 * the faster hand first. Each input hand is matched to the nearest existing
 * track by wrist position, so a track id follows one physical hand. A track
 * missing from a frame survives `keepMs`, which bridges a dropped detection; a
 * longer gap starts the hand afresh with a new id.
 *
 * After toaster (github.com/StopBanning/toaster, MIT, renderer/smooth.js):
 * same filter, same wrist matching, same defaults (minCutoff 0.7 Hz, beta 12),
 * tuned there on the tracker's own shimmer. Added here: z, stable ids, dropout
 * bridging, and world landmarks passed through unfiltered (bends are judged per
 * frame; nothing differentiates them).
 *
 * Pure: explicit clock (ms), no DOM, no timers.
 */

const finite = (x, d = 0) => (typeof x === 'number' && isFinite(x) ? x : d);

/**
 * One scalar One Euro filter. Returns (x, dtSeconds) => filtered x.
 * minCutoff: smoothing when still (Hz, lower = smoother).
 * beta: how fast smoothing releases with speed. dCutoff: derivative cutoff (Hz).
 */
export function oneEuro(minCutoff = 0.7, beta = 12, dCutoff = 1) {
    let prev = null;
    let dPrev = 0;
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    return (x, dt) => {
        if (prev === null || !(dt > 0)) {
            prev = x;
            dPrev = 0;
            return x;
        }
        dPrev += alpha(dCutoff, dt) * ((x - prev) / dt - dPrev);
        prev += alpha(minCutoff + beta * Math.abs(dPrev), dt) * (x - prev);
        return prev;
    };
}

export const HAND_SMOOTHER_DEFAULTS = Object.freeze({
    minCutoff: 0.7,
    beta: 12,
    matchRadius: 0.15,  // max wrist travel (normalized image units) to keep a track
    keepMs: 400,        // a track missing longer than this is dropped
});

/**
 * @returns {(hands: Array<{landmarks: Array<{x,y,z}>, world?: Array|null}>, tMs: number) =>
 *           Array<{id: number, landmarks: Array<{x,y,z}>, world: Array|null, fresh: boolean, ageMs: number}>}
 */
export function createHandSmoother(options = {}) {
    const o = { ...HAND_SMOOTHER_DEFAULTS, ...options };
    let tracks = [];
    let nextId = 1;

    const makeFilters = (n) => Array.from({ length: n }, () => [
        oneEuro(o.minCutoff, o.beta), oneEuro(o.minCutoff, o.beta), oneEuro(o.minCutoff, o.beta),
    ]);

    function smooth(hands, t) {
        const now = finite(t);
        const live = tracks.filter((tr) => now - tr.at <= o.keepMs);
        const taken = new Set();
        const out = [];

        for (const hand of hands || []) {
            const lm = hand?.landmarks;
            if (!Array.isArray(lm) || lm.length === 0) continue;
            const wx = finite(lm[0]?.x), wy = finite(lm[0]?.y);

            let track = null;
            let best = o.matchRadius;
            for (const tr of live) {
                if (taken.has(tr) || tr.filters.length !== lm.length) continue;
                const d = Math.hypot(tr.wrist.x - wx, tr.wrist.y - wy);
                if (d < best) { best = d; track = tr; }
            }
            const fresh = !track;
            if (fresh) {
                track = { id: nextId++, filters: makeFilters(lm.length), at: now, born: now, wrist: { x: wx, y: wy } };
            }
            const dt = fresh ? 0 : (now - track.at) / 1000;
            const landmarks = lm.map((p, i) => ({
                x: track.filters[i][0](finite(p?.x), dt),
                y: track.filters[i][1](finite(p?.y), dt),
                z: track.filters[i][2](finite(p?.z), dt),
            }));
            track.at = now;
            track.wrist = landmarks[0];
            taken.add(track);
            out.push({ id: track.id, landmarks, world: hand.world || null, fresh, ageMs: now - track.born });
        }

        // Unmatched live tracks persist (dropout bridging) until keepMs passes.
        tracks = [...taken, ...live.filter((tr) => !taken.has(tr))];
        return out;
    }

    smooth.reset = () => { tracks = []; };
    smooth.trackCount = () => tracks.length;
    return smooth;
}
