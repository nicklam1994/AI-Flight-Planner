/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 *
 * The model field is an <input> with <datalist> (select + type combo).
 * The 🔄 Fetch button populates the datalist options from the LLM API.
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

  load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) return { ...this.defaults, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    return { ...this.defaults };
  },

  save(settings) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  },

  reset() {
    localStorage.removeItem(this.STORAGE_KEY);
    return { ...this.defaults };
  },

  populateForm(settings) {
    document.getElementById('llmProvider').value = settings.provider;
    document.getElementById('llmBaseUrl').value = settings.base_url;
    document.getElementById('llmApiKey').value = settings.api_key;
    document.getElementById('llmTemperature').value = settings.temperature;
    document.getElementById('tempValue').textContent = settings.temperature;
    document.getElementById('llmModel').value = settings.model;
  },

  readForm() {
    return {
      provider: document.getElementById('llmProvider').value,
      base_url: document.getElementById('llmBaseUrl').value.trim(),
      model: document.getElementById('llmModel').value.trim(),
      api_key: document.getElementById('llmApiKey').value,
      temperature: parseFloat(document.getElementById('llmTemperature').value),
    };
  },

  /**
   * Fetch available models from the LLM API via backend proxy.
   * Avoids CORS issues with external APIs like NVIDIA NIM.
   */
  async fetchModels(baseUrl, apiKey) {
    try {
      const res = await fetch('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.models && data.models.length > 0) return data.models;
        const msg = data.source === null ? 'API returned no models — check your URL and key' : 'No models found';
        throw new Error(msg);
      }
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.substring(0, 100) || 'Unknown error'}`);
    } catch (e) {
      throw e;
    }
  },

  /** Replace the <datalist> options with fetched model list. */
  populateModels(models) {
    const list = document.getElementById('llmModelList');
    const input = document.getElementById('llmModel');
    const currentVal = input.value;

    // Clear existing options
    list.innerHTML = '';

    // Add fetched models as datalist options
    models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    });

    // Preserve current value if already typed; otherwise set first model
    if (!currentVal || !models.includes(currentVal)) {
      input.value = models[0] || '';
    }
  },
};
