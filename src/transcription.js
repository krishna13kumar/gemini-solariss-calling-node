/**
 * Call-recording transcription: uploaded audio -> diarized Telecaller/Lead turns.
 * Diarization + STT via Sarvam; which speaker is the telecaller is decided with a
 * quick local Ollama check (optional — falls back to a word-count heuristic).
 */

import { Ollama } from 'ollama';
import { getEnv } from './env.js';

/** Merges consecutive diarized entries from the same speaker into one turn. */
export function toTurns(entries) {
  const turns = [];
  for (const e of entries) {
    const text = e.transcript?.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.speaker === e.speaker_id) {
      last.text += ' ' + text;
      last.end = e.end_time_seconds;
    } else {
      turns.push({ speaker: e.speaker_id, start: e.start_time_seconds, end: e.end_time_seconds, text });
    }
  }
  return turns;
}

/** Fallback when Ollama is unavailable: the telecaller usually talks the most. */
export function guessTelecaller(turns) {
  const words = {};
  for (const t of turns) words[t.speaker] = (words[t.speaker] || 0) + t.text.split(/\s+/).length;
  return Object.entries(words).sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function identifyTelecaller(turns) {
  const speakers = [...new Set(turns.map(t => t.speaker))];
  const label = id => String.fromCharCode(65 + speakers.indexOf(id)); // letters, not Sarvam's numeric ids
  const sample = turns.slice(0, 30).map(t => `Speaker ${label(t.speaker)}: ${t.text}`).join('\n');
  try {
    const ollama = new Ollama({ host: getEnv('OLLAMA_HOST', 'http://localhost:11434') });
    const res = await ollama.chat({
      model: getEnv('OLLAMA_MODEL', 'qwen2.5:7b-instruct-q4_K_M'),
      format: 'json',
      options: { temperature: 0 },
      messages: [{
        role: 'user',
        content: `Transcript of a phone call:\n\n${sample}\n\nOne speaker is the TELECALLER: an employee of a solar company who introduces themselves or the company, explains rooftop solar/subsidies, and asks for a site visit. The other is the LEAD: the customer who received the call.\nFirst explain in one sentence who introduces the company, then answer.\nReply as JSON: {"reason": "...", "telecaller": "A" or "B"}`
      }]
    });
    const id = speakers[String(JSON.parse(res.message.content).telecaller).trim().toUpperCase().charCodeAt(0) - 65];
    if (id !== undefined) return id;
  } catch (err) {
    console.warn('[Transcription] Ollama speaker identification unavailable, using word-count fallback:', err.message);
  }
  return guessTelecaller(turns);
}

/**
 * @param {Object} voiceProvider - must implement transcribeFileWithDiarization
 * @returns {Promise<{file: string, language: string, turns: Array}>}
 */
export async function transcribeCallRecording(voiceProvider, fileBuffer, filename, languageCode, mode) {
  const result = await voiceProvider.transcribeFileWithDiarization(fileBuffer, filename, languageCode, mode);
  const turns = toTurns(result.diarized_transcript?.entries || []);
  if (!turns.length && result.transcript) turns.push({ speaker: '0', start: 0, end: 0, text: result.transcript });
  const telecaller = await identifyTelecaller(turns);

  return {
    file: filename,
    language: result.language_code,
    turns: turns.map(t => ({ ...t, role: t.speaker === telecaller ? 'Telecaller' : 'Lead' }))
  };
}
