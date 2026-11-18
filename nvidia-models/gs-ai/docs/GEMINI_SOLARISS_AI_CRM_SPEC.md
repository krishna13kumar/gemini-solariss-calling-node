# Gemini Solariss — AI-Orchestrated Solar CRM
### Product & Technical Specification (v1.0 — October 2026)

> **Purpose of this document:** A single source of truth for building the Gemini Solariss CRM — an AI-first CRM tailored to a rooftop/commercial solar business in India. It covers the full customer lifecycle (lead → sale → PM Surya Ghar / DISCOM paperwork → installation → net metering → subsidy → AMC), the plug-and-play AI layer, data model, integrations with setup steps, and GPU/model hosting options (including NVIDIA).
>
> Hand this file to developers (or to an AI coding agent) as the build brief.

---

## Table of Contents
1. [Vision & Goals](#1-vision--goals)
2. [Users & Roles](#2-users--roles)
3. [Customer Lifecycle — Pipeline Stages](#3-customer-lifecycle--pipeline-stages)
4. [AI Orchestration Layer](#4-ai-orchestration-layer)
5. [AI Agents & Smart Features (per stage)](#5-ai-agents--smart-features-per-stage)
6. [Plug-and-Play AI Provider Design](#6-plug-and-play-ai-provider-design)
7. [System Architecture](#7-system-architecture)
8. [Data Model](#8-data-model)
9. [External Entities & Integrations (with setup steps)](#9-external-entities--integrations-with-setup-steps)
10. [NVIDIA GPUs & High-Performance Models](#10-nvidia-gpus--high-performance-models)
11. [Security, Privacy & Compliance](#11-security-privacy--compliance)
12. [Recommended Tech Stack](#12-recommended-tech-stack)
13. [Repository Structure](#13-repository-structure)
14. [Delivery Roadmap](#14-delivery-roadmap)
15. [KPIs & Success Metrics](#15-kpis--success-metrics)
16. [Open Decisions](#16-open-decisions)

---

## 1. Vision & Goals

**Vision:** Every lead that enters Gemini Solariss is guided — automatically and intelligently — to a commissioned solar plant, a received subsidy, and a long-term AMC relationship, with staff acting as supervisors of an AI that does the routine work.

**Goals**
| # | Goal | Measure |
|---|------|---------|
| G1 | No lead is ever forgotten | 100% of leads have a next action + due date |
| G2 | Faster lead → booking | Cut median conversion time by 40% |
| G3 | Zero subsidy rejections due to paperwork | Document pre-checks by AI before every portal submission |
| G4 | Predictable installations | Material + crew + weather-aware scheduling |
| G5 | Recurring revenue | ≥ 60% of installed customers on paid AMC |
| G6 | AI vendor freedom | Swap AI provider via config, no code change |

**Non-goals (v1):** Full ERP / inventory accounting (integrate with Tally/Zoho instead), utility-scale (MW) project management.

---

## 2. Users & Roles

| Role | Primary needs |
|------|---------------|
| **Owner / Admin** | Dashboards, revenue forecast, AI settings, approvals |
| **Sales Executive** | Lead inbox, AI-suggested next actions, quotes, follow-ups |
| **Site Surveyor** (mobile) | Survey checklist, photos, roof measurements, shading notes |
| **Design Engineer** | System sizing, BOM, layout, generation estimate |
| **Documentation / Subsidy Officer** | PM Surya Ghar + DISCOM workflow, document vault, status tracking |
| **Procurement** | BOM → purchase orders, stock, ALMM-compliance check |
| **Installation Team Lead** (mobile) | Job cards, checklists, commissioning photos, customer sign-off |
| **Service / AMC Technician** (mobile) | Tickets, cleaning schedule, inverter alerts |
| **Accounts** | Invoices, payments, GST, collections |
| **Customer** (portal / WhatsApp) | Status tracking, documents upload, payments, service requests |
| **Channel Partner / Referrer** | Submit leads, track commissions |

RBAC is enforced at API level; every AI action runs under the permissions of the role it acts for.

---

## 3. Customer Lifecycle — Pipeline Stages

The pipeline is a **state machine**. Each stage has entry criteria, required data/documents, an SLA, AI responsibilities, and exit criteria. The AI may *propose* stage changes; configurable stages require human approval.

```
LEAD ─► QUALIFIED ─► SURVEY_SCHEDULED ─► SURVEY_DONE ─► DESIGN_READY ─► PROPOSAL_SENT
   │                                                                         │
   └──► NURTURE / LOST ◄─────────────────────── NEGOTIATION ◄────────────────┘
                                                     │
                                                     ▼
 BOOKED (advance) ─► FINANCE (optional) ─► PORTAL_REGISTERED ─► DISCOM_FEASIBILITY_APPROVED
                                                                          │
                                                                          ▼
 PROCUREMENT ─► INSTALL_SCHEDULED ─► INSTALLED ─► INSPECTION_NET_METER_APPLIED
                                                                          │
                                                                          ▼
 NET_METER_INSTALLED / COMMISSIONED ─► SUBSIDY_CLAIMED ─► SUBSIDY_RECEIVED ─► AMC_ACTIVE ⟲ (service, renewals, referrals)
```

### Stage details

| # | Stage | Entry trigger | Key data / docs | Default SLA | AI responsibilities |
|---|-------|---------------|-----------------|-------------|---------------------|
| 1 | **Lead** | Any channel (web, WhatsApp, Meta/Google ads, IndiaMART, JustDial, referral, walk-in, call) | Name, phone, location, source | First response ≤ 5 min | De-duplicate, enrich (geocode, DISCOM, pincode), instant WhatsApp greeting, ask for latest electricity bill |
| 2 | **Qualified** | Bill received / need confirmed | Monthly units, sanctioned load, roof type, ownership, budget, segment (residential / housing society / C&I) | ≤ 24 h | Read the bill (vision OCR), compute recommended kW, subsidy eligibility, savings estimate, lead score |
| 3 | **Survey Scheduled** | Customer agrees | Slot, surveyor, address pin | ≤ 48 h | Propose slots by surveyor route + weather, send reminders |
| 4 | **Survey Done** | Surveyor submits checklist | Roof photos, dimensions, shading, structure type, earthing, meter location, cable route | Same day | Validate completeness of survey, flag risks (shading, weak roof, long cable runs) |
| 5 | **Design Ready** | Engineer approves | kW, panel count, inverter, structure, BOM, generation estimate | ≤ 24 h | Draft design + BOM from templates, generation estimate (PVWatts/PVGIS), ROI/payback |
| 6 | **Proposal Sent** | Quote generated | Quote PDF, options (good/better/best), EMI options | Same day | Generate personalized proposal + WhatsApp summary, track opens |
| 7 | **Negotiation** | Customer engages | Objections, competitor quotes | — | Objection-handling suggestions, discount guardrails, follow-up cadence |
| 8 | **Booked** | Advance paid / agreement e-signed | Agreement, advance receipt | — | Trigger onboarding checklist, collect KYC docs |
| 9 | **Finance** *(optional)* | Customer needs loan | Loan application, sanction | — | Pre-fill loan docs, track NBFC/bank status |
| 10 | **Portal Registered** | Application on PM Surya Ghar national portal | Consumer number, application ID, vendor selection | ≤ 3 days from booking | Document pre-check (name match across bill/Aadhaar/bank), checklist for officer |
| 11 | **DISCOM Feasibility Approved** | DISCOM approval | Feasibility letter | DISCOM-dependent | Track status, escalate if overdue, notify customer |
| 12 | **Procurement** | Feasibility OK | PO, ALMM-listed module serials, inverter serials | ≤ 7 days | Generate PO from BOM, verify ALMM compliance, reserve stock |
| 13 | **Install Scheduled** | Material ready | Date, crew, vehicle | — | Crew/route/weather-aware scheduling, customer prep checklist |
| 14 | **Installed** | Crew submits job card | Photos (geo-tagged), serials, checklist, customer signature | 1–3 days | Verify photo checklist completeness, generate installation report |
| 15 | **Inspection / Net-meter Applied** | Installation details uploaded on portal | Work completion report, net-meter application | ≤ 2 days | Prepare documents, track DISCOM inspection |
| 16 | **Commissioned** | Net meter installed, commissioning certificate issued | Commissioning certificate | DISCOM-dependent | Notify customer, activate monitoring, welcome kit |
| 17 | **Subsidy Claimed** | Bank details + commissioning certificate submitted | Cancelled cheque / passbook | — | Verify bank details, set follow-up timers |
| 18 | **Subsidy Received** | Customer confirms credit | Credit confirmation | ~30–45 days after commissioning (track, don't promise) | Chase status, escalate delays, ask for review/referral |
| 19 | **AMC Active** | AMC contract (free period → paid) | AMC plan, schedule | Recurring | Cleaning schedule, inverter-alert tickets, generation anomaly detection, renewal & upsell (battery, EV charger, capacity add) |

**Side states:** `NURTURE` (not ready now — AI drip campaign), `LOST` (reason captured: price / competitor / roof / financing / no response), `ON_HOLD`, `CANCELLED` (with refund workflow).

**Segment variants:** Housing societies (RWA approval sub-flow), C&I (no residential subsidy; capex/OPEX/PPA options, accelerated depreciation talking points), off-grid/hybrid (battery sizing).

> ⚠️ **Subsidy rules change.** Store all subsidy slabs, caps, state top-ups, and eligibility rules in an admin-editable **Rules table**, never hard-coded. Current central slabs at the time of writing: ₹30,000 for 1 kW, ₹60,000 for 2 kW, ₹78,000 cap for 3 kW and above (verify on pmsuryaghar.gov.in before go-live).

---

## 4. AI Orchestration Layer

### 4.1 Principles
1. **AI proposes, rules constrain, humans approve where it matters.** Every AI action is classified:
   - `AUTO` — safe, reversible (send greeting, set reminder, summarize call, update a field).
   - `SUGGEST` — staff sees a one-click suggestion (send quote, offer discount, move stage).
   - `APPROVAL_REQUIRED` — money, legal, or irreversible actions (refunds, discounts beyond threshold, portal submissions, cancelling a job).
2. **Event-driven.** Every change emits a domain event (`lead.created`, `bill.uploaded`, `survey.completed`, `subsidy.overdue`…). The orchestrator subscribes and decides what to do.
3. **Tools, not free text.** The AI acts only through typed tools (function calling) backed by the CRM API — never direct DB access.
4. **Deterministic guardrails.** SLA timers, compliance checks, pricing floors, and stage-entry rules are code; the AI cannot bypass them.
5. **Full audit trail.** Every AI decision logs: input context, model/provider used, tool calls, output, cost, and who approved.

### 4.2 Orchestration loop
```
Domain Event ──► Event Bus ──► Orchestrator Agent
                                 │ 1. Load context (customer 360, stage, history, rules)
                                 │ 2. Retrieve knowledge (RAG: SOPs, product catalog, subsidy rules)
                                 │ 3. Plan → choose specialist agent(s)
                                 │ 4. Specialist calls tools (CRM API, WhatsApp, calendar…)
                                 │ 5. Policy engine checks action class (AUTO/SUGGEST/APPROVAL)
                                 ▼
                     Execute  |  Queue suggestion  |  Request approval
                                 │
                                 ▼
                        Audit log + metrics + feedback (👍/👎 from staff)
```

### 4.3 Scheduled "sweeps" (the AI as operations manager)
| Sweep | Frequency | What it does |
|-------|-----------|--------------|
| Stale-lead sweep | Hourly | Finds leads with no activity past SLA → drafts follow-ups |
| Daily stand-up brief | 8:30 AM IST | Per-user brief: today's visits, hot leads, overdue items, at-risk deals |
| Pipeline health | Daily | Bottleneck detection (e.g., "11 files stuck at DISCOM feasibility > 15 days") |
| Subsidy chaser | Daily | Commissioned-but-unpaid cases past expected window → escalation |
| Weather planner | Daily | Re-plans surveys/installs if rain forecast |
| AMC planner | Weekly | Schedules cleanings, renewal reminders 60/30/7 days before expiry |
| Generation anomaly | Daily | Compares actual vs expected kWh from inverter APIs → service ticket |
| Owner weekly report | Monday | Revenue, conversion funnel, forecast, AI-suggested improvements |

---

## 5. AI Agents & Smart Features (per stage)

| Agent | Responsibilities | Key tools |
|-------|------------------|-----------|
| **Orchestrator** | Routes events, plans multi-step work, enforces policies | all agents, policy engine |
| **Lead Intake Agent** | Dedupe, enrich, first-touch WhatsApp in customer's language (Tamil/English/Hindi), collect bill | `crm.lead.upsert`, `geo.lookup`, `whatsapp.send_template` |
| **Qualification & Scoring Agent** | Bill OCR → units/load/tariff; kW sizing; subsidy eligibility; lead score (fit × intent × urgency) with explanation | `doc.extract`, `sizing.calc`, `rules.subsidy` |
| **Conversational Sales Agent** | 24×7 WhatsApp/web chat: answers FAQs, explains subsidy, books survey; hands off to human on request or low confidence | `kb.search`, `calendar.book`, `handoff.human` |
| **Follow-up Agent** | Personalized follow-up cadence per stage; picks channel & time based on past response behaviour | `whatsapp`, `sms`, `email`, `call.task` |
| **Survey Assistant** | Validates survey checklist & photos; flags shading/structure risks from photos | `vision.analyze`, `survey.validate` |
| **Design & Proposal Agent** | Draft layout/BOM from templates, PVWatts/PVGIS estimate, ROI, EMI options, generates branded proposal PDF | `pv.estimate`, `catalog.price`, `pdf.render` |
| **Negotiation Coach** | Objection handling, competitor comparison, discount within guardrails | `kb.search`, `pricing.guardrail` |
| **Document & Compliance Agent** | Checks name/address consistency across bill, ID, bank proof; ALMM module verification; missing-doc requests | `doc.extract`, `almm.check`, `vault.store` |
| **Subsidy & DISCOM Tracker** | Tracks portal/DISCOM status, prepares submissions, SLA escalation, keeps customer informed | `portal.status` (manual/RPA), `notify` |
| **Project Scheduler** | Crew/vehicle/material/weather-aware install scheduling; reschedules on disruption | `schedule.optimize`, `weather.forecast`, `inventory.check` |
| **Field Copilot** (mobile) | Voice notes → structured job report; photo checklist validation; offline-first | `speech.transcribe`, `vision.analyze` |
| **AMC & Service Agent** | Inverter alert → ticket; generation anomaly diagnosis; cleaning schedules; renewals; upsell | `inverter.api`, `ticket.create` |
| **Collections Agent** | Payment reminders, payment links, polite escalation | `payments.link`, `invoice.status` |
| **Analytics Copilot** | Natural-language questions ("Which source gives best conversion in Chengalpattu?") → safe read-only SQL/semantic layer → chart | `analytics.query` (read-only) |
| **Reputation & Referral Agent** | Post-subsidy review requests, referral program, testimonial collection | `reviews.link`, `referral.create` |

### Smart features list
- **Bill-to-proposal in minutes:** customer sends bill photo on WhatsApp → AI extracts consumption → instant indicative quote + savings + subsidy.
- **Next Best Action** on every record, with reasoning.
- **Conversation summaries** for every call/WhatsApp thread; sentiment & intent tags.
- **Deal-risk prediction** (no reply, competitor mention, price objection).
- **Multilingual** (Tamil, English, Hindi to start) with tone matching.
- **Voice:** call transcription + summary (via telephony recordings); field voice notes.
- **Knowledge base (RAG):** SOPs, product datasheets, warranty terms, subsidy FAQs, DISCOM procedures — staff and customers get grounded answers with citations.
- **Owner copilot:** "What should I focus on this week?" → prioritized list with numbers.

---

## 6. Plug-and-Play AI Provider Design

### 6.1 Goal
The AI engine must run on **any** of: Anthropic Claude, OpenAI ChatGPT models, Google Gemini models, NVIDIA NIM (hosted or self-hosted), or a **local** model (Ollama / vLLM / llama.cpp / LM Studio) — selectable per task in the admin panel.

> **Naming note:** the business is "Gemini Solariss" and Google's model family is "Gemini". Use the provider ID `google_gemini` in code and config to avoid confusion.

### 6.2 Architecture
```
Agents ──► AI Gateway (internal service)
             ├─ Provider adapters: anthropic | openai | google_gemini | nvidia_nim | openai_compatible (Ollama/vLLM/LM Studio)
             ├─ Model router (task → tier → provider/model, with fallback chain)
             ├─ Capability registry (tool-calling, vision, JSON schema, context length, languages)
             ├─ Prompt registry (versioned prompts per agent)
             ├─ PII redaction / re-identification
             ├─ Response cache + rate limiting + retries
             ├─ Cost & token metering per tenant/agent
             └─ Tracing (Langfuse / OpenTelemetry)
```
You can build this yourself or start from an open-source gateway such as **LiteLLM** (unified OpenAI-style interface to many providers) and wrap it with the router/policy logic.

### 6.3 Unified interface (pseudo-TypeScript)
```ts
interface LLMProvider {
  id: 'anthropic' | 'openai' | 'google_gemini' | 'nvidia_nim' | 'openai_compatible';
  capabilities: { tools: boolean; vision: boolean; jsonSchema: boolean; maxContext: number };
  chat(req: {
    model: string;
    messages: Message[];
    tools?: ToolSpec[];          // JSON-schema tool definitions
    responseSchema?: JSONSchema; // structured output
    temperature?: number;
    maxTokens?: number;
  }): Promise<ChatResult>;       // normalized: text, toolCalls[], usage, latencyMs
  embed?(texts: string[]): Promise<number[][]>;
}
```

### 6.4 Task tiers & routing (example config)
```yaml
ai:
  default_fallback: [anthropic, openai, google_gemini, local]
  tiers:
    fast:        # classification, extraction, short replies, summaries
      primary:  { provider: openai_compatible, base_url: http://gpu-box:8000/v1, model: nemotron-3-nano }
      fallback: { provider: google_gemini, model: <fast-model> }
    reasoning:   # orchestration, planning, negotiation coaching, proposals
      primary:  { provider: anthropic, model: <frontier-model> }
      fallback: { provider: openai, model: <frontier-model> }
    vision:      # bills, roof photos, documents
      primary:  { provider: google_gemini, model: <vision-model> }
      fallback: { provider: openai_compatible, model: <local-vlm> }
    embeddings:
      primary:  { provider: openai_compatible, model: <local-embedding-model> }
  privacy:
    pii_mode: redact_for_cloud      # local models see raw data; cloud models see redacted data
  budgets:
    monthly_inr_cap: 25000
    alert_at_percent: 80
```
Model names are placeholders — fill them from each provider's current catalog at build time.

### 6.5 Requirements for adapters
- Normalize tool-calling formats across providers.
- Enforce JSON-schema outputs; validate and auto-retry on invalid output.
- Health checks + automatic failover (e.g., local GPU box offline → cloud).
- **Evaluation harness:** a golden test set (e.g., 200 real bills, 100 chat transcripts) to benchmark any new model before switching. Switching providers is only "plug-and-play" if you test it.

---

## 7. System Architecture

```
                ┌──────────── Channels ─────────────┐
 Web app (staff) │ Mobile app (field) │ Customer portal │ WhatsApp │ SMS │ Email │ Telephony │ Lead sources
                └───────────────┬───────────────────┘
                                ▼
                      API Gateway / Auth (OIDC, RBAC)
                                ▼
   ┌───────────────────── Core Services ─────────────────────┐
   │ CRM (leads, contacts, deals) │ Projects & Field Service  │
   │ Documents Vault │ Quotes & Proposals │ Billing & Payments │
   │ AMC & Tickets │ Notifications │ Rules Engine │ Workflow   │
   └───────────────┬──────────────────────────────┬──────────┘
                   ▼                              ▼
           Event Bus (Redis Streams / NATS / Kafka)   Scheduler (cron sweeps)
                   ▼
           AI Orchestrator + Agents ──► AI Gateway ──► Cloud LLMs / NVIDIA NIM / Local GPU
                   ▼
   PostgreSQL (+pgvector) │ Object storage (S3/MinIO) │ Redis │ Analytics (read replica / ClickHouse)
                   ▼
          Integration workers (WhatsApp, payments, inverter APIs, accounting, RPA)
```

**Workflow engine:** use a durable workflow engine (e.g., **Temporal**) for long-running flows (booking → subsidy can take months) so timers, retries, and human approvals survive restarts.

---

## 8. Data Model

Core entities (PostgreSQL). `*` = indexed; all tables have `id, tenant_id, created_at, updated_at, created_by`.

| Entity | Key fields |
|--------|-----------|
| **Lead** | source*, campaign, name, phone*, email, pincode*, geo (lat/lng), segment, status*, score, owner_id*, next_action, next_action_due* |
| **Contact / Customer** | name, phone(s), email, language_pref, address, KYC status, consent flags (WhatsApp/SMS/marketing) |
| **Property / Site** | address, geo, roof_type, roof_area, structure, shading_score, DISCOM*, consumer_number*, sanctioned_load, phase, tariff_category |
| **ElectricityBill** | site_id, billing_period, units, amount, extracted_json, confidence |
| **Opportunity / Deal** | contact_id, site_id, stage*, value, probability, expected_close, lost_reason, competitor |
| **Survey** | site_id, surveyor_id, scheduled_at, checklist_json, photos[], risks[] |
| **Design** | kW, modules (make/model/qty/Wp), inverter, structure, BOM[], expected_annual_kwh, layout_file |
| **Quote / Proposal** | version, options[], price, gst, subsidy_estimate, net_price, emi_options, pdf_url, viewed_at |
| **Agreement** | quote_id, esign_status, signed_pdf_url |
| **SubsidyApplication** | portal_app_id*, consumer_no, status*, feasibility_date, commissioning_date, claim_date, credited_date, amount, state_topup |
| **NetMeterApplication** | discom_ref, status, inspection_date, meter_installed_date |
| **PurchaseOrder / Inventory** | items, serials[], ALMM_verified, supplier |
| **InstallationJob** | crew[], scheduled_date, checklist_json, photos[], serials[], customer_signoff |
| **Asset (Installed System)** | site_id, commissioning_date, inverter_brand, monitoring_id, warranty dates |
| **AMCContract** | plan, start, end, visits_per_year, price, status* |
| **ServiceTicket** | asset_id, type (cleaning/fault/alert), priority, status*, sla_due |
| **Payment / Invoice** | amount, type (advance/milestone/final/AMC), gateway_ref, gst_invoice_no |
| **Document** | owner_entity, type (bill/ID/bank/photo/certificate), url, extracted_json, verified, retention_until |
| **Activity / Message** | channel, direction, content, summary, sentiment, ai_generated |
| **Task** | assignee, due, type, source (AI/human), status |
| **AIActionLog** | agent, event, provider, model, prompt_version, tool_calls, action_class, approved_by, tokens, cost_inr, latency |
| **Rule** | type (subsidy_slab, sla, discount_cap, state_topup…), JSON value, effective_from/to |
| **KnowledgeChunk** | source_doc, text, embedding (pgvector) |

---

## 9. External Entities & Integrations (with setup steps)

Priority: **P0** = needed for MVP, **P1** = phase 2, **P2** = later.

### 9.1 Communication

#### WhatsApp Business Platform (Cloud API by Meta) — **P0**
Primary customer channel in India.
1. Create a **Meta Business Portfolio** (business.facebook.com) and complete **business verification** (GST certificate / incorporation docs).
2. In **Meta for Developers**, create an app → add the **WhatsApp** product.
3. Register a **dedicated phone number** not active on the regular WhatsApp app; set the display name "Gemini Solariss" (subject to approval).
4. Generate a **permanent System User access token** with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
5. Configure a **webhook** (HTTPS) for inbound messages and delivery statuses; verify with the verify token.
6. Create and get **message templates** approved (greeting, survey reminder, quote sent, payment reminder, subsidy update, AMC reminder) — needed to message customers outside the 24-hour window.
7. Store opt-in consent per customer.
*Alternative:* a Business Solution Provider (BSP) such as Gupshup, Interakt, AiSensy, or Wati if you want a managed dashboard — they wrap the same API.

#### SMS — **P0**
1. Choose a provider (MSG91, Gupshup, Kaleyra, Twilio, etc.).
2. Register as Principal Entity on a **TRAI DLT** platform (Jio/Airtel/Vi/BSNL portals).
3. Register **sender ID (header)** and **content templates** on DLT.
4. Map DLT template IDs in the CRM template table.

#### Email — **P0**
1. Provider: Amazon SES / SendGrid / Zoho ZeptoMail / Google Workspace.
2. Verify domain; set **SPF, DKIM, DMARC** DNS records.
3. Configure inbound parsing (reply-to-CRM) via webhook.

#### Telephony / Cloud calling — **P1**
1. Provider: Exotel, Knowlarity, Ozonetel, or Twilio.
2. Get virtual numbers; configure click-to-call, call recording, and call-status webhooks.
3. Pipe recordings to the speech-to-text service → AI summary attached to the lead.
4. Inform callers about recording (consent prompt).

### 9.2 Lead sources — **P0**
| Source | Steps |
|--------|-------|
| **Website forms** | Embed CRM form / POST to `/api/leads` with UTM capture + reCAPTCHA |
| **Meta Lead Ads** (Facebook/Instagram) | Connect Page in Meta app → subscribe to `leadgen` webhook → fetch lead via Graph API |
| **Google Ads lead forms** | Configure webhook URL + key in the lead form extension |
| **IndiaMART** | Enable Lead Manager **CRM integration / push API** key from seller panel → poll or receive leads |
| **JustDial** | Request lead API / email lead parsing from JustDial account manager |
| **Referral / channel partners** | Partner portal + unique referral links |
| **Google Business Profile** | Track calls/messages; collect reviews post-installation |

### 9.3 Government & utility

#### PM Surya Ghar national portal (pmsuryaghar.gov.in) — **P0 (process), no public API**
1. Ensure Gemini Solariss is a **registered/empanelled vendor** for your state on the portal.
2. Create officer logins; map officers to CRM users.
3. In CRM, model the portal steps as tasks: consumer registration → application → vendor selection → feasibility → installation details upload → net-meter request → commissioning → bank details → subsidy.
4. Capture portal **application ID** and status manually (or via assisted entry).
5. *Optional later:* browser automation (RPA) **only** for reading status, with human-in-the-loop for any submission, and only if permitted by the portal's terms. Never store customers' portal passwords in plain text.

#### DISCOM (Tamil Nadu: TNPDCL, formerly TANGEDCO; others by state) — **P0 (process)**
1. Maintain a **DISCOM master** (name, circle/section offices, contacts, typical SLAs, required documents).
2. Track feasibility, inspection, and net-meter installation dates per application.
3. AI escalation rules per DISCOM SLA.

#### ALMM (Approved List of Models & Manufacturers, MNRE) — **P0**
1. Import the current ALMM list (published by MNRE) into a reference table; refresh monthly.
2. Validate module make/model at design and procurement; block non-compliant modules for subsidy jobs.

#### National Portal for loans (e.g., Jan Samarth / bank rooftop-solar loan schemes) — **P2**
Track applications manually first; integrate with partner NBFC/bank APIs if available.

### 9.4 Payments, finance & documents

| Integration | Priority | Setup steps |
|-------------|----------|-------------|
| **Payment gateway** (Razorpay / Cashfree / PayU) | P0 | KYC business account → API keys → Payment Links + UPI + webhooks (`payment.captured`) → reconcile to invoice |
| **Accounting** (Tally Prime / Zoho Books) | P1 | Zoho Books: OAuth app + API sync of invoices/payments. Tally: XML/ODBC connector or a sync middleware |
| **GST e-invoicing** (IRP via GSP) | P1 | If turnover crosses e-invoice threshold: register with a GSP → generate IRN + QR on invoices |
| **e-Sign** (Leegality / Digio / SignDesk / Aadhaar eSign) | P1 | Create account → API keys → agreement templates → webhook on signed |
| **KYC / DigiLocker** (via Digio, Setu, or similar) | P2 | Consent-based document fetch to reduce manual uploads |
| **Solar loan partners / NBFCs** | P2 | Lead-sharing API or portal; track sanction status |

### 9.5 Maps, design & energy data

| Integration | Priority | Setup steps |
|-------------|----------|-------------|
| **Google Maps Platform** (Geocoding, Places, Maps JS, Routes) | P0 | GCP project → enable APIs → restricted API keys → billing alerts |
| **NREL PVWatts API** or **EU PVGIS API** | P0 | PVWatts: free API key from developer.nrel.gov. PVGIS: no key. Use for annual/monthly kWh estimates by lat/lng, tilt, azimuth |
| **Google Solar API** | P2 | Check India coverage for your service areas before relying on it |
| **Weather** (Open-Meteo / OpenWeather / IMD data) | P1 | API key (if needed) → daily forecast for survey/install scheduling; irradiance for performance checks |
| **Design tools** (e.g., PVsyst, Aurora, OpenSolar, HelioScope) | P2 | Import/export designs via files or API where available |

### 9.6 Plant monitoring (for AMC) — **P1**
Connect the inverter brands you install. Each typically needs an installer/business account and API access request:
| Brand portal | Steps |
|--------------|-------|
| Huawei FusionSolar | Request Northbound API account from Huawei/your distributor |
| Sungrow iSolarCloud | Apply for developer/OpenAPI access |
| Growatt | Request API token via installer account |
| SolarEdge | Generate API key in monitoring portal (site/account level) |
| Solis (SolisCloud), GoodWe (SEMS), Polycab, Deye etc. | Request API keys from the vendor / distributor |
Then: normalize to a common `generation_daily` table → anomaly detection agent → auto service tickets.

### 9.7 Platform & internal services

| Service | Priority | Notes |
|---------|----------|-------|
| **Object storage** (AWS S3 Mumbai/Hyderabad region, or MinIO on-prem) | P0 | Encrypted buckets for documents & photos; India data residency |
| **Auth** (Keycloak / Auth0 / Clerk / Supabase Auth) | P0 | OIDC, MFA for staff, OTP login for customers |
| **Push notifications** (Firebase Cloud Messaging) | P1 | Mobile app alerts for field staff |
| **Calendar** (Google Workspace / Microsoft 365) | P1 | OAuth → sync survey/installation appointments |
| **Speech-to-text** (cloud provider or local Whisper-class / NVIDIA Riva) | P1 | Call & voice-note transcription; test Tamil accuracy |
| **AI providers** (Anthropic, OpenAI, Google, NVIDIA NIM, local) | P0 | API keys in a secrets manager; per-provider spend limits |
| **Observability** (Langfuse, Sentry, Grafana/Prometheus) | P0 | LLM traces, errors, metrics |
| **Reviews** (Google Business Profile) | P2 | Review-request links post subsidy credit |

### 9.8 Integration build order
1. Auth, storage, database → 2. WhatsApp + SMS + email → 3. Website + Meta + IndiaMART leads → 4. Maps + PVWatts → 5. Payments → 6. AI gateway with 1 cloud + 1 local provider → 7. e-Sign + accounting → 8. Inverter monitoring → 9. Telephony + speech → 10. Optional RPA status readers.

---

## 10. NVIDIA GPUs & High-Performance Models

**Short answer: Yes.** NVIDIA fits well as the "local AI" option in the plug-and-play design. Because NVIDIA NIM, vLLM, and Ollama all expose **OpenAI-compatible endpoints**, the CRM's `openai_compatible` / `nvidia_nim` adapter can point at them with no code changes.

### 10.1 Options, from cheapest to most powerful

| Option | What it is | Good for | Notes |
|--------|-----------|----------|-------|
| **A. NVIDIA hosted API** (build.nvidia.com) | NVIDIA-hosted endpoints for many open models | Prototyping, benchmarking before buying hardware | Hosted catalog can change; use for evaluation, not as the only production path |
| **B. Single workstation GPU** (e.g., RTX-class 24–32 GB, or RTX PRO workstation cards with larger VRAM) | On-prem box running vLLM / Ollama / NIM | Routine tasks: bill extraction, summaries, classification, WhatsApp drafts, embeddings | Best value for a single-company CRM; keeps customer PII on your premises |
| **C. NVIDIA DGX Spark-class desktop** (large unified memory) | Compact AI workstation | Running larger quantized models + a vision model side-by-side | Check current price/availability in India |
| **D. Rented cloud GPUs** (L40S / A100 / H100 on Indian clouds such as E2E Networks or Yotta, or AWS/GCP/Azure India regions) | Pay-per-hour GPU servers | Scaling, burst workloads, avoiding capex | Keeps data in India; compare hourly cost vs. cloud LLM API cost |
| **E. Multi-GPU servers** (8× H100/B-series) | Data-centre class | Frontier-size open models | **Overkill for a CRM** — only for multi-tenant SaaS at large scale |

### 10.2 Suggested open models to evaluate on NVIDIA GPUs
| Role in CRM | Candidate families (verify latest versions) | Hardware fit |
|-------------|----------------------------------------------|--------------|
| Fast agent / tool-calling / RAG | **NVIDIA Nemotron 3 Nano** (efficient MoE, small active parameters), Qwen-family instruct models, Llama-family 8B–70B | Single 24–48 GB GPU (quantized) |
| Stronger reasoning on-prem | Nemotron 3 Super (needs a multi-GPU H100-class node at full precision), larger Qwen/Llama/Mistral models | Multi-GPU / cloud GPU |
| Vision (bills, roof photos, documents) | Gemma-family and Mistral-family VLMs (available as NIM containers), Qwen-VL family | 1–2 GPUs |
| Indian languages (Tamil/Hindi) | Evaluate Indic-focused models (e.g., Sarvam family) alongside the above | Varies |
| Embeddings / reranking | NVIDIA NeMo Retriever embedding & reranker NIMs, or open embedding models | Small GPU / even CPU |
| Speech | NVIDIA Riva / Parakeet-family ASR, Whisper-class models | Small GPU |
| Safety / PII guard | Nemotron Safety/Guard models, NeMo Guardrails | Small GPU |

### 10.3 Recommended setup for Gemini Solariss (hybrid)
1. **Phase 1 – Prototype:** use a cloud frontier model (Claude / GPT / Gemini) for `reasoning`, and NVIDIA's hosted API to benchmark open models on your golden test set.
2. **Phase 2 – Local box:** one on-prem NVIDIA workstation running **vLLM or NIM** with a Nemotron-Nano-class model for the `fast` tier + an embedding model + a VLM for bills. All raw PII stays local.
3. **Keep cloud for hard tasks:** orchestration, proposal writing, and negotiation coaching on a frontier cloud model, with PII redacted.
4. **Automatic failover:** if the local box is down, the AI gateway falls back to cloud.
5. **Re-evaluate quarterly:** open models improve fast; rerun the eval harness and shift more traffic local if quality holds.

### 10.4 Steps to stand up a local NVIDIA inference server
1. Install Ubuntu LTS, latest **NVIDIA driver**, CUDA, and **NVIDIA Container Toolkit**; confirm with `nvidia-smi` and a GPU test container.
2. Join the **NVIDIA Developer Program** (free access to downloadable NIMs for development/self-hosting on limited GPUs; production use may need an NVIDIA AI Enterprise licence — check current terms).
3. Pull a NIM container (or run vLLM / Ollama) for your chosen model; expose port 8000 internally.
4. Test: `curl http://gpu-box:8000/v1/models` and a chat completion with a tool-call.
5. Register the endpoint in the CRM admin → AI Providers → `nvidia_nim` / `openai_compatible`.
6. Run the eval harness; set routing tiers; set monitoring (GPU utilization, latency, tokens/sec).
7. Put it behind the internal network only (VPN/Tailscale), with TLS and an API key.

### 10.5 Rough decision rule
- < ~5,000 AI calls/day and small team → **cloud APIs** are usually cheaper and simpler.
- Strict data-privacy need, or high daily volume of simple tasks → **local NVIDIA box** pays off.
- Most practical: **hybrid** (above).

---

## 11. Security, Privacy & Compliance

- **DPDP Act 2023 (India)** and its Rules: explicit consent capture, purpose limitation, data-principal rights (access, correction, erasure), breach notification process, retention schedules.
- **Aadhaar handling:** store only masked Aadhaar (last 4 digits) unless legally required; never send unmasked Aadhaar to cloud LLMs.
- **PII redaction** before any cloud AI call; full data only to local models.
- **Encryption:** TLS everywhere; AES-256 at rest; field-level encryption for bank details & IDs.
- **Data residency:** host in Indian regions.
- **RBAC + row-level security** (tenant, branch, owner).
- **Audit logs** for all reads/writes of sensitive docs and all AI actions.
- **Prompt-injection defence:** treat inbound customer messages & documents as untrusted data; agents can't execute instructions found in them; tool permissions scoped per agent.
- **Marketing compliance:** TRAI DLT for SMS, WhatsApp opt-in, DND respect, unsubscribe handling.
- **Backups:** daily encrypted backups, tested restores, RPO ≤ 24h, RTO ≤ 4h.

---

## 12. Recommended Tech Stack

| Layer | Choice (alternatives) |
|-------|----------------------|
| Frontend (staff web) | Next.js + TypeScript + Tailwind + shadcn/ui |
| Mobile (field + customer) | React Native / Expo (offline-first with SQLite sync) or Flutter |
| Backend API | NestJS (TypeScript) or FastAPI (Python) |
| AI services | Python (FastAPI) — agents, gateway, eval harness; LiteLLM for provider abstraction; LangGraph or a lightweight custom agent loop |
| Workflow | Temporal (durable long-running flows) |
| Database | PostgreSQL 16+ with pgvector; Redis |
| Events | Redis Streams → NATS/Kafka at scale |
| Storage | S3 (India region) / MinIO |
| Search | Postgres full-text → OpenSearch if needed |
| Analytics | Metabase / Superset on read replica |
| Infra | Docker + Kubernetes (or Docker Compose for v1), Terraform, GitHub Actions CI/CD |
| Observability | Langfuse (LLM), Sentry, Prometheus + Grafana, OpenTelemetry |
| Local AI | vLLM / NVIDIA NIM / Ollama on NVIDIA GPU |

---

## 13. Repository Structure

```
gemini-solariss-crm/
├── apps/
│   ├── web/                 # Staff web app (Next.js)
│   ├── mobile/              # Field & customer app
│   └── portal/              # Customer self-service portal
├── services/
│   ├── api/                 # Core CRM API
│   ├── workflows/           # Temporal workflows (lifecycle, SLA timers)
│   ├── ai-gateway/          # Provider adapters, router, redaction, metering
│   ├── agents/              # Orchestrator + specialist agents, tools
│   ├── integrations/        # WhatsApp, SMS, payments, inverter APIs, lead sources
│   └── notifications/
├── packages/
│   ├── schemas/             # Shared types, JSON schemas, tool specs
│   ├── rules/               # Subsidy slabs, SLAs, discount caps (data, not code)
│   └── prompts/             # Versioned prompt templates
├── evals/                   # Golden datasets + model benchmark harness
├── infra/                   # Docker, k8s, Terraform
└── docs/
    ├── GEMINI_SOLARISS_AI_CRM_SPEC.md   # this file
    ├── SOPs/                # Fed into the RAG knowledge base
    └── runbooks/
```

---

## 14. Delivery Roadmap

| Phase | Duration (indicative) | Scope |
|-------|----------------------|-------|
| **0. Foundations** | 2–3 weeks | Auth, DB schema, RBAC, document vault, audit log, AI gateway skeleton (1 cloud + 1 local provider) |
| **1. MVP – Sell** | 6–8 weeks | Leads (web/Meta/IndiaMART/WhatsApp), qualification with bill OCR, survey mobile app, design/proposal PDF, follow-up agent, daily brief, payments |
| **2. Deliver** | 6–8 weeks | Booking, e-sign, PM Surya Ghar + DISCOM tracker, document compliance agent, procurement + ALMM check, installation scheduling, commissioning, subsidy tracker |
| **3. Retain** | 4–6 weeks | AMC contracts, inverter monitoring integrations, anomaly detection, service tickets, renewals, referrals, reviews |
| **4. Intelligence** | Ongoing | Analytics copilot, forecasting, voice (telephony), deeper multilingual, local NVIDIA model expansion, RPA status readers |

Each phase ends with: eval-harness run, UAT with real staff, and a rollback plan.

---

## 15. KPIs & Success Metrics

- First-response time to new leads (target < 5 min, AI-driven)
- Lead → survey, survey → booking, booking → commissioning conversion rates
- Median days per stage; % of cases breaching SLA
- Subsidy: % applications with zero rework; median days commissioning → credit
- AMC attach rate & renewal rate; average generation vs. expected
- AI: suggestion acceptance rate, auto-action error rate, cost per lead (₹), cost per closed deal (₹)
- Customer NPS / Google rating

---

## 16. Open Decisions

| # | Decision | Options |
|---|----------|---------|
| 1 | Single-company tool vs. future multi-tenant SaaS for other installers | Build multi-tenant-ready schema now (recommended) |
| 2 | Build vs. buy WhatsApp layer | Direct Cloud API vs. BSP |
| 3 | First local GPU purchase vs. rented GPU | Decide after Phase 1 cost data |
| 4 | Default cloud LLM for `reasoning` tier | Benchmark Claude / GPT / Gemini on your eval set |
| 5 | AMC pricing tiers & free-AMC period | Business decision |
| 6 | Portal RPA — allowed and worth it? | Review portal terms; start manual |
| 7 | Languages at launch | Tamil + English (+ Hindi?) |

---

*Prepared for Gemini Solariss. Verify all government scheme parameters, vendor terms, and model availability at implementation time — these change frequently.*
