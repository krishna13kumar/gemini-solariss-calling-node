/**
 * Leads storage: data/leads_input.xlsx (editable queue) and data/leads_completed.xlsx
 * (read-only call results). Backs the dashboard's leads grid, upload, and results view.
 */

import xlsx from 'xlsx';
import fs from 'fs';
import { getEnv } from './env.js';

const REQUIRED_LEAD_COLUMNS = ['lead_id', 'customer_name', 'phone_number', 'city_district', 'avg_bimonthly_eb_bill', 'roof_type'];

export class LeadsStore {
  constructor(inputPath = './data/leads_input.xlsx', outputPath = './data/leads_completed.xlsx') {
    this.inputPath = inputPath;
    this.outputPath = outputPath;
    this.nodeEnv = getEnv('NODE_ENV', 'development');
  }

  /** TRAI telemarketing window: 09:00-20:30 IST. Bypassed outside production for testing. */
  isWithinTraiCallingHours() {
    if (this.nodeEnv !== 'production') return true;
    const istDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const minutes = istDate.getHours() * 60 + istDate.getMinutes();
    return minutes >= 9 * 60 && minutes <= 20 * 60 + 30;
  }

  cleanPhoneNumber(rawNumber) {
    if (!rawNumber) return null;
    const digits = String(rawNumber).replace(/\D/g, '');
    if (digits.length === 10 && ['6', '7', '8', '9'].includes(digits[0])) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91') && ['6', '7', '8', '9'].includes(digits[2])) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith('0') && ['6', '7', '8', '9'].includes(digits[1])) return `+91${digits.slice(1)}`;
    if (this.nodeEnv !== 'production' && digits.length >= 10) return digits.startsWith('91') ? `+${digits}` : `+91${digits.slice(-10)}`;
    return null;
  }

  /** Raw rows exactly as stored, for the editable UI grid (no sanitization/validation). */
  listLeads() {
    if (!fs.existsSync(this.inputPath)) return [];
    const workbook = xlsx.readFile(this.inputPath);
    return xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  }

  /** Sanitized, deduplicated, TRAI-window-checked queue for actually dialing. */
  loadValidatedLeads() {
    if (!this.isWithinTraiCallingHours()) {
      throw new Error('Outbound calling is blocked outside 09:00 AM - 08:30 PM IST per TRAI compliance.');
    }
    const seen = new Set();
    const queue = [];
    for (const row of this.listLeads()) {
      const leadId = String(row.lead_id || '').trim();
      const cleanPhone = this.cleanPhoneNumber(row.phone_number);
      if (!leadId || !cleanPhone || seen.has(cleanPhone)) continue;
      seen.add(cleanPhone);
      queue.push({
        lead_id: leadId,
        customer_name: String(row.customer_name || 'Valued Customer').trim(),
        phone_number: cleanPhone,
        city_district: String(row.city_district || 'Tamil Nadu').trim(),
        avg_bimonthly_eb_bill: parseFloat(row.avg_bimonthly_eb_bill || 0),
        roof_type: String(row.roof_type || 'Concrete Terrace').trim()
      });
    }
    return queue;
  }

  /** Overwrites leads_input.xlsx with rows edited in the UI grid. */
  saveLeads(rows) {
    const workbook = xlsx.utils.book_new();
    const sheet = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(workbook, sheet, 'Leads');
    xlsx.writeFile(workbook, this.inputPath);
    return rows.length;
  }

  /** Replaces leads_input.xlsx entirely from an uploaded file buffer. */
  replaceLeadsFromUpload(fileBuffer) {
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    const missingCols = REQUIRED_LEAD_COLUMNS.filter(col => rows.length > 0 && !(col in rows[0]));
    if (missingCols.length > 0) {
      throw new Error(`Uploaded sheet is missing required column(s): ${missingCols.join(', ')}`);
    }
    this.saveLeads(rows);
    return rows.length;
  }

  getLeadContext(leadId) {
    const rows = this.listLeads();
    return rows.find(r => String(r.lead_id || '').trim() === String(leadId).trim()) || null;
  }

  updateLeadStatus(leadId, updates) {
    const rows = this.listLeads();
    const updatedRows = rows.map(row => {
      if (String(row.lead_id || '').trim() !== String(leadId).trim()) return row;
      return {
        ...row,
        call_status: updates.call_status || row.call_status || 'ATTEMPTED',
        call_disposition: updates.call_disposition || row.call_disposition,
        last_call_notes: updates.last_call_notes || row.last_call_notes,
        last_called_at: new Date().toISOString()
      };
    });
    try {
      this.saveLeads(updatedRows);
    } catch (err) {
      console.warn(`[LeadsStore] Could not persist status update for ${leadId}:`, err.message);
    }
  }

  /** Read-only call results for the dashboard's results view/download. */
  get pendingPath() { return this.outputPath.replace(/.xlsx$/, '_pending.xlsx'); }

  _readRows(file) {
    if (!fs.existsSync(file)) return [];
    try {
      const wb = xlsx.readFile(file);
      return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } catch { return []; }
  }

  /**
   * Results = the main sheet plus anything parked in the pending sheet. Windows locks a
   * workbook that's open in Excel, so a write to it fails; those rows go to the pending sheet
   * instead of being lost, are shown here straight away, and are folded back in (pending file
   * removed) the first time the main sheet is writable again.
   */
  listResults() {
    const rows = this._readRows(this.outputPath);
    const pending = this._readRows(this.pendingPath);
    if (!pending.length) return rows;
    const ids = new Set(pending.map(r => String(r.lead_id).trim()));
    const merged = [...rows.filter(r => !ids.has(String(r.lead_id).trim())), ...pending];
    if (this._writeRows(this.outputPath, merged)) fs.rmSync(this.pendingPath, { force: true });
    return merged;
  }

  _writeRows(file, rows) {
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), 'Completed Leads');
    try { xlsx.writeFile(workbook, file); return true; }
    catch (err) { if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return false; throw err; }
  }

  /** Inserts or replaces one lead's result row. Returns true if it reached the main sheet (false = parked as pending because Excel has it open). */
  upsertResult(row) {
    const id = String(row.lead_id).trim();
    const rows = this.listResults().filter(r => String(r.lead_id).trim() !== id);
    rows.push(row);
    if (this._writeRows(this.outputPath, rows)) return true;
    const pending = this._readRows(this.pendingPath).filter(r => String(r.lead_id).trim() !== id);
    this._writeRows(this.pendingPath, [...pending, row]);
    console.warn(`[LeadsStore] ${this.outputPath} is open in Excel — saved to ${this.pendingPath}; close Excel and it merges automatically.`);
    return false;
  }

  deleteResults(leadIds) {
    const idSet = new Set(leadIds.map(id => String(id).trim()));
    const rows = this.listResults();
    const kept = rows.filter(r => !idSet.has(String(r.lead_id || '').trim()));
    if (!this._writeRows(this.outputPath, kept)) throw new Error('The results file is open in Excel — close it and try again.');
    fs.rmSync(this.pendingPath, { force: true });
    return rows.length - kept.length;
  }
}
