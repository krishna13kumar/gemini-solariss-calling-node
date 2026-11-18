/**
 * Voice Plugin: Sarvam AI (STT, TTS, voice cloning, diarized batch transcription).
 */

import { SarvamAIClient } from 'sarvamai';
import { getRequiredEnv, getEnv } from '../../env.js';
import { pcmToWav, wavToPcm, resamplePcm, getWavSampleRate } from '../../audioUtils.js';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AUDIO_MIME_BY_EXTENSION = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', webm: 'audio/webm'
};

function guessAudioMimeType(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  return AUDIO_MIME_BY_EXTENSION[ext] || null;
}

// Domain words biasing STT (saaras:v4 `keyterms`, max 50): measured to turn "Gemming Solaris" /
// "பிஎம் சூர்யா கார்" into the exact "Gemini Solariss" / "PM Surya Ghar" the CRM and LLM expect.
const STT_KEYTERMS = [
  'Gemini Solariss', 'PM Surya Ghar', 'TANGEDCO', 'TNPDCL', 'EB bill', 'net metering', 'subsidy', 'kilowatt', 'kW',
  'rooftop solar', 'on-grid', 'off-grid', 'shared roof', 'individual roof', 'apartment', 'residential', 'commercial',
  'Injambakkam', 'Chennai', 'Coimbatore', 'Madurai', 'Trichy', 'Salem', 'Tirunelveli', 'Erode', 'Vellore'
];
export class SarvamVoiceService {
  constructor() {
    this.apiKey = getRequiredEnv('SARVAM_API_KEY');
    this.sttModel = getRequiredEnv('SARVAM_STT_MODEL');
    this.ttsModel = getRequiredEnv('SARVAM_TTS_MODEL');
    this.languageCode = getEnv('VOICE_LANGUAGE_CODE', 'ta-IN'); // Tamil by default
    this.speaker = getEnv('VOICE_SPEAKER', 'kavya');
    this.pace = parseFloat(getEnv('VOICE_PACE', '1.0'));
    // codemix keeps English words ("bill", "subsidy", "Gemini Solariss") in Latin script and numbers as digits
    // — what the LLM prompt and CRM extraction expect. Set SARVAM_STT_MODE=transcribe for all-Tamil-script output.
    this.sttMode = getEnv('SARVAM_STT_MODE', 'codemix');
    this.temperature = getEnv('VOICE_TEMPERATURE', ''); // bulbul:v3 only; lower = steadier delivery. Unset = Sarvam default (0.6)
    this.client = new SarvamAIClient({ apiSubscriptionKey: this.apiKey });
    this.health = { ok: null, message: 'No calls made yet this run', checkedAt: null };
  }

  /**
   * Sarvam has no API to check remaining credits (confirmed against their docs) —
   * only a web dashboard. This tracks the outcome of the last real STT/TTS call
   * instead of faking a balance number, so "out of credits" is at least visible
   * on the dashboard instead of silently making calls go quiet.
   */
  _recordHealth(ok, message) {
    this.health = { ok, message, checkedAt: new Date().toISOString() };
  }

  getHealthStatus() {
    return this.health;
  }

  /** Anything that changes how a given text sounds — cached audio is keyed on this. */
  getVoiceFingerprint() {
    return `${this.speaker}|${this.pace}|${this.languageCode}|${this.ttsModel}|${this.temperature}`;
  }

  /**
   * Synthesizes text into 16-bit mono PCM at `rate` Hz (8000 for telephony, higher for local playback).
   * @returns {Promise<Buffer>}
   */
  async textToSpeech(text, rate = 8000) {
    if (!text || !text.trim()) return null;

    const isClonedVoice = this.speaker.startsWith('svc-');
    let base64Audio;

    if (isClonedVoice) {
      const form = new FormData();
      form.append('text', text.trim());
      form.append('target_language_code', this.languageCode);
      form.append('model', this.ttsModel);
      form.append('voice_id', this.speaker);
      form.append('pace', String(this.pace));

      const response = await fetch('https://api.sarvam.ai/voices/clone', {
        method: 'POST',
        headers: { 'api-subscription-key': this.apiKey },
        body: form
      });
      const data = await response.json();
      if (!response.ok || !data.audio_b64) {
        this._recordHealth(false, data.error?.message || JSON.stringify(data));
        throw new Error(`Sarvam voice-clone synthesis failed: ${data.error?.message || JSON.stringify(data)}`);
      }
      this._recordHealth(true, 'OK');
      base64Audio = data.audio_b64;
    } else {
      const response = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: [text.trim()],
          target_language_code: this.languageCode,
          model: this.ttsModel,
          speaker: this.speaker,
          pace: this.pace,
          ...(this.temperature && { temperature: parseFloat(this.temperature) })
        })
      });
      const data = await response.json();
      if (!response.ok || !data.audios?.[0]) {
        this._recordHealth(false, data.error?.message || JSON.stringify(data));
        throw new Error(`Sarvam TTS synthesis failed: ${data.error?.message || JSON.stringify(data)}`);
      }
      this._recordHealth(true, 'OK');
      base64Audio = data.audios[0];
    }

    const wavBuf = Buffer.from(base64Audio, 'base64');
    const sourceRate = getWavSampleRate(wavBuf);
    const pcmSource = wavToPcm(wavBuf);
    return resamplePcm(pcmSource, sourceRate, rate);
  }

  /** True for the (default) preset-speaker path; cloned voices (svc-...) don't support streaming synthesis yet. */
  supportsStreaming() {
    return !this.speaker.startsWith('svc-');
  }

  /**
   * Opens a persistent low-latency TTS WebSocket (~300-700ms time-to-first-audio,
   * vs ~3s+ for the batch REST endpoint). Caller owns the socket's lifetime — keep
   * one per call and close it when the call ends, rather than reconnecting per sentence.
   * Audio arrives pre-resampled at `rate` Hz raw PCM (no WAV parsing needed). First-chunk time
   * was measured identical (~290ms) at 8k/16k/24k, so local playback can use full quality for free.
   * @returns {Promise<import('sarvamai').TextToSpeechStreamingSocket>}
   */
  async createStreamingSocket(rate = 8000) {
    const socket = await this.client.textToSpeechStreaming.connect({ model: this.ttsModel, send_completion_event: true });
    await socket.waitForOpen();
    socket.configureConnection({
      language_code: this.languageCode,
      speaker: this.speaker,
      pace: this.pace,
      speech_sample_rate: rate,
      output_audio_codec: 'linear16',
      min_buffer_size: 30,
      ...(this.temperature && { temperature: parseFloat(this.temperature) })
    });
    return socket;
  }

  /**
   * Synthesizes one piece of text over an already-open streaming socket, invoking
   * onChunk(pcmBuffer) as each audio chunk arrives. Chunk delivery to onChunk is
   * serialized (each call awaited before the next) — Sarvam's WS events can arrive
   * faster than paced playback can consume them, and onChunk is typically a
   * paced-send function, so calling it concurrently would corrupt audio ordering.
   * Resolves once Sarvam signals that sentence's synthesis is complete ("final").
   */
  streamTextToSpeech(socket, text, onChunk) {
    return new Promise((resolve, reject) => {
      if (!text || !text.trim()) return resolve();

      const pending = [];
      let draining = false;
      let settled = false;

      const drain = async () => {
        draining = true;
        while (pending.length > 0) {
          const item = pending.shift();
          if (item.type === 'chunk') await onChunk(item.data);
          else if (item.type === 'final' && !settled) { settled = true; this._recordHealth(true, 'OK'); resolve(); }
          else if (item.type === 'error' && !settled) { settled = true; this._recordHealth(false, item.error.message); reject(item.error); }
        }
        draining = false;
      };

      socket.on('message', (message) => {
        if (message.type === 'audio') {
          pending.push({ type: 'chunk', data: Buffer.from(message.data.audio, 'base64') });
        } else if (message.type === 'event' && message.data.event_type === 'final') {
          pending.push({ type: 'final' });
        } else if (message.type === 'error') {
          pending.push({ type: 'error', error: new Error(message.data?.message || 'Sarvam streaming TTS error') });
        } else {
          return;
        }
        if (!draining) drain();
      });

      socket.convert(text.trim());
      socket.flush();
    });
  }

  /**
   * Transcribes an 8kHz 16-bit mono PCM buffer captured mid-call (low-latency, no diarization).
   * @returns {Promise<string>}
   */
  async speechToText(pcmBuffer, sampleRate = 8000) {
    if (!pcmBuffer || pcmBuffer.length < 3200) return '';

    const wavBuffer = pcmToWav(pcmBuffer, sampleRate, 1, 16);
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'customer_audio.wav');
    form.append('model', this.sttModel);
    form.append('language_code', this.languageCode);
    form.append('mode', this.sttMode);
    if (this.sttModel === 'saaras:v4') form.append('keyterms', JSON.stringify(STT_KEYTERMS)); // v4 only

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[SarvamSTT] Transcription error:', data);
      this._recordHealth(false, data.error?.message || JSON.stringify(data));
      return '';
    }
    this._recordHealth(true, 'OK');
    return data.transcript?.trim() || '';
  }

  /**
   * Registers a reference clip as a cloned voice. Returns the resulting voice_id.
   */
  async cloneVoiceFromSample(fileBuffer, filename, name, mimetype) {
    const resolvedType = mimetype || guessAudioMimeType(filename) || 'audio/wav';
    const form = new FormData();
    form.append('name', name);
    form.append('language', this.languageCode);
    form.append('file', new Blob([fileBuffer], { type: resolvedType }), filename || 'sample.wav');

    const response = await fetch('https://api.sarvam.ai/voices/create', {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form
    });
    const data = await response.json();
    if (!response.ok || !data.data?.voice_id) {
      throw new Error(`Sarvam voice registration failed: ${data.error?.message || JSON.stringify(data)}`);
    }
    return data.data.voice_id;
  }

  /**
   * Batch-transcribes an uploaded call recording with speaker diarization.
   * languageCode: 'unknown' (auto-detect) or a specific code (ta-IN, en-IN, hi-IN, ...).
   * mode: 'transcribe' | 'translate' | 'codemix' | 'translit'.
   * @returns {Promise<{language_code: string, diarized_transcript?: {entries: Array}, transcript?: string}>}
   */
  async transcribeFileWithDiarization(fileBuffer, filename, languageCode = 'unknown', mode = 'transcribe') {
    const workDir = await mkdtemp(path.join(tmpdir(), 'solariss-stt-'));
    try {
      const filePath = path.join(workDir, path.basename(filename || 'audio').replace(/[^\w.\-]/g, '_'));
      await writeFile(filePath, fileBuffer);

      const job = await this.client.speechToTextJob.createJob({
        model: this.sttModel,
        languageCode,
        mode,
        withDiarization: true,
        numSpeakers: 2,
        keyterms: STT_KEYTERMS
      });
      await job.uploadFiles([filePath]);
      await job.start();
      const status = await job.waitUntilComplete(5, 1800);
      if (status.job_state.toLowerCase() !== 'completed') {
        throw new Error(`Sarvam job ${job.jobId} ${status.job_state}: ${JSON.stringify(status.job_details?.[0]?.error_message || status)}`);
      }
      await job.downloadOutputs(workDir);
      const jsonFile = (await readdir(workDir)).find(f => f.endsWith('.json'));
      return JSON.parse(await readFile(path.join(workDir, jsonFile), 'utf8'));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
