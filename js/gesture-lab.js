/**
 * GestureLab — live and deterministic inspection for FaceGestureRecognizer.
 *
 * Camerastein owns recognition, not Psychodeli's artistic response. This panel
 * therefore stops at the shared FaceGestures contract: continuous feature
 * evidence, recognizer phase, lifecycle events, and confidence. Its synthetic
 * rehearsals instantiate a private recognizer and never emit onto MotionBus, so
 * testing one gesture cannot drive a connected product or contaminate the live
 * camera stream.
 */

import { FaceGestureRecognizer } from './tasks-vision/face-gesture-channel.js';

const WAIT_MS = 145;
const MAX_EVENTS = 48;

export const GESTURE_DEFINITIONS = Object.freeze({
    mouth: Object.freeze({
        label: 'Mouth',
        cue: 'Open, hold, then close',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    brow: Object.freeze({
        label: 'Brow',
        cue: 'Raise either or both brows',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    smile: Object.freeze({
        label: 'Smile',
        cue: 'Smile, hold, then relax',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    frown: Object.freeze({
        label: 'Frown',
        cue: 'Turn mouth corners down, hold, relax',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    leanIn: Object.freeze({
        label: 'Lean in',
        cue: 'Move closer, pause, return',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    leanOut: Object.freeze({
        label: 'Lean out',
        cue: 'Move farther away, pause, return',
        family: 'track',
        expected: ['start', 'peak', 'release'],
    }),
    nod: Object.freeze({
        label: 'Nod',
        cue: 'Excursion, reversal, neutral return',
        family: 'cycle',
        expected: ['start', 'peak', 'complete'],
    }),
    shake: Object.freeze({
        label: 'Shake',
        cue: 'Turn, reverse, reach opposite side',
        family: 'cycle',
        expected: ['start', 'peak', 'complete'],
    }),
    scream: Object.freeze({
        label: 'Scream',
        cue: 'Open mouth wide and raise brows',
        family: 'compound',
        expected: ['start', 'release'],
    }),
});

const GESTURE_IDS = Object.freeze(Object.keys(GESTURE_DEFINITIONS));

function finite(x, fallback = 0) {
    return (typeof x === 'number' && Number.isFinite(x)) ? x : fallback;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, finite(x)));
}

function featureFrame(t, overrides = {}) {
    return {
        v: 1,
        t,
        quality: {
            confidence: 1,
            facePresent: 1,
            hasExpressions: 1,
            calibrated: true,
            ...(overrides.quality || {}),
        },
        expression: {
            jawOpen: 0,
            browRaiseL: 0,
            browRaiseR: 0,
            ...(overrides.expression || {}),
        },
        pose: {
            pitch: 0,
            yaw: 0,
            proximity: 0,
            ...(overrides.pose || {}),
        },
        dynamics: {
            jawVel: 0,
            browLVel: 0,
            browRVel: 0,
            pitchVel: 0,
            yawVel: 0,
            proximityVel: 0,
            ...(overrides.dynamics || {}),
        },
        authority: overrides.authority ?? 0,
    };
}

/**
 * Deterministic provider-neutral feature sequence for one recognizer.
 * Timestamps are explicit so the same rehearsal runs in Node tests and in the
 * browser UI without a camera, a model, timers, or wall-clock assumptions.
 */
export function createGestureRehearsal(kind, startT = 0) {
    const t = finite(startT);
    const neutral = featureFrame(t);
    const sequences = {
        mouth: [
            neutral,
            featureFrame(t + 50, {
                expression: { jawOpen: 0.48 },
                dynamics: { jawVel: 1.1 },
                authority: 0.5,
            }),
            featureFrame(t + 110, {
                expression: { jawOpen: 0.82 },
                dynamics: { jawVel: 0.6 },
                authority: 0.82,
            }),
            featureFrame(t + 170, {
                expression: { jawOpen: 0.78 },
                dynamics: { jawVel: 0 },
                authority: 0.78,
            }),
            featureFrame(t + 240, {
                expression: { jawOpen: 0.08 },
                dynamics: { jawVel: -1.1 },
                authority: 0.08,
            }),
        ],
        brow: [
            neutral,
            featureFrame(t + 50, {
                expression: { browRaiseL: 0.52, browRaiseR: 0.5 },
                dynamics: { browLVel: 1, browRVel: 0.95 },
                authority: 0.52,
            }),
            featureFrame(t + 110, {
                expression: { browRaiseL: 0.78, browRaiseR: 0.74 },
                dynamics: { browLVel: 0.5, browRVel: 0.45 },
                authority: 0.78,
            }),
            featureFrame(t + 170, {
                expression: { browRaiseL: 0.75, browRaiseR: 0.72 },
                dynamics: { browLVel: 0, browRVel: 0 },
                authority: 0.75,
            }),
            featureFrame(t + 240, {
                expression: { browRaiseL: 0.08, browRaiseR: 0.07 },
                dynamics: { browLVel: -1, browRVel: -1 },
                authority: 0.08,
            }),
        ],
        smile: [
            neutral,
            featureFrame(t + 50, {
                expression: { valence: 0.45 },
                dynamics: { valenceVel: 0.9 },
                authority: 0.45,
            }),
            featureFrame(t + 120, {
                expression: { valence: 0.62 },
                dynamics: { valenceVel: 0.2 },
                authority: 0.62,
            }),
            featureFrame(t + 180, {
                expression: { valence: 0.58 },
                dynamics: { valenceVel: 0 },
                authority: 0.58,
            }),
            featureFrame(t + 250, {
                expression: { valence: 0.04 },
                dynamics: { valenceVel: -0.9 },
                authority: 0.04,
            }),
        ],
        frown: [
            neutral,
            featureFrame(t + 50, {
                expression: { valence: -0.45 },
                dynamics: { valenceVel: -0.9 },
                authority: 0.45,
            }),
            featureFrame(t + 120, {
                expression: { valence: -0.62 },
                dynamics: { valenceVel: -0.2 },
                authority: 0.62,
            }),
            featureFrame(t + 180, {
                expression: { valence: -0.58 },
                dynamics: { valenceVel: 0 },
                authority: 0.58,
            }),
            featureFrame(t + 250, {
                expression: { valence: -0.04 },
                dynamics: { valenceVel: 0.9 },
                authority: 0.04,
            }),
        ],
        leanIn: [
            neutral,
            featureFrame(t + 50, {
                pose: { proximity: 0.42 },
                dynamics: { proximityVel: 0.8 },
                authority: 0.42,
            }),
            featureFrame(t + 110, {
                pose: { proximity: 0.68 },
                dynamics: { proximityVel: 0.4 },
                authority: 0.68,
            }),
            featureFrame(t + 170, {
                pose: { proximity: 0.64 },
                dynamics: { proximityVel: 0 },
                authority: 0.64,
            }),
            featureFrame(t + 240, {
                pose: { proximity: 0.04 },
                dynamics: { proximityVel: -0.9 },
                authority: 0.04,
            }),
        ],
        leanOut: [
            neutral,
            featureFrame(t + 50, {
                pose: { proximity: -0.42 },
                dynamics: { proximityVel: -0.8 },
                authority: 0.42,
            }),
            featureFrame(t + 110, {
                pose: { proximity: -0.68 },
                dynamics: { proximityVel: -0.4 },
                authority: 0.68,
            }),
            featureFrame(t + 170, {
                pose: { proximity: -0.64 },
                dynamics: { proximityVel: 0 },
                authority: 0.64,
            }),
            featureFrame(t + 240, {
                pose: { proximity: -0.04 },
                dynamics: { proximityVel: 0.9 },
                authority: 0.04,
            }),
        ],
        nod: [
            neutral,
            featureFrame(t + 50, {
                pose: { pitch: 0.16 },
                dynamics: { pitchVel: 0.6 },
                authority: 0.45,
            }),
            featureFrame(t + 100, {
                pose: { pitch: 0.22 },
                dynamics: { pitchVel: 0.3 },
                authority: 0.55,
            }),
            featureFrame(t + 160, {
                pose: { pitch: 0.12 },
                dynamics: { pitchVel: -0.5 },
                authority: 0.45,
            }),
            featureFrame(t + 220, {
                pose: { pitch: 0.01 },
                dynamics: { pitchVel: -0.3 },
                authority: 0.2,
            }),
        ],
        shake: [
            neutral,
            featureFrame(t + 50, {
                pose: { yaw: 0.18 },
                dynamics: { yawVel: 0.6 },
                authority: 0.45,
            }),
            featureFrame(t + 100, {
                pose: { yaw: 0.22 },
                dynamics: { yawVel: 0.3 },
                authority: 0.55,
            }),
            featureFrame(t + 150, {
                pose: { yaw: 0 },
                dynamics: { yawVel: -0.5 },
                authority: 0.35,
            }),
            featureFrame(t + 200, {
                pose: { yaw: -0.13 },
                dynamics: { yawVel: -0.5 },
                authority: 0.45,
            }),
        ],
        scream: [
            neutral,
            featureFrame(t + 50, {
                expression: {
                    jawOpen: 0.72,
                    browRaiseL: 0.55,
                    browRaiseR: 0.53,
                },
                dynamics: { jawVel: 1.2, browLVel: 1, browRVel: 1 },
                authority: 0.8,
            }),
            featureFrame(t + 120, {
                expression: {
                    jawOpen: 0.9,
                    browRaiseL: 0.7,
                    browRaiseR: 0.68,
                },
                dynamics: { jawVel: 0.4, browLVel: 0.25, browRVel: 0.25 },
                authority: 0.95,
            }),
            featureFrame(t + 190, {
                expression: {
                    jawOpen: 0.82,
                    browRaiseL: 0.65,
                    browRaiseR: 0.64,
                },
                authority: 0.9,
            }),
            featureFrame(t + 260, {
                expression: {
                    jawOpen: 0.2,
                    browRaiseL: 0.18,
                    browRaiseR: 0.17,
                },
                dynamics: { jawVel: -1.2, browLVel: -1, browRVel: -1 },
                authority: 0.2,
            }),
        ],
    };
    if (!sequences[kind]) throw new Error(`Unknown gesture rehearsal: ${kind}`);
    return sequences[kind];
}

/**
 * Synchronous test seam used by Node and the browser's rehearsal verdict.
 */
export function runGestureRehearsal(kind, startT = 0) {
    const recognizer = new FaceGestureRecognizer();
    const frames = createGestureRehearsal(kind, startT)
        .map(input => recognizer.update(input))
        .filter(Boolean);
    const events = frames.flatMap(frame => frame.events || [])
        .filter(event => event.kind === kind);
    return {
        kind,
        frames,
        events,
        phases: events.map(event => event.phase),
        passed: JSON.stringify(events.map(event => event.phase))
            === JSON.stringify(GESTURE_DEFINITIONS[kind].expected),
    };
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function valueFor(frame, kind) {
    if (!frame) return { phase: 'idle', value: 0, active: false };
    const def = GESTURE_DEFINITIONS[kind];
    if (def.family === 'track') {
        const track = frame.tracks?.[kind];
        return {
            phase: track?.phase || 'idle',
            value: clamp01(track?.value),
            active: !!track?.active,
        };
    }
    if (def.family === 'cycle') {
        const cycle = frame.cycles?.[kind];
        return {
            phase: cycle?.phase || 'idle',
            value: clamp01(cycle?.peak),
            active: !!cycle?.active,
        };
    }
    const compound = frame.compound?.[kind];
    return {
        phase: compound?.active ? 'active' : 'idle',
        value: clamp01(compound?.strength),
        active: !!compound?.active,
    };
}

export class GestureLab {
    constructor() {
        this.panel = document.getElementById('gesture-lab-panel');
        this.toggle = document.getElementById('gesture-lab-toggle');
        if (!this.panel || !this.toggle) return;

        this.focus = 'all';
        this.liveFrame = null;
        this.syntheticFrame = null;
        this.lastFeatures = null;
        this.events = [];
        this.rehearsalRun = 0;
        this.isTasksVision = new URLSearchParams(location.search).has('tasks-vision');

        this._build();
        this._wire();
        this._subscribe();
        this._render();
    }

    _build() {
        const focusButtons = [
            '<button class="gesture-focus active" data-focus="all">All</button>',
            ...GESTURE_IDS.map(kind =>
                `<button class="gesture-focus" data-focus="${kind}">${GESTURE_DEFINITIONS[kind].label}</button>`
            ),
        ].join('');
        const cards = GESTURE_IDS.map(kind => {
            const def = GESTURE_DEFINITIONS[kind];
            return `
                <article class="gesture-card" data-gesture="${kind}">
                    <div class="gesture-card-heading">
                        <div>
                            <strong>${def.label}</strong>
                            <span class="gesture-family">${def.family}</span>
                        </div>
                        <button class="gesture-rehearse" data-rehearse="${kind}">rehearse</button>
                    </div>
                    <p>${def.cue}</p>
                    <div class="gesture-state-row">
                        <span class="gesture-phase" data-phase="${kind}">idle</span>
                        <span class="gesture-value" data-value="${kind}">0.00</span>
                    </div>
                    <div class="gesture-meter"><i data-meter="${kind}"></i></div>
                    <code>${def.expected.join(' → ')}</code>
                </article>`;
        }).join('');

        this.panel.innerHTML = `
            <div class="gesture-lab-header">
                <div>
                    <span class="gesture-kicker">FaceGestures v1</span>
                    <h2>Gesture lab</h2>
                </div>
                <button class="gesture-close" aria-label="Close gesture lab">×</button>
            </div>
            <div class="gesture-source-row">
                <span class="gesture-source" data-source>waiting for face</span>
                <span class="gesture-calibration" data-calibration>uncalibrated</span>
            </div>
            <p class="gesture-lab-intro">
                Solo a recognizer, perform its cue, or rehearse its deterministic
                feature sequence without touching the live MotionBus.
            </p>
            <div class="gesture-focus-strip" role="group" aria-label="Gesture recognizer focus">
                ${focusButtons}
            </div>
            <div class="gesture-lab-actions">
                <button data-reset-baseline>reset baseline</button>
                <button data-clear-events>clear events</button>
            </div>
            <div class="gesture-cards">${cards}</div>
            <section class="gesture-event-section">
                <div class="gesture-event-heading">
                    <strong>Lifecycle events</strong>
                    <span data-verdict>live observation</span>
                </div>
                <ol class="gesture-event-log" data-event-log>
                    <li class="gesture-event-empty">No events yet</li>
                </ol>
            </section>`;
    }

    _wire() {
        this.toggle.addEventListener('click', () => this._setOpen(
            this.panel.classList.contains('collapsed')
        ));
        this.panel.querySelector('.gesture-close')
            ?.addEventListener('click', () => this._setOpen(false));

        this.panel.querySelectorAll('[data-focus]').forEach(button => {
            button.addEventListener('click', () => {
                this.focus = button.dataset.focus || 'all';
                this._render();
            });
        });
        this.panel.querySelectorAll('[data-rehearse]').forEach(button => {
            button.addEventListener('click', () => this._rehearse(button.dataset.rehearse));
        });
        this.panel.querySelector('[data-reset-baseline]')?.addEventListener('click', () => {
            window.FaceFeatures?.resetCalibration?.();
            window.FaceGestures?.reset?.();
            this.events = [];
            this._render();
        });
        this.panel.querySelector('[data-clear-events]')?.addEventListener('click', () => {
            this.events = [];
            this._renderEvents();
        });
    }

    _subscribe() {
        window.MotionBus?.subscribe?.('faceFeatures', features => {
            this.lastFeatures = features;
            this._renderSource();
        });
        window.MotionBus?.subscribe?.('faceGestures', gestures => {
            this.liveFrame = gestures;
            if (gestures) this._recordEvents(gestures, 'live');
            if (!this.syntheticFrame) this._render();
        });
    }

    _setOpen(open) {
        this.panel.classList.toggle('collapsed', !open);
        this.toggle.classList.toggle('active', open);
        this.toggle.setAttribute('aria-expanded', String(open));
        if (open) this._render();
    }

    async _rehearse(kind) {
        if (!GESTURE_DEFINITIONS[kind]) return;
        const run = ++this.rehearsalRun;
        this.focus = kind;
        this.events = this.events.filter(item => item.source !== 'synthetic');
        const recognizer = new FaceGestureRecognizer();
        const inputs = createGestureRehearsal(kind, performance.now());
        const verdict = this.panel.querySelector('[data-verdict]');
        if (verdict) verdict.textContent = `rehearsing ${GESTURE_DEFINITIONS[kind].label.toLowerCase()}`;

        for (const input of inputs) {
            if (run !== this.rehearsalRun) return;
            this.syntheticFrame = recognizer.update(input);
            if (this.syntheticFrame) this._recordEvents(this.syntheticFrame, 'synthetic');
            this._render();
            await wait(WAIT_MS);
        }

        if (run !== this.rehearsalRun) return;
        const phases = this.events
            .filter(item => item.source === 'synthetic' && item.event.kind === kind)
            .map(item => item.event.phase)
            .reverse(); // the visible log is newest-first; the contract is chronological
        const expected = GESTURE_DEFINITIONS[kind].expected;
        const passed = JSON.stringify(phases) === JSON.stringify(expected);
        if (verdict) verdict.textContent = passed ? 'rehearsal passed' : 'rehearsal incomplete';
        this.panel.classList.toggle('rehearsal-failed', !passed);
        await wait(650);
        if (run !== this.rehearsalRun) return;
        this.syntheticFrame = null;
        this._render();
    }

    _recordEvents(frame, source) {
        for (const event of frame.events || []) {
            this.events.unshift({ event, source });
        }
        this.events = this.events.slice(0, MAX_EVENTS);
    }

    _render() {
        if (!this.panel || this.panel.classList.contains('collapsed')) return;
        this.panel.classList.remove('rehearsal-failed');
        this.panel.querySelectorAll('[data-focus]').forEach(button => {
            button.classList.toggle('active', button.dataset.focus === this.focus);
        });

        const frame = this.syntheticFrame || this.liveFrame;
        for (const kind of GESTURE_IDS) {
            const state = valueFor(frame, kind);
            const card = this.panel.querySelector(`[data-gesture="${kind}"]`);
            if (card) {
                card.hidden = this.focus !== 'all' && this.focus !== kind;
                card.classList.toggle('active', state.active);
            }
            const phase = this.panel.querySelector(`[data-phase="${kind}"]`);
            const value = this.panel.querySelector(`[data-value="${kind}"]`);
            const meter = this.panel.querySelector(`[data-meter="${kind}"]`);
            if (phase) phase.textContent = state.phase;
            if (value) value.textContent = state.value.toFixed(2);
            if (meter) meter.style.width = `${Math.round(state.value * 100)}%`;
        }
        this._renderSource();
        this._renderEvents();
    }

    _renderSource() {
        if (!this.panel || this.panel.classList.contains('collapsed')) return;
        const source = this.panel.querySelector('[data-source]');
        const calibration = this.panel.querySelector('[data-calibration]');
        const q = this.lastFeatures?.quality;
        if (this.syntheticFrame) {
            if (source) source.textContent = 'synthetic rehearsal';
            if (calibration) calibration.textContent = 'isolated recognizer';
            return;
        }
        if (!this.isTasksVision) {
            if (source) source.textContent = 'synthetic only';
            if (calibration) calibration.textContent = 'add ?tasks-vision for live input';
            return;
        }
        if (!q?.facePresent) {
            if (source) source.textContent = 'waiting for face';
            if (calibration) calibration.textContent = 'look toward camera';
            return;
        }
        if (source) source.textContent = `live · ${Math.round(clamp01(q.confidence) * 100)}% confidence`;
        if (calibration) calibration.textContent = q.calibrated ? 'baseline ready' : 'calibrating…';
    }

    _renderEvents() {
        const log = this.panel?.querySelector('[data-event-log]');
        if (!log) return;
        const visible = this.events.filter(item =>
            this.focus === 'all' || item.event.kind === this.focus
        ).slice(0, 18);
        if (!visible.length) {
            log.innerHTML = '<li class="gesture-event-empty">No events yet</li>';
            return;
        }
        log.innerHTML = visible.map(({ event, source }) => `
            <li>
                <span class="gesture-event-source ${source}">${source === 'live' ? 'L' : 'S'}</span>
                <strong>${event.kind}</strong>
                <span>${event.phase}</span>
                <i style="--strength:${clamp01(event.strength)}"></i>
                <small>${clamp01(event.strength).toFixed(2)}</small>
            </li>`).join('');
    }
}
