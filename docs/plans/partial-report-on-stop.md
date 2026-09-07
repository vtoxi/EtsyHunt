# Partial Report on Stop — Implementation Plan

**Feature:** When a user stops a running pipeline, EtsyHunt finishes the current in-flight operation, then generates a **partial HTML report** from whatever research data has already been saved locally.

**Status:** Implemented (Phases 1–3)  
**Target release:** v1.1.0  
**Owner:** —  
**Last updated:** 2026-09-07

---

## 1. Problem statement

Today, clicking **Stop** during a full pipeline run:

1. Shows a misleading confirm: *“Progress will be lost”* — but keywords, snapshots, and audits are **already persisted** incrementally in `chrome.storage.local`.
2. Exits the pipeline **before Step 4**, so no report is generated.
3. Leaves the user with 20–40 minutes of collected data and no deliverable.

Users need a way to **cancel gracefully** and still receive value from completed work.

---



## 2. Goals


| #   | Goal                                                                       |
| --- | -------------------------------------------------------------------------- |
| G1  | Stop → partial report when minimum data threshold is met                   |
| G2  | Report clearly labeled **PARTIAL** with step reached and disclaimer        |
| G3  | Reuse existing NES scoring + `deliverReport()` — no parallel report system |
| G4  | Popup shows report panel immediately after partial report is saved         |
| G5  | Fix misleading “progress will be lost” copy                                |




## 3. Non-goals (this feature)


| #   | Out of scope                                                                      |
| --- | --------------------------------------------------------------------------------- |
| NG1 | Resume pipeline from stop point (Phase 3)                                         |
| NG2 | Report history / archive of multiple partial reports (Phase 3)                    |
| NG3 | Cloud sync or email delivery                                                      |
| NG4 | Partial report when Step 1 produced zero keywords (show empty-state message only) |
| NG5 | Changing scoring formula for partial runs — only verdict labeling and UI copy     |


---



## 4. User experience spec



### 4.1 Stop dialog (Phase 1)

**Replace** current confirm:

> Stop the running pipeline? Progress will be lost.

**With:**

> **Stop research?**  
> EtsyHunt will finish the current page, then save a **partial report** from whatever steps are complete. Your collected data stays on this device.

Buttons: **Stop & save report** (primary) · **Cancel**

Phase 2 adds: **Stop without report** (secondary, destructive).

### 4.2 Status after stop


| Condition                    | Status pill | Progress text                               |
| ---------------------------- | ----------- | ------------------------------------------- |
| Partial report generated     | Stopped     | Partial report ready — stopped after Step N |
| Not enough data              | Stopped     | Stopped — not enough data for a report yet  |
| User chose discard (Phase 2) | Stopped     | Stopped by user                             |




### 4.3 Report banner (inside HTML)

Insert at top of every partial report:

```
⚠ Partial report — you stopped this run after Step {N}.
Grades and verdict reflect only the {X} keywords / {Y} listings collected so far.
Re-run the full pipeline for a complete verdict.
```

Verdict line for partial runs:


| Situation                    | Display verdict                       |
| ---------------------------- | ------------------------------------- |
| Step 2+ with scored keywords | `PARTIAL` (never bare GO/NO-GO alone) |
| Step 2 gate-skip path        | `PARTIAL — crowded niche signal`      |
| Step 1 keyword-only          | `PARTIAL — keywords only`             |
| Step 3 stopped mid-audit     | `PARTIAL — incomplete audits`         |


---



## 5. Minimum data thresholds


| Stopped after            | Min data required                         | Report type              | Generator                                                                |
| ------------------------ | ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Step 1                   | ≥ 1 keyword row for seed                  | Keyword table only       | `runInsufficientKeywordsReport` variant or new `runPartialKeywordReport` |
| Step 2 (mid or complete) | ≥ 1 snapshot / listing row                | Snapshot + gate analysis | `runNesScoring` with `partial: true`                                     |
| Step 3 (mid or complete) | ≥ 1 audit row **or** Step 2 snapshot data | Scored partial report    | `runNesScoring` with `partial: true`                                     |
| Before Step 1 completes  | —                                         | None                     | Log + popup message only                                                 |


Legacy pipeline (`use_nes_pipeline=false`): same thresholds; call `runNicheScoring` with partial flags where applicable.

---



## 6. Architecture



### 6.1 New state fields

**Module-level (service worker):**

```js
let stopRequested = false;
let stopMode = 'report'; // 'report' | 'discard' (Phase 2)
```

`runState` **(chrome.storage.local):**

```js
{
  lastStatus: 'stopped' | 'stopped_partial' | ...,
  stoppedAfterStep: 1 | 2 | 3 | null,
  partialReportReady: boolean,
  // existing fields unchanged
}
```

`lastReport` **(via deliverReport):**

```js
{
  reportType: 'partial' | 'full' | 'insufficient-keywords' | ...,
  partial: true,
  stoppedAfterStep: 2,
  completedSteps: ['discovery', 'snapshots'],
  verdict: 'PARTIAL',
  // existing fields unchanged
}
```



### 6.2 Control flow change

```
User clicks "Stop & save report"
        │
        ▼
stopRequested = true, stopMode = 'report'
        │
        ▼
Current step loop hits checkStop() → breaks cleanly (already works)
        │
        ▼
Step returns partial result to service worker
        │
        ▼
┌───────────────────────────────────────┐
│  generatePartialReportIfEligible()    │
│  - check stopMode !== 'discard'       │
│  - check minimum data threshold       │
│  - determine stoppedAfterStep         │
│  - invoke Step 4 with partial opts    │
└───────────────────────────────────────┘
        │
        ▼
deliverReport() → lastReport + auto-download
        │
        ▼
updateState({ lastStatus: 'stopped_partial', partialReportReady: true })
        │
        ▼
_archive('stopped')  // or 'stopped_partial' if we add run history distinction
```



### 6.3 New helper (service worker)

```js
async function generatePartialReportIfEligible({
  apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
  stoppedAfterStep, useNes, log,
}) → { generated: boolean, reason?: string }
```

Called from **every** current early-exit path that checks `stopRequested` after Steps 1–3, and after mid-step returns when `stopRequested` is true.

### 6.4 Scoring opts extension

Pass to `runNesScoring` / `runNicheScoring`:

```js
{
  partial: true,
  userStopped: true,
  stoppedAfterStep: 2,
  pipelineRunId,
  pipelineStartedAt,
}
```

Scoring modules read these flags to:

- Skip treating partial run as final GO/NO-GO for `niche_scores.status` → write `PARTIAL` or `PARTIAL-NO-GO`
- Pass `partial` into `buildReport()` / `generateNicheReport()` for banner rendering

---



## 7. Phased delivery



### Phase 1 — Core partial report (ship in v1.1.0)

**Effort estimate:** 1–2 days  
**User value:** High

#### Task 1.1 — Service worker stop mode plumbing

- [ ] Add `stopMode` variable (`'report'` default)
- [ ] Extend `stopPipeline` message handler to accept optional `{ mode: 'report' | 'discard' }` (discard stubbed for Phase 2)
- [ ] Do **not** set `running: false` immediately on stop click — defer until step boundary OR partial report completes (prevents UI flicker and double-start race). *Alternative:* keep immediate `running: false` but set `stopping: true` flag for popup. Document chosen approach in code comment.
- [ ] Track `stoppedAfterStep` based on which step was active when stop fired

**Files:** `src/background/service-worker.js`

**Acceptance:**

- Stop message sets `stopRequested` and `stopMode`
- Pipeline still finishes current listing/keyword before exiting step loop

---



#### Task 1.2 — `generatePartialReportIfEligible()` helper

- [ ] Implement helper in service worker (or extract to `src/utils/partial-report.js`)
- [ ] Query local API client for seed: keyword count, listing count, audit count
- [ ] Apply minimum thresholds (Section 5)
- [ ] Route to correct scorer:
  - Step 2+ data → `runNesScoring` / `runNicheScoring` with partial opts
  - Step 1 only (Phase 1 optional — can defer to Phase 2 if tight on time)
- [ ] Return `{ generated, reason }` for logging

**Files:** `src/background/service-worker.js`, optionally `src/utils/partial-report.js`

**Acceptance:**

- Stopped after Step 2 with listings → Step 4 invoked
- Stopped before any data → `{ generated: false, reason: 'insufficient_data' }`

---



#### Task 1.3 — Replace all stop early-exit `return`s

Replace each block like:

```js
if (stopRequested) { ... return; }
```

With:

```js
if (stopRequested) {
  await handlePipelineStop({
    seedKeyword, apiClient, config, pipelineRunId, pipelineStartedAt,
    stoppedAfterStep: N, useNes,
  });
  return;
}
```

Locations in `runFullPipeline()`:

- [ ] After Step 1 completes (line ~686)
- [ ] After Step 2 completes (line ~701)
- [ ] After Step 3 completes (line ~714)
- [ ] Before Step 1 (line ~611) — no report, just stop
- [ ] After Step 2 returns when stopped **mid-step** (Step 2 already returns; check `stopRequested` before Step 3 gate)
- [ ] After Step 3 returns when stopped **mid-step**

Also handle **standalone step runs** (`runSingleStep`) if user stops during Step 2/3 solo run — same partial report logic.

**Files:** `src/background/service-worker.js`

**Acceptance:**

- Full pipeline stopped after Step 2 → partial report generated
- Full pipeline stopped mid Step 3 → partial report with thin-keyword disclaimers

---



#### Task 1.4 — NES scoring partial mode

- [ ] Accept `opts.partial`, `opts.userStopped`, `opts.stoppedAfterStep` in `runNesScoring`
- [ ] When `partial: true`:
  - [ ] Set report verdict display to `PARTIAL` (append context suffix if gate-skip or enterable keywords exist)
  - [ ] Write `niche_scores.status = 'PARTIAL'` (or `PARTIAL-NO-GO` / `PARTIAL-GO-SIGNAL`)
  - [ ] Pass `partial`, `stoppedAfterStep` into `buildReport(ctx)`
- [ ] Add partial banner HTML block at top of `buildReport()` output
- [ ] Pass `reportType: 'partial'` to `deliverReport()`

**Files:** `src/worker-modules/nes-scoring-workflow.js`

**Acceptance:**

- Partial report HTML contains visible banner
- Filename includes `_partial_` e.g. `etsyhunt_tote_bag_2026-09-07_partial.html`
- `lastReport.reportType === 'partial'`

---



#### Task 1.5 — Legacy scoring partial mode

- [ ] Mirror partial opts handling in `runNicheScoring`
- [ ] Add partial banner to `generateNicheReport()` template
- [ ] Ensure `runInsufficientKeywordsReport` is **not** used for partial stop (different copy)

**Files:** `src/worker-modules/niche-scoring-workflow.js`

**Acceptance:**

- Legacy pipeline stop after Step 2 produces partial legacy-format report

---



#### Task 1.6 — Popup Stop UX

- [ ] Update confirm dialog copy (Section 4.1)
- [ ] Send `{ action: 'stopPipeline', mode: 'report' }` from popup
- [ ] Map `lastStatus: 'stopped_partial'` → status pill “Stopped” + success tint or new “Partial” state
- [ ] Show `report-panel` when `partialReportReady` or `lastReport.reportType === 'partial'`
- [ ] Update `refreshReportPanel()` to show “Partial report” badge

**Files:** `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`

**Acceptance:**

- User sees report panel without re-opening popup after stop
- No message says “progress will be lost”

---



#### Task 1.7 — `deliverReport()` metadata

- [ ] Extend `deliverReport()` meta param with `partial`, `stoppedAfterStep`, `completedSteps`
- [ ] Persist fields on `lastReport` object
- [ ] Log line distinguishes partial vs full delivery

**Files:** `src/utils/report-delivery.js`

**Acceptance:**

- Viewer and popup can read partial metadata from storage

---



#### Task 1.8 — Report viewer partial indicator

- [ ] Show partial badge in `viewer.html` toolbar when `report.partial === true`
- [ ] Subtitle includes “Stopped after Step N”

**Files:** `src/report/viewer.html`, `src/report/viewer.js`

---



#### Task 1.9 — Manual test plan (Phase 1)


| #   | Scenario                                  | Expected                                                         |
| --- | ----------------------------------------- | ---------------------------------------------------------------- |
| T1  | Stop before Step 1 starts                 | No report; status Stopped                                        |
| T2  | Stop mid Step 2 (after ≥3 keywords)       | Partial report with snapshot/gate data                           |
| T3  | Stop after Step 2 complete, before Step 3 | Partial report; gate-skip or thin sections as appropriate        |
| T4  | Stop mid Step 3                           | Partial report; keywords with partial audit coverage marked thin |
| T5  | Stop after Step 3 complete                | Full scoring on collected data, still labeled PARTIAL            |
| T6  | Normal complete run                       | Full report unchanged; no partial banner                         |
| T7  | Stop during solo Step 2 run               | Partial report generated                                         |
| T8  | Reload extension after partial stop       | Report panel still shows last partial report                     |


---



### Phase 2 — Step 1 partial + discard option (v1.2.0)

**Effort estimate:** 0.5–1 day

#### Task 2.1 — Step 1 keyword-only partial report

- [ ] New `runPartialKeywordReport()` or extend insufficient-keywords report with different banner (“stopped by user” vs “below minimum threshold”)
- [ ] Trigger when stopped after Step 1 with ≥1 keyword

**Files:** `src/worker-modules/niche-scoring-workflow.js` or new `src/worker-modules/partial-keyword-report.js`

---



#### Task 2.2 — “Stop without report” option

- [ ] Popup: secondary button or hold-Shift to discard
- [ ] `stopMode = 'discard'` skips `generatePartialReportIfEligible()`
- [ ] Confirm copy clarifies data remains in storage but no HTML file

**Files:** `src/popup/popup.js`, `src/background/service-worker.js`

---



#### Task 2.3 — Run history partial status

- [ ] `archiveCurrentRun()` records `status: 'stopped_partial'` vs `'stopped'`
- [ ] Footer “Last run” shows partial indicator

**Files:** `src/background/service-worker.js`, `src/utils/config-loader.js` (if run history shape changes)

---



### Phase 3 — Power user features (v1.3.0+)

**Effort estimate:** 2–3 days

#### Task 3.1 — Resume from stop

- [ ] Persist `pipelineCheckpoint: { seedKeyword, lastCompletedStep, pipelineRunId, stoppedAt }`
- [ ] Popup CTA: “Resume research” when checkpoint exists for current seed
- [ ] Service worker skips completed steps on resume

---



#### Task 3.2 — Report history

- [ ] Store `reportHistory: Report[]` (cap at 5 entries) instead of overwriting `lastReport` only
- [ ] Popup dropdown or list to open/download previous reports
- [ ] Prune oldest when cap exceeded

---



#### Task 3.3 — Storage quota guard

- [ ] Before saving large HTML to storage, check approximate size
- [ ] If near quota, skip inline HTML storage; keep metadata + offer re-generate from DB via Step 4 solo run

---



## 8. File change summary


| File                                           | Phase 1 changes                                                 |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `src/background/service-worker.js`             | Stop handler, partial report orchestration, replace early exits |
| `src/worker-modules/nes-scoring-workflow.js`   | Partial opts, banner, verdict labeling                          |
| `src/worker-modules/niche-scoring-workflow.js` | Partial opts, banner (legacy)                                   |
| `src/utils/report-delivery.js`                 | Partial metadata                                                |
| `src/utils/partial-report.js`                  | **New** — eligibility + routing (optional extract)              |
| `src/popup/popup.html`                         | Stop dialog / report partial badge                              |
| `src/popup/popup.js`                           | Stop message, status mapping, report panel                      |
| `src/popup/popup.css`                          | Partial status + badge styles                                   |
| `src/report/viewer.html`                       | Partial indicator                                               |
| `src/report/viewer.js`                         | Read partial metadata                                           |
| `store/LISTING.md`                             | Mention partial report on stop (store copy update)              |
| `CHANGELOG.md`                                 | v1.1.0 entry                                                    |


---



## 9. Risks and mitigations


| Risk                                          | Impact               | Mitigation                                                                       |
| --------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| User misreads PARTIAL as full GO              | High trust damage    | Never show bare GO; always PARTIAL prefix + banner                               |
| Large HTML exceeds storage quota              | Report save fails    | Phase 3 quota guard; Phase 1 monitor report size in tests                        |
| MV3 worker killed mid partial Step 4          | No report            | Keepalive already running during pipeline; extend until partial report completes |
| Mid-step stop with 0 listings on last keyword | Empty partial report | Minimum threshold check before invoking Step 4                                   |
| Legacy vs NES pipeline divergence             | Inconsistent reports | Shared partial opts contract; test both paths in T6–T7                           |


---



## 10. Success metrics


| Metric                                                 | Target             |
| ------------------------------------------------------ | ------------------ |
| Partial report generated when stopped after Step 2+    | ≥ 95% of test runs |
| User can view partial report from popup without re-run | 100%               |
| Full pipeline report unchanged                         | No regression      |
| Stop dialog no longer claims data is lost              | 100%               |


---



## 11. Implementation order (recommended)

```
1.1 stop mode plumbing
    ↓
1.2 generatePartialReportIfEligible()
    ↓
1.4 NES partial scoring + banner
    ↓
1.5 Legacy partial scoring + banner
    ↓
1.3 wire stop exits in service worker
    ↓
1.7 deliverReport metadata
    ↓
1.6 popup UX
    ↓
1.8 viewer indicator
    ↓
1.9 manual QA
    ↓
Phase 2 / 3 as follow-up releases
```

---



## 12. Open questions


| #   | Question                                                    | Recommendation                                                               |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1  | Should partial report auto-download or only save for popup? | Auto-download (consistent with full report) + popup access                   |
| Q2  | Overwrite `lastReport` or keep full report if one existed?  | Overwrite — last run wins; Phase 3 adds history                              |
| Q3  | Should solo Step 4 re-score after partial stop?             | No — partial Step 4 already runs on stop; solo Step 4 remains user-initiated |
| Q4  | GitLab issue number for tracking?                           | Create `#XXX` when work starts                                               |


---



## 13. Definition of done (Phase 1)

- [ ] All Phase 1 tasks checked off
- [ ] Manual test plan T1–T8 passed
- [ ] No regression on full pipeline report flow
- [ ] CHANGELOG updated
- [ ] Store listing copy updated if user-facing behavior changed materially