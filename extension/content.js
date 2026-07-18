/**
 * Slide Gesture — Content Script
 *
 * Receives swipe direction from the background service worker and
 * injects arrow key events into the page. Works in Google Slides,
 * Reveal.js, Slidev, or any web presentation tool that listens
 * for arrow keys.
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'inject-key') return;

  const key = msg.direction === 'left' ? 'ArrowLeft' : 'ArrowRight';

  // Dispatch on document.body — Google Slides listens here in
  // presentation mode. Both keydown and keyup for full lifecycle.
  const opts = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
  };

  document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
  document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
});
