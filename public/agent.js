// Public entry page: one button that opens a voice call with the agent through the browser microphone.
const $ = (id) => document.getElementById(id);
const PLAY_RATE = 24000; // playback runs at full quality; the mic is captured at 8 kHz, what the server's speech recognition expects

// ---- theme ----
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙'; // shows what you'll switch to
  try { localStorage.setItem('theme', t); } catch {}
}
$('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
$('themeBtn').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';

// ---- call state ----
let ws = null, micStream = null, capCtx = null, playCtx = null;
let nextPlayTime = 0, rxBytes = 0, idleTimer = null;
let heardAgent = false;  // did the agent ever speak (so "thank you" isn't shown after a failed start)
let endedByUser = false;

const setView = (v) => { document.body.dataset.view = v; };
const setStatus = (text, mode) => { $('status').textContent = text; if (mode) $('orb').dataset.mode = mode; };
const hint = (text, isError) => { const h = $('introHint'); h.textContent = text; h.className = 'hint' + (isError ? ' err' : ''); };

function addCaption(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'me' : 'bot');
  div.textContent = text; // textContent, never innerHTML: this is untrusted speech-to-text output
  $('captions').appendChild(div);
  $('captions').scrollTop = $('captions').scrollHeight;
}

function playChunk(arrayBuffer) {
  if (!playCtx || arrayBuffer.byteLength < 2) return;
  const int16 = new Int16Array(arrayBuffer);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  const buf = playCtx.createBuffer(1, f32.length, PLAY_RATE);
  buf.copyToChannel(f32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const startAt = Math.max(playCtx.currentTime, nextPlayTime);
  src.start(startAt);
  nextPlayTime = startAt + buf.duration;

  heardAgent = true;
  setStatus('Kavya is speaking…', 'speaking');
  // Tell the server the moment the queue really drains so it starts listening right then, and tell the person it's their turn.
  rxBytes += arrayBuffer.byteLength;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'playback_idle', bytes: rxBytes }));
    setStatus('Your turn — please speak', 'listening');
  }, Math.max(0, (nextPlayTime - playCtx.currentTime) * 1000) + 30);
}

function cleanup() {
  clearTimeout(idleTimer);
  try { ws?.close(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  for (const c of [capCtx, playCtx]) c?.close().catch(() => {});
  ws = micStream = capCtx = playCtx = null;
  $('orb').style.setProperty('--lvl', 0);
}

function finish(title, text) {
  cleanup();
  $('doneTitle').textContent = title;
  $('doneText').textContent = text;
  setView('done');
}

function micError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'The microphone is blocked. Click the 🔒 icon next to the address bar, allow the microphone, then press the button again.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'We couldn’t find a microphone. Plug one in (or turn on your headset) and try again.';
  if (err?.name === 'NotReadableError') return 'Your microphone is being used by another app. Close it and try again.';
  return 'We couldn’t start the microphone: ' + (err?.message || 'unknown error');
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    hint('This browser can’t use the microphone here. Open this page in Chrome, Edge or Safari over a secure (https) link.', true);
    return;
  }
  $('startBtn').disabled = true;
  hint('Please allow the microphone when your browser asks…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (err) {
    $('startBtn').disabled = false;
    hint(micError(err), true);
    return;
  }

  // Fresh state for every call (a new AudioContext's clock restarts at 0).
  nextPlayTime = 0; rxBytes = 0; heardAgent = false; endedByUser = false;
  $('captions').innerHTML = '';
  setView('live');
  setStatus('Connecting…', 'connecting');

  const AC = window.AudioContext || window.webkitAudioContext;
  capCtx = new AC({ sampleRate: 8000 });
  playCtx = new AC({ sampleRate: PLAY_RATE });
  capCtx.resume?.(); playCtx.resume?.();

  const source = capCtx.createMediaStreamSource(micStream);
  const processor = capCtx.createScriptProcessor(1024, 1, 1);
  source.connect(processor);
  processor.connect(capCtx.destination);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sum += s * s;
    }
    $('orb').style.setProperty('--lvl', Math.min(1, Math.sqrt(sum / input.length) * 6).toFixed(2)); // the ring pulses with your voice
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm16.buffer);
  };

  const id = 'WEB_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/audio-stream?rate=' + PLAY_RATE + '&lead_id=' + id);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ event: 'trigger_greeting' }));
  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) return playChunk(evt.data);
    let m; try { m = JSON.parse(evt.data); } catch { return; }
    if (m.event === 'caption') addCaption(m.role, m.text);
    else if (m.event === 'state') {
      if (m.stage === 'stt') setStatus('Understanding you…', 'thinking');
      else if (m.stage === 'llm') setStatus('Kavya is thinking…', 'thinking');
    } else if (m.event === 'busy') finishBusy();
    else if (m.event === 'time_limit') finish('Call ended', 'This call reached its time limit. Our team will use the details already noted to contact you.');
  };
  ws.onclose = () => {
    if (!document.body.dataset.view || document.body.dataset.view !== 'live') return;
    if (endedByUser || heardAgent) finish('Thank you!', 'Your details have been noted. Our team will contact you shortly to confirm your appointment.');
    else { cleanup(); setView('intro'); $('startBtn').disabled = false; hint('We couldn’t connect to the agent. Please check your internet and try again.', true); }
  };
  ws.onerror = () => {};
}

function finishBusy() {
  cleanup();
  setView('intro');
  $('startBtn').disabled = false;
  hint('All our advisors are busy right now. Please try again in a few minutes.', true);
}

$('startBtn').onclick = start;
$('endBtn').onclick = () => { endedByUser = true; try { ws?.close(); } catch {} if (document.body.dataset.view === 'live') finish('Thank you!', 'Your call has ended. Any details you shared have been noted, and our team will be in touch to confirm your appointment.'); };
$('againBtn').onclick = () => { setView('intro'); $('startBtn').disabled = false; hint('Takes about 4 minutes. Tamil or English — whichever you prefer. Headphones give the best sound.'); };
