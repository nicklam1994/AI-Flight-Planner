/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 *
 * The Model field is now a <select> that can be auto-populated from
 * the /api/tags (Ollama) or /v1/models (OpenAI-compatible) endpoint.
 */
const LLMSettings = {
  STORAGE_KEY: 'ai_flight_planner_llm',

  defaults: {
    provider: 'ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'gemma4:e4b',
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
    document.getElementById('llmApiKey').value = settings.api_key;
    document.getElementById('llmTemperature').value = settings.temperature;
    document.getElementById('tempValue').textContent = settings.temperature;

    // Repopulate the model dropdown — preserve any existing options
    const select = document.getElementById('llmModelSelect');
    select.innerHTML = `<option value="${settings.model}">${settings.model}</option>`;
  },

  /** Read values from the settings form. */
  readForm() {
    const select = document.getElementById('llmModelSelect');
    const manual = document.getElementById('llmModelManual');
    // Prefer select value, fall back to manual input, then first option
    let model = select.value;
    if (!model && manual) model = manual.value.trim();
    if (!model) model = select.options[0]?.value || '';
    return {
      provider: document.getElementById('llmProvider').value,
      base_url: document.getElementById('llmBaseUrl').value.trim(),
      model: model,
      api_key: document.getElementById('llmApiKey').value,
      temperature: parseFloat(document.getElementById('llmTemperature').value),
    };
  },

  /**
   * Fetch available models from the configured LLM API endpoint.
   * Supports OpenAI-compatible (/v1/models) and Ollama (/api/tags).
   * Returns array of model name strings, or empty array on error.
   */
  async fetchModels(baseUrl, apiKey) {
    const base = baseUrl.replace(/\/+$/, '');

    // Try Ollama API first (/api/tags)
    const ollamaUrl = base.replace(/\/v1$/, '') + '/api/tags';
    try {
      const res = await fetch(ollamaUrl, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.models && Array.isArray(data.models)) {
          return data.models.map(m => m.name).sort();
        }
      }
    } catch (e) { /* fall through to OpenAI-compatible */ }

    // Try OpenAI-compatible (/v1/models)
    const openaiUrl = base.endsWith('/v1/models') ? base : base + '/models';
    try {
      const res = await fetch(openaiUrl, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data && Array.isArray(data.data)) {
          return data.data
            .filter(m => m.id && !m.id.startsWith('.'))
            .map(m => m.id)
            .sort();
        }
      }
    } catch (e) { /* model list unavailable */ }

    return [];
  },
};
