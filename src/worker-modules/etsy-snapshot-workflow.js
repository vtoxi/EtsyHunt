// Step 2: Etsy Search Snapshots Workflow
// Takes validated keywords, searches Etsy, extracts top N listings per keyword
// Evaluates each keyword for "beatable slots" (shops with low review counts)
// Returns qualification result — determines whether Steps 3 & 4 should run
//
// Capture vs audit split:
//   SNAPSHOT_CAPTURE_DEPTH  — ALL cards we persist from the Etsy search page
//                             (structural signal for concept clustering and
//                              admin-level aggregation; silent to the user).
//   maxListingsPerKw        — user-controlled audit depth (default 12, recommended
//                             ≤16). Drives beatable-slots, the kw "qualified" flag,
//                             and eRank credit consumption in Step 3. Changing this
//                             does NOT change how many rows we persist per keyword.
const SNAPSHOT_CAPTURE_DEPTH = 64;

// Detects junk keywords that should never be used as Etsy search queries.
//
// There are two layers of defense here:
//   (1) Step 1's eRank extractor has its own filter that runs at scrape time.
//   (2) This filter runs at Step 2 read time, so even if old garbage rows are
//       already sitting in pro_etsy_res_etsy_keywords from a previous broken
//       extractor version, we will refuse to snapshot them on Etsy.
// Updated 2026-04-08 after bad rows like "/ 13", "Copy Tags", "Search Trend"
// leaked past the older filter and burned eRank credit on bogus snapshots.
function isJunkKeyword(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower.length < 4) return true;  // "s", "39", "hi" — too short to be a real keyword
  // Pure numbers: "13", "2024"
  if (/^\d+$/.test(lower)) return true;
  // Leading slash — eRank UI strings often start with "/" (e.g. "/ 13")
  if (/^[\/\\]/.test(trimmed)) return true;
  // Strip leading "/" and spaces, then re-check pure digits: catches "/ 13"
  const stripped = trimmed.replace(/^[\/\\\s]+/, '').trim();
  if (/^\d+$/.test(stripped)) return true;
  // Starts with a number — "39 s", "2 pack", "1 piece" are fragments, not real keywords.
  // BUT allow 3+ word phrases like "67 days of school", "100 days of school shirt"
  // which are legitimate Etsy search keywords with high volume.
  if (/^\d+\s/.test(trimmed) && trimmed.split(/\s+/).length <= 2) return true;
  // Split into words for further checks
  const words = lower.split(/\s+/).filter(Boolean);
  // Short keywords (≤2 words) with a single-character word are fragments — "39 s", "s day"
  // Allow "i" and "a" (e.g. "a gift"). Don't flag 3+ word keywords like "mom t shirt".
  if (words.length <= 2) {
    const hasSingleCharJunk = words.some(w => w.length === 1 && w !== 'i' && w !== 'a');
    if (hasSingleCharJunk) return true;
  }
  // All words are ≤ 2 chars — "s t", "to do" — not meaningful keywords
  if (words.length >= 2 && words.every(w => w.length <= 2)) return true;
  // Known eRank / Etsy UI chrome strings that look like keywords
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
    // 2026-04-08: eRank listing-audit page field labels that leaked into
    // tag-derived keywords and concept cards ("Start Of Title", "In Description", etc.)
    'start of title', 'in title', 'in description', 'in tags',
    'title length', 'description length', 'tags count',
    'listing age', 'listing score', 'listing quality',
    'views', 'hearts', 'sales', 'conversion rate', 'conversion',
    'daily views', 'monthly views', 'estimated sales', 'est sales',
    'overview', 'details', 'recommendations', 'suggestions',
    'edit listing', 'view listing', 'open listing',
    'learn more', 'read more', 'show more', 'show less',
    'save changes', 'cancel', 'close', 'ok', 'next', 'back',
    'yes', 'no', 'on', 'off',
    'loading', 'please wait', 'error', 'success',
  ];
  if (uiJunk.includes(lower)) return true;
  // Catches short strings that are ONLY single navigation words (≤2 words,
  // no digits, and in a common-english verb/noun stop list). Cheap guard.
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
    'character limit', 'special character', 'routine quotidienne', 'ma routine',
    // 2026-04-08: phrases from eRank warning cards and listing-audit sections
    'start of title', 'start of tag', 'end of title',
    'in description', 'in the description', 'in title', 'in the title',
    'in tags', 'in the tags', 'tag recommendation', 'tag recommendations',
    'recommended tag', 'recommended tags',
    'found in', 'not found in',
  ];
  for (const pat of junkPatterns) { if (lower.includes(pat)) return true; }
  if (/^[A-Za-z\s]+:\s+/i.test(trimmed) && !trimmed.includes('http')) return true;
  if (/^["'\u201c\u201d]/.test(trimmed) && /["'\u201c\u201d]/.test(trimmed)) return true;
  if (/appears\s+\d+\s+times?/i.test(lower)) return true;
  if (/\(\d+\)\s*$/.test(trimmed) && trimmed.split(/\s+/).length <= 2) return true;
  // Anything with a colon that looks like "Label: value" from a label-value UI
  if (/:/.test(trimmed) && trimmed.split(':').length === 2 && trimmed.split(/\s+/).length <= 4) return true;
  // Anything containing typical warning-card phrasing
  if (/^(possible|repeated|duplicate|misspelled|misspelling)\b/i.test(trimmed)) return true;
  return false;
}

// Exported so Step 3 + Step 4 can share the exact same filter
export { isJunkKeyword };

export async function runEtsySearchSnapshots(sheetsClient, tabId, config, log, seedKeyword, shouldStop, opts = {}) {
  if (!shouldStop) shouldStop = () => false;
  // pipelineRunId is required for writing per-user verdicts to user_keyword_results.
  // If the caller didn't pass one (standalone Step 2 run), we fall back to in-memory
  // only — no per-user DB write — and Step 4's fallback read will treat the run
  // as having no verdict snapshot.
  const pipelineRunId = (opts && (opts.pipelineRunId || opts.runId)) || null;
  const started = new Date().toISOString();
  let keywordsProcessed = 0, listingsFound = 0, snapshotsTaken = 0;

  // Track keyword qualification for niche verdict
  const keywordResults = []; // { keyword, qualified, beatableSlots, totalListings }
  // Warn once per run if the database predates the shop_reviews column.
  let skippedShopReviewsCol = false;

  try {
    let sheetConfig;
    try { sheetConfig = await sheetsClient.readConfig(); } catch(e) { sheetConfig = {}; }

    // Config priority: popup settings (config) > sheet config > hardcoded defaults
    // The user sets values in the popup UI — those must take precedence.
    // Use nullish coalescing so explicit 0 / "" from popup don't fall through.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = sheetConfig != null ? sheetConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };

    const maxKeywords = cfg('max_keywords_per_run', 20);
    // 2026-08-08: hard floor of 7s between Etsy page loads. Etsy tightened rate
    // limiting sharply — blank/throttled listing captures went from ~1% in
    // mid-July to 41% on Aug 7, which silently emptied reports. The floor is
    // enforced HERE (not just in the popup) because existing installs already
    // have 5 stored in chrome.storage / pro_etsy_res_config, and the UI value
    // alone wouldn't protect them. Users may raise the delay, never lower it.
    const MIN_ETSY_DELAY_SEC = 7;
    const delay = Math.max(parseInt(cfg('delay_between_pages_sec', MIN_ETSY_DELAY_SEC)) || MIN_ETSY_DELAY_SEC, MIN_ETSY_DELAY_SEC) * 1000;
    // Issue 5: per-seed listing cap removed. The per-keyword cap (max_listings_per_keyword,
    // default 12) is the only operative limit now — no need to also cap the category total.
    // Setting to Infinity preserves all the existing log-line math without the cap ever firing.
    const maxListingsPerCat = Infinity;

    // Niche qualification settings
    const maxListingsPerKw = cfg('max_listings_per_keyword', 12);
    const minQualifiedKw = cfg('min_qualified_keywords', 5);
    const maxShopReviewsBeatable = cfg('max_shop_reviews_beatable', 300);
    const minBeatableSlots = cfg('min_beatable_slots', 3);

    // Product type filter — controls Etsy search URL parameter
    // 'digital'  → &instant_download=true   (only digital/instant-download listings)
    // 'physical' → &instant_download=false   (only physical items — Etsy's new default)
    // 'any'      → no parameter appended     (no filter, show everything)
    const productTypeFilter = cfg('product_type_filter', 'any');
    const productTypeParam = productTypeFilter === 'digital' ? '&instant_download=true'
                           : productTypeFilter === 'physical' ? '&instant_download=false'
                           : '';

    log('info', `⚙️ Qualification criteria: top ${maxListingsPerKw} listings/kw, need ${minBeatableSlots}+ shops under ${maxShopReviewsBeatable} reviews, need up to ${minQualifiedKw} qualified keywords (scaled down if this run searches fewer)`);
    log('info', `🏷️ Product type filter: ${productTypeFilter}${productTypeParam ? ' (' + productTypeParam.substring(1) + ')' : ' (no filter)'}`);

    // ─── Per-run device context ───
    // Collected ONCE per run and stamped on every snapshot row so we can
    // correlate SERP rank observations to the device that captured them.
    // IP / country / region / city / asn / as_organization are stamped
    // server-side by the Worker from Cloudflare's request headers — we
    // never send those from the client.
    const deviceContext = collectDeviceContext();
    log('info', `🖥️ Device context: ${deviceContext.user_agent ? deviceContext.user_agent.split(') ')[0] + ')' : 'n/a'} • ${deviceContext.screen_resolution} • UTC${deviceContext.timezone_offset >= 0 ? '+' : ''}${deviceContext.timezone_offset} • local hour ${deviceContext.hour_local}`);

    // Data freshness window. Popup config wins; falls back to DB config, then 48h.
    // 2026-04-18: priority inverted — user's popup setting now takes precedence.
    const FRESH_HOURS = parseInt(
      cfg('data_staleness_hours', null)
      ?? cfg('keyword_freshness_hours', null)
      ?? 48
    ) || 48;
    // Post-m2m migration: seed_keywords is read first so we can scope the
    // keywords read by seed_id. The Worker transparently rewrites
    // `?seed_id=X` on the keywords table into a JOIN through
    // pro_etsy_res_seed_keyword_map and aliases _skm.seed_id AS seed_id in
    // the response, so downstream code reading k.seed_id keeps working.
    const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');

    // Find the seed for this run
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) {
      log('error', `Seed keyword "${seedKeyword}" not found in seed_keywords sheet`);
      await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', 0, 0, 0, `Seed "${seedKeyword}" not found`, '');
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    const seedId = String(seed.seed_id);
    log('info', `🎯 Locked onto seed "${seedKeyword}" (ID #${seedId})`);

    // 2026-04-17: Keywords read no longer uses the `updated_at` freshness
    // filter. The snapshot-always model below re-snapshots every selected
    // keyword every run, so the age of the keyword metadata row is irrelevant
    // — what matters is Etsy-side data, which we still filter via FRESH_HOURS
    // on the listings read (next line). The previous filter was producing
    // false-negative runs when a seed was rerun beyond 48h.
    const { rows: keywords } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seedId });
    // 2026-04-22: seed-scoped (Worker JOINs through seed_keyword_map). Avoids
    // pulling every user's 48h listings just to count this seed's.
    // 2026-08-21: snapshot_date, matching Steps 3 and 4. This count is only a
    // log line, but it says "listings collected", and updated_at answers a
    // different question — it is ON UPDATE CURRENT_TIMESTAMP and Step 3 bumps
    // it on every row for a listing it audits, so the figure counted rows we
    // had merely re-written, not listings we had recently seen on Etsy.
    const { rows: existingListings } = await sheetsClient.readSheet('etsy_listings', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'snapshot_date' });

    // Count existing listings for this seed only
    const seedKwIds = new Set(keywords.filter(k => String(k.seed_id) === seedId).map(k => String(k.keyword_id)));
    let seedListingCount = existingListings.filter(l => seedKwIds.has(String(l.keyword_id))).length;
    log('info', `📊 Current state: ${seedKwIds.size} keywords linked to this seed, ${seedListingCount} listings collected`);

    // Find keywords to process — snapshot-always model: we re-snapshot every
    // non-junk keyword for the seed every run, regardless of snapshot_count or
    // prior status. Etsy shuffles rankings by IP/time/personalization, so
    // multiple snapshots per keyword give us richer data over time.
    //
    // The `snapshot_count = 0` gate that used to live here was causing reruns
    // to silently drop to 0-3 keywords and produce false-negative NO-GO
    // verdicts (see nursery seed, 2026-04-07). We now re-evaluate every
    // keyword every run and rely on the per-run cap (max_keywords_per_run) to
    // bound Etsy traffic.
    //
    // Keywords are ordered by oldest-last-snapshot-first (or never-snapshotted
    // first), so if the cap hits, the keywords most in need of a fresh
    // snapshot get priority.
    const available = keywords.filter(k => {
      if (String(k.seed_id) !== seedId) return false;
      const status = (k.status || '').toLowerCase();
      // Accept any keyword the pipeline has ever considered:
      //   pending      — never snapshotted
      //   validated    — Step 1 accepted it but Step 2 hasn't run
      //   qualified    — previous Step 2 run marked it as having beatable slots
      //   unqualified  — previous Step 2 run marked it as crowded
      // We re-snapshot all of them because Etsy rankings drift.
      if (status && status !== 'pending' && status !== 'validated'
          && status !== 'qualified' && status !== 'unqualified') {
        return false;
      }
      const kwText = (k.keyword || '').trim();
      if (isJunkKeyword(kwText)) {
        log('warn', `🗑️ Skipping junk keyword from sheet: "${kwText}"`);
        return false;
      }
      return true;
    });

    // Order: never-snapshotted first (oldest last_snapshot_at = ""), then
    // by oldest last_snapshot_at. This ensures stale/new keywords beat
    // recently-snapshotted ones when the per-run cap bites.
    available.sort((a, b) => {
      const aLast = a.last_snapshot_at || '';
      const bLast = b.last_snapshot_at || '';
      if (aLast === bLast) {
        // Tiebreak on created_at (older seeds first) for stability
        return (a.created_at || '').localeCompare(b.created_at || '');
      }
      return aLast.localeCompare(bLast);
    });

    // 2026-08-20: prefer THIS RUN's discoveries over the seed's whole history.
    // Step 1 stashes the keyword set it just produced, already ordered the way
    // the run cares about (seed → Etsy-validated title phrases → long-tails).
    // Before this, the run's limited search slots went to whatever had the
    // oldest snapshot, so a run could search almost none of what it had just
    // discovered, and Step 4 then reported on keywords this run never touched.
    // Falls back to the full pool when there is no fresh discovery stash —
    // i.e. Step 2 run on its own, or the legacy pipeline.
    let ordered = available;
    try {
      const stash = (await chrome.storage.local.get('nesDiscovery')).nesDiscovery;
      if (stash && String(stash.seed_id) === seedId && Array.isArray(stash.runKeywords) && stash.runKeywords.length) {
        const rank = new Map(stash.runKeywords.map((k, i) => [String(k).toLowerCase().trim(), i]));
        const thisRun = available.filter(k => rank.has((k.keyword || '').toLowerCase().trim()));
        if (thisRun.length) {
          thisRun.sort((a, b) => rank.get((a.keyword || '').toLowerCase().trim()) - rank.get((b.keyword || '').toLowerCase().trim()));
          const rest = available.filter(k => !rank.has((k.keyword || '').toLowerCase().trim()));
          ordered = thisRun.concat(rest);
          log('info', `🎯 Prioritising the ${thisRun.length} keyword(s) this run just discovered (${rest.length} older keyword(s) queue behind them)`);
        }
      }
    } catch (e) { /* no stash — keep the oldest-first order */ }

    const selected = ordered.slice(0, maxKeywords);
    if (selected.length === 0) {
      log('warn', `😴 No keywords found for "${seedKeyword}" — run Step 1 first to discover keywords.`);
      await sheetsClient.logRun('etsy_search_snapshots', 'SKIPPED', 0, 0, 0, '', `No keywords for "${seedKeyword}"`);
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    const neverSnapshotted = selected.filter(k => !k.last_snapshot_at).length;
    const reSnapshotted = selected.length - neverSnapshotted;
    log('info', `🔎 Selected ${selected.length} keywords to snapshot on Etsy (${neverSnapshotted} new, ${reSnapshotted} re-snapshot)`);

    const existingListingIds = new Set(existingListings.map(l => String(l.listing_id)));

    let blankPages = 0;   // consecutive searches returning nothing (CAPTCHA guard)
    for (const kw of selected) {
      if (shouldStop()) { log('warn', `🛑 Stop requested — halting Etsy snapshots`); break; }

      try {
        const keyword = (kw.keyword || '').trim();
        const kwIndex = selected.indexOf(kw) + 1;
        log('info', `🛒 [${kwIndex}/${selected.length}] Searching Etsy for: "${keyword}"`);

        // Navigate to Etsy search
        const url = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}${productTypeParam}`;
        await navigateTab(tabId, url);
        log('info', `⏳ Etsy is thinking... loading search results`);
        await sleep(delay);

        // Extract listings
        const result = await sendToTab(tabId, { action: 'extractEtsySearchResults' });

        if (!result.success) {
          log('warn', `⚠️ Extraction failed for "${keyword}": ${result.error}`);
          keywordResults.push({ keyword, qualified: false, beatableSlots: 0, totalListings: 0, reason: 'extraction_failed' });
          continue;
        }

        // Capture vs audit split:
        //   captured = ALL cards we persist (up to SNAPSHOT_CAPTURE_DEPTH = 64).
        //              Drives snapshot_hash, ads_count_top_n, listing_count, and
        //              the rows written to etsy_listings. This is structural
        //              signal for concept clustering and admin aggregation.
        //   auditSet = top maxListingsPerKw (user-controlled, default 12).
        //              Drives beatable-slots, the per-keyword "qualified" flag,
        //              and eRank audit credit consumption in Step 3.
        const allListings = result.listings || [];
        const captured = allListings.slice(0, SNAPSHOT_CAPTURE_DEPTH);
        const auditSet = captured.slice(0, maxListingsPerKw);

        // Debug: log a sample listing's key fields to verify extraction data arrives intact
        if (auditSet.length > 0) {
          const sample = auditSet[0];
          log('info', `🔍 Sample listing #${sample.listing_id}: shop_rating=${sample.shop_rating}, shop_reviews=${sample.shop_reviews}, shop=${sample.shop_name}`);
        }
        log('info', `🏪 Etsy returned ${allListings.length} cards for "${keyword}" — persisting ${captured.length}, auditing top ${auditSet.length}`);

        // 2026-08-20: bail out when Etsy stops serving results.
        // A CAPTCHA / rate-limit wall returns a page with no listing cards, and
        // until now the run simply carried on — 30-50 more minutes of page loads
        // that return nothing, each one digging the rate-limit hole deeper, and
        // a report at the end built on air. A healthy search page always returns
        // dozens of cards, so two empty pages in a row is not bad luck.
        if (allListings.length === 0) {
          blankPages++;
          if (blankPages >= 2) {
            log('error', `🛑 Etsy returned no listings on ${blankPages} searches in a row — it is almost certainly showing a CAPTCHA or rate-limiting this browser. Stopping the run rather than burning the rest of it.`);
            log('warn', `   Open etsy.com in a normal tab, clear the CAPTCHA, then leave Etsy alone for a few hours. Raising "Delay Between Pages" makes this less likely next time.`);
            break;
          }
          log('warn', `⚠️ No listings returned for "${keyword}" — one more empty page and the run stops.`);
        } else {
          blankPages = 0;
        }

        // ─── Keyword qualification: count beatable slots in the AUDIT set ───
        // A "beatable slot" is a listing in the top maxListingsPerKw where the
        // shop has fewer than maxShopReviewsBeatable reviews (default 300).
        // Qualification is always computed on the audit set, not the full
        // captured set — otherwise raising capture depth would silently change
        // the qualification math.
        // 2026-08-21: an unreadable card is NOT a beatable slot. This used to be
        // `parseInt(l.shop_reviews) || 0`, so a card whose rating element was
        // missing scored as a zero-review shop — the most beatable value there
        // is — and inflated qualification. Unknown now counts against the
        // keyword, and the count is logged so a bad scrape is visible rather
        // than silently flattering the result.
        let beatableSlots = 0;
        let unknownSlots = 0;
        for (const l of auditSet) {
          const raw = l.shop_reviews;
          const shopRevs = (raw === null || raw === undefined || raw === '') ? null : parseInt(raw);
          if (shopRevs === null || Number.isNaN(shopRevs)) { unknownSlots++; continue; }
          if (shopRevs < maxShopReviewsBeatable) beatableSlots++;
        }

        const kwQualified = beatableSlots >= minBeatableSlots;
        const qualEmoji = kwQualified ? '✅' : '❌';
        log('info', `${qualEmoji} "${keyword}" → ${beatableSlots}/${auditSet.length} beatable slots (need ${minBeatableSlots})${unknownSlots ? ` · ${unknownSlots} slot(s) had no shop review count and count against it` : ''} → ${kwQualified ? 'QUALIFIED' : 'NOT QUALIFIED'}`);

        keywordResults.push({
          keyword,
          keyword_id: kw.keyword_id,
          qualified: kwQualified,
          beatableSlots,
          totalListings: auditSet.length,
          reason: kwQualified ? 'passed' : `only ${beatableSlots} beatable slots`
        });

        // Create snapshot — let MySQL AUTO_INCREMENT assign the snapshot_id.
        // Hash + ads count + listing_count are computed over the full captured
        // set so snapshot fingerprinting stays stable regardless of audit depth.
        const now = new Date().toISOString();
        const orderedCapturedIds = captured
          .map(l => l && l.listing_id)
          .filter(id => id != null)
          .map(String);
        const snapshotHash = await sha1Hex(orderedCapturedIds.join('|'));
        // 2026-08-19 (v2.0.0): real ad count from the extractor's page-level
        // stats (ads are excluded from `captured`, so the old reduce over it
        // was always 0 — the column has been silently empty).
        const adsCount = (typeof result.adCount === 'number') ? result.adCount
          : captured.reduce((acc, l) => acc + (l && (l.is_ad || l.promoted) ? 1 : 0), 0);

        const snapshotResult = await sheetsClient.appendRowsByName('etsy_search_snapshots', [{
          keyword_id: kw.keyword_id,
          keyword_text: keyword,
          page_number: 1,
          search_type: 'regular',
          snapshot_date: now,
          listing_count: captured.length,
          notes: result.totalResultsCount ? JSON.stringify({ total_results_count: result.totalResultsCount }) : '',
          // (notes JSON persisted server-side; the stash below is the NES-side copy)
          // Device context (server stamps the network/geo half from CF)
          user_agent: deviceContext.user_agent,
          screen_resolution: deviceContext.screen_resolution,
          timezone_offset: deviceContext.timezone_offset,
          hour_local: deviceContext.hour_local,
          is_logged_in: deviceContext.is_logged_in,
          // Snapshot fingerprint (detects reshuffles run-over-run)
          snapshot_hash: snapshotHash,
          ads_count_top_n: adsCount
        }]);

        // 2026-08-19 (v2.0.0): stash this keyword's market size for NES Step 4.
        // The Worker (correctly) refuses reads on search_snapshots — the table
        // carries other users' IP/geo context — so Step 4 can't query the
        // number back (403 in live run 4826). The run-local stash is the
        // privacy-clean channel: same data, this user's run only.
        try {
          const stashKey = 'nesMarket';
          const cur = (await chrome.storage.local.get(stashKey))[stashKey] || {};
          // object form since ad-count support; Step 4 accepts both the old
          // bare-number entries and this shape.
          cur[String(kw.keyword_id)] = {
            mkt: result.totalResultsCount || null,
            adShare: (typeof result.adCount === 'number' && result.rawSlots > 0)
              ? result.adCount / result.rawSlots : null,
          };
          await chrome.storage.local.set({ [stashKey]: cur });
        } catch (e) { /* non-fatal — Step 4 renormalizes without market size */ }

        // 2026-08-20: record WHICH listings this run saw on this keyword's page.
        // Step 4 scores from these ids alone. Before this, scoring read every
        // listing the seed had collected inside the freshness window, so a card
        // could read "2 of 78 audited listings" for a keyword whose page one is
        // six slots — 78 being this run's captures plus sibling keywords' plus
        // older runs'. A report describes ONE look at Etsy; the database keeps
        // everything, but it is not the arithmetic.
        try {
          const runKey = 'nesRun';
          const run = (await chrome.storage.local.get(runKey))[runKey] || { listingIdsByKw: {}, auditedIds: [] };
          run.listingIdsByKw = run.listingIdsByKw || {};
          run.listingIdsByKw[String(kw.keyword_id)] = captured.map(l => String(l.listing_id));
          await chrome.storage.local.set({ [runKey]: run });
        } catch (e) { /* non-fatal — Step 4 falls back to the freshness window */ }
        const snapshotId = snapshotResult && snapshotResult.first_insert_id ? snapshotResult.first_insert_id : 0;
        snapshotsTaken++;

        // Write listings — enforce per-seed cap mid-extraction
        // Uses appendRowsByName to map by column name, NOT position.
        // This prevents column-shift bugs when sheet headers differ from code assumptions.
        const listingRowObjects = [];
        const newStores = new Map(); // shop_name → { shop_rating, shop_reviews }
        // Helper: convert value to string, preserving 0 as "0" (|| '' would lose it)
        const v = (val) => (val !== undefined && val !== null && val !== '') ? String(val) : '';

        for (const l of captured) {
          if (!l.listing_id) continue;

          // etsy_listings columns match the Google Sheet headers exactly.
          // NOTE: rating & review_count are LISTING-level metrics — populated in Step 3 (audit).
          // shop_rating & shop_reviews are SHOP-level and go to etsy_stores instead.
          // urgency_text: captured from search cards when present (e.g. "In 20+ carts").
          // Richer urgency data (sold_24h, views_24h) comes from Step 3 listing detail pages.
          // Bestseller / popular_now tags ARE visible on search cards, so those
          // are kept.
          listingRowObjects.push({
            listing_id: l.listing_id,
            keyword_id: kw.keyword_id,
            snapshot_id: snapshotId,
            shop_name: v(l.shop_name),
            title: v(l.title),
            price: v(l.price),
            original_price: v(l.original_price),
            discount_pct: v(l.discount_pct),
            rating: '',         // Listing-level — filled by Step 3 audit
            review_count: '',   // Listing-level — filled by Step 3 audit
            is_digital: l.is_digital ? 'TRUE' : 'FALSE',
            is_bestseller: l.is_bestseller ? 'TRUE' : 'FALSE',
            is_popular_now: l.is_popular_now ? 'TRUE' : 'FALSE',
            // 2026-08-21: stored per listing so Step 4 measures slots from THIS
            // run's own capture. It used to re-derive shop size from the stores
            // table, whose read is capped at 5000 rows across all seeds and
            // users — run 4853 lost 35 of its own shops that way. Omitted (not
            // blanked) when unknown, so the column stays NULL rather than 0.
            ...(l.shop_reviews === null || l.shop_reviews === undefined || l.shop_reviews === ''
              ? {}
              : { shop_reviews: String(l.shop_reviews) }),
            search_position: v(l.search_position),
            run_number: '1',
            snapshot_date: now,
            etsy_url: v(l.etsy_url),
            thumbnail_url: v(l.thumbnail_url),
            urgency_text: v(l.urgency_text),  // Captured from search cards when available
            free_delivery: l.free_delivery ? 'TRUE' : 'FALSE'
          });

          // Collect shop-level data (rating & reviews from search cards are SHOP metrics)
          if (l.shop_name) {
            newStores.set(l.shop_name, {
              shop_rating: l.shop_rating || null,
              // null stays null — see the payload guard below, which only writes
              // shop_review_count when the card actually carried one.
              shop_reviews: (l.shop_reviews === undefined ? null : l.shop_reviews)
            });
          }
          seedListingCount++;
        }

        // Batch write listings by column name
        if (listingRowObjects.length > 0) {
          for (let i = 0; i < listingRowObjects.length; i += 50) {
            const chunk = listingRowObjects.slice(i, i + 50);
            try {
              await sheetsClient.appendRowsByName('etsy_listings', chunk);
            } catch (e) {
              // shop_reviews is new (migration 2026-08-21). The Worker builds its
              // INSERT column list straight from the row keys, so on a database
              // without the column the whole chunk fails and the run loses its
              // listings. Drop the field and retry once rather than lose data;
              // Step 4 then falls back to the stores table as it did before.
              if (/unknown column/i.test(e.message || '') && /shop_reviews/i.test(e.message || '')) {
                if (!skippedShopReviewsCol) {
                  skippedShopReviewsCol = true;
                  log('warn', '⚠️ Database has no listings.shop_reviews column — run migration 2026-08-21_listing_shop_reviews.sql. Beatable slots fall back to the stores table until then.');
                }
                await sheetsClient.appendRowsByName('etsy_listings',
                  chunk.map(({ shop_reviews, ...rest }) => rest));
              } else {
                throw e;
              }
            }
          }
          listingsFound += listingRowObjects.length;
        }

        // Upsert stores — refresh shop_rating + shop_review_count for every shop
        // we saw in today's search cards, not just newly-discovered ones.
        // 2026-04-17: previously we only INSERTed shops not already in the DB,
        // which meant shops discovered in prior runs kept whatever (often null)
        // rating Step 2 captured the first time. Result: report's non-audited
        // listing cards rendered "★ 0.0 · N reviews" even when Etsy's search
        // cards clearly show the shop's rating — because the stores row never
        // got updated. Now we always upsert, and the Worker's
        // INSERT ... ON DUPLICATE KEY UPDATE refreshes those fields on every
        // run.
        //
        // Payload is built conditionally — we only include shop_rating /
        // shop_review_count when today's card actually had them. This avoids
        // the case where an Etsy card omits the rating (shop has zero reviews,
        // or the card layout varied) and we'd otherwise overwrite a previously-
        // good value with null/empty. Columns not in the payload aren't in the
        // ON DUPLICATE KEY UPDATE clause, so MariaDB leaves them alone.
        const storeRowObjects = [];
        for (const [shopName, shopData] of newStores) {
          const row = { shop_name: shopName, source: 'search_snapshot' };
          // Only include rating if we actually got a non-empty numeric value
          const ratingVal = shopData.shop_rating;
          if (ratingVal !== null && ratingVal !== undefined && ratingVal !== '' && !Number.isNaN(parseFloat(ratingVal))) {
            row.shop_rating = String(ratingVal);
          }
          const reviewsVal = shopData.shop_reviews;
          if (reviewsVal !== null && reviewsVal !== undefined && reviewsVal !== '' && !Number.isNaN(parseInt(reviewsVal))) {
            row.shop_review_count = String(reviewsVal);
          }
          storeRowObjects.push(row);
        }
        if (storeRowObjects.length > 0) {
          // Batch-upsert all stores for this keyword in a single HTTP call.
          // The Worker's handleUpsert accepts { rows: [...] } and runs
          // INSERT ... ON DUPLICATE KEY UPDATE per row server-side, all
          // over one DB connection.
          try {
            await sheetsClient.upsertRowsBatch('etsy_stores', storeRowObjects);
            log('info', `🏬 Upserted ${storeRowObjects.length} shop(s) with today's ratings — refreshes existing rows, inserts new ones`);
          } catch (storeErr) {
            // Fall back to the old per-row path so a single bad shop row
            // can't block the whole keyword.
            log('warn', `⚠️ Batch store upsert failed (${storeErr.message}) — falling back to per-row`);
            let perRowOk = 0;
            for (const store of storeRowObjects) {
              try {
                await sheetsClient.upsertRow('etsy_stores', 'shop_name', store.shop_name, store);
                perRowOk++;
              } catch (_) { /* skip bad row */ }
            }
            log('info', `🏬 Upserted ${perRowOk}/${storeRowObjects.length} shop(s) via per-row fallback`);
          }
        }

        // Update keyword snapshot metadata only. snapshot_count now increments
        // on every run (snapshot-always model) rather than being a 0/1 flag.
        // 2026-04-17: We no longer write status='qualified'|'unqualified' here.
        // Qualification is per-user (different users have different thresholds)
        // and lives in pro_etsy_res_user_keyword_results, scoped by run_id.
        // Writing the verdict to the shared keywords row used to cause User A's
        // "unqualified" to silently overwrite User B's "qualified" on the same
        // seed. status now only carries data-freshness state ('pending' for
        // newly-discovered, 'validated' once Step 1 populates metrics), which
        // is what the gate actually needs.
        const priorCount = parseInt(kw.snapshot_count) || 0;
        // 2026-08-20: persist market size + ad share on the keyword row, not
        // just in the run-local stash. Run 4828 exposed why: only keywords
        // searched in THAT run had a competition figure, so 21 of 37 rows read
        // "—" and — because unknown market dropped out of the score — every
        // A-grade was an unmeasured keyword. Stored here, the figure survives
        // across runs and is shared with other users on the same keyword.
        // Both values are public search-page facts (no user/IP/geo).
        const kwUpdate = {
          snapshot_count: priorCount + 1,
          last_snapshot_at: now,
          status: 'validated'
        };
        if (result.totalResultsCount) {
          kwUpdate.market_size = result.totalResultsCount;
          kwUpdate.market_size_at = now;
        }
        if (typeof result.adCount === 'number' && result.rawSlots > 0) {
          kwUpdate.ad_share = (result.adCount / result.rawSlots).toFixed(4);
          kwUpdate.market_size_at = now;
        }
        await sheetsClient.updateRowByMatch('etsy_keywords', 'keyword_id', kw.keyword_id, kwUpdate);

        keywordsProcessed++;
        const qualSoFar = keywordResults.filter(r => r.qualified).length;
        log('success', `📸 Snapshot done for "${keyword}": ${listingRowObjects.length} listings captured (${seedListingCount} total for this seed) | ${qualSoFar} qualified so far`);

        // Post-mortem marker: write the last-completed keyword to storage so
        // if the service worker dies mid-loop anyway, we can see exactly
        // where it stopped on next reload instead of staring at a frozen log.
        try {
          await chrome.storage.local.set({
            step2LastProgress: {
              seedKeyword,
              lastCompletedKeyword: keyword,
              lastCompletedIndex: kwIndex,
              totalKeywords: selected.length,
              completedAt: new Date().toISOString()
            }
          });
        } catch (_) { /* storage failures should not block the loop */ }

        // Extra delay between keywords
        log('info', `💤 Brief cooldown before next keyword...`);
        await sleep(5000);

      } catch (err) {
        log('error', `Error with "${kw.keyword}": ${err.message}`);
      }
    }

    // ─── Niche qualification verdict ───
    const qualifiedCount = keywordResults.filter(r => r.qualified).length;
    const totalProcessed = keywordResults.length;
    // 2026-08-21 (audit #7): a keyword whose page never rendered tells us nothing
    // about the niche, but it used to sit in the denominator as a failed keyword,
    // dragging the whole seed towards NO-GO because Etsy throttled us.
    const failedToMeasure = keywordResults.filter(r => r.reason === 'extraction_failed').length;
    const measuredCount = totalProcessed - failedToMeasure;

    // 2026-08-21 (audit #4): the threshold now scales with how many keywords this
    // run actually searched. `min_qualified_keywords` defaults to 5, a number
    // chosen when "Keywords Per Run" was 20 — a 25% bar. At 8 keywords per run the
    // same 5 demands 63%, so lowering the run size silently tripled the
    // requirement and ended run 4854 (nurse) with an empty report at 3/8. The
    // configured value stays the ceiling, so nobody's runs get looser than they
    // asked for; the share reproduces the original design at 20 searched.
    const scaledMin = Math.max(2, Math.ceil(measuredCount * 0.25));
    const effectiveMin = Math.max(1, Math.min(minQualifiedKw, scaledMin));
    const nicheQualified = qualifiedCount >= effectiveMin;

    const verdictEmoji = nicheQualified ? '🟢' : '🔴';
    log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(nicheQualified ? 'success' : 'warn',
      `${verdictEmoji} NICHE VERDICT: ${qualifiedCount}/${measuredCount} keywords qualified (need ${effectiveMin}${effectiveMin !== minQualifiedKw ? `, scaled from your ${minQualifiedKw} because this run searched ${measuredCount}` : ''}) → ${nicheQualified ? 'GO — proceed to audit' : 'NO-GO — not enough entry points'}`);
    if (failedToMeasure > 0) {
      log('warn', `   ${failedToMeasure} keyword(s) could not be read at all (Etsy did not render the page) — left out of the count rather than counted against the niche.`);
    }
    log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // ─── Persist per-user verdicts to user_keyword_results ───
    // 2026-04-17: each user's qualified/unqualified verdict now lives here,
    // scoped by run_id. user_runs carries user_id, so two users researching
    // the same seed keep independent verdicts.
    // Unique key is (run_id, keyword_id) — upsert is idempotent on re-run.
    if (pipelineRunId && keywordResults.length > 0) {
      const userKwRows = keywordResults
        .filter(r => r.keyword_id)
        .map(r => ({
          run_id: pipelineRunId,
          keyword_id: r.keyword_id,
          beatable_slots: r.beatableSlots || 0,
          total_listings: r.totalListings || 0,
          qualified: r.qualified ? 1 : 0,
          reason: (r.reason || '').slice(0, 250),
        }));
      if (userKwRows.length > 0) {
        try {
          await sheetsClient.upsertRowsBatch('user_keyword_results', userKwRows);
          log('info', `💾 Persisted ${userKwRows.length} per-user verdict(s) to user_keyword_results (run_id=${pipelineRunId})`);
        } catch (e) {
          log('warn', `⚠️ Failed to write user_keyword_results (${e.message}) — Step 4 will fall back to in-memory verdict`);
        }
      }
    } else if (!pipelineRunId) {
      log('info', `ℹ️ No pipelineRunId — skipping user_keyword_results persistence (Step 4 will use in-memory verdict only)`);
    }

    if (!nicheQualified) {
      log('warn', `⏭️ Skipping Steps 3 & 4 — niche does not meet qualification criteria`);
      log('info', `💡 Only ${qualifiedCount} keywords had ${minBeatableSlots}+ shops with under ${maxShopReviewsBeatable} reviews in the top ${maxListingsPerKw}. The top spots are dominated by established shops.`);
    }

    // ─── Pre-audit ranking ───
    // 2026-04-18: audit_keyword_pct removed. Originally throttled Step 3 to a
    // fraction of qualified keywords because each audit consumed an eRank
    // credit. Step 3 is now Etsy-only, so the only constraint is total count.
    //
    // 2026-08-20: `audit_keyword_max` is GONE as a separate setting — Step 3 now
    // audits every keyword Step 2 searched, bounded by the one "Keywords Per
    // Run" number. Since scoring counts only this run's own audits, a keyword
    // that is searched but not audited cannot be graded at all: it costs ~45s of
    // Etsy crawling and yields an ungradeable row. Two caps also read as one
    // thing to the user (both say "keywords"), which is exactly the confusion
    // that had a run searching 8 and auditing 8 while the user believed the 8
    // meant listings.
    // A stored audit_keyword_max from an older install is still honoured when it
    // is SMALLER, so upgrading never silently lengthens someone's run.
    const legacyAuditMax = parseInt(
      (config && (config.audit_keyword_max != null) ? config.audit_keyword_max : null)
      ?? sheetConfig.audit_keyword_max
      ?? NaN
    );
    const auditMax = Math.max(1, Number.isFinite(legacyAuditMax)
      ? Math.min(legacyAuditMax, maxKeywords)
      : maxKeywords);

    const rankedResults = [...keywordResults]
      .filter(kr => kr.qualified || kr.beatableSlots > 0)
      .map(kr => {
        const kw = selected.find(k => String(k.keyword_id) === String(kr.keyword_id));
        const searches = kw ? (parseFloat(kw.avg_searches) || 0) : 0;
        const ratio = kr.totalListings > 0 ? kr.beatableSlots / kr.totalListings : 0;
        return { ...kr, searches, prelimScore: searches * ratio };
      })
      .sort((a, b) => b.prelimScore - a.prelimScore);

    const topKeywordIds = rankedResults.slice(0, auditMax).map(kr => String(kr.keyword_id));
    // 2026-08-21 (audit #6): this used to print after the skip notice, announcing
    // "7 qualified candidates → top 7 selected for Step 3 audit" for an audit that
    // never ran, on a run whose verdict line said 3 qualified. rankedResults also
    // includes keywords with SOME beatable slots, so "qualified candidates" was
    // the wrong word for it.
    if (nicheQualified) {
      log('info', `📊 Pre-audit ranking: ${rankedResults.length} candidate keyword(s) with at least one beatable slot → top ${topKeywordIds.length} queued for Step 3 (cap=${auditMax})`);
    }

    // Store qualification result for the pipeline to read.
    // snapshotCaptureDepth is included so Step 4 knows how many listings per
    // keyword were persisted (the structural signal) vs how many were audited.
    await chrome.storage.local.set({
      nicheQualification: {
        seedKeyword,
        nicheQualified,
        qualifiedCount,
        totalProcessed,
        // 2026-08-21: `minQualifiedKw` is the threshold that was ACTUALLY applied
        // (scaled to the number of keywords this run measured). Step 3 and the
        // report quote it, so it has to match the verdict line, not the raw
        // setting. The configured value rides along for transparency.
        minQualifiedKw: effectiveMin,
        minQualifiedKwConfigured: minQualifiedKw,
        measuredCount,
        failedToMeasure,
        maxShopReviewsBeatable,
        minBeatableSlots,
        maxListingsPerKw,
        snapshotCaptureDepth: SNAPSHOT_CAPTURE_DEPTH,
        keywordResults,
        topKeywordIds,
        auditCount: topKeywordIds.length,
        evaluatedAt: new Date().toISOString()
      }
    });

    await sheetsClient.logRun('etsy_search_snapshots', keywordsProcessed > 0 ? 'SUCCESS' : 'FAILED',
      keywordsProcessed, listingsFound, 0, '',
      `Keywords: ${keywordsProcessed}, Listings: ${listingsFound}, Qualified: ${qualifiedCount}/${totalProcessed}, Niche: ${nicheQualified ? 'GO' : 'NO-GO'}`);

    log('success', `🏁 Step 2 DONE! ${keywordsProcessed} keywords searched → ${listingsFound} listings captured → ${qualifiedCount}/${totalProcessed} keywords qualified`);
    return { keywordsProcessed, listingsFound, snapshotsTaken, nicheQualified, qualifiedCount, totalProcessed, keywordResults };

  } catch (err) {
    log('error', `Step 2 failed: ${err.message}`);
    await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', keywordsProcessed, listingsFound, 0, err.message, '');
    throw err;
  }
}

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
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

async function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('sendToTab timeout (30s)')); }
    }, 30000);
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

// ─── Device context (per-snapshot fingerprint) ───
// Collected from the service worker context. screen / navigator may not exist
// in the SW global scope on all Chrome versions, so each lookup is guarded.
// IP / country / city / asn / as_organization are NOT collected here — those
// are stamped server-side by the Worker from Cloudflare's request headers,
// which the client can't spoof.
function collectDeviceContext() {
  let userAgent = '';
  try { if (typeof navigator !== 'undefined' && navigator.userAgent) userAgent = String(navigator.userAgent); } catch {}

  let screenRes = '';
  try {
    if (typeof self !== 'undefined' && self.screen && self.screen.width) {
      screenRes = `${self.screen.width}x${self.screen.height}`;
    }
  } catch {}

  // getTimezoneOffset returns minutes WEST of UTC, so flip the sign so that
  // e.g. UTC+5 becomes 5.0 not -5.0.
  let tzOffset = 0;
  try { tzOffset = -(new Date().getTimezoneOffset()) / 60; } catch {}

  let hourLocal = 0;
  try { hourLocal = new Date().getHours(); } catch {}

  return {
    user_agent: userAgent.slice(0, 500),
    screen_resolution: screenRes.slice(0, 20),
    timezone_offset: Number.isFinite(tzOffset) ? tzOffset : 0,
    hour_local: hourLocal,
    is_logged_in: 0  // Placeholder — extension does not currently track Etsy login state
  };
}

// SHA-1 hex of an arbitrary string. Used for snapshot_hash so we can detect
// when Etsy returns the same ordered top-N for a keyword across runs.
async function sha1Hex(input) {
  try {
    const data = new TextEncoder().encode(String(input || ''));
    const buf = await crypto.subtle.digest('SHA-1', data);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch {
    return '';
  }
}
