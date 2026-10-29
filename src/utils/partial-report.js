// Partial-report eligibility and labeling helpers.
// Used when the user stops a run early and we still want a deliverable.

const STEP_NAMES = {
  1: 'discovery',
  2: 'snapshots',
  3: 'audits',
};

export function completedStepsFor(stoppedAfterStep) {
  const n = Math.max(0, Math.min(3, parseInt(stoppedAfterStep, 10) || 0));
  const out = [];
  for (let i = 1; i <= n; i++) out.push(STEP_NAMES[i]);
  return out;
}

/** Display verdict for partial reports — never a bare GO/NO-GO. */
export function partialDisplayVerdict({ stoppedAfterStep, underlyingVerdict, gateSkip, hasAudits }) {
  const step = parseInt(stoppedAfterStep, 10) || 0;
  if (step <= 1) return 'PARTIAL — keywords only';
  if (gateSkip) return 'PARTIAL — crowded niche signal';
  if (step === 3 && !hasAudits) return 'PARTIAL — incomplete audits';
  if (step === 3) return 'PARTIAL — incomplete audits';
  if (underlyingVerdict === 'GO') return 'PARTIAL — promising so far';
  if (underlyingVerdict === 'NO-GO') return 'PARTIAL — early NO-GO signal';
  return 'PARTIAL';
}

/** Status string written to niche_scores for partial runs. */
export function partialScoreStatus(underlyingVerdict) {
  if (underlyingVerdict === 'GO') return 'PARTIAL-GO-SIGNAL';
  if (underlyingVerdict === 'NO-GO') return 'PARTIAL-NO-GO';
  return 'PARTIAL';
}

/**
 * Count fresh-ish rows for a seed so we know whether a partial report is useful.
 */
export async function countSeedEvidence(apiClient, seedKeyword) {
  try {
    const { rows: seeds } = await apiClient.readSheet('seed_keywords');
    const seed = (seeds || []).find(
      (s) => (s.keyword || '').toLowerCase().trim() === String(seedKeyword || '').toLowerCase().trim()
    );
    if (!seed) {
      return { keywordCount: 0, listingCount: 0, auditCount: 0, seedId: null };
    }
    const seedId = String(seed.seed_id);
    const { rows: keywords } = await apiClient.readSheet('etsy_keywords', { seed_id: seedId });
    const kwRows = keywords || [];
    const kwIds = new Set(kwRows.map((k) => String(k.keyword_id)));

    const { rows: listings } = await apiClient.readSheet('etsy_listings', { seed_id: seedId });
    const listingRows = (listings || []).filter((l) => kwIds.has(String(l.keyword_id)) || String(l.seed_id) === seedId);

    let auditCount = 0;
    try {
      const { rows: audits } = await apiClient.readSheet('listing_audit', { seed_id: seedId });
      const listingIds = new Set(listingRows.map((l) => String(l.listing_id)));
      auditCount = (audits || []).filter((a) => listingIds.has(String(a.listing_id)) || String(a.seed_id) === seedId).length;
    } catch (_) {
      auditCount = 0;
    }

    return {
      keywordCount: kwRows.length,
      listingCount: listingRows.length,
      auditCount,
      seedId,
    };
  } catch (e) {
    return { keywordCount: 0, listingCount: 0, auditCount: 0, seedId: null, error: e.message };
  }
}

/**
 * Decide whether we can generate a partial report and which path to use.
 * @returns {{ eligible: boolean, reason?: string, path?: 'keywords'|'score' }}
 */
export function assessPartialEligibility(stoppedAfterStep, counts) {
  const step = parseInt(stoppedAfterStep, 10) || 0;
  const kw = counts.keywordCount || 0;
  const listings = counts.listingCount || 0;
  const audits = counts.auditCount || 0;

  if (step < 1) {
    return { eligible: false, reason: 'insufficient_data' };
  }
  if (step === 1) {
    if (kw < 1) return { eligible: false, reason: 'insufficient_data' };
    return { eligible: true, path: 'keywords' };
  }
  // Step 2+: prefer scored report when we have listings; fall back to keywords
  if (listings >= 1 || audits >= 1) {
    return { eligible: true, path: 'score' };
  }
  if (kw >= 1) {
    return { eligible: true, path: 'keywords' };
  }
  return { eligible: false, reason: 'insufficient_data' };
}

export function partialBannerHtml({ stoppedAfterStep, keywordCount, listingCount, esc }) {
  const step = parseInt(stoppedAfterStep, 10) || 0;
  const kw = keywordCount != null ? keywordCount : '—';
  const listings = listingCount != null ? listingCount : '—';
  const e = typeof esc === 'function' ? esc : (s) => String(s == null ? '' : s);
  return `<div class="partial-banner" style="margin:0 0 18px;padding:14px 16px;border-radius:12px;background:#fff6e0;border:1.5px solid #e8b84a;color:#5c4300;font-size:13.5px;line-height:1.5">
  <b>⚠ Partial report</b> — you stopped this run after Step ${e(step)}.
  Grades and verdict reflect only the <b>${e(kw)}</b> keywords / <b>${e(listings)}</b> listings collected so far.
  Re-run the full pipeline for a complete verdict.
</div>`;
}
