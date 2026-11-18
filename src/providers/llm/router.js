/**
 * Holds every configured LLM provider (Gemini, NVIDIA NIM, Ollama) and routes to the active one.
 * The dashboard can switch the active provider live (no restart), and — unless LLM_FALLBACK=false —
 * a provider that errors BEFORE producing its first word hands the turn to the next available one,
 * so a 429/503 on one service doesn't leave the customer in silence.
 *
 * Same interface as a single provider: { model, streamResponse(...), generateJson(prompt) }.
 */

export class LlmRouter {
  /**
   * @param {Object<string, new () => Object>} classes name -> provider class (constructor throws if its key is missing)
   * @param {string} defaultName
   * @param {boolean} [fallback]
   */
  constructor(classes, defaultName, fallback = true) {
    this.classes = classes;
    this.fallback = fallback;
    this.instances = new Map();
    this.active = defaultName;
    this._get(defaultName); // fail fast at startup if the configured default isn't usable
  }

  /** The provider instance, created on first use; throws (missing key etc.) if it can't be. */
  _get(name) {
    if (!this.instances.has(name)) {
      const Provider = this.classes[name];
      if (!Provider) throw new Error(`Unknown LLM provider "${name}". Available: ${Object.keys(this.classes).join(', ')}`);
      this.instances.set(name, new Provider());
    }
    return this.instances.get(name);
  }

  /** Providers that are actually usable right now (their credentials are present). */
  available() {
    return Object.keys(this.classes).filter(name => { try { this._get(name); return true; } catch { return false; } });
  }

  get model() { return `${this.active}: ${this._get(this.active).model}`; }

  /** Model name currently used by each usable provider. */
  models() { return Object.fromEntries(this.available().map(n => [n, this._get(n).model])); }

  /** Changes the model a provider uses from its next request on. */
  setModel(name, model) { this._get(name).model = model; }

  /**
   * Tries a provider/model without touching the live one: one tiny request, reports whether it
   * answered and how long the first word took. Catches typos in model names before a customer does.
   */
  async probe(name, model) {
    const started = Date.now();
    try {
      const probe = new this.classes[name]();
      probe.model = model;
      for await (const token of probe.streamResponse([{ role: 'user', content: 'வணக்கம்' }], null, null)) {
        return { ok: true, ms: Date.now() - started, sample: token.trim().slice(0, 40) };
      }
      return { ok: false, error: 'The model returned an empty reply.' };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  }

  use(name) {
    this._get(name); // throws with the real reason if it isn't configured
    this.active = name;
  }

  /** Active provider first, then (if enabled) every other usable one. */
  _order(capability) {
    const rest = this.fallback ? this.available().filter(n => n !== this.active) : [];
    return [this.active, ...rest].filter(n => typeof this._get(n)[capability] === 'function');
  }

  async *streamResponse(history, leadContext, knowledge) {
    const order = this._order('streamResponse');
    for (const [i, name] of order.entries()) {
      let started = false;
      try {
        for await (const token of this._get(name).streamResponse(history, leadContext, knowledge)) {
          started = true;
          yield token;
        }
        return;
      } catch (err) {
        // Once words have been spoken, switching model mid-sentence would garble the reply — surface the error instead.
        if (started || i === order.length - 1) throw err;
        console.warn(`[LLM] ${name} failed before replying (${String(err.message).slice(0, 120)}) — trying ${order[i + 1]}`);
      }
    }
  }

  /** One-shot JSON completion (CRM extraction). */
  async generateJson(prompt) {
    const order = this._order('generateJson');
    for (const [i, name] of order.entries()) {
      try { return await this._get(name).generateJson(prompt); }
      catch (err) {
        if (i === order.length - 1) throw err;
        console.warn(`[LLM] ${name} JSON call failed (${String(err.message).slice(0, 120)}) — trying ${order[i + 1]}`);
      }
    }
    throw new Error('No LLM provider supports JSON completion.');
  }
}
