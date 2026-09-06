// Step 3: Etsy Listing Audit Workflow
// Single-pass Etsy-only audit — no eRank credits consumed.
// Visits each listing's Etsy detail page to capture social proof signals:
//   in_carts, sold_24h, views_24h, rating, review_count, thumbnail_url,
//   favorites_count, photo_count, has_video, related_search_queries
// Also enriches shop data: total_sales, shop_location, shop_established,
//   is_star_seller, shop_team_size
//
// Scoped to the top N keywords ranked by Step 2's pre-audit ranking
// (topKeywordIds stored in chrome.storage.local.nicheQualification).
// Within each keyword, audits up to `max_listings_per_keyword` beatable
// listings (shops with fewer reviews than the beatable threshold).
//
// 2026-04-17: per-keyword audit cap is now config-driven. Was hardcoded to 5
// which ignored the user's popup setting (default 12). Now sourced from the
// same `max_listings_per_keyword` config key Step 2 + Step 4 use, so the
// user's single setting consistently drives audit depth AND report display.

export async function runErankListingAudit(sheetsClient, tabId, config, log, seedKeyword, shouldStop) {
  if (!shouldStop) shouldStop = () => false;
  const started = new Date().toISOString();
  let audited = 0;
  // 2026-08-08: listings whose page never rendered (Etsy throttling). We skip
  // writing an audit row for these so they stay retryable — counted here purely
  // so the run log can show how much throttling cost this run.
  let skippedBlank = 0;
  // 2026-08-21 (audit #15): pages that answered but arrived without Etsy's
  // structured-data block. Tracked separately so the next live run measures how
  // often this happens instead of us guessing at it.
  let skippedPartial = 0;

  try {
    // ─── Niche qualification gate ───
    // Step 3 only runs if Step 2 found enough qualified keywords.
    const { nicheQualification } = await chrome.storage.local.get('nicheQualification');
    if (nicheQualification && nicheQualification.seedKeyword === seedKeyword) {
      if (!nicheQualification.nicheQualified) {
        log('warn', `🚫 SKIPPING Step 3 — niche "${seedKeyword}" did not qualify in Step 2`);
        // Quote the same denominator the verdict used — totalProcessed still
        // includes keywords Etsy refused to render, which are excluded from the
        // gate since audit finding #7.
        const measured = nicheQualification.measuredCount != null
          ? nicheQualification.measuredCount
          : nicheQualification.totalProcessed;
        log('info', `💡 Only ${nicheQualification.qualifiedCount}/${measured} keywords had ${nicheQualification.minBeatableSlots || 3}+ page-one slots held by small shops (need ${nicheQualification.minQualifiedKw}). Page one belongs to established shops — auditing listings would not change that.`);
        await sheetsClient.logRun('erank_listing_audit', 'SKIPPED', 0, 0, 0, '',
          `Niche not qualified: ${nicheQualification.qualifiedCount}/${nicheQualification.totalProcessed} keywords`);
        return { audited: 0, skippedReason: 'niche_not_qualified' };
      }
      log('info', `✅ Niche qualified — ${nicheQualification.qualifiedCount} keywords passed, proceeding with audit`);
    }

    let sheetConfig;
    try { sheetConfig = await sheetsClient.readConfig(); } catch(e) { sheetConfig = {}; }

    // 2026-04-18: config priority inverted — popup (config) wins over DB
    // (sheetConfig). User changes in popup must take effect immediately
    // without needing a DB row purge.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = sheetConfig != null ? sheetConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };

    // 2026-08-08: hard floor of 7s between Etsy listing fetches — see the same
    // constant in etsy-snapshot-workflow.js. Enforced at point of use because
    // existing installs have 5 stored in chrome.storage / pro_etsy_res_config,
    // so changing only the popup default would leave them throttled. Etsy's
    // rate limiting is what drives the blank captures skipped below.
    const MIN_ETSY_DELAY_SEC = 7;
    const delay = Math.max(parseInt(cfg('delay_between_pages_sec', MIN_ETSY_DELAY_SEC)) || MIN_ETSY_DELAY_SEC, MIN_ETSY_DELAY_SEC) * 1000;

    // Per-keyword audit cap — matches what Step 2 uses for beatable-slots
    // evaluation and what Step 4 shows in the report listing card.
    const maxBeatablePerKw = Math.max(1, parseInt(cfg('max_listings_per_keyword', 12)) || 12);

    // Audit freshness window
    const FRESH_HOURS = parseInt(
      cfg('audit_freshness_hours', null)
      ?? cfg('data_staleness_hours', null)
      ?? cfg('listing_freshness_hours', null)
      ?? 48
    ) || 48;
    log('info', `🕒 Audit freshness window: ${FRESH_HOURS}h, max ${maxBeatablePerKw} listings/keyword`);

    // Load seed first so we can seed-scope all downstream reads.
    const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) {
      log('error', `Seed keyword "${seedKeyword}" not found`);
      await sheetsClient.logRun('erank_listing_audit', 'FAILED', 0, 0, 0, `Seed "${seedKeyword}" not found`, '');
      return { audited: 0 };
    }

    const seedId = String(seed.seed_id);
    // 2026-04-22: seed-scoped listings read (Worker JOINs through seed_keyword_map).
    // Previously unscoped → Worker OOM once listings table grew past ~5000 rows.
    // 2026-08-21: snapshot_date, not updated_at — see the note in
    // nes-scoring-workflow.js. This very module bumps updated_at on every row
    // for a listing when it writes rating/thumbnail back, so filtering on it
    // fed months-old captures back into the audit candidate list.
    const { rows: listings } = await sheetsClient.readSheet('etsy_listings', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'snapshot_date' });
    // 2026-08-21 (audit #10): no freshness filter on the KEYWORD rows. Step 2
    // dropped the same filter in April because it produced false-negative runs —
    // a seed rerun after 48h found none of its own keywords. Step 3 kept it, so a
    // keyword whose metadata row had not been touched recently silently dropped
    // out of audit scope. Keyword metadata age says nothing about Etsy.
    const { rows: keywords } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seedId });
    const seedKwIds = new Set(keywords.filter(k => String(k.seed_id) === seedId).map(k => String(k.keyword_id)));

    // ─── Scope to top keywords from pre-audit ranking ───
    // Step 2 ranked keywords by preliminary opportunity and stored the top N
    // IDs in nicheQualification.topKeywordIds. If available, only audit
    // listings from those keywords. Falls back to all seed keywords if the
    // pre-audit ranking is not available (e.g. Step 3 run standalone).
    const topKeywordIds = (nicheQualification && nicheQualification.topKeywordIds) || [];
    let effectiveKwIds;
    if (topKeywordIds.length > 0) {
      effectiveKwIds = new Set(topKeywordIds.filter(id => seedKwIds.has(id)));
      log('info', `🎯 Pre-audit ranking: scoping to ${effectiveKwIds.size} top keywords (of ${seedKwIds.size} total)`);
    } else {
      effectiveKwIds = seedKwIds;
      log('info', `🎯 No pre-audit ranking available — auditing all ${seedKwIds.size} keywords`);
    }
    log('info', `🎯 Seed "${seedKeyword}" has ${effectiveKwIds.size} keywords in scope — scanning listings`);

    // Beatable threshold
    // 2026-08-21 (audit #9): read through cfg() like every other setting. Reading
    // `config` directly skipped the DB config table, so a threshold set there was
    // ignored here while Steps 2 and 4 honoured it — three steps, two answers.
    const maxShopReviewsBeatable = parseInt(cfg('max_shop_reviews_beatable', 300)) || 300;

    // Load stores for beatable check — cap to 30-day freshness window so we
    // don't slurp the entire shared stores table (grows unbounded across all
    // users/seeds). 30 days is generous for shop review_count churn.
    // Order by last_updated DESC so the 5-page cap (5000 rows) hits the
    // freshest shops first — the ones most likely referenced by this run.
    const { rows: stores } = await sheetsClient.readSheet(
      'etsy_stores',
      {},
      { sinceHours: 24 * 7, sinceColumn: 'last_updated', orderBy: 'last_updated', order: 'DESC' }
    );
    const shopLookup = {};
    for (const s of stores) {
      const name = (s.shop_name || '').toLowerCase();
      if (name) shopLookup[name] = s;
    }

    // Build candidate pool scoped to effective keywords, dedup by listing_id
    const seenIds = new Set();
    const candidates = listings.filter(l => {
      if (!l.listing_id) return false;
      const id = String(l.listing_id);
      if (seenIds.has(id)) return false;
      if (!effectiveKwIds.has(String(l.keyword_id))) return false;
      seenIds.add(id);
      return true;
    });

    // Server-side keyword-agnostic freshness lookup
    let freshnessMap = {};
    if (candidates.length > 0) {
      try {
        const candidateIds = candidates.map(c => c.listing_id);
        const freshnessResp = await sheetsClient.getListingAuditFreshness(candidateIds);
        freshnessMap = freshnessResp.listings || {};
        const freshCount = Object.values(freshnessMap).filter(f => f && f.is_fresh).length;
        log('info', `♻️ Cross-keyword reuse check: ${freshCount}/${candidates.length} candidates already have a fresh audit (within ${freshnessResp.freshnessHours}h) — skipping those`);
      } catch (e) {
        log('warn', `⚠️ Audit-freshness lookup failed (${e.message}) — auditing every candidate`);
        freshnessMap = {};
      }
    }

    // Drop listings with fresh audits.
    // 2026-08-20: NOT when this run is scoring only its own captures. Scoring
    // counts audits performed in THIS run, so skipping a listing because it was
    // audited 20 hours ago would silently shrink the keyword's sample to
    // nothing. Under a run-scoped pipeline every candidate is opened fresh; the
    // reuse gate still applies to standalone/legacy runs, where it saves real
    // work. Costs page loads, buys a report whose numbers are all from one look.
    let runScoped = false;
    try {
      const rs = (await chrome.storage.local.get('nesRun')).nesRun;
      runScoped = !!(rs && rs.listingIdsByKw && Object.keys(rs.listingIdsByKw).length);
    } catch (e) { /* treat as not run-scoped */ }
    const unaudited = runScoped ? candidates : candidates.filter(l => {
      const f = freshnessMap[String(l.listing_id)];
      return !(f && f.is_fresh);
    });
    if (runScoped) {
      log('info', `🔄 Scoring this run's own captures — re-reading all ${candidates.length} candidate listing(s) rather than reusing older audits`);
    }

    // ─── Group by keyword, pick top beatable listings per keyword ───
    // Within each keyword, prioritize beatable shops (low review count),
    // then bestsellers, then by search position.
    const byKeyword = new Map();
    for (const l of unaudited) {
      const kid = String(l.keyword_id);
      if (!byKeyword.has(kid)) byKeyword.set(kid, []);
      byKeyword.get(kid).push(l);
    }

    // 2026-08-21 (audit #3): shop size comes from the listing row first — Step 2
    // writes what the search card showed for THIS run. The stores table is only a
    // fallback for rows captured before that column existed; its read is capped at
    // 5000 rows across every seed and user, so a run's own shops can be missing
    // from it entirely.
    //
    // The old code was `parseInt(...) || 1e9`, which sent a shop with ZERO reviews
    // — the most beatable shop there is — down the falsy branch and sorted it as
    // unbeatable. The audit was systematically skipping exactly the shops this
    // method exists to find. null now means unknown, and unknown is not beatable.
    const shopReviewsOf = (l) => {
      const own = l.shop_reviews;
      if (own !== null && own !== undefined && own !== '') {
        const n = parseInt(own);
        if (!Number.isNaN(n)) return n;
      }
      const st = shopLookup[(l.shop_name || '').toLowerCase()];
      if (st) {
        const n = parseInt(st.shop_review_count);
        if (!Number.isNaN(n)) return n;
      }
      return null;
    };

    // Sort each bucket: beatable first, then bestseller/popular, then position
    for (const bucket of byKeyword.values()) {
      bucket.sort((a, b) => {
        const aRevs = shopReviewsOf(a);
        const bRevs = shopReviewsOf(b);
        const aBeatable = (aRevs !== null && aRevs < maxShopReviewsBeatable) ? 1 : 0;
        const bBeatable = (bRevs !== null && bRevs < maxShopReviewsBeatable) ? 1 : 0;
        if (aBeatable !== bBeatable) return bBeatable - aBeatable;
        const aScore = (a.is_bestseller === 'TRUE' ? 100 : 0) + (a.is_popular_now === 'TRUE' ? 50 : 0);
        const bScore = (b.is_bestseller === 'TRUE' ? 100 : 0) + (b.is_popular_now === 'TRUE' ? 50 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return (parseInt(a.search_position) || 999) - (parseInt(b.search_position) || 999);
      });
    }

    // Build final audit batch: max `maxBeatablePerKw` per keyword (config-driven).
    //
    // 2026-08-20: the SEED gets a deeper sample. Runs 4848 and 4849 an hour apart
    // graded "school" as "Owned by giants" (4 of 12 slots) and then
    // "C · Tread carefully" (5 of 8) — the cap had been halved between them, so
    // the seed's own verdict moved with the setting rather than with Etsy. The
    // seed is the one keyword the seller actually asked about and the one whose
    // answer opens the report, so it is measured at a floor depth regardless of
    // the per-keyword cap. Everything else still honours the cap.
    const seedDepth = Math.max(maxBeatablePerKw, parseInt(cfg('nes_seed_min_listings', 16)) || 16);
    const seedNorm = String(seedKeyword).toLowerCase().trim();
    const kwTextById = new Map(keywords.map(k => [String(k.keyword_id), (k.keyword || '').toLowerCase().trim()]));
    const auditBatch = [];
    let seedDeepened = 0;
    for (const [kid, bucket] of byKeyword) {
      const isSeed = kwTextById.get(String(kid)) === seedNorm;
      const cap = isSeed ? seedDepth : maxBeatablePerKw;
      if (isSeed && bucket.length > maxBeatablePerKw) seedDeepened = Math.min(bucket.length, cap);
      auditBatch.push(...bucket.slice(0, cap));
    }
    if (seedDeepened) {
      log('info', `🎯 Reading ${seedDeepened} listings for the seed "${seedKeyword}" (deeper than the ${maxBeatablePerKw}/keyword cap) — its verdict opens the report, so it shouldn't move with the setting`);
    }

    if (auditBatch.length === 0) {
      log('warn', `😴 No unaudited listings left for "${seedKeyword}" — all caught up!`);
      await sheetsClient.logRun('erank_listing_audit', 'SKIPPED', 0, 0, 0, '', 'No unaudited listings');
      return { audited: 0 };
    }

    log('info', `🛍️ Auditing ${auditBatch.length} listings across ${byKeyword.size} keywords (max ${maxBeatablePerKw} per keyword)`);

    // ─── Single-pass Etsy-only audit ───
    const auditRowsBatch = [];
    let blankStreak = 0;   // consecutive un-rendered listing pages (CAPTCHA guard)
    for (let i = 0; i < auditBatch.length; i++) {
      if (shouldStop()) { log('warn', `🛑 Stop requested — halting listing audit`); break; }
      const listing = auditBatch[i];
      try {
        log('info', `🛍️ [${i + 1}/${auditBatch.length}] Auditing listing #${listing.listing_id}: "${(listing.title || '').substring(0, 45)}..."`);

        const etsyUrl = `https://www.etsy.com/listing/${listing.listing_id}`;
        await navigateTab(tabId, etsyUrl);
        await sleep(delay);

        let socialData = {};
        try {
          const result = await sendToTab(tabId, { action: 'extractEtsyListingDetail' });
          if (result.success) {
            socialData = result.data;
            const signals = [];
            if (socialData.in_carts) signals.push(`${socialData.in_carts} in carts`);
            if (socialData.sold_24h) signals.push(`${socialData.sold_24h} sold/24h`);
            if (socialData.views_24h) signals.push(`${socialData.views_24h} views/24h`);
            if (socialData.listing_rating) signals.push(`rating: ${socialData.listing_rating}`);
            if (socialData.listing_review_count) signals.push(`reviews: ${socialData.listing_review_count}`);
            if (socialData.urgency_text) signals.push(`urgency: "${socialData.urgency_text}"`);
            if (socialData.favorites_count) signals.push(`♥ ${socialData.favorites_count} favs`);
            if (socialData.photo_count) signals.push(`📷 ${socialData.photo_count} photos`);
            if (socialData.has_video) signals.push(`🎥 video`);
            log('info', `   👀 Social proof: ${signals.length > 0 ? signals.join(', ') : 'no hot signals detected'}`);
            if (socialData.related_search_queries && socialData.related_search_queries.length > 0) {
              log('info', `   🔗 Related queries: ${socialData.related_search_queries.join(', ')}`);
            }

            // Persist listing-level fields back to etsy_listings
            const updateFields = {};
            if (socialData.listing_rating) updateFields.rating = String(socialData.listing_rating);
            if (socialData.listing_review_count) updateFields.review_count = String(socialData.listing_review_count);
            if (socialData.urgency_text) updateFields.urgency_text = String(socialData.urgency_text);
            if (socialData.etsy_thumbnail_url) updateFields.thumbnail_url = String(socialData.etsy_thumbnail_url);

            if (Object.keys(updateFields).length > 0) {
              try {
                await sheetsClient.updateRowByMatch('etsy_listings', 'listing_id', listing.listing_id, updateFields);
                log('info', `   📝 Updated etsy_listings: rating=${updateFields.rating || '—'}, reviews=${updateFields.review_count || '—'}, thumb=${updateFields.thumbnail_url ? 'yes' : 'no'}`);
              } catch (ue) {
                log('warn', `   ⚠️ Could not update etsy_listings for #${listing.listing_id}: ${ue.message}`);
              }
            }
          }
        } catch (e) {
          log('warn', `   ⚠️ Etsy page hiccup for listing #${listing.listing_id}: ${e.message}`);
        }

        // Find parent keyword info
        const parentKw = keywords.find(k => String(k.keyword_id) === String(listing.keyword_id));
        const kwText = parentKw ? parentKw.keyword : '';

        // 2026-08-08: never persist an audit row for a page that didn't render.
        // Etsy has been throttling browsers hard (blank captures went from ~1%
        // in mid-July to 41% on Aug 7): navigation "succeeds" but the page
        // yields nothing, and we used to write a row with every social field
        // empty. The worker then treated that blank row as a completed audit
        // and skipped the listing for the entire 48h freshness window, making
        // the emptiness permanent. Worker v1.10.2 fixed the read side; this
        // stops producing the bad rows at the source, so the listing simply
        // stays un-audited and a later run retries it.
        // "Rendered" test matches the worker's exactly (thumbnail or photo
        // count) — verified present on 10/10 live Etsy listing pages.
        // 2026-08-21 (audit #15): a page can carry a thumbnail and still be missing
        // Etsy's structured-data block — that is how 39% of the school run's audits
        // ended up with no review date, which scoring then had to treat as unknown
        // freshness. Verified live on 2026-08-21: the block is in the SERVER HTML
        // of every listing page, so its absence means we were served a partial
        // page. Treat that exactly like a blank capture — write nothing, leave the
        // listing retryable — rather than banking a row we know is incomplete.
        // `!== false` so an older content script that does not send the flag still
        // behaves as before instead of skipping everything.
        const gotSomething = !!(socialData.etsy_thumbnail_url || socialData.photo_count);
        const partialPage = gotSomething && socialData.ld_product_found === false;
        const pageRendered = gotSomething && !partialPage;
        if (!pageRendered) {
          skippedBlank++;
          if (partialPage) skippedPartial++;
          // Only a page that returned NOTHING counts towards the CAPTCHA streak.
          // A partial page still proves Etsy is answering us, so a burst of them
          // must not abort a run that is otherwise working.
          if (!partialPage) blankStreak++;
          // 2026-08-20: stop when Etsy has clearly stopped serving pages.
          // The guard above already refuses to write empty rows, but the run
          // used to keep opening listings for another half hour against a
          // CAPTCHA wall — no data, and every request making the block worse.
          // Individual blanks are normal (throttling, deleted listings); five in
          // a row is a wall.
          if (blankStreak >= 5) {
            log('error', `🛑 ${blankStreak} listing pages in a row came back empty — Etsy is almost certainly showing a CAPTCHA or rate-limiting this browser. Stopping the audit instead of burning the rest of the run.`);
            log('warn', `   Open etsy.com in a normal tab, clear the CAPTCHA, then leave Etsy alone for a few hours. What was audited before this point is saved.`);
            break;
          }
          log('warn', `   ⏭️ Listing #${listing.listing_id} not saved — ${socialData.ld_product_found === false && (socialData.etsy_thumbnail_url || socialData.photo_count) ? 'Etsy served a partial page (no structured data)' : "page didn't load"} (likely Etsy throttling). Left un-audited so a later run retries it.`);
          continue;
        }
        blankStreak = 0;

        // Collect audit row for batch write after loop
        const now = new Date().toISOString();
        auditRowsBatch.push({
          listing_id: listing.listing_id,
          keyword_text: kwText,
          title: listing.title || '',
          erank_est_sales: '',
          erank_views: '',
          erank_daily_views: '',
          erank_monthly_views: '',
          erank_hearts: '',
          erank_conversion_rate: '',
          erank_title_length: '',
          erank_tags_count: '',
          erank_score: '',
          erank_listing_age: '',
          erank_qty: '',
          tags_list: '',
          in_carts: socialData.in_carts || '',
          sold_24h: socialData.sold_24h || '',
          views_24h: socialData.views_24h || '',
          etsy_thumbnail_url: socialData.etsy_thumbnail_url || '',
          favorites_count: socialData.favorites_count || '',
          photo_count: socialData.photo_count || '',
          has_video: socialData.has_video ? 1 : 0,
          // 2026-08-19 (v2.0.0): freshness-leg inputs. NULL/'' means we could not
          // read a review date — since 2026-08-21 scoring treats that as UNKNOWN
          // and scores the freshness leg neutral, never as "cold" (a scraper gap
          // used to publish live niches as "buyers left"). Requires the
          // 2026-08-19_nes_columns.sql migration (columns pass straight through
          // the Worker's insert; no worker change needed).
          last_review_date: socialData.last_review_date || null,
          // 2026-08-20: Etsy auto-renews a listing when it sells, so a recent
          // "Listed on" date is evidence of a recent sale — and it survives
          // when Etsy shows a basket badge instead of a sold count.
          listed_on: socialData.listed_on || null,
          recent_review_dates: socialData.recent_review_dates || '',
          audited_at: now
        });

        // Update shop-level data from listing detail page (if available)
        // 2026-04-19: extractor now captures real shop_rating + shop_review_count
        // from the seller-cred area (.rating-and-reviews-count__avg-rating /
        // .rating-and-reviews-count__reviews-count). Use those instead of
        // listing_rating which was a wrong-but-close proxy. Falls back to
        // listing_rating if shop_rating wasn't extractable on this page.
        const shopName = listing.shop_name;
        // is_star_seller is deliberately NOT part of this test: it is now written
        // as 0 too, and `false` would not qualify as "has a field" — a non-star
        // shop with no other captured field would never get its 0 recorded.
        const hasAnyShopField = socialData.shop_rating || socialData.shop_review_count
          || socialData.listing_rating || socialData.shop_total_sales || socialData.shop_location
          || socialData.shop_established || socialData.shop_team_size
          || socialData.is_star_seller !== undefined;
        if (shopName && hasAnyShopField) {
          const shopUpdate = {};
          // Prefer real shop_rating from seller cred. Fall back to listing rating only if absent.
          if (socialData.shop_rating) shopUpdate.shop_rating = String(socialData.shop_rating);
          else if (socialData.listing_rating) shopUpdate.shop_rating = String(socialData.listing_rating);
          if (socialData.shop_review_count) shopUpdate.shop_review_count = String(socialData.shop_review_count);
          if (socialData.shop_total_sales) shopUpdate.total_sales = String(socialData.shop_total_sales);
          if (socialData.shop_location) shopUpdate.shop_location = String(socialData.shop_location);
          if (socialData.shop_established) shopUpdate.shop_established = String(socialData.shop_established);
          // 2026-08-21 (audit #2): write 0 as well as 1. This only ever wrote 1,
          // so "not a star seller" was indistinguishable from "never audited" —
          // both NULL. Once Step 4 started scoring unknown neutrally, the KNOWN
          // set contained nothing but star sellers, so the share was 1.0 by
          // construction and every keyword with one audited star seller lost all
          // 5 non-star winnability points. We reach this line only after the
          // page rendered, so a missing badge is real evidence of absence.
          shopUpdate.is_star_seller = socialData.is_star_seller ? 1 : 0;
          if (socialData.shop_team_size) shopUpdate.shop_team_size = String(socialData.shop_team_size);
          try {
            await sheetsClient.updateRowByMatch('etsy_stores', 'shop_name', shopName, shopUpdate);
            const shopSignals = [];
            if (shopUpdate.shop_rating) shopSignals.push(`★ ${shopUpdate.shop_rating}`);
            if (shopUpdate.shop_review_count) shopSignals.push(`${shopUpdate.shop_review_count} reviews`);
            if (shopUpdate.total_sales) shopSignals.push(`sales: ${shopUpdate.total_sales}`);
            if (shopUpdate.shop_location) shopSignals.push(`from: ${shopUpdate.shop_location}`);
            if (shopUpdate.shop_established) shopSignals.push(`since: ${shopUpdate.shop_established}`);
            if (shopUpdate.is_star_seller) shopSignals.push('⭐ Star Seller');
            if (shopUpdate.shop_team_size) shopSignals.push(`team: ${shopUpdate.shop_team_size}`);
            log('info', `   🏬 Shop "${shopName}": ${shopSignals.join(', ')}`);
          } catch (shopErr) {
            log('warn', `   ⚠️ Could not update shop data for "${shopName}": ${shopErr.message}`);
          }
        }

        audited++;
        log('success', `   ✅ Listing #${listing.listing_id} audited — Etsy social proof captured`);

      } catch (err) {
        log('error', `Error auditing ${listing.listing_id}: ${err.message}`);
      }
    }

    // Batch write all collected audit rows in chunks of 10
    if (auditRowsBatch.length > 0) {
      // 2026-08-20: hand Step 4 the exact set of listings this run opened.
      try {
        const runKey = 'nesRun';
        const run = (await chrome.storage.local.get(runKey))[runKey] || { listingIdsByKw: {}, auditedIds: [] };
        const ids = new Set([...(run.auditedIds || []), ...auditRowsBatch.map(r => String(r.listing_id))]);
        run.auditedIds = [...ids];
        await chrome.storage.local.set({ [runKey]: run });
      } catch (e) { /* non-fatal — Step 4 falls back to the freshness window */ }

      log('info', `📝 Writing ${auditRowsBatch.length} audit rows in batches of 10...`);
      for (let i = 0; i < auditRowsBatch.length; i += 10) {
        try {
          await sheetsClient.appendRowsByName('listing_audit', auditRowsBatch.slice(i, i + 10));
        } catch (batchErr) {
          log('warn', `⚠️ Batch audit write failed at offset ${i} (${batchErr.message}) — falling back to per-row`);
          const chunk = auditRowsBatch.slice(i, i + 10);
          for (const row of chunk) {
            try {
              await sheetsClient.appendRowsByName('listing_audit', [row]);
            } catch (rowErr) {
              log('warn', `⚠️ Per-row audit write failed for listing #${row.listing_id}: ${rowErr.message}`);
            }
          }
        }
      }
    }

    // 2026-08-21 (audit #11): a run with nothing left to audit is not a failure.
    // Reserve FAILED for the catch block, which logs it separately.
    await sheetsClient.logRun('erank_listing_audit', 'SUCCESS',
      audited, audited, 0, '',
      `Etsy-only audit: ${audited} listings across ${byKeyword.size} keywords (no eRank credits used)`);

    // 2026-08-08: surface throttled/blank pages so a run that quietly lost half
    // its listings to Etsy rate-limiting is visible instead of looking "clean".
    if (skippedPartial > 0) {
      log('warn', `⚠️ ${skippedPartial} listing(s) skipped because Etsy served a partial page (no structured data, so no review dates). They stay un-audited and a later run retries them — nothing was recorded as "no reviews" on their behalf.`);
    }
    if (skippedBlank > 0) {
      log('warn', `⚠️ ${skippedBlank} listing(s) skipped because the page didn't load — Etsy is likely rate-limiting. They stay un-audited and will be retried on a later run. Raising "Delay between pages" in settings reduces this.`);
    }
    log('success', `🏁 Step 3 DONE! ${audited} listings audited across ${byKeyword.size} keywords`);
    return { audited };

  } catch (err) {
    log('error', `Step 3 failed: ${err.message}`);
    await sheetsClient.logRun('erank_listing_audit', 'FAILED', audited, audited, 0, err.message, '');
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
