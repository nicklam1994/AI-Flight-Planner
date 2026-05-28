/**
 * AI Flight Planner v3 — main application logic.
 *
 * v3 changes:
 * - No kSelect; always plans with k=3 internally.
 * - Route candidates are clickable CARDS (not buttons).
 * - Parsed intent as TABLE with 項目|內容.
 * - Airport detail cards with SID/STAR, runway tables, foldable weather.
 * - Route detail table with SID/airway/STAR rows.
 * - Navigation waypoint table.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let llmSettings = LLMSettings.load();
  let currentCycle = localStorage.getItem('ai_flight_planner_cycle') || null;
  let currentTimezone = localStorage.getItem('ai_flight_planner_timezone') || 'UTC+8';
  let useEvaluator = localStorage.getItem('ai_flight_planner_evaluator') === 'true';

  let state = {
    planResult: null,       // POST /api/plan response
    selectedRoute: null,    // Selected RouteCandidateResponse
    candidateIndex: null,   // Index of selected candidate
  };

  // ── DOM refs ───────────────────────────────────────────────
  const $input = document.getElementById('routeInput');
  const $planBtn = document.getElementById('planBtn');
  const $status = document.getElementById('status');
  const $parsedCard = document.getElementById('parsedCard');
  const $parsedContent = document.getElementById('parsedContent');
  const $candidatesCard = document.getElementById('candidatesCard');
  const $candidatesContent = document.getElementById('candidatesContent');
  const $routeDetailSection = document.getElementById('routeDetailSection');
  const $warnings = document.getElementById('warnings');
  const $depAirportContent = document.getElementById('depAirportContent');
  const $arrAirportContent = document.getElementById('arrAirportContent');
  const $routeDetailContent = document.getElementById('routeDetailContent');
  const $navDetailContent = document.getElementById('navDetailContent');

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

  // ── Plan route (always k=3) ──────────────────────────────
  async function handlePlan() {
    const input = $input.value.trim();
    if (!input) {
      showStatus(I18N.t('error-empty-input'), 'error');
      return;
    }

    hideAllCards();

    setLoading(true);
    showStatus('Planning route...', 'loading');

    try {
      const result = await API.plan(input, 3, llmSettings, currentCycle);
      state.planResult = result;
      state.selectedRoute = null;
      state.candidateIndex = null;

      // Show parsed intent
      if (result.parsed) {
        renderParsedTable(result.parsed);
      }

      // Show candidates as clickable cards
      if (result.candidates && result.candidates.length > 0) {
        renderCandidateCards(result);
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
    $routeDetailSection.style.display = 'none';
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

  // ── Rendering: Parsed Intent (TABLE) ─────────────────────
  function renderParsedTable(parsed) {
    const altStr = parsed.cruise_altitude
      ? `FL${Math.round(parsed.cruise_altitude / 100)}`
      : '\u2014';

    const avoidParts = [];
    if (parsed.avoid_waypoints && parsed.avoid_waypoints.length > 0) {
      avoidParts.push('航点: ' + parsed.avoid_waypoints.join(', '));
    }
    if (parsed.avoid_airspaces && parsed.avoid_airspaces.length > 0) {
      avoidParts.push('空域: ' + parsed.avoid_airspaces.join(', '));
    }
    const avoidStr = avoidParts.length > 0 ? avoidParts.join('; ') : '\u2014';

    $parsedContent.innerHTML = `
      <table class="parsed-table">
        <thead><tr><th>\u9805\u76EE</th><th>\u5167\u5BB9</th></tr></thead>
        <tbody>
          <tr><td>${I18N.t('label-origin')}</td><td>${escapeHtml(parsed.origin || '?')}</td></tr>
          <tr><td>${I18N.t('label-destination')}</td><td>${escapeHtml(parsed.destination || '?')}</td></tr>
          <tr><td>${I18N.t('label-airway-type')}</td><td>${escapeHtml(parsed.airway_type || I18N.t('any'))}</td></tr>
          <tr><td>${I18N.t('label-cruise-alt')}</td><td>${escapeHtml(altStr)}</td></tr>
          <tr><td>\u822A\u7DDA\u898F\u907F</td><td>${escapeHtml(avoidStr)}</td></tr>
          <tr><td>${I18N.t('label-confidence')}</td><td>${Math.round((parsed.confidence || 0) * 100)}%</td></tr>
        </tbody>
      </table>`;
    $parsedCard.style.display = 'block';
  }

  // ── Rendering: Route Candidate Cards (clickable) ─────────
  function renderCandidateCards(result) {
    const labels = [
      '\u2605 \u6700\u4F73\u7DDA\u8DEF',      // ★ 最佳線路
      '\u25CB \u5019\u9078\u7DDA\u8DEF1',      // ○ 候選線路1
      '\u25CB \u5019\u9078\u7DDA\u8DEF2',      // ○ 候選線路2
    ];

    $candidatesContent.innerHTML = result.candidates.map((c, i) => {
      const label = labels[i] || `\u25CB \u5019\u9078\u7DDA\u8DEF${i + 1}`;
      const isBest = i === 0 || (c.index === (result.candidate_index ?? result.candidates[0]?.index ?? 0));

      return `
        <div class="route-card ${isBest ? 'best' : ''}"
             data-candidate-index="${c.index}"
             onclick="app.selectRoute(${c.index})">
          <div class="route-card-header">${label}</div>
          <div class="route-card-string">${escapeHtml(c.route_string)}</div>
          <div class="route-card-meta">
            <span>${I18N.t('distance-nm')}: ${c.total_distance_nm?.toFixed(0) || '?'} NM</span>
            ${c.segments ? '<span>' + c.segments.length + ' ' + I18N.t('segments') + '</span>' : ''}
            ${c.score != null ? '<span>Score: ' + c.score.toFixed(1) + '</span>' : ''}
          </div>
          ${c.eval_reason ? '<div class="route-card-reason">' + escapeHtml(c.eval_reason) + '</div>' : ''}
        </div>`;
    }).join('');

    $candidatesCard.style.display = 'block';
  }

  // ── Route Selection ──────────────────────────────────────
  async function handleSelectRoute(candidateIndex) {
    const result = state.planResult;
    if (!result || !result.candidates) return;

    const candidate = result.candidates.find(c => c.index === candidateIndex);
    if (!candidate) return;

    state.selectedRoute = candidate;
    state.candidateIndex = candidateIndex;

    const parsed = result.parsed;
    const dep = parsed?.origin || '';
    const arr = parsed?.destination || '';
    const routeString = candidate.route_string;

    // Extract dep_fix / arr_fix from route_string
    const fixes = extractFixesFromRoute(routeString);
    const depFix = fixes.dep_fix || '';
    const arrFix = fixes.arr_fix || '';

    // Show route detail section
    $routeDetailSection.style.display = 'block';

    // Highlight selected card
    document.querySelectorAll('.route-card').forEach(el => el.classList.remove('selected'));
    const selectedEl = document.querySelector(`.route-card[data-candidate-index="${candidateIndex}"]`);
    if (selectedEl) selectedEl.classList.add('selected');

    // Set loading states
    $depAirportContent.innerHTML = '<div class="panel-loading">Loading airport data...</div>';
    $arrAirportContent.innerHTML = '<div class="panel-loading">Loading airport data...</div>';
    $routeDetailContent.innerHTML = '<div class="panel-loading">Loading route details...</div>';
    $navDetailContent.innerHTML = '<div class="panel-loading">Loading waypoints...</div>';

    // Render route description right away (before airport grid)
    renderRouteDescription(candidate, parsed);

    // Parallel requests
    const [depResult, arrResult, wpResult, wxResult] = await Promise.allSettled([
      API.getAirportDetail(dep, depFix),
      API.getAirportDetail(arr, arrFix),
      API.getRouteWaypoints(candidateIndex),
      API.getWeather(dep, arr),
    ]);

    const depData = depResult.status === 'fulfilled' ? depResult.value : null;
    const arrData = arrResult.status === 'fulfilled' ? arrResult.value : null;
    const wpData = wpResult.status === 'fulfilled' ? wpResult.value : null;
    const wxData = wxResult.status === 'fulfilled' ? wxResult.value : null;

    if (depResult.status === 'rejected') console.warn('Departure airport detail failed:', depResult.reason);
    if (arrResult.status === 'rejected') console.warn('Arrival airport detail failed:', arrResult.reason);
    if (wpResult.status === 'rejected') console.warn('Waypoint request failed:', wpResult.reason);
    if (wxResult.status === 'rejected') console.warn('Weather request failed:', wxResult.reason);

    // Render departure airport card
    renderAirportCard($depAirportContent, dep, depFix, depData,
      wxData?.departure || null, '\uD83D\uDEEB');

    // Render arrival airport card
    renderAirportCard($arrAirportContent, arr, arrFix, arrData,
      wxData?.arrival || null, '\uD83D\uDEEC');

    // Render route detail table
    renderRouteDetailTable(candidate, dep, arr, depFix, arrFix, wpData);

    // Render navigation table
    renderNavigationTable(wpData?.waypoints || []);
  }

  // ── Extract fixes from route string ─────────────────────
  function extractFixesFromRoute(routeString) {
    if (!routeString) return { dep_fix: '', arr_fix: '' };
    const parts = routeString.trim().split(/\s+/);
    const sidIdx = parts.findIndex(p => p === 'SID');
    const starIdx = parts.findIndex(p => p === 'STAR');

    let dep_fix = '';
    let arr_fix = '';

    if (sidIdx >= 0 && sidIdx < parts.length - 1) {
      dep_fix = parts[sidIdx + 1];
    }
    if (starIdx > 0) {
      arr_fix = parts[starIdx - 1];
    }

    return { dep_fix, arr_fix };
  }

  // ── Route Description (before airport grid) ─────────────
  function renderRouteDescription(candidate, parsed) {
    const dep = parsed?.origin || '';
    const arr = parsed?.destination || '';
    const n = candidate.segments ? candidate.segments.length + 2 : '?'; // segments + SID + STAR
    const distance = candidate.total_distance_nm?.toFixed(0) || '?';

    // Direct bearing placeholder — updated after airport details load
    const bearingId = `route-bearing-${candidate.index}`;

    let html = `
      <div class="card route-description-card">
        <div class="card-title">\u2708\uFE0F \u6700\u4F73\u822A\u7DDA</div>
        <div class="route-desc-string">${escapeHtml(candidate.route_string)}</div>
        <div class="route-desc-text">
          <p>\u8DEF\u7DDA\u63CF\u8FF0\uFF1A\u5F9E ${escapeHtml(dep)} \u5230 ${escapeHtml(arr)}</p>
          <p>\u5168\u7A0B\u6578\u64DA\uFF1A\u5168\u7A0B\u5171 ${n} \u500B\u5C0E\u822A\u9EDE\uFF0C\u76F4\u98DB\u822A\u5411 <span id="${bearingId}">\u2014</span>\u00B0\uFF0C\u822A\u8DEF\u91CC\u7A0B ${distance} \u6D77\u91CC\u3002</p>
          <p>\u9AD8\u5EA6\u5EFA\u8B70\uFF1A\u4E2D\u570B RVSM \u5EFA\u8B70\u9AD8\u5EA6\uFF1A9200\u7C73(FL301)\u30019800\u7C73(FL321)\u300110400\u7C73(FL341) \u6216\u4EE5\u4E0A<br>\u3000\u3000\u3000\u3000\u3000\u3000 \u570B\u969B RVSM \u5EFA\u8B70\u9AD8\u5EA6\uFF1AFL290\u3001FL310\u3001FL330 \u6216\u4EE5\u4E0A</p>
        </div>
      </div>`;

    // Insert route description before the airport grid
    const $airportGrid = document.getElementById('airportGrid');
    // Remove existing route description card if any
    const existing = document.querySelector('.route-description-card');
    if (existing) existing.remove();
    if ($airportGrid) {
      $airportGrid.insertAdjacentHTML('beforebegin', html);
    }

    // Store bearing element ID for later update
    state._bearingElId = bearingId;
  }

  // ── Airport Card ─────────────────────────────────────────
  function renderAirportCard(container, icao, fix, data, weatherData, icon) {
    if (!data) {
      container.innerHTML = renderError(`Airport data unavailable for ${escapeHtml(icao)}`);
      return;
    }

    const ap = data.airport || data;
    const name = ap.name || icao;
    const city = ap.city || '';
    const country = ap.country || '';

    let html = '';

    // Airport name header
    html += `<div class="airport-header">${icon} <strong>${escapeHtml(icao)} — ${escapeHtml(name)}</strong>`;
    if (city || country) {
      html += ` <span class="airport-location">${escapeHtml(city)}${city && country ? ', ' : ''}${escapeHtml(country)}</span>`;
    }
    html += '</div>';

    // Update route description bearing if we have coordinates
    if (ap.lat != null && ap.lon != null) {
      state['_ap_' + icao] = { lat: ap.lat, lon: ap.lon };
      updateRouteBearing();
    }

    // SID/STAR table
    const hasProcedures = (data.sids && data.sids.length > 0) || (data.stars && data.stars.length > 0);
    if (hasProcedures) {
      html += '<div class="airport-section"><div class="airport-section-title">\u25B6 \u9032/\u96E2\u5834\u7A0B\u5E8F</div>';
      html += '<table class="proc-table"><thead><tr><th>\u7A0B\u5E8F</th><th>\u4F7F\u7528\u8DD1\u9053</th><th>\u9032/\u96E2\u5834\u9EDE</th></tr></thead><tbody>';

      if (data.sids) {
        data.sids.forEach(s => {
          html += `<tr><td>SID ${escapeHtml(s.name)}</td><td>${escapeHtml((s.runways || []).join(', '))}</td><td>${escapeHtml(s.transition_fix || s.transition || '\u2014')}</td></tr>`;
        });
      }
      if (data.stars) {
        data.stars.forEach(s => {
          html += `<tr><td>STAR ${escapeHtml(s.name)}</td><td>${escapeHtml((s.runways || []).join(', '))}</td><td>${escapeHtml(s.transition_fix || s.transition || '\u2014')}</td></tr>`;
        });
      }

      html += '</tbody></table></div>';
    } else {
      html += '<p class="no-data">No SID/STAR procedures available</p>';
    }

    // Runway table
    if (data.runways && data.runways.length > 0) {
      html += '<div class="airport-section"><div class="airport-section-title">\u25B6 \u8DD1\u9053\u4FE1\u606F</div>';
      html += '<table class="runway-table"><thead><tr>';
      html += '<th>\u8DD1\u9053</th><th>\u9577\u5EA6(ft)</th><th>\u5BEC\u5EA6(ft)</th><th>\u9AD8\u5EA6(ft)</th><th>\u822A\u5411(\u00B0)</th><th>GP\u4E0B\u6ED1(\u00B0)</th><th>ILS\u983B\u7387</th><th>\u6A19\u8B58</th><th>CAT</th><th>DME</th><th>\u904E\u6E21\u9AD8\u5EA6(ft)</th>';
      html += '</tr></thead><tbody>';

      data.runways.forEach(r => {
        html += '<tr>';
        html += `<td>${escapeHtml(r.name || r.ident || '\u2014')}</td>`;
        html += `<td>${r.length_ft != null ? r.length_ft.toLocaleString() : '\u2014'}</td>`;
        html += `<td>${r.width_ft != null ? r.width_ft : '\u2014'}</td>`;
        html += `<td>${r.elevation_ft != null ? r.elevation_ft : '\u2014'}</td>`;
        html += `<td>${r.heading_deg != null ? r.heading_deg : '\u2014'}</td>`;
        html += `<td>${r.glidepath_deg != null ? r.glidepath_deg.toFixed(1) : '\u2014'}</td>`;
        html += `<td>${escapeHtml(r.ils_freq || '\u2014')}</td>`;
        html += `<td>${escapeHtml(r.ils_ident || '\u2014')}</td>`;
        html += `<td>${escapeHtml(r.ils_cat || '\u2014')}</td>`;
        html += `<td>${r.dme != null ? (r.dme ? '\u2713' : '\u2717') : '\u2014'}</td>`;
        html += `<td>${r.transition_alt_ft != null ? r.transition_alt_ft : '\u2014'}</td>`;
        html += '</tr>';
      });

      html += '</tbody></table></div>';
    }

    // Weather section (collapsible)
    if (weatherData && (weatherData.metar || weatherData.taf || weatherData.metar_raw || weatherData.taf_raw)) {
      const wxId = 'wx-' + icao + '-' + Date.now();
      html += '<div class="airport-section weather-toggle-section">';
      html += `<div class="airport-section-title collapsible-header" onclick="document.getElementById('${wxId}').classList.toggle('collapsed');this.classList.toggle('expanded')">`;
      html += `\u25B6 \u6C23\u8C61\u4FE1\u606F (\u9EDE\u64CA\u5C55\u958B/\u6536\u5408)`;
      html += `<button class="btn btn-small weather-refresh-btn" onclick="event.stopPropagation();app.refreshWeather('${escapeAttr(icao)}', ${state.candidateIndex})" style="margin-left:12px">\uD83D\uDD04</button>`;
      html += '</div>';
      html += `<div id="${wxId}" class="collapsible-content collapsed">`;
      html += renderWeatherContent(icao, weatherData);
      html += '</div></div>';
    }

    container.innerHTML = html;
  }

  // ── Update bearing in route description ─────────────────
  function updateRouteBearing() {
    if (!state.selectedRoute || !state._bearingElId) return;
    const parsed = state.planResult?.parsed;
    const dep = parsed?.origin;
    const arr = parsed?.destination;
    if (!dep || !arr) return;

    const depCoord = state['_ap_' + dep];
    const arrCoord = state['_ap_' + arr];
    if (!depCoord || !arrCoord) return;

    const bearing = computeBearing(depCoord.lat, depCoord.lon, arrCoord.lat, arrCoord.lon);
    const el = document.getElementById(state._bearingElId);
    if (el) el.textContent = bearing;
  }

  function computeBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return ((brng + 360) % 360).toFixed(0);
  }

  // ── Route Detail Table ──────────────────────────────────
  function renderRouteDetailTable(candidate, dep, arr, depFix, arrFix, wpData) {
    const waypoints = wpData?.waypoints || [];
    const segments = candidate.segments || [];

    let html = '<table class="route-detail-table"><thead><tr>';
    html += '<th>\u822A\u8DEF</th><th>\u8D77\u9EDE</th><th>\u7D42\u9EDE</th><th>\u8DDD\u96E2(\u6D77\u91CC)</th><th>\u822A\u5411</th>';
    html += '</tr></thead><tbody>';

    // First row: SID
    html += '<tr>';
    html += '<td><strong>SID</strong></td>';
    html += `<td>${escapeHtml(dep)}</td>`;
    html += `<td>${escapeHtml(depFix || '\u2014')}</td>`;
    html += `<td>${segments[0]?.distance_nm?.toFixed(0) || '\u2014'}</td>`;
    html += `<td>${segments[0] ? computeSegBearing(segments[0], 0, waypoints) : '\u2014'}</td>`;
    html += '</tr>';

    // Middle rows: airway segments
    segments.forEach((seg, i) => {
      html += '<tr>';
      html += `<td>${escapeHtml(seg.airway || seg.airway_name || '\u2014')}</td>`;
      html += `<td>${escapeHtml(seg.from || seg.from_ident || '\u2014')}</td>`;
      html += `<td>${escapeHtml(seg.to || seg.to_ident || '\u2014')}</td>`;
      html += `<td>${seg.distance_nm != null ? seg.distance_nm.toFixed(0) : '\u2014'}</td>`;
      html += `<td>${computeSegBearing(seg, i, waypoints)}</td>`;
      html += '</tr>';
    });

    // Last row: STAR
    const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null;
    html += '<tr>';
    html += '<td><strong>STAR</strong></td>';
    html += `<td>${escapeHtml(arrFix || '\u2014')}</td>`;
    html += `<td>${escapeHtml(arr)}</td>`;
    html += `<td>${lastSeg?.distance_nm?.toFixed(0) || '\u2014'}</td>`;
    html += `<td>${lastSeg ? computeSegBearing(lastSeg, segments.length - 1, waypoints) : '\u2014'}</td>`;
    html += '</tr>';

    html += '</tbody></table>';

    // Copy button
    html += `<button class="copy-btn" style="margin-top:8px" onclick="navigator.clipboard.writeText('${escapeAttr(candidate.route_string)}');showToast('${I18N.t('toast-route-copied')}')">\uD83D\uDCCB \u8907\u88FD\u822A\u8DEF</button>`;

    $routeDetailContent.innerHTML = html;
  }

  function computeSegBearing(seg, idx, waypoints) {
    // Try to compute bearing from waypoints
    const fromIdent = (seg.from || seg.from_ident || '').toUpperCase();
    const toIdent = (seg.to || seg.to_ident || '').toUpperCase();

    const fromWp = waypoints.find(w => (w.ident || '').toUpperCase() === fromIdent);
    const toWp = waypoints.find(w => (w.ident || '').toUpperCase() === toIdent);

    if (fromWp && toWp && fromWp.lat != null && fromWp.lon != null && toWp.lat != null && toWp.lon != null) {
      return computeBearing(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon) + '\u00B0';
    }

    // Fallback: use waypoint index positions
    if (idx < waypoints.length - 1) {
      const w1 = waypoints[idx];
      const w2 = waypoints[idx + 1];
      if (w1 && w2 && w1.lat != null && w1.lon != null && w2.lat != null && w2.lon != null) {
        return computeBearing(w1.lat, w1.lon, w2.lat, w2.lon) + '\u00B0';
      }
    }

    return '\u2014';
  }

  // ── Navigation Table ─────────────────────────────────────
  function renderNavigationTable(waypoints) {
    if (!waypoints || waypoints.length === 0) {
      $navDetailContent.innerHTML = '<p class="no-data">No waypoint data available</p>';
      return;
    }

    function wpTypeLabel(w) {
      const type = (w.type || '').toUpperCase();
      if (type === 'VOR' || type === 'VOR-DME' || type === 'VORTAC') return 'VORD';
      if (type === 'NDB') return 'NDB';
      return 'Waypoint';
    }

    function freqStr(w) {
      const type = (w.type || '').toUpperCase();
      if (w.frequency == null) return '\u2014';
      if (type === 'NDB') {
        return (w.frequency / 1000).toFixed(0) + ' kHz';
      }
      // VOR / other: frequency is in kHz*100, convert to MHz
      return (w.frequency / 1000).toFixed(2) + ' MHz';
    }

    let html = '<table class="nav-table"><thead><tr>';
    html += '<th>\u5C0E\u822A\u9EDE</th><th>\u985E\u578B</th><th>\u983B\u7387</th><th>\u7DEF\u5EA6</th><th>\u7D93\u5EA6</th>';
    html += '</tr></thead><tbody>';

    waypoints.forEach(w => {
      html += '<tr>';
      html += `<td>${escapeHtml(w.ident)}</td>`;
      html += `<td>${escapeHtml(wpTypeLabel(w))}</td>`;
      html += `<td>${freqStr(w)}</td>`;
      html += `<td>${w.lat != null ? w.lat.toFixed(3) : '\u2014'}</td>`;
      html += `<td>${w.lon != null ? w.lon.toFixed(3) : '\u2014'}</td>`;
      html += '</tr>';
    });

    html += '</tbody></table>';
    $navDetailContent.innerHTML = html;
  }

  // ── Weather Content (for airport card) ──────────────────

  const WX_CN = {
    '+': '\u5927', '-': '\u5C0F', VC: '\u9644\u8FD1',
    MI: '\u6DFA', PR: '\u90E8\u5206', BC: '\u788E\u7247', DR: '\u4F4E\u5439', BL: '\u9AD8\u5439',
    SH: '\u9663\u6027', TS: '\u96F7\u66B4', FZ: '\u51CD\u7D50',
    RA: '\u96E8', SN: '\u96EA', DZ: '\u6BDB\u6BDB\u96E8', SG: '\u96EA\u7C92',
    PL: '\u51B0\u7C92', GR: '\u51B0\u96F9', GS: '\u5C0F\u51B0\u96F9',
    BR: '\u9744', FG: '\u9727', HZ: '\u9729', SA: '\u63DA\u6C99',
    DU: '\u6D6E\u5875', FU: '\u7159', VA: '\u706B\u5C71\u7070',
    SQ: '\u98AE', DS: '\u6C99\u5875\u66B4', SS: '\u6C99\u66B4',
    PY: '\u6C34\u9727', FC: '\u6F0F\u6597\u96F2',
  };
  const CLOUD_TYPE_CN = { CB: '\u7A4D\u96E8\u96F2', TCU: '\u6FC3\u7A4D\u96F2' };
  const FLIGHT_RULES_CN = {
    VFR: 'VFR (\u76EE\u8996\u98DB\u884C\u898F\u5247)', MVFR: 'MVFR (\u908A\u969B\u76EE\u8996\u98DB\u884C\u898F\u5247)',
    IFR: 'IFR (\u5100\u8868\u98DB\u884C\u898F\u5247)', LIFR: 'LIFR (\u4F4E\u5100\u8868\u98DB\u884C\u898F\u5247)',
  };
  const CLOUD_CN = {
    FEW: '\u5C11\u96F2', SCT: '\u758F\u96F2', BKN: '\u591A\u96F2', OVC: '\u9670\u5929',
    SKC: '\u6674\u7A7A', CLR: '\u6674\u7A7A', NSC: '\u7121\u986F\u8457\u96F2', NCD: '\u7121\u96F2',
  };

  function stripMetarPrefix(raw) {
    return (raw || '').replace(/^(METAR|SPECI)\s+/i, '').trim();
  }

  function stripTafPrefix(raw) {
    return (raw || '').replace(/^TAF\s+/i, '').trim();
  }

  function translateWx(code) {
    if (!code) return '';
    code = code.toUpperCase();
    const parts = [];
    let c = code;

    if (c.startsWith('+')) { parts.push(WX_CN['+']); c = c.slice(1); }
    else if (c.startsWith('-')) { parts.push(WX_CN['-']); c = c.slice(1); }

    if (c.startsWith('VC')) { parts.push(WX_CN.VC); c = c.slice(2); }

    for (const desc of ['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ']) {
      if (c.startsWith(desc)) { parts.push(WX_CN[desc] || desc); c = c.slice(desc.length); break; }
    }

    for (const key of Object.keys(WX_CN).sort((a, b) => b.length - a.length)) {
      if (['+', '-', 'VC', 'MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ'].includes(key)) continue;
      if (c.startsWith(key)) { parts.push(WX_CN[key]); c = c.slice(key.length); break; }
    }

    if (!parts.length) return code;

    let emoji = '\uD83C\uDF21\uFE0F';
    if (code.includes('TS')) emoji = code.includes('RA') ? '\u26C8\uFE0F' : '\uD83C\uDF29\uFE0F';
    else if (code.includes('SH')) emoji = '\uD83C\uDF26\uFE0F';
    else if (code.includes('RA')) emoji = '\uD83C\uDF27\uFE0F';
    else if (code.includes('SN')) emoji = '\uD83C\uDF28\uFE0F';
    else if (code.includes('FG')) emoji = '\uD83C\uDF2B\uFE0F';
    else if (code.includes('FZ')) emoji = '\uD83E\uDDCA';

    return `${emoji} ${parts.join('')} (${code})`;
  }

  function translateCloud(c) {
    if (!c) return '';
    const cn = CLOUD_CN[c.cover] || c.cover;
    const h = c.height_ft != null ? ` ${c.height_ft}\u82F1\u5C3A` : '';
    const codeH = c.height_ft != null ? Math.round(c.height_ft / 100) : '';
    const codeStr = c.cover ? ` (${c.cover}${codeH})` : '';

    let dangerTag = '';
    if (c.is_dangerous) {
      const typeCN = c.cloud_type_cn || CLOUD_TYPE_CN[c.cloud_type] || c.cloud_type || '';
      dangerTag = ` \u26A0\uFE0F${typeCN}`;
    }

    return `${c.emoji || ''} ${cn}${h}${codeStr}${dangerTag}`;
  }

  function renderWeatherContent(icao, wx) {
    const ap = wx.airport || {};
    const apName = ap.name || icao || '';

    let html = '';

    // ── METAR ──
    if (wx.metar) {
      const m = wx.metar;
      html += '<div class="weather-section">';
      html += '<div class="weather-section-title">\uD83D\uDCE1 METAR \u5929\u6C23\u5831\u544A</div>';
      html += `<pre class="weather-raw">${escapeHtml(stripMetarPrefix(m.raw || wx.metar_raw || ''))}</pre>`;

      html += '<div class="weather-section-title">\uD83D\uDCCB METAR \u5831\u6587\u89E3\u6790</div>';
      html += '<table class="weather-table"><tbody>';

      const latLon = ap.lat != null && ap.lon != null
        ? ` \u7DEF\u7D93\u5EA6: ${ap.lat.toFixed(3)} / ${ap.lon.toFixed(3)}` : '';
      const elev = m.elevation_m != null ? ` ${m.elevation_m} M` : '';
      html += `<tr><td class="wx-label">\u6A5F\u5834\u4EE3\u78BC</td><td class="wx-value">\u3010 ${escapeHtml(icao)} (${escapeHtml(apName)}${latLon}) \u3011</td>`
        + (elev ? `<td class="wx-label">\u6D77\u62D4\u9AD8\u5EA6</td><td class="wx-value">\u3010 ${elev} \u3011</td>` : '<td></td><td></td>') + '</tr>';

      html += '<tr>';
      html += `<td class="wx-label">\u4FEE\u6B63\u6D77\u58D3</td><td class="wx-value">\u3010 ${m.pressure_hpa != null ? m.pressure_hpa + ' hPa' : '\u2014'} \u3011</td>`;
      html += `<td class="wx-label">\u6A5F\u5834\u6EAB\u5EA6</td><td class="wx-value">\u3010 ${m.temp_c != null ? m.temp_c + ' \u00B0C' : '\u2014'}  / \u9732\u9EDE ${m.dewpt_c != null ? m.dewpt_c + ' \u00B0C' : '\u2014'} \u3011</td>`;
      html += '</tr>';

      html += '<tr>';
      html += `<td class="wx-label">\u98DB\u884C\u898F\u5247</td><td class="wx-value">\u3010 ${FLIGHT_RULES_CN[m.flight_rules] || m.flight_rules || '\u2014'} \u3011</td>`;
      html += `<td class="wx-label">\u80FD\u898B\u5EA6</td><td class="wx-value">\u3010 ${m.visibility_str || (m.visibility_m != null ? m.visibility_m >= 10000 ? '\uD83D\uDD2D \u80FD\u898B\u5EA6\u826F\u597D' : m.visibility_m + 'm' : '\u2014')} \u3011</td>`;
      html += '</tr>';

      const wind = m.wind || {};
      const windStr = wind.dir_cn
        ? `${wind.arrow || ''} ${wind.dir_cn} @ ${wind.speed_kts || '?'} \u7BC0`
        : (m.wind_text || '\u2014');
      const gustStr = wind.gust_kts ? ` Gust ${wind.gust_kts}kt` : '';
      html += '<tr>';
      html += `<td class="wx-label">\u98A8\u901F\u98A8\u5411</td><td class="wx-value">\u3010 ${escapeHtml(windStr + gustStr)} \u3011</td>`;
      html += `<td class="wx-label">\u66F4\u65B0\u6642\u9593</td><td class="wx-value">\u3010 ${escapeHtml(wx.updated_iso || wx.updated || m.time || '\u2014')} \u3011</td>`;
      html += '</tr>';

      if (m.weather && m.weather.length > 0) {
        html += '<tr>';
        html += `<td class="wx-label">\u5929\u6C23\u73FE\u8C61</td><td class="wx-value" colspan="3">\u3010 ${m.weather.map(translateWx).join(' ')} \u3011</td>`;
        html += '</tr>';
      }

      if (m.clouds && m.clouds.length > 0) {
        html += '<tr>';
        html += `<td class="wx-label">\u96F2\u5C64</td><td class="wx-value" colspan="3">\u3010 ${m.clouds.map(translateCloud).join(' ')} \u3011</td>`;
        html += '</tr>';
      }

      html += '</tbody></table></div>';
    } else if (wx.metar_raw) {
      html += '<div class="weather-section">';
      html += '<div class="weather-section-title">\uD83D\uDCE1 METAR \u5929\u6C23\u5831\u544A</div>';
      html += `<pre class="weather-raw">${escapeHtml(stripMetarPrefix(wx.metar_raw))}</pre>`;
      html += '</div>';
    }

    // ── TAF ──
    if (wx.taf) {
      const t = wx.taf;
      html += '<div class="weather-section">';
      html += '<div class="weather-section-title">\uD83D\uDCE1 TAF \u5929\u6C23\u9810\u5831</div>';
      html += `<pre class="weather-raw">${escapeHtml(stripTafPrefix(t.raw || wx.taf_raw || ''))}</pre>`;

      html += '<div class="weather-section-title">\uD83D\uDCCB TAF \u5831\u6587\u89E3\u6790</div>';
      html += '<table class="weather-table"><tbody>';

      const timeFrom = t.time_from || '\u2014';
      const timeTo = t.time_to || '\u2014';
      html += '<tr>';
      html += `<td class="wx-label">\u6A5F\u5834\u4EE3\u78BC</td><td class="wx-value">\u3010 ${escapeHtml(icao)} (${escapeHtml(apName)}) \u3011</td>`;
      html += `<td class="wx-label">\u9810\u5831\u6642\u6548</td><td class="wx-value">\u3010 ${timeFrom} \u81F3 ${timeTo} (UTC) \u3011</td>`;
      html += '</tr>';

      if (t.max_temp_c != null || t.min_temp_c != null) {
        html += '<tr>';
        const maxT = t.max_temp_c != null ? `${t.max_temp_c}\u00B0C${t.max_temp_time ? ' (' + t.max_temp_time + ')' : ''}` : '\u2014';
        const minT = t.min_temp_c != null ? `${t.min_temp_c}\u00B0C${t.min_temp_time ? ' (' + t.min_temp_time + ')' : ''}` : '\u2014';
        html += `<td class="wx-label">\u6700\u9AD8\u6EAB\u5EA6</td><td class="wx-value">\u3010 ${maxT} \u3011</td>`;
        html += `<td class="wx-label">\u6700\u4F4E\u6EAB\u5EA6</td><td class="wx-value">\u3010 ${minT} \u3011</td>`;
        html += '</tr>';
      }

      const twind = t.wind || {};
      const twindStr = twind.dir_cn
        ? `${twind.arrow || ''} ${twind.dir_cn} @ ${twind.speed_kts || '?'} \u7BC0`
        : (t.wind_text || '\u2014');
      html += '<tr>';
      html += `<td class="wx-label">\u4E3B\u5C0E\u98A8\u5411\u98A8\u901F</td><td class="wx-value">\u3010 ${escapeHtml(twindStr)} \u3011</td>`;
      html += `<td class="wx-label">\u80FD\u898B\u5EA6</td><td class="wx-value">\u3010 ${escapeHtml(t.visibility_str || '\u2014')} \u3011</td>`;
      html += '</tr>';

      if (t.clouds && t.clouds.length > 0) {
        html += '<tr>';
        html += `<td class="wx-label">\u96F2\u5C64\u72C0\u6CC1</td><td class="wx-value" colspan="3">\u3010 ${t.clouds.map(translateCloud).join(' ')} \u3011</td>`;
        html += '</tr>';
      }

      if (t.trends && t.trends.length > 0) {
        html += '<tr>';
        html += '<td class="wx-label">\u8B8A\u5316\u8DA8\u52E2</td>';
        html += '<td class="wx-value" colspan="3">';
        html += t.trends.map(tr => {
          const parts = [];
          parts.push(`\u23F3 ${tr.kind} ${tr.time_from || '?'}-${tr.time_to || '?'}Z`);

          const detailParts = [];
          if (tr.wind_text) detailParts.push(escapeHtml(tr.wind_text));
          if (tr.visibility_str) detailParts.push(escapeHtml(tr.visibility_str));
          else if (tr.visibility_m != null) detailParts.push(`${tr.visibility_m}m`);
          if (tr.clouds && tr.clouds.length > 0) detailParts.push(tr.clouds.map(translateCloud).join(' '));
          if (tr.weather && tr.weather.length > 0) detailParts.push(tr.weather.map(translateWx).join(' '));

          if (detailParts.length > 0) parts.push(`  ${detailParts.join('\uFF0C')}`);
          return parts.join('');
        }).join('<br>');
        html += '</td></tr>';
      }

      html += '</tbody></table></div>';
    } else if (wx.taf_raw) {
      html += '<div class="weather-section">';
      html += '<div class="weather-section-title">\uD83D\uDCE1 TAF \u5929\u6C23\u9810\u5831</div>';
      html += `<pre class="weather-raw">${escapeHtml(stripTafPrefix(wx.taf_raw))}</pre>`;
      html += '</div>';
    }

    if (!wx.metar && !wx.taf && !wx.metar_raw && !wx.taf_raw) {
      html = '<p class="no-data">No weather data</p>';
    }

    return html;
  }

  async function handleWeatherRefresh(icao, candidateIndex) {
    const parsed = state.planResult?.parsed;
    if (!parsed) return;

    const dep = parsed.origin;
    const arr = parsed.destination;

    try {
      const data = await API.getWeather(dep, arr);
      const wx = icao === dep ? data.departure : data.arrival;
      if (wx) {
        // Re-render just the weather section within the airport card
        const container = icao === dep
          ? $depAirportContent
          : $arrAirportContent;

        // Find and update weather content in the container
        const wxContainers = container.querySelectorAll('.collapsible-content');
        wxContainers.forEach(el => {
          el.innerHTML = renderWeatherContent(icao, wx);
        });
      }
      showToast(I18N.t('toast-weather-refreshed'));
    } catch (e) {
      showToast(I18N.t('toast-weather-fail') + ': ' + e.message);
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
      return `<div class="warning-item">\u26A0\uFE0F ${escapeHtml(translated)}</div>`;
    }).join('');
  }

  // ── Helpers ───────────────────────────────────────────────
  function renderError(msg) {
    return `<p class="no-data error">\u26A0\uFE0F ${escapeHtml(msg)}</p>`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/\"/g, '&quot;');
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
      showToast(`\u274C ${I18N.t('toast-connection-fail')}${e.message}`);
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
    $fetchBtn.textContent = '\u23F3';

    try {
      const models = await LLMSettings.fetchModels(baseUrl, apiKey);
      if (models.length === 0) {
        LLMSettings.populateModels(['(no models fetched)']);
        showToast('No models found — type one below \u2B07\uFE0F');
      } else {
        LLMSettings.populateModels(models);
        showToast(`Found ${models.length} models`);
      }
    } catch (e) {
      LLMSettings.populateModels(['(fetch failed)']);
      showToast(`Error: ${e.message} — type model below`);
    }

    $fetchBtn.disabled = false;
    $fetchBtn.textContent = '\uD83D\uDD04';
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
    $toggleKey.textContent = input.type === 'password' ? '\uD83D\uDC41' : '\uD83D\uDE48';
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
    refreshWeather: handleWeatherRefresh,
  };

  // ── Start ─────────────────────────────────────────────────
  init();
})();
