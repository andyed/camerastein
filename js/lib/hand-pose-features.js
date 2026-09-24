/**
 * Hand Pose Features — palm-local geometry for two-hand recognizers.
 *
 * Pure functions over MediaPipe hand landmarks (21 × {x, y, z}). No state, no
 * smoothing, no bus. Everything here is scale- and position-invariant so a
 * recognizer can fire the same way whether the hands are at chest height or
 * held up near the lens.
 *
 * Coordinate conventions (MediaPipe normalized landmarks):
 *   x → right across the image, 0..1
 *   y → DOWN the image, 0..1   (so "fingers up" means a negative axis.y)
 *   z → relative depth, wrist-origin, negative toward the camera
 *
 * ## Why almost everything here is 2D
 *
 * MediaPipe's z is a *relative* depth estimate. It is not metrically
 * comparable to x and y, and it is far noisier. Mixing it into a distance
 * quietly corrupts that distance: on a synthetic pray pose with the image
 * plane left untouched and depth jitter applied, the 3D palm-centre separation
 * inflated 6.6× (0.031 → 0.202) while the image-plane one did not move at all.
 * The recognizer would have read the hands as drifting apart while they were
 * held perfectly still.
 *
 * So every criterion is computed in the image plane. `normal` — the one
 * quantity that cannot be — is published for diagnosis, and `aspect` says how
 * edge-on the palm is, which is what determines whether the normal had enough
 * in-plane structure to mean anything.
 *
 * The cost: a finger pointed straight at the lens projects short and reads as
 * curled. Every gesture in this vocabulary is performed in the image plane, so
 * that trade is worth making — but it is a real limit, not a free win.
 *
 * Palm-local normalization (center from wrist + four MCPs, scale from palm
 * width and length, inter-hand distance divided by mean scale) follows the
 * approach in argyrios-dev/AirControll's FeatureExtractor.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 */

export const LM = {
    WRIST: 0,
    THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
    INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
    MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
    RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
    PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

/**
 * Finger chains used for extension.
 *
 * The thumb is included here but deliberately EXCLUDED from `handFlatness` — it
 * opposes the palm and reads as partly curled on a perfectly flat hand, the same
 * reason OptiGest's fist test drops it (`fix(hand): exclude thumb from fist
 * detection`). Poses that care about the thumb ask for it by name.
 */
export const FINGER_CHAINS = {
    thumb: [LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP],
    index: [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
    middle: [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
    ring: [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
    pinky: [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
};

const EPS = 1e-6;

const num = (value) => (Number.isFinite(value) ? value : 0);
const pt = (lm) => (lm ? { x: num(lm.x), y: num(lm.y), z: num(lm.z) } : null);

/** Image-plane distance. Ignores z, which is the untrustworthy axis. */
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});

function unit3(a) {
    const m = Math.sqrt(dot3(a, a));
    if (!(m > EPS)) return null;
    return { x: a.x / m, y: a.y / m, z: a.z / m };
}

function unit2(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const m = Math.hypot(dx, dy);
    if (!(m > EPS)) return null;
    return { x: dx / m, y: dy / m };
}

/**
 * Palm frame for one hand. All lengths are image-plane; `normal` is not.
 *
 * @returns {{center, scale, axis, normal, aspect, palmWidth, palmLength}|null}
 *   center — mean of wrist + the four MCPs, the stable interior point
 *   scale  — palmLength, i.e. |wrist → middleMCP| in the image plane. The
 *            hand's own unit of length, and the ONLY one that survives this
 *            gesture: it lies along the finger axis, so rotating the palm about
 *            that axis leaves it untouched. A width-based proxy shrinks 1.75×
 *            as the palm turns edge-on — which is precisely what pressing two
 *            palms together does — so anything normalized by it inflates by
 *            that factor in the pose it is meant to recognize.
 *   axis   — unit wrist→middleMCP in the image plane, where the fingers point
 *   normal — unit 3D palm normal, (indexMCP−wrist) × (pinkyMCP−wrist). The one
 *            z-dependent quantity here; consult `aspect` before believing it.
 *   aspect — projected palm width ÷ length. ~0.85 with the palm toward the
 *            camera, ~0.1 edge-on. Low aspect means the normal's two source
 *            vectors project nearly collinear and their cross product is left
 *            to z alone — exactly when `normal` should not be trusted.
 *
 * Returns null rather than a degenerate frame when landmarks are missing or the
 * palm collapses entirely. Callers must handle null.
 */
export function palmFrame(landmarks) {
    if (!landmarks || landmarks.length < 21) return null;

    const wrist = pt(landmarks[LM.WRIST]);
    const indexMcp = pt(landmarks[LM.INDEX_MCP]);
    const middleMcp = pt(landmarks[LM.MIDDLE_MCP]);
    const ringMcp = pt(landmarks[LM.RING_MCP]);
    const pinkyMcp = pt(landmarks[LM.PINKY_MCP]);
    if (!wrist || !indexMcp || !middleMcp || !ringMcp || !pinkyMcp) return null;

    const center = {
        x: (wrist.x + indexMcp.x + middleMcp.x + ringMcp.x + pinkyMcp.x) / 5,
        y: (wrist.y + indexMcp.y + middleMcp.y + ringMcp.y + pinkyMcp.y) / 5,
    };

    const palmWidth = dist2(indexMcp, pinkyMcp);
    const palmLength = dist2(middleMcp, wrist);
    const scale = palmLength;
    if (!(scale > EPS)) return null;

    const axis = unit2(wrist, middleMcp);
    const normal = unit3(cross3(sub3(indexMcp, wrist), sub3(pinkyMcp, wrist)));
    if (!axis || !normal) return null;

    const aspect = palmLength > EPS ? palmWidth / palmLength : 1;

    // Which side of its own palm the thumb sits on, measured across the finger
    // axis and in hand-scale units. The thumb base is a large landmark offset
    // in the image plane, so this survives projection where the palm normal
    // does not: it flips sign when the palm turns to face the other way, and
    // it does not depend on z at all.
    const thumbCmc = pt(landmarks[LM.THUMB_CMC]);
    const thumbSide = thumbCmc
        ? ((thumbCmc.x - center.x) * -axis.y + (thumbCmc.y - center.y) * axis.x) / scale
        : 0;

    return { center, scale, axis, normal, aspect, thumbSide, palmWidth, palmLength };
}

/**
 * Finger extension, 0 (fully curled) → 1 (straight), in the image plane.
 *
 * Ratio of the direct base→tip distance to the summed bone length along the
 * chain. Scale-free by construction, and unlike a tip-to-palm distance it needs
 * no calibrated hand size.
 *
 * The chain starts at the **MCP**, not the wrist, matching
 * `handPoseDetector._fingerChains` exactly. That is deliberate and load-bearing
 * in two ways. It measures the finger rather than the finger plus the palm —
 * including the wrist puts a fixed length in both numerator and denominator,
 * which compresses a fully curled finger to ~0.5 instead of ~0.1 and throws
 * away most of the dynamic range. And it makes this value the exact complement
 * of the detector's `state.<finger>Curl`, so Psychodeli and the pose suite
 * finally measure the same quantity and their thresholds are comparable.
 *
 *     fingerExtension(…) === 1 − handPoseDetector.state.<finger>Curl
 */
export function fingerExtension(landmarks, chain) {
    if (!landmarks) return 0;
    const points = chain.map((index) => pt(landmarks[index]));
    if (points.some((p) => p === null)) return 0;

    let chainLength = 0;
    for (let i = 1; i < points.length; i++) chainLength += dist2(points[i - 1], points[i]);
    if (!(chainLength > EPS)) return 0;

    const direct = dist2(points[0], points[points.length - 1]);
    return Math.max(0, Math.min(1, direct / chainLength));
}

/**
 * Wrist-reach calibration: the raw reach that maps to 0 and to 1.
 *
 * Measured on a live guided run (2026-09-24, one subject): extended long
 * fingers read 1.25–1.38 raw, curled ones 0.34–0.89, in every pose recorded.
 * Synthetic hands agree: 1.31–1.36 straight, 0.73–0.87 fully curled, facing
 * the camera or edge-on. Mapping 0.6 → 0 and 1.3 → 1 puts real extended
 * fingers at ≥ 0.93 and curled at ≤ 0.41, so the suite's EXTENDED (0.85) and
 * CURLED (0.55) bands sit inside the measured gap with margin on both sides.
 */
export const REACH_CURLED = 0.6;
export const REACH_STRAIGHT = 1.3;

/**
 * Finger extension by wrist reach — OptiGest's rule, made continuous.
 *
 * OptiGest (optimac `FingerCounter.isExtended`) calls a finger extended when
 * its tip is farther from the wrist than both its PIP and its MCP. Here that
 * is the ratio `tip→wrist ÷ max(pip→wrist, mcp→wrist)` — above 1 is the
 * OptiGest "extended" — rescaled onto 0 curled … 1 straight.
 *
 * Why not `fingerExtension` for the one-hand suite: that is straightness, the
 * base→tip chord over the chain length, and it is scale-free in the wrong way.
 * A finger curled *toward the camera* projects as a short straight segment,
 * so its chord equals its chain and it reads 1.00 — straight. A live peace
 * sign read its tucked ring and pinky as fully extended for exactly this
 * reason. Reach does not care how straight the projection is, only whether
 * the tip got farther from the wrist than the knuckles did, and a curl in any
 * direction brings the tip back.
 *
 * Long fingers only. The thumb's tip clears its knuckles whether it is tucked
 * across a fist or not (OptiGest found the same and dropped the thumb from its
 * fist test), so the thumb keeps `fingerExtension`.
 */
export function fingerReach(landmarks, chain) {
    if (!landmarks) return 0;
    const wrist = pt(landmarks[LM.WRIST]);
    const [mcp, pip, , tip] = chain.map((index) => pt(landmarks[index]));
    if (!wrist || !mcp || !pip || !tip) return 0;

    const knuckle = Math.max(dist2(pip, wrist), dist2(mcp, wrist));
    if (!(knuckle > EPS)) return 0;

    const reach = dist2(tip, wrist) / knuckle;
    return Math.max(0, Math.min(1, (reach - REACH_CURLED) / (REACH_STRAIGHT - REACH_CURLED)));
}

/**
 * Flatness: mean extension of the four non-thumb fingers, 0..1.
 * A prayer hand is flat; a loose two-hand clasp is not.
 */
/** The four non-thumb fingers, in anatomical order. Adjacency matters for spread. */
export const LONG_FINGERS = Object.freeze(['index', 'middle', 'ring', 'pinky']);

export function handFlatness(landmarks) {
    const values = LONG_FINGERS.map((name) => fingerExtension(landmarks, FINGER_CHAINS[name]));
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const TIPS = Object.freeze({
    thumb: LM.THUMB_TIP,
    index: LM.INDEX_TIP,
    middle: LM.MIDDLE_TIP,
    ring: LM.RING_TIP,
    pinky: LM.PINKY_TIP,
});

/**
 * The full shape of one hand, as a flat bag of image-plane measurements.
 *
 * This is the vocabulary a declarative pose speaks: a pose says which fingers
 * must be extended or curled and what the spread, pinch or orientation must be,
 * and every one of those is a key here. Nothing in it uses z.
 *
 * @returns {object|null}
 *   thumbExtension — 0 curled, 1 straight (chord ÷ chain, fingerExtension)
 *   indexExtension … pinkyExtension — 0 curled, 1 extended (wrist reach, fingerReach)
 *   spread  — SMALLEST adjacent fingertip gap ÷ hand length. The minimum, not
 *             the mean: an outer pair staying wide would otherwise hide two
 *             fingers collapsing together, which is how a "duck" shape passes a
 *             naive open-hand test. (map-gesture-controls makes the same call.)
 *   pinch   — thumb tip ↔ index tip ÷ hand length. 0 is touching.
 *   aspect  — projected palm width ÷ length; low means edge-on to the camera
 *   uprightness — +1 fingers straight up
 */
export function handShape(landmarks) {
    const frame = palmFrame(landmarks);
    if (!frame) return null;

    const shape = {
        aspect: frame.aspect,
        uprightness: -frame.axis.y,
        center: frame.center,
        scale: frame.scale,
    };
    // Long fingers by wrist reach, the thumb by straightness — see fingerReach.
    for (const [name, chain] of Object.entries(FINGER_CHAINS)) {
        shape[`${name}Extension`] = name === 'thumb'
            ? fingerExtension(landmarks, chain)
            : fingerReach(landmarks, chain);
    }

    let spread = Infinity;
    for (let i = 1; i < LONG_FINGERS.length; i++) {
        const a = pt(landmarks[TIPS[LONG_FINGERS[i - 1]]]);
        const b = pt(landmarks[TIPS[LONG_FINGERS[i]]]);
        if (!a || !b) continue;
        spread = Math.min(spread, dist2(a, b) / frame.scale);
    }
    shape.spread = Number.isFinite(spread) ? spread : 0;

    const thumbTip = pt(landmarks[TIPS.thumb]);
    const indexTip = pt(landmarks[TIPS.index]);
    shape.pinch = (thumbTip && indexTip) ? dist2(thumbTip, indexTip) / frame.scale : 1;

    // Where the thumb points, independent of where the rest of the hand does —
    // a thumbs-up and a thumbs-down are the same hand shape rotated, and the
    // fingers give no clue which. +1 straight up, −1 straight down.
    const thumbCmc = pt(landmarks[LM.THUMB_CMC]);
    const thumbAxis = (thumbCmc && thumbTip) ? unit2(thumbCmc, thumbTip) : null;
    shape.thumbUpness = thumbAxis ? -thumbAxis.y : 0;

    return shape;
}

/**
 * Two-hand geometry in hand-relative units.
 *
 * @returns {{separation, normalDot, axisAlignment, uprightness, foreshortening, scale}|null}
 *   separation     — palm-center distance ÷ mean hand scale. ~0.35 palms
 *                    pressed, ~1.0 a hand-width apart. Image-plane, so two
 *                    hands stacked in depth also read as close; MediaPipe's z
 *                    is too unreliable to defend against that, and every other
 *                    criterion still has to agree.
 *   palmOpposition — −1 when the palms face opposite ways (each other, or back
 *                    to back), +1 when they face the same way, and **near 0
 *                    when the image cannot say**. The depth-free stand-in for
 *                    normalDot, read off the thumbs' image-plane positions.
 *                    A truly edge-on palm hides its thumb's sideways offset in
 *                    depth, so the reading weakens toward 0 exactly as the pose
 *                    perfects itself — which is why the recognizer treats this
 *                    as a veto on a clear +1 rather than a demand for −1.
 *                    It also cannot tell facing-each-other from back-to-back.
 *   normalDot      — palm normals dotted. −1 facing each other, +1 stacked the
 *                    same way. The z-dependent one. Check `foreshortening`.
 *   axisAlignment  — finger directions dotted. +1 both point the same way.
 *   uprightness    — mean −axis.y, +1 fingers straight up.
 *   foreshortening — the *less* edge-on hand's aspect, so both palms must be
 *                    turned away from the camera, not just the near one.
 */
export function twoHandGeometry(frameA, frameB) {
    if (!frameA || !frameB) return null;

    const meanScale = (frameA.scale + frameB.scale) / 2;
    if (!(meanScale > EPS)) return null;

    // Saturating product of the two thumb offsets. Well clear of the reference
    // offset it reads ±1; near zero — an ambiguous thumb — it says little
    // rather than asserting a sign it cannot support.
    const THUMB_REF = 0.05;
    const opposition = (frameA.thumbSide * frameB.thumbSide) / (THUMB_REF * THUMB_REF);

    return {
        separation: dist2(frameA.center, frameB.center) / meanScale,
        palmOpposition: Math.max(-1, Math.min(1, opposition)),
        normalDot: dot3(frameA.normal, frameB.normal),
        axisAlignment: frameA.axis.x * frameB.axis.x + frameA.axis.y * frameB.axis.y,
        uprightness: -(frameA.axis.y + frameB.axis.y) / 2,
        foreshortening: Math.max(frameA.aspect, frameB.aspect),
        scale: meanScale,
    };
}

/**
 * The subset of pray evidence one hand can carry on its own.
 *
 * Used only to sustain a pose the two-hand path already vouched for — never to
 * start one. See PrayRecognizer's arming.
 */
export function singleHandGeometry(landmarks) {
    const frame = palmFrame(landmarks);
    if (!frame) return null;
    return {
        flatness: handFlatness(landmarks),
        uprightness: -frame.axis.y,
        foreshortening: frame.aspect,
        center: frame.center,
        scale: frame.scale,
    };
}
