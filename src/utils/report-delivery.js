// Save generated HTML reports locally and trigger browser download.
// Reports are kept in chrome.storage.local so the popup can view or
// re-download them even when chrome.downloads fails (e.g. large data URLs).

const STORAGE_KEY = 'lastReport';
const HISTORY_KEY = 'reportHistory';
const MAX_HISTORY = 5;
// Soft guard: chrome.storage.local is typically ~10MB. Keep HTML under ~4MB.
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function approxBytes(str) {
  try {
    return new Blob([str]).size;
  } catch {
    return String(str || '').length * 2;
  }
}

export async function deliverReport(html, meta, log) {
  const rawHtml = String(html || '');
  const htmlBytes = approxBytes(rawHtml);
  const storeHtml = htmlBytes <= MAX_HTML_BYTES;
  if (!storeHtml && log) {
    log('warn', `Report HTML is large (${Math.round(htmlBytes / 1024)} KB) — download will still run, but in-popup storage was skipped to protect quota`);
  }

  const report = {
    html: storeHtml ? rawHtml : '',
    htmlStored: storeHtml,
    htmlBytes,
    filename: meta.filename || `etsyhunt_report_${Date.now()}.html`,
    seedKeyword: meta.seedKeyword || '',
    verdict: meta.verdict || '',
    generatedAt: meta.generatedAt || new Date().toISOString(),
    reportType: meta.reportType || 'full',
    partial: !!meta.partial,
    stoppedAfterStep: meta.stoppedAfterStep != null ? meta.stoppedAfterStep : null,
    completedSteps: Array.isArray(meta.completedSteps) ? meta.completedSteps : [],
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: report });
  await pushReportHistory(report);

  try {
    const { runState } = await chrome.storage.local.get('runState');
    if (runState) {
      await chrome.storage.local.set({
        runState: {
          ...runState,
          lastReport: {
            seedKeyword: report.seedKeyword,
            verdict: report.verdict,
            generatedAt: report.generatedAt,
            filename: report.filename,
            reportType: report.reportType,
            partial: report.partial,
            stoppedAfterStep: report.stoppedAfterStep,
          },
          partialReportReady: !!report.partial,
        },
      });
    }
  } catch (_) { /* non-fatal */ }

  let downloaded = false;
  try {
    const blob = new Blob([rawHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename: report.filename, saveAs: false });
      downloaded = true;
      const kind = report.partial ? 'Partial report' : 'Report';
      if (log) log('success', `📄 ${kind} saved — download started: ${report.filename}`);
    } finally {
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 60000);
    }
  } catch (e) {
    if (log) {
      log('warn', `Auto-download failed (${e.message}) — open or download the report from the EtsyHunt popup`);
    }
  }

  return { downloaded, report };
}

async function pushReportHistory(report) {
  try {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
    // Keep HTML only for the newest entry to limit quota; older keep metadata.
    const slimPrior = history.map((h) => ({
      ...h,
      html: '',
      htmlStored: false,
    }));
    const entry = {
      id: `${report.generatedAt}|${report.filename}`,
      seedKeyword: report.seedKeyword,
      verdict: report.verdict,
      generatedAt: report.generatedAt,
      filename: report.filename,
      reportType: report.reportType,
      partial: report.partial,
      stoppedAfterStep: report.stoppedAfterStep,
      completedSteps: report.completedSteps,
      html: report.html,
      htmlStored: report.htmlStored,
    };
    slimPrior.unshift(entry);
    if (slimPrior.length > MAX_HISTORY) slimPrior.length = MAX_HISTORY;
    await chrome.storage.local.set({ [HISTORY_KEY]: slimPrior });
  } catch (e) {
    console.warn('[ENR] report history push failed:', e && e.message);
  }
}

export async function getLastReport() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

export async function getReportHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}
