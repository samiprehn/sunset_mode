// Sunset Mode — content script
// Receives state messages from the service worker and adjusts overlay opacity.

const OVERLAY_ID = 'sunset-mode-overlay';
const PEAK_OPACITY = 0.45;

function getOrCreateOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = OVERLAY_ID;
        (document.body || document.documentElement).appendChild(el);
    }
    return el;
}

function applyState(state) {
    const el = getOrCreateOverlay();
    if (!state || state.phase === 'off') {
        el.style.opacity = '0';
        return;
    }
    if (state.phase === 'ramp') {
        // Linear ramp from 10% → PEAK over the time between startedAt and sunsetMs (~30 min normally).
        const span = Math.max(state.sunsetMs - state.startedAt, 1);
        const elapsed = Math.min(Math.max(Date.now() - state.startedAt, 0), span);
        const opacity = 0.1 + (PEAK_OPACITY - 0.1) * (elapsed / span);
        el.style.opacity = String(opacity);
    } else if (state.phase === 'peak') {
        el.style.opacity = String(PEAK_OPACITY);
    } else if (state.phase === 'fade') {
        // Fade from peak → 0 over T+1min to T+15min (14-minute window).
        const fadeStart = state.sunsetMs + 1 * 60 * 1000;
        const span = 14 * 60 * 1000;
        const elapsed = Math.min(Math.max(Date.now() - fadeStart, 0), span);
        const opacity = PEAK_OPACITY * (1 - elapsed / span);
        el.style.opacity = String(Math.max(opacity, 0));
    }
}

let pollTimer = null;
function startPolling(state) {
    stopPolling();
    if (!state || state.phase === 'off' || state.phase === 'peak') return;
    pollTimer = setInterval(() => applyState(state), 30000); // recompute every 30s
}
function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Listen for state pushes
chrome.runtime?.onMessage.addListener((msg) => {
    if (msg?.type === 'overlay') {
        applyState(msg.state);
        startPolling(msg.state);
    }
});

// On load, ask for current state in case we missed a broadcast
(async () => {
    try {
        const { overlay } = await chrome.storage.local.get('overlay');
        if (overlay) {
            applyState(overlay);
            startPolling(overlay);
        }
    } catch (e) { /* extension context not available */ }
})();
