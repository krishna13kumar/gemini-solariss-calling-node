/**
 * LLM Plugin: Google Gemini dialogue engine.
 */

import { GoogleGenAI } from '@google/genai';
import { getRequiredEnv } from '../../env.js';
import { buildSystemPrompt } from '../../knowledgeBase.js';

export class GeminiDialogueEngine {
  constructor(apiKey = getRequiredEnv('GEMINI_API_KEY'), model = getRequiredEnv('GEMINI_MODEL')) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  /**
   * @param {Array<{role: string, content: string}>} conversationHistory
   * @param {Object} leadContext Prior call context for follow-ups
   * @param {Array<{question: string, answer: string}>} [knowledge] approved Q&A to ground answers in
   * @returns {AsyncGenerator<string>} streamed reply tokens
   */
  async *streamResponse(conversationHistory, leadContext = null, knowledge = null) {
    let systemInstruction = buildSystemPrompt(knowledge);
    if (leadContext && (leadContext.call_disposition || leadContext.last_call_notes)) {
      systemInstruction += `\nPRIOR CALL CONTEXT FOR THIS LEAD:
- Customer Name: ${leadContext.customer_name || 'Customer'}
- Previous Disposition: ${leadContext.call_disposition || 'FOLLOW_UP_NEEDED'}
- Last Notes: ${leadContext.last_call_notes || 'None'}
Use this naturally, as if you remember the last call.\n`;
    }

    const contents = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // Gemini returns 503 UNAVAILABLE on transient capacity spikes (confirmed in
    // production, not hypothetical) — one short retry before giving up, since the
    // alternative is a dead turn with no reply at all.
    let responseStream;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        responseStream = await this.ai.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.3,
            topP: 0.85,
            maxOutputTokens: 150
          }
        });
        break;
      } catch (err) {
        const isTransient = err.message?.includes('503') || err.message?.includes('UNAVAILABLE');
        if (!isTransient || attempt === 2) throw err;
        console.warn(`[GeminiDialogueEngine] 503 high demand, retrying (attempt ${attempt})...`);
        await new Promise(r => setTimeout(r, 400));
      }
    }

    for await (const chunk of responseStream) {
      const text = chunk.text || '';
      if (text) yield text;
    }
  }

  /** One-shot structured completion: returns the parsed JSON object. */
  async generateJson(prompt) {
    const generate = () => this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.1 }
    });
    // Rate limits (429) / overload (503) are routine on the free tier — one retry before giving up.
    const response = await generate().catch(async err => {
      if (!/429|503|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(String(err.message))) throw err;
      await new Promise(r => setTimeout(r, 4000));
      return generate();
    });
    return JSON.parse(response.text.trim());
  }
}
