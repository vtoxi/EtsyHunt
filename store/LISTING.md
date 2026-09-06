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

Everything is local-first. Your research data stays in your browser. No EtsyHunt account. No license key.

Features:
• Full pipeline or single-step runs
• Digital / Physical / Any product-type filter
• Configurable keyword limits, delays, and beatable-shop thresholds
• Activity log with copy / export
• Downloadable niche reports

How to use:
1. Install EtsyHunt and pin it
2. Enter a seed keyword (for example: tote bag)
3. Choose product type
4. Click Run full research
5. Open the downloaded HTML report when the run finishes

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

## Permission justifications (paste into store form)

**storage**  
Stores user settings, seed keywords, local research results, and run logs on the device so the pipeline can continue and reports can be generated without a remote database.

**tabs**  
Creates and navigates background tabs to Etsy (and optionally eRank) to collect search and listing data during a research run the user starts.

**scripting**  
Used only for the optional legacy eRank keyword workflow to ensure the content script is available on eRank pages when needed.

**alarms**  
Keeps the Manifest V3 service worker alive during long multi-step research runs so Chrome does not suspend the worker mid-pipeline.

**downloads**  
Saves generated HTML niche reports and user-requested JSON log exports to the user’s Downloads folder.

**Host permission: https://www.etsy.com/***  
Required to open Etsy search and listing pages and extract publicly visible niche research signals during user-started runs.

**Host permission: https://members.erank.com/***  
Optional legacy keyword workflow. Used only when that workflow is enabled and the user is logged into eRank.

## Screenshots (you must capture)

Chrome requires 1–5 screenshots:

- Size: **1280×800** or **640×400** PNG/JPEG
- Show the real popup UI (seed input, run button, progress, activity log)
- Optional: a finished HTML report window

Tip: open the extension popup, use Windows Snipping Tool / ShareX, then pad/crop to exact size.

Place finished images in `store/screenshots/` (not required inside the ZIP).

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
