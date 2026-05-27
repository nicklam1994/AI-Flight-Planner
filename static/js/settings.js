/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 */
const LLMSettings = {
  STORAGE_KEY: 'ai_flight_planner_llm',

  defaults: {
    provider: 'ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'qwen3.5:9b-agent',
    api_key: 'ollama',
    temperature: 0.3,
  },

  /** Load settings from localStorage, merging with defaults. */
  load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) return { ...this.defaults, ...JSON.parse(raw) };
    } catch (e) { /* ignore corrupt data */ }
    return { ...this.defaults };
  },

  /** Save settings to localStorage. */
  save(settings) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  },

  /** Reset to factory defaults. */
  reset() {
    localStorage.removeItem(this.STORAGE_KEY);
    return { ...this.defaults };
  },

  /** Populate the settings form with current values. */
  populateForm(settings) {
    document.getElementById('llmProvider').value = settings.provider;
    document.getElementById('llmBaseUrl').value = settings.base_url;
    document.getElementById('llmModel').value = settings.model;
    document.getElementById('llmApiKey').value = settings.api_key;
    document.getElementById('llmTemperature').value = settings.temperature;
    document.getElementById('tempValue').textContent = settings.temperature;
  },

  /** Read values from the settings form. */
  readForm() {
    return {
      provider: document.getElementById('llmProvider').value,
      base_url: document.getElementById('llmBaseUrl').value.trim(),
      model: document.getElementById('llmModel').value.trim(),
      api_key: document.getElementById('llmApiKey').value,
      temperature: parseFloat(document.getElementById('llmTemperature').value),
    };
  },
};
