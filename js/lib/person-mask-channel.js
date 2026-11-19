/**
 * Person mask channel — where the person is, as a low-resolution mask, on
 * MotionBus 'personMask'.
 *
 * A new kind of signal for the lab: not landmarks but a region. Psychodeli-side
 * uses are a cut-out composited into the visuals, a person-shaped hole, or
 * motion energy inside the silhouette. After toaster (MIT; renderer/segcam.js
 * and track-worker.js), which builds its camera looks on the same model.
 *
 * Lazy and separate from the landmark loop:
 *   - nothing loads until the first subscriber; the last unsubscribe stops it
 *     and frees the worker;
 *   - its own worker (person-mask-worker.js), its own clock (~10 Hz), one frame
 *     in flight, frames downscaled to 256 px wide before transfer;
 *   - it reads the camera manager's <video>, so it needs the camera on and adds
 *     no camera of its own.
 *
 * Payload: { t, width, height, data: Uint8ClampedArray (0..255 person
 * confidence, row-major), ms (worker inference) } or null when stopped.
 * Inspect with window.PersonMask.stats().
 */

import { VISION_BUNDLE, WASM_BASE, MODEL_URLS } from '../tasks-vision/runtime-config.js';

const WORKER_URL = new URL('./person-mask-worker.js', import.meta.url).href;

export function initPersonMaskChannel({ hz = 10, width = 256 } = {}) {
    const w = (typeof window !== 'undefined') ? window : null;
    const bus = w?.MotionBus;
    if (!bus) return null;
    if (w.PersonMask?._wired) return w.PersonMask;

    if (bus._channels && !bus._channels.personMask) {
        bus._channels.personMask = 'personMask';
        bus.state.personMask = null;
    }

    const subscribers = new Set();
    const samples = [];   // [{at, ms}] for rate and latency
    let worker = null;
    let ready = false;
    let inFlight = false;
    let timer = null;
    let lastError = null;

    const video = () => {
        const v = w.SharedCameraManager?.videoElement;
        return v && v.videoWidth > 0 && v.videoHeight > 0 ? v : null;
    };

    function start() {
        if (worker) return;
        worker = new Worker(WORKER_URL);
        ready = false;
        worker.onmessage = ({ data }) => {
            if (data.type === 'ready') { ready = true; return; }
            if (data.type === 'error') { lastError = `${data.phase}: ${data.message}`; inFlight = false; return; }
            if (data.type !== 'mask') return;
            inFlight = false;
            const now = performance.now();
            samples.push({ at: now, ms: data.ms });
            while (samples.length && now - samples[0].at > 5000) samples.shift();
            if (data.empty) return;
            const payload = { t: data.t, width: data.width, height: data.height, data: data.data, ms: data.ms };
            bus.emit('personMask', payload);
            for (const fn of subscribers) {
                try { fn(payload); } catch (_) { /* a consumer's error is its own */ }
            }
        };
        worker.postMessage({ type: 'init', visionBundleUrl: VISION_BUNDLE, wasmBaseUrl: WASM_BASE, modelUrl: MODEL_URLS.selfieSegmenter });
        tick();
    }

    async function tick() {
        timer = setTimeout(tick, 1000 / hz);
        if (!worker || !ready || inFlight) return;
        const v = video();
        if (!v) return;
        inFlight = true;
        try {
            const h = Math.max(1, Math.round((v.videoHeight * width) / v.videoWidth));
            const bitmap = await createImageBitmap(v, { resizeWidth: width, resizeHeight: h, resizeQuality: 'low' });
            if (!worker) { bitmap.close(); return; }
            worker.postMessage({ type: 'frame', bitmap, t: performance.now() }, [bitmap]);
        } catch (e) {
            inFlight = false;
            lastError = `frame: ${e?.message || e}`;
        }
    }

    function stop() {
        clearTimeout(timer);
        timer = null;
        if (worker) {
            worker.postMessage({ type: 'close' });
            worker.terminate();
        }
        worker = null;
        ready = false;
        inFlight = false;
        samples.length = 0;
        bus.emit('personMask', null);
    }

    w.PersonMask = {
        _wired: true,
        /** Start receiving masks; returns an unsubscribe. The first subscriber loads the model. */
        subscribe(fn) {
            subscribers.add(fn);
            start();
            return () => {
                subscribers.delete(fn);
                if (subscribers.size === 0) stop();
            };
        },
        get active() { return !!worker; },
        get ready() { return ready; },
        stats() {
            const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
            const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
            const span = samples.length > 1 ? (samples.at(-1).at - samples[0].at) / 1000 : 0;
            return {
                active: !!worker, ready, subscribers: subscribers.size,
                hz: span > 0 ? +((samples.length - 1) / span).toFixed(2) : 0,
                inferenceMs: { p50: q(0.5), p95: q(0.95), n: ms.length },
                error: lastError,
            };
        },
    };
    return w.PersonMask;
}
