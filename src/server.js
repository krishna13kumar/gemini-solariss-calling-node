/**
 * Gemini Solariss AI Voice Agent — Fastify server.
 * Serves the dashboard, lead/result management APIs, voice cloning, call-recording
 * transcription, and the real-time audio bridge (Exotel Voicebot + local mic test).
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { getRequiredEnv, getEnv, getBoolEnv } from './env.js';
import { LeadsStore } from './leadsStore.js';
import { CRMAuditorAgent } from './crmAuditor.js';
import { CallSession, RETRY_LINE, NOISY_RETRY_LINE } from './callSession.js';
import { Vad } from './vad.js';
import { FaqStore } from './faqStore.js';
import { trainingStore } from './trainingStore.js';
import { SettingsStore } from './settingsStore.js';
import { createAdminAuth, requiresAdmin } from './adminAuth.js';
import xlsx from 'xlsx';
import { transcribeCallRecording } from './transcription.js';
import { createLLMProvider, createTelephonyProvider, createVoiceProvider } from './providers/index.js';
import { getAudioEnergy, pcmToMuLaw, muLawToPcm, chunkPcm, pcmToWav } from './audioUtils.js';

getRequiredEnv('NODE_ENV');
// LLM keys are checked by the router at startup (the configured default must be usable); the other
// provider, if its key is present, becomes the live-switch / fallback option.
getRequiredEnv('SARVAM_API_KEY');
getRequiredEnv('SARVAM_STT_MODEL');
getRequiredEnv('SARVAM_TTS_MODEL');

const PORT = parseInt(getEnv('PORT', '8000'), 10);
const MAX_CONCURRENT_CALLS = parseInt(getEnv('MAX_CONCURRENT_CALLS', '10'), 10); // simultaneous call sockets (web visitors + phone)
const MAX_CALL_MINUTES = parseInt(getEnv('MAX_CALL_MINUTES', '15'), 10);        // a call is ended after this long
let openCalls = 0;
const EXOTEL_CALLS_ENABLED = getBoolEnv('ENABLE_EXOTEL_CALLS', false);
// Crisp by design: just who's calling and on whose behalf. The pitch/permission
// question is the LLM's first generated turn (see knowledgeBase.js step 1b),
// not baked into this fixed line.
// Real Tamil script, not Latin-letter "Tanglish" — Sarvam's Tamil TTS reads
// romanized text as mis-pronounced phonetic English, not natural Tamil. Brand
// name stays in Latin script, same as how it'd actually be said mid-sentence.
const GREETING_TEXT = "வணக்கம் சார்! நான் கவியா, Gemini Solariss சார்பா பேசுறேன்.";
const FIXED_LINES = [GREETING_TEXT, RETRY_LINE, NOISY_RETRY_LINE]; // audio pre-generated at startup, played with no TTS wait

process.on('uncaughtException', err => console.error('[Fatal]', err));
process.on('unhandledRejection', reason => console.error('[Unhandled Rejection]', reason));

const fastify = Fastify({ logger: true });

// --- Admin gate -------------------------------------------------------------------------------------
// The public site is only the entry page + the call socket. The dashboard and every API behind it need
// the ADMIN_PASSWORD session (src/adminAuth.js). One hook covers HTTP routes and websocket upgrades.
const adminAuth = createAdminAuth();
if (!adminAuth.isConfigured()) console.warn('[Admin] ADMIN_PASSWORD is not set in .env — the dashboard stays locked until it is.');
fastify.addHook('onRequest', async (request, reply) => {
  if (requiresAdmin(request.method, request.url) && !adminAuth.isAuthed(request)) {
    return reply.code(401).send({ error: 'Admin login required.' });
  }
});
await fastify.register(fastifyMultipart, { attachFieldsToBody: 'keyValues', limits: { fileSize: 500 * 1024 * 1024 } });
await fastify.register(fastifyWebsocket);
await fastify.register(fastifyStatic, { root: path.join(process.cwd(), 'public') });

// --- Admin pages: login form until signed in, then the dashboard (kept outside public/ so it is never served openly) ---
const adminDir = path.join(process.cwd(), 'admin');
const sendAdminFile = (reply, file, type) => reply.type(type).header('Cache-Control', 'no-store').send(fs.readFileSync(path.join(adminDir, file)));
const adminPage = async (request, reply) => sendAdminFile(reply, adminAuth.isAuthed(request) ? 'index.html' : 'login.html', 'text/html; charset=utf-8');
fastify.get('/admin', adminPage);
fastify.get('/admin/', adminPage);
fastify.get('/admin/app.js', async (request, reply) => sendAdminFile(reply, 'app.js', 'text/javascript; charset=utf-8'));
fastify.get('/admin/style.css', async (request, reply) => sendAdminFile(reply, 'style.css', 'text/css; charset=utf-8'));

fastify.post('/api/admin/login', async (request, reply) => {
  const result = adminAuth.login(request, request.body?.password);
  if (!result.ok) {
    if (result.retryAfter) reply.header('Retry-After', result.retryAfter);
    return reply.code(result.status).send({ error: result.error });
  }
  reply.header('Set-Cookie', result.cookie);
  return { ok: true };
});
fastify.post('/api/admin/logout', async (request, reply) => {
  reply.header('Set-Cookie', adminAuth.logout(request));
  return { ok: true };
});

const leadsStore = new LeadsStore('./data/leads_input.xlsx', './data/leads_completed.xlsx');
const telephonyGateway = createTelephonyProvider();
const dialogueEngine = createLLMProvider();
const voiceProvider = createVoiceProvider();
const crmAuditor = new CRMAuditorAgent(dialogueEngine); // CRM extraction uses whichever LLM is active
const settingsStore = new SettingsStore();
const GEMINI_SUGGESTIONS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

/** Applies saved dashboard settings on top of the .env defaults. Bad/stale values are skipped, not fatal. */
let endOfTurnFrames = parseInt(getEnv('VAD_SILENCE_FRAMES', '4'), 10); // quiet frames (~128ms each) that end a turn

function applySettings({ llm = {}, stt = {}, speech = {} } = {}) {
  try {
    if (Number.isInteger(speech.endOfTurnFrames)) endOfTurnFrames = speech.endOfTurnFrames;
    for (const [name, model] of Object.entries(llm.models || {})) if (model) dialogueEngine.setModel(name, model);
    if (typeof llm.fallback === 'boolean') dialogueEngine.fallback = llm.fallback;
    if (llm.provider) dialogueEngine.use(llm.provider);
    if (stt.engine) voiceProvider.configureStt(stt);
  } catch (err) {
    console.warn(`[Settings] Ignored a saved setting: ${err.message}`);
  }
}
applySettings(settingsStore.get());
const faqStore = new FaqStore();
faqStore.ensureEmbedded().then(n => { if (n) console.log(`[FaqStore] Indexed ${n} FAQ entr${n === 1 ? 'y' : 'ies'}.`); })
  .catch(err => console.warn('[FaqStore] Indexing failed — FAQ matching disabled until it succeeds:', err.message));

console.log('\n==================================================');
console.log(`[EngineInit] Dialogue model     : ${dialogueEngine.model}`);
console.log(`[EngineInit] LLMs available     : ${dialogueEngine.available().join(', ')}${dialogueEngine.fallback ? ' (automatic fallback on)' : ''}`);
console.log(`[EngineInit] Exotel calls       : ${EXOTEL_CALLS_ENABLED ? 'ENABLED (live)' : 'disabled (local test mode)'}`);
console.log(`[EngineInit] Exotel gateway     : ${telephonyGateway.getConfigStatus().isReady ? 'READY' : 'needs setup'}`);
console.log('==================================================\n');

const callTranscripts = new Map(); // leadId -> [{role, content}]
const liveMonitorClients = new Set();

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of liveMonitorClients) {
    if (client.readyState === 1) { try { client.send(payload); } catch {} }
  }
}

async function auditCompletedCall(leadId, { final = true } = {}) {
  const history = callTranscripts.get(leadId);
  if (!history || history.length <= 1) return;
  const transcript = history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join('\n');
  try {
    const audit = await crmAuditor.auditAndSaveLead(leadId, transcript, leadsStore.inputPath, leadsStore.outputPath);
    leadsStore.updateLeadStatus(leadId, {
      call_status: 'COMPLETED',
      call_disposition: audit.call_disposition,
      last_call_notes: `${audit.customer_name || ''} | ${audit.property_type || ''} | EB avg: ${audit.eb_bill_average || ''}`
    });
    broadcast({ event: 'call_ended', audit });
    console.log(`[Audit] Lead ${leadId} -> ${audit.call_disposition}`);
  } catch (err) {
    console.error('[Audit] Failed:', err.message);
  } finally {
    if (final) callTranscripts.delete(leadId); // chat keeps its history between interim saves
  }
}

// ---------------------------------------------------------------------------
// Leads: list / edit / upload
// ---------------------------------------------------------------------------

fastify.get('/api/leads', async () => ({ status: 'OK', leads: leadsStore.listLeads() }));

fastify.post('/api/leads', async (request, reply) => {
  try {
    const rows = request.body?.rows;
    if (!Array.isArray(rows)) return reply.status(400).send({ error: '"rows" must be an array.' });
    const count = leadsStore.saveLeads(rows);
    return { status: 'SAVED', count };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

fastify.post('/api/leads/upload', async (request, reply) => {
  try {
    const fileBuffer = request.body?.file;
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      return reply.status(400).send({ error: 'No file uploaded. Attach an .xlsx as "file".' });
    }
    const count = leadsStore.replaceLeadsFromUpload(fileBuffer);
    return { status: 'UPLOADED', count };
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Results: read-only view + download
// ---------------------------------------------------------------------------

fastify.get('/api/results', async () => ({ status: 'OK', results: leadsStore.listResults() }));

fastify.get('/api/results/download', async (request, reply) => {
  const rows = leadsStore.listResults();
  if (!rows.length) return reply.status(404).send({ error: 'No results yet.' });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Completed Leads');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return reply
    .header('Content-Disposition', 'attachment; filename="leads_completed.xlsx"')
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(buffer);
});

fastify.delete('/api/results', async (request, reply) => {
  const leadIds = request.body?.lead_ids;
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return reply.status(400).send({ error: '"lead_ids" must be a non-empty array.' });
  }
  const removed = leadsStore.deleteResults(leadIds);
  return { status: 'DELETED', removed };
});

// ---------------------------------------------------------------------------
// Telephony status + calling (gated by ENABLE_EXOTEL_CALLS)
// ---------------------------------------------------------------------------

fastify.get('/api/exotel-status', async () => telephonyGateway.getConfigStatus());

fastify.get('/api/exotel-balance', async () => telephonyGateway.getBalance());

fastify.get('/api/sarvam-status', async () => {
  return typeof voiceProvider.getHealthStatus === 'function'
    ? voiceProvider.getHealthStatus()
    : { ok: null, message: `No health tracking for VOICE_PROVIDER=${getEnv('VOICE_PROVIDER', 'sarvam')}` };
});

fastify.post('/api/custom-call', async (request, reply) => {
  if (!EXOTEL_CALLS_ENABLED) {
    return { status: 'LOCAL_TEST_MODE', message: 'ENABLE_EXOTEL_CALLS is not "true" — use the local mic test instead.' };
  }
  const { phone_number, customer_name } = request.body || {};
  if (!phone_number) return reply.status(400).send({ error: 'phone_number is required.' });
  const leadId = `CUSTOM_${Date.now()}`;
  const result = await telephonyGateway.triggerCall({ lead_id: leadId, phone_number, customer_name: customer_name || 'Lead' });
  return result;
});

fastify.post('/telephony/trigger-campaign', async (request, reply) => {
  if (!EXOTEL_CALLS_ENABLED) {
    return { status: 'LOCAL_TEST_MODE', message: 'ENABLE_EXOTEL_CALLS is not "true" — no real calls were placed.' };
  }
  try {
    const leads = leadsStore.loadValidatedLeads();
    const dispatchResults = [];
    for (const lead of leads) {
      dispatchResults.push(await telephonyGateway.triggerCall(lead));
      await new Promise(r => setTimeout(r, 2000));
    }
    return { status: 'CAMPAIGN_STARTED', totalLeads: leads.length, dispatchResults };
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});

fastify.post('/telephony/exotel/call-status', async (request, reply) => {
  const body = request.body || {};
  const leadId = body.CustomField || 'UNKNOWN';
  const status = (body.Status || body.CallStatus || 'UNKNOWN').toLowerCase();
  console.log(`[ExotelWebhook] ${leadId} -> ${status}`);
  if (status === 'completed' || status === 'terminal') await auditCompletedCall(leadId);
  return reply.type('text/plain').send('OK');
});

// ---------------------------------------------------------------------------
// Quick answers (FAQ)
// ---------------------------------------------------------------------------

// Teaching examples (curated in the chat) that shape both the chat and voice replies.
fastify.get('/api/training', async () => trainingStore.list());
fastify.post('/api/training', async (request, reply) => {
  try { return trainingStore.add(request.body?.customer, request.body?.reply); }
  catch (err) { return reply.code(400).send({ error: err.message }); }
});
fastify.delete('/api/training/:id', async (request) => { trainingStore.remove(request.params.id); return { ok: true }; });

// Live settings (AI model + speech-to-text engine), editable from the dashboard and saved to data/settings.json.
const llmStatus = () => ({
  active: dialogueEngine.active,
  model: dialogueEngine.model,
  available: dialogueEngine.available(),
  fallback: dialogueEngine.fallback
});
const settingsStatus = () => ({
  llm: { ...llmStatus(), models: dialogueEngine.models() },
  speech: { endOfTurnFrames, waitMs: (endOfTurnFrames + 1) * 128 },
  stt: { engine: voiceProvider.stt.engine, url: voiceProvider.stt.url, model: voiceProvider.stt.model, defaults: { url: getEnv('CACTUS_STT_URL', 'http://127.0.0.1:8080/v1/audio/transcriptions'), model: getEnv('CACTUS_STT_MODEL', 'openai/whisper-small') } }
});
fastify.get('/api/llm', async () => llmStatus());
fastify.post('/api/llm', async (request, reply) => { // header quick-switch
  try { dialogueEngine.use(String(request.body?.provider || '').toLowerCase()); }
  catch (err) { return reply.code(400).send({ error: err.message }); }
  settingsStore.update({ llm: { provider: dialogueEngine.active } });
  console.log(`[LLM] Switched to ${dialogueEngine.model}`);
  return llmStatus();
});

fastify.get('/api/settings', async () => settingsStatus());
fastify.post('/api/settings', async (request, reply) => {
  const { llm = {}, stt = {}, speech = {} } = request.body || {};
  const text = (v, max = 200) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : null);
  try {
    const patch = { llm: {}, stt: {}, speech: {} };
    if (speech.endOfTurnFrames !== undefined) {
      const n = Number(speech.endOfTurnFrames);
      if (!Number.isInteger(n) || n < 2 || n > 8) throw new Error('endOfTurnFrames must be a whole number from 2 to 8.');
      patch.speech.endOfTurnFrames = n;
    }
    if (llm.provider !== undefined) patch.llm.provider = String(llm.provider).toLowerCase();
    if (llm.fallback !== undefined) patch.llm.fallback = !!llm.fallback;
    for (const [name, model] of Object.entries(llm.models || {})) {
      if (!dialogueEngine.available().includes(name)) throw new Error(`"${name}" isn't configured (its API key is missing).`);
      const m = text(model, 120);
      if (!m || !/^[\w./:@-]+$/.test(m)) throw new Error(`Invalid model name for ${name}.`);
      (patch.llm.models ??= {})[name] = m;
    }
    if (stt.engine !== undefined) patch.stt.engine = String(stt.engine);
    for (const k of ['url', 'model']) if (stt[k] !== undefined) {
      const v = text(stt[k], 300);
      if (v === null) throw new Error(`Invalid STT ${k}.`);
      if (k === 'url' && v && !/^https?:\/\//.test(v)) throw new Error('STT URL must start with http:// or https://');
      patch.stt[k] = v;
    }
    if (patch.llm.provider && !dialogueEngine.available().includes(patch.llm.provider)) throw new Error(`"${patch.llm.provider}" isn't configured (its API key is missing).`);
    if (patch.stt.engine !== undefined && !['default', 'cactus'].includes(patch.stt.engine)) throw new Error(`Unknown STT engine "${patch.stt.engine}".`);
    // apply first: anything invalid throws here, before it can be written to disk
    applyStrict({ llm: patch.llm, stt: patch.stt });
    if (patch.speech.endOfTurnFrames !== undefined) endOfTurnFrames = patch.speech.endOfTurnFrames;
    settingsStore.update(patch);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
  return settingsStatus();
});

function applyStrict({ llm, stt }) {
  for (const [name, model] of Object.entries(llm.models || {})) dialogueEngine.setModel(name, model);
  if (typeof llm.fallback === 'boolean') dialogueEngine.fallback = llm.fallback;
  if (llm.provider) dialogueEngine.use(llm.provider);
  if (Object.keys(stt).length) voiceProvider.configureStt(stt);
}

// "Test" button: does this provider + model actually answer? (never touches the live settings)
fastify.post('/api/settings/test', async (request, reply) => {
  const { provider, model } = request.body || {};
  if (!dialogueEngine.available().includes(provider) || !/^[\w./:@-]+$/.test(String(model || ''))) {
    return reply.code(400).send({ error: 'Choose a configured provider and a valid model name.' });
  }
  return dialogueEngine.probe(provider, model);
});

// Model-name suggestions for the dashboard's inputs (cached 10 minutes; empty list if the lookup fails).
const modelListCache = new Map();
fastify.get('/api/models', async (request) => {
  const provider = String(request.query?.provider || '');
  const hit = modelListCache.get(provider);
  if (hit && Date.now() - hit.at < 600000) return hit.models;
  let models = [];
  try {
    if (provider === 'nvidia') {
      const r = await fetch('https://integrate.api.nvidia.com/v1/models', { signal: AbortSignal.timeout(8000) });
      models = (await r.json()).data.map(m => m.id).filter(id => !/embed|rerank|reward|safety|guard|parse|vl-|clip|nvclip/i.test(id)).sort();
    } else if (provider === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${getRequiredEnv('GEMINI_API_KEY')}`, { signal: AbortSignal.timeout(8000) });
      models = (await r.json()).models.filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, '')).sort();
    }
  } catch { /* keep []: the input still accepts any typed name */ }
  if (provider === 'gemini' && !models.length) models = GEMINI_SUGGESTIONS;
  modelListCache.set(provider, { at: Date.now(), models });
  return models;
});

fastify.get('/api/faq', async () => faqStore.describe(voiceProvider));

fastify.post('/api/faq', async (request, reply) => {
  try {
    const result = await faqStore.save(request.body || {});
    faqStore.warm(voiceProvider, FIXED_LINES).catch(err => console.warn('[FaqStore] warm failed:', err.message));
    return { status: 'SAVED', ...result };
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});

// Raw similarity scores for a sample utterance — the client compares against its
// threshold field, so the threshold can be tuned before saving.
fastify.post('/api/faq/test', async (request, reply) => {
  try {
    const results = await faqStore.search(request.body?.text);
    return { results: results.slice(0, 3).map(r => ({ question: r.entry.question, answer: r.entry.answer, score: r.score })) };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

fastify.post('/api/faq/regenerate-voice', async (request) => {
  faqStore.warm(voiceProvider, FIXED_LINES).catch(err => console.warn('[FaqStore] warm failed:', err.message));
  return { status: 'WARMING' };
});

// Parses an uploaded sheet into {question, answer} rows for the grid — nothing is
// saved until the user reviews them and hits Save.
fastify.post('/api/faq/parse', async (request, reply) => {
  const fileBuffer = request.body?.file;
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) return reply.status(400).send({ error: 'Attach an .xlsx/.csv as "file".' });
  try {
    // .xlsx is a zip ("PK"); anything else is treated as UTF-8 CSV — SheetJS would
    // otherwise decode BOM-less CSV as Latin-1 and garble Tamil text.
    const isZip = fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B;
    const wb = isZip ? xlsx.read(fileBuffer, { type: 'buffer' }) : xlsx.read(fileBuffer.toString('utf8'), { type: 'string' });
    const raw = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const pick = (row, word) => row[Object.keys(row).find(k => k.toLowerCase().includes(word))];
    const rows = raw.map(r => {
      const [c1, c2] = Object.values(r);
      return { question: String(pick(r, 'question') ?? c1 ?? '').trim(), answer: String(pick(r, 'answer') ?? c2 ?? '').trim() };
    }).filter(r => r.question && r.answer);
    return { rows };
  } catch (err) {
    return reply.status(400).send({ error: `Couldn't read that file: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Voice cloning
// ---------------------------------------------------------------------------

fastify.post('/api/clone-voice', async (request, reply) => {
  try {
    if (typeof voiceProvider.cloneVoiceFromSample !== 'function') {
      return reply.status(400).send({ error: `Voice cloning isn't supported by VOICE_PROVIDER=${getEnv('VOICE_PROVIDER', 'sarvam')}.` });
    }
    const body = request.body || {};
    const fileBuffer = body.file;
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      return reply.status(400).send({ error: 'No audio uploaded. Attach a 10-30s reference clip as "file".' });
    }
    const name = (body.name || `gemini_solariss_voice_${Date.now()}`).toString().trim();
    const filename = (body.filename || 'sample.wav').toString();
    const mimetype = (body.mimetype || '').toString();

    const voiceId = await voiceProvider.cloneVoiceFromSample(fileBuffer, filename, name, mimetype);
    voiceProvider.speaker = voiceId;

    const envPath = path.join(process.cwd(), '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const updatedEnv = /^VOICE_SPEAKER=.*$/m.test(envContent)
      ? envContent.replace(/^VOICE_SPEAKER=.*$/m, `VOICE_SPEAKER=${voiceId}`)
      : envContent + `\nVOICE_SPEAKER=${voiceId}\n`;
    fs.writeFileSync(envPath, updatedEnv);
    process.env.VOICE_SPEAKER = voiceId;

    return { status: 'VOICE_CLONED', voice_id: voiceId, message: 'Kavya is now using this cloned voice.' };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Call-recording transcription (upload -> diarized Telecaller/Lead transcript)
// ---------------------------------------------------------------------------

fastify.post('/api/transcribe', async (request, reply) => {
  try {
    const body = request.body || {};
    const fileBuffer = body.audio;
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      return reply.status(400).send({ error: 'No audio uploaded. Attach a recording as "audio".' });
    }
    const language = ['unknown', 'ta-IN', 'en-IN', 'hi-IN'].includes(body.language) ? body.language : 'unknown';
    const mode = ['transcribe', 'translate', 'codemix', 'translit'].includes(body.mode) ? body.mode : 'transcribe';
    const filename = (body.filename || 'recording.wav').toString();

    console.log(`[Transcribe] ${filename} (${fileBuffer.length} bytes, lang=${language}, mode=${mode})`);
    const result = await transcribeCallRecording(voiceProvider, fileBuffer, filename, language, mode);
    return result;
  } catch (err) {
    console.error('[Transcribe] Failed:', err);
    return reply.status(500).send({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Real-time audio bridge: Exotel Voicebot stream + local microphone test
// ---------------------------------------------------------------------------

fastify.register(async function (fastifyInstance) {
  fastifyInstance.get('/ws/live-feed', { websocket: true }, (connection) => {
    const socket = connection?.socket || connection;
    liveMonitorClients.add(socket);
    socket.on('close', () => liveMonitorClients.delete(socket));
  });

  // Text chat with the same brain as the voice agent (FAQ tiers + LLM + qualification script),
  // minus STT/TTS. Each browser tab is one conversation; it's audited into the results sheet on close.
  fastifyInstance.get('/ws/chat', { websocket: true }, (connection, req) => {
    const socket = connection?.socket || connection;
    const leadId = req.query?.lead_id || `CHAT_${Date.now()}`;
    const out = (data) => { if (socket.readyState === 1) socket.send(JSON.stringify(data)); };
    callTranscripts.set(leadId, []);
    // Record as the chat goes (after 15s of quiet) and when it ends — not only on close, which
    // never fires if the tab is just left open. Audit overwrites this lead's row each time.
    let saveTimer = null, savedAt = 0;
    const save = (final) => {
      clearTimeout(saveTimer);
      const n = callTranscripts.get(leadId)?.length ?? 0;
      if (n > 1 && n !== savedAt) { savedAt = n; auditCompletedCall(leadId, { final }); }
      else if (final) callTranscripts.delete(leadId);
    };
    const session = new CallSession({
      leadId,
      leadContext: leadsStore.getLeadContext(leadId),
      dialogueEngine,
      voiceProvider,
      sendAudio: async () => {},
      faqStore,
      textOnly: true,
      onTranscript: (role, text, latencyMs, meta) => {
        callTranscripts.get(leadId).push({ role: role === 'user' ? 'user' : 'assistant', content: text });
        out({ event: 'transcript', role: role === 'user' ? 'user' : 'bot', text, latency: latencyMs, faq: !!meta?.faq });
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => save(false), 15000);
      },
      onError: (message) => out({ event: 'error', message }),
      onEvent: (stage, data) => out({ event: 'pipeline', leadId, stage, t: Date.now(), ...data })
    });
    session.speak(GREETING_TEXT);
    socket.on('message', (data) => {
      try { session.handleUserText(JSON.parse(data.toString()).text); } catch {}
    });
    socket.on('close', () => save(true));
  });

  fastifyInstance.get('/ws/audio-stream', { websocket: true }, (connection, req) => {
    const socket = connection?.socket || connection;
    // A visitor must not be able to name an existing lead (the call's result row is keyed by this id), so only
    // ids of our own browser-session shape are accepted; anything else gets a fresh one. Exotel's lead id arrives
    // later in the 'start' event (below).
    const askedId = String(req.query?.lead_id || '');
    let leadId = /^(WEB|LOCAL_TEST)_[A-Za-z0-9_-]{1,40}$/.test(askedId) ? askedId : `WEB_${Date.now()}`;
    let streamSid = null;

    // Cost guard: calls bill Sarvam + the AI per minute, and this socket is reachable by anyone who can load the page.
    if (openCalls >= MAX_CONCURRENT_CALLS) {
      try { socket.send(JSON.stringify({ event: 'busy' })); } catch {}
      socket.close(1013, 'busy');
      return;
    }
    openCalls++;
    socket.on('close', () => { openCalls--; clearTimeout(callTimer); });
    const callTimer = setTimeout(() => { try { socket.send(JSON.stringify({ event: 'time_limit' })); } catch {} socket.close(1000, 'time limit'); }, MAX_CALL_MINUTES * 60 * 1000);
    const toBrowser = (msg) => { if (!streamSid && socket.readyState === 1) socket.send(JSON.stringify(msg)); }; // captions/status for web visitors only (not phone calls)
    let encoding = 'audio/x-l16';
    let greetingSent = false;

    // Each frame is ~128ms (1024 samples @ 8kHz). 4 silent frames (~512ms) end a turn:
    // 3 (~384ms) cut off short/hesitant answers mid-word, which Sarvam STT then
    // mis-transcribed as nonsense — the cause of fields coming back "Not Provided".
    const SPEECH_ENERGY_THRESHOLD = parseInt(getEnv('VAD_ENERGY_THRESHOLD', '450'), 10);
    const vad = new Vad({
      energyThreshold: SPEECH_ENERGY_THRESHOLD,
      minSpeechFrames: parseInt(getEnv('VAD_MIN_SPEECH_FRAMES', '3'), 10),
      silenceFramesForTurnEnd: endOfTurnFrames
    });

    if (!callTranscripts.has(leadId)) callTranscripts.set(leadId, []);
    const leadContext = leadsStore.getLeadContext(leadId);

    // We send audio ~1.25x faster than real time, so the browser is still playing the
    // tail of a reply after sendAudio() returns. Listening then makes the speakers bleed
    // into the mic as fake "speech" (empty STT, false "background noise"). Track when
    // playback really ends and keep the VAD deaf until a short echo tail after it.
    // Phone lines are 8kHz. The local browser asks for higher (?rate=24000): Sarvam's first-audio time is
    // the same at every rate, and 8kHz narrowband is what makes synthesized speech sound thin/muffled.
    const requestedRate = Number(req.query?.rate);
    const SAMPLE_RATE = [8000, 16000, 22050, 24000].includes(requestedRate) ? requestedRate : 8000;
    const BYTES_PER_MS = SAMPLE_RATE / 500; // 16-bit mono
    // While Kavya's audio is playing the mic is ignored (her own voice would be "heard" as the customer).
    // The estimate below is only a fallback: the page tells us the moment its playback queue really drains
    // ('playback_idle'), so the customer's answer, which usually starts right as the question ends, isn't
    // clipped by a guessed safety margin. Short answers like "ஆமா" are ~3 frames and used to vanish in it.
    let playbackEndsAt = 0;
    let bytesSent = 0;
    let listenSince = 0, listenMax = 0, lastMicWarn = 0; // how long we've been listening and the loudest frame in that time
    const ECHO_TAIL_MS = 150; // speaker/room decay after the audio itself has stopped
    const isPlayingBack = () => Date.now() < playbackEndsAt + ECHO_TAIL_MS;

    async function sendAudio(pcm8k) { // PCM at SAMPLE_RATE (8kHz on phone lines)
      if (!pcm8k || pcm8k.length === 0 || socket.readyState !== 1) return;
      playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + (pcm8k.length / BYTES_PER_MS);
      if (!streamSid) bytesSent += pcm8k.length;
      try {
        if (streamSid) {
          const isMuLaw = encoding.toLowerCase().includes('mulaw');
          const payloadBuffer = isMuLaw ? pcmToMuLaw(pcm8k) : pcm8k;
          const chunkSize = isMuLaw ? 800 : 1600;
          for (const chunk of chunkPcm(payloadBuffer, chunkSize)) {
            if (socket.readyState !== 1) break;
            socket.send(JSON.stringify({ event: 'media', stream_sid: streamSid, streamSid, media: { payload: chunk.toString('base64') } }));
            await new Promise(r => setTimeout(r, 90));
          }
        } else {
          // Browser path: no pacing. The page schedules every chunk on its own audio clock, so sending ahead
          // is gapless between sentences (the next sentence's synthesis starts at once instead of after the
          // previous one has been trickled out), and playbackEndsAt above still tells us when it really ends.
          for (const chunk of chunkPcm(pcm8k, BYTES_PER_MS * 100)) {
            if (socket.readyState !== 1) break;
            socket.send(chunk);
          }
        }
      } catch (err) {
        console.error('[AudioBridge] sendAudio failed mid-stream:', err.message);
      }
    }

    const session = new CallSession({
      leadId,
      leadContext,
      dialogueEngine,
      voiceProvider,
      sendAudio,
      faqStore,
      sampleRate: SAMPLE_RATE,
      onTranscript: (role, text, latencyMs, meta) => {
        const history = callTranscripts.get(leadId) || [];
        if (role === 'user') history.push({ role: 'user', content: text });
        else history.push({ role: 'assistant', content: text });
        callTranscripts.set(leadId, history);
        broadcast({ event: 'transcript', leadId, role: role === 'user' ? 'user' : 'bot', text, latency: latencyMs, faq: !!meta?.faq });
        toBrowser({ event: 'caption', role: role === 'user' ? 'user' : 'bot', text });
      },
      onError: (message) => broadcast({ event: 'error', message }),
      onEvent: (stage, data) => {
        broadcast({ event: 'pipeline', leadId, stage, t: Date.now(), ...data });
        if (['stt', 'llm', 'tts', 'idle', 'echo', 'retry'].includes(stage)) toBrowser({ event: 'state', stage });
      }
    });

    session.getTtsSocket(); // open the streaming TTS socket now so the first reply doesn't pay the connect time

    async function playGreeting() {
      if (greetingSent) return;
      greetingSent = true;
      broadcast({ event: 'call_connected', leadId });
      try {
        await session.speak(GREETING_TEXT);
      } catch (err) {
        console.error(`[AudioBridge] Greeting synthesis failed for ${leadId}:`, err.message);
        broadcast({ event: 'error', message: `Couldn't speak the greeting: ${err.message}` });
        greetingSent = false; // allow a retry (e.g. via "trigger_greeting") once the underlying issue clears
      }
    }

    socket.on('message', async (data, isBinary) => {
      // --- Exotel/dashboard JSON protocol ---
      // isBinary (from the underlying `ws` library) is authoritative — sniffing the
      // first byte for '{' is a coin-flip on raw audio data that happens to start
      // with 0x7B, which silently drops that audio frame as a JSON parse error.
      const text = !isBinary ? (typeof data === 'string' ? data : data.toString('utf8')) : null;

      if (text) {
        try {
          const msg = JSON.parse(text);
          const event = msg.event || msg.Event;

          if (event === 'start') {
            streamSid = msg.stream_sid || msg.streamSid || msg.start?.stream_sid || msg.start?.streamSid;
            const customField = msg.start?.custom_field || msg.start?.customField;
            // Only trust a lead id from the 'start' event when real telephony is on; otherwise any visitor could send one.
            if (customField && EXOTEL_CALLS_ENABLED) { leadId = customField; session.leadId = leadId; }
            encoding = msg.start?.mediaFormat?.encoding || msg.start?.media_format?.encoding || 'audio/x-l16';
            await playGreeting();
            return;
          }
          if (event === 'media') {
            if (!streamSid) streamSid = msg.stream_sid || msg.streamSid;
            if (!greetingSent) { await playGreeting(); return; }
            const payload = msg.media?.payload;
            if (!payload) return;
            const rawChunk = Buffer.from(payload, 'base64');
            const pcmChunk = encoding.toLowerCase().includes('mulaw') ? muLawToPcm(rawChunk) : rawChunk;

            if (session.isProcessing) {
              if (getAudioEnergy(pcmChunk) > SPEECH_ENERGY_THRESHOLD * 1.8) {
                session.interrupt();
                if (streamSid) socket.send(JSON.stringify({ event: 'clear', stream_sid: streamSid, streamSid }));
              }
              return;
            }
            handleVadFrame(pcmChunk);
            return;
          }
          if (event === 'playback_idle') {
            // Honoured only if the page has received everything we sent (a newer reply may be in flight).
            if (msg.bytes >= bytesSent) playbackEndsAt = Math.min(playbackEndsAt, Date.now());
            return;
          }
          if (event === 'stop') { await auditCompletedCall(leadId); return; }
          if (event === 'trigger_greeting') { greetingSent = false; await playGreeting(); return; }
        } catch (e) {
          console.error('[AudioBridge] Error handling message:', e.message);
        }
        return;
      }

      // --- Raw binary (browser mic / local test) ---
      // Gated on session.isProcessing (spans the WHOLE turn: STT -> LLM -> every
      // sentence spoken), not a per-chunk "is audio currently sending" flag — that
      // flag had gaps between sentences in a multi-sentence reply where it briefly
      // went false, letting stray frames leak into the VAD buffer and corrupt the
      // next real utterance's transcript (symptom: replies that don't track what was
      // actually said, i.e. "conversation not building up").
      if (isBinary) {
        if (session.isProcessing || Date.now() < playbackEndsAt) { vad.reset(); listenSince = 0; } // not listening: drop stale half-turns
        else if (isPlayingBack()) { vad.hold(data); listenSince = 0; } // speaker-decay tail: keep as pre-roll only
        else {
          handleVadFrame(data);
          // Nothing resembling speech for a while: say what the mic is actually delivering instead of staying silent.
          const now = Date.now();
          if (!listenSince) { listenSince = now; listenMax = 0; }
          listenMax = Math.max(listenMax, getAudioEnergy(data));
          if (now - listenSince > 8000 && now - lastMicWarn > 8000 && !vad.speechFrames) {
            lastMicWarn = now;
            broadcast({ event: 'pipeline', leadId, stage: 'mic', t: now, level: Math.round(listenMax), threshold: Math.round(vad.threshold) });
          }
        }
      }
    });

    // Local mic tests only: keep the last 20 captured turns as WAV files (data/debug_turns/), named with the
    // measured levels, so "it didn't understand me" can be diagnosed from the real audio. Off: DEBUG_SAVE_TURNS=false.
    function saveDebugTurn(turn) {
      if (streamSid || !getBoolEnv('DEBUG_SAVE_TURNS', true)) return;
      try {
        const dir = path.join(process.cwd(), 'data', 'debug_turns');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${Date.now()}_${turn.frames}f_floor${Math.round(turn.noiseFloor)}_speech${Math.round(turn.meanSpeech)}.wav`), pcmToWav(turn.buffer, 8000));
        for (const old of fs.readdirSync(dir).sort().slice(0, -20)) fs.rmSync(path.join(dir, old), { force: true });
      } catch { /* diagnostics must never break a call */ }
    }

    function handleVadFrame(pcmChunk) {
      vad.silenceFramesForTurnEnd = endOfTurnFrames; // live setting
      const turn = vad.push(pcmChunk);
      // Quiet for the first part of the end-of-turn window: start transcribing now, in parallel (see prefetchStt).
      if (!turn && vad.silenceFrames === Math.max(1, vad.silenceFramesForTurnEnd - 2) && vad.speechFrames >= vad.minSpeechFrames) session.prefetchStt(vad.buffer);
      if (!turn) return;
      console.log(`[AudioBridge] VAD turn end: ${turn.buffer.length} bytes, ${turn.frames} voiced frames, noisy=${turn.noisy} (noise floor ${Math.round(turn.noiseFloor)}, speech ${Math.round(turn.meanSpeech)}, threshold ${Math.round(turn.threshold)})`);
      broadcast({ event: 'pipeline', leadId, stage: 'vad', t: Date.now(), frames: turn.frames, noisy: turn.noisy, noiseFloor: Math.round(turn.noiseFloor), speech: Math.round(turn.meanSpeech), threshold: Math.round(turn.threshold) });
      listenSince = 0;
      saveDebugTurn(turn);
      session.handleUserUtterance(turn.buffer, { noisy: turn.noisy });
    }

    socket.on('close', () => {
      session.close();
      if ((callTranscripts.get(leadId) || []).length > 1) auditCompletedCall(leadId);
    });
  });
});

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\nGemini Solariss Voice Agent listening on http://localhost:${PORT}`);
  faqStore.warm(voiceProvider, FIXED_LINES).catch(err => console.warn('[FaqStore] warm failed:', err.message));
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
