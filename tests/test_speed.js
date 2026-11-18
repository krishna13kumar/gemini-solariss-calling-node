import assert from 'node:assert/strict';
import { CallSession, RETRY_LINE } from '../src/callSession.js';
import { resamplePcm } from '../src/audioUtils.js';

// Downsampling averages (anti-alias) and tolerates an odd-offset Buffer; upsampling still interpolates.
const loud = Buffer.alloc(48); for (let i = 0; i < 24; i++) loud.writeInt16LE(i % 2 ? 1000 : -1000, i * 2); // Nyquist-rate tone
const down = resamplePcm(loud, 24000, 8000);
assert.equal(down.length, 16);
for (let i = 0; i < down.length; i += 2) assert.ok(Math.abs(down.readInt16LE(i)) < 400, 'high-frequency content is averaged out, not aliased');
assert.equal(resamplePcm(Buffer.alloc(100), 8000, 24000).length, 300);

// Speculative STT: the transcript started early is reused when the turn ends unchanged, and dropped if it changed.
let sttCalls = 0;
const voice = { speechToText: async () => { sttCalls++; return 'ராஜா'; }, textToSpeech: async () => Buffer.alloc(320), supportsStreaming: () => false };
const engine = { async *streamResponse() { yield 'சரி.'; } };
const make = () => new CallSession({ leadId: 'T', leadContext: null, dialogueEngine: engine, voiceProvider: voice, sendAudio: async () => {}, onTranscript: () => {} });

let s = make();
const turn = Buffer.alloc(8000);
s.prefetchStt(turn);
await s.handleUserUtterance(turn);
assert.equal(sttCalls, 1, 'same audio: reuse the speculative result');

sttCalls = 0; s = make();
s.prefetchStt(Buffer.alloc(4000)); // they kept talking, so the final buffer is longer
await s.handleUserUtterance(turn);
assert.equal(sttCalls, 2, 'different audio: transcribe the real one');

// A failed speculative call falls back to a normal one.
sttCalls = 0; s = make();
voice.speechToText = async () => { sttCalls++; if (sttCalls === 1) throw new Error('boom'); return 'ராஜா'; };
s.prefetchStt(turn);
await s.handleUserUtterance(turn);
assert.equal(sttCalls, 2);

// Fixed lines come from the audio cache when it has them (no TTS call), and stream otherwise.
const played = []; let tts = 0;
const faq = { hasAudio: () => true, getAudio: async () => Buffer.alloc(640, 1) };
const v2 = { speechToText: async () => '', textToSpeech: async () => { tts++; return Buffer.alloc(320); }, supportsStreaming: () => false };
s = new CallSession({ leadId: 'T', leadContext: null, dialogueEngine: engine, voiceProvider: v2, faqStore: faq, sendAudio: async p => played.push(p.length), onTranscript: () => {} });
await s.speakFixed(RETRY_LINE);
assert.deepEqual(played, [640]);
assert.equal(tts, 0);
faq.hasAudio = () => false;
await s.speakFixed(RETRY_LINE);
assert.equal(played.length, 2);

console.log('speed tests passed');

// Echo guard: Kavya's own sentence coming back is ignored; a real (even similar-sounding) answer is not.
{
  const { looksLikeEcho } = await import('../src/callSession.js');
  const bot = 'சரி சார். உங்க terrace சொந்த individual terrace-ஆ, இல்ல apartment-ல் common roof-ஆ?';
  assert.equal(looksLikeEcho('உங்க terrace சொந்த individual terrace ஆ இல்ல apartment ல் common roof ஆ', bot), true);
  assert.equal(looksLikeEcho('இல்ல apartment-ல் common roof-ஆ', bot), true); // one sentence fragment, verbatim
  assert.equal(looksLikeEcho('தனி வீடு, individual', bot), false);
  assert.equal(looksLikeEcho('சொந்த வீடு தான்', bot), false);
  assert.equal(looksLikeEcho('ஆமா', bot), false);
  assert.equal(looksLikeEcho('anything at all here ok', null), false);
}

// A failed (empty) speculative transcription is not trusted: the final audio is transcribed again.
{
  let calls = 0;
  const v = { speechToText: async () => (++calls === 1 ? '' : 'ராஜா'), textToSpeech: async () => Buffer.alloc(320), supportsStreaming: () => false };
  const heard = [];
  const s = new CallSession({ leadId: 'T', leadContext: null, dialogueEngine: { async *streamResponse() { yield 'சரி.'; } }, voiceProvider: v, sendAudio: async () => {}, onTranscript: (r, t) => r === 'user' && heard.push(t) });
  const audio = Buffer.alloc(8000);
  s.prefetchStt(audio); // fails -> ''
  await s.handleUserUtterance(audio);
  assert.deepEqual(heard, ['ராஜா']);
  assert.equal(calls, 2);
}

// Speculative calls per turn are capped.
{
  let calls = 0;
  const v = { speechToText: async () => { calls++; return 'x'; }, textToSpeech: async () => null, supportsStreaming: () => false };
  const s = new CallSession({ leadId: 'T', leadContext: null, dialogueEngine: {}, voiceProvider: v, sendAudio: async () => {}, onTranscript: () => {} });
  for (const n of [4000, 5000, 6000, 7000]) s.prefetchStt(Buffer.alloc(n));
  assert.equal(calls, 2);
}
console.log('echo/prefetch guard tests passed');

// Instant answers: a one- or two-word reply never triggers one unless it's a near-exact match.
{
  const { isFaqHit } = await import('../src/callSession.js');
  const faq = { threshold: 0.6 };
  assert.equal(isFaqHit({ score: 0.51 }, faq, 'சொல்லுங்க'), false);          // below threshold
  assert.equal(isFaqHit({ score: 0.7 }, faq, 'சொல்லுங்க'), false);           // one word, not near-exact
  assert.equal(isFaqHit({ score: 0.9 }, faq, 'net metering'), true);        // short but near-exact
  assert.equal(isFaqHit({ score: 0.7 }, faq, 'subsidy எவ்வளவு கிடைக்கும்'), true);
  assert.equal(isFaqHit(undefined, faq, 'x y z'), false);
}
console.log('faq-hit guard tests passed');
