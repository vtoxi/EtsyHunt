// Worker API Client — HTTP client shape used by LocalStorageAPIClient helpers.
// Default base URL is unused in local-first mode.

export class WorkerAPIClient {
  constructor(licenseKey, baseUrl = 'https://example.invalid', deviceId = null) {
    this.licenseKey = licenseKey;
    this.baseUrl = baseUrl;
    this.deviceId = deviceId;
  }

  // ─── Sheet-name → MySQL table-name mapping ─────────────────────────────────
  // The extension code uses Google Sheet tab names (e.g. "etsy_keywords").
  // The Worker API uses MySQL table names without the "pro_etsy_res_" prefix
  // (e.g. "keywords"). This map bridges the two so all existing workflow code
  // keeps calling readSheet('etsy_keywords') and it Just Works.
  static TABLE_MAP = {
    'etsy_keywords':          'keywords',
    'etsy_listings':          'listings',
    'etsy_stores':            'stores',
    'etsy_search_snapshots':  'search_snapshots',
    'seed_keywords':          'seed_keywords',
    'listing_audit':          'listing_audit',
    'keyword_suggestions':    'keyword_suggestions',
    'niche_scores':           'niche_scores',
    'automation_log':         'automation_log',
    'config':                 'config',         // handled specially
  };

  // Map a sheet name to the API table name
  static _resolveTable(sheetName) {
    return WorkerAPIClient.TABLE_MAP[sheetName] || sheetName;
  }

  // ─── Column-name mapping ───────────────────────────────────────────────────
  // Google Sheet headers used names like "Shop Rating", the MySQL columns use
  // snake_case like "shop_rating".  The Worker API returns MySQL column names,
  // so we also expose a normalized alias on each row object for backward compat
  // (just like SheetAPIClient did).
  static _normalizeHeader(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
  }

  // Sheet column names → MySQL column names (where they differ).
  // GLOBAL_COLUMN_MAP applies to all tables.
  // TABLE_COLUMN_MAP applies only to specific tables (for ambiguous names like 'keyword').
  static GLOBAL_COLUMN_MAP = {
    'last_searched_at':  'last_run_at',        // seed_keywords
    'search_by_country': 'locale',             // keywords (approximation)
    'trend':             'trend_velocity',      // keywords
    'velocity':          'trend_velocity',      // keywords alias
    'parent_kw_id':      'parent_keyword_id',   // keyword_suggestions
  };

  static TABLE_COLUMN_MAP = {
    'search_snapshots': {
      'keyword': 'keyword_text',
      'version': 'page_number',
      'type':    'search_type',
    },
    'listing_audit': {
      'keyword': 'keyword_text',
    },
  };

  // Translate a single column name from sheet-speak to MySQL-speak (global only)
  static _mapColumn(col) {
    return WorkerAPIClient.GLOBAL_COLUMN_MAP[col] || col;
  }

  // Translate a column name with table context (checks table-specific map first)
  static _mapColumnForTable(col, table) {
    const tableMap = WorkerAPIClient.TABLE_COLUMN_MAP[table];
    if (tableMap && tableMap[col]) return tableMap[col];
    return WorkerAPIClient.GLOBAL_COLUMN_MAP[col] || col;
  }

  // Translate all keys in an object from sheet column names to MySQL column names,
  // and convert ISO datetime strings to MySQL format.
  // If tableName is provided, also applies table-specific column mapping.
  static _mapRowColumns(obj, tableName = null) {
    const mapped = {};
    for (const [k, v] of Object.entries(obj)) {
      // Skip empty/null/undefined values — MySQL DECIMAL/INT columns reject empty strings
      if (v === undefined || v === null || v === '') continue;
      const newKey = tableName
        ? WorkerAPIClient._mapColumnForTable(k, tableName)
        : WorkerAPIClient._mapColumn(k);
      mapped[newKey] = WorkerAPIClient._toMySQLDateTime(v);
    }
    return mapped;
  }

  // Convert ISO 8601 datetime (2026-04-06T11:09:05.961Z) to MySQL DATETIME (2026-04-06 11:09:05)
  // Also converts boolean-like strings ('TRUE'/'FALSE') to 1/0 for TINYINT columns.
  // Passes through other values unchanged.
  static _toMySQLDateTime(val) {
    if (typeof val !== 'string') return val;
    // Boolean-like strings → 1/0 for MySQL TINYINT columns
    if (val === 'TRUE' || val === 'true') return 1;
    if (val === 'FALSE' || val === 'false') return 0;
    // Match ISO 8601 pattern: YYYY-MM-DDTHH:MM:SS.sssZ
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      return val.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
    }
    return val;
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  _headers() {
    const h = {
      'Content-Type': 'application/json',
      'X-License-Key': this.licenseKey,
    };
    if (this.deviceId) h['X-Device-ID'] = this.deviceId;
    // 2026-06-16: report the extension version so the worker can enforce a
    // minimum (force-update). getManifest() is available in SW/extension
    // contexts; guarded so the client never throws if run elsewhere.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        h['X-Extension-Version'] = chrome.runtime.getManifest().version;
      }
    } catch (_) {}
    return h;
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...this._headers(), ...(options.headers || {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async _get(path) {
    return this._fetch(path);
  }

  async _post(path, body) {
    return this._fetch(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async _patch(path, body) {
    return this._fetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async _put(path, body) {
    return this._fetch(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  // ─── Drop-in replacements for SheetAPIClient methods ──────────────────────

  // readSheet(sheetName) → { headers: [...], rows: [{...}, ...] }
  // Fetches all rows from the corresponding MySQL table.
  // Returns the same shape as SheetAPIClient.readSheet() so workflow code
  // doesn't need to change.
  //
  // Optional 3rd arg `options` supports:
  //   { sinceHours: 48, sinceColumn: 'updated_at' }
  // → adds a server-side WHERE filter `col >= NOW() - INTERVAL N HOUR`,
  //   used for the 48h data-freshness check on Step 2/3/4 reads.
  async readSheet(sheetName, filters = {}, options = {}) {
    const table = WorkerAPIClient._resolveTable(sheetName);

    // Build base query string from filters (map column names).
    // 2026-04-22: auto-paginate. Worker hard-caps `limit` at 5000. Previously
    // we sent limit=5000 and stopped, silently dropping rows past the first
    // page for any table that grew past 5k rows (listings especially).
    // Now we loop using total+offset until we've fetched everything.
    const baseParams = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      baseParams.set(WorkerAPIClient._mapColumnForTable(k, table), v);
    }
    if (options.sinceHours && options.sinceColumn) {
      baseParams.set('since_hours', String(options.sinceHours));
      baseParams.set('since_column', options.sinceColumn);
    }
    if (options.orderBy) {
      baseParams.set('order_by', options.orderBy);
      if (options.order) baseParams.set('order', options.order);
    }

    // 2026-04-22: PAGE_SIZE reduced 5000 → 1000. CF Worker hits "exceeded
    // resource limits" serializing larger JSON blobs.
    // Per-table max page cap: some shared tables (stores) grow to tens of
    // thousands of rows within the freshness window — we only care about
    // the shops referenced by THIS seed's listings, so iterating 13+ pages
    // just to find them blows the Worker budget. Cap per table; callers
    // can override via options.maxPages.
    const PAGE_SIZE = 1000;
    const DEFAULT_MAX_PAGES = 200; // 200k row ceiling
    const PER_TABLE_MAX_PAGES = {
      stores: 5, // up to 5000 most-recently-updated shops — enough for any
                 // single seed's shop set; the rest fall back to a null
                 // shop-rating render rather than crashing Step 4.
    };
    const MAX_PAGES = options.maxPages != null
      ? options.maxPages
      : (PER_TABLE_MAX_PAGES[table] || DEFAULT_MAX_PAGES);

    let rows = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams(baseParams);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      const data = await this._get(`/v1/data/${table}?${params.toString()}`);
      const pageRows = data.rows || [];
      if (pageRows.length === 0) break;
      rows = rows.concat(pageRows);
      const total = Number.isFinite(data.total) ? data.total : null;
      if (pageRows.length < PAGE_SIZE) break;
      if (total != null && rows.length >= total) break;
      offset += PAGE_SIZE;
    }

    // Derive headers from first row (or empty array)
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

    // Add reverse aliases so workflow code can use old sheet column names.
    // e.g. MySQL returns 'last_run_at' but workflow code reads 'last_searched_at'.
    const REVERSE_MAP = {};
    // Global aliases
    for (const [sheetCol, mysqlCol] of Object.entries(WorkerAPIClient.GLOBAL_COLUMN_MAP)) {
      if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
      REVERSE_MAP[mysqlCol].push(sheetCol);
    }
    // Table-specific aliases
    const tableColMap = WorkerAPIClient.TABLE_COLUMN_MAP[table];
    if (tableColMap) {
      for (const [sheetCol, mysqlCol] of Object.entries(tableColMap)) {
        if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
        REVERSE_MAP[mysqlCol].push(sheetCol);
      }
    }

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        // Add reverse aliases (MySQL col → sheet col aliases)
        const aliases = REVERSE_MAP[key];
        if (aliases) {
          for (const alias of aliases) {
            if (!row.hasOwnProperty(alias)) {
              row[alias] = row[key];
            }
          }
        }
        // Also add normalized header aliases
        const normalized = WorkerAPIClient._normalizeHeader(key);
        if (normalized !== key && !row.hasOwnProperty(normalized)) {
          row[normalized] = row[key];
        }
      }
    }

    return { headers, rows };
  }

  // readConfig(sheetName) → { key: value, ... }
  // Reads config from the Worker API /v1/config endpoint (merged global + user).
  // Cached in-memory for the lifetime of this client instance so a single
  // pipeline run only fetches it once. Workflow modules call getConfig() which
  // delegates here — no separate Chrome storage round-trips.
  async readConfig(sheetName = 'config') {
    if (this._configCache) return this._configCache;
    const data = await this._get('/v1/config?scope=all');
    this._configCache = data.config || {};
    return this._configCache;
  }

  // getConfig() — alias for readConfig with no sheet-name argument.
  // Use this from workflow modules so the call site reads naturally.
  async getConfig() {
    return this.readConfig();
  }

  // Force-refresh the cached config (used after a user updates a setting in
  // the popup). Most pipeline code should NOT call this — let the cache live.
  invalidateConfig() {
    this._configCache = null;
  }

  // ─── Listing audit freshness (keyword-agnostic reuse gate) ────────────────
  // Returns a Map<string listingId, { is_fresh, last_audited_at, age_hours }>
  // for the requested listing IDs. Used by Step 3 to skip listings that
  // already have a fresh audit row from any prior keyword's snapshot.
  // Batches requests to stay under the worker's 500-id limit per call.
  async getListingAuditFreshness(listingIds) {
    const ids = (listingIds || [])
      .map(x => String(x))
      .filter(x => /^\d+$/.test(x));
    if (ids.length === 0) return { freshnessHours: 48, listings: {} };

    const out = {};
    let freshnessHours = 48;
    const BATCH = 400;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const params = new URLSearchParams();
      for (const id of chunk) params.append('listing_id', id);
      const data = await this._get(`/v1/listings/audit-freshness?${params.toString()}`);
      if (data.freshness_hours) freshnessHours = data.freshness_hours;
      Object.assign(out, data.listings || {});
    }
    return { freshnessHours, listings: out };
  }

  // appendRows(sheetName, rows)
  // rows is an array of arrays (positional values) — but the Worker API expects
  // objects. Positional arrays use the OLD SHEET column order (from _getTableColumns),
  // which maps positions to MySQL column names. Also accepts object rows.
  async appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    const table = WorkerAPIClient._resolveTable(sheetName);

    if (Array.isArray(rows[0])) {
      // Positional data — map using the old sheet column order
      const columns = await this._getTableColumns(table);

      const objRows = rows.map(arr => {
        const obj = {};
        for (let i = 0; i < Math.min(arr.length, columns.length); i++) {
          // Skip columns prefixed with '_skip_' — these sheet positions have no MySQL equivalent
          if (columns[i].startsWith('_skip_')) continue;
          if (arr[i] !== undefined && arr[i] !== null && arr[i] !== '') {
            obj[columns[i]] = WorkerAPIClient._toMySQLDateTime(arr[i]);
          }
        }
        return obj;
      });
      return this._post(`/v1/data/${table}`, { rows: objRows });
    }

    // Already object rows — apply column mapping and datetime conversion
    const mapped = rows.map(obj => WorkerAPIClient._mapRowColumns(obj, table));
    return this._post(`/v1/data/${table}`, { rows: mapped });
  }

  // appendRowsByName(sheetName, rowObjects)
  // rowObjects is an array of { column: value, ... } — maps directly to POST.
  // Column names are translated from sheet-speak to MySQL-speak.
  async appendRowsByName(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return;
    const table = WorkerAPIClient._resolveTable(sheetName);
    const mapped = rowObjects.map(obj => WorkerAPIClient._mapRowColumns(obj, table));
    return this._post(`/v1/data/${table}`, { rows: mapped });
  }

  // updateCell — not needed with MySQL (row-level updates instead)
  // Kept for compat but implemented via updateRowByMatch
  async updateCell(sheetName, row, col, value) {
    // This method is only called from updateRowByMatch/upsertRow internally
    // in SheetAPIClient. With the Worker API, those methods call PATCH directly.
    // If called standalone, it's a no-op warning.
    console.warn('WorkerAPIClient.updateCell() is a no-op — use updateRowByMatch() instead');
  }

  // updateRange — not needed with MySQL
  async updateRange(sheetName, range, values) {
    console.warn('WorkerAPIClient.updateRange() is a no-op — use updateRowByMatch() instead');
  }

  // findRow — returns a truthy value if the row exists (the row object itself)
  // SheetAPIClient returns a 1-based row number; we return the matched row object.
  // Code that only checks truthiness (if (row) ...) works unchanged.
  async findRow(sheetName, matchCol, matchVal) {
    const table = WorkerAPIClient._resolveTable(sheetName);
    const mappedCol = WorkerAPIClient._mapColumnForTable(matchCol, table);
    const params = new URLSearchParams();
    params.set(mappedCol, matchVal);
    params.set('limit', '1');
    const data = await this._get(`/v1/data/${table}?${params.toString()}`);
    return (data.rows && data.rows.length > 0) ? data.rows[0] : null;
  }

  // updateRowByMatch(sheetName, matchCol, matchVal, updates)
  async updateRowByMatch(sheetName, matchCol, matchVal, updates) {
    const table = WorkerAPIClient._resolveTable(sheetName);
    const match = {};
    match[WorkerAPIClient._mapColumnForTable(matchCol, table)] = matchVal;
    const mappedUpdates = WorkerAPIClient._mapRowColumns(updates, table);
    const result = await this._patch(`/v1/data/${table}`, { match, data: mappedUpdates });
    return result.affected > 0;
  }

  // upsertRow(sheetName, matchCol, matchVal, rowData)
  async upsertRow(sheetName, matchCol, matchVal, rowData) {
    const table = WorkerAPIClient._resolveTable(sheetName);
    const mappedRow = WorkerAPIClient._mapRowColumns(rowData, table);
    mappedRow[WorkerAPIClient._mapColumnForTable(matchCol, table)] = matchVal;
    return this._post(`/v1/data/${table}/upsert`, { row: mappedRow });
  }

  // upsertRowsBatch(sheetName, rowObjects)
  // Bulk-upsert many rows in a single HTTP call. The Worker's handleUpsert
  // accepts `{ rows: [...] }` and runs INSERT ... ON DUPLICATE KEY UPDATE
  // per row server-side over one DB connection. Collapses ~50 sequential
  // per-store HTTP calls in etsy-snapshot-workflow into a single roundtrip,
  // which dramatically shortens the time the MV3 service worker spends
  // awaiting between chrome.tabs events (the thing that let Chrome kill it
  // mid-run in the previous build).
  async upsertRowsBatch(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return { success: true, affected: 0 };
    const table = WorkerAPIClient._resolveTable(sheetName);
    const mapped = rowObjects.map(obj => WorkerAPIClient._mapRowColumns(obj, table));
    return this._post(`/v1/data/${table}/upsert`, { rows: mapped });
  }

  // rowExists(sheetName, matchCol, matchVal) → boolean
  async rowExists(sheetName, matchCol, matchVal) {
    const row = await this.findRow(sheetName, matchCol, matchVal);
    return row !== null;
  }

  // getNextId(sheetName, idCol) → number
  async getNextId(sheetName, idCol) {
    const table = WorkerAPIClient._resolveTable(sheetName);
    const mappedCol = WorkerAPIClient._mapColumnForTable(idCol, table);
    const data = await this._get(`/v1/data/${table}/next-id/${mappedCol}`);
    return data.next_id;
  }

  // clearSheetData(sheetName) → number of rows deleted
  // With MySQL, we use DELETE — but we don't expose a DELETE endpoint yet.
  // For safety, this is rarely needed. We'll add it to the Worker API if required.
  async clearSheetData(sheetName) {
    // TODO: Implement server-side DELETE /v1/data/:table/clear endpoint
    console.warn(`WorkerAPIClient.clearSheetData(${sheetName}) — not yet implemented server-side`);
    return 0;
  }

  // logRun(taskName, status, ...)
  async logRun(taskName, status, itemsProcessed = 0, itemsSuccess = 0, itemsFailed = 0, errorMessage = '', notes = '') {
    return this._post('/v1/log', {
      task_name: taskName,
      status,
      items_processed: itemsProcessed,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
      error_message: errorMessage,
      notes,
    });
  }

  // ─── Run management (new — not in SheetAPIClient) ─────────────────────────

  // Create a pipeline run record
  async createRun(seedKeyword, configSnapshot = null) {
    return this._post('/v1/run', {
      seed_keyword: seedKeyword,
      config_snapshot: configSnapshot,
    });
  }

  // Update run status
  async updateRun(runId, status, stepsCompleted = null) {
    const body = { status };
    if (stepsCompleted) body.steps_completed = stepsCompleted;
    return this._patch(`/v1/run/${runId}`, body);
  }

  // Check data freshness for a seed
  async checkFreshness(seedId) {
    return this._get(`/v1/freshness/${seedId}`);
  }

  // Update freshness after scraping
  async updateFreshness(seedId, tableName, rowCount) {
    return this._post(`/v1/freshness/${seedId}`, {
      table_name: tableName,
      row_count: rowCount,
    });
  }

  // Validate the license key — returns user info or throws
  async validateLicense() {
    return this._get('/v1/validate-license');
  }

  // Single-roundtrip seed lookup: returns existence + keyword_count + listing_count
  // Replaces the old multi-step findRow + N+1 listing count.
  async getSeedSummary(seedKeyword) {
    const params = new URLSearchParams();
    params.set('keyword', seedKeyword);
    return this._get(`/v1/seed-summary?${params.toString()}`);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  // Known column orders for each table (fallback when table is empty
  // and we're doing positional appendRows).
  // These match the MySQL CREATE TABLE column order.
  async _getTableColumns(table) {
    // OLD SHEET COLUMN ORDER — this is what positional appendRows() arrays are based on.
    // These map the Google Sheet header order to MySQL column names (via _mapColumn).
    // When a workflow does appendRows('seed_keywords', [[id, kw, 'manual', ...]]),
    // position 0 → 'seed_id', position 2 → 'source', etc.
    // Positional column order — verified against actual appendRows() calls in each workflow.
    // These use MySQL column names (after mapping), matching what the Worker API expects.
    const SHEET_COLUMNS = {
      // erank-keyword-workflow.js line 41: [nextSeedId, seedKeyword, 'manual', '', '', 1, 0, '', '', 0, now, '']
      'seed_keywords': ['seed_id', 'keyword', 'source', 'category', 'product_type', 'times_searched', 'exhaustion_count', 'is_exhausted', 'status', 'locale', 'last_run_at', 'notes'],
      // erank-keyword-workflow.js line 247: [nextKwId, seed_id, keyword, prodType, category, searches, comp, clickRate, '', '', 'pending', 0, '', '', '', '', countryJSON, now]
      // Position 9 was an old "score" sheet column with no MySQL equivalent — always empty, skip it.
      // Position 16 sends JSON.stringify(countryData) which is too large for locale VARCHAR(10) — skip it.
      'keywords': ['keyword_id', 'seed_id', 'keyword', 'product_type', 'category', 'avg_searches', 'competition', 'click_rate', 'trend_velocity', '_skip_score', 'status', 'snapshot_count', 'last_snapshot_at', 'peak_month', 'optimal_list_date', 'source', '_skip_country_json', 'created_at'],
      // etsy-snapshot-workflow.js uses appendRowsByName for snapshots — these positional
      // columns are kept for back-compat only. New context fields (user_agent,
      // screen_resolution, timezone_offset, hour_local, is_logged_in, snapshot_hash,
      // ads_count_top_n) are sent by name. IP / country / city / asn / as_organization
      // / license_key_hash are server-stamped by the Worker from CF headers.
      'search_snapshots': ['snapshot_id', 'keyword_id', 'keyword_text', 'page_number', 'search_type', 'snapshot_date', 'listing_count', 'notes'],
      // etsy-snapshot-workflow.js uses appendRowsByName (not positional) for listings
      'listings': ['listing_id', 'keyword_id', 'snapshot_id', 'shop_name', 'title', 'price', 'original_price', 'discount_pct', 'rating', 'review_count', 'is_digital', 'is_bestseller', 'is_popular_now', 'search_position', 'run_number', 'snapshot_date', 'etsy_url', 'urgency_text', 'free_delivery'],
      // etsy-snapshot-workflow.js uses appendRowsByName (not positional) for stores
      'stores': ['shop_name', 'shop_rating', 'shop_review_count', 'source', 'total_sales', 'shop_location', 'shop_established', 'is_star_seller', 'shop_team_size'],
      // erank-listing-workflow.js line 152: [listing_id, kwText, title, ...20 fields..., now]
      'listing_audit': ['listing_id', 'keyword_text', 'title', 'erank_est_sales', 'erank_views', 'erank_daily_views', 'erank_monthly_views', 'erank_hearts', 'erank_conversion_rate', 'erank_title_length', 'erank_tags_count', 'erank_score', 'erank_listing_age', 'erank_qty', 'tags_list', 'in_carts', 'sold_24h', 'views_24h', 'etsy_thumbnail_url', 'favorites_count', 'photo_count', 'has_video', 'created_at'],
      // erank-keyword-workflow.js line 283: [sugId, parentKwId, keyword, searches, comp, clickRate, '', promoted, now]
      'keyword_suggestions': ['suggestion_id', 'parent_keyword_id', 'keyword', 'avg_searches', 'competition', 'click_rate', 'source', 'promoted', 'created_at'],
      // niche-scoring-workflow.js uses appendRowsByName (not positional)
      'niche_scores': ['niche_id', 'category', 'seed_keyword', 'product_type', 'total_keywords', 'validated_keywords', 'total_listings', 'total_shops', 'avg_price', 'avg_competition', 'avg_searches', 'weak_competitor_pct', 'readiness_score', 'status', 'report_url', 'scored_at'],
      // service-worker.js logRun uses the /v1/log endpoint directly, not positional appendRows
      'automation_log': ['log_id', 'task_name', 'started_at', 'completed_at', 'status', 'items_processed', 'items_success', 'items_failed', 'error_message', 'notes'],
    };
    return SHEET_COLUMNS[table] || [];
  }
}
