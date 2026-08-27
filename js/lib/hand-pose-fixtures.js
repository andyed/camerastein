/**
 * Hand Pose Fixtures — deterministic synthetic landmarks, no camera.
 *
 * Builds anatomically-plausible 21-point MediaPipe hands from a pose
 * description, so hand recognizers can be exercised the way the face Gesture
 * Lab's `rehearse` exercises the face channel: same lifecycle, no webcam, no
 * lighting, no flake. A rehearsal proves the recognizer's state machine. It
 * does NOT prove landmark extraction from a real camera.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 */

import { LM } from './hand-pose-features.js';

const EPS = 1e-6;

const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});

function normalize(a) {
    const m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (!(m > EPS)) return { x: 0, y: 0, z: 0 };
    return { x: a.x / m, y: a.y / m, z: a.z / m };
}

// Canonical hand, right chirality, in palm units:
//   U across the palm, pinky → index positive
//   V from wrist toward the fingertips
//   W the palm normal that palmFrame() recovers
const MCP = {
    index: { u: 0.35, v: 0.85 },
    middle: { u: 0.05, v: 0.95 },
    ring: { u: -0.22, v: 0.90 },
    pinky: { u: -0.48, v: 0.78 },
};

const PHALANX = {
    index: [0.40, 0.26, 0.20],
    middle: [0.44, 0.28, 0.21],
    ring: [0.40, 0.26, 0.20],
    pinky: [0.32, 0.21, 0.17],
};

// Fingers fan slightly outward from the palm axis rather than running parallel.
// The fan tapers as the hand closes: a fist brings the fingertips together, and
// a splay that survived a full curl kept the pinky — which fans the most —
// reading straighter than its neighbours at the same curl.
const FAN = { index: 0.20, middle: 0.03, ring: -0.14, pinky: -0.30 };
const FAN_TAPER = 0.75;

// Per-joint flexion at full curl. Cumulative across the three joints this is
// ~3.0 rad (172°) — the fingertip folded back against the palm, which is where
// a real finger stops. An earlier 1.2 rad summed to 3.6 rad and swung the tip
// back out the far side, making extension non-monotonic in curl: a "fully
// curled" finger measured straighter than a half-curled one.
const MAX_BEND = 1.0;

// Thumb chain, extended. Curling folds it across the palm toward the pinky,
// which is what a real thumb does — it does not bend into the palm plane the
// way the fingers do, so it gets its own path rather than the finger sweep.
const THUMB = [
    { u: 0.30, v: 0.15, w: 0.05 },
    { u: 0.58, v: 0.34, w: 0.10 },
    { u: 0.76, v: 0.50, w: 0.13 },
    { u: 0.90, v: 0.62, w: 0.15 },
];

// Tucked across the palm, folded at the IP joint the way a real thumb closes
// over a fist — not merely swung inward while staying straight.
const THUMB_TUCKED = [
    { u: 0.28, v: 0.16, w: 0.04 },
    { u: 0.40, v: 0.40, w: 0.06 },
    { u: 0.18, v: 0.52, w: 0.07 },
    { u: 0.06, v: 0.34, w: 0.08 },
];

const FINGER_SLOTS = [
    ['index', LM.INDEX_MCP],
    ['middle', LM.MIDDLE_MCP],
    ['ring', LM.RING_MCP],
    ['pinky', LM.PINKY_MCP],
];

/**
 * Canonical-space landmarks for a right hand.
 *
 * @param {number|object} curl  a single curl for every finger, or a per-finger
 *   map `{ thumb, index, middle, ring, pinky }` (missing keys default to 0).
 *   Per-finger control is what makes a pose vocabulary expressible: point,
 *   peace, horns and a fist differ only in which fingers are curled.
 */
function canonicalHand(curl) {
    const per = (finger) => (typeof curl === 'number' ? curl : (curl?.[finger] ?? 0));
    const points = new Array(21);
    points[LM.WRIST] = { u: 0, v: 0, w: 0 };

    const thumbCurl = per('thumb');
    THUMB.forEach((p, index) => {
        const tucked = THUMB_TUCKED[index];
        points[LM.THUMB_CMC + index] = {
            u: p.u + (tucked.u - p.u) * thumbCurl,
            v: p.v + (tucked.v - p.v) * thumbCurl,
            w: p.w + (tucked.w - p.w) * thumbCurl,
        };
    });

    for (const [finger, mcpIndex] of FINGER_SLOTS) {
        const base = MCP[finger];
        let current = { u: base.u, v: base.v, w: 0 };
        points[mcpIndex] = { ...current };

        const fingerCurl = per(finger);
        const fan = FAN[finger] * (1 - FAN_TAPER * fingerCurl);
        for (let joint = 0; joint < 3; joint++) {
            const theta = fingerCurl * MAX_BEND * (joint + 1);
            const dir = normalize({ x: fan, y: Math.cos(theta), z: -Math.sin(theta) });
            const length = PHALANX[finger][joint];
            current = {
                u: current.u + dir.x * length,
                v: current.v + dir.y * length,
                w: current.w + dir.z * length,
            };
            points[mcpIndex + joint + 1] = { ...current };
        }
    }

    return points;
}

// Palm scale and palm center of the canonical hand, so a caller's requested
// scale and center land where they asked. Derived once, not hardcoded, so
// edits to the canonical layout stay self-consistent.
const CANON = (() => {
    const p = canonicalHand(0);
    const width = Math.hypot(p[LM.INDEX_MCP].u - p[LM.PINKY_MCP].u, p[LM.INDEX_MCP].v - p[LM.PINKY_MCP].v);
    const length = Math.hypot(p[LM.MIDDLE_MCP].u, p[LM.MIDDLE_MCP].v);
    const keys = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
    const center = keys.reduce((acc, k) => ({
        u: acc.u + p[k].u / keys.length,
        v: acc.v + p[k].v / keys.length,
        w: acc.w + p[k].w / keys.length,
    }), { u: 0, v: 0, w: 0 });
    return { scale: (width + length) / 2, center };
})();

/**
 * Build one hand's landmarks in MediaPipe image coordinates.
 *
 * @param {object} pose
 * @param {{x,y,z}} pose.palmCenter  where palmFrame().center should land
 * @param {number}  pose.scale       what palmFrame().scale should read
 * @param {{x,y,z}} pose.axis        unit finger direction (y runs DOWN the image)
 * @param {{x,y,z}} pose.palmDirection  unit vector the PALM faces
 * @param {number|object} pose.curl     0 flat → 1 fisted, or a per-finger map
 *                                      `{ thumb, index, middle, ring, pinky }`
 * @param {'left'|'right'} pose.chirality
 *
 * `palmDirection` is physical and chirality-independent: it is where the palm
 * points, for either hand. The normal `palmFrame()` recovers is NOT the same
 * thing. That normal is `(indexMCP−wrist) × (pinkyMCP−wrist)`, a chirality-
 * dependent construction — a left hand is the mirror of a right one, so the
 * same formula yields the palm direction for one and the back-of-hand
 * direction for the other. This generator reproduces that inversion rather
 * than compensating for it, because MediaPipe does not compensate either. A
 * fixture that quietly corrected the sign would validate a recognizer that
 * cannot work on a real pair of hands.
 */
export function makeHand({
    palmCenter = { x: 0.5, y: 0.5, z: 0 },
    scale = 0.09,
    axis = { x: 0, y: -1, z: 0 },
    palmDirection = { x: 0, y: 0, z: -1 },
    curl = 0,
    chirality = 'right',
} = {}) {
    // Mirroring through the u = 0 plane turns a right hand into a left one and
    // leaves the palm pointing the same way, so the basis is shared. The
    // cross-product normal then comes out inverted for the left hand, exactly
    // as it does on real landmarks.
    const mirrored = chirality === 'left';
    const v = normalize(axis);
    const w = normalize(palmDirection);
    const u = normalize(cross(v, w));

    const gain = scale / CANON.scale;
    const points = canonicalHand(curl);

    return points.map((p) => {
        const pu = (mirrored ? -1 : 1) * (p.u - CANON.center.u);
        const pv = p.v - CANON.center.v;
        const pw = p.w - CANON.center.w;
        return {
            x: palmCenter.x + gain * (pu * u.x + pv * v.x + pw * w.x),
            y: palmCenter.y + gain * (pu * u.y + pv * v.y + pw * w.y),
            z: palmCenter.z + gain * (pu * u.z + pv * v.z + pw * w.z),
        };
    });
}

/**
 * A two-hand prayer pose: palms flat, facing each other, fingers up.
 *
 * @param {object} [options]
 * @param {number} [options.gap]   palm-center separation in hand-scale units
 * @param {number} [options.curl]  finger curl on both hands
 * @param {number} [options.tilt]  radians the pair leans off vertical
 */
export function makePrayPose({ gap = 0.34, curl = 0.04, tilt = 0, scale = 0.09, centerX = 0.5, centerY = 0.52 } = {}) {
    const half = (gap * scale) / 2;
    const axis = normalize({ x: Math.sin(tilt), y: -Math.cos(tilt), z: 0 });
    // Separation runs along the palm normals, perpendicular to the finger axis.
    const apart = normalize({ x: Math.cos(tilt), y: Math.sin(tilt), z: 0 });

    return [
        makeHand({
            chirality: 'right',
            palmCenter: { x: centerX + apart.x * half, y: centerY + apart.y * half, z: 0 },
            scale,
            axis,
            palmDirection: { x: -apart.x, y: -apart.y, z: 0 },
            curl,
        }),
        makeHand({
            chirality: 'left',
            palmCenter: { x: centerX - apart.x * half, y: centerY - apart.y * half, z: 0 },
            scale,
            axis,
            palmDirection: { x: apart.x, y: apart.y, z: 0 },
            curl,
        }),
    ];
}

/** Two flat hands held apart, palms toward the camera — the "not pray" control. */
export function makeOpenPalmsPose({ separation = 2.2, scale = 0.09, centerY = 0.52 } = {}) {
    const half = (separation * scale) / 2;
    return [
        makeHand({
            chirality: 'right',
            palmCenter: { x: 0.5 + half, y: centerY, z: 0 },
            scale,
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: 0, y: 0, z: -1 },
            curl: 0.05,
        }),
        makeHand({
            chirality: 'left',
            palmCenter: { x: 0.5 - half, y: centerY, z: 0 },
            scale,
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: 0, y: 0, z: -1 },
            curl: 0.05,
        }),
    ];
}

/**
 * Scramble depth while leaving the image plane intact.
 *
 * This is the pray failure mode in a fixture: MediaPipe reports x and y well
 * and z poorly, and the palm normal is built from a cross product whose result,
 * for an edge-on palm, is almost entirely z. Deterministic — a fixed hash per
 * landmark index, so a test that passes stays passed.
 */
export function jitterDepth(hands, amount = 0.06) {
    return hands.map((hand, handIndex) => hand.map((point, index) => {
        const hash = Math.sin((handIndex * 21 + index + 1) * 12.9898) * 43758.5453;
        return { ...point, z: point.z + (hash - Math.floor(hash) - 0.5) * 2 * amount };
    }));
}

/** Two flat palms facing the camera, held close — the pose foreshortening rejects. */
export function makeFlatSandwichPose({ gap = 0.5, scale = 0.09 } = {}) {
    const half = (gap * scale) / 2;
    return [
        makeHand({
            chirality: 'right',
            palmCenter: { x: 0.5 + half, y: 0.52, z: 0 },
            scale,
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: 0, y: 0, z: -1 },
            curl: 0.04,
        }),
        makeHand({
            chirality: 'left',
            palmCenter: { x: 0.5 - half, y: 0.52, z: 0 },
            scale,
            axis: { x: 0, y: -1, z: 0 },
            palmDirection: { x: 0, y: 0, z: -1 },
            curl: 0.04,
        }),
    ];
}

/**
 * Pull the thumb landmarks onto the finger axis, so `thumbSide` reads ~0.
 *
 * Simulates the thumb of a genuinely edge-on palm, whose sideways offset lies
 * almost entirely in depth and so leaves no in-plane trace. This is the state
 * `palmOpposition` degrades to as the pray pose perfects itself — the case the
 * criterion must not reject.
 */
export function flattenThumb(hands) {
    return hands.map((hand) => {
        const wrist = hand[LM.WRIST];
        const middleMcp = hand[LM.MIDDLE_MCP];
        const ax = middleMcp.x - wrist.x;
        const ay = middleMcp.y - wrist.y;
        const len = Math.hypot(ax, ay) || 1;
        const ux = ax / len;
        const uy = ay / len;
        return hand.map((point, index) => {
            if (index < LM.THUMB_CMC || index > LM.THUMB_TIP) return point;
            // Project the thumb onto the finger axis: keep its reach, drop the
            // sideways component that carries the palm-facing signal.
            const dx = point.x - wrist.x;
            const dy = point.y - wrist.y;
            const along = dx * ux + dy * uy;
            return { ...point, x: wrist.x + ux * along, y: wrist.y + uy * along };
        });
    });
}
