/**
 * Telephony Plugin: Exotel Cloud PSTN (outbound calls + Voice Streaming bridge).
 */

import { getEnv } from '../../env.js';

export class ExotelTelephonyProvider {
  constructor() {
    this.accountSid = getEnv('EXOTEL_ACCOUNT_SID', '');
    this.apiKey = getEnv('EXOTEL_API_KEY', '');
    this.apiToken = getEnv('EXOTEL_API_TOKEN', '');
    this.callerId = getEnv('EXOTEL_CALLER_ID', '');
    this.subdomain = getEnv('EXOTEL_SUBDOMAIN', 'api.exotel.com');
    this.appletId = getEnv('EXOTEL_APPLET_ID', '');
    this.serverDomain = getEnv('APP_PUBLIC_DOMAIN', '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.defaultTargetNumber = getEnv('EXOTEL_WHITELISTED_NUMBER', '');
    this.activeCalls = new Map();
    this._balanceCache = null; // { data, fetchedAt } — see getBalance()
  }

  /** Formats an Indian number for Exotel's API: leading 0 + 10 digits. */
  formatPhoneNumber(phone) {
    const digits = String(phone || this.defaultTargetNumber).replace(/\D/g, '');
    return `0${digits.slice(-10)}`;
  }

  getConfigStatus() {
    const missing = [];
    if (!this.accountSid) missing.push('EXOTEL_ACCOUNT_SID');
    if (!this.apiKey) missing.push('EXOTEL_API_KEY');
    if (!this.apiToken) missing.push('EXOTEL_API_TOKEN');
    if (!this.callerId) missing.push('EXOTEL_CALLER_ID');
    return {
      isReady: missing.length === 0,
      missing,
      accountSid: this.accountSid ? `${this.accountSid.slice(0, 4)}...${this.accountSid.slice(-4)}` : null,
      callerId: this.callerId || 'Not Configured',
      targetNumber: this.defaultTargetNumber,
      serverDomain: this.serverDomain || 'Not Configured (run a tunnel / deploy publicly)'
    };
  }

  /**
   * Dispatches an outbound call via Exotel, bridged to the App Bazaar flow (`appletId`)
   * that contains the Voicebot/AgentStream node pointed at our WebSocket.
   */
  async triggerCall(lead) {
    const status = this.getConfigStatus();
    const targetPhone = this.formatPhoneNumber(lead.phone_number || this.defaultTargetNumber);

    if (!status.isReady) {
      return { status: 'CREDENTIALS_REQUIRED', error: `Exotel credentials missing: ${status.missing.join(', ')}`, missing: status.missing, lead_id: lead.lead_id, targetPhone };
    }
    if (!this.appletId) {
      return { status: 'APPLET_REQUIRED', error: 'EXOTEL_APPLET_ID is not set — the Connect API Url must point to an Exotel App Bazaar flow.', lead_id: lead.lead_id, targetPhone };
    }

    try {
      const url = `https://${this.subdomain}/v1/Accounts/${this.accountSid}/Calls/connect.json`;
      const basicAuth = Buffer.from(`${this.apiKey}:${this.apiToken}`).toString('base64');

      const formParams = new URLSearchParams();
      formParams.append('From', targetPhone);
      formParams.append('CallerId', this.callerId);
      formParams.append('CallType', 'trans');
      formParams.append('TimeLimit', '480');
      formParams.append('CustomField', lead.lead_id || 'LEAD');
      formParams.append('Url', `http://my.exotel.com/${this.accountSid}/exoml/start_voice/${this.appletId}`);
      if (this.serverDomain) {
        formParams.append('StatusCallback', `https://${this.serverDomain}/telephony/exotel/call-status`);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formParams.toString()
      });
      const rawResponse = await response.text();
      let result;
      try { result = JSON.parse(rawResponse); } catch { result = { raw: rawResponse }; }

      if (!response.ok) {
        return { status: 'FAILED', httpCode: response.status, error: result, lead_id: lead.lead_id, targetPhone };
      }

      const callSid = result.Call?.Sid || 'EXOTEL_CALL_ACTIVE';
      this.activeCalls.set(lead.lead_id, { callSid, leadId: lead.lead_id, targetPhone, startedAt: new Date() });
      return { status: 'INITIATED', callSid, lead_id: lead.lead_id, targetPhone, exotelResponse: result };
    } catch (err) {
      return { status: 'NETWORK_ERROR', error: err.message, lead_id: lead.lead_id, targetPhone };
    }
  }

  async dialDefaultNumber(leadId = 'LEAD_DEFAULT') {
    return this.triggerCall({ lead_id: leadId, phone_number: this.defaultTargetNumber });
  }

  /**
   * Live wallet balance via Exotel's real Account Balance API. Cached briefly
   * since the dashboard polls this periodically and it's a real billed account
   * call, not something to hit every few seconds.
   */
  async getBalance() {
    if (this._balanceCache && Date.now() - this._balanceCache.fetchedAt < 60_000) {
      return this._balanceCache.data;
    }
    const status = this.getConfigStatus();
    if (!status.isReady) return { ok: false, error: `Exotel credentials missing: ${status.missing.join(', ')}` };

    try {
      const url = `https://${this.subdomain}/v1/Accounts/${this.accountSid}/Balance.json`;
      const basicAuth = Buffer.from(`${this.apiKey}:${this.apiToken}`).toString('base64');
      const response = await fetch(url, { headers: { 'Authorization': `Basic ${basicAuth}` } });
      const result = await response.json();
      if (!response.ok) {
        const data = { ok: false, error: result.RestException?.Message || `HTTP ${response.status}` };
        this._balanceCache = { data, fetchedAt: Date.now() };
        return data;
      }
      const data = { ok: true, balance: result.Balance?.Amount, currency: 'INR' };
      this._balanceCache = { data, fetchedAt: Date.now() };
      return data;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async terminateCall(callSid) {
    if (!callSid || !this.accountSid || !this.apiKey) return { status: 'SKIPPED' };
    try {
      const url = `https://${this.subdomain}/v1/Accounts/${this.accountSid}/Calls/${callSid}.json`;
      const basicAuth = Buffer.from(`${this.apiKey}:${this.apiToken}`).toString('base64');
      await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Status: 'completed' }).toString()
      });
      return { status: 'HANGUP_SENT', callSid };
    } catch (err) {
      return { status: 'ERROR', error: err.message };
    }
  }
}
