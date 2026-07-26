/**
 * Face Feature Channel — provider-neutral semantic face features over the raw
 * blendshape/landmark channels. docs/FACE_FEATURE_CONTRACT.md is the schema;
 * docs/AE_FACE_FEATURES_AUDIT.md is the wiring/ownership story.
 *
 * WHY THIS EXISTS
 * face-shim.js emits 52 ARKit-named blendshape weights on MotionBus
 * ('faceBlendshapes') — and, as of the 2026-07-18 audit, NOTHING consumes them.
 * Every downstream face signal (smileValence, wink, gaze, lean) is re-derived
 * from raw landmark geometry in provider-specific code. This module is the one
 * place that turns provider output into a small, named, normalized feature set
 * (valence, jawOpen, browRaise, gazeX/Y, proximity, …) so AE and Self-mode
 * consumers read semantics, not landmark indices — and so a native iOS ARKit
 * provider can slot in by emitting the same canonical frame.
 *
 * PIPELINE
 *   face-shim.js emit('faceBlendshapes')/emit('faceLandmarks')
 *     → frameFromMediaPipe() (canonical frame, provider-tagged)
 *     → FaceFeatureExtractor.update() (pure, deterministic, testable)
 *     → MotionBus emit('faceFeatures') + window.FaceFeatures read surface
 *
 * AUTHORITY CONTRACT (AE must not fight Self mode)
 * `features.authority` is a 0..1 scalar: how strongly the user is CURRENTLY
 * expressing deliberately (smile/frown deviation from their own neutral, jaw,
 * brow, purse). AE consumers must treat authority > ~0.35 as "the human has
 * the pen" — amplify or answer, never stochastically overwrite.
 *
 * FLAG: window.__faceFeatureChannel === true (experiment, default OFF —
 * registry entry in the audit doc's wiring patch). Subscriptions are wired at
 * init but the handler is a cheap early-return while the flag is off, matching
 * the face-mesh-relief `!== true` compute-time gate so it can be flipped live.
 *
 * No raw identity data leaves this module: inputs are transient geometry and
 * expression weights; outputs are normalized scalars. Nothing is persisted or
 * sent anywhere.
 */

export const CONTRACT_VERSION = 1;

// ---- defensive numeric helpers (house style: isFinite guards everywhere) ----
const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;
const clamp = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);
const clamp01 = (x) => clamp(x, 0, 1);
const clamp11 = (x) => clamp(x, -1, 1);
// exponential-smoothing coefficient for time-constant tau (seconds)
const emaK = (dt, tau) => (tau > 0) ? (1 - Math.exp(-dt / tau)) : 1;

/**
 * Landmark indices shared with HeadBobDetector (head-bob-detector.js:35) so the
 * pose numbers here agree with the rhythm channel's headYaw/Pitch/Roll family.
 */
const LM = {
    NOSE_TIP: 1,
    FOREHEAD: 10,
    CHIN: 152,
    LEFT_EAR: 234,
    RIGHT_EAR: 454,
    MOUTH_UPPER: 13,
    MOUTH_LOWER: 14,
    MOUTH_LEFT: 61,
    MOUTH_RIGHT: 291,
};

/**
 * Per-face canonical-frame core, shared by the single-face compat builder and
 * the multi-face builder. `shapesLike` is one face's Classifications object
 * ({categories:[{categoryName,score}]}) or a bare array; `lms` is one face's
 * landmark array. `faceCount` is the frame-wide face total (every per-face
 * frame reports the same count); pass null to fall back to geomOk ? 1 : 0
 * (the legacy single-face behavior).
 */
function _canonFromParts(shapesLike, lms, provider, t, faceCount) {
    // Blendshapes: Tasks Vision hands back a Classifications object whose
    // .categories is [{categoryName, score}]; accept a bare array defensively.
    const blendshapes = {};
    const cats = shapesLike?.categories || (Array.isArray(shapesLike) ? shapesLike : null);
    let bsCount = 0;
    if (Array.isArray(cats)) {
        for (const c of cats) {
            if (c && typeof c.categoryName === 'string') {
                blendshapes[c.categoryName] = clamp01(num(c.score));
                bsCount++;
            }
        }
    }

    // Pose + scale from raw geometry, same construction as HeadBobDetector
    // (_updateHeadOrientation, head-bob-detector.js:655) with its DEFAULT gains
    // (yaw 2.2 / pitch 1.0 / roll 1.0) so both channels tell one story about
    // where the head points. Missing/NaN landmarks → pose stays null-safe zero.
    let yaw = 0, pitch = 0, roll = 0, faceScale = 0, geomOk = false, valenceGeom = 0;
    let cx = 0, cy = 0;   // nose-tip centroid — identity anchor for FaceTrackSet
    if (Array.isArray(lms) && lms.length > LM.RIGHT_EAR) {
        const nose = lms[LM.NOSE_TIP], le = lms[LM.LEFT_EAR], re = lms[LM.RIGHT_EAR];
        const fh = lms[LM.FOREHEAD], chin = lms[LM.CHIN];
        const finitePt = (p) => p && isFinite(p.x) && isFinite(p.y);
        if (finitePt(nose) && finitePt(le) && finitePt(re) && finitePt(fh) && finitePt(chin)) {
            const earDx = re.x - le.x, earDy = re.y - le.y;
            const earSpan = Math.hypot(earDx, earDy);
            if (earSpan > 1e-6) {
                roll = clamp11((Math.atan2(earDy, earDx) / (Math.PI / 4)));
                const midX = (le.x + re.x) / 2;
                yaw = clamp11(((nose.x - midX) / earSpan) * 2.2);
                const denomY = Math.abs(chin.y - fh.y) || 1e-6;
                pitch = clamp11((((nose.y - fh.y) / denomY) - 0.5) * 2);
                faceScale = clamp01(earSpan); // normalized image coords → 0..1
                cx = clamp01(num(nose.x));    // same anchor as the detector's
                cy = clamp01(num(nose.y));    // _findOrCreateFaceState matching
                geomOk = true;
            }

            // Corner-vs-midline valence, same construction and ×8 scaling as the
            // shipped mouth-tracking detector. It exists because the mouthFrown
            // BLENDSHAPE is the weak half of the smile/frown pair: a frown that
            // this geometry reads clearly can leave mouthFrown near zero, which
            // is why the blendshape-only valence could not fire a frown episode
            // while the legacy geometry detector could. Positive = corners above
            // the lip midline = smile. Null-safe: missing points leave it 0.
            const upper = lms[LM.MOUTH_UPPER], lower = lms[LM.MOUTH_LOWER];
            const cornerL = lms[LM.MOUTH_LEFT], cornerR = lms[LM.MOUTH_RIGHT];
            if (finitePt(upper) && finitePt(lower) && finitePt(cornerL)
                && finitePt(cornerR) && finitePt(nose) && finitePt(chin)) {
                const lipMidY = (upper.y + lower.y) / 2;
                const avgCornerY = (cornerL.y + cornerR.y) / 2;
                const faceHeight = Math.abs(chin.y - nose.y) || 0.1;
                valenceGeom = clamp11(((lipMidY - avgCornerY) / faceHeight) * 8);
            }
        }
    }

    // Availability confidence, not a model score (Tasks Vision exposes none on
    // this path): geometry + expressions = 1.0, one of the two = 0.6, none = 0.
    const confidence = (geomOk && bsCount > 0) ? 1.0 : ((geomOk || bsCount > 0) ? 0.6 : 0);

    return {
        provider,
        t: num(t),
        confidence,
        blendshapes,
        bsCount,   // how many blendshape weights actually arrived (0 = geometry-only frame)
        yaw, pitch, roll,
        faceScale,
        valenceGeom,   // additive (contract §7): corner-geometry valence, 0 when landmarks absent
        cx, cy,    // additive (contract §7): normalized nose-tip centroid, 0/0 when geometry absent
        faceCount: (faceCount == null) ? (geomOk ? 1 : 0) : Math.max(0, Math.floor(num(faceCount))),
    };
}

/**
 * Build a canonical provider-neutral frame from the two MotionBus messages the
 * MediaPipe face shim emits per processed frame (face-shim.js:42 blendshapes,
 * face-shim.js:53 landmarks). Either input may be null/missing — confidence
 * reflects what actually arrived, so the extractor's gates do the right thing.
 * Single-face (primary) view; multi-face consumers use framesFromMediaPipe.
 *
 * @param {Object|null} bsMsg  MotionBus 'faceBlendshapes' payload ({shapes, t})
 * @param {Object|null} lmMsg  MotionBus 'faceLandmarks' payload ({landmarks, t})
 * @returns {Object} canonical frame (see docs/FACE_FEATURE_CONTRACT.md §3)
 */
export function frameFromMediaPipe(bsMsg, lmMsg) {
    const fc = Array.isArray(lmMsg?.allFaces) ? lmMsg.allFaces.length : null;
    return _canonFromParts(bsMsg?.shapes, lmMsg?.landmarks,
        (lmMsg?.source || 'mediapipe-tasks'), num(lmMsg?.t ?? bsMsg?.t), fc);
}

/**
 * Multi-face builder: one canonical frame per face in the shim's allFaces[]
 * arrays. MediaPipe aligns faceBlendshapes[i] with faceLandmarks[i], so index
 * pairing is the contract. Falls back to the primary fields for legacy
 * emitters that never populate allFaces ('mediapipe-legacy'). Order is the
 * provider's detection order — identity/stability is FaceTrackSet's job.
 *
 * @returns {Object[]} canonical frames (possibly empty; never null)
 */
export function framesFromMediaPipe(bsMsg, lmMsg) {
    if (!lmMsg) return [];
    const all = (Array.isArray(lmMsg.allFaces) && lmMsg.allFaces.length)
        ? lmMsg.allFaces
        : (Array.isArray(lmMsg.landmarks) ? [lmMsg.landmarks] : []);
    if (!all.length) return [];
    const bsAll = Array.isArray(bsMsg?.allFaces) ? bsMsg.allFaces
        : (bsMsg?.shapes ? [bsMsg.shapes] : []);
    const provider = lmMsg.source || 'mediapipe-tasks';
    const t = num(lmMsg.t ?? bsMsg?.t);
    const frames = [];
    for (let i = 0; i < all.length && i < 8; i++) {   // 8 = sanity cap ahead of maxFaces
        frames.push(_canonFromParts(bsAll[i], all[i], provider, t, all.length));
    }
    return frames;
}

/**
 * Stable face identity over per-frame detection output. MediaPipe face indices
 * are detection-order and can swap between frames; a per-person feature stream
 * (baselines are PERSONAL — one face's neutral must never calibrate another)
 * needs ids that survive the swap. Same principle as HeadBobDetector's
 * _findOrCreateFaceState (nose-centroid matching, monotonic ids, seconds-scale
 * identity timeout) — implemented here so the portable channel stays
 * self-contained for Camerastein and the future ARKit provider (which is
 * single-face and degrades to one track by construction).
 *
 * Pure and clock-explicit (assign takes t) — testable like the extractor.
 */
export class FaceTrackSet {
    constructor(opts = {}) {
        this.opts = {
            maxFaces: 4,          // matches detector numFaces / HeadExtrude MAXFACES
            matchDist: 0.12,      // normalized-image centroid gate (faces sit farther apart)
            releaseMs: 3000,      // identity timeout (mirrors detector faceTimeout)
            primaryBoost: 1.15,   // challenger must be 15% larger to steal primary (anti-flap)
        };
        for (const k in opts) if (k in this.opts) this.opts[k] = num(opts[k]) || this.opts[k];
        this._tracks = [];        // {id, cx, cy, faceScale, lastSeen}
        this._nextId = 1;
        this._primaryId = null;
    }

    /**
     * Match this frame's canonical faces to persistent ids. Returns
     * [{id, frame}] with the PRIMARY face at index 0, remainder largest-first.
     * Untrackable frames (no geometry → no centroid) are excluded — callers
     * fall back to their single-face path.
     */
    assign(frames, t) {
        const now = num(t);
        const o = this.opts;
        // Largest-first so greedy matching favors the dominant face, and the
        // maxFaces cap drops the smallest (farthest) faces, matching the
        // rhythm.faces "largest (closest) first" convention.
        const inc = (Array.isArray(frames) ? frames : [])
            .filter(f => f && f.faceScale > 0)
            .sort((a, b) => b.faceScale - a.faceScale)
            .slice(0, o.maxFaces);
        const claimed = new Set();
        const out = [];
        for (const f of inc) {
            let best = null, bd = o.matchDist;
            for (const tr of this._tracks) {
                if (claimed.has(tr.id)) continue;
                const d = Math.hypot(f.cx - tr.cx, f.cy - tr.cy);
                if (d < bd) { bd = d; best = tr; }
            }
            if (!best) {
                best = { id: this._nextId++, cx: f.cx, cy: f.cy, faceScale: f.faceScale, lastSeen: now };
                this._tracks.push(best);
            }
            claimed.add(best.id);
            best.cx = f.cx; best.cy = f.cy; best.faceScale = f.faceScale; best.lastSeen = now;
            out.push({ id: best.id, frame: f });
        }
        // Identity timeout — a pruned person who returns is a NEW person (fresh
        // baselines), exactly the resetCalibration semantic.
        this._tracks = this._tracks.filter(tr => !(now - tr.lastSeen > o.releaseMs));
        // Primary with hysteresis: the current primary keeps the seat unless it
        // vanished or a challenger is decisively larger — expression consumers
        // must not flap between two near-equal faces.
        const cur = out.find(x => x.id === this._primaryId) || null;
        let primary = out[0] || null;                     // out is largest-first
        if (cur && primary && primary.id !== cur.id
            && !(primary.frame.faceScale > cur.frame.faceScale * o.primaryBoost)) {
            primary = cur;
        }
        this._primaryId = primary ? primary.id : null;
        if (primary && out[0] !== primary) {
            out.splice(out.indexOf(primary), 1);
            out.unshift(primary);
        }
        return out;
    }

    liveIds() { return this._tracks.map(tr => tr.id); }
    get primaryId() { return this._primaryId; }
}

/**
 * Pure semantic-feature extractor. Deterministic: state advances only via
 * update(frame) using the frame's own timestamp, so tests drive it with
 * synthetic frames and explicit clocks (same discipline as AEModBus.update).
 */
export class FaceFeatureExtractor {
    constructor(opts = {}) {
        this.opts = {
            staleMs: 400,          // read(): features older than this are released (no zombie faces)
            minConfidence: 0.35,   // frames below this are treated as "no face"
            warmupFrames: 12,      // ~0.5s at 24fps before baselines are trusted
            baselineTau: 25,       // s — personal-neutral drift (mirrors _valenceBaseline's ~25s τ)
            velTau: 0.15,          // s — velocity smoothing (fast enough for onsets, kills jitter)
            onsetVel: 1.2,         // units/s a feature must move to count as a deliberate onset
            authorityFloor: 0.15,  // expression intensity below this never claims authority
        };
        for (const k in opts) if (k in this.opts) this.opts[k] = num(opts[k]) || this.opts[k];
        this.reset();
    }

    reset() {
        this.features = null;      // last computed feature frame (or null)
        this._lastT = -Infinity;
        this._warmN = 0;
        // Calibration state: personal neutral valence + resting face scale.
        this._baseValence = null;
        this._baseScale = null;
        // Dynamics state
        this._prev = null;         // previous scalar snapshot for first derivatives
        this._vel = {
            valence: 0,
            jawOpen: 0,
            browRaiseL: 0,
            browRaiseR: 0,
            gazeX: 0,
            yaw: 0,
            pitch: 0,
            proximity: 0,
        };
        this._holdSince = { smile: 0, jawOpen: 0 };
        return this;
    }

    /** Drop learned baselines (e.g. new person sat down). Features keep flowing. */
    resetCalibration() {
        this._baseValence = null;
        this._baseScale = null;
        this._warmN = 0;
        return this;
    }

    get calibrated() {
        return this._baseValence !== null && this._baseScale !== null;
    }

    /**
     * Ingest one canonical frame. Returns the feature frame (also kept on
     * this.features), or an "absent" frame when confidence gates fail.
     */
    update(frame) {
        const f = frame || {};
        const t = num(f.t);
        const conf = clamp01(num(f.confidence));

        // Confidence gate: below the floor we report absence rather than noise.
        // Baselines and dynamics freeze (not reset) so a 2-frame tracking blip
        // doesn't cost the user their calibration.
        if (conf < this.opts.minConfidence) {
            this.features = this._absentFrame(f, t, conf);
            return this.features;
        }

        const bs = f.blendshapes || {};
        const g = (name) => clamp01(num(bs[name]));
        // Expression availability: a geometry-only frame (e.g. the legacy
        // 'mediapipe-legacy' emitter — landmarks, no blendshapes) reads every
        // g() as 0, which is indistinguishable from wide-open eyes + neutral
        // face. hasExpressions lets unified-read consumers (audit opportunity
        // #5) fall back to landmark geometry instead of flatlining. Additive
        // field — contract §7, no version bump.
        const bsCount = isFinite(f.bsCount) ? f.bsCount : Object.keys(bs).length;
        const hasExpressions = bsCount > 0 ? 1 : 0;

        // dt from frame timestamps; clamp survives stalls and first-frame gaps
        const dtMs = (this._lastT > -Infinity) ? (t - this._lastT) : 33;
        const dt = clamp(dtMs / 1000, 0.001, 0.25);
        this._lastT = t;
        this._warmN++;

        // ---- expression family (ARKit blendshape names — MediaPipe + ARKit share them) ----
        const blinkL = g('eyeBlinkLeft');
        const blinkR = g('eyeBlinkRight');
        const jawOpen = g('jawOpen');
        const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
        const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
        // Asymmetric fusion, NEGATIVE HALF ONLY. mouthSmile is a strong, well
        // behaved blendshape; mouthFrown is not, and a frown the corner geometry
        // reads clearly can leave the blendshape pair near zero — which is why a
        // frown episode could never enter while the shipped geometry detector
        // (head-bob-detector-mouth-tracking.js) fired on the same face. Take the
        // stronger frown evidence of the two, and leave the smile half untouched
        // so positive-valence behavior is bit-identical. Geometry absent → 0 →
        // no-op, so blendshape-only providers degrade to the previous behavior.
        let valenceRaw = clamp11(smile - frown);
        const vGeom = clamp11(num(f.valenceGeom));
        if (vGeom < 0 && vGeom < valenceRaw) valenceRaw = vGeom;
        const mouthWidth = clamp01((g('mouthStretchLeft') + g('mouthStretchRight')) / 2);
        const lipPurse = Math.max(g('mouthPucker'), g('mouthFunnel'));
        const browRaiseL = clamp01((g('browInnerUp') + g('browOuterUpLeft')) / 2);
        const browRaiseR = clamp01((g('browInnerUp') + g('browOuterUpRight')) / 2);
        const browAsym = clamp11(browRaiseL - browRaiseR);

        // ---- calibration: personal neutral (resting faces read slightly frowny —
        // the smileValence lesson, head-bob-detector-mouth-tracking.js:143) ----
        if (this._baseValence === null) {
            if (this._warmN >= this.opts.warmupFrames) this._baseValence = valenceRaw;
        } else {
            this._baseValence += (valenceRaw - this._baseValence) * emaK(dt, this.opts.baselineTau);
            this._baseValence = clamp(this._baseValence, -0.5, 0.5);
        }
        const valence = clamp11(valenceRaw - (this._baseValence ?? valenceRaw));

        // ---- pose/depth family ----
        const yaw = clamp11(num(f.yaw));
        const pitch = clamp11(num(f.pitch));
        const roll = clamp11(num(f.roll));
        const faceScale = clamp01(num(f.faceScale));
        if (this._baseScale === null) {
            if (this._warmN >= this.opts.warmupFrames && faceScale > 0) this._baseScale = faceScale;
        } else if (faceScale > 0) {
            // slow drift only — proximity is DEVIATION from resting distance
            this._baseScale += (faceScale - this._baseScale) * emaK(dt, this.opts.baselineTau * 2);
        }
        // proximity: -1 leaned back … +1 leaned in (same ×5 mapping as the
        // rhythm channel's leanAmount, head-bob-detector.js:507)
        const proximity = (this._baseScale && this._baseScale > 1e-6)
            ? clamp11(((faceScale / this._baseScale) - 1) * 5) : 0;

        // ---- attention family: gaze from the eye-look blendshapes.
        // Anatomical L/R: subject-looking-their-right = eyeLookInLeft + eyeLookOutRight.
        // +x = subject's right, +y = up. Provider-neutral (ARKit has the same names).
        const gazeX = clamp11(((g('eyeLookInLeft') + g('eyeLookOutRight'))
            - (g('eyeLookOutLeft') + g('eyeLookInRight'))) / 2);
        const gazeY = clamp11(((g('eyeLookUpLeft') + g('eyeLookUpRight'))
            - (g('eyeLookDownLeft') + g('eyeLookDownRight'))) / 2);
        const eyeOpenness = clamp01(1 - (blinkL + blinkR) / 2);

        // ---- dynamics family: smoothed first derivatives + hold + onset ----
        const p = this._prev || {
            valence, jawOpen, browRaiseL, browRaiseR,
            gazeX, yaw, pitch, proximity,
        };
        const velRaw = {
            valence: (valence - p.valence) / dt,
            jawOpen: (jawOpen - p.jawOpen) / dt,
            browRaiseL: (browRaiseL - p.browRaiseL) / dt,
            browRaiseR: (browRaiseR - p.browRaiseR) / dt,
            gazeX: (gazeX - p.gazeX) / dt,
            yaw: (yaw - p.yaw) / dt,
            pitch: (pitch - p.pitch) / dt,
            proximity: (proximity - p.proximity) / dt,
        };
        const kv = emaK(dt, this.opts.velTau);
        for (const k in this._vel) this._vel[k] += (num(velRaw[k]) - this._vel[k]) * kv;
        this._prev = {
            valence, jawOpen, browRaiseL, browRaiseR,
            gazeX, yaw, pitch, proximity,
        };

        // hold: how long the expression has been continuously sustained
        if (valence > 0.25) { if (!this._holdSince.smile) this._holdSince.smile = t; }
        else this._holdSince.smile = 0;
        if (jawOpen > 0.35) { if (!this._holdSince.jawOpen) this._holdSince.jawOpen = t; }
        else this._holdSince.jawOpen = 0;
        const smileHoldMs = this._holdSince.smile ? Math.max(0, t - this._holdSince.smile) : 0;
        const jawHoldMs = this._holdSince.jawOpen ? Math.max(0, t - this._holdSince.jawOpen) : 0;

        // onset: the feature is moving fast AND has arrived somewhere meaningful —
        // a deliberate gesture edge, not drift
        const onset = {
            smile: (this._vel.valence > this.opts.onsetVel && valence > 0.25),
            jawOpen: (this._vel.jawOpen > this.opts.onsetVel && jawOpen > 0.35),
        };

        // ---- authority: is the user actively expressing? (AE must yield) ----
        // Max of the deliberate-expression intensities, floored so resting-face
        // noise never claims the pen, scaled by confidence so a half-seen face
        // can't lock AE out.
        const rawAuthority = Math.max(
            Math.abs(valence), jawOpen, browRaiseL, browRaiseR, lipPurse);
        const authority = (rawAuthority > this.opts.authorityFloor)
            ? clamp01(rawAuthority * conf) : 0;

        this.features = {
            v: CONTRACT_VERSION,
            provider: (typeof f.provider === 'string') ? f.provider : 'unknown',
            t,
            quality: {
                confidence: conf,
                facePresent: 1,
                hasExpressions,
                faceCount: Math.max(1, Math.floor(num(f.faceCount)) || 1),
                calibrated: this.calibrated,
            },
            expression: {
                blinkL, blinkR, blink: Math.min(blinkL, blinkR),
                jawOpen, valence, valenceRaw, mouthWidth, lipPurse,
                browRaiseL, browRaiseR, browAsym,
            },
            attention: { gazeX, gazeY, eyeOpenness },
            pose: { yaw, pitch, roll, proximity, faceScale },
            dynamics: {
                valenceVel: num(this._vel.valence),
                jawVel: num(this._vel.jawOpen),
                browLVel: num(this._vel.browRaiseL),
                browRVel: num(this._vel.browRaiseR),
                gazeXVel: num(this._vel.gazeX),
                yawVel: num(this._vel.yaw),
                pitchVel: num(this._vel.pitch),
                proximityVel: num(this._vel.proximity),
                smileHoldMs, jawHoldMs, onset,
            },
            authority,
        };
        return this.features;
    }

    /** Feature frame reporting "no face", preserving provider/time for tracing. */
    _absentFrame(f, t, conf) {
        return {
            v: CONTRACT_VERSION,
            provider: (typeof f.provider === 'string') ? f.provider : 'unknown',
            t,
            quality: { confidence: conf, facePresent: 0, hasExpressions: 0, faceCount: 0, calibrated: this.calibrated },
            expression: {
                blinkL: 0, blinkR: 0, blink: 0, jawOpen: 0, valence: 0, valenceRaw: 0,
                mouthWidth: 0, lipPurse: 0, browRaiseL: 0, browRaiseR: 0, browAsym: 0,
            },
            attention: { gazeX: 0, gazeY: 0, eyeOpenness: 0 },
            pose: { yaw: 0, pitch: 0, roll: 0, proximity: 0, faceScale: 0 },
            dynamics: {
                valenceVel: 0, jawVel: 0, browLVel: 0, browRVel: 0,
                gazeXVel: 0, yawVel: 0, pitchVel: 0, proximityVel: 0,
                smileHoldMs: 0, jawHoldMs: 0, onset: { smile: false, jawOpen: false },
            },
            authority: 0,
        };
    }

    /**
     * Read with stale-frame release: past staleMs the features are gone, not
     * "the last face we ever saw" (the zombie-payload lesson, motion-bus.js:51).
     * @param {number} nowMs - caller clock (performance.now() in production)
     */
    read(nowMs) {
        const now = num(nowMs);
        if (!this.features || !isFinite(this.features.t)) {
            return { fresh: false, ageMs: Infinity, features: null };
        }
        const ageMs = now - this.features.t;
        if (!(ageMs >= 0) || ageMs > this.opts.staleMs) {
            return { fresh: false, ageMs: num(ageMs), features: null };
        }
        return { fresh: true, ageMs, features: this.features };
    }
}

/**
 * Wire the channel onto MotionBus + publish the window.FaceFeatures read
 * surface. Idempotent. Compute is gated per-frame on
 * `window.__faceFeatureChannel === true` so the flag flips live.
 *
 * @returns {Object|null} the handle (also window.FaceFeatures), or null if no bus
 */
export function initFaceFeatureChannel() {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.FaceFeatures && w.FaceFeatures._wired) return w.FaceFeatures;

    // Register the state keys so consumers can do MotionBus.state.faceFeatures
    // and MotionBus.isLive('faceFeatures') like every other channel.
    // 'faceFeatures'    = the PRIMARY face's feature frame (single-face compat).
    // 'faceFeaturesAll' = {v, t, faceCount, primaryId, faces[]} — one feature
    //                     frame per tracked person, primary first then largest-
    //                     first. A separate channel (not a faces[] field on the
    //                     primary frame) because the primary IS faces[0]: nesting
    //                     would make the frame contain itself and break every
    //                     naive tree-walker (JSON export, finiteness sweeps).
    if (bus._channels && !bus._channels.faceFeatures) {
        bus._channels.faceFeatures = 'faceFeatures';
        bus.state.faceFeatures = null;
    }
    if (bus._channels && !bus._channels.faceFeaturesAll) {
        bus._channels.faceFeaturesAll = 'faceFeaturesAll';
        bus.state.faceFeaturesAll = null;
    }

    // Per-person extractors keyed by FaceTrackSet id — baselines are PERSONAL
    // (one face's neutral must never calibrate another), so identity churn in
    // the provider's detection order must not leak across extractor state.
    const STALE_MS = 400;                    // matches FaceFeatureExtractor staleMs default
    const tracker = new FaceTrackSet();
    const extractors = new Map();            // track id -> FaceFeatureExtractor
    let lastBs = null;       // latest blendshape message (arrives just before landmarks)
    let lastAll = null;      // last multi-face emission (readAll surface)
    let wasEmitting = false; // so a flag flip OFF clears the channels exactly once

    const flagOn = () => w.__faceFeatureChannel === true;
    const clearChannels = () => {
        if (!wasEmitting) return;
        wasEmitting = false;
        lastAll = null;
        bus.emit('faceFeatures', null);
        bus.emit('faceFeaturesAll', null);
    };

    bus.subscribe?.('faceBlendshapes', (msg) => { lastBs = msg || null; });

    // Landmarks arrive last per processed frame (face-shim.js:53) and are the
    // channel's liveness signal (null on face loss) — so they drive the compute.
    bus.subscribe?.('faceLandmarks', (msg) => {
        if (!flagOn()) { clearChannels(); return; }
        if (!msg) { lastBs = null; clearChannels(); return; }

        const frames = framesFromMediaPipe(lastBs, msg);
        const t = num(msg.t ?? lastBs?.t);
        let assigned = tracker.assign(frames, t);
        // Degenerate geometry (no centroid → untrackable) still reports through
        // the legacy single-face path under reserved id 0, so the extractor's
        // own confidence gates stay the arbiter of absence — not the tracker.
        if (!assigned.length && frames.length) assigned = [{ id: 0, frame: frames[0] }];

        // Drop extractors for identities the tracker aged out (a person who
        // left and returns after releaseMs is a NEW person — fresh baselines).
        const live = new Set(tracker.liveIds());
        live.add(0);
        for (const id of extractors.keys()) if (!live.has(id)) extractors.delete(id);

        const faces = assigned.map(({ id, frame }) => {
            let ex = extractors.get(id);
            if (!ex) { ex = new FaceFeatureExtractor(); extractors.set(id, ex); }
            const feats = ex.update(frame);
            feats.faceId = id;               // additive (contract §7): stable person id
            return feats;
        });
        const primary = faces[0] || null;
        wasEmitting = true;
        lastAll = {
            v: CONTRACT_VERSION,
            t,
            faceCount: faces.length,
            primaryId: primary ? primary.faceId : null,
            faces,
        };
        bus.emit('faceFeatures', primary);
        bus.emit('faceFeaturesAll', lastAll);
    });

    // Freshness-guarded reads off the last emission (the per-face extractors
    // rotate with the primary seat, so the emission — not any one extractor —
    // is the stable read surface).
    const readPrimary = (nowMs) => {
        if (!lastAll || !isFinite(lastAll.t)) return { fresh: false, ageMs: Infinity, features: null };
        const ageMs = num(nowMs) - lastAll.t;
        if (!(ageMs >= 0) || ageMs > STALE_MS) return { fresh: false, ageMs: num(ageMs), features: null };
        return { fresh: true, ageMs, features: lastAll.faces[0] || null };
    };

    w.FaceFeatures = {
        _wired: true,
        contractVersion: CONTRACT_VERSION,
        /** Primary track's extractor (legacy surface; rotates with the primary seat). */
        get extractor() {
            return extractors.get(tracker.primaryId ?? 0) || extractors.values().next().value || null;
        },
        /** Freshness-guarded PRIMARY-face read; consumers should prefer this over bus state. */
        read() { return readPrimary(performance.now()); },
        /**
         * Freshness-guarded multi-face read: {fresh, ageMs, faceCount, primaryId,
         * faces[]} — faces[] is primary-first then largest-first, each frame
         * carrying its stable faceId. Empty faces[] when stale/absent.
         */
        readAll() {
            const now = performance.now();
            if (!lastAll || !isFinite(lastAll.t)) {
                return { fresh: false, ageMs: Infinity, faceCount: 0, primaryId: null, faces: [] };
            }
            const ageMs = now - lastAll.t;
            if (!(ageMs >= 0) || ageMs > STALE_MS) {
                return { fresh: false, ageMs: num(ageMs), faceCount: 0, primaryId: null, faces: [] };
            }
            return { fresh: true, ageMs, faceCount: lastAll.faceCount, primaryId: lastAll.primaryId, faces: lastAll.faces };
        },
        /** New person / new session: drop personal baselines (all tracked people). */
        resetCalibration() { for (const ex of extractors.values()) ex.resetCalibration(); },
        /** Console-friendly one-liner (modStatus pattern, ae-mod-bus.js:324). */
        status() {
            const r = readPrimary(performance.now());
            const s = {
                flag: flagOn(),
                fresh: r.fresh,
                ageMs: Math.round(num(r.ageMs)),
                faceCount: lastAll ? lastAll.faceCount : 0,
                primaryId: lastAll ? lastAll.primaryId : null,
                calibrated: !!(r.features && r.features.quality.calibrated),
                authority: r.features ? +r.features.authority.toFixed(3) : 0,
                valence: r.features ? +r.features.expression.valence.toFixed(3) : 0,
                provider: r.features?.provider || null,
            };
            try { console.log('🙂 FaceFeatures', s); } catch (_) { }
            return s;
        },
    };
    return w.FaceFeatures;
}
