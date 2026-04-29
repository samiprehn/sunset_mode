# Sunset Mode

A Chrome extension that nudges you outdoors at golden hour.

An hour before San Diego sunset, your browser starts warming its color temperature, surfaces tonight's best viewpoint pulled from [SD Sunset](https://samiprehn.github.io/sd-sunset/), and quietly suggests pausing what you're doing. The browser physically nudging you outside.

If the forecast grades the night a **D or F** (marine layer, low clouds, hazy), the extension stays silent — no point.

## Behavior

- **T – 60 min**: Notification with tonight's pick. Color overlay fades in across all tabs.
- **T – 60 min → T**: Overlay opacity ramps to 45% over the hour.
- **T**: Peak warm.
- **T → T + 30 min**: Overlay fades back to nothing.

## Install (unpacked)

1. Visit `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and pick this `sunset_mode/` directory
4. Pin the extension to your toolbar so the popup is one click away

## Popup

- Shows today's pick + grade + cloud %
- **Preview warming (60s)** — fires the overlay immediately so you can see what the effect looks like
- **Refresh forecast** — re-fetches NWS + TAF data and updates the pick

## How tonight's pick is computed

The service worker mirrors the verdict logic from [`sd_sunset/check_sunset.py`](https://github.com/samiprehn/sd-sunset/blob/main/check_sunset.py):

- **NWS gridpoint cloud cover** at the moment of sunset (one gridpoint per spot)
- **TAF data** from the nearest airport, via `sd-sunset-taf.sami-prehn.workers.dev`
- Verdict + grade combine cloud % with TAF cloud-layer info; lower-altitude clouds get penalized, high cirrus is rewarded

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker (alarms, forecast fetch, broadcast)
- `overlay.js` + `overlay.css` — content script that renders the warming filter
- `popup.html` / `popup.js` / `popup.css` — toolbar popup
- `icons/` — 16/48/128px PNGs

## Permissions

- `alarms` — schedule the daily T–30 wake-up
- `notifications` — surface the pick
- `scripting` + `<all_urls>` — inject the overlay everywhere
- `storage` — persist enable/disable + today's pick

No data leaves your machine; the only network calls are to `api.weather.gov`, `aviationweather.gov` (via the existing Worker), and the linked sd-sunset page if you click through.

## Limitations

- San Diego only (`SD_LAT = 32.72`, `SD_LON = -117.22` in `background.js`)
- Overlay can't apply to `chrome://`, `chrome-extension://`, or PDF viewers
- If your browser is closed at T–30, you miss that day's nudge — alarms only fire while Chrome is running
