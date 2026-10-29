// Service Worker — Main Orchestrator
// Manages the 4-step pipeline, tab control, and state.

import { LocalStorageAPIClient } from '../utils/local-storage-api-client.js';
import { EXT_NAME } from '../utils/brand.js';
import { loadConfig, saveRunState, loadRunState } from '../utils/config-loader.js';
import { runErankKeywordResearch } from '../worker-modules/erank-keyword-workflow.js';
import { runEtsySearchSnapshots } from '../worker-modules/etsy-snapshot-workflow.js';
import { runErankListingAudit } from '../worker-modules/erank-listing-workflow.js';
import { runNicheScoring } from '../worker-modules/niche-scoring-workflow.js';
// 2026-08-19 (v2.0.0): NES pipeline — eRank-free discovery + evidence-based
// scoring. Selected per-run by the `use_nes_pipeline` config flag (default ON).
// Legacy modules stay importable as the fallback (`use_nes_pipeline=false`).
import { runNesDiscovery } from '../worker-modules/nes-discovery-workflow.js';
import { runNesScoring } from '../worker-modules/nes-scoring-workflow.js';
import {
  assessPartialEligibility,
  countSeedEvidence,
} from '../utils/partial-report.js';

// Config flag helper: NES is the default in 2.0.0; explicit false/0/'false'
// (from DB config or popup) reverts to the legacy eRank pipeline.
// Merge the server config table underneath the local settings: local (popup)
// wins, server fills the gaps, code defaults are already inside loadConfig().
// A failed/unavailable read is non-fatal — the run proceeds on local settings.
async function mergeServerConfig(apiClient, localConfig) {
  try {
    const server = await apiClient.getConfig();
    return { ...(server || {}), ...(localConfig || {}) };
  } catch (e) {
    console.warn('[NM] server config merge skipped:', e && e.message);
    return localConfig;
  }
}

function nesEnabled(config) {
  const v = config && config.use_nes_pipeline;
  return !(v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false');
}

let stopRequested = false;
let stopMode = 'report'; // 'report' | 'discard'
let pipelineRunning = false;
let workTabId = null;
// Active pipeline context — used by Stop → partial report + Phase 3 resume.
let activePipelineCtx = null;
// Handle to the in-flight server-side run row (pro_etsy_res_user_runs). Set the
// moment createRun returns; cleared when the run is archived. A Stop click uses
// it to close the row IMMEDIATELY, instead of waiting for the async pipeline
// loop to reach a checkStop boundary. Without this, an MV3 worker teardown
// between createRun and the first checkpoint orphans the row as 'running' for
// the worker's 2h concurrent-limit window — the next Start then fails with a
// bogus "Concurrent run limit reached (1)" even though the user stopped the run.
let activeRunId = null;
let activeApiClient = null;

// ─── MV3 service-worker keepalive ─────────────────────────────────────────
// Chrome aggressively kills MV3 service workers after ~30s of idle. During a
// pipeline run, long awaits (Etsy tab loads, multi-second DB reads, serial
// upsert loops) can all cross that threshold and the worker gets killed
// mid-run — leaving "inactive" next to the worker link in chrome://extensions
// and the pipeline log frozen forever with no error.
//
// Workaround: while a pipeline is running, fire a chrome.alarms ping every
// 20 seconds. chrome.alarms are the official MV3-supported way to keep a
// worker alive; each fired alarm counts as an "event" that resets the idle
// timer. The listener itself is a no-op — it just exists so the alarm has a
// handler to dispatch to.
//
// Start on pipeline begin, stop on pipeline end (success OR failure).
const KEEPALIVE_ALARM_NAME = 'enr-pipeline-keepalive';

function startKeepalive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
      // Chrome clamps periodInMinutes to a minimum of 0.5 (30s) in release
      // builds but honors fractional minutes in dev. 0.35 = 21s — below the
      // 30s idle-kill threshold with a little margin.
      when: Date.now() + 20 * 1000,
      periodInMinutes: 0.35
    });
  } catch (e) {
    console.warn('[ENR] startKeepalive failed:', e && e.message);
  }
}

function stopKeepalive() {
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  } catch (e) {
    console.warn('[ENR] stopKeepalive failed:', e && e.message);
  }
}

// Alarm listener — the handler body is intentionally a no-op. The only
// purpose is to give Chrome an event to dispatch, which resets the idle
// timer that would otherwise kill the service worker.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === KEEPALIVE_ALARM_NAME) {
    // no-op — existence of this handler is what matters
  }
});

// ─── Message handler ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startPipeline') {
    // CRITICAL: must run async work via an IIFE and return true so Chrome
    // keeps the message channel open until sendResponse fires. Without this,
    // a cold-started service worker can drop the response (or be suspended
    // mid-startup) and the popup's callback never fires — which is what
    // makes the Start button feel like it needs 2-3 clicks.
    (async () => {
      try {
        // Cross-restart guard: pipelineRunning is in-memory and resets when
        // the MV3 service worker is evicted. The persistent storage flag is
        // the real source of truth — check it too before launching.
        const persisted = await loadRunState();
        let persistedRunning = !!(persisted && persisted.running);

        // Stale pipeline recovery: if flagged as running but no update in 30min,
        // the service worker likely died mid-pipeline. Auto-clear so user isn't stuck.
        // Also recover when lastStartedAt is missing (pre-v1.1.0 state upgrade).
        if (persistedRunning) {
          let isStale = false;
          if (!persisted.lastStartedAt) {
            isStale = true; // pre-v1.1.0 state — no timestamp, assume stale
          } else {
            const staleMs = Date.now() - (new Date(persisted.lastStartedAt)).getTime();
            isStale = staleMs > 30 * 60 * 1000;
          }
          if (isStale) {
            console.warn('[ENR] Stale pipeline detected, auto-clearing');
            await saveRunState({ ...persisted, running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'stale_recovery' });
            const refreshed = await loadRunState();
            if (refreshed) Object.assign(persisted, refreshed);
            persistedRunning = false;
          }
        }

        if (pipelineRunning || persistedRunning) {
          sendResponse({ started: false, reason: 'Pipeline already running' });
          return;
        }
        pipelineRunning = true;
        stopRequested = false;
        stopMode = 'report';
        // Mark running in persistent storage IMMEDIATELY (before any async
        // work) so a second click that wakes a fresh SW sees the lock.
        await updateState({ running: true, currentStep: 'Starting...', progress: '', lastStatus: null, lastStartedAt: new Date().toISOString(), progressCur: null, progressTotal: null, progressPhase: null });
        // Acknowledge the popup before kicking off the long-running pipeline.
        sendResponse({ started: true });
        const seedKeyword = msg.seedKeyword || '';
        const runner = msg.mode === 'full'
          ? runFullPipeline(seedKeyword)
          : runSingleStep(msg.step, seedKeyword);
        runner.finally(() => { pipelineRunning = false; });
      } catch (e) {
        console.error('[ENR] startPipeline handler failed:', e);
        pipelineRunning = false;
        try { sendResponse({ started: false, reason: e.message }); } catch (_) {}
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  if (msg.action === 'stopPipeline') {
    stopRequested = true;
    stopMode = (msg.mode === 'discard') ? 'discard' : 'report';
    const modeNote = stopMode === 'discard'
      ? 'finishing current operation (no report)…'
      : 'finishing current operation, then saving a partial report…';
    log('warn', `🛑 Stop requested by user — ${modeNote}`);
    // Keep running=true until the pipeline handler finishes the current step
    // and (optionally) generates the partial report. The popup uses
    // lastStatus/stopping to show "Stopping…".
    updateState({
      stopping: true,
      progressCur: null,
      progressTotal: null,
      progressPhase: null,
      lastStatus: 'stopping',
      progress: stopMode === 'discard'
        ? 'Stopping — no report'
        : 'Stopping — will save a partial report',
    });
    // Close the in-flight server run row NOW so its concurrent slot frees
    // immediately. Relying on the async loop to reach a checkStop is unsafe:
    // an MV3 teardown can abandon the loop, orphaning the row as 'running'
    // for the worker's 2h window and blocking the next Start with a false
    // "Concurrent run limit reached" error. Snapshot + null the handle first
    // so a double-click can't fire two PATCHes for the same row.
    if (activeRunId && activeApiClient) {
      const _rid = activeRunId, _client = activeApiClient;
      activeRunId = null; activeApiClient = null;
      _client.updateRun(_rid, 'failed')
        .then(() => log('info', `Server run ${_rid} marked stopped — concurrent slot freed`))
        .catch((e) => console.warn('[ENR] stop updateRun failed:', e && e.message));
    }
    // Also try to stop any active tab navigation by navigating to blank
    if (workTabId) {
      chrome.tabs.update(workTabId, { url: 'about:blank' }, () => {
        if (chrome.runtime.lastError) { workTabId = null; }
      });
    }
    sendResponse({ stopped: true, mode: stopMode });
  }

  if (msg.action === 'resumePipeline') {
    (async () => {
      try {
        const data = await chrome.storage.local.get('pipelineCheckpoint');
        const cp = data.pipelineCheckpoint;
        if (!cp || !cp.seedKeyword) {
          sendResponse({ started: false, reason: 'No checkpoint to resume' });
          return;
        }
        const persisted = await loadRunState();
        if (pipelineRunning || (persisted && persisted.running)) {
          sendResponse({ started: false, reason: 'Pipeline already running' });
          return;
        }
        pipelineRunning = true;
        stopRequested = false;
        stopMode = 'report';
        await updateState({
          running: true,
          stopping: false,
          currentStep: `Resuming "${cp.seedKeyword}" from Step ${(cp.lastCompletedStep || 0) + 1}…`,
          progress: '',
          lastStatus: null,
          lastStartedAt: new Date().toISOString(),
          progressCur: null,
          progressTotal: null,
          progressPhase: null,
        });
        sendResponse({ started: true, seedKeyword: cp.seedKeyword, fromStep: (cp.lastCompletedStep || 0) + 1 });
        runFullPipeline(cp.seedKeyword, { resumeFrom: cp })
          .finally(() => { pipelineRunning = false; });
      } catch (e) {
        pipelineRunning = false;
        sendResponse({ started: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === 'getCheckpoint') {
    chrome.storage.local.get('pipelineCheckpoint').then((data) => {
      sendResponse({ checkpoint: data.pipelineCheckpoint || null });
    });
    return true;
  }

  if (msg.action === 'clearCheckpoint') {
    chrome.storage.local.remove('pipelineCheckpoint').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'getReportHistory') {
    chrome.storage.local.get('reportHistory').then((data) => {
      const history = Array.isArray(data.reportHistory) ? data.reportHistory : [];
      sendResponse({
        history: history.map((h) => ({
          id: h.id,
          seedKeyword: h.seedKeyword,
          verdict: h.verdict,
          generatedAt: h.generatedAt,
          filename: h.filename,
          reportType: h.reportType,
          partial: h.partial,
          stoppedAfterStep: h.stoppedAfterStep,
          hasHtml: !!(h.htmlStored && h.html),
        })),
      });
    });
    return true;
  }

  if (msg.action === 'openReportFromHistory') {
    (async () => {
      try {
        const { reportHistory } = await chrome.storage.local.get('reportHistory');
        const history = Array.isArray(reportHistory) ? reportHistory : [];
        const entry = history.find((h) => h.id === msg.id);
        if (!entry || !entry.html) {
          sendResponse({ ok: false, error: 'Report not found in history (HTML may have been pruned)' });
          return;
        }
        await chrome.storage.local.set({ lastReport: entry });
        chrome.tabs.create({ url: chrome.runtime.getURL('src/report/viewer.html') });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === 'checkSeedExists') {
    (async () => {
      try {
        const apiClient = await initAPIClient();
        // Single aggregated query: existence + keyword_count + listing_count
        // in one round-trip. Replaces the old findRow + N+1 listing count
        // pattern that made the popup hang for 10+ seconds on busy seeds.
        const summary = await apiClient.getSeedSummary(msg.seedKeyword || '');
        if (summary && summary.exists) {
          sendResponse({
            exists: true,
            timesSearched: summary.times_searched != null ? String(summary.times_searched) : '0',
            keywordCount: summary.keyword_count,
            listingCount: summary.listing_count
          });
        } else {
          sendResponse({ exists: false });
        }
      } catch (e) {
        console.warn('Seed check failed:', e.message);
        sendResponse({ exists: false });
      }
    })();
    return true;
  }

  if (msg.action === 'getState') {
    loadRunState().then(state => sendResponse(state));
    return true;
  }

  if (msg.action === 'getRunHistory') {
    chrome.storage.local.get('runHistory').then(data => {
      sendResponse({ history: data.runHistory || [] });
    });
    return true;
  }

  if (msg.action === 'openReport') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/report/viewer.html') });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'downloadReport') {
    (async () => {
      try {
        const { lastReport } = await chrome.storage.local.get('lastReport');
        if (!lastReport || !lastReport.html) {
          sendResponse({ ok: false, error: 'No report saved yet' });
          return;
        }
        const blob = new Blob([lastReport.html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        try {
          await chrome.downloads.download({
            url,
            filename: lastReport.filename || 'etsyhunt_report.html',
            saveAs: false,
          });
          sendResponse({ ok: true });
        } finally {
          setTimeout(() => {
            try { URL.revokeObjectURL(url); } catch (_) {}
          }, 60000);
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === 'getLastReport') {
    chrome.storage.local.get('lastReport').then(data => {
      const r = data.lastReport;
      if (!r) {
        sendResponse({ report: null });
        return;
      }
      sendResponse({
        report: {
          seedKeyword: r.seedKeyword,
          verdict: r.verdict,
          generatedAt: r.generatedAt,
          filename: r.filename,
          reportType: r.reportType,
          hasHtml: !!r.html,
        },
      });
    });
    return true;
  }

  if (msg.action === 'clearAllData') {
    (async () => {
      try {
        const apiClient = await initAPIClient();
        const tablesToClear = [
          'seed_keywords', 'etsy_keywords', 'keyword_suggestions',
          'etsy_search_snapshots', 'etsy_listings', 'etsy_stores',
          'listing_audit', 'niche_scores', 'automation_log'
        ];
        let totalCleared = 0;
        const results = [];
        for (const table of tablesToClear) {
          try {
            const count = await apiClient.clearSheetData(table);
            totalCleared += count;
            results.push(`${table}: ${count} rows`);
          } catch (e) {
            results.push(`${table}: error (${e.message})`);
          }
        }
        console.log('[ENR] Data clear results:', results.join(', '));
        sendResponse({ success: true, tablesCleared: tablesToClear.length, rowsCleared: totalCleared, details: results });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});

// ─── State management (serialized to prevent race conditions) ───
// Without serialization, concurrent updateState() and addLog() calls can
// overwrite each other's changes (read-modify-write race). This queue
// ensures only one state mutation runs at a time, preserving all log entries.
let stateQueue = Promise.resolve();

function enqueueStateUpdate(fn) {
  stateQueue = stateQueue.then(fn).catch(e => console.error('[ENR] State update error:', e));
  return stateQueue;
}

async function updateState(partial) {
  return enqueueStateUpdate(async () => {
    const current = await loadRunState();
    const updated = { ...current, ...partial };
    await saveRunState(updated);
  });
}

// 2026-08-20: real progress for the popup's bar.
// The workflows already announce their position — "[3/8] Searching Etsy for…",
// "[46/118] Auditing listing…" — so rather than adding a progress channel to
// every module, we read those counters here, at the single point every message
// passes through. `phase` tells the popup which per-item cost to use when it
// estimates the time left (searching a keyword ~42s, opening a listing ~17s at
// a 7s delay — both measured from real runs).
function readProgress(msg) {
  const m = String(msg || '').match(/\[(\d+)\s*\/\s*(\d+)\]/);
  if (!m) return null;
  const cur = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (!Number.isFinite(cur) || !Number.isFinite(total) || total < 1 || cur > total) return null;
  const lower = String(msg).toLowerCase();
  const phase = lower.includes('auditing listing') ? 'listing'
    : (lower.includes('searching etsy') ? 'keyword'
    : (lower.includes('asking etsy about') ? 'probe' : 'other'));
  return { cur, total, phase };
}

async function log(type, msg) {
  console.log(`[ENR] [${type}] ${msg}`);
  const progress = readProgress(msg);
  return enqueueStateUpdate(async () => {
    const state = await loadRunState();
    const logs = state.logs || [];
    logs.push({ type, msg, time: new Date().toLocaleTimeString() });
    // Keep last 1000 log entries
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    const next = { ...state, logs };
    if (progress) {
      next.progressCur = progress.cur;
      next.progressTotal = progress.total;
      next.progressPhase = progress.phase;
    }
    await saveRunState(next);
  });
}

// ─── Server-side log persistence ───
// Flushes all current log entries to the server so they survive browser
// refreshes and can be reviewed for debugging without the user's machine.
// Called at the end of each pipeline run (success, error, or stop).
async function flushLogsToServer(seedKeyword, step) {
  try {
    const api = await initAPIClient();
    if (!api) return;
    const state = await loadRunState();
    const logs = state.logs || [];
    if (logs.length === 0) return;

    const runKey = `${seedKeyword || 'unknown'}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await api._post('/v1/pipeline-logs', {
      run_key: runKey,
      seed_keyword: seedKeyword || null,
      step: step || 'full_pipeline',
      logs: logs.map(l => ({
        level: l.type || 'info',
        message: l.msg || '',
        logged_at: l.time || '',
      })),
    });
    console.log(`[ENR] Flushed ${logs.length} log entries to server (run_key: ${runKey})`);
  } catch (e) {
    // Non-fatal — don't break the pipeline if log upload fails
    console.error('[ENR] flushLogsToServer failed:', e);
  }
}

// ─── Persistent run history (last 10 runs) ───
// Snapshots the live runState into chrome.storage.local.runHistory whenever a
// run finishes. Keeps the most recent MAX_HISTORY entries so logs survive
// across pipeline runs (the live runState.logs is wiped at the start of each run).
const MAX_HISTORY = 10;
async function archiveCurrentRun(extra = {}) {
  try {
    const state = await loadRunState();
    if (!state || !state.logs || state.logs.length === 0) return; // nothing to archive
    // Persist the config snapshot used for this run — makes post-hoc diagnosis
    // possible (which filter threshold was applied, was manual-tab ON, etc).
    let configSnapshot = null;
    try {
      const cfgData = await chrome.storage.local.get('config');
      configSnapshot = cfgData.config || null;
    } catch {}
    const entry = {
      archived_at: new Date().toISOString(),
      seed_keyword: extra.seedKeyword || null,
      mode: extra.mode || null,
      step: extra.step || null,
      status: state.lastStatus || extra.status || null,
      current_step: state.currentStep || null,
      progress: state.progress || null,
      configSnapshot,
      logs: state.logs.slice(),
    };
    const data = await chrome.storage.local.get('runHistory');
    const history = Array.isArray(data.runHistory) ? data.runHistory : [];
    history.unshift(entry); // newest first
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await chrome.storage.local.set({ runHistory: history });
  } catch (e) {
    console.error('[ENR] archiveCurrentRun failed:', e);
  }
}

// ─── Tab management ───
async function getOrCreateWorkTab() {
  // Try to reuse existing tab
  if (workTabId) {
    try {
      const tab = await chrome.tabs.get(workTabId);
      if (tab) return workTabId;
    } catch (e) {
      workTabId = null;
    }
  }

  // Create a new tab
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  workTabId = tab.id;
  return workTabId;
}

// ─── eRank login check ───
async function checkErankLogin(tabId) {
  await log('info', 'Checking eRank login...');

  // Navigate to eRank
  await navigateTab(tabId, 'https://members.erank.com/keyword-tool');
  await sleep(5000);

  try {
    const response = await sendToTab(tabId, { action: 'checkErankLogin' });
    if (response && response.loggedIn) {
      await log('success', 'eRank is logged in');
      return true;
    } else {
      await log('error', 'eRank is NOT logged in — please log in and retry');
      return false;
    }
  } catch (err) {
    // "Receiving end does not exist" = content script not injected (often because
    // the eRank page bounced you to the login page). Treat as login failure first
    // rather than surfacing the cryptic Chrome messaging error.
    const msg = err && err.message ? err.message : String(err);
    if (/receiving end does not exist|could not establish connection/i.test(msg)) {
      await log('error', 'eRank is NOT logged in (or page redirected to login) — please open https://members.erank.com, log in, then retry');
      return false;
    }
    await log('error', `Could not check eRank login: ${msg}`);
    return false;
  }
}

// ─── Initialize API client ───
async function initAPIClient() {
  return new LocalStorageAPIClient();
}

async function savePipelineCheckpoint(checkpoint) {
  try {
    await chrome.storage.local.set({ pipelineCheckpoint: checkpoint });
  } catch (e) {
    console.warn('[ENR] checkpoint save failed:', e && e.message);
  }
}

async function clearPipelineCheckpoint() {
  try {
    await chrome.storage.local.remove('pipelineCheckpoint');
  } catch (_) {}
}

/**
 * Generate a partial report after the user stops, if enough data exists.
 */
async function generatePartialReportIfEligible({
  apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
  stoppedAfterStep, useNes,
}) {
  if (stopMode === 'discard') {
    await log('info', 'Stop mode is discard — skipping partial report');
    return { generated: false, reason: 'discard' };
  }

  const counts = await countSeedEvidence(apiClient, seedKeyword);
  const assessment = assessPartialEligibility(stoppedAfterStep, counts);
  if (!assessment.eligible) {
    await log('warn', `Not enough data for a partial report yet (keywords=${counts.keywordCount}, listings=${counts.listingCount}, audits=${counts.auditCount})`);
    return { generated: false, reason: assessment.reason || 'insufficient_data', counts };
  }

  await log('info', `📄 Generating partial report (path=${assessment.path}, stopped after Step ${stoppedAfterStep})…`);
  await updateState({
    currentStep: `Partial report for "${seedKeyword}"`,
    progress: `Building report from Steps 1–${stoppedAfterStep}…`,
    stopping: true,
  });

  const logFn = (type, msg) => {
    log(type, `[Partial] ${msg}`);
    updateState({ progress: msg });
  };

  const baseOpts = {
    partial: true,
    userStopped: true,
    stoppedAfterStep,
    pipelineRunId,
    pipelineStartedAt,
  };

  try {
    const runner = useNes ? runNesScoring : runNicheScoring;
    const result = await runner(apiClient, config, logFn, seedKeyword, {
      ...baseOpts,
      ...(assessment.path === 'keywords' ? { partialKeywordsOnly: true } : {}),
    });
    await log('success', `Partial report ready: ${result && result.verdict ? result.verdict : 'saved'}`);
    return { generated: true, result, counts };
  } catch (e) {
    await log('error', `Partial report failed: ${e.message}`);
    return { generated: false, reason: e.message, counts };
  }
}

async function handlePipelineStop({
  apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
  stoppedAfterStep, useNes, _archive,
}) {
  await savePipelineCheckpoint({
    seedKeyword,
    lastCompletedStep: stoppedAfterStep,
    pipelineRunId,
    pipelineStartedAt,
    stoppedAt: new Date().toISOString(),
    useNes: !!useNes,
  });

  const outcome = await generatePartialReportIfEligible({
    apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
    stoppedAfterStep, useNes,
  });

  if (outcome.generated) {
    await updateState({
      running: false,
      stopping: false,
      progressCur: null,
      progressTotal: null,
      progressPhase: null,
      lastStatus: 'stopped_partial',
      stoppedAfterStep,
      partialReportReady: true,
      currentStep: `Stopped after Step ${stoppedAfterStep} — partial report ready`,
      progress: `Partial report ready — stopped after Step ${stoppedAfterStep}`,
    });
    await chrome.storage.local.set({ lastRunTime: Date.now() });
    await log('warn', `=== Pipeline stopped after Step ${stoppedAfterStep} — partial report saved ===`);
    await _archive('stopped_partial');
  } else if (outcome.reason === 'discard') {
    await updateState({
      running: false,
      stopping: false,
      progressCur: null,
      progressTotal: null,
      progressPhase: null,
      lastStatus: 'stopped',
      stoppedAfterStep,
      partialReportReady: false,
      currentStep: `Stopped after Step ${stoppedAfterStep}`,
      progress: 'Stopped by user',
    });
    await log('warn', `=== Pipeline stopped after Step ${stoppedAfterStep} (no report) ===`);
    await _archive('stopped');
  } else {
    await updateState({
      running: false,
      stopping: false,
      progressCur: null,
      progressTotal: null,
      progressPhase: null,
      lastStatus: 'stopped',
      stoppedAfterStep,
      partialReportReady: false,
      currentStep: `Stopped after Step ${stoppedAfterStep}`,
      progress: 'Stopped — not enough data for a report yet',
    });
    await log('warn', `=== Pipeline stopped after Step ${stoppedAfterStep} — no report (${outcome.reason}) ===`);
    await _archive('stopped');
  }
}

// ─── Full pipeline ───
async function runFullPipeline(seedKeyword, resumeOpts = null) {
  const resumeFrom = resumeOpts && resumeOpts.resumeFrom ? resumeOpts.resumeFrom : null;
  const resumeStep = resumeFrom ? (parseInt(resumeFrom.lastCompletedStep, 10) || 0) : 0;

  await updateState({
    running: true,
    stopping: false,
    currentStep: resumeStep ? `Resuming from Step ${resumeStep + 1}…` : 'Initializing...',
    progress: '',
    lastStatus: null,
    logs: [],
    partialReportReady: false,
    stoppedAfterStep: null,
  });
  await log('info', resumeStep
    ? `=== Resuming Pipeline for: "${seedKeyword}" (after Step ${resumeStep}) ===`
    : `=== Starting Full Pipeline for: "${seedKeyword}" ===`);
  let _archived = false;
  // Hoist these so _archive can read their latest values at archive time.
  let pipelineRunId = null;
  let apiClient = null;
  // 2026-05-01: Capture the pipeline's wall-clock start so Step 4 can scope
  // its data reads to listings/audits captured during THIS run only.
  // Defends against cross-niche contamination — listings inserted under a
  // prior seed but mapped to the current seed via shared keyword_ids no
  // longer surface in the report.
  const pipelineStartedAt = (resumeFrom && resumeFrom.pipelineStartedAt)
    ? resumeFrom.pipelineStartedAt
    : new Date().toISOString();
  const _archive = async (status) => {
    if (_archived) return;
    _archived = true;
    // Mark run as completed/failed in DB so /runs page reflects final state
    // (fixes "runs stuck on running" bug).
    if (pipelineRunId && apiClient) {
      try {
        const dbStatus = (status === 'success' || status === 'stopped_partial') ? 'completed' : 'failed';
        await apiClient.updateRun(pipelineRunId, dbStatus);
      } catch (e) {
        console.warn('[ENR] updateRun at archive failed:', e.message);
      }
    }
    // Run is now closed (or being closed) — drop the Stop-handle so a later
    // Stop click can't re-close an already-finished row.
    if (activeRunId === pipelineRunId) { activeRunId = null; activeApiClient = null; }
    await flushLogsToServer(seedKeyword, 'full_pipeline');
    return archiveCurrentRun({ seedKeyword, mode: 'full', status });
  };

  // Start MV3 keepalive for the duration of this run. Chrome kills idle
  // service workers after ~30s, which is what ate the last pipeline run
  // mid-Step-2. The alarm fires every ~21s, giving Chrome an event to
  // dispatch and resetting the idle timer. Stopped in the finally block
  // below so it always fires even on early returns.
  startKeepalive();

  try {
    let config = await loadConfig();
    apiClient = await initAPIClient();
    // 2026-08-20: fold the server config table in behind the local settings.
    // Without this, `use_nes_pipeline` was read from local storage only — and
    // the popup never writes it — so the documented legacy kill-switch could
    // not actually be thrown from the DB. Local settings still win; server
    // values fill in anything the popup doesn't set (the flag, the nes_* keys).
    config = await mergeServerConfig(apiClient, config);
    const tabId = await getOrCreateWorkTab();

    // Create user_runs record NOW so the seed-exists check (checkSeedExists)
    // sees this user's run on subsequent Start clicks. Step 4 will look up
    // this run_id by seed_keyword + user and reuse it for concept scoring.
    //
    // The Worker also enforces plan-based limits here (max_runs_month,
    // max_concurrent_runs, daily cap). A 429 means the user hit a cap —
    // abort the pipeline with a clear message instead of silently proceeding.
    try {
      const runRes = await apiClient.createRun(seedKeyword, {
        max_listings_per_keyword: parseInt(config.max_listings_per_keyword) || 16,
        min_qualified_keywords:   parseInt(config.min_qualified_keywords) || 5,
        max_shop_reviews_beatable: parseInt(config.max_shop_reviews_beatable) || 300,
        min_beatable_slots:       parseInt(config.min_beatable_slots) || 3,
        // 2026-08-20: min_monthly_searches / max_competition / enforce_seed_relevance
        // dropped from the run record — no NES step applies them, so recording
        // them made past runs look filtered when nothing was filtered. The
        // dashboard renders whatever keys a snapshot contains, so older runs
        // keep showing their historical values.
        // 2026-08-20: one "Keywords Per Run" number — Step 3 audits everything
        // Step 2 searched, so a separate audit cap no longer exists.
        max_keywords_per_run:     parseInt(config.max_keywords_per_run) || 20,
        // 2026-08-08: record the 7s Etsy floor that Steps 2/3 actually enforce,
        // so the run's config snapshot reflects the real pacing, not a stale 5.
        delay_between_pages_sec:  Math.max(parseInt(config.delay_between_pages_sec) || 7, 7),
        product_type_filter:      config.product_type_filter || 'any',
        extension_version:        chrome.runtime.getManifest().version,
        pipeline:                 nesEnabled(config) ? 'nes' : 'legacy',
      });
      pipelineRunId = (runRes && runRes.run_id) ? Number(runRes.run_id) : null;
      // Expose to the Stop handler so it can close this row on demand.
      activeRunId = pipelineRunId;
      activeApiClient = apiClient;
      await log('info', `Pipeline run record created: run_id=${pipelineRunId}`);
    } catch (e) {
      const msg = String(e && e.message || e);
      // Worker error formats:
      //   "API POST /v1/run failed: 429 {...limit reached...}"
      //   "API POST /v1/run failed: 401 {...license expired/invalid/device bound...}"
      const isLimit = / 429 /.test(msg) || /limit reached/i.test(msg);
      const isAuth  = / 401 /.test(msg) || /license/i.test(msg) || /device/i.test(msg);
      // 2026-06-16: 426 = force-update gate (extension version below the
      // worker's configured minimum). Surface it as a clear stop so the user
      // knows to update rather than seeing a generic failure.
      const isUpdate = / 426 /.test(msg) || /update required/i.test(msg);
      if (isLimit || isAuth || isUpdate) {
        // Surface a user-visible reason and stop the pipeline.
        let reason = isUpdate ? 'Extension update required'
                   : isLimit ? 'Plan limit reached'
                   : 'License/device check failed';
        const m = msg.match(/"error":"([^"]+)"/);
        if (m) reason = m[1];
        else if (isLimit) {
          const m2 = msg.match(/limit reached[^"}]*/i);
          if (m2) reason = m2[0];
        }
        const tag = isUpdate ? 'update required' : isLimit ? 'plan limit' : 'license/device';
        const archiveStatus = isUpdate ? 'update' : isLimit ? 'limit' : 'auth';
        await log('error', `Pipeline blocked by ${tag}: ${reason}`);
        await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: archiveStatus, progress: reason });
        try { await apiClient.logRun('full_pipeline', 'BLOCKED', 0, 0, 0, reason, ''); } catch {}
        await _archive(archiveStatus);
        return;
      }
      await log('warn', `createRun at pipeline start failed (${e.message}) — seed-exists check may not work for re-runs`);
    }

    // Step 1: keyword discovery.
    // NES (default): title-funnel from Etsy itself — no eRank, so no login gate.
    // Legacy: eRank scraping, which requires an eRank session.
    const useNes = nesEnabled(config);
    if (stopRequested) {
      await log('warn', '🛑 Pipeline stopped before Step 1');
      await updateState({ running: false, stopping: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'stopped', progress: 'Stopped — not enough data for a report yet' });
      await _archive('stopped');
      return;
    }
    await updateState({ currentStep: `Step 1: ${useNes ? 'Etsy Discovery' : 'eRank Keywords'} for "${seedKeyword}"` });

    if (!useNes) {
      const loggedIn = await checkErankLogin(tabId);
      if (!loggedIn) {
        await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'error', progress: 'eRank not logged in' });
        await apiClient.logRun('full_pipeline', 'FAILED', 0, 0, 0, 'eRank not logged in', '');
        await _archive('error');
        return;
      }
    }

    const checkStop = () => stopRequested;

    let step1 = { newKeywordsFound: 0, refreshedCount: 0 };
    if (resumeStep >= 1) {
      await log('info', `⏭️ Resume: skipping Step 1 (already completed)`);
    } else {
      const runStep1 = useNes ? runNesDiscovery : runErankKeywordResearch;
      step1 = await runStep1(apiClient, tabId, config, (type, msg) => {
        log(type, `[Step 1] ${msg}`);
        updateState({ progress: msg });
      }, seedKeyword, checkStop);
      await log('success', `Step 1 done: ${step1.newKeywordsFound} new keywords from "${seedKeyword}"`);

      if (stopRequested) {
        await handlePipelineStop({
          apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
          stoppedAfterStep: 1, useNes, _archive,
        });
        return;
      }
    }

    // ─── Pre-Step-2 gate: Step 1 must surface enough keywords ───
    // If Step 1 didn't produce at least `min_qualified_keywords` usable keywords
    // for this seed, there is no point running Step 2 at all — Etsy snapshots
    // burn rate-limit budget, and the final verdict is already going to be
    // NO-GO. We skip straight to Step 4's stripped-down NO-GO report so the
    // user can see the keyword table, understand the shortfall, and either
    // lower their `min_qualified_keywords` setting or pick a different seed.
    const minQualifiedKw = parseInt(config.min_qualified_keywords) || 5;
    // 2026-04-22: Gate first trusts Step 1's in-process counter (new + refreshed)
    // — that's what Step 1 actually wrote this run. A DB re-read was causing
    // false-negative NO-GOs: Hyperdrive + Workers tier can serve reads that
    // miss very-recent writes, so the gate saw 0 keywords despite Step 1
    // having just inserted 24. If Step 1's in-process count is already ≥
    // minQualifiedKw, trust it and skip the DB round-trip. Only fall back to
    // the DB-scan gate when Step 1 came up short, because in that case we
    // still want to count historical keywords already linked to this seed.
    const step1Usable = (step1.newKeywordsFound || 0) + (step1.refreshedCount || 0);
    let availableForSeed;
    if (step1Usable >= minQualifiedKw) {
      availableForSeed = step1Usable;
      await log('info', `✅ Gate: Step 1 surfaced ${step1Usable} usable keyword(s) (≥ ${minQualifiedKw} minimum) — skipping DB re-scan`);
    } else {
      availableForSeed = await countAvailableKeywordsForSeed(apiClient, seedKeyword, config);
      // Fallback read may see pre-existing historical keywords for this seed
      // that Step 1 didn't surface this run (e.g. rediscoveries below eRank's
      // top-N this time but still valid). If the DB scan bumps us over the
      // minimum, proceed.
      if (availableForSeed > step1Usable) {
        await log('info', `📚 Gate: Step 1 got ${step1Usable}, but DB has ${availableForSeed} historical keyword(s) for this seed — proceeding`);
      }
    }
    if (availableForSeed < minQualifiedKw) {
      await log('warn', `⏭️ Step 1 surfaced ${availableForSeed} usable keyword(s) for "${seedKeyword}" — below the ${minQualifiedKw} minimum. Skipping Steps 2 & 3.`);
      await updateState({ currentStep: `Step 4: NO-GO Report for "${seedKeyword}"` });
      const runStep4Short = nesEnabled(config) ? runNesScoring : runNicheScoring;
      const step4 = await runStep4Short(apiClient, config, (type, msg) => {
        log(type, `[Step 4] ${msg}`);
        updateState({ progress: msg });
      }, seedKeyword, { insufficientKeywords: true, availableCount: availableForSeed, minRequired: minQualifiedKw, pipelineRunId, pipelineStartedAt });
      await log('success', `Step 4 done: NO-GO report (insufficient keywords) for "${seedKeyword}"`);
      await updateState({
        running: false,
        currentStep: `Pipeline Complete: "${seedKeyword}" — NO-GO`,
        lastStatus: 'success',
        progress: `Keywords: ${availableForSeed}/${minQualifiedKw} — insufficient, Steps 2 & 3 skipped`
      });
      await chrome.storage.local.set({ lastRunTime: Date.now() });
      await log('warn', `=== Pipeline Complete for "${seedKeyword}" — NO-GO (insufficient keywords) ===`);
      await _archive('success');
      return;
    }

    // Step 2: Etsy Search Snapshots
    if (stopRequested) {
      await handlePipelineStop({
        apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
        stoppedAfterStep: 1, useNes, _archive,
      });
      return;
    }

    let step2 = { listingsFound: 0, keywordsProcessed: 0, qualifiedCount: 0, totalProcessed: 0, nicheQualified: true };
    if (resumeStep >= 2) {
      await log('info', `⏭️ Resume: skipping Step 2 (already completed)`);
      try {
        const nq = (await chrome.storage.local.get('nicheQualification')).nicheQualification;
        if (nq && nq.seedKeyword === seedKeyword) {
          step2 = {
            listingsFound: nq.totalListings || 0,
            keywordsProcessed: nq.totalProcessed || 0,
            qualifiedCount: nq.qualifiedCount || 0,
            totalProcessed: nq.totalProcessed || 0,
            nicheQualified: !!nq.nicheQualified,
          };
        }
      } catch (_) {}
    } else {
      await updateState({ currentStep: `Step 2: Etsy Snapshots for "${seedKeyword}"` });

      step2 = await runEtsySearchSnapshots(apiClient, tabId, config, (type, msg) => {
        log(type, `[Step 2] ${msg}`);
        updateState({ progress: msg });
      }, seedKeyword, checkStop, { pipelineRunId });
      await log('success', `Step 2 done: ${step2.listingsFound} listings from ${step2.keywordsProcessed} keywords — ${step2.qualifiedCount || 0}/${step2.totalProcessed || 0} keywords qualified`);

      if (stopRequested) {
        await handlePipelineStop({
          apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
          stoppedAfterStep: 2, useNes, _archive,
        });
        return;
      }
    }

    // Check niche qualification — if not enough qualified keywords, skip Steps 3 & 4 audit
    // but still generate a NO-GO report in Step 4
    let step3 = { audited: 0 };

    if (step2.nicheQualified) {
      if (resumeStep >= 3) {
        await log('info', `⏭️ Resume: skipping Step 3 (already completed)`);
      } else {
        await updateState({ currentStep: `Step 3: Listing Audit for "${seedKeyword}"` });

        step3 = await runErankListingAudit(apiClient, tabId, config, (type, msg) => {
          log(type, `[Step 3] ${msg}`);
          updateState({ progress: msg });
        }, seedKeyword, checkStop);
        await log('success', `Step 3 done: ${step3.audited} listings audited`);

        if (stopRequested) {
          await handlePipelineStop({
            apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
            stoppedAfterStep: 3, useNes, _archive,
          });
          return;
        }
      }
    } else {
      await log('warn', `⏭️ Skipping Step 3 — niche "${seedKeyword}" did not qualify (${step2.qualifiedCount || 0}/${step2.totalProcessed || 0} keywords)`);
    }

    // Step 4: Niche Verdict & Report (always runs — generates GO or NO-GO report)
    if (stopRequested) {
      await handlePipelineStop({
        apiClient, config, seedKeyword, pipelineRunId, pipelineStartedAt,
        stoppedAfterStep: step2.nicheQualified ? 3 : 2, useNes, _archive,
      });
      return;
    }
    await updateState({ currentStep: `Step 4: Verdict & Report for "${seedKeyword}"` });

    const runStep4 = useNes ? runNesScoring : runNicheScoring;
    const step4 = await runStep4(apiClient, config, (type, msg) => {
      log(type, `[Step 4] ${msg}`);
      updateState({ progress: msg });
    }, seedKeyword, { pipelineRunId, pipelineStartedAt });
    await log('success', `Step 4 done: ${step4.verdict || 'report'} for "${seedKeyword}"`);

    // 2026-07-01 (v1.3.0): Step 4 can RETURN {verdict:'ERROR'} WITHOUT throwing
    // (e.g. its seed lookup came back empty) — in that case no niche_scores
    // verdict row is written. Previously we archived 'success' regardless, so
    // the run showed 'completed' with no verdict on the dashboard. Treat an
    // ERROR verdict as a failed run so it's visible and can be re-run.
    if (step4 && step4.verdict === 'ERROR') {
      await log('error', `Step 4 could not score "${seedKeyword}" — no verdict written; marking run failed`);
      await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'error', progress: 'Scoring failed — no verdict' });
      await _archive('error');
      return;
    }

    // Done!
    await clearPipelineCheckpoint();
    const verdict = (step4 && step4.verdict) || (step2.nicheQualified ? 'GO' : 'NO-GO');
    await updateState({ running: false, stopping: false, currentStep: `Pipeline Complete: "${seedKeyword}" — ${verdict}`, lastStatus: 'success',
      progress: `Keywords: ${(step1.newKeywordsFound || 0) + (step1.refreshedCount || 0)} (${step1.newKeywordsFound || 0} new + ${step1.refreshedCount || 0} refreshed), Listings: ${step2.listingsFound}, Qualified: ${step2.qualifiedCount || 0}/${step2.totalProcessed || 0}, Verdict: ${verdict}` });
    await chrome.storage.local.set({ lastRunTime: Date.now() });
    await log('success', `=== Pipeline Complete for "${seedKeyword}" — Verdict: ${verdict} ===`);
    await _archive('success');

  } catch (err) {
    await log('error', `Pipeline error: ${err.message}`);
    await updateState({ running: false, stopping: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'error', progress: err.message });
    await _archive('error');
  } finally {
    activePipelineCtx = null;
    // Always release the keepalive so idle Chrome can suspend the worker
    // normally between runs. Safe to call even if startKeepalive errored.
    stopKeepalive();
  }
}

// ─── Single step ───
async function runSingleStep(stepNum, seedKeyword) {
  const stepNames = { 1: 'eRank Keyword Research', 2: 'Etsy Search Snapshots', 3: 'Etsy Listing Audit', 4: 'Niche Scoring & Reports' };

  await updateState({ running: true, currentStep: `Step ${stepNum}: ${stepNames[stepNum]} for "${seedKeyword}"`, progress: '', lastStatus: null, logs: [] });
  await log('info', `=== Running Step ${stepNum}: ${stepNames[stepNum]} for "${seedKeyword}" ===`);
  let _archived = false;
  let standaloneRunId = null;
  let standaloneApiClient = null;
  const _archive = async (status) => {
    if (_archived) return;
    _archived = true;
    // If a DB run record was created/resolved for this standalone step, flip it
    // to completed/failed so the dashboard doesn't see it stuck at 'running'.
    if (standaloneRunId && standaloneApiClient) {
      try {
        const dbStatus = status === 'success' ? 'completed' : 'failed';
        await standaloneApiClient.updateRun(standaloneRunId, dbStatus);
      } catch (e) {
        console.warn('[ENR] standalone updateRun at archive failed:', e.message);
      }
    }
    await flushLogsToServer(seedKeyword, `step${stepNum}`);
    return archiveCurrentRun({ seedKeyword, mode: 'step', step: stepNum, status });
  };

  // Keep the MV3 service worker alive for the duration of this step — see
  // the comment on startKeepalive() near the top of the file for the why.
  startKeepalive();

  try {
    let config = await loadConfig();
    const apiClient = await initAPIClient();
    // Same server-config merge as the full pipeline (see comment there) so a
    // solo step picks the same pipeline as a full run would.
    config = await mergeServerConfig(apiClient, config);

    const logFn = (type, msg) => {
      log(type, `[Step ${stepNum}] ${msg}`);
      updateState({ progress: msg });
    };

    const checkStop = () => stopRequested;
    let result;

    if (stepNum <= 3) {
      const tabId = await getOrCreateWorkTab();

      // Check eRank login for steps 1-3
      if (stepNum === 1) {
        // Step 3 is fully Etsy-only (verified: its only navigateTab targets are Etsy
        // listing URLs), so it never needs an eRank session under either pipeline.
        // Only legacy Step 1 (eRank keyword scraping) requires the login.
        const needsErank = !nesEnabled(config) && stepNum === 1;
        const loggedIn = needsErank ? await checkErankLogin(tabId) : true;
        if (!loggedIn) {
          await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'error', progress: 'eRank not logged in' });
          await _archive('error');
          return;
        }
      }

      if (stepNum === 1) result = await (nesEnabled(config) ? runNesDiscovery : runErankKeywordResearch)(apiClient, tabId, config, logFn, seedKeyword, checkStop);
      else if (stepNum === 2) {
        // Standalone Step 2: resolve this user's latest run for this seed
        // (or create a new one) so the per-user verdict write has a run_id.
        const soloRunId = await resolveOrCreateStandaloneRunId(apiClient, seedKeyword, config, log);
        standaloneRunId = soloRunId;
        standaloneApiClient = apiClient;
        result = await runEtsySearchSnapshots(apiClient, tabId, config, logFn, seedKeyword, checkStop, { pipelineRunId: soloRunId });
      }
      else if (stepNum === 3) result = await runErankListingAudit(apiClient, tabId, config, logFn, seedKeyword, checkStop);

      if (stopRequested && stepNum >= 1) {
        await handlePipelineStop({
          apiClient,
          config,
          seedKeyword,
          pipelineRunId: standaloneRunId,
          pipelineStartedAt: new Date().toISOString(),
          stoppedAfterStep: stepNum,
          useNes: nesEnabled(config),
          _archive,
        });
        return;
      }
    } else {
      // Standalone Step 4: locate this user's most recent run for this seed so
      // the fallback read of user_keyword_results has something to scope to.
      const soloRunId = await resolveLatestRunIdForSeed(apiClient, seedKeyword, log);
      result = await (nesEnabled(config) ? runNesScoring : runNicheScoring)(apiClient, config, logFn, seedKeyword, { pipelineRunId: soloRunId });
    }

    await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'success', progress: JSON.stringify(result) });
    await chrome.storage.local.set({ lastRunTime: Date.now() });
    await log('success', `=== Step ${stepNum} Complete for "${seedKeyword}" ===`);
    await _archive('success');

  } catch (err) {
    await log('error', `Step ${stepNum} failed: ${err.message}`);
    await updateState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, lastStatus: 'error', progress: err.message });
    await _archive('error');
  } finally {
    stopKeepalive();
  }
}

// ─── Pre-Step-2 gate helper ───
// Counts how many usable keywords the current seed has after Step 1, using
// the SAME filter rules Step 2 would apply:
//   - row.seed_id matches the seed
//   - row is within the freshness window (default 48h)
//   - row status is pending / validated / qualified / unqualified (i.e. not
//     blacklisted, not 'failed')
//   - keyword text passes the junk filter (no "/13", "Copy Tags", etc.)
// Returns the count so the gate can decide whether to skip Step 2.
// Standalone-step helpers — resolve a run_id for Step 2/4 when they're run
// outside the full pipeline. The Worker's /v1/run endpoint auto-scopes
// user_runs rows by X-License-Key, so we can safely query for THIS user's
// runs without an explicit user_id filter.
async function resolveLatestRunIdForSeed(apiClient, seedKeyword, log) {
  try {
    const { rows: seeds } = await apiClient.readSheet('seed_keywords');
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) return null;
    const { rows: runs } = await apiClient.readSheet('user_runs', { seed_id: seed.seed_id });
    if (!runs || runs.length === 0) return null;
    // Latest by started_at
    runs.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
    const runId = runs[0].run_id;
    if (log) await log('info', `Resolved latest run_id=${runId} for seed "${seedKeyword}" (standalone)`);
    return runId ? Number(runId) : null;
  } catch (e) {
    if (log) await log('warn', `Could not resolve latest run_id (${e.message}) — falling back to no-verdict fallback`);
    return null;
  }
}

async function resolveOrCreateStandaloneRunId(apiClient, seedKeyword, config, log) {
  try {
    const runRes = await apiClient.createRun(seedKeyword, config);
    const runId = (runRes && runRes.run_id) ? Number(runRes.run_id) : null;
    if (log && runId) await log('info', `Created standalone run_id=${runId} for seed "${seedKeyword}"`);
    return runId;
  } catch (e) {
    if (log) await log('warn', `Could not create standalone run (${e.message}) — falling back to latest existing run`);
    return await resolveLatestRunIdForSeed(apiClient, seedKeyword, log);
  }
}

async function countAvailableKeywordsForSeed(apiClient, seedKeyword, config) {
  try {
    const { rows: seeds } = await apiClient.readSheet('seed_keywords');
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) return 0;
    const seedId = String(seed.seed_id);

    // 2026-04-17: dropped the `sinceHours: 48, sinceColumn: 'updated_at'`
    // freshness filter that used to live on this read.
    //   - This is a STRUCTURAL gate ("does this seed have keywords to work with?")
    //     not a DATA-AGE gate. If the user has 100 keywords linked to seed
    //     "doctor" from prior runs, the pipeline should proceed regardless of
    //     when Step 1 last bumped their row timestamps.
    //   - Step 2 re-snapshots every selected keyword anyway (snapshot-always
    //     model), so keyword-row age has no bearing on the freshness of the
    //     listings/snapshots Step 2 actually depends on.
    //   - The prior filter was producing false-negative NO-GO skips whenever a
    //     seed was rerun beyond 48h: Step 1 only refreshed whatever eRank
    //     happened to re-surface in its top N, leaving the rest stale and
    //     invisible to the gate.
    // Post-m2m migration: keywords table no longer has seed_id. We push the
    // filter down to the Worker, which transparently JOINs through
    // pro_etsy_res_seed_keyword_map and aliases _skm.seed_id AS seed_id in the
    // result, so downstream code that reads k.seed_id keeps working.
    const { rows: keywords } = await apiClient.readSheet(
      'etsy_keywords',
      { seed_id: seedId }
    );

    let count = 0;
    for (const k of keywords) {
      // Safety net: the server-side JOIN should already have scoped this,
      // but we double-check in case the Worker ever returns extra rows.
      if (String(k.seed_id) !== seedId) continue;
      const status = (k.status || '').toLowerCase();
      if (status && status !== 'pending' && status !== 'validated'
          && status !== 'qualified' && status !== 'unqualified') continue;
      const kwText = (k.keyword || '').trim();
      if (!kwText || isJunkKeywordGate(kwText)) continue;
      count++;
    }
    return count;
  } catch (e) {
    console.warn('[ENR] countAvailableKeywordsForSeed failed:', e && e.message);
    // Fail open: if the count fails, let Step 2 run its own checks so we
    // don't block a real pipeline on a transient DB hiccup.
    return Number.POSITIVE_INFINITY;
  }
}

// Junk filter — mirrored from etsy-snapshot-workflow.js. Keep these two in
// sync; they are the two layers of defense against stale garbage rows from
// older extractor versions leaking into Step 2.
function isJunkKeywordGate(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower.length < 4) return true;
  if (/^\d+$/.test(lower)) return true;
  if (/^[\/\\]/.test(trimmed)) return true;
  const stripped = trimmed.replace(/^[\/\\\s]+/, '').trim();
  if (/^\d+$/.test(stripped)) return true;
  if (/^\d+\s/.test(trimmed)) return true;
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && words.some(w => w.length === 1 && w !== 'i' && w !== 'a')) return true;
  if (words.length >= 2 && words.every(w => w.length <= 2)) return true;
  const uiJunk = [
    'copy tags', 'copy tag', 'copy to clipboard', 'copy all',
    'search trends', 'search trend', 'search trending',
    'show filters', 'hide filters', 'clear filters',
    'categories', 'sort by', 'filter by',
    'bestseller', 'top seller', 'new seller',
    'menu', 'dashboard', 'settings', 'account',
    'log in', 'log out', 'sign in', 'sign out', 'sign up',
    'home favourites', 'home favorites', 'top gifts', 'trending now',
    'star seller', 'free shipping',
  ];
  if (uiJunk.includes(lower)) return true;
  const navOnly = new Set([
    'categories', 'shop', 'sell', 'cart', 'wishlist', 'help', 'about',
    'blog', 'faq', 'terms', 'privacy', 'policy', 'contact', 'support',
    'trending', 'popular', 'featured', 'explore', 'discover'
  ]);
  if (navOnly.has(lower)) return true;
  const junkPatterns = [
    'keyword stuffing', 'possible typo', 'repeated word', 'repeated words',
    'repeated tag', 'repeated tags', 'misspelling', 'misspelled',
    'duplicate tag', 'duplicate tags', 'too long', 'too short',
    'single word', 'not relevant', 'low quality', 'quality issue',
    'character limit', 'special character'
  ];
  for (const pat of junkPatterns) { if (lower.includes(pat)) return true; }
  if (/^[A-Za-z\s]+:\s+/i.test(trimmed) && !trimmed.includes('http')) return true;
  if (/^["'\u201c\u201d]/.test(trimmed) && /["'\u201c\u201d]/.test(trimmed)) return true;
  if (/appears\s+\d+\s+times?/i.test(lower)) return true;
  if (/\(\d+\)\s*$/.test(trimmed) && trimmed.split(/\s+/).length <= 2) return true;
  return false;
}

// ─── Helpers ───
function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        workTabId = null;
        return reject(new Error('Tab no longer exists: ' + chrome.runtime.lastError.message));
      }
      const listener = (tId, changeInfo) => {
        if (tId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    });
  });
}

// 2026-06-16: timeoutMs is now per-call. The slow Step-1 eRank ops pass 65000 —
// waitForKeywordTable legitimately polls up to ~60s while the competition
// column resolves, and the old fixed 30s cap aborted it mid-work, stopping
// Step-1 pagination early ("sendToTab timeout" regression). Fast ops keep 30s.
async function sendToTab(tabId, message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const act = (message && message.action) || 'unknown';
        reject(new Error(`sendToTab timeout after ${timeoutMs}ms (action: ${act})`));
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      }
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── On install ───
chrome.runtime.onInstalled.addListener(() => {
  console.log(`${EXT_NAME} installed`);
  saveRunState({ running: false, progressCur: null, progressTotal: null, progressPhase: null, currentStep: null, progress: '', logs: [], lastStatus: null });
});
