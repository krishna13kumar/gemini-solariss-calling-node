import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FaqStore, cosine } from '../src/faqStore.js';
import { lastAssistantQuestion } from '../src/callSession.js';

// Fake embedder: keyword presence vector, so similarity is predictable offline.
const KEYS = ['subsidy', 'office', 'home'];
let embeddedTexts = [];
const embed = async (texts) => { embeddedTexts.push(...texts); return texts.map(t => [...KEYS.map(k => (t.toLowerCase().includes(k) ? 1 : 0)), 0.01]); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-test-'));
const store = new FaqStore({ filePath: path.join(dir, 'faq.json'), audioDir: path.join(dir, 'audio'), embed });

// Seeds exist on first run and get indexed once.
assert.ok(store.entries.length > 0 && store.entries.every(e => e.embedding === null));
await store.ensureEmbedded();
assert.ok(store.entries.every(e => e.embedding));

// Matching: a paraphrase clears the threshold, an unrelated utterance doesn't, empty input finds nothing.
await store.save({ entries: [{ question: 'subsidy for 3kw', answer: 'A1' }, { question: 'office location', answer: 'A2' }], threshold: 0.85 });
const [top] = await store.search('how much subsidy do I get');
assert.equal(top.entry.answer, 'A1');
assert.ok(top.score >= store.threshold);
assert.ok((await store.search('home'))[0].score < store.threshold);
assert.deepEqual(await store.search(''), []);

// Knowledge for the LLM: whole set while it fits the budget, closest few once it doesn't.
assert.equal(store.fitsInContext(), true);
assert.deepEqual(store.allKnowledge().map(k => k.answer), ['A1', 'A2']);
assert.equal(store.describe({ constructor: { name: 'v' } }).mode, 'context');
const tiny = new FaqStore({ filePath: path.join(dir, 'faq.json'), audioDir: path.join(dir, 'audio'), embed, contextCharBudget: 5 });
assert.equal(tiny.fitsInContext(), false);
assert.equal(tiny.describe({ constructor: { name: 'v' } }).mode, 'retrieval');
assert.deepEqual(tiny.retrieved(await tiny.search('subsidy')).map(k => k.answer), ['A1', 'A2']); // ranked, A1 first

// Editing only an answer must not trigger a re-embed; editing the question must.
embeddedTexts = [];
const [e1, e2] = store.entries;
await store.save({ entries: [{ id: e1.id, question: e1.question, answer: 'changed' }, { id: e2.id, question: 'office address', answer: 'A2' }], threshold: 0.85 });
assert.deepEqual(embeddedTexts, ['office address']);

// Bad threshold is rejected.
await assert.rejects(() => store.save({ entries: [], threshold: 1.5 }));

// Audio cache: synthesized once per (voice, text); a voice change invalidates it.
let synths = 0;
const voice = { fp: 'kavya|1.0', getVoiceFingerprint() { return this.fp; }, textToSpeech: async () => { synths++; return Buffer.from([1, 2, 3, 4]); } };
await store.getAudio(store.entries[0], voice);
await store.getAudio(store.entries[0], voice);
assert.equal(synths, 1);
voice.fp = 'other|1.0';
assert.equal(store.hasAudio(store.entries[0], voice), false);
await store.getAudio(store.entries[0], voice);
assert.equal(synths, 2);

// Persistence round-trip keeps embeddings (no re-embed on restart).
embeddedTexts = [];
const reloaded = new FaqStore({ filePath: path.join(dir, 'faq.json'), audioDir: path.join(dir, 'audio'), embed });
assert.equal(await reloaded.ensureEmbedded(), 0);
assert.deepEqual(embeddedTexts, []);

// Re-asking the pending question after a FAQ answer.
assert.equal(lastAssistantQuestion([{ role: 'assistant', content: 'சரி சார். இது வீடா? இல்ல commercial-ஆ?' }, { role: 'user', content: 'x' }]), 'இல்ல commercial-ஆ?');
assert.equal(lastAssistantQuestion([{ role: 'assistant', content: 'நன்றி சார்.' }]), null);
assert.equal(lastAssistantQuestion([]), null);

assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
fs.rmSync(dir, { recursive: true, force: true });
console.log('faq store tests passed');
