/**
 * API client — wraps fetch calls to the backend.
 */
const API = {
  base: '',

  // ── Route Planning ──────────────────────────────────────────

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

  // ── Health & Cycles ─────────────────────────────────────────

  async health() {
    const res = await fetch(`${this.base}/api/health`);
    return res.json();
  },

  async getCycles() {
    const res = await fetch(`${this.base}/api/cycles`);
    return res.json();
  },

  // ── Autocomplete ────────────────────────────────────────────

  async searchAirports(q, limit = 10) {
    const res = await fetch(`${this.base}/api/airports?q=${encodeURIComponent(q)}&limit=${limit}`);
    return res.json();
  },

  async searchWaypoints(q, limit = 10) {
    const res = await fetch(`${this.base}/api/waypoints?q=${encodeURIComponent(q)}&limit=${limit}`);
    return res.json();
  },

  // ── Procedures (legacy v1) ──────────────────────────────────

  async fetchProcedures(airport, type = '') {
    const params = new URLSearchParams({ airport });
    if (type) params.set('type', type);
    const res = await fetch(`${this.base}/api/procedures?${params}`);
    if (!res.ok) return { icao: airport, sids: [], stars: [] };
    return res.json();
  },

  // ── Step 3: Route Filter (v2) ────────────────────────────────

  async filterRoute(origin, destination, routeString) {
    const res = await fetch(`${this.base}/api/route/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, destination, route_string: routeString }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ── Step 4: Waypoint Details (v2) ────────────────────────────

  async getRouteWaypoints(candidateIndex) {
    const res = await fetch(`${this.base}/api/route/${candidateIndex}/waypoints`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ── Step 5: Weather (v2) ─────────────────────────────────────

  async getWeather(dep, arr) {
    const res = await fetch(`${this.base}/api/weather?dep=${encodeURIComponent(dep)}&arr=${encodeURIComponent(arr)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ── Airport Detail (v3) ──────────────────────────────────────

  async getAirportDetail(icao, fix) {
    const params = new URLSearchParams();
    if (fix) params.set('fix', fix);
    const res = await fetch(`${this.base}/api/airport/${encodeURIComponent(icao)}/detail?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },
};
