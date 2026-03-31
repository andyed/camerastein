// timeline-panel.js — Rolling sparkline graphs for motion detection signals
// Polls window.MotionBus.state at 10Hz, renders 6 signal rows on a canvas

const BUFFER_SIZE = 600; // 60 seconds at 10Hz
const POLL_INTERVAL = 100; // 10Hz
const ROW_HEIGHT = 18;
const ROW_GAP = 2;
const LABEL_WIDTH = 90;
const VALUE_WIDTH = 40;

const SIGNALS = [
  { name: 'Head bob',   color: '#4ecdc4', read: s => s.rhythm?.intensity || 0 },
  { name: 'Head vel',   color: '#45b7d1', read: s => Math.min(1, Math.abs(s.rhythm?.headVelocity || 0)) },
  { name: 'Body sway',  color: '#96ceb4', read: s => s.body?.swayAmplitude || 0 },
  { name: 'Body energy', color: '#feca57', read: s => s.body?.energyLevel || 0 },
  { name: 'Hand pinch', color: '#ff6b6b', read: s => s.hand?.pinchStrength || 0 },
  { name: 'Hand vel',   color: '#a78bfa', read: s => Math.min(1, (s.hand?.fingerVelocity || 0) / 2) },
];

// Parse hex color to r,g,b components (used for alpha compositing)
function hexToRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export class TimelinePanel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Ring buffers — one Float32Array per signal
    this.buffers = SIGNALS.map(() => new Float32Array(BUFFER_SIZE));
    this.writePtr = 0;
    this.sampleCount = 0; // total samples written (for knowing how much of buffer is valid)
    this.dirty = false;

    // Pre-compute RGB tuples for each signal color
    this.rgbColors = SIGNALS.map(sig => hexToRGB(sig.color));

    // Current values for the right-side readout
    this.currentValues = new Float32Array(SIGNALS.length);

    this._resizeCanvas();
    this._onResize = () => this._resizeCanvas();
    window.addEventListener('resize', this._onResize);

    // Start polling and rendering
    this._pollId = setInterval(() => this._poll(), POLL_INTERVAL);
    this._rafId = requestAnimationFrame(() => this._renderLoop());
  }

  // --- Polling ---

  _poll() {
    const state = window.MotionBus?.state;
    if (!state) return;

    for (let i = 0; i < SIGNALS.length; i++) {
      const val = SIGNALS[i].read(state);
      // Clamp to 0-1 defensively
      const clamped = isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
      this.buffers[i][this.writePtr] = clamped;
      this.currentValues[i] = clamped;
    }

    this.writePtr = (this.writePtr + 1) % BUFFER_SIZE;
    this.sampleCount++;
    this.dirty = true;
  }

  // --- Resize ---

  _resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = 120 * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = '120px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.displayWidth = rect.width;
    this.dirty = true; // force redraw after resize
  }

  // --- Render ---

  _renderLoop() {
    if (this.dirty) {
      this.dirty = false;
      this._draw();
    }
    this._rafId = requestAnimationFrame(() => this._renderLoop());
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = 120;

    ctx.clearRect(0, 0, w, h);

    const sparkLeft = LABEL_WIDTH;
    const sparkRight = w - VALUE_WIDTH;
    const sparkW = sparkRight - sparkLeft;
    if (sparkW <= 0) return;

    const totalSamples = Math.min(this.sampleCount, BUFFER_SIZE);
    // How many samples to draw — fit them into the sparkline width
    const pxPerSample = sparkW / BUFFER_SIZE;

    for (let i = 0; i < SIGNALS.length; i++) {
      const rowY = i * (ROW_HEIGHT + ROW_GAP);
      const buf = this.buffers[i];
      const [r, g, b] = this.rgbColors[i];

      // --- Label (left) ---
      ctx.font = '10px monospace';
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(SIGNALS[i].name, 4, rowY + ROW_HEIGHT / 2);

      // --- Value (right) ---
      ctx.textAlign = 'right';
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
      ctx.fillText(this.currentValues[i].toFixed(2), w - 4, rowY + ROW_HEIGHT / 2);

      if (totalSamples < 2) continue;

      // --- Sparkline ---
      // Read ring buffer in chronological order: oldest to newest
      // Oldest sample is at writePtr (if buffer is full), newest is at writePtr - 1
      const startIdx = totalSamples < BUFFER_SIZE ? 0 : this.writePtr;

      ctx.beginPath();
      for (let s = 0; s < totalSamples; s++) {
        const bufIdx = (startIdx + s) % BUFFER_SIZE;
        // Position sample relative to the right edge so the graph scrolls left
        const x = sparkLeft + (BUFFER_SIZE - totalSamples + s) * pxPerSample;
        const val = buf[bufIdx];
        const y = rowY + ROW_HEIGHT * (1 - val);
        if (s === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      // Stroke the line
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Fill under the line — close the path along the bottom of the row
      const lastX = sparkLeft + (BUFFER_SIZE - 1) * pxPerSample;
      const firstX = sparkLeft + (BUFFER_SIZE - totalSamples) * pxPerSample;
      ctx.lineTo(lastX, rowY + ROW_HEIGHT);
      ctx.lineTo(firstX, rowY + ROW_HEIGHT);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.1)`;
      ctx.fill();
    }
  }

  // --- Cleanup ---

  destroy() {
    clearInterval(this._pollId);
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
  }
}
