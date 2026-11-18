/**
 * Teaching examples: customer message -> the reply Kavya SHOULD have given, curated from
 * the dashboard chat (👍 keep a good reply, ✏️ correct a bad one). The most recent ones are
 * appended to the system prompt as few-shot examples, so the voice agent and the chat both
 * pick up the style/answers immediately — no fine-tuning, no restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_IN_PROMPT = 15; // ponytail: most-recent-N; rank by similarity (faqStore embeddings) if the list outgrows this
const MAX_CHARS = 300;

export class TrainingStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'training.json')) {
    this.filePath = filePath;
    try { this.examples = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { this.examples = []; }
  }

  list() { return this.examples; }

  add(customer, reply) {
    customer = String(customer || '').trim().slice(0, MAX_CHARS);
    reply = String(reply || '').trim().slice(0, MAX_CHARS);
    if (!customer || !reply) throw new Error('Both the customer message and the reply are required.');
    const ex = { id: crypto.randomUUID(), customer, reply };
    this.examples = [...this.examples.filter(e => !(e.customer === customer && e.reply === reply)), ex];
    this._save();
    return ex;
  }

  remove(id) {
    this.examples = this.examples.filter(e => e.id !== id);
    this._save();
  }

  /** Few-shot block for the system prompt ('' when there are none). */
  promptBlock() {
    const recent = this.examples.slice(-MAX_IN_PROMPT);
    if (!recent.length) return '';
    return `APPROVED EXAMPLE REPLIES (written by the Gemini Solariss team — match their tone, wording and length; reuse the facts only when the customer asks the same thing):
${recent.map(e => `Customer: ${e.customer}\nKavya: ${e.reply}`).join('\n\n')}`;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.examples, null, 2));
  }
}

export const trainingStore = new TrainingStore();
