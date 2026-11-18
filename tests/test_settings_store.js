import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/settingsStore.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')), 'settings.json');
const s = new SettingsStore(file);
assert.deepEqual(s.get(), {});
s.update({ llm: { provider: 'gemini', models: { gemini: 'g1' } } });
s.update({ llm: { fallback: false, models: { nvidia: 'n1' } }, stt: { engine: 'cactus' } });
assert.deepEqual(s.get(), { llm: { provider: 'gemini', fallback: false, models: { gemini: 'g1', nvidia: 'n1' } }, stt: { engine: 'cactus' } });
assert.deepEqual(new SettingsStore(file).get(), s.get()); // survives a restart
fs.writeFileSync(file, '{ not json');
assert.deepEqual(new SettingsStore(file).get(), {}); // corrupt file never blocks startup
console.log('settings store tests passed');
