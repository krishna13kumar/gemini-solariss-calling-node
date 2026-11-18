/**
 * Smoke test: dialogue engine asks for qualification details in order, escalates
 * unanswerable questions instead of guessing, and the CRM auditor writes a result row.
 * Hits live NVIDIA NIM + does a real Excel write — run with real credentials in .env.
 */
import assert from 'node:assert/strict';
import { NvidiaDialogueEngine } from '../src/providers/llm/nvidia.js';
import { CRMAuditorAgent } from '../src/crmAuditor.js';
import { LeadsStore } from '../src/leadsStore.js';

async function run() {
  console.log('[Test] Dialogue flow + CRM audit...');
  const engine = new NvidiaDialogueEngine();
  const history = [
    { role: 'assistant', content: 'Hello Sir! I am Kavya from Gemini Solariss. Can we talk about reducing your electricity bill with solar panels?' },
    { role: 'user', content: 'Yes sure.' }
  ];

  let reply = '';
  for await (const t of engine.streamResponse(history)) reply += t;
  console.log('  Kavya:', reply);
  // Tamil-default: accept the English word or the Tamil word for "name" (peru/per).
  assert.match(reply.toLowerCase(), /name|per|பெயர்|பேர்/, 'Expected Kavya to ask for the customer name first');
  history.push({ role: 'assistant', content: reply });

  history.push({ role: 'user', content: 'My name is Test Lead. What warranty do you give on the panels?' });
  let reply2 = '';
  for await (const t of engine.streamResponse(history)) reply2 += t;
  console.log('  Kavya:', reply2);
  assert.doesNotMatch(reply2, /\b\d+\s*year/i, 'Kavya should escalate warranty questions, not invent a number');

  const store = new LeadsStore('./data/leads_input.xlsx', './data/leads_completed.xlsx');
  store.saveLeads([{ lead_id: 'TEST_SMOKE_001', customer_name: '', phone_number: '+919000000099', city_district: 'Chennai', avg_bimonthly_eb_bill: 5000, roof_type: 'Concrete' }]);

  const transcript = `AGENT: Hello Sir! I am Kavya from Gemini Solariss.\nUSER: Yes sure.\nAGENT: ${reply}\nUSER: My name is Test Lead, residential, individual roof. Bills were 5000, 5200, 4800.\nAGENT: Average is about 5000 rupees, 2kW recommended, Rs 60,000 subsidy.`;
  const auditor = new CRMAuditorAgent();
  const audit = await auditor.auditAndSaveLead('TEST_SMOKE_001', transcript, store.inputPath, store.outputPath);
  console.log('  Audit result:', audit.customer_name, audit.property_type, audit.eb_bill_average);

  const results = store.listResults();
  const row = results.find(r => r.lead_id === 'TEST_SMOKE_001');
  assert.ok(row, 'Expected a result row for TEST_SMOKE_001 in leads_completed.xlsx');
  assert.equal(row.Property_Type, 'Residential');

  console.log('✅ Dialogue flow + CRM audit test passed.');
}

run().catch(err => { console.error('❌ Test failed:', err); process.exitCode = 1; });
