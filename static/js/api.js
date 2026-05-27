/**
 * API client — wraps fetch calls to the backend.
 */
const API = {
  base: '',

  async plan(input, k = 5, llmConfig = null, cycle = null) {
    const body = { input, k };
    if (llmConfig) body.llm_config = llmConfig;
    if (cycle) body.cycle = cycle;

    const res = await fetch(`${this.base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async health() {
    const res = await fetch(`${this.base}/api/health`);
    return res.json();
  },

  async searchAirports(q, limit = 10) {
    const res = await fetch(`${this.base}/api/airports?q=${encodeURIComponent(q)}&limit=${limit}`);
    return res.json();
  },

  async searchWaypoints(q, limit = 10) {
    const res = await fetch(`${this.base}/api/waypoints?q=${encodeURIComponent(q)}&limit=${limit}`);
    return res.json();
  },

  async getCycles() {
    const res = await fetch(`${this.base}/api/cycles`);
    return res.json();
  },

  async fetchProcedures(airport, type = '') {
    const params = new URLSearchParams({ airport });
    if (type) params.set('type', type);
    const res = await fetch(`${this.base}/api/procedures?${params}`);
    if (!res.ok) return { icao: airport, sids: [], stars: [] };
    return res.json();
  },
};
