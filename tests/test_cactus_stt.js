import assert from 'node:assert/strict';
import http from 'node:http';

process.env.STT_PROVIDER = 'cactus';
process.env.CACTUS_STT_MODEL = 'test-model';
process.env.CACTUS_STT_TIMEOUT_MS = '800';

// Fake `cactus serve`: records the multipart body, answers per `mode`.
let mode = 'ok', seen = '';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c.toString('latin1'));
  req.on('end', () => {
    seen = body;
    if (mode === 'error') { res.writeHead(500); return res.end('model not loaded'); }
    if (mode === 'hang') return; // never answers -> client timeout
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: ' என் பேர் ராம் ' }));
  });
});
await new Promise(r => server.listen(0, r));
process.env.CACTUS_STT_URL = `http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`;

// Import after env is set: the provider reads it at construction. Built-in STT is stubbed out below.
const { createVoiceProvider } = await import('../src/providers/index.js');
const voice = createVoiceProvider();
const pcm = Buffer.alloc(16000);

assert.equal(await voice.speechToText(pcm, 8000), 'என் பேர் ராம்');
for (const field of ['name="file"', 'name="model"', 'test-model', 'name="language"', 'name="prompt"', 'Gemini Solariss', 'RIFF']) assert.ok(seen.includes(field), `request carries ${field}`);

assert.equal(await voice.speechToText(Buffer.alloc(100), 8000), ''); // too short: never sent

// Server error and timeout both fall back to Sarvam instead of failing the turn. (Sarvam would be a real
// network call, so point its fetch at a stub by temporarily replacing the global.)
const realFetch = globalThis.fetch; let fellBack = 0;
globalThis.fetch = (url, opts) => String(url).includes('api.sarvam.ai') ? (fellBack++, Promise.resolve(new Response(JSON.stringify({ transcript: 'sarvam text' })))) : realFetch(url, opts);
mode = 'error'; assert.equal(await voice.speechToText(pcm, 8000), 'sarvam text');
mode = 'hang'; assert.equal(await voice.speechToText(pcm, 8000), 'sarvam text');
assert.equal(fellBack, 2);
globalThis.fetch = realFetch;

server.closeAllConnections?.(); server.close();
console.log('cactus stt tests passed');
