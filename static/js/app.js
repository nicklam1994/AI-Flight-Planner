/**
 * AI Flight Planner — main application logic.
 *
 * Coordinates the UI, API calls, LLM settings panel, and result rendering.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let llmSettings = LLMSettings.load();
  let currentCycle = localStorage.getItem('ai_flight_planner_cycle') || null;

  // ── DOM refs ───────────────────────────────────────────────
  const $input = document.getElementById('routeInput');
  const $kSelect = document.getElementById('kSelect');
  const $planBtn = document.getElementById('planBtn');
  const $status = document.getElementById('status');
  const $parsedCard = document.getElementById('parsedCard');
  const $parsedContent = document.getElementById('parsedContent');
  const $resultsCard = document.getElementById('resultsCard');
  const $resultsContent = document.getElementById('resultsContent');
  const $warnings = document.getElementById('warnings');

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

    // Cycle dropdown
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

      // Populate dropdown
      $cycleSelect.innerHTML = data.cycles.map(c =>
        `<option value="${c.id}">${c.label || c.id}</option>`
      ).join('');

      // Select the saved preference or server default
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
    showToast(`AIRAC cycle: ${cycle}`);
  }

  // ── Plan route ────────────────────────────────────────────
  async function handlePlan() {
    const input = $input.value.trim();
    if (!input) {
      showStatus('Please enter a route request (e.g., "VHHH to RJTT")', 'error');
      return;
    }

    const k = parseInt($kSelect.value, 10);

    // Hide previous results
    $parsedCard.style.display = 'none';
    $resultsCard.style.display = 'none';
    $warnings.innerHTML = '';

    // Show loading
    setLoading(true);
    showStatus('Planning route...', 'loading');

    try {
      const result = await API.plan(input, k, llmSettings, currentCycle);

      // Show parsed intent
      if (result.parsed) {
        renderParsed(result.parsed);
      }

      // Show results
      if (result.candidates && result.candidates.length > 0) {
        renderResults(result);
      } else if (result.error) {
        showStatus(result.error, 'error');
      }

      // Show warnings
      if (result.warnings && result.warnings.length > 0) {
        renderWarnings(result.warnings);
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
    $planBtn.textContent = loading ? 'Planning...' : '✈️ Plan Route';
  }

  // ── Rendering ─────────────────────────────────────────────
  function showStatus(msg, type) {
    $status.textContent = msg;
    $status.className = `status show status-${type}`;
  }

  function hideStatus() {
    $status.className = 'status';
  }

  function renderParsed(parsed) {
    const items = [
      ['Origin', parsed.origin || '?'],
      ['Destination', parsed.destination || '?'],
      ['Airway Type', parsed.airway_type || 'Any'],
      ['Cruise Alt', parsed.cruise_altitude ? `FL${Math.round(parsed.cruise_altitude / 100)}` : '—'],
      ['Confidence', `${Math.round((parsed.confidence || 0) * 100)}%`],
    ];

    if (parsed.avoid_waypoints?.length) {
      items.push(['Avoid WPs', parsed.avoid_waypoints.join(', ')]);
    }
    if (parsed.avoid_airspaces?.length) {
      items.push(['Avoid Airspaces', parsed.avoid_airspaces.join(', ')]);
    }

    $parsedContent.innerHTML = items.map(([label, value]) =>
      `<div class="parsed-item">
        <div class="label">${label}</div>
        <div>${value}</div>
      </div>`
    ).join('');
    $parsedCard.style.display = 'block';
  }

  function renderResults(result) {
    const bestIdx = result.candidates[0]?.index ?? 0;

    $resultsContent.innerHTML = result.candidates.map((c, i) => {
      const isBest = c.index === bestIdx;
      const scoreHtml = c.score != null
        ? `<span class="result-score">${c.score.toFixed(1)}</span>`
        : '';

      // Build segment flow
      const flowHtml = c.segments?.length
        ? `<div class="segment-flow">${c.segments.map(s =>
            `<span class="segment-badge">${s.from_ident}</span>
             <span class="segment-arrow">→</span>
             ${s.segment_type === 'airway' ? `<span class="segment-badge" style="color:var(--accent)">${s.airway_name}</span><span class="segment-arrow">→</span>` : ''}
             <span class="segment-badge">${s.to_ident}</span>`
          ).join(' ')}</div>`
        : '';

      return `
        <div class="card result-card ${isBest ? 'result-best' : ''}">
          <div class="result-header">
            <strong>${isBest ? '⭐ Best Route' : `○ Alternative #${i + 1}`}</strong>
            ${scoreHtml}
          </div>
          <div class="route-string">${c.route_string}</div>
          <div class="route-meta">
            Distance: ${c.total_distance_nm?.toFixed(0) || '?'} NM
            ${c.segments ? `· ${c.segments.length} segments` : ''}
          </div>
          ${c.eval_reason ? `<div class="route-reason">${c.eval_reason}</div>` : ''}
          ${flowHtml}
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${c.route_string.replace(/'/g, "\\'")}');showToast('Route copied!')">
            📋 Copy Route String
          </button>
        </div>
      `;
    }).join('');

    $resultsCard.style.display = 'block';
  }

  function renderWarnings(warnings) {
    $warnings.innerHTML = warnings.map(w =>
      `<div class="warning-item">⚠️ ${w}</div>`
    ).join('');
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
    showToast('Settings saved!');
  }

  function resetSettings() {
    llmSettings = LLMSettings.reset();
    LLMSettings.populateForm(llmSettings);
    showToast('Settings reset to defaults');
  }

  async function testConnection() {
    const settings = LLMSettings.readForm();
    $testConnBtn.disabled = true;
    $testConnBtn.textContent = 'Testing...';

    try {
      // Try a minimal chat completion
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
        showToast('✅ Connection successful!');
      } else {
        const err = await res.text().catch(() => 'Unknown error');
        showToast(`❌ Failed: ${res.status} ${err.substring(0, 60)}`);
      }
    } catch (e) {
      showToast(`❌ Connection failed: ${e.message}`);
    } finally {
      $testConnBtn.disabled = false;
      $testConnBtn.textContent = '🧪 Test Connection';
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

  // ── Start ─────────────────────────────────────────────────
  init();
})();
