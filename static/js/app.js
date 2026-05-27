/**
 * AI Flight Planner — v2 four-zone UI application logic.
 *
 * Flow:
 *   Step 1: Natural language input → POST /api/plan
 *   Step 2: Display candidate routes (clickable)
 *   Step 3: Click candidate → POST /api/procedures/filter → four-zone details
 *   Step 4: Auto-fetch weather after plan result
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let llmSettings = LLMSettings.load();
  let currentCycle = localStorage.getItem('ai_flight_planner_cycle') || null;
  /** @type {Object|null} Last plan result for reference */
  let lastPlanResult = null;
  /** @type {number|null} Index of selected candidate */
  let selectedCandidateIdx = null;

  // ── DOM refs ───────────────────────────────────────────────
  const $input = document.getElementById('routeInput');
  const $kSelect = document.getElementById('kSelect');
  const $planBtn = document.getElementById('planBtn');
  const $status = document.getElementById('status');

  // Weather
  const $weatherCard = document.getElementById('weatherCard');
  const $weatherContent = document.getElementById('weatherContent');
  const $weatherRefreshBtn = document.getElementById('weatherRefreshBtn');

  // Candidates
  const $candidatesCard = document.getElementById('candidatesCard');
  const $candidatesContent = document.getElementById('candidatesContent');

  // Four-zone detail panels
  const $detailPanels = document.getElementById('detailPanels');
  const $departureContent = document.getElementById('departureContent');
  const $arrivalContent = document.getElementById('arrivalContent');
  const $routePanelContent = document.getElementById('routePanelContent');
  const $navigationContent = document.getElementById('navigationContent');

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

    // Weather refresh
    $weatherRefreshBtn.addEventListener('click', () => {
      const dep = lastPlanResult?.parsed?.origin;
      const arr = lastPlanResult?.parsed?.destination;
      if (dep || arr) fetchWeather(dep, arr);
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

    // Fetch models button
    const $fetchBtn = document.getElementById('fetchModelsBtn');
    if ($fetchBtn) $fetchBtn.addEventListener('click', handleFetchModels);

    // Provider auto-fill
    const $provider = document.getElementById('llmProvider');
    if ($provider) $provider.addEventListener('change', handleProviderChange);

    // Cycle dropdown
    $cycleSelect.addEventListener('change', handleCycleChange);

    // Collapsible panels
    document.querySelectorAll('.collapsible').forEach(el => {
      el.addEventListener('click', togglePanel);
    });

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

    // Hide previous results
    $candidatesCard.style.display = 'none';
    $detailPanels.style.display = 'none';
    $weatherCard.style.display = 'none';
    selectedCandidateIdx = null;
    lastPlanResult = null;

    setLoading(true);
    showStatus('Planning route...', 'loading');

    try {
      const result = await API.plan(input, k, llmSettings, currentCycle);
      lastPlanResult = result;

      if (result.candidates && result.candidates.length > 0) {
        renderCandidates(result);
        // Auto-fetch weather
        const dep = result.parsed?.origin;
        const arr = result.parsed?.destination;
        if (dep || arr) fetchWeather(dep, arr);
      } else if (result.error) {
        showStatus(result.error, 'error');
      }

      hideStatus();
    } catch (e) {
      showStatus(e.message || 'An error occurred', 'error');
    } finally {
      setLoading(false);
    }
  }

  function setLoading(loading) {
    $planBtn.disabled = loading;
    $planBtn.textContent = loading ? I18N.t('btn-planning') : I18N.t('btn-plan');
  }

  // ── Weather ───────────────────────────────────────────────
  async function fetchWeather(dep, arr) {
    $weatherCard.style.display = 'block';
    $weatherContent.innerHTML = '<div class="panel-loading">Loading weather...</div>';
    if ($weatherRefreshBtn) $weatherRefreshBtn.disabled = true;

    try {
      const data = await API.fetchWeather(dep, arr);
      renderWeather(data);
    } catch (e) {
      $weatherContent.innerHTML = `<div class="error-text">Weather unavailable: ${e.message}</div>`;
    } finally {
      if ($weatherRefreshBtn) $weatherRefreshBtn.disabled = false;
    }
  }

  function renderWeather(data) {
    const renderStation = (station, label) => {
      if (!station) return '';
      const metar = station.metar;
      const ap = station.airport || {};
      const name = ap.name || station.icao;

      let html = `<div class="weather-station">
        <div class="weather-header">${label} ${station.icao} (${name})</div>`;

      if (metar) {
        const w = metar.wind || {};
        const windInfo = w.dir_compass
          ? `${w.dir_compass} ${w.dir}° ${w.speed_kts || '?'}kt`
          : (metar.wind_text || 'calm');
        const tempInfo = metar.temp_c != null ? `${metar.temp_c}°C` : '—';
        const presInfo = metar.pressure_hpa != null ? `${metar.pressure_hpa}hPa` : '—';
        const cloudsStr = metar.clouds?.map(c =>
          c.cover_cn ? `${c.cover}(${c.cover_cn})${c.height_ft ? '@' + c.height_ft + 'ft' : ''}` : c.cover
        ).join(' ') || 'CAVOK';
        const wxStr = metar.weather?.length ? 'wx: ' + metar.weather.join(', ') : '';
        const frColor = {
          VFR: '#4caf50', MVFR: '#2196f3', IFR: '#ff9800', LIFR: '#f44336'
        };
        const fr = metar.flight_rules || '?';

        html += `<div class="weather-body">
          <div class="weather-line">METAR ${metar.time ? new Date(metar.time).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})+'Z' : '—'} | ${windInfo} | ${tempInfo}/${metar.dewpt_c != null ? metar.dewpt_c + '°C' : '?'} | ${presInfo}</div>
          <div class="weather-line">VIS: ${metar.visibility_str} | ${cloudsStr}</div>
          ${wxStr ? `<div class="weather-line">${wxStr}</div>` : ''}
          <div class="weather-line">Flight Rules: <span style="color:${frColor[fr]||'#fff'};font-weight:bold">${fr}</span></div>
          ${metar.raw ? `<div class="weather-raw">&#8203;${metar.raw}</div>` : ''}
        </div>`;
      }

      if (station.taf_raw) {
        html += `<div class="weather-taf">
          <div class="weather-line" style="color:var(--accent)">TAF:</div>
          <div class="weather-raw">${station.taf_raw.replace(/\n/g, '<br>')}</div>
        </div>`;
      }

      html += '</div>';
      return html;
    };

    $weatherContent.innerHTML =
      renderStation(data.departure, '🛫') +
      renderStation(data.arrival, '🛬');
    if ($weatherRefreshBtn) $weatherRefreshBtn.disabled = false;
  }

  // ── Candidate rendering ────────────────────────────────────
  function renderCandidates(result) {
    const bestIdx = result.candidates[0]?.index ?? 0;

    $candidatesContent.innerHTML = result.candidates.map((c, i) => {
      const isBest = c.index === bestIdx;
      const scoreHtml = c.score != null
        ? `<span class="result-score">${c.score.toFixed(1)}</span>`
        : '';

      const flowHtml = c.segments?.length
        ? `<div class="segment-flow">${c.segments.map(s =>
            `<span class="segment-badge">${s.from_ident}</span>
             <span class="segment-arrow">→</span>
             ${s.segment_type === 'airway' ? `<span class="segment-badge" style="color:var(--accent)">${s.airway_name}</span><span class="segment-arrow">→</span>` : ''}
             <span class="segment-badge">${s.to_ident}</span>`
          ).join(' ')}</div>`
        : '';

      return `
        <div class="card result-card ${isBest ? 'result-best' : ''} candidate-clickable"
             data-candidate-idx="${i}" data-route="${c.route_string.replace(/"/g, '&quot;')}">
          <div class="result-header">
            <strong>${isBest ? '⭐ ' + I18N.t('best-route') : '◌ ' + I18N.t('alternative') + (i + 1)}</strong>
            ${scoreHtml}
          </div>
          <div class="route-string">${c.route_string}</div>
          <div class="route-meta">
            ${I18N.t('distance-nm')}: ${c.total_distance_nm?.toFixed(0) || '?'} NM
            ${c.segments ? '· ' + c.segments.length + ' ' + I18N.t('segments') : ''}
          </div>
          ${c.eval_reason ? `<div class="route-reason">${c.eval_reason}</div>` : ''}
          ${flowHtml}
          <button class="copy-btn" onclick="event.stopPropagation();navigator.clipboard.writeText('${c.route_string.replace(/'/g, "\\'")}');showToast('${I18N.t('toast-route-copied')}')">
            ${I18N.t('btn-copy-route')}
          </button>
        </div>
      `;
    }).join('');

    $candidatesCard.style.display = 'block';

    // Click handler for candidate selection
    document.querySelectorAll('.candidate-clickable').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.candidateIdx, 10);
        const routeStr = el.dataset.route;
        selectCandidate(idx, routeStr, el);
      });
    });

    // Auto-select best candidate
    const firstEl = document.querySelector('.candidate-clickable');
    if (firstEl) firstEl.click();
  }

  async function selectCandidate(idx, routeStr, el) {
    selectedCandidateIdx = idx;
    // Highlight
    document.querySelectorAll('.candidate-clickable').forEach(e => e.classList.remove('candidate-selected'));
    if (el) el.classList.add('candidate-selected');

    $detailPanels.style.display = 'block';

    // Render route details immediately
    renderRouteDetails(routeStr);

    // Fetch SID/STAR filter
    const candidate = lastPlanResult?.candidates?.[idx];
    if (candidate && lastPlanResult?.parsed) {
      const dep = lastPlanResult.parsed.origin;
      const arr = lastPlanResult.parsed.destination;

      $departureContent.innerHTML = '<div class="panel-loading">Filtering SID procedures...</div>';
      $arrivalContent.innerHTML = '<div class="panel-loading">Filtering STAR procedures...</div>';

      try {
        const filterData = await API.fetchProcedureFilter(routeStr, dep, arr);
        renderDeparture(filterData, dep);
        renderArrival(filterData, arr);

        // Fetch navigation waypoint details
        fetchNavigationDetails(candidate.segments);
      } catch (e) {
        $departureContent.innerHTML = `<div class="error-text">SID filter unavailable: ${e.message}</div>`;
        $arrivalContent.innerHTML = `<div class="error-text">STAR filter unavailable: ${e.message}</div>`;
      }
    }
  }

  // ── Four-zone rendering ────────────────────────────────────

  function renderDeparture(filterData, airport) {
    const sids = filterData.sids || [];
    const sidNode = filterData.sid_node || '?';

    let html = `<h4>SID 離場程序 (經 <strong>${sidNode}</strong>)</h4>`;
    if (sids.length === 0) {
      html += '<div class="panel-empty">No matching SID procedures found for this waypoint</div>';
    } else {
      html += `<table class="data-table">
        <thead><tr><th>程序名</th><th>跑道</th></tr></thead>
        <tbody>${sids.map(s =>
          `<tr><td><strong>${s.name}</strong></td><td>${(s.runways || []).join(', ')}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    }

    // Also show full SID list summary
    if (airport) {
      html += `<div class="panel-note" style="margin-top:8px;font-size:0.8rem;opacity:0.6">
        共 ${sids.length} 條匹配程序 (過濾節點: ${sidNode})
      </div>`;
    }

    $departureContent.innerHTML = html;
  }

  function renderArrival(filterData, airport) {
    const stars = filterData.stars || [];
    const starNode = filterData.star_node || '?';

    let html = `<h4>STAR 進場程序 (經 <strong>${starNode}</strong>)</h4>`;
    if (stars.length === 0) {
      html += '<div class="panel-empty">No matching STAR procedures found for this waypoint</div>';
    } else {
      html += `<table class="data-table">
        <thead><tr><th>程序名</th><th>跑道</th></tr></thead>
        <tbody>${stars.map(s =>
          `<tr><td><strong>${s.name}</strong></td><td>${(s.runways || []).join(', ')}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    }

    if (airport) {
      html += `<div class="panel-note" style="margin-top:8px;font-size:0.8rem;opacity:0.6">
        共 ${stars.length} 條匹配程序 (過濾節點: ${starNode})
      </div>`;
    }

    $arrivalContent.innerHTML = html;
  }

  function renderRouteDetails(routeStr) {
    // Clean route string: remove SID...STAR wrapping for flight plan copy
    const planRoute = routeStr
      .replace(/\bSID\s+\w+\s*/gi, '')
      .replace(/\s*\w+\s+STAR\b/gi, '')
      .trim();

    $routePanelContent.innerHTML = `
      <div class="route-detail-section">
        <h4>完整航路字串 (ATS Route String)</h4>
        <div class="route-string-display">${routeStr}</div>
      </div>
      <div class="route-detail-section">
        <h4>飛行計劃航路 (Flight Plan Route)</h4>
        <div class="route-string-display">${planRoute}</div>
        <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${planRoute.replace(/'/g, "\\'")}');showToast('Flight plan route copied!')" style="margin-top:8px">
          📋 複製飛行計劃航路
        </button>
      </div>
    `;
  }

  async function fetchNavigationDetails(segments) {
    if (!segments || segments.length === 0) {
      $navigationContent.innerHTML = '<div class="panel-empty">No waypoint data</div>';
      return;
    }

    $navigationContent.innerHTML = '<div class="panel-loading">Loading waypoint details...</div>';

    // Collect unique waypoint idents from segments
    const idents = [...new Set(segments.flatMap(s => [s.from_ident, s.to_ident]))];

    // Look up each waypoint via the /api/waypoints endpoint
    const results = [];
    for (const ident of idents) {
      try {
        const data = await API.searchWaypoints(ident, 1);
        if (data.results && data.results.length > 0) {
          results.push(data.results[0]);
        } else {
          results.push({ ident, wp_type: '?', lat: null, lon: null });
        }
      } catch (e) {
        results.push({ ident, wp_type: '?', lat: null, lon: null });
      }
    }

    renderNavigationTable(results);
  }

  function renderNavigationTable(waypoints) {
    let html = `<table class="data-table">
      <thead><tr><th>航點名</th><th>類型</th><th>緯度</th><th>經度</th></tr></thead>
      <tbody>${waypoints.map(w =>
        `<tr>
          <td><strong>${w.ident}</strong></td>
          <td>${w.wp_type || '?'}</td>
          <td>${w.lat != null ? w.lat.toFixed(4) : '—'}</td>
          <td>${w.lon != null ? w.lon.toFixed(4) : '—'}</td>
        </tr>`
      ).join('')}</tbody>
    </table>`;
    $navigationContent.innerHTML = html;
  }

  // ── Collapsible panels ─────────────────────────────────────
  function togglePanel(e) {
    const title = e.currentTarget;
    const panel = title.dataset.panel;
    const body = document.getElementById(panel + 'Panel');
    const icon = title.querySelector('.collapse-icon');
    if (body) {
      body.classList.toggle('collapsed');
      if (body.classList.contains('collapsed')) {
        body.style.display = 'none';
        icon.textContent = '▶';
      } else {
        body.style.display = 'block';
        icon.textContent = '▼';
      }
    }
  }

  // ── Status / Toast ─────────────────────────────────────────
  function showStatus(msg, type) {
    $status.textContent = msg;
    $status.className = `status show status-${type}`;
  }

  function hideStatus() {
    $status.className = 'status';
  }

  window.showToast = function (msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  };

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
      addManualModelInput();
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
      nvidia: { url: 'https://integrate.api.nvidia.com/v1', key: '' },
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

  // ── Start ─────────────────────────────────────────────────
  init();
})();
