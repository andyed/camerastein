/**
 * SlideGest — Offscreen Document
 *
 * Runs camera + MediaPipe Hands in the offscreen context (Manifest V3
 * content scripts can't access getUserMedia). Detects fist → swipe
 * gesture sequence and sends direction events to the service worker.
 *
 * Activation model: fist activates swipe mode, open hand swipe
 * triggers arrow key. Fist state is reported to background for
 * icon badge feedback.
 *
 * Hand-only — no head or body detection loaded.
 */

import { HandLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';

// ── MediaPipe Hands ───────────────────────────────────────────────────────

let handLandmarker = null;
let running = false;

async function loadHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL('vendor/wasm')
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL('vendor/models/hand_landmarker.task'),
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
}

// ── Camera ────────────────────────────────────────────────────────────────

const video = document.getElementById('video');
let stream = null;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: 'user' }
  });
  video.srcObject = stream;
  await new Promise(r => { video.onloadeddata = r; });
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

// ── Fist Detection ────────────────────────────────────────────────────────
// Fist = all fingertips close to palm center. Gates swipe mode.

const FIST = {
  closureThreshold: 0.12,   // max avg fingertip-to-palm distance (normalized)
  cooldownMs: 500,           // min time between fist toggle events
  holdMs: 200,               // must hold fist for this long to activate
};

let fistState = {
  active: false,             // true = swipe mode armed
  fistStartTime: 0,
  lastToggleTime: 0,
  wasFist: false,
};

function detectFist(landmarks) {
  if (!landmarks || landmarks.length === 0) return false;

  const hand = landmarks[0];
  // Palm center ≈ average of wrist + MCP joints
  const palmPts = [0, 5, 9, 13, 17]; // wrist + 4 MCP bases
  let px = 0, py = 0;
  for (const idx of palmPts) {
    px += hand[idx].x;
    py += hand[idx].y;
  }
  px /= palmPts.length;
  py /= palmPts.length;

  // Fingertip distances to palm center
  const tipIndices = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky tips
  let totalDist = 0;
  for (const idx of tipIndices) {
    const dx = hand[idx].x - px;
    const dy = hand[idx].y - py;
    totalDist += Math.sqrt(dx * dx + dy * dy);
  }
  const avgDist = totalDist / tipIndices.length;

  return avgDist < FIST.closureThreshold;
}

function updateFistState(landmarks) {
  const now = performance.now();
  const isFist = detectFist(landmarks);

  if (isFist && !fistState.wasFist) {
    // Fist just started
    fistState.fistStartTime = now;
  }

  if (isFist && (now - fistState.fistStartTime >= FIST.holdMs)) {
    // Held fist long enough — toggle activation
    if (!fistState.active && (now - fistState.lastToggleTime >= FIST.cooldownMs)) {
      fistState.active = true;
      fistState.lastToggleTime = now;
      chrome.runtime.sendMessage({ type: 'fist-state', active: true });
    }
  }

  if (!isFist && fistState.wasFist && fistState.active) {
    // Fist released while active — stay active for swipe detection.
    // Deactivation happens after a swipe fires or after timeout.
  }

  // No hand visible for 2s → deactivate
  if (!landmarks || landmarks.length === 0) {
    if (fistState.active && (now - fistState.lastToggleTime > 2000)) {
      fistState.active = false;
      chrome.runtime.sendMessage({ type: 'fist-state', active: false });
    }
  }

  fistState.wasFist = isFist;
  return fistState.active;
}

// ── Swipe Detection ───────────────────────────────────────────────────────
// Ported from demos/swipe-nav.html — displacement-based, not velocity-based.

const SWIPE = {
  minDistance: 0.10,
  minConsecutive: 3,
  cooldownMs: 800,
  settleMs: 400,
};

const swipeState = {
  lastSwipeTime: 0,
  history: [],
  historyMax: 16,
  lastDirection: 0,
};

function trackWrist(landmarks) {
  if (!landmarks || landmarks.length === 0) {
    swipeState.history = [];
    swipeState.lastDirection = 0;
    return;
  }
  const wrist = landmarks[0][0];
  if (!wrist) return;

  swipeState.history.push({ x: 1 - wrist.x, t: performance.now() });
  if (swipeState.history.length > swipeState.historyMax) {
    swipeState.history.shift();
  }
}

function detectSwipe() {
  const now = performance.now();
  const hist = swipeState.history;

  if (hist.length < SWIPE.minConsecutive + 1) return null;
  if (now - swipeState.lastSwipeTime < SWIPE.cooldownMs) return null;

  const recent = hist.slice(-SWIPE.minConsecutive - 1);
  let totalDx = 0;
  let consistent = true;
  let direction = 0;

  for (let i = 1; i < recent.length; i++) {
    const dx = recent[i].x - recent[i - 1].x;
    if (i === 1) {
      direction = dx > 0 ? 1 : -1;
    } else if ((dx > 0 ? 1 : -1) !== direction) {
      consistent = false;
      break;
    }
    totalDx += dx;
  }

  if (!consistent) return null;
  if (Math.abs(totalDx) < SWIPE.minDistance) return null;

  if (swipeState.lastDirection !== 0 && direction === -swipeState.lastDirection) {
    const timeSinceLast = now - swipeState.lastSwipeTime;
    if (timeSinceLast < SWIPE.settleMs + SWIPE.cooldownMs) {
      return null;
    }
  }

  swipeState.lastSwipeTime = now;
  swipeState.lastDirection = direction;
  swipeState.history = [];

  return direction > 0 ? 'right' : 'left';
}

// ── Detection Loop ────────────────────────────────────────────────────────

let lastFrameTime = -1;

function detectFrame() {
  if (!running || !handLandmarker) return;

  const now = performance.now();
  if (now === lastFrameTime) {
    requestAnimationFrame(detectFrame);
    return;
  }
  lastFrameTime = now;

  const results = handLandmarker.detectForVideo(video, now);
  const landmarks = results?.landmarks;

  // Fist gating — must fist to arm, then open hand + swipe to fire
  const armed = updateFistState(landmarks);

  if (armed) {
    trackWrist(landmarks);
    const swipe = detectSwipe();
    if (swipe) {
      chrome.runtime.sendMessage({ type: 'swipe', direction: swipe });
      // Deactivate after successful swipe — require re-fist to go again
      fistState.active = false;
      fistState.lastToggleTime = now;
      chrome.runtime.sendMessage({ type: 'fist-state', active: false });
    }
  } else {
    // Not armed — clear swipe history so stale motion doesn't fire on activation
    swipeState.history = [];
  }

  requestAnimationFrame(detectFrame);
}

// ── Message handling ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'start-detection') {
    if (running) return;
    running = true;
    if (!handLandmarker) await loadHandLandmarker();
    await startCamera();
    requestAnimationFrame(detectFrame);
  }

  if (msg.type === 'stop-detection') {
    running = false;
    stopCamera();
  }

  if (msg.type === 'set-sensitivity') {
    SWIPE.minDistance = msg.minDistance;
  }
});
