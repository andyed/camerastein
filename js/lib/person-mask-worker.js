/**
 * Person mask worker — MediaPipe ImageSegmenter (selfie) off the main thread.
 *
 * Classic worker (constructed with `new Worker(url)`, no {type:'module'}),
 * like tasks-vision/worker/vision-worker.js: the Tasks Vision bundle is pulled
 * in with dynamic import() inside the init handler.
 *
 * CPU delegate on purpose. Toaster (MIT, renderer/track-worker.js) found the
 * GPU delegate's setup froze the picture for up to 0.6 s on first use; a
 * person mask at ~10 Hz on a 256 px frame is cheap on the CPU.
 *
 * Protocol (all messages {type, ...}):
 *   in   init  {visionBundleUrl, wasmBaseUrl, modelUrl}
 *        frame {bitmap: ImageBitmap (transferred), t: ms, strictly increasing}
 *        close
 *   out  ready
 *        mask  {t, ms, width, height, data: Uint8ClampedArray (transferred)} or {t, ms, empty: true}
 *        error {message, phase}
 */
let segmenter = null;
let lastT = -Infinity;

self.onmessage = async ({ data }) => {
    const msg = data || {};
    if (msg.type === 'init') {
        try {
            const tv = await import(msg.visionBundleUrl);
            const fileset = await tv.FilesetResolver.forVisionTasks(msg.wasmBaseUrl);
            segmenter = await tv.ImageSegmenter.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: msg.modelUrl, delegate: 'CPU' },
                runningMode: 'VIDEO',
                outputCategoryMask: false,
                outputConfidenceMasks: true,
            });
            self.postMessage({ type: 'ready' });
        } catch (e) {
            self.postMessage({ type: 'error', phase: 'init', message: String(e?.message || e) });
        }
        return;
    }

    if (msg.type === 'frame') {
        const { bitmap } = msg;
        // segmentForVideo needs strictly increasing timestamps.
        const t = Math.max(Number(msg.t) || 0, lastT + 1);
        lastT = t;
        if (!segmenter || !bitmap) {
            bitmap?.close?.();
            self.postMessage({ type: 'mask', t, ms: 0, empty: true });
            return;
        }
        const t0 = performance.now();
        let out = null;
        try {
            const result = segmenter.segmentForVideo(bitmap, t);
            const mask = result?.confidenceMasks?.[0];
            if (mask) {
                const f = mask.getAsFloat32Array();
                const u = new Uint8ClampedArray(f.length);
                for (let i = 0; i < f.length; i++) u[i] = f[i] * 255;
                out = { width: mask.width, height: mask.height, data: u };
            }
            result?.close?.();
        } catch (e) {
            self.postMessage({ type: 'error', phase: 'frame', message: String(e?.message || e) });
        }
        bitmap.close?.();
        const ms = performance.now() - t0;
        if (out) self.postMessage({ type: 'mask', t, ms, ...out }, [out.data.buffer]);
        else self.postMessage({ type: 'mask', t, ms, empty: true });
        return;
    }

    if (msg.type === 'close') {
        try { segmenter?.close?.(); } catch (_) { /* closing anyway */ }
        segmenter = null;
    }
};
