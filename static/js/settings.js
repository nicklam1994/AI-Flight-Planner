/**
 * LLM Settings — localStorage-persisted LLM configuration panel.
 *
 * The model field is a <select> dropdown populated from API via 🔄 Fetch button.
 * The "Other..." option allows typing a custom model name inline.
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
  },

  readForm() {
    const select = document.getElementById('llmModel');
    let model = select.value;
    // If "Other..." selected, show prompt for custom model name
    if (model === '__custom__') {
      model = prompt('Enter model name:') || select.options[0]?.value || '';
      if (model) {
        // Add the custom model to dropdown for future use
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        select.insertBefore(opt, select.querySelector('option[value="__custom__"]'));
        select.value = model;
      }
    }
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
        const msg = data.source === null ? 'API returned no models — check your URL and key' : 'No models found';
        throw new Error(msg);
      }
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.substring(0, 100) || 'Unknown error'}`);
    } catch (e) {
      throw e;
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
  },
};
