// Google Sheets API Client
// Uses Google Sheets REST API v4 with service account JWT auth

import { JWTSigner } from './jwt-signer.js';

export class SheetAPIClient {
  constructor(serviceAccountJSON, spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.jwtSigner = new JWTSigner(serviceAccountJSON);
    this.baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  }

  async _authHeaders() {
    const token = await this.jwtSigner.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  // Read all values from a sheet
  async readSheet(sheetName) {
    const headers = await this._authHeaders();
    const url = `${this.baseUrl}/values/${encodeURIComponent(sheetName)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`readSheet(${sheetName}) failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length === 0) return { headers: [], rows: [] };
    const headerRow = rows[0];
    const dataRows = rows.slice(1).map(r => {
      const obj = {};
      headerRow.forEach((h, i) => {
        const val = r[i] || '';
        // Store under the raw header name (preserves original for appendRowsByName)
        obj[h] = val;
        // Also store under normalized snake_case key so code can use either form.
        // e.g. sheet header "Shop Rating" → also accessible as obj.shop_rating
        const normalized = SheetAPIClient._normalizeHeader(h);
        if (normalized !== h && !obj.hasOwnProperty(normalized)) {
          obj[normalized] = val;
        }
      });
      return obj;
    });
    return { headers: headerRow, rows: dataRows };
  }

  // Read config sheet as key-value pairs
  async readConfig(sheetName = 'config') {
    const { rows } = await this.readSheet(sheetName);
    const config = {};
    for (const row of rows) {
      const k = (row.key || '').trim();
      let v = row.value || '';
      if (k) {
        const num = Number(v);
        config[k] = isNaN(num) ? v : num;
      }
    }
    return config;
  }

  // Append rows to a sheet
  async appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    const headers = await this._authHeaders();
    const url = `${this.baseUrl}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: rows })
    });
    if (!res.ok) throw new Error(`appendRows(${sheetName}) failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Normalize a header string for flexible matching:
  // "Shop Rating" → "shop_rating", "shop-rating" → "shop_rating", "shopRating" → "shoprating"
  static _normalizeHeader(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
  }

  // Append rows using named columns — maps each object's keys to the sheet's actual header order.
  // This prevents column shift bugs when the sheet header order differs from the code's assumptions.
  // Each row is an object like { listing_id: '123', title: 'My Item', price: 9.99, ... }
  // Header matching is case-insensitive and treats spaces/hyphens/underscores as equivalent,
  // so "Shop Rating" in the sheet matches "shop_rating" in the object.
  async appendRowsByName(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return;
    const { headers: sheetHeaders } = await this.readSheet(sheetName);
    if (!sheetHeaders || sheetHeaders.length === 0) {
      throw new Error(`appendRowsByName(${sheetName}): sheet has no headers`);
    }

    // Build a map from normalized object keys to original keys (from first row object)
    const sample = rowObjects[0];
    const objKeyMap = {}; // normalized → original key
    for (const key of Object.keys(sample)) {
      objKeyMap[SheetAPIClient._normalizeHeader(key)] = key;
    }

    // For each sheet header, find the matching object key via normalized comparison
    const headerToObjKey = sheetHeaders.map(h => {
      // Try exact match first (fastest path when headers already match)
      if (sample.hasOwnProperty(h)) return h;
      // Try normalized match
      const normalized = SheetAPIClient._normalizeHeader(h);
      return objKeyMap[normalized] || null;
    });

    const rows = rowObjects.map(obj => {
      return headerToObjKey.map(objKey => {
        if (!objKey) return '';
        const val = obj[objKey];
        return val !== undefined && val !== null ? String(val) : '';
      });
    });
    return this.appendRows(sheetName, rows);
  }

  // Update a single cell (row and col are 1-based)
  async updateCell(sheetName, row, col, value) {
    const headers = await this._authHeaders();
    const colLetter = String.fromCharCode(64 + col);
    const range = `${sheetName}!${colLetter}${row}`;
    const url = `${this.baseUrl}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: [[value]] })
    });
    if (!res.ok) throw new Error(`updateCell failed: ${res.status}`);
  }

  // Update a range of cells
  async updateRange(sheetName, range, values) {
    const hdrs = await this._authHeaders();
    const url = `${this.baseUrl}/values/${encodeURIComponent(`${sheetName}!${range}`)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ values })
    });
    if (!res.ok) throw new Error(`updateRange failed: ${res.status}`);
  }

  // Find a header's index using flexible matching (exact first, then normalized)
  _findHeaderIndex(headers, colName) {
    let idx = headers.indexOf(colName);
    if (idx !== -1) return idx;
    const normalized = SheetAPIClient._normalizeHeader(colName);
    return headers.findIndex(h => SheetAPIClient._normalizeHeader(h) === normalized);
  }

  // Find row index by matching a column value. Returns 1-based row number (header=1, first data=2)
  async findRow(sheetName, matchCol, matchVal) {
    const { headers: hdr, rows } = await this.readSheet(sheetName);
    const colIdx = this._findHeaderIndex(hdr, matchCol);
    if (colIdx === -1) return null;
    const rawHeader = hdr[colIdx]; // Use actual header name for row lookup
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][rawHeader] || '').trim() === String(matchVal).trim()) {
        return i + 2; // +2 because row 1 is header, data starts at row 2
      }
    }
    return null;
  }

  // Update columns in a row found by matching
  async updateRowByMatch(sheetName, matchCol, matchVal, updates) {
    const { headers: hdr } = await this.readSheet(sheetName);
    const rowNum = await this.findRow(sheetName, matchCol, matchVal);
    if (!rowNum) return false;
    for (const [colName, value] of Object.entries(updates)) {
      const colIdx = this._findHeaderIndex(hdr, colName);
      if (colIdx !== -1) {
        await this.updateCell(sheetName, rowNum, colIdx + 1, value);
      }
    }
    return true;
  }

  // Upsert: update if exists, append if not
  async upsertRow(sheetName, matchCol, matchVal, rowData) {
    const { headers: hdr } = await this.readSheet(sheetName);
    const rowNum = await this.findRow(sheetName, matchCol, matchVal);
    if (rowNum) {
      for (const [colName, value] of Object.entries(rowData)) {
        const colIdx = this._findHeaderIndex(hdr, colName);
        if (colIdx !== -1) {
          await this.updateCell(sheetName, rowNum, colIdx + 1, value);
        }
      }
    } else {
      // Build row using flexible header matching
      const dataKeyMap = {};
      for (const key of Object.keys(rowData)) {
        dataKeyMap[SheetAPIClient._normalizeHeader(key)] = key;
      }
      const newRow = hdr.map(h => {
        if (rowData.hasOwnProperty(h)) return String(rowData[h] ?? '');
        const norm = SheetAPIClient._normalizeHeader(h);
        const matchedKey = dataKeyMap[norm];
        return matchedKey ? String(rowData[matchedKey] ?? '') : '';
      });
      await this.appendRows(sheetName, [newRow]);
    }
  }

  // Check if a row exists
  async rowExists(sheetName, matchCol, matchVal) {
    const row = await this.findRow(sheetName, matchCol, matchVal);
    return row !== null;
  }

  // Get next ID (max + 1)
  async getNextId(sheetName, idCol) {
    const { rows } = await this.readSheet(sheetName);
    let max = 0;
    for (const row of rows) {
      const val = parseInt(row[idCol]);
      if (!isNaN(val) && val > max) max = val;
    }
    return max + 1;
  }

  // Clear all data rows from a sheet (keeps header row intact)
  // Uses deleteRows (batchUpdate) instead of values:clear to also remove formatting.
  // This prevents the blue header background from bleeding into new data rows.
  async clearSheetData(sheetName) {
    const headers = await this._authHeaders();

    // First, read to see how many rows there are
    const url = `${this.baseUrl}/values/${encodeURIComponent(sheetName)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`clearSheetData read failed: ${res.status}`);
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length <= 1) return 0; // Only header or empty — nothing to clear

    // Get the numeric sheetId for this tab
    const metaUrl = `${this.baseUrl}?fields=sheets.properties`;
    const metaRes = await fetch(metaUrl, { headers });
    if (!metaRes.ok) throw new Error(`clearSheetData meta failed: ${metaRes.status}`);
    const metaData = await metaRes.json();
    const sheet = (metaData.sheets || []).find(s => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
    const sheetId = sheet.properties.sheetId;

    // Delete all rows from row 2 (index 1) onwards — removes values AND formatting
    const batchUrl = `${this.baseUrl}:batchUpdate`;
    const batchRes = await fetch(batchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: 1,  // Row index 1 = row 2 (0-indexed, row 0 = header)
              endIndex: rows.length
            }
          }
        }]
      })
    });
    if (!batchRes.ok) throw new Error(`clearSheetData delete failed: ${batchRes.status}`);
    return rows.length - 1; // number of data rows deleted
  }

  // Log a run to automation_log
  async logRun(taskName, status, itemsProcessed = 0, itemsSuccess = 0, itemsFailed = 0, errorMessage = '', notes = '') {
    const now = new Date().toISOString();
    const { rows } = await this.readSheet('automation_log');
    const nextId = rows.length + 1;
    await this.appendRows('automation_log', [[
      nextId, taskName, now, now, status, itemsProcessed, itemsSuccess, itemsFailed, errorMessage, notes
    ]]);
  }
}
