/**
 * Audio utilities for the telephony/voice bridge: WAV<->PCM, resampling,
 * mu-law codec for Exotel, RMS energy for VAD, and chunking for streaming.
 */

export function pcmToWav(pcmBuffer, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const buffer = Buffer.alloc(44 + pcmBuffer.length);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

/** Strips a WAV header, returning the raw 16-bit PCM data chunk. */
export function wavToPcm(wavBuffer) {
  let offset = 12;
  while (offset < wavBuffer.length) {
    const chunkId = wavBuffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return wavBuffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  return wavBuffer.slice(44);
}

/** Reads the sample rate declared in a WAV file's "fmt " chunk. */
export function getWavSampleRate(wavBuffer) {
  let offset = 12;
  while (offset < wavBuffer.length) {
    const chunkId = wavBuffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      return wavBuffer.readUInt32LE(offset + 8 + 4); // AudioFormat(2) NumChannels(2) SampleRate(4)
    }
    offset += 8 + chunkSize;
  }
  return 22050;
}

/** Resamples 16-bit linear PCM via linear interpolation. */
export function resamplePcm(inputBuffer, fromRate, toRate) {
  if (fromRate === toRate) return inputBuffer;

  // Copy so the Int16Array view is always aligned (a pooled Buffer can start at an odd offset).
  const inputSamples = new Int16Array(inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.length - (inputBuffer.length % 2)));
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(inputSamples.length / ratio);
  const outputSamples = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    if (ratio > 1) {
      // Downsampling: average the source samples this output sample covers. Plain interpolation
      // aliases high frequencies into the voice band (harsh, "tinny" speech).
      const from = Math.floor(i * ratio), to = Math.min(inputSamples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += inputSamples[j];
      outputSamples[i] = Math.round(sum / (to - from));
      continue;
    }
    const inputIndex = i * ratio;
    const indexFloor = Math.floor(inputIndex);
    const indexCeil = Math.min(indexFloor + 1, inputSamples.length - 1);
    const weight = inputIndex - indexFloor;
    outputSamples[i] = Math.round(inputSamples[indexFloor] * (1 - weight) + inputSamples[indexCeil] * weight);
  }

  return Buffer.from(outputSamples.buffer, outputSamples.byteOffset, outputSamples.byteLength);
}

export function chunkPcm(buffer, chunkSize = 1600) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.slice(i, Math.min(i + chunkSize, buffer.length)));
  }
  return chunks;
}

/** RMS energy of a 16-bit PCM buffer, used for VAD (speech vs silence). */
export function getAudioEnergy(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;
  let sum = 0;
  const numSamples = Math.floor(pcmBuffer.length / 2);
  for (let i = 0; i < numSamples * 2; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / numSamples);
}

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

function pcm16ToMuLawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > ULAW_CLIP) sample = ULAW_CLIP;
  sample += ULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function muLawToPcm16Sample(ulawByte) {
  ulawByte = ~ulawByte;
  let sign = ulawByte & 0x80;
  let exponent = (ulawByte >> 4) & 0x07;
  let mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

export function pcmToMuLaw(pcmBuffer) {
  const numSamples = Math.floor(pcmBuffer.length / 2);
  const muLawBuffer = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    muLawBuffer[i] = pcm16ToMuLawSample(pcmBuffer.readInt16LE(i * 2));
  }
  return muLawBuffer;
}

export function muLawToPcm(muLawBuffer) {
  const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i++) {
    pcmBuffer.writeInt16LE(muLawToPcm16Sample(muLawBuffer[i]), i * 2);
  }
  return pcmBuffer;
}
