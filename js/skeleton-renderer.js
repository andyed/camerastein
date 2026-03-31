// skeleton-renderer.js — Draws stick figures on a Canvas 2D overlay
// from raw MediaPipe landmark results (Face, Pose, Hands).

const BODY_COLOR = '#4ecdc4';
const FACE_COLOR = '#a78bfa';
const HAND_LEFT_COLOR = '#4ecdc4';
const HAND_RIGHT_COLOR = '#ff6b6b';

// MediaPipe Pose connections (pairs of landmark indices)
const BODY_CONNECTIONS = [
    // Spine
    [0, 11], [0, 12],
    // Shoulders
    [11, 12],
    // Left arm
    [11, 13], [13, 15],
    // Right arm
    [12, 14], [14, 16],
    // Torso
    [11, 23], [12, 24],
    // Hips
    [23, 24],
    // Left leg
    [23, 25], [25, 27],
    // Right leg
    [24, 26], [26, 28],
    // Left foot
    [27, 29], [29, 31],
    // Right foot
    [28, 30], [30, 32],
];

// Face landmark index chains — each drawn as a connected polyline
const FACE_JAWLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const FACE_LEFT_EYE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const FACE_RIGHT_EYE = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382];
const FACE_NOSE = [168, 6, 197, 195, 5];
const FACE_LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

const FACE_CHAINS = [FACE_JAWLINE, FACE_LEFT_EYE, FACE_RIGHT_EYE, FACE_NOSE, FACE_LIPS];

// Hand connections: finger chains + palm cross-connections
const HAND_FINGERS = [
    [0, 1, 2, 3, 4],       // thumb
    [0, 5, 6, 7, 8],       // index
    [0, 9, 10, 11, 12],    // middle
    [0, 13, 14, 15, 16],   // ring
    [0, 17, 18, 19, 20],   // pinky
];
const HAND_PALM = [[5, 9], [9, 13], [13, 17]];

export class SkeletonRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.w = canvas.width;
        this.h = canvas.height;

        // Latest results per channel — null means "nothing received yet"
        this.faceResults = null;
        this.bodyResults = null;
        this.handResults = null;
    }

    updateFace(results) {
        this.faceResults = results;
    }

    updateBody(results) {
        this.bodyResults = results;
    }

    updateHand(results) {
        this.handResults = results;
    }

    // --- Drawing helpers ---

    /** Convert normalized landmark coords to canvas pixels, mirrored for selfie view. */
    _toPixel(landmark) {
        return {
            x: (1 - landmark.x) * this.w,
            y: landmark.y * this.h,
        };
    }

    /** Opacity from visibility (0-1). Landmarks below 0.5 get dimmed proportionally. */
    _visibilityAlpha(v) {
        if (v == null) return 1;
        return Math.max(0.1, Math.min(1, v));
    }

    /** Draw a line between two pixel-space points. */
    _line(ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    /** Draw a filled circle at a pixel-space point. */
    _circle(ctx, p, r) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- Channel renderers ---

    _drawBody() {
        const landmarks = this.bodyResults?.poseLandmarks;
        if (!landmarks || landmarks.length === 0) return;

        const ctx = this.ctx;
        const pts = landmarks.map(lm => this._toPixel(lm));

        // Draw connections
        ctx.lineWidth = 2;
        for (const [i, j] of BODY_CONNECTIONS) {
            if (i >= landmarks.length || j >= landmarks.length) continue;
            const va = landmarks[i].visibility ?? 1;
            const vb = landmarks[j].visibility ?? 1;
            const alpha = this._visibilityAlpha(Math.min(va, vb));
            ctx.strokeStyle = BODY_COLOR;
            ctx.globalAlpha = alpha;
            this._line(ctx, pts[i], pts[j]);
        }

        // Draw joint circles
        for (let i = 0; i < landmarks.length; i++) {
            const alpha = this._visibilityAlpha(landmarks[i].visibility ?? 1);
            ctx.fillStyle = BODY_COLOR;
            ctx.globalAlpha = alpha;
            this._circle(ctx, pts[i], 3);
        }

        ctx.globalAlpha = 1;
    }

    _drawFace() {
        const faces = this.faceResults?.multiFaceLandmarks;
        if (!faces || faces.length === 0) return;
        const landmarks = faces[0];
        if (!landmarks || landmarks.length === 0) return;

        const ctx = this.ctx;
        const pts = landmarks.map(lm => this._toPixel(lm));

        ctx.strokeStyle = FACE_COLOR;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;

        for (const chain of FACE_CHAINS) {
            ctx.beginPath();
            for (let k = 0; k < chain.length; k++) {
                const idx = chain[k];
                if (idx >= pts.length) continue;
                const p = pts[idx];
                if (k === 0) {
                    ctx.moveTo(p.x, p.y);
                } else {
                    ctx.lineTo(p.x, p.y);
                }
            }
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
    }

    _drawHands() {
        const hands = this.handResults?.multiHandLandmarks;
        if (!hands || hands.length === 0) return;

        const classifications = this.handResults?.multiHandedness;
        const ctx = this.ctx;

        for (let h = 0; h < hands.length; h++) {
            const landmarks = hands[h];
            if (!landmarks || landmarks.length === 0) continue;

            // Determine handedness — MediaPipe labels are from the camera's
            // perspective, so "Left" in results is the user's right hand
            // after mirroring. We use the raw label to pick color:
            // "Left" (camera) → user's right → red, "Right" → user's left → teal.
            let label = 'Left';
            if (classifications && classifications[h]) {
                label = classifications[h].label ?? 'Left';
            }
            const color = label === 'Right' ? HAND_LEFT_COLOR : HAND_RIGHT_COLOR;

            const pts = landmarks.map(lm => this._toPixel(lm));

            // Draw finger chains
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 1;

            for (const chain of HAND_FINGERS) {
                ctx.beginPath();
                for (let k = 0; k < chain.length; k++) {
                    const idx = chain[k];
                    if (idx >= pts.length) continue;
                    const p = pts[idx];
                    if (k === 0) {
                        ctx.moveTo(p.x, p.y);
                    } else {
                        ctx.lineTo(p.x, p.y);
                    }
                }
                ctx.stroke();
            }

            // Draw palm cross-connections
            for (const [i, j] of HAND_PALM) {
                if (i >= pts.length || j >= pts.length) continue;
                this._line(ctx, pts[i], pts[j]);
            }

            // Draw joint circles
            ctx.fillStyle = color;
            for (let k = 0; k < pts.length; k++) {
                this._circle(ctx, pts[k], 2);
            }
        }

        ctx.globalAlpha = 1;
    }

    // --- Main draw loop entry ---

    draw() {
        // Refresh dimensions in case canvas was resized
        this.w = this.canvas.width;
        this.h = this.canvas.height;

        this.ctx.clearRect(0, 0, this.w, this.h);

        this._drawBody();
        this._drawFace();
        this._drawHands();
    }
}
