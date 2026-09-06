// concept-scoring.js
//
// Pure-JS verdict scoring for product concepts (tight clusters). No DOM, no
// network, no imports. Safe to run in the service worker.
//
// Input concept shape (built by the clustering + aggregation phases):
//   {
//     concept_label: string,
//     seed_id, seed_keyword, run_id,
//     keyword_ids, keyword_count, total_searches,
//     median_in_carts, median_sold_24h, median_views_24h,
//     avg_shop_reviews, beatable_slots_avg,
//     ads_count_avg, shop_slot_share_max,
//     example_listing_ids,
//   }
//
// Config keys consumed (all from pro_etsy_res_config, merged global+user):
//   min_cluster_searches        (default 3000)
//   max_avg_shop_reviews        (default 400)   -- cluster average
//   min_median_in_carts         (default 5)
//   min_median_sold_24h         (default 1)
//   min_median_favorites        (default 10)    -- demand depth: favs OR carts OR sold
//   max_ads_in_top_n            (default 6)
//   ad_dominance_mode           ('skip' | 'test' | 'ignore', default 'skip')
//   max_shop_slot_share         (default 0.25)
//   home_run_max_fails          (default 0)
//   worth_test_max_fails        (default 2)
//
// Output: { verdict, reasons, rules } where
//   verdict  = 'home_run' | 'worth_test' | 'skip'
//   reasons  = array of { rule, pass, detail, softFail? }
//   rules    = { total, pass, hardFail, softFail }

export const RULES = [
  'min_cluster_searches',
  'max_avg_shop_reviews',
  'min_median_in_carts',
  'min_median_sold_24h',
  'demand_depth',
  'ad_dominance',
  'max_shop_slot_share',
];

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function scoreConcept(concept, config = {}) {
  const cfg = {
    // 2026-04-08: 3000 was too strict — Ali's real winning niches often sit
    // in the 2000–3000 band. Lowered default to 2000.
    min_cluster_searches:  toNum(config.min_cluster_searches, 2000),
    max_avg_shop_reviews:  toNum(config.max_avg_shop_reviews, 400),
    min_median_in_carts:   toNum(config.min_median_in_carts, 5),
    min_median_sold_24h:   toNum(config.min_median_sold_24h, 1),
    min_median_favorites:  toNum(config.min_median_favorites, 10),
    max_ads_in_top_n:      toNum(config.max_ads_in_top_n, 6),
    // 2026-04-08 (revised): Ads rule stays ACTIVE with mode='skip' — a red
    // Ads chip means "too many sellers paying to compete here" and that
    // single hard-fail is enough to block home_run on its own (because
    // home_run_max_fails=0). A green Ads chip means "low paid competition,
    // you can win this organically". The legend in the report explains the
    // semantics so Ali knows what green vs red actually means.
    ad_dominance_mode:     String(config.ad_dominance_mode || 'skip').toLowerCase(),
    max_shop_slot_share:   toNum(config.max_shop_slot_share, 0.25),
    home_run_max_fails:    toNum(config.home_run_max_fails, 0),
    worth_test_max_fails:  toNum(config.worth_test_max_fails, 2),
  };

  const reasons = [];
  const push = (rule, pass, detail) => reasons.push({ rule, pass, detail });

  // Rule 1: min cluster searches
  {
    const searches = toNum(concept.total_searches, 0);
    const pass = searches >= cfg.min_cluster_searches;
    push('min_cluster_searches', pass,
      `${searches.toLocaleString()} searches vs. min ${cfg.min_cluster_searches.toLocaleString()}`);
  }

  // Rule 2: max avg shop reviews (weak competition)
  {
    const v = concept.avg_shop_reviews;
    if (v == null) {
      push('max_avg_shop_reviews', false, 'no audited shop-review data');
    } else {
      const pass = v <= cfg.max_avg_shop_reviews;
      push('max_avg_shop_reviews', pass,
        `avg shop reviews ${Math.round(v)} vs. max ${cfg.max_avg_shop_reviews}`);
    }
  }

  // Rule 3: min median in-carts
  {
    const v = concept.median_in_carts;
    if (v == null) {
      push('min_median_in_carts', false, 'no in-cart data');
    } else {
      const pass = v >= cfg.min_median_in_carts;
      push('min_median_in_carts', pass,
        `median in-carts ${v} vs. min ${cfg.min_median_in_carts}`);
    }
  }

  // Rule 4: min median sold in 24h
  {
    const v = concept.median_sold_24h;
    if (v == null) {
      push('min_median_sold_24h', false, 'no sold-24h data');
    } else {
      const pass = v >= cfg.min_median_sold_24h;
      push('min_median_sold_24h', pass,
        `median sold/24h ${v} vs. min ${cfg.min_median_sold_24h}`);
    }
  }

  // Rule 5: demand depth — passes if ANY demand signal meets threshold
  // A keyword with 0 favs but strong in-carts still passes.
  // Only fails when ALL signals are below thresholds (truly dead keyword).
  {
    const favs = concept.median_favorites;
    const carts = concept.median_in_carts;
    const sold = concept.median_sold_24h;
    const hasFavs = favs != null && favs >= cfg.min_median_favorites;
    const hasCarts = carts != null && carts >= cfg.min_median_in_carts;
    const hasSold = sold != null && sold >= cfg.min_median_sold_24h;
    const hasAny = hasFavs || hasCarts || hasSold;
    const allNull = favs == null && carts == null && sold == null;

    if (allNull) {
      push('demand_depth', false, 'no demand data (favs, carts, sold all missing)');
    } else {
      const parts = [];
      if (favs != null) parts.push(`favs ${favs}${hasFavs ? ' ✓' : ''}`);
      if (carts != null) parts.push(`carts ${carts}${hasCarts ? ' ✓' : ''}`);
      if (sold != null) parts.push(`sold/24h ${sold}${hasSold ? ' ✓' : ''}`);
      push('demand_depth', hasAny,
        `${parts.join(', ')} — need ≥1 signal (favs≥${cfg.min_median_favorites} OR carts≥${cfg.min_median_in_carts} OR sold≥${cfg.min_median_sold_24h})`);
    }
  }

  // Rule 6: ad dominance (mode-controlled)
  // mode='skip'   → hard fail
  // mode='test'   → soft fail (blocks home_run, allows worth_test)
  // mode='ignore' → rule skipped entirely (not added to reasons — no ✓ chip)
  //
  // 2026-04-08: when mode='ignore' we no longer push a pass=true entry,
  // because Ali does not want "✓ Ads" showing in the winners-box rule chips
  // (ads presence is not a home-run signal on Etsy).
  {
    const ads = concept.ads_count_avg;
    const mode = cfg.ad_dominance_mode;
    if (mode === 'ignore') {
      // skip — no reason pushed, rule doesn't count toward pass/fail tally
    } else if (ads == null) {
      push('ad_dominance', false, 'no ad-count data');
    } else {
      const pass = ads <= cfg.max_ads_in_top_n;
      const detail = `ads_count_avg ${ads.toFixed(1)} vs. max ${cfg.max_ads_in_top_n} (mode=${mode})`;
      const entry = { rule: 'ad_dominance', pass, detail };
      if (!pass && mode === 'test') entry.softFail = true;
      reasons.push(entry);
    }
  }

  // Rule 7: max single-shop slot share
  {
    const v = concept.shop_slot_share_max;
    if (v == null) {
      push('max_shop_slot_share', false, 'no shop slot-share data');
    } else {
      const pass = v <= cfg.max_shop_slot_share;
      push('max_shop_slot_share', pass,
        `top shop holds ${(v * 100).toFixed(0)}% of slots vs. max ${(cfg.max_shop_slot_share * 100).toFixed(0)}%`);
    }
  }

  // Tally
  let hardFails = 0;
  let softFails = 0;
  let passCount = 0;
  for (const r of reasons) {
    if (r.pass) { passCount++; continue; }
    if (r.softFail) softFails++;
    else hardFails++;
  }

  const homeRunFails   = hardFails + softFails;
  const worthTestFails = hardFails;

  let verdict;
  if (homeRunFails <= cfg.home_run_max_fails) {
    verdict = 'home_run';
  } else if (worthTestFails <= cfg.worth_test_max_fails) {
    verdict = 'worth_test';
  } else {
    verdict = 'skip';
  }

  return {
    verdict,
    reasons,
    rules: {
      total: reasons.length,
      pass: passCount,
      hardFail: hardFails,
      softFail: softFails,
    },
    // Echo the resolved config so the report's rule-legend can display the
    // actual thresholds used for this run (not hardcoded report defaults).
    cfg,
  };
}

export function scoreConcepts(concepts, config = {}) {
  const out = [];
  const counts = { home_run: 0, worth_test: 0, skip: 0 };
  for (const c of concepts) {
    const r = scoreConcept(c, config);
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    out.push({ ...c, ...r });
  }
  const order = { home_run: 0, worth_test: 1, skip: 2 };
  out.sort((a, b) => {
    const o = order[a.verdict] - order[b.verdict];
    if (o !== 0) return o;
    return (b.total_searches || 0) - (a.total_searches || 0);
  });
  return { concepts: out, counts };
}
