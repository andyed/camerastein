/**
 * eye-reticle.js — Self-contained brass + spice eye reticle for Oculens.
 *
 * Port of /Users/andyed/Documents/dev/ocular-brand/apparatus.py `eye_reticle()` +
 * `render_vessels()` to a runtime-mutable JS class. ViewBox 400x400.
 *
 * Construction builds all chrome (brass ring, ticks, crosshair, defs) once.
 * update() only mutates iris/pupil position, lid heights, rim opacity/width,
 * vessel-group opacity, halo opacity, iris dilation. No SVG rebuilds per frame.
 */

const NS = 'http://www.w3.org/2000/svg';

// ---------- Palette (mirror of apparatus.py) ----------
export const PALETTE = {
    BAKELITE_DARK:  '#170a06',
    BAKELITE:       '#2a1410',
    BAKELITE_LIGHT: '#3a1c16',
    BRASS:          '#9a7434',
    BRASS_LIGHT:    '#d8b870',
    AMBER:          '#ffb347',
    AMBER_BRIGHT:   '#ffd089',
    AMBER_DEC:      '#7a4e1a',   // decorative only — never text
    BONE:           '#ede4d3',
    COBALT_DEEP:    '#0a2058',
    SPICE_BLUE:     '#3a78ff',
    SPICE_CYAN:     '#5fe6ff',
    NEAR_BLACK:     '#080406',
    EYE_WELL:       '#06101a',

    VESSEL_BRIGHT:  '#ff7a72',
    VESSEL_DARK:    '#c8443e',

    SCLERA: {
        baseline: ['#d8d2c0', '#b8b0a0', '#7a7264'],
        test:     ['#dac8c0', '#b89a90', '#7a5a52'],
        verdict:  ['#dec4b8', '#b48070', '#7a4030'],
    },

    IRIS: {
        baseline: [
            { offset: '0%',   color: '#1a1208' },
            { offset: '55%',  color: '#3a2a1a' },
            { offset: '100%', color: '#5a4028' },
        ],
        test: [
            { offset: '0%',   color: '#000a18' },
            { offset: '35%',  color: '#0a2058' },
            { offset: '72%',  color: '#3a78ff' },
            { offset: '100%', color: '#5fe6ff' },
        ],
        verdict: [
            { offset: '0%',   color: '#000812' },
            { offset: '28%',  color: '#0a2058' },
            { offset: '62%',  color: '#3a78ff' },
            { offset: '100%', color: '#5fe6ff' },
        ],
    },
};

// AMBER on EYE_WELL contrast:
//   L(amber)  ≈ 0.531
//   L(near-black) ≈ 0.003
//   ratio ≈ (0.531 + 0.05) / (0.003 + 0.05) ≈ 10.96  → passes 8:1.
// Tick numerals sit on NEAR_BLACK page bg (in test page) and on EYE_WELL ring band — both safe.

// Module-level monotonic counter ensures unique <defs> ids across instances on the same page.
let _instanceCounter = 0;

// Reticle internal geometry — viewBox is 400x400.
const CX = 200;
const CY = 200;
const R  = 130;
const IRIS_R_BASE  = R * 0.55;   // 71.5
const PUPIL_R_BASE = R * 0.18;   // 23.4
const SCLERA_R     = R * 0.92;   // 119.6

function el(name, attrs = {}) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) {
        if (attrs[k] === undefined || attrs[k] === null) continue;
        node.setAttribute(k, attrs[k]);
    }
    return node;
}

export class EyeReticle {
    /**
     * @param {SVGElement} hostSvg - <svg> with viewBox="0 0 400 400" already set.
     * @param {Object} opts - { side: 'L'|'R', state: 'baseline'|'test'|'verdict' }
     */
    constructor(hostSvg, opts = {}) {
        if (!hostSvg) throw new Error('EyeReticle: hostSvg required');
        this.svg   = hostSvg;
        this.side  = opts.side  || 'L';
        this.state = opts.state || 'baseline';

        _instanceCounter++;
        // Unique id suffix — collision-free across N instances on one page.
        this.uid = `er-${this.side}-${_instanceCounter}`;

        // Cached refs populated by _build*().
        this._refs = {};

        // Last-applied state cache for cheap diffing.
        this._last = {};

        // viewBox safety — only set if missing.
        if (!this.svg.getAttribute('viewBox')) {
            this.svg.setAttribute('viewBox', '0 0 400 400');
        }

        // Wipe any prior children (idempotent re-init).
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

        this._buildDefs();
        this._buildChrome();
        this._buildSclera();
        this._buildVessels();
        this._buildRim();
        this._buildHalo();
        this._buildIrisPupil();
        this._buildLids();
        this._buildCrosshair();
        this._buildLabels();

        // Apply initial palette + neutral state.
        this.setState(this.state);
        this.update({
            blink: 0, gazeX: 0, gazeY: 0,
            squint: 0, vesselIntensity: 0,
            spiceActive: this.state !== 'baseline',
            irisDilation: 1.0,
        });
    }

    // ---------- defs ----------
    _buildDefs() {
        const defs = el('defs');

        // Iris radial gradient (will be re-stopped on setState).
        const irisGrad = el('radialGradient', {
            id: `${this.uid}-iris`, cx: '0.5', cy: '0.5', r: '0.5',
        });
        defs.appendChild(irisGrad);

        // Sclera radial gradient.
        const scleraGrad = el('radialGradient', {
            id: `${this.uid}-sclera`, cx: '0.5', cy: '0.45', r: '0.55',
        });
        defs.appendChild(scleraGrad);

        // Brass linear gradient for outer ring.
        const brassGrad = el('linearGradient', {
            id: `${this.uid}-brass`, x1: '0', y1: '0', x2: '0', y2: '1',
        });
        brassGrad.appendChild(el('stop', { offset: '0%',   'stop-color': PALETTE.BRASS_LIGHT }));
        brassGrad.appendChild(el('stop', { offset: '50%',  'stop-color': PALETTE.BRASS }));
        brassGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#5a4220' }));
        defs.appendChild(brassGrad);

        // Spice glow filters.
        const spiceGlow = el('filter', {
            id: `${this.uid}-spice-glow`,
            x: '-100%', y: '-100%', width: '300%', height: '300%',
        });
        spiceGlow.appendChild(el('feGaussianBlur', { stdDeviation: '3.0' }));
        defs.appendChild(spiceGlow);

        const spiceGlowTight = el('filter', {
            id: `${this.uid}-spice-glow-tight`,
            x: '-50%', y: '-50%', width: '200%', height: '200%',
        });
        spiceGlowTight.appendChild(el('feGaussianBlur', { stdDeviation: '1.4', result: 'b' }));
        const merge = el('feMerge');
        merge.appendChild(el('feMergeNode', { in: 'b' }));
        merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
        spiceGlowTight.appendChild(merge);
        defs.appendChild(spiceGlowTight);

        // Amber glow for labels.
        const amberGlow = el('filter', {
            id: `${this.uid}-amber-glow`,
            x: '-50%', y: '-50%', width: '200%', height: '200%',
        });
        amberGlow.appendChild(el('feGaussianBlur', { stdDeviation: '0.8', result: 'b' }));
        const amerge = el('feMerge');
        amerge.appendChild(el('feMergeNode', { in: 'b' }));
        amerge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
        amberGlow.appendChild(amerge);
        defs.appendChild(amberGlow);

        // Sclera clip-path for vessels (clips to fixed sclera disc; gaze offset is applied
        // by translating the vessel group, so the clip stays static and pre-pruned).
        const clip = el('clipPath', { id: `${this.uid}-vclip` });
        clip.appendChild(el('circle', {
            cx: CX, cy: CY, r: SCLERA_R - 0.5,
        }));
        defs.appendChild(clip);

        this.svg.appendChild(defs);
        this._refs.irisGrad = irisGrad;
        this._refs.scleraGrad = scleraGrad;
    }

    // ---------- chrome (brass ring, ticks, eye-well) ----------
    _buildChrome() {
        // Outer brass ring (two strokes — graded + thin inner).
        this.svg.appendChild(el('circle', {
            cx: CX, cy: CY, r: R + 26,
            fill: 'none',
            stroke: `url(#${this.uid}-brass)`,
            'stroke-width': '2.6',
        }));
        this.svg.appendChild(el('circle', {
            cx: CX, cy: CY, r: R + 22,
            fill: 'none',
            stroke: PALETTE.BRASS,
            'stroke-width': '0.6',
        }));

        // Tick scale every 15° with numeric labels at 45° intervals.
        for (let i = 0; i < 24; i++) {
            const ang = (i * 15) * Math.PI / 180;
            const major = (i % 3 === 0);
            const outer = R + 18;
            const inner = R + (major ? 5 : 10);
            const x1 = CX + Math.cos(ang) * inner;
            const y1 = CY + Math.sin(ang) * inner;
            const x2 = CX + Math.cos(ang) * outer;
            const y2 = CY + Math.sin(ang) * outer;
            this.svg.appendChild(el('line', {
                x1: x1.toFixed(1), y1: y1.toFixed(1),
                x2: x2.toFixed(1), y2: y2.toFixed(1),
                stroke: PALETTE.AMBER,
                'stroke-width': major ? '1.4' : '0.7',
            }));
            if (major) {
                const lx = CX + Math.cos(ang) * (outer + 12);
                const ly = CY + Math.sin(ang) * (outer + 12) + 3;
                const t = el('text', {
                    x: lx.toFixed(1), y: ly.toFixed(1),
                    'font-family': 'Courier New, monospace',
                    'font-size': '9',
                    'font-weight': 'bold',
                    fill: PALETTE.AMBER,
                    'text-anchor': 'middle',
                });
                t.textContent = String(i * 15);
                this.svg.appendChild(t);
            }
        }

        // Eye well (dark interior).
        this.svg.appendChild(el('circle', {
            cx: CX, cy: CY, r: R,
            fill: PALETTE.EYE_WELL,
            stroke: PALETTE.AMBER_DEC,
            'stroke-width': '0.6',
        }));
    }

    _buildSclera() {
        const sclera = el('circle', {
            cx: CX, cy: CY, r: SCLERA_R,
            fill: `url(#${this.uid}-sclera)`,
        });
        this.svg.appendChild(sclera);
        this._refs.sclera = sclera;
    }

    // Bezier vessels seeded from medial + lateral canthi. Built once in a <g>
    // whose opacity scales with vesselIntensity; clipped to sclera disc.
    _buildVessels() {
        const group = el('g', {
            'clip-path': `url(#${this.uid}-vclip)`,
            opacity: '0',
        });

        const sclera_r = SCLERA_R;
        const iris_r   = IRIS_R_BASE;

        // Build at intensity = 1.0; final visibility comes from group opacity.
        const intensity = 1.0;

        const seeds = [
            [Math.PI * 170 / 180, 4, 28],
            [Math.PI *  10 / 180, 4, 28],
            [Math.PI * 195 / 180, 3, 22],
            [Math.PI * 345 / 180, 3, 22],
        ];

        for (const [seed_ang, n, spread_deg] of seeds) {
            const spread = spread_deg * Math.PI / 180;
            for (let j = 0; j < n; j++) {
                const offset = (j - (n - 1) / 2) * spread / Math.max(n - 1, 1);
                const ang = seed_ang + offset;
                const sx = CX + Math.cos(ang) * (sclera_r - 1);
                const sy = CY + Math.sin(ang) * (sclera_r - 1);
                const end_ang = ang + 0.06 * (j - (n - 1) / 2);
                const end_r = iris_r + 6 + (j % 2) * 4;
                const ex = CX + Math.cos(end_ang) * end_r;
                const ey = CY + Math.sin(end_ang) * end_r;
                const perp = ang + Math.PI / 2;
                const wob = 4 + (j % 3) * 2;
                const sign = j % 2 ? 1 : -1;
                const mx = (sx + ex) / 2 + Math.cos(perp) * wob * sign;
                const my = (sy + ey) / 2 + Math.sin(perp) * wob * sign;
                const sw = 0.55 + intensity * 1.0;
                const color = j % 2 ? PALETTE.VESSEL_BRIGHT : PALETTE.VESSEL_DARK;
                const op    = 0.35 + intensity * 0.55;

                group.appendChild(el('path', {
                    d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`,
                    fill: 'none',
                    stroke: color,
                    'stroke-width': sw.toFixed(2),
                    opacity: op.toFixed(2),
                    'stroke-linecap': 'round',
                }));

                if (j < 2) {
                    const tx = (sx + mx) / 2;
                    const ty = (sy + my) / 2;
                    const tex = tx + Math.cos(perp + 0.4) * 6;
                    const tey = ty + Math.sin(perp + 0.4) * 6;
                    group.appendChild(el('path', {
                        d: `M${tx.toFixed(1)},${ty.toFixed(1)} L${tex.toFixed(1)},${tey.toFixed(1)}`,
                        fill: 'none',
                        stroke: color,
                        'stroke-width': (sw * 0.7).toFixed(2),
                        opacity: (op * 0.75).toFixed(2),
                        'stroke-linecap': 'round',
                    }));
                }
            }
        }

        this.svg.appendChild(group);
        this._refs.vesselGroup = group;
    }

    _buildRim() {
        // Two stacked circles: blurred spice halo + crisp cyan thin line.
        const rimGlow = el('circle', {
            cx: CX, cy: CY, r: SCLERA_R,
            fill: 'none',
            stroke: PALETTE.SPICE_BLUE,
            'stroke-width': '3',
            opacity: '0',
            filter: `url(#${this.uid}-spice-glow)`,
        });
        const rimEdge = el('circle', {
            cx: CX, cy: CY, r: SCLERA_R,
            fill: 'none',
            stroke: PALETTE.SPICE_CYAN,
            'stroke-width': '0.8',
            opacity: '0',
        });
        this.svg.appendChild(rimGlow);
        this.svg.appendChild(rimEdge);
        this._refs.rimGlow = rimGlow;
        this._refs.rimEdge = rimEdge;
    }

    _buildHalo() {
        // Verdict-state outer halo. Hidden by default; opacity revealed by setState/update.
        const halo = el('circle', {
            cx: CX, cy: CY, r: R + 34,
            fill: 'none',
            stroke: PALETTE.SPICE_BLUE,
            'stroke-width': '3',
            opacity: '0',
            filter: `url(#${this.uid}-spice-glow)`,
        });
        this.svg.appendChild(halo);
        this._refs.halo = halo;
    }

    _buildIrisPupil() {
        const iris = el('circle', {
            cx: CX, cy: CY, r: IRIS_R_BASE,
            fill: `url(#${this.uid}-iris)`,
        });
        const pupil = el('circle', {
            cx: CX, cy: CY, r: PUPIL_R_BASE,
            fill: '#000308',
        });
        const catchlight = el('circle', {
            cx: CX - PUPIL_R_BASE * 0.32,
            cy: CY - PUPIL_R_BASE * 0.42,
            r: PUPIL_R_BASE * 0.2,
            fill: '#cfd8e8',
            opacity: '0.9',
        });
        this.svg.appendChild(iris);
        this.svg.appendChild(pupil);
        this.svg.appendChild(catchlight);
        this._refs.iris = iris;
        this._refs.pupil = pupil;
        this._refs.catchlight = catchlight;
    }

    _buildLids() {
        // Lid covers — same color as eye-well so "closed" reads as eye-well face.
        // Animated by mutating y + height.
        const lidTop = el('rect', {
            x: CX - R, y: CY - R, width: R * 2, height: 0,
            fill: PALETTE.EYE_WELL,
        });
        const lidBot = el('rect', {
            x: CX - R, y: CY + R, width: R * 2, height: 0,
            fill: PALETTE.EYE_WELL,
        });
        this.svg.appendChild(lidTop);
        this.svg.appendChild(lidBot);
        this._refs.lidTop = lidTop;
        this._refs.lidBot = lidBot;
    }

    _buildCrosshair() {
        // Amber crosshair across the eye well — drawn ABOVE lids so the cross stays
        // legible during blink (an instrument reticle never disappears).
        const segments = [
            [CX - R - 10, CY,           CX - R * 0.72, CY],
            [CX + R * 0.72, CY,         CX + R + 10, CY],
            [CX, CY - R - 10,           CX, CY - R * 0.72],
            [CX, CY + R * 0.72,         CX, CY + R + 10],
        ];
        for (const [x1, y1, x2, y2] of segments) {
            this.svg.appendChild(el('line', {
                x1, y1, x2, y2,
                stroke: PALETTE.AMBER,
                'stroke-width': '1.1',
            }));
        }
    }

    _buildLabels() {
        // Side label slot — caller can override via setLabels().
        const top = el('text', {
            x: CX, y: CY - R - 32,
            'font-family': 'Courier New, monospace',
            'font-size': '11', 'font-weight': 'bold',
            'letter-spacing': '3',
            fill: PALETTE.AMBER, 'text-anchor': 'middle',
            filter: `url(#${this.uid}-amber-glow)`,
        });
        top.textContent = this.side === 'L' ? 'OS' : 'OD';
        const bot = el('text', {
            x: CX, y: CY + R + 40,
            'font-family': 'Courier New, monospace',
            'font-size': '11', 'font-weight': 'bold',
            'letter-spacing': '3',
            fill: PALETTE.AMBER, 'text-anchor': 'middle',
            filter: `url(#${this.uid}-amber-glow)`,
        });
        bot.textContent = this.side === 'L' ? 'LEFT' : 'RIGHT';
        this.svg.appendChild(top);
        this.svg.appendChild(bot);
        this._refs.labelTop = top;
        this._refs.labelBot = bot;
    }

    /**
     * Override the top/bottom amber labels.
     */
    setLabels(top, bot) {
        if (top != null && this._refs.labelTop) this._refs.labelTop.textContent = top;
        if (bot != null && this._refs.labelBot) this._refs.labelBot.textContent = bot;
    }

    /**
     * Switch palette state without rebuilding the SVG. Re-stops the iris + sclera
     * gradients and updates spice-active rim defaults.
     */
    setState(stateName) {
        if (!PALETTE.SCLERA[stateName]) {
            console.warn(`EyeReticle.setState: unknown state ${stateName}`);
            return;
        }
        this.state = stateName;

        // Re-stop iris.
        const irisGrad = this._refs.irisGrad;
        while (irisGrad.firstChild) irisGrad.removeChild(irisGrad.firstChild);
        for (const stop of PALETTE.IRIS[stateName]) {
            irisGrad.appendChild(el('stop', {
                offset: stop.offset, 'stop-color': stop.color,
            }));
        }

        // Re-stop sclera.
        const scleraGrad = this._refs.scleraGrad;
        const sStops = PALETTE.SCLERA[stateName];
        while (scleraGrad.firstChild) scleraGrad.removeChild(scleraGrad.firstChild);
        scleraGrad.appendChild(el('stop', { offset: '0%',   'stop-color': sStops[0] }));
        scleraGrad.appendChild(el('stop', { offset: '60%',  'stop-color': sStops[1] }));
        scleraGrad.appendChild(el('stop', { offset: '100%', 'stop-color': sStops[2] }));

        // Iris filter only when spice active.
        if (stateName === 'baseline') {
            this._refs.iris.removeAttribute('filter');
            this._refs.catchlight.setAttribute('fill', '#cfd8e8');
        } else {
            this._refs.iris.setAttribute('filter', `url(#${this.uid}-spice-glow-tight)`);
            this._refs.catchlight.setAttribute('fill', PALETTE.SPICE_CYAN);
        }

        // Halo: only verdict shows it (and only with non-zero spice).
        this._refs.halo.setAttribute('opacity', stateName === 'verdict' ? '0.5' : '0');

        // Re-apply last update so rim/vessel defaults reflect new state.
        if (this._last && Object.keys(this._last).length) {
            this.update(this._last);
        }
    }

    /**
     * Apply runtime state. Cheap; safe to call per-frame.
     * @param {Object} state
     *   blink:           0..1
     *   gazeX, gazeY:    -1..1
     *   squint:          0..1
     *   vesselIntensity: 0..1
     *   spiceActive:     boolean
     *   irisDilation:    0.5..1.5
     */
    update(state = {}) {
        this._last = { ...this._last, ...state };
        const s = this._last;

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Gaze offset — same scale as ocular.html legacy (r * 0.25 max).
        const gx = clamp(s.gazeX || 0, -1, 1) * R * 0.25;
        const gy = clamp(s.gazeY || 0, -1, 1) * R * 0.25;

        const dilation = clamp(s.irisDilation == null ? 1 : s.irisDilation, 0.5, 1.5);
        const pupilR = PUPIL_R_BASE * dilation;

        const iris = this._refs.iris;
        iris.setAttribute('cx', CX + gx);
        iris.setAttribute('cy', CY + gy);

        const pupil = this._refs.pupil;
        pupil.setAttribute('cx', CX + gx);
        pupil.setAttribute('cy', CY + gy);
        pupil.setAttribute('r', pupilR.toFixed(2));

        const cl = this._refs.catchlight;
        cl.setAttribute('cx', (CX + gx - pupilR * 0.32).toFixed(2));
        cl.setAttribute('cy', (CY + gy - pupilR * 0.42).toFixed(2));
        cl.setAttribute('r',  (pupilR * 0.2).toFixed(2));

        // Sclera follows gaze too (subtle — keeps the spheroid illusion).
        this._refs.sclera.setAttribute('cx', CX + gx);
        this._refs.sclera.setAttribute('cy', CY + gy);

        // Rim (spice signal): visibility = spiceActive AND (state != baseline) AND squint envelope.
        const spiceOn = (s.spiceActive !== false) && this.state !== 'baseline';
        const sq = clamp(s.squint || 0, 0, 1);
        const rimBase = this.state === 'verdict' ? 0.7 : 0.55;
        const rimW    = this.state === 'verdict' ? 4   : 3;
        if (spiceOn) {
            const op = (rimBase * 0.55) + sq * (rimBase * 0.45 + 0.2);
            this._refs.rimGlow.setAttribute('cx', CX + gx);
            this._refs.rimGlow.setAttribute('cy', CY + gy);
            this._refs.rimGlow.setAttribute('opacity', clamp(op, 0, 1).toFixed(2));
            this._refs.rimGlow.setAttribute('stroke-width', (rimW + sq * 1.5).toFixed(1));
            this._refs.rimEdge.setAttribute('cx', CX + gx);
            this._refs.rimEdge.setAttribute('cy', CY + gy);
            this._refs.rimEdge.setAttribute('opacity', (0.7 + sq * 0.3).toFixed(2));
        } else {
            this._refs.rimGlow.setAttribute('opacity', '0');
            this._refs.rimEdge.setAttribute('opacity', '0');
        }

        // Halo (verdict only, modulated by spice + squint).
        if (this.state === 'verdict' && spiceOn) {
            this._refs.halo.setAttribute('opacity', (0.4 + sq * 0.4).toFixed(2));
        } else {
            this._refs.halo.setAttribute('opacity', '0');
        }

        // Vessels — opacity follows intensity. Translate group with gaze so vessels
        // ride the eyeball; clip stays static, so off-edge geometry is pruned cleanly.
        const vi = clamp(s.vesselIntensity || 0, 0, 1);
        this._refs.vesselGroup.setAttribute('opacity', vi.toFixed(2));
        this._refs.vesselGroup.setAttribute('transform', `translate(${gx.toFixed(1)},${gy.toFixed(1)})`);

        // Lids — close from top + bottom, max ~0.9 of well height.
        const blinkAmt = clamp(s.blink || 0, 0, 1);
        const lidH = R * blinkAmt * 0.95;
        this._refs.lidTop.setAttribute('y', CY - R);
        this._refs.lidTop.setAttribute('height', lidH);
        this._refs.lidBot.setAttribute('y', CY + R - lidH);
        this._refs.lidBot.setAttribute('height', lidH);
    }
}
