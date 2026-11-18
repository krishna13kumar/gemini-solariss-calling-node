/**
 * Energy-based voice activity detection for the call audio stream.
 *
 * Feed it fixed-size PCM frames; it returns a finished turn once the customer stops
 * talking, or null otherwise. The speech threshold adapts to the room: a laptop mic with
 * auto-gain often idles above any fixed threshold, which would mean no pause is ever seen
 * and no turn ever ends. `noisy` says speech barely rose above the room's own level, so an
 * empty transcript can fairly be blamed on background noise.
 */

import { getAudioEnergy } from './audioUtils.js';

const NOISE_WINDOW_FRAMES = 80;   // ~10s of recent frames used to estimate the room's level
const NOISE_PERCENTILE = 0.1;     // speech is rarely >90% of a 10s window, so this tracks the room
const MIN_FRAMES_FOR_FLOOR = 6;   // before this, only the configured minimum threshold applies
const SPEECH_OVER_FLOOR = 2.5;    // a frame must be this many times the room level to count as speech
const NOISY_MIN_FLOOR = 100;      // quieter rooms are never called noisy
const NOISY_SNR = 4;              // average speech louder than this x the room level = clearly audible

export class Vad {
  /**
   * @param {Object} opts
   * @param {number} opts.energyThreshold minimum RMS for speech (the adaptive threshold never goes below it)
   * @param {number} opts.minSpeechFrames voiced frames needed before a burst counts as a turn (filters blips)
   * @param {number} opts.silenceFramesForTurnEnd quiet frames that end a turn
   * @param {number} [opts.preRollFrames] quiet frames kept before speech starts so word onsets aren't clipped
   * @param {number} [opts.maxUtteranceFrames] force-end a turn after this many voiced frames
   */
  constructor({ energyThreshold, minSpeechFrames, silenceFramesForTurnEnd, preRollFrames = 2, maxUtteranceFrames = 100 }) {
    Object.assign(this, { minThreshold: energyThreshold, minSpeechFrames, silenceFramesForTurnEnd, preRollFrames, maxUtteranceFrames });
    this.recent = []; // energies of recent frames, for the room-level estimate
    this.preRoll = [];
    this._resetTurn();
  }

  _resetTurn() {
    this.buffer = Buffer.alloc(0);
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.speechEnergySum = 0;
  }

  /**
   * Called for frames that arrive in the short tail right after Kavya's audio ends: they can't start a turn
   * (speaker decay could look like speech), but they're kept as pre-roll so an answer that begins inside the
   * tail still has its first syllable.
   */
  hold(frame) {
    this._resetTurn();
    this.preRoll.push(frame);
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
  }

  /** Drop any half-captured turn — call while the bot is talking and frames are being ignored. */
  reset() {
    this._resetTurn();
    this.preRoll = [];
  }

  /** Room level: a low percentile of recent frame energies, or null until there's enough data. */
  get noiseFloor() {
    if (this.recent.length < MIN_FRAMES_FOR_FLOOR) return null;
    const sorted = [...this.recent].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * NOISE_PERCENTILE)];
  }

  get threshold() {
    return Math.max(this.minThreshold, (this.noiseFloor ?? 0) * SPEECH_OVER_FLOOR);
  }

  /** @returns {{buffer: Buffer, frames: number, noisy: boolean, noiseFloor: number, meanSpeech: number, threshold: number} | null} */
  push(frame) {
    const energy = getAudioEnergy(frame);
    const threshold = this.threshold; // judged against the room level BEFORE this frame is counted
    this.recent.push(energy);
    if (this.recent.length > NOISE_WINDOW_FRAMES) this.recent.shift();

    if (energy > threshold) {
      if (this.speechFrames === 0 && this.preRoll.length > 0) this.buffer = Buffer.concat(this.preRoll);
      this.speechFrames++;
      this.speechEnergySum += energy;
      this.silenceFrames = 0;
      this.buffer = Buffer.concat([this.buffer, frame]);
      // Unbroken sound never produces a pause, so cap it or the turn would never end.
      return this.speechFrames >= this.maxUtteranceFrames ? this._finish(true, threshold) : null;
    }

    this.preRoll.push(frame);
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
    this.silenceFrames++;
    return this.silenceFrames > this.silenceFramesForTurnEnd && this.buffer.length > 0 ? this._finish(false, threshold) : null;
  }

  _finish(forced, threshold) {
    let turn = null;
    if (this.speechFrames >= this.minSpeechFrames) { // else a brief blip — noise, not a turn
      const noiseFloor = this.noiseFloor ?? 0;
      const meanSpeech = this.speechEnergySum / this.speechFrames;
      turn = {
        buffer: this.buffer,
        frames: this.speechFrames,
        noiseFloor,
        meanSpeech,
        threshold,
        noisy: forced || (noiseFloor >= NOISY_MIN_FLOOR && meanSpeech < noiseFloor * NOISY_SNR)
      };
    }
    if (forced) this.preRoll = []; // those frames predate the audio just consumed
    this._resetTurn();
    return turn;
  }
}
