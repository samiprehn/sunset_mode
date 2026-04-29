const pickEl = document.getElementById('pick');
const enabledEl = document.getElementById('enabled');
const previewBtn = document.getElementById('preview');
const refreshBtn = document.getElementById('refresh');

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderPick(top, sunsetMs) {
    if (!top) {
        pickEl.innerHTML = `<div class="muted">No forecast yet — click "Refresh forecast" below.</div>`;
        return;
    }
    pickEl.innerHTML = `
        <div class="pick-name">${top.name}<span class="pick-grade grade-${top.grade.replace('+', '\\+')}">${top.grade}</span></div>
        <div class="pick-meta">${top.label}${top.cloud != null ? ` · ${top.cloud}% clouds` : ''}</div>
        ${sunsetMs ? `<div class="pick-meta">Sunset at ${fmtTime(sunsetMs)}</div>` : ''}
    `;
}

async function load() {
    const { todayPick, todaySunset, enabled = true } = await chrome.storage.local.get(['todayPick', 'todaySunset', 'enabled']);
    enabledEl.checked = !!enabled;
    renderPick(todayPick, todaySunset);
}

enabledEl.addEventListener('change', async () => {
    await chrome.storage.local.set({ enabled: enabledEl.checked });
    chrome.runtime.sendMessage({ type: 'reschedule' });
});

previewBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'preview' });
    previewBtn.textContent = 'Previewing… (60s)';
    setTimeout(() => { previewBtn.textContent = 'Preview warming (60s)'; }, 60000);
});

refreshBtn.addEventListener('click', async () => {
    refreshBtn.textContent = 'Fetching…';
    const resp = await chrome.runtime.sendMessage({ type: 'refreshPick' });
    if (resp?.top) renderPick(resp.top, resp.sunsetMs);
    refreshBtn.textContent = 'Refresh forecast';
});

load();
