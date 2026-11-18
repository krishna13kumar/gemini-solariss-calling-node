/**
 * Quick-answer knowledge store. Question/answer pairs serve two tiers:
 *  1. Instant: a close embedding match plays pre-generated audio — no LLM, no TTS.
 *  2. Grounded: everything else goes to the LLM with the Q&A as knowledge (whole set if it
 *     fits the context budget, otherwise the closest few by embedding — i.e. RAG).
 *
 * Embeddings are plain arrays in data/faq.json and matched with a linear cosine scan —
 * fine for hundreds of entries, no vector DB needed.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getEnv, getRequiredEnv } from './env.js';
import { resamplePcm } from './audioUtils.js';
import { nimPost } from './providers/llm/nvidia.js';
import { GoogleGenAI } from '@google/genai';

const NATIVE_RATE = 24000; // cached audio is stored at this rate, resampled to whatever the caller needs
// Saved questions AND live utterances are both embedded as input_type "query": on Tamil test data
// (nemotron-3-embed-1b) query/query matched 7/7 with the widest gap between real questions and
// ordinary answers ("வீடு", "5000"): hits >= 0.379, non-questions <= 0.208. query/passage gave a
// gap of only 0.059 — measured, not assumed. Scores are on a different scale from Gemini's, hence 0.30.
const INPUT_TYPE = 'query';
// Each embedding model has its own score scale, so the starting threshold depends on the provider.
// nvidia 0.30 was too low: re-measured with everyday answers, "சொல்லுங்க" scored 0.51 against "உங்க phone number
// சொல்லுங்க" and "ஆமா பேசுங்க" 0.27, so ordinary replies played the phone number. Genuine questions score 0.59-0.99
// when phrased like a saved one; weaker paraphrases (0.3-0.5) just fall through to the LLM, which has the whole Q&A
// in its prompt anyway — a miss costs a little time, a false hit gives the customer a wrong answer.
const DEFAULT_THRESHOLDS = { nvidia: 0.60, gemini: 0.85 };
// Bump when DEFAULT_THRESHOLDS are re-measured: saved files carrying an older version get the new default.
const THRESHOLD_VERSION = 2;
const EMBED_BATCH = 50;
// Largest knowledge base (characters of questions+answers) handed to the LLM whole. Measured with
// gemini-3.5-flash-lite: time-to-first-token was flat (~1.0-1.2s) from 0 up to 200 entries
// (31k chars / 11.7k tokens), so whole-context beats retrieval — no 500ms lookup before the LLM
// can start, and nothing missed. Past this, only the closest RETRIEVE_TOP_K entries are sent.
const CONTEXT_CHAR_BUDGET = 30000;
const RETRIEVE_TOP_K = 4;

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Starter entries — only facts already verified in knowledgeBase.js. Replace with your own.
const SEED_ENTRIES = [
  // One entry for every system size on purpose: embeddings barely distinguish "3 kW" from
  // "2 kW", so separate per-size entries would sometimes give the wrong size's answer.
  { question: 'solar-க்கு subsidy எவ்வளவு கிடைக்கும்? 1 kW, 2 kW, 3 kW-க்கு?', answer: '1 kW-க்கு Rs 30,000, 2 kW-க்கு Rs 60,000, 3 kW அல்லது அதுக்கு மேல உள்ள system-க்கு PM Surya Ghar திட்டத்துல அதிகபட்சம் Rs 78,000 subsidy கிடைக்கும்.' },
  { question: 'உங்க office எங்க இருக்கு?', answer: 'எங்க head office Chennai-ல ECR-ல, Injambakkam-ல இருக்கு. Salem, Dharmapuri, Hosur, Bangalore-லயும் எங்களுக்கு office இருக்கு.' },
  { question: 'ஒரு kW solar-க்கு எவ்வளவு terrace இடம் வேணும்?', answer: 'ஒரு kW-க்கு கிட்டத்தட்ட 100 square feet நிழல் விழாத terrace இடம் வேணும்.' },
  { question: 'net metering னா என்ன?', answer: 'Net metering-ல, பகல்ல உங்க solar-ல உற்பத்தியாகி மீதமிருக்குற unit-கள் TANGEDCO grid-க்கு போயிடும். அதுக்காகத்தான் bi-directional net meter வெக்கிறாங்க.' },
  { question: 'உங்க phone number சொல்லுங்க', answer: 'எங்க number, +91 79099 69999.' },
  { question: 'உங்க email id என்ன?', answer: 'எங்க email, np at geminisolaris dot com.' }
];

export class FaqStore {
  /**
   * @param {Object} [opts]
   * @param {(texts: string[]) => Promise<number[][]>} [opts.embed] injectable for tests
   */
  constructor({ filePath = './data/faq.json', audioDir = './data/faq_audio', embed, contextCharBudget = CONTEXT_CHAR_BUDGET } = {}) {
    this.contextCharBudget = contextCharBudget;
    this.filePath = filePath;
    this.audioDir = audioDir;
    // EMBEDDING_PROVIDER is deliberately separate from the live LLM switch: changing embedding models
    // means re-indexing every question, which you don't want happening each time the LLM is toggled.
    this.embedProvider = getEnv('EMBEDDING_PROVIDER', 'nvidia').toLowerCase();
    this.embedModel = this.embedProvider === 'gemini'
      ? getEnv('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001')
      : getEnv('NVIDIA_EMBEDDING_MODEL', 'nvidia/nemotron-3-embed-1b');
    this.embedKey = `${this.embedModel}:${this.embedProvider === 'gemini' ? 'CLASSIFICATION' : INPUT_TYPE}`;
    this.defaultThreshold = DEFAULT_THRESHOLDS[this.embedProvider] ?? DEFAULT_THRESHOLDS.nvidia;
    this.warming = false;

    if (embed) {
      this.embed = embed;
    } else if (this.embedProvider === 'gemini') {
      let ai;
      this.embed = async (texts) => {
        ai ??= new GoogleGenAI({ apiKey: getRequiredEnv('GEMINI_API_KEY') });
        const out = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
          const res = await ai.models.embedContent({
            model: this.embedModel,
            contents: texts.slice(i, i + EMBED_BATCH),
            config: { taskType: 'CLASSIFICATION', outputDimensionality: 768 }
          });
          out.push(...res.embeddings.map(e => e.values));
        }
        return out;
      };
    } else {
      const embedBatch = async (input) => {
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await nimPost('embeddings', { model: this.embedModel, input, input_type: INPUT_TYPE, encoding_format: 'float', truncate: 'END' });
            return (await res.json()).data.sort((a, b) => a.index - b.index).map(d => d.embedding);
          } catch (err) {
            if (attempt === 2 || !/429|503/.test(err.message)) throw err;
            await new Promise(r => setTimeout(r, 400));
          }
        }
      };
      this.embed = async (texts) => {
        const out = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...await embedBatch(texts.slice(i, i + EMBED_BATCH)));
        return out;
      };
    }
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      const file = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.threshold = file.threshold ?? this.defaultThreshold;
      if (file.thresholdVersion !== THRESHOLD_VERSION) this.threshold = this.defaultThreshold;
      this.entries = file.entries || [];
      // Embeddings (and the threshold tuned on them) from a different model/input type aren't comparable — drop and recompute.
      if (file.embedKey !== this.embedKey) {
        this.entries.forEach(e => { e.embedding = null; });
        this.threshold = this.defaultThreshold;
      }
    } else {
      this.threshold = this.defaultThreshold;
      this.entries = SEED_ENTRIES.map(e => ({ id: crypto.randomUUID().slice(0, 8), ...e, embedding: null }));
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ embedKey: this.embedKey, thresholdVersion: THRESHOLD_VERSION, threshold: this.threshold, entries: this.entries }));
  }

  /** Embeds any entry that doesn't have a current embedding yet (seed data, model change). */
  async ensureEmbedded() {
    const missing = this.entries.filter(e => !e.embedding);
    if (missing.length === 0) { this._persist(); return 0; }
    const vectors = await this.embed(missing.map(e => e.question));
    missing.forEach((e, i) => { e.embedding = vectors[i]; });
    this._persist();
    return missing.length;
  }

  /**
   * Replaces the whole list from the UI grid. Only entries that are new or whose
   * question text changed get re-embedded — editing just an answer is free.
   */
  async save({ entries, threshold }) {
    if (!Array.isArray(entries)) throw new Error('"entries" must be an array.');
    const t = Number(threshold);
    if (!(t >= 0.1 && t <= 0.99)) throw new Error('threshold must be between 0.1 and 0.99.');

    const previous = new Map(this.entries.map(e => [e.id, e]));
    this.entries = entries
      .map(e => ({ question: String(e.question || '').trim(), answer: String(e.answer || '').trim(), id: e.id }))
      .filter(e => e.question && e.answer)
      .map(e => {
        const old = e.id && previous.get(e.id);
        return {
          id: old ? e.id : crypto.randomUUID().slice(0, 8),
          question: e.question,
          answer: e.answer,
          embedding: old && old.question === e.question ? old.embedding : null
        };
      });
    this.threshold = t;
    const embedded = await this.ensureEmbedded();
    return { count: this.entries.length, embedded };
  }

  /** Every entry ranked by similarity to the text (used by match() and the UI's test box). */
  async search(text) {
    const q = String(text || '').trim();
    const indexed = this.entries.filter(e => e.embedding);
    if (!q || indexed.length === 0) return [];
    const [vec] = await this.embed([q]);
    return indexed.map(entry => ({ entry, score: cosine(vec, entry.embedding) })).sort((a, b) => b.score - a.score);
  }

  // --- Grounding knowledge for the LLM ---------------------------------------

  knowledgeChars() {
    return this.entries.reduce((n, e) => n + e.question.length + e.answer.length, 0);
  }

  /** True when the whole Q&A set can go to the LLM as context (no retrieval step needed). */
  fitsInContext() {
    return this.knowledgeChars() <= this.contextCharBudget;
  }

  allKnowledge() {
    return this.entries.map(e => ({ question: e.question, answer: e.answer }));
  }

  /** Closest entries from a search() result — used only when the set is too big for context. */
  retrieved(ranked) {
    return ranked.slice(0, RETRIEVE_TOP_K).map(r => ({ question: r.entry.question, answer: r.entry.answer }));
  }

  // --- Cached answer audio ------------------------------------------------

  _fingerprint(voice) {
    return voice.getVoiceFingerprint?.() ?? voice.constructor.name;
  }

  _audioPath(entry, voice) {
    const hash = crypto.createHash('sha1').update(`${this._fingerprint(voice)}|${NATIVE_RATE}|${entry.answer}`).digest('hex').slice(0, 16);
    return path.join(this.audioDir, `${hash}.pcm`);
  }

  hasAudio(entry, voice) {
    return fs.existsSync(this._audioPath(entry, voice));
  }

  /** Cached PCM for this text in the current voice at `rate` Hz; synthesizes + caches (at the native rate) on first use. */
  async getAudio(entry, voice, rate = 8000) {
    const file = this._audioPath(entry, voice);
    let pcm = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!pcm) {
      pcm = await voice.textToSpeech(entry.answer, NATIVE_RATE);
      if (pcm) {
        fs.mkdirSync(this.audioDir, { recursive: true });
        fs.writeFileSync(file, pcm);
      }
    }
    return pcm && resamplePcm(pcm, NATIVE_RATE, rate);
  }

  /** Pre-synthesizes every answer (plus any fixed `phrases`, e.g. the greeting) that has no cached audio yet (spends TTS credits once per text). */
  async warm(voice, phrases = []) {
    if (this.warming) return;
    this.warming = true;
    try {
      for (const entry of [...this.entries, ...phrases.map(answer => ({ answer, question: answer }))]) {
        if (this.hasAudio(entry, voice)) continue;
        try { await this.getAudio(entry, voice); }
        catch (err) { console.warn(`[FaqStore] Couldn't pre-generate audio for "${entry.question}":`, err.message); }
      }
    } finally {
      this.warming = false;
    }
  }

  describe(voice) {
    return {
      threshold: this.threshold,
      warming: this.warming,
      mode: this.fitsInContext() ? 'context' : 'retrieval',
      chars: this.knowledgeChars(),
      budget: this.contextCharBudget,
      topK: RETRIEVE_TOP_K,
      entries: this.entries.map(e => ({
        id: e.id, question: e.question, answer: e.answer,
        indexed: !!e.embedding, audioReady: this.hasAudio(e, voice)
      }))
    };
  }
}
