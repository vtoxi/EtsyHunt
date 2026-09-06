// Step 4: Niche Verdict & Report Generation Workflow
// Reads all data, determines GO/NO-GO verdict based on keyword qualification,
// computes keyword-level opportunity scores, and generates an HTML report with
// an expandable keyword opportunity table (top beatable listings per keyword).
//
// 2026-04-09: concept clustering removed. Replaced with weighted keyword-level
// opportunity scoring (searches 25pts, beatable ratio 25pts, favorites 15pts,
// in-carts 15pts, sold/24h 10pts, competition 5pts, ad penalty -5pts).
// 2026-04-14: added favorites to scoring, demand health banner, redesigned
// listing cards with two-column layout (signals left, shop details right).

import { isJunkKeyword } from './etsy-snapshot-workflow.js';
import { EXT_NAME, extVersionLabel } from '../utils/brand.js';

export async function runNicheScoring(sheetsClient, config, log, seedKeyword, opts = {}) {
  const started = new Date().toISOString();

  // ─── Insufficient-keywords shortcut ───
  // Called by service-worker when Step 1 didn't surface enough keywords to
  // make Step 2 worth running. We produce a minimal NO-GO report: keyword
  // table + banner, no winners, no listings, no concepts, no audits. The
  // user sees exactly what came out of Step 1 and can either lower their
  // min_qualified_keywords threshold or try a different seed.
  if (opts && opts.insufficientKeywords) {
    try {
      return await runInsufficientKeywordsReport(sheetsClient, config, log, seedKeyword, opts);
    } catch (err) {
      log('error', `NO-GO short-report failed: ${err.message}`);
      return { verdict: 'NO-GO', qualifiedCount: 0, totalProcessed: 0, reportsGenerated: 0 };
    }
  }

  // pipelineRunId is passed in from service-worker. When present, Step 4's
  // fallback (no in-memory Step 2 blob) reads per-user verdicts from
  // user_keyword_results scoped to this run. When absent, falls back to "no
  // verdicts known" and treats every keyword as pending.
  const pipelineRunId = (opts && (opts.pipelineRunId || opts.runId)) || null;
  // 2026-05-01: Defensive contamination filter. When set, drops any listing /
  // audit row created before the current pipeline started — so prior runs'
  // bookmark/etc rows that happen to share keyword_ids with the current seed
  // (via uniq_keyword_ci + seed_keyword_map) cannot bleed into the report.
  // Only set on full-pipeline runs (Step 1→2→3→4 same session). Solo Step 4
  // runs leave it null, falling back to the 48h freshness window so historical
  // data still displays.
  const pipelineStartedAt = (opts && opts.pipelineStartedAt) || null;
  const pipelineStartMs   = pipelineStartedAt ? Date.parse(pipelineStartedAt) : null;

  try {
    // Load qualification result from Step 2
    const { nicheQualification } = await chrome.storage.local.get('nicheQualification');

    // Data freshness on Step 4 reads — sourced from pro_etsy_res_config so we
    // can change the threshold globally without redeploying. Verdict and
    // report must only consider data refreshed in the current run window —
    // otherwise stale qualified-status rows from old runs leak in and create
    // the GO/NO-GO contradiction Ali saw on 2026-04-07. Per-table freshness columns:
    //   etsy_keywords  → updated_at (ON UPDATE CURRENT_TIMESTAMP)
    //   etsy_listings  → updated_at (ON UPDATE CURRENT_TIMESTAMP)
    //   listing_audit  → audited_at (no updated_at; audited_at is bumped each run)
    //   etsy_stores    → updated_at if present, else falls back to no filter (stores are slow-changing)
    //   seed_keywords  → never filtered (we always need the seed)
    let dbConfig = {};
    try { dbConfig = await sheetsClient.readConfig(); } catch {}
    // 2026-04-18: popup wins over DB. Inverted from prior order so user
    // settings change in UI take effect without DB row purge.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = dbConfig != null ? dbConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };
    const FRESH_HOURS = parseInt(
      cfg('data_staleness_hours', null)
      ?? cfg('audit_freshness_hours', null)
      ?? 48
    ) || 48;
    log('info', `📥 Loading data for seed: "${seedKeyword}" (last ${FRESH_HOURS}h only)...`);
    // Post-m2m migration: resolve the seed first so we can scope the keywords
    // read by seed_id. The Worker rewrites `?seed_id=X` on the keywords table
    // into a JOIN through pro_etsy_res_seed_keyword_map and aliases
    // _skm.seed_id AS seed_id in the response.
    const seedsData = await sheetsClient.readSheet('seed_keywords');
    const seedsEarly = seedsData.rows;
    const seedEarly = seedsEarly.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    const seedIdEarly = seedEarly ? String(seedEarly.seed_id) : null;

    // 2026-04-22: stores table is shared across all users, unbounded growth
    // (~750k rows projected at 500 users). Previously read entire table each
    // Step 4 run. Now bounded by 30-day freshness window + uses readSheet's
    // auto-paginator (1000-row pages, Worker-safe).
    const readAllStores = async () => {
      // 7-day window + order by last_updated DESC + 5-page cap (5000 rows)
      // = freshest shops in the set. Enough for any single seed's shop
      // lookups without blowing Worker resource limits on the shared
      // pro_etsy_res_stores table (which has tens of thousands of rows
      // across all users).
      return await sheetsClient.readSheet(
        'etsy_stores',
        {},
        { sinceHours: 24 * 7, sinceColumn: 'last_updated', orderBy: 'last_updated', order: 'DESC' }
      );
    };

    // 2026-04-22: listings + listing_audit reads now seed-scoped via Worker's
    // JOIN-through-seed_keyword_map shim. Previously pulled all users' 48h
    // data just to filter to this seed client-side, which blew the Worker's
    // CPU/memory budget at modest user counts.
    const [keywordsData, listingsData, auditsData, storesData] = await Promise.all([
      seedIdEarly
        ? sheetsClient.readSheet('etsy_keywords', { seed_id: seedIdEarly }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' })
        : Promise.resolve({ rows: [] }),
      seedIdEarly
        ? sheetsClient.readSheet('etsy_listings', { seed_id: seedIdEarly }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' })
        : Promise.resolve({ rows: [] }),
      seedIdEarly
        ? sheetsClient.readSheet('listing_audit', { seed_id: seedIdEarly }, { sinceHours: FRESH_HOURS, sinceColumn: 'audited_at' })
        : Promise.resolve({ rows: [] }),
      readAllStores(),
    ]);

    const seeds = seedsEarly;
    const allKeywords = keywordsData.rows;
    const allListings = listingsData.rows;
    const allAudits = auditsData.rows;
    const allStores = storesData.rows;

    // Build shop lookup: shop_name → { shop_rating, shop_review_count }
    const shopLookup = {};
    for (const store of allStores) {
      const name = (store.shop_name || '').toLowerCase();
      if (name) shopLookup[name] = store;
    }

    // Find this seed
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) {
      log('error', `Seed "${seedKeyword}" not found`);
      return { verdict: 'ERROR', reportsGenerated: 0 };
    }

    const seedId = String(seed.seed_id);

    // Auto-assign category if missing
    const CATEGORY_PATTERNS = {
      healthcare: ['nurse', 'doctor', 'pharmacist', 'dentist', 'veterinarian', 'paramedic', 'doula', 'midwife', 'medical', 'hospital'],
      education: ['teacher', 'student', 'classroom', 'tutor', 'librarian', 'school', 'professor', 'homeschool'],
      mental_health: ['adhd', 'autism', 'anxiety', 'dyslexia', 'grief', 'sobriety', 'therapist', 'counselor', 'depression', 'mindfulness'],
      hospitality: ['airbnb', 'hotel', 'guest', 'host', 'vacation', 'rental', 'bnb'],
      spirituality: ['tarot', 'astrology', 'witchcraft', 'manifestation', 'meditation', 'crystal', 'chakra', 'zodiac'],
      wellness: ['affirmation', 'gratitude', 'self-care', 'yoga', 'fitness', 'workout', 'health', 'nutrition'],
      professional: ['realtor', 'accountant', 'hairstylist', 'esthetician', 'electrician', 'mechanic', 'bartender', 'firefighter', 'lawyer', 'consultant'],
      home_office: ['planner', 'tracker', 'organizer', 'spreadsheet', 'template', 'printable', 'productivity', 'budget'],
      pets: ['dog', 'cat', 'pet', 'puppy', 'kitten', 'animal', 'paw'],
      weddings: ['wedding', 'bride', 'groom', 'bridal', 'engagement', 'bachelorette', 'bridesmaid'],
      kids: ['baby', 'toddler', 'nursery', 'kids', 'children', 'newborn', 'infant'],
      seasonal: ['christmas', 'halloween', 'easter', 'valentine', 'thanksgiving', 'holiday', 'summer', 'winter'],
      crafts: ['svg', 'cricut', 'silhouette', 'craft', 'sewing', 'knitting', 'embroidery', 'crochet'],
      home_decor: ['wall art', 'home decor', 'farmhouse', 'modern', 'rustic', 'boho', 'minimalist', 'canvas', 'poster']
    };

    if (!seed.category || seed.category.trim() === '') {
      const kw = seedKeyword.toLowerCase();
      let cat = seedKeyword;
      for (const [c, patterns] of Object.entries(CATEGORY_PATTERNS)) {
        for (const p of patterns) {
          if (kw.includes(p)) { cat = c; break; }
        }
        if (cat !== seedKeyword) break;
      }
      seed.category = cat;
      await sheetsClient.updateRowByMatch('seed_keywords', 'seed_id', seed.seed_id, { category: cat });
      log('info', `🏷️ Auto-assigned category: "${cat}"`);
    }

    // Filter data to this seed
    const keywords = allKeywords.filter(k => String(k.seed_id) === seedId);
    const kwIds = new Set(keywords.map(k => String(k.keyword_id)));
    // 2026-05-01: Defensive contamination filter — when pipelineStartMs is
    // set, only consider listing rows captured during the current pipeline.
    // Picks created_at first, falls back to updated_at / snapshot_date so
    // older rows without created_at are still evaluable. Rows that fail
    // every timestamp check are dropped (safer than including them).
    const rowMs = (l) => {
      const t = l.created_at || l.updated_at || l.snapshot_date || '';
      const ms = t ? Date.parse(t) : NaN;
      return isFinite(ms) ? ms : NaN;
    };
    const passesRunFilter = (l) => {
      if (pipelineStartMs === null) return true;
      const ms = rowMs(l);
      // Allow a 60s grace window for clock skew between client and DB.
      return isFinite(ms) && ms >= (pipelineStartMs - 60 * 1000);
    };
    const rawListings = allListings.filter(l => kwIds.has(String(l.keyword_id)) && l.listing_id && /^\d+$/.test(String(l.listing_id).trim()));
    const listings = rawListings.filter(passesRunFilter);
    if (pipelineStartMs !== null) {
      const dropped = rawListings.length - listings.length;
      log('info', `🛡️ Run-scope filter: kept ${listings.length} listings captured during this pipeline (dropped ${dropped} pre-run rows)`);
    }

    // Deduplicate listings
    const seenListingIds = new Set();
    const dedupedListings = listings.filter(l => {
      const id = String(l.listing_id).trim();
      if (seenListingIds.has(id)) return false;
      seenListingIds.add(id);
      return true;
    });

    const listingIds = new Set(dedupedListings.map(l => String(l.listing_id)));
    const audits = allAudits.filter(a => listingIds.has(String(a.listing_id)));

    log('info', `📊 Data: ${keywords.length} keywords, ${dedupedListings.length} listings, ${audits.length} audits`);

    // ─── Determine verdict from qualification data ───
    // Issue 1 + verdict alignment: Step 2 is the single source of truth for the
    // GO/NO-GO verdict. If we have a fresh `nicheQualification` blob from this
    // run's Step 2, use it verbatim. If not (e.g. Step 4 run standalone), fall
    // back to recomputing from the 48h-filtered keyword statuses — but we no
    // longer trust historical 'qualified' statuses from runs > 48h old because
    // those rows have already been filtered out at the SQL level.
    const qual = nicheQualification && nicheQualification.seedKeyword === seedKeyword
      ? nicheQualification : null;

    if (qual) {
      log('info', `🔗 Using Step 2 qualification result: ${qual.qualifiedCount}/${qual.totalProcessed} qualified`);
    } else {
      log('warn', `⚠️ No Step 2 qualification snapshot found — falling back to fresh DB statuses (last ${FRESH_HOURS}h only)`);
    }

    // Fallback for standalone Step 4 runs (no in-memory Step 2 blob): read
    // per-user verdicts from user_keyword_results scoped by pipelineRunId.
    // If pipelineRunId is missing, we can't identify which user's verdicts
    // to load — we degrade to "no verdicts" rather than reading the shared
    // (and potentially cross-user corrupted) keywords.status column.
    // 2026-04-17: prior logic `keywords.filter(k => k.status === 'qualified')`
    // read from the shared table which has no user scoping. After the
    // per-user migration that column only holds 'pending'|'validated', so
    // this fallback has to come from user_keyword_results.
    let fallbackResults = [];
    if (!qual && pipelineRunId) {
      try {
        const { rows: ukwr } = await sheetsClient.readSheet('user_keyword_results', { run_id: pipelineRunId });
        fallbackResults = ukwr || [];
        log('info', `📥 Loaded ${fallbackResults.length} per-user verdict(s) from user_keyword_results (run_id=${pipelineRunId})`);
      } catch (e) {
        log('warn', `⚠️ Could not load user_keyword_results fallback (${e.message}) — treating all keywords as pending`);
      }
    }
    const qualifiedCount = qual
      ? qual.qualifiedCount
      : fallbackResults.filter(r => parseInt(r.qualified) === 1).length;
    const totalProcessed = qual
      ? qual.totalProcessed
      : fallbackResults.length;
    const minQualifiedKw = qual ? qual.minQualifiedKw : (config.min_qualified_keywords || 5);
    const maxShopReviewsBeatable = qual ? qual.maxShopReviewsBeatable : (config.max_shop_reviews_beatable || 300);
    const minBeatableSlots = qual ? qual.minBeatableSlots : (config.min_beatable_slots || 3);
    const maxListingsPerKw = qual ? qual.maxListingsPerKw : (config.max_listings_per_keyword || 12);
    // Winner score threshold: DB config overrides popup config, defaults to 50.
    // Each listing is scored on 10 equally-weighted signals (10 pts each, max 100).
    // Only listings with score >= this threshold render in the report.
    const minWinnerScore = Math.max(0, parseInt(cfg('min_winner_score', 50)) || 50);
    config.min_winner_score = minWinnerScore;  // propagate to computeKeywordOpportunityScores
    // keywordResults is the input for per-keyword qualification lookup in the
    // report + scoring function. Prefer in-memory Step 2 blob. Fallback is the
    // DB-loaded per-user verdicts so Step 4 run standalone still has data.
    const keywordResults = qual
      ? qual.keywordResults
      : fallbackResults.map(r => ({
          keyword_id: String(r.keyword_id),
          qualified: parseInt(r.qualified) === 1,
          beatableSlots: parseInt(r.beatable_slots) || 0,
          totalListings: parseInt(r.total_listings) || 0,
          reason: r.reason || '',
        }));

    // Verdict: prefer Step 2's explicit nicheQualified flag (if present) so we
    // never contradict it. Only re-derive when there's no Step 2 result at all.
    const nicheQualified = qual ? !!qual.nicheQualified : (qualifiedCount >= minQualifiedKw);
    const verdict = nicheQualified ? 'GO' : 'NO-GO';

    // ─── Report keyword filter (2026-06-04) ───
    // Reports surface ONLY keywords that pass the user's Step-1 thresholds:
    //   avg_searches >= min_monthly_searches  AND  competition <= max_competition
    // Over-threshold / under-volume keywords are still written to the DB by
    // Step 1 (and the metrics-only refresh path) — they're just hidden from the
    // HTML report, the dashboard report view (same file), and the runs-page KW
    // count (niche_scores.total_keywords). Mirrors the Step-1 accept logic
    // exactly: unknown/0 competition passes (it isn't "high"); searches below
    // the floor drop out. Qualified keywords always pass (they came through
    // Step 1's search+competition gate), so none of them can ever be hidden here.
    const _repMinSearches = parseFloat(cfg('min_monthly_searches', 450));
    const reportMinSearches = Number.isFinite(_repMinSearches) && _repMinSearches > 0 ? _repMinSearches : 0;
    const _repMaxComp = parseFloat(cfg('max_competition', 25000));
    const reportMaxCompetition = Number.isFinite(_repMaxComp) && _repMaxComp > 0 ? _repMaxComp : Infinity;
    const reportKeywords = keywords.filter(k => {
      const kw = (k.keyword || '').trim();
      if (!kw || isJunkKeyword(kw)) return false;
      const searches = parseFloat(k.avg_searches) || 0;
      const comp = parseFloat(k.competition) || 0; // unknown → 0 → passes (not "high")
      if (searches < reportMinSearches) return false;
      if (comp > reportMaxCompetition) return false;
      return true;
    });
    log('info', `🔎 Report filter: ${reportKeywords.length}/${keywords.length} keywords pass thresholds (searches ≥ ${reportMinSearches}, competition ≤ ${reportMaxCompetition === Infinity ? '∞' : reportMaxCompetition})`);

    // ─── Compute summary metrics ───
    // All keyword-derived aggregates use reportKeywords so the report tiles,
    // table, and stored counts stay internally consistent with the filter.
    const totalKw = reportKeywords.length;
    const totalListings = dedupedListings.length;
    const shops = new Set(dedupedListings.map(l => l.shop_name).filter(Boolean));
    const totalShops = shops.size;
    const avgPrice = dedupedListings.length > 0 ? dedupedListings.reduce((s, l) => s + (parseFloat(l.price) || 0), 0) / dedupedListings.length : 0;

    const competitions = reportKeywords.map(k => parseFloat(k.competition) || 0).filter(v => v > 0);
    const searchVols = reportKeywords.map(k => parseFloat(k.avg_searches) || 0).filter(v => v > 0);
    const avgComp = competitions.length > 0 ? competitions.reduce((s, v) => s + v, 0) / competitions.length : 0;
    const avgSearches = searchVols.length > 0 ? searchVols.reduce((s, v) => s + v, 0) / searchVols.length : 0;

    // Product type — use the user's selected filter from settings, not auto-detection
    const productType = config.product_type_filter === 'digital' ? 'digital'
                      : config.product_type_filter === 'physical' ? 'physical'
                      : 'any';

    // Weak competitors from audit data (only meaningful when audits exist)
    const scoredAudits = audits.filter(a => a.erank_score && parseInt(a.erank_score) > 0);
    const hasAudits = scoredAudits.length > 0;
    const weakPct = hasAudits
      ? (scoredAudits.filter(a => parseInt(a.erank_score) < 60).length / scoredAudits.length) * 100
      : 0;

    const verdictEmoji = nicheQualified ? '🟢' : '🔴';
    log('success', `${verdictEmoji} VERDICT for "${seedKeyword}": ${verdict} — ${qualifiedCount}/${totalProcessed} keywords qualified (need ${minQualifiedKw})`);

    const now = new Date().toISOString();

    // Write niche score — let MySQL AUTO_INCREMENT assign niche_id
    await sheetsClient.appendRowsByName('niche_scores', [{
      // 2026-07-01 (v1.3.0): stamp the exact run that produced this score so the
      // dashboard can link run→verdict directly (ns.run_id = user_runs.run_id)
      // instead of the fuzzy seed+user+time join that misses/bleeds. Requires
      // the niche_scores.run_id column (migration 2026-07-01). Worker forces
      // user_id, so a run_id can't cross users.
      run_id: pipelineRunId,
      category: seed.category,
      seed_keyword: seedKeyword,
      product_type: productType,
      total_keywords: totalKw,
      validated_keywords: qualifiedCount,
      total_listings: totalListings,
      total_shops: totalShops,
      avg_price: avgPrice.toFixed(2),
      avg_competition: avgComp.toFixed(0),
      avg_searches: avgSearches.toFixed(0),
      weak_competitor_pct: weakPct.toFixed(1),
      readiness_score: qualifiedCount + '/' + totalProcessed,
      status: verdict,
      report_url: '',
      scored_at: now
    }]);

    // ─── Keyword opportunity scoring ───
    // Replaces concept clustering. Each keyword gets a weighted composite
    // score so the report surfaces the best opportunities at a glance.
    // 2026-04-18: pass RAW seed-scoped `listings` (not dedupedListings).
    // Same listing_id can appear under multiple keywords (popular products
    // surface in many SERPs). Dedupe collapsed listing → one keyword owner;
    // other keywords lost the listing → their winner card showed "0 found".
    // Per-keyword filter inside the scorer reads l.keyword_id, so passing the
    // un-deduped list lets each keyword see its own rows.
    const scoredKeywords = computeKeywordOpportunityScores(
      reportKeywords, keywordResults, audits, listings, shopLookup, config
    );
    log('info', `📊 Keyword opportunity scores: ${scoredKeywords.length} keywords scored (top: ${scoredKeywords[0] ? scoredKeywords[0].keyword + ' = ' + scoredKeywords[0].totalScore.toFixed(1) : 'none'})`);


    // ─── Generate HTML report ───
    let reportsGenerated = 0;
    try {
      const productTypeFilter = config.product_type_filter || 'any';
      const niche = {
        seed_keyword: seedKeyword, category: seed.category, product_type: productType,
        total_keywords: totalKw, qualified_keywords: qualifiedCount, total_processed: totalProcessed,
        total_listings: totalListings, total_shops: totalShops,
        avg_price: avgPrice.toFixed(2), avg_competition: avgComp.toFixed(0),
        avg_searches: avgSearches.toFixed(0), weak_competitor_pct: weakPct.toFixed(1),
        has_audits: hasAudits,
        verdict, min_qualified_kw: minQualifiedKw,
        max_shop_reviews_beatable: maxShopReviewsBeatable, min_beatable_slots: minBeatableSlots,
        max_listings_per_kw: maxListingsPerKw,
        min_winner_score: minWinnerScore,
        product_type_filter: productTypeFilter,
      };

      const html = generateNicheReport(niche, keywords, dedupedListings, audits, keywordResults, shopLookup, scoredKeywords);
      const filename = `etsyhunt_${seedKeyword.replace(/\s+/g, '_')}_${now.split('T')[0]}.html`;
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      reportsGenerated = 1;
      log('success', `📄 Report downloaded: ${filename}`);
    } catch (e) {
      log('warn', `Report download failed: ${e.message}`);
      try {
        const niche = {
          seed_keyword: seedKeyword, category: seed.category, product_type: productType,
          total_keywords: totalKw, qualified_keywords: qualifiedCount, total_processed: totalProcessed,
          total_listings: totalListings, total_shops: totalShops,
          avg_price: avgPrice.toFixed(2), avg_competition: avgComp.toFixed(0),
          avg_searches: avgSearches.toFixed(0), weak_competitor_pct: weakPct.toFixed(1),
          has_audits: hasAudits,
          verdict, min_qualified_kw: minQualifiedKw,
          max_shop_reviews_beatable: maxShopReviewsBeatable, min_beatable_slots: minBeatableSlots,
          max_listings_per_kw: maxListingsPerKw,
          min_winner_score: minWinnerScore,
          product_type_filter: productTypeFilter,
        };
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(
          generateNicheReport(niche, keywords, dedupedListings, audits, keywordResults, shopLookup, scoredKeywords));
        await chrome.tabs.create({ url: dataUrl, active: true });
        reportsGenerated = 1;
      } catch (e2) {
        log('error', `Could not open report: ${e2.message}`);
      }
    }

    await sheetsClient.logRun('niche_scoring', 'SUCCESS', 1, 1, 0, '',
      `Seed: "${seedKeyword}", Verdict: ${verdict}, Qualified: ${qualifiedCount}/${totalProcessed}`);

    log('success', `🏁 Step 4 DONE! "${seedKeyword}" → ${verdict}`);
    return { verdict, qualifiedCount, totalProcessed, reportsGenerated };

  } catch (err) {
    log('error', `Step 4 failed: ${err.message}`);
    await sheetsClient.logRun('niche_scoring', 'FAILED', 0, 0, 0, err.message, '');
    throw err;
  }
}

// ─── Report Generation ───
// Redesigned 2026-04-07: combined keyword table, listing thumbnails, star ratings,
// color-coded eRank score badges, stacked price column, chip-style urgency signals.
// All values come from real DB fields. Missing values render as em-dash (—) — no
// mock/placeholder data anywhere.
// ─── Keyword Opportunity Scoring ───
// Weighted composite score per keyword. Replaces concept clustering.
// Weights: searches 25, beatable 25, favorites 15, in-carts 15, sold/24h 10, competition 5, ad penalty -5.
function computeKeywordOpportunityScores(keywords, keywordResults, audits, dedupedListings, shopLookup, config) {
  const maxShopReviewsBeatable = parseInt(config.max_shop_reviews_beatable || 300);

  const median = (arr) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const scored = keywords
    .filter(k => {
      const kw = (k.keyword || '').trim();
      return kw.length > 0 && !isJunkKeyword(kw);
    })
    .map(k => {
      const kwText = (k.keyword || '').trim();
      const kwId = String(k.keyword_id);
      const searches = parseFloat(k.avg_searches) || 0;
      const competition = parseFloat(k.competition) || 0;

      // Find qualification data from Step 2
      const kr = (keywordResults || []).find(r =>
        String(r.keyword_id) === kwId ||
        (r.keyword || '').toLowerCase().trim() === kwText.toLowerCase()
      );

      const beatableSlots = kr ? (kr.beatableSlots || 0) : 0;
      const totalListings = kr ? (kr.totalListings || 0) : 0;
      const beatableRatio = totalListings > 0 ? beatableSlots / totalListings : 0;
      // 2026-04-17: per-user migration — shared keywords.status no longer
      // carries qualified/unqualified. If kr lookup misses, verdict is unknown
      // (treat as not-qualified for the report — no false positives).
      const qualified = kr ? !!kr.qualified : false;

      // Get listings for this keyword and dedupe PER-KEYWORD by listing_id.
      // 2026-04-19: Step 2 INSERTs a fresh row for every (listing_id, keyword_id)
      // on every run, so the etsy_listings table has N rows per listing per
      // keyword where N = number of past runs. Without per-keyword dedupe the
      // same listing renders as N cards. Keep the most-recent row (highest
      // updated_at / snapshot_date / created_at, in that preference order) so
      // we get fresh metrics + urgency_text + thumbnail.
      const rawKwListings = dedupedListings.filter(l => String(l.keyword_id) === kwId);
      const latestByListingId = new Map();
      const rowTime = (l) => {
        const t = l.updated_at || l.snapshot_date || l.created_at || '';
        return String(t);
      };
      for (const l of rawKwListings) {
        const id = String(l.listing_id);
        const prev = latestByListingId.get(id);
        if (!prev || rowTime(l) > rowTime(prev)) {
          latestByListingId.set(id, l);
        }
      }
      const kwListings = Array.from(latestByListingId.values());
      const kwListingIds = new Set(kwListings.map(l => String(l.listing_id)));
      const kwAudits = audits.filter(a => kwListingIds.has(String(a.listing_id)));

      // Median in-carts, sold/24h, and favorites from audits
      const inCartsValues = kwAudits.map(a => parseInt(a.in_carts)).filter(x => !isNaN(x) && x >= 0);
      const sold24Values = kwAudits.map(a => parseInt(a.sold_24h)).filter(x => !isNaN(x) && x >= 0);
      const favValues = kwAudits.map(a => parseInt(a.favorites_count)).filter(x => !isNaN(x) && x >= 0);

      const medianInCarts = median(inCartsValues);
      const medianSold24 = median(sold24Values);
      const medianFavorites = median(favValues);

      // Ad count
      const adCount = kwListings.filter(l =>
        l.is_ad === 'TRUE' || l.is_ad === true || l.promoted === 'TRUE' || l.promoted === true
      ).length;
      const adRatio = kwListings.length > 0 ? adCount / kwListings.length : 0;

      // Normalize each component to 0-1 range, then apply weights
      // Weights: searches 25, beatable 25, favorites 15, in-carts 15, sold/24h 10, competition 5, ad penalty -5
      const searchScore = Math.min(1, Math.log10(Math.max(1, searches)) / 4) * 25;
      const beatableScore = beatableRatio * 25;
      const favScore = Math.min(1, medianFavorites / 200) * 15;
      const inCartsScore = Math.min(1, medianInCarts / 50) * 15;
      const sold24Score = Math.min(1, medianSold24 / 10) * 10;
      const compScore = (1 - Math.min(1, competition / 50000)) * 5;
      const adPenalty = adRatio * 5;

      const totalScore = searchScore + beatableScore + favScore + inCartsScore + sold24Score + compScore - adPenalty;

      // ─── Per-listing winner score ───
      // 2026-04-17: replaces "top N beatable listings" slice with a 10-signal
      // equally-weighted score (max 100). Listings scoring >= min_winner_score
      // (config, default 50) are shown in the report. Non-beatable shops
      // naturally drop out: they miss the +10 beatable signal, capping them
      // at 90, and usually miss several other signals → they rarely clear 50.
      // No fixed top-N slice — report shows however many listings qualify.
      const minWinnerScore = Math.max(0, parseInt(config.min_winner_score) || 50);
      const auditByListingId = {};
      for (const a of kwAudits) {
        auditByListingId[String(a.listing_id)] = a;
      }

      const scoreListing = (l) => {
        const audit = auditByListingId[String(l.listing_id)] || {};
        const shop = shopLookup[(l.shop_name || '').toLowerCase()] || {};
        const shopRevs = parseInt(shop.shop_review_count);
        const isBeatable = !isNaN(shopRevs) && shopRevs < maxShopReviewsBeatable;

        const hit = {};
        // 1. Bestseller badge
        hit.bestseller = (l.is_bestseller === 'TRUE' || l.is_bestseller === true) ? 10 : 0;
        // 2. Popular Now badge
        hit.popular_now = (l.is_popular_now === 'TRUE' || l.is_popular_now === true) ? 10 : 0;
        // 3. Favorites >= 5 (from Step 3 audit)
        const favs = parseInt(audit.favorites_count);
        hit.favorites = (!isNaN(favs) && favs >= 5) ? 10 : 0;
        // 4. In carts > 0
        const inCarts = parseInt(audit.in_carts);
        hit.in_carts = (!isNaN(inCarts) && inCarts > 0) ? 10 : 0;
        // 5. Sold in last 24h > 0
        const sold = parseInt(audit.sold_24h);
        hit.sold_24h = (!isNaN(sold) && sold > 0) ? 10 : 0;
        // 6. Urgency text present on listing (Step 3 writes to etsy_listings.urgency_text)
        hit.urgency = ((l.urgency_text || '').trim().length > 0) ? 10 : 0;
        // 7. Listing rating >= 4.5 (prefer listing row; fall back to shop rating)
        const rating = parseFloat(l.rating) || parseFloat(shop.shop_rating) || 0;
        hit.rating = (rating >= 4.5) ? 10 : 0;
        // 8. Has video (Step 3 audit captures this)
        hit.video = (parseInt(audit.has_video) === 1) ? 10 : 0;
        // 9. Photos >= 7
        const photos = parseInt(audit.photo_count);
        hit.photos = (!isNaN(photos) && photos >= 7) ? 10 : 0;
        // 10. Shop is beatable (reviews < threshold)
        hit.beatable = isBeatable ? 10 : 0;

        const score = hit.bestseller + hit.popular_now + hit.favorites + hit.in_carts
                    + hit.sold_24h + hit.urgency + hit.rating + hit.video + hit.photos + hit.beatable;
        return { score, hit };
      };

      // 2026-05-01: Render the same audited slice the qualification math
      // ran on (top maxListingsPerKw by search_position). Score every row,
      // sort by score desc with position as tiebreak, and KEEP all of them.
      // The pass/fail threshold is now a per-card visual badge instead of a
      // hard cutoff, so users can see what scored and what didn't (the prior
      // behavior of hiding sub-50 listings was confusing when the kw header
      // claimed e.g. "8/12 beatable" but only 3 listings rendered).
      const maxListingsPerKw = parseInt(config.max_listings_per_keyword) || 12;
      const auditWindow = kwListings
        .slice()
        .sort((a, b) => (parseInt(a.search_position) || 999) - (parseInt(b.search_position) || 999))
        .slice(0, maxListingsPerKw);

      const beatableListings = auditWindow
        .map(l => {
          const { score, hit } = scoreListing(l);
          return Object.assign({}, l, { _winnerScore: score, _winnerHit: hit });
        })
        .sort((a, b) => {
          if (b._winnerScore !== a._winnerScore) return b._winnerScore - a._winnerScore;
          return (parseInt(a.search_position) || 999) - (parseInt(b.search_position) || 999);
        });

      return {
        keyword_id: kwId,
        keyword: kwText,
        searches,
        competition,
        click_rate: k.click_rate,
        beatableSlots,
        totalListings,
        beatableRatio,
        qualified,
        medianInCarts,
        medianSold24,
        medianFavorites,
        adCount,
        adRatio,
        totalScore: Math.max(0, totalScore),
        beatableListings,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  return scored;
}

function generateNicheReport(niche, nicheKeywords, nicheListings, nicheAudits, keywordResults, shopLookup = {}, scoredKeywords = []) {
  const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MUTED = '<span class="muted">—</span>';

  const formatClickRate = (val) => {
    if (!val && val !== 0) return '';
    const str = String(val).replace('%', '').trim();
    let num = parseFloat(str);
    if (isNaN(num) || num === 0) return '';
    if (num > 999) num = num / 100;
    return num.toFixed(0) + '%';
  };

  const isValidListing = (l) => {
    if (!l.listing_id || !/^\d+$/.test(String(l.listing_id).trim())) return false;
    const title = (l.title || '').trim();
    if (title.length < 3) return false;
    if (/^\d+(\.\d+)?$/.test(title)) return false;
    return true;
  };

  // Star row: "★★★★☆ 4.6"
  const starsHtml = (rating) => {
    const r = parseFloat(rating);
    if (isNaN(r) || r <= 0) return '';
    let full = Math.floor(r);
    const frac = r - full;
    let half = 0;
    if (frac >= 0.75) full += 1;
    else if (frac >= 0.25) half = 1;
    const empty = Math.max(0, 5 - full - half);
    const stars = '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(empty);
    return `<span class="stars-row"><span class="stars">${stars}</span> <span class="stars-num">${r.toFixed(1)}</span></span>`;
  };

  // eRank score badge — green/amber/red
  const scoreBadge = (score) => {
    const s = parseInt(score);
    if (isNaN(s) || s <= 0) return '';
    const cls = s >= 60 ? 'score-good' : s >= 40 ? 'score-mid' : 'score-bad';
    return `<span class="score-badge ${cls}">${s}</span>`;
  };

  // Friendly age string from eRank "X years Y months" / "X months" raw text.
  // 2026-04-08: the extractor's "Age:" regex is greedy and often grabs the
  // following line (e.g. "2 years 3 months Quantity 1"). Pick out ONLY the
  // years/months fragment so the column shows the real age.
  const formatAge = (raw) => {
    if (!raw) return '';
    const t = String(raw).trim();
    if (!t) return '';
    // Try canonical eRank patterns in priority order
    const patterns = [
      /(\d+\s*years?\s+\d+\s*months?)/i,
      /(\d+\s*years?)/i,
      /(\d+\s*months?)/i,
      /(\d+\s*weeks?)/i,
      /(\d+\s*days?)/i,
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (m) return m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    }
    // Fallback — first 20 chars so junk like "Quantity 1\nTags 13" doesn't leak
    return t.length > 20 ? t.substring(0, 20) + '…' : t;
  };

  // Format an integer with commas; returns '' on bad input
  const formatInt = (val) => {
    const n = parseInt(val);
    if (isNaN(n) || n <= 0) return '';
    return n.toLocaleString();
  };

  // ─── Verdict ───
  const isGo = niche.verdict === 'GO';
  const verdictColor = isGo ? '#10b981' : '#ef4444';
  const verdictBg = isGo
    ? 'linear-gradient(135deg,#10b981 0%,#059669 100%)'
    : 'linear-gradient(135deg,#ef4444 0%,#dc2626 100%)';
  const verdictIcon = isGo ? '✓' : '✗';
  const verdictShadow = isGo ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)';

  const qualRate = niche.total_processed > 0 ? (niche.qualified_keywords / niche.total_processed) : 0;
  const insufficientData = niche.total_processed < niche.min_qualified_kw;

  // ─── Plain English explanation ───
  let explanation = '';
  if (isGo) {
    explanation = `This niche has <strong>${niche.qualified_keywords}</strong> qualified keywords out of <strong>${niche.total_processed}</strong> evaluated `
      + `(you needed at least ${niche.min_qualified_kw}). `
      + `In these keywords, we found smaller shops (under ${niche.max_shop_reviews_beatable} total shop reviews) ranking in the `
      + `top ${niche.max_listings_per_kw} search results, which means a new shop can realistically compete for visibility. `
      + `The average listing price is <strong>$${niche.avg_price}</strong> and average monthly searches are <strong>${niche.avg_searches}</strong>.`;
  } else if (insufficientData && qualRate >= 0.7) {
    explanation = `<strong>Not enough keywords were found to make a confident decision.</strong> `
      + `Only <strong>${niche.total_processed}</strong> keywords were evaluated (you need at least ${niche.min_qualified_kw}), `
      + `and <strong>${niche.qualified_keywords}</strong> of those qualified (${Math.round(qualRate * 100)}% pass rate — which is actually strong). `
      + `The issue is that Step 1 didn't find enough qualifying keywords for this seed. `
      + `<strong>Try running Step 1 again</strong>, or lower the search volume / raise competition thresholds in settings to let more keywords through.`;
  } else {
    const failedCount = niche.total_processed - niche.qualified_keywords;
    explanation = `Only <strong>${niche.qualified_keywords}</strong> out of <strong>${niche.total_processed}</strong> keywords had room for newer shops `
      + `(you needed at least ${niche.min_qualified_kw}). `
      + `For a keyword to qualify, at least ${niche.min_beatable_slots} of the top ${niche.max_listings_per_kw} listings must be from shops `
      + `with under ${niche.max_shop_reviews_beatable} total reviews. `
      + `<strong>${failedCount}</strong> keyword${failedCount !== 1 ? 's' : ''} had their top results dominated by established shops with thousands of reviews, `
      + `making it very difficult for a new shop to break into those search results.`;
  }

  // ─── Combined keyword table (qualification + metrics merged) ───
  // Build keyword → qualification details lookup from Step 2 in-memory data
  const kwResults = keywordResults || [];
  const kwQualLookup = {};
  for (const kr of kwResults) {
    kwQualLookup[(kr.keyword || '').toLowerCase().trim()] = {
      qualified: !!kr.qualified,
      beatableSlots: kr.beatableSlots,
      totalListings: kr.totalListings,
      reason: kr.reason || '',
    };
  }

  // Sort the keywords list by "opportunity" — qualified (biggest beatable/totalListings
  // ratio) first, then by search volume. This surfaces the most winnable keywords
  // at the top of the keyword table. (2026-04-08: was sorted by avg_searches only.)
  const opportunityScore = (k) => {
    const lk = kwQualLookup[(k.keyword || '').toLowerCase().trim()];
    const searches = parseFloat(k.avg_searches) || 0;
    if (lk) {
      const bs = lk.beatableSlots != null ? lk.beatableSlots : 0;
      const bt = lk.totalListings != null ? lk.totalListings : 1;
      const ratio = bt > 0 ? bs / bt : 0;
      const qBoost = lk.qualified ? 1000000 : 0;
      // qualified first, then by beatable ratio, then by search volume
      return qBoost + ratio * 10000 + searches;
    }
    return searches;
  };
  const sortedKw = [...nicheKeywords].sort((a, b) => opportunityScore(b) - opportunityScore(a));
  const cleanKeywords = sortedKw.filter(k => {
    const kw = (k.keyword || '').trim();
    if (!kw || kw.length < 3 || kw.length > 60) return false;
    if (/^["'\u201c]/.test(kw)) return false;
    // 2026-04-08: keep the keywords table in sync with the concept pool — junk
    // that already landed in the DB should not render as a row the user sees.
    if (isJunkKeyword(kw)) return false;
    const searches = parseFloat(k.avg_searches);
    const comp = parseFloat(k.competition);
    if ((!searches || searches === 0) && (!comp || comp === 0)) return false;
    return true;
  });

  // (All Keywords + Top Listings tables removed — 2026-04-10)
  // All data is now shown in the Keyword Opportunities table with expandable
  // beatable listings per keyword.

  // ─── Keyword Opportunity Table (expandable rows) ───
  // Each keyword row expands to show its winning listings.
  // First row auto-expanded, others collapsed with ▶ arrow.
  const maxListingsPerKw = parseInt(niche.max_listings_per_kw) || 12;
  const maxShopReviewsBeatable = parseInt(niche.max_shop_reviews_beatable) || 300;
  // Winner threshold (config-driven). Used in detail-header text.
  const minWinnerScoreCfg = Math.max(0, parseInt(niche.min_winner_score) || 50);
  // Product type filter for Etsy search links in the report
  const ptf = niche.product_type_filter || 'any';
  const ptfParam = ptf === 'digital' ? '&instant_download=true'
                 : ptf === 'physical' ? '&instant_download=false'
                 : '';
  const oppTableRows = scoredKeywords.slice(0, 30).map((sk, idx) => {
    const etsySearchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(sk.keyword)}${ptfParam}`;
    const searchesDisp = sk.searches > 0 ? sk.searches.toLocaleString() : '';
    const compDisp = sk.competition > 0 ? sk.competition.toLocaleString() : '';
    const ctrDisp = formatClickRate(sk.click_rate);
    const scoreDisp = sk.totalScore.toFixed(1);
    const scoreCls = sk.totalScore >= 50 ? 'opp-high' : sk.totalScore >= 25 ? 'opp-mid' : 'opp-low';

    // Beatable bar
    const bs = sk.beatableSlots;
    const bt = sk.totalListings || parseInt(niche.max_listings_per_kw) || 12;
    const ratio = bt > 0 ? bs / bt : 0;
    const barColor = ratio >= 0.5 ? '#10b981' : ratio >= 0.25 ? '#f59e0b' : '#ef4444';
    const beatableHtml = `<div class="beatable-cell">`
      + `<div class="beatable-text">${bs}<span class="beatable-of">/${bt}</span></div>`
      + `<div class="beatable-bar"><div class="beatable-fill" style="width:${(ratio * 100).toFixed(0)}%;background:${barColor}"></div></div>`
      + `</div>`;

    const pill = sk.qualified
      ? '<span class="pill pill-go">Qualified</span>'
      : '<span class="pill pill-nogo">Unqualified</span>';

    const favsDisp = sk.medianFavorites > 0 ? sk.medianFavorites.toLocaleString() : MUTED;
    const inCartsDisp = sk.medianInCarts > 0 ? sk.medianInCarts.toLocaleString() : MUTED;
    const sold24Disp = sk.medianSold24 > 0 ? sk.medianSold24.toLocaleString() : MUTED;

    const isExpanded = idx === 0;
    const arrowCls = isExpanded ? 'expanded' : '';

    // Build beatable listings sub-rows — two-column layout:
    // Left: thumbnail, title, position, price, badges, urgency signals, favorites, photos/video
    // Right: shop name (linked), total sales, established year, Star Seller, team size, location
    let detailHtml = '';
    if (sk.beatableListings && sk.beatableListings.length > 0) {
      // Build audit lookup by listing_id for fast matching
      const auditLookup = {};
      for (const a of nicheAudits) {
        auditLookup[String(a.listing_id)] = a;
      }

      const listingCards = sk.beatableListings.map(l => {
        const title = (l.title || '').trim();
        const shop = (l.shop_name || '').trim();
        const price = parseFloat(l.price);
        const listingUrl = l.etsy_url || `https://www.etsy.com/listing/${l.listing_id}`;
        const shopData = shopLookup[shop.toLowerCase()] || {};
        const shopRevs = parseInt(shopData.shop_review_count) || 0;
        // Shop rating: prefer listing-level rating (set by Step 3 on etsy_listings)
        // because etsy_stores.shop_rating often isn't populated by Step 2
        const shopRat = parseFloat(l.rating) || parseFloat(shopData.shop_rating) || 0;
        const shopSales = parseInt(shopData.total_sales) || 0;
        const shopLocation = (shopData.shop_location || '').trim();
        const shopEstablished = (shopData.shop_established || '').trim();
        const shopStarSeller = parseInt(shopData.is_star_seller) === 1;
        const shopTeamSize = parseInt(shopData.shop_team_size) || 0;
        const pos = parseInt(l.search_position);
        const posHtml = !isNaN(pos) && pos > 0 ? `<span class="pos-badge">#${pos}</span>` : '';

        // Audit data for this listing
        const audit = auditLookup[String(l.listing_id)] || {};
        const inCarts = parseInt(audit.in_carts);
        const sold24 = parseInt(audit.sold_24h);
        const views24 = parseInt(audit.views_24h);
        const favCount = parseInt(audit.favorites_count);
        const photoCount = parseInt(audit.photo_count);
        const hasVideo = parseInt(audit.has_video) === 1;
        // Urgency text from etsy_listings (set by Step 3), e.g. "Low in stock, only 4 left"
        const urgencyText = (l.urgency_text || '').trim();

        // Thumbnail
        const thumbUrl = (l.thumbnail_url || '').trim();
        let thumbHtml;
        if (thumbUrl && /^https?:\/\//.test(thumbUrl)) {
          thumbHtml = `<div class="detail-thumb"><img src="${esc(thumbUrl)}" alt="" loading="lazy"></div>`;
        } else {
          const initial = esc((title || '?').charAt(0).toUpperCase());
          thumbHtml = `<div class="detail-thumb detail-thumb-placeholder">${initial}</div>`;
        }

        // Badges
        const badges = [];
        if (l.is_bestseller === 'TRUE' || l.is_bestseller === true) badges.push('<span class="chip chip-best">Bestseller</span>');
        if (l.is_popular_now === 'TRUE' || l.is_popular_now === true) badges.push('<span class="chip chip-pop">Popular</span>');

        // Urgency signal chips — show exactly what Etsy shows on the listing page
        const signals = [];
        // Raw urgency text from Etsy (e.g. "Low in stock, only 4 left", "In 20+ baskets")
        if (urgencyText) {
          // Pick the right chip style based on urgency type
          const isStock = /stock|left/i.test(urgencyText);
          const chipCls = isStock ? 'chip-stock' : 'chip-hot';
          signals.push(`<span class="chip ${chipCls}">${esc(urgencyText)}</span>`);
        }
        // Only show in_carts/sold_24h as separate chips if urgencyText doesn't already cover them
        if (!isNaN(inCarts) && inCarts > 0 && !urgencyText) {
          signals.push(`<span class="chip chip-hot">🛒 ${inCarts} in carts</span>`);
        }
        if (!isNaN(sold24) && sold24 > 0 && !/bought.*last.*24/i.test(urgencyText)) {
          signals.push(`<span class="chip chip-hot">🔥 ${sold24} sold/24h</span>`);
        }
        if (!isNaN(views24) && views24 > 0) signals.push(`<span class="chip">👁 ${views24.toLocaleString()} views/24h</span>`);
        if (!isNaN(favCount) && favCount > 0) signals.push(`<span class="chip chip-fav">❤️ ${favCount.toLocaleString()} favorites</span>`);

        // Media info
        const mediaChips = [];
        if (!isNaN(photoCount) && photoCount > 0) mediaChips.push(`<span class="chip chip-media">📷 ${photoCount} photos</span>`);
        if (hasVideo) mediaChips.push(`<span class="chip chip-media">🎬 Video</span>`);

        // Shop detail block (right side)
        const shopUrl = `https://www.etsy.com/shop/${encodeURIComponent(shop)}`;
        const shopDetailParts = [];
        if (shopSales > 0) shopDetailParts.push(`<span class="shop-detail-item">📦 ${shopSales.toLocaleString()} sales</span>`);
        if (shopEstablished) shopDetailParts.push(`<span class="shop-detail-item">📅 Since ${esc(shopEstablished)}</span>`);
        if (shopStarSeller) shopDetailParts.push(`<span class="shop-detail-item star-seller-badge">⭐ Star Seller</span>`);
        if (shopTeamSize > 1) shopDetailParts.push(`<span class="shop-detail-item">👥 ${shopTeamSize} members</span>`);
        if (shopLocation) shopDetailParts.push(`<span class="shop-detail-item">📍 ${esc(shopLocation)}</span>`);

        // Winner score badge + per-signal breakdown tooltip (for transparency).
        // Each entry shows BOTH the signal pass/fail AND the actual value so the
        // user can see e.g. "✓ Rating 4.9" instead of just "✓ Rating ≥ 4.5".
        const winnerScore = typeof l._winnerScore === 'number' ? l._winnerScore : 0;
        const hit = l._winnerHit || {};
        // 2026-05-01: scoreClass now distinguishes winners from sub-threshold
        // listings so the rendered card visually communicates pass/fail.
        // win-fail = below the configured winner threshold (still rendered,
        // but greyed so users see what didn't make the cut).
        const minWS = Math.max(0, parseInt(niche && niche.min_winner_score) || 50);
        const scoreClass = winnerScore < minWS ? 'win-fail'
                         : winnerScore >= 80 ? 'win-high'
                         : winnerScore >= 60 ? 'win-mid'
                         : 'win-low';
        const ratingForTip = parseFloat(l.rating) || parseFloat(shopData.shop_rating) || 0;
        const hitList = [
          ['Bestseller', hit.bestseller, (l.is_bestseller === 'TRUE' || l.is_bestseller === true) ? 'yes' : 'no'],
          ['Popular Now', hit.popular_now, (l.is_popular_now === 'TRUE' || l.is_popular_now === true) ? 'yes' : 'no'],
          ['Favorites', hit.favorites, !isNaN(favCount) ? String(favCount) : '—'],
          ['In carts', hit.in_carts, !isNaN(inCarts) ? String(inCarts) : '—'],
          ['Sold/24h', hit.sold_24h, !isNaN(sold24) ? String(sold24) : '—'],
          ['Urgency', hit.urgency, urgencyText ? `"${urgencyText}"` : '—'],
          ['Rating', hit.rating, ratingForTip > 0 ? ratingForTip.toFixed(1) : '—'],
          ['Video', hit.video, hasVideo ? 'yes' : 'no'],
          ['Photos', hit.photos, !isNaN(photoCount) ? String(photoCount) : '—'],
          ['Beatable shop', hit.beatable, shopRevs > 0 ? `${shopRevs.toLocaleString()} reviews` : '—'],
        ];
        const tooltip = hitList.map(([label, v, val]) => `${v ? '✓' : '✗'} ${label}: ${val}`).join(' · ');

        // Listing-own rating + review count (written by Step 3 from the Etsy
        // listing page). Distinct from shop-aggregate rating on the right.
        // Etsy shows both — reviews specific to THIS product vs the shop total.
        const listingRatingNum = parseFloat(l.rating);
        const listingReviewsNum = parseInt(l.review_count);
        const listingStatsParts = [];
        if (!isNaN(listingRatingNum) && listingRatingNum > 0) {
          listingStatsParts.push(`★ ${listingRatingNum.toFixed(1)}`);
        }
        if (!isNaN(listingReviewsNum) && listingReviewsNum > 0) {
          const revLabel = listingReviewsNum === 1 ? 'review' : 'reviews';
          listingStatsParts.push(`${listingReviewsNum.toLocaleString()} ${revLabel}`);
        }
        const listingStatsHtml = listingStatsParts.length > 0
          ? `<div class="listing-stats">${listingStatsParts.join(' · ')}</div>`
          : '';

        return `<div class="detail-listing detail-listing-2col">
          <div class="detail-left">
            ${thumbHtml}
            <div class="detail-info">
              <a class="detail-title" href="${esc(listingUrl)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title.length > 70 ? title.substring(0, 70) + '...' : title)}</a>
              ${listingStatsHtml}
              <div class="detail-meta">
                ${posHtml}
                <span class="win-badge ${scoreClass}" title="${esc(tooltip)}">🏆 ${winnerScore}/100</span>
                ${!isNaN(price) && price > 0 ? `<span class="detail-price">$${price.toFixed(2)}</span>` : ''}
                ${badges.join('')}
              </div>
              ${signals.length > 0 || mediaChips.length > 0 ? `<div class="detail-signals">${signals.join('')}${mediaChips.join('')}</div>` : ''}
            </div>
          </div>
          <div class="detail-right">
            <div class="shop-label">Shop</div>
            <a class="detail-shop-link" href="${esc(shopUrl)}" target="_blank" rel="noopener">${esc(shop)}</a>
            <div class="detail-shop-rating">★ ${shopRat.toFixed(1)} · ${shopRevs.toLocaleString()} ${shopRevs === 1 ? 'review' : 'reviews'}</div>
            ${shopDetailParts.length > 0 ? `<div class="shop-details">${shopDetailParts.join('')}</div>` : ''}
          </div>
        </div>`;
      }).join('');

      detailHtml = `<div class="detail-listings">${listingCards}</div>`;
    } else {
      detailHtml = `<div class="detail-empty">No listings audited for this keyword (Step 2 captured nothing).</div>`;
    }

    return `<tr class="kw-opp-row ${arrowCls}" data-idx="${idx}">
        <td class="expand-cell"><span class="expand-arrow ${arrowCls}">▶</span></td>
        <td><a href="${etsySearchUrl}" target="_blank" rel="noopener">${esc(sk.keyword)}</a></td>
        <td class="center"><span class="opp-score ${scoreCls}">${scoreDisp}</span></td>
        <td class="num">${searchesDisp}</td>
        <td class="num">${compDisp}</td>
        <td class="num">${ctrDisp}</td>
        <td>${beatableHtml}</td>
        <td class="num">${favsDisp}</td>
        <td class="num">${inCartsDisp}</td>
        <td class="num">${sold24Disp}</td>
        <td>${pill}</td>
      </tr>
      <tr class="detail-row ${isExpanded ? '' : 'hidden'}" data-idx="${idx}">
        <td colspan="11">
          <div class="detail-wrap">
            <div class="detail-header">Top ${sk.beatableListings ? sk.beatableListings.length : 0} audited listings — sorted by winner score (≥ ${minWinnerScoreCfg}/100 marks a winner)</div>
            ${detailHtml}
          </div>
        </td>
      </tr>`;
  }).join('');

  // Collapsible "how the winner score works" panel — rendered once above the
  // opportunity table. Explains the 10 equally-weighted signals, the threshold,
  // and why non-beatable shops drop out naturally.
  const scoringLegendHtml = `
      <details class="scoring-legend">
        <summary>🏆 How are winning listings scored?</summary>
        <div class="scoring-legend-body">
          <p>Each of the top audited listings (the same set the qualification math runs on — top ${maxListingsPerKw} by Etsy search position) is scored on <strong>10 equally-weighted signals</strong>, 10 points each, for a maximum of <strong>100 / 100</strong>. Listings scoring <strong>${minWinnerScoreCfg}+</strong> are flagged as winners; everything else still renders so you can see what fell short.</p>
          <div class="signal-grid">
            <div>🏅 Bestseller badge <strong>+10</strong></div>
            <div>⭐ Popular Now badge <strong>+10</strong></div>
            <div>❤️ 5+ favorites <strong>+10</strong></div>
            <div>🛒 In carts <strong>+10</strong></div>
            <div>🔥 Sold in last 24h <strong>+10</strong></div>
            <div>⚡ Urgency text present <strong>+10</strong></div>
            <div>⭐ Listing rating ≥ 4.5 <strong>+10</strong></div>
            <div>🎬 Has video <strong>+10</strong></div>
            <div>📷 7+ photos <strong>+10</strong></div>
            <div>🔓 Beatable shop (reviews &lt; ${maxShopReviewsBeatable}) <strong>+10</strong></div>
          </div>
          <div class="threshold-note">
            <strong>Winner threshold: ${minWinnerScoreCfg}/100.</strong> Listings below threshold render greyed-out so you can see what fell short. Hover over a listing's 🏆 badge to see exactly which signals it hit.
          </div>
        </div>
      </details>`;

  const oppTableHtml = scoredKeywords.length > 0
    ? `<div class="opp-section">
        <h2>🎯 Keyword Opportunities</h2>
        ${scoringLegendHtml}
        <p class="criteria-note">Keywords ranked by opportunity score (searches × beatability × demand signals). Click a row to see winning listings (score ${minWinnerScoreCfg}+/100). <span class="beatable">Green score</span> = high opportunity.</p>
        <div class="table-wrap"><table class="opp-table">
          <thead><tr>
            <th style="width:30px"></th>
            <th>Keyword</th>
            <th class="center" title="Weighted opportunity score (0-100)">Score</th>
            <th class="num">Searches</th>
            <th class="num">Competition</th>
            <th class="num">CTR</th>
            <th>Beatable</th>
            <th class="num" title="Median favorites from audited listings">Favs</th>
            <th class="num" title="Median in-carts from audited listings">In-Carts</th>
            <th class="num" title="Median sold in last 24h from audited listings">Sold/24h</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${oppTableRows}</tbody>
        </table></div>
      </div>`
    : '';

  // ─── Demand Health summary ───
  // 2026-04-19: Dedupe audits by listing_id (keep most recent) before
  // aggregating. Prior code counted raw audit rows — same listing audited
  // across N runs inflated counts N×.
  const latestAuditByListingId = new Map();
  const audRowTime = (a) => String(a.audited_at || a.updated_at || a.created_at || '');
  for (const a of (nicheAudits || [])) {
    const id = String(a.listing_id);
    if (!id) continue;
    const prev = latestAuditByListingId.get(id);
    if (!prev || audRowTime(a) > audRowTime(prev)) {
      latestAuditByListingId.set(id, a);
    }
  }
  const uniqNicheAudits = Array.from(latestAuditByListingId.values());
  const uniqAuditedCount = uniqNicheAudits.length;
  const uniqListingCount = new Set((nicheListings || []).map(l => String(l.listing_id))).size;

  // Aggregate demand signals across all audited listings for a quick health check
  const allInCarts = uniqNicheAudits.map(a => parseInt(a.in_carts)).filter(x => !isNaN(x) && x >= 0);
  const allSold24 = uniqNicheAudits.map(a => parseInt(a.sold_24h)).filter(x => !isNaN(x) && x >= 0);
  const allFavs = uniqNicheAudits.map(a => parseInt(a.favorites_count)).filter(x => !isNaN(x) && x >= 0);
  const allViews24 = uniqNicheAudits.map(a => parseInt(a.views_24h)).filter(x => !isNaN(x) && x >= 0);

  const medianAllFavs = allFavs.length > 0 ? (() => { const s = [...allFavs].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; })() : 0;
  const medianAllInCarts = allInCarts.length > 0 ? (() => { const s = [...allInCarts].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; })() : 0;
  const medianAllSold24 = allSold24.length > 0 ? (() => { const s = [...allSold24].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; })() : 0;
  const avgAllViews24 = allViews24.length > 0 ? Math.round(allViews24.reduce((s,v) => s+v, 0) / allViews24.length) : 0;
  const withFavs = allFavs.filter(v => v > 0).length;
  const withInCarts = allInCarts.filter(v => v > 0).length;
  const withSold24 = allSold24.filter(v => v > 0).length;

  const hasDemandData = allFavs.length > 0 || allInCarts.length > 0 || allSold24.length > 0;
  const demandBannerHtml = hasDemandData ? `
    <div class="demand-banner">
      <span>💡</span>
      <div>
        <strong>Demand Health</strong> — across ${uniqAuditedCount} audited listings:
        <div class="demand-stats">
          ${allFavs.length > 0 ? `<div class="demand-stat"><span class="demand-stat-val">${medianAllFavs.toLocaleString()}</span><span class="demand-stat-label">Median Favs</span></div>` : ''}
          ${allInCarts.length > 0 ? `<div class="demand-stat"><span class="demand-stat-val">${medianAllInCarts}</span><span class="demand-stat-label">Median In-Carts</span></div>` : ''}
          ${allSold24.length > 0 ? `<div class="demand-stat"><span class="demand-stat-val">${medianAllSold24}</span><span class="demand-stat-label">Median Sold/24h</span></div>` : ''}
          ${allViews24.length > 0 ? `<div class="demand-stat"><span class="demand-stat-val">${avgAllViews24.toLocaleString()}</span><span class="demand-stat-label">Avg Views/24h</span></div>` : ''}
          <div class="demand-stat"><span class="demand-stat-val">${withFavs}/${uniqAuditedCount}</span><span class="demand-stat-label">Have Favs</span></div>
          <div class="demand-stat"><span class="demand-stat-val">${withInCarts}/${uniqAuditedCount}</span><span class="demand-stat-label">Have Carts</span></div>
          <div class="demand-stat"><span class="demand-stat-val">${withSold24}/${uniqAuditedCount}</span><span class="demand-stat-label">Sold Today</span></div>
        </div>
      </div>
    </div>` : '';

  // ─── Audit coverage strip ───
  // Use unique listing counts, not raw row counts (Step 2 writes new rows per run).
  const auditCoverageText = `${uniqAuditedCount} of ${uniqListingCount} listings audited on Etsy`;

  // ─── Date for footer ───
  const reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<title>Niche Report: ${esc(niche.seed_keyword)} — ${niche.verdict}</title>
<style>
:root {
  --bg: #f8fafc;
  --card: #ffffff;
  --text: #0f172a;
  --muted: #94a3b8;
  --border: #e2e8f0;
  --primary: #2F5496;
  --good: #10b981;
  --mid: #f59e0b;
  --bad: #ef4444;
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}
.verdict-header {
  background: ${verdictBg};
  color: white;
  padding: 28px 32px;
  border-radius: 14px;
  margin-bottom: 20px;
  box-shadow: 0 10px 25px -5px ${verdictShadow};
  position: relative;
  overflow: hidden;
}
.verdict-header::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -10%;
  width: 300px;
  height: 300px;
  background: rgba(255,255,255,0.08);
  border-radius: 50%;
}
.verdict-header h1 { margin: 0 0 4px; font-size: 24px; font-weight: 600; }
.verdict-header .meta { margin: 0; opacity: 0.9; font-size: 13px; }
.verdict-row { display: flex; align-items: center; gap: 20px; margin-top: 18px; position: relative; }
.verdict-icon {
  width: 56px; height: 56px;
  background: rgba(255,255,255,0.2);
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; font-weight: bold;
}
.verdict-text { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
.verdict-sub { margin-top: 4px; opacity: 0.9; font-size: 13px; }
.explanation {
  background: white;
  border-radius: 12px;
  padding: 22px 26px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  line-height: 1.7;
  font-size: 14px;
  border-left: 4px solid ${verdictColor};
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin: 20px 0;
}
.metric-card {
  background: white;
  border-radius: 12px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  transition: transform 0.15s, box-shadow 0.15s;
}
.metric-card:hover { transform: translateY(-2px); box-shadow: 0 8px 16px -8px rgba(0,0,0,0.1); }
.metric-card h3 { margin: 0 0 6px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.metric-card p { margin: 0; font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
.coverage-strip {
  background: linear-gradient(90deg,#fef3c7 0%,#fde68a 100%);
  color: #78350f;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 13px;
  margin: 16px 0 24px;
  display: flex; align-items: center; gap: 10px;
}
.coverage-strip strong { font-weight: 700; }
h2 { color: var(--text); margin: 32px 0 12px; font-size: 17px; font-weight: 700; letter-spacing: -0.3px; }
.table-wrap { background: white; border-radius: 12px; overflow: hidden; border: 1px solid var(--border); margin: 12px 0 24px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  background: #f1f5f9; color: #475569;
  padding: 12px 14px; text-align: left;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.4px;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
th.num { text-align: right; }
th.center { text-align: center; }
td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tr:nth-child(even) td { background: #fafbfc; }
tr:hover td { background: #eff6ff; }
td a { color: var(--primary); text-decoration: none; }
td a:hover { text-decoration: underline; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.center { text-align: center; }
.muted { color: var(--muted); }
.title-col { min-width: 320px; max-width: 380px; }
.title-cell { display: flex; gap: 12px; align-items: flex-start; }
.thumb {
  width: 56px; height: 56px;
  border-radius: 8px; overflow: hidden;
  flex-shrink: 0; background: #e2e8f0;
  border: 1px solid var(--border);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-placeholder {
  width: 56px; height: 56px;
  border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 24px;
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.title-text { flex: 1; min-width: 0; display: block; }
.title-text > a.title-link {
  font-weight: 500; color: var(--text); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; text-decoration: none;
}
.title-text > a.title-link:hover { color: var(--primary); }
.ranked-mini {
  display: block; font-size: 11px; color: var(--muted);
  margin-top: 4px; white-space: nowrap !important;
  overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
.ranked-mini, .ranked-mini * { white-space: nowrap !important; }
.ranked-mini a { color: var(--muted); }
.price-col { font-weight: 600; color: var(--text); white-space: nowrap; width: 1%; min-width: 80px; }
.price-stacked { line-height: 1.3; }
.price-line2 { margin-top: 2px; font-size: 0.85em; }
.sale-price { color: #d5451b; font-size: 1em; }
.original-price { text-decoration: line-through; color: var(--muted); font-weight: 400; }
.discount-badge { background: #fee2e2; color: #991b1b; padding: 1px 5px; border-radius: 4px; font-size: 0.95em; font-weight: 600; margin-left: 2px; white-space: nowrap; }
.stars-row { display: inline-flex; align-items: center; gap: 4px; }
.stars { color: #fbbf24; letter-spacing: 1px; font-size: 13px; }
.stars-num { font-weight: 600; color: var(--text); }
.reviews-num { font-size: 11px; color: var(--muted); margin-top: 2px; }
.score-badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; min-width: 38px; text-align: center; }
.score-good { background: #d1fae5; color: #065f46; }
.score-mid { background: #fef3c7; color: #92400e; }
.score-bad { background: #fee2e2; color: #991b1b; }
.shop-cell { min-width: 140px; max-width: 180px; }
.shop-name { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shop-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.beatable-shop .shop-meta { color: #059669; font-weight: 600; }
.signals { display: flex; flex-wrap: wrap; gap: 4px; max-width: 200px; }
.chip { display: inline-block; padding: 3px 8px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 11px; font-weight: 500; white-space: nowrap; }
.chip-hot { background: #fef3c7; color: #92400e; }
.chip-pop { background: #dbeafe; color: #1e40af; }
.chip-best { background: #fce7f3; color: #9d174d; }
.pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
.pill-go { background: #d1fae5; color: #065f46; }
.pill-nogo { background: #fee2e2; color: #991b1b; }
.beatable-cell { min-width: 100px; }
.beatable-text { font-weight: 600; font-size: 13px; }
.beatable-of { color: var(--muted); font-weight: 400; font-size: 11px; }
.beatable-bar { width: 100px; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.beatable-fill { height: 100%; transition: width 0.3s; }
.criteria-note { color: var(--muted); font-size: 12px; margin: 0 0 12px 4px; font-style: italic; }
.criteria-note .beatable { color: #059669; font-weight: 600; font-style: normal; }
footer { color: var(--muted); text-align: center; margin-top: 40px; font-size: 12px; }

/* ─── Keyword Opportunity Table ─── */
.opp-section { margin: 0 0 24px; }
.opp-section h2 { margin: 0 0 4px; font-size: 17px; }
.opp-table .kw-opp-row { cursor: pointer; }
.opp-table .kw-opp-row:hover td { background: #eff6ff; }
.expand-cell { width: 30px; text-align: center; padding: 8px 4px !important; }
.expand-arrow {
  display: inline-block; font-size: 10px; color: var(--muted);
  transition: transform 0.2s;
}
.expand-arrow.expanded { transform: rotate(90deg); }
.opp-score {
  display: inline-block; padding: 4px 10px; border-radius: 999px;
  font-weight: 700; font-size: 12px; min-width: 42px; text-align: center;
}
.opp-high { background: #d1fae5; color: #065f46; }
.opp-mid { background: #fef3c7; color: #92400e; }
.opp-low { background: #fee2e2; color: #991b1b; }
.detail-row td { padding: 0 !important; border-bottom: 2px solid var(--border); }
.detail-row.hidden { display: none; }
.detail-wrap {
  background: #f8fafc; padding: 12px 16px 16px;
  border-top: 1px solid var(--border);
}
.detail-header {
  font-size: 11px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.3px;
  margin-bottom: 10px;
}
.detail-listings { display: flex; flex-direction: column; gap: 8px; }
.detail-listing {
  display: flex; gap: 10px; align-items: flex-start;
  background: white; border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px;
}
.detail-listing:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.detail-thumb {
  width: 44px; height: 44px; border-radius: 6px;
  overflow: hidden; flex-shrink: 0; background: #e2e8f0;
  border: 1px solid var(--border);
}
.detail-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.detail-thumb-placeholder {
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 18px;
  background: #94a3b8;
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.detail-info { flex: 1; min-width: 0; }
.detail-title {
  font-weight: 500; color: var(--text); font-size: 13px;
  text-decoration: none; display: block;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.detail-title:hover { color: var(--primary); }
.detail-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin-top: 4px; font-size: 11px; color: var(--muted);
}
.detail-shop { font-weight: 500; color: #059669; }
.detail-revs { color: var(--muted); }
.detail-price { font-weight: 600; color: var(--text); }
.pos-badge {
  background: #e2e8f0; color: #475569;
  padding: 1px 6px; border-radius: 4px;
  font-size: 10px; font-weight: 600;
}
.detail-empty {
  text-align: center; color: var(--muted);
  font-size: 12px; font-style: italic; padding: 12px;
}

/* ─── Two-column listing card layout ─── */
.detail-listing-2col {
  display: flex; justify-content: space-between; gap: 16px;
}
.detail-left {
  display: flex; gap: 10px; align-items: flex-start; flex: 1; min-width: 0;
}
.detail-right {
  flex-shrink: 0; min-width: 160px; max-width: 220px;
  border-left: 1px solid var(--border); padding-left: 14px;
  display: flex; flex-direction: column; gap: 3px;
}
.detail-shop-link {
  font-weight: 600; color: #059669; font-size: 13px;
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.detail-shop-link:hover { text-decoration: underline; }
.detail-shop-rating { font-size: 11px; color: var(--muted); }
.shop-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
.listing-stats { font-size: 11px; color: #64748b; margin: 2px 0 4px; font-weight: 500; }
.shop-details {
  display: flex; flex-direction: column; gap: 2px; margin-top: 4px;
}
.shop-detail-item {
  font-size: 11px; color: #64748b; white-space: nowrap;
}
.star-seller-badge { color: #d97706; font-weight: 600; }
.detail-signals {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px;
}
.chip-fav { background: #fce7f3; color: #9d174d; }
.chip-stock { background: #fef3c7; color: #92400e; }
.chip-media { background: #e0e7ff; color: #3730a3; }

/* ─── Winner score badge on listing cards ─── */
.win-badge {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 700;
  background: #e2e8f0; color: #334155;
  cursor: help;
}
.win-badge.win-high { background: #d1fae5; color: #065f46; }
.win-badge.win-mid  { background: #fef3c7; color: #92400e; }
.win-badge.win-low  { background: #fee2e2; color: #991b1b; }
.win-badge.win-fail { background: #f1f5f9; color: #64748b; }
.detail-listing:has(.win-badge.win-fail) { opacity: 0.6; }

/* ─── Scoring legend panel (collapsible) ─── */
.scoring-legend {
  background: white;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0;
  margin: 0 0 16px;
  overflow: hidden;
}
.scoring-legend summary {
  cursor: pointer; padding: 12px 18px;
  font-weight: 600; font-size: 13px; color: var(--text);
  list-style: none;
  display: flex; align-items: center; gap: 8px;
  background: #f8fafc;
  border-bottom: 1px solid transparent;
}
.scoring-legend[open] summary { border-bottom-color: var(--border); }
.scoring-legend summary::-webkit-details-marker { display: none; }
.scoring-legend summary::before {
  content: '▶'; font-size: 10px; color: var(--muted);
  transition: transform 0.2s;
}
.scoring-legend[open] summary::before { transform: rotate(90deg); }
.scoring-legend-body { padding: 14px 18px 18px; font-size: 13px; color: var(--text); line-height: 1.55; }
.scoring-legend-body p { margin: 0 0 10px; }
.scoring-legend-body .signal-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px; margin: 10px 0;
}
.scoring-legend-body .signal-grid div {
  padding: 6px 10px; background: #f8fafc; border-radius: 6px;
  font-size: 12px; display: flex; justify-content: space-between; align-items: center;
}
.scoring-legend-body .signal-grid div strong { color: #2F5496; font-weight: 700; }
.scoring-legend-body .threshold-note {
  background: #eff6ff; border-left: 3px solid #2F5496;
  padding: 10px 12px; border-radius: 6px;
  font-size: 12px; margin-top: 10px;
}

/* ─── Demand Health banner ─── */
.demand-banner {
  background: linear-gradient(90deg, #eff6ff 0%, #dbeafe 100%);
  color: #1e3a5f;
  padding: 14px 20px;
  border-radius: 10px;
  font-size: 13px;
  margin: 12px 0 8px;
  display: flex; align-items: center; gap: 12px;
  border: 1px solid #bfdbfe;
}
.demand-banner .demand-stats {
  display: flex; gap: 18px; flex-wrap: wrap;
}
.demand-banner .demand-stat {
  display: flex; flex-direction: column; align-items: center;
}
.demand-banner .demand-stat-val {
  font-size: 18px; font-weight: 700; color: #1e40af;
}
.demand-banner .demand-stat-label {
  font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.3px;
}
</style></head><body>

<div class="verdict-header">
  <h1>Niche Report: ${esc(niche.seed_keyword)}</h1>
  <p class="meta">Category: ${esc(niche.category)}  ·  Product type: ${esc(niche.product_type)}</p>
  <div class="verdict-row">
    <div class="verdict-icon">${verdictIcon}</div>
    <div>
      <div class="verdict-text">${esc(niche.verdict)}</div>
      <div class="verdict-sub">${niche.qualified_keywords}/${niche.total_processed} keywords qualified (need ${niche.min_qualified_kw})</div>
    </div>
  </div>
</div>

<div class="explanation">${explanation}</div>

<div class="grid">
  <div class="metric-card"><h3>Keywords</h3><p>${niche.total_keywords}</p></div>
  <div class="metric-card"><h3>Qualified</h3><p>${niche.qualified_keywords}/${niche.total_processed}</p></div>
  <div class="metric-card"><h3>Listings</h3><p>${niche.total_listings}</p></div>
  <div class="metric-card"><h3>Shops</h3><p>${niche.total_shops}</p></div>
  <div class="metric-card"><h3>Avg Price</h3><p>$${niche.avg_price}</p></div>
  <div class="metric-card"><h3>Avg Searches</h3><p>${niche.avg_searches}</p></div>
  <div class="metric-card"><h3>Avg Comp</h3><p>${niche.avg_competition}</p></div>
  <!-- 2026-04-17: "Weak Listings %" metric removed. It depended on erank_score,
       which Step 3 stopped collecting when it went Etsy-only. The tile was
       never rendering in practice (has_audits was always false post-migration). -->
  ${(() => {
    // Unique listing_id counts — prior display used raw row counts which
    // inflated with each pipeline run (Step 2 INSERTs a new row per run).
    const uniqAuditedIds = new Set((nicheAudits || []).map(a => String(a.listing_id)));
    const uniqListingIds = new Set((nicheListings || []).map(l => String(l.listing_id)));
    return uniqAuditedIds.size > 0
      ? `<div class="metric-card"><h3>Audited</h3><p>${uniqAuditedIds.size}/${uniqListingIds.size}</p></div>`
      : '';
  })()}
</div>

${oppTableHtml}

${demandBannerHtml}

<div class="coverage-strip">
  <span>📊</span>
  <div><strong>${auditCoverageText}</strong> · Social proof signals (in-carts, sold/24h, favorites, urgency) come from Etsy listing pages. Expand keyword rows above to see winning listings.</div>
</div>

<footer>
  ${EXT_NAME} Report — Generated on ${reportDate} · ${extVersionLabel()}
</footer>

<script>
(function() {
  // Expand/collapse keyword opportunity rows
  document.querySelectorAll('.kw-opp-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.dataset.idx;
      const detail = document.querySelector('.detail-row[data-idx="' + idx + '"]');
      const arrow = row.querySelector('.expand-arrow');
      if (!detail) return;
      const isHidden = detail.classList.contains('hidden');
      if (isHidden) {
        detail.classList.remove('hidden');
        arrow.classList.add('expanded');
        row.classList.add('expanded');
      } else {
        detail.classList.add('hidden');
        arrow.classList.remove('expanded');
        row.classList.remove('expanded');
      }
    });
  });
})();
</script>

</body></html>`;
}

// ─── Insufficient-keywords short report ───────────────────────────────────
// Produces a stripped-down NO-GO report when Step 1 didn't surface enough
// keywords to make Step 2 worth running. Keyword table + banner only — no
// listings, no audits, no concepts. The user guidance at the top explains
// exactly what to do next (lower the min, pick a new seed, or re-run).
async function runInsufficientKeywordsReport(sheetsClient, config, log, seedKeyword, opts) {
  log('info', `📭 Generating NO-GO report for "${seedKeyword}" — Step 1 yielded ${opts.availableCount} of ${opts.minRequired} required keywords`);

  let dbConfig = {};
  try { dbConfig = await sheetsClient.readConfig(); } catch {}
  // Popup config wins over DB config.
  const pickCfg = (key, fallback) => {
    const popup = config != null ? config[key] : undefined;
    if (popup !== undefined && popup !== null && popup !== '') return popup;
    const db = dbConfig != null ? dbConfig[key] : undefined;
    if (db !== undefined && db !== null && db !== '') return db;
    return fallback;
  };
  const FRESH_HOURS = parseInt(
    pickCfg('data_staleness_hours', null)
    ?? pickCfg('keyword_freshness_hours', null)
    ?? 48
  ) || 48;

  // Post-m2m migration: read seeds first, then scope the keywords read by
  // seed_id so the Worker JOINs through pro_etsy_res_seed_keyword_map.
  const seedsData = await sheetsClient.readSheet('seed_keywords');
  const seed = seedsData.rows.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
  if (!seed) {
    log('error', `Seed "${seedKeyword}" not found — cannot render short report`);
    return { verdict: 'NO-GO', qualifiedCount: 0, totalProcessed: 0, reportsGenerated: 0 };
  }

  const seedId = String(seed.seed_id);
  const keywordsData = await sheetsClient.readSheet('etsy_keywords', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' });
  const keywords = keywordsData.rows.filter(k => String(k.seed_id) === seedId);

  // Report keyword filter (2026-06-04) — same rule as the main report: list
  // only keywords passing the user's Step-1 thresholds (searches >= min AND
  // competition <= max). Stored DB data is untouched; this only affects what
  // the report shows and the niche_scores.total_keywords count.
  const _nogoMin = parseFloat(pickCfg('min_monthly_searches', 450));
  const nogoMinSearches = Number.isFinite(_nogoMin) && _nogoMin > 0 ? _nogoMin : 0;
  const _nogoMax = parseFloat(pickCfg('max_competition', 25000));
  const nogoMaxCompetition = Number.isFinite(_nogoMax) && _nogoMax > 0 ? _nogoMax : Infinity;
  const reportKeywords = keywords.filter(k => {
    const kw = (k.keyword || '').trim();
    if (!kw || isJunkKeyword(kw)) return false;
    const searches = parseFloat(k.avg_searches) || 0;
    const comp = parseFloat(k.competition) || 0; // unknown → 0 → passes (not "high")
    if (searches < nogoMinSearches) return false;
    if (comp > nogoMaxCompetition) return false;
    return true;
  });

  const now = new Date().toISOString();

  // Still write a niche_scores row so the seed's history stays consistent
  // with the NO-GO verdict. We mark it clearly as insufficient-keywords so
  // downstream analytics can tell this apart from a normal NO-GO.
  try {
    await sheetsClient.appendRowsByName('niche_scores', [{
      run_id: opts.pipelineRunId || null,   // 2026-07-01 (v1.3.0): exact run→verdict link
      category: seed.category || '',
      seed_keyword: seedKeyword,
      product_type: 'unknown',
      total_keywords: reportKeywords.length,
      validated_keywords: 0,
      total_listings: 0,
      total_shops: 0,
      avg_price: '0.00',
      avg_competition: '0',
      avg_searches: '0',
      weak_competitor_pct: '0.0',
      readiness_score: `${opts.availableCount}/${opts.minRequired}`,
      status: 'NO-GO',
      report_url: '',
      scored_at: now
    }]);
  } catch (e) {
    // 2026-07-01 (v1.3.0): was 'warn' (silently swallowed) — surface as 'error'
    // so a missing NO-GO verdict row is visible in the log. Report still
    // generates below; we don't fail the run just because the score row blipped.
    log('error', `niche_scores write failed on short (NO-GO) report — verdict row missing: ${e.message}`);
  }

  const html = generateInsufficientKeywordsReport(seedKeyword, seed, reportKeywords, opts);
  const filename = `etsyhunt_${seedKeyword.replace(/\s+/g, '_')}_${now.split('T')[0]}_NOGO.html`;
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

  let reportsGenerated = 0;
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    reportsGenerated = 1;
    log('success', `📄 NO-GO report downloaded: ${filename}`);
  } catch (e) {
    log('warn', `NO-GO report download failed: ${e.message} — opening in tab`);
    try {
      await chrome.tabs.create({ url: dataUrl, active: true });
      reportsGenerated = 1;
    } catch (e2) {
      log('error', `Could not open NO-GO report: ${e2.message}`);
    }
  }

  await sheetsClient.logRun('niche_scoring', 'SUCCESS', 1, 0, 0, '',
    `Seed: "${seedKeyword}", Verdict: NO-GO (insufficient keywords ${opts.availableCount}/${opts.minRequired})`);

  log('warn', `🏁 Step 4 DONE! "${seedKeyword}" → NO-GO (insufficient keywords)`);
  return { verdict: 'NO-GO', qualifiedCount: 0, totalProcessed: keywords.length, reportsGenerated };
}

function generateInsufficientKeywordsReport(seedKeyword, seed, keywords, opts) {
  const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return esc(String(v));
    return n.toLocaleString();
  };

  // Sort by searches desc so the most promising keywords surface at the top.
  const sorted = [...keywords].sort((a, b) => (parseFloat(b.avg_searches) || 0) - (parseFloat(a.avg_searches) || 0));
  const kwRowsHtml = sorted.length === 0
    ? `<tr><td colspan="5" class="empty">No keywords were captured for this seed in the current run window.</td></tr>`
    : sorted.map(k => `
        <tr>
          <td class="kw">${esc(k.keyword || '')}</td>
          <td class="num">${fmt(k.avg_searches)}</td>
          <td class="num">${fmt(k.competition)}</td>
          <td class="num">${fmt(k.click_rate)}</td>
          <td class="status ${esc((k.status || 'pending').toLowerCase())}">${esc(k.status || 'pending')}</td>
        </tr>`).join('');

  const available = opts.availableCount;
  const required = opts.minRequired;
  const shortfall = Math.max(0, required - available);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>NO-GO Report — ${esc(seedKeyword)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background: #f4f5f7; color: #222; margin: 0; padding: 32px 24px; }
  .container { max-width: 960px; margin: 0 auto; }
  .nogo-banner { background: #fff1f0; border: 2px solid #ef4444; border-radius: 10px; padding: 20px 24px; margin-bottom: 24px; }
  .nogo-banner h1 { margin: 0 0 8px; font-size: 22px; color: #b91c1c; display: flex; align-items: center; gap: 10px; }
  .nogo-banner .subtitle { font-size: 14px; color: #7f1d1d; margin-bottom: 12px; }
  .nogo-banner .shortfall { font-size: 15px; color: #991b1b; font-weight: 600; }
  .nogo-banner .shortfall strong { font-size: 18px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .card h2 { margin: 0 0 12px; font-size: 17px; color: #2F5496; }
  .card p { margin: 8px 0; line-height: 1.55; color: #374151; font-size: 14px; }
  .guidance ul { margin: 8px 0 0; padding-left: 22px; color: #374151; font-size: 14px; line-height: 1.7; }
  .guidance li { margin-bottom: 4px; }
  .guidance code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: 'Consolas', 'Monaco', monospace; color: #b91c1c; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eef0f2; }
  th { background: #f9fafb; font-weight: 600; color: #475569; text-transform: uppercase; font-size: 11px; letter-spacing: 0.3px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.kw { font-weight: 500; color: #1f2937; }
  td.status { text-transform: capitalize; font-size: 12px; }
  td.status.pending { color: #92400e; }
  td.status.validated { color: #1e40af; }
  td.status.qualified { color: #166534; }
  td.status.unqualified { color: #991b1b; }
  td.empty { text-align: center; color: #9ca3af; font-style: italic; padding: 32px 12px; }
  .meta { display: flex; gap: 20px; font-size: 13px; color: #64748b; margin-top: 12px; flex-wrap: wrap; }
  .meta span strong { color: #1f2937; }
  .footer { text-align: center; font-size: 11px; color: #9ca3af; margin-top: 20px; }
</style>
</head><body>
<div class="container">
  <div class="nogo-banner">
    <h1>🔴 NO-GO — Insufficient keywords for "${esc(seedKeyword)}"</h1>
    <div class="subtitle">Step 1 didn't surface enough keywords to make an Etsy snapshot worthwhile. Steps 2 and 3 were skipped to save eRank credit and Etsy rate-limit budget.</div>
    <div class="shortfall">Usable keywords found: <strong>${available}</strong> &nbsp;•&nbsp; minimum required: <strong>${required}</strong> &nbsp;•&nbsp; shortfall: <strong>${shortfall}</strong></div>
  </div>

  <div class="card guidance">
    <h2>What to do next</h2>
    <p>The pipeline stopped early because your <code>min_qualified_keywords</code> setting is higher than what eRank returned for this seed. You have a few options:</p>
    <ul>
      <li><strong>Lower the threshold.</strong> Open the extension settings and drop <code>min_qualified_keywords</code> (currently <code>${required}</code>) to something below <code>${available}</code>, then re-run this seed.</li>
      <li><strong>Relax your Step 1 filters.</strong> <code>min_monthly_searches</code> or <code>min_word_count</code> may be too tight for this niche — relax them and re-run to surface more candidates.</li>
      <li><strong>Try a different seed.</strong> If "${esc(seedKeyword)}" is a very narrow term, a broader adjacent seed will often surface more usable keywords that reuse into this niche.</li>
      <li><strong>Review the table below.</strong> The keywords eRank returned for this seed are listed below — if most are off-topic, the issue is Step 1 filtering, not your threshold.</li>
    </ul>
  </div>

  <div class="card">
    <h2>Keywords captured for "${esc(seedKeyword)}" (${keywords.length})</h2>
    <table>
      <thead>
        <tr>
          <th>Keyword</th>
          <th class="num">Avg searches</th>
          <th class="num">Competition</th>
          <th class="num">Click rate</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${kwRowsHtml}</tbody>
    </table>
    <div class="meta">
      <span>Seed ID: <strong>${esc(seed.seed_id || '—')}</strong></span>
      <span>Category: <strong>${esc(seed.category || '—')}</strong></span>
      <span>Generated: <strong>${esc(new Date().toLocaleString())}</strong></span>
    </div>
  </div>

  <div class="footer">${EXT_NAME} — short NO-GO report (insufficient keywords)</div>
</div>
</body></html>`;
}
