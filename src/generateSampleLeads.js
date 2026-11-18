/**
 * Generates a template data/leads_input.xlsx with the columns LeadsStore expects.
 * Replace these placeholder rows with real leads before running a campaign.
 */
import { LeadsStore } from './leadsStore.js';

const sampleLeads = [
  { lead_id: 'LEAD_TN_001', customer_name: 'Sundaram Murugan', phone_number: '+919000000001', city_district: 'Chennai', avg_bimonthly_eb_bill: 5200, roof_type: 'Concrete Terrace (1200 sqft)' },
  { lead_id: 'LEAD_TN_002', customer_name: 'Kavitha Rajendran', phone_number: '+919000000002', city_district: 'Coimbatore', avg_bimonthly_eb_bill: 3400, roof_type: 'Concrete Terrace (900 sqft)' },
  { lead_id: 'LEAD_TN_003', customer_name: 'Arun Prakash', phone_number: '+919000000003', city_district: 'Madurai', avg_bimonthly_eb_bill: 8200, roof_type: 'RCC Terrace (1800 sqft)' }
];

const store = new LeadsStore('./data/leads_input.xlsx', './data/leads_completed.xlsx');
store.saveLeads(sampleLeads);
console.log(`Wrote ${sampleLeads.length} placeholder leads to ./data/leads_input.xlsx — replace with real lead data before dialing.`);
