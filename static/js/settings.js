/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 *
 * The model field has BOTH a <select> dropdown AND a text input.
 * - Dropdown: populated from API via 🔄 Fetch button
 * - Text input: always visible, can type any model name
 * - When dropdown value changes → text input copies it
 * - When saving: text input wins if non-empty
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

    // Model select — add custom value if not in list
    const select = document.getElementById('llmModel');
    if (!Array.from(select.options).some(o => o.value === settings.model)) {
      const opt = document.createElement('option');
      opt.value = settings.model;
      opt.textContent = settings.model;
      select.appendChild(opt);
    }
    select.value = settings.model;

    // Manual input — always populated with current model
    const manual = document.getElementById('llmModelManual');
    if (manual) manual.value = settings.model;
  },

  readForm() {
    const select = document.getElementById('llmModel');
    const manual = document.getElementById('llmModelManual');
    // Manual input wins if non-empty; otherwise use select
    const model = (manual && manual.value.trim()) || select.value || '';
    return {
      provider: document.getElementById('llmProvider').value,
      base_url: document.getElementById('llmBaseUrl').value.trim(),
      model: model,
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
        // If we got a 200 but empty, the API might have responded with an error
        const msg = data.source === null ? 'API returned no models — check your URL and key' : 'No models found';
        throw new Error(msg);
      }
      // Extract error message from response
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.substring(0, 100) || 'Unknown error'}`);
    } catch (e) {
      throw e; // re-throw so the caller can show the error
    }
  },

  /** Replace the model <select> options with fetched list, keep "Other...". */
  populateModels(models) {
    const select = document.getElementById('llmModel');
    const currentVal = select.value;

    // Clear all except the "Other..." option
    while (select.options.length > 0) {
      if (select.options[0].value === '__custom__') break;
      select.remove(0);
    }

    // Prepend fetched models
    models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.insertBefore(opt, select.options[0] || null);
    });

    // Preserve or set first model
    if (Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    } else {
      select.value = models[0] || select.options[0]?.value || '';
    }

    // Sync manual input
    const manual = document.getElementById('llmModelManual');
    if (manual) manual.value = select.value;
  },
};
