# Privacy Policy — EtsyHunt

**Last updated:** September 7, 2026

EtsyHunt (“the Extension”) is a free Chrome extension for local Etsy niche research.

## Summary

EtsyHunt is designed to keep your research data on your device. It does not require an account, does not sell data, and does not send your research results to our servers.

## Data the Extension stores locally

The Extension may store the following in Chrome’s local extension storage (`chrome.storage.local`) on your computer:

- Seed keywords you enter
- Settings you configure (limits, delays, filters)
- Research results collected during a run (keywords, listing metadata, scores, activity logs)
- Run history and timestamps

This data stays on your device. Clearing extension data or uninstalling EtsyHunt removes it.

## Website content accessed during research

When you start a research run, the Extension opens browser tabs and reads publicly visible page content from:

- **etsy.com** — to discover keywords, capture search results, and audit listing pages
- **members.erank.com** (optional / legacy mode) — only if you use the eRank-based workflow and are logged into eRank in Chrome

That content is processed locally to build your niche report. The Extension does not upload those results to an EtsyHunt backend.

## Downloads

The Extension may save HTML reports and exported JSON logs to your Downloads folder using the Chrome downloads API, only when a run completes or you click Export / when a report is generated.

## Permissions (why they are needed)

| Permission | Purpose |
|------------|---------|
| `storage` | Save settings and local research data |
| `tabs` | Open and control research tabs on Etsy (and optionally eRank) |
| `scripting` | Inject helpers needed for the optional eRank workflow |
| `alarms` | Keep long research runs alive under Manifest V3 |
| `downloads` | Save HTML niche reports and exported logs |
| Host access to `etsy.com` | Read Etsy search and listing pages during a run you start |
| Host access to `members.erank.com` | Optional legacy keyword workflow |

## Data we do not collect

EtsyHunt does not:

- Require signup or login to EtsyHunt
- Sell or rent personal data
- Use your research data for advertising
- Track browsing outside the research workflow you start
- Send analytics, crash reports, or telemetry from inside the Extension itself

## Analytics on this website

This privacy policy webpage (not the Extension) uses Google Analytics to understand visits to the page itself — approximate location, device/browser type, and referral source. Google Analytics uses cookies and may collect your IP address. This applies only to your browser visiting the webpage version of this policy; the EtsyHunt Chrome extension does not send any analytics or telemetry.

You can opt out using the [Google Analytics Opt-out Browser Add-on](https://tools.google.com/dlpage/gaoptout), or a browser/extension that blocks tracking scripts. See [Google's Privacy Policy](https://policies.google.com/privacy) for details.

## Third-party services

Etsy and eRank are independent services. Your use of those sites is governed by their own terms and privacy policies. EtsyHunt does not control those services. Google Analytics (used only on the webpage version of this policy) is governed by Google's privacy policy, linked above.

## Children’s privacy

EtsyHunt is not directed at children under 13.

## Changes

We may update this policy when the Extension’s behavior changes. The “Last updated” date at the top will change when we do.

## Contact

Questions about this policy: open an issue at [github.com/vtoxi/EtsyHunt](https://github.com/vtoxi/EtsyHunt).
