/**
 * LLM Plugin: NVIDIA NIM hosted API (OpenAI-compatible, build.nvidia.com).
 */

import { getRequiredEnv, getEnv } from '../../env.js';
import { buildSystemPrompt } from '../../knowledgeBase.js';

export const nvidiaModel = () => getEnv('NVIDIA_MODEL', 'nvidia/nemotron-3-super-120b-a12b');

/** POST to the NIM API; throws with the HTTP status in the message (callers retry on 429/503). */
export async function nimPost(endpoint, body, apiKey = getRequiredEnv('NVIDIA_API_KEY')) {
  const res = await fetch(`https://integrate.api.nvidia.com/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`[NIM ${endpoint}] ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export class NvidiaDialogueEngine {
  constructor(apiKey = getRequiredEnv('NVIDIA_API_KEY'), model = nvidiaModel()) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async *streamResponse(conversationHistory, leadContext = null, knowledge = null) {
    let systemContent = buildSystemPrompt(knowledge);
    if (leadContext && (leadContext.call_disposition || leadContext.last_call_notes)) {
      systemContent += `\nPRIOR CALL CONTEXT: ${leadContext.customer_name || 'Customer'}, disposition=${leadContext.call_disposition || 'FOLLOW_UP_NEEDED'}, notes=${leadContext.last_call_notes || 'None'}\n`;
    }

    const res = await nimPost('chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: systemContent },
        ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      ],
      stream: true,
      temperature: 0.3,
      top_p: 0.85,
      max_tokens: 150,
      // Nemotron 3 is a thinking model: with thinking on it spends max_tokens reasoning and returns no content.
      chat_template_kwargs: { enable_thinking: false }
    }, this.apiKey);

    yield* this._readStream(res);
  }

  /** One-shot structured completion: returns the parsed JSON object. */
  async generateJson(prompt) {
    const generate = () => nimPost('chat/completions', {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false }
    }, this.apiKey);
    const response = await generate().catch(async err => {
      if (!/429|503/.test(String(err.message))) throw err;
      await new Promise(r => setTimeout(r, 4000));
      return generate();
    });
    const text = (await response.json()).choices[0].message.content || '';
    // No strict JSON mode here: take the outermost {...} in case the model wraps it in ``` fences.
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  }

  async *_readStream(res) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) continue;
        const token = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    }
  }
}
