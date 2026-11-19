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

const CAMERA_PREFERRED_DEVICE_KEY = 'camera.preferredDeviceId';
const CAMERA_PREFERRED_EXPLICIT_KEY = 'camera.preferredDeviceExplicit';

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
    const _cameraAvailable = window.Platform?.can?.camera !== false;
    window.CameraFeatureFlags = {
        head: _cameraAvailable,
        hand: _cameraAvailable && !_isNativeApp,
        body: _cameraAvailable && !_isNativeApp
    };
}

class SharedCameraManager {
    constructor() {
        this.videoElement = null;
        this.stream = null;
        this.active = false;
        this.preferredDeviceId = null;
        try {
            const storedId = localStorage.getItem(CAMERA_PREFERRED_DEVICE_KEY) || null;
            const wasExplicitlySelected = localStorage.getItem(CAMERA_PREFERRED_EXPLICIT_KEY) === '1';
            this.preferredDeviceId = wasExplicitlySelected ? storedId : null;
            // Before build 44, _startStream() saved whichever enumerated camera happened
            // to open first. On iOS that was commonly a rear lens, so it looked like a
            // deliberate preference and stayed rear-facing forever. Drop that legacy
            // auto-selection once; future choices made through setPreferredDeviceId()
            // carry the explicit marker and remain durable.
            if (storedId && !wasExplicitlySelected) {
                localStorage.removeItem(CAMERA_PREFERRED_DEVICE_KEY);
            }
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

        // Interleave scheduler (js/lib/camera-resource-policy.js interleaveSlot).
        // Alternates primary/hand across paced ticks instead of starving hands to
        // ~0.83Hz on mobile. Monotonic tick counter drives the slot phase.
        this._pacedTick = 0;
        // Presence pacing (js/lib/hand-pacing.js), used only while
        // window.__handPacing === 'presence'. Created lazily so a host that never
        // loads hand-pacing.js pays nothing and keeps the schedulers above.
        this._handPacer = null;
        // Per-channel inference latency + achieved rate. Always on: it is the only
        // way mobile pacing is observable (headless has no camera), and it is what
        // validates the interleave change on a real device via getTrackingStats().
        this._trackingStats = window.CameraTrackingStats || null;

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

        // Native iOS capture (docs/IOS_NATIVE_VISION.md §1, §6). Non-null only while the
        // PsychodeliVision plugin owns the camera: { running, wants:{face,hands,body} }.
        this._nativeSession = null;
        this._nativeStatusUnsub = null;

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

    // ------------------------------------------------------------------
    // Native capture (iOS PsychodeliVision plugin). docs/IOS_NATIVE_VISION.md §1, §6.
    // ------------------------------------------------------------------

    /**
     * True when the camera belongs to the native plugin rather than getUserMedia.
     *
     * Asks the dispatcher (injected as `visionTransport`) rather than reading a loader's
     * `transport`, because a loader only knows its transport AFTER load() resolves, and
     * this answer is needed before any model loads: isAvailable() runs inside
     * initialize(), and the hand-only fast path calls _startStream() before it loads
     * anything. peekTransport() returns the committed choice, or the one the next load
     * would make — the same decision, read early. Absent the dep (Camerastein, tests,
     * older hosts) it is false and every native branch below is dead code.
     */
    get _nativeCapture() {
        const vt = this._dep('visionTransport');
        if (!vt) return false;
        try {
            const t = vt.transport || (typeof vt.peekTransport === 'function' ? vt.peekTransport() : null);
            return t === 'native';
        } catch (_) {
            return false;
        }
    }

    _nativeVision() { return this._dep('NativeVision') || null; }

    /**
     * May this mode be enabled at all? CameraFeatureFlags ships iOS head-only because
     * the bundle carries face_landmarker.task alone. Native capture does not need those
     * assets — Vision runs hands/body on the device — so under native capture the hand
     * (and, once measured, body) gate defers to the __nativeVisionHands /
     * __nativeVisionBody flags instead. A camera-less device stays off either way.
     */
    _modeAllowed(mode) {
        const ff = window.CameraFeatureFlags;
        if (!ff || ff[mode] !== false) return true;
        if (window.Platform?.can?.camera === false || mode === 'head') return false;
        if (!this._nativeCapture) return false;
        return mode === 'hand' ? window.__nativeVisionHands !== false : window.__nativeVisionBody === true;
    }

    /** Machine config → plugin channels. Body/hands run only when the target needs them. */
    _nativeWantsFor(target) {
        const t = target || this._machine.state.live || {};
        return {
            face: t.primary === 'head',
            hands: !!(t.overlay || t.primary === 'hand'),
            body: t.primary === 'body',
        };
    }

    /**
     * Start (or retune) the native session for `target`. A running session is retuned
     * with setOptions — a mode switch or hand overlay toggle must not bounce the ARSession
     * (that is a visible camera-light flicker and a ~0.5s tracking gap).
     */
    async _nativeStart(target) {
        const nv = this._nativeVision();
        if (!nv?.available) {
            const e = new Error('PsychodeliVision plugin not available');
            e.code = 'unsupported';
            throw e;
        }
        const wants = this._nativeWantsFor(target);
        if (this._nativeSession?.running) {
            const w = this._nativeSession.wants;
            if (w.face === wants.face && w.hands === wants.hands && w.body === wants.body) return;
            this._lifecycle('native-retune', `face=${wants.face} hands=${wants.hands} body=${wants.body}`);
            try {
                await nv.setOptions(wants);
                this._nativeSession.wants = wants;
            } catch (err) {
                // Retune failure leaves the old channels running; tracking degrades, the
                // camera does not die. Surface it rather than tearing the session down.
                this._dep('debugManager')?.warn?.('Native vision setOptions failed:', err?.message || String(err));
            }
            return;
        }
        this._lifecycle('native-starting', `face=${wants.face} hands=${wants.hands} body=${wants.body}`);
        this._watchNativeStatus(nv);
        const res = await nv.start({ ...wants, synthetic: window.__nativeVisionSynthetic === true });
        this._nativeSession = { running: true, wants };
        this._lifecycle('native-started', `backend=${res?.backend ?? '?'}`);
    }

    /**
     * A plugin `fatal` ends the generation exactly like a fatal frame error does on the
     * pumped transports: FATAL → stop effect → models unloaded. The dispatcher has
     * already latched native off (its adapter watches the same event), so the next
     * camera start lands on the worker.
     */
    _watchNativeStatus(nv) {
        if (this._nativeStatusUnsub || typeof nv?.onStatus !== 'function') return;
        this._nativeStatusUnsub = nv.onStatus((s) => {
            if (!s || !s.event) return;
            this._lifecycle('native-status', s.event + (s.message ? `: ${s.message}` : ''));
            if (s.event === 'fatal' && this._nativeSession) {
                // _nativeSession stays set so the stop effect still calls stop():
                // idempotent on the plugin side, and it releases whatever a half-dead
                // session still holds.
                this._commandQueued({ type: 'FATAL', message: s.message || 'native vision fatal' });
            }
        });
    }

    /**
     * NativeVision.start() rejected. Decide whether to latch to the next transport (§1.3).
     * Returns true when latched — the caller then falls through to getUserMedia.
     *
     * Two rejections are NOT transport failures and do not latch: permission-denied (the
     * same camera permission gates getUserMedia, so falling back just fails twice and
     * loses the 'denied' classification the UI needs) and camera-busy (the rear LiDAR
     * session holds the camera — a contention, not an incapacity).
     */
    async _nativeStartFailed(err) {
        const code = err?.code || '';
        this._lifecycle('native-start-failed', `${code}: ${err?.message || err}`);
        if (code === 'permission-denied') {
            const e = new Error('Camera permission denied');
            e.name = 'NotAllowedError';
            e._errClass = 'denied';
            throw e;
        }
        if (code === 'camera-busy') throw err;
        const vt = this._dep('visionTransport');
        if (typeof vt?.markNativeUnavailable !== 'function') throw err;
        vt.markNativeUnavailable(code || 'native-start-failed', err);
        await this._reloadModelsAfterLatch();
        return true;
    }

    /**
     * Models already loaded on the native transport would never receive a frame from
     * getUserMedia. Release them and load the same set again — the dispatcher now picks
     * worker/inline. Missing assets (the iOS bundle ships face only) degrade the way
     * they always have: the model returns null and the hand wish is trimmed.
     */
    async _reloadModelsAfterLatch() {
        const had = { face: this.faceMeshLoaded, pose: this.poseLoaded, hand: this.handsLoaded };
        try { this._dep('MediaPipeLoader')?.unload?.(); } catch (_) { }
        try { this._dep('PoseLoader')?.unload?.(); } catch (_) { }
        try { this._dep('HandsLoader')?.unload?.(); } catch (_) { }
        this.faceMesh = null; this.pose = null; this.hands = null;
        this.faceMeshLoaded = false; this.poseLoaded = false; this.handsLoaded = false;
        if (had.face) { this.faceMesh = await this._loadFaceMesh(); this.faceMeshLoaded = !!this.faceMesh; }
        if (had.pose) { this.pose = await this._loadPose(); this.poseLoaded = !!this.pose; }
        if (had.hand) { this.hands = await this._loadHands(); this.handsLoaded = !!this.hands; }
    }

    /**
     * Synchronous diagnostics snapshot: status + which transport owns the camera.
     * nativeStatus is the bridge's last-seen Status (the plugin call is async and this
     * must not be).
     */
    getDebugSnapshot() {
        const vt = this._dep('visionTransport');
        let transport = null;
        try { transport = vt?.describe?.() ?? null; } catch (_) { transport = null; }
        const native = this._nativeCapture;
        return {
            ...this.getStatus(),
            transport: native ? 'native' : (transport?.transport ?? null),
            transportDetail: transport,
            nativeSession: this._nativeSession ? { ...this._nativeSession, wants: { ...this._nativeSession.wants } } : null,
            nativeStatus: native ? (this._nativeVision()?.lastStatus ?? null) : null,
            machineViolations: (this._machine.violations || []).length,
            lifecycleTail: (this.lifecycleLog || []).slice(-12),
        };
    }

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
        if (!this._modeAllowed(mode)) {
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
        if (!this._modeAllowed(mode)) {
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
            if (nextId) {
                localStorage.setItem(CAMERA_PREFERRED_DEVICE_KEY, nextId);
                localStorage.setItem(CAMERA_PREFERRED_EXPLICIT_KEY, '1');
            } else {
                localStorage.removeItem(CAMERA_PREFERRED_DEVICE_KEY);
                localStorage.removeItem(CAMERA_PREFERRED_EXPLICIT_KEY);
            }
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

            await this._startStream(target);
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
            // No-op while the stream lives; heals a dead one. Under native capture this
            // retunes the running session's channels instead (no ARSession bounce).
            await this._startStream(to);

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
            this._handPacer?.reset?.();
            this._dep('handDetector')?._deactivate?.();
            this._dep('debugManager')?.logTransition?.('hand', 'overlay-stopped');
        } else if (toHand && !fromHand) {
            this._handOverlayCallback = this._dep('handDetector')?._onResults || null;
            this._handFrameCounter = 0;
            this._handPacer?.reset?.();
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
        // Parity with _ensureHands()'s toast — this used to fire here too (see the
        // 2026-06-11 note on initialize() referencing "Loading Face Tracking..."),
        // but a cold load can take long enough on its own (worse before the vendor
        // asset caching fix) that its absence reads as a dead camera, not a slow one.
        this._dep('commandRegistry')?.showParameterIndicator?.(
            need === 'face' ? 'Loading Face Tracking...' : 'Loading Body Tracking...', true);
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
        // Native capture needs neither getUserMedia nor WebGL: ARKit owns the camera and
        // inference runs on the device. Checked first because WKWebView can expose
        // getUserMedia while the plugin is the owner we actually want.
        if (this._nativeCapture && this._nativeVision()?.available) return true;
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
        // Typed transport errors first. The worker reports stable codes precisely
        // so this does not have to guess from prose; the substring matching below
        // remains the inline path's classifier and is untouched.
        // See js/tasks-vision/worker/protocol.js FATAL_CODES.
        if (error && typeof error.code === 'string') {
            if (typeof error.fatal === 'boolean') return error.fatal;
            return ['PROTOCOL_MISMATCH', 'MODEL_LOAD_FAILED', 'FRAME_TIMEOUT', 'WORKER_CRASHED'].includes(error.code);
        }

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
            // Under native capture mirror the ring into the device syslog (plugin `trace`): the
            // iOS app has no renderer console, and this is how a stalled retune gets diagnosed.
            if (this._nativeSession || this._nativeCapture) {
                this._nativeVision()?.trace?.(detail ? `${event} ${detail}` : event);
            }
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
            this._dep('commandRegistry').showParameterIndicator('Loading Face Tracking...', true, window.ToastPolicy?.TRANSPORT);
        }
        this.faceMesh = await this._loadFaceMesh();
        this.faceMeshLoaded = !!this.faceMesh;

        // Body tracking is NOT shipped on the native build (head-only v1) and the pose model
        // isn't bundled there (build-web.mjs ships face_landmarker.task only), so preloading it
        // on native just 404s and spams fetch retries. Skip it — head tracking is unaffected, and
        // body already doesn't work on native, so this is no behaviour change (just less noise).
        // Web/desktop still preload pose as before.
        // Native capture (docs/IOS_NATIVE_VISION.md) changes the premise: no asset to
        // fetch, a pose "model" is just a registered callback. Preload it there so a body
        // toggle (when __nativeVisionBody allows one) skips _ensureModelsFor's 1.5s retry.
        if (!(typeof window !== 'undefined' && window.__PSYDELI_NATIVE_BUILD) || this._nativeCapture) {
            this._dep('debugManager')?.logTransition('camera', 'model-load-pose', null, { minIntervalMs: 300 });
            if (!this.poseLoaded && this._dep('commandRegistry')?.showParameterIndicator) {
                this._dep('commandRegistry').showParameterIndicator('Loading Body Tracking...', true, window.ToastPolicy?.TRANSPORT);
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

    /**
     * @param {{primary, overlay}} [target] machine config being acquired/applied. Only the
     *   native branch reads it (to pick plugin channels); the getUserMedia ladder ignores it.
     */
    async _startStream(target) {
        if (this.stream && this.videoElement) {
            return;
        }

        // Native capture (§1.1): the plugin owns the front camera; getUserMedia is never
        // called and videoElement stays null. A start failure that latches (§1.3) falls
        // through to the ladder below with models already reloaded on the next transport.
        if (this._nativeCapture) {
            try {
                await this._nativeStart(target);
                return;
            } catch (err) {
                await this._nativeStartFailed(err);   // throws unless latched
            }
        }

        this._lifecycle('stream-starting');
        this._dep('debugManager')?.logTransition('camera', 'stream-starting');

        const deviceInputs = await this.listVideoInputs();
        const deviceIds = (Array.isArray(deviceInputs) ? deviceInputs : [])
            .map(d => d?.deviceId)
            .filter(Boolean);

        const fallbackDeviceIds = deviceIds.filter(id => id !== this.preferredDeviceId);

        // Android (esp. Mali GPUs in a Capacitor WebView) shares GPU memory between the camera
        // textures, MediaPipe, and the main WebGL2 visualization context. Cap capture at 320×240
        // there to cut texture pressure (MediaPipe downscales for inference anyway) — part of
        // preventing the camera-on → main-context-loss blank screen. Full 640×480 elsewhere.
        const _isAndroid = /Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
        const _camW = _isAndroid ? 320 : 640, _camH = _isAndroid ? 240 : 480;

        const streamAttempts = [];
        // A device ID is a real preference only when the user picked it in the
        // camera selector. Preserve that choice, including an intentional rear
        // camera. With no explicit choice, Familiar is a face interaction, so
        // request the selfie camera before trying enumeration-order fallbacks.
        if (this.preferredDeviceId) {
            streamAttempts.push({
                constraints: {
                    video: {
                        deviceId: { exact: this.preferredDeviceId },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId: this.preferredDeviceId,
                explicitPreference: true
            });
        }

        streamAttempts.push(
            {
                constraints: {
                    video: {
                        facingMode: { exact: 'user' },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId: null
            },
            {
                constraints: {
                    video: {
                        facingMode: { ideal: 'user' },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId: null
            }
        );

        fallbackDeviceIds.forEach(deviceId => {
            streamAttempts.push({
                constraints: {
                    video: {
                        deviceId: { exact: deviceId },
                        width: { ideal: _camW },
                        height: { ideal: _camH }
                    }
                },
                deviceId,
                explicitPreference: false
            });
        });

        streamAttempts.push(
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
                const nativeIOS = window.__PSYDELI_NATIVE_BUILD === true
                    && window.__PSYDELI_PLATFORM === 'ios';
                if (nativeIOS) {
                    // WKWebView can advance currentTime on a camera video that its
                    // compositor has stopped painting. Both inline 1.5 and worker
                    // builds 62/63 then run valid inference calls over black pixels:
                    // no exception, no drop, and permanently zero faces. Keep the
                    // native-iOS source in the rendered viewport at negligible size
                    // and alpha so WebKit continues producing decoded frames for
                    // both direct inference and the worker's canvas bridge.
                    this.videoElement.style.left = '0px';
                    this.videoElement.style.top = '0px';
                    this.videoElement.style.width = '16px';
                    this.videoElement.style.height = '12px';
                    this.videoElement.style.opacity = '0.001';
                    this.videoElement.style.transform = 'translateZ(0)';
                } else {
                    this.videoElement.style.left = '-9999px';
                    this.videoElement.style.top = '0';
                    this.videoElement.style.width = '1px';
                    this.videoElement.style.height = '1px';
                    this.videoElement.style.opacity = '0';
                }
                this.videoElement.style.pointerEvents = 'none';
                this.videoElement.setAttribute('aria-hidden', 'true');

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
                    // Host app can set window.__appDisplayName (e.g. 'Psychodeli+') so the
                    // guidance names the entry the user must find in the Settings list.
                    this._dep('debugManager')?.warn?.(
                        `Camera permission denied. Check macOS Settings > Privacy & Security > Camera and ensure ${window.__appDisplayName || 'this app'} is allowed.`
                    );
                    throw err;
                }

                if ((isNotFound || isNoFrames || isMetaTimeout || isOverconstrained) && attempt.explicitPreference) {
                    try {
                        localStorage.removeItem(CAMERA_PREFERRED_DEVICE_KEY);
                        localStorage.removeItem(CAMERA_PREFERRED_EXPLICIT_KEY);
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
                    localStorage.removeItem(CAMERA_PREFERRED_DEVICE_KEY);
                    localStorage.removeItem(CAMERA_PREFERRED_EXPLICIT_KEY);
                } catch (_) { }
                this.preferredDeviceId = null;
            }
            throw lastError || new Error('Failed to acquire camera stream');
        }
    }

    _stopStream() {
        // Stop means the camera light goes off (§1.4) — every stop path lands here, so
        // the ARSession ends on every camera-off even though models stay cached. Keyed on
        // the session, not on _nativeCapture, so a session started before a latch is
        // still stopped after it. Fire-and-forget: callers are synchronous and the bridge
        // stop() never rejects.
        if (this._nativeSession) {
            this._lifecycle('native-stopped');
            this._nativeSession = null;
            try { this._nativeVision()?.stop?.(); } catch (_) { }
        }
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
     * Run one model send, timing it into CameraTrackingStats.
     *
     * Inline, detectForVideo is a synchronous WASM call under the shim, so this wall
     * time IS the main-thread stall the 60fps renderer pays for tracking. That stops
     * being true the moment a transport puts inference on another thread, so the
     * stopwatch here is reported as roundTripMs and the shim's own structured
     * outcome supplies the breakdown. See docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md § 11.
     *
     * Errors propagate unchanged — callers own their own catch semantics (hands must
     * not kill primary). A throwing send is still recorded, as a dropped frame.
     */
    async _timedSend(channel, model, frameSource) {
        const t0 = performance.now();
        let outcome = null;
        let threw = false;
        try {
            outcome = await model.send({ image: frameSource });
        } catch (e) {
            threw = true;
            throw e;
        } finally {
            const roundTripMs = performance.now() - t0;
            if (threw) {
                this._trackingStats?.record?.(channel, {
                    channel, transport: 'inline', completed: false,
                    dropped: true, dropReason: 'inference-error',
                });
            } else if (outcome && typeof outcome === 'object') {
                // mainThreadMs: inline, the whole await is synchronous main-thread work.
                // A worker transport reports its own and this fallback does not apply.
                this._trackingStats?.record?.(channel, {
                    ...outcome,
                    channel,
                    roundTripMs,
                    mainThreadMs: Number.isFinite(outcome.mainThreadMs)
                        ? outcome.mainThreadMs
                        : (outcome.transport === 'worker' ? undefined : roundTripMs),
                });
            } else {
                // Legacy model with no structured outcome — a bare stopwatch still
                // reads correctly for an inline synchronous send.
                this._trackingStats?.record?.(channel, roundTripMs);
            }
        }
        // Returned for the presence pacer, which reads outcome.resultCount (hands
        // in the result). Existing callers ignore it.
        return outcome;
    }

    /**
     * Presence pacing (js/lib/hand-pacing.js): hands every tick while one was seen
     * recently, the primary on a watchdog; hands scouting otherwise. Opt-in with
     * window.__handPacing = 'presence'. Like interleave, it only applies when hands
     * share the pumped loop with a primary detector, and it takes precedence over
     * interleave when both are set.
     */
    _presencePacingActive() {
        return window.__handPacing === 'presence'
            && !!window.CameraHandPacing
            && !this._nativeCapture
            && this._handOverlayActive
            && !this._handSuspended
            && !this._handPrimaryMode
            && !!this.activeMode;
    }

    _getHandPacer() {
        if (!this._handPacer && window.CameraHandPacing) {
            this._handPacer = window.CameraHandPacing.createHandPacer(window.__handPacingOptions || undefined);
        }
        return this._handPacer;
    }

    /**
     * Is the interleave scheduler active right now? Only meaningful when hands share
     * the loop with a primary detector — dedicated hand mode already runs every tick.
     */
    _interleaveActive() {
        // Default OFF: this changes mobile pacing and has not been measured on a real
        // device yet. Flip =true on-device, read getTrackingStats(), then graduate.
        // _handSuspended check: once hand errors suspend the model, hand slots would
        // run nothing — fall back to skip mode so the primary keeps every tick.
        // Interleave is a pumped-loop scheduler; under native capture the plugin paces
        // each channel itself, so report the plain scheduler.
        return window.__handInterleave === true
            && !this._nativeCapture
            && this._handOverlayActive
            && !this._handSuspended
            && !this._handPrimaryMode
            && !!this.activeMode;
    }

    /** Planned vs achieved rates — the readout for validating pacing changes on-device. */
    getTrackingStats() {
        const policy = window.CameraResourcePolicy;
        const presence = this._presencePacingActive() && !!this._handPacer;
        const interleaved = !presence && this._interleaveActive();
        const planned = presence
            ? this._handPacer.plannedRates(this.targetFPS)
            : (policy?.plannedRates?.(
                this.targetFPS,
                interleaved ? 'interleave' : 'skip',
                window.__handInterleaveRatio ?? 2,
                this._handFrameSkip
            ) || null);
        return {
            scheduler: presence ? 'presence' : (interleaved ? 'interleave' : 'skip'),
            // Presence pacing's phase ('present' | 'scouting') and transition count.
            pacing: presence ? this._handPacer.state() : null,
            targetFPS: this.targetFPS,
            constrained: this._resourceConstrained,
            planned,
            achieved: this._trackingStats?.summary?.() || null,
            // Main-thread cost only. Inline this is unchanged; behind a worker it no
            // longer silently absorbs round-trip wait. See the stats module header.
            loadMsPerSec: this._trackingStats?.loadMsPerSec?.() || null,
            // Transport-aware breakdown — the view to read when comparing an inline
            // baseline against a worker run.
            transport: this._trackingStats?.detail?.() || null,
        };
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
                    // Native subset frames tag their landmark arrays (non-enumerable);
                    // forward it so a geometry consumer reading THIS emit also skips.
                    ...(landmarks.sparse === true ? { sparse: true } : {}),
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
     * How much main thread can the periodic body probe afford right now?
     *
     * THE PROBLEM. A probe window suspends interleave and forces `primarySlot`,
     * so pose claims EVERY paced tick for its whole duration while face runs not
     * at all. That is fine when pose inference is sub-frame. It is not fine on the
     * CPU delegate: at ~50ms per inference and ~10 ticks in a 500ms window, the
     * probe blocks the main thread for essentially the entire window — the
     * animation stops dead for half a second, every three seconds, in ordinary
     * head tracking. Andy, 2026-08-07: "the jank freezes the running animation, so
     * feels broken." The visualization is the product; a convenience feature must
     * not be allowed to freeze it.
     *
     * THE POLICY. Scale the probe to the measured cost of a pose inference rather
     * than assuming it is cheap:
     *   - no samples yet   → allow. The first probe is how we learn the cost.
     *   - cheap            → today's behaviour exactly, unchanged.
     *   - expensive        → shrink to the minimum tick count the velocity math
     *                        needs, and stretch the interval to hold the duty cycle.
     *   - unaffordable     → skip. Arm-wave auto-switch is a convenience; the
     *                        low-confidence switch path still works, and a worker
     *                        transport would make the probe affordable again.
     *
     * Reads main-thread cost, NOT round trip, so a worker transport correctly reads
     * as cheap even when its inference is slow — which is the whole point of it.
     */
    _bodyProbeBudget(requestedWindowMs) {
        const OFF = (typeof window !== 'undefined' && window.__bodyProbeCostGate === false);
        const base = { affordable: true, windowMs: requestedWindowMs, intervalMs: this.autoSwitchConfig.bodyProbeIntervalMs, costMs: null, reason: null };
        if (OFF) return { ...base, reason: 'gate-disabled' };

        const costMs = this._trackingStats?.mainThreadP50?.('pose');
        if (!Number.isFinite(costMs) || costMs <= 0) return { ...base, reason: 'no-samples' };
        base.costMs = costMs;

        // A frame is ~16.7ms. Sub-frame pose is cheap enough to leave alone; past
        // ~1.5 frames a single inference is a visible hitch on its own, and no
        // amount of scheduling makes a burst of them acceptable.
        const CHEAP_MS = 12;
        const UNAFFORDABLE_MS = 25;
        const MIN_TICKS = 3;        // velocity math needs consecutive frames (dt ~50ms)

        if (costMs <= CHEAP_MS) return { ...base, reason: 'cheap' };
        if (costMs > UNAFFORDABLE_MS) {
            return { ...base, affordable: false, reason: 'pose-too-expensive' };
        }

        // In between: run the shortest probe the velocity math accepts. Worst case
        // is MIN_TICKS × UNAFFORDABLE_MS = 75ms against the 3s interval — a 2.5%
        // duty cycle, so the interval itself needs no adjustment. If MIN_TICKS or
        // the affordability cap ever rise, re-derive that before trusting it.
        const tickMs = 1000 / Math.max(1, this.targetFPS);
        return { ...base, windowMs: MIN_TICKS * tickMs, reason: 'throttled' };
    }

    /**
     * Begin a probing window: route pose results to the body detector so its
     * state populates, auto-revert after the window if nothing significant.
     * Prevents shoulder micro-movements from stealing the camera while seated.
     * @param {boolean} isAutoSwitch - confidence-triggered vs periodic peek
     * @param {number} [windowMs] - probe duration (default 500 auto / 1000 manual)
     */
    _beginBodyProbe(isAutoSwitch, windowMs) {
        if (this.isProbingBody) return;
        // The probe borrows pumped pose frames inside a face-mode loop; native capture
        // has no such loop (and runs body only when body is the primary). Inert there.
        if (this._nativeCapture) return;
        if (!this.permissions.head || !this.permissions.body) return;
        if (this.phase !== 'running' || this.activeMode !== 'head') return;
        if (!this.poseLoaded || !this.pose) return;

        // Cost gate applies to the PERIODIC peek only. A confidence-triggered probe
        // is answering "has the user left the frame", which is worth a hitch; the
        // periodic one is speculative and must not freeze the visualization.
        let probeTimeout = windowMs || (isAutoSwitch ? 500 : 1000);
        if (isAutoSwitch) {
            const budget = this._bodyProbeBudget(probeTimeout);
            this._lastProbeBudget = budget;
            if (!budget.affordable) {
                if (!this._probeSkipLogged) {
                    this._probeSkipLogged = true;
                    this._dep('debugManager')?.info?.(
                        `👀 Body peek disabled: pose costs ${Math.round(budget.costMs)}ms of main thread per tick `
                        + `(>1.5 frames). Auto-switch falls back to the low-confidence path. Override: __bodyProbeCostGate = false`);
                }
                return;
            }
            probeTimeout = budget.windowMs;
        }
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
        // Native capture pushes results from the plugin's own cadence (ARKit 60 Hz,
        // coalesced per channel natively). There is nothing to pump: no video element, no
        // send(). Return once rather than spinning a rAF that re-checks every frame;
        // _attachConfig calls back here on every reconfigure, so a later latch to a
        // pumped transport still starts the loop on its next attach.
        if (this._nativeCapture) return;
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
                        this._resourceConstrained,
                        this._interleaveActive()
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

                // Interleave: this paced tick belongs to EITHER the primary detector or
                // hands, never both. Without it, hands are starved to targetFPS/skip
                // (~0.83Hz on mobile). The slot phase advances once per paced tick.
                // Presence pacing, when on, decides both slots and overrides interleave.
                const pacing = this._presencePacingActive() ? this._getHandPacer()?.tick(now) : null;
                const interleaved = !pacing && this._interleaveActive();
                const slot = interleaved
                    ? (window.CameraResourcePolicy?.interleaveSlot(
                        this._pacedTick++, window.__handInterleaveRatio ?? 2) || 'primary')
                    : null;
                // The body probe assumes CONSECUTIVE pose frames for its velocity math
                // (dt ~50ms, see _beginBodyProbe). Interleaving would halve that and
                // skew wristVelocity, so the probe window suspends interleave entirely.
                // Presence pacing yields to the probe the same way.
                const primarySlot = pacing
                    ? (pacing.primary || this.isProbingBody)
                    : (!interleaved || slot === 'primary' || this.isProbingBody);
                const handSlot = pacing
                    ? (pacing.hand && !this.isProbingBody)
                    : (!interleaved || (slot === 'hand' && !this.isProbingBody));

                try {
                    // Head Mode (Primary) - Only run if NOT probing body
                    if (primarySlot && this.activeMode === 'head' && this.faceMesh && !this.isProbingBody) {
                        await this._timedSend('face', this.faceMesh, frameSource);

                        // Periodic body probe: while in face mode with auto-switch on,
                        // peek at pose every few seconds to detect arm-waving.
                        // Without this, face→body switch only triggers on low face confidence,
                        // meaning waving arms while face is visible never triggers a switch.
                        // Interval is cost-aware too, not just the window: an expensive
                        // probe backs off in frequency so its duty cycle stays bounded.
                        // See _bodyProbeBudget().
                        const probeIntervalMs = this._bodyProbeBudget(500).intervalMs;
                        if (this.autoSwitchEnabled && this.autoSwitchConfig.enabled &&
                            this.permissions.head && this.permissions.body &&
                            this.poseLoaded && this.pose &&
                            now - this._lastBodyProbeTime > probeIntervalMs &&
                            now - this.lastSwitchTime > this.autoSwitchConfig.cooldownMs) {
                            this._lastBodyProbeTime = now;
                            // Short pose burst → consecutive frames for velocity
                            // calculation (dt ~50ms vs ~3000ms single snapshots).
                            this._beginBodyProbe(true, 500);
                        }
                    }

                    // Body Mode OR Probing - Run Pose
                    if (primarySlot && (this.activeMode === 'body' || this.isProbingBody) && this.pose) {
                        await this._timedSend('pose', this.pose, frameSource);

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
                    if (handSlot && this._handOverlayActive && !this._handSuspended && this.hands) {
                        // Dedicated: every frame. Interleave: every hand slot (the slot
                        // gate above already did the throttling). Legacy: every Nth frame.
                        const shouldProcess = this._handPrimaryMode
                            || interleaved
                            || !!pacing
                            || (++this._handFrameCounter >= this._handFrameSkip && (this._handFrameCounter = 0, true));
                        if (shouldProcess) {
                            try {
                                const handOutcome = await this._timedSend('hand', this.hands, frameSource);
                                if (pacing) {
                                    // Worker outcomes carry resultCount; the inline shim
                                    // does not, so read the detector it just updated.
                                    const n = Number.isFinite(handOutcome?.resultCount)
                                        ? handOutcome.resultCount
                                        : (this._dep('handDetector')?.state?.handCount || 0);
                                    this._handPacer?.observe(performance.now(), n);
                                }
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
        // Head↔body auto-switch presumes the pumped loop (a body probe inside face mode,
        // both models fed from one <video>). Native capture runs only the primary's
        // channel, so the policy is gated off rather than deleted. Confidence is still
        // recorded for diagnostics.
        if (this._nativeCapture) return;
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
        // `this.active` means models are ready and stays true after a normal STOP.
        // Public camera status must follow live ownership so cached models do not
        // leave the camera toggle reporting On after capture has been released.
        const live = this._machine.state.live;
        return {
            active: live.primary !== null || live.overlay,
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
