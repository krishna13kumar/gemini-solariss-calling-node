/**
 * The per-turn contract of the knowledge tiers, with fake STT/LLM/embeddings:
 *  - instant hit  -> cached audio plays, the LLM answer is never used
 *  - context mode -> the LLM starts immediately (in parallel with the lookup) with ALL entries
 *  - retrieval mode -> the LLM starts only AFTER the lookup, with just the closest entries
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FaqStore } from '../src/faqStore.js';
import { CallSession } from '../src/callSession.js';

const KEYS = ['subsidy', 'office', 'warranty'];
let lookupDone;
const embed = async (texts) => { await new Promise(r => setTimeout(r, 40)); lookupDone = true; return texts.map(t => [...KEYS.map(k => (t.toLowerCase().includes(k) ? 1 : 0)), 0.01]); };

async function setup(contextCharBudget) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-flow-'));
  const store = new FaqStore({ filePath: path.join(dir, 'f.json'), audioDir: path.join(dir, 'a'), embed, contextCharBudget });
  await store.save({ entries: [{ question: 'subsidy amount', answer: 'ANSWER-SUBSIDY' }, { question: 'office address', answer: 'ANSWER-OFFICE' }], threshold: 0.85 });

  const engineCalls = [];
  // The fake LLM is slower to its first word than the (instant, fake) lookup, as a real model is: a reply the LLM can already
  // start is never held for the lookup, so an instant-fast LLM would legitimately win the race.
  const engine = { async *streamResponse(h, l, knowledge) { engineCalls.push({ knowledge, lookupWasDone: lookupDone }); await new Promise(r => setTimeout(r, 40)); yield 'LLM reply.'; } };
  const voice = { speechToText: async () => voice.heard, textToSpeech: async () => Buffer.alloc(3200, 7), supportsStreaming: () => false, getVoiceFingerprint: () => 'fake' };
  const audio = [], transcripts = [];
  const session = new CallSession({
    leadId: 'T', leadContext: null, dialogueEngine: engine, voiceProvider: voice, faqStore: store,
    sendAudio: async (pcm) => { audio.push(pcm); },
    onTranscript: (role, text, lat, meta) => transcripts.push({ role, text, faq: !!meta?.faq })
  });
  session.history.push({ role: 'assistant', content: 'வணக்கம். பேர் என்ன?' });
  const say = async (text) => { voice.heard = text; lookupDone = false; engineCalls.length = 0; audio.length = 0; transcripts.length = 0; await session.handleUserUtterance(Buffer.alloc(8000)); };
  return { store, session, say, engineCalls, audio, transcripts, dir };
}

// --- context mode (default budget) ---
let t = await setup(30000);
await t.say('ராஜா');                      // ordinary answer: no instant match, LLM gets everything
assert.equal(t.engineCalls.length, 1);
assert.equal(t.engineCalls[0].knowledge.length, 2);
assert.equal(t.engineCalls[0].lookupWasDone, false, 'LLM must start in parallel with the lookup, not after it');
assert.equal(t.transcripts.at(-1).faq, false);

await t.say('subsidy');                   // instant hit: cached audio plays, LLM output never spoken
assert.equal(t.transcripts.at(-1).faq, true);
assert.ok(t.transcripts.at(-1).text.startsWith('ANSWER-SUBSIDY'));
assert.ok(t.audio.length >= 1 && t.audio[0].length === 1066, 'plays the cached answer audio (24kHz cache resampled to the 8kHz session)');
assert.ok(!t.transcripts.some(x => x.text === 'LLM reply.'));
fs.rmSync(t.dir, { recursive: true, force: true });

// --- retrieval mode (set too big for context) ---
t = await setup(5);
await t.say('subsidy office');            // related to both entries but not a close match to either
assert.equal(t.engineCalls.length, 1);
assert.equal(t.engineCalls[0].lookupWasDone, true, 'in retrieval mode the LLM must wait for the lookup');
assert.deepEqual(t.engineCalls[0].knowledge.map(k => k.answer).sort(), ['ANSWER-OFFICE', 'ANSWER-SUBSIDY']);
fs.rmSync(t.dir, { recursive: true, force: true });

console.log('knowledge tier flow tests passed');
