import assert from 'node:assert/strict';
import { LlmRouter } from '../src/providers/llm/router.js';

const log = [];
const fake = (name, { fail = false, failAfter = null, json = null } = {}) => class {
  model = `${name}-model`;
  async *streamResponse() {
    log.push(name);
    if (fail) throw new Error(`${name} 429`);
    yield `${name} one `;
    if (failAfter) throw new Error(`${name} died mid-reply`);
    yield `${name} two`;
  }
  async generateJson() { if (fail) throw new Error(`${name} 503`); return { from: name }; }
};
const NoKey = class { constructor() { throw new Error('missing key'); } };
const collect = async (r) => { let s = ''; for await (const t of r.streamResponse([], null, null)) s += t; return s; };

// Availability and live switching.
let r = new LlmRouter({ gemini: fake('gemini'), nvidia: fake('nvidia'), ollama: NoKey }, 'gemini');
assert.deepEqual(r.available(), ['gemini', 'nvidia']);
assert.equal(r.model, 'gemini: gemini-model');
assert.equal(await collect(r), 'gemini one gemini two');
r.use('nvidia');
assert.equal(await collect(r), 'nvidia one nvidia two');
assert.throws(() => r.use('ollama'), /missing key/);
assert.throws(() => r.use('nope'), /Unknown LLM provider/);
assert.equal(r.active, 'nvidia'); // a failed switch changes nothing

// A provider that fails before its first word hands the turn to the other one.
log.length = 0;
r = new LlmRouter({ gemini: fake('gemini', { fail: true }), nvidia: fake('nvidia') }, 'gemini');
assert.equal(await collect(r), 'nvidia one nvidia two');
assert.deepEqual(log, ['gemini', 'nvidia']);

// ...but never mid-reply (would splice two models' sentences together).
r = new LlmRouter({ gemini: fake('gemini', { failAfter: true }), nvidia: fake('nvidia') }, 'gemini');
await assert.rejects(collect(r), /died mid-reply/);

// Fallback off: the error surfaces. Everything failing: the last error surfaces.
r = new LlmRouter({ gemini: fake('gemini', { fail: true }), nvidia: fake('nvidia') }, 'gemini', false);
await assert.rejects(collect(r), /gemini 429/);
r = new LlmRouter({ gemini: fake('gemini', { fail: true }), nvidia: fake('nvidia', { fail: true }) }, 'gemini');
await assert.rejects(collect(r), /nvidia 429/);

// The configured default must be usable at startup.
assert.throws(() => new LlmRouter({ gemini: NoKey, nvidia: fake('nvidia') }, 'gemini'), /missing key/);

// JSON completions (CRM extraction) follow the same switch + fallback.
r = new LlmRouter({ gemini: fake('gemini', { fail: true }), nvidia: fake('nvidia') }, 'gemini');
assert.deepEqual(await r.generateJson('x'), { from: 'nvidia' });

console.log('llm router tests passed');

// Per-provider model changes, and probing a model without touching the live one.
{
  const Prov = class { model = 'm1'; async *streamResponse() { if (this.model === 'typo') throw new Error('404 model not found'); yield 'ok'; } };
  const r = new LlmRouter({ gemini: Prov, nvidia: Prov }, 'gemini');
  assert.deepEqual(r.models(), { gemini: 'm1', nvidia: 'm1' });
  r.setModel('nvidia', 'm2');
  assert.deepEqual(r.models(), { gemini: 'm1', nvidia: 'm2' });
  const good = await r.probe('nvidia', 'm3');
  assert.ok(good.ok && good.sample === 'ok');
  assert.equal(r.models().nvidia, 'm2', 'probe must not change the live model');
  const bad = await r.probe('nvidia', 'typo');
  assert.ok(!bad.ok && /404/.test(bad.error));
}
console.log('llm model/probe tests passed');
