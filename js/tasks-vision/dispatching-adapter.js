/**
 * DispatchingAdapter — one loader facade per channel that routes to the worker
 * transport or the inline one, and latches to inline once the worker is out.
 *
 * WHY THIS SHAPE. motion-init.js constructs the adapter and all three loaders at
 * module load and injects them into SharedCameraManager.init() exactly once.
 * Those loader objects are permanent for the page session; nothing rebuilds them
 * per camera generation. So the spec's fallback story — "on the next explicit
 * camera start, create the inline loaders" — had nothing to hook onto.
 *
 * Rebuilding motion-init per generation would change the DI contract for every
 * detector. Instead the loaders injected once are these dispatchers: same
 * construction, same injection, and the transport decision moves inside. load()
 * is already lazy and first runs at camera start, which is the natural decision
 * point.
 *
 * Rules it enforces:
 *   - No mixed backend. The choice is made once per process and applies to every
 *     channel; face cannot run in the worker while hands run inline.
 *   - Failure is one-way. Once the worker is marked unavailable it stays
 *     unavailable for the page session, so a flapping transport cannot reorder
 *     timestamps or leave two graphs alive.
 *   - An explicit __mediapipeWorker = false always wins, immediately.
 *
 * See docs/MEDIAPIPE_WORKER_EXECUTION_SPEC.md §§ 5.4, 5.6, 7.
 *
 * THIRD TRANSPORT, 2026-10-01: `native` (docs/IOS_NATIVE_VISION.md §6). On the iOS app
 * the PsychodeliVision plugin owns the camera and pushes ARKit/Vision results; its
 * loaders come from js/tasks-vision/native/native-adapter.js. Same rules, one more rung:
 *   - preference order native → worker → inline, decided per camera generation;
 *   - native failure (loader refusal, a rejected NativeVision.start() reported by the
 *     camera manager, or a `visionStatus{event:'fatal'}`) latches native off one-way,
 *     and the next decision falls to the worker exactly as before;
 *   - __nativeVision = false is honoured at every decision point.
 */

import { TasksVisionAdapter } from './adapter.js';
import { workerAssets } from './runtime-config.js';
import { NativeVision } from './native/native-vision-bridge.js';

const CHANNELS = ['face', 'pose', 'hand'];

export class DispatchingAdapter {
    /**
     * @param {object} opts
     *   workerAdapterFactory  ({assets, delegate, onFatal}) => adapter  (test seam)
     *   inlineAdapterFactory  () => adapter                            (test seam)
     *   isWorkerEnabled       () => boolean   reads the registered flag
     *   delegate              () => 'CPU'|'GPU'
     *   onFallback            (reason, error) => void
     *   nativeAdapterFactory  ({onFatal}) => adapter                   (iOS native provider)
     *   isNativeEnabled       () => boolean   reads __nativeVision
     *   isNativeAvailable     () => boolean   NativeVision.available (plugin present)
     *   nativeStatus          () => object|null  synchronous diagnostics snapshot
     */
    constructor({
        workerAdapterFactory = null,
        inlineAdapterFactory = null,
        isWorkerEnabled = null,
        delegate = null,
        onFallback = null,
        nativeAdapterFactory = null,
        isNativeEnabled = null,
        isNativeAvailable = null,
        nativeStatus = null,
    } = {}) {
        this._workerAdapterFactory = workerAdapterFactory;
        this._inlineAdapterFactory = inlineAdapterFactory || (() => new TasksVisionAdapter());
        this._isWorkerEnabled = isWorkerEnabled || (() => (typeof window !== 'undefined' && window.__mediapipeWorker === true));
        this._delegate = delegate || (() => {
            const d = (typeof window !== 'undefined') && window.__mediapipeWorkerDelegate;
            return d === 'GPU' ? 'GPU' : 'CPU';
        });
        this._onFallback = onFallback;
        this._nativeAdapterFactory = nativeAdapterFactory;
        this._isNativeEnabled = isNativeEnabled || (() => (typeof window !== 'undefined' && window.__nativeVision === true));
        this._isNativeAvailable = isNativeAvailable || (() => !!NativeVision.available);
        this._nativeStatus = nativeStatus || (() => NativeVision.lastStatus);

        this._native = null;
        this._nativeUnavailable = false;
        this._nativeFallbackReason = null;
        this._inline = null;
        this._worker = null;
        this._workerUnavailable = false;
        this._fallbackReason = null;
        this._transport = null;      // 'native' | 'worker' | 'inline', once decided
        this._loaders = Object.create(null);
    }

    get transport() { return this._transport; }
    get fallbackReason() { return this._fallbackReason; }
    get workerAdapter() { return this._worker; }
    get nativeAdapter() { return this._native; }

    /** Diagnostics: what the session actually ended up running. */
    describe() {
        const out = {
            transport: this._transport,
            workerRequested: this._isWorkerEnabled(),
            workerUnavailable: this._workerUnavailable,
            fallbackReason: this._fallbackReason,
            delegate: this._transport === 'worker' ? this._delegate() : null,
            nativeRequested: this._safe(this._isNativeEnabled, false),
            nativeUnavailable: this._nativeUnavailable,
            nativeFallbackReason: this._nativeFallbackReason,
        };
        // Only when the native transport is (or would be) the one running: elsewhere the
        // plugin is absent and a null status would just be noise in every export.
        if (this.peekTransport() === 'native') out.native = this._safe(this._nativeStatus, null);
        return out;
    }

    /** Flag readers are app code; diagnostics and decisions must survive them throwing. */
    _safe(fn, fallback) {
        try { return fn(); } catch (_) { return fallback; }
    }

    _nativeWanted() {
        return !this._nativeUnavailable
            && !!this._nativeAdapterFactory
            && this._safe(this._isNativeEnabled, false) === true
            && this._safe(this._isNativeAvailable, false) === true;
    }

    _workerWanted() {
        return this._isWorkerEnabled() && !this._workerUnavailable && !!this._workerAdapterFactory;
    }

    /**
     * The transport the NEXT load would use, WITHOUT committing to it. SharedCameraManager
     * needs this before any model loads: isAvailable() and the hand-only fast path run
     * ahead of the first load(), and both must already know whether getUserMedia or the
     * plugin owns the camera (§1.1).
     */
    peekTransport() {
        if (this._transport) return this._transport;
        if (this._nativeWanted()) return 'native';
        return this._workerWanted() ? 'worker' : 'inline';
    }

    /**
     * One-way native latch (§1.3). Public because the most important failure is not a
     * loader failure at all: NativeVision.start() runs in the camera manager's
     * _startStream(), after the loaders have resolved, and the manager reports it here.
     * The caller owns releasing models it already holds; this only clears the decision.
     */
    markNativeUnavailable(reason, error) {
        if (this._nativeUnavailable) return;
        this._nativeUnavailable = true;
        this._nativeFallbackReason = reason;
        if (this._transport === 'native') this._transport = null;   // re-decide next load
        try {
            const detail = error?.message ? ` — ${error.message}` : '';
            window.debugManager?.warn?.(`Native vision unavailable (${reason}${detail}); falling back to ${this.peekTransport()} for this session.`);
        } catch (_) { /* diagnostics must never break tracking */ }
        try { this._onFallback?.(reason, error); } catch (_) { /* caller's problem */ }
    }

    _nativeAdapterOrNull() {
        if (this._native) return this._native;
        const factory = this._nativeAdapterFactory;
        if (!factory) return null;
        this._native = factory({
            onFatal: (err) => this.markNativeUnavailable('native-fatal', err),
        });
        return this._native;
    }

    _inlineAdapter() {
        if (!this._inline) this._inline = this._inlineAdapterFactory();
        return this._inline;
    }

    /**
     * One-way latch. Called when the worker cannot start or dies mid-session; the
     * next explicit camera start then builds inline loaders instead.
     */
    _markWorkerUnavailable(reason, error) {
        if (this._workerUnavailable) return;
        this._workerUnavailable = true;
        this._fallbackReason = reason;
        this._worker = null;
        if (this._transport === 'worker') this._transport = null;   // re-decide next start
        try {
            const detail = error?.message ? ` — ${error.message}` : '';
            window.debugManager?.warn?.(`MediaPipe worker unavailable (${reason}${detail}); falling back to inline for this session.`);
        } catch (_) { /* diagnostics must never break tracking */ }
        try { this._onFallback?.(reason, error); } catch (_) { /* caller's problem */ }
    }

    _workerAdapter() {
        if (this._worker) return this._worker;
        const factory = this._workerAdapterFactory;
        if (!factory) return null;
        this._worker = factory({
            assets: workerAssets(),
            delegate: this._delegate(),
            onFatal: (err) => this._markWorkerUnavailable('worker-crashed', err),
        });
        return this._worker;
    }

    /** Which transport should the NEXT model load use? Decided per generation. */
    _chooseTransport() {
        if (this._transport) return this._transport;     // no mixed backend within a generation
        if (this._nativeWanted()) {
            this._transport = 'native';
            return this._transport;
        }
        this._transport = this._workerWanted() ? 'worker' : 'inline';
        return this._transport;
    }

    /**
     * All channels release together, so the next start re-decides cleanly.
     *
     * IMPORTANT: this fires far less often than it looks like it should.
     * SharedCameraManager keeps models loaded across an ordinary camera toggle —
     * `_unloadModels()` runs only on fatal teardown or an explicit `shutdown()` —
     * because caching them is what makes re-enabling fast. That is correct
     * behaviour and this must not try to change it. The consequence is that
     * flipping __mediapipeWorker mid-session does NOT switch transport on the next
     * toggle; see reset() for the supported way to apply it.
     */
    _maybeResetTransport() {
        const anyLoaded = CHANNELS.some((c) => this._loaders[c]?.loaded);
        if (!anyLoaded) this._transport = null;
    }

    /**
     * Release every loader and clear the transport decision so the next camera
     * start re-reads the flag.
     *
     * ONLY SAFE WITH THE CAMERA STOPPED. SharedCameraManager holds direct
     * references to the model objects (this.faceMesh and friends); unloading
     * underneath a running loop would leave it sending frames to a closed model.
     * The wiring layer exposes this behind a helper that stops the camera first.
     */
    reset() {
        for (const c of CHANNELS) {
            try { this._loaders[c]?.unload?.(); } catch (_) { /* best effort */ }
        }
        this._transport = null;
        this._workerUnavailable = false;
        this._fallbackReason = null;
        this._worker = null;
        // The native adapter is NOT discarded: it owns a long-lived visionStatus
        // subscription, and rebuilding it would stack a second one. Clearing the latch
        // is enough for the next start to re-read __nativeVision.
        this._nativeUnavailable = false;
        this._nativeFallbackReason = null;
        return this.describe();
    }

    _dispatcher(channel, makeInline, makeWorker, makeNative = makeInline) {
        const self = this;
        let active = null;         // the underlying loader currently in use
        let activeTransport = null;

        const loader = {
            loaded: false,
            loading: false,

            get transport() { return activeTransport; },

            async load() {
                if (active) return active.load();
                this.loading = true;
                try {
                    if (self._chooseTransport() === 'native') {
                        const na = self._nativeAdapterOrNull();
                        let nativeErr = null;
                        if (na) {
                            const candidate = makeNative(na);
                            try {
                                const model = await candidate.load();
                                active = candidate;
                                activeTransport = 'native';
                                this.loaded = true;
                                return model;
                            } catch (e) {
                                nativeErr = e;
                            }
                        }
                        // Same in-call retry as the worker below: a camera start is
                        // never lost to a transport the user did not ask about.
                        self.markNativeUnavailable(nativeErr?.code || (na ? 'native-load-failed' : 'native-adapter-missing'), nativeErr);
                        self._transport = null;
                        self._chooseTransport();
                    }
                    if (self._transport === 'worker') {
                        const wa = self._workerAdapter();
                        if (wa) {
                            // INIT_TIMEOUT means the worker never got to answer within
                            // TIMEOUTS.init, not that it is broken — a cold WASM compile
                            // racing the rest of a fresh page load can miss that window
                            // once on its own (see worker-client.js's TIMEOUTS.init
                            // comment). TasksVisionWorkerAdapter's own _ensureClient()
                            // already documents "a rejected attempt does not poison
                            // later retries", so calling makeWorker(wa) again for a
                            // fresh candidate costs nothing but time and gives a
                            // merely-slow worker one more shot before the session
                            // permanently latches to the slower inline path for
                            // everything downstream. Any other failure (constructor
                            // throw, unsupported, crash) will not resolve on retry, so
                            // it still falls back immediately, same as before.
                            let lastErr = null;
                            for (let attempt = 0; attempt < 2; attempt++) {
                                const candidate = makeWorker(wa);
                                try {
                                    const model = await candidate.load();
                                    active = candidate;
                                    activeTransport = 'worker';
                                    this.loaded = true;
                                    return model;
                                } catch (e) {
                                    lastErr = e;
                                    if (attempt === 0 && e?.code === 'INIT_TIMEOUT') continue;
                                    break;
                                }
                            }
                            // Pre-activation failure: latch to inline and retry
                            // in the SAME call, so camera start is not lost to a
                            // transport the user never asked about.
                            self._markWorkerUnavailable(lastErr?.code || 'worker-start-failed', lastErr);
                            self._transport = 'inline';
                        } else {
                            self._transport = 'inline';
                        }
                    }
                    const fallback = makeInline(self._inlineAdapter());
                    const model = await fallback.load();
                    active = fallback;
                    activeTransport = 'inline';
                    this.loaded = true;
                    return model;
                } finally {
                    this.loading = false;
                }
            },

            unload() {
                try { active?.unload?.(); } catch (_) { /* teardown is best effort */ }
                active = null;
                activeTransport = null;
                this.loaded = false;
                self._maybeResetTransport();
            },

            setOptions(...args) { active?.setOptions?.(...args); },
        };

        this._loaders[channel] = loader;
        return loader;
    }

    createFaceLoader(options = {}) {
        return this._dispatcher('face',
            (a) => a.createFaceLoader(options),
            (a) => a.createFaceLoader(options),
            (a) => a.createFaceLoader(options));
    }

    createPoseLoader(options = {}) {
        return this._dispatcher('pose',
            (a) => a.createPoseLoader(options),
            (a) => a.createPoseLoader(options),
            (a) => a.createPoseLoader(options));
    }

    createHandsLoader(options = {}) {
        return this._dispatcher('hand',
            (a) => a.createHandsLoader(options),
            (a) => a.createHandsLoader(options),
            (a) => a.createHandsLoader(options));
    }
}
