// Config Loader — loads extension config from Chrome storage

const DEFAULT_CONFIG = {
  // Step 1: eRank keyword filtering
  min_monthly_searches: 500,
  max_competition: 25000,
  min_word_count: 1,
  max_keywords_per_run: 20,
  // Step 2: Etsy search & keyword qualification
  max_listings_per_keyword: 12,        // Top N listings to check per keyword (max 16)
  min_qualified_keywords: 5,           // Min keywords that must pass for niche GO verdict
  max_shop_reviews_beatable: 300,      // Shop review count threshold — under this = beatable slot
  min_beatable_slots: 3,              // Min beatable slots in top N for a keyword to qualify
  // Pre-audit ranking (Step 2→3 bridge)
  // 2026-08-20: audit_keyword_max merged into max_keywords_per_run — Step 3
  // audits every keyword Step 2 searched. A stored value from an older install
  // is still honoured when it is smaller (see etsy-snapshot-workflow.js), so an
  // upgrade never silently lengthens a run.
  // General
  // 2026-08-20: was 5 — stale. Steps 1/2/3 all clamp to a 7s Etsy floor, so a
  // fresh install effectively ran at 7 while this said 5. Aligned to the truth.
  delay_between_pages_sec: 7
};

// ─── License key (replaces service account) ─────────────────────────────────

export async function loadLicenseKey() {
  const result = await chrome.storage.local.get('licenseKey');
  return result.licenseKey || null;
}

export async function saveLicenseKey(key) {
  await chrome.storage.local.set({ licenseKey: key });
}

// ─── Device ID (license ↔ device binding) ───────────────────────────────────
// Generated once on first activation, persisted in chrome.storage.local.
// Sent as X-Device-ID header on every API request. The Worker binds the
// license to the first device_id it sees and rejects mismatches after that.
// Clearing extension data or reinstalling generates a new ID — user must
// contact admin to reset their device binding.

export async function loadDeviceId() {
  const result = await chrome.storage.local.get('deviceId');
  if (result.deviceId) return result.deviceId;
  // First activation — generate and persist
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

// ─── Backward compat aliases (so old code doesn't break during transition) ──
// loadServiceAccount → loadLicenseKey, saveServiceAccount → saveLicenseKey
export const loadServiceAccount = loadLicenseKey;
export const saveServiceAccount = saveLicenseKey;

// ─── Config ─────────────────────────────────────────────────────────────────

export async function loadConfig() {
  const result = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(result.config || {}) };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

// ─── Run state ──────────────────────────────────────────────────────────────

export async function loadRunState() {
  const result = await chrome.storage.local.get('runState');
  return result.runState || { running: false, currentStep: null, progress: '', logs: [] };
}

export async function saveRunState(state) {
  await chrome.storage.local.set({ runState: state });
}

export function getDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}
