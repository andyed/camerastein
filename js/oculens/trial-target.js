/**
 * TrialTarget — guided ocular elicitation trials for Oculens.
 *
 * Five trial kinds (REST, CONVERGENCE, SACCADE, PURSUIT, BLINK), each with:
 *   - a pure trajectory function pos(t_seconds) -> {x, y, z}
 *     where x, y are normalized viewport coords in [-1, +1] (origin = center)
 *     and z is in [0, 1] (zoom toward viewer; only meaningful for convergence)
 *   - a full-viewport overlay rendered into a host element
 *   - a 3-2-1-GO countdown in apparatus brand (amber tabular monospace)
 *   - per-frame rAF loop that emits {kind, t, x, y, z, frame} on
 *     window.MotionBus channel 'oculensTarget' so downstream feature
 *     extractors can correlate eye position with stimulus position
 *
 * No external deps. Brand palette inlined to keep the module self-contained.
 *
 * Brand source-of-truth: ocular-brand/apparatus.py
 *   --near-black:  #080406
 *   --amber:       #ffb347   (countdown numerals, 8.7:1 on near-black)
 *   --spice-cyan:  #5fe6ff   (target only)
 */

// ---------- Brand constants (mirror apparatus.py) ----------
const NEAR_BLACK  = '#080406';
const AMBER       = '#ffb347';
const AMBER_BRIGHT= '#ffd089';
const SPICE_CYAN  = '#5fe6ff';
const SPICE_BLUE  = '#3a78ff';

// ---------- Defaults per trial kind ----------
const DEFAULTS = {
    rest:        { duration_s: 30, repetitions: 1 },
    convergence: { duration_s: 30, repetitions: 5 },   // 5 reps × 5s + ~5s tail
    saccade:     { duration_s: 18, repetitions: 10 },  // initial fixation + 10 jumps
    pursuit:     { duration_s: 12, repetitions: 1 },   // 1s lead-in + 10s + 1s lead-out
    blink:       { duration_s: 30, repetitions: 1 },
};

// ---------- Trajectory parameters ----------
const SACCADE_AMPLITUDE = 0.55;  // ~30° at typical viewing distance, normalized
const SACCADE_DWELL_S   = 0.8;   // time held at each end
const PURSUIT_AMPLITUDE = 0.7;   // ~40° p-p
const PURSUIT_FREQ_HZ   = 0.2;   // sinusoidal frequency
const PURSUIT_LEAD_S    = 1.0;
const CONVERGENCE_REP_S = 5.0;   // one approach+return cycle

/**
 * Pure trajectory functions. Each maps t (seconds since trial start) -> {x, y, z}.
 * x, y in [-1, +1] (viewport-normalized; origin = center).
 * z in [0, 1] (0 = far/small, 1 = near/large; only convergence varies it).
 *
 * For trials that do not need depth, z is held at a sensible neutral
 * (REST/BLINK/SACCADE/PURSUIT use z=0 — flat, screen-distance target).
 */
export const TRAJECTORIES = {
    /** Static fixation cross at center. */
    rest(t) {
        return { x: 0, y: 0, z: 0 };
    },

    /**
     * Target zooms toward the viewer over CONVERGENCE_REP_S seconds, returns,
     * repeats. Triangular z profile (0 -> 1 -> 0). x/y stay centered so the
     * eyes' only correct response is symmetric inward convergence.
     */
    convergence(t, opts = {}) {
        const period = opts.period_s || CONVERGENCE_REP_S;
        const phase = (t % period) / period;          // 0..1
        const z = phase < 0.5 ? phase * 2 : (1 - phase) * 2;  // triangle 0..1..0
        return { x: 0, y: 0, z };
    },

    /**
     * Square-wave horizontal jumps L<->R with ~0.8s dwell at each end.
     * First half-second is a centered fixation lead-in.
     */
    saccade(t, opts = {}) {
        const dwell = opts.dwell_s || SACCADE_DWELL_S;
        const amp   = opts.amplitude || SACCADE_AMPLITUDE;
        const leadIn = 0.5;
        if (t < leadIn) return { x: 0, y: 0, z: 0 };
        const idx = Math.floor((t - leadIn) / dwell);
        // Alternate: -amp, +amp, -amp, +amp ...
        const x = (idx % 2 === 0) ? -amp : +amp;
        return { x, y: 0, z: 0 };
    },

    /**
     * Smooth horizontal sinusoid for pursuit gain measurement.
     * 1s lead-in at center, then sin(2π f t), then 1s lead-out at last value.
     */
    pursuit(t, opts = {}) {
        const freq = opts.freq_hz || PURSUIT_FREQ_HZ;
        const amp  = opts.amplitude || PURSUIT_AMPLITUDE;
        const lead = opts.lead_s || PURSUIT_LEAD_S;
        if (t < lead) return { x: 0, y: 0, z: 0 };
        const tp = t - lead;
        return { x: amp * Math.sin(2 * Math.PI * freq * tp), y: 0, z: 0 };
    },

    /** Passive — small static cross, identical to REST trajectory. */
    blink(t) {
        return { x: 0, y: 0, z: 0 };
    },
};

/**
 * Trajectory metadata returned alongside frame log so downstream code
 * knows what stimulus generated the data.
 */
const TRAJECTORY_META = {
    rest:        { kind: 'rest',        description: 'static fixation 30s' },
    convergence: { kind: 'convergence', period_s: CONVERGENCE_REP_S,
                   description: 'triangular z 0->1->0, repeated' },
    saccade:     { kind: 'saccade',     amplitude: SACCADE_AMPLITUDE,
                   dwell_s: SACCADE_DWELL_S,
                   description: 'square-wave horizontal jumps' },
    pursuit:     { kind: 'pursuit',     amplitude: PURSUIT_AMPLITUDE,
                   freq_hz: PURSUIT_FREQ_HZ, lead_s: PURSUIT_LEAD_S,
                   description: 'horizontal sinusoid' },
    blink:       { kind: 'blink',       description: 'passive 30s' },
};


export class TrialTarget {
    /**
     * @param {HTMLElement} hostEl - container the target renders into.
     *   When run() is called the host is forced full-viewport with near-black
     *   background. Original inline styles are restored on done/cancel.
     */
    constructor(hostEl) {
        if (!hostEl) throw new Error('TrialTarget: hostEl required');
        this.hostEl = hostEl;
        this._rafId = null;
        this._cancelled = false;
        this._cancelReject = null;
        this._savedStyle = null;
        this._overlay = null;
    }

    /**
     * Run one trial. Resolves when complete; rejects on cancel().
     *
     * @param {Object} opts
     * @param {'rest'|'convergence'|'saccade'|'pursuit'|'blink'} opts.kind
     * @param {number} [opts.duration_s] override default
     * @param {number} [opts.repetitions] override default for jump-style trials
     * @returns {Promise<{kind, duration_s, frames, trajectory_meta}>}
     */
    async run(opts) {
        const kind = opts && opts.kind;
        if (!TRAJECTORIES[kind]) {
            throw new Error(`TrialTarget.run: unknown kind '${kind}'`);
        }
        const def = DEFAULTS[kind];
        const duration_s  = (opts.duration_s != null) ? opts.duration_s : def.duration_s;
        const repetitions = (opts.repetitions != null) ? opts.repetitions : def.repetitions;

        this._cancelled = false;
        this._buildOverlay();

        try {
            await this._runCountdown();
            if (this._cancelled) throw new Error('cancelled');
            const frames = await this._runTrial(kind, duration_s, repetitions);
            return {
                kind,
                duration_s,
                frames,
                trajectory_meta: { ...TRAJECTORY_META[kind], repetitions, duration_s },
            };
        } finally {
            this._teardownOverlay();
        }
    }

    cancel() {
        this._cancelled = true;
        if (this._rafId != null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._cancelReject) {
            const r = this._cancelReject;
            this._cancelReject = null;
            r(new Error('cancelled'));
        }
    }

    // ---------- internal: overlay DOM ----------

    _buildOverlay() {
        const host = this.hostEl;
        // Save the styles we mutate so we can restore them.
        this._savedStyle = {
            position: host.style.position,
            inset: host.style.inset,
            top: host.style.top,
            left: host.style.left,
            right: host.style.right,
            bottom: host.style.bottom,
            width: host.style.width,
            height: host.style.height,
            background: host.style.background,
            zIndex: host.style.zIndex,
            overflow: host.style.overflow,
        };
        Object.assign(host.style, {
            position: 'fixed',
            top: '0', left: '0', right: '0', bottom: '0',
            width: '100vw', height: '100vh',
            background: NEAR_BLACK,
            zIndex: '9999',
            overflow: 'hidden',
        });

        const overlay = document.createElement('div');
        overlay.setAttribute('data-trial-target', '');
        Object.assign(overlay.style, {
            position: 'absolute',
            inset: '0',
            background: NEAR_BLACK,
            color: AMBER,
            fontFamily: "'Courier New', ui-monospace, SFMono-Regular, Menlo, monospace",
            overflow: 'hidden',
        });

        // Countdown label (centered, large amber tabular monospace).
        // 8:1+ contrast: #ffb347 on #080406 ≈ 8.74:1 (passes the project floor).
        const count = document.createElement('div');
        count.setAttribute('data-trial-countdown', '');
        Object.assign(count.style, {
            position: 'absolute',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: '24vmin',
            fontWeight: '700',
            letterSpacing: '0.05em',
            fontVariantNumeric: 'tabular-nums',
            color: AMBER,
            textShadow: `0 0 6vmin rgba(255, 179, 71, 0.35)`,
            textAlign: 'center',
            lineHeight: '1',
            userSelect: 'none',
            pointerEvents: 'none',
        });
        count.textContent = '';
        overlay.appendChild(count);

        // Target element — spice-cyan glowing circle. Sized in vmin so it
        // scales sanely from phone to laptop. Hidden until trial begins.
        const target = document.createElement('div');
        target.setAttribute('data-trial-dot', '');
        Object.assign(target.style, {
            position: 'absolute',
            top: '50%', left: '50%',
            // Translate centers it; scale handles z-zoom. Width/height
            // expressed via base diameter (3vmin ≈ 24px on a 800px-min viewport).
            width: '3vmin', height: '3vmin',
            borderRadius: '50%',
            background: SPICE_CYAN,
            boxShadow: `0 0 2vmin ${SPICE_CYAN}, 0 0 4vmin ${SPICE_BLUE}`,
            transform: 'translate(-50%, -50%) scale(1)',
            willChange: 'transform',
            opacity: '0',
            pointerEvents: 'none',
        });
        overlay.appendChild(target);

        // Ambient label (small, lower-center) — kind name in amber.
        const label = document.createElement('div');
        label.setAttribute('data-trial-label', '');
        Object.assign(label.style, {
            position: 'absolute',
            bottom: '6vmin', left: '0', right: '0',
            textAlign: 'center',
            fontSize: 'clamp(10px, 1.4vmin, 16px)',
            letterSpacing: '0.3em',
            color: AMBER_BRIGHT,
            opacity: '0.85',
            pointerEvents: 'none',
        });
        overlay.appendChild(label);

        host.appendChild(overlay);
        this._overlay = overlay;
        this._countEl = count;
        this._targetEl = target;
        this._labelEl = label;
    }

    _teardownOverlay() {
        if (this._rafId != null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._overlay && this._overlay.parentNode) {
            this._overlay.parentNode.removeChild(this._overlay);
        }
        this._overlay = null;
        this._countEl = null;
        this._targetEl = null;
        this._labelEl = null;
        // Restore host styles
        if (this._savedStyle && this.hostEl) {
            for (const k of Object.keys(this._savedStyle)) {
                this.hostEl.style[k] = this._savedStyle[k];
            }
        }
        this._savedStyle = null;
    }

    // ---------- internal: countdown ----------

    _runCountdown() {
        return new Promise((resolve, reject) => {
            this._cancelReject = reject;
            const beats = ['3', '2', '1', 'GO'];
            let i = 0;
            const tick = () => {
                if (this._cancelled) return;
                this._countEl.textContent = beats[i];
                i++;
                if (i >= beats.length) {
                    setTimeout(() => {
                        if (this._cancelled) return;
                        this._countEl.textContent = '';
                        this._cancelReject = null;
                        resolve();
                    }, 1000);
                } else {
                    setTimeout(tick, 1000);
                }
            };
            tick();
        });
    }

    // ---------- internal: per-frame trial loop ----------

    _runTrial(kind, duration_s, repetitions) {
        return new Promise((resolve, reject) => {
            this._cancelReject = reject;

            const traj = TRAJECTORIES[kind];
            const trajOpts = {};
            if (kind === 'saccade')     trajOpts.dwell_s = SACCADE_DWELL_S;
            if (kind === 'convergence') trajOpts.period_s = duration_s / repetitions;

            this._labelEl.textContent = `· ${kind.toUpperCase()} ·`;
            this._targetEl.style.opacity = '1';

            const frames = [];
            const t0 = performance.now();
            let frame = 0;

            const step = (now) => {
                if (this._cancelled) return;
                const t = (now - t0) / 1000;
                if (t >= duration_s) {
                    // Final emit + resolve
                    this._targetEl.style.opacity = '0';
                    this._cancelReject = null;
                    this._emit(kind, t, 0, 0, 0, frame, /*final*/true);
                    resolve(frames);
                    return;
                }

                const { x, y, z } = traj(t, trajOpts);

                // Render: position via translate, z via scale.
                // Base diameter = 3vmin (~24px). At z=1 we want ~80px → scale ≈ 3.3.
                const scale = 1 + z * 2.3;
                // x in [-1,+1] → viewport [10vw .. 90vw] (10% margin).
                // Same for y. Using calc() preserves vmin-friendly behaviour.
                const xPct = 50 + x * 40;   // 10% .. 90%
                const yPct = 50 + y * 40;
                this._targetEl.style.left = xPct + '%';
                this._targetEl.style.top  = yPct + '%';
                this._targetEl.style.transform =
                    `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

                frames.push({ t, x, y, z });
                this._emit(kind, t, x, y, z, frame, false);
                frame++;
                this._rafId = requestAnimationFrame(step);
            };
            this._rafId = requestAnimationFrame(step);
        });
    }

    _emit(kind, t, x, y, z, frame, isFinal) {
        const bus = (typeof window !== 'undefined') ? window.MotionBus : null;
        if (bus && typeof bus.emit === 'function') {
            bus.emit('oculensTarget', { kind, t, x, y, z, frame, isFinal });
        }
    }
}

export default TrialTarget;
