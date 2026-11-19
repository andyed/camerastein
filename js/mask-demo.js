/**
 * Mask demo — the person mask channel's first consumer: a cut-out preview.
 *
 * The header's "mask" button subscribes to window.PersonMask (which loads the
 * segmenter on first use) and draws the camera with everything but the person
 * replaced by a gradient, in a small panel bottom-left. Turning it off
 * unsubscribes, which stops the worker. It needs a tracking mode on, since the
 * mask reads the camera manager's video.
 */
export function initMaskDemo() {
    const button = document.getElementById('mask-toggle');
    if (!button || !window.PersonMask) return;

    const panel = document.createElement('figure');
    panel.id = 'mask-demo';
    panel.hidden = true;
    panel.innerHTML = '<canvas width="320" height="240"></canvas><figcaption data-mask-stats>loading the segmenter…</figcaption>';
    document.body.appendChild(panel);
    const canvas = panel.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const caption = panel.querySelector('[data-mask-stats]');
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d');
    let unsubscribe = null;
    let statsTimer = null;

    const draw = (mask) => {
        const video = window.SharedCameraManager?.videoElement;
        if (!mask || !video?.videoWidth) return;
        canvas.height = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
        if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
            maskCanvas.width = mask.width;
            maskCanvas.height = mask.height;
        }
        // Mask confidence becomes alpha; the RGB is irrelevant to destination-in.
        const img = maskCtx.createImageData(mask.width, mask.height);
        for (let i = 0; i < mask.data.length; i++) img.data[4 * i + 3] = mask.data[i];
        maskCtx.putImageData(img, 0, 0);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Mirrored like the main view.
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        g.addColorStop(0, '#3b1d6e');
        g.addColorStop(1, '#0f5f5a');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
    };

    const setOn = (on) => {
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
        panel.hidden = !on;
        if (on && !unsubscribe) {
            unsubscribe = window.PersonMask.subscribe(draw);
            statsTimer = setInterval(() => {
                const s = window.PersonMask.stats();
                caption.textContent = s.error
                    ? `mask: ${s.error}`
                    : (s.ready
                        ? `mask ${s.hz.toFixed(1)} Hz · ${Number.isFinite(s.inferenceMs.p50) ? s.inferenceMs.p50.toFixed(1) : '–'} ms p50`
                        : 'loading the segmenter…');
            }, 1000);
        } else if (!on && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
            clearInterval(statsTimer);
        }
    };
    button.addEventListener('click', () => setOn(!unsubscribe));
}
