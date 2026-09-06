// Popup Controller — communicates with service worker

// 2026-06-16 (security audit E1): escape text before it goes into innerHTML.
// Activity-log messages embed scraped Etsy shop names / listing titles, which
// are attacker-controlled — an unescaped value like `<img src=x onerror=...>`
// would execute in the popup's chrome-extension:// origin.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showVersion() {
  try {
    const manifest = chrome.runtime.getManifest();
    const el = document.getElementById('ext-version');
    if (el) el.textContent = 'v' + manifest.version;
  } catch (_) {}
}

const STEP_LABELS = ['Keywords', 'Snapshots', 'Listings', 'Report'];
const CTA_DEFAULT = 'Start full pipeline';

function setCtaLabel(text) {
  const btn = document.getElementById('btn-full-pipeline');
  if (!btn) return;
  const label = btn.querySelector('.btn-cta-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  // Local "I just clicked Start" flag — prevents the double-click race where
  // refreshUI() runs ~1s after the click but the service worker hasn't yet
  // flipped runState.running to true, so the buttons would briefly re-enable
  // and a second click would launch a parallel pipeline.
  // Cleared once we observe runState.running === true OR after a hard timeout.
  let pendingStart = false;
  let pendingStartAt = 0;
  const PENDING_START_TIMEOUT_MS = 15000; // give the worker up to 15s to flip running=true

  // Separate guard for the pre-flight phase (seed-exists check + confirmation
  // banner). pendingStart only kicks in after the check resolves, so without
  // this flag a second click during the ~1-3s check sneaks through and we
  // launch two pipelines or show two confirmation banners.
  let preflightInProgress = false;

  // ─── Load state ───
  async function refreshUI() {
    const { runState } = await chrome.storage.local.get('runState');
    const state = runState || { running: false, currentStep: null, progress: '', logs: [] };

    // Clear pendingStart once the worker has actually started, or if it's been
    // way too long (something went wrong — let the user click again).
    if (pendingStart) {
      if (state.running) {
        pendingStart = false;
      } else if (Date.now() - pendingStartAt > PENDING_START_TIMEOUT_MS) {
        pendingStart = false;
      }
    }

    // Treat pendingStart as if we were running, so buttons stay disabled
    // until the service worker confirms.
    if (pendingStart && !state.running) {
      state.running = true;
      state.currentStep = state.currentStep || 'Starting...';
    }

    const dot = $('status-dot');
    const statusText = $('status-text');
    const statusPill = $('status-pill');
    const stepEl = $('current-step');
    const progressEl = $('progress-info');

    // 2026-08-20: progress bar. The service worker publishes progressCur/Total
    // from the [i/n] counters the workflows already emit, so this needs no new
    // plumbing in the step modules. Time-left uses the per-item costs measured
    // from real runs (~42s to search a keyword, ~17s to open a listing at a 7s
    // delay). Everything hides when there is no count — a bar that invents its
    // own position is worse than no bar.
    renderProgress(state);

    if (state.running) {
      dot.className = 'dot running';
      statusText.textContent = 'Running';
      statusPill?.classList.remove('is-success', 'is-error');
      statusPill?.classList.add('is-running');
      stepEl.textContent = state.currentStep || 'Processing…';
      progressEl.textContent = state.progress || '';
      $('btn-full-pipeline').disabled = true;
      setCtaLabel('Running…');
      document.querySelectorAll('.btn-step').forEach(b => b.disabled = true);
      $('btn-stop').disabled = false;
    } else {
      const isError = state.lastStatus === 'error';
      const isSuccess = state.lastStatus === 'success';
      dot.className = 'dot ' + (isError ? 'error' : isSuccess ? 'success' : 'idle');
      statusText.textContent = isError ? 'Error' : isSuccess ? 'Completed' : state.lastStatus === 'stopped' ? 'Stopped' : 'Idle';
      statusPill?.classList.remove('is-running', 'is-success', 'is-error');
      if (isError) statusPill?.classList.add('is-error');
      else if (isSuccess) statusPill?.classList.add('is-success');
      stepEl.textContent = state.lastStatus
        ? `Last run: ${state.currentStep || 'Pipeline'}`
        : 'Ready when you are';
      progressEl.textContent = state.progress || '';
      $('btn-full-pipeline').disabled = false;
      setCtaLabel(CTA_DEFAULT);
      document.querySelectorAll('.btn-step').forEach((b, i) => {
        b.disabled = false;
        const lbl = b.querySelector('.s-label');
        if (lbl) lbl.textContent = STEP_LABELS[i];
      });
      $('btn-stop').disabled = true;
    }

    const logArea = $('log-area');
    if (state.logs && state.logs.length > 0) {
      logArea.innerHTML = state.logs.map(l => {
        const cls = l.type === 'error' ? 'log-error' : l.type === 'success' ? 'log-success' : l.type === 'warn' ? 'log-warn' : 'log-info';
        const time = l.time ? `<span style="color:#64748b">[${escHtml(l.time)}]</span> ` : '';
        return `<div class="log-entry ${cls}">${time}${escHtml(l.msg)}</div>`;
      }).join('');
      logArea.scrollTop = logArea.scrollHeight;
    } else if (logArea) {
      logArea.innerHTML = '<div class="log-empty">Logs appear here once a run starts.</div>';
    }
  }

  // ─── Progress bar ─────────────────────────────────────────────────────────
  function renderProgress(state) {
    const track = $('progress-track');
    const meta  = $('progress-meta');
    if (!track || !meta) return;
    const cur = parseInt(state.progressCur, 10);
    const total = parseInt(state.progressTotal, 10);
    const show = state.running && Number.isFinite(cur) && Number.isFinite(total) && total > 0;
    track.style.display = show ? 'block' : 'none';
    meta.style.display  = show ? 'flex'  : 'none';
    if (!show) return;

    const pct = Math.max(0, Math.min(100, Math.round((cur / total) * 100)));
    $('progress-fill').style.width = pct + '%';
    $('progress-count').textContent = `${cur} of ${total} · ${pct}%`;

    // Remaining time for the CURRENT phase only. We don't claim to know what
    // the later steps will cost — saying "19 min left" and meaning "for this
    // step" is honest; pretending to time the whole pipeline is not.
    const delay = Math.max(parseInt($('input-delay').value, 10) || 7, 7);
    // Per-item costs, all measured from real runs. Autosuggest probes are ~0.7s
    // (28 probes in 20s, run 4840) and are NOT subject to the page delay — they
    // are a single fetch against Etsy's suggestions endpoint, not a page load.
    const perItem = state.progressPhase === 'listing' ? (10 + delay)
      : state.progressPhase === 'keyword' ? (35 + delay)
      : state.progressPhase === 'probe' ? 0.8 : null;
    if (!perItem) { $('progress-left').textContent = ''; return; }
    const secs = Math.max(0, (total - cur) * perItem);
    if (secs < 90) {
      $('progress-left').textContent = secs < 8 ? 'almost done' : `~${Math.round(secs)}s left in this step`;
      return;
    }
    const mins = Math.round(secs / 60);
    $('progress-left').textContent = mins >= 60
      ? `~${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m left in this step`
      : (mins <= 1 ? 'almost done' : `~${mins} min left in this step`);
  }

  // ─── Max listings per keyword: >16 warning ───
  // We removed the hard max="16" on the input so power users can push the
  // audit depth higher, but runs with >16 audits per keyword get noticeably
  // slower and chew more eRank credits. Show a red inline warning when the
  // current value is above 16 so Ali always sees the tradeoff.
  function checkMaxListingsWarning() {
    const input = $('input-max-listings-per-kw');
    const warn = $('warn-max-listings-per-kw');
    if (!input || !warn) return;
    const n = parseInt(input.value, 10);
    warn.style.display = Number.isFinite(n) && n > 16 ? 'block' : 'none';
  }

  // ─── Load settings ───
  async function loadSettings() {
    const { config } = await chrome.storage.local.get(['config']);
    const cfg = config || {};

    // 2026-08-20: min_monthly_searches / max_competition / min_word_count are no
    // longer surfaced — nothing in the NES pipeline reads them (see popup.html).
    if (cfg.max_keywords_per_run) $('input-max-keywords').value = cfg.max_keywords_per_run;
    // 2026-08-08: clamp a previously-saved value (installs commonly have 5) up
    // to the 7s Etsy floor so the UI shows what will actually be used.
    if (cfg.delay_between_pages_sec) $('input-delay').value = Math.max(parseInt(cfg.delay_between_pages_sec) || 7, 7);
    // Niche qualification settings
    if (cfg.max_listings_per_keyword) $('input-max-listings-per-kw').value = cfg.max_listings_per_keyword;
    // Re-evaluate the >16 warning after loading stored value
    checkMaxListingsWarning();
    if (typeof updateRunEstimate === 'function') updateRunEstimate();
    if (cfg.min_qualified_keywords) $('input-min-qualified-kw').value = cfg.min_qualified_keywords;
    if (cfg.max_shop_reviews_beatable) $('input-max-shop-reviews').value = cfg.max_shop_reviews_beatable;
    if (cfg.min_beatable_slots) $('input-min-beatable-slots').value = cfg.min_beatable_slots;
    // 2026-08-20: audit_keyword_max merged into max_keywords_per_run.
    // Product type filter (digital / physical / any)
    if (cfg.product_type_filter) $('select-product-type').value = cfg.product_type_filter;
    // 2026-08-20: use_manual_erank_tab and enforce_seed_relevance controls
    // removed — both are read only by the legacy eRank Step 1.
  }

  // Auto-save product type filter on change (no Save Settings click required).
  // Dropdown is immediately below seed kw field, not inside Settings accordion,
  // so users expect change to take effect right away.
  function wireAutoSaveProductTypeFilter() {
    const sel = $('select-product-type');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const newValue = sel.value || 'digital';
      chrome.storage.local.get(['config'], (result) => {
        const cfg = result.config || {};
        cfg.product_type_filter = newValue;
        chrome.storage.local.set({ config: cfg }, () => {
          // Brief visual confirmation
          sel.style.transition = 'box-shadow 0.3s';
          sel.style.boxShadow = '0 0 0 2px #16a34a';
          setTimeout(() => { sel.style.boxShadow = ''; }, 600);
        });
      });
    });
  }
  wireAutoSaveProductTypeFilter();

  // ─── Product type: segmented control mirrors the (hidden) select ─────────
  // 2026-08-20: the select is still the single source of truth — popup.js and
  // the workflows read product_type_filter from it — but the user now clicks a
  // segmented control. Radio → select fires the existing auto-save above.
  function wireProductTypeSegment() {
    const sel = $('select-product-type');
    const radios = document.querySelectorAll('#product-type-seg input[name="ptype"]');
    if (!sel || !radios.length) return;
    radios.forEach(r => r.addEventListener('change', () => {
      if (!r.checked) return;
      sel.value = r.value;
      sel.dispatchEvent(new Event('change'));
    }));
    // select → radios (initial load, and any programmatic change)
    const sync = () => radios.forEach(r => { r.checked = (r.value === sel.value); });
    sel.addEventListener('change', sync);
    sync();
  }
  wireProductTypeSegment();

  // ─── Run-time estimate under the Start button ────────────────────────────
  // 2026-08-20: a run is 30-60 minutes and nobody can infer that from the
  // numbers. Constants are MEASURED from real run logs, not guessed:
  //   Step 1 discovery      ~2.0 min flat        (run 4840)
  //   Step 2 per keyword    ~42s at a 7s delay   (8.5 min / 12 kw, run 4840)
  //   Step 3 per listing    ~17s at a 7s delay   (26.2 min / 94, run 4840;
  //                                               39.1 min / 131, run 4831)
  // The variable part is how many listings actually get opened: a listing that
  // ranks for several of the run's keywords is read ONCE, so the audit count
  // comes in well under keywords x listings — 94 of 144 (65%) on tote bag,
  // 131 of 192 (68%) on adhd, and lower when the keywords share a shelf. A
  // single number was therefore ~1.8x too high; we show a range across a
  // 50-85% overlap band instead. Back-checked: run 4831 actual 53 min lands
  // inside 43-63, run 4840 actual ~37 min lands inside 37-56.
  const EST = { step1Min: 2, searchFixed: 35, listingFixed: 10, lapLow: 0.5, lapHigh: 0.85 };
  function updateRunEstimate() {
    const el = $('run-estimate');
    if (!el) return;
    const kw = parseInt($('input-max-keywords').value, 10);
    const listings = parseInt($('input-max-listings-per-kw').value, 10);
    if (!Number.isFinite(kw) || !Number.isFinite(listings) || kw < 1 || listings < 1) {
      el.textContent = '';
      return;
    }
    const delay = Math.max(parseInt($('input-delay').value, 10) || 7, 7);
    const searchMin = (kw * (EST.searchFixed + delay)) / 60;
    const auditMin = (share) => (kw * listings * share * (EST.listingFixed + delay)) / 60;
    const lo = Math.round(EST.step1Min + searchMin + auditMin(EST.lapLow));
    const hi = Math.round(EST.step1Min + searchMin + auditMin(EST.lapHigh));
    const fmt = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
    el.innerHTML = `About <b>${lo === hi ? fmt(lo) : fmt(lo) + '–' + fmt(hi)}</b> · ${kw} keyword${kw === 1 ? '' : 's'} × up to ${listings} listings`;
    el.title = 'Measured from real runs: ~2 min to discover keywords, ~'
      + (EST.searchFixed + delay) + 's to search each keyword, ~' + (EST.listingFixed + delay)
      + 's to open each listing. The range is because a listing ranking for several of your keywords is only opened once.';
  }
  ['input-max-keywords', 'input-max-listings-per-kw', 'input-delay'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', updateRunEstimate);
  });

  // 2026-08-20: wireAutoSaveManualErank() removed along with its checkbox —
  // the setting is read only by the legacy eRank Step 1.

  // ─── Seed keyword validation ───
  function getSeedKeyword() {
    const val = ($('input-seed-keyword').value || '').trim();
    if (!val) {
      $('seed-error').style.display = 'block';
      $('input-seed-keyword').focus();
      return null;
    }
    $('seed-error').style.display = 'none';
    return val;
  }

  // Ask the service worker to check if seed already exists in the database
  function checkSeedExists(seedKeyword) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'checkSeedExists', seedKeyword }, (response) => {
        resolve(response || { exists: false });
      });
    });
  }

  // Show inline confirmation banner, returns promise
  function showConfirmBanner(message) {
    return new Promise((resolve) => {
      const banner = $('confirm-banner');
      const msg = $('confirm-msg');
      msg.textContent = message;
      banner.style.display = 'block';

      const yesBtn = $('btn-confirm-yes');
      const noBtn = $('btn-confirm-no');

      function cleanup() {
        banner.style.display = 'none';
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
      }
      function onYes() { cleanup(); resolve(true); }
      function onNo() { cleanup(); resolve(false); }

      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
    });
  }

  // Check seed against database, show confirmation if it exists
  async function checkSeedAndConfirm(seedKeyword) {
    const result = await checkSeedExists(seedKeyword);
    if (result.exists) {
      let info;
      if (result.timesSearched) {
        const parts = [`searched ${result.timesSearched} time(s)`];
        if (result.keywordCount != null) parts.push(`${result.keywordCount} keywords`);
        if (result.listingCount != null) parts.push(`${result.listingCount} listings`);
        info = `"${seedKeyword}" already exists (${parts.join(', ')}).`;
      } else {
        info = `"${seedKeyword}" already exists in the database.`;
      }
      return showConfirmBanner(`${info} Run again? This will add more data to the existing seed.`);
    }
    return true;
  }

  // Persist seed keyword across popup opens
  chrome.storage.local.get('currentSeedKeyword', (data) => {
    if (data.currentSeedKeyword) $('input-seed-keyword').value = data.currentSeedKeyword;
  });
  $('input-seed-keyword').addEventListener('input', () => {
    $('seed-error').style.display = 'none';
    chrome.storage.local.set({ currentSeedKeyword: $('input-seed-keyword').value.trim() });
  });

  // Live-update the >16 warning as the user edits the max-listings input.
  const maxListingsInput = $('input-max-listings-per-kw');
  if (maxListingsInput) {
    maxListingsInput.addEventListener('input', checkMaxListingsWarning);
    // Also run once at bind time in case loadSettings() hasn't fired yet.
    checkMaxListingsWarning();
    if (typeof updateRunEstimate === 'function') updateRunEstimate();
  }

  // ─── Event listeners ───
  $('btn-full-pipeline').addEventListener('click', async () => {
    if (pendingStart || preflightInProgress) return; // double-click guard
    const seedKeyword = getSeedKeyword();
    if (!seedKeyword) return;
    preflightInProgress = true;
    // Disable the button immediately and show "Checking..." so the user
    // sees feedback during the seed-exists API call. Without this the
    // button looks idle for 1-3s and they double-click.
    $('btn-full-pipeline').disabled = true;
    setCtaLabel('Checking…');
    document.querySelectorAll('.btn-step').forEach(b => b.disabled = true);
    try {
      const ok = await checkSeedAndConfirm(seedKeyword);
      if (!ok) {
        // User said No (or no banner shown). Restore the buttons.
        preflightInProgress = false;
        $('btn-full-pipeline').disabled = false;
        setCtaLabel(CTA_DEFAULT);
        document.querySelectorAll('.btn-step').forEach(b => b.disabled = false);
        return;
      }
      // Hand off to pendingStart, then fire the message.
      pendingStart = true;
      pendingStartAt = Date.now();
      setCtaLabel('Starting…');
      chrome.runtime.sendMessage({ action: 'startPipeline', mode: 'full', seedKeyword }, (resp) => {
        if (chrome.runtime.lastError) {
          // SW dropped the message — clear pending and let user retry.
          console.warn('startPipeline message error:', chrome.runtime.lastError.message);
          pendingStart = false;
          $('btn-full-pipeline').disabled = false;
          setCtaLabel(CTA_DEFAULT);
          document.querySelectorAll('.btn-step').forEach(b => b.disabled = false);
          return;
        }
        if (resp && !resp.started) {
          setCtaLabel('Already running');
        }
      });
      setTimeout(refreshUI, 1000);
    } finally {
      preflightInProgress = false;
    }
  });

  // 2026-08-20: step chips are two-line — <em>Step N</em> + <span class="s-label">.
  // Writing btn.textContent flattens both into one string ("Step 1Keywords") and
  // destroys the markup, which is what happened when a chip was clicked and then
  // cancelled: the handler saved textContent and wrote it back as plain text.
  // Always go through the label span so the "Step N" line survives.
  const stepLabel = (btn) => {
    const el = btn.querySelector('.s-label');
    return el ? el.textContent : btn.textContent;
  };
  const setStepLabel = (btn, text) => {
    const el = btn.querySelector('.s-label');
    if (el) el.textContent = text; else btn.textContent = text;
  };

  document.querySelectorAll('.btn-step').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (pendingStart || preflightInProgress) return; // double-click guard
      const seedKeyword = getSeedKeyword();
      if (!seedKeyword) return;
      preflightInProgress = true;
      $('btn-full-pipeline').disabled = true;
      btn.disabled = true;
      const originalText = stepLabel(btn);
      setStepLabel(btn, 'Checking…');
      document.querySelectorAll('.btn-step').forEach(b => b.disabled = true);
      try {
        const ok = await checkSeedAndConfirm(seedKeyword);
        if (!ok) {
          preflightInProgress = false;
          $('btn-full-pipeline').disabled = false;
          setStepLabel(btn, originalText);
          document.querySelectorAll('.btn-step').forEach(b => b.disabled = false);
          return;
        }
        pendingStart = true;
        pendingStartAt = Date.now();
        setStepLabel(btn, 'Starting…');
        const step = parseInt(btn.dataset.step);
        chrome.runtime.sendMessage({ action: 'startPipeline', mode: 'step', step, seedKeyword }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('startPipeline message error:', chrome.runtime.lastError.message);
            pendingStart = false;
            $('btn-full-pipeline').disabled = false;
            btn.disabled = false;
            setStepLabel(btn, originalText);
            document.querySelectorAll('.btn-step').forEach(b => b.disabled = false);
            return;
          }
          if (resp && !resp.started) {
            setStepLabel(btn, 'Running…');
          }
        });
        setTimeout(refreshUI, 1000);
      } finally {
        preflightInProgress = false;
      }
    });
  });

  $('btn-stop').addEventListener('click', () => {
    if (!confirm('Stop the running pipeline? Progress will be lost.')) return;
    chrome.runtime.sendMessage({ action: 'stopPipeline' });
    setTimeout(refreshUI, 500);
  });

  $('btn-copy-log').addEventListener('click', async () => {
    const btn = $('btn-copy-log');
    try {
      const { runState } = await chrome.storage.local.get('runState');
      const state = runState || {};
      if (!state.logs || state.logs.length === 0) {
        btn.textContent = 'No logs';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        return;
      }
      const text = state.logs.map(l => `[${l.time || ''}] [${l.type}] ${l.msg}`).join('\n');
      // navigator.clipboard.writeText can silently fail in MV3 popups
      // (focus loss, missing permission). Use a textarea fallback.
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    } catch (e) {
      console.error('Copy log failed:', e);
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });

  $('btn-clear-log').addEventListener('click', async () => {
    const { runState } = await chrome.storage.local.get('runState');
    const state = runState || {};
    state.logs = [];
    await chrome.storage.local.set({ runState: state });
    refreshUI();
  });

  // Download persistent run history (last 10 runs) as a JSON file.
  // Includes the current in-progress run state too, so users can grab logs
  // mid-run without losing them.
  $('btn-download-logs').addEventListener('click', async () => {
    const btn = $('btn-download-logs');
    try {
      const data = await chrome.storage.local.get(['runHistory', 'runState']);
      const history = Array.isArray(data.runHistory) ? data.runHistory : [];
      const payload = {
        exported_at: new Date().toISOString(),
        current_run: data.runState || null,
        history,
        history_count: history.length,
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = url;
      a.download = `etsyhunt-logs-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the download has a chance to start
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      btn.textContent = 'Downloaded!';
      setTimeout(() => { btn.textContent = 'Export'; }, 1500);
    } catch (e) {
      console.error('Download logs failed:', e);
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Export'; }, 1500);
    }
  });

  // ─── Reset Settings ───────────────────────────────────────────────────────
  // 2026-08-20: puts the shipped defaults back into the form. Deliberately does
  // NOT write to storage — the user presses Save afterwards.
  // Values mirror DEFAULT_CONFIG in src/utils/config-loader.js; popup.js is a
  // plain script (not a module) so they can't be imported. Keep the two in sync.
  const SETTINGS_DEFAULTS = {
    'select-product-type':       'any',
    'input-max-keywords':        20,   // max_keywords_per_run (searched AND audited)
    'input-delay':               7,    // delay_between_pages_sec (7s Etsy floor)
    'input-max-listings-per-kw': 12,   // max_listings_per_keyword
    'input-min-qualified-kw':    5,    // min_qualified_keywords
    'input-max-shop-reviews':    300,  // max_shop_reviews_beatable
    'input-min-beatable-slots':  3,    // min_beatable_slots
  };
  const resetBtn = $('btn-reset-settings');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const [id, value] of Object.entries(SETTINGS_DEFAULTS)) {
        const el = $(id);
        if (el) el.value = value;
      }
      checkMaxListingsWarning();
      if (typeof updateRunEstimate === 'function') updateRunEstimate();
      const note = $('settings-reset');
      if (note) {
        note.style.display = 'inline';
        setTimeout(() => { note.style.display = 'none'; }, 4000);
      }
    });
  }

  // Save settings
  $('btn-save-settings').addEventListener('click', async () => {
    const config = {
      // 2026-08-20: min_monthly_searches / max_competition / min_word_count /
      // enforce_seed_relevance are no longer written from the popup — no NES
      // step reads them, and persisting them made runs look filtered when they
      // were not. The legacy pipeline still resolves them from DEFAULT_CONFIG
      // and the server config table.
      max_keywords_per_run: parseInt($('input-max-keywords').value) || 20,
      // 2026-08-08: never save below the 7s Etsy floor (min= on the input only
      // guards the spinner; a typed value still needs clamping).
      delay_between_pages_sec: Math.max(parseInt($('input-delay').value) || 7, 7),
      // Niche qualification
      max_listings_per_keyword: Math.min(48, Math.max(6, parseInt($('input-max-listings-per-kw').value) || 12)),
      min_qualified_keywords: parseInt($('input-min-qualified-kw').value) || 5,
      max_shop_reviews_beatable: parseInt($('input-max-shop-reviews').value) || 300,
      min_beatable_slots: parseInt($('input-min-beatable-slots').value) || 3,
      // Pre-audit ranking — audit_keyword_pct removed 2026-04-18 (Step 3 is Etsy-only,
      // no eRank credits, so % throttling is no longer needed).
      // 2026-08-20: audit_keyword_max is no longer written — Step 3 audits every
      // keyword Step 2 searched, bounded by max_keywords_per_run above.
      // Product type filter
      product_type_filter: $('select-product-type').value || 'digital',
    };

    await chrome.storage.local.set({ config });
    $('settings-saved').style.display = 'inline';
    setTimeout(() => { $('settings-saved').style.display = 'none'; }, 2000);
  });

  // Listen for state changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.runState) {
      refreshUI();
    }
  });

  // Last run time
  // Wake the service worker so chrome://extensions shows it as active while
  // the popup is open (MV3 workers go inactive after ~30s of idle — normal).
  chrome.runtime.sendMessage({ action: 'getState' }, () => {
    if (chrome.runtime.lastError) { /* cold start — ignore */ }
  });

  await loadSettings();
  await refreshUI();
  showVersion();
  const { lastRunTime } = await chrome.storage.local.get('lastRunTime');
  if (lastRunTime) {
    $('last-run').textContent = `Last run: ${new Date(lastRunTime).toLocaleString()}`;
  }
});
