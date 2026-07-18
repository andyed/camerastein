/**
 * Benchmark Harness
 *
 * Measures and displays performance metrics for the MediaPipe
 * detection system: model load times, per-frame detection latency
 * (P50/P95/P99), render FPS, and JS heap usage.
 *
 * Imported by app.js. Call tick() every frame from requestAnimationFrame.
 * Install detection hooks via hookDetectors() after app.js has done
 * its own _onResults wrapping.
 */

const LATENCY_WINDOW = 100;   // rolling sample count per channel
const FPS_WINDOW = 60;        // frames for rolling FPS average
const RENDER_INTERVAL = 500;  // ms between DOM updates
const MEMORY_POLL_INTERVAL = 2000; // ms between performance.memory reads

export class BenchmarkHarness {
    constructor(panelElement) {
        this._panel = panelElement;
        this._dirty = true;
        this._lastRender = 0;

        // --- Model load times (ms) ---
        this.loadTimes = { faceMesh: null, pose: null, hands: null };

        // --- Detection latency rolling windows ---
        this._latency = {
            head: [],
            body: [],
            hand: [],
        };

        // --- Render FPS ---
        this._frameTimes = [];  // timestamps of last N frames
        this._fps = null;

        // --- Memory ---
        this._memory = null;
        this._memoryTimer = null;

        // Monkey-patch loaders to capture load times
        this._hookLoader('faceMesh', window.MediaPipeLoader);
        this._hookLoader('pose', window.PoseLoader);
        this._hookLoader('hands', window.HandsLoader);

        // Start memory polling (Chrome only)
        if (performance.memory) {
            this._pollMemory();
            this._memoryTimer = setInterval(() => this._pollMemory(), MEMORY_POLL_INTERVAL);
        }

        // Wire toggle button
        const toggleBtn = document.getElementById('benchmark-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this._panel.classList.toggle('collapsed');
            });
        }

        // Build initial DOM
        this._render();
    }

    // --- Public API ---

    /**
     * Called every frame from the main render loop.
     * Updates FPS tracking and throttled DOM render.
     */
    tick() {
        const now = performance.now();

        // FPS tracking
        this._frameTimes.push(now);
        if (this._frameTimes.length > FPS_WINDOW) {
            this._frameTimes.shift();
        }
        if (this._frameTimes.length >= 2) {
            const elapsed = this._frameTimes[this._frameTimes.length - 1] - this._frameTimes[0];
            this._fps = ((this._frameTimes.length - 1) / elapsed) * 1000;
        }

        // Throttled DOM update
        if (now - this._lastRender > RENDER_INTERVAL) {
            this._render();
            this._lastRender = now;
        }
    }

    /**
     * Install latency hooks on detectors. Call this from app.js AFTER
     * its own _onResults wrapping so we measure the full pipeline
     * (detector work + forwarding overhead).
     */
    hookDetectors() {
        this._hookDetector('head', window.HeadBobDetector);
        this._hookDetector('body', window.BodyMotionDetector);
        this._hookDetector('hand', window.HandPoseDetector);
    }

    /**
     * Record a latency sample for a given channel.
     * Called by the _onResults wrapper.
     */
    recordLatency(channel, ms) {
        const buf = this._latency[channel];
        if (!buf) return;
        buf.push(ms);
        if (buf.length > LATENCY_WINDOW) {
            buf.shift();
        }
        this._dirty = true;
    }

    /** Latest rolling render FPS for camera resource pacing. */
    getFPS() {
        return this._fps;
    }

    // --- Internals ---

    /**
     * Monkey-patch a loader's .load() to measure time-to-load.
     * Only records the first load per model.
     */
    _hookLoader(name, loader) {
        if (!loader || typeof loader.load !== 'function') return;

        const origLoad = loader.load.bind(loader);
        const harness = this;

        loader.load = async function (...args) {
            // Only measure the first load
            if (harness.loadTimes[name] !== null) {
                return origLoad(...args);
            }
            const t0 = performance.now();
            const result = await origLoad(...args);
            harness.loadTimes[name] = performance.now() - t0;
            harness._dirty = true;
            return result;
        };
    }

    /**
     * Wrap a detector's _onResults to measure execution time.
     */
    _hookDetector(channel, detector) {
        if (!detector || typeof detector._onResults !== 'function') return;

        const orig = detector._onResults;
        const harness = this;

        detector._onResults = function (results) {
            const t0 = performance.now();
            orig.call(this, results);
            harness.recordLatency(channel, performance.now() - t0);
        };
    }

    _pollMemory() {
        if (performance.memory) {
            this._memory = {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
            };
            this._dirty = true;
        }
    }

    /**
     * Compute percentiles from a rolling buffer.
     * Returns { p50, p95, p99 } or null if buffer is empty.
     */
    _percentiles(buf) {
        if (buf.length === 0) return null;
        const sorted = [...buf].sort((a, b) => a - b);
        const p = (pct) => sorted[Math.min(Math.floor(pct / 100 * sorted.length), sorted.length - 1)];
        return { p50: p(50), p95: p(95), p99: p(99) };
    }

    _fmt(val) {
        if (val === null || val === undefined) return '--';
        return val.toFixed(1);
    }

    _fmtInt(val) {
        if (val === null || val === undefined) return '--';
        return Math.round(val).toString();
    }

    _fmtMB(bytes) {
        if (bytes === null || bytes === undefined) return '--';
        return Math.round(bytes / (1024 * 1024)).toString();
    }

    /**
     * Render the benchmark panel HTML. Throttled to every RENDER_INTERVAL ms.
     */
    _render() {
        const lt = this.loadTimes;
        const headP = this._percentiles(this._latency.head);
        const bodyP = this._percentiles(this._latency.body);
        const handP = this._percentiles(this._latency.hand);

        const fpsStr = this._fmtInt(this._fps);
        const memStr = this._memory
            ? `${this._fmtMB(this._memory.used)} / ${this._fmtMB(this._memory.total)} MB`
            : 'N/A';

        this._panel.innerHTML = `
            <div class="bench-section">
                <div class="bench-row"><span class="bench-label" style="font-weight:bold">MODEL LOAD TIMES</span></div>
                <div class="bench-row"><span class="bench-label">Face Mesh</span><span class="bench-value">${this._fmtInt(lt.faceMesh)}${lt.faceMesh !== null ? ' ms' : ''}</span></div>
                <div class="bench-row"><span class="bench-label">Pose</span><span class="bench-value">${this._fmtInt(lt.pose)}${lt.pose !== null ? ' ms' : ''}</span></div>
                <div class="bench-row"><span class="bench-label">Hands</span><span class="bench-value">${this._fmtInt(lt.hands)}${lt.hands !== null ? ' ms' : ''}</span></div>
            </div>
            <div class="bench-section">
                <div class="bench-row"><span class="bench-label" style="font-weight:bold">DETECTION LATENCY (ms)</span></div>
                <div class="bench-row">
                    <span class="bench-label"></span>
                    <span class="bench-value">P50</span>
                    <span class="bench-value">P95</span>
                    <span class="bench-value">P99</span>
                </div>
                <div class="bench-row">
                    <span class="bench-label">Head</span>
                    <span class="bench-value">${headP ? this._fmt(headP.p50) : '--'}</span>
                    <span class="bench-value">${headP ? this._fmt(headP.p95) : '--'}</span>
                    <span class="bench-value">${headP ? this._fmt(headP.p99) : '--'}</span>
                </div>
                <div class="bench-row">
                    <span class="bench-label">Body</span>
                    <span class="bench-value">${bodyP ? this._fmt(bodyP.p50) : '--'}</span>
                    <span class="bench-value">${bodyP ? this._fmt(bodyP.p95) : '--'}</span>
                    <span class="bench-value">${bodyP ? this._fmt(bodyP.p99) : '--'}</span>
                </div>
                <div class="bench-row">
                    <span class="bench-label">Hand</span>
                    <span class="bench-value">${handP ? this._fmt(handP.p50) : '--'}</span>
                    <span class="bench-value">${handP ? this._fmt(handP.p95) : '--'}</span>
                    <span class="bench-value">${handP ? this._fmt(handP.p99) : '--'}</span>
                </div>
            </div>
            <div class="bench-section">
                <div class="bench-row"><span class="bench-label" style="font-weight:bold">PERFORMANCE</span></div>
                <div class="bench-row"><span class="bench-label">Render FPS</span><span class="bench-value">${fpsStr}</span></div>
                <div class="bench-row"><span class="bench-label">Memory</span><span class="bench-value">${memStr}</span></div>
            </div>
            <div class="bench-section">
                <a href="#" class="bench-export-link">Export JSON</a>
            </div>
        `;

        // Wire export link
        const exportLink = this._panel.querySelector('.bench-export-link');
        if (exportLink) {
            exportLink.addEventListener('click', (e) => {
                e.preventDefault();
                this._exportJSON();
            });
        }

        this._dirty = false;
    }

    /**
     * Build a snapshot of all metrics and trigger a JSON download.
     */
    _exportJSON() {
        const snapshot = {
            timestamp: new Date().toISOString(),
            loadTimes: { ...this.loadTimes },
            latency: {
                head: this._percentiles(this._latency.head),
                body: this._percentiles(this._latency.body),
                hand: this._percentiles(this._latency.hand),
            },
            latencyRaw: {
                head: [...this._latency.head],
                body: [...this._latency.body],
                hand: [...this._latency.hand],
            },
            fps: this._fps !== null ? Math.round(this._fps) : null,
            memory: this._memory ? {
                usedMB: Math.round(this._memory.used / (1024 * 1024)),
                totalMB: Math.round(this._memory.total / (1024 * 1024)),
            } : null,
        };

        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const ts = Date.now();
        const a = document.createElement('a');
        a.href = url;
        a.download = `camerastein-bench-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
