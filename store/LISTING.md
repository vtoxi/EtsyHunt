# Chrome Web Store listing — EtsyHunt

Use this copy when submitting at https://chrome.google.com/webstore/devconsole

## Privacy policy URL (required)

**https://github.com/vtoxi/EtsyHunt/blob/main/PRIVACY.md**

Optional nicer URL (if you enable GitHub Pages on this repo, root `/`):

**https://vtoxi.github.io/EtsyHunt/privacy.html**

## Listing fields

### Name
EtsyHunt — Etsy Niche Research

### Short description (≤132 characters)
Free local Etsy niche research: find keywords, audit listings, and download scored niche reports.

### Detailed description

EtsyHunt helps Etsy sellers research niches directly in Chrome — for free.

Run a 4-step pipeline from one seed keyword:

1. Discover related keywords
2. Capture Etsy search snapshots
3. Audit listing pages for sales and social-proof signals
4. Score the niche and download an HTML report

Need to leave mid-run? Use **Stop & save report** to keep a partial report from whatever is already complete, or **Resume research** later from the last finished step.

Everything is local-first. Your research data stays in your browser. No EtsyHunt account. No license key.

Features:
• Full pipeline or single-step runs
• Digital / Physical / Any product-type filter
• Configurable keyword limits, delays, and beatable-shop thresholds
• Activity log with copy / export
• Downloadable niche reports (full or partial if you stop early)
• Resume research after stopping mid-run

How to use:
1. Install EtsyHunt and pin it
2. Enter a seed keyword (for example: tote bag)
3. Choose product type
4. Click Run full research
5. Open the downloaded HTML report when the run finishes (or stop early and open the partial report from the popup)

Notes:
• Runs can take 30–60 minutes depending on your settings
• Use a page delay of at least 7 seconds to avoid empty Etsy pages
• Optional legacy mode can use eRank if you are logged into members.erank.com

EtsyHunt is free and open source (MIT): https://github.com/vtoxi/EtsyHunt

### Category
Productivity (or Shopping)

### Language
English

## Privacy practices (dashboard checkboxes)

Declare accurately:

- **Website content** — Yes (reads Etsy / optional eRank page content during runs you start)
- **Personally identifiable information** — No (unless the user types it into the seed field themselves)
- **Health / financial / authentication / location / personal communications** — No
- **User activity** — Only activity inside the extension (run logs), stored locally
- **Does not sell data** — Yes
- **Limited Use** — Certify yes

Remote code: No  
Single purpose: Etsy niche research automation

## Privacy practices — paste-ready answers

### Single purpose description
Helps Etsy sellers research niches by discovering keywords, capturing Etsy search and listing data, scoring opportunities, and downloading local HTML reports.

### Remote code use
No. EtsyHunt does not use remote code. All JavaScript is packaged inside the extension. It does not download or execute scripts from the network. It only reads publicly visible page content on Etsy (and optionally eRank) during research runs the user starts, and stores results locally.

### storage
Stores the user’s settings, seed keywords, research results (keywords, listings, scores), and activity logs in chrome.storage.local on the user’s device so runs can continue and reports can be generated without a remote database.

### tabs
Creates and controls browser tabs used during a research run the user starts, so the extension can open Etsy (and optionally eRank) pages, wait for them to load, and collect publicly visible niche research data.

### scripting
Used only for the optional legacy eRank keyword workflow, to inject or ensure the content script is available on members.erank.com pages when that workflow is enabled.

### alarms
Keeps the Manifest V3 service worker alive during long multi-step research runs. Without alarms, Chrome can suspend the worker mid-pipeline and stop the run.

### downloads
Saves generated HTML niche reports (full or partial) to the user’s Downloads folder when a run finishes or is stopped with “Stop & save report”, and saves JSON log exports when the user clicks Export.

### Host permissions
https://www.etsy.com/* — Required to open Etsy search and listing pages and extract publicly visible niche research signals during user-started runs.

https://members.erank.com/* — Optional legacy keyword workflow only. Used when that mode is enabled and the user is already logged into eRank in Chrome.

### Certification checkbox
Certify that your data usage complies with the Chrome Web Store Developer Program Policies (Limited Use). Check yes. EtsyHunt does not sell user data and does not use research data for advertising.

## Permission justifications (same text as above, split by field)

**storage**  
Stores the user’s settings, seed keywords, research results (keywords, listings, scores), and activity logs in chrome.storage.local on the user’s device so runs can continue and reports can be generated without a remote database.

**tabs**  
Creates and controls browser tabs used during a research run the user starts, so the extension can open Etsy (and optionally eRank) pages, wait for them to load, and collect publicly visible niche research data.

**scripting**  
Used only for the optional legacy eRank keyword workflow, to inject or ensure the content script is available on members.erank.com pages when that workflow is enabled.

**alarms**  
Keeps the Manifest V3 service worker alive during long multi-step research runs. Without alarms, Chrome can suspend the worker mid-pipeline and stop the run.

**downloads**  
Saves generated HTML niche reports (full or partial) to the user’s Downloads folder when a run finishes or is stopped with “Stop & save report”, and saves JSON log exports when the user clicks Export.

**Host permission**  
https://www.etsy.com/* is required to open Etsy search and listing pages and extract publicly visible niche research signals during user-started runs. https://members.erank.com/* is for the optional legacy eRank keyword workflow only, when that mode is enabled and the user is logged into eRank.

## Screenshots (ready to upload)

All files are **1280×800 PNG (no alpha)** in `store/screenshots/`, rendered from the real popup UI
(not mockups) — see `_src/README.md` to regenerate after a UI change:

| # | File | Shows |
|---|------|--------|
| 1 | `01-start-research.png` | Seed keyword + Run full research |
| 2 | `02-research-in-progress.png` | Live progress + activity log |
| 3 | `03-steps-and-settings.png` | Single-step controls + advanced settings |
| 4 | `04-completed-report.png` | Completed run, GO verdict, **Resume research** + **report history** (new in 1.1.0) |
| 5 | `05-feature-overview.png` | Feature overview cards, incl. Stop/save/resume |

Upload all 5 in the Chrome Web Store listing (order above).

## Promo tiles (ready to upload)

| Tile | Size | File |
|------|------|------|
| Small promo | 440×280 | `promo-small-440x280.png` |
| Marquee promo | 1400×560 | `promo-marquee-1400x560.png` |

Both are **PNG (no alpha)** in `store/screenshots/`.

## Package for upload

From the repo root (PowerShell):

```powershell
.\scripts\package.ps1
```

Upload the generated ZIP from `dist/`.

## Developer checklist

- [ ] Pay one-time Chrome Web Store developer fee ($5)
- [ ] Load unpacked and test a short run
- [ ] Confirm privacy URL opens in Incognito
- [ ] Upload ZIP from `dist/`
- [ ] Paste listing copy + permission justifications
- [ ] Upload screenshots
- [ ] Complete privacy practices form
- [ ] Submit for review
