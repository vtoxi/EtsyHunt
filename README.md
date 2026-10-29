# EtsyHunt

Free Chrome extension for Etsy niche research. Discover keywords, capture search snapshots, audit listings, and generate scored HTML reports — all from your browser. No account. No license. Data stays on your device.

**Privacy policy:** https://github.com/vtoxi/EtsyHunt/blob/main/PRIVACY.md

## Features

- **4-step pipeline** — keyword discovery → Etsy snapshots → listing audit → niche scoring
- **Local-first** — research data is stored in Chrome storage on your machine
- **HTML reports** — downloadable GO / NO-GO niche reports
- **Configurable** — keywords per run, delays, beatable-shop thresholds, and more
- **Free & open source** — use it, fork it, improve it

## Install (developer / sideload)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked** and select this folder
5. Pin **EtsyHunt** to your toolbar

## Package for Chrome Web Store

```powershell
.\scripts\package.ps1
```

Upload the ZIP from `dist/` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

Full listing copy, permission justifications, and privacy checklist: [`store/LISTING.md`](store/LISTING.md).

## Quick start

1. Open the extension popup
2. Enter a seed keyword (e.g. `tote bag`, `wedding invite`)
3. Choose product type: Digital / Physical / Any
4. Click **Run full research**
5. When finished, an HTML report downloads automatically

You can also run any of the four steps individually.

## Pipeline

| Step | Name | What it does |
|------|------|--------------|
| 1 | Discover | Finds related keywords from Etsy suggestions |
| 2 | Capture | Snapshots top search results for each keyword |
| 3 | Audit | Opens listings and reads sales / social-proof signals |
| 4 | Score | Grades keywords and builds a niche report |

## Settings

Open **Advanced settings** in the popup:

| Setting | Default | Notes |
|---------|---------|--------|
| Keywords / run | 20 | Searched and audited |
| Page delay | 7 sec | Minimum 7 — Etsy rate-limits faster crawling |
| Listings / keyword | 12 | Audit depth (12–16 recommended) |
| Beatable reviews | 300 | Shops under this count count as beatable |
| Min beatable slots | 3 | Per keyword |
| Min keywords gate | 5 | Stop early if Step 1 finds too few |

## Privacy

EtsyHunt does not require login to a third-party dashboard. Pipeline data (keywords, listings, audits, scores) lives in `chrome.storage.local`. Clearing extension data or uninstalling removes it. Use **Export** in the activity log to back up run history as JSON.

Full policy: [PRIVACY.md](PRIVACY.md) · [privacy.html](privacy.html)

## Troubleshooting

**Service worker shows (Inactive)**  
Normal for Manifest V3 when idle. It wakes when you open the popup or start a run.

**Empty Etsy results**  
Increase page delay to 7+ seconds.

**Pipeline stops mid-run**  
Check the activity log and use **Copy** / **Export** to save details.

## License

MIT — free for personal and commercial use.
