import assert from 'node:assert/strict';
import { Vad } from '../src/vad.js';

// A frame whose RMS energy equals `level` exactly (constant-valued samples).
const frame = (level) => { const b = Buffer.alloc(2048); for (let i = 0; i < 1024; i++) b.writeInt16LE(level, i * 2); return b; };
const LOUD = 5000, SILENT = 0, NOISE = 300; 
const make = () => new Vad({ energyThreshold: 450, minSpeechFrames: 3, silenceFramesForTurnEnd: 4 });
const feed = (vad, level, n) => { let last = null; for (let i = 0; i < n; i++) last = vad.push(frame(level)) ?? last; return last; };

// Normal turn: 2 quiet frames of pre-roll + 4 voiced; ends after 5 quiet frames; trailing silence excluded.
let vad = make();
feed(vad, SILENT, 2);
assert.equal(feed(vad, LOUD, 4), null);
const turn = feed(vad, SILENT, 5);
assert.equal(turn.frames, 4);
assert.equal(turn.buffer.length, 6 * 2048);
assert.equal(turn.noisy, false);

// A brief blip never becomes a turn, and the detector recovers for the next one.
vad = make();
feed(vad, LOUD, 1);
assert.equal(feed(vad, SILENT, 5), null);
feed(vad, LOUD, 4);
assert.equal(feed(vad, SILENT, 5).frames, 4);

// Noisy room: speech barely above the room's own level is flagged; clear speech over the same room isn't.
vad = make();
feed(vad, NOISE, 40);
feed(vad, 800, 4); // threshold adapts to 2.5x300=750; 800 passes it but isn't 4x the room
assert.equal(feed(vad, NOISE, 5).noisy, true);
vad = make();
feed(vad, NOISE, 40);
feed(vad, LOUD, 4);
assert.equal(feed(vad, NOISE, 5).noisy, false); // clearly audible over the same room

// A quiet room is never called noisy, and a steady hum above the fixed threshold (AGC'd laptop mic)
// is learned as the room level, so turns still end instead of hanging.
vad = make();
feed(vad, 20, 40);
feed(vad, LOUD, 4);
assert.equal(feed(vad, SILENT, 5).noisy, false);
vad = make();
feed(vad, 600, 40); // above the 450 minimum
feed(vad, 5000, 4);
assert.equal(feed(vad, 600, 5).frames, 4);

// reset() drops a half-captured turn and its pre-roll.
vad = make();
feed(vad, SILENT, 2);
feed(vad, LOUD, 2);
vad.reset();
feed(vad, LOUD, 4);
assert.equal(feed(vad, SILENT, 5).buffer.length, 4 * 2048);

// Steady loud noise is learned as the room level (turn ends, flagged noisy) instead of hanging forever.
vad = make();
const steady = feed(vad, LOUD, 100);
assert.ok(steady && steady.noisy === true && steady.frames < 100);

console.log('vad tests passed');

// hold(): frames in the post-playback tail can't start a turn but are kept as pre-roll for an answer that begins in it.
{
  const v = make();
  v.hold(frame(LOUD)); v.hold(frame(LOUD)); v.hold(frame(LOUD)); // loud, but never a turn
  assert.equal(v.speechFrames, 0);
  feed(v, LOUD, 4);
  const t = feed(v, SILENT, 5);
  assert.equal(t.frames, 4);
  assert.equal(t.buffer.length, (2 + 4) * 2048); // 2 held pre-roll frames + 4 voiced
}
console.log('vad hold tests passed');
