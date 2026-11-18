/**
 * STT plugin: Cactus (https://github.com/cactus-compute/cactus) running a Whisper model behind
 * `cactus serve`, called over its OpenAI-style transcription route. Self-hosted, no per-minute cost.
 * Selected with STT_PROVIDER=cactus; any failure (server down, timeout, bad reply) falls back to the
 * default voice provider's STT so a call never goes deaf.
 *
 * Expected: POST {CACTUS_STT_URL}  multipart(file=wav, model, language, prompt, response_format=json)
 *           -> {"text": "..."}        (also accepts {"response": "..."} / {"transcript": "..."})
 */

import { getEnv } from '../../env.js';
import { pcmToWav } from '../../audioUtils.js';

// Whisper biases toward words in its prompt — the Whisper counterpart of Sarvam's `keyterms`.
const PROMPT = 'Gemini Solariss, PM Surya Ghar, TANGEDCO, EB bill, net metering, subsidy, kilowatt, rooftop solar, Chennai';

export class CactusSttService {
  /** @param {{url?: string, model?: string}} [overrides] dashboard settings; .env values are the defaults */
  constructor({ url, model } = {}) {
    this.url = url || getEnv('CACTUS_STT_URL', 'http://127.0.0.1:8080/v1/audio/transcriptions');
    this.model = model || getEnv('CACTUS_STT_MODEL', 'openai/whisper-small');
    this.language = getEnv('CACTUS_STT_LANGUAGE', 'ta'); // Whisper takes ISO-639-1, not ta-IN
    this.timeoutMs = parseInt(getEnv('CACTUS_STT_TIMEOUT_MS', '6000'), 10);
  }

  /** @returns {Promise<string>} transcript ('' when nothing was understood); throws if the server fails */
  async transcribe(pcmBuffer, sampleRate = 8000) {
    if (!pcmBuffer || pcmBuffer.length < 3200) return '';
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(pcmBuffer, sampleRate, 1, 16)], { type: 'audio/wav' }), 'customer_audio.wav');
    form.append('model', this.model);
    form.append('language', this.language);
    form.append('prompt', PROMPT);
    form.append('response_format', 'json');

    const response = await fetch(this.url, { method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Cactus STT HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { return body.trim(); } // some servers answer with plain text
    return String(data.text ?? data.response ?? data.transcript ?? '').trim();
  }
}
