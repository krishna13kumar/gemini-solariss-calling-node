import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { LeadsStore } from '../src/leadsStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-'));
const main = path.join(dir, 'leads_completed.xlsx');
const store = new LeadsStore(path.join(dir, 'in.xlsx'), main);

assert.equal(store.upsertResult({ lead_id: 'A', Customer_Name: 'one' }), true);
assert.equal(store.upsertResult({ lead_id: 'A', Customer_Name: 'one-v2' }), true); // same lead overwrites
assert.deepEqual(store.listResults().map(r => r.Customer_Name), ['one-v2']);

// Excel has the sheet open (write fails with EBUSY): the row is parked, still listed, never lost.
const realWrite = xlsx.writeFile;
xlsx.writeFile = (wb, file, ...rest) => { if (file === main) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realWrite(wb, file, ...rest); };
assert.equal(store.upsertResult({ lead_id: 'B', Customer_Name: 'two' }), false);
assert.deepEqual(store.listResults().map(r => r.lead_id).sort(), ['A', 'B']);
assert.throws(() => store.deleteResults(['A']), /open in Excel/);

// Excel closed: the next read folds the parked row into the main sheet.
xlsx.writeFile = realWrite;
assert.deepEqual(store.listResults().map(r => r.lead_id).sort(), ['A', 'B']);
assert.equal(fs.existsSync(store.pendingPath), false);
assert.equal(store.deleteResults(['A']), 1);
assert.deepEqual(store.listResults().map(r => r.lead_id), ['B']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('results store tests passed');
