// Step 1: eRank Keyword Research Workflow
// Picks unprocessed seed keywords, navigates to eRank, extracts & filters keywords, writes to sheets
//
// 2026-04-17: Freshness mechanism fix — keywords already in DB are no longer
// silently dropped as "duplicate". Instead they go through the same qualification
// filter (based on today's eRank numbers) and are split into two buckets:
//   - newKeywords   → full INSERT (status='pending', created_at=now)
//   - refreshKeywords → PATCH of avg_searches/competition/click_rate only.
//                       MariaDB's ON UPDATE CURRENT_TIMESTAMP bumps updated_at,
//                       which is exactly what the Step 2 gate's freshness filter
//                       (since_hours + updated_at) relies on. status is NOT sent
//                       on the PATCH so Step 2's prior qualified/unqualified
//                       verdict is preserved until Step 2 re-evaluates.

export async function runErankKeywordResearch(sheetsClient, tabId, config, log, seedKeyword, shouldStop) {
  // shouldStop is a function that returns true if the user pressed Stop
  if (!shouldStop) shouldStop = () => false;
  const started = new Date().toISOString();
  let seedsProcessed = 0, newKeywordsFound = 0, refreshedCount = 0, suggestionsCollected = 0;

  try {
    // Also read config from sheet to get latest thresholds
    let sheetConfig;
    try {
      sheetConfig = await sheetsClient.readConfig();
    } catch (e) {
      log('warn', 'Could not read sheet config, using local config');
      sheetConfig = {};
    }

    // Config priority: popup settings (config) > sheet config > hardcoded defaults
    // 2026-04-18: nullish-aware so explicit 0/"" from popup don't fall through.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = sheetConfig != null ? sheetConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };

    const minSearches = cfg('min_monthly_searches', 450);
    const maxCompetition = cfg('max_competition', 25000);
    const minWordCount = config.min_word_count ?? sheetConfig.min_word_count ?? 1;
    // 2026-05-01: when false (default), trust eRank's relevance — accept any
    // suggestion that clears the numeric filters even if it shares no word with
    // the seed (e.g. seed "sonny angel" → eRank also returns "blind box figure",
    // "kawaii doll", which are still topical). Set true to re-enable the
    // legacy "must contain a seed word" check.
    const enforceSeedRelevance = !!(config.enforce_seed_relevance ?? sheetConfig.enforce_seed_relevance ?? false);
    const maxKeywords = cfg('max_keywords_per_run', 20);
    // eRank pagination delay is hardcoded to 3s — eRank's table loads quickly via Vue
    // and the configurable `delay_between_pages_sec` is for Etsy search / audit pacing only.
    const delay = 3000;

    log('info', `⚙️ Config loaded — minSearches: ${minSearches}, maxComp: ${maxCompetition}, minWords: ${minWordCount}`);
    log('info', `🌱 Seed keyword: "${seedKeyword}" — let's see what eRank has for us`);

    // Read seed_keywords to find or create this seed
    log('info', `📋 Checking if "${seedKeyword}" is already in our seed list...`);
    const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');
    let seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());

    if (!seed) {
      // New seed — add it to the sheet
      const nextSeedId = await sheetsClient.getNextId('seed_keywords', 'seed_id');
      const now = new Date().toISOString();
      await sheetsClient.appendRows('seed_keywords', [[
        nextSeedId, seedKeyword, 'manual', '', '', 1, 0, '', '', 0, now, ''
      ]]);
      seed = { seed_id: String(nextSeedId), keyword: seedKeyword, category: '', product_type: '', times_searched: '0', exhaustion_count: '0', is_exhausted: '' };
      log('info', `🆕 Fresh seed planted! "${seedKeyword}" → ID #${nextSeedId}`);
    } else {
      log('info', `👋 Welcome back! Seed "${seedKeyword}" found (ID #${seed.seed_id}, searched ${seed.times_searched || 0} times before)`);
    }

    // Only process this one seed
    const selectedSeeds = [seed];
    log('info', `🎯 Locked on target: "${seedKeyword}" — time to mine some keywords`);

    // Read existing etsy_keywords — we need keyword_id so we can refresh rather
    // than silently drop rediscovered keywords. Map is keyed by lowercased
    // keyword text so lookups match the dedup pattern used below.
    log('info', `🔍 Loading existing keywords for freshness-aware refresh...`);
    // 2026-04-22: scope to this seed. Previously loaded the entire shared
    // keywords table every Step 1 run (grows unbounded across all users).
    const { rows: existingKeywords } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seed.seed_id });
    const existingKwMap = new Map();
    for (const k of existingKeywords) {
      const kw = (k.keyword || '').toLowerCase().trim();
      if (kw) existingKwMap.set(kw, k);
    }
    log('info', `📚 ${existingKwMap.size} keywords already in the database — rediscoveries will be refreshed with today's eRank numbers`);

    // Process each seed
    for (const seed of selectedSeeds) {
      try {
        const keyword = seed.keyword.trim();

        // Manual-tab mode: if user has an eRank keyword-tool tab already open with this
        // seed and pre-filtered the way they want, use that instead of opening a new one.
        // When this falls back (no match), flow is identical to the original behavior.
        const useManualTab = !!cfg('use_manual_erank_tab', false);
        let activeTabId = tabId;
        let manualTabActive = false;
        log('info', `🔧 Manual-tab setting: ${useManualTab ? 'ON' : 'OFF'} (cfg.use_manual_erank_tab=${JSON.stringify(cfg('use_manual_erank_tab', false))})`);
        if (useManualTab) {
          try {
            const tabs = await chrome.tabs.query({ url: 'https://members.erank.com/keyword-tool*' });
            log('info', `🔍 Manual-tab scan: found ${tabs.length} eRank keyword-tool tab(s) open`);
            if (tabs.length) {
              tabs.forEach((t, i) => {
                try {
                  const u = new URL(t.url);
                  const kw = (u.searchParams.get('keyword') || '').trim();
                  log('info', `   • tab[${i}] id=${t.id} keyword="${kw}" url=${t.url.substring(0, 120)}`);
                } catch {
                  log('info', `   • tab[${i}] id=${t.id} (bad URL)`);
                }
              });
            }
            const match = tabs.find(t => {
              try {
                const u = new URL(t.url);
                const kw = (u.searchParams.get('keyword') || '').toLowerCase().trim();
                return kw === keyword.toLowerCase();
              } catch { return false; }
            });
            if (match) {
              activeTabId = match.id;
              manualTabActive = true;
              log('info', `🎯 Manual tab mode: using your pre-filtered eRank tab (tabId=${match.id}) for "${keyword}"`);
              // Re-inject content script — user's tab may still have the OLD injected
              // script from a previous extension version, or none at all if extension
              // was reloaded after tab was opened.
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: match.id },
                  files: ['src/content-scripts/erank-keyword-extractor.js'],
                });
                log('info', `💉 Content script injected into manual tab`);
                await sleep(500);
              } catch (injErr) {
                log('warn', `⚠️ Could not inject content script (${injErr.message}) — scraping may fail; try reloading the eRank tab`);
              }
            } else {
              log('warn', `⚠️ Manual tab mode ON but no open eRank tab matches "${keyword}" (lowercase match) — falling back to auto mode`);
            }
          } catch (e) {
            log('warn', `⚠️ Manual tab lookup failed: ${e.message} — falling back to auto mode`);
          }
        }

        log('info', `🚀 Launching eRank keyword tool for "${keyword}"...`);

        // Navigate to eRank keyword tool (skip if manual tab is being used)
        if (!manualTabActive) {
          const url = `https://members.erank.com/keyword-tool?keyword=${encodeURIComponent(keyword)}&country=GLO&source=etsy`;
          await navigateTab(tabId, url);
          log('info', `⏳ Waiting for eRank to load... patience is a virtue`);
          await sleep(delay);
        } else {
          log('info', `⏩ Skipping nav + filter-apply — using your existing tab as-is`);
          await sleep(500); // brief settle
        }

        // Extract main keyword data
        log('info', `📊 Extracting main metrics for "${keyword}"...`);
        let mainData;
        try {
          mainData = await sendToTab(activeTabId, { action: 'extractKeywordData' });
          if (mainData.success) {
            const m = mainData.data.mainMetrics;
            log('info', `📈 "${keyword}" stats → Searches: ${m.avg_searches || '?'}, Competition: ${m.competition || '?'}, Click rate: ${m.click_rate || '?'}%`);
          }
        } catch (e) {
          log('warn', `⚠️ Could not extract main data for "${keyword}": ${e.message}`);
          mainData = { success: false, data: { mainMetrics: {}, countryData: {} } };
        }

        log('info', `🔧 Criteria: searches ≥ ${minSearches}, competition ≤ ${maxCompetition}, relevance: ${enforceSeedRelevance ? 'must contain seed word' : 'trust eRank'}`);

        let allSuggestions = [];
        let qualifying = [];
        let stoppedByUser = false;
        let extractionMethod = 'unknown';

        // ─── PRIMARY METHOD: DOM table scraping with pagination ───
        // Note: Clipboard interception was attempted but doesn't work in Chrome MV3
        // (CSP blocks inline scripts, content script isolation prevents monkey-patching,
        // and clipboard.readText fails without document focus). DOM scraping is reliable.
        {
          // Wait for the keyword table to finish rendering before scraping.
          // eRank's Vue SPA loads the main metrics first, then populates the
          // suggestion table asynchronously — scraping too early returns 0 rows.
          log('info', `⏳ Waiting for keyword suggestion table to load (up to 60s)...`);
          try {
            const tableStatus = await sendToTab(activeTabId, { action: 'waitForKeywordTable' }, 65000);
            if (tableStatus.ready) {
              log('info', `✅ Table loaded: ${tableStatus.rowCount} rows visible (took ${tableStatus.polls} polls)`);
            } else if (tableStatus.timeout) {
              log('warn', `⚠️ Table wait timed out — only ${tableStatus.rowCount} rows visible after ${tableStatus.polls} polls`);
              if (tableStatus.diagnostics?.length) {
                log('warn', `   Diagnostic: ${tableStatus.diagnostics.slice(-5).join(' || ')}`);
              }
            }
          } catch (waitErr) {
            log('warn', `⚠️ Table wait failed: ${waitErr.message} — proceeding anyway`);
          }

          // 2026-08-08: raised 10 → 25. eRank now returns 100 rows per page, and
          // real seeds run long: "bridal dress" = 1,477 keywords (15 pages),
          // "wedding veil" = 1,314 (14). At the old cap of 10 we truncated every
          // broad seed mid-way. 25 pages x 100 rows covers ~2,500 keywords, which
          // clears the seeds seen in production. The message below uses the
          // constant so the two can't drift apart again.
          // Cost is bounded in practice: the early-stop below exits as soon as a
          // page yields 0 new keywords, so narrow seeds still finish in 1-2 pages
          // and only genuinely deep seeds pay for the extra pagination.
          const maxPages = 25;
          log('info', `🔄 Scraping keyword table from DOM (up to ${maxPages} pages)...`);
          extractionMethod = 'domScraping';
          let page = 1;
          let consecutiveEmptyPages = 0;

          while (page <= maxPages) {
            if (shouldStop()) {
              log('warn', `🛑 Stop requested — halting at page ${page}`);
              stoppedByUser = true;
              break;
            }

            // Extract with retries — slow SPA hydration can return 0 rows first attempt
            let result = await sendToTab(activeTabId, { action: 'extractKeywordSuggestions' }, 60000);

            // Surface column-mapping aborts (manual-tab mode with a customised
            // eRank column layout) immediately — retrying won't help.
            if (result && result.success === false && result.error &&
                /column layout not recognized/i.test(result.error)) {
              log('error', `⛔ ${result.error}`);
              throw new Error(result.error);
            }

            if ((!result.success || result.suggestions.length === 0) && page === 1) {
              for (let attempt = 1; attempt <= 3; attempt++) {
                log('warn', `🔁 Page 1 returned ${result.suggestions?.length || 0} rows — retry ${attempt}/3 after 5s`);
                await sleep(5000);
                result = await sendToTab(activeTabId, { action: 'extractKeywordSuggestions' }, 60000);
                if (result.success && result.suggestions.length > 0) {
                  log('info', `✅ Retry ${attempt} succeeded with ${result.suggestions.length} rows`);
                  break;
                }
              }
            }
            if (result.success && result.suggestions.length > 0) {
              // Deduplicate across pages (in case same rows appear on multiple pages)
              const seenKeywords = new Set(allSuggestions.map(s => (s.keyword || '').toLowerCase().trim()));
              const newSuggestions = result.suggestions.filter(s => {
                const kw = (s.keyword || '').toLowerCase().trim();
                if (seenKeywords.has(kw)) return false;
                seenKeywords.add(kw);
                return true;
              });
              const dupeCount = result.suggestions.length - newSuggestions.length;
              allSuggestions = allSuggestions.concat(newSuggestions);
              log('info', `📄 Page ${page}: ${result.suggestions.length} scraped, ${newSuggestions.length} new (${allSuggestions.length} total)${dupeCount > 0 ? ` [${dupeCount} cross-page dupes skipped]` : ''}`);

              // 2026-08-08: surface eRank's paginator state on page 1. Previously this
              // only went to the page console, so when eRank started rendering the
              // pagination bar AFTER the rows, Step 1 silently captured 100 of 1,314
              // keywords and every pipeline NO-GO'd with no clue why. Now the run log
              // shows the totals, and warns loudly if the bar still can't be found.
              if (page === 1) {
                if (result.paginatorFound && result.totalItems > 0) {
                  const totalPages = Math.ceil(result.totalItems / Math.max(result.suggestions.length, 1));
                  log('info', `🔢 eRank reports ${result.totalItems.toLocaleString()} keywords (~${totalPages} page(s)); this run will read up to ${maxPages}`);
                } else {
                  log('warn', `⚠️ eRank pagination bar not detected — treating this as a single page. If eRank has more results, they will be missed (this is the symptom of an eRank layout change).`);
                }
              }

              // Early stop: if a page returns 0 NEW keywords (all dupes from prior pages),
              // stop paginating — eRank is just recycling rows. Gated to page >= 2 so a
              // slow-loading first page can't accidentally kill the run.
              if (page >= 2 && newSuggestions.length === 0) {
                log('info', `⏭️ Page ${page} had 0 new keywords (all duplicates) — early stop`);
                break;
              }
            } else {
              log('info', `📄 Page ${page}: no suggestions found — table may not have updated`);
              // Only stop if the page truly had no rows (not just filtered out)
              consecutiveEmptyPages++;
              if (consecutiveEmptyPages >= 2) break;
            }

            // Navigate to next page if there are more
            if (result.hasMore && page < maxPages) {
              log('info', `➡️ Navigating to page ${page + 1}...`);
              try {
                await sendToTab(activeTabId, { action: 'goToNextPage' });
              } catch (e) {
                log('warn', `⚠️ goToNextPage failed: ${e.message} — stopping pagination, will save what we have`);
                break;
              }
              // Don't update hasMore here — let the next extraction determine it.
              // goToNextPage returning hasMore=false on the last page would skip extraction.
              page++;
              // Wait for the new page's table rows to render
              await sleep(Math.max(delay, 3000));
              // Wait for the next page's table, with recovery.
              // 2026-08-08: one bad page used to end pagination for the entire
              // seed. Verified on "bridal dress" (1,477 keywords / 15 pages):
              // the run died at page 4 with "sendToTab timeout after 65000ms",
              // keeping only 300 of 1,477. That matters because eRank orders
              // suggestions by RELEVANCE, not volume — the high-volume keywords
              // ("corset wedding dress" 4,268, "hochzeit" 5,463) sit on later
              // pages and were confirmed present in the default dataset.
              // Two distinct failures happen here and BOTH must be survivable:
              //   (a) the content script replies but the table isn't ready;
              //   (b) the content script doesn't reply at all — its own 58s
              //       safety timer never fired, i.e. the script died with the
              //       page re-render, so sendToTab hits its 65s timeout.
              // (b) can't be fixed by waiting, so re-inject the content script
              // before the retry. Only the second consecutive failure gives up.
              let tableReady = null;
              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  tableReady = await sendToTab(activeTabId, { action: 'waitForKeywordTable' }, 65000);
                } catch (e) {
                  log('warn', `⚠️ Page ${page} wait failed (attempt ${attempt}/2): ${e.message}`);
                  tableReady = null;
                }
                if (tableReady && tableReady.ready) break;
                if (attempt === 1) {
                  log('warn', `⚠️ Page ${page} not ready — re-injecting content script and retrying once...`);
                  try {
                    await chrome.scripting.executeScript({
                      target: { tabId: activeTabId },
                      files: ['src/content-scripts/erank-keyword-extractor.js'],
                    });
                  } catch (injErr) {
                    log('warn', `⚠️ Re-inject failed: ${injErr.message}`);
                  }
                  await sleep(5000);
                }
              }
              if (tableReady && tableReady.ready) {
                log('info', `✅ Page ${page} table ready (${tableReady.rowCount} rows, ${tableReady.polls} polls)`);
              } else {
                log('warn', `⚠️ Page ${page} unrecoverable — stopping pagination with ${allSuggestions.length} keywords captured so far`);
                break;
              }
            } else {
              break;
            }
          }

          log('info', `📖 DOM scraping done: ${allSuggestions.length} keywords across ${page} page(s)`);
        }

        if (stoppedByUser) {
          log('warn', `⏹️ Stopped by user — saving what we have so far`);
        }

        // ─── Apply software filter to ALL collected suggestions ───
        // Seed words for relevance check — keyword must contain at least one seed word
        // e.g., seed "doctor" → "plague doctor" ✅, "glasses chain" ❌
        const seedWordsLower = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        // ─── Apply software filter with detailed rejection tracking ───
        // 2026-04-17: `duplicate` is no longer a rejection reason. Keywords
        // already in the DB still have to clear every other filter based on
        // TODAY'S eRank numbers; if they pass, they get refreshed (not dropped).
        const rejectReasons = {
          junk: 0, tooLong: 0, noData: 0, format: 0,
          wordCount: 0, irrelevant: 0, lowSearches: 0,
          highComp: 0, isSeed: 0
        };

        qualifying = allSuggestions.filter(s => {
          const searches = parseInt(s.avg_searches) || 0;
          const comp = parseInt(s.competition) || 0;
          const kw = (s.keyword || '').trim();
          const wordCount = kw.split(/\s+/).length;
          const kwLower = kw.toLowerCase();

          // Skip junk
          if (!kw || kw.length < 3) { rejectReasons.junk++; return false; }
          if (kw.length > 60) { rejectReasons.tooLong++; return false; }
          if (searches === 0 && comp === 0) { rejectReasons.noData++; return false; }
          if (/^["'\u201c]/.test(kw)) { rejectReasons.format++; return false; }
          if (/:\s+/.test(kw)) { rejectReasons.format++; return false; }
          if (/\(\d+\)\s*$/.test(kw) && wordCount <= 2) { rejectReasons.format++; return false; }
          if (/appears\s+\d+\s+times/i.test(kw)) { rejectReasons.format++; return false; }

          // Min word count filter (configurable via settings)
          if (minWordCount > 1 && wordCount < minWordCount) { rejectReasons.wordCount++; return false; }

          // Relevance: only enforced when user explicitly opts in via
          // enforce_seed_relevance. Default (off) trusts eRank's own relevance —
          // suggestions are accepted as long as they pass numeric filters.
          if (enforceSeedRelevance && seedWordsLower.length > 0) {
            const relevant = seedWordsLower.some(sw => kwLower.includes(sw));
            if (!relevant) { rejectReasons.irrelevant++; return false; }
          }

          if (kwLower === keyword.toLowerCase()) { rejectReasons.isSeed++; return false; }
          if (searches < minSearches) { rejectReasons.lowSearches++; return false; }
          if (comp > maxCompetition) { rejectReasons.highComp++; return false; }

          return true;
        });

        // Log detailed filter breakdown so user knows exactly what happened
        const reasons = Object.entries(rejectReasons).filter(([,v]) => v > 0).map(([k,v]) => `${k}: ${v}`).join(', ');
        log('info', `🏆 Total: ${allSuggestions.length} suggestions (via ${extractionMethod}), ${qualifying.length} qualify after filtering`);
        if (reasons) log('info', `📊 Filter breakdown — rejected: ${reasons}`);

        // Diagnostic — when 0 keywords qualify and >=80% of rejects are
        // lowSearches/highComp, dump a sample of what the extractor actually
        // returned. This catches silent column-mismatch bugs where headers
        // map fine but the parsed numbers come from the wrong cells.
        if (qualifying.length === 0 && allSuggestions.length >= 5) {
          const numericRejects = rejectReasons.lowSearches + rejectReasons.highComp;
          const sample = allSuggestions.slice(0, 3).map(s =>
            `"${s.keyword}" searches=${s.avg_searches} comp=${s.competition} ctr=${s.click_rate}`
          ).join(' | ');
          log('warn', `🔎 Sample of scraped rows (for column-mapping check): ${sample}`);
          if (numericRejects / allSuggestions.length >= 0.8) {
            log('warn', `⚠️ Most rows rejected on numeric thresholds — if those values look wrong vs your eRank UI, the extractor may be reading the wrong column. Reset eRank columns to default and retry.`);
          }
        }
        suggestionsCollected += allSuggestions.length;

        // Also check if the seed keyword itself qualifies. Unlike before, we
        // don't skip a seed that's already in the DB — it just gets refreshed
        // below instead of re-inserted.
        const seedMetrics = mainData.success ? mainData.data.mainMetrics : {};
        const seedLower = keyword.toLowerCase();
        const seedExisting = existingKwMap.get(seedLower) || null;
        const seedQualifies = (seedMetrics.avg_searches || 0) >= minSearches &&
                              (seedMetrics.competition || 0) <= maxCompetition;

        // ─── Split qualifying into NEW (insert) vs REFRESH (patch metrics) ───
        // Keywords already in DB keep their row identity, status, snapshot_count,
        // created_at — we only update metrics + let MariaDB bump updated_at.
        const newSuggestions = [];
        const refreshSuggestions = []; // { existing, suggestion }
        for (const q of qualifying) {
          const qLower = q.keyword.toLowerCase().trim();
          const existing = existingKwMap.get(qLower);
          if (existing) {
            refreshSuggestions.push({ existing, suggestion: q });
          } else {
            newSuggestions.push(q);
          }
        }

        // ─── Metrics-only update for over-threshold existing keywords ───
        // Keywords rejected ONLY by highComp (competition > maxCompetition) but
        // already in the DB get their avg_searches + competition updated so the
        // DB has accurate data, even though they don't enter the qualifying pool.
        // This fixes the long-standing NULL competition issue for popular seeds
        // where eRank initially returned 0 (inserted), then later showed real high values.
        const metricsOnlyRows = [];
        for (const s of allSuggestions) {
          const comp = parseInt(s.competition) || 0;
          if (comp <= maxCompetition) continue; // already handled by qualifying path
          const qLower = (s.keyword || '').toLowerCase().trim();
          const existing = existingKwMap.get(qLower);
          if (!existing) continue; // not in DB, don't insert over-threshold keywords
          metricsOnlyRows.push({
            seed_id: seed.seed_id,
            keyword: s.keyword.trim(),
            avg_searches: s.avg_searches != null ? s.avg_searches : '',
            competition: s.competition != null ? s.competition : '',
            click_rate: s.click_rate != null ? s.click_rate : '',
          });
        }

        // Write qualifying keywords to etsy_keywords
        let nextKwId = await sheetsClient.getNextId('etsy_keywords', 'keyword_id');
        const kwRows = [];
        const now = new Date().toISOString();

        // Get seed's category and product_type
        const seedCategory = seed.category || '';
        const seedProductType = seed.product_type || '';

        // Seed keyword — INSERT only if qualifying AND not already in DB
        if (seedQualifies && !seedExisting) {
          // 18 columns: keyword_id, seed_id, keyword, product_type, category, avg_searches,
          // competition, click_rate, trend, score, status, snapshot_count, last_snapshot_at,
          // trend_velocity, peak_month, optimal_list_date, search_by_country, created_at
          kwRows.push([
            nextKwId, seed.seed_id, keyword, seedProductType, seedCategory,
            seedMetrics.avg_searches != null ? seedMetrics.avg_searches : '',
            seedMetrics.competition != null ? seedMetrics.competition : '',
            seedMetrics.click_rate != null ? seedMetrics.click_rate : '',
            '', '', 'pending', 0, '',
            '', '', '',
            JSON.stringify(mainData.success ? mainData.data.countryData : {}), now
          ]);
          existingKwMap.set(seedLower, { keyword_id: nextKwId, keyword, status: 'pending' });
          nextKwId++;
          newKeywordsFound++;
        }

        for (const q of newSuggestions) {
          kwRows.push([
            nextKwId, seed.seed_id, q.keyword.trim(), seedProductType, seedCategory,
            q.avg_searches != null ? q.avg_searches : '',
            q.competition != null ? q.competition : '',
            q.click_rate != null ? q.click_rate : '',
            '', '', 'pending', 0, '',
            '', '', '', '', now
          ]);
          existingKwMap.set(q.keyword.toLowerCase().trim(), { keyword_id: nextKwId, keyword: q.keyword, status: 'pending' });
          nextKwId++;
          newKeywordsFound++;
        }

        if (kwRows.length > 0) {
          await sheetsClient.appendRows('etsy_keywords', kwRows);
          log('success', `✍️ Saved ${kwRows.length} brand-new keyword(s) to the database`);
        }

        // ─── Refresh existing keywords with today's eRank numbers ───
        // Route through appendRowsByName (→ Worker's handleKeywordsInsert) rather
        // than a generic PATCH. Two reasons:
        //   1. The handler does `INSERT ... ON DUPLICATE KEY UPDATE` keyed on
        //      the keyword text unique index. Our payload deliberately omits
        //      `status`, so MariaDB refreshes only the metric columns (+ auto-
        //      bumps updated_at), preserving whatever verdict Step 2 set earlier.
        //   2. The handler ALSO writes a (seed_id, keyword_id) row to
        //      pro_etsy_res_seed_keyword_map on every call (idempotent via
        //      ON DUPLICATE KEY UPDATE). So a keyword first discovered under
        //      seed "nurse" that we're rediscovering today under "doctor" gets
        //      its junction link to "doctor" added — the gate's seed-scoped
        //      JOIN will now see it.
        const refreshRows = [];
        if (seedQualifies && seedExisting) {
          const row = {
            seed_id: seed.seed_id,
            keyword,
            avg_searches: seedMetrics.avg_searches != null ? seedMetrics.avg_searches : '',
            competition: seedMetrics.competition != null ? seedMetrics.competition : '',
            click_rate: seedMetrics.click_rate != null ? seedMetrics.click_rate : '',
          };
          if (mainData.success && mainData.data.countryData) {
            row.search_by_country = JSON.stringify(mainData.data.countryData);
          }
          refreshRows.push(row);
        }
        for (const { suggestion } of refreshSuggestions) {
          refreshRows.push({
            seed_id: seed.seed_id,
            keyword: suggestion.keyword.trim(),
            avg_searches: suggestion.avg_searches != null ? suggestion.avg_searches : '',
            // Use explicit null check so competition=0 (valid eRank value) is stored
            // as 0, not coerced to empty string which MariaDB stores as NULL.
            competition: suggestion.competition != null ? suggestion.competition : '',
            click_rate: suggestion.click_rate != null ? suggestion.click_rate : '',
          });
        }

        let seedRunRefreshed = 0;
        if (refreshRows.length > 0) {
          log('info', `🔄 Refreshing ${refreshRows.length} existing keyword(s) with today's eRank metrics + ensuring junction link to this seed...`);
          try {
            const result = await sheetsClient.appendRowsByName('etsy_keywords', refreshRows);
            // handleKeywordsInsert returns { inserted, updated, junction_rows, failed }.
            // For refresh rows we expect `updated` to dominate; any `inserted` would
            // mean the keyword text didn't match an existing unique-key row (unlikely
            // since we only built refreshRows from existingKwMap hits, but safe).
            const refreshOk = (result && (result.updated || 0) + (result.inserted || 0)) || 0;
            const junctionsWritten = (result && result.junction_rows) || 0;
            const refreshFail = (result && result.failed) || 0;
            seedRunRefreshed = refreshOk;
            refreshedCount += refreshOk;
            if (refreshFail === 0) {
              log('success', `🔄 Refreshed ${refreshOk} existing keyword(s) — metrics + updated_at bumped, ${junctionsWritten} junction link(s) ensured`);
            } else {
              log('warn', `🔄 Refreshed ${refreshOk}/${refreshRows.length} existing keyword(s) (${refreshFail} failed). Junction links: ${junctionsWritten}`);
            }
          } catch (e) {
            log('warn', `⚠️ Bulk refresh failed: ${e && e.message || 'unknown'}`);
          }
        }

        // Write metrics-only updates for over-threshold keywords (best-effort, non-blocking)
        if (metricsOnlyRows.length > 0) {
          try {
            await sheetsClient.appendRowsByName('etsy_keywords', metricsOnlyRows);
            log('info', `📊 Updated metrics for ${metricsOnlyRows.length} over-threshold keyword(s) in DB`);
          } catch (e) {
            log('warn', `⚠️ Metrics-only update failed (non-critical): ${e && e.message || 'unknown'}`);
          }
        }

        const totalUsableThisRun = kwRows.length + seedRunRefreshed;
        if (totalUsableThisRun === 0) {
          log('info', `😅 No new or refreshable qualifying keywords this time — the niche might be well-explored or filters may be too tight`);
        }

        // Write ALL suggestions to keyword_suggestions
        let nextSugId = await sheetsClient.getNextId('keyword_suggestions', 'suggestion_id');
        // Use the first newly-inserted keyword ID, or fall back to an existing keyword for this seed.
        // Post-m2m migration: existingKeywords is a global dedup read (no seed_id
        // on rows), so we do a seed-scoped lookup via the Worker's JOIN translation.
        let parentKwId = kwRows.length > 0 ? kwRows[0][0] : null;
        if (!parentKwId) {
          try {
            const { rows: seedKws } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seed.seed_id });
            if (seedKws && seedKws.length > 0) {
              parentKwId = seedKws[0].keyword_id;
            }
          } catch (_) { /* fall through with null */ }
        }
        const sugRows = allSuggestions.map(s => {
          const promoted = qualifying.some(q => q.keyword.toLowerCase().trim() === (s.keyword || '').toLowerCase().trim());
          return [
            nextSugId++, parentKwId, s.keyword || '',
            s.avg_searches != null ? s.avg_searches : '',
            s.competition != null ? s.competition : '',
            s.click_rate != null ? s.click_rate : '',
            '', promoted ? 'TRUE' : 'FALSE', now
          ];
        });

        // Issue 2: Only write keyword_suggestions if at least one keyword qualified
        // (either the seed itself or one of the suggestions). On a dead-end run
        // archiving 700+ junk rows wastes minutes and pollutes the DB.
        const haveAnythingQualified = (kwRows.length > 0);
        if (!haveAnythingQualified) {
          log('info', `⏭️ Skipping ${sugRows.length} raw suggestion writes — no qualifying keywords for "${keyword}", not worth archiving`);
        } else if (sugRows.length > 0 && parentKwId && !shouldStop()) {
          // Background fire-and-forget: split into 100-row chunks and write
          // them SERIALLY (one at a time) on a detached promise so Step 1 can
          // return immediately and Step 2 starts. Suggestions are an archive
          // table — nothing downstream depends on them being written before
          // the next step. Serial avoids the parallel-connection bug we hit
          // on 2026-04-07 where Promise.allSettled never resolved against
          // cPanel MariaDB's connection limit.
          const CHUNK = 100;
          const chunks = [];
          for (let i = 0; i < sugRows.length; i += CHUNK) {
            chunks.push(sugRows.slice(i, i + CHUNK));
          }
          log('info', `💾 Queued ${sugRows.length} raw suggestions for background write (${chunks.length} serial chunks of ${CHUNK}) — Step 1 will continue`);

          // Detached async — note no `await`. Errors are logged, never thrown.
          (async () => {
            let ok = 0, fail = 0;
            for (let i = 0; i < chunks.length; i++) {
              try {
                await sheetsClient.appendRows('keyword_suggestions', chunks[i]);
                ok++;
              } catch (e) {
                fail++;
                log('warn', `⚠️ [bg] suggestion chunk ${i+1}/${chunks.length} failed: ${e && e.message || 'unknown'}`);
              }
            }
            if (fail === 0) {
              log('success', `📝 [bg] All ${chunks.length} suggestion chunks archived for "${keyword}" (${sugRows.length} rows)`);
            } else {
              log('warn', `📝 [bg] ${ok}/${chunks.length} suggestion chunks archived for "${keyword}" — ${fail} failed`);
            }
          })().catch(e => log('warn', `⚠️ [bg] suggestion write task crashed: ${e && e.message}`));
        }

        // Update seed_keywords
        const timesSearched = (parseInt(seed.times_searched) || 0) + 1;
        const exhaustionCount = qualifying.length === 0 ? (parseInt(seed.exhaustion_count) || 0) + 1 : 0;
        const isExhausted = exhaustionCount >= 3 ? 'TRUE' : '';

        await sheetsClient.updateRowByMatch('seed_keywords', 'seed_id', seed.seed_id, {
          times_searched: timesSearched,
          last_searched_at: now,
          exhaustion_count: exhaustionCount,
          is_exhausted: isExhausted
        });

        seedsProcessed++;
        log('success', `🎉 Seed "${keyword}" complete! ${kwRows.length} new + ${seedRunRefreshed} refreshed = ${totalUsableThisRun} usable keyword(s) this run, ${sugRows.length} raw suggestions archived`);

      } catch (err) {
        log('error', `Error processing seed "${seed.keyword}": ${err.message}`);
      }
    }

    // Log run
    await sheetsClient.logRun('erank_keyword_research',
      seedsProcessed > 0 ? 'SUCCESS' : 'FAILED',
      seedsProcessed, newKeywordsFound + refreshedCount, 0, '',
      `Seeds: ${seedsProcessed}, New keywords: ${newKeywordsFound}, Refreshed: ${refreshedCount}, Suggestions: ${suggestionsCollected}`
    );

    // Be explicit about what happened so the user doesn't think 0-new = failure.
    // Refreshed keywords are just as "usable" for Step 2 as new ones — their
    // updated_at is now fresh, so the gate will see them.
    const totalUsable = newKeywordsFound + refreshedCount;
    if (totalUsable > 0) {
      log('success', `🏁 Step 1 DONE! ${seedsProcessed} seed processed → ${newKeywordsFound} new + ${refreshedCount} refreshed = ${totalUsable} usable keyword(s), ${suggestionsCollected} raw suggestions inspected`);
    } else {
      log('warn', `🏁 Step 1 DONE! ${seedsProcessed} seed processed → 0 usable keywords (${suggestionsCollected} raw suggestions inspected, all filtered out or non-qualifying on refresh)`);
    }
    return { seedsProcessed, newKeywordsFound, refreshedCount, suggestionsCollected };

  } catch (err) {
    log('error', `Step 1 failed: ${err.message}`);
    await sheetsClient.logRun('erank_keyword_research', 'FAILED', seedsProcessed, newKeywordsFound, 0, err.message, '');
    throw err;
  }
}

// Helper: navigate a tab
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      // Wait for page load
      const listener = (tId, changeInfo) => {
        if (tId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 30s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
  });
}

// Helper: send message to content script with a timeout.
// Without a timeout, a vanished/replaced content script can hang the
// workflow forever — chrome.runtime.lastError only fires if no listener
// existed at send time, not if a listener disappears mid-call.
function sendToTab(tabId, message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`sendToTab timeout after ${timeoutMs}ms (action: ${message && message.action})`));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || {});
        }
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
