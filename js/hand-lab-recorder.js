/**
 * Hand Lab Recorder — every hand frame, written down, so a live session can be
 * analysed afterwards instead of narrated while it happens.
 *
 * Performing a hand pose puts you an arm's length from the screen with both
 * hands up; reading a reason tally at the same time is not realistic. This
 * records what the lab would have shown — raw detector output, the pray frame,
 * every suite pose's verdict — tagged with whatever the guided run was asking
 * for at that moment, so "did thumbs-up fire while I was holding thumbs-up" is
 * a query over the log rather than a memory.
 *
 * Three ways out, cheapest first:
 *   - `window.HandLabRecorder.summary()` in the page console
 *   - `?handlog=http://127.0.0.1:8792` streams rows to scripts/hand-log-sink.mjs,
 *     which writes JSONL to logs/ where an agent can read it from any browser
 *   - `window.HandLabRecorder.download()` saves the rows as a file
 *
 * ## Clips (the OptiGest scheme)
 *
 * A guided run with a sink attached also records camera frames, following
 * optimac's `tests/fixtures/clips/<timestamp>/frame_NNN.jpg` layout, plus two
 * things OptiGest keeps only in test code: `rows.jsonl` (every frame's full
 * landmarks and verdicts) and `manifest.json` (which pose was cued when). The
 * landmarks replay through the recognizers in Node after a threshold change;
 * the frames are there for when the detector itself is the suspect — "pray
 * falls to 0 hands" is a question about pixels, not thresholds.
 *
 * A pure consumer of MotionBus. It subscribes; it never emits.
 */

const MAX_ROWS = 20000;
const FLUSH_MS = 1000;
/** OptiGest captures at ~5 fps; enough to see a hand vanish, cheap to store. */
const FRAME_MS = 200;
const FRAME_WIDTH = 640;

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
const r2 = (x) => (num(x) === null ? null : Math.round(x * 100) / 100);
const r4 = (x) => (num(x) === null ? null : Math.round(x * 10000) / 10000);
/** Full landmarks, flattened [x,y,z,…] — replayable, and a third the size of objects. */
const flatLandmarks = (lms) => (Array.isArray(lms)
    ? lms.flatMap((lm) => [r4(lm?.x), r4(lm?.y), r4(lm?.z)])
    : null);

function roundFeatures(features) {
    if (!features) return null;
    const out = {};
    for (const [key, value] of Object.entries(features)) {
        if (typeof value === 'number') out[key] = r2(value);
    }
    return out;
}

/** The poses a guided run walks through, with a neutral at each end. */
const GUIDED_SEQUENCE = [
    'rest', 'openPalm', 'fist', 'point', 'peace', 'horns',
    'thumbsUp', 'thumbsDown', 'pray', 'rest',
];
const READY_MS = 3000;
const HOLD_MS = 8000;

export class HandLabRecorder {
    constructor({ labels = {}, cues = {} } = {}) {
        this.rows = [];
        this.cue = null;          // { pose, stage: 'ready' | 'hold' }
        this.labels = labels;
        // The name alone is ambiguous — "horns" was performed as bull horns.
        this.cues = cues;
        this.pending = [];
        this.runId = null;
        this.sink = this._sinkUrl();
        this.guidedRun = 0;
        this._subscribe();
        if (this.sink) {
            this._flushTimer = setInterval(() => this._flush(), FLUSH_MS);
            this._push({ ch: 'meta', event: 'recorder-start', ua: navigator.userAgent });
        }
    }

    _sinkUrl() {
        try {
            const url = new URLSearchParams(location.search).get('handlog');
            return url ? url.replace(/\/$/, '') + '/log' : null;
        } catch {
            return null;
        }
    }

    _subscribe() {
        const bus = window.MotionBus;
        if (!bus?.subscribe) return;

        // Raw detector output. `null` is the detector saying "no hands, and I
        // have stopped broadcasting" — worth a row of its own, since a pose that
        // "falls to 0 hands" is either this or MediaPipe returning nothing.
        bus.subscribe('handPose', (hand) => {
            if (!hand) {
                this._push({ ch: 'hand', nul: true });
                return;
            }
            this._push({
                ch: 'hand',
                t: r2(hand.t ?? hand.timestamp),
                n: hand.handCount ?? 0,
                l1: Array.isArray(hand.landmarks),
                l2: Array.isArray(hand.landmarks2),
                conf: r2(hand.confidence),
                // Wrist positions, so a hand leaving frame is visible as such.
                w1: Array.isArray(hand.landmarks)
                    ? [r2(hand.landmarks[0]?.x), r2(hand.landmarks[0]?.y)] : null,
                w2: Array.isArray(hand.landmarks2)
                    ? [r2(hand.landmarks2[0]?.x), r2(hand.landmarks2[0]?.y)] : null,
                // Only inside a run: enough to replay, without an idle page
                // accumulating megabytes of landmarks nobody asked for.
                lm1: this.runId ? flatLandmarks(hand.landmarks) : undefined,
                lm2: this.runId ? flatLandmarks(hand.landmarks2) : undefined,
            });
        });

        bus.subscribe('prayGesture', (frame) => {
            if (!frame) {
                this._push({ ch: 'pray', nul: true });
                return;
            }
            this._push({
                ch: 'pray',
                t: r2(frame.t),
                hp: frame.quality?.handsPresent ?? 0,
                r: frame.quality?.reason ?? null,
                b: frame.quality?.blockedBy ?? [],
                ph: frame.track?.phase ?? null,
                v: r2(frame.track?.value),
                f: roundFeatures(frame.features),
                ev: (frame.events || []).map((e) => e.phase),
            });
        });

        // Every pose shares one hand, so its features are recorded once and
        // each pose contributes only its verdict.
        bus.subscribe('handPoses', (payload) => {
            if (!payload) {
                this._push({ ch: 'poses', nul: true });
                return;
            }
            const verdicts = {};
            let features = null;
            let t = null;
            for (const [kind, frame] of Object.entries(payload)) {
                if (!frame?.quality) continue;
                verdicts[kind] = {
                    r: frame.quality.reason,
                    b: frame.quality.blockedBy ?? [],
                    ph: frame.track?.phase ?? null,
                    ev: (frame.events || []).map((e) => e.phase),
                };
                features ??= roundFeatures(frame.features);
                t ??= r2(frame.t);
            }
            this._push({ ch: 'poses', t, f: features, k: verdicts });
        });
    }

    _push(row) {
        row.wall = Date.now();
        if (this.runId) row.run = this.runId;
        if (this.cue) {
            row.cue = this.cue.pose;
            row.stage = this.cue.stage;
        }
        this.rows.push(row);
        if (this.rows.length > MAX_ROWS) this.rows.shift();
        if (this.sink) this.pending.push(row);
    }

    _flush() {
        if (!this.pending.length) return;
        const body = this.pending.map((row) => JSON.stringify(row)).join('\n');
        this.pending = [];
        // text/plain keeps this a CORS "simple request": no preflight, so the
        // sink stays a dozen lines.
        fetch(this.sink, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })
            .catch(() => { /* sink down: rows are still in memory */ });
    }

    /**
     * Walk the pose sequence with a large on-video prompt. Each pose gets a
     * READY window (not scored — you are moving into it) and a HOLD window.
     */
    async guided({ onCue } = {}) {
        const run = ++this.guidedRun;
        this.runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        this._push({ ch: 'meta', event: 'guided-start', sequence: GUIDED_SEQUENCE });
        const overlay = this._overlay();
        overlay.hidden = false;
        const frames = this._startFrames(run);

        for (const pose of GUIDED_SEQUENCE) {
            for (const [stage, ms] of [['ready', READY_MS], ['hold', HOLD_MS]]) {
                if (run !== this.guidedRun) return;
                this.cue = { pose, stage };
                onCue?.(this.cue);
                const until = performance.now() + ms;
                while (performance.now() < until) {
                    if (run !== this.guidedRun) return;
                    const left = Math.ceil((until - performance.now()) / 1000);
                    this._paintOverlay(overlay, pose, stage, left);
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }
        }

        this.cue = null;
        frames.stop();
        this._push({ ch: 'meta', event: 'guided-end', frames: frames.count() });
        this._flush();
        overlay.hidden = true;
        this.runId = null;
    }

    /**
     * Camera frames to the sink at ~5 fps, each tagged with the cue it was
     * taken under. No sink, no frames: they are only useful on disk.
     */
    _startFrames(run) {
        let index = 0;
        let timer = null;
        const video = document.getElementById('video-feed')
            || window.SharedCameraManager?.videoElement;
        const base = this.sink?.replace(/\/log$/, '');
        if (base && video) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const runId = this.runId;
            timer = setInterval(() => {
                if (run !== this.guidedRun || !video.videoWidth) return;
                canvas.width = FRAME_WIDTH;
                canvas.height = Math.round(FRAME_WIDTH * video.videoHeight / video.videoWidth);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const i = index++;
                const cue = this.cue;
                this._push({ ch: 'frame', i });
                canvas.toBlob((blob) => {
                    if (!blob) return;
                    const q = new URLSearchParams({
                        run: runId, i: String(i),
                        cue: cue?.pose ?? '', stage: cue?.stage ?? '',
                    });
                    fetch(`${base}/frame?${q}`, { method: 'POST', body: blob })
                        .catch(() => {});
                }, 'image/jpeg', 0.85);
            }, FRAME_MS);
        }
        return {
            stop: () => clearInterval(timer),
            count: () => index,
        };
    }

    stop() {
        this.guidedRun++;
        this.cue = null;
        this.runId = null;
        if (this.overlay) this.overlay.hidden = true;
    }

    _overlay() {
        if (this.overlay) return this.overlay;
        const el = document.createElement('div');
        el.id = 'hand-guided-overlay';
        el.hidden = true;
        el.innerHTML = `
            <div class="hgo-stage" data-hgo-stage></div>
            <div class="hgo-pose" data-hgo-pose></div>
            <div class="hgo-cue" data-hgo-cue></div>
            <div class="hgo-count" data-hgo-count></div>
            <button class="hgo-stop" data-hgo-stop>stop</button>`;
        el.querySelector('[data-hgo-stop]').addEventListener('click', () => this.stop());
        (document.getElementById('main-area') || document.body).appendChild(el);
        this.overlay = el;
        return el;
    }

    _paintOverlay(el, pose, stage, secondsLeft) {
        const label = pose === 'rest' ? 'Hands down, relaxed' : (this.labels[pose] || pose);
        el.dataset.stage = stage;
        el.querySelector('[data-hgo-stage]').textContent = stage === 'ready' ? 'get ready' : 'HOLD';
        el.querySelector('[data-hgo-pose]').textContent = label;
        el.querySelector('[data-hgo-cue]').textContent = pose === 'rest' ? '' : (this.cues[pose] || '');
        el.querySelector('[data-hgo-count]').textContent = String(secondsLeft);
    }

    /**
     * Per cued pose, over its HOLD window: how often each pose was active, and
     * the dominant blocking reasons for the pose that was asked for. Readable
     * straight from the console or an agent's javascript call.
     */
    summary({ run } = {}) {
        const rows = this.rows.filter((row) => row.stage === 'hold' && (!run || row.run === run));
        const byCue = {};
        for (const row of rows) {
            const bucket = byCue[row.cue] ??= {
                handFrames: 0, handCounts: {}, nulls: 0,
                poseFrames: 0, active: {}, reasons: {},
                prayFrames: 0, prayActive: 0, prayReasons: {},
            };
            if (row.ch === 'hand') {
                if (row.nul) bucket.nulls++;
                else {
                    bucket.handFrames++;
                    bucket.handCounts[row.n] = (bucket.handCounts[row.n] || 0) + 1;
                }
            } else if (row.ch === 'poses' && row.k) {
                bucket.poseFrames++;
                for (const [kind, v] of Object.entries(row.k)) {
                    if (v.ph && v.ph !== 'idle') bucket.active[kind] = (bucket.active[kind] || 0) + 1;
                }
                const own = row.k[row.cue];
                if (own) {
                    const why = own.r === 'blocked' ? `blocked: ${own.b.join(' + ')}` : own.r;
                    bucket.reasons[why] = (bucket.reasons[why] || 0) + 1;
                }
            } else if (row.ch === 'pray' && !row.nul) {
                bucket.prayFrames++;
                if (row.ph && row.ph !== 'idle') bucket.prayActive++;
                const why = row.r === 'blocked' ? `blocked: ${row.b.join(' + ')}` : row.r;
                bucket.prayReasons[why] = (bucket.prayReasons[why] || 0) + 1;
            }
        }
        return byCue;
    }

    download() {
        const blob = new Blob([this.rows.map((row) => JSON.stringify(row)).join('\n')],
            { type: 'application/x-ndjson' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `hand-lab-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
}
