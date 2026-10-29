// ─────────────────────────────────────────────────────────────────────────────
// NES Discovery (Step 1, v2.0.0) — eRank-free keyword discovery.
//
// Replaces erank-keyword-workflow's eRank scraping with the "title funnel",
// validated live on 5 seeds (2026-08-19, docs/data-inventory/phase0-nes-demand-test.md):
//
//   1. Open ONE Etsy search page for the seed → read the ranking listings'
//      TITLES (sellers stuff their target keywords into titles because Etsy
//      weights them — titles are where tags went after Etsy hid tag pills).
//   2. Slide a 2-4-word window over every title; keep phrases containing the
//      seed that appear in ≥2 DIFFERENT titles (one seller's quirk dies,
//      anything two competitors both target is a real term).
//   3. Validate each candidate with ONE autosuggest probe from the user's own
//      session: if Etsy's dropdown contains the phrase (order/plural-insensitive
//      — Etsy suggests "excel spreadsheet" for "spreadsheet excel"), it is a
//      real buyer query. Junk n-grams die here with zero suggestions.
//   4. Harvest each validated keyword's suggestion family as long-tails.
//
// Family size is ALSO recorded per keyword: it saturates at ~11 for healthy
// terms but collapses for out-of-season ones (validated 2026-08-19: "mothers
// day shirt" → 1 in August), so Step 4 uses it as a seasonality gate, never as
// a demand score.
//
// Writes discovered keywords through the same Worker path as the legacy Step 1
// (positional 'etsy_keywords' rows → handleKeywordsInsert), so the seed↔keyword
// junction, text-based refresh of rediscoveries, and Step 2's status filter all
// keep working unchanged. avg_searches/competition stay EMPTY — the NES
// pipeline scores demand from live listing evidence, not search-volume
// estimates (Step 2 accepts keywords regardless; verified 2026-08-19).
// ─────────────────────────────────────────────────────────────────────────────

import { isJunkKeyword } from './etsy-snapshot-workflow.js';

// Words that never start/end a real product keyword. Kept tiny on purpose —
// the autosuggest probe is the real judge; this only trims obvious noise
// before we spend probes on it.
const EDGE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'your', 'of', 'to', 'in',
  'on', 'by', 'my', 'our', 'you', 'is',
]);

// Order+plural-insensitive canonical form. "Dress Engagement" ≡ "engagement
// dresses" — Etsy's dropdown phrases word orders differently than titles do,
// and exact-order matching rejected real keywords in the prototype.
function canon(s) {
  return String(s).toLowerCase().replace(/s\b/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function runNesDiscovery(sheetsClient, tabId, config, log, seedKeyword, shouldStop) {
  if (!shouldStop) shouldStop = () => false;

  // 2026-08-20: read the server-side config table too, same priority order
  // Steps 2 and 3 already use (popup > DB > code default). Without this the
  // nes_* tuning keys were unreachable from the DB — changing candidate count,
  // probe delay, cold-days or winner-card count would have required shipping a
  // new extension build to every user instead of one config row update.
  let dbConfig = {};
  try { dbConfig = await sheetsClient.readConfig() || {}; } catch (e) { dbConfig = {}; }
  const cfg = (key, dflt) => {
    const local = config != null ? config[key] : undefined;
    if (local !== undefined && local !== null && local !== '') return local;
    const db = dbConfig[key];
    if (db !== undefined && db !== null && db !== '') return db;
    return dflt;
  };

  const candidateCap = parseInt(cfg('nes_discovery_candidates', 30)) || 30;
  const probeDelayMs = parseInt(cfg('nes_probe_delay_ms', 450)) || 450;
  const seedNorm = seedKeyword.toLowerCase().trim();

  log('info', `🧭 Discovering keywords for "${seedKeyword}" from live Etsy data...`);

  // ─── Ensure the seed row exists (same shape as legacy Step 1) ───
  const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');
  let seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedNorm);
  if (!seed) {
    const nextSeedId = await sheetsClient.getNextId('seed_keywords', 'seed_id');
    const now = new Date().toISOString();
    await sheetsClient.appendRows('seed_keywords', [[
      nextSeedId, seedKeyword, 'manual', '', '', 1, 0, '', '', 0, now, ''
    ]]);
    seed = { seed_id: String(nextSeedId), keyword: seedKeyword, category: '', product_type: '' };
    log('info', `🆕 Fresh seed planted! "${seedKeyword}" → ID #${nextSeedId}`);
  } else {
    log('info', `👋 Seed "${seedKeyword}" found (ID #${seed.seed_id})`);
  }

  // Existing keywords for this seed — so we can report new vs rediscovered.
  const { rows: existingKws } = await sheetsClient.readSheet('etsy_keywords', { seed_id: String(seed.seed_id) });
  const existingSet = new Set(existingKws.map(k => (k.keyword || '').toLowerCase().trim()));
  log('info', `📚 ${existingKws.length} keyword(s) already linked to this seed`);

  // ─── Stage 1: one Etsy search page → titles ───
  // 2026-08-21 (audit #8): honour the product-type filter here too. Discovery
  // mined titles from an UNFILTERED search while Step 2 measured with
  // instant_download applied, so on a "digital" run the keywords came off the
  // physical shelf and were then scored against the digital one.
  const productTypeFilter = String(cfg('product_type_filter', 'any')).toLowerCase();
  const productTypeParam = productTypeFilter === 'digital' ? '&instant_download=true'
                         : productTypeFilter === 'physical' ? '&instant_download=false'
                         : '';
  const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(seedKeyword)}${productTypeParam}`;
  if (productTypeParam) log('info', `🏷️ Discovering on the ${productTypeFilter} shelf only — same filter Step 2 measures with`);
  log('info', `🔍 Loading Etsy search for "${seedKeyword}"...`);
  // Wait for the tab's load-complete event, then give Etsy's lazy grid time to
  // hydrate. 2026-08-19 live-test fix: a flat sleep from tabs.update yielded
  // only ~8 hydrated cards ("autism" run 4826) because navigation ate the wait;
  // Step 2 waits for 'complete' + its page delay and gets 45-48 cards.
  await navigateTab(tabId, searchUrl);
  await sleep(Math.max(parseInt(cfg('delay_between_pages_sec', 7)) * 1000 || 7000, 7000));

  let serp = null;
  try {
    serp = await sendToTab(tabId, { action: 'extractEtsySearchResults' }, 45000);
  } catch (e) {
    log('error', `❌ Could not read the search page: ${e.message}`);
    return { newKeywordsFound: 0, refreshedCount: 0, error: 'serp_failed' };
  }
  const listings = (serp && serp.listings) || [];
  const titles = [...new Set(listings.map(l => (l.title || '').trim()).filter(t => t.length > 20))];
  log('info', `📃 ${titles.length} distinct titles harvested from ${listings.length} listings`);
  if (titles.length < 5) {
    log('warn', `⚠️ Too few titles to mine (${titles.length}) — is the search page loading?`);
    return { newKeywordsFound: 0, refreshedCount: 0, error: 'too_few_titles' };
  }

  // ─── Stage 2: n-gram mining ───
  // Which seed words actually identify the product?
  // 2026-08-20 (run 4834): matching ANY seed token was too loose. For "tote bag"
  // the token "bag" matches nearly every title on the page, so the funnel walked
  // out of print-on-demand totes and into sourced leather goods — the report led
  // with "shoulder bag". The rule that caused it was added for "bridal dress" →
  // "bridal gown", where both words are meaningful, so the fix is not to revert
  // it but to tell the two cases apart with data we already have: a token that
  // appears in almost every ranking title is a category word, not an identity.
  // Tokens close to the RAREST seed token stay distinctive; ones that appear
  // markedly more often are treated as generic and can't carry relevance alone.
  // In an English compound the LAST word is the category (bag, dress, jacket)
  // and the earlier words say WHICH one (tote, bridal, leather). Drop the
  // modifier and you have a different product; drop the category and you don't.
  // So relevance is anchored on the modifier, not on any token.
  //   "tote bag"   → anchor "tote": keeps canvas tote / leather tote,
  //                  drops shoulder bag (run 4834's complaint — a tote seller
  //                  prints on blanks, a shoulder bag has to be sourced).
  //   "bridal dress" → anchor "bridal": still keeps "bridal gown", which is the
  //                  case the any-token rule was added for in the first place.
  // Word frequency was tried first and does NOT separate them: on the tote-bag
  // page "tote" appears in 92% of titles and "bag" in 100%, so both look
  // generic. Position does separate them, and it is predictable to explain.
  const seedTokens = seedNorm.split(' ').filter(Boolean);
  const anchors = new Set(seedTokens.length > 1 ? seedTokens.slice(0, -1) : seedTokens);
  if (seedTokens.length > 1) {
    log('info', `🔍 Staying on "${[...anchors].join('", "')}" — "${seedTokens[seedTokens.length - 1]}" is the product category, too broad to define the niche on its own`);
  }

  const counts = {}; // phrase → number of DISTINCT titles containing it
  for (const t of titles) {
    // 2026-08-20 (run 4851, "home decor"): mine WITHIN punctuation segments, not
    // across them. An Etsy title is a comma-separated list of phrases —
    // "…Iron Shelf Decor, Home Accents, Gift…" — and a sliding window that
    // crosses the comma invents "decor home", which is not a phrase any seller
    // wrote or any buyer types. Worse, it then passed autosuggest validation
    // (our matcher ignores word order, so "decor home" matched Etsy's real
    // "home decor"), and the long-tail harvest probed the SCRAMBLED string, so
    // Etsy autocompleted it into "decor home accents", "decor home a well",
    // "decor home bamboo". Three of those were searched, audited and graded A.
    // The tell was in the report: "home decor", "decor home" and
    // "decor home decor" all returned ~22.02M listings — Etsy was serving one
    // result set to three spellings of the same query.
    const segments = t.toLowerCase()
      .split(/[,;|/•·\u2013\u2014\u2022\n\r]+|\s[-–—]\s/)   // commas, pipes, bullets, dashes-as-separators
      .map(seg => seg.replace(/[^a-z0-9\s]/g, ' '))
      .filter(seg => seg.trim());
    const seen = new Set();
    for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        const phrase = gram.join(' ');
        // Must contain the seed phrase, or a DISTINCTIVE seed token (see the
        // token-frequency note above). 4-grams still require the full seed
        // phrase so they don't explode into title fragments.
        const touchesSeed = phrase.includes(seedNorm) || gram.some(w => anchors.has(w));
        if (!touchesSeed) continue;
        if (phrase === seedNorm) continue;
        // "decor home" for the seed "home decor" is the seed reordered — the
        // same query to Etsy, and it drags a whole scrambled long-tail family
        // in behind it. canon() is order/plural-insensitive, so this catches
        // every permutation.
        if (canon(phrase) === canon(seedNorm)) continue;
        if (EDGE_STOPWORDS.has(gram[0]) || EDGE_STOPWORDS.has(gram[n - 1])) continue;
        if (n >= 4 && !phrase.includes(seedNorm)) continue;
        seen.add(phrase);
      }
    }
    }
    for (const p of seen) counts[p] = (counts[p] || 0) + 1;
  }
  const candidates = Object.entries(counts)
    .filter(([p, c]) => c >= 2 && !isJunkKeyword(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, candidateCap)
    .map(([p, c]) => ({ phrase: p, titleCount: c }));
  log('info', `⛏️ ${candidates.length} candidate phrases mined (seen in ≥2 titles, junk-filtered)`);

  // ─── Stage 3: autosuggest validation + long-tail harvest ───
  const validated = [];
  const expanded = new Map(); // suggestion → sourced-from phrase
  const familyByKeyword = {}; // keyword → family size (Step 4 seasonality gate)
  const seenCanon = new Set();
  let probes = 0;

  for (const cand of candidates) {
    if (shouldStop()) { log('warn', '🛑 Stop requested — halting discovery probes'); break; }
    const ck = canon(cand.phrase);
    if (seenCanon.has(ck)) continue; // reversed duplicate ("dress engagement") — skip, canonical already handled

    // 2026-08-20: announce position as [i/n]. Discovery is ~2 minutes of probing
    // and used to log nothing between "candidate phrases mined" and the final
    // tally, so the popup's progress bar had no counter to read and stayed
    // hidden for the whole step — the run looked frozen right after starting.
    // Steps 2 and 3 already emit this shape; the service worker reads it
    // centrally at log().
    log('info', `🔎 [${probes + 1}/${candidates.length}] Asking Etsy about "${cand.phrase}"`);

    let res = null;
    try {
      res = await sendToTab(tabId, { action: 'probeAutosuggest', query: cand.phrase }, 15000);
    } catch (e) { /* counted as unvalidated below */ }
    probes++;

    if (res && res.success) {
      const sugg = res.suggestions || [];
      const hitIdx = sugg.findIndex(s => canon(s) === ck);
      if (hitIdx >= 0) {
        // Real buyer query. Prefer Etsy's own phrasing as the canonical text.
        const canonical = sugg[hitIdx];
        seenCanon.add(ck);
        validated.push({ keyword: canonical, titleCount: cand.titleCount, family: sugg.length, selfRank: hitIdx + 1 });
        familyByKeyword[canonical.toLowerCase()] = sugg.length;
        for (const s of sugg) {
          // 2026-08-20: long-tails were harvested with no seed check, so a
          // validated keyword's suggestion family could walk out of the niche
          // entirely (run 4831 "adhd" → "time management", "task manager").
          // Same anchor rule as the n-grams: keep the seed phrase or a modifier.
          const sl = s.toLowerCase();
          const onTopic = sl.includes(seedNorm) || [...anchors].some(a => sl.split(/\s+/).includes(a));
          if (!onTopic) continue;
          if (!expanded.has(s) && !isJunkKeyword(s)) expanded.set(s, canonical);
        }
      }
    }
    await sleep(probeDelayMs);
  }
  log('info', `✅ ${validated.length} keywords validated by Etsy's own suggestions (${probes} probes), ${expanded.size} long-tails harvested`);

  // ─── Stage 4: write keywords (same positional path as legacy Step 1) ───
  // Row shape: keyword_id, seed_id, keyword, product_type, category,
  // avg_searches, competition, click_rate, trend, score, status,
  // snapshot_count, last_snapshot_at, peak_month, optimal_list_date, source,
  // country_json, created_at
  const now = new Date().toISOString();
  const toWrite = [];
  const seedCategory = seed.category || '';
  const seedProductType = seed.product_type || '';

  // include the seed itself so Step 2 snapshots it
  const all = [{ keyword: seedKeyword, source: 'nes_seed' }]
    .concat(validated.map(v => ({ keyword: v.keyword, source: 'nes_title' })))
    .concat([...expanded.keys()]
      .filter(s => !validated.some(v => v.keyword.toLowerCase() === s.toLowerCase()) && s.toLowerCase() !== seedNorm)
      .map(s => ({ keyword: s, source: 'nes_family' })));

  const writtenSet = new Set();
  let newCount = 0, rediscovered = 0;
  let nextKwId = await sheetsClient.getNextId('etsy_keywords', 'keyword_id');
  for (const item of all) {
    const kwLower = item.keyword.toLowerCase().trim();
    if (writtenSet.has(kwLower)) continue;
    writtenSet.add(kwLower);
    if (existingSet.has(kwLower)) { rediscovered++; }
    else { newCount++; }
    toWrite.push([
      nextKwId++, seed.seed_id, item.keyword.trim(), seedProductType, seedCategory,
      '', '', '', '', '', 'pending', 0, '', '', '', item.source, '', now,
    ]);
  }
  if (toWrite.length > 0) {
    // 100-row chunks with per-chunk fallback, same pattern as the rest of the codebase
    for (let i = 0; i < toWrite.length; i += 100) {
      try {
        await sheetsClient.appendRows('etsy_keywords', toWrite.slice(i, i + 100));
      } catch (e) {
        log('warn', `⚠️ Keyword chunk write failed at ${i}: ${e.message}`);
      }
    }
  }
  log('success', `✍️ ${toWrite.length} keyword(s) written (${newCount} new, ${rediscovered} refreshed by the Worker)`);

  // ─── Stage 5: stash discovery metadata for Step 4 (same-run, no DB change) ───
  // Step 4 reads familyByKeyword for the seasonality gate (family ≤8 = "low
  // current search interest") and the validation info for the report.
  try {
    await chrome.storage.local.set({
      // 2026-08-20: a run scores ONLY what it captured itself. Reset the
      // run-evidence stash here, at the start of the pipeline, so nothing from
      // a previous run can leak into this one's numbers.
      nesRun: { seed_id: seed.seed_id, at: now, listingIdsByKw: {}, auditedIds: [] },
      nesDiscovery: {
        seed: seedKeyword,
        seed_id: seed.seed_id,
        at: now,
        // 2026-08-20: the keyword set THIS run produced, in the order the run
        // cares about (seed → Etsy-validated title phrases, strongest first →
        // long-tails). Steps 2 and 4 work from this list instead of the whole
        // accumulated pool for the seed. Before this, Step 2 re-read every
        // keyword ever linked to the seed and gave the run's limited search
        // slots to whatever had the oldest snapshot, so a run could search
        // none of what it had just discovered — and Step 4 then graded
        // keywords the run never touched (run 4831: 58 graded, 12 measured).
        runKeywords: all.map(a => a.keyword.trim()),
        familyByKeyword,
        validated: validated.map(v => ({ k: v.keyword, t: v.titleCount, f: v.family })),
        titleCount: titles.length,
        probes,
      }
    });
  } catch (e) { /* non-fatal — Step 4 degrades gracefully without it */ }

  log('success', `🏁 Step 1 DONE! "${seedKeyword}" → ${validated.length} validated keywords + ${expanded.size} long-tails from ${titles.length} ranking titles`);
  return {
    newKeywordsFound: newCount,
    refreshedCount: rediscovered,
    validatedCount: validated.length,
    expandedCount: expanded.size,
    method: 'nes_title_funnel',
  };
}

// Navigate a tab and resolve when the page reports 'complete' (same behaviour
// as Step 2's navigateTab — a flat sleep is not enough because navigation time
// varies and eats the hydration window).
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && !done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
    setTimeout(() => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } }, 30000);
  });
}

// Same helper contract as the other worker-modules: message a tab with timeout.
function sendToTab(tabId, message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`sendToTab timeout after ${timeoutMs}ms (action: ${message && message.action})`)); }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}
