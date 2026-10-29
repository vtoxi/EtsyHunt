// Local Storage API Client — offline replacement for WorkerAPIClient
// Stores pipeline data in chrome.storage.local so no license or remote API is needed.

import { WorkerAPIClient } from './worker-api-client.js';

const STORAGE_KEY = 'localApiData';

const TABLE_PRIMARY_KEYS = {
  seed_keywords: ['seed_id'],
  keywords: ['keyword_id'],
  listings: ['listing_id', 'keyword_id'],
  stores: ['shop_name'],
  search_snapshots: ['snapshot_id'],
  listing_audit: ['listing_id'],
  keyword_suggestions: ['suggestion_id'],
  niche_scores: ['niche_id'],
  automation_log: ['log_id'],
  user_runs: ['run_id'],
  user_keyword_results: ['run_id', 'keyword_id'],
  config: ['key'],
};

function cloneRow(row) {
  return { ...row };
}

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class LocalStorageAPIClient {
  constructor() {
    this.licenseKey = null;
    this._configCache = null;
    this._dataPromise = null;
  }

  async _loadData() {
    if (!this._dataPromise) {
      this._dataPromise = chrome.storage.local.get(STORAGE_KEY).then((result) => {
        const data = result[STORAGE_KEY] || { tables: {}, nextIds: {} };
        if (!data.tables) data.tables = {};
        if (!data.nextIds) data.nextIds = {};
        this._data = data;
        return data;
      });
    }
    return this._dataPromise;
  }

  async _saveData() {
    await chrome.storage.local.set({ [STORAGE_KEY]: this._data });
  }

  _tableName(sheetName) {
    return WorkerAPIClient._resolveTable(sheetName);
  }

  async _getRows(sheetName) {
    await this._loadData();
    const table = this._tableName(sheetName);
    if (!this._data.tables[table]) this._data.tables[table] = [];
    return this._data.tables[table];
  }

  _keywordIdsForSeed(seedId) {
    const keywords = this._data.tables.keywords || [];
    return new Set(
      keywords
        .filter((k) => String(k.seed_id) === String(seedId))
        .map((k) => String(k.keyword_id))
    );
  }

  _applyFilters(table, rows, filters = {}, options = {}) {
    let out = rows.map(cloneRow);

    for (const [rawKey, rawVal] of Object.entries(filters)) {
      const col = WorkerAPIClient._mapColumnForTable(rawKey, table);
      if (col === 'seed_id' && (table === 'listings' || table === 'listing_audit')) {
        const kwIds = this._keywordIdsForSeed(rawVal);
        out = out.filter((row) => kwIds.has(String(row.keyword_id)));
        continue;
      }
      out = out.filter((row) => String(row[col] ?? '') === String(rawVal));
    }

    if (options.sinceHours && options.sinceColumn) {
      const col = WorkerAPIClient._mapColumnForTable(options.sinceColumn, table);
      const cutoff = Date.now() - Number(options.sinceHours) * 3600000;
      out = out.filter((row) => {
        const d = parseDate(row[col]);
        return d && d.getTime() >= cutoff;
      });
    }

    if (options.orderBy) {
      const col = WorkerAPIClient._mapColumnForTable(options.orderBy, table);
      const dir = String(options.order || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      out.sort((a, b) => {
        const av = a[col] ?? '';
        const bv = b[col] ?? '';
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    return out;
  }

  _addAliases(table, rows) {
    const REVERSE_MAP = {};
    for (const [sheetCol, mysqlCol] of Object.entries(WorkerAPIClient.GLOBAL_COLUMN_MAP)) {
      if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
      REVERSE_MAP[mysqlCol].push(sheetCol);
    }
    const tableColMap = WorkerAPIClient.TABLE_COLUMN_MAP[table];
    if (tableColMap) {
      for (const [sheetCol, mysqlCol] of Object.entries(tableColMap)) {
        if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
        REVERSE_MAP[mysqlCol].push(sheetCol);
      }
    }

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        const aliases = REVERSE_MAP[key];
        if (aliases) {
          for (const alias of aliases) {
            if (!Object.prototype.hasOwnProperty.call(row, alias)) row[alias] = row[key];
          }
        }
        const normalized = WorkerAPIClient._normalizeHeader(key);
        if (normalized !== key && !Object.prototype.hasOwnProperty.call(row, normalized)) {
          row[normalized] = row[key];
        }
      }
      if (table === 'keywords' || table === 'listings' || table === 'listing_audit') {
        const seedId = row.seed_id;
        if (seedId != null && !Object.prototype.hasOwnProperty.call(row, 'seed_id')) {
          row.seed_id = seedId;
        }
      }
    }
    return rows;
  }

  async readSheet(sheetName, filters = {}, options = {}) {
    await this._loadData();
    const table = this._tableName(sheetName);
    const allRows = await this._getRows(sheetName);
    const rows = this._addAliases(table, this._applyFilters(table, allRows, filters, options));
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { headers, rows, total: rows.length };
  }

  async readConfig() {
    return this.getConfig();
  }

  async getConfig() {
    if (this._configCache) return this._configCache;
    this._configCache = {};
    return this._configCache;
  }

  invalidateConfig() {
    this._configCache = null;
  }

  async getListingAuditFreshness(listingIds) {
    const ids = (listingIds || []).map(String).filter((x) => /^\d+$/.test(x));
    const freshnessHours = 48;
    const listings = {};
    const { rows } = await this.readSheet('listing_audit');
    const now = Date.now();
    for (const id of ids) {
      const row = rows.find((r) => String(r.listing_id) === id);
      if (!row) {
        listings[id] = { is_fresh: false, last_audited_at: null, age_hours: null };
        continue;
      }
      const auditedAt = row.audited_at || row.created_at;
      const d = parseDate(auditedAt);
      const ageHours = d ? (now - d.getTime()) / 3600000 : null;
      listings[id] = {
        is_fresh: ageHours != null && ageHours < freshnessHours,
        last_audited_at: auditedAt || null,
        age_hours: ageHours,
      };
    }
    return { freshnessHours, listings };
  }

  async appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    await this._loadData();
    const table = this._tableName(sheetName);
    const target = await this._getRows(sheetName);
    const helper = new WorkerAPIClient('local');
    const columns = await helper._getTableColumns(table);

    const objRows = rows.map((arr) => {
      const obj = {};
      for (let i = 0; i < Math.min(arr.length, columns.length); i++) {
        if (columns[i].startsWith('_skip_')) continue;
        if (arr[i] !== undefined && arr[i] !== null && arr[i] !== '') {
          obj[columns[i]] = WorkerAPIClient._toMySQLDateTime(arr[i]);
        }
      }
      return obj;
    });

    target.push(...objRows);
    await this._saveData();
    return { success: true, inserted: objRows.length };
  }

  async appendRowsByName(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return;
    await this._loadData();
    const table = this._tableName(sheetName);
    const target = await this._getRows(sheetName);
    const mapped = [];
    for (const obj of rowObjects) {
      const row = WorkerAPIClient._mapRowColumns(obj, table);
      if (table === 'search_snapshots' && !row.snapshot_id) {
        row.snapshot_id = await this.getNextId(sheetName, 'snapshot_id');
      }
      if (table === 'niche_scores' && !row.niche_id) {
        row.niche_id = await this.getNextId(sheetName, 'niche_id');
      }
      mapped.push(row);
    }
    target.push(...mapped);
    await this._saveData();
    const firstId = mapped[0] && (mapped[0].snapshot_id || mapped[0].niche_id || mapped[0].keyword_id || null);
    return { success: true, inserted: mapped.length, first_insert_id: firstId };
  }

  async updateCell() {
    console.warn('LocalStorageAPIClient.updateCell() is a no-op — use updateRowByMatch() instead');
  }

  async updateRange() {
    console.warn('LocalStorageAPIClient.updateRange() is a no-op — use updateRowByMatch() instead');
  }

  async findRow(sheetName, matchCol, matchVal) {
    const table = this._tableName(sheetName);
    const mappedCol = WorkerAPIClient._mapColumnForTable(matchCol, table);
    const { rows } = await this.readSheet(sheetName, { [mappedCol]: matchVal });
    return rows.length > 0 ? rows[0] : null;
  }

  async updateRowByMatch(sheetName, matchCol, matchVal, updates) {
    await this._loadData();
    const table = this._tableName(sheetName);
    const target = await this._getRows(sheetName);
    const mappedCol = WorkerAPIClient._mapColumnForTable(matchCol, table);
    const mappedUpdates = WorkerAPIClient._mapRowColumns(updates, table);
    const idx = target.findIndex((row) => String(row[mappedCol]) === String(matchVal));
    if (idx < 0) return false;
    target[idx] = { ...target[idx], ...mappedUpdates };
    await this._saveData();
    return true;
  }

  _findUpsertIndex(table, row) {
    const keys = TABLE_PRIMARY_KEYS[table] || Object.keys(row).slice(0, 1);
    return (this._data.tables[table] || []).findIndex((existing) =>
      keys.every((k) => String(existing[k] ?? '') === String(row[k] ?? ''))
    );
  }

  async upsertRow(sheetName, matchCol, matchVal, rowData) {
    await this._loadData();
    const table = this._tableName(sheetName);
    const target = await this._getRows(sheetName);
    const mappedRow = WorkerAPIClient._mapRowColumns(rowData, table);
    mappedRow[WorkerAPIClient._mapColumnForTable(matchCol, table)] = matchVal;
    const idx = this._findUpsertIndex(table, mappedRow);
    if (idx >= 0) target[idx] = { ...target[idx], ...mappedRow };
    else target.push(mappedRow);
    await this._saveData();
    return { success: true };
  }

  async upsertRowsBatch(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return { success: true, affected: 0 };
    await this._loadData();
    const table = this._tableName(sheetName);
    const target = await this._getRows(sheetName);
    let affected = 0;
    for (const obj of rowObjects) {
      const mappedRow = WorkerAPIClient._mapRowColumns(obj, table);
      const idx = this._findUpsertIndex(table, mappedRow);
      if (idx >= 0) {
        target[idx] = { ...target[idx], ...mappedRow };
      } else {
        target.push(mappedRow);
      }
      affected++;
    }
    await this._saveData();
    return { success: true, affected };
  }

  async rowExists(sheetName, matchCol, matchVal) {
    const row = await this.findRow(sheetName, matchCol, matchVal);
    return row !== null;
  }

  async getNextId(sheetName, idCol) {
    await this._loadData();
    const table = this._tableName(sheetName);
    const mappedCol = WorkerAPIClient._mapColumnForTable(idCol, table);
    const rows = await this._getRows(sheetName);
    let max = 0;
    for (const row of rows) {
      const n = parseInt(row[mappedCol], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  async clearSheetData(sheetName) {
    await this._loadData();
    const table = this._tableName(sheetName);
    const count = (this._data.tables[table] || []).length;
    this._data.tables[table] = [];
    await this._saveData();
    return count;
  }

  async logRun(taskName, status, itemsProcessed = 0, itemsSuccess = 0, itemsFailed = 0, errorMessage = '', notes = '') {
    const logId = await this.getNextId('automation_log', 'log_id');
    return this.appendRowsByName('automation_log', [{
      log_id: logId,
      task_name: taskName,
      started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      completed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      status,
      items_processed: itemsProcessed,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
      error_message: errorMessage,
      notes,
    }]);
  }

  async createRun(seedKeyword, configSnapshot = null) {
    await this._loadData();
    const seeds = await this._getRows('seed_keywords');
    let seed = seeds.find((s) => (s.keyword || '').toLowerCase().trim() === String(seedKeyword || '').toLowerCase().trim());
    if (!seed) {
      const seedId = await this.getNextId('seed_keywords', 'seed_id');
      seed = {
        seed_id: seedId,
        keyword: seedKeyword,
        source: 'manual',
        times_searched: 0,
        status: 'active',
      };
      seeds.push(seed);
    }
    const runId = await this.getNextId('user_runs', 'run_id');
    const run = {
      run_id: runId,
      seed_id: seed.seed_id,
      seed_keyword: seedKeyword,
      status: 'running',
      started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      config_snapshot: configSnapshot,
    };
    const runs = await this._getRows('user_runs');
    runs.push(run);
    await this._saveData();
    return { success: true, run_id: runId };
  }

  async updateRun(runId, status, stepsCompleted = null) {
    const updates = { status };
    if (stepsCompleted) updates.steps_completed = stepsCompleted;
    updates.completed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await this.updateRowByMatch('user_runs', 'run_id', runId, updates);
    return { success: true };
  }

  async checkFreshness(seedId) {
    return { fresh: true, seed_id: seedId };
  }

  async updateFreshness(seedId, tableName, rowCount) {
    return { success: true, seed_id: seedId, table_name: tableName, row_count: rowCount };
  }

  async validateLicense() {
    return {
      success: true,
      user: { display_name: 'Local', license_tier: 'local' },
    };
  }

  async getSeedSummary(seedKeyword) {
    const { rows: seeds } = await this.readSheet('seed_keywords');
    const seed = seeds.find((s) => (s.keyword || '').toLowerCase().trim() === String(seedKeyword || '').toLowerCase().trim());
    if (!seed) return { exists: false };
    const { rows: keywords } = await this.readSheet('etsy_keywords', { seed_id: seed.seed_id });
    const kwIds = new Set(keywords.map((k) => String(k.keyword_id)));
    const { rows: listings } = await this.readSheet('etsy_listings');
    const listingCount = listings.filter((l) => kwIds.has(String(l.keyword_id))).length;
    return {
      exists: true,
      times_searched: seed.times_searched != null ? seed.times_searched : 0,
      keyword_count: keywords.length,
      listing_count: listingCount,
    };
  }

  async _post() {
    return { success: true };
  }

  async _get() {
    return { success: true };
  }
}
