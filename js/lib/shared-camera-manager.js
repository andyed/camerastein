/**
 * Shared Camera Manager
 *
 * Manages a single camera stream shared between HeadBobDetector and BodyMotionDetector.
 * Pre-loads both MediaPipe models for instant switching between modes.
 *
 * Benefits:
 * - Single camera permission request
 * - Instant switching between head/body modes (no reload delay)
 * - Both models stay resident (~7MB total)
 *
 * @see docs/BODY_MOTION_SPEC.md
 * @see docs/HEAD_BOB_DETECTION.md
 */

// Camera feature flags — which video-tracking modes are available. iOS v1 (the Capacitor
// native app) ships HEAD-ONLY: hand + body are deferred to keep camera init light and the UX
// focused. Desktop + web keep all three. Read by togglePermission / setModeDesired so EVERY
// activation path (keyboard, consumer surface, permalink autostart, Electron) honors it from
// one choke point — and the gated detectors never start, so their MediaPipe models never load.
// Override by setting window.CameraFeatureFlags before camera init.
if (typeof window !== 'undefined' && !window.CameraFeatureFlags) {
    const _cap = window.Capacitor;
    const _isNativeApp = !!(_cap && (typeof _cap.isNativePlatform === 'function'
        ? _cap.isNativePlatform()
        : (_cap.platform && _cap.platform !== 'web')));
    window.CameraFeatureFlags = { head: true, hand: !_isNativeApp, body: !_isNativeApp };
}

class SharedCameraManager {
    constructor() {
        this.videoElement = null;
        this.stream = null;
        this.active = false;
        this.preferredDeviceId = null;
        try {
            this.preferredDeviceId = localStorage.getItem('camera.preferredDeviceId') || null;
        } catch (_) {
            this.preferredDeviceId = null;
        }

        // Model references (stay loaded once initialized)
        this.faceMesh = null;
        this.pose = null;
        this.hands = null;
        this.faceMeshLoaded = false;
        this.poseLoaded = false;
        this.handsLoaded = false;

        // Ownership truth lives in the CameraMachine (js/lib/camera-machine.js):
        // activeMode / _handPrimaryMode / _handOverlayActive / permissions are
        // GETTERS over machine state — transitions, not scattered flags
        // (docs/TODO.md "Camera Controls — FULL REFACTOR"). A missing
        // CameraMachine throws here: louder and safer than a half-alive camera
        // (UI rows hide themselves when this singleton is absent).
        this._machine = window.CameraMachine.create();
        // Serialized effect queue — one acquire/apply/stop at a time, mash-proof.
        this._chain = Promise.resolve();

        // Hand frame-pacing state (overlay = throttled, dedicated = full rate)
        this._handOverlayCallback = null;
        this._handFrameCounter = 0;
        this._handSuspended = false; // set on hand frame errors until the machine detaches hands
        const resourcePolicy = window.CameraResourcePolicy;
        // Process hands every Nth frame in overlay mode. Mobile gets a slower
        // rate to preserve battery; the policy also catches desktop-UA iPads.
        this._handFrameSkip = resourcePolicy?.handOverlayFrameSkip(navigator)
            ?? (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 12 : 6);

        // Callbacks for frame processing
        this.onFaceMeshResults = null;
        this.onPoseResults = null;

        // Frame processing
        this.animationFrameId = null;
        this.lastFrameTime = 0;
        // Mobile devices get lower base FPS to reduce GPU contention with main render loop.
        // 20fps is fine for desktop but causes frame drops/crashes on Android tablets.
        this._isMobile = resourcePolicy?.isMobileDevice(navigator)
            ?? /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        this._baseFPS = resourcePolicy?.baseFPS(navigator) ?? (this._isMobile ? 12 : 20);
        this.targetFPS = this._baseFPS;
        this._resourceConstrained = false;
        this._lastAdaptiveCheck = 0; // Timestamp for periodic FPS adaptation
        this.isManualMode = false; // Tracks if user explicitly chose a mode

        // Loading state
        this.loading = false;
        this.loadPromise = null;

        // Auto-switch state (only active if user has tried both modes)
        this.hasUsedHead = false;
        this.hasUsedBody = false;
        this.autoSwitchEnabled = false;  // True once both modes used

        // Confidence tracking for auto-switch
        this.currentConfidence = 1.0;
        this.lowConfidenceStart = null;  // Timestamp when confidence dropped
        this.lastSwitchTime = 0;         // Prevent rapid switching

        // Auto-switch config
        this.autoSwitchConfig = {
            confidenceThreshold: 0.3,    // Below this = low confidence
            sustainedLowMs: 2000,        // Must be low for this long to switch
            cooldownMs: 5000,            // Wait this long after switch before allowing another
            enabled: true,               // Master enable (was false)
            bodyProbeIntervalMs: 3000    // How often to peek at pose while in face mode
        };

        // Periodic body probe state — detects arm-waving while in face mode.
        // The probe is POLICY (signal analysis), not ownership: it never flips
        // machine state itself; a confirmed probe dispatches AUTO_SWITCH.
        this._lastBodyProbeTime = 0;
        this.isProbingBody = false;
        this.probeStartTime = 0;
        this._probeIsAutoSwitch = false;

        // NOTE: `permissions` (the desired {head,body,hand} config) is a getter
        // over machine state — see below. There is no flag object to drift.

        // Dependencies injected via init() after all scripts load
        this._deps = {};
    }

    // ------------------------------------------------------------------
    // Machine-backed views — the single source of truth for ownership.
    // Legacy readers (EQ panel, history overlay, motion ladder, Electron
    // bridge, Camerastein) keep working against these exact names.
    // ------------------------------------------------------------------

    /** Desired config — the user's toggles. Read-only by convention. */
    get permissions() { return this._machine.state.desired; }

    /** Live primary mode: 'head' | 'body' | null (hand-dedicated reads null). */
    get activeMode() {
        const p = this._machine.state.live.primary;
        return (p === 'head' || p === 'body') ? p : null;
    }

    /** True when hands own the camera at full rate (dedicated mode). */
    get _handPrimaryMode() { return this._machine.state.live.primary === 'hand'; }

    /** True when hand processing runs at all (overlay or dedicated). */
    get _handOverlayActive() {
        const l = this._machine.state.live;
        return l.overlay || l.primary === 'hand';
    }

    /** Machine phase: idle | acquiring | running | switching | stopping. */
    get phase() { return this._machine.state.phase; }

    /**
     * Inject dependencies. Called from motion-init.js after all singletons exist.
     * Fallback: _dep() returns window[name] if init() hasn't been called yet.
     */
    init(deps = {}) {
        this._deps = deps;
    }

    /** Safe dependency access with window fallback */
    _dep(name) { return this._deps[name] || window[name]; }

    // ------------------------------------------------------------------
    // Machine driver: synchronous dispatch, serialized effect execution.
    //
    // User commands (TOGGLE/SET_DESIRED) dispatch IMMEDIATELY so mashed keys
    // mutate the desired config with zero latency; the machine absorbs them
    // while an acquire/apply/stop is in flight and reconciles on completion.
    // Policy signals (AUTO_SWITCH/FATAL/HAND_FATAL) dispatch QUEUED so they
    // serialize behind whatever is in flight. Every queued effect carries
    // opSeq; superseded effects are skipped, and effect impls re-check opSeq
    // before mutating the world — no stale async straggler can act.
    // ------------------------------------------------------------------

    /** Dispatch + ring-log a machine event; returns its effects. */
    _dispatchLogged(ev) {
        const before = this._machine.state.phase;
        const effects = this._machine.dispatch(ev);
        const s = this._machine.state;
        const want = (s.desired.head ? 'H' : '') + (s.desired.body ? 'B' : '') + (s.desired.hand ? 'h' : '');
        this._lifecycle('machine', `${ev.type}${ev.mode ? ':' + ev.mode : ''}${ev.to ? ':' + ev.to : ''}${ev.errClass ? ':' + ev.errClass : ''} ${before}→${s.phase} live=${s.live.primary || 'none'}${s.live.overlay ? '+hand' : ''} want=${want || '-'}`);
        return effects;
    }

    /** Append effects to the serialized chain (FIFO, one at a time). */
    _enqueueEffects(effects) {
        (effects || []).forEach((eff) => {
            this._chain = this._chain
                .then(() => this._execEffect(eff))
                .catch((err) => {
                    this._dep('debugManager')?.warn?.('Camera effect error:', err?.message || String(err));
                });
        });
    }

    /** Resolve when the chain (including follow-ups it spawned) drains. */
    async _settle() {
        let tail;
        do { tail = this._chain; await tail; } while (tail !== this._chain);
    }

    /** User command: immediate dispatch, then wait for the world to settle. */
    _command(ev) {
        this._enqueueEffects(this._dispatchLogged(ev));
        return this._settle().then(() => this._syncUiState());
    }

    /** Policy signal: dispatch serialized behind any in-flight effect. */
    _commandQueued(ev) {
        this._chain = this._chain
            .then(() => { this._enqueueEffects(this._dispatchLogged(ev)); })
            .catch(() => { });
        return this._settle().then(() => this._syncUiState());
    }

    /** Completion event from inside an effect impl (same-link dispatch). */
    _completion(ev) {
        this._enqueueEffects(this._dispatchLogged(ev));
    }

    async _execEffect(eff) {
        if ((eff.do === 'acquire' || eff.do === 'apply' || eff.do === 'stop')
            && eff.opSeq !== this._machine.state.opSeq) {
            this._lifecycle('skip-superseded', `${eff.do} op${eff.opSeq}`);
            return;
        }
        switch (eff.do) {
            case 'acquire': return this._effectAcquire(eff);
            case 'apply': return this._effectApply(eff);
            case 'stop': return this._effectStop(eff);
            case 'emitModeChange': return this._emitModeChangeEvent(eff.from, eff.to, eff.reason);
            case 'notifyError': return this._notifyError(eff);
            default: return undefined;
        }
    }

    /**
     * Toggle desired state for a mode — THE public entry point (keys, EQ/strip
     * buttons, Electron menu all land here via CameraCommands).
     * @param {'head' | 'body' | 'hand'} mode
     */
    async togglePermission(mode) {
        if (mode !== 'head' && mode !== 'body' && mode !== 'hand') return;
        if (window.CameraFeatureFlags && window.CameraFeatureFlags[mode] === false) {
            window.debugManager?.info?.('[Camera] ' + mode + ' tracking disabled by feature flag — ignoring toggle');
            return;
        }
        await this._command({ type: 'TOGGLE', mode });
        if (mode === 'hand') this._showHandStatus();
    }

    /**
     * Programmatic set-to-state (permalink autostart, Electron, detector shims).
     * Resolves { ok } — ok=false means the request failed and was rolled back,
     * which callers like the permalink auto-retry rely on.
     * @param {'head' | 'body' | 'hand'} mode
     * @param {boolean} on
     */
    async setModeDesired(mode, on) {
        if (mode !== 'head' && mode !== 'body' && mode !== 'hand') return { ok: false };
        if (window.CameraFeatureFlags && window.CameraFeatureFlags[mode] === false) {
            // Feature-flagged off (e.g. hand/body on iOS v1). Treat as a settled no-op so
            // permalink/Electron auto-retry doesn't loop trying to enable a disabled mode.
            return { ok: true, noop: true, disabled: true };
        }
        if (!!this._machine.state.desired[mode] === !!on) return { ok: true, noop: true };
        await this._command({ type: 'TOGGLE', mode });
        return { ok: !!this._machine.state.desired[mode] === !!on };
    }

    /** Post-settle UI/registry/electron sync — desired flags are the truth. */
    _syncUiState() {
        const d = this._machine.state.desired;
        const reg = this._dep('commandRegistry');
        if (reg?.activeEffects) {
            reg.activeEffects['Head Tracking'] = !!d.head;
            reg.activeEffects['Body Tracking'] = !!d.body;
            reg.activeEffects['Hand Tracking'] = !!d.hand;
        }
        const both = !!(d.head && d.body);
        if (both && !this.autoSwitchEnabled) {
            this.hasUsedHead = true;
            this.hasUsedBody = true;
            this.autoSwitchEnabled = true;
            this._dep('debugManager')?.logTransition('camera', 'auto-switch-eligible');
        }
        if (this.autoSwitchConfig.enabled !== both) this.setAutoSwitch(both);
        if (typeof this._dep('electronBridge')?.reportEffectState === 'function') {
            try { this._dep('electronBridge').reportEffectState(); } catch (_) { }
        }
    }

    /** Hand toggle status toast (parity with the pre-machine UX). */
    _showHandStatus() {
        const status = this.permissions.hand ? 'ON' : 'OFF';
        const rate = this._handPrimaryMode ? 'dedicated' : 'overlay';
        const primaryLabel = this.activeMode || (this._handPrimaryMode ? 'hand' : 'off');
        this._dep('commandRegistry')?.showParameterIndicator?.(
            `🖐️ Hand Tracking: ${status} (${rate}, ${primaryLabel})`
        );
    }

    /** User-visible failure surfaced by the machine (rollback already done). */
    _notifyError(eff) {
        const labels = (eff.modes || []).map(m => m === 'head' ? 'Head' : m === 'body' ? 'Body' : 'Hand');
        const what = labels.length ? labels.join('+') : 'Camera';
        this._dep('debugManager')?.warn?.(`Camera ${eff.stage} failed (${eff.errClass}): ${eff.message}`);
        this._dep('commandRegistry')?.showParameterIndicator?.(
            `❌ ${what} tracking failed${eff.errClass === 'denied' ? ' (permission denied)' : ''} — toggle to retry`
        );
    }

    async listVideoInputs() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            return [];
        }

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d && d.kind === 'videoinput');
        } catch (_) {
            return [];
        }
    }

    getPreferredDeviceId() {
        return this.preferredDeviceId;
    }

    async setPreferredDeviceId(deviceId) {
        const nextId = deviceId || null;
        if (this.preferredDeviceId === nextId) {
            return;
        }

        this.preferredDeviceId = nextId;
        try {
            if (nextId) localStorage.setItem('camera.preferredDeviceId', nextId);
            else localStorage.removeItem('camera.preferredDeviceId');
        } catch (_) { }

        if (!this.activeMode) {
            return;
        }

        const mode = this.activeMode;
        const callback = this._getCallbackForMode(mode);

        this._stopStream();

        try {
            await this._startStream();
        } catch (err) {
            this._dep('debugManager')?.warn?.('Camera switch failed:', err?.message || String(err));
            throw err;
        }

        if (callback) {
            if (mode === 'head') {
                this.onFaceMeshResults = callback;
            } else if (mode === 'body') {
                this.onPoseResults = callback;
            }
        }
    }

    /**
     * Get the results callback for a given mode from the detector singletons.
     * This avoids relying on stored callbacks that get nulled during stopMode().
     * @param {'head' | 'body'} mode
     * @returns {Function|null}
     */
    _getCallbackForMode(mode) {
        if (mode === 'head') return this._dep('headDetector')?._onResults || null;
        if (mode === 'body') return this._dep('bodyDetector')?._onResults || null;
        return null;
    }

    /**
     * Emit a cameraModeChange event to the audio reactivity bus (and DOM for backward compat).
     * Camera transitions are instant + certain — no hysteresis needed.
     * @param {string|null} from - Previous mode ('head' | 'body' | null)
     * @param {string|null} to - New mode ('head' | 'body' | null)
     * @param {'manual' | 'auto-switch' | 'disabled'} reason
     */
    _emitModeChangeEvent(from, to, reason) {
        const payload = {
            from,
            to,
            reason,
            handOverlay: this._handOverlayActive,
            userEnergy: window.MotionBus?.state?.body?.energyLevel || window.MotionBus?.state?.rhythm?.energyLevel || 0,
            resistance: window.__skewMotionResistance || 0,
            t: performance.now()
        };

        // Bus event for AE consumption
        if (this._dep('audioBus')?.emit) {
            this._dep('audioBus').emit('cameraModeChange', payload);
        }

        // DOM event for backward compat
        window.dispatchEvent(new CustomEvent('camera-mode-switch', { detail: payload }));

        this._dep('debugManager')?.logTransition?.('camera', 'mode-change', { from: from || 'off', to: to || 'off', reason });
    }

    // ------------------------------------------------------------------
    // Effect implementations — the imperative arms of the machine.
    // acquire = cold start (stream + models + attach); apply = live
    // reconfigure with NO stream bounce; stop = teardown (models cached).
    // Each re-checks opSeq before touching the world so a superseded op
    // can never act on stale intent.
    // ------------------------------------------------------------------

    /** Cold start toward `target` from idle. */
    async _effectAcquire(eff) {
        const target = eff.target;
        const degraded = [];
        try {
            const needsFacePose = target.primary === 'head' || target.primary === 'body';
            if (needsFacePose) {
                if (!this.active) await this.initialize();
            } else {
                // Hand-only fast path (preserved): no face/pose model loads.
                if (!this.isAvailable()) {
                    const e = new Error('Camera not available on this device');
                    e._errClass = 'no-device';
                    throw e;
                }
                this.active = true;
            }

            await this._startStream();
            await this._ensureModelsFor(target);

            if (target.overlay || target.primary === 'hand') {
                const ok = await this._ensureHands();
                if (!ok) {
                    if (target.primary === 'hand') {
                        const e = new Error('Hand tracking model failed to load');
                        e._errClass = 'model';
                        throw e;
                    }
                    degraded.push('hand'); // primary survives, hand wish gets trimmed
                }
            }

            // Superseded while acquiring? Don't attach stale intent — the
            // superseding effect is queued right behind us.
            if (eff.opSeq !== this._machine.state.opSeq) {
                this._lifecycle('abort-superseded', `acquire op${eff.opSeq}`);
                return;
            }

            const achieved = { primary: target.primary, overlay: target.overlay && !degraded.includes('hand') };
            this._attachConfig({ primary: null, overlay: false }, achieved, eff.reasonTag);
            this._completion({
                type: 'ACQUIRE_OK', achieved, opSeq: eff.opSeq,
                ...(degraded.length ? { degraded } : {})
            });
        } catch (err) {
            this._stopStream();
            if (this.animationFrameId) {
                cancelAnimationFrame(this.animationFrameId);
                this.animationFrameId = null;
            }
            this._completion({
                type: 'ACQUIRE_FAIL', opSeq: eff.opSeq,
                errClass: this._classifyError(err),
                message: err?.message || String(err)
            });
        }
    }

    /** Live reconfigure from → to. Failable steps run BEFORE any detach. */
    async _effectApply(eff) {
        const { from, to } = eff;
        const degraded = [];
        try {
            if (to.primary === 'head' || to.primary === 'body') {
                if (!this.active) await this.initialize();
                await this._ensureModelsFor(to);
            }
            const wantHand = to.overlay || to.primary === 'hand';
            const hadHand = from.overlay || from.primary === 'hand';
            if (wantHand && !hadHand) {
                const ok = await this._ensureHands();
                if (!ok) {
                    if (to.primary === 'hand') {
                        const e = new Error('Hand tracking model failed to load');
                        e._errClass = 'model';
                        throw e;
                    }
                    degraded.push('hand');
                }
            }
            await this._startStream(); // no-op while the stream lives; heals a dead one

            if (eff.opSeq !== this._machine.state.opSeq) {
                this._lifecycle('abort-superseded', `apply op${eff.opSeq}`);
                return;
            }

            const achieved = { primary: to.primary, overlay: to.overlay && !degraded.includes('hand') };
            this._attachConfig(from, achieved, eff.reasonTag);
            this._completion({
                type: 'APPLY_OK', achieved, opSeq: eff.opSeq, reasonTag: eff.reasonTag,
                ...(degraded.length ? { degraded } : {})
            });
        } catch (err) {
            // Atomic contract: nothing was detached — `from` is still running.
            this._completion({
                type: 'APPLY_FAIL', opSeq: eff.opSeq, reasonTag: eff.reasonTag,
                errClass: this._classifyError(err),
                message: err?.message || String(err)
            });
        }
    }

    /** Teardown: detach consumers, stop loop + stream. Models stay cached. */
    async _effectStop(eff) {
        this._attachConfig(eff.from, { primary: null, overlay: false }, eff.reasonTag);
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.isManualMode = false;
        this.isProbingBody = false;
        this._probeIsAutoSwitch = false;
        this._stopStream();
        this._dep('debugManager')?.logTransition('camera', 'paused', 'models-cached');
        if (eff.reasonTag === 'fatal') this._unloadModels(); // pre-machine fatal path = full shutdown
        this._completion({ type: 'STOP_OK', opSeq: eff.opSeq, reasonTag: eff.reasonTag === 'fatal' ? 'disabled' : eff.reasonTag });
    }

    /**
     * Reconfigure live consumers from one config to another. Synchronous and
     * infallible by design (model loads happened earlier): detector hooks,
     * result callbacks, FPS pacing, frame loop. Detectors are pure consumers —
     * _activate/_deactivate are the ONLY lifecycle calls they receive.
     */
    _attachConfig(from, to, reasonTag) {
        const fromHB = (from.primary === 'head' || from.primary === 'body') ? from.primary : null;
        const toHB = (to.primary === 'head' || to.primary === 'body') ? to.primary : null;

        if (fromHB && fromHB !== toHB) {
            this._detectorFor(fromHB)?._deactivate?.();
            if (fromHB === 'head') this.onFaceMeshResults = null;
            else this.onPoseResults = null;
        }
        if (toHB) {
            this._detectorFor(toHB)?._activate?.();
            const cb = this._getCallbackForMode(toHB);
            if (toHB === 'head') { this.onFaceMeshResults = cb; this.hasUsedHead = true; }
            else { this.onPoseResults = cb; this.hasUsedBody = true; }
        }

        const fromHand = from.overlay || from.primary === 'hand';
        const toHand = to.overlay || to.primary === 'hand';
        if (fromHand && !toHand) {
            this._handOverlayCallback = null;
            this._handFrameCounter = 0;
            this._dep('handDetector')?._deactivate?.();
            this._dep('debugManager')?.logTransition?.('hand', 'overlay-stopped');
        } else if (toHand && !fromHand) {
            this._handOverlayCallback = this._dep('handDetector')?._onResults || null;
            this._handFrameCounter = 0;
            this._dep('handDetector')?._activate?.();
            this._dep('debugManager')?.logTransition?.('hand', 'overlay-started', { frameSkip: this._handFrameSkip });
        }
        this._handSuspended = false;

        // FPS pacing: overlay sharing costs ~15%; solo/dedicated runs at base.
        // Transient render pressure is layered on top of this stable config.
        const hasOverlay = !!(toHand && toHB);
        this.targetFPS = window.CameraResourcePolicy?.targetFPS(
            this._baseFPS,
            hasOverlay,
            this._resourceConstrained
        ) ?? (hasOverlay ? Math.max(5, Math.round(this._baseFPS * 0.85)) : this._baseFPS);

        // Confidence/auto-switch bookkeeping on primary change (pre-machine
        // startMode parity: manual switches refresh the cooldown, auto doesn't).
        if (fromHB !== toHB && toHB) {
            this.currentConfidence = 1.0;
            this.lowConfidenceStart = null;
            this.lastBodyActivity = null;
            this.isManualMode = reasonTag !== 'auto-switch';
            if (reasonTag !== 'auto-switch') this.lastSwitchTime = performance.now();
            this._dep('debugManager')?.logTransition('camera', 'mode-changed', {
                mode: toHB,
                switchType: reasonTag === 'auto-switch' ? 'auto-switch' : 'manual switch',
                manual: this.isManualMode
            }, { minIntervalMs: 300 });
        }

        if ((toHB || toHand) && !this.animationFrameId) this._startFrameLoop();
    }

    _detectorFor(mode) {
        return mode === 'head' ? this._dep('headDetector')
            : mode === 'body' ? this._dep('bodyDetector')
                : null;
    }

    /**
     * Ensure the primary's model is loaded, with one delayed re-attempt before
     * failing (the 2026-05-27 model-race retry, relocated — and unlike the old
     * detector-layer retry, this one actually re-runs the load).
     */
    async _ensureModelsFor(target) {
        const need = target.primary === 'head' ? 'face' : target.primary === 'body' ? 'pose' : null;
        if (!need) return;
        const loaded = () => (need === 'face' ? this.faceMeshLoaded : this.poseLoaded);
        if (loaded()) return;
        this._lifecycle('model-retry', need);
        await new Promise(r => setTimeout(r, 1500));
        if (need === 'face') {
            this.faceMesh = await this._loadFaceMesh();
            this.faceMeshLoaded = !!this.faceMesh;
        } else {
            this.pose = await this._loadPose();
            this.poseLoaded = !!this.pose;
        }
        if (!loaded()) {
            const e = new Error(need === 'face' ? 'Face Mesh model not available' : 'Pose model not available');
            e._errClass = 'model';
            throw e;
        }
    }

    /** Lazy-load the hands model (first ^ press). Returns success boolean. */
    async _ensureHands() {
        if (this.handsLoaded && this.hands) return true;
        this._dep('commandRegistry')?.showParameterIndicator?.('Loading Hand Tracking...', true);
        this.hands = await this._loadHands();
        this.handsLoaded = !!this.hands;
        return this.handsLoaded;
    }

    /** Error taxonomy for machine rollback decisions + user messaging. */
    _classifyError(err) {
        if (err?._errClass) return err._errClass;
        const details = [err?.name, err?.message, String(err)].filter(Boolean).join(' | ').toLowerCase();
        if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
            || details.includes('permission denied') || details.includes('notallowederror')
            || details.includes('denied')) return 'denied';
        if (err?.name === 'NotFoundError' || /requested device not found/i.test(err?.message || '')) return 'no-device';
        if (/metadata never arrived/i.test(err?.message || '')) return 'timeout';
        if (/not available|not loaded/i.test(err?.message || '')) return 'model';
        return 'other';
    }

    /** Unload all models (fatal teardown / explicit shutdown). */
    _unloadModels() {
        this.onFaceMeshResults = null;
        this.onPoseResults = null;
        if (this._dep('MediaPipeLoader')) this._dep('MediaPipeLoader').unload();
        if (this._dep('PoseLoader')) this._dep('PoseLoader').unload();
        if (this._dep('HandsLoader')) this._dep('HandsLoader').unload();
        this.faceMesh = null;
        this.pose = null;
        this.hands = null;
        this.faceMeshLoaded = false;
        this.poseLoaded = false;
        this.handsLoaded = false;
        this.active = false;
        this.lastFrameTime = 0;
    }

    /**
     * Check if camera is available
     */
    isAvailable() {
        if (!navigator.mediaDevices?.getUserMedia) {
            this._dep('debugManager')?.warn?.('SharedCameraManager: getUserMedia not supported');
            return false;
        }

        // Check WebGL (required by MediaPipe)
        if (!SharedCameraManager._webglAvailable) {
            try {
                const c = document.createElement('canvas');
                SharedCameraManager._webglAvailable = !!(c.getContext('webgl2') || c.getContext('webgl'));
            } catch (_) {
                SharedCameraManager._webglAvailable = false;
            }
        }
        if (!SharedCameraManager._webglAvailable) {
            this._dep('debugManager')?.warn?.('SharedCameraManager: WebGL not available');
            return false;
        }

        return true;
    }

    /**
     * Initialize camera and load both models
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.active) return;

        if (this.loading) {
            return this.loadPromise;
        }

        this.loading = true;
        this.loadPromise = this._doInitialize();

        try {
            await this.loadPromise;
        } catch (err) {
            // 2026-06-11: a failed init left the persistent "Loading Face Tracking..."
            // indicator up forever and the failure invisible (console.warn is suppressed
            // here) — the user-facing half of the stuck-startup bug. Replace it with a
            // visible, non-persistent failure message; the retry path is a fresh
            // Shift+7 (loading/loadPromise are cleared below, so it actually retries).
            this._lifecycle('initialize-failed', err?.message || String(err));
            try {
                this._dep('commandRegistry')?.showParameterIndicator?.(
                    `📷 Camera failed: ${err?.message || 'unknown error'} — toggle tracking to retry`, false);
            } catch (_) { }
            throw err;
        } finally {
            this.loading = false;
            this.loadPromise = null;
        }
    }

    _isFatalFrameError(error) {
        const details = [
            error?.name,
            error?.message,
            error?.stack,
            String(error)
        ]
            .filter(Boolean)
            .join(' | ')
            .toLowerCase();

        if (!details) {
            return false;
        }

        return (
            details.includes('abort(') ||
            details.includes('graph has errors') ||
            details.includes('calculatorgraph::run() failed') ||
            details.includes('roi width and height must be > 0') ||
            details.includes('input_frames_gpu was not ok') ||
            details.includes('teximage2d: no video') ||
            details.includes('framebuffer is incomplete')
        );
    }

    // Camera lifecycle ring (2026-06-11): "the whole camera toggle state is buggy as
    // hell" — every camera report this week was diagnosed by inference because dumps
    // carried no transition history. Every lifecycle moment now lands here (cap 80)
    // and exports in the debug dump (cameraLifecycle). Additive; Camerastein-safe.
    _lifecycle(event, detail) {
        try {
            this.lifecycleLog = this.lifecycleLog || [];
            this.lifecycleLog.push({
                t: +((typeof performance !== 'undefined' ? performance.now() : 0) / 1000).toFixed(1),
                event, ...(detail ? { detail } : {})
            });
            if (this.lifecycleLog.length > 80) this.lifecycleLog.shift();
        } catch (_) { }
    }

    async _doInitialize() {
        this._lifecycle('initialize');
        this._dep('debugManager')?.logTransition('camera', 'initializing');
        const startTime = performance.now();

        if (!this.isAvailable()) {
            throw new Error('Camera not available on this device');
        }

        // Load models sequentially to avoid locateFile callback conflicts
        // (MediaPipe models share global state, parallel loading causes wrong CDN paths)
        this._dep('debugManager')?.logTransition('camera', 'model-load-facemesh', null, { minIntervalMs: 300 });
        if (!this.faceMeshLoaded && this._dep('commandRegistry')?.showParameterIndicator) {
            this._dep('commandRegistry').showParameterIndicator('Loading Face Tracking...', true);
        }
        this.faceMesh = await this._loadFaceMesh();
        this.faceMeshLoaded = !!this.faceMesh;

        // Body tracking is NOT shipped on the native build (head-only v1) and the pose model
        // isn't bundled there (build-web.mjs ships face_landmarker.task only), so preloading it
        // on native just 404s and spams fetch retries. Skip it — head tracking is unaffected, and
        // body already doesn't work on native, so this is no behaviour change (just less noise).
        // Web/desktop still preload pose as before.
        if (!(typeof window !== 'undefined' && window.__PSYDELI_NATIVE_BUILD)) {
            this._dep('debugManager')?.logTransition('camera', 'model-load-pose', null, { minIntervalMs: 300 });
            if (!this.poseLoaded && this._dep('commandRegistry')?.showParameterIndicator) {
                this._dep('commandRegistry').showParameterIndicator('Loading Body Tracking...', true);
            }
            this.pose = await this._loadPose();
            this.poseLoaded = !!this.pose;
        }

        this.active = true;
        this._lifecycle('models-ready');

        const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
        this._dep('debugManager')?.logTransition('camera', 'ready', {
            loadSeconds: Number(loadTime),
            faceMesh: this.faceMeshLoaded,
            pose: this.poseLoaded
        }, {
            minIntervalMs: 300
        });
    }

    async _startStream() {
        if (this.stream && this.videoElement) {
            return;
        }

        this._lifecycle('stream-starting');
        this._dep('debugManager')?.logTransition('camera', 'stream-starting');

        const deviceInputs = await this.listVideoInputs();
        const deviceIds = (Array.isArray(deviceInputs) ? deviceInputs : [])
            .map(d => d?.deviceId)
            .filter(Boolean);

        const uniqueDeviceIds = [];
        const seen = new Set();
        if (this.preferredDeviceId) {
            uniqueDeviceIds.push(this.preferredDeviceId);
            seen.add(this.preferredDeviceId);
        }
        deviceIds.forEach(id => {
            if (!seen.has(id)) {
                seen.add(id);
                uniqueDeviceIds.push(id);
            }
        });

        // Android (esp. Mali GPUs in a Capacitor WebView) shares GPU memory between the camera
        // textures, MediaPipe, and the main WebGL2 visualization context. Cap capture at 320×240
        // there to cut texture pressure (MediaPipe downscales for inference anyway) — part of
        // preventing the camera-on → main-context-loss blank screen. Full 640×480 elsewhere.
        const _isAndroid = /Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
        const _camW = _isAndroid ? 320 : 640, _camH = _isAndroid ? 240 : 480;

        const streamAttempts = [];
        uniqueDeviceIds.forEach(deviceId => {
            streamAttempts.push({
                constraints: {
                    video: {
                        deviceId: { exact: deviceId },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId
            });
        });

        streamAttempts.push(
            {
                constraints: {
                    video: {
                        facingMode: { ideal: 'user' },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId: null
            },
            {
                constraints: {
                    video: {
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId: null
            },
            { constraints: { video: true }, deviceId: null }
        );

        let lastError = null;
        let lastNotFound = false;
        let preferredWasInvalid = false;

        for (let i = 0; i < streamAttempts.length; i++) {
            const attempt = streamAttempts[i];
            try {
                this.stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);

                this.videoElement = document.createElement('video');
                this.videoElement.srcObject = this.stream;
                this.videoElement.playsInline = true;
                this.videoElement.muted = true;
                this.videoElement.autoplay = true;
                this.videoElement.setAttribute('autoplay', '');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.style.position = 'fixed';
                this.videoElement.style.left = '-9999px';
                this.videoElement.style.top = '0';
                this.videoElement.style.width = '1px';
                this.videoElement.style.height = '1px';
                this.videoElement.style.opacity = '0';
                this.videoElement.style.pointerEvents = 'none';

                if (!this.videoElement.parentNode && document.body) {
                    document.body.appendChild(this.videoElement);
                }

                await new Promise((resolve, reject) => {
                    // 2026-06-11: TIMEOUT added — this wait had no failure path, and a
                    // stream that opens but never delivers metadata (camera half-held by
                    // another app/tab, post-sleep camera zombie) parked it FOREVER. With
                    // initialize() caching loadPromise, one hang poisoned every retry
                    // until reload — the month-old "stuck in waiting for" bug. A
                    // rejection here flows into the attempt loop's existing catch
                    // (stream stopped, next constraint attempt tried, errors surfaced).
                    // COLD-START GRACE (same day, second field report): the session's
                    // FIRST camera open on macOS can exceed 8s (sensor wake + Continuity
                    // Camera enumeration) — the first '&' press always failed while the
                    // second found warm hardware. The cold session's FIRST attempt gets
                    // 20s; fallback attempts and warmed sessions get the snappy 8s, so a
                    // true zombie still fails in bounded time (~44s worst case, once).
                    const metaMs = (!this._metaWarmedUp && i === 0) ? 20000 : 8000;
                    const metaTimeout = setTimeout(() => {
                        reject(new Error(`Camera stream metadata never arrived (${metaMs / 1000}s) — device busy or zombie stream`));
                    }, metaMs);
                    this.videoElement.onloadedmetadata = () => {
                        clearTimeout(metaTimeout);
                        this._metaWarmedUp = true;
                        const playPromise = this.videoElement.play();
                        if (playPromise && typeof playPromise.then === 'function') {
                            playPromise.then(resolve).catch(reject);
                        } else {
                            resolve();
                        }
                    };
                });

                await new Promise((resolve, reject) => {
                    const start = performance.now();
                    const timeoutMs = 5000;

                    const checkReady = () => {
                        if (!this.videoElement) {
                            reject(new Error('Camera video element unavailable'));
                            return;
                        }

                        const hasDimensions = this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0;
                        const hasDecodedFrame = this.videoElement.currentTime > 0 || this.videoElement.readyState >= 3;

                        if (hasDimensions && hasDecodedFrame) {
                            resolve();
                            return;
                        }

                        if (performance.now() - start >= timeoutMs) {
                            reject(new Error('Camera stream started but produced no valid frames (0x0)'));
                            return;
                        }

                        requestAnimationFrame(checkReady);
                    };

                    checkReady();
                });

                if (attempt.deviceId) {
                    if (this.preferredDeviceId && attempt.deviceId !== this.preferredDeviceId) {
                        preferredWasInvalid = true;
                    }
                    this.preferredDeviceId = attempt.deviceId;
                    try {
                        localStorage.setItem('camera.preferredDeviceId', attempt.deviceId);
                    } catch (_) { }
                } else if (preferredWasInvalid) {
                    try {
                        localStorage.removeItem('camera.preferredDeviceId');
                    } catch (_) { }
                    this.preferredDeviceId = null;
                }

                this._lifecycle('stream-ready', `${this.videoElement.videoWidth}x${this.videoElement.videoHeight} attempt ${i + 1}`);
                this._dep('debugManager')?.logTransition('camera', 'stream-ready', {
                    width: this.videoElement.videoWidth,
                    height: this.videoElement.videoHeight,
                    currentTime: Number(this.videoElement.currentTime || 0)
                }, {
                    minIntervalMs: 300
                });

                return;
            } catch (err) {
                lastError = err;
                this._lifecycle('attempt-failed', `${i + 1}/${streamAttempts.length}: ${err?.message || err?.name || String(err)}`);
                const errorDetails = [err?.name, err?.message, String(err)]
                    .filter(Boolean)
                    .join(' | ')
                    .toLowerCase();
                const isNotFound = err?.name === 'NotFoundError' || /Requested device not found/i.test(err?.message || '');
                const isPermissionDenied = (
                    err?.name === 'NotAllowedError' ||
                    err?.name === 'PermissionDeniedError' ||
                    errorDetails.includes('permission denied') ||
                    errorDetails.includes('notallowederror') ||
                    errorDetails.includes('denied')
                );
                const isNoFrames = /produced no valid frames/i.test(err?.message || '');
                // 2026-06-11: the metadata timeout must be a FALLBACK-class error —
                // unclassified errors abort the whole pass below, so attempt 1's
                // timeout never even tried the remaining constraints.
                const isMetaTimeout = /metadata never arrived/i.test(err?.message || '');
                // OverconstrainedError: a constraint no device can satisfy — almost always the
                // exact-deviceId FIRST attempt against a stale localStorage preferredDeviceId, or a
                // deviceId Chromium won't honour with { exact } (seen on Electron/macOS: camera never
                // activated because attempt 1 aborted the whole ladder). MUST be fallback-class so the
                // ladder falls through to facingMode → size-only → { video:true } (which cannot
                // over-constrain) instead of throwing on attempt 1. Andy 2026-07-04.
                const isOverconstrained = err?.name === 'OverconstrainedError'
                    || errorDetails.includes('overconstrained');

                this._stopStream();
                lastNotFound = isNotFound;

                if (isPermissionDenied) {
                    this._dep('debugManager')?.logTransition('camera', 'permission-denied', {
                        attempt: i + 1,
                        totalAttempts: streamAttempts.length,
                        name: err?.name || 'UnknownError',
                        message: err?.message || 'Camera permission denied'
                    }, {
                        minIntervalMs: 300
                    });
                    this._dep('debugManager')?.warn?.(
                        'Camera permission denied. Check macOS Settings > Privacy & Security > Camera and ensure this app is allowed.'
                    );
                    throw err;
                }

                if ((isNotFound || isNoFrames || isOverconstrained) && attempt.deviceId && attempt.deviceId === this.preferredDeviceId) {
                    try {
                        localStorage.removeItem('camera.preferredDeviceId');
                    } catch (_) { }
                    this.preferredDeviceId = null;
                }

                if (!(isNotFound || isNoFrames || isMetaTimeout || isOverconstrained) || i === streamAttempts.length - 1) {
                    this._dep('debugManager')?.logTransition('camera', 'stream-failed', {
                        attempt: i + 1,
                        totalAttempts: streamAttempts.length,
                        name: err?.name || 'UnknownError',
                        message: err?.message || String(err)
                    }, {
                        minIntervalMs: 300
                    });
                    throw err;
                }

                this._dep('debugManager')?.logTransition('camera', 'stream-fallback', {
                    attempt: i + 2,
                    reason: err?.message || err?.name || 'NotFoundError'
                }, {
                    minIntervalMs: 300
                });
            }
        }

        if (!this.stream) {
            if (lastNotFound && this.preferredDeviceId) {
                try {
                    localStorage.removeItem('camera.preferredDeviceId');
                } catch (_) { }
                this.preferredDeviceId = null;
            }
            throw lastError || new Error('Failed to acquire camera stream');
        }
    }

    _stopStream() {
        if (this.stream || this.videoElement) this._lifecycle('stream-stopped');
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.srcObject = null;
            if (this.videoElement.parentNode) {
                this.videoElement.parentNode.removeChild(this.videoElement);
            }
            this.videoElement = null;
        }

    }

    /**
     * Get frame source for MediaPipe processing.
     *
     * Passes the <video> element directly to MediaPipe instead of copying
     * each frame to an intermediate canvas. MediaPipe's .send({ image })
     * accepts HTMLVideoElement natively, which:
     * - Eliminates a drawImage() call per frame (CPU + GPU savings)
     * - Avoids allocating a persistent offscreen canvas (~1.2MB at 640x480)
     * - Reduces GPU memory pressure on mobile (fixes Android tablet crashes)
     * - Lets MediaPipe handle its own texture upload path (more efficient)
     */
    _getFrameSource() {
        if (!this.videoElement) {
            return null;
        }

        const width = this.videoElement.videoWidth || 0;
        const height = this.videoElement.videoHeight || 0;
        if (width <= 0 || height <= 0) {
            return null;
        }

        // MediaPipe accepts <video> elements directly — no canvas copy needed
        return this.videoElement;
    }

    /**
     * Load Face Mesh model
     */
    async _loadFaceMesh() {
        try {
            const faceMesh = await this._dep('MediaPipeLoader').load();
            faceMesh.onResults((results) => {
                const faces = results?.multiFaceLandmarks || [];
                const landmarks = faces[0];
                const bus = this._dep('MotionBus') || window.MotionBus;
                bus?.emit?.('faceLandmarks', landmarks ? {
                    landmarks,
                    allFaces: faces,
                    topology: null,
                    source: 'mediapipe-legacy',
                    imageSize: {
                        width: Number(this.videoElement?.videoWidth) || 0,
                        height: Number(this.videoElement?.videoHeight) || 0,
                    },
                    t: performance.now(),
                } : null);
                if (this.activeMode === 'head' && this.onFaceMeshResults) {
                    this.onFaceMeshResults(results);
                }
            });
            return faceMesh;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Face Mesh:', e.message);
            return null;
        }
    }

    /**
     * Load Pose model
     */
    async _loadPose() {
        try {
            const pose = await this._dep('PoseLoader').load();
            pose.onResults((results) => {
                // Allow results if explicitly in Body Mode OR if we are Probing Body for activity
                if ((this.activeMode === 'body' || this.isProbingBody) && this.onPoseResults) {
                    this.onPoseResults(results);
                }
            });
            return pose;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Pose:', e.message);
            return null;
        }
    }

    /**
     * Load Hands model (lazy — only called on first ^ press).
     */
    async _loadHands() {
        try {
            if (!this._dep('HandsLoader')) {
                throw new Error('HandsLoader not available');
            }
            const hands = await this._dep('HandsLoader').load();
            hands.onResults((results) => {
                if (this._handOverlayActive && this._handOverlayCallback) {
                    this._handOverlayCallback(results);

                    // Feed debug canvas if enabled
                    if (this._dep('handDetector')?.drawDebug) {
                        this._dep('handDetector').drawDebug(results);
                    }
                }
            });
            return hands;
        } catch (e) {
            this._dep('debugManager')?.warn?.('Failed to load Hands:', e.message);
            return null;
        }
    }

    /**
     * DEPRECATED shims — hand lifecycle is a machine transition now. Kept
     * callable for Camerastein-era external code; HandPoseDetector no longer
     * calls these.
     */
    async _startHandOverlay(_resultsCallback) {
        return this.setModeDesired('hand', true);
    }

    _stopHandOverlay() {
        this.setModeDesired('hand', false);
    }

    /**
     * DEPRECATED shim — mode startup is a machine transition now. The callback
     * argument is ignored: result callbacks are fetched from the detector
     * singletons at attach time (_getCallbackForMode).
     * @param {'head' | 'body'} mode
     */
    async startMode(mode, _resultsCallback, _isAutoSwitch = false) {
        if (mode !== 'head' && mode !== 'body') return;
        await this.setModeDesired(mode, true);
    }

    // ------------------------------------------------------------------
    // Body probe — POLICY, not ownership. While head runs with auto-switch
    // armed, short pose bursts check for real arm movement; a confirmed
    // burst dispatches AUTO_SWITCH('body') into the machine. The probe
    // never flips detector or machine state by itself.
    // ------------------------------------------------------------------

    /**
     * Begin a probing window: route pose results to the body detector so its
     * state populates, auto-revert after the window if nothing significant.
     * Prevents shoulder micro-movements from stealing the camera while seated.
     * @param {boolean} isAutoSwitch - confidence-triggered vs periodic peek
     * @param {number} [windowMs] - probe duration (default 500 auto / 1000 manual)
     */
    _beginBodyProbe(isAutoSwitch, windowMs) {
        if (this.isProbingBody) return;
        if (!this.permissions.head || !this.permissions.body) return;
        if (this.phase !== 'running' || this.activeMode !== 'head') return;
        if (!this.poseLoaded || !this.pose) return;
        const probeTimeout = windowMs || (isAutoSwitch ? 500 : 1000);
        this._dep('debugManager')?.info?.(`👀 Peeking Body Mode (${isAutoSwitch ? 'auto' : 'manual'}, ${probeTimeout}ms window)...`);
        this.isProbingBody = true;
        this.probeStartTime = performance.now();
        this._probeIsAutoSwitch = isAutoSwitch;
        this.onPoseResults = this._getCallbackForMode('body');

        setTimeout(() => {
            if (!this.isProbingBody) return;
            this._dep('debugManager')?.info?.('❌ Peek failed: No significant body action. Reverting.');
            this._probeRevert();
        }, probeTimeout);
    }

    /** Probe window closed without a switch: clear pose leakage, set cooldown. */
    _probeRevert() {
        this.isProbingBody = false;
        this._probeIsAutoSwitch = false;
        this.lowConfidenceStart = null;
        this.lastSwitchTime = performance.now();
        if (this.activeMode !== 'body') {
            this.onPoseResults = null;
            // Payload contract: probe-leaked body state must not linger as a
            // zombie on the bus. Null means null.
            window.MotionBus?.emit('bodyMotion', null);
        }
    }

    /** Probe confirmed real body action: commit the switch via the machine. */
    _commitBodyProbe(wasAutoSwitch) {
        this.isProbingBody = false;
        this._probeIsAutoSwitch = false;
        this._dep('debugManager')?.info?.(`✅ Peek confirmed: Switching to Body Mode! (${wasAutoSwitch ? 'auto' : 'manual'})`);
        this._commandQueued({ type: 'AUTO_SWITCH', to: 'body' });
    }

    /**
     * DEPRECATED shim — stops the current primary mode via the machine.
     * (Pre-machine this also silently killed the stream out from under a
     * running hand overlay — one of the zombie sources. Hand now survives
     * a primary-mode stop, exactly as the arbitration table says it should.)
     */
    stopMode() {
        const mode = this.activeMode;
        if (mode) this.setModeDesired(mode, false);
    }

    /**
     * Full shutdown: all modes off, stream stopped, models unloaded.
     */
    async shutdown() {
        await this._command({ type: 'SET_DESIRED', desired: { head: false, body: false, hand: false } });
        this._unloadModels();
        this._dep('debugManager')?.logTransition('camera', 'shutdown');
    }

    /**
     * Frame processing loop
     */
    _startFrameLoop() {
        const processFrame = async () => {
            if (!this.activeMode && !this._handOverlayActive) {
                // No active mode and no overlay — stop loop.
                // But if permissions are still on, keep polling so toggling works
                // without needing to restart the loop from scratch.
                if (this.permissions.head || this.permissions.body) {
                    this.animationFrameId = requestAnimationFrame(processFrame);
                }
                return;
            }
            if (!this.videoElement) {
                this.animationFrameId = requestAnimationFrame(processFrame);
                return;
            }

            if (
                this.videoElement.readyState < 2 ||
                this.videoElement.videoWidth <= 0 ||
                this.videoElement.videoHeight <= 0 ||
                (this.videoElement.currentTime <= 0 && this.videoElement.readyState < 3)
            ) {
                this.animationFrameId = requestAnimationFrame(processFrame);
                return;
            }

            const now = performance.now();

            // Adaptive camera FPS: reduce processing rate when main render FPS drops.
            // Check every 2 seconds to avoid thrashing.
            if (now - this._lastAdaptiveCheck > 2000) {
                this._lastAdaptiveCheck = now;
                let mainFPS = 0;
                if (typeof window.getFPS === 'function') {
                    const f = window.getFPS();
                    if (typeof f === 'number' && isFinite(f)) mainFPS = f;
                }
                const policy = window.CameraResourcePolicy;
                if (policy) {
                    this._resourceConstrained = policy.nextConstrained(
                        this._resourceConstrained,
                        mainFPS
                    );
                    const hasOverlay = this._handOverlayActive && !!this.activeMode;
                    this.targetFPS = policy.targetFPS(
                        this._baseFPS,
                        hasOverlay,
                        this._resourceConstrained
                    );
                } else if (mainFPS > 0 && mainFPS < 50) {
                    // Compatibility path for hosts that have not loaded the policy.
                    this.targetFPS = Math.max(5, Math.round(this._baseFPS / 2));
                } else {
                    this.targetFPS = this._baseFPS;
                }
            }

            const frameInterval = 1000 / this.targetFPS;

            if (now - this.lastFrameTime >= frameInterval) {
                this.lastFrameTime = now;

                const frameSource = this._getFrameSource();
                if (!frameSource) {
                    this.animationFrameId = requestAnimationFrame(processFrame);
                    return;
                }

                try {
                    // Head Mode (Primary) - Only run if NOT probing body
                    if (this.activeMode === 'head' && this.faceMesh && !this.isProbingBody) {
                        await this.faceMesh.send({ image: frameSource });

                        // Periodic body probe: while in face mode with auto-switch on,
                        // peek at pose every few seconds to detect arm-waving.
                        // Without this, face→body switch only triggers on low face confidence,
                        // meaning waving arms while face is visible never triggers a switch.
                        if (this.autoSwitchEnabled && this.autoSwitchConfig.enabled &&
                            this.permissions.head && this.permissions.body &&
                            this.poseLoaded && this.pose &&
                            now - this._lastBodyProbeTime > this.autoSwitchConfig.bodyProbeIntervalMs &&
                            now - this.lastSwitchTime > this.autoSwitchConfig.cooldownMs) {
                            this._lastBodyProbeTime = now;
                            // Short pose burst → consecutive frames for velocity
                            // calculation (dt ~50ms vs ~3000ms single snapshots).
                            this._beginBodyProbe(true, 500);
                        }
                    }

                    // Body Mode OR Probing - Run Pose
                    if ((this.activeMode === 'body' || this.isProbingBody) && this.pose) {
                        await this.pose.send({ image: frameSource });

                        // Active Probe Logic: Check results immediately
                        if (this.isProbingBody) {
                            const bs = this._dep('bodyDetector')?.state;

                            // Align thresholds with strict auto-switch logic
                            // If sitting, we need huge movement (2.5+) to confirm it's not just typing/jitter.
                            // If standing, 0.8 is fine.
                            const sittingNoise = bs?.isSitting ? 2.5 : 0.8;
                            const elbowThreshold = sittingNoise * 0.4;

                            const isSignificantMove = (bs?.wristVelocity > sittingNoise) && (bs?.elbowVelocity > elbowThreshold);

                            if (bs && (isSignificantMove || bs.armsRaised)) {
                                this._commitBodyProbe(this._probeIsAutoSwitch);
                            }
                        }
                    }

                    // Hand tracking — full rate when primary, throttled when overlay.
                    // Separate try/catch so hand errors never affect primary tracking.
                    if (this._handOverlayActive && !this._handSuspended && this.hands) {
                        // Primary mode: process every frame. Overlay mode: every Nth frame.
                        const shouldProcess = this._handPrimaryMode
                            || (++this._handFrameCounter >= this._handFrameSkip && (this._handFrameCounter = 0, true));
                        if (shouldProcess) {
                            try {
                                await this.hands.send({ image: frameSource });
                            } catch (handErr) {
                                const msg = handErr?.message || String(handErr);
                                if (this._isFatalFrameError(handErr)) {
                                    this._dep('debugManager')?.warn?.('🖐️ Hand tracking fatal error, disabling:', msg);
                                    // Suspend hand sends THIS frame; the machine
                                    // detaches hands properly right behind it.
                                    this._handSuspended = true;
                                    this._commandQueued({ type: 'HAND_FATAL', message: msg });
                                }
                            }
                        }
                    }
                } catch (e) {
                    const errorMessage = e?.message || String(e);
                    const isFatal = this._isFatalFrameError(e);

                    if (isFatal) {
                        this._dep('debugManager')?.warn?.('Fatal frame processing error; stopping tracking mode:', errorMessage);
                        // The stop effect cancels the loop, stops the stream and
                        // unloads models (fatal class); UI flags sync post-settle.
                        this._commandQueued({ type: 'FATAL', message: errorMessage });
                        return;
                    }

                    this._dep('debugManager')?.warn?.('Frame processing error:', errorMessage);
                }
            }

            this.animationFrameId = requestAnimationFrame(processFrame);
        };

        this.animationFrameId = requestAnimationFrame(processFrame);
    }

    /**
     * Report confidence from current detector
     * Called by HeadBobDetector or BodyMotionDetector each frame
     * @param {number} confidence - 0 to 1 confidence value
     */
    reportConfidence(confidence) {
        this.currentConfidence = confidence;
        const now = performance.now();

        // If Manual Mode is set, we still process the confidence but we treat
        // it as a "Permission" (we don't shut down the camera).
        // However, we still allow auto-switching between modes if inactive.
        if (this.isManualMode) {
            // No early return here - let auto-switch logic run so user isn't "stuck"
        }

        // Only run auto-switch logic when both modes are permitted.
        // If the user has explicitly disabled a mode via permissions toggle,
        // respect that choice — don't auto-switch into a disabled mode.
        if (!this.permissions.head || !this.permissions.body) {
            return;
        }
        if (this.activeMode !== 'body' && (!this.autoSwitchEnabled || !this.autoSwitchConfig.enabled)) {
            return;
        }

        const config = this.autoSwitchConfig;

        // Check cooldown
        if (now - this.lastSwitchTime < config.cooldownMs) {
            return;
        }

        // Smart posture-based switching (sitting/standing detection)
        // Body mode: if sitting detected, switch to head (better for desk use)
        // Head mode: if low confidence (face not visible), switch to body
        let shouldSwitch = false;
        let switchReason = '';

        if (this.activeMode === 'body') {
            // Auto-return to Face Mode if arms are inactive
            const bodyState = this._dep('bodyDetector')?.state;

            // Activity check for auto-switch must be ABOVE the sitting noise floor.
            // MediaPipe pose jitter produces wristVelocity ~0.3-0.8 when sitting still,
            // especially with shoulder micro-movements and breathing. We need a much
            // higher bar than the visual reactivity thresholds to avoid keeping users
            // stuck in body mode when they're just sitting at their desk.
            // armActivity threshold is too sensitive for switch decisions — it's meant
            // for visual reactivity where false positives are fine.
            // UPDATE: Typing can hit ~1.9 wrist velocity. Raised to 2.5.
            const sittingNoise = bodyState?.isSitting ? 2.5 : 0.8;
            // NEW: Require ELBOW movement too.
            // Typing = High Wrist Vel, Low Elbow Vel.
            // Dancing = High Wrist Vel, High Elbow Vel.
            // Elbow threshold can be lower (shoulders/elbows move less than wrists)
            // UPDATE: Increased elbow requirement ratio to 0.4.
            const elbowThreshold = sittingNoise * 0.4;

            const isArmActivity = (bodyState?.wristVelocity > sittingNoise) && (bodyState?.elbowVelocity > elbowThreshold);
            const isActive = isArmActivity || bodyState?.armsRaised;

            if (isActive) {
                // console.log(`[AutoSwitch] ACtive! Vel: ${bodyState?.wristVelocity.toFixed(3)} (>${sittingNoise}), Sitting: ${bodyState?.isSitting}`);
                this.lastBodyActivity = now;
            } else {
                // Initialize if missing
                if (!this.lastBodyActivity) this.lastBodyActivity = now;

                // Adaptive Timeout: 
                // Sitting: 2.5s (was 1.5s) - give more breathing room
                // Standing: 5s 
                const isSitting = bodyState?.isSitting;
                const timeout = isSitting ? 2500 : 5000;

                // Debug log every second to see countdown
                if (Math.random() < 0.05) {
                    this._dep('debugManager')?.info?.(`[AutoSwitch] Inactive for ${(now - this.lastBodyActivity).toFixed(0)}ms (Timeout: ${timeout}ms). Vel: ${bodyState?.wristVelocity?.toFixed(3)}`);
                }

                if (now - this.lastBodyActivity > timeout) {
                    shouldSwitch = true;
                    switchReason = isSitting ? 'sitting inactive' : 'arms inactive';
                }
            }

            // Sit detection explicitly ignored (handled by inactivity above)
            this.sittingDetectedStart = null;

            // Check low confidence as fallback
            if (confidence < config.confidenceThreshold) {
                if (!this.lowConfidenceStart) {
                    this.lowConfidenceStart = now;
                } else if (now - this.lowConfidenceStart >= config.sustainedLowMs) {
                    shouldSwitch = true;
                    switchReason = 'low confidence';
                }
            } else {
                this.lowConfidenceStart = null;
            }
        } else if (this.activeMode === 'head') {
            // Head mode: switch to body on low confidence (face not visible)
            if (confidence < config.confidenceThreshold) {
                if (!this.lowConfidenceStart) {
                    this.lowConfidenceStart = now;
                } else if (now - this.lowConfidenceStart >= config.sustainedLowMs) {
                    shouldSwitch = true;
                    switchReason = 'face not visible';
                }
            } else {
                this.lowConfidenceStart = null;
            }
        }

        if (shouldSwitch) {
            this._triggerAutoSwitch(switchReason);
        }
    }

    /**
     * Trigger automatic mode switch
     * @param {string} reason - Why the switch is happening
     */
    _triggerAutoSwitch(reason = 'low confidence') {
        const newMode = this.activeMode === 'head' ? 'body' : 'head';

        // Respect user's permission toggles — never switch into a disabled mode
        if (!this.permissions[newMode]) {
            return;
        }

        // Check if target mode is available
        if (newMode === 'head' && !this.faceMeshLoaded) return;
        if (newMode === 'body' && !this.poseLoaded) return;

        this._dep('debugManager')?.info?.(`[AutoSwitch] ${reason} → ${newMode}`);
        if (newMode === 'body') {
            // Body direction must prove real arm movement first (active peek);
            // a confirmed probe dispatches AUTO_SWITCH('body') into the machine.
            this._beginBodyProbe(true, 500);
        } else {
            // Head direction is direct — the machine applies the switch and
            // emits the cameraModeChange event itself.
            this._commandQueued({ type: 'AUTO_SWITCH', to: 'head' });
        }
    }

    /**
     * Enable/disable auto-switching
     * @param {boolean} enabled
     */
    setAutoSwitch(enabled) {
        this.autoSwitchConfig.enabled = enabled;
        this._dep('debugManager')?.logTransition('camera', `auto-switch-${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            active: this.active,
            mode: this.activeMode,
            phase: this.phase,
            live: { ...this._machine.state.live },
            desired: { ...this._machine.state.desired },
            faceMeshLoaded: this.faceMeshLoaded,
            poseLoaded: this.poseLoaded,
            handsLoaded: this.handsLoaded,
            handOverlay: this._handOverlayActive,
            videoReady: !!this.videoElement?.srcObject,
            autoSwitch: {
                eligible: this.autoSwitchEnabled,
                enabled: this.autoSwitchConfig.enabled,
                confidence: this.currentConfidence,
                hasUsedHead: this.hasUsedHead,
                hasUsedBody: this.hasUsedBody
            }
        };
    }
}

// Global singleton
window.SharedCameraManager = new SharedCameraManager();
