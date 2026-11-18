/**
 * Settings changed from the dashboard (data/settings.json). They take effect live and override the
 * matching .env defaults on every start, so a choice made in the UI survives a restart.
 *
 * Shape: { llm: { provider, models: { gemini, nvidia }, fallback }, stt: { engine, url, model } }
 */

import fs from 'node:fs';
import path from 'node:path';

export class SettingsStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'settings.json')) {
    this.filePath = filePath;
    try { this.data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { this.data = {}; }
  }

  get() { return this.data; }

  /** Merges `patch` (two levels deep: section -> field, with `llm.models` merged per provider) and saves. */
  update(patch) {
    for (const [section, fields] of Object.entries(patch)) {
      const current = this.data[section] ?? {};
      const next = { ...current, ...fields };
      if (fields.models) next.models = { ...current.models, ...fields.models };
      this.data[section] = next;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    return this.data;
  }
}
