/**
 * CameraMachine — the ONE explicit ownership state machine for the shared camera.
 *
 * Pure logic: no DOM, no timers, no MediaPipe, no globals read. Events in,
 * { state, effects } out. SharedCameraManager is the driver that executes
 * effects (acquire stream, attach detectors, stop) and dispatches completion
 * events back. Because this module is pure it is unit-testable and recorded
 * lifecycle rings can be REPLAYED through it as regression fixtures
 * (docs/TODO.md "Camera Controls — FULL REFACTOR", filed 2026-06-11).
 *
 * Model:
 *   desired  — the user's wish: { head, body, hand } booleans. This IS the
 *              public `permissions` object. Mutated only by TOGGLE/SET_DESIRED.
 *   live     — what is actually attached right now: { primary, overlay }.
 *              primary ∈ 'head' | 'body' | 'hand' | null. primary 'hand' =
 *              dedicated hand mode; overlay = hand running alongside head/body.
 *   phase    — idle | acquiring | running | switching | stopping.
 *   target   — the config the in-flight effect is producing.
 *
 * Arbitration (head/body exclusivity, hand overlay-vs-dedicated, the hand
 * three-state cycle) lives in deriveTarget() + the TOGGLE reducer — as
 * transitions, not scattered flags. One coherence FIX vs the old code:
 * promoting hand to dedicated now clears desired.head/body, so the
 * permission flags always tell the truth about what runs.
 *
 * Race armor:
 *   - dispatch() is synchronous: mashed toggles mutate `desired` immediately;
 *     phases in flight absorb them and completions reconcile to the LATEST
 *     desired. No effect is ever aborted mid-flight (the old retry-poisoning
 *     class: a hung acquire poisoning every later attempt).
 *   - every issued acquire/apply/stop effect carries opSeq. Completions must
 *     echo it; stale completions (late async stragglers) are rejected. The
 *     driver must also skip executing a QUEUED effect whose opSeq no longer
 *     matches state.opSeq (it was superseded before it ran).
 *
 * Events:
 *   {type:'TOGGLE', mode}                          user toggle (^ & * keys, buttons)
 *   {type:'SET_DESIRED', desired:{head,body,hand}} programmatic (autostart, electron)
 *   {type:'AUTO_SWITCH', to:'head'|'body'}         confidence policy decision
 *   {type:'ACQUIRE_OK', achieved, opSeq, degraded?, reasonTag?}
 *   {type:'ACQUIRE_FAIL', errClass, message, opSeq}
 *   {type:'APPLY_OK', achieved, opSeq, degraded?, reasonTag?}
 *   {type:'APPLY_FAIL', errClass, message, opSeq, reasonTag?}
 *   {type:'STOP_OK', opSeq, reasonTag?}
 *   {type:'FATAL', message?}                        fatal frame error → full stop
 *   {type:'HAND_FATAL', message?}                   hand-only fatal → drop hand
 *
 * Effects (returned to the driver):
 *   {do:'acquire', target, opSeq}            cold start: stream + models + attach
 *   {do:'apply', from, to, opSeq, reasonTag} live reconfigure (no stream bounce)
 *   {do:'stop', from, opSeq, reasonTag}      teardown stream + loop
 *   {do:'emitModeChange', from, to, reason}  legacy cameraModeChange event
 *   {do:'notifyError', stage, errClass, message, modes} user-visible failure
 */
(function () {
    'use strict';

    const NONE = Object.freeze({ primary: null, overlay: false });

    // Declared legal transitions — which events each phase may receive.
    // Commands (TOGGLE/SET_DESIRED) and policy signals (AUTO_SWITCH, FATAL,
    // HAND_FATAL) are legal EVERYWHERE: they originate from async sources
    // (keys, confidence timers, frame-loop stragglers) that cannot know the
    // phase, so the machine absorbs them — acting only when settled.
    // Completions are strict: each is legal only in the phase whose effect
    // produced it, and must echo the current opSeq.
    const ANYTIME = ['TOGGLE', 'SET_DESIRED', 'AUTO_SWITCH', 'FATAL', 'HAND_FATAL'];
    const LEGAL = Object.freeze({
        idle:      ANYTIME,
        acquiring: ANYTIME.concat(['ACQUIRE_OK', 'ACQUIRE_FAIL']),
        running:   ANYTIME,
        switching: ANYTIME.concat(['APPLY_OK', 'APPLY_FAIL']),
        stopping:  ANYTIME.concat(['STOP_OK']),
    });

    function freshDesired() { return { head: false, body: false, hand: false }; }

    function initialState() {
        return {
            phase: 'idle',
            live: { primary: null, overlay: false },
            target: { primary: null, overlay: false },
            desired: freshDesired(),
            preferredPrimary: 'head',
            opSeq: 0,
        };
    }

    /**
     * Pure arbitration: desired flags → target config.
     * head+body both desired → preferredPrimary runs (auto-switch flips it);
     * hand desired → overlay when a head/body primary exists, dedicated when alone.
     */
    function deriveTarget(desired, preferredPrimary) {
        let primary = null;
        if (desired.head && desired.body) primary = (preferredPrimary === 'body') ? 'body' : 'head';
        else if (desired.head) primary = 'head';
        else if (desired.body) primary = 'body';
        else if (desired.hand) primary = 'hand';
        const overlay = !!desired.hand && (primary === 'head' || primary === 'body');
        return { primary, overlay };
    }

    function configsEqual(a, b) { return a.primary === b.primary && a.overlay === b.overlay; }
    function isNone(cfg) { return cfg.primary === null; }
    function configIncludes(cfg, mode) {
        if (mode === 'hand') return cfg.overlay || cfg.primary === 'hand';
        return cfg.primary === mode;
    }

    /** Legacy mode label for the cameraModeChange event ('head'|'body'|null). */
    function legacyMode(cfg) {
        return (cfg.primary === 'head' || cfg.primary === 'body') ? cfg.primary : null;
    }

    /** Emit the legacy mode-change event only when the legacy view changed. */
    function pushModeChange(effects, fromCfg, toCfg, reason) {
        const from = legacyMode(fromCfg);
        const to = legacyMode(toCfg);
        if (from !== to || reason === 'hand-dedicated') {
            effects.push({ do: 'emitModeChange', from, to, reason });
        }
    }

    /**
     * From a settled phase (idle/running), compare live vs derived target and
     * issue at most ONE effect. In-flight phases never call this — their
     * completion handlers do, which is what makes mashing converge.
     */
    function reconcileSettled(state, effects, reasonTag) {
        const target = deriveTarget(state.desired, state.preferredPrimary);
        state.target = target;
        if (state.phase === 'idle') {
            if (isNone(target)) return;
            state.opSeq++;
            state.phase = 'acquiring';
            effects.push({ do: 'acquire', target, opSeq: state.opSeq });
            return;
        }
        if (state.phase !== 'running') return; // in-flight: absorb, converge later
        if (configsEqual(target, state.live)) return;
        state.opSeq++;
        if (isNone(target)) {
            state.phase = 'stopping';
            effects.push({ do: 'stop', from: state.live, opSeq: state.opSeq, reasonTag: reasonTag || 'disabled' });
        } else {
            state.phase = 'switching';
            effects.push({ do: 'apply', from: state.live, to: target, opSeq: state.opSeq, reasonTag: reasonTag || 'manual' });
        }
    }

    /** TOGGLE semantics, including the hand three-state cycle. Returns reasonTag. */
    function applyToggle(state, mode) {
        const d = state.desired;
        if (mode === 'hand') {
            if (!d.hand) {
                d.hand = true;                    // off → overlay (or dedicated if alone)
                return 'manual';
            }
            if (d.head || d.body) {
                // overlay → dedicated: hand takes the camera, head/body release it.
                // Flags stay coherent (old code left permissions.head=true with a
                // dead head detector — the UI lied).
                d.head = false; d.body = false;
                return 'hand-dedicated';
            }
            d.hand = false;                       // dedicated → off
            return 'disabled';
        }

        d[mode] = !d[mode];

        // preferredPrimary bookkeeping mirrors the old observable behavior:
        // enabling the second of head/body does NOT switch the running one.
        if (d.head && d.body) {
            if (state.live.primary === 'head' || state.live.primary === 'body') {
                state.preferredPrimary = state.live.primary;
            } else if (state.target.primary === 'head' || state.target.primary === 'body') {
                state.preferredPrimary = state.target.primary; // mid-acquire mash
            } else {
                state.preferredPrimary = (mode === 'head') ? 'body' : 'head'; // the already-on one
            }
        } else if (d.head) {
            state.preferredPrimary = 'head';
        } else if (d.body) {
            state.preferredPrimary = 'body';
        }
        return (!d.head && !d.body && !d.hand) ? 'disabled' : 'manual';
    }

    /** Drop desired flags whose addition just failed (manual paths only). */
    function trimFailedAdditions(state, failedTarget) {
        ['head', 'body', 'hand'].forEach((mode) => {
            if (state.desired[mode] && !configIncludes(state.live, mode) && configIncludes(failedTarget, mode)) {
                state.desired[mode] = false;
            }
        });
    }

    /** Drop desired flags the executor reported as degraded (e.g. hands model failed). */
    function trimDegraded(state, effects, ev, stage) {
        if (!Array.isArray(ev.degraded)) return;
        ev.degraded.forEach((mode) => {
            if (state.desired[mode]) state.desired[mode] = false;
        });
        if (ev.degraded.length) {
            effects.push({
                do: 'notifyError', stage, errClass: 'model',
                message: ev.degradedMessage || `${ev.degraded.join('+')} unavailable`,
                modes: ev.degraded.slice(),
            });
        }
    }

    /**
     * The reducer. Mutates `state`, returns effects. Illegal events and stale
     * completions return [] and push onto `violations` instead of corrupting
     * state — defensive in production, assertable in tests.
     */
    function step(state, ev, violations) {
        const effects = [];
        const legal = LEGAL[state.phase] || [];
        if (!legal.includes(ev.type)) {
            violations.push({ phase: state.phase, event: ev.type, kind: 'illegal-event' });
            return effects;
        }
        const isCompletion = /^(ACQUIRE|APPLY|STOP)_/.test(ev.type);
        if (isCompletion && ev.opSeq !== state.opSeq) {
            violations.push({ phase: state.phase, event: ev.type, kind: 'stale-completion', got: ev.opSeq, want: state.opSeq });
            return effects;
        }

        switch (ev.type) {
            case 'TOGGLE': {
                if (ev.mode !== 'head' && ev.mode !== 'body' && ev.mode !== 'hand') break;
                const reasonTag = applyToggle(state, ev.mode);
                reconcileSettled(state, effects, reasonTag);
                break;
            }

            case 'SET_DESIRED': {
                const d = ev.desired || {};
                state.desired = { head: !!d.head, body: !!d.body, hand: !!d.hand };
                if (state.desired.head && !state.desired.body) state.preferredPrimary = 'head';
                else if (state.desired.body && !state.desired.head) state.preferredPrimary = 'body';
                const off = !state.desired.head && !state.desired.body && !state.desired.hand;
                reconcileSettled(state, effects, off ? 'disabled' : 'manual');
                break;
            }

            case 'AUTO_SWITCH': {
                if (ev.to !== 'head' && ev.to !== 'body') break;
                if (!(state.desired.head && state.desired.body)) break; // policy guard
                if (state.live.primary === ev.to) break;
                state.preferredPrimary = ev.to;
                reconcileSettled(state, effects, 'auto-switch');
                break;
            }

            case 'ACQUIRE_OK': {
                const prev = state.live;
                state.live = { primary: ev.achieved.primary, overlay: !!ev.achieved.overlay };
                state.phase = 'running';
                trimDegraded(state, effects, ev, 'acquire');
                pushModeChange(effects, prev, state.live, ev.reasonTag || 'manual');
                reconcileSettled(state, effects); // converge if desired moved mid-flight
                break;
            }

            case 'ACQUIRE_FAIL': {
                // Acquire only runs from idle — nothing was live, so the honest
                // rollback is all-off. The machine never caches the failure:
                // the very next TOGGLE issues a fresh acquire (no poisoning).
                const failed = state.target;
                state.live = { primary: null, overlay: false };
                state.phase = 'idle';
                state.desired = freshDesired();
                state.target = { primary: null, overlay: false };
                effects.push({
                    do: 'notifyError', stage: 'acquire',
                    errClass: ev.errClass || 'other', message: ev.message || '',
                    modes: ['head', 'body', 'hand'].filter(m => configIncludes(failed, m)),
                });
                break;
            }

            case 'APPLY_OK': {
                const prev = state.live;
                state.live = { primary: ev.achieved.primary, overlay: !!ev.achieved.overlay };
                state.phase = 'running';
                trimDegraded(state, effects, ev, 'apply');
                pushModeChange(effects, prev, state.live, ev.reasonTag || 'manual');
                reconcileSettled(state, effects);
                break;
            }

            case 'APPLY_FAIL': {
                // Executor contract: apply is atomic — failable steps (model
                // loads) happen before any detach, so `live` is still running.
                const failedTarget = state.target;
                state.phase = 'running';
                if (ev.reasonTag === 'auto-switch') {
                    // Old behavior: a failed auto-switch keeps both permissions;
                    // cooldown stops thrash. Revert preferredPrimary so the
                    // reconciler converges on what's live instead of re-issuing
                    // the failing apply forever; a later AUTO_SWITCH may retry.
                    if (state.live.primary === 'head' || state.live.primary === 'body') {
                        state.preferredPrimary = state.live.primary;
                    }
                } else {
                    trimFailedAdditions(state, failedTarget);
                }
                effects.push({
                    do: 'notifyError', stage: 'apply',
                    errClass: ev.errClass || 'other', message: ev.message || '',
                    modes: ['head', 'body', 'hand'].filter(m => !configIncludes(state.live, m) && configIncludes(failedTarget, m)),
                });
                reconcileSettled(state, effects);
                break;
            }

            case 'STOP_OK': {
                const prev = state.live;
                state.live = { primary: null, overlay: false };
                state.phase = 'idle';
                state.target = { primary: null, overlay: false };
                pushModeChange(effects, prev, state.live, ev.reasonTag || 'disabled');
                reconcileSettled(state, effects); // re-acquire if re-toggled during teardown
                break;
            }

            case 'FATAL': {
                state.desired = freshDesired();
                if (state.phase === 'running' || state.phase === 'switching') {
                    state.opSeq++;
                    state.phase = 'stopping';
                    state.target = { primary: null, overlay: false };
                    effects.push({ do: 'stop', from: state.live, opSeq: state.opSeq, reasonTag: 'fatal' });
                }
                break;
            }

            case 'HAND_FATAL': {
                state.desired.hand = false;
                if (state.phase === 'running') reconcileSettled(state, effects, 'hand-fatal');
                break;
            }
        }
        return effects;
    }

    /**
     * Create a machine instance. dispatch() is SYNCHRONOUS — call it from
     * anywhere, execute the returned effects on a serialized queue.
     */
    function create() {
        const state = initialState();
        const violations = [];
        const log = [];
        let seq = 0;

        return {
            state,       // read-only by convention; only dispatch() mutates
            violations,  // illegal events / stale completions land here
            log,         // last 50 transitions (ring); ground truth for replay

            dispatch(ev) {
                const fromPhase = state.phase;
                const effects = step(state, ev, violations);
                log.push({
                    seq: seq++,
                    event: ev.type + (ev.mode ? ':' + ev.mode : '') + (ev.to ? ':' + ev.to : ''),
                    from: fromPhase,
                    to: state.phase,
                    live: state.live.primary + (state.live.overlay ? '+hand' : ''),
                    desired: (state.desired.head ? 'H' : '') + (state.desired.body ? 'B' : '') + (state.desired.hand ? 'h' : '') || '-',
                    effects: effects.map(e => e.do),
                });
                if (log.length > 50) log.shift();
                return effects;
            },
        };
    }

    /**
     * Replay a recorded event sequence through a fresh machine. Used by the
     * regression suite: a clean session of aggressive toggle-mashing must
     * produce zero violations.
     */
    function replay(events) {
        const m = create();
        events.forEach(ev => m.dispatch(ev));
        return {
            ok: m.violations.length === 0,
            violations: m.violations,
            log: m.log,
            state: m.state,
        };
    }

    const api = { create, replay, deriveTarget, configsEqual, configIncludes, NONE, LEGAL };
    if (typeof window !== 'undefined') window.CameraMachine = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
