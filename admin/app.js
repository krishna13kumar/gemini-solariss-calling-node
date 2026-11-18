// If the admin session has expired (or the server restarted) any dashboard call comes back 401: reload to the login form.
const _fetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _fetch(...args);
  if (res.status === 401) location.reload();
  return res;
};

const $ = id => document.getElementById(id);

function setStatus(el, message, kind) {
  el.hidden = false;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = message;
}

// ---------------------------------------------------------------------------
// Mode / Exotel status
// ---------------------------------------------------------------------------
async function refreshStatus() {
  try {
    const res = await fetch('/api/exotel-status');
    const data = await res.json();
    const exotelBadge = $('exotelBadge');
    exotelBadge.textContent = data.isReady ? `Exotel Ready (${data.callerId})` : `Exotel: ${data.missing.join(', ')}`;
    exotelBadge.style.background = data.isReady ? '#238636' : '#d29922';
  } catch {}
}
// Mode badge is static per page load based on a one-time probe to /api/custom-call semantics;
// simplest reliable signal is the exotel-status call above plus a convention: we just label it.
fetch('/api/exotel-status').then(r => r.json()).then(data => {
  const modeBadge = $('modeBadge');
  modeBadge.textContent = data.isReady ? '☎️ Exotel configured' : '🧪 Local test mode';
  modeBadge.style.background = data.isReady ? '#da3633' : '#1f6feb';
}).catch(() => {});
refreshStatus();
setInterval(refreshStatus, 8000);

// Real billed-account call (Exotel's Account Balance API) — polled slower than
// the lightweight config-status check above so we're not hammering it.
async function refreshExotelBalance() {
  const badge = $('exotelBalanceBadge');
  try {
    const res = await fetch('/api/exotel-balance');
    const data = await res.json();
    if (data.ok) {
      const bal = Number(data.balance);
      badge.textContent = `Exotel balance: ₹${bal.toFixed(2)}`;
      badge.style.background = bal < 0 ? '#da3633' : (bal < 100 ? '#d29922' : '#238636');
    } else {
      badge.textContent = `Exotel balance: ${data.error || 'unavailable'}`;
      badge.style.background = '#6e7681';
    }
  } catch {
    badge.textContent = 'Exotel balance: unavailable';
    badge.style.background = '#6e7681';
  }
}
refreshExotelBalance();
setInterval(refreshExotelBalance, 60000);

// Sarvam has no balance API (confirmed against their docs) — this reflects the
// outcome of the last real STT/TTS call, which is the best honest signal we can
// show without faking a number. See the badge's tooltip for the full caveat.
async function refreshSarvamStatus() {
  const badge = $('sarvamBadge');
  try {
    const res = await fetch('/api/sarvam-status');
    const data = await res.json();
    if (data.ok === true) {
      badge.textContent = '✅ Sarvam: OK';
      badge.style.background = '#238636';
    } else if (data.ok === false) {
      badge.textContent = `⚠️ Sarvam: ${data.message}`.slice(0, 60);
      badge.style.background = '#da3633';
    } else {
      badge.textContent = 'Sarvam: no calls yet';
      badge.style.background = '#6e7681';
    }
  } catch {
    badge.textContent = 'Sarvam: unavailable';
    badge.style.background = '#6e7681';
  }
}
refreshSarvamStatus();
setInterval(refreshSarvamStatus, 8000);

// ---------------------------------------------------------------------------
// Leads grid (editable)
// ---------------------------------------------------------------------------
const LEAD_COLUMNS = [
  { title: 'Lead ID', field: 'lead_id', editor: 'input', width: 130 },
  { title: 'Name', field: 'customer_name', editor: 'input', width: 160 },
  { title: 'Phone', field: 'phone_number', editor: 'input', width: 140 },
  { title: 'City/District', field: 'city_district', editor: 'input', width: 130 },
  { title: 'Avg EB Bill', field: 'avg_bimonthly_eb_bill', editor: 'number', width: 110 },
  { title: 'Roof Type', field: 'roof_type', editor: 'input', width: 170 },
  { title: 'Status', field: 'call_status', editor: 'input', width: 110 },
  { title: 'Disposition', field: 'call_disposition', editor: 'input', width: 140 },
  { title: 'Notes', field: 'last_call_notes', editor: 'input', width: 220 }
];

const leadsTable = new Tabulator('#leadsGrid', {
  layout: 'fitDataStretch',
  height: 360,
  placeholder: 'No leads yet — upload an Excel file or add a row.',
  columns: LEAD_COLUMNS
});

async function loadLeads() {
  const res = await fetch('/api/leads');
  const data = await res.json();
  leadsTable.setData(data.leads || []);
  $('leadCount').textContent = `(${(data.leads || []).length})`;
}
loadLeads();

$('addLeadRowBtn').onclick = () => {
  leadsTable.addRow({ lead_id: 'LEAD_' + Date.now(), customer_name: '', phone_number: '', city_district: '', avg_bimonthly_eb_bill: '', roof_type: '' });
};

$('saveLeadsBtn').onclick = async () => {
  const rows = leadsTable.getData();
  try {
    const res = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    const data = await res.json();
    if (res.ok) setStatus($('leadsStatus'), `✅ Saved ${data.count} lead(s).`, 'ok');
    else setStatus($('leadsStatus'), `❌ ${data.error}`, 'err');
    $('leadCount').textContent = `(${rows.length})`;
  } catch (err) {
    setStatus($('leadsStatus'), `❌ ${err.message}`, 'err');
  }
};

$('leadsUploadInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file, file.name);
  setStatus($('leadsStatus'), '⏳ Uploading…');
  try {
    const res = await fetch('/api/leads/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (res.ok) {
      setStatus($('leadsStatus'), `✅ Uploaded ${data.count} lead(s).`, 'ok');
      await loadLeads();
    } else {
      setStatus($('leadsStatus'), `❌ ${data.error}`, 'err');
    }
  } catch (err) {
    setStatus($('leadsStatus'), `❌ ${err.message}`, 'err');
  }
  e.target.value = '';
};

$('runCampaignBtn').onclick = async () => {
  const count = leadsTable.getData().length;
  if (!confirm(`Dial all ${count} lead(s) now? This places real outbound calls if Exotel is enabled.`)) return;
  const btn = $('runCampaignBtn');
  btn.disabled = true;
  setStatus($('leadsStatus'), '⏳ Triggering campaign…');
  try {
    const res = await fetch('/telephony/trigger-campaign', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'LOCAL_TEST_MODE') {
      setStatus($('leadsStatus'), `🧪 ${data.message}`, 'ok');
    } else if (data.status === 'CAMPAIGN_STARTED') {
      const lines = (data.dispatchResults || []).map(r => `${r.status === 'INITIATED' ? '🟢' : '🔴'} ${r.lead_id} — ${r.status}`).join('<br>');
      setStatus($('leadsStatus'), `✅ Dispatched ${data.totalLeads} lead(s):<br>${lines}`, 'ok');
    } else {
      setStatus($('leadsStatus'), `❌ ${data.error || JSON.stringify(data)}`, 'err');
    }
  } catch (err) {
    setStatus($('leadsStatus'), `❌ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Custom call
// ---------------------------------------------------------------------------
$('customCallBtn').onclick = async () => {
  const phone_number = $('customPhone').value.trim();
  const customer_name = $('customName').value.trim();
  if (!phone_number) { alert('Enter a phone number.'); return; }
  setStatus($('customCallStatus'), '⏳ Dialing…');
  try {
    const res = await fetch('/api/custom-call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number, customer_name }) });
    const data = await res.json();
    if (data.status === 'INITIATED') setStatus($('customCallStatus'), `🟢 Call initiated. SID: ${data.callSid}`, 'ok');
    else if (data.status === 'LOCAL_TEST_MODE') setStatus($('customCallStatus'), `🧪 ${data.message}`, 'ok');
    else setStatus($('customCallStatus'), `❌ ${data.error || JSON.stringify(data.error || data)}`, 'err');
  } catch (err) {
    setStatus($('customCallStatus'), `❌ ${err.message}`, 'err');
  }
};

// ---------------------------------------------------------------------------
// Local microphone test (no Exotel) — mirrors the real-time call pipeline
// ---------------------------------------------------------------------------
// Mic capture runs at 8kHz (what the VAD/STT expect); playback is a separate full-rate context, because a
// context can't output more bandwidth than its own sample rate — 8kHz playback made the voice thin and muffled.
const PLAY_RATE = 24000;
let ws = null, liveFeedWs = null, audioContext = null, playContext = null, micStream = null, nextPlayTime = 0;
let rxBytes = 0, idleTimer = null;
let localLeadId = 'LOCAL_TEST_' + Date.now(); // new one per connection — see micConnectBtn

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let lastChatUser = null;
async function teach(customer, reply, fb) {
  const res = await fetch('/api/training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer, reply }) });
  if (res.ok) { fb.textContent = '✅ Saved as a training example'; loadTraining(); }
  else fb.textContent = '⚠️ ' + ((await res.json()).error || 'could not save');
}
async function loadTraining() {
  const list = await (await fetch('/api/training')).json();
  $('trainList').innerHTML = list.length
    ? `<b>${list.length} training example${list.length > 1 ? 's' : ''}</b> (newest 15 are used)` + list.map(e => `<div class="ln">Customer: ${esc(e.customer)}<br>Kavya: ${esc(e.reply)} <button class="btn secondary" data-id="${e.id}">🗑</button></div>`).join('')
    : '<span class="muted">No training examples yet.</span>';
  $('trainList').querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => { await fetch('/api/training/' + b.dataset.id, { method: 'DELETE' }); loadTraining(); });
}
function appendChat(role, text, latency, faq, boxId = 'transcriptBox') {
  const box = $(boxId);
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-bot');
  const who = role === 'user' ? 'You' : (faq ? 'Kavya ⚡ quick answer' : 'Kavya');
  div.innerHTML = `<div class="who">${who}</div>${esc(text)}${latency ? ` <span class="muted">(${latency}ms)</span>` : ''}`;
  if (boxId === 'chatBox') {
    if (role === 'user') lastChatUser = text;
    else if (lastChatUser && !text.startsWith('⚠️')) {
      const customer = lastChatUser;
      const fb = document.createElement('div');
      fb.className = 'fb';
      fb.innerHTML = '<button class="btn secondary">👍 Teach</button> <button class="btn secondary">✏️ Fix</button>';
      const [good, fix] = fb.querySelectorAll('button');
      good.onclick = () => teach(customer, text, fb);
      fix.onclick = () => { const r = prompt('What should Kavya have replied?', text); if (r && r.trim()) teach(customer, r, fb); };
      div.appendChild(fb);
    }
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// Live pipeline trace: the server pushes one small event per step (fire-and-forget on the live-feed
// socket, off the audio path, so it adds no latency to the call).
const STAGES = { listening: '👂 Listening…', stt: '📝 Transcribing…', llm: '🧠 AI thinking…', tts: '🔊 Speaking…', faq: '⚡ Matching quick answers…', idle: '👂 Listening…' };
function setStage(key) { if (traceBoxId === 'pipelineBox') $('stagePill').textContent = STAGES[key] || key; }
let traceT0 = 0;
let traceBoxId = 'pipelineBox';
function trace(cls, tag, text, ctx) {
  const box = $(traceBoxId);
  const t = ((Date.now() - traceT0) / 1000).toFixed(1);
  const div = document.createElement('div');
  div.className = 'ln ' + cls;
  div.innerHTML = `<small>+${t}s</small><span class="tag">${tag}</span>${esc(text)}` + (ctx ? `<div class="ctx">${ctx}</div>` : '');
  box.appendChild(div);
  while (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function handlePipeline(d) {
  const ms = v => (v == null ? '' : ` ${v}ms`);
  switch (d.stage) {
    case 'vad':
      trace(d.noisy ? 't-warn' : 't-hear', 'HEARD', `speech turn: ${d.frames} voiced frames · loudness ${d.speech} vs room ${d.noiseFloor} (trigger ${d.threshold})${d.noisy ? ' · ⚠ barely above background noise' : ''}`);
      setStage('stt'); break;
    case 'stt':
      if (d.status === 'start') { trace('t-stt', 'STT →', `${(d.bytes / 16000).toFixed(1)}s of audio to Sarvam${d.speculative ? ' (already transcribing since you paused)' : ''}`); setStage('stt'); }
      else trace(d.text ? 't-stt' : 't-warn', 'STT ←', d.text ? `"${d.text}"${ms(d.ms)}${d.speculative ? ' still waiting (head start)' : ''}` : `nothing understood${ms(d.ms)}`);
      break;
    case 'faq':
      trace('t-faq', 'QUICK-Q&A', d.topQuestion ? `closest: "${d.topQuestion}" score ${d.score.toFixed(2)} / need ${d.threshold} → ${d.hit ? 'HIT, answering from saved audio' : 'miss, using AI'}${ms(d.ms)}` : 'no entries indexed' + ms(d.ms));
      break;
    case 'llm':
      if (d.status === 'start') {
        const ctx = d.context.map(m => `<b>${m.role === 'user' ? 'You' : 'Kavya'}:</b> ${esc(m.text)}`).join('<br>');
        trace('t-llm', 'AI →', `sent: system prompt + ${d.knowledgeEntries} Q&A entries (${d.mode}) + last ${d.context.length} messages; newest: "${d.userText}"`, ctx);
        setStage('llm');
      } else if (d.status === 'first_token') trace('t-llm', 'AI ←', `first words after${ms(d.ms)}`);
      else if (d.status === 'sentence') { trace('t-llm', 'AI ←', `"${d.text}"`); setStage('tts'); }
      else if (d.status === 'done') trace('t-llm', 'AI ✓', `reply complete (${d.chars} chars)${ms(d.ms)}`);
      break;
    case 'tts':
      trace('t-tts', 'VOICE', d.status === 'cached_audio' ? `playing saved audio${ms(d.ms)}` : `first audio out${ms(d.ms)} after you stopped talking`);
      setStage('tts'); break;
    case 'mic':
      trace('t-warn', 'MIC', d.level < d.threshold * 0.5
        ? `I can't hear anything: the loudest the mic got in the last few seconds was ${d.level} (speech needs more than ${d.threshold}). Check the browser's microphone choice / mute and that this tab has mic permission.`
        : `Very quiet: loudest ${d.level} vs the ${d.threshold} needed to count as speech. Speak a little louder or closer to the microphone.`);
      break;
    case 'echo': trace('t-warn', 'ECHO', `ignored — that was Kavya's own voice coming back through the speakers: "${d.text}" (use headphones or lower the volume)`); break;
    case 'retry': trace('t-warn', 'RETRY', d.noisy ? 'asking customer to repeat (noise)' : 'asking customer to repeat'); break;
    case 'idle': setStage('idle'); break;
  }
}

function playPcm16Chunk(arrayBuffer) {
  if (!playContext || arrayBuffer.byteLength < 2) return;
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  const buffer = playContext.createBuffer(1, float32.length, PLAY_RATE);
  buffer.copyToChannel(float32, 0);
  const source = playContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playContext.destination);
  const startAt = Math.max(playContext.currentTime, nextPlayTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;

  // Tell the server the moment our queue really drains, so it can start listening right then.
  rxBytes += arrayBuffer.byteLength;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'playback_idle', bytes: rxBytes }));
  }, Math.max(0, (nextPlayTime - playContext.currentTime) * 1000) + 30);
}

function connectLiveFeed() {
  if (liveFeedWs && liveFeedWs.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  liveFeedWs = new WebSocket(protocol + '//' + location.host + '/ws/live-feed');
  liveFeedWs.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.event === 'call_ended') refreshResults();
      if (data.event === 'error') appendChat('bot', `⚠️ ${data.message}`);
      if (data.event === 'pipeline' && data.leadId === localLeadId) handlePipeline(data);
      if (data.event === 'call_connected' && data.leadId === localLeadId) { traceT0 = Date.now(); $('pipelineBox').innerHTML = ''; setStage('tts'); }
      if (data.event === 'transcript' && data.leadId === localLeadId) appendChat(data.role, data.text, data.latency, data.faq);
    } catch {}
  };
  liveFeedWs.onclose = () => setTimeout(connectLiveFeed, 3000);
}

$('micConnectBtn').onclick = async () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: 'trigger_greeting' }));
    return;
  }
  connectLiveFeed();
  try {
    // Ask for the browser's echo cancellation / noise suppression explicitly rather than trusting defaults:
    // the speakers are right next to the mic in a local test.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    localLeadId = 'LOCAL_TEST_' + Date.now();
    // A new AudioContext's clock restarts at 0. Leaving nextPlayTime at the old
    // context's value scheduled every later greeting/reply tens of seconds into
    // the future — silent until a page refresh.
    nextPlayTime = 0;
    rxBytes = 0;
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
    playContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PLAY_RATE });
    const source = audioContext.createMediaStreamSource(micStream);
    const processor = audioContext.createScriptProcessor(1024, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inputData.length);
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        sum += s * s;
      }
      const rms = Math.round(Math.sqrt(sum / inputData.length) * 1000);
      $('meterFill').style.width = Math.min(100, rms / 4) + '%';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm16.buffer);
    };

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/ws/audio-stream?rate=' + PLAY_RATE + '&lead_id=' + localLeadId);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      $('micConnectBtn').textContent = '🗣️ Mic Live — click to replay greeting';
      ws.send(JSON.stringify({ event: 'trigger_greeting' }));
    };
    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) playPcm16Chunk(evt.data);
    };
  } catch (err) {
    alert('Microphone access failed: ' + err.message);
  }
};

$('micEndBtn').onclick = () => {
  if (ws) { ws.close(); ws = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  for (const c of [audioContext, playContext]) c?.close().catch(() => {}); // browsers cap live contexts
  audioContext = playContext = null;
  $('meterFill').style.width = '0%';
  $('stagePill').textContent = 'Not connected';
  $('micConnectBtn').textContent = '🎙️ Connect Mic & Speak Greeting';
  setTimeout(refreshResults, 1500);
};

// ---------------------------------------------------------------------------
// Results grid (read-only) + download
// ---------------------------------------------------------------------------
const resultsTable = new Tabulator('#resultsGrid', {
  layout: 'fitDataStretch',
  height: 360,
  placeholder: 'No completed calls yet.',
  columns: [
    { title: 'Lead ID', field: 'lead_id', width: 120 },
    { title: 'Name', field: 'Customer_Name', width: 150 },
    { title: 'Property', field: 'Property_Type', width: 100 },
    { title: 'Roof', field: 'Roof_Ownership', width: 90 },
    { title: 'EB Avg', field: 'EB_Bill_Average', width: 100 },
    { title: 'Address', field: 'Address', width: 220 },
    { title: 'Disposition', field: 'Call_Disposition', width: 150 },
    { title: 'Unanswered Qs', field: 'Unanswered_Questions', width: 220 },
    { title: 'Audited At', field: 'Audited_At', width: 180 },
    {
      title: '', width: 50, headerSort: false, hozAlign: 'center',
      formatter: () => '🗑️',
      cellClick: async (e, cell) => {
        const leadId = cell.getRow().getData().lead_id;
        if (!confirm(`Delete row ${leadId}? This removes it from leads_completed.xlsx permanently.`)) return;
        const res = await fetch('/api/results', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_ids: [leadId] })
        });
        const data = await res.json();
        if (res.ok) cell.getRow().delete();
        else alert('Delete failed: ' + (data.error || JSON.stringify(data)));
      }
    }
  ]
});

async function refreshResults() {
  const res = await fetch('/api/results');
  const data = await res.json();
  resultsTable.setData(data.results || []);
}
$('refreshResultsBtn').onclick = refreshResults;
refreshResults();

// ---------------------------------------------------------------------------
// Quick answers (FAQ)
// ---------------------------------------------------------------------------
const newFaqId = () => 'new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
const tick = ok => (ok === undefined ? '—' : ok ? '✓' : '…');

const faqTable = new Tabulator('#faqGrid', {
  layout: 'fitColumns',
  height: 340,
  index: 'id',
  placeholder: 'No quick answers yet — add a row or import an Excel file.',
  columns: [
    { title: 'Question (how a customer might ask)', field: 'question', editor: 'textarea', formatter: 'textarea', widthGrow: 2 },
    { title: 'Answer (what Kavya says)', field: 'answer', editor: 'textarea', formatter: 'textarea', widthGrow: 3 },
    { title: 'Indexed', field: 'indexed', width: 80, hozAlign: 'center', headerSort: false, formatter: c => tick(c.getValue()) },
    { title: 'Voice', field: 'audioReady', width: 70, hozAlign: 'center', headerSort: false, formatter: c => tick(c.getValue()) },
    { title: '', width: 50, headerSort: false, hozAlign: 'center', formatter: () => '🗑️', cellClick: (e, cell) => cell.getRow().delete() }
  ]
});

function updateFaqCount() {
  $('faqCount').textContent = `(${faqTable.getDataCount()})`;
}
faqTable.on('rowDeleted', updateFaqCount);

async function loadFaq() {
  const data = await (await fetch('/api/faq')).json();
  faqTable.setData(data.entries);
  $('faqThreshold').value = data.threshold;
  updateFaqCount();
  const chars = `${data.chars.toLocaleString()} of ${data.budget.toLocaleString()}`;
  $('faqMode').textContent = data.mode === 'context'
    ? `🧠 All ${data.entries.length} answers go to the AI as knowledge on every turn (${chars} characters used) — no lookup delay, nothing missed.`
    : `🔎 Too much knowledge to send whole (${chars} characters), so the AI gets only the ${data.topK} closest answers per turn — adds about half a second on those turns.`;
  return data;
}

// Updates only the status ticks, never the text — so polling can't clobber unsaved edits.
async function pollFaqStatus(tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const data = await (await fetch('/api/faq')).json();
    await Promise.all(data.entries.map(e => faqTable.updateData([{ id: e.id, indexed: e.indexed, audioReady: e.audioReady }]).catch(() => {})));
    if (!data.warming && data.entries.every(e => e.audioReady)) return;
  }
}

loadFaq().then(data => { if (data.warming || data.entries.some(e => !e.audioReady)) pollFaqStatus(5); });

$('faqAddRowBtn').onclick = () => { faqTable.addRow({ id: newFaqId(), question: '', answer: '' }, true); updateFaqCount(); };

$('faqSaveBtn').onclick = async () => {
  const btn = $('faqSaveBtn');
  btn.disabled = true;
  setStatus($('faqStatus'), '⏳ Saving and indexing…');
  try {
    const res = await fetch('/api/faq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: faqTable.getData(), threshold: Number($('faqThreshold').value) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await loadFaq();
    setStatus($('faqStatus'), `✅ Saved ${data.count} answer(s), indexed ${data.embedded} new/changed. Generating voice in the background — the Voice column fills in as each finishes.`, 'ok');
    pollFaqStatus();
  } catch (err) {
    setStatus($('faqStatus'), `❌ ${esc(err.message)}`, 'err');
  } finally {
    btn.disabled = false;
  }
};

$('faqRegenVoiceBtn').onclick = async () => {
  await fetch('/api/faq/regenerate-voice', { method: 'POST' });
  setStatus($('faqStatus'), '🔊 Generating voice for answers that don\'t have it yet…', 'ok');
  pollFaqStatus();
};

$('faqImportInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const res = await fetch('/api/faq/parse', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    faqTable.addData(data.rows.map(r => ({ id: newFaqId(), ...r })), true);
    updateFaqCount();
    setStatus($('faqStatus'), `Imported ${data.rows.length} row(s) — review them, then click Save &amp; Index to apply.`, 'ok');
  } catch (err) {
    setStatus($('faqStatus'), `❌ ${esc(err.message)}`, 'err');
  }
  e.target.value = '';
};

$('faqTestBtn').onclick = async () => {
  const text = $('faqTestInput').value.trim();
  if (!text) return;
  const out = $('faqTestOut');
  setStatus(out, '⏳ Checking…');
  try {
    const res = await fetch('/api/faq/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.results.length === 0) return setStatus(out, 'Nothing is indexed yet — click Save &amp; Index first.', 'err');
    const threshold = Number($('faqThreshold').value);
    const [best] = data.results;
    const verdict = best.score >= threshold
      ? `✅ Would answer instantly (${best.score.toFixed(3)} ≥ ${threshold}): <b>${esc(best.answer)}</b>`
      : `➡️ Would go to the AI (best score ${best.score.toFixed(3)} &lt; ${threshold})`;
    const rows = data.results.map(r => `${r.score.toFixed(3)} — ${esc(r.question)}`).join('<br>');
    setStatus(out, `${verdict}<br><span class="muted">Closest saved questions:<br>${rows}</span>`, best.score >= threshold ? 'ok' : '');
  } catch (err) {
    setStatus(out, `❌ ${esc(err.message)}`, 'err');
  }
};

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------
let transcriptionData = null;
const ts = s => { s = Math.floor(s || 0); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

$('transcribeForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('transcribeFile').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('language', $('transcribeLanguage').value);
  form.append('mode', $('transcribeMode').value);
  form.append('filename', file.name);
  form.append('audio', file, file.name);

  setStatus($('transcribeStatus'), '⏳ Transcribing… long calls can take a few minutes.');
  $('transcribeOut').hidden = true;
  try {
    const res = await fetch('/api/transcribe', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    transcriptionData = data;
    renderTranscription();
    setStatus($('transcribeStatus'), `✅ Done: ${data.turns.length} turns (${data.language || 'detected language'}).`, 'ok');
  } catch (err) {
    setStatus($('transcribeStatus'), `❌ ${err.message}`, 'err');
  }
};

function renderTranscription() {
  const out = $('transcribeOut');
  out.hidden = false;
  out.innerHTML = '';
  for (const t of transcriptionData.turns) {
    const div = document.createElement('div');
    div.className = 'msg turn-' + t.role;
    div.innerHTML = `<div class="who">${t.role} · ${ts(t.start)}</div>${t.text}`;
    out.appendChild(div);
  }
  $('transcribeDownloadBtn').hidden = false;
}

$('transcribeDownloadBtn').onclick = () => {
  if (!transcriptionData) return;
  const txt = transcriptionData.turns.map(t => `[${ts(t.start)}] ${t.role}: ${t.text}`).join('\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = transcriptionData.file.replace(/\.[^.]+$/, '') + '_transcript.txt';
  a.click();
};

// ---------------------------------------------------------------------------
// Voice cloning
// ---------------------------------------------------------------------------
$('voiceCloneBtn').onclick = async () => {
  const file = $('voiceCloneFile').files[0];
  if (!file) { alert('Choose an audio file first.'); return; }
  setStatus($('voiceCloneStatus'), '⏳ Uploading and registering voice…');
  try {
    const form = new FormData();
    form.append('name', $('voiceCloneName').value.trim() || ('gemini_solariss_voice_' + Date.now()));
    form.append('filename', file.name);
    form.append('mimetype', file.type || '');
    form.append('file', file, file.name);
    const res = await fetch('/api/clone-voice', { method: 'POST', body: form });
    const data = await res.json();
    if (data.status === 'VOICE_CLONED') setStatus($('voiceCloneStatus'), `✅ Voice cloned (${data.voice_id}). ${data.message}`, 'ok');
    else setStatus($('voiceCloneStatus'), `❌ ${data.error || JSON.stringify(data)}`, 'err');
  } catch (err) {
    setStatus($('voiceCloneStatus'), `❌ ${err.message}`, 'err');
  }
};

// ---------------------------------------------------------------------------
// Text chat — same server brain as voice, over /ws/chat
// ---------------------------------------------------------------------------
let chatWs = null;
function chatOpen() {
  if (chatWs && chatWs.readyState <= 1) return;
  $('chatBox').innerHTML = ''; $('chatTrace').innerHTML = ''; lastChatUser = null;
  traceT0 = Date.now();
  chatWs = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/chat');
  chatWs.onmessage = (evt) => {
    const d = JSON.parse(evt.data);
    if (d.event === 'transcript') appendChat(d.role, d.text, d.latency, d.faq, 'chatBox');
    else if (d.event === 'error') appendChat('bot', '⚠️ ' + d.message, null, false, 'chatBox');
    else if (d.event === 'pipeline') { traceBoxId = 'chatTrace'; try { handlePipeline(d); } finally { traceBoxId = 'pipelineBox'; } }
  };
  chatWs.onclose = () => setTimeout(refreshResults, 1500);
}
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  chatOpen();
  const send = () => chatWs.send(JSON.stringify({ text }));
  chatWs.readyState === WebSocket.OPEN ? send() : chatWs.addEventListener('open', send, { once: true });
  $('chatInput').value = '';
};
$('chatNewBtn').onclick = () => { if (chatWs) chatWs.close(); chatWs = null; chatOpen(); };
chatOpen();
loadTraining();

// ---------------------------------------------------------------------------
// LLM switch (Gemini / NVIDIA / ...) — applies to the next reply, no restart
// ---------------------------------------------------------------------------
const LLM_LABELS = { gemini: 'Gemini', nvidia: 'NVIDIA NIM', ollama: 'Ollama (local)' };
async function loadLlm() {
  const sel = $('llmSelect');
  try {
    const st = await (await fetch('/api/llm')).json();
    sel.innerHTML = st.available.map(n => `<option value="${n}">${LLM_LABELS[n] || n}</option>`).join('');
    sel.value = st.active;
    sel.title = st.model;
  } catch { sel.innerHTML = '<option>unavailable</option>'; }
}
$('llmSelect').onchange = async (e) => {
  const res = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: e.target.value }) });
  if (!res.ok) alert((await res.json()).error || 'Could not switch');
  loadLlm();
};
loadLlm();

// ---------------------------------------------------------------------------
// Settings card — AI provider/models/fallback and speech-to-text engine
// ---------------------------------------------------------------------------
function settingsMsg(text, ok = true) {
  const el = $('settingsStatus');
  el.hidden = false;
  el.className = 'status ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

async function loadSettings() {
  const st = await (await fetch('/api/settings')).json();
  const { llm, stt } = st;
  $('setProvider').innerHTML = llm.available.map(n => `<option value="${n}">${LLM_LABELS[n] || n}</option>`).join('');
  $('setProvider').value = llm.active;
  $('setFallback').checked = llm.fallback;
  $('setGeminiModel').value = llm.models.gemini || '';
  $('setNvidiaModel').value = llm.models.nvidia || '';
  $('setGeminiModel').disabled = !llm.available.includes('gemini');
  $('setNvidiaModel').disabled = !llm.available.includes('nvidia');
  document.querySelectorAll('[data-test]').forEach(b => { b.disabled = !llm.available.includes(b.dataset.test); });
  $('setEndOfTurn').value = String(st.speech.endOfTurnFrames);
  $('setSttEngine').value = stt.engine;
  $('setCactusUrl').value = stt.url || '';
  $('setCactusUrl').placeholder = stt.defaults.url;
  $('setCactusModel').value = stt.model || '';
  $('setCactusModel').placeholder = stt.defaults.model;
  for (const provider of ['gemini', 'nvidia']) {
    if (!llm.available.includes(provider)) continue;
    fetch('/api/models?provider=' + provider).then(r => r.json()).then(list => {
      $(provider + 'Models').innerHTML = list.map(m => `<option value="${esc(m)}">`).join('');
    }).catch(() => {});
  }
}

$('settingsSaveBtn').onclick = async () => {
  const models = {};
  if (!$('setGeminiModel').disabled && $('setGeminiModel').value.trim()) models.gemini = $('setGeminiModel').value.trim();
  if (!$('setNvidiaModel').disabled && $('setNvidiaModel').value.trim()) models.nvidia = $('setNvidiaModel').value.trim();
  const res = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      llm: { provider: $('setProvider').value, fallback: $('setFallback').checked, models },
      speech: { endOfTurnFrames: Number($('setEndOfTurn').value) },
      stt: { engine: $('setSttEngine').value, url: $('setCactusUrl').value.trim(), model: $('setCactusModel').value.trim() }
    })
  });
  const body = await res.json();
  if (!res.ok) return settingsMsg('Not saved: ' + body.error, false);
  settingsMsg(`Saved. Replies now use ${body.llm.model}; speech-to-text: ${body.stt.engine === 'cactus' ? 'Cactus Whisper (Sarvam on failure)' : 'Sarvam'}.`);
  loadSettings();
  loadLlm();
};

document.querySelectorAll('[data-test]').forEach(btn => {
  btn.onclick = async () => {
    const provider = btn.dataset.test;
    const model = $(provider === 'gemini' ? 'setGeminiModel' : 'setNvidiaModel').value.trim();
    btn.disabled = true; btn.textContent = '…';
    try {
      const res = await (await fetch('/api/settings/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model })
      })).json();
      settingsMsg(res.ok ? `${LLM_LABELS[provider]} / ${model} works — first word in ${res.ms}ms ("${res.sample}")` : `${LLM_LABELS[provider]} / ${model} failed: ${res.error}`, !!res.ok);
    } catch (err) { settingsMsg('Test failed: ' + err.message, false); }
    btn.disabled = false; btn.textContent = 'Test';
  };
});
loadSettings();

document.getElementById('logoutBtn').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.href = '/'; };
