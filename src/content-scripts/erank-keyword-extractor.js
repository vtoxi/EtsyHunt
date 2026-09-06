// eRank Keyword Extractor — Content Script
// Runs on: https://members.erank.com/*

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'checkErankLogin') {
      handleCheckLogin(sendResponse);
      return true;
    }
    if (msg.action === 'extractKeywordData') {
      handleExtractKeywordData(sendResponse);
      return true;
    }
    if (msg.action === 'extractKeywordSuggestions') {
      handleExtractSuggestions(sendResponse);
      return true;
    }
    if (msg.action === 'extractViaCopyAll') {
      handleExtractViaCopyAll(sendResponse);
      return true;
    }
    if (msg.action === 'waitForKeywordTable') {
      handleWaitForKeywordTable(sendResponse);
      return true;
    }
    if (msg.action === 'applyFilters') {
      handleApplyFilters(msg, sendResponse);
      return true;
    }
    if (msg.action === 'goToNextPage') {
      handleNextPage(sendResponse);
      return true;
    }
  });

  function handleCheckLogin(sendResponse) {
    // Check for login form vs keyword tool interface
    const loginForm = document.querySelector('form[action*="login"], input[name="email"], .login-form, #login-form');
    const keywordTool = document.querySelector('.keyword-tool, #keyword-tool, .search-bar, input[name="keyword"], [class*="KeywordTool"]');

    // Also check page text for common indicators
    const bodyText = document.body.innerText.toLowerCase();
    const hasLoginIndicators = bodyText.includes('sign in') && bodyText.includes('password') && !bodyText.includes('keyword explorer');
    const hasToolIndicators = bodyText.includes('avg searches') || bodyText.includes('keyword explorer') || bodyText.includes('etsy competition');

    if (loginForm && !keywordTool) {
      sendResponse({ loggedIn: false });
    } else if (hasLoginIndicators && !hasToolIndicators) {
      sendResponse({ loggedIn: false });
    } else {
      sendResponse({ loggedIn: true });
    }
  }

  function handleExtractKeywordData(sendResponse) {
    try {
      const data = { mainMetrics: {}, countryData: {} };

      // Extract main keyword metrics from the summary card area
      const pageText = document.body.innerText;

      // Look for avg searches
      const searchMatch = pageText.match(/Avg[\s.]*Searches[:\s]*([0-9,]+)/i);
      if (searchMatch) data.mainMetrics.avg_searches = parseInt(searchMatch[1].replace(/,/g, ''));

      // Look for competition
      const compMatch = pageText.match(/(?:Etsy\s+)?Competition[:\s]*([0-9,]+)/i);
      if (compMatch) data.mainMetrics.competition = parseInt(compMatch[1].replace(/,/g, ''));

      // Look for click rate
      const clickMatch = pageText.match(/Click\s*Rate[:\s]*([0-9.]+)%?/i);
      if (clickMatch) data.mainMetrics.click_rate = parseFloat(clickMatch[1]);

      // Try to extract from specific DOM elements (cards, stats sections)
      const statCards = document.querySelectorAll('.stat-card, .metric-card, .summary-card, [class*="stat"], [class*="metric"]');
      statCards.forEach(card => {
        const text = card.innerText;
        if (text.match(/avg.*search/i) && !data.mainMetrics.avg_searches) {
          const num = text.match(/([0-9,]+)/);
          if (num) data.mainMetrics.avg_searches = parseInt(num[1].replace(/,/g, ''));
        }
        if (text.match(/competition/i) && !data.mainMetrics.competition) {
          const num = text.match(/([0-9,]+)/);
          if (num) data.mainMetrics.competition = parseInt(num[1].replace(/,/g, ''));
        }
      });

      // Extract country data from charts or tables
      const countryRows = document.querySelectorAll('[class*="country"], [class*="Country"]');
      countryRows.forEach(row => {
        const text = row.innerText.trim();
        const parts = text.split(/\s+/);
        if (parts.length >= 2) {
          const country = parts[0];
          const value = parts[parts.length - 1].replace(/[^0-9.]/g, '');
          if (country && value) {
            data.countryData[country] = parseFloat(value);
          }
        }
      });

      // Also try to get country data from SVG chart labels
      const chartLabels = document.querySelectorAll('svg text, .chart-label, [class*="chart"] text');
      chartLabels.forEach(label => {
        const text = label.textContent.trim();
        if (text.length > 1 && text.length < 30) {
          // Might be a country name
        }
      });

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }

  // ─── Extract ALL keywords via Export → "Copy to clipboard" ───
  // DISABLED: Clipboard interception doesn't work in Chrome MV3 extensions because:
  // - Content scripts run in an isolated JS world (monkey-patching clipboard doesn't affect page code)
  // - Injecting inline <script> tags is blocked by CSP (no 'unsafe-inline')
  // - clipboard.readText() fails because the extension steals document focus
  //
  // The workflow falls through to DOM table scraping with pagination, which works reliably.
  function handleExtractViaCopyAll(sendResponse) {
    sendResponse({
      success: false,
      error: 'Clipboard method disabled — using DOM scraping instead',
      diagnostics: ['Chrome MV3 CSP + isolated world prevents clipboard interception'],
      suggestions: []
    });
  }

  // ─── Wait for the keyword suggestion table to load ───
  // eRank's Vue SPA loads the main metrics first, then renders the suggestion table
  // asynchronously. This handler polls until the table has visible data rows.
  // The workflow should call this BEFORE extractKeywordSuggestions.
  function handleWaitForKeywordTable(sendResponse) {
    let pollCount = 0;
    let rowsReadyPoll = 0; // poll # at which rows first became visible
    const maxPolls = 120; // 120 × 500ms = 60 seconds max (slow connections)
    const diagnostics = [];
    let responded = false;
    // 2026-08-08: track how many competition cells are resolved between polls so
    // we can stop as soon as the column STOPS filling, rather than always
    // demanding a fixed 60% (see the stability check further down).
    let lastResolvedCount = -1;
    let stableResolvedPolls = 0;

    // Safety: force a response by 58s in case anything throws
    const safetyTimer = setTimeout(() => {
      if (responded) return;
      responded = true;
      try { sendResponse({ ready: false, rowCount: 0, polls: pollCount, timeout: true, diagnostics, reason: 'safety_timer' }); } catch {}
    }, 58000);

    function respondOnce(payload) {
      if (responded) return;
      responded = true;
      clearTimeout(safetyTimer);
      try { sendResponse(payload); } catch {}
    }

    function poll() {
      try {
        pollCount++;
        const tables = document.querySelectorAll('table');
        let bestRowCount = 0;
        let bestTableInfo = '';
        let matchedTables = 0;

        let bestTable = null;
        for (const table of tables) {
          const headerText = (table.querySelector('thead tr:first-child')?.innerText || '').toLowerCase();
          if (!headerText.includes('keyword')) continue;
          matchedTables++;
          const bodyRows = table.querySelectorAll('tbody tr');
          const visibleRows = Array.from(bodyRows).filter(r => r.offsetParent !== null || r.offsetHeight > 0);
          if (visibleRows.length > bestRowCount) {
            bestRowCount = visibleRows.length;
            bestTableInfo = `headers: ${headerText.substring(0, 60)}`;
            bestTable = table;
          }
        }

        // ─── Competition-column resolution check (2026-06-03) ───
        // eRank renders rows with "Unknown" / empty Etsy Competition cells first,
        // then fetches the real values ~6-10s later. Scraping before this resolves
        // stores competition as 0. So once rows are present, also wait until the
        // competition column has resolved (real numbers) before declaring ready.
        // A 20s extra-wait cap (after rows appear) prevents hanging on keywords
        // eRank genuinely can't score (those stay "Unknown" forever).
        let compRatio = 1;       // fraction of sampled comp cells that are resolved
        let compResolved = true; // default true so tables without a comp column don't block
        if (bestTable && bestRowCount >= 3) {
          const headerCells = Array.from(bestTable.querySelectorAll('thead tr:first-child th, thead tr:first-child td'));
          let compIdx = -1;
          headerCells.forEach((h, i) => {
            const ht = (h.innerText || '').toLowerCase().replace(/[↑↓⇅↕]/g, '').trim();
            if (compIdx === -1 && ht.includes('competition')) compIdx = i;
          });
          if (compIdx >= 0) {
            const visRows = Array.from(bestTable.querySelectorAll('tbody tr'))
              .filter(r => r.offsetParent !== null || r.offsetHeight > 0)
              .slice(0, 10);
            let resolved = 0, total = 0;
            for (const r of visRows) {
              const cell = r.querySelectorAll('td')[compIdx];
              const txt = (cell?.innerText || '').trim();
              total++;
              // 2026-08-08: eRank changed its "still loading" placeholder for the
              // Etsy Competition cell from the word "Unknown" to a plain hyphen
              // "-" (verified live: charCode 45). The original test below only
              // rejected '' and 'unknown', so "-" counted as RESOLVED — the
              // extractor declared compRatio=1.00 while most cells were still
              // placeholders, scraped immediately, and stored competition as 0
              // (confirmed against eRank's own CSV: 8,803 and 30,566 both saved
              // as 0). The original two conditions are KEPT and the newly
              // observed placeholders are added alongside them.
              // Note: "-" is ALSO eRank's permanent "no data" value for keywords
              // it can't score (verified: 2 of 10 stayed "-" for 10s+). That's
              // fine — the >=60% threshold plus the 20s cap below still let the
              // scrape proceed instead of hanging.
              const low = txt.toLowerCase();
              const isUnresolved = txt === ''            // original check
                || low === 'unknown'                      // original check
                || low === '-' || low === '--'            // new: eRank loading/no-data
                || low === '–' || low === '—'   // new: en/em dash variants
                || low === 'n/a';                         // new: defensive
              if (!isUnresolved) resolved++;
            }
            compRatio = total > 0 ? resolved / total : 1;

            // 2026-08-08: a fixed 60% bar is wrong for deeper eRank pages, where
            // a large share of keywords have NO competition score at all and stay
            // "-" forever. Measured live on "bridal dress": page 1 settles at 13%
            // dashes (87% resolved → fine), but page 2 settles at 43% dashes
            // (57% resolved) — just under 60%, so every deep page burned the full
            // 20s cap, which is what slowed the run and starved page 6 into a
            // "table not ready" timeout.
            // So: still accept ≥60% immediately (fast path for normal pages), but
            // ALSO accept once the resolved count has STOPPED GROWING for ~2s —
            // i.e. eRank has finished filling whatever it can. Still requires at
            // least one real value, so a fully-unloaded table keeps waiting.
            if (resolved === lastResolvedCount) stableResolvedPolls++;
            else { stableResolvedPolls = 0; lastResolvedCount = resolved; }
            const settled = resolved > 0 && stableResolvedPolls >= 4; // 4 × 500ms
            compResolved = compRatio >= 0.6 || settled;
          }
        }

        // Track when rows first appeared so we can cap the extra competition wait.
        if (bestRowCount >= 3 && rowsReadyPoll === 0) rowsReadyPoll = pollCount;
        const compWaitPolls = rowsReadyPoll > 0 ? (pollCount - rowsReadyPoll) : 0;
        const compWaitExceeded = compWaitPolls >= 40; // 40 × 500ms = 20s extra cap

        // Record diagnostic every 10 polls (every 5s)
        if (pollCount === 1 || pollCount % 10 === 0) {
          diagnostics.push(`poll${pollCount} tables=${tables.length} matched=${matchedTables} bestRows=${bestRowCount} compRatio=${compRatio.toFixed(2)} ready=${document.readyState}`);
        }

        if (bestRowCount >= 3 && (compResolved || compWaitExceeded)) {
          const note = (compWaitExceeded && !compResolved) ? ' (comp wait capped)' : '';
          console.log(`[eRank Extractor] Table ready: ${bestRowCount} rows, compRatio=${compRatio.toFixed(2)}${note} after ${pollCount} polls`);
          respondOnce({ ready: true, rowCount: bestRowCount, polls: pollCount, info: bestTableInfo, compRatio, diagnostics });
        } else if (pollCount >= maxPolls) {
          console.log(`[eRank Extractor] Table wait timeout: ${bestRowCount} rows after ${pollCount} polls`);
          respondOnce({ ready: bestRowCount > 0, rowCount: bestRowCount, polls: pollCount, timeout: true, compRatio, diagnostics });
        } else {
          setTimeout(poll, 500);
        }
      } catch (err) {
        console.error(`[eRank Extractor] Poll error:`, err);
        diagnostics.push(`poll${pollCount} ERROR: ${err.message}`);
        respondOnce({ ready: false, rowCount: 0, polls: pollCount, timeout: true, error: err.message, diagnostics });
      }
    }

    poll();
  }

  // Parse TSV clipboard data into keyword suggestions
  function finishParsing(clipboardText, diagnostics, sendResponse) {
    try {
      if (!clipboardText || clipboardText.length < 20) {
        diagnostics.push('Clipboard data empty or too short');
        sendResponse({ success: false, error: 'No clipboard data', diagnostics, suggestions: [] });
        return;
      }

      const lines = clipboardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length < 2) {
        sendResponse({ success: false, error: 'Clipboard has no data rows', diagnostics, suggestions: [] });
        return;
      }

      // Detect delimiter
      const delimiter = lines[0].includes('\t') ? '\t' : ',';
      diagnostics.push(`Delimiter: ${delimiter === '\t' ? 'TAB' : 'COMMA'}, rows: ${lines.length}`);

      // Parse headers
      // eRank clipboard: Keywords | Average Searches | Average Clicks | CTR | Competition | KD | Tag Occurrences | Character Count | Google Searches
      const headerParts = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/"/g, ''));
      diagnostics.push(`Headers: ${headerParts.join(' | ')}`);

      let colMap = {};
      headerParts.forEach((h, i) => {
        if ((h === 'keywords' || h === 'keyword') && colMap.keyword === undefined) colMap.keyword = i;
        if (h.includes('average searches') || h.includes('avg. searches') || h.includes('avg searches')) colMap.avg_searches = i;
        if (h === 'competition' || h.includes('etsy competition')) colMap.competition = i;
        if (h === 'ctr' || h.includes('avg. ctr') || h.includes('avg ctr')) colMap.click_rate = i;
        if (h.includes('average clicks') || h.includes('avg. clicks') || h.includes('avg clicks')) colMap.avg_clicks = i;
        if (h === 'kd') colMap.kd = i;
        if (h.includes('character count') || h.includes('chars')) colMap.chars = i;
        if (h.includes('google')) colMap.google_searches = i;
        if (h.includes('tag occur')) colMap.tag_occurrences = i;
      });

      diagnostics.push(`Column map: ${JSON.stringify(colMap)}`);

      // Parse data rows
      const suggestions = [];
      let skippedJunk = 0;

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(delimiter).map(p => p.trim().replace(/"/g, ''));
        if (parts.length < 3) continue;

        const keyword = colMap.keyword !== undefined ? parts[colMap.keyword] : parts[0];
        if (isJunkKeyword(keyword)) {
          skippedJunk++;
          continue;
        }

        let clickRateRaw = colMap.click_rate !== undefined ? parseFloat((parts[colMap.click_rate] || '').replace('%', '')) || 0 : 0;
        // eRank sometimes exports CTR as basis points (13400 = 134%). Normalize.
        if (clickRateRaw > 999) clickRateRaw = clickRateRaw / 100;

        const suggestion = {
          keyword: keyword.trim(),
          avg_searches: colMap.avg_searches !== undefined ? parseNum(parts[colMap.avg_searches]) : 0,
          competition: colMap.competition !== undefined ? parseNum(parts[colMap.competition]) : 0,
          click_rate: clickRateRaw,
          avg_clicks: colMap.avg_clicks !== undefined ? parseNum(parts[colMap.avg_clicks]) : 0
        };

        if (suggestion.keyword && suggestion.keyword.length > 0) {
          const hasMetrics = suggestion.avg_searches > 0 || suggestion.competition > 0;
          if (hasMetrics) {
            suggestions.push(suggestion);
          } else {
            skippedJunk++;
          }
        }
      }

      diagnostics.push(`Parsed ${suggestions.length} keywords, skipped ${skippedJunk} junk`);
      console.log('[eRank Extractor] Copy to clipboard extraction:', diagnostics.join(' | '));

      sendResponse({
        success: true,
        suggestions,
        hasMore: false,
        currentPage: 1,
        totalFound: suggestions.length,
        method: 'copyAll',
        diagnostics
      });
    } catch (parseErr) {
      diagnostics.push('Parse error: ' + parseErr.message);
      sendResponse({ success: false, error: parseErr.message, diagnostics, suggestions: [] });
    }
  }

  // Detect junk keyword rows: eRank quality warnings, typos, repeated-word notices, quoted singles
  function isJunkKeyword(text) {
    if (!text) return true;
    const trimmedEarly = (text || '').trim();
    const lower = trimmedEarly.toLowerCase();

    // Empty or too short
    if (lower.length < 2) return true;
    // Pure numbers
    if (/^\d+$/.test(lower)) return true;

    // Leading slash ("/ 13", "/something") — eRank UI strings often start
    // with a slash; never legit keywords. Strip and re-check pure digits.
    if (/^[\/\\]/.test(trimmedEarly)) return true;
    const stripped = trimmedEarly.replace(/^[\/\\\s]+/, '').trim();
    if (/^\d+$/.test(stripped)) return true;

    // Known eRank / Etsy UI chrome that has leaked into the keywords column
    // before (2026-04-08 incident with "Copy Tags", "Search Trend", "/ 13")
    const uiJunk = new Set([
      'copy tags', 'copy tag', 'copy to clipboard', 'copy all',
      'search trends', 'search trend', 'search trending',
      'show filters', 'hide filters', 'clear filters',
      'categories', 'sort by', 'filter by',
      'bestseller', 'top seller', 'new seller',
      'menu', 'dashboard', 'settings', 'account',
      'log in', 'log out', 'sign in', 'sign out', 'sign up',
      'home favourites', 'home favorites', 'top gifts', 'trending now',
      'star seller', 'free shipping'
    ]);
    if (uiJunk.has(lower)) return true;
    const navOnly = new Set([
      'categories', 'shop', 'sell', 'cart', 'wishlist', 'help', 'about',
      'blog', 'faq', 'terms', 'privacy', 'policy', 'contact', 'support',
      'trending', 'popular', 'featured', 'explore', 'discover'
    ]);
    if (navOnly.has(lower)) return true;

    // eRank quality/warning labels — match both singular and plural forms
    const junkPatterns = [
      'keyword stuffing', 'possible typo', 'repeated word', 'repeated words',
      'repeated tag', 'repeated tags', 'misspelling', 'misspelled',
      'duplicate tag', 'duplicate tags', 'too long', 'too short',
      'single word', 'not relevant', 'low quality', 'quality issue',
      'character limit', 'special character', 'routine quotidienne',
      'ma routine'
    ];
    for (const pat of junkPatterns) {
      if (lower.includes(pat)) return true;
    }

    // Starts with a known warning prefix followed by colon
    // e.g., "Repeated word: \"cleaning\" appears 3 times"
    if (/^[A-Za-z\s]+:\s+/i.test(text.trim()) && !text.includes('http')) return true;

    // Quoted words — with or without count suffix
    // Matches: "cleaning" (4), "adhd" (3), "svg", "png" (5)
    // These are eRank's tag repetition warnings
    const trimmed = text.trim();
    if (/^["'\u201c\u201d]/.test(trimmed) && /["'\u201c\u201d]/.test(trimmed)) return true;

    // Ends with (X) count AND the non-count part is 1-2 words — repetition warning
    // e.g., "cleaning (4)", "autism (5)" but NOT "adhd cleaning planner (2)"
    if (/\(\d+\)\s*$/.test(trimmed)) {
      const withoutCount = trimmed.replace(/\s*\(\d+\)\s*$/, '').trim();
      if (withoutCount.split(/\s+/).length <= 2) return true;
    }

    // Contains "appears X times" — definitely a warning
    if (/appears\s+\d+\s+times?/i.test(lower)) return true;

    return false;
  }

  // async since 2026-08-08 — the paginator re-poll below awaits. Safe: the
  // onMessage listener already returns true for this action, so the response
  // channel stays open for an async sendResponse.
  async function handleExtractSuggestions(sendResponse) {
    try {
      const suggestions = [];

      // eRank is a Vue SPA — the keyword tool renders a DataTable with these columns:
      //   [checkbox] [icon] Keywords | Search Trend | Avg. Searches | Avg. Clicks | Avg. CTR | Etsy Competition | KD | Chars.
      // DataTables often creates duplicate/shadow tables, so we pick the one with the MOST tbody rows.
      // TABLE 0 & TABLE 1 are typically duplicates; TABLE 2 is a smaller section.

      const tables = document.querySelectorAll('table');
      let targetTable = null;
      let bestScore = 0;

      for (const table of tables) {
        const headerRow = table.querySelector('thead tr:first-child, tr:first-child');
        if (!headerRow) continue;
        const headerText = headerRow.innerText.toLowerCase();

        let score = 0;
        // Must have "keyword" column
        if (headerText.includes('keyword')) score += 3;
        // Must have searches column
        if (headerText.includes('searches') || (headerText.includes('avg') && headerText.includes('search'))) score += 2;
        // Should have competition column
        if (headerText.includes('competition') || headerText.includes('compet')) score += 2;
        // Should have CTR column (eRank uses "Avg. CTR")
        if (headerText.includes('ctr')) score += 1;
        // Should have clicks column
        if (headerText.includes('click')) score += 1;
        // Prefer tables with more data rows (the real table, not a clone with 0 visible rows)
        const bodyRows = table.querySelectorAll('tbody tr');
        const visibleRows = Array.from(bodyRows).filter(r => r.offsetParent !== null || r.offsetHeight > 0);
        // Use visible row count as a tiebreaker — more visible rows = more likely the real table
        score += Math.min(visibleRows.length, 5);
        // Multiple header cells = data table
        const headerCells = headerRow.querySelectorAll('th, td');
        if (headerCells.length >= 6) score += 2;

        if (score > bestScore) {
          bestScore = score;
          targetTable = table;
        }
      }

      if (!targetTable) {
        targetTable = document.querySelector('[class*="keyword-table"], [class*="suggestions"], .table, [class*="DataTable"]');
      }

      console.log(`[eRank Extractor] Best table score: ${bestScore}, found: ${!!targetTable}`);

      if (targetTable) {
        const rows = targetTable.querySelectorAll('tbody tr');
        const headerRow = targetTable.querySelector('thead tr:first-child');

        // Build column map from actual header text. Strategy:
        //   1) Exact-match on canonical eRank header strings (most reliable
        //      and immune to "search trend" / "google search volume" column
        //      additions that the loose substring rules used to mis-match).
        //   2) Fall back to looser substring rules only when exact match
        //      didn't resolve a slot.
        //   3) Sanitize header text by stripping the "↑↓" sort glyph eRank
        //      now appends after every column label.
        // eRank headers (default): [blank icons] Keywords | Search Trend |
        //   Avg. Searches | Avg. Clicks | Avg. CTR | Etsy Competition | KD |
        //   Tag Occurrences | Chars. | Google Search Volume
        let colMap = {};
        let rawHeaders = [];
        if (headerRow) {
          rawHeaders = Array.from(headerRow.querySelectorAll('th, td'))
            .map(h => (h.innerText || '').trim());
          const headers = rawHeaders.map(h => h
            .toLowerCase()
            // strip sort indicator glyphs eRank renders inside <th>
            .replace(/[↑↓⇅↕]/g, '')
            // collapse all whitespace (newlines from icon sub-elements)
            .replace(/\s+/g, ' ')
            .trim()
          );
          console.log('[eRank Extractor] Headers (cleaned):', headers);

          // Pass 1 — exact match (canonical labels)
          const exactMap = {
            keyword:      ['keywords', 'keyword'],
            avg_searches: ['avg. searches', 'avg searches', 'average searches'],
            avg_clicks:   ['avg. clicks',   'avg clicks',   'average clicks'],
            click_rate:   ['avg. ctr',      'avg ctr',      'ctr', 'average ctr'],
            competition:  ['etsy competition', 'competition'],
          };
          for (const [slot, labels] of Object.entries(exactMap)) {
            if (colMap[slot] !== undefined) continue;
            for (let i = 0; i < headers.length; i++) {
              // Exact match first; also allow header to contain the label
              // (catches extra sort glyphs or whitespace that survived stripping)
              if (labels.includes(headers[i]) || labels.some(l => headers[i].includes(l))) {
                colMap[slot] = i; break;
              }
            }
          }

          // Pass 2 — substring fallback, but EXCLUDE columns that have
          // already been claimed in pass 1, and skip headers that are
          // notorious near-matches (e.g. "search trend", "google search
          // volume" both contain "search" but aren't avg searches).
          const claimed = new Set(Object.values(colMap));
          headers.forEach((h, i) => {
            if (claimed.has(i)) return;
            if (colMap.keyword === undefined && h.includes('keyword')) {
              colMap.keyword = i; claimed.add(i); return;
            }
            if (colMap.avg_searches === undefined &&
                /(?:^|\s)searches(?:$|\s)/.test(h) &&
                !h.includes('trend') && !h.includes('google')) {
              colMap.avg_searches = i; claimed.add(i); return;
            }
            if (colMap.competition === undefined && h.includes('compet')) {
              colMap.competition = i; claimed.add(i); return;
            }
            if (colMap.click_rate === undefined && h.includes('ctr')) {
              colMap.click_rate = i; claimed.add(i); return;
            }
            if (colMap.avg_clicks === undefined && h.includes('click') && !h.includes('ctr')) {
              colMap.avg_clicks = i; claimed.add(i); return;
            }
          });
        }

        console.log('[eRank Extractor] Column map:', JSON.stringify(colMap),
                    'headers:', JSON.stringify(rawHeaders));

        // Hard guard: if we couldn't find the keyword OR avg_searches column,
        // bail out with a clear error rather than scraping wrong cells silently.
        if (colMap.keyword === undefined || colMap.avg_searches === undefined) {
          const missing = []
            .concat(colMap.keyword === undefined ? ['Keyword'] : [])
            .concat(colMap.avg_searches === undefined ? ['Avg. Searches'] : []);
          console.warn('[eRank Extractor] Required columns missing — aborting scrape.',
                       { colMap, rawHeaders });
          sendResponse({
            success: false,
            error: 'eRank table column layout not recognized — missing column(s): '
                 + missing.join(', ')
                 + '. If you customised columns in eRank, reset to default '
                 + '(Columns button → Reset) and retry.',
            suggestions: [],
            diagnostics: { colMap, headers: rawHeaders },
          });
          return;
        }

        let skippedJunk = 0;
        let extracted = 0;
        rows.forEach(row => {
          // Skip hidden rows (DataTables clone rows)
          if (row.offsetParent === null && row.offsetHeight === 0) return;

          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 3) return;

          const suggestion = {};

          // Extract keyword text from the Keywords column
          // eRank keyword cell contains bold text like "adhd cleaning" possibly with a link
          // It may also have icon elements (star, menu) that add whitespace/text
          if (colMap.keyword !== undefined) {
            const kwCell = cells[colMap.keyword];
            // Priority 1: look for a link (eRank keywords are often clickable links)
            const link = kwCell?.querySelector('a');
            if (link) {
              suggestion.keyword = link.innerText.trim();
            } else {
              // Priority 2: look for bold/strong/span with the keyword text
              const bold = kwCell?.querySelector('b, strong, span[class*="keyword"], span[class*="Keyword"]');
              if (bold) {
                suggestion.keyword = bold.innerText.trim();
              } else {
                // Priority 3: use full cell text but clean it up
                let text = (kwCell?.innerText || '').trim();
                // Remove newlines and collapse whitespace (icons/menu may add extra text)
                text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                suggestion.keyword = text;
              }
            }
          } else {
            // Fallback: scan cells for one that looks like a keyword (text, not a number)
            for (let i = 0; i < cells.length; i++) {
              const text = cells[i]?.innerText?.trim() || '';
              if (text.length > 1 && !/^\d/.test(text) && !/^[%$]/.test(text)) {
                suggestion.keyword = text;
                break;
              }
            }
          }

          // Skip junk keywords
          if (isJunkKeyword(suggestion.keyword)) {
            skippedJunk++;
            return;
          }

          // Extract numeric columns
          if (colMap.avg_searches !== undefined) {
            suggestion.avg_searches = parseNum(cells[colMap.avg_searches]?.innerText);
          }
          if (colMap.competition !== undefined) {
            suggestion.competition = parseNum(cells[colMap.competition]?.innerText);
          }
          if (colMap.click_rate !== undefined) {
            let ctrVal = parseFloat(cells[colMap.click_rate]?.innerText?.replace('%', '')) || 0;
            // Normalize basis points (13400 → 134)
            if (ctrVal > 999) ctrVal = ctrVal / 100;
            suggestion.click_rate = ctrVal;
          }
          if (colMap.avg_clicks !== undefined) {
            suggestion.avg_clicks = parseNum(cells[colMap.avg_clicks]?.innerText);
          }

          // Fallback: if colMap missed columns, try positional extraction
          // Known eRank layout after 2 blank cols: [2]=keyword [3]=trend [4]=searches [5]=clicks [6]=ctr [7]=competition
          if (suggestion.avg_searches === undefined) {
            // Try to find searches from a cell that has a reasonable number
            for (let i = 2; i < cells.length; i++) {
              if (i === colMap.keyword) continue;
              const val = parseNum(cells[i]?.innerText);
              if (val > 0) {
                suggestion.avg_searches = val;
                break;
              }
            }
          }

          // Accept rows with keyword + at least some numeric data
          if (suggestion.keyword && suggestion.keyword.length > 0) {
            const hasMetrics = (suggestion.avg_searches > 0) || (suggestion.competition > 0);
            if (hasMetrics) {
              suggestions.push(suggestion);
              extracted++;
            } else {
              skippedJunk++;
            }
          }
        });

        console.log(`[eRank Extractor] Extracted ${extracted} keywords, filtered ${skippedJunk} junk/warning rows`);

        // Diagnostic: dump the first 3 rows so a column-mapping bug shows up
        // immediately in the eRank tab's console (and gets attached when a
        // user exports logs).
        if (suggestions.length > 0) {
          const sample = suggestions.slice(0, 3).map(s => ({
            keyword: s.keyword,
            avg_searches: s.avg_searches,
            avg_clicks: s.avg_clicks,
            click_rate: s.click_rate,
            competition: s.competition,
          }));
          console.log('[eRank Extractor] First parsed rows:', JSON.stringify(sample));
        }
      }

      // Check if there are more pages
      // eRank uses a CUSTOM pagination bar (NOT PrimeVue's p-paginator).
      // Structure: a div containing "Rows per page" text + "X - Y of Z" label + numbered p-button page buttons.
      // Active page button: button.p-button.p-button-secondary WITHOUT p-button-outlined
      // Inactive page buttons: button.p-button.p-button-secondary WITH p-button-outlined
      // Next/prev: icon-only p-button buttons (with SVG) flanking the numbered buttons
      // 2026-08-08: the paginator renders AFTER the rows. Verified live on
      // eRank: at t=0.0s the table already had 104 rows but no pagination bar;
      // it only appeared at t=1.4s ("1 - 100 of 1314"). Because a missing bar
      // yields hasMore=false, Step 1 concluded there was a single page and
      // stopped after 100 of 1,314 keywords — which is what NO-GO'd every
      // pipeline. So when the bar isn't found, re-poll briefly instead of
      // treating "not found yet" as "no more pages". Only retries on a MISS,
      // so single-page results cost at most this window once.
      let pagInfo = findErankPagination();
      if (!pagInfo.found) {
        for (let attempt = 0; attempt < 8 && !pagInfo.found; attempt++) {
          await new Promise(r => setTimeout(r, 500));   // 8 x 500ms = up to 4s
          pagInfo = findErankPagination();
        }
        console.log(`[eRank Extractor] Paginator re-poll finished: found=${pagInfo.found}`);
      }
      const hasMore = pagInfo.hasMore;
      const currentPage = pagInfo.currentPage;

      console.log(`[eRank Extractor] Pagination: hasMore=${hasMore}, currentPage=${currentPage}, total=${pagInfo.totalItems}, paginatorFound=${pagInfo.found}`);
      // Surfaced to the pipeline log (not just the page console) so a future
      // eRank change is visible in the run history instead of silently
      // truncating to one page.
      sendResponse({ success: true, suggestions, hasMore, currentPage, totalFound: suggestions.length,
                     paginatorFound: pagInfo.found, totalItems: pagInfo.totalItems });
    } catch (err) {
      sendResponse({ success: false, error: err.message, suggestions: [] });
    }
  }

  function handleApplyFilters(msg, sendResponse) {
    // eRank uses a PrimeVue DataTable with Vue-rendered filter dropdowns.
    // DOM interaction with Vue's virtual DOM is unreliable, so we don't try to apply filters.
    // Instead, the workflow uses software filtering on scraped data.
    // This handler just reports page diagnostics for logging.
    try {
      const diagnostics = [];
      const pageText = document.body.innerText;

      // Detect if filters are already manually applied by the user
      const hasActiveFilters = pageText.includes('Active Filters') || pageText.includes('Clear All');
      let searchesApplied = false, competitionApplied = false;

      if (hasActiveFilters) {
        diagnostics.push('Active filters detected on page (user applied manually)');
        if (/average\s*searches?\s*greater/i.test(pageText)) {
          searchesApplied = true;
          diagnostics.push('Search filter active');
        }
        if (/competition\s*less/i.test(pageText)) {
          competitionApplied = true;
          diagnostics.push('Competition filter active');
        }
      } else {
        diagnostics.push('No active filters — software filtering will handle criteria');
      }

      // Report table structure for debugging
      const tables = document.querySelectorAll('table');
      diagnostics.push(`${tables.length} tables on page`);
      for (let i = 0; i < tables.length; i++) {
        const hdr = tables[i].querySelector('thead tr:first-child');
        const bodyRows = tables[i].querySelectorAll('tbody tr');
        const visibleRows = Array.from(bodyRows).filter(r => r.offsetParent !== null || r.offsetHeight > 0);
        diagnostics.push(`TABLE ${i}: ${visibleRows.length}/${bodyRows.length} visible rows, header: ${hdr ? hdr.innerText.substring(0, 80).replace(/\n/g, ' ') : 'none'}`);
      }

      console.log('[eRank Filter]', diagnostics.join(' | '));
      const applied = searchesApplied || competitionApplied;
      sendResponse({ applied, searchesApplied, competitionApplied, diagnostics });
    } catch (err) {
      sendResponse({ applied: false, error: err.message, diagnostics: [err.message] });
    }
  }

  // ─── Find eRank's custom pagination bar ───
  // eRank does NOT use PrimeVue's .p-paginator component.
  // It builds a custom bar with:
  //   - "Rows per page:" label + p-dropdown (10/20/50/100)
  //   - "X - Y of Z" range label
  //   - Prev icon button | numbered page buttons | Next icon button | Last icon button
  // Active page: button.p-button WITHOUT .p-button-outlined
  // Inactive page: button.p-button WITH .p-button-outlined
  function findErankPagination() {
    const result = { found: false, bar: null, currentPage: 1, totalPages: 1, totalItems: 0, hasMore: false };

    // Find the bar by looking for the "X - Y of Z" label
    const spans = document.querySelectorAll('span');
    let rangeLabel = null;
    for (const span of spans) {
      const text = span.textContent.trim();
      // Match "1 - 100 of 1000" or "101 - 200 of 1000" etc
      const match = text.match(/^(\d+)\s*-\s*(\d+)\s+of\s+(\d[\d,]*)/);
      if (match) {
        rangeLabel = span;
        result.rangeStart = parseInt(match[1]);
        result.rangeEnd = parseInt(match[2]);
        result.totalItems = parseInt(match[3].replace(/,/g, ''));
        break;
      }
    }

    if (!rangeLabel) return result;

    // Walk up to find the pagination bar container (the div with all buttons)
    let bar = rangeLabel.parentElement;
    for (let i = 0; i < 5 && bar; i++) {
      const buttons = bar.querySelectorAll('button.p-button');
      if (buttons.length >= 3) { // At least prev + page 1 + next
        result.bar = bar;
        result.found = true;
        break;
      }
      bar = bar.parentElement;
    }

    if (!result.found) return result;

    // Find all page number buttons (buttons whose text is a number)
    const allButtons = Array.from(result.bar.querySelectorAll('button.p-button'));
    const pageButtons = allButtons.filter(btn => /^\d+$/.test(btn.innerText.trim()));

    // Active page = the page button WITHOUT p-button-outlined
    const activeBtn = pageButtons.find(btn => !btn.classList.contains('p-button-outlined'));
    if (activeBtn) {
      result.currentPage = parseInt(activeBtn.innerText.trim()) || 1;
    }

    // Total pages from range info
    const rowsPerPage = result.rangeEnd - result.rangeStart + 1;
    if (rowsPerPage > 0) {
      result.totalPages = Math.ceil(result.totalItems / rowsPerPage);
    }

    // Has more = current page < total pages
    result.hasMore = result.currentPage < result.totalPages;

    return result;
  }

  function handleNextPage(sendResponse) {
    try {
      const pagInfo = findErankPagination();
      if (!pagInfo.found) {
        console.log('[eRank Extractor] No pagination bar found');
        sendResponse({ hasMore: false, currentPage: 1 });
        return;
      }

      if (!pagInfo.hasMore) {
        console.log(`[eRank Extractor] Already on last page (${pagInfo.currentPage}/${pagInfo.totalPages})`);
        sendResponse({ hasMore: false, currentPage: pagInfo.currentPage });
        return;
      }

      // Strategy: click the next numbered page button
      // Find all page number buttons and click the one after the active page
      const allButtons = Array.from(pagInfo.bar.querySelectorAll('button.p-button'));
      const pageButtons = allButtons.filter(btn => /^\d+$/.test(btn.innerText.trim()));

      // Find the button with page number = currentPage + 1
      const targetPage = pagInfo.currentPage + 1;
      let targetBtn = pageButtons.find(btn => parseInt(btn.innerText.trim()) === targetPage);

      // If exact next page button isn't visible (e.g., "1 2 3 ... 10" and we need page 4),
      // click the icon-only "next" button instead.
      // The next-arrow button: it's the first icon-only button AFTER the page number buttons.
      if (!targetBtn) {
        const lastPageBtn = pageButtons[pageButtons.length - 1];
        if (lastPageBtn) {
          const lastPageIdx = allButtons.indexOf(lastPageBtn);
          // The next icon button should be right after the last page number button
          for (let i = lastPageIdx + 1; i < allButtons.length; i++) {
            const btn = allButtons[i];
            if (btn.querySelector('svg') && !btn.disabled) {
              targetBtn = btn;
              break;
            }
          }
        }
      }

      if (targetBtn) {
        console.log(`[eRank Extractor] Clicking to go to page ${targetPage} (btn text: "${targetBtn.innerText.trim() || 'icon'}")`);
        targetBtn.click();

        // Wait for table to re-render, then poll for the page change to complete
        let pollCount = 0;
        const maxPolls = 20; // 20 × 300ms = 6 seconds max
        function pollForPageChange() {
          pollCount++;
          const newPag = findErankPagination();
          if (newPag.currentPage !== pagInfo.currentPage) {
            // Page changed successfully
            console.log(`[eRank Extractor] Page changed: ${pagInfo.currentPage} → ${newPag.currentPage}, hasMore=${newPag.hasMore}`);
            sendResponse({ hasMore: newPag.hasMore, currentPage: newPag.currentPage });
          } else if (pollCount >= maxPolls) {
            console.log(`[eRank Extractor] Page change timed out (still on page ${newPag.currentPage})`);
            sendResponse({ hasMore: newPag.hasMore, currentPage: newPag.currentPage, timeout: true });
          } else {
            setTimeout(pollForPageChange, 300);
          }
        }
        // Initial delay before polling (give Vue time to start re-rendering)
        setTimeout(pollForPageChange, 500);
      } else {
        console.log('[eRank Extractor] Could not find next page button');
        sendResponse({ hasMore: false, currentPage: pagInfo.currentPage });
      }
    } catch (err) {
      console.error('[eRank Extractor] handleNextPage error:', err);
      sendResponse({ hasMore: false, error: err.message });
    }
  }

  function parseNum(text) {
    if (!text) return 0;
    text = text.trim().replace(/,/g, '');
    const multiplierMatch = text.match(/([0-9.]+)\s*([kKmM])/);
    if (multiplierMatch) {
      const num = parseFloat(multiplierMatch[1]);
      const mult = multiplierMatch[2].toLowerCase() === 'k' ? 1000 : 1000000;
      return Math.round(num * mult);
    }
    return parseInt(text.replace(/[^0-9.-]/g, '')) || 0;
  }
})();
