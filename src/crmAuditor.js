/**
 * Post-call CRM auditor: extracts structured lead data from the transcript via
 * an NVIDIA NIM model (JSON reply), and writes it into data/leads_completed.xlsx.
 */

import { LeadsStore } from './leadsStore.js';
import { createLLMProvider } from './providers/index.js';

export class CRMAuditorAgent {
  /** @param {{generateJson(prompt: string): Promise<Object>}} [llm] the (switchable) LLM; defaults to the configured one */
  constructor(llm = createLLMProvider()) {
    this.llm = llm;
  }

  async auditAndSaveLead(leadId, transcript, inputExcelPath, outputExcelPath) {
    const auditPrompt = `
You are the Quality Assurance Auditor and CRM Data Extractor for Gemini Solariss.
Analyze this customer telephone call transcript. Verify that:
1. The agent properly identified as 'Gemini Solariss'.
2. Central subsidies were accurate (1kW=30k, 2kW=60k, 3kW+=78k max cap).
3. Extract: Customer Name, Property Type (Residential/Commercial), Roof Ownership (Individual/Shared), last 3 EB bill amounts and their average, Full Address.
4. Use "DECLINED_TO_ANSWER" ONLY if the customer explicitly refused or said they are not willing/able to share details now. A conversation that simply stops before every detail is collected (the customer never refused) is "CLIENT_DISCONNECTED", not declined.
4b. Record every figure the customer actually gave. If they stated only an average bill (not three separate bills), set eb_bill_average to that figure (e.g. "Rs 4500 (customer's own estimate)") and eb_bill_readings to "Not Provided". Never invent or compute figures they did not say.
5. Extract every question the customer asked that the agent could NOT answer and escalated instead (pricing/financing/warranty/brand/timeline questions, or anything routed to a technical agent).

Transcript:
${transcript}

Respond ONLY with a valid JSON object matching this exact schema:
{
  "audit_passed": true,
  "hallucination_flag": false,
  "call_disposition": "QUALIFIED_LEAD" | "SITE_VISIT_BOOKED" | "RESCHEDULED" | "DECLINED_TO_ANSWER" | "CLIENT_BUSY_ATTENDED" | "CLIENT_DISCONNECTED" | "NOT_INTERESTED" | "INELIGIBLE",
  "customer_name": "e.g. Sundaram Murugan or Not Provided",
  "property_type": "Residential" | "Commercial" | "Not Provided",
  "roof_ownership": "Individual" | "Shared" | "Not Provided",
  "eb_bill_readings": "e.g. Rs 5200, Rs 4800, Rs 5400 or Not Provided",
  "eb_bill_average": "e.g. Rs 5133 or Not Provided",
  "recommended_kw": "e.g. 3 kW or Not Specified",
  "subsidy_amount": "e.g. Rs 78,000 or Not Applicable",
  "address": "Full address as given or Not Provided",
  "site_visit_slot": "e.g. Next Tuesday 10 AM, or Not Scheduled",
  "reschedule_time": "e.g. Tomorrow 4 PM, or None",
  "unanswered_questions": "Every escalated question, semicolon-separated, or 'None'",
  "customer_queries_summary": "Short summary of customer answers and inquiries",
  "follow_up_action": "Action required by sales/technical team"
}
`;

    let auditResult;
    try {
      auditResult = await this.llm.generateJson(auditPrompt);
    } catch (genErr) {
      console.warn(`[CRMAuditorAgent] LLM audit error (${genErr.message}). Using rule-based fallback.`);
      const lower = transcript.toLowerCase();
      const declined = lower.includes("don't want to answer") || lower.includes('not willing') || lower.includes("won't answer") || lower.includes('not now');
      auditResult = {
        audit_passed: true,
        hallucination_flag: false,
        call_disposition: lower.includes('disconnected') ? 'CLIENT_DISCONNECTED' : (declined ? 'DECLINED_TO_ANSWER' : 'QUALIFIED_LEAD'),
        customer_name: 'Not Provided',
        property_type: lower.includes('residential') ? 'Residential' : (lower.includes('commercial') ? 'Commercial' : 'Not Provided'),
        roof_ownership: lower.includes('shared') || lower.includes('apartment') ? 'Shared' : (lower.includes('individual') ? 'Individual' : 'Not Provided'),
        eb_bill_readings: 'Not Provided',
        eb_bill_average: 'Not Provided',
        recommended_kw: 'Not Specified',
        subsidy_amount: 'Not Applicable',
        address: 'Not Provided',
        site_visit_slot: 'Not Scheduled',
        reschedule_time: 'None',
        unanswered_questions: 'None',
        customer_queries_summary: `AUTOMATIC EXTRACTION FAILED (${String(genErr.message).slice(0, 80)}) — details not parsed; read the transcript.`,
        follow_up_action: 'Review transcript manually'
      };
    }

    const customerLines = transcript
      .split('\n')
      .filter(l => l.startsWith('USER:') || l.startsWith('CUSTOMER:'))
      .map(l => l.replace(/^(USER|CUSTOMER):\s*/, '').trim())
      .filter(Boolean)
      .join(' | ');

    const resultRow = {
      lead_id: leadId,
      Customer_Name: auditResult.customer_name || 'Not Provided',
      Property_Type: auditResult.property_type || 'Not Provided',
      Roof_Ownership: auditResult.roof_ownership || 'Not Provided',
      EB_Bill_Readings: auditResult.eb_bill_readings || 'Not Provided',
      EB_Bill_Average: auditResult.eb_bill_average || 'Not Provided',
      Recommended_KW: auditResult.recommended_kw || 'Not Specified',
      Subsidy_Amount: auditResult.subsidy_amount || 'Not Applicable',
      Address: auditResult.address || 'Not Provided',
      Site_Visit_Slot: auditResult.site_visit_slot || 'Not Scheduled',
      Call_Disposition: auditResult.call_disposition,
      Unanswered_Questions: auditResult.unanswered_questions || 'None',
      Customer_Spoken_Statements: customerLines || 'None',
      Customer_Summary: auditResult.customer_queries_summary,
      Follow_Up_Action: auditResult.follow_up_action,
      Full_Conversation_Transcript: transcript,
      Audit_Passed: auditResult.audit_passed,
      Hallucination_Flag: auditResult.hallucination_flag,
      Audited_At: new Date().toISOString()
    };

    new LeadsStore(inputExcelPath, outputExcelPath).upsertResult(resultRow);
    return auditResult;
  }
}
