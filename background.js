// Sunset Mode — service worker
// Schedules a daily alarm 60 min before San Diego sunset, picks tonight's
// best viewpoint, fires a notification, and broadcasts overlay-state to
// content scripts on every tab.

const NUDGE_LEAD_MINUTES = 60;

const SD_LAT = 32.72;
const SD_LON = -117.22;
const SITE_URL = 'https://samiprehn.github.io/sd-sunset/';
const TAF_WORKER = 'https://sd-sunset-taf.sami-prehn.workers.dev';

// Skip the nudge if the top spot grades D or F (no point — sunset will be a dud).
const MIN_GRADE_RANK = { 'A+': 0, A: 1, B: 2, C: 3, D: 4, F: 5 };
const SKIP_THRESHOLD = MIN_GRADE_RANK.C; // grade rank > C → skip

// ── Spots (mirrors sd_sunset/index.html) ───────────────────────────────────
const SPOTS = [
    { name: 'Sunset Cliffs',           grid: 'SGX/53,14', taf: 'KSAN', place: 'Sunset Cliffs Natural Park, San Diego, CA' },
    { name: 'Torrey Pines Gliderport', grid: 'SGX/55,22', taf: 'KNKX', place: 'Torrey Pines Gliderport, La Jolla, CA' },
    { name: 'Mt Soledad',              grid: 'SGX/54,20', taf: 'KSAN', place: 'Mt Soledad National Veterans Memorial, La Jolla, CA' },
    { name: 'Coronado',                grid: 'SGX/56,13', taf: 'KNZY', place: 'Coronado Dog Beach, Coronado, CA' },
    { name: 'OB',                      grid: 'SGX/54,16', taf: 'KSAN', place: 'Ocean Beach Dog Beach, San Diego, CA' },
    { name: 'La Jolla Shores',         grid: 'SGX/54,21', taf: 'KSAN', place: 'Kellogg Park, La Jolla Shores, La Jolla, CA' },
    { name: 'Presidio Park',           grid: 'SGX/56,16', taf: 'KSAN', place: 'Presidio Park, San Diego, CA' },
    { name: 'Mt Helix',                grid: 'SGX/63,15', taf: 'KNKX', place: 'Mt Helix Park, La Mesa, CA' },
    { name: 'Ponto Beach',             grid: 'SGX/54,31', taf: 'KCRQ', place: 'Ponto Beach, Carlsbad, CA' },
    { name: 'Del Mar',                 grid: 'SGX/55,26', taf: 'KCRQ', place: 'Del Mar Dog Beach, Del Mar, CA' },
];

// ── Sun position (suncalc-style port from skywatch) ────────────────────────
const PI = Math.PI, RAD = PI / 180;
const OBLIQUITY = RAD * 23.4397;
const toJulian = (d) => d.getTime() / 86400000 - 0.5 + 2440588;
const toDays = (d) => toJulian(d) - 2451545;

function solarMeanAnomaly(d) { return RAD * (357.5291 + 0.98560028 * d); }
function eclipticLongitude(M) {
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + RAD * 102.9372 + PI;
}
function sunCoords(d) {
    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    return {
        dec: Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)),
        ra:  Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L)),
    };
}
function siderealTime(d, lw) { return RAD * (280.16 + 360.9856235 * d) - lw; }

// Find sunset = next time sun altitude crosses below the horizon at SD.
// Returns Date. Uses 1-min sampling around the typical SD sunset window.
function sunAltitude(date) {
    const d = toDays(date);
    const c = sunCoords(d);
    const H = siderealTime(d, RAD * -SD_LON) - c.ra;
    return Math.asin(Math.sin(RAD * SD_LAT) * Math.sin(c.dec)
                   + Math.cos(RAD * SD_LAT) * Math.cos(c.dec) * Math.cos(H));
}
function sunsetForDate(date) {
    // Search from local 16:00 to 21:00 in 1-min steps for the zero-crossing.
    const start = new Date(date); start.setHours(16, 0, 0, 0);
    let prev = sunAltitude(start);
    for (let i = 1; i < 5 * 60; i++) {
        const t = new Date(start.getTime() + i * 60000);
        const cur = sunAltitude(t);
        if (prev > 0 && cur <= 0) {
            // Linear interpolate the exact crossing
            const frac = prev / (prev - cur);
            return new Date(start.getTime() + (i - 1 + frac) * 60000);
        }
        prev = cur;
    }
    return null;
}

// ── NWS + TAF (mirrors check_sunset.py) ───────────────────────────────────
function parseDuration(iso) {
    const m = iso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
    if (!m) return 0;
    return ((+(m[1]||0)*24 + +(m[2]||0))*60 + +(m[3]||0)) * 60000;
}
function valueAtTime(values, target) {
    for (const e of values) {
        const [s, dur] = e.validTime.split('/');
        const start = new Date(s).getTime();
        const end = start + parseDuration(dur);
        if (target >= start && target < end) return e.value;
    }
    return null;
}
async function fetchGrid(grid) {
    const r = await fetch(`https://api.weather.gov/gridpoints/${grid}`);
    if (!r.ok) throw new Error(`NWS ${grid}: ${r.status}`);
    const d = await r.json();
    const props = d.properties || {};
    return {
        skyCover: (props.skyCover?.values) || [],
        weather:  (props.weather?.values)  || [],
    };
}
async function fetchTAFs(stations) {
    const ids = [...new Set(stations)].join(',');
    const r = await fetch(`${TAF_WORKER}/?ids=${ids}`);
    if (!r.ok) return {};
    const data = await r.json();
    const map = {};
    for (const rec of data) {
        if (rec.icaoId && !map[rec.icaoId]) map[rec.icaoId] = rec;
    }
    return map;
}
function tafPeriodAt(rec, targetSec) {
    if (!rec || !Array.isArray(rec.fcsts)) return null;
    for (const p of rec.fcsts) {
        if (p.timeFrom <= targetSec && targetSec < p.timeTo) return p;
    }
    return null;
}
function classifyTAF(period) {
    if (!period || !Array.isArray(period.clouds)) return { score: 0, verdict: null };
    const clouds = period.clouds.filter(c => c && c.base !== null);
    const veryLow = clouds.filter(c => c.base < 3000);
    const low     = clouds.filter(c => c.base < 5000);
    const high    = clouds.filter(c => c.base >= 20000);
    const veryLowHeavy = veryLow.find(c => c.cover === 'BKN' || c.cover === 'OVC');
    const lowHeavy     = low.find(c => c.cover === 'BKN' || c.cover === 'OVC');
    const lowMed       = low.find(c => c.cover === 'SCT');
    const lowLight     = low.find(c => c.cover === 'FEW');
    const highHeavy    = high.find(c => c.cover === 'BKN' || c.cover === 'OVC');

    let score = 0, verdict = null;
    if (veryLowHeavy) { score += 60; verdict = 'Marine layer'; }
    else if (lowHeavy) { score += 40; verdict = `Low clouds (${lowHeavy.base}ft)`; }
    else if (lowMed)   { score += 20; verdict = `Patchy low clouds (${lowMed.base}ft)`; }
    else if (lowLight) { score += 10; }
    if (highHeavy && !veryLowHeavy && !lowHeavy) {
        score -= 15;
        if (!verdict) verdict = 'Cirrus — best color';
    }
    return { score, verdict };
}
function verdictForCloud(cloud) {
    if (cloud < 20) return 'Clear & golden';
    if (cloud < 50) return 'Great for color';
    if (cloud < 75) return 'Partly cloudy';
    if (cloud < 90) return 'Hazy';
    return 'Socked in';
}
function gradeFor(label) {
    if (label === 'Cirrus — best color') return 'A+';
    if (label === 'Great for color')     return 'A';
    if (label === 'Partly cloudy')       return 'B';
    if (label === 'Clear & golden')      return 'C';
    if (label === 'Hazy')                return 'D';
    if (label.startsWith('Low clouds'))  return 'D';
    if (label.startsWith('Patchy low'))  return 'C';
    if (label === 'Marine layer')        return 'F';
    if (label === 'Socked in')           return 'D';
    return 'D';
}
function blockingWeather(weatherVal) {
    if (!Array.isArray(weatherVal)) return null;
    return weatherVal.find(w => w && w.weather) || null;
}

async function pickTopSpot(sunsetDate) {
    const grids = {};
    for (const s of SPOTS) {
        if (!grids[s.grid]) {
            try { grids[s.grid] = await fetchGrid(s.grid); }
            catch (e) { console.warn('grid fail', s.grid, e); grids[s.grid] = { skyCover: [], weather: [] }; }
        }
    }
    const tafs = await fetchTAFs(SPOTS.map(s => s.taf)).catch(() => ({}));

    const sunsetMs = sunsetDate.getTime();
    const sunsetSec = Math.floor(sunsetMs / 1000);

    const evaluated = [];
    for (const s of SPOTS) {
        const cloud = valueAtTime(grids[s.grid].skyCover, sunsetMs);
        if (cloud == null) continue;
        const blocker = blockingWeather(valueAtTime(grids[s.grid].weather, sunsetMs));
        const taf = classifyTAF(tafPeriodAt(tafs[s.taf], sunsetSec));

        let label;
        if (taf.verdict)   label = taf.verdict;
        else if (blocker)  label = (blocker.weather || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
        else               label = verdictForCloud(cloud);

        const grade = gradeFor(label);
        let score = Math.abs(cloud - 40) + taf.score;
        if (blocker && !taf.verdict) score += 35;
        evaluated.push({ ...s, cloud, label, grade, score });
    }
    evaluated.sort((a, b) => a.score - b.score);
    return evaluated[0] || null;
}

// ── Alarm scheduling ──────────────────────────────────────────────────────
async function scheduleNextNudge() {
    const now = new Date();
    let target = sunsetForDate(now);
    if (!target || target.getTime() - NUDGE_LEAD_MINUTES * 60000 < now.getTime()) {
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
        target = sunsetForDate(tomorrow);
    }
    if (!target) return;
    const fireAt = target.getTime() - NUDGE_LEAD_MINUTES * 60000;
    chrome.alarms.create('sunset-nudge', { when: fireAt });
    const sunsetMs = target.getTime();
    chrome.alarms.create('sunset-peak',     { when: sunsetMs });
    chrome.alarms.create('sunset-fade',     { when: sunsetMs + 30 * 60000 });
    chrome.alarms.create('sunset-off',      { when: sunsetMs + 60 * 60000 });
    await chrome.storage.local.set({ nextSunset: sunsetMs, nextNudge: fireAt });
    console.log('Next sunset', target.toString(), 'nudge at', new Date(fireAt).toString());
}

async function broadcastOverlay(state) {
    // state: { phase: 'ramp'|'peak'|'fade'|'off', startedAt, sunsetMs }
    await chrome.storage.local.set({ overlay: state });
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        if (/^(chrome|chrome-extension|edge|about|view-source):/.test(tab.url)) continue;
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'overlay', state });
        } catch (e) {
            try {
                await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
                await chrome.tabs.sendMessage(tab.id, { type: 'overlay', state }).catch(() => {});
            } catch (e2) { /* restricted page, skip */ }
        }
    }
}

async function fireNudge() {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    if (!enabled) { scheduleNextNudge(); return; }

    const sunset = sunsetForDate(new Date());
    if (!sunset) { scheduleNextNudge(); return; }
    let top;
    try { top = await pickTopSpot(sunset); } catch (e) { console.error(e); }

    await chrome.storage.local.set({ todayPick: top, todaySunset: sunset.getTime() });

    if (!top) { scheduleNextNudge(); return; }
    const rank = MIN_GRADE_RANK[top.grade] ?? 5;
    if (rank > SKIP_THRESHOLD) {
        console.log('Skipping nudge — grade', top.grade);
        scheduleNextNudge();
        return;
    }

    const time = sunset.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    chrome.notifications.create('sunset-nudge', {
        type: 'basic',
        iconUrl: 'icons/128.png',
        title: `🌅 Tonight's pick: ${top.name}`,
        message: `${top.grade} · ${top.label} · sunset at ${time}. Step outside?`,
        buttons: [{ title: 'See live forecast' }],
        priority: 1,
    });

    broadcastOverlay({ phase: 'ramp', startedAt: Date.now(), sunsetMs: sunset.getTime() });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    const { todaySunset } = await chrome.storage.local.get('todaySunset');
    switch (alarm.name) {
        case 'sunset-nudge': fireNudge(); break;
        case 'sunset-peak':  broadcastOverlay({ phase: 'peak', sunsetMs: todaySunset }); break;
        case 'sunset-fade':  broadcastOverlay({ phase: 'fade', sunsetMs: todaySunset }); break;
        case 'sunset-off':
            broadcastOverlay({ phase: 'off' });
            scheduleNextNudge();
            break;
    }
});

chrome.notifications.onClicked.addListener((id) => {
    if (id === 'sunset-nudge') chrome.tabs.create({ url: SITE_URL });
});
chrome.notifications.onButtonClicked.addListener((id, btnIdx) => {
    if (id === 'sunset-nudge') chrome.tabs.create({ url: SITE_URL });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ enabled: true });
    scheduleNextNudge();
});
chrome.runtime.onStartup.addListener(() => scheduleNextNudge());

// Allow popup to trigger a preview / refresh
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg?.type === 'preview') {
            // Force peak immediately so the effect is unmistakable, then off after 60s
            await broadcastOverlay({ phase: 'peak', sunsetMs: Date.now() });
            setTimeout(() => broadcastOverlay({ phase: 'off' }), 60000);
            sendResponse({ ok: true });
        } else if (msg?.type === 'refreshPick') {
            const sunset = sunsetForDate(new Date());
            const top = sunset ? await pickTopSpot(sunset).catch(() => null) : null;
            await chrome.storage.local.set({ todayPick: top, todaySunset: sunset?.getTime() });
            sendResponse({ ok: true, top, sunsetMs: sunset?.getTime() });
        } else if (msg?.type === 'reschedule') {
            scheduleNextNudge();
            sendResponse({ ok: true });
        }
    })();
    return true; // keep channel open for async sendResponse
});
