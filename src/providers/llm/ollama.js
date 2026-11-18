/**
 * LLM Plugin: local Ollama dialogue engine (free/offline alternative to Gemini).
 */

import { Ollama } from 'ollama';
import { getRequiredEnv, getEnv } from '../../env.js';
import { buildSystemPrompt } from '../../knowledgeBase.js';

export class OllamaDialogueEngine {
  constructor(host = getEnv('OLLAMA_HOST', 'http://localhost:11434'), model = getRequiredEnv('OLLAMA_MODEL')) {
    this.ollama = new Ollama({ host });
    this.model = model;
  }

  async *streamResponse(conversationHistory, leadContext = null, knowledge = null) {
    let systemContent = buildSystemPrompt(knowledge);
    if (leadContext && (leadContext.call_disposition || leadContext.last_call_notes)) {
      systemContent += `\nPRIOR CALL CONTEXT: ${leadContext.customer_name || 'Customer'}, disposition=${leadContext.call_disposition || 'FOLLOW_UP_NEEDED'}, notes=${leadContext.last_call_notes || 'None'}\n`;
    }

    const messages = [
      { role: 'system', content: systemContent },
      ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    ];

    const responseStream = await this.ollama.chat({
      model: this.model,
      messages,
      stream: true,
      options: { temperature: 0.3, top_p: 0.85, num_predict: 90 }
    });

    for await (const chunk of responseStream) {
      const token = chunk.message?.content || '';
      if (token) yield token;
    }
  }
}
