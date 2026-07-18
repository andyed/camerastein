const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const sensitivityEl = document.getElementById('sensitivity');

function updateUI(state) {
  const { enabled, fistArmed } = state;
  toggleBtn.textContent = enabled ? 'Disable' : 'Enable';
  toggleBtn.classList.toggle('active', enabled);

  if (!enabled) {
    statusEl.textContent = 'Disabled';
    statusEl.className = 'status';
  } else if (fistArmed) {
    statusEl.textContent = 'Fist recognized — swipe to advance';
    statusEl.className = 'status armed';
  } else {
    statusEl.textContent = 'Show fist to arm swipe mode';
    statusEl.className = 'status on';
  }
}

// Get initial state
chrome.runtime.sendMessage({ type: 'get-state' }, (resp) => {
  if (resp) updateUI(resp);
});

// Poll for fist state changes while popup is open
const pollInterval = setInterval(() => {
  chrome.runtime.sendMessage({ type: 'get-state' }, (resp) => {
    if (resp) updateUI(resp);
  });
}, 500);

toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'toggle' }, (resp) => {
    if (resp) updateUI({ enabled: resp.enabled, fistArmed: false });
  });
});

sensitivityEl.addEventListener('input', () => {
  const val = parseInt(sensitivityEl.value) / 100;
  chrome.runtime.sendMessage({ type: 'set-sensitivity', minDistance: val });
});
