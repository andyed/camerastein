/**
 * SlideGest — Background Service Worker
 *
 * Manages the offscreen document (camera + MediaPipe) and relays
 * swipe events to the active tab's content script.
 *
 * Badge states:
 *   (empty)  — detection disabled
 *   "ON"     — detection running, waiting for fist
 *   "✊"     — fist recognized, swipe mode armed
 */

let enabled = false;
let fistArmed = false;

// ── Offscreen document lifecycle ──────────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Camera access for hand gesture detection via MediaPipe'
  });
}

async function teardownOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    await chrome.offscreen.closeDocument();
  }
}

// ── Toggle enable/disable ─────────────────────────────────────────────────

async function toggle() {
  enabled = !enabled;
  fistArmed = false;
  if (enabled) {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: 'start-detection' });
  } else {
    chrome.runtime.sendMessage({ type: 'stop-detection' });
    await teardownOffscreen();
  }
  updateBadge();
  return enabled;
}

function updateBadge() {
  if (!enabled) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (fistArmed) {
    chrome.action.setBadgeText({ text: '✊' });
    chrome.action.setBadgeBackgroundColor({ color: '#e8a040' });
  } else {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ecdc4' });
  }
}

// ── Message routing ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'toggle') {
    toggle().then(state => sendResponse({ enabled: state }));
    return true;
  }

  if (msg.type === 'get-state') {
    sendResponse({ enabled, fistArmed });
    return;
  }

  // Fist state changed in offscreen → update badge
  if (msg.type === 'fist-state') {
    fistArmed = msg.active;
    updateBadge();
  }

  // Swipe detected in offscreen → forward to active tab
  if (msg.type === 'swipe') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'inject-key',
          direction: msg.direction
        });
      }
    });
  }
});

// Init badge
updateBadge();
