import assert from 'node:assert/strict';
import { toTurns, guessTelecaller } from '../src/transcription.js';

const turns = toTurns([
  { transcript: 'Hello?', start_time_seconds: 0, end_time_seconds: 1, speaker_id: '1' },
  { transcript: 'Vanakkam sir, calling from Gemini Solariss.', start_time_seconds: 1, end_time_seconds: 4, speaker_id: '0' },
  { transcript: 'You can get Rs 78,000 subsidy for 3 kW.', start_time_seconds: 4, end_time_seconds: 7, speaker_id: '0' },
  { transcript: '  ', start_time_seconds: 7, end_time_seconds: 8, speaker_id: '1' },
  { transcript: 'Okay, tell me more.', start_time_seconds: 8, end_time_seconds: 10, speaker_id: '1' }
]);

assert.equal(turns.length, 3);
assert.equal(turns[1].text, 'Vanakkam sir, calling from Gemini Solariss. You can get Rs 78,000 subsidy for 3 kW.');
assert.deepEqual([turns[1].start, turns[1].end], [1, 7]);
assert.equal(guessTelecaller(turns), '0');
console.log('transcription turn-merging tests passed');
