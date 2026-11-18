/**
 * Shared real-time conversation engine — one instance per call, used by both the
 * Exotel WebSocket bridge and the local-microphone test bridge.
 *
 * Latency strategy: Sarvam's streaming TTS WebSocket (~300-700ms time-to-first-audio,
 * measured live) replaces the batch REST endpoint (~3s+ for the same text) whenever
 * the active voice supports it — one persistent socket per call, reused across every
 * turn. Audio for each sentence starts playing as soon as the first chunk streams
 * back, not after the whole sentence finishes synthesizing. Cloned voices don't
 * support the streaming endpoint yet, so they fall back to a REST pipeline that still
 * pipelines sentence N+1's synthesis while sentence N plays — slower, but not serial.
 * The remaining floor is real network time to Sarvam STT + Gemini — not literally zero.
 */

const SENTENCE_END = /([.!?।॥]|\n)\s*/;

// Fixed lines Kavya says without the LLM. Their audio is pre-generated at startup and played from
// cache — no TTS round-trip, so the retry reaches the customer instantly.
export const RETRY_LINE = 'மன்னிக்கணும் சார், புரியல — இன்னொரு தடவ சொல்லுங்க?';
export const NOISY_RETRY_LINE = 'மன்னிக்கணும் சார், உங்க பக்கம் background-ல சத்தம் அதிகமா இருக்கு, தெளிவா கேக்கல. கொஞ்சம் அமைதியான இடத்துல இருந்து இன்னொரு தடவ சொல்லுங்க?';

/** Lowercase letters/digits only (any script), for comparing speech transcripts with Kavya's own words. */
const squash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * True when what was "heard" is really Kavya's own voice coming back through the speakers (not the customer).
 * A genuine answer rarely repeats 14+ characters of the question verbatim; an echo is nearly all of one of her
 * sentences. Left unchecked, the echo is answered as if the customer said it — the "keeps repeating the same
 * question" loop.
 */
export function looksLikeEcho(heard, botText) {
  const u = squash(heard);
  if (u.length < 14 || !botText) return false;
  const candidates = [botText, ...botText.split(/(?<=[.!?।])\s+/)].map(squash).filter(Boolean);
  return candidates.some(c => c.includes(u) || dice(u, c) >= 0.8);
}

/**
 * Instant-answer eligibility: a close embedding match, and not a one- or two-word utterance ("சொல்லுங்க", "ஆமா")
 * unless it is a near-exact match — short replies score deceptively high against short saved questions.
 */
export function isFaqHit(top, faq, userText) {
  if (!top || !faq || top.score < faq.threshold) return false;
  const words = userText.trim().split(/\s+/).length;
  return words >= 3 || top.score >= 0.85;
}

/** The last question Kavya asked, so a FAQ answer can hand the conversation back to it. */
export function lastAssistantQuestion(history) {
  const last = [...history].reverse().find(m => m.role === 'assistant');
  if (!last) return null;
  const sentences = last.content.split(/(?<=[.!?।])\s+/);
  return sentences.reverse().find(s => s.includes('?'))?.trim() || null;
}

export class CallSession {
  /**
   * @param {Object} opts
   * @param {string} opts.leadId
   * @param {Object|null} opts.leadContext
   * @param {Object} opts.dialogueEngine - LLM provider
   * @param {Object} opts.voiceProvider - voice provider (STT + TTS)
   * @param {(pcm8k: Buffer) => Promise<void>} opts.sendAudio - delivers synthesized audio to the call/browser
   * @param {(role: 'user'|'bot', text: string, latencyMs?: number, meta?: {faq?: boolean, score?: number}) => void} opts.onTranscript
   * @param {(message: string) => void} [opts.onError]
   * @param {import('./faqStore.js').FaqStore} [opts.faqStore] quick answers that bypass the LLM
   * @param {(stage: string, data?: Object) => void} [opts.onEvent] live pipeline trace for the dashboard (fire-and-forget)
   */
  constructor({ leadId, leadContext, dialogueEngine, voiceProvider, sendAudio, onTranscript, onError, onEvent, faqStore, textOnly = false, sampleRate = 8000 }) {
    this.leadId = leadId;
    this.leadContext = leadContext;
    this.dialogueEngine = dialogueEngine;
    this.voiceProvider = voiceProvider;
    this.sendAudio = sendAudio;
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onEvent = onEvent || (() => {});
    this.faq = faqStore || null;
    this.textOnly = textOnly; // chat mode: same brain, no STT/TTS
    this.sampleRate = sampleRate; // PCM rate of everything handed to sendAudio (8000 on phone lines, higher for the local browser)
    this._prefetch = null;
    this._prefetchCount = 0;

    this.history = [];
    this.isProcessing = false;
    this.interrupted = false;
    this.ttsSocket = null;
    this.ttsSocketPromise = null;
    this.speakQueue = Promise.resolve();
  }

  async getTtsSocket() {
    if (!this.voiceProvider.supportsStreaming?.()) return null;
    if (this.ttsSocket) return this.ttsSocket;
    if (!this.ttsSocketPromise) {
      this.ttsSocketPromise = this.voiceProvider.createStreamingSocket(this.sampleRate)
        .then(socket => { this.ttsSocket = socket; return socket; })
        .catch(err => {
          console.error('[CallSession] Could not open streaming TTS socket, falling back to REST:', err.message);
          this.ttsSocketPromise = null;
          return null;
        });
    }
    return this.ttsSocketPromise;
  }

  /**
   * Synthesizes and plays one sentence, using streaming TTS when available.
   * Serialized against every other call (greeting, replies, retry prompts) via
   * speakQueue — the streaming socket has a single message-handler slot, so two
   * concurrent callers would have their audio chunks misrouted/interleaved into
   * each other's playback (heard as overlapping, garbled audio). This is the one
   * place that guarantee needs to live, not something every caller re-implements.
   */
  speakSentence(sentence) {
    return this._serialize(() => this._speakSentenceNow(sentence));
  }

  _serialize(fn) {
    const task = this.speakQueue.then(fn);
    this.speakQueue = task.catch(() => {}); // keep the queue alive even if this one failed
    return task;
  }

  /**
   * Plays a preset answer from the audio cache — no LLM, no TTS round-trip. The
   * question Kavya had pending is re-asked afterwards (its TTS starts now, while the
   * answer plays) so the conversation picks up where it was instead of going quiet.
   */
  async answerFromFaq({ entry, score }, startedAt) {
    const reask = lastAssistantQuestion(this.history);
    const reaskPcm = reask && !this.textOnly ? this.voiceProvider.textToSpeech(reask, this.sampleRate).catch(() => null) : null;

    const spoken = reask ? `${entry.answer} ${reask}` : entry.answer;
    this.history.push({ role: 'assistant', content: spoken });
    this.onTranscript('bot', spoken, Date.now() - startedAt, { faq: true, score });
    this.onEvent('tts', { status: 'cached_audio', ms: Date.now() - startedAt });
    console.log(`[CallSession] ⚡ FAQ hit (${score.toFixed(3)}): "${entry.question}" in ${Date.now() - startedAt}ms`);

    if (this.textOnly) return;
    const pcm = await this.faq.getAudio(entry, this.voiceProvider, this.sampleRate);
    await this._serialize(async () => { if (pcm && !this.interrupted) await this.sendAudio(pcm); });

    if (reask && !this.interrupted) {
      const reaskAudio = await reaskPcm;
      if (reaskAudio) await this._serialize(() => this.sendAudio(reaskAudio));
      else await this.speakSentence(reask);
    }
  }

  async _speakSentenceNow(sentence) {
    const socket = await this.getTtsSocket();
    if (socket) {
      await this.voiceProvider.streamTextToSpeech(socket, sentence, async (chunk) => {
        if (this.interrupted) return;
        this._onFirstAudio?.();
        await this.sendAudio(chunk);
      });
    } else {
      const pcm = await this.voiceProvider.textToSpeech(sentence, this.sampleRate);
      if (pcm && !this.interrupted) { this._onFirstAudio?.(); await this.sendAudio(pcm); }
    }
  }

  /** Plays a fixed line from the audio cache when it's there (instant); otherwise streams it like any sentence. */
  async speakFixed(text) {
    const entry = { answer: text };
    if (this.faq?.hasAudio(entry, this.voiceProvider)) {
      const pcm = await this.faq.getAudio(entry, this.voiceProvider, this.sampleRate);
      if (pcm) return this._serialize(() => this.sendAudio(pcm));
    }
    return this.speakSentence(text);
  }

  /**
   * Speculative STT: the server calls this once the customer has been quiet for a fraction of the
   * end-of-turn window. Transcription runs during the rest of that window; if they really are done,
   * handleUserUtterance reuses the result (the STT time vanishes), and if they resume speaking the
   * buffer differs and this is simply discarded.
   */
  prefetchStt(pcmBuffer) {
    // Capped per turn: a speaker who pauses a lot would otherwise fire several STT calls per answer and risk the provider's rate limit.
    if (this.isProcessing || this.textOnly || this._prefetch?.length === pcmBuffer.length || this._prefetchCount >= 2) return;
    this._prefetchCount++;
    this._prefetch = { length: pcmBuffer.length, promise: this.voiceProvider.speechToText(pcmBuffer, 8000).catch(() => null) };
  }

  /**
   * Speaks a fixed line (e.g. the opening greeting) with no LLM involved.
   * Marks the session busy for the duration — without this, VAD keeps listening
   * while the greeting itself is playing, and (especially without a headset) the
   * greeting's own audio bleeding back into the mic gets captured as "the customer
   * spoke", STT returns nothing usable, and the retry prompt fires before the
   * customer ever got a chance to say anything.
   */
  async speak(text) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      this.history.push({ role: 'assistant', content: text });
      this.onTranscript('bot', text);
      if (!this.textOnly) await this.speakFixed(text);
    } finally {
      this.isProcessing = false;
    }
  }

  /** Stops queued/playing audio — call this the moment the caller barges in. */
  interrupt() {
    this.interrupted = true;
  }

  /** Closes the persistent TTS socket — call when the underlying call/connection ends. */
  close() {
    if (this.ttsSocket) {
      try { this.ttsSocket.close(); } catch {}
      this.ttsSocket = null;
    }
  }

  /**
   * Transcribes the customer's utterance, streams a reply from the LLM, and
   * speaks it back sentence-by-sentence as each one completes.
   */
  async handleUserUtterance(pcmBuffer, { noisy = false } = {}) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.interrupted = false;

    try {
      const t0 = Date.now();
      const early = this._prefetch?.length === pcmBuffer.length ? this._prefetch.promise : null;
      this._prefetch = null;
      this._prefetchCount = 0;
      this.onEvent('stt', { status: 'start', bytes: pcmBuffer.length, noisy, speculative: !!early });
      let userText = early ? await early : null;
      // The provider returns '' for failures (rate limit, timeout) as well as for silence, so an empty
      // early result is never trusted: ask again with the real, final audio.
      const usedEarly = !!userText?.trim();
      if (!usedEarly) userText = await this.voiceProvider.speechToText(pcmBuffer, 8000);
      const sttLatency = Date.now() - t0; // after a speculative hit this is only the wait left over
      this.onEvent('stt', { status: 'done', ms: sttLatency, text: userText?.trim() || '', speculative: usedEarly });
      if (!userText || !userText.trim()) {
        // Not an error — STT legitimately returns empty for noise/unclear audio —
        // but silently doing nothing here is indistinguishable from the pipeline
        // hanging. Say so and let the customer try again, like a human would.
        console.log(`[CallSession] STT returned empty (${pcmBuffer.length} bytes, ${sttLatency}ms, noisy=${noisy}) — asking customer to repeat.`);
        // If the room was loud, say that instead of a generic "didn't catch that" — the
        // customer can fix it (move somewhere quieter), and the operator sees why on the dashboard.
        if (noisy) this.onError('🔊 Background noise is making it hard to hear — the last reply couldn\'t be understood. Ask the customer to move somewhere quieter or use a headset.');
        const retryText = noisy ? NOISY_RETRY_LINE : RETRY_LINE;
        this.onEvent('retry', { noisy });
        this.onTranscript('bot', retryText);
        await this.speakFixed(retryText);
        return;
      }

      const lastBot = [...this.history].reverse().find(m => m.role === 'assistant')?.content;
      if (looksLikeEcho(userText, lastBot)) {
        console.log(`[CallSession] Ignoring echo of Kavya's own voice: "${userText.trim().slice(0, 60)}"`);
        this.onEvent('echo', { text: userText.trim() });
        return;
      }

      await this._respond(userText, sttLatency);
    } catch (err) {
      console.error('[CallSession] Error handling utterance:', err);
      this.onError(err.message);
    } finally {
      this.isProcessing = false;
      this.onEvent('idle');
    }
  }

  /** Chat entry point: the customer typed their message, so skip speech-to-text. */
  async handleUserText(userText) {
    if (this.isProcessing || !userText?.trim()) return;
    this.isProcessing = true;
    this.interrupted = false;
    try {
      await this._respond(userText.trim(), null);
    } catch (err) {
      console.error('[CallSession] Error handling chat message:', err);
      this.onError(err.message);
    } finally {
      this.isProcessing = false;
      this.onEvent('idle');
    }
  }

  /** Everything after we know what the customer said: quick-answer lookup, LLM, speaking. */
  async _respond(userText, sttLatency) {
    {
      this.history.push({ role: 'user', content: userText });
      this.onTranscript('user', userText, sttLatency);

      const t1 = Date.now();

      // Two tiers off one lookup (~500ms embedding call):
      //  1. a close match plays the cached answer — no LLM, no TTS;
      //  2. otherwise the LLM answers with the Q&A as knowledge. If that knowledge fits in
      //     context it's sent whole, so the LLM request starts NOW, in parallel with the lookup
      //     (a miss costs no extra latency, a hit just abandons the stream). Only an oversized
      //     set has to wait for retrieval to pick the closest entries (true RAG, ~+0.5s).
      const faq = this.faq;
      const lookup = faq
        ? faq.search(userText).catch(err => { console.warn('[CallSession] FAQ lookup failed, answering without it:', err.message); return []; })
        : Promise.resolve([]);

      let llm = null;
      let firstStep = null;
      const startLlm = (knowledge) => {
        this.onEvent('llm', {
          status: 'start',
          mode: !faq ? 'no-knowledge' : faq.fitsInContext() ? 'full Q&A in prompt' : 'retrieved top entries',
          knowledgeEntries: knowledge?.length ?? 0,
          userText,
          context: this.history.slice(-6).map(m => ({ role: m.role, text: m.content }))
        });
        llm = this.dialogueEngine.streamResponse(this.history, this.leadContext, knowledge);
        firstStep = llm.next();
        firstStep.catch(() => {}); // a rejection on an abandoned stream must not become unhandled
      };
      if (!faq || faq.fitsInContext()) startLlm(faq ? faq.allKnowledge() : null);

      // The LLM request is already in flight (context mode). If its first word arrives before the
      // embedding lookup does, don't hold the reply for the lookup: the LLM has the whole Q&A anyway.
      const ranked = llm ? await Promise.race([lookup, firstStep.then(() => [], () => [])]) : await lookup;
      this.onEvent('faq', {
        ms: Date.now() - t1,
        topQuestion: ranked[0]?.entry.question ?? null,
        score: ranked[0]?.score ?? null,
        threshold: faq?.threshold ?? null,
        hit: isFaqHit(ranked[0], faq, userText)
      });
      if (isFaqHit(ranked[0], faq, userText)) {
        llm?.return().catch(() => {});
        await this.answerFromFaq(ranked[0], t1);
        return;
      }
      if (!llm) startLlm(faq.retrieved(ranked));

      let fullResponse = '';
      let sentenceBuffer = '';
      let firstAudioSent = false;
      this._onFirstAudio = () => {
        if (firstAudioSent) return;
        firstAudioSent = true;
        console.log(`[CallSession] ⏱️ First audio out ${Date.now() - t1}ms after the transcript (LLM + TTS)`);
        this.onEvent('tts', { status: 'first_audio', ms: Date.now() - t1 });
      };

      // Non-streaming (cloned-voice) fallback still pipelines: synthesis of
      // sentence N+1 starts while sentence N plays, instead of waiting serially.
      const usingStreamingVoice = this.voiceProvider.supportsStreaming?.() ?? false;
      const playQueue = [];
      let draining = false;
      const enqueueFallback = (sentence) => {
        const synthesisPromise = this.voiceProvider.textToSpeech(sentence, this.sampleRate).catch(err => {
          console.error('[CallSession] TTS error:', err.message);
          return null;
        });
        playQueue.push(synthesisPromise);
        if (!draining) drainFallbackQueue();
      };
      const drainFallbackQueue = async () => {
        draining = true;
        while (playQueue.length > 0) {
          if (this.interrupted) { playQueue.length = 0; break; }
          const pcm = await playQueue.shift();
          if (pcm && !this.interrupted) {
            this._onFirstAudio?.();
            await this.sendAudio(pcm);
          }
        }
        draining = false;
      };

      const speakOrEnqueue = async (sentence) => {
        this.onEvent('llm', { status: 'sentence', text: sentence });
        if (this.textOnly) return;
        if (usingStreamingVoice) {
          await this.speakSentence(sentence);
        } else {
          enqueueFallback(sentence);
        }
      };

      for (let step = await firstStep; !step.done; step = await llm.next()) {
        if (this.interrupted) { llm.return().catch(() => {}); break; }
        const token = step.value;
        if (!fullResponse) this.onEvent('llm', { status: 'first_token', ms: Date.now() - t1 });
        fullResponse += token;
        sentenceBuffer += token;
        let match;
        while ((match = SENTENCE_END.exec(sentenceBuffer))) {
          const sentence = sentenceBuffer.slice(0, match.index + match[0].length).trim();
          sentenceBuffer = sentenceBuffer.slice(match.index + match[0].length);
          if (sentence) await speakOrEnqueue(sentence);
        }
      }
      if (!this.interrupted && sentenceBuffer.trim()) await speakOrEnqueue(sentenceBuffer.trim());

      const llmLatency = Date.now() - t1;
      this.onEvent('llm', { status: 'done', ms: llmLatency, chars: fullResponse.length });
      this.history.push({ role: 'assistant', content: fullResponse });
      this.onTranscript('bot', fullResponse, llmLatency);

      while (draining || playQueue.length > 0) {
        await new Promise(r => setTimeout(r, 30));
      }
    }
  }
}
