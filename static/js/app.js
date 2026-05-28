/**
 * AI Flight Planner v2 — main application logic.
 *
 * Coordinates the UI, API calls, LLM settings panel, and result rendering.
 * v2 adds: state management, four-panel route details, weather integration.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let llmSettings = LLMSettings.load();
  let currentCycle = localStorage.getItem('ai_flight_planner_cycle') || null;

  // Session state (lost on page refresh — intentional per design decision)
  let state = {
    planResult: null,       // POST /api/plan response
    selectedRoute: null,    // Selected RouteCandidateResponse
    filterResult: null,     // POST /api/route/filter response
    weatherData: null,      // GET /api/weather response
  };

  // ── DOM refs ───────────────────────────────────────────────
  const $input = document.getElementById('routeInput');
  const $kSelect = document.getElementById('kSelect');
  const $planBtn = document.getElementById('planBtn');
  const $status = document.getElementById('status');
  const $parsedCard = document.getElementById('parsedCard');
  const $parsedContent = document.getElementById('parsedContent');
  const $candidatesCard = document.getElementById('candidatesCard');
  const $candidatesContent = document.getElementById('candidatesContent');
  const $detailCard = document.getElementById('detailCard');
  const $weatherCard = document.getElementById('weatherCard');
  const $warnings = document.getElementById('warnings');
  const $weatherRefreshBtn = document.getElementById('weatherRefreshBtn');

  // LLM settings modal
  const $settingsBtn = document.getElementById('settingsBtn');
  const $modalOverlay = document.getElementById('modalOverlay');
  const $modalClose = document.getElementById('modalClose');
  const $modalSave = document.getElementById('modalSave');
  const $modalReset = document.getElementById('modalReset');
  const $testConnBtn = document.getElementById('testConnBtn');
  const $toggleKey = document.getElementById('toggleKey');
  const $temperatureRange = document.getElementById('llmTemperature');
  const $temperatureValue = document.getElementById('tempValue');
  const $cycleSelect = document.getElementById('cycleSelect');

  // ── Initialization ────────────────────────────────────────
  function init() {
    LLMSettings.populateForm(llmSettings);

    $planBtn.addEventListener('click', handlePlan);
    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handlePlan();
      }
    });

    // Settings modal
    $settingsBtn.addEventListener('click', openSettings);
    $modalClose.addEventListener('click', closeSettings);
    $modalOverlay.addEventListener('click', (e) => {
      if (e.target === $modalOverlay) closeSettings();
    });
    $modalSave.addEventListener('click', saveSettings);
    $modalReset.addEventListener('click', resetSettings);
    $testConnBtn.addEventListener('click', testConnection);
    $toggleKey.addEventListener('click', toggleApiKey);
    $temperatureRange.addEventListener('input', () => {
      $temperatureValue.textContent = $temperatureRange.value;
    });

    const $fetchBtn = document.getElementById('fetchModelsBtn');
    if ($fetchBtn) $fetchBtn.addEventListener('click', handleFetchModels);

    const $provider = document.getElementById('llmProvider');
    if ($provider) $provider.addEventListener('change', handleProviderChange);

    $cycleSelect.addEventListener('change', handleCycleChange);

    // Weather refresh
    $weatherRefreshBtn.addEventListener('click', handleWeatherRefresh);

    // Health check + cycle list on load
    checkHealth();
    loadCycles();
  }

  // ── Health check ──────────────────────────────────────────
  async function checkHealth() {
    try {
      const h = await API.health();
      console.log('Health:', h);
    } catch (e) {
      console.warn('Health check failed:', e);
    }
  }

  // ── Cycle management ──────────────────────────────────────
  async function loadCycles() {
    try {
      const data = await API.getCycles();
      if (!data.cycles || data.cycles.length === 0) return;

      $cycleSelect.innerHTML = data.cycles.map(c =>
        `<option value="${c.id}">${c.label || c.id}</option>`
      ).join('');

      const preferred = currentCycle || data.default;
      if (preferred) {
        $cycleSelect.value = preferred;
        currentCycle = preferred;
      }
    } catch (e) {
      console.warn('Failed to load cycles:', e);
    }
  }

  function handleCycleChange() {
    const cycle = $cycleSelect.value;
    if (!cycle) return;
    currentCycle = cycle;
    localStorage.setItem('ai_flight_planner_cycle', cycle);
    showToast(`AIRAC: ${cycle}`);
    I18N.refresh();
  }

  // ── Plan route ────────────────────────────────────────────
  async function handlePlan() {
    const input = $input.value.trim();
    if (!input) {
      showStatus(I18N.t('error-empty-input'), 'error');
      return;
    }

    const k = parseInt($kSelect.value, 10);

    // Hide all result cards
    hideAllCards();

    // Show loading
    setLoading(true);
    showStatus('Planning route...', 'loading');

    try {
      const result = await API.plan(input, k, llmSettings, currentCycle);
      state.planResult = result;
      state.selectedRoute = null;
      state.filterResult = null;
      state.weatherData = null;

      // Show parsed intent
      if (result.parsed) {
        renderParsed(result.parsed);
      }

      // Show candidates
      if (result.candidates && result.candidates.length > 0) {
        renderCandidates(result);
      } else if (result.error) {
        showStatus(result.error, 'error');
      }

      // Show warnings
      if (result.warnings && result.warnings.length > 0) {
        renderWarnings(result.warnings);
      }

      hideStatus();
    } catch (e) {
      showStatus(e.message || I18N.t('error-plan-failed'), 'error');
    } finally {
      setLoading(false);
    }
  }

  function setLoading(loading) {
    $planBtn.disabled = loading;
    $planBtn.textContent = loading ? I18N.t('btn-planning') : I18N.t('btn-plan');
  }

  function hideAllCards() {
    $parsedCard.style.display = 'none';
    $candidatesCard.style.display = 'none';
    $detailCard.style.display = 'none';
    $weatherCard.style.display = 'none';
    $warnings.innerHTML = '';
  }

  // ── Status ────────────────────────────────────────────────
  function showStatus(msg, type) {
    $status.textContent = msg;
    $status.className = `status show status-${type}`;
  }

  function hideStatus() {
    $status.className = 'status';
  }

  // ── Rendering: Parsed Intent ──────────────────────────────
  function renderParsed(parsed) {
    const items = [
      [I18N.t('label-origin'), parsed.origin || '?'],
      [I18N.t('label-destination'), parsed.destination || '?'],
      [I18N.t('label-airway-type'), parsed.airway_type || I18N.t('any')],
      [I18N.t('label-cruise-alt'), parsed.cruise_altitude ? `FL${Math.round(parsed.cruise_altitude / 100)}` : '\u2014'],
      [I18N.t('label-confidence'), `${Math.round((parsed.confidence || 0) * 100)}%`],
    ];

    if (parsed.avoid_waypoints?.length) {
      items.push([I18N.t('label-avoid-wps'), parsed.avoid_waypoints.join(', ')]);
    }
    if (parsed.avoid_airspaces?.length) {
      items.push([I18N.t('label-avoid-airspaces'), parsed.avoid_airspaces.join(', ')]);
    }

    $parsedContent.innerHTML = items.map(([label, value]) =>
      `<div class="parsed-item">
        <div class="label">${label}</div>
        <div>${value}</div>
      </div>`
    ).join('');
    $parsedCard.style.display = 'block';
  }

  // ── Rendering: Candidates (Step 2) ────────────────────────
  function renderCandidates(result) {
    const bestIdx = result.candidate_index ?? result.candidates[0]?.index ?? 0;

    $candidatesContent.innerHTML = result.candidates.map((c, i) => {
      const isBest = c.index === bestIdx;
      const scoreHtml = c.score != null
        ? `<span class="result-score">${c.score.toFixed(1)}</span>`
        : '';

      return `
        <div class="card result-card ${isBest ? 'result-best' : ''}">
          <div class="result-header">
            <strong>${isBest ? '⭐ ' + I18N.t('best-route') : '\u25cb ' + I18N.t('alternative') + (i + 1)}</strong>
            ${scoreHtml}
          </div>
          <div class="route-string">${escapeHtml(c.route_string)}</div>
          <div class="route-meta">
            ${I18N.t('distance-nm')}: ${c.total_distance_nm?.toFixed(0) || '?'} NM
            ${c.segments ? '· ' + c.segments.length + ' ' + I18N.t('segments') : ''}
          </div>
          ${c.eval_reason ? `<div class="route-reason">${escapeHtml(c.eval_reason)}</div>` : ''}
          <div class="result-actions">
            <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeAttr(c.route_string)}');showToast('${I18N.t('toast-route-copied')}')">
              ${I18N.t('btn-copy-route')}
            </button>
            <button class="select-btn" onclick="app.selectRoute(${c.index})">
              ${I18N.t('btn-select-route')}
            </button>
          </div>
        </div>
      `;
    }).join('');

    $candidatesCard.style.display = 'block';
  }

  // ── Step 3-5: Select Route (v2 — parallel requests) ───────
  async function handleSelectRoute(candidateIndex) {
    const result = state.planResult;
    if (!result || !result.candidates) return;

    const candidate = result.candidates.find(c => c.index === candidateIndex);
    if (!candidate) return;

    state.selectedRoute = candidate;

    const parsed = result.parsed;
    const origin = parsed?.origin || '';
    const destination = parsed?.destination || '';
    const routeString = candidate.route_string;

    // Show detail + weather cards
    $detailCard.style.display = 'block';
    $weatherCard.style.display = 'block';

    // Set loading states
    document.getElementById('departureTitle').textContent = `🛫 Departure — ${origin}`;
    document.getElementById('arrivalTitle').textContent = `🛬 Arrival — ${destination}`;
    document.getElementById('departureContent').innerHTML = '<div class="panel-loading">Loading SID data...</div>';
    document.getElementById('arrivalContent').innerHTML = '<div class="panel-loading">Loading STAR data...</div>';
    document.getElementById('routeContent').innerHTML = '';
    document.getElementById('navigationContent').innerHTML = '<div class="panel-loading">Loading waypoint details...</div>';
    document.getElementById('weatherDepContent').innerHTML = '<div class="panel-loading">Loading weather...</div>';
    document.getElementById('weatherArrContent').innerHTML = '<div class="panel-loading">Loading weather...</div>';

    // Parallel requests using Promise.allSettled so partial failures don't block
    const [filterResult, waypointResult, weatherResult] = await Promise.allSettled([
      API.filterRoute(origin, destination, routeString),
      API.getRouteWaypoints(candidateIndex),
      API.getWeather(origin, destination),
    ]);

    // Process filter result
    if (filterResult.status === 'fulfilled') {
      state.filterResult = filterResult.value;
      renderDeparturePanel(origin, filterResult.value.sids || [], filterResult.value.sid_filter_node);
      renderArrivalPanel(destination, filterResult.value.stars || [], filterResult.value.star_filter_node);
    } else {
      document.getElementById('departureContent').innerHTML = renderError('SID filter unavailable');
      document.getElementById('arrivalContent').innerHTML = renderError('STAR filter unavailable');
      console.warn('Filter request failed:', filterResult.reason);
    }

    // Process waypoint result
    if (waypointResult.status === 'fulfilled') {
      renderNavigationPanel(waypointResult.value.waypoints || []);
    } else {
      document.getElementById('navigationContent').innerHTML = renderError('Waypoint details unavailable');
      console.warn('Waypoint request failed:', waypointResult.reason);
    }

    // Render route string panel
    renderRoutePanel(candidate);

    // Process weather result
    if (weatherResult.status === 'fulfilled') {
      state.weatherData = weatherResult.value;
      renderWeatherPanel(weatherResult.value);
    } else {
      document.getElementById('weatherDepContent').innerHTML = renderError('Weather unavailable');
      document.getElementById('weatherArrContent').innerHTML = renderError('Weather unavailable');
      console.warn('Weather request failed:', weatherResult.reason);
    }
  }

  // ── Panel: Departure (SID table) ──────────────────────────
  function renderDeparturePanel(icao, sids, filterNode) {
    const runways = sids.length > 0
      ? [...new Set(sids.flatMap(s => s.runways || []))].join(', ')
      : '\u2014';

    let html = '';

    if (filterNode) {
      html += `<div class="filter-info">Filter: <code>${escapeHtml(filterNode)}</code></div>`;
    }

    html += `<div class="runway-info">Runways: <strong>${escapeHtml(runways)}</strong></div>`;

    if (sids.length > 0) {
      html += `<table class="proc-table">
        <thead><tr><th>SID</th><th>Runways</th></tr></thead>
        <tbody>${sids.map(s =>
          `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml((s.runways || []).join(', '))}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    } else {
      html += `<p class="no-data">${filterNode ? 'No matching SIDs found' : 'Unable to determine filter node'}</p>`;
    }

    document.getElementById('departureContent').innerHTML = html;
  }

  // ── Panel: Arrival (STAR table) ───────────────────────────
  function renderArrivalPanel(icao, stars, filterNode) {
    const runways = stars.length > 0
      ? [...new Set(stars.flatMap(s => s.runways || []))].join(', ')
      : '\u2014';

    let html = '';

    if (filterNode) {
      html += `<div class="filter-info">Filter: <code>${escapeHtml(filterNode)}</code></div>`;
    }

    html += `<div class="runway-info">Runways: <strong>${escapeHtml(runways)}</strong></div>`;

    if (stars.length > 0) {
      html += `<table class="proc-table">
        <thead><tr><th>STAR</th><th>Runways</th></tr></thead>
        <tbody>${stars.map(s =>
          `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml((s.runways || []).join(', '))}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    } else {
      html += `<p class="no-data">${filterNode ? 'No matching STARs found' : 'Unable to determine filter node'}</p>`;
    }

    document.getElementById('arrivalContent').innerHTML = html;
  }

  // ── Panel: Route String ───────────────────────────────────
  function renderRoutePanel(candidate) {
    document.getElementById('routeContent').innerHTML = `
      <div class="route-string-box">${escapeHtml(candidate.route_string)}</div>
      <button class="copy-btn" style="margin-top:8px" onclick="navigator.clipboard.writeText('${escapeAttr(candidate.route_string)}');showToast('${I18N.t('toast-route-copied')}')">
        📋 Copy
      </button>
      <div class="route-stats">
        <span>${I18N.t('distance-nm')}: ${candidate.total_distance_nm?.toFixed(0) || '?'} NM</span>
        <span>${I18N.t('segments')}: ${candidate.segments?.length || 0}</span>
        ${candidate.score != null ? `<span>Score: ${candidate.score.toFixed(1)}</span>` : ''}
      </div>
    `;
  }

  // ── Panel: Navigation (waypoint table) ────────────────────
  function renderNavigationPanel(waypoints) {
    if (!waypoints || waypoints.length === 0) {
      document.getElementById('navigationContent').innerHTML = '<p class="no-data">No waypoint data available</p>';
      return;
    }

    const freqStr = (freq) => {
      if (freq == null) return '\u2014';
      return (freq / 1000).toFixed(2) + ' MHz';  // kHz*100 → MHz
    };

    document.getElementById('navigationContent').innerHTML = `
      <table class="nav-table">
        <thead>
          <tr>
            <th>Waypoint</th>
            <th>Type</th>
            <th>Frequency</th>
            <th>Lat</th>
            <th>Lon</th>
          </tr>
        </thead>
        <tbody>
          ${waypoints.map(w => `
            <tr>
              <td>${escapeHtml(w.ident)}</td>
              <td>${escapeHtml(w.type_label || w.type)}</td>
              <td>${freqStr(w.frequency)}</td>
              <td>${w.lat?.toFixed(3) || '\u2014'}</td>
              <td>${w.lon?.toFixed(3) || '\u2014'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ── Weather ───────────────────────────────────────────────
  function renderWeatherPanel(data) {
    renderWeatherColumn(
      document.getElementById('weatherDepLabel'),
      document.getElementById('weatherDepContent'),
      data.departure,
      true
    );
    renderWeatherColumn(
      document.getElementById('weatherArrLabel'),
      document.getElementById('weatherArrContent'),
      data.arrival,
      false
    );
  }

  function renderWeatherColumn(labelEl, contentEl, wx, isDeparture) {
    if (!wx) {
      labelEl.textContent = isDeparture ? '🛫 Weather' : '🛬 Weather';
      contentEl.innerHTML = '<p class="no-data">No weather data</p>';
      return;
    }

    labelEl.textContent = `${wx.icao || ''} — ${wx.airport?.name || wx.airport?.city || ''}`;

    if (!wx.metar) {
      contentEl.innerHTML = `<p class="no-data">No METAR data</p>
        ${wx.taf_raw ? `<details><summary>Raw TAF</summary>
        <pre class="weather-metar-raw">${escapeHtml(wx.taf_raw)}</pre></details>` : ''}`;
      return;
    }

    const m = wx.metar;

    let html = '<div class="weather-fields">';

    // Time
    html += `<div class="weather-field"><span class="label">Time</span><span class="value">${m.time || '\u2014'}</span></div>`;

    // Wind
    html += `<div class="weather-field"><span class="label">Wind</span><span class="value">${m.wind_text || m.wind?.description || '\u2014'}</span></div>`;

    // Visibility
    html += `<div class="weather-field"><span class="label">Vis</span><span class="value">${m.visibility_str || (m.visibility_m != null ? (m.visibility_m >= 10000 ? '10km+' : m.visibility_m + 'm') : '\u2014')}</span></div>`;

    // Temperature / Dew point
    const tempStr = m.temp_c != null ? `${m.temp_c}°C` : '\u2014';
    const dewStr = m.dewpt_c != null ? `${m.dewpt_c}°C` : '\u2014';
    html += `<div class="weather-field"><span class="label">Temp/Dew</span><span class="value">${tempStr} / ${dewStr}</span></div>`;

    // Pressure
    html += `<div class="weather-field"><span class="label">QNH</span><span class="value">${m.pressure_hpa != null ? m.pressure_hpa + ' hPa' : '\u2014'}</span></div>`;

    // Clouds
    if (m.clouds && m.clouds.length > 0) {
      const cloudStr = m.clouds.map(c => {
        const cover = c.cover_cn || c.cover || '';
        const alt = c.height_ft != null ? ` ${c.height_ft}ft` : '';
        return `${cover}${alt}`;
      }).join(', ');
      html += `<div class="weather-field"><span class="label">Clouds</span><span class="value">${escapeHtml(cloudStr)}</span></div>`;
    }

    // Flight rules
    if (m.flight_rules) {
      html += `<div class="weather-field"><span class="label">Rules</span><span class="value"><span class="wx-badge wx-${m.flight_rules.toLowerCase()}">${m.flight_rules}</span></span></div>`;
    }

    // Weather phenomena
    if (m.weather && m.weather.length > 0) {
      html += `<div class="weather-field"><span class="label">Weather</span><span class="value">${escapeHtml(m.weather.join(', '))}</span></div>`;
    }

    html += '</div>';

    // Raw METAR
    if (wx.metar_raw) {
      html += `<details><summary>Raw METAR</summary>
        <pre class="weather-metar-raw">${escapeHtml(wx.metar_raw)}</pre></details>`;
    }

    // Raw TAF
    if (wx.taf_raw) {
      html += `<details><summary>Raw TAF</summary>
        <pre class="weather-metar-raw">${escapeHtml(wx.taf_raw)}</pre></details>`;
    }

    contentEl.innerHTML = html;
  }

  async function handleWeatherRefresh() {
    if (!state.selectedRoute || !state.planResult?.parsed) {
      showToast('Select a route first');
      return;
    }

    const parsed = state.planResult.parsed;
    $weatherRefreshBtn.disabled = true;
    $weatherRefreshBtn.textContent = '⏳';

    try {
      const data = await API.getWeather(parsed.origin, parsed.destination);
      state.weatherData = data;
      renderWeatherPanel(data);
      showToast(I18N.t('toast-weather-refreshed'));
    } catch (e) {
      showToast(I18N.t('toast-weather-fail') + ': ' + e.message);
    } finally {
      $weatherRefreshBtn.disabled = false;
      $weatherRefreshBtn.textContent = '🔄 Refresh';
    }
  }

  // ── Warnings ──────────────────────────────────────────────
  function renderWarnings(warnings) {
    const warningMap = {
      'Route evaluation unavailable — routes sorted by distance only': I18N.t('warning-no-evaluation'),
      'Low confidence in parsing — results may not match your intent': I18N.t('warning-low-confidence'),
    };
    $warnings.innerHTML = warnings.map(w => {
      const translated = warningMap[w] || w;
      return `<div class="warning-item">⚠️ ${escapeHtml(translated)}</div>`;
    }).join('');
  }

  // ── Helpers ───────────────────────────────────────────────
  function renderError(msg) {
    return `<p class="no-data error">⚠️ ${escapeHtml(msg)}</p>`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  // ── Settings modal ────────────────────────────────────────
  function openSettings() {
    LLMSettings.populateForm(llmSettings);
    $modalOverlay.classList.add('show');
  }

  function closeSettings() {
    $modalOverlay.classList.remove('show');
  }

  function saveSettings() {
    llmSettings = LLMSettings.readForm();
    LLMSettings.save(llmSettings);
    closeSettings();
    showToast(I18N.t('toast-settings-saved'));
  }

  function resetSettings() {
    llmSettings = LLMSettings.reset();
    LLMSettings.populateForm(llmSettings);
    showToast(I18N.t('toast-reset-defaults'));
  }

  async function testConnection() {
    const settings = LLMSettings.readForm();
    $testConnBtn.disabled = true;
    $testConnBtn.textContent = I18N.t('btn-testing');

    try {
      const base = settings.base_url.replace(/\/+$/, '');
      const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.api_key}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 5,
        }),
      });

      if (res.ok) {
        showToast(I18N.t('toast-connection-ok'));
      } else {
        const err = await res.text().catch(() => 'Unknown error');
        showToast(`${I18N.t('toast-connection-fail')}${res.status} ${err.substring(0, 60)}`);
      }
    } catch (e) {
      showToast(`❌ ${I18N.t('toast-connection-fail')}${e.message}`);
    } finally {
      $testConnBtn.disabled = false;
      $testConnBtn.textContent = I18N.t('btn-test-connection');
    }
  }

  async function handleFetchModels() {
    const $fetchBtn = document.getElementById('fetchModelsBtn');
    const baseUrl = document.getElementById('llmBaseUrl').value.trim();
    const apiKey = document.getElementById('llmApiKey').value;

    if (!baseUrl) {
      showToast('Please enter Base URL first');
      return;
    }

    $fetchBtn.disabled = true;
    $fetchBtn.textContent = '⏳';

    try {
      const models = await LLMSettings.fetchModels(baseUrl, apiKey);
      if (models.length === 0) {
        LLMSettings.populateModels(['(no models fetched)']);
        showToast('No models found — type one below ⬇️');
      } else {
        LLMSettings.populateModels(models);
        showToast(`Found ${models.length} models`);
      }
    } catch (e) {
      LLMSettings.populateModels(['(fetch failed)']);
      showToast(`Error: ${e.message} — type model below`);
    }

    $fetchBtn.disabled = false;
    $fetchBtn.textContent = '🔄';
  }

  function handleProviderChange() {
    const provider = document.getElementById('llmProvider').value;
    const presets = {
      ollama: { url: 'http://localhost:11434/v1', key: 'ollama' },
      openai: { url: 'https://api.openai.com/v1', key: '' },
      deepseek: { url: 'https://api.deepseek.com/v1', key: '' },
      nvidia: { url: 'https://api.integrate.nvidia.com/v1', key: '' },
    };
    const preset = presets[provider];
    if (preset) {
      document.getElementById('llmBaseUrl').value = preset.url;
    }
  }

  function toggleApiKey() {
    const input = document.getElementById('llmApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $toggleKey.textContent = input.type === 'password' ? '👁' : '🙈';
  }

  // ── Toast ─────────────────────────────────────────────────
  window.showToast = function (msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  };

  // ── Public API (exposed for onclick handlers in rendered HTML) ─
  window.app = {
    selectRoute: handleSelectRoute,
  };

  // ── Start ─────────────────────────────────────────────────
  init();
})();
