/**
 * Plugin Registry — every capability (dialogue model, telephony carrier, voice
 * STT/TTS) is selected here from a .env variable, never hardcoded in server.js.
 *
 * Interfaces:
 *   LLM provider       — { model, streamResponse(history, leadContext) -> AsyncGenerator<string> }
 *   Telephony provider — { triggerCall(lead), terminateCall(callSid), getConfigStatus() }
 *   Voice provider      — { speechToText(pcmBuffer, sampleRate), textToSpeech(text) }
 *   STT provider        — { transcribe(pcmBuffer, sampleRate) } — optional override of the voice provider's STT
 */

import { GeminiDialogueEngine } from './llm/gemini.js';
import { OllamaDialogueEngine } from './llm/ollama.js';
import { NvidiaDialogueEngine } from './llm/nvidia.js';
import { ExotelTelephonyProvider } from './telephony/exotel.js';
import { SarvamVoiceService } from './voice/sarvam.js';
import { CactusSttService } from './stt/cactus.js';
import { LlmRouter } from './llm/router.js';
import { getEnv, getBoolEnv } from '../env.js';

const LLM_PROVIDERS = { gemini: GeminiDialogueEngine, ollama: OllamaDialogueEngine, nvidia: NvidiaDialogueEngine };
const TELEPHONY_PROVIDERS = { exotel: ExotelTelephonyProvider };
const VOICE_PROVIDERS = { sarvam: SarvamVoiceService };

function pick(providers, envVar, fallback) {
  const key = getEnv(envVar, fallback).toLowerCase();
  const Provider = providers[key];
  if (!Provider) throw new Error(`[Providers] Unknown ${envVar}="${key}". Available: ${Object.keys(providers).join(', ')}`);
  console.log(`[Providers] ${envVar}=${key}`);
  return Provider;
}

/** All LLM providers behind one switchable router; LLM_PROVIDER picks the default, the dashboard can change it live. */
export function createLLMProvider() {
  const defaultName = getEnv('LLM_PROVIDER', 'gemini').toLowerCase();
  pick(LLM_PROVIDERS, 'LLM_PROVIDER', 'gemini'); // validates the name and logs it
  // Ollama has no credentials to check, so "configured" says nothing about whether a server is running —
  // include it only when it's the explicit default, never as a dropdown option / silent fallback.
  const { ollama, ...cloud } = LLM_PROVIDERS;
  const classes = defaultName === 'ollama' ? LLM_PROVIDERS : cloud;
  return new LlmRouter(classes, defaultName, getBoolEnv('LLM_FALLBACK', true));
}

export function createTelephonyProvider() {
  return new (pick(TELEPHONY_PROVIDERS, 'TELEPHONY_PROVIDER', 'exotel'))();
}

export function createVoiceProvider() {
  const voice = new (pick(VOICE_PROVIDERS, 'VOICE_PROVIDER', 'sarvam'))();

  // STT can be swapped while running (dashboard settings): only the hearing changes, TTS and everything
  // else stay on the voice provider. A failing/slow external STT falls back to the built-in one per utterance.
  const builtIn = voice.speechToText.bind(voice);
  let external = null; // CactusSttService, built lazily from the current settings
  voice.stt = { engine: getEnv('STT_PROVIDER', 'default').toLowerCase() === 'cactus' ? 'cactus' : 'default', url: '', model: '' };

  voice.configureStt = ({ engine, url, model } = {}) => {
    if (engine !== undefined && !['default', 'cactus'].includes(engine)) throw new Error(`Unknown STT engine "${engine}". Use: default, cactus.`);
    Object.assign(voice.stt, Object.fromEntries(Object.entries({ engine, url, model }).filter(([, v]) => v !== undefined)));
    external = null;
    console.log(`[STT] engine=${voice.stt.engine}`);
  };

  voice.speechToText = async (pcm, rate) => {
    if (voice.stt.engine !== 'cactus') return builtIn(pcm, rate);
    try {
      external ??= new CactusSttService({ url: voice.stt.url, model: voice.stt.model });
      return await external.transcribe(pcm, rate);
    } catch (err) {
      console.warn(`[STT] ${err.message} — falling back to the built-in STT for this utterance`);
      return builtIn(pcm, rate);
    }
  };
  return voice;
}
