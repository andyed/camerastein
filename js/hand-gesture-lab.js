/**
 * Hand Gesture Lab — the hand-side parallel to the face Gesture Lab.
 *
 * Same shape, different channel: a registry of recognizers, a focus strip, a
 * card per gesture with a deterministic `rehearse` that never touches the live
 * MotionBus, and one shared lifecycle log. The face lab reads `faceGestures`;
 * this reads each hand gesture's own channel.
 *
 * Adding a gesture means adding one entry to HAND_GESTURE_DEFINITIONS. Nothing
 * in the rendering knows what `pray` is.
 *
 * ## Hand gesture frame contract
 *
 * Every registered channel publishes the shape PrayRecognizer produces:
 *
 *   { v, t,
 *     quality: { confidence, handsPresent, degraded, reason, blockedBy, armed },
 *     track:   { kind, phase, active, value, dwell, episodeId, durationMs },
 *     features: { …criterion measurements… } | null,
 *     events:  [ { id, kind, phase, episodeId, t, strength } ] }
 *
 * `reason` is why the frame did or did not qualify, and `blockedBy` names every
 * failing criterion. Those two fields are what make the lab a diagnosis tool
 * rather than a meter — the tally below is just a histogram over them.
 *
 * @see docs/HAND_GESTURE_PRAY.md
 */

import {
    PrayRecognizer,
    PRAY_CONFIG,
    PRAY_CONTRACT_VERSION,
} from './lib/pray-recognizer.js';
import {
    makePrayPose,
    makeOpenPalmsPose,
    makeHand,
} from './lib/hand-pose-fixtures.js';
import {
    HAND_POSE_SPECS,
    HAND_POSE_IDS,
    HandPoseRecognizer,
} from './lib/hand-pose-suite.js';

/** Rolling window the lab tallies frame reasons over. */
const REASON_WINDOW = 90;
const MAX_EVENTS = 24;

const HAND_SHAPE_HINTS = {
    thumbExtension: '0 curled, 1 straight',
    indexExtension: '0 curled, 1 straight',
    middleExtension: '0 curled, 1 straight',
    ringExtension: '0 curled, 1 straight',
    pinkyExtension: '0 curled, 1 straight',
    aspect: 'not edge-on to the camera',
    thumbUpness: '+1 up, −1 down',
    spread: 'smallest adjacent fingertip gap',
    pinch: 'thumb tip to index tip',
};

/**
 * Fixture poses for each one-hand rehearsal, expressed the way the suite
 * declares them: which fingers are out. Curl 1 is fisted, 0 is straight.
 */
const POSE_REHEARSAL_CURLS = {
    openPalm: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    fist: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 },
    point: { thumb: 0.9, index: 0, middle: 1, ring: 1, pinky: 1 },
    peace: { thumb: 0.9, index: 0, middle: 0, ring: 1, pinky: 1 },
    horns: { thumb: 0.9, index: 0, middle: 1, ring: 1, pinky: 0 },
    thumbsUp: { thumb: 0, index: 1, middle: 1, ring: 1, pinky: 1 },
    thumbsDown: { thumb: 0, index: 1, middle: 1, ring: 1, pinky: 1 },
};

const FACING = { x: 0, y: 0, z: -1 };

function poseRehearsal(kind) {
    const axis = kind === 'thumbsDown' ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
    const held = makeHand({ palmDirection: FACING, axis, curl: POSE_REHEARSAL_CURLS[kind] });
    // A pose either side that clearly is NOT the target, so the rehearsal shows
    // it being entered and left rather than existing from frame one. A merely
    // "relaxed" hand will not do: a slightly curled palm facing the camera
    // still reads as fully extended in projection — the documented blind spot
    // of 2D finger extension — so an open hand is not a neutral for openPalm.
    const idleCurl = kind === 'openPalm' ? 1 : 0;
    const idle = makeHand({ palmDirection: FACING, axis: { x: 0, y: -1, z: 0 }, curl: idleCurl });
    return [
        { hands: [idle], count: 2 },
        { hands: [held], count: 6 },
        { hands: [idle], count: 3 },
    ];
}

/** Registry entries for the seven one-hand poses, generated from their specs. */
const POSE_ENTRIES = Object.fromEntries(HAND_POSE_IDS.map((kind) => {
    const spec = HAND_POSE_SPECS[kind];
    return [kind, {
        label: spec.title,
        family: 'held pose',
        version: 1,
        render: 'pose',
        hands: 1,
        channel: 'handPoses',
        // One channel carries the whole suite, so each entry picks its own slice.
        select: (payload) => payload?.[kind] ?? null,
        cue: spec.cue,
        expected: ['start', 'peak', 'release'],
        criteria: Object.keys(spec.config.criteria).map((name) => ({
            key: name,
            label: spec.criteriaLabels(name),
            hint: HAND_SHAPE_HINTS[name] ?? '',
        })),
        diagnostic: null,
        sliders: [
            { flag: `__${kind}HoldMs`, label: 'hold ms', min: 200, max: 2000, step: 50, base: spec.config.holdMs },
        ],
        switches: [],
        host: () => (typeof window === 'undefined' ? null : window.HandPoses),
        defaultConfig: spec.config,
        createRecognizer: () => new HandPoseRecognizer(spec),
        rehearsal: () => poseRehearsal(kind),
    }];
}));

export const HAND_GESTURE_DEFINITIONS = Object.freeze({
    pray: {
        label: 'Pray',
        family: 'held pose',
        version: PRAY_CONTRACT_VERSION,
        render: 'pose',
        hands: 2,
        channel: 'prayGesture',
        select: (payload) => payload,
        cue: 'Palms flat, pressed together, fingers up — held.',
        expected: ['start', 'peak', 'release'],
        criteria: [
            { key: 'separation', label: 'separation', hint: 'palm centres apart, in hand-lengths' },
            { key: 'palmOpposition', label: 'palms opposed', hint: 'veto: fails only on a clear +1' },
            { key: 'foreshortening', label: 'palms edge-on', hint: 'both turned from the camera' },
            { key: 'axisAlignment', label: 'fingers aligned', hint: 'rejects a handshake' },
            { key: 'flatness', label: 'hands flat', hint: 'rejects an interlocked clasp' },
            { key: 'uprightness', label: 'fingers up', hint: '+1 is straight up' },
        ],
        // Reported, never gated: the palm normal is mirror-sensitive, so it
        // inverts when MediaPipe mislabels handedness. Shown so a live session
        // can watch it do so.
        diagnostic: { key: 'normalDot', label: 'palm normal (not gated)' },
        sliders: [
            { flag: '__praySeparationEnter', label: 'separation enter', min: 0.4, max: 2.0, step: 0.05, base: PRAY_CONFIG.criteria.separation.enter },
            { flag: '__prayPalmOppositionEnter', label: 'palms-opposed veto', min: -0.2, max: 1, step: 0.05, base: PRAY_CONFIG.criteria.palmOpposition.enter },
            { flag: '__prayForeshorteningEnter', label: 'edge-on enter', min: 0.1, max: 1, step: 0.05, base: PRAY_CONFIG.criteria.foreshortening.enter },
            { flag: '__prayFlatnessEnter', label: 'flatness enter', min: 0.5, max: 1, step: 0.02, base: PRAY_CONFIG.criteria.flatness.enter },
            { flag: '__praySoloDriftMax', label: 'solo drift max', min: 0.2, max: 4, step: 0.1, base: PRAY_CONFIG.soloDriftMax },
            { flag: '__prayHoldMs', label: 'hold ms', min: 200, max: 2000, step: 50, base: PRAY_CONFIG.holdMs },
        ],
        switches: [
            {
                flag: '__prayOcclusionAssist',
                label: 'occlusion assist — let one still hand sustain a pose two hands started',
                base: true,
            },
        ],
        host: () => (typeof window === 'undefined' ? null : window.PrayGesture),
        defaultConfig: PRAY_CONFIG,
        createRecognizer: () => new PrayRecognizer(),
        rehearsal: () => [
            { hands: makeOpenPalmsPose(), count: 2 },
            { hands: makePrayPose(), count: 8 },
            { hands: makeOpenPalmsPose(), count: 3 },
        ],
    },

    ...POSE_ENTRIES,

    /*
     * Psychodeli+'s thumbs-up/down, shown beside the suite's own so the two can
     * be watched disagreeing. They are NOT the same gesture and should not be:
     *
     *   suite thumbsUp   reports STATE — the hand is in this shape right now.
     *                    Fires anywhere in frame, at any distance, after 500 ms.
     *   thumbConfirm     COMMITS AN ACTION — approve/reject. Also demands the
     *                    hand be centred and near the camera, holds for 1.2 s,
     *                    and latches until the pose is released.
     *
     * A commitment gesture SHOULD be harder to trigger than a readout, so the
     * divergence in strictness is deliberate. What was not deliberate, and is
     * now fixed, is that the two measured different quantities under the same
     * name — see docs/HAND_GESTURE_SUITE.md.
     */
    thumbConfirm: {
        label: 'Thumb confirm (Psychodeli)',
        family: 'commitment',
        version: 1,
        render: 'transient',
        hands: 1,
        channel: 'handPose',
        select: (payload) => (payload ? {
            charge: num(payload.thumbCharge),
            direction: num(payload.thumbDirection),
            confidence: num(payload.thumbConfidence),
            centred: !!payload.thumbCentered,
            t: num(payload.t ?? payload.timestamp),
        } : null),
        cue: 'Thumb out, four fingers curled, hand centred and close to the camera. Held 1.2 s.',
        expected: [],
        criteria: [],
        diagnostic: null,
        sliders: [
            { flag: '__thumbCurlMin', label: 'others-curled floor', min: 0.2, max: 0.9, step: 0.05, base: 0.55 },
            { flag: '__thumbExtMin', label: 'thumb-extended floor', min: 0.2, max: 0.9, step: 0.05, base: 0.45 },
            { flag: '__thumbCenterR', label: 'centre radius', min: 0.1, max: 0.5, step: 0.02, base: 0.24 },
            { flag: '__thumbProxMin', label: 'min proximity', min: 0.05, max: 0.6, step: 0.02, base: 0.22 },
            { flag: '__thumbChargeSec', label: 'hold seconds', min: 0.3, max: 3, step: 0.1, base: 1.2 },
        ],
        switches: [],
        host: () => null,
        defaultConfig: { criteria: {} },
        createRecognizer: null,
        rehearsal: null,
    },

    /*
     * A second family, and the reason the lab does not assume everything is a
     * held pose. The air-drum strike is a <80 ms transient read off raw wrist
     * velocity in `hand-pose-detector.js`; it has no dwell, no criteria and no
     * hysteresis, and it cannot use the held-pose engine. It is registered here
     * as an adapter over the detector's own published state so drumming can be
     * tested beside the poses — not reimplemented.
     *
     * It also has a hard sampling floor the poses do not: detecting a descent
     * and its deceleration needs consecutive frames inside the stroke, so the
     * throttled overlay (~2.8 Hz desktop, ~0.83 Hz mobile) will miss most hits.
     * A dedicated Hand mode is not a nicety here, it is a precondition.
     */
    strike: {
        label: 'Air drum strike',
        family: 'transient',
        version: 1,
        render: 'transient',
        hands: 1,
        channel: 'handPose',
        select: (payload) => (payload ? {
            lastStrike: payload.lastStrike ?? null,
            strikeCount: num(payload.strikeCount),
            strikeEnergy: num(payload.strikeEnergy),
            handCount: num(payload.handCount),
            // The lab measures stroke speed itself from the wrist, so it can
            // say whether you are moving fast enough rather than only that
            // nothing fired. The detector does not publish its own velocity.
            wristY: Array.isArray(payload.landmarks) ? num(payload.landmarks[0]?.y) : null,
            t: num(payload.t ?? payload.timestamp),
        } : null),
        cue: 'Sharp downward strokes, as if hitting a drum. Wrist velocity, not hand shape.',
        expected: [],
        criteria: [],
        diagnostic: null,
        sliders: [
            { flag: '__handStrikeThresh', label: 'min peak down-velocity', min: 0.005, max: 0.06, step: 0.001, base: 0.018 },
            { flag: '__handStrikeScale', label: 'velocity → intensity', min: 0.02, max: 0.2, step: 0.005, base: 0.06 },
            { flag: '__handStrikeCooldownMs', label: 'cooldown ms', min: 40, max: 400, step: 10, base: 110 },
        ],
        switches: [],
        host: () => null,
        defaultConfig: { criteria: {} },
        createRecognizer: null,
        rehearsal: null,
    },
});

export const HAND_GESTURE_IDS = Object.keys(HAND_GESTURE_DEFINITIONS);

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;
const fmt = (x, digits = 2) => num(x).toFixed(digits);

function passes(value, spec, bound) {
    return spec.dir < 0 ? value <= spec[bound] : value >= spec[bound];
}

/**
 * Run one gesture's rehearsal through a private recognizer.
 *
 * Exported so `tests/hand-gesture-lab.test.js` exercises the same sequence the
 * button does — one source of truth, as the face lab has.
 */
export function runHandRehearsal(kind, startT = 0, frameMs = 360) {
    const def = HAND_GESTURE_DEFINITIONS[kind];
    if (!def) throw new Error(`Unknown hand gesture rehearsal: ${kind}`);
    if (!def.rehearsal || !def.createRecognizer) {
        throw new Error(`${kind} is a ${def.family} and has no rehearsal`);
    }

    const recognizer = def.createRecognizer();
    const phases = [];
    const frames = [];
    let t = startT;
    for (const { hands, count } of def.rehearsal()) {
        for (let i = 0; i < count; i++) {
            const frame = recognizer.update({ t, hands, confidence: 0.9 });
            frames.push(frame);
            phases.push(...frame.events.map((event) => event.phase));
            t += frameMs;
        }
    }
    return {
        phases,
        frames,
        passed: phases.join(',') === def.expected.join(','),
    };
}

export class HandGestureLab {
    constructor() {
        this.panel = document.getElementById('hand-lab-panel');
        this.toggle = document.getElementById('hand-lab-toggle');
        if (!this.panel || !this.toggle) return;

        this.focus = HAND_GESTURE_IDS[0];
        this.live = new Map();       // kind → latest bus frame
        this.synthetic = new Map();  // kind → rehearsal frame, while one runs
        this.reasons = new Map();    // kind → rolling reason window
        this.events = [];
        this.rehearsalRun = 0;
        // Rolling wrist-speed probe for the strike card — see _probeStroke.
        this.stroke = { prevY: null, prevT: 0, peak: 0, peakAt: 0 };
        for (const kind of HAND_GESTURE_IDS) this.reasons.set(kind, []);

        this._build();
        this._buildHud();
        this._wire();
        this._subscribe();
        this._render();

        // Reading the achieved hand rate walks the latency buffers; once a
        // second is plenty, and it is the number that explains most misses.
        this._rateTimer = setInterval(() => this._renderSource(), 1000);
    }

    _build() {
        const focusButtons = HAND_GESTURE_IDS.length > 1
            ? `<div class="hlab-focus-strip" role="group" aria-label="Hand gesture focus">
                   ${HAND_GESTURE_IDS.map((kind) => `
                       <button class="hlab-focus" data-focus="${kind}">
                           ${HAND_GESTURE_DEFINITIONS[kind].label}
                       </button>`).join('')}
               </div>`
            : '';

        const cards = HAND_GESTURE_IDS.map((kind) => {
            const def = HAND_GESTURE_DEFINITIONS[kind];
            const rows = def.criteria.map(({ key, label, hint }) => `
                <li class="hlab-criterion">
                    <span class="hlab-criterion-name">${label}<em>${hint}</em></span>
                    <span class="hlab-criterion-value" data-value="${kind}:${key}">—</span>
                    <span class="hlab-criterion-bound" data-bound="${kind}:${key}">—</span>
                    <span class="hlab-chip" data-chip="${kind}:${key}">—</span>
                </li>`).join('');

            const sliders = def.sliders.map(({ flag, label, min, max, step, base }) => `
                <label class="hlab-slider">
                    <span>${label}<em data-slider-value="${flag}">${base}</em></span>
                    <input type="range" data-slider="${flag}"
                           min="${min}" max="${max}" step="${step}" value="${base}">
                </label>`).join('');

            const switches = def.switches.map(({ flag, label }) => `
                <label class="hlab-switch">
                    <input type="checkbox" data-switch="${flag}" checked>
                    <span>${label}</span>
                </label>`).join('');

            const transient = def.render === 'transient';

            // A transient has no dwell, no criteria and no lifecycle, so it gets
            // a different body rather than empty meters pretending otherwise.
            const body = transient
                ? `
                <ul class="hlab-source hlab-transient">
                    <li><span>${kind === 'strike' ? 'strikes' : 'direction'}</span><b data-strike-count="${kind}">0</b></li>
                    <li><span>${kind === 'strike' ? 'peak / needed' : 'confidence'}</span><b data-strike-last="${kind}">\u2014</b></li>
                </ul>
                <div class="hlab-gauge">
                    <span>${kind === 'strike' ? 'energy' : 'charge'}</span>
                    <div class="hlab-meter"><i data-meter="${kind}:energy"></i></div>
                    <b data-readout="${kind}:energy">0.00</b>
                </div>`
                : `
                <div class="hlab-state">
                    <span class="hlab-phase" data-phase="${kind}">idle</span>
                    <span class="hlab-episode" data-episode="${kind}"></span>
                </div>
                <div class="hlab-gauge">
                    <span>dwell</span>
                    <div class="hlab-meter"><i data-meter="${kind}:dwell"></i></div>
                    <b data-readout="${kind}:dwell">0.00</b>
                </div>
                <div class="hlab-gauge">
                    <span>value</span>
                    <div class="hlab-meter"><i data-meter="${kind}:value"></i></div>
                    <b data-readout="${kind}:value">0.00</b>
                </div>`;

            const detail = transient
                ? ''
                : `
                    <ul class="hlab-criteria">${rows}</ul>
                    ${def.diagnostic ? `
                        <p class="hlab-diagnostic">
                            <span>${def.diagnostic.label}</span>
                            <b data-diagnostic="${kind}">—</b>
                        </p>` : ''}
                    <div class="hlab-reasons">
                        <span>last ${REASON_WINDOW} frames</span>
                        <ol data-reasons="${kind}"><li class="hlab-reason-empty">nothing yet</li></ol>
                    </div>`;

            return `
            <article class="hlab-card" data-gesture="${kind}">
                <div class="hlab-card-heading">
                    <div>
                        <strong>${def.label}</strong>
                        <span class="hlab-family">${def.family} \u00b7 v${def.version}</span>
                    </div>
                    ${transient ? '' : `<button class="hlab-rehearse" data-rehearse="${kind}">rehearse</button>`}
                </div>
                <p class="hlab-cue">${def.cue}</p>
                ${body}

                <div class="hlab-detail" data-detail="${kind}">
                    <p class="hlab-warning" data-warning="${kind}" hidden></p>
                    ${detail}
                    ${switches}
                    <details class="hlab-tuning">
                        <summary>live thresholds</summary>
                        ${sliders}
                        <button data-restore="${kind}">restore defaults</button>
                    </details>
                </div>
                <code>${def.expected.length
                    ? def.expected.join(' \u2192 ')
                    : (transient && kind === 'strike'
                        ? 'no lifecycle \u2014 discrete hits'
                        : 'no lifecycle \u2014 one latched confirmation')}</code>
            </article>`;
        }).join('');

        this.panel.innerHTML = `
            <div class="hlab-header">
                <div>
                    <span class="hlab-kicker">HandGestures</span>
                    <h2>Hand gesture lab</h2>
                </div>
                <button class="hlab-close" aria-label="Close hand gesture lab">×</button>
            </div>

            <p class="hlab-intro">
                Enable <strong>Hand</strong> above. A dedicated hand mode samples
                far faster than the throttled overlay, and the rate below is the
                first thing to check when a gesture will not fire.
            </p>

            <ul class="hlab-source">
                <li><span>hands</span><b data-src-hands>0</b></li>
                <li><span>hand rate</span><b data-src-rate>—</b></li>
                <li><span>confidence</span><b data-src-conf>—</b></li>
                <li><span>frame age</span><b data-src-age>—</b></li>
            </ul>

            ${focusButtons}
            <div class="hlab-actions">
                <button data-reset>reset</button>
                <button data-clear>clear events</button>
                <button data-guided title="Cues each pose on the video and records every frame">guided run</button>
                <button data-save-log title="Download everything recorded this session">save log</button>
            </div>

            <div class="hlab-cards">${cards}</div>

            <section class="hlab-events">
                <div class="hlab-events-heading">
                    <strong>Lifecycle events</strong>
                    <span data-verdict>live observation</span>
                </div>
                <ol class="hlab-event-log" data-event-log>
                    <li class="hlab-event-empty">No events yet</li>
                </ol>
            </section>`;
    }

    /**
     * Large-type overlay on the video.
     *
     * You cannot test a hand gesture and read 10px labels at the same time —
     * performing one puts you an arm's length from the screen with both hands
     * up. The HUD carries only what you need from there.
     */
    _buildHud() {
        const host = document.getElementById('main-area');
        if (!host) return;
        this.hud = document.createElement('div');
        this.hud.id = 'hand-lab-hud';
        this.hud.hidden = true;
        this.hud.innerHTML = `
            <div class="hlab-hud-phase" data-hud-phase>idle</div>
            <div class="hlab-hud-meter"><i data-hud-meter></i></div>
            <div class="hlab-hud-note" data-hud-note>waiting for a hand</div>`;
        host.appendChild(this.hud);
    }

    _wire() {
        this.toggle.addEventListener('click', () => this._setOpen(
            this.panel.classList.contains('collapsed')
        ));
        this.panel.querySelector('.hlab-close')
            ?.addEventListener('click', () => this._setOpen(false));

        this.panel.querySelectorAll('[data-focus]').forEach((button) => {
            button.addEventListener('click', () => {
                this.focus = button.dataset.focus;
                this._render();
            });
        });
        this.panel.querySelectorAll('[data-rehearse]').forEach((button) => {
            button.addEventListener('click', () => this._rehearse(button.dataset.rehearse));
        });

        this.panel.querySelector('[data-reset]')?.addEventListener('click', () => {
            for (const kind of HAND_GESTURE_IDS) {
                HAND_GESTURE_DEFINITIONS[kind].host()?.reset?.();
                this.reasons.set(kind, []);
            }
            this.live.clear();
            this.synthetic.clear();
            this._render();
        });
        this.panel.querySelector('[data-guided]')?.addEventListener('click', () => {
            window.HandLabRecorder?.guided();
        });
        this.panel.querySelector('[data-save-log]')?.addEventListener('click', () => {
            window.HandLabRecorder?.download();
        });
        this.panel.querySelector('[data-clear]')?.addEventListener('click', () => {
            this.events = [];
            this.panel.classList.remove('hlab-rehearsal-failed');
            this._renderEvents();
        });

        this.panel.querySelectorAll('[data-switch]').forEach((input) => {
            input.addEventListener('change', () => {
                window[input.dataset.switch] = input.checked;
                this._retuneAll();
                this._render();
            });
        });

        this.panel.querySelectorAll('[data-slider]').forEach((input) => {
            input.addEventListener('input', () => {
                const flag = input.dataset.slider;
                window[flag] = Number(input.value);
                this.panel.querySelector(`[data-slider-value="${flag}"]`).textContent = input.value;
                // Config is resolved once at construction; without the retune
                // the slider would move and change nothing.
                this._retuneAll();
                this._render();
            });
        });
        this.panel.querySelectorAll('[data-restore]').forEach((button) => {
            button.addEventListener('click', () => {
                const def = HAND_GESTURE_DEFINITIONS[button.dataset.restore];
                for (const { flag, base } of def.sliders) {
                    delete window[flag];
                    const input = this.panel.querySelector(`[data-slider="${flag}"]`);
                    if (input) input.value = String(base);
                    const readout = this.panel.querySelector(`[data-slider-value="${flag}"]`);
                    if (readout) readout.textContent = String(base);
                }
                for (const { flag, base } of def.switches) {
                    delete window[flag];
                    const input = this.panel.querySelector(`[data-switch="${flag}"]`);
                    if (input) input.checked = base;
                }
                this._retuneAll();
                this._render();
            });
        });
    }

    _retuneAll() {
        for (const kind of HAND_GESTURE_IDS) {
            HAND_GESTURE_DEFINITIONS[kind].host()?.recognizer?.retune?.();
        }
    }

    _subscribe() {
        // One subscription per distinct channel: the whole pose suite rides on
        // `handPoses`, so seven poses do not mean seven subscriptions.
        const byChannel = new Map();
        for (const kind of HAND_GESTURE_IDS) {
            const { channel } = HAND_GESTURE_DEFINITIONS[kind];
            if (!byChannel.has(channel)) byChannel.set(channel, []);
            byChannel.get(channel).push(kind);
        }

        for (const [channel, kinds] of byChannel) {
            window.MotionBus?.subscribe?.(channel, (payload) => {
                for (const kind of kinds) {
                    const def = HAND_GESTURE_DEFINITIONS[kind];
                    const frame = payload ? def.select(payload) : null;
                    this.live.set(kind, frame);
                    if (kind === 'strike') this._probeStroke(frame);
                    if (frame && def.render !== 'transient') {
                        this._recordReason(kind, frame);
                        this._recordEvents(kind, frame, 'live');
                    }
                }
                if (this.synthetic.size === 0) this._render();
            });
        }
    }

    /**
     * Peak downward wrist speed, in the detector's own units.
     *
     * `_detectStrike` compares a per-frame `vy` against `__handStrikeThresh`,
     * but publishes neither, so a card built only on `strikeCount` can say
     * "nothing happened" and nothing else. Recomputing vy here from the wrist
     * the detector already broadcasts turns "no strikes" into one of three
     * distinguishable answers: no hand, hand but too slow, or fast enough and
     * still not firing.
     */
    _probeStroke(frame) {
        const probe = this.stroke;
        const y = frame?.wristY;
        if (!Number.isFinite(y)) {
            probe.prevY = null;
            return;
        }
        let interval = 0;
        if (probe.prevY !== null && frame.t > probe.prevT) {
            interval = frame.t - probe.prevT;
            const vy = y - probe.prevY;   // +ve is downward, as in the detector
            if (vy > probe.peak) {
                probe.peak = vy;
                probe.peakAt = frame.t;
            }
        }
        probe.prevY = y;
        probe.prevT = frame.t;

        // Decay so the readout reports recent effort rather than a personal
        // best — but the window has to hold several frames, and a frame is
        // 360 ms on desktop and 1.2 s on mobile. A fixed 2 s window erased the
        // peak between samples at the very rates the readout exists to explain.
        const window_ = Math.max(2000, interval * 4);
        if (frame.t - probe.peakAt > window_) probe.peak = 0;
    }

    _setOpen(open) {
        this.panel.classList.toggle('collapsed', !open);
        this.toggle.classList.toggle('active', open);
        this.toggle.setAttribute('aria-expanded', String(open));
        if (this.hud) this.hud.hidden = !open;
        if (open) this._render();
    }

    /**
     * Deterministic rehearsal through a private recognizer. Proves the lab and
     * the lifecycle; proves nothing about landmark extraction.
     */
    async _rehearse(kind) {
        const def = HAND_GESTURE_DEFINITIONS[kind];
        if (!def) return;
        const run = ++this.rehearsalRun;

        this.focus = kind;
        this.events = [];
        this.reasons.set(kind, []);
        this.panel.classList.remove('hlab-rehearsal-failed');

        const recognizer = def.createRecognizer();
        const phases = [];
        let t = 0;

        for (const { hands, count } of def.rehearsal()) {
            for (let i = 0; i < count; i++) {
                if (run !== this.rehearsalRun) return;
                const frame = recognizer.update({ t, hands, confidence: 0.9 });
                t += 360;
                this.synthetic.set(kind, frame);
                this._recordReason(kind, frame);
                phases.push(...frame.events.map((event) => event.phase));
                this._recordEvents(kind, frame, 'rehearsal');
                this._render();
                await new Promise((resolve) => setTimeout(resolve, 90));
            }
        }

        const passed = phases.join(',') === def.expected.join(',');
        this.panel.classList.toggle('hlab-rehearsal-failed', !passed);
        const verdict = this.panel.querySelector('[data-verdict]');
        if (verdict) {
            verdict.textContent = passed
                ? `${def.label} rehearsal passed`
                : `${def.label} rehearsal FAILED — ${phases.join(' → ') || 'no events'}`;
        }
        this.synthetic.delete(kind);
        this._render();
    }

    /** Tally why frames are not qualifying; the dominant reason is the diagnosis. */
    _recordReason(kind, frame) {
        const reason = frame.quality.reason === 'blocked'
            ? `blocked: ${frame.quality.blockedBy.join(' + ')}`
            : frame.quality.reason;
        const window_ = this.reasons.get(kind) || [];
        window_.push(reason);
        if (window_.length > REASON_WINDOW) window_.shift();
        this.reasons.set(kind, window_);
    }

    _recordEvents(kind, frame, source) {
        for (const event of frame.events || []) {
            this.events.unshift({
                kind,
                phase: event.phase,
                episodeId: event.episodeId,
                strength: num(event.strength),
                reason: event.reason || '',
                source,
            });
        }
        if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
        this._renderEvents();
    }

    _frameFor(kind) {
        return this.synthetic.get(kind) ?? this.live.get(kind) ?? null;
    }

    _render() {
        if (this.panel.classList.contains('collapsed')) {
            if (this.hud) this.hud.hidden = true;
            return;
        }

        this.panel.querySelectorAll('[data-focus]').forEach((button) => {
            button.classList.toggle('active', button.dataset.focus === this.focus);
        });

        for (const kind of HAND_GESTURE_IDS) {
            const def = HAND_GESTURE_DEFINITIONS[kind];
            const frame = this._frameFor(kind);
            const focused = kind === this.focus;
            const card = this.panel.querySelector(`[data-gesture="${kind}"]`);
            card.classList.toggle('focused', focused);
            this.panel.querySelector(`[data-detail="${kind}"]`).hidden = !focused;

            if (def.render === 'transient') {
                this._renderTransient(kind, frame, card, focused);
                if (focused) this._renderHud(kind, frame, []);
                continue;
            }

            const config = def.host()?.recognizers?.[kind]?.config
                || def.host()?.recognizer?.config
                || def.defaultConfig;
            const track = frame?.track;
            card.classList.toggle('active', !!track?.active);

            const phase = this.panel.querySelector(`[data-phase="${kind}"]`);
            phase.textContent = track?.phase || 'idle';
            phase.dataset.state = track?.phase || 'idle';

            this.panel.querySelector(`[data-episode="${kind}"]`).textContent = track?.active
                ? `episode ${track.episodeId} · ${Math.round(num(track.durationMs))} ms`
                : (this.synthetic.has(kind) ? 'rehearsal' : '');

            for (const key of ['dwell', 'value']) {
                const value = num(track?.[key]);
                this.panel.querySelector(`[data-meter="${kind}:${key}"]`).style.width = `${value * 100}%`;
                this.panel.querySelector(`[data-readout="${kind}:${key}"]`).textContent = fmt(value);
            }

            const bound = (track?.active || track?.phase === 'rising') ? 'exit' : 'enter';
            const blocking = [];
            for (const { key, label } of def.criteria) {
                const spec = config.criteria[key];
                const measured = frame?.features?.[key];
                const valueCell = this.panel.querySelector(`[data-value="${kind}:${key}"]`);
                const boundCell = this.panel.querySelector(`[data-bound="${kind}:${key}"]`);
                const chip = this.panel.querySelector(`[data-chip="${kind}:${key}"]`);

                boundCell.textContent = `${spec.dir < 0 ? '≤' : '≥'} ${fmt(spec[bound])}`;

                if (!Number.isFinite(measured)) {
                    valueCell.textContent = '—';
                    chip.textContent = 'no read';
                    chip.dataset.state = 'none';
                    continue;
                }
                const ok = passes(measured, spec, bound);
                if (!ok) blocking.push(label);
                valueCell.textContent = fmt(measured);
                chip.textContent = ok ? 'pass' : 'fail';
                chip.dataset.state = ok ? 'pass' : 'fail';
            }

            if (def.diagnostic) {
                const value = frame?.features?.[def.diagnostic.key];
                this.panel.querySelector(`[data-diagnostic="${kind}"]`).textContent =
                    Number.isFinite(value) ? fmt(value) : '—';
            }

            this._renderReasons(kind);
            if (focused) {
                this._renderWarning(kind, frame);
                this._renderHud(kind, frame, blocking);
            }
        }

        this._renderSource();
    }

    /** Families with no dwell, no criteria and no lifecycle of their own. */
    _renderTransient(kind, frame, card, focused) {
        const isStrike = kind === 'strike';
        // The strike reports an energy envelope; the thumb confirmation reports
        // a charge toward commitment. Both are a 0..1 bar and two numbers, so
        // one card shape serves, but the labels have to follow the source.
        const level = num(isStrike ? frame?.strikeEnergy : frame?.charge);
        const thresh = Number.isFinite(window.__handStrikeThresh) ? window.__handStrikeThresh : 0.018;
        const left = isStrike
            ? `${Math.round(num(frame?.strikeCount))}`
            : (frame?.direction > 0 ? 'up' : (frame?.direction < 0 ? 'down' : '\u2014'));
        const right = isStrike
            // Peak downward speed against the bar it has to clear. This is the
            // number that explains a card sitting at zero.
            ? (frame ? `${fmt(this.stroke.peak, 3)} / ${fmt(thresh, 3)}` : '\u2014')
            : (frame ? `${fmt(frame.confidence)}${frame.centred ? '' : ' (off-centre)'}` : '\u2014');

        card.classList.toggle('active', level > 0.05);
        this.panel.querySelector(`[data-strike-count="${kind}"]`).textContent = left;
        this.panel.querySelector(`[data-strike-last="${kind}"]`).textContent = right;
        this.panel.querySelector(`[data-meter="${kind}:energy"]`).style.width = `${level * 100}%`;
        this.panel.querySelector(`[data-readout="${kind}:energy"]`).textContent = fmt(level);
        if (!focused) return;

        const warning = this.panel.querySelector(`[data-warning="${kind}"]`);
        if (!isStrike) {
            warning.textContent = 'Psychodeli\u2019s commitment gesture, not the suite\u2019s '
                + 'thumbs-up state. Stricter on purpose: centred, near the camera, held 1.2 s, '
                + 'then latched until released.';
            warning.hidden = false;
            return;
        }

        // Three distinguishable reasons the count can sit at zero.
        const hz = window.sharedCameraManager?.getTrackingStats?.()?.achieved?.hand?.hz;
        if (!frame || num(frame.handCount) === 0) {
            warning.textContent = 'No hand tracked. Turn on Hand above and show a hand \u2014 '
                + 'strikes are read off wrist movement, so nothing is measured until one is visible.';
        } else if (this.stroke.peak < thresh) {
            warning.textContent = `Hand tracked, but the fastest downward move in the last 2 s was `
                + `${fmt(this.stroke.peak, 3)} against a ${fmt(thresh, 3)} bar. Strike harder, or lower `
                + `the threshold below.`;
        } else if (Number.isFinite(hz) && hz > 0 && hz < 10) {
            warning.textContent = `Moving fast enough, but the hand rate is ${fmt(hz, 2)} Hz. A strike `
                + `is a <80 ms transient and the detector needs the descent AND its deceleration in `
                + `consecutive frames, so most hits fall between samples. Use a dedicated Hand mode.`;
        } else {
            warning.textContent = 'Reading wrist velocity. A strike needs a fast descent followed by a '
                + 'stop \u2014 a smooth continuous sweep never registers one.';
        }
        warning.hidden = false;
        return;

    }

    _renderReasons(kind) {
        const list = this.panel.querySelector(`[data-reasons="${kind}"]`);
        if (!list) return;
        const window_ = this.reasons.get(kind) || [];
        if (window_.length === 0) {
            list.innerHTML = '<li class="hlab-reason-empty">nothing yet</li>';
            return;
        }
        const tally = new Map();
        for (const reason of window_) tally.set(reason, (tally.get(reason) || 0) + 1);
        list.innerHTML = [...tally.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => `
                <li><span>${reason}</span><b>${Math.round((count / window_.length) * 100)}%</b></li>`)
            .join('');
    }

    _renderWarning(kind, frame) {
        const warning = this.panel.querySelector(`[data-warning="${kind}"]`);
        if (!warning || !HAND_GESTURE_DEFINITIONS[kind].expected.length) return;
        const config = HAND_GESTURE_DEFINITIONS[kind].host()?.recognizer?.config
            || HAND_GESTURE_DEFINITIONS[kind].defaultConfig;
        const hz = window.sharedCameraManager?.getTrackingStats?.()?.achieved?.hand?.hz;

        let message = '';
        if (this.synthetic.has(kind)) {
            message = 'Rehearsal running — synthetic landmarks, live bus untouched.';
        } else if (!frame) {
            message = `No hand frames yet. Turn on Hand above and ${this._waitingNote(HAND_GESTURE_DEFINITIONS[kind])}.`;
        } else if (frame.quality.reason === 'one-hand-armed') {
            message = 'One hand only — sustaining while it holds still.';
        } else if (frame.quality.reason === 'one-hand-moving') {
            message = 'The remaining hand is moving, so the pose is treated as breaking.';
        } else if (frame.quality.reason === 'coasting') {
            message = 'No read this frame — holding the last one through the nil tolerance.';
        } else if (frame.quality.reason === 'frame-collapsed') {
            message = 'Two hands reported but a palm frame collapsed — landmarks unusable.';
        } else if (Number.isFinite(hz) && hz > 0 && (hz * num(config.holdMs)) / 1000 < 2) {
            message = `Hand rate ${fmt(hz, 2)} Hz gives under 2 samples per hold — raise hold ms or use a dedicated Hand mode.`;
        } else if (frame.quality.handsPresent === 0) {
            message = 'No hand tracked.';
        } else if (HAND_GESTURE_DEFINITIONS[kind].hands === 2
            && frame.quality.handsPresent < 2 && !frame.quality.armed) {
            message = 'Only one hand tracked, and nothing armed. This gesture needs both to start.';
        }
        warning.textContent = message;
        warning.hidden = !message;
    }

    /**
     * The HUD always describes the FOCUSED gesture. Everything it says is
     * derived from that entry — a fist asking for both hands, or an idle
     * message left over from whatever was focused before, is the bug this
     * shape exists to prevent.
     */
    _renderHud(kind, frame, blocking) {
        if (!this.hud) return;
        const open = !this.panel.classList.contains('collapsed');
        this.hud.hidden = !open;
        if (!open) return;

        const def = HAND_GESTURE_DEFINITIONS[kind];
        const phaseEl = this.hud.querySelector('[data-hud-phase]');
        const meter = this.hud.querySelector('[data-hud-meter]');
        const noteEl = this.hud.querySelector('[data-hud-note]');

        if (def.render === 'transient') {
            const level = num(kind === 'strike' ? frame?.strikeEnergy : frame?.charge);
            phaseEl.textContent = level > 0.05 ? def.label.toUpperCase() : 'idle';
            phaseEl.dataset.state = level > 0.05 ? 'holding' : 'idle';
            meter.style.width = `${level * 100}%`;
            noteEl.textContent = !frame
                ? this._waitingNote(def)
                : (kind === 'strike'
                    ? (num(frame.handCount) === 0
                        ? this._waitingNote(def)
                        : `${Math.round(num(frame.strikeCount))} hits · peak ${fmt(this.stroke.peak, 3)}`)
                    : (frame.direction === 0 ? 'no thumb pose' : `charging ${fmt(level)}`));
            return;
        }

        const track = frame?.track;
        const phase = track?.phase || 'idle';
        phaseEl.textContent = track?.active ? def.label.toUpperCase() : phase;
        phaseEl.dataset.state = phase;
        meter.style.width = `${num(track?.dwell) * 100}%`;

        const present = num(frame?.quality?.handsPresent);
        let note;
        if (!frame) note = this._waitingNote(def);
        else if (track?.active) note = `held ${(num(track.durationMs) / 1000).toFixed(1)}s`;
        else if (present === 0) note = this._waitingNote(def);
        else if (def.hands === 2 && present < 2) note = 'need both hands';
        else if (blocking.length === 0) note = 'holding…';
        else note = `blocked by ${blocking.join(' + ')}`;
        noteEl.textContent = note;
    }

    _waitingNote(def) {
        return def.hands === 2 ? 'show both hands' : 'show a hand';
    }

    _renderSource() {
        if (this.panel.classList.contains('collapsed')) return;
        // Read the detector's own state rather than the focused gesture's
        // frame: the transient family carries no `quality` block at all, and
        // hands/confidence describe the camera, not any one gesture.
        const hand = window.MotionBus?.state?.hand ?? null;
        const hz = window.sharedCameraManager?.getTrackingStats?.()?.achieved?.hand?.hz;

        this.panel.querySelector('[data-src-hands]').textContent =
            String(Math.round(num(hand?.handCount)));
        this.panel.querySelector('[data-src-rate]').textContent =
            Number.isFinite(hz) && hz > 0 ? `${fmt(hz, 2)} Hz` : '\u2014';
        this.panel.querySelector('[data-src-conf]').textContent =
            hand ? fmt(hand.confidence) : '\u2014';

        const read = HAND_GESTURE_DEFINITIONS[this.focus].host()?.read?.();
        this.panel.querySelector('[data-src-age]').textContent =
            read?.fresh ? `${Math.round(num(read.ageMs))} ms` : (read ? 'stale' : '\u2014');
    }

    _renderEvents() {
        const log = this.panel.querySelector('[data-event-log]');
        if (!log) return;
        if (this.events.length === 0) {
            log.innerHTML = '<li class="hlab-event-empty">No events yet</li>';
            return;
        }
        log.innerHTML = this.events.map((event) => `
            <li data-source="${event.source}">
                <span class="hlab-event-kind">${event.kind}</span>
                <span class="hlab-event-phase" data-state="${event.phase}">${event.phase}</span>
                <span>ep ${event.episodeId}</span>
                <span>${fmt(event.strength)}</span>
                <span class="hlab-event-note">${event.reason || event.source}</span>
            </li>`).join('');
    }
}
