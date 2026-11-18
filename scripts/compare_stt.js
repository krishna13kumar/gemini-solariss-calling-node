/**
 * Side-by-side STT check on your own recordings: node scripts/compare_stt.js clip1.wav [clip2.wav ...]
 * Prints what Sarvam and Cactus each heard, and how long each took. Needs 16-bit mono PCM WAV files.
 */
import fs from 'node:fs';
import { SarvamVoiceService } from '../src/providers/voice/sarvam.js';
import { CactusSttService } from '../src/providers/stt/cactus.js';
import { wavToPcm, getWavSampleRate, resamplePcm } from '../src/audioUtils.js';

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node scripts/compare_stt.js clip.wav [more.wav ...]'); process.exit(1); }

const engines = { sarvam: new SarvamVoiceService(), cactus: new CactusSttService() };
const run = {
  sarvam: (pcm) => engines.sarvam.speechToText(pcm, 8000),
  cactus: (pcm) => engines.cactus.transcribe(pcm, 8000)
};

for (const file of files) {
  const wav = fs.readFileSync(file);
  const pcm = resamplePcm(wavToPcm(wav), getWavSampleRate(wav), 8000); // the call pipeline's rate
  console.log(`\n${file}  (${(pcm.length / 16000).toFixed(1)}s)`);
  for (const name of Object.keys(run)) {
    const t = Date.now();
    try { const text = await run[name](pcm); console.log(`  ${name.padEnd(7)} ${String(Date.now() - t).padStart(5)}ms  ${text}`); }
    catch (err) { console.log(`  ${name.padEnd(7)} FAILED: ${err.message}`); }
  }
}
