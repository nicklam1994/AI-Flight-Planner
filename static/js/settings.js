/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 *
 * The Model field is a <select> with a "🔄 Fetch" button to populate
 * from the LLM API endpoint. "Other..." option opens a manual text input.
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

    // Populate model — add current value if not in dropdown
    const select = document.getElementById('llmModel');
    if (!Array.from(select.options).some(o => o.value === settings.model)) {
      const opt = document.createElement('option');
      opt.value = settings.model;
      opt.textContent = settings.model;
      select.appendChild(opt);
    }
    select.value = settings.model;
  },

  /** Read values from the settings form. */
  readForm() {
    const select = document.getElementById('llmModel');
    let model = select.value;
    // If "Other..." selected, read from the manual input
    if (model === 'custom') {
      model = document.getElementById('llmModelManual')?.value?.trim() || '';
    }
    return {
      provider: document.getElementById('llmProvider').value,
      base_url: document.getElementById('llmBaseUrl').value.trim(),
      model: model || select.options[0]?.value || '',
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
    // Ollama's /api/tags is at port root, not under /v1
    const rootUrl = base.replace(/\/v1$/, '');
    try {
      const res = await fetch(rootUrl + '/api/tags', {
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
    const modelsUrl = (base.endsWith('/v1') ? base + '/models' : base + '/v1/models');
    try {
      const res = await fetch(modelsUrl, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        // OpenAI-like: { data: [{ id: "..." }, ...] }
        if (data.data && Array.isArray(data.data)) {
          return data.data
            .filter(m => m.id && !m.id.startsWith('.'))
            .map(m => m.id)
            .sort();
        }
        // Ollama /v1/models: { object: "list", data: [...] }
        if (Array.isArray(data)) {
          return data.filter(m => m.id).map(m => m.id).sort();
        }
      }
    } catch (e) { /* model list unavailable */ }

    return [];
  },

  /** Replace the model <select> options with fetched list. */
  populateModels(models) {
    const select = document.getElementById('llmModel');
    const currentVal = select.value;

    // Clear existing options, keep "Other..."
    while (select.options.length > 0) {
      const opt = select.options[0];
      if (opt.value !== 'custom') select.remove(0);
      else break;
    }

    // Insert fetched models before "Other..."
    models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.insertBefore(opt, select.options[select.options.length - 1] || null);
    });

    // Restore or set first model
    if (Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    } else {
      select.value = models[0] || select.options[0]?.value || '';
    }
  },
};
