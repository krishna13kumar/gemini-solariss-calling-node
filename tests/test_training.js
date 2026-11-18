import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrainingStore } from '../src/trainingStore.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'train-')), 'training.json');
const store = new TrainingStore(file);
assert.equal(store.promptBlock(), '');
const a = store.add('subsidy evlo?', '3 kW-க்கு Rs 78,000 சார்.');
store.add('subsidy evlo?', '3 kW-க்கு Rs 78,000 சார்.'); // duplicate is not stored twice
assert.equal(store.list().length, 1);
assert.throws(() => store.add('', 'x'));
assert.ok(store.promptBlock().includes('Customer: subsidy evlo?\nKavya: 3 kW-க்கு Rs 78,000 சார்.'));
assert.equal(new TrainingStore(file).list().length, 1); // persisted
for (let i = 0; i < 20; i++) store.add(`q${i}`, `a${i}`);
assert.ok(!store.promptBlock().includes('q0\n') && store.promptBlock().includes('q19')); // newest 15 only
store.remove(a.id);
assert.ok(!store.list().some(e => e.id === a.id));
console.log('training store tests passed');
