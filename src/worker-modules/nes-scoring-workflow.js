// ─────────────────────────────────────────────────────────────────────────────
// NES Scoring (Step 4, v2.0.0) — formula v1.3, validated before it was built.
//
// Scores every keyword of the run on three legs computed from LIVE Etsy
// evidence captured by Steps 2/3 (no eRank anywhere):
//
//   DEMAND (40)      sold 24 · favs 12 · carts 2 · views 2
//                    "Are the products on this keyword's shelf selling?"
//                    sold_24h is Etsy's own 24h counter, used AS-IS (snapshot,
//                    never presented as a daily rate — per Ali 2026-08-19).
//   WINNABILITY (35) beatable 15 · market-size 10 · non-star 5 · bestseller 5
//                    "Can a newcomer realistically rank here?"
//   FRESHNESS (25)   hot-reviews 15 · not-cold 10
//                    "Is the niche alive right now?" (last-review dates —
//                    caught the bridal-dress dead-niche trap in round 2)
//
// Gates BEFORE blending (fail any → grade D with the reason named):
//   demand ≥ 25 (plus the ABSOLUTE anchor: some sold badge or hot review must
//   exist — percentile demand looks high even in an all-dead run, learned in
//   round 2), winnability ≥ 30, freshness ≥ 40.
// NES = 0.40·D + 0.35·W + 0.25·F → A ≥65 · B ≥45 · C ≥30 · D.
// Seasonality: discovery family ≤8 caps the grade at B ("low current interest").
//
// Winners ("products to model"): beatable shops first — smallest shop with
// demand proof wins a card (max 2/keyword, max nes_winners_max total, A/B
// keywords only), plus at most ONE big-shop "Category king" clearly labelled
// for study, never as a competition target (per Ali 2026-08-19).
//
// Validation history: docs/data-inventory/phase0-nes-demand-test.md
// (4 offline rounds + 4 live niche rounds). formula_version stamped on every
// niche_scores row so future formula changes never mix with these scores.
// ─────────────────────────────────────────────────────────────────────────────

import { EXT_NAME, EXT_SITE, extVersionLabel } from '../utils/brand.js';
import { deliverReport } from '../utils/report-delivery.js';
import {
  completedStepsFor,
  partialBannerHtml,
  partialDisplayVerdict,
  partialScoreStatus,
} from '../utils/partial-report.js';

const FORMULA_VERSION = '1.3';
const REPORT_VERSION = extVersionLabel();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function median(arr) {
  const v = arr.filter(x => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function daysSince(dateStr, nowMs) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return null;
  return Math.floor((nowMs - t) / 86400000);
}
// Percentile rank (0-100) of each value within the run — one freak keyword
// can't distort the scale, and scores stay comparable across niches.
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map(v => 100 * sorted.filter(x => x <= v).length / sorted.length);
}
// A replay fixture leaves the machine (Ali mails them, they land in Downloads).
// Strip anything credential-shaped before it is written, by key name — an
// allow-list of "safe" keys would rot the moment a new setting is added.
// Match whole words, not substrings: the first version used /key/ and quietly
// dropped `max_listings_per_keyword`, so replays fell back to the code default
// (12 instead of 8) and grades moved for a reason that had nothing to do with
// the code. Split the key into words and compare each one exactly.
const SECRET_WORDS = new Set([
  'licence', 'license', 'key', 'apikey', 'token', 'secret',
  'password', 'passwd', 'auth', 'credential', 'credentials',
]);
function scrubSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    // Split camelCase too, so licenseKey is caught as well as license_key.
    const words = String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some(w => SECRET_WORDS.has(w))) continue;
    if (typeof v === 'object' && v !== null) continue;
    out[k] = v;
  }
  return out;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function runNesScoring(sheetsClient, config, log, seedKeyword, opts = {}) {
  if (opts && opts.insufficientKeywords) {
    const { runInsufficientKeywordsReport } = await import('./niche-scoring-workflow.js');
    return runInsufficientKeywordsReport(sheetsClient, config, log, seedKeyword, opts);
  }
  if (opts && opts.partialKeywordsOnly) {
    const { runPartialKeywordReport } = await import('./niche-scoring-workflow.js');
    return runPartialKeywordReport(sheetsClient, config, log, seedKeyword, opts);
  }

  // 2026-08-20: server config table joins the lookup chain (popup > DB > code
  // default), matching Steps 2 and 3. Lets the scoring knobs (cold-days,
  // winner-card cap, freshness window) be retuned from the DB for all users
  // without an extension release. readConfig() is cached per API client, so
  // this costs at most one HTTP call per run.
  let dbConfig = {};
  try { dbConfig = await sheetsClient.readConfig() || {}; } catch (e) { dbConfig = {}; }
  const cfg = (key, dflt) => {
    const local = config != null ? config[key] : undefined;
    if (local !== undefined && local !== null && local !== '') return local;
    const db = dbConfig[key];
    if (db !== undefined && db !== null && db !== '') return db;
    return dflt;
  };
  const pipelineRunId = (opts && (opts.pipelineRunId || opts.runId)) || null;
  const isPartial = !!(opts && opts.partial);
  const stoppedAfterStep = (opts && opts.stoppedAfterStep) || null;
  const nowMs = Date.now();
  const FRESH_HOURS = parseInt(cfg('data_staleness_hours', 48)) || 48;

  log('info', `🧮 Scoring "${seedKeyword}" on live market evidence (formula v${FORMULA_VERSION})${isPartial ? ' [PARTIAL — user stopped early]' : ''}`);

  // ─── Load everything for this seed ───
  const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');
  const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
  if (!seed) {
    log('error', `❌ Seed "${seedKeyword}" not found — cannot score`);
    return { verdict: 'ERROR', error: 'seed_not_found' };
  }
  const seedId = String(seed.seed_id);
  const productType = (seed.product_type || '').toLowerCase();
  // Physical goods review slower (shipping + usage time before a review) —
  // validated build-note from round 2. Threshold configurable per type.
  // 2026-08-20: the cold-review threshold is now decided by what is ACTUALLY on
  // the shelf, per keyword, not by seed.product_type — that column is NULL for
  // every seed in the database (nothing ever writes it; the popup's Product Type
  // only filters the Etsy search URL). So every niche silently got the 30-day
  // DIGITAL threshold, and the physical branch was dead code. Live cost, run
  // 4833 "leather jacket": physical goods reviewed on a digital clock, 11 of 12
  // keywords declared "Gone quiet". Step 2 already stores is_digital per listing
  // (from the "Digital Download" badge), so each keyword is judged on its own mix.
  const coldDigital = parseInt(cfg('nes_cold_days_digital', 30)) || 30;
  const coldPhysical = parseInt(cfg('nes_cold_days_physical', 45)) || 45;
  const coldDaysFor = (kwRows) => {
    // An explicit seed product_type still wins when someone has set one.
    if (productType === 'physical') return coldPhysical;
    if (productType === 'digital') return coldDigital;
    const known = kwRows.filter(r => r.listing && r.listing.is_digital !== undefined && r.listing.is_digital !== '');
    if (!known.length) return coldPhysical; // unknown mix → the patient clock
    const digitalShare = known.filter(r => String(r.listing.is_digital).toUpperCase() === 'TRUE').length / known.length;
    return digitalShare >= 0.5 ? coldDigital : coldPhysical;
  };
  // Reported in the legend; the per-keyword value is what actually scores.
  const coldDays = productType === 'physical' ? coldPhysical : coldDigital;

  // Evidence floors (2026-08-20, run 4831) — expressed as a SHARE of the sample
  // the user asked for, not as hand-picked constants. "Top Listings Per Keyword"
  // is the number of listings we set out to open for each keyword; the bar to
  // say anything is half of that, and the bar to say "Go for it" is three
  // quarters. So the thresholds track the setting: 12 → 6 and 9; 16 → 8 and 12.
  //
  // Why a keyword can legitimately land under its own target (all verified):
  //   · Etsy returned fewer cards than the target for that keyword;
  //   · a listing page came back blank/throttled — since 2026-08-08 we
  //     deliberately write NO audit row for a page that didn't render, rather
  //     than a row full of empty fields;
  //   · the keyword was never in the audit scope (Step 3 audits only the top
  //     the run's keyword cap) and merely shares listings with one that
  //     was — the case that produced run 4831's bogus A-grades.
  // Only the first two are real measurement; the third is what these floors
  // exist to reject.
  const auditTarget = parseInt(cfg('max_listings_per_keyword', 12)) || 12;
  const covGrade = parseFloat(cfg('nes_audit_coverage_grade', 0.5)) || 0.5;
  const covA     = parseFloat(cfg('nes_audit_coverage_a', 0.75)) || 0.75;
  // Absolute floor so a keyword with a handful of listings can't be graded on
  // two of them just because two is "most" of what exists.
  const auditFloor = parseInt(cfg('nes_min_audited_floor', 5)) || 5;

  const [{ rows: keywords }, { rows: listings }, { rows: audits }, { rows: stores }] = await Promise.all([
    sheetsClient.readSheet('etsy_keywords', { seed_id: seedId }),
    // 2026-08-21: freshness must be measured on snapshot_date — WHEN WE LOOKED
    // AT ETSY — not updated_at, which is ON UPDATE CURRENT_TIMESTAMP. Step 3
    // writes rating/thumbnail back with updateRowByMatch('listing_id'), which
    // matches EVERY row for that listing across every keyword and snapshot, so
    // auditing a listing today made its June and July rows look fresh. In the
    // school run that graded "back to school suncatcher" A · Go for it on six
    // listings last actually seen on Etsy between 9 June and 25 July.
    sheetsClient.readSheet('etsy_listings', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'snapshot_date' }),
    sheetsClient.readSheet('listing_audit', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'audited_at' }),
    // Freshest-first + 7-day window — the Worker caps large reads (~5000
    // rows); unscoped, the cap returned stale shops and this run's shops were
    // MISSING (run 4827: beatable share computed from almost no data → W
    // crushed → zero winner cards). Same read shape Step 3 uses for the same
    // reason.
    sheetsClient.readSheet('etsy_stores', {}, { sinceHours: 24 * 7, sinceColumn: 'last_updated', orderBy: 'last_updated', order: 'DESC' }),
  ]);
  // Market size comes from the Step-2 run-local stash — the Worker refuses
  // reads on search_snapshots (it carries other users' IP/geo context; 403 in
  // live run 4826), so the stash is the privacy-clean channel. Missing sizes
  // degrade gracefully (percentile treats null as largest → no false boost).
  let marketStash = {};
  try { marketStash = (await chrome.storage.local.get('nesMarket')).nesMarket || {}; } catch (e) {}
  log('info', `📥 Loaded ${keywords.length} keywords, ${listings.length} listings, ${audits.length} audits, market sizes for ${Object.keys(marketStash).length} keyword(s) (fresh ≤${FRESH_HOURS}h)`);

  const storeByName = new Map(stores.map(s => [(s.shop_name || '').toLowerCase(), s]));
  // newest audit per listing
  const auditByListing = new Map();
  for (const a of audits) {
    const k = String(a.listing_id);
    const prev = auditByListing.get(k);
    if (!prev || String(a.audited_at) > String(prev.audited_at)) auditByListing.set(k, a);
  }
  // discovery metadata (seasonality gate) — same-run stash from NES Step 1
  let famByKw = {};
  try {
    const stash = await chrome.storage.local.get('nesDiscovery');
    if (stash && stash.nesDiscovery && String(stash.nesDiscovery.seed_id) === seedId) {
      famByKw = stash.nesDiscovery.familyByKeyword || {};
    }
  } catch (e) { /* gate simply won't fire */ }

  // ─── Per-keyword metrics from the evidence ───
  const listingsByKw = new Map();
  for (const l of listings) {
    const k = String(l.keyword_id);
    if (!listingsByKw.has(k)) listingsByKw.set(k, []);
    listingsByKw.get(k).push(l);
  }

  // 2026-08-20: report on THIS RUN's keyword set when Step 1 published one.
  // Previously every keyword the seed had ever collected was scored, so a
  // report covered keywords the run never searched or audited — run 4831 graded
  // 58 keywords off 12 measured ones. Keywords outside the run still contribute
  // their listings/audits to the shared data pool; they just don't get graded
  // by a run that didn't look at them. No stash (solo Step 4, legacy pipeline)
  // → previous behaviour, scoped by the evidence floors.
  let runKeywordSet = null;
  try {
    const stash = (await chrome.storage.local.get('nesDiscovery')).nesDiscovery;
    if (stash && String(stash.seed_id) === seedId && Array.isArray(stash.runKeywords) && stash.runKeywords.length) {
      runKeywordSet = new Set(stash.runKeywords.map(k => String(k).toLowerCase().trim()));
    }
  } catch (e) { /* fall through to scoring everything with evidence */ }
  if (runKeywordSet) {
    log('info', `🎯 Reporting on the ${runKeywordSet.size} keyword(s) this run worked through`);
  }

  // ── This run's own evidence ───────────────────────────────────────────────
  // 2026-08-20: the report is ONE look at Etsy, so the arithmetic uses only what
  // this run captured — the listings Step 2 saw on each keyword's page and the
  // listings Step 3 opened. The database still stores everything (and other
  // pages of the product read it), but a verdict is never computed from rows a
  // previous run left behind. Before this, scoring took every listing for the
  // seed inside the freshness window, which is how a card came to read
  // "2 of 78 audited listings" for a keyword whose page one is six slots.
  // No stash (Step 4 run standalone, or the legacy pipeline) → previous
  // behaviour, bounded by the freshness window.
  let runListingIds = null;   // Map<kwId, Set<listing_id>>
  let runAuditedIds = null;   // Set<listing_id>
  try {
    const rs = (await chrome.storage.local.get('nesRun')).nesRun;
    if (rs && String(rs.seed_id) === seedId && rs.listingIdsByKw && Object.keys(rs.listingIdsByKw).length) {
      runListingIds = new Map(Object.entries(rs.listingIdsByKw).map(([k, v]) => [String(k), new Set((v || []).map(String))]));
      runAuditedIds = new Set((rs.auditedIds || []).map(String));
      const capturedTotal = [...runListingIds.values()].reduce((t, set) => t + set.size, 0);
      log('info', `📸 Scoring this run's own capture only: ${capturedTotal} listing(s) across ${runListingIds.size} keyword(s), ${runAuditedIds.size} of them opened and read`);
    }
  } catch (e) { /* fall through to the freshness window */ }
  // 2026-08-20: the fallback used to be silent. A Step 4 run on its own has no
  // stash, so it scored every row for this seed inside the freshness window —
  // the school fixture did exactly that: 341 keywords and 2,359 listings from
  // several earlier runs, presented as if one look at Etsy produced it. Say so,
  // in the log and on the report, so a verdict is never mistaken for fresh.
  const scopedToRun = !!runListingIds;
  if (!scopedToRun) {
    log('warn', '⚠️ No capture from this run found — scoring stored data for this seed from the last ' + FRESH_HOURS + 'h instead. Run Steps 1–3 for a report built on one fresh look at Etsy.');
  }

  const scored = [];
  const thin = []; // captured but not audited enough to grade honestly
  for (const kw of keywords) {
    const kwId = String(kw.keyword_id);
    if (runKeywordSet && !runKeywordSet.has((kw.keyword || '').toLowerCase().trim())) continue;
    let kwListings = listingsByKw.get(kwId) || [];
    if (runListingIds) {
      // Only the listings THIS run saw on this keyword's page.
      const seenThisRun = runListingIds.get(kwId);
      if (!seenThisRun || !seenThisRun.size) continue; // keyword wasn't searched this run
      kwListings = kwListings.filter(l => seenThisRun.has(String(l.listing_id)));
    }
    // 2026-08-21: ONE ROW PER LISTING. A keyword accumulates several snapshots
    // inside a single run (the pregnancy run had up to 9 for one keyword), and
    // listingsByKw held every one of them — 437 rows for 259 distinct listings.
    // So every share below was weighted by how many times a listing happened to
    // be re-snapshotted, not by what is on the shelf. Keep the most recent row
    // for each listing before anything is counted.
    {
      const newestByListing = new Map();
      for (const l of kwListings) {
        const lid = String(l.listing_id);
        const prev = newestByListing.get(lid);
        if (!prev || String(l.snapshot_date || '') > String(prev.snapshot_date || '')) {
          newestByListing.set(lid, l);
        }
      }
      kwListings = [...newestByListing.values()];
    }
    if (kwListings.length < 3) continue; // never snapshotted — not shown at all

    const rows = kwListings.map(l => {
      const lid = String(l.listing_id);
      const a = (runAuditedIds && !runAuditedIds.has(lid)) ? {} : (auditByListing.get(lid) || {});
      const st = storeByName.get((l.shop_name || '').toLowerCase()) || {};
      return {
        listing: l, audit: a,
        pos: num(l.search_position),
        sold: num(a.sold_24h) || 0,
        favs: num(a.favorites_count) || 0,
        carts: num(a.in_carts) || 0,
        views: num(a.views_24h) || 0,
        reviewAge: daysSince(a.last_review_date, nowMs), // null = no reviews captured
        renewAge: daysSince(a.listed_on, nowMs),         // null = renewal date not captured
        audited: !!a.audited_at,
        // 2026-08-21: the listing row is now the source of truth — Step 2 stores
        // what the search card showed. The stores table is only a fallback for
        // listings captured before that column existed: its read is capped at
        // 5000 rows across every seed and user, and run 4853 lost 35 of its own
        // shops to that cap, shrinking the beatable-slot denominator.
        shopReviews: num(l.shop_reviews) !== null ? num(l.shop_reviews) : num(st.shop_review_count),
        // 2026-08-21: star seller is only ever captured by Step 3 (the listing
        // detail page), so for most shops it is simply unknown — and it was
        // being read as "not a star seller", which is good news for the score
        // (5 of 40 winnability points reward a shelf without star sellers).
        // Same trap as the beatable-slot denominator: a shop missing from the
        // capped stores read made a niche look more winnable than it is.
        // null = unknown, and unknown is scored neutral further down.
        star: (st.is_star_seller === undefined || st.is_star_seller === null || st.is_star_seller === '')
          ? null
          : (String(st.is_star_seller) === '1' || String(st.is_star_seller).toUpperCase() === 'TRUE'),
        bes: String(l.is_bestseller).toUpperCase() === 'TRUE',
        thumb: a.etsy_thumbnail_url || l.thumbnail_url || '',
        title: l.title || '', url: l.etsy_url || '', shop: l.shop_name || '',
        price: num(l.price),
      };
    });
    const audited = rows.filter(r => r.audited);
    // 2026-08-19 (run 4827 lesson): a keyword outside the audit scope has NO
    // sold/review data — grading it reads as "gone quiet" when the truth is
    // "never measured". Honesty rule: too few audited listings → no grade; the
    // keyword goes to the report's "not enough data yet" bucket instead of the
    // danger zone. Raising Keywords Per Run / Top Listings Per Keyword widens coverage.
    //
    // 2026-08-20 (run 4831 lesson): the old floor of 3 was far too low, and
    // that let scraps masquerade as evidence. Step 3 audits only the top
    // keywords the run searched, but Step 4 scores EVERY
    // keyword holding fresh listings. A keyword outside the audit scope still
    // shows a few "audited" listings — not because we measured that keyword,
    // but because a listing it shares with an audited keyword carries an audit
    // row. "time management" and "task manager" were never even searched in
    // run 4831, yet surfaced as A-grade "Start here" cards off 3 and 4
    // incidental listings. The floor is now 6, and an A additionally needs a
    // real sample (MIN_AUDITED_FOR_A) — see the grade cap below.
    // Sample we intended to open for THIS keyword: the configured target, or
    // everything Etsy returned if that was less.
    // 2026-08-20: the seed is audited deeper than the per-keyword cap (see
    // erank-listing-workflow), so its slot window has to match — otherwise those
    // extra listings are read and then thrown away, and the seed's verdict still
    // swings with the cap. Declared here because the evidence floor below is the
    // FIRST use; when it sat further down, `intended` hit it in the temporal
    // dead zone and every run died with "Cannot access 'slotTarget' before
    // initialization".
    const isSeedKw = (kw.keyword || '').toLowerCase().trim() === String(seedKeyword).toLowerCase().trim();
    const slotTarget = isSeedKw
      ? Math.max(auditTarget, parseInt(cfg('nes_seed_min_listings', 16)) || 16)
      : auditTarget;
    const intended = Math.min(slotTarget, rows.length);
    const needToGrade = Math.max(auditFloor, Math.ceil(intended * covGrade));
    const needForA    = Math.max(auditFloor, Math.ceil(intended * covA));
    if (audited.length < needToGrade) {
      thin.push({ kw, kwId, n: rows.length, nAudited: audited.length, needed: needToGrade });
      continue;
    }
    // 2026-08-20 (run 4840): freshness counted a listing with NO captured review
    // date as COLD, i.e. "buyers left". That is the same unknown-equals-bad
    // error the market-size fix removed. Today 67 of 263 audited listings had no
    // review date (a brand-new listing has no reviews at all, and Etsy does not
    // always emit them), and every one of the run's 12 keywords was declared
    // "Gone quiet" on the back of it. Freshness is now measured ONLY over
    // listings whose review date we actually read.
    const withReviewData = audited.filter(r => r.reviewAge !== null);
    const kwColdDays = coldDaysFor(rows);
    // Too few dates to judge liveness at all → neutral, and the card says so
    // rather than the report calling a niche dead on missing data.
    const freshnessKnown = withReviewData.length >= 3;

    const beatThreshold = parseInt(cfg('max_shop_reviews_beatable', 300)) || 300;
    // 2026-08-20: BEATABLE SLOTS — the original idea behind this whole method,
    // and until now it was computed but never shown. It also wasn't measured
    // the way it is defined: beatShare ran over EVERY listing we had ever
    // captured for the keyword (up to 64), while a "slot" means a position on
    // the page a newcomer has to take. That's why run 4834 showed "62% of top
    // shops" on a card while Step 2 had logged "5/6 beatable slots" for the
    // same keyword. Both now mean one thing: of the top `auditTarget` slots by
    // search position, how many are held by a shop under the review threshold.
    // 2026-08-21: ONE ROW PER SLOT. Even after de-duplicating listings, two
    // different listings can each claim position 4 — one from an earlier
    // snapshot, one from a later one. Sorting by position and slicing the top N
    // then broke ties on array order, which made the headline figure partly
    // luck: "pregnancy gift" read 0 of 7 beatable slots in the live run and
    // 1 of 5 when the identical data was replayed. A slot is a position on the
    // page, so hold one listing per position — whichever we saw there last.
    const slotByPos = new Map();
    for (const r of rows) {
      if (r.pos === null) continue;
      const prev = slotByPos.get(r.pos);
      if (!prev || String(r.listing.snapshot_date || '') > String(prev.listing.snapshot_date || '')) {
        slotByPos.set(r.pos, r);
      }
    }
    // 2026-08-21: slots are always measured over the configured page depth,
    // even for the seed. The seed is AUDITED deeper (slotTarget) so its verdict
    // does not swing on a handful of listings, but "beatable slots" has to mean
    // the same thing on every row of the report and in the Step 2 log — the seed
    // was being measured over 15 slots while every other keyword used 8.
    const bySlot = slotByPos.size
      ? [...slotByPos.values()].sort((a, b) => a.pos - b.pos).slice(0, auditTarget)
      // Listings captured before search_position was recorded have no slots at
      // all; fall back to the old ordering so old data is not scored as if the
      // whole page were unbeatable.
      : [...rows].slice(0, auditTarget);
    // 2026-08-21: the denominator is every slot we looked at, not only the ones
    // whose shop we could size. Dropping unknown shops from the denominator made
    // Step 2 and Step 4 print different figures for the same keyword
    // ("6/8 beatable slots" in the log, "6 of 7" on the report) and quietly
    // flattered keywords whose shop data was missing. Unknown counts against the
    // keyword in both steps now.
    const shopKnown = bySlot;
    const slotsUnknown = bySlot.filter(r => r.shopReviews === null).length;
    const m = {
      n: rows.length, nAudited: audited.length,
      soldMed: median(audited.map(r => r.sold)),
      soldShare: audited.length ? audited.filter(r => r.sold > 0).length / audited.length : 0,
      // 2026-08-20 (Ali): a listing showing "In 20+ baskets" is not a listing
      // with zero sales — Etsy simply picked which single urgency line to print.
      // Sold and baskets are the same evidence of buying, so they carry the same
      // weight, always, not only when the sold badge is missing entirely.
      buyShare: audited.length ? audited.filter(r => r.sold > 0 || r.carts > 0).length / audited.length : 0,
      // 2026-08-20 (Ali): show WHICH signals a keyword actually produced, not
      // just a score. Etsy prints one urgency line per listing, so the mix tells
      // a seller what kind of shelf they are looking at — a page full of basket
      // counts reads differently from one full of view counts.
      nSold: audited.filter(r => r.sold > 0).length,
      nCarts: audited.filter(r => r.carts > 0).length,
      nViews: audited.filter(r => r.views > 0).length,
      nFavs: audited.filter(r => r.favs > 0).length,
      nRenewHot: audited.filter(r => r.renewAge !== null && r.renewAge <= 7).length,
      nHotReview: audited.filter(r => r.reviewAge !== null && r.reviewAge <= 7).length,
      buyMed: median(audited.map(r => Math.max(r.sold || 0, r.carts || 0))),
      // Etsy auto-renews on sale, so a fresh renewal is a recent-sale proxy.
      renewHotShare: (() => {
        const known = audited.filter(r => r.renewAge !== null);
        return known.length ? known.filter(r => r.renewAge <= 7).length / known.length : null;
      })(),
      nRenewDates: audited.filter(r => r.renewAge !== null).length,
      favsMed: median(audited.map(r => r.favs)),
      cartsShare: audited.length ? audited.filter(r => r.carts > 0).length / audited.length : 0,
      viewsShare: audited.length ? audited.filter(r => r.views > 0).length / audited.length : 0,
      // 2026-08-21 (audit #1): null when we have no review dates, NOT zero.
      // Zero meant "nothing was reviewed recently", which is a finding; the truth
      // was "we could not read the dates", which is a gap. School run: 169 of 435
      // audits carried no review date, 163 of them on listings that DO have
      // reviews. With hotShare pinned at 0 the freshness leg scored 20, under the
      // gate of 40, and the keyword was published as "Open shelf because buyers
      // left — old/no reviews". A scraper gap must never read as a dead niche.
      hotShare: freshnessKnown ? withReviewData.filter(r => r.reviewAge <= 7).length / withReviewData.length : null,
      coldShare: freshnessKnown ? withReviewData.filter(r => r.reviewAge > kwColdDays).length / withReviewData.length : null,
      freshnessKnown,
      nReviewDates: withReviewData.length,
      beatShare: shopKnown.length ? shopKnown.filter(r => r.shopReviews !== null && r.shopReviews < beatThreshold).length / shopKnown.length : 0,
      beatSlots: shopKnown.filter(r => r.shopReviews !== null && r.shopReviews < beatThreshold).length,
      beatOf: shopKnown.length,
      slotsUnknown,
      // Share among the shops whose status we actually know; null when we know
      // none, so the formula can score it neutral instead of guessing.
      starShare: (() => {
        const known = rows.filter(r => r.star !== null);
        return known.length ? known.filter(r => r.star).length / known.length : null;
      })(),
      nStarKnown: rows.filter(r => r.star !== null).length,
      besShare: rows.length ? rows.filter(r => r.bes).length / rows.length : 0,
      // 2026-08-20: keyword row first (persisted by Step 2, survives across
      // runs and users), run-local stash as fallback for a keyword captured
      // this run before the column existed / if the PATCH failed.
      market: (() => {
        const stored = num(kw.market_size);
        if (stored !== null) return stored;
        const e = marketStash[kwId];
        return num(e && typeof e === 'object' ? e.mkt : e);
      })(),
      adShare: (() => {
        const stored = num(kw.ad_share);
        if (stored !== null) return stored;
        const e = marketStash[kwId];
        const v = e && typeof e === 'object' ? e.adShare : null;
        return (v === null || v === undefined) ? null : v;
      })(),
      family: famByKw[(kw.keyword || '').toLowerCase()] ?? null,
      avgPrice: median(rows.map(r => r.price).filter(p => p !== null)),
    };
    scored.push({ kw, kwId, m, rows, intended, needToGrade, needForA });
  }

  // 2026-08-21 (audit #5): find out WHY there is nothing to score. When Step 2's
  // niche gate fails, Step 3 never opens a listing, so Step 4 sees zero audits and
  // used to blame the user's settings — run 4854 (nurse) told Ali to raise
  // "Keywords Per Run" when the truth was that only 3 of 8 keywords had beatable
  // page-one slots. The reason belongs in the report, not just in the log.
  let gateSkip = null;
  try {
    const nq = (await chrome.storage.local.get('nicheQualification')).nicheQualification;
    if (nq && nq.seedKeyword === seedKeyword && nq.nicheQualified === false) {
      gateSkip = {
        qualifiedCount: nq.qualifiedCount,
        measuredCount: nq.measuredCount != null ? nq.measuredCount : nq.totalProcessed,
        needed: nq.minQualifiedKw,
        minBeatableSlots: nq.minBeatableSlots,
        beatThreshold: nq.maxShopReviewsBeatable,
        // Per-keyword evidence, so a NO-GO is something the seller can read and
        // act on — which keywords, how much of page one was winnable on each —
        // instead of a bare refusal.
        keywords: Array.isArray(nq.keywordResults)
          ? nq.keywordResults
              .filter(k => k && k.keyword && k.reason !== 'extraction_failed')
              .map(k => ({
                keyword: k.keyword,
                beatableSlots: k.beatableSlots || 0,
                totalListings: k.totalListings || 0,
                qualified: !!k.qualified,
              }))
              .sort((a, b) => b.beatableSlots - a.beatableSlots)
          : [],
      };
    }
  } catch (e) { /* no stash — fall back to the generic wording */ }

  if (scored.length === 0) {
    log('warn', gateSkip
      ? `📭 Step 3 never ran — only ${gateSkip.qualifiedCount} of ${gateSkip.measuredCount} keywords had ${gateSkip.minBeatableSlots}+ beatable slots (needed ${gateSkip.needed}). Reporting that, not a data shortage.`
      : `📭 No keyword has enough fresh listing evidence to score — generating NO-GO report`);
  }

  // ─── Percentile normalization within the run ───
  // 2026-08-20 (run 4840): Etsy shows ONE urgency line per listing — "N people
  // bought this in the last 24 hours" OR "In 20+ baskets" OR "N views in the
  // last 24 hours". They are mutually exclusive, so a niche where Etsy favours
  // the basket badge yields NO sold data at all: 0 of 263 audited tote-bag
  // listings today, against 132 of 793 yesterday across other niches. Sold is
  // 24 of the 40 demand points, so an entire niche was being judged on a signal
  // Etsy simply wasn't printing.
  // When not one listing in the whole run carries a sold badge, the sold leg is
  // UNMEASURED (not zero) and its weight moves to the signals Etsy did print —
  // carts and views, which are buying intent, plus favourites. Same rule as an
  // unknown market size: absent data neither rewards nor punishes.
  // This also removes a latent trap: percentiles over all-zero sold return 100
  // for every keyword, which would award full marks for no sales at all.
  const soldMeasured = scored.some(s => s.m.soldShare > 0);
  if (!soldMeasured && scored.length) {
    log('info', `ℹ️ Etsy printed basket counts rather than "people bought this" on this niche — it shows only one urgency line per listing. Both count as buying evidence, so demand is read from baskets here.`);
  }
  // Buying evidence = sold badge OR basket count, weighted identically.
  const pBuy = percentiles(scored.map(s => s.m.buyShare));
  const pFavs = percentiles(scored.map(s => s.m.favsMed));
  // Market percentile among KNOWN sizes only. Run 4827 lesson: mapping unknown
  // market to "largest possible" silently cost those keywords 10 of 35
  // winnability points and mass-gated them as giant-owned. Unknown ≠ crowded.
  // Run 4828 lesson (the opposite error): dropping the component instead
  // REWARDED missing data. Unknown now scores mid-pack — see the neutral
  // fallback below — and the report names what was not measured.
  const known = scored.filter(s => s.m.market !== null);
  const pMktKnown = percentiles(known.map(s => s.m.market));
  const mktPct = new Map(known.map((s, i) => [s.kwId, pMktKnown[i]]));
  scored.forEach((s, i) => {
    const m = s.m;
    const hasMkt = m.market !== null;
    // 2026-08-20: unknown market scores NEUTRAL (mid-pack), it no longer drops
    // out of the formula. Dropping it renormalized the score over the remaining
    // legs, which quietly REWARDED missing data: in run 4828 every A-grade was
    // a keyword whose competition had never been measured, while every measured
    // keyword (150k-570k listings) lost points and capped at B. Neutral means
    // an unmeasured keyword is neither rewarded nor punished, and the report
    // says plainly which figure was missing. Same rule for ad share below.
    const nMktInv = hasMkt ? (100 - mktPct.get(s.kwId) + 100 / Math.max(known.length, 1)) : 50;
    // DEMAND (40) = buying evidence 24 · favourites 12 · views 2 · renewal 2.
    // "Buying evidence" is sold-badge OR basket count with equal weight (Ali,
    // 2026-08-20): Etsy prints one urgency line per listing, so which of the two
    // a seller sees is Etsy's choice, not a difference in the shelf.
    // Renewal recency is a small supporting leg — Etsy auto-renews on sale, but
    // sellers also renew by hand and listings roll over on expiry, so it earns
    // 2 points, not more. It renormalises away when we have no dates.
    const hasRenew = m.renewHotShare !== null;
    const dPts = 24 * pBuy[i] / 100
      + 12 * pFavs[i] / 100
      + 2 * m.viewsShare
      + (hasRenew ? 2 * m.renewHotShare : 0);
    const dDen = hasRenew ? 40 : 38;
    const D = dPts / dDen * 100;
    // Organic openness: 1 − ad share of the search page. Paid slots are
    // visibility a newcomer cannot earn organically. Weight kept small (5) —
    // the ads column was empty until 2026-08-19, so this component has no
    // validation history yet; it earns weight after calibration. Unknown ad
    // share scores neutral (0.5), same honesty rule as market size above.
    const hasAds = m.adShare !== null;
    const adOpen = hasAds ? (1 - m.adShare) : 0.5;
    // Denominator is now constant (40) — every keyword is scored on the same
    // scale whether or not we measured its market/ads.
    // Unknown star-seller share scores neutral (0.5), the same honesty rule as
    // market size and ad share above.
    const starShare = m.starShare === null ? 0.5 : m.starShare;
    const wPts = 15 * m.beatShare
      + 10 * (Math.min(nMktInv, 100) / 100)
      + 5 * (1 - starShare) + 5 * m.besShare
      + 5 * adOpen;
    const W = wPts / 40 * 100;
    // Unknown freshness scores NEUTRAL (50), the same honesty rule already applied
    // to market size, ad share and star sellers. A keyword we could not measure is
    // neither rewarded nor punished — and cannot be gated as "gone quiet".
    const F = m.hotShare === null
      ? 50
      : (15 * m.hotShare + 10 * (1 - m.coldShare)) / 25 * 100;
    // Absolute demand anchor (round-2 lesson): percentile demand is meaningless
    // when NOTHING in the run sells — require real evidence somewhere.
    // Absolute anchor — real evidence must exist somewhere. When Etsy prints no
    // sold badges at all, a basket count is the strongest thing it will show.
    const demandAbsolute = m.buyShare > 0 || (m.hotShare || 0) > 0;
    // 2026-08-21 (run 4856, airbnb): "Gone quiet" means BUYERS LEFT, so it must
    // not be decided on review recency alone. Every one of that run's 5 keywords
    // was written off as a dead niche while 43% of the seed's page-one listings
    // had a live basket and 60% had renewed inside a week. What was actually true
    // is narrower: reviews lag in digital-template niches — people rarely review a
    // downloaded PDF — and the youngest review was 8 days old rather than 7.
    //
    // Renewal was the obvious substitute signal and it is NOT usable: it runs
    // 60-73% in every run measured, alive or dead, so it cannot separate them.
    // Review recency can (5% on airbnb vs 33% on nurse). The metric was right;
    // the conclusion drawn from it was too strong. So the freshness gate now
    // fires only when the shelf ALSO shows no-one buying.
    const quietBuyFloor = parseFloat(cfg('nes_quiet_buy_floor', 0.25)) || 0.25;
    const buyersActive = m.buyShare >= quietBuyFloor;
    const gates = [];
    if (D < 25 || !demandAbsolute) gates.push('demand');
    if (W < 30) gates.push('winnability');
    if (F < 40 && !buyersActive) gates.push('freshness');
    const NES = 0.40 * D + 0.35 * W + 0.25 * F;
    let grade = gates.length ? 'D' : (NES >= 65 ? 'A' : NES >= 45 ? 'B' : NES >= 30 ? 'C' : 'D');
    // 2026-08-20 (run 4831): two caps on 'A', both from cards that were
    // indefensible on their own face.
    //  1. "task manager" showed "0 of 4 audited listings sold in the last 24h"
    //     and still read "A · Go for it". Fresh reviews alone passed the demand
    //     anchor. Nothing may be called a go-for-it opening when not one
    //     audited listing has a sale on it — recent reviews make it worth a
    //     test (B), never a recommendation.
    //  2. An A off a handful of listings is a guess dressed as a verdict. A
    //     needs a real sample of that keyword's own top listings.
    let capReason = null;
    // 2026-08-21 (Ali): the "Minimum beatable slots" setting finally applies to
    // the grade. Step 2 has always used it to qualify a keyword — 3 of the top
    // slots must be held by shops under the review threshold — but the scorer
    // ignored it, so beatable slots were worth only 15 of the 40 winnability
    // points and a page owned by 5,000-review shops could still be carried to
    // "worth testing" by market size and ad share. "pregnancy announcement
    // shirt" came out B on 1 beatable slot of 5. Below the minimum, a keyword
    // cannot be a recommendation at any score.
    const minBeatSlots = parseInt(cfg('min_beatable_slots', 3)) || 3;
    if ((grade === 'A' || grade === 'B') && m.beatOf > 0 && m.beatSlots < minBeatSlots) {
      grade = 'C';
      capReason = 'slots';
    }
    if (grade === 'A' && m.buyShare === 0) { grade = 'B'; capReason = 'nosales'; }
    // 2026-08-21 (audit #1, second half): unknown freshness scores neutral so a
    // scraper gap can no longer read as "gone quiet" — but neutral must not buy a
    // recommendation either. "Go for it" claims the shelf is alive right now, and
    // with no review dates we cannot claim that. Same rule as the no-sales cap.
    if (grade === 'A' && m.hotShare === null) { grade = 'B'; capReason = 'nofreshness'; }
    // Buyers being active keeps a stale-review shelf out of the "gone quiet" bin,
    // but it does not make it a go-for-it: "A" claims the shelf is alive right now
    // and week-old reviews do not show that. Held at B, reason stated on the row.
    if (grade === 'A' && F < 40) { grade = 'B'; capReason = 'stalereviews'; }
    if (grade === 'A' && m.nAudited < s.needForA) { grade = 'B'; capReason = 'sample'; }
    let seasonal = false;
    // Seasonality cap. A collapsed autosuggest family means Etsy has few live
    // queries for the term — validated on "mothers day shirt" (1 suggestion in
    // August). But a long-tail keyword has a small family BY NATURE, so family
    // size alone punished specificity and called it seasonality: run 4849 tagged
    // "editable school labels" as "low current search interest" in the third week
    // of August, on 7 of 8 beatable slots and 74% of listings renewed that week.
    //
    // Word count was the obvious discriminator and it is wrong — it would exempt
    // "mothers day shirt", the exact case the rule was built for. So the cap now
    // asks the LIVE evidence instead: a small family only means "out of season"
    // when the shelf is also quiet. If listings there are renewing or being
    // reviewed this week, buyers are active now and the small family is just
    // specificity.
    const shelfIsAwake = (m.renewHotShare !== null && m.renewHotShare >= 0.4)
      || (m.hotShare || 0) >= 0.3;
    if (m.family !== null && m.family <= 8 && grade === 'A' && !shelfIsAwake) { grade = 'B'; seasonal = true; }
    // trap classification for the report
    let trap = null;
    if (gates.includes('winnability') && D >= 50) trap = 'giants';
    // 2026-08-21 (run 4856): "Gone quiet — old/no reviews" was printed on keywords
    // whose own signal line said "1 reviewed this week". Both cannot be true. The
    // gate is right to hold these back — few buyers AND slow reviews — but the
    // label has to match the evidence, so a shelf with a review inside the week is
    // called thin rather than dead.
    else if (gates.includes('freshness')) trap = ((m.hotShare || 0) === 0) ? 'quiet' : 'thin';
    else if (gates.length) trap = 'weak';
    Object.assign(s, { D: Math.round(D), W: Math.round(W), F: Math.round(F), NES: Math.round(NES), grade, gates, trap, seasonal, capReason, minBeatSlots });
  });
  scored.sort((a, b) => b.NES - a.NES);

  const enterable = scored.filter(s => !s.gates.length && (s.grade === 'A' || s.grade === 'B'));
  const underlyingVerdict = enterable.length > 0 ? 'GO' : 'NO-GO';
  const hasAudits = audits.length > 0;
  const verdict = isPartial
    ? partialDisplayVerdict({
        stoppedAfterStep,
        underlyingVerdict,
        gateSkip,
        hasAudits,
      })
    : underlyingVerdict;
  const scoreStatus = isPartial ? partialScoreStatus(underlyingVerdict) : underlyingVerdict;
  log('info', `⚖️ ${scored.length} keywords graded — ${scored.filter(s => s.grade === 'A').length} A, ${scored.filter(s => s.grade === 'B').length} B → verdict ${verdict}${thin.length ? (gateSkip
      ? ` (${thin.length} searched but not opened — the niche gate stopped the run, see the report)`
      : ` (${thin.length} more captured but not yet audited — raise Keywords Per Run or Top Listings Per Keyword, or re-run)`) : ''}`);

  // ─── Winners: beatable shops first, +1 optional Category king ───
  const winnersMax = parseInt(cfg('nes_winners_max', 8)) || 8;
  const beatThreshold = parseInt(cfg('max_shop_reviews_beatable', 300)) || 300;
  const winners = [];
  let king = null;
  // 2026-08-20 (run 4828): one listing can rank for several A/B keywords and
  // was nominated by each — the school report showed the same handprint-craft
  // card three times. Each listing gets ONE card (first/highest-scored keyword
  // wins it); the slot freed goes to the keyword's next-best beatable winner.
  const seenWinnerIds = new Set();
  for (const s of enterable) {
    const proof = s.rows.filter(r => r.audited && (r.sold > 0 || (r.reviewAge !== null && r.reviewAge <= 7)) && r.title);
    // beatable winners: smallest shop first
    const beatable = proof.filter(r => r.shopReviews !== null && r.shopReviews < beatThreshold)
      .sort((a, b) => a.shopReviews - b.shopReviews);
    let taken = 0;
    for (const r of beatable) {
      if (taken >= 2 || winners.length >= winnersMax) break;
      const wid = String(r.listing.listing_id);
      if (seenWinnerIds.has(wid)) continue;
      seenWinnerIds.add(wid);
      winners.push({ ...r, forKw: s.kw.keyword, forGrade: s.grade });
      taken++;
    }
    // candidate king: strongest big-shop seller (study material, never a target)
    const bigs = proof.filter(r => r.shopReviews !== null && r.shopReviews >= beatThreshold)
      .sort((a, b) => b.sold - a.sold);
    if (!king && bigs.length && bigs[0].sold > 0) king = { ...bigs[0], forKw: s.kw.keyword };
  }
  log('info', `🏆 ${winners.length} beatable winner(s) selected${king ? ' + 1 category king (reference)' : ''}`);

  // ─── Persist niche_scores (same table/fields as legacy + formula_version) ───
  const totalShops = new Set(listings.map(l => (l.shop_name || '').toLowerCase()).filter(Boolean)).size;
  const avgPriceAll = median(scored.map(s => s.m.avgPrice).filter(p => p));
  try {
    await sheetsClient.appendRowsByName('niche_scores', [{
      run_id: pipelineRunId,
      category: seed.category || '',
      seed_keyword: seedKeyword,
      product_type: seed.product_type || '',
      total_keywords: keywords.length,
      validated_keywords: enterable.length,
      total_listings: new Set(listings.map(l => String(l.listing_id))).size,
      total_shops: totalShops,
      avg_price: (avgPriceAll || 0).toFixed(2),
      // '0' not '' — these are DECIMAL columns; empty string fails under
      // MySQL strict mode (live-test audit finding #1). NES doesn't use eRank
      // metrics, so zero is the honest "not applicable" here, matching the
      // legacy writer's no-data behaviour.
      avg_competition: '0',
      avg_searches: '0',
      weak_competitor_pct: scored.length ? (100 * scored.reduce((t, s) => t + s.m.beatShare, 0) / scored.length).toFixed(1) : '0',
      readiness_score: `${enterable.length}/${scored.length}`,
      status: scoreStatus,
      report_url: '',
      scored_at: new Date().toISOString(),
      formula_version: FORMULA_VERSION,
    }]);
    log('info', `💾 niche_scores written (run_id=${pipelineRunId}, formula v${FORMULA_VERSION}${isPartial ? ', PARTIAL' : ''})`);
  } catch (e) {
    log('warn', `⚠️ niche_scores write failed: ${e.message}`);
  }

  // ─── Plausibility self-checks ────────────────────────────────────────────
  // 2026-08-20: every bug this pipeline shipped was visible in its own output —
  // keywords graded off scraps, A-grades with no evidence, "gone quiet" across
  // a whole live niche, word-salad keywords like "decor home a well", an audit
  // step that planned 100 listings and wrote 54. Ali found each one by reading
  // a report; the code never objected. These checks make the run object out
  // loud. They only WARN — a surprising market is not a bug, and refusing to
  // report would be worse — but nothing implausible leaves silently again.
  const selfChecks = [];
  const check = (cond, msg) => { if (cond) selfChecks.push(msg); };
  if (scored.length) {
    const nA = scored.filter(s => s.grade === 'A').length;
    const gradedNoEvidence = scored.filter(s => s.m.buyShare === 0 && (s.m.hotShare || 0) === 0 && (s.grade === 'A' || s.grade === 'B'));
    check(gradedNoEvidence.length > 0,
      `${gradedNoEvidence.length} keyword(s) graded A/B with no buying signal AND no fresh review: ${gradedNoEvidence.slice(0,3).map(s => `"${s.kw.keyword}"`).join(', ')}`);
    check(scored.every(s => s.trap === 'quiet' || s.trap === 'thin') && scored.length >= 4,
      `every one of ${scored.length} keywords came back "gone quiet" — check review-date capture before trusting this`);
    check(nA === 0 && scored.length >= 8 && scored.some(s => s.m.buyShare >= 0.8 && s.m.beatShare >= 0.5),
      `no keyword reached A although at least one has strong buying signals on a beatable page — check the A cap`);
    // Keyword hygiene: a repeated word or a permutation of the seed means the
    // discovery funnel produced a string no buyer types (run 4851).
    // 2026-08-20 (re-run of 4851): the first version of this check caught only a
    // repeated word or an exact permutation of the seed, so it flagged
    // "decor home decor" and "decor home" but MISSED "decor home a well",
    // "decor home living room" and "decor home accents" — the three actually
    // sitting at A. The thing they share: every seed word is present, but the
    // seed PHRASE isn't, i.e. the seed's words appear reordered. That is the
    // signature of an n-gram that crossed a comma in an Etsy title, and it never
    // describes a phrase a buyer types.
    const seedLower = String(seedKeyword).toLowerCase().trim();
    const seedWords = seedLower.split(/\s+/).filter(Boolean);
    const junky = scored.filter(s => {
      const kwLower = String(s.kw.keyword || '').toLowerCase().trim();
      const w = kwLower.split(/\s+/).filter(Boolean);
      const dupWord = new Set(w).size !== w.length;
      // Order matters, not just presence. "leather bomber jacket" keeps the
      // seed's words in the seed's ORDER with a word inserted — a perfectly good
      // keyword. "decor home accents" REVERSES them, which is what an n-gram
      // crossing a comma produces. Checking presence alone flagged 14 keywords
      // on the "leather jacket" seed that were all legitimate.
      const hasEverySeedWord = seedWords.length > 1 && seedWords.every(t => w.includes(t));
      let orderKept = true;
      if (hasEverySeedWord) {
        let at = -1;
        for (const t of seedWords) {
          const pos = w.indexOf(t, at + 1);
          if (pos === -1) { orderKept = false; break; }   // appears only earlier → reordered
          at = pos;
        }
      }
      const seedWordsScrambled = hasEverySeedWord && !orderKept;
      return dupWord || seedWordsScrambled;
    });
    check(junky.length > 0,
      `${junky.length} keyword(s) look machine-made rather than typed by a buyer: ${junky.slice(0,3).map(s => `"${s.kw.keyword}"`).join(', ')}`);
    // Same shelf under several spellings. Bucketing by exact thousands missed
    // run 4851's 22,024,186 / 22,027,863 / 22,024,369 — Etsy's count drifts by a
    // few thousand between requests, so compare RELATIVELY: within 0.5% of each
    // other is the same result set, not three markets that happen to be close.
    const sizes = scored.filter(s => s.m.market).map(s => ({ kw: s.kw.keyword, n: s.m.market }));
    let sameShelfGroup = null;
    for (const a of sizes) {
      const near = sizes.filter(b => Math.abs(b.n - a.n) / a.n < 0.005);
      if (near.length >= 3 && (!sameShelfGroup || near.length > sameShelfGroup.length)) sameShelfGroup = near;
    }
    check(!!sameShelfGroup,
      sameShelfGroup
        ? `${sameShelfGroup.length} keywords report the same market size (~${Math.round(sameShelfGroup[0].n / 1000)}k): ${sameShelfGroup.slice(0,3).map(x => `"${x.kw}"`).join(', ')} — Etsy is serving one result set to several spellings of one query`
        : '');
  }
  if (selfChecks.length) {
    log('warn', `🔎 Self-check flagged ${selfChecks.length} thing(s) about this report:`);
    for (const c of selfChecks) log('warn', `   • ${c}`);
  } else if (scored.length) {
    log('info', `🔎 Self-check passed — nothing implausible in ${scored.length} graded keyword(s)`);
  }

  // ─── Replay fixture ──────────────────────────────────────────────────────
  // Dumps exactly what this step read, so scoring changes can be re-run offline
  // against real Etsy data in seconds instead of a 40-minute live crawl. Off by
  // default; set nes_dump_inputs in the config table to switch it on.
  if (String(cfg('nes_dump_inputs', '')) === '1') {
    try {
      const fixture = {
        capturedAt: new Date().toISOString(),
        seedKeyword, seedId, productType,
        // Derived numbers are for reading the fixture by eye. The RAW maps below
        // are what a replay must feed back: cfg() reads popup config first, then
        // the DB config table, so a fixture without them replays on code
        // defaults and silently produces different grades than the live run did
        // (school run: 3 of 52 moved for this reason alone).
        derived: {
          auditTarget, beatThreshold, coldDigital, coldPhysical, winnersMax,
          covGrade, covA, auditFloor, freshHours: FRESH_HOURS,
        },
        // Never let a licence key or any credential into a file the user shares.
        configRaw: scrubSecrets(config),
        dbConfig: scrubSecrets(dbConfig),
        runStash: {
          listingIdsByKw: runListingIds ? Object.fromEntries([...runListingIds].map(([k, v]) => [k, [...v]])) : null,
          auditedIds: runAuditedIds ? [...runAuditedIds] : null,
          runKeywords: runKeywordSet ? [...runKeywordSet] : null,
          marketStash, famByKw,
          // 2026-08-21: Step 2's gate outcome decides whether the report explains
          // itself as "too crowded" or "not enough data". A fixture without it
          // cannot reproduce that branch offline.
          gateSkip,
        },
        rows: { seeds, keywords, listings, audits, stores },
        producedVerdict: verdict,
        producedGrades: scored.map(s => ({ kw: s.kw.keyword, grade: s.grade, D: s.D, W: s.W, F: s.F, NES: s.NES })),
        selfChecks,
      };
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(fixture));
      await chrome.downloads.download({
        url,
        filename: `nm_replay_${String(seedKeyword).replace(/[^a-z0-9]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.json`,
        saveAs: false,
      });
      log('info', `🧪 Replay fixture saved (${listings.length} listings, ${audits.length} audits) — scoring changes can be tested against this run offline`);
    } catch (e) {
      log('warn', `⚠️ Could not save replay fixture: ${e.message}`);
    }
  }

  // ─── Report ───
  // 2026-08-21: the report claimed "read 437 top listings" when 437 was the
  // number of DATABASE ROWS — the same listing appears once per snapshot, and
  // this run had 259 distinct listings. Scoring already de-duplicates; the
  // sentence the seller reads has to match it.
  const distinctListings = new Set(listings.map(l => String(l.listing_id))).size;
  const html = buildReport({
    seedKeyword, seed, scored, thin, enterable, winners, king, verdict, pipelineRunId, listings, distinctListings,
    coldDays, winnersMax, auditTarget, coldDigital, coldPhysical, beatThreshold, freshHours: FRESH_HOURS,
    soldMeasured, scopedToRun, gateSkip,
    partial: isPartial,
    stoppedAfterStep,
    underlyingVerdict,
    keywordCount: keywords.length,
    listingCount: distinctListings,
  });
  const dateStr = new Date().toISOString().slice(0, 10);
  const partialSuffix = isPartial ? '_partial' : '';
  const filename = `etsyhunt_${seedKeyword.replace(/[^a-z0-9]+/gi, '_')}_${dateStr}${partialSuffix}.html`;
  await deliverReport(html, {
    filename,
    seedKeyword,
    verdict,
    reportType: isPartial ? 'partial' : (gateSkip ? 'gate-skip' : 'full'),
    partial: isPartial,
    stoppedAfterStep,
    completedSteps: isPartial ? completedStepsFor(stoppedAfterStep) : ['discovery', 'snapshots', 'audits', 'scoring'],
  }, log);

  log('success', `🏁 Step 4 DONE! "${seedKeyword}" → ${verdict} (${enterable.length} enterable of ${scored.length} scored)`);
  return {
    verdict,
    underlyingVerdict,
    enterable: enterable.length,
    scoredCount: scored.length,
    formulaVersion: FORMULA_VERSION,
    partial: isPartial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report generator — the v2.2/v2.3 mockup (docs/mockups/report-v2-mockup.html)
// with live data. Plain language for non-technical sellers; hazard-zone for
// do-not-enter keywords; honesty disclosures built in.
// ─────────────────────────────────────────────────────────────────────────────
function buildReport(ctx) {
  const { seedKeyword, scored, thin, enterable, winners, king, verdict, listings, coldDays, auditTarget, coldDigital, coldPhysical } = ctx;
  const beatThresholdLegend = ctx.beatThreshold || 300;
  const FRESH_HOURS_LEGEND = ctx.freshHours || 48;
  // Coverage counter for the honesty footer — how many graded keywords we
  // actually have an Etsy market size for (2026-08-20).
  const mktMeasured = scored.filter(s => s.m.market !== null).length;
  const gradeChip = (s) => {
    if (s.grade === 'A') return '<span class="chip g-a">A · Go for it</span>';
    if (s.grade === 'B') return '<span class="chip g-b">B · Worth testing</span>';
    if (s.trap === 'giants') return '<span class="chip g-lock">Owned by giants</span>';
    if (s.trap === 'quiet') return '<span class="chip g-skip">Gone quiet</span>';
    if (s.trap === 'thin') return '<span class="chip g-skip">Too thin to call</span>';
    return '<span class="chip g-skip">' + (s.grade === 'C' ? 'C · Tread carefully' : 'Skip for now') + '</span>';
  };
  const reason = (s) => {
    if (s.seasonal) return 'Capped: low current search interest (seasonal?)';
    // 2026-08-20: name the cap instead of letting a downgraded keyword wear a
    // generic B line — the seller should see WHY it isn't a go-for-it.
    if (s.capReason === 'slots') return `Only ${s.m.beatSlots} of ${s.m.beatOf} top slots are winnable — below the ${s.minBeatSlots} this run asks for`;
    if (s.capReason === 'stalereviews') return 'Buyers are active, but the newest review here is over a week old — reviews lag in this niche';
    if (s.capReason === 'nofreshness') return 'Buyers are active, but we could not read review dates here — held at B until we can';
    if (s.capReason === 'nosales') return 'Reviews are fresh, but no listing shows a sale or a basket yet';
    if (s.capReason === 'sample') return `Held at B — ${s.m.nAudited} of ${s.intended} listings audited, short of the ${s.needForA} an A needs`;
    if (s.grade === 'A') return 'Small shops, real sales, fresh reviews';
    if (s.grade === 'B') return s.W >= s.D ? 'Open shelf — demand modest but real' : 'Buyers active — pick a specific angle';
    if (s.trap === 'giants') return 'Money flows, but big shops hold page 1';
    if (s.trap === 'quiet') return 'Open shelf because buyers left — old/no reviews';
    if (s.trap === 'thin') return `Open shelf, but only ${s.m.nSold + s.m.nCarts} of ${s.m.nAudited} listings show a buyer and reviews are slow here`;
    return 'Not enough going for it yet';
  };
  // 2026-08-20 (run 4833, Ali's call): "Buyers buying" is a within-run ranking,
  // so in a niche where NOTHING sold it still printed 68-95 next to a Sold (24h)
  // column of straight zeros. A number implies a measurement we don't have —
  // when not one audited listing on the keyword carries a sale, say that instead
  // of scoring it. The underlying D score still drives gates and ranking; only
  // the display changes.
  const noSales = (s) => s.m.buyShare === 0;
  const NO_SALES_NOTE = 'No audited listing on this keyword carries a sale in Etsy\u2019s 24-hour counter. Favourites and reviews still count toward the score, but there is no confirmed sale to show.';
  // What evidence did this keyword actually produce? Etsy prints ONE urgency line
  // per listing, so the mix matters: a shelf full of basket counts reads very
  // differently from one full of view counts. Zero-count signals are omitted
  // rather than printed as "0 sold" — absence here is Etsy's choice of badge,
  // not a measurement (2026-08-20, Ali).
  const signalStrip = (m) => {
    const parts = [];
    if (m.nSold > 0)      parts.push(`<b>${m.nSold}</b> sold in 24h`);
    if (m.nCarts > 0)     parts.push(`<b>${m.nCarts}</b> in baskets`);
    if (m.nViews > 0)     parts.push(`<b>${m.nViews}</b> being viewed`);
    if (m.nRenewHot > 0)  parts.push(`<b>${m.nRenewHot}</b> renewed this week`);
    if (m.nHotReview > 0) parts.push(`<b>${m.nHotReview}</b> reviewed this week`);
    if (!parts.length) return `<span class="signals none">no buyer signals on any of the ${m.nAudited} listings we opened</span>`;
    return `<span class="signals">${parts.join(' · ')} <span class="of">of ${m.nAudited} listings opened</span></span>`;
  };
  const bar = (v, cls) => `<span class="minibar ${cls}"><i style="width:${Math.min(v, 100)}%"></i></span>${v}`;
  const barCls = (v) => v >= 60 ? 'mb-go' : v >= 35 ? 'mb-mid' : 'mb-low';

  // ── The seed's own verdict, answered first ───────────────────────────────
  // 2026-08-20 (Ali, run 4834): a seller types "tote bag" and the report opened
  // with "shoulder bag — A · Go for it", while tote bag itself sat 7th in the
  // table. The seed was graded (B, 1/6 beatable slots, half a million listings)
  // but "Start here" is capped at 3 cards and it ranked 4th, so the one question
  // the seller actually asked went unanswered. This block answers it before
  // anything else, in plain words, including the cases where we could NOT
  // answer it.
  const seedNorm = String(seedKeyword).toLowerCase().trim();
  const seedScored = scored.find(s => (s.kw.keyword || '').toLowerCase().trim() === seedNorm) || null;
  const seedThin = !seedScored ? (thin.find(t => (t.kw.keyword || '').toLowerCase().trim() === seedNorm) || null) : null;
  const seedVerdictHtml = (() => {
    const shell = (cls, chip, answer, why, nums) => `
<section class="seedbox ${cls}">
  <div class="sb-head"><span class="sb-kw">${esc(seedKeyword)}</span>${chip}</div>
  <div class="sb-body">
    <div class="sb-answer">${answer}</div>
    <div class="sb-why">${why}</div>
    ${nums ? `<div class="sb-nums">${nums}</div>` : ''}
  </div>
</section>`;

    if (seedScored) {
      const m = seedScored.m;
      const nums = [
        m.beatOf ? `<span class="sb-num">Beatable slots <b>${m.beatSlots}/${m.beatOf}</b></span>` : '',
        `<span class="sb-num">Buyers acting <b>${Math.round(m.buyShare * m.nAudited)}</b> of <b>${m.nAudited}</b> listings</span>`,
        m.renewHotShare !== null && m.renewHotShare > 0 ? `<span class="sb-num">Renewed this week <b>${Math.round(m.renewHotShare * 100)}%</b></span>` : '',
        m.hotShare === null
          ? `<span class="sb-num">Reviewed this week <span class="unmeasured">not captured</span></span>`
          : `<span class="sb-num">Reviewed this week <b>${Math.round(m.hotShare * 100)}%</b></span>`,
        m.market ? `<span class="sb-num">Competing listings <b>${m.market.toLocaleString()}</b></span>` : '',
      ].filter(Boolean).join('');
      const others = enterable.filter(e => e !== seedScored).length;
      const pointer = others
        ? ` We found <b>${others}</b> related opening${others === 1 ? '' : 's'} worth a look — they're in <i>Start here</i> below.`
        : '';

      if (seedScored.grade === 'A') {
        return shell('sb-go', '<span class="chip g-a">A · Go for it</span>',
          'Yes — this is worth entering.',
          `Buyers are active on “${esc(seedKeyword)}” and enough of page one is held by shops you can realistically outrank.${pointer}`, nums);
      }
      if (seedScored.grade === 'B') {
        const watch = seedScored.capReason === 'nosales'
          ? 'not one audited listing shows a sale or a basket yet — reviews are fresh, but the buying proof is missing'
          : (m.beatOf && m.beatSlots / m.beatOf < 0.5
              ? 'most of page one is held by established shops, so ranking will be slow'
              : 'the numbers are good but not outstanding on every front');
        return shell('sb-test', '<span class="chip g-b">B · Worth testing</span>',
          'Yes, but go in with a narrower angle.',
          `“${esc(seedKeyword)}” has real demand — the catch is that ${watch}. Enter with a specific, differentiated version rather than a general one.${pointer}`, nums);
      }
      if (seedScored.trap === 'giants') {
        return shell('sb-no', '<span class="chip g-lock">Owned by giants</span>',
          'Not as a new shop.',
          `Money is moving on “${esc(seedKeyword)}”, but shops with long sales histories hold page one${m.beatOf ? ` — only ${m.beatSlots} of ${m.beatOf} top slots are winnable` : ''}. A new listing would sit where nobody looks.${pointer}`, nums);
      }
      if (seedScored.trap === 'thin') {
        return shell('sb-no', '<span class="chip g-skip">Too thin to call</span>',
          'Not yet — the signals are too faint.',
          `Page one for “${esc(seedKeyword)}” is open to a new shop, but only a handful of those listings show a buyer and reviews come slowly here. There is not enough happening to justify building on it today.${pointer}`, nums);
      }
      if (seedScored.trap === 'quiet') {
        return shell('sb-no', '<span class="chip g-skip">Gone quiet</span>',
          'No — it looks easy because buyers left.',
          `Page one for “${esc(seedKeyword)}” is full of shops you could outrank, but the listings there are not selling and their reviews have gone cold. Easy to rank for, nothing to earn.${pointer}`, nums);
      }
      const gatedOut = seedScored.gates && seedScored.gates.length;
      return shell('sb-no', `<span class="chip g-skip">${gatedOut ? 'Not yet' : 'C · Tread carefully'}</span>`,
        gatedOut ? 'Not on the evidence we found.' : 'Possible, but nothing here stands out.',
        gatedOut
          ? `“${esc(seedKeyword)}” did not clear the bar on ${seedScored.gates.join(' or ')} this run.${pointer}`
          // A C passed every gate — it simply scored low overall. Saying it
          // "failed" the bars would be wrong, and this is the most-read box.
          : `“${esc(seedKeyword)}” clears every bar — buyers are there and the page is not locked — but nothing about it is strong enough to lead with. Treat it as a background option rather than the thing you build around.${pointer}`, nums);
    }

    if (seedThin) {
      const others = enterable.length;
      // 2026-08-21 (audit #5): when Step 2's gate stopped the run, the seed was
      // not "unmeasured" — it was measured and the page was full. Saying "raise
      // your settings" there sends the seller to fix a setting that is not the
      // problem.
      if (ctx.gateSkip) {
        return shell('sb-no', '<span class="chip g-skip">Too crowded to enter</span>',
          'Page one belongs to established shops.',
          `We searched <b>${ctx.gateSkip.measuredCount}</b> keyword${ctx.gateSkip.measuredCount === 1 ? '' : 's'} around “${esc(seedKeyword)}” and only <b>${ctx.gateSkip.qualifiedCount}</b> had at least <b>${ctx.gateSkip.minBeatableSlots}</b> of the top slots held by shops under ${Number(ctx.gateSkip.beatThreshold || 300).toLocaleString()} reviews. We stopped there rather than spend half an hour opening listings to confirm what page one already says. Try a narrower angle on this idea, or a different seed.`, '');
      }
      return shell('', '<span class="chip g-skip">Not measured</span>',
        'We could not answer this one honestly.',
        `We opened only <b>${seedThin.nAudited}</b> of the <b>${seedThin.needed}</b> listings a verdict needs for “${esc(seedKeyword)}” this run, so we will not grade it. Raise <b>Keywords Per Run</b> or <b>Top Listings Per Keyword</b> and run this seed again.${others ? ` ${others} related keyword${others === 1 ? ' was' : 's were'} measured — see <i>Start here</i> below.` : ''}`, '');
    }

    const others = enterable.length;
    return shell('', '<span class="chip g-skip">Not measured</span>',
      'We could not answer this one this run.',
      `We did not capture enough live listings for “${esc(seedKeyword)}” itself — it may not have been searched this run, or Etsy returned too little. ${others ? `${others} related keyword${others === 1 ? '' : 's'} were measured and appear in <i>Start here</i> below.` : 'Try running this seed again.'}`, '');
  })();

  const gradeRank = { A: 0, B: 1 };
  const picksOrdered = [...enterable].sort((a, b) =>
    (gradeRank[a.grade] ?? 9) - (gradeRank[b.grade] ?? 9) || b.NES - a.NES);
  const pickCards = picksOrdered.slice(0, 3).map(s => `
      <div class="card ${s.grade === 'A' ? 'rank-a' : ''}">
        <span class="grade ${s.grade === 'A' ? 'g-a' : 'g-b'}">${s.grade === 'A' ? 'A · Go for it' : 'B · Worth testing'}</span>
        <h3>${esc(s.kw.keyword)}</h3>
        <p class="why">${esc(reason(s))}</p>
        <div class="facts">
          <div class="fact"><span class="dot ${s.m.buyShare > 0.5 ? 'good' : 'ok'}"></span><span><b>${Math.round(s.m.buyShare * s.m.nAudited)} of ${s.m.nAudited}</b> audited listings show buyers acting — sold in the last 24h, or sitting in a basket now*</span></div>
          ${s.m.renewHotShare !== null && s.m.renewHotShare > 0 ? `<div class="fact"><span class="dot ${s.m.renewHotShare > 0.4 ? 'good' : 'ok'}"></span><span><b>${Math.round(s.m.renewHotShare * 100)}%</b> of listings renewed in the last 7 days <span class="unmeasured">(Etsy renews on sale)</span></span></div>` : ''}
          <div class="fact"><span class="dot ${s.m.beatShare > 0.5 ? 'good' : 'ok'}"></span><span>${s.m.beatOf ? `<b>${s.m.beatSlots} of ${s.m.beatOf}</b> top slots are held by shops small enough to outrank` : `<span class="unmeasured">Shop sizes not captured for these slots</span>`}</span></div>
          <div class="fact"><span class="dot ${(s.m.hotShare || 0) > 0.5 ? 'good' : 'ok'}"></span><span>${s.m.freshnessKnown
            ? `<b>${Math.round(s.m.hotShare * 100)}%</b> reviewed within the last 7 days <span class="unmeasured">(of ${s.m.nReviewDates} listings with review dates)</span>`
            : `<span class="unmeasured">Too few review dates captured to judge how active this keyword is — scored as average.</span>`}</span></div>
          ${s.m.market
            ? `<div class="fact"><span class="dot ok"></span><span><b>${s.m.market.toLocaleString()}</b> competing listings</span></div>`
            /* 2026-08-20: say it out loud when a figure is missing, and why.
               Silence read as "nothing to report" — it actually meant the
               keyword was never searched (per-run keyword cap) or Etsy withheld
               the count. Scored mid-pack, so it neither helps nor hurts. */
            : `<div class="fact"><span class="dot ok"></span><span class="unmeasured">Competition size not measured — this keyword wasn’t searched in this run (raise “Keywords Per Run”) or Etsy didn’t report a count. Scored as average, not as a win.</span></div>`}
          ${s.m.adShare !== null
            ? `<div class="fact"><span class="dot ${s.m.adShare > 0.4 ? 'bad' : 'ok'}"></span><span><b>${Math.round(s.m.adShare * 100)}%</b> of the search page is paid ads</span></div>`
            : `<div class="fact"><span class="dot ok"></span><span class="unmeasured">Paid-ad share not measured for this keyword — scored as average.</span></div>`}
        </div>
        <div class="meters">
          ${noSales(s)
            ? `<div class="meter"><span>Buyers buying</span><span class="unmeasured" style="grid-column:2/4" title="${NO_SALES_NOTE}">no confirmed sales</span></div>`
            : `<div class="meter ${s.D >= 60 ? 'm-go' : s.D >= 35 ? 'm-mid' : 'm-low'}"><span>Buyers buying</span><span class="bar"><span class="fill" style="width:${s.D}%"></span></span><b>${s.D}</b></div>`}
          <div class="meter ${s.W >= 60 ? 'm-go' : s.W >= 35 ? 'm-mid' : 'm-low'}"><span>Room for you</span><span class="bar"><span class="fill" style="width:${s.W}%"></span></span><b>${s.W}</b></div>
          <div class="meter ${s.F >= 60 ? 'm-go' : s.F >= 35 ? 'm-mid' : 'm-low'}"><span>Active now</span><span class="bar"><span class="fill" style="width:${s.F}%"></span></span><b>${s.F}</b></div>
        </div>
      </div>`).join('');

  const winnerCard = (w, isKing) => `
      <div class="prod">
        ${w.thumb ? `<a class="thumb" href="${esc(w.url || '#')}" target="_blank" rel="noopener"><img src="${esc(w.thumb)}" alt="${esc(w.title)}" loading="lazy"></a>` : ''}
        <div class="body">
          <div class="for"${isKing ? ' style="color:var(--locked)"' : ''}>${esc(w.forKw)}${isKing ? ' · Category king — for reference' : ''}</div>
          <h4>${esc((w.title || '').slice(0, 70))}</h4>
          <div class="stats">
            ${w.sold > 0
              ? `<span class="stat hl">Sold ${w.sold} in 24h*</span>`
              : (w.reviewAge !== null && w.reviewAge !== undefined
                  ? `<span class="stat hl">Reviewed ${w.reviewAge === 0 ? 'today' : w.reviewAge === 1 ? 'yesterday' : w.reviewAge + ' days ago'}</span>`
                  : '')}
            ${w.favs > 0 ? `<span class="stat">${w.favs.toLocaleString()} ♥</span>` : ''}
            ${w.shopReviews !== null ? `<span class="stat ${isKing ? '' : 'hl'}">shop: ${w.shopReviews.toLocaleString()} reviews</span>` : ''}
          </div>
          <p class="lesson">${isKing
            ? '<b>Study, don’t chase:</b> a big shop — not your competition target. Learn its format, win on an angle it ignores.'
            : '<b>Why it matters:</b> a small shop selling here — proof the door is open. Study the format, then do it your way.'}</p>
        </div>
      </div>`;

  const trapped = scored.filter(s => s.gates.length);
  const giantRows = trapped.filter(s => s.trap === 'giants');
  const quietRows = trapped.filter(s => s.trap === 'quiet');
  const dangerCard = (list, label, why, keepout) => list.length ? `
      <div class="card">
        <span class="grade ${label === 'Owned by giants' ? 'g-lock' : 'g-skip'}">${label}</span>
        <h3>${esc(list[0].kw.keyword)}${list.length > 1 ? ` <span style="font-weight:400;color:var(--ink-soft)">+ ${list.length - 1} more</span>` : ''}</h3>
        <p class="why">${why}</p>
        <div class="facts">${list.slice(0, 4).map(s => `<div class="fact"><span class="dot bad"></span><span>${esc(s.kw.keyword)} — ${esc(reason(s))}</span></div>`).join('')}</div>
        <div class="keepout">🚫 ${keepout}</div>
      </div>` : '';

  const tableRows = scored.map(s => `
          <tr${s.gates.length ? ' class="off"' : ''}><td><span class="kw">${esc(s.kw.keyword)}</span><span class="reason">${esc(reason(s))}</span>${signalStrip(s.m)}</td><td>${gradeChip(s)}</td><td class="num">${s.m.beatOf
              ? `<b>${s.m.beatSlots}</b><span style="color:var(--ink-soft)">/${s.m.beatOf}</span>`
              : '<span class="unmeasured">—</span>'}</td><td class="num">${noSales(s) ? `<span class="unmeasured" title="${NO_SALES_NOTE}">no confirmed sales</span>` : bar(s.D, barCls(s.D))}</td><td class="num">${bar(s.W, barCls(s.W))}</td><td class="num">${bar(s.F, barCls(s.F))}</td><td class="num">${s.m.market ? s.m.market.toLocaleString() : '<span class="unmeasured" title="Not measured — this keyword wasn’t searched in this run, or Etsy didn’t report a result count. Scored as average, never as a win.">not measured</span>'}</td></tr>`).join('');

  const nA = scored.filter(s => s.grade === 'A').length;
  const nB = scored.filter(s => s.grade === 'B').length;
  const uv = ctx.underlyingVerdict || (String(verdict).startsWith('PARTIAL') ? null : verdict);
  const isGoSignal = uv === 'GO' || verdict === 'GO';
  const headline = ctx.partial
    ? `This is a <span style="color:var(--test)">partial</span> read of “${esc(seedKeyword)}” — ${nA} A-grade and ${nB} B-grade so far among ${scored.length} scored keyword(s). Treat it as a signal, not a final go / no-go.`
    : (isGoSignal
      ? `Good news: this market has room. <span style="color:var(--go)">${nA} strong opening${nA === 1 ? '' : 's'}</span> and <span style="color:var(--test)">${nB} worth testing</span> — plus ${trapped.length} to avoid, each with the reason why.`
      : `Honest verdict: we found no opening a new shop should enter right now — ${trapped.length} keyword(s) checked, every one gated. Better to know before you spend months here.`);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Niche Report — ${esc(seedKeyword)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700;9..144,900&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#f4f7fa;--ink:#16232e;--ink-soft:#5a6b7a;--line:#dde5ec;--go:#157a4a;--go-soft:#e0f3e9;--test:#8a6d00;--test-soft:#f7f0d4;--skip:#b03a2e;--skip-soft:#fbe9e5;--locked:#4f46a0;--locked-soft:#eae8f9;--accent:#0e7c86;--card:#ffffff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Public Sans',-apple-system,'Segoe UI',sans-serif;background:var(--paper);color:var(--ink);line-height:1.55;background-image:radial-gradient(circle at 1px 1px, rgba(22,35,46,.045) 1px, transparent 0);background-size:22px 22px}
.wrap{max-width:1180px;margin:0 auto;padding:40px 28px 80px}
.rule{border:none;border-top:2px solid var(--ink);margin:0 0 6px}
header{animation:rise .6s ease both}
.kicker{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:8px 0}
h1{font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:clamp(34px,6vw,58px);line-height:1.05;margin:14px 0 8px}
h1 em{font-style:italic;color:var(--accent)}
.subtitle{font-size:16px;color:var(--ink-soft);max-width:70ch}
.verdict-line{margin-top:26px;background:var(--card);border:1.5px solid var(--ink);border-radius:14px;padding:18px 22px;display:flex;gap:16px;align-items:flex-start;box-shadow:4px 4px 0 rgba(22,35,46,.10)}
.verdict-line .big{font-family:'Fraunces',serif;font-size:19px;font-weight:700;line-height:1.35}
.verdict-line .sun{font-size:30px;line-height:1}
h2{font-family:'Fraunces',Georgia,serif;font-weight:700;font-size:26px;margin:0 0 4px}
.sec-note{font-size:14px;color:var(--ink-soft);margin-bottom:18px}
section{margin-top:46px;animation:rise .6s ease both}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.card{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:18px 18px 16px;position:relative}
.card.rank-a{border-color:var(--go)}
.grade{position:absolute;top:-13px;right:14px;font-family:'Fraunces',serif;font-weight:900;font-size:15px;padding:3px 12px;border-radius:99px;border:1.5px solid currentColor;background:var(--paper)}
.g-a{color:var(--go);background:var(--go-soft)}.g-b{color:var(--test);background:var(--test-soft)}
.g-skip{color:var(--skip);background:var(--skip-soft)}.g-lock{color:var(--locked);background:var(--locked-soft)}
.card h3{font-family:'Fraunces',serif;font-size:19px;font-weight:700;margin:2px 0 2px;text-transform:capitalize}
.card .why{font-size:13.5px;color:var(--ink-soft);margin:6px 0 12px}
.facts{display:flex;flex-direction:column;gap:6px;font-size:13px}
.fact{display:flex;gap:8px;align-items:baseline}
.fact b{font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:99px;flex:none}
.dot.good{background:var(--go)}.dot.ok{background:var(--test)}.dot.bad{background:var(--skip)}
.meters{display:flex;flex-direction:column;gap:7px;margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
.meter{display:grid;grid-template-columns:96px 1fr 30px;gap:8px;align-items:center;font-size:11.5px;color:var(--ink-soft)}
.meter .bar{height:7px;background:#e7edf3;border-radius:99px;overflow:hidden}
.meter .fill{height:100%;border-radius:99px}
.meter.m-go .fill{background:var(--go)}.meter.m-mid .fill{background:var(--test)}.meter.m-low .fill{background:var(--skip)}
.meter b{text-align:right;color:var(--ink)}
.prods{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.prod{background:var(--card);border:1.5px solid var(--line);border-radius:14px;overflow:hidden}
a.thumb{display:block}.prod .thumb{height:150px;background:#e8eef3;overflow:hidden}
.prod .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.prod .body{padding:14px 16px 16px}
.prod .for{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700}
.prod h4{font-family:'Fraunces',serif;font-size:16px;font-weight:700;margin:4px 0 8px;line-height:1.3}
.prod .stats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.stat{font-size:11.5px;font-weight:600;background:var(--paper);border:1px solid var(--line);border-radius:99px;padding:2px 9px}
.stat.hl{background:var(--go-soft);border-color:var(--go);color:var(--go)}
.prod .lesson{font-size:12.5px;color:var(--ink-soft)}
.prod .lesson b{color:var(--ink)}
.danger{margin-top:46px;border:2px solid var(--skip);border-radius:16px;overflow:hidden;background:linear-gradient(rgba(176,58,46,.045),rgba(176,58,46,.045)),repeating-linear-gradient(-45deg, transparent 0 14px, rgba(176,58,46,.05) 14px 28px),var(--paper)}
.danger .dz-bar{background:repeating-linear-gradient(-45deg, var(--skip) 0 16px, #7e2a20 16px 32px);color:#fff;padding:10px 22px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12.5px;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.danger .dz-inner{padding:22px}
.danger h2{color:var(--skip)}
.danger .card{background:#f6efec;border:1.5px dashed rgba(176,58,46,.55);filter:saturate(.55)}
.danger .card h3{color:#6c5a53;text-decoration:line-through;text-decoration-color:rgba(176,58,46,.6)}
.danger .keepout{font-size:12px;font-weight:700;color:var(--skip);margin-top:12px;padding-top:10px;border-top:1px dashed rgba(176,58,46,.4)}
.tablewrap{overflow-x:auto;border:1.5px solid var(--ink);border-radius:14px;background:var(--card);box-shadow:4px 4px 0 rgba(22,35,46,.10)}
table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:700px}
th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);text-align:left;padding:12px 14px;border-bottom:2px solid var(--ink);white-space:nowrap}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
td .kw{font-weight:600;text-transform:capitalize}
td .reason{display:block;font-size:12px;color:var(--ink-soft);margin-top:2px}
/* 2026-08-20: per-keyword evidence strip — which signals Etsy actually showed
   on the listings we opened. */
td .signals{display:block;font-size:11.5px;color:var(--ink-soft);margin-top:5px;line-height:1.5}
td .signals b{color:var(--ink);font-variant-numeric:tabular-nums}
td .signals .of{color:#9fb0bf}
td .signals.none{font-style:italic}
/* 2026-08-20: styling for "we didn't measure this" notes — deliberately quiet
   and italic so a missing figure reads as a gap, never as a finding. */
.unmeasured{color:var(--ink-soft);font-style:italic;font-weight:400;font-size:12px}
.chip{display:inline-block;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;white-space:nowrap}
.minibar{display:inline-block;width:52px;height:6px;background:#e7edf3;border-radius:99px;overflow:hidden;vertical-align:middle;margin-right:6px}
.minibar i{display:block;height:100%;border-radius:99px}
.mb-go i{background:var(--go)}.mb-mid i{background:var(--test)}.mb-low i{background:var(--skip)}
tr.off td{background:rgba(176,58,46,.035)}
tr.off td .kw{color:#8a7a74;text-decoration:line-through;text-decoration-color:rgba(176,58,46,.45)}
.legend{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:20px 22px}
.legend h2{font-size:20px}
.legend dl{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-size:13.5px;margin-top:12px}
.legend dt{font-weight:700;white-space:nowrap}
.legend dd{color:var(--ink-soft)}
details{margin-top:14px;font-size:13px;color:var(--ink-soft)}
summary{cursor:pointer;font-weight:600;color:var(--ink)}
details p{margin:8px 0 0}
.seedbox{margin-top:30px;border:2px solid var(--ink);border-radius:16px;background:var(--card);box-shadow:5px 5px 0 rgba(22,35,46,.10);overflow:hidden}
.seedbox .sb-head{padding:16px 22px 4px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.seedbox .sb-kw{font-family:'Fraunces',serif;font-weight:900;font-size:24px;text-transform:capitalize}
.seedbox .sb-body{padding:6px 22px 20px}
.seedbox .sb-answer{font-family:'Fraunces',serif;font-size:20px;font-weight:700;line-height:1.35;margin:6px 0 10px}
.seedbox .sb-why{font-size:14px;color:var(--ink-soft);max-width:78ch}
.seedbox .sb-nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.seedbox .sb-num{background:var(--paper);border:1px solid var(--line);border-radius:99px;padding:4px 12px;font-size:12.5px}
.seedbox .sb-num b{font-variant-numeric:tabular-nums}
.sb-go{border-color:var(--go)}.sb-go .sb-answer{color:var(--go)}
.sb-test{border-color:var(--test)}.sb-test .sb-answer{color:var(--test)}
.sb-no{border-color:var(--skip)}.sb-no .sb-answer{color:var(--skip)}
/* 2026-08-21: footer is now a credit card rather than a grey line — reports get
   forwarded and screenshotted, so the brand and the link travel with them.
   Colours come from the same tokens as the rest of the report. */
footer{margin-top:44px;background:var(--card);border:1.5px solid var(--ink);border-radius:14px;box-shadow:4px 4px 0 rgba(22,35,46,.10);padding:18px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink-soft)}
footer .badge{width:42px;height:42px;border-radius:11px;background:var(--ink);display:flex;align-items:center;justify-content:center;flex:none}
footer .txt{flex:1;min-width:240px}
footer .txt .t1{font-family:'Fraunces',serif;font-weight:700;font-size:15.5px;color:var(--ink);line-height:1.3;display:block}
footer .txt .t2{font-size:12.5px;color:var(--ink-soft);margin-top:2px;display:block}
footer a.cta{font-size:12.5px;font-weight:700;text-decoration:none;color:#fff;background:var(--accent);border-radius:99px;padding:9px 18px;white-space:nowrap}
footer a.cta:hover{background:#0a616a}
footer .meta{width:100%;font-size:11.5px;color:var(--ink-soft);border-top:1px dashed var(--line);padding-top:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
footer .meta a{color:var(--accent);font-weight:600;text-decoration:none}
footer .meta a:hover{text-decoration:underline}
/* The call-to-action button is decoration in print; the URL below it is not. */
@media print{footer{box-shadow:none}footer a.cta{display:none}}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media print{body{background:#fff}}
</style></head><body><div class="wrap">

<header>
  <hr class="rule">
  <div class="kicker"><span>${EXT_NAME} · Market Report${ctx.partial ? ' · Partial' : ''}</span><span>${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}${ctx.pipelineRunId ? ' · Run #' + ctx.pipelineRunId : ''}</span></div>
  ${ctx.partial ? partialBannerHtml({
    stoppedAfterStep: ctx.stoppedAfterStep,
    keywordCount: ctx.keywordCount != null ? ctx.keywordCount : scored.length,
    listingCount: ctx.listingCount != null ? ctx.listingCount : (ctx.distinctListings ?? listings.length),
    esc,
  }) : ''}
  <h1>You searched <em>“${esc(seedKeyword)}”</em>.<br>${ctx.partial
    ? 'Here’s what we found before you stopped.'
    : (verdict === 'GO' ? 'Here’s where a new shop can win.' : 'Here’s why we’d wait.')}</h1>
  <p class="subtitle">${ctx.gateSkip
    ? `We searched <b>${ctx.gateSkip.measuredCount} keyword${ctx.gateSkip.measuredCount === 1 ? '' : 's'}</b> and read <b>${ctx.distinctListings ?? listings.length} top listings</b> on Etsy, then stopped: only <b>${ctx.gateSkip.qualifiedCount}</b> of them had enough page-one room for a new shop, so we did not spend the time opening listings for a niche this crowded.`
    : `We checked <b>${scored.length} keyword ideas</b>, read <b>${ctx.distinctListings ?? listings.length} top listings</b> live on Etsy, and looked at who’s selling, who owns the shelf, and what’s gone quiet.`}</p>
  ${ctx.scopedToRun === false ? `<p class="subtitle" style="color:#8a5a00;background:#fff6e0;border:1px solid #f0d9a0;border-radius:8px;padding:10px 12px"><b>Heads up:</b> this report was built from data already stored for “${esc(seedKeyword)}” (last ${ctx.freshHours || 48} hours), not from a fresh crawl — Steps 1–3 were not run just now. Numbers may mix more than one visit to Etsy.</p>` : ''}
  <div class="verdict-line"><span class="sun">${ctx.partial ? '⏸' : (isGoSignal ? '☀️' : '🌧')}</span><div><div class="big">${ctx.partial
    ? esc(verdict)
    : (ctx.gateSkip && !isGoSignal
    ? `This niche is too crowded to enter. Only <span style="color:var(--skip)">${ctx.gateSkip.qualifiedCount} of ${ctx.gateSkip.measuredCount}</span> keywords had page-one room for a new shop — we stopped before opening listings, because the answer was already clear.`
    : headline)}</div></div></div>
</header>

${seedVerdictHtml}

${enterable.length ? `<section><h2>🥇 Start here</h2>
<p class="sec-note">Openings where real buyers are active <i>and</i> the competition is small enough to beat.</p>
<div class="cards">${pickCards}</div></section>` : ''}

${winners.length ? `<section><h2>🏆 Products to model</h2>
<p class="sec-note">Winners from shops small enough to compete with, smallest first — each one has proof it is alive right now: a sale in the last 24 hours, or a review within the last week. Up to ${ctx.winnersMax || 8} per report, never from gated niches. Photos link to the live listing.</p>
<div class="prods">${winners.map(w => winnerCard(w, false)).join('')}${king ? winnerCard(king, true) : ''}</div></section>` : ''}

${trapped.length ? `<section class="danger"><div class="dz-bar">⛔ Do not enter — save your money and months</div><div class="dz-inner">
<h2>Looks tempting. Isn’t.</h2>
<p class="sec-note">These would top any search-volume tool. Our live check of the actual listings says a new shop loses here.</p>
<div class="cards">
${dangerCard(giantRows, 'Owned by giants', 'Money is flowing — to shops with huge sales histories. New shops don’t crack this page 1.', 'Entering costs listing fees + months of zero visibility')}
${dangerCard(quietRows, 'Gone quiet', 'Plenty of “beatable” competition — because buyers left. The classic dead-niche trap.', '“Easy to rank” here means easy to rank for nothing')}
${dangerCard(trapped.filter(s => s.trap === 'thin'), 'Too thin to call', 'The page is open and a few buyers are about, but not enough of either to build on yet.', 'Worth re-checking later rather than entering now')}
${dangerCard(trapped.filter(s => s.trap === 'weak'), 'Skip for now', 'Not enough evidence of buyers or openings.', 'Re-run later — niches shift')}
</div></div></section>` : ''}

${ctx.gateSkip && ctx.gateSkip.keywords && ctx.gateSkip.keywords.length ? `<section><h2>🔒 What page one looks like</h2>
<p class="sec-note">Every keyword we searched for “${esc(seedKeyword)}”, and how much of Etsy's first page a new shop could realistically take. A slot counts as winnable when the shop holding it has fewer than ${Number(ctx.gateSkip.beatThreshold || 300).toLocaleString()} reviews. We needed <b>${ctx.gateSkip.needed}</b> keyword${ctx.gateSkip.needed === 1 ? '' : 's'} with at least <b>${ctx.gateSkip.minBeatableSlots}</b> winnable slots to be worth going further.</p>
<div class="tablewrap"><table><thead><tr><th>Keyword</th><th class="num">Winnable slots</th><th>Verdict</th></tr></thead>
<tbody>${ctx.gateSkip.keywords.map(k => `<tr${k.qualified ? '' : ' class="off"'}><td><span class="kw">${esc(k.keyword)}</span></td><td class="num"><b>${k.beatableSlots}</b><span style="color:var(--ink-soft)">/${k.totalListings}</span></td><td>${k.qualified
  ? '<span class="chip g-b">Enough room</span>'
  : '<span class="chip g-lock">Held by established shops</span>'}</td></tr>`).join('')}</tbody></table></div>
<p class="sec-note" style="margin-top:14px">${ctx.gateSkip.qualifiedCount === 0
  ? 'Not one keyword here has room for a new shop. This is a niche to walk away from, not one to try harder at.'
  : `Only ${ctx.gateSkip.qualifiedCount} keyword${ctx.gateSkip.qualifiedCount === 1 ? '' : 's'} cleared the bar — too few to build on. If one of them matches what you actually want to sell, run it as its own seed and we will measure it properly.`}</p></section>` : ''}

${thin && thin.length && !ctx.gateSkip ? `<section><h2>🕓 Not enough data yet</h2>
<p class="sec-note">${ctx.gateSkip
  ? `These ${thin.length} keyword(s) were searched, but we stopped before opening their listings. Of the <b>${ctx.gateSkip.measuredCount}</b> keywords we checked, only <b>${ctx.gateSkip.qualifiedCount}</b> had at least <b>${ctx.gateSkip.minBeatableSlots}</b> page-one slots held by shops under ${Number(ctx.gateSkip.beatThreshold || 300).toLocaleString()} reviews — the rest of page one belongs to established shops. Nothing here is a fault in your settings: this niche is crowded, and opening listings would not have changed that answer.`
  : `These ${thin.length} keyword(s) were found and captured, but we opened too few of their listings to say anything honest. Your setting asks for <b>${auditTarget}</b> listings per keyword; a verdict needs at least half of that, and “Go for it” needs three quarters. A keyword can show one or two audited listings simply because it shares a product with a keyword we <i>did</i> measure — that is not evidence about this keyword. To measure these, raise <b>Top Listings Per Keyword</b> (and <b>Keywords Per Run</b> if the keyword has never been searched) and run this seed again.`}</p>
<p style="font-size:13.5px;color:var(--ink-soft)">${thin.map(t => `<b style="color:var(--ink)">${esc(t.kw.keyword)}</b> — ${t.nAudited}/${t.needed} audited`).join(' · ')}</p></section>` : ''}

<section><h2>The full picture</h2>
<p class="sec-note">All ${scored.length} scored keywords, best first. Every number comes from listings we read live on Etsy.</p>
<div class="tablewrap"><table><thead><tr><th>Keyword</th><th>Verdict</th><th class="num" title="Of the top slots on Etsy's first page, how many are held by shops small enough to outrank">Beatable&nbsp;slots</th><th class="num">Buyers buying</th><th class="num">Room for you</th><th class="num">Active now</th><th class="num">Competition</th></tr></thead>
<tbody>${tableRows}</tbody></table></div></section>

<section><div class="legend"><h2>How to read this report</h2>
<dl>
<dt><span class="chip g-a">A · Go for it</span></dt><dd>Buyers are active <i>and</i> the competition is small enough to beat.</dd>
<dt><span class="chip g-b">B · Worth testing</span></dt><dd>Good on most fronts, one thing to watch — see the note on the row.</dd>
<dt><span class="chip g-lock">Owned by giants</span></dt><dd>Money is flowing, but shops with huge sales histories hold page 1.</dd>
<dt><span class="chip g-skip">Gone quiet</span></dt><dd>Looks easy to enter — because buyers left. Reviews have gone cold <i>and</i> almost nothing on page one is selling or sitting in a basket. A shelf with stale reviews but live baskets is <b>not</b> called quiet: in some niches — digital templates especially — buyers simply do not leave reviews.</dd>
<dt>Buyer signals</dt><dd>The small line under each keyword: how many of the listings we opened carried each kind of evidence — a 24-hour sale count, a basket count, a view count, a renewal this week (Etsy renews a listing when it sells), a review this week. Etsy prints only <b>one</b> urgency line per listing, so a keyword showing mostly baskets is not a keyword without sales; it is Etsy choosing which line to print. A signal with no listings behind it is left out rather than shown as a zero.</dd>
<dt>Beatable slots</dt><dd>The heart of the method. Of the top slots on Etsy's first page for that keyword, how many are held by a shop with fewer than ${beatThresholdLegend} reviews — shops a new listing can realistically outrank. <b>5/6</b> means five of the six slots we checked are winnable; <b>1/6</b> means established shops own the page.</dd>
<dt>Buyers buying</dt><dd>Are the top listings actually selling? Etsy prints one urgency line per listing — “N people bought this in the last 24 hours”, “In 20+ baskets”, or a view count — so we count a sale badge and a basket the same way; which one appears is Etsy's choice, not a difference in the shelf. Favourites, view counts and how recently listings were renewed (Etsy auto-renews on a sale) fill in the rest. Reads <i>no confirmed sales</i> when not one audited listing on that keyword shows a sale <i>or</i> a basket — we would rather say so than print a score.</dd>
<dt>Room for you</dt><dd>How beatable the shelf is: small shops ranking, market size, badge-heavy giants, and how much of the page is taken by paid ads (slots you can’t win organically).</dd>
<dt>Active now</dt><dd>How recently the top listings got reviews (cold after ${coldDigital} days for digital items, ${coldPhysical} for physical — judged per keyword from what's actually ranking). Fresh reviews = sales happening now. A low score here alone does not condemn a keyword — if buyers are still filling baskets we say the reviews lag rather than that the niche is dead — but it does hold it back from “Go for it”.</dd>
</dl>
<details><summary>Where these numbers come from (the honest part)</summary>
<p>* <b>Sold (24h)</b> is Etsy’s own counter — “N people bought this in the last 24 hours” — read from each listing at the moment we checked. It’s a one-day snapshot, not a daily average, and a listing’s sales come from all its traffic, not only this keyword. We show it exactly as Etsy states it. Etsy prints only <b>one</b> urgency line per listing, so where it chose to show a basket or view count instead, that is what the buyer-signal line under the keyword reports — and those baskets count as buying evidence with the same weight.</p>
<p>Scores compare the keywords in <i>this report</i> against each other. <b>Beatable slots</b> looks at the top <b>${auditTarget}</b> positions on page one. The demand and freshness figures use every listing of that keyword we have opened within the last ${Math.round(FRESH_HOURS_LEGEND / 24) || 2} days, which is why the "of N listings" counts are often larger than ${auditTarget} — a listing that ranks for several of these keywords is read once and counts for each. Keywords with too few opened listings are excluded rather than guessed. Every claim traces back to a listing we actually opened — nothing is estimated or modelled.</p>
<p><b>Competition coverage in this report: ${mktMeasured} of ${scored.length} graded keywords have a measured market size.</b> A keyword gets one when its Etsy search page was opened and Etsy reported a result count. Keywords discovered late in a run may not have been searched yet — the “Keywords Per Run” setting caps how many are. Where the figure is missing we say so on the row and score that keyword <i>mid-pack</i>: it is neither rewarded nor punished for our gap. Re-running the seed fills in the missing ones, and the figure is remembered from then on.</p>
</details></div></section>

<footer>
  <span class="badge"><svg width="22" height="22" viewBox="0 0 32 32" fill="none"><rect x="4" y="13" width="6" height="15" rx="1.6" fill="#fff"/><rect x="13" y="8" width="6" height="20" rx="1.6" fill="#17b0bd"/><rect x="22" y="17" width="6" height="11" rx="1.6" fill="#fff"/></svg></span>
  <span class="txt">
    <span class="t1">This report was made with ${EXT_NAME}.</span>
    <span class="t2">Every number read live off Etsy — no search-volume guesswork.</span>
  </span>
  <a class="cta" href="${EXT_SITE}" target="_blank" rel="noopener">Get your own &rarr;</a>
  <span class="meta"><span>${esc(REPORT_VERSION)} · formula v${FORMULA_VERSION} · ${ctx.distinctListings ?? listings.length} listings read live · data stored locally in your browser</span></span>
</footer>
</div></body></html>`;
}
