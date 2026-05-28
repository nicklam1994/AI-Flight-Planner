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
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      showStatus('Planning route... ' + elapsed + 's', 'loading');
    }, 1000);

    try {
      const result = await API.plan(input, 3, llmSettings, currentCycle, useEvaluator);
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
      clearInterval(timerInterval);
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

  function normalizeAircraft(raw) {
    if (!raw) return '';
    const s = raw.trim();
    const map = {
      'B738': 'Boeing 737-800', 'B737': 'Boeing 737', 'B739': 'Boeing 737-900',
      'B738W': 'Boeing 737-800W', 'B77W': 'Boeing 777-300ER', 'B772': 'Boeing 777-200',
      'B773': 'Boeing 777-300', 'B788': 'Boeing 787-8', 'B789': 'Boeing 787-9',
      'B78X': 'Boeing 787-10', 'B744': 'Boeing 747-400', 'B748': 'Boeing 747-8',
      'A320': 'Airbus A320', 'A319': 'Airbus A319', 'A321': 'Airbus A321',
      'A332': 'Airbus A330-200', 'A333': 'Airbus A330-300', 'A359': 'Airbus A350-900',
      'A388': 'Airbus A380-800',
      'CRJ2': 'Bombardier CRJ200', 'CRJ7': 'Bombardier CRJ700', 'CRJ9': 'Bombardier CRJ900',
      'E170': 'Embraer E170', 'E175': 'Embraer E175', 'E190': 'Embraer E190', 'E195': 'Embraer E195',
    };
    const upper = s.toUpperCase();
    if (map[upper]) return map[upper];
    if (/^(boeing|airbus|bombardier|embraer)/i.test(s)) return s;
    return s;
  }

  
  function normalizeAircraft(raw) {
    if (!raw) return '';
    var s = raw.trim();
    var map = {
  'A124': 'Antonov An-124 Ruslan',
  'A140': 'Antonov An-140',
  'A148': 'Antonov An-148',
  'A158': 'Antonov An-158',
  'A19N': 'Airbus A319neo',
  'A20N': 'Airbus A320neo',
  'A21N': 'Airbus A321neo/LR/XLR',
  'A225': 'Antonov An-225 Mriya',
  'A306': 'Airbus A300-600',
  'A30B': 'Airbus A300B2, A300B4 and A300C4',
  'A310': 'Airbus A310-200',
  'A318': 'Airbus A318',
  'A319': 'Airbus A319',
  'A320': 'Airbus A320',
  'A321': 'Airbus A321',
  'A332': 'Airbus A330-200',
  'A333': 'Airbus A330-300',
  'A337': 'Airbus A330-700 "BelugaXL"',
  'A338': 'Airbus A330-800',
  'A339': 'Airbus A330-900',
  'A342': 'Airbus A340-200',
  'A343': 'Airbus A340-300',
  'A345': 'Airbus A340-500',
  'A346': 'Airbus A340-600',
  'A359': 'Airbus A350-900',
  'A35K': 'Airbus A350-1000',
  'A388': 'Airbus A380-800',
  'A3ST': 'Airbus A300-600ST "Super Transporter" / "Beluga"',
  'A400': 'Airbus A400M Atlas',
  'A748': 'Hawker Siddeley HS 748',
  'AC90': 'Gulfstream/Rockwell (Aero) Turbo Commander 690',
  'AJ27': 'Comac ARJ21-700 / C909',
  'AN12': 'Antonov An-12',
  'AN24': 'Antonov An-24',
  'AN26': 'Antonov An-26',
  'AN28': 'Antonov An-28',
  'AN30': 'Antonov An-30',
  'AN32': 'Antonov An-32',
  'AN72': 'Antonov An-72 / An-74',
  'AT43': 'Aerospatiale/Alenia ATR 42-300 / 320',
  'AT45': 'Aerospatiale/Alenia ATR 42-500',
  'AT46': 'Aerospatiale/Alenia ATR 42-600',
  'AT72': 'Aerospatiale/Alenia ATR 72-201/-202',
  'AT73': 'Aerospatiale/Alenia ATR 72-211/-212',
  'AT75': 'Aerospatiale/Alenia ATR 72-212A (500)',
  'AT76': 'Aerospatiale/Alenia ATR 72-212A (600)',
  'ATP': 'British Aerospace ATP',
  'B190': 'Beechcraft 1900',
  'B37M': 'Boeing 737 MAX 7',
  'B38M': 'Boeing 737 MAX 8',
  'B39M': 'Boeing 737 MAX 9',
  'B3XM': 'Boeing 737 MAX 10',
  'B52': 'Boeing B-52 Stratofortress',
  'B703': 'Boeing 707',
  'B712': 'Boeing 717',
  'B720': 'Boeing 720B',
  'B721': 'Boeing 727-100',
  'B722': 'Boeing 727-200',
  'B732': 'Boeing 737-200',
  'B733': 'Boeing 737-300',
  'B734': 'Boeing 737-400',
  'B735': 'Boeing 737-500',
  'B736': 'Boeing 737-600',
  'B737': 'Boeing 737-700 / Boeing 737-700ER',
  'B738': 'Boeing 737-800',
  'B739': 'Boeing 737-900 / Boeing 737-900ER',
  'B741': 'Boeing 747-100',
  'B742': 'Boeing 747-200',
  'B743': 'Boeing 747-300',
  'B744': 'Boeing 747-400 / Boeing 747-400ER',
  'B748': 'Boeing 747-8I',
  'B74R': 'Boeing 747SR',
  'B74S': 'Boeing 747SP',
  'B752': 'Boeing 757-200',
  'B753': 'Boeing 757-300',
  'B762': 'Boeing 767-200 / Boeing 767-200ER',
  'B763': 'Boeing 767-300 / Boeing 767-300ER',
  'B764': 'Boeing 767-400ER',
  'B772': 'Boeing 777-200 / Boeing 777-200ER',
  'B773': 'Boeing 777-300',
  'B778': 'Boeing 777-8',
  'B779': 'Boeing 777-9',
  'B77L': 'Boeing 777-200 Freighter',
  'B77W': 'Boeing 777-300ER',
  'B788': 'Boeing 787-8',
  'B789': 'Boeing 787-9',
  'B78X': 'Boeing 787-10',
  'BA11': 'British Aerospace (BAC) One Eleven',
  'BCS1': 'Bombardier CSeries CS100 / Airbus A220-100',
  'BCS3': 'Bombardier CSeries CS300 / Airbus A220-300',
  'BE20': 'Beechcraft (Super) King Air 200',
  'BE40': 'Hawker 400',
  'BE99': 'Beechcraft Model 99',
  'BELF': 'Shorts SC-5 Belfast',
  'BER2': 'Beriev Be-200 Altair',
  'BLCF': 'Boeing 747-400 LCF Dreamlifter',
  'C130': 'Lockheed L-182 / 282 / 382 (L-100) Hercules',
  'C208': 'Cessna 208 Caravan',
  'C212': 'CASA / IPTN 212 Aviocar',
  'C25A': 'Cessna Citation CJ2',
  'C25B': 'Cessna Citation CJ3',
  'C25C': 'Cessna Citation CJ4',
  'C30J': 'Lockheed Martin C-130J Hercules',
  'C408': 'Cessna 408 SkyCourier',
  'C500': 'Cessna Citation I',
  'C510': 'Cessna Citation Mustang',
  'C525': 'Cessna CitationJet',
  'C550': 'Cessna Citation II',
  'C560': 'Cessna Citation V',
  'C56X': 'Cessna Citation Excel',
  'C5M': 'Lockheed C-5M Super Galaxy',
  'C650': 'Cessna Citation III, VI, VII',
  'C680': 'Cessna Citation Sovereign',
  'C68A': 'Cessna Citation Latitude',
  'C700': 'Cessna Citation Longitude',
  'C750': 'Cessna Citation X',
  'C919': 'Comac C919',
  'CL2T': 'Bombardier 415',
  'CL30': 'Bombardier BD-100 Challenger 300',
  'CL35': 'Bombardier BD-100 Challenger 350',
  'CL60': 'Canadair Challenger 600',
  'CN35': 'CASA/IPTN CN-235',
  'CRJ1': 'Canadair Regional Jet 100',
  'CRJ2': 'Canadair Regional Jet 200',
  'CRJ7': 'Canadair Regional Jet 700 ',
  'CRJ9': 'Canadair Regional Jet 900',
  'CRJX': 'Canadair Regional Jet 1000',
  'CVLT': 'Convair CV-580, Convair CV-600, Convair CV-640',
  'D228': 'Dornier 228',
  'D328': 'Fairchild Dornier Do.328',
  'DC10': 'Douglas DC-10-10 / -15 Passenger',
  'DC85': 'Douglas DC-8-50',
  'DC86': 'Douglas DC-8-62',
  'DC87': 'Douglas DC-8-72',
  'DC91': 'Douglas DC-9-10',
  'DC92': 'Douglas DC-9-20',
  'DC93': 'Douglas DC-9-30',
  'DC94': 'Douglas DC-9-40',
  'DC95': 'Douglas DC-9-50',
  'DH8A': 'De Havilland Canada DHC-8-100 Dash 8 / 8Q',
  'DH8B': 'De Havilland Canada DHC-8-200 Dash 8 / 8Q',
  'DH8C': 'De Havilland Canada DHC-8-300 Dash 8 / 8Q',
  'DH8D': 'De Havilland Canada DHC-8-400 Dash 8Q',
  'DHC5': 'De Havilland Canada DHC-5 Buffalo',
  'DHC6': 'De Havilland Canada DHC-6 Twin Otter',
  'DHC7': 'De Havilland Canada DHC-7 Dash 7',
  'E110': 'Embraer EMB 110 Bandeirante',
  'E120': 'Embraer EMB 120 Brasilia',
  'E135': 'Embraer RJ135',
  'E145': 'Embraer RJ145',
  'E170': 'Embraer 170',
  'E190': 'Embraer 190 / Lineage 1000',
  'E195': 'Embraer 195',
  'E290': 'Embraer E190-E2',
  'E295': 'Embraer E195-E2',
  'E35L': 'Embraer Legacy 600 / Legacy 650',
  'E50P': 'Embraer Phenom 100',
  'E545': 'Embraer Legacy 450 / Praetor 500',
  'E550': 'Embraer Legacy 500 / Praetor 600',
  'E55P': 'Embraer Phenom 300',
  'E75L': 'Embraer 175 (long wing)',
  'E75S': 'Embraer 175 (short wing)',
  'EA50': 'Eclipse 500',
  'F100': 'Fokker 100',
  'F27': 'Fokker F27 Friendship',
  'F28': 'Fokker F28 Fellowship',
  'F2TH': 'Dassault Falcon 2000',
  'F406': 'Reims-Cessna F406 Caravan II',
  'F50': 'Fokker 50',
  'F70': 'Fokker 70',
  'F900': 'Dassault Falcon 900',
  'FA50': 'Dassault Falcon 50',
  'FA6X': 'Dassault Falcon 6X',
  'FA7X': 'Dassault Falcon 7X',
  'G159': 'Gulfstream Aerospace G-159 Gulfstream I',
  'G280': 'Gulfstream G280',
  'G73T': 'Grumman G-73 Turbo Mallard',
  'GL5T': 'Bombardier Global 5000',
  'GLEX': 'Bombardier Global Express / Raytheon Sentinel',
  'GLF4': 'Gulfstream IV',
  'K35R': 'Boeing KC-135 Stratotanker',
  'P8': 'Boeing P-8 Poseidon',
};
    var upper = s.toUpperCase();
    if (map[upper]) return map[upper];
    if (/^(boeing|airbus|bombardier|embraer)/i.test(s)) return s;
    return s;
  }

  function renderParsedTable(parsed) {
    var altMin = parsed.cruise_altitude_min
      ? 'FL' + Math.round(parsed.cruise_altitude_min / 100)
      : parsed.cruise_altitude ? 'FL' + Math.round(parsed.cruise_altitude / 100) : '—';
    var altMax = parsed.cruise_altitude_max
      ? 'FL' + Math.round(parsed.cruise_altitude_max / 100)
      : parsed.cruise_altitude ? 'FL' + Math.round(parsed.cruise_altitude / 100) : '—';
    var avoidParts = [];
    if (parsed.avoid_waypoints && parsed.avoid_waypoints.length > 0) avoidParts.push('航点: ' + parsed.avoid_waypoints.join(', '));
    if (parsed.avoid_airspaces && parsed.avoid_airspaces.length > 0) avoidParts.push('空域: ' + parsed.avoid_airspaces.join(', '));
    var avoidStr = avoidParts.length > 0 ? avoidParts.join('; ') : '—';

    var h = '';
    if (parsed.context) h += '<div style="color:var(--accent);font-size:0.82rem;margin-bottom:8px;padding:6px 10px;background:rgba(59,130,246,0.08);border-radius:4px">' + escapeHtml(parsed.context) + '</div>';
    h += '<table class="parsed-table"><tbody>';
    h += '<tr><td class="intent-label">出發(ICAO/IATA)</td><td class="intent-value">' + escapeHtml(parsed.origin||'?') + (parsed.origin_iata?'/'+escapeHtml(parsed.origin_iata):'') + '</td><td class="intent-label">到達(ICAO/IATA)</td><td class="intent-value">' + escapeHtml(parsed.destination||'?') + (parsed.dest_iata?'/'+escapeHtml(parsed.dest_iata):'') + '</td></tr>';
    h += '<tr><td class="intent-label">巡航高度(MIN)</td><td class="intent-value">' + altMin + '</td><td class="intent-label">巡航高度(MAX)</td><td class="intent-value">' + altMax + '</td></tr>';
    h += '<tr><td class="intent-label">航路類型</td><td class="intent-value">' + (parsed.airway_type==='J'?'High':parsed.airway_type==='B'||parsed.airway_type==='V'?'Low':'Both') + '</td><td class="intent-label">航路規避</td><td class="intent-value">' + avoidStr + '</td></tr>';
    h += '<tr><td class="intent-label">執飛機型</td><td class="intent-value">' + (normalizeAircraft(parsed.aircraft_type) || '—') + '</td><td class="intent-label">燃料單位</td><td class="intent-value">' + (parsed.fuel_unit ? escapeHtml(parsed.fuel_unit) : 'kgs') + '</td></tr>';
    h += '<tr><td class="intent-label">Use SIDs</td><td class="intent-value">' + (parsed.use_sids!==false?'✅️':'❌') + '</td><td class="intent-label">Use STARs</td><td class="intent-value">' + (parsed.use_stars!==false?'✅️':'❌') + '</td></tr>';
    h += '<tr><td class="intent-label">RNAV equipped</td><td class="intent-value">' + (parsed.rnav_capable!==false?'✅️':'❌') + '</td><td class="intent-label">置信度</td><td class="intent-value">' + Math.round((parsed.confidence||0)*100) + '%</td></tr>';
    h += '</tbody></table>';
    $parsedContent.innerHTML = h;
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
    var dep = parsed?.origin || '';
    var arr = parsed?.destination || '';
    var depName = state._depAirportName || dep;
    var arrName = state._arrAirportName || arr;
    // Try to extract Chinese names from AI context: "VHHH（香港國際機場，中國）"
    var ctx = parsed?.context || '';
    function extractCnName(icao, ctx) {
      var idx = ctx.indexOf(icao);
      if (idx >= 0) {
        var start = ctx.indexOf('（', idx);
        var end = ctx.indexOf('）', start);
        if (start > 0 && end > start) {
          var full = ctx.substring(start + 1, end);
          var comma = full.indexOf('，');
          return comma > 0 ? full.substring(0, comma) : full;
        }
      }
      return '';
    }
    var depCn = extractCnName(dep, ctx);
    var arrCn = extractCnName(arr, ctx);
    var useCn = (I18N.currentLang || '').startsWith('zh');
    var depDisplay = useCn ? (depCn || depName) : depName;
    var arrDisplay = useCn ? (arrCn || arrName) : arrName;
    var n = candidate.segments ? candidate.segments.length + 2 : '?';
    var distance = candidate.total_distance_nm?.toFixed(0) || '?';
    var bearingId = 'route-bearing-' + candidate.index;

    var html = '<div class="card route-description-card">';
    html += '<div class="card-title">\u2708\uFE0F \u822A\u7DDA\u8A73\u60C5</div>';
    html += '<div class="route-string-box" title="點擊即可複製" onclick="var t=this.querySelector(\'.route-string-text\');if(t)navigator.clipboard.writeText(t.textContent.trim());this.classList.add(\'copied\');var tip=this.querySelector(\'.copy-toast\');if(tip){tip.style.display=\'block\';setTimeout(function(){tip.style.display=\'none\'},1500)}">';
    html += '<span class="copy-toast" style="display:none;position:absolute;top:-24px;right:8px;background:var(--success);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.7rem;z-index:10">✓ 已複製</span>';
    html += '<span class="route-string-text">' + escapeHtml(candidate.route_string) + '</span></div>';
    html += '<table class="data-table">';
    html += '<tr><td class="intent-label">\u822A\u7DDA\u63CF\u8FF0</td><td class="intent-value">\u51FA\u767C\u5730 ' + escapeHtml(dep) + '\uFF08' + escapeHtml(depName) + '\uFF09\uFF0C\u76EE\u7684\u5730 ' + escapeHtml(arr) + '\uFF08' + escapeHtml(arrName) + '\uFF09</td></tr>';
    html += '<tr><td class="intent-label">\u5168\u7A0B\u6578\u64DA</td><td class="intent-value">\u5168\u7A0B\u5171 ' + n + ' \u500B\u5C0E\u822A\u9EDE\uFF0C\u76F4\u98DB\u822A\u5411 <span id="' + bearingId + '">\u2014</span>\u00B0\uFF0C\u76F4\u98DB\u91CC\u7A0B <span id="' + bearingId + '-direct">\u2014</span> \u6D77\u91CC\uFF0C\u822A\u8DEF\u91CC\u7A0B ' + distance + ' \u6D77\u91CC</td></tr>';
    html += '<tr><td class="intent-label">\u4E2D\u570B RVSM</td><td class="intent-value">9200\u7C73(FL301)\u30019800\u7C73(FL321)\u300110400\u7C73(FL341) \u6216\u4EE5\u4E0A</td></tr>';
    html += '<tr><td class="intent-label">\u570B\u969B RVSM</td><td class="intent-value">FL290\u3001FL310\u3001FL330 \u6216\u4EE5\u4E0A</td></tr>';
    html += '</table></div>';

    var airportGrid = document.getElementById('airportGrid');
    var existing = document.querySelector('.route-description-card');
    if (existing) existing.remove();
    if (airportGrid) airportGrid.insertAdjacentHTML('beforebegin', html);
    state._bearingElId = bearingId;
  }
  // ── Airport Card ─────────────────────────────────────────
  function renderAirportCard(container, icao, fix, data, weatherData, icon) {
    if (!data) {
      container.innerHTML = renderError('Airport data unavailable for ' + escapeHtml(icao));
      return;
    }
    var ap = data.airport || data;
    var name = ap.name || icao;
    var isDeparture = (icon === '\uD83D\uDEEB');
    var html = '';

    // Header: "🛫 Narita Intl（RJAA）"
    html += '<div class="airport-header">' + icon + ' <strong>' + escapeHtml(name) + '\uFF08' + escapeHtml(icao) + '\uFF09</strong></div>';

    if (ap.lat != null && ap.lon != null) {
      state['_ap_' + icao] = { lat: ap.lat, lon: ap.lon };
      updateRouteBearing();
    }

    // Procedures (already filtered by fix from backend)
    var allProcs = isDeparture ? (data.sids || []) : (data.stars || []); var procs = fix ? allProcs.filter(function(p) { return p.exit_fix && p.exit_fix.toUpperCase() === fix.toUpperCase(); }) : allProcs;
    var procTitle = isDeparture ? '\u96E2\u5834\u7A0B\u5E8F (SID)' : '\u9032\u5834\u7A0B\u5E8F (STAR)';
    var fixCol = isDeparture ? '\u96E2\u5834\u9EDE' : '\u9032\u5834\u9EDE';
    var refRunways = {};

    if (procs.length > 0) {
      html += '<div class="airport-section"><div class="airport-section-title">' + procTitle + '</div>';
      html += '<table class="data-table"><thead><tr>' + (isDeparture ? '<th>\u96E2\u5834\u7A0B\u5E8F</th><th>\u4F7F\u7528\u8DD1\u9053</th><th>\u904E\u6E21</th><th>\u96E2\u5834\u9EDE</th>' : '<th>\u9032\u5834\u7A0B\u5E8F</th><th>\u9032\u8FD1\u7A0B\u5E8F</th><th>\u904E\u6E21</th><th>\u4F7F\u7528\u8DD1\u9053</th><th>\u9032\u5834\u9EDE</th>') + '</tr></thead><tbody>';
      var lastProcName = null; procs.forEach(function(p) {
        var rwy = p.runway || '';
        if (rwy) refRunways[rwy.toUpperCase()] = true; if (!isDeparture && p.approaches) { p.approaches.forEach(function(a){ if (a.runway) refRunways[a.runway.toUpperCase()] = true; }); }
        var fix = isDeparture ? (p.exit_fix || '\u2014') : ((p.fix_waypoints && p.fix_waypoints[0]) || '\u2014'); var trans = (p.transition || '\u2014');
        if (isDeparture) { var showName = (lastProcName !== p.name) ? escapeHtml(p.name) : '\u221F'; lastProcName = p.name; html += '<tr><td>' + showName + '</td><td>' + escapeHtml(rwy || '\u2014') + '</td><td>' + escapeHtml(trans) + '</td><td>' + escapeHtml(fix) + '</td></tr>'; } else { var apps = p.approaches || []; if (apps.length > 0) { apps.forEach(function(a,ai){ if (ai===0) html += '<tr><td>' + escapeHtml(p.name) + '</td>'; else html += '<tr><td>∟</td>'; var aname = a.name; html += '<td>' + escapeHtml(aname) + '</td><td>' + escapeHtml(a.transition || '\u2014') + '</td><td>' + escapeHtml(a.runway || '\u2014') + '</td><td>' + escapeHtml(fix) + '</td></tr>'; }); } /* no approaches - skip this STAR */  }
      });
      html += '</tbody></table></div>';
    }

    // Runway table — show only runways referenced by procedures
    var runways = data.runways || [];
    var displayRunways = runways;
    var refKeys = Object.keys(refRunways);
    if (refKeys.length > 0) {
      displayRunways = runways.filter(function(r) {
        var rn = (r.name || '').replace(/^RW/i, '').toUpperCase();
        return refRunways[rn];
      });
    }
    // Find max length for recommendation
    var maxLen = 0;
    displayRunways.forEach(function(r) { if ((r.length_ft || 0) > maxLen) maxLen = r.length_ft; });

    if (displayRunways.length > 0) {
      html += '<div class="airport-section"><div class="airport-section-title">\u8DD1\u9053\u4FE1\u606F</div>';
      html += '<table class="data-table"><thead><tr>';
      html += '<th>\u8DD1\u9053</th><th>\u9577\u5EA6(ft)</th><th>\u5BEC\u5EA6(ft)</th><th>\u9AD8\u5EA6(ft)</th><th>\u822A\u5411(\u00B0)</th><th>GP\u4E0B\u6ED1(\u00B0)</th><th>ILS\u983B\u7387(MHz)</th><th>\u6A19\u8B58</th><th>CAT</th><th>DME</th><th>\u904E\u6E21\u9AD8\u5EA6(ft)</th><th title=\"ILS CAT II/III + \u6700\u9577\u2014\u512A\u5148\u7CBE\u78BA\u9032\u5834\">\u63A8\u85A6</th>';
      html += '</tr></thead><tbody>';
      displayRunways.forEach(function(r) {
        var isRec = r.ils_cat && (r.ils_cat.indexOf('II') >= 0 || r.ils_cat.indexOf('III') >= 0) && r.length_ft === maxLen && maxLen > 0;
        html += '<tr>';
        html += '<td>' + escapeHtml(r.name || '\u2014') + '</td>';
        html += '<td>' + (r.length_ft != null ? r.length_ft.toLocaleString() : '\u2014') + '</td>';
        html += '<td>' + (r.width_ft != null ? r.width_ft : '\u2014') + '</td>';
        html += '<td>' + (r.elevation_ft != null ? r.elevation_ft : '\u2014') + '</td>';
        html += '<td>' + (r.heading_deg != null ? r.heading_deg.toFixed(0) : '\u2014') + '</td>';
        html += '<td>' + (r.glidepath_deg != null ? r.glidepath_deg.toFixed(1) : '\u2014') + '</td>';
        html += '<td>' + (r.ils_frequency ? (r.ils_frequency/1000).toFixed(3) : '\u2014') + '</td>';
        html += '<td>' + escapeHtml(r.ils_ident || '\u2014') + '</td>';
        html += '<td>' + escapeHtml(r.ils_cat || '\u2014') + '</td>';
        html += '<td>' + (r.has_dme ? '\u652F\u6301' : '\u2014') + '</td>';
        html += '<td>' + (r.transition_alt_ft != null ? r.transition_alt_ft : '\u2014') + '</td>';
        html += '<td>' + (isRec ? '\u2705\uFE0F' : '') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }

    // COM Frequencies table
    var coms = data.coms || [];
    if (coms.length > 0) {
      // Group by type
      var comGroups = {};
      coms.forEach(function(c) {
        if (!comGroups[c.type]) comGroups[c.type] = [];
        comGroups[c.type].push(c);
      });
      html += '<div class="airport-section"><div class="airport-section-title">COM 通訊頻率</div>';
      html += '<table class="data-table"><thead><tr><th>Type</th><th>Frequency(MHz)</th><th>Name</th></tr></thead><tbody>';
      var typeMap = {T:'Tower',A:'Approach',G:'Ground',D:'Departure',C:'Clearance',ATIS:'ATIS',RMP:'Ramp',RDR:'Radar',TCA:'TCA',CTR:'Center',DIR:'Director',INF:'Info',MC:'Multicom',UC:'Unicom',AWOS:'AWOS',ASOS:'ASOS',FSS:'FSS'};
      Object.keys(comGroups).sort().forEach(function(type) {
        var freqs = comGroups[type].map(function(c){ return (c.frequency_khz/1000).toFixed(3); }).join(', ');
        var names = [...new Set(comGroups[type].map(function(c){ return c.name || '—'; }))].join(', ');
        html += '<tr><td>' + escapeHtml(typeMap[type] || type) + '</td><td>' + freqs + '</td><td>' + escapeHtml(names) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // Weather section (collapsible)
    if (weatherData && (weatherData.metar || weatherData.taf || weatherData.metar_raw || weatherData.taf_raw)) {
      var wxId = 'wx-' + icao + '-' + Date.now();
      html += '<div class="airport-section"><div class="airport-section-title collapsible-header" onclick="document.getElementById(\'' + wxId + '\').classList.toggle(\'collapsed\')">\u6C23\u8C61\u4FE1\u606F</div>';
      html += '<div id="' + wxId + '" class="collapsible-content collapsed">';
      html += renderWeatherContent(icao, weatherData);
      html += '</div></div>';
    }

    container.innerHTML = html;
  }

  // ── Update bearing
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
    // Also update direct distance
    const directEl = document.getElementById(state._bearingElId + '-direct');
    if (directEl) {
      const directNM = haversineNM(depCoord.lat, depCoord.lon, arrCoord.lat, arrCoord.lon);
      directEl.textContent = directNM.toFixed(0);
    }
  }

  function computeBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return ((brng + 360) % 360).toFixed(0);
  }

  function haversineNM(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
    var ap = wx.airport || {};
    var apName = ap.name || icao || '';
    var h = '';

    if (wx.metar) {
      var m = wx.metar;
      h += '<div class="weather-section"><div class="weather-section-title">\uD83D\uDCE1 METAR \u5929\u6C23\u5831\u544A</div>';
      h += '<pre class="weather-raw">' + escapeHtml(stripMetarPrefix(m.raw || wx.metar_raw || '')) + '</pre>';
      h += '<div class="weather-section-title">\uD83D\uDCCB METAR \u5831\u6587\u89E3\u6790</div>';
      h += '<table class="data-table"><tbody>';

      // Airport code + Update time
      h += '<tr><td class="intent-label">\u6A5F\u5834\u4EE3\u78BC</td><td class="intent-value">' + escapeHtml(icao) + ' (' + escapeHtml(apName) + ')</td>';
      h += '<td class="intent-label">\u66F4\u65B0\u6642\u9593</td><td class="intent-value">' + (wx.updated_iso || '\u2014') + '</td></tr>';

      // Wind
      var wind = m.wind || {};
      var windStr = '\u2014';
      if (wind.dir_cn && wind.dir != null) {
        windStr = '(' + (wind.arrow||'') + ' ' + wind.dir_cn + ') ' + wind.dir + '\u00B0 @ ' + (wind.speed_kts||'?') + ' KT';
        if (wind.gust_kts) windStr += ' Gust ' + wind.gust_kts + 'kt';
      } else if (m.wind_text) { windStr = m.wind_text; }
      var rawText = m.raw || '';
      var varMatch = rawText.match(/(\d{3})V(\d{3})/);
      if (varMatch) windStr += '<br>\u98A8\u5411\u5728 ' + varMatch[1] + '\u00B0 \u5230 ' + varMatch[2] + '\u00B0 \u4E4B\u9593\u6CE2\u52D5';
      // Visibility
      var visStr = m.visibility_str || (m.visibility_m!=null?(m.visibility_m>=10000?'\uD83D\uDD2D \u80FD\u898B\u5EA6\u826F\u597D':m.visibility_m+'m'):'\u2014');
      h += '<tr><td class="intent-label">\u98A8\u901F\u98A8\u5411</td><td class="intent-value">' + windStr + '</td>';
      h += '<td class="intent-label">\u80FD\u898B\u5EA6</td><td class="intent-value">' + visStr + '</td></tr>';

      // Clouds + Temp/Dew
      var cloudStr = '\u2014';
      if (m.clouds && m.clouds.length > 0) {
        cloudStr = '';
        m.clouds.forEach(function(c) { cloudStr += (c.emoji||'')+' '+(c.cover_cn||c.cover)+', \u4E91\u5E95\u9AD8\u5EA6 '+c.height_ft+' FT '; });
      }
      var tempStr = (m.temp_c!=null?m.temp_c+' \u00B0C':'\u2014')+' / '+(m.dewpt_c!=null?m.dewpt_c+' \u00B0C':'\u2014');
      h += '<tr><td class="intent-label">\u96F2\u5C64\u72C0\u6CC1</td><td class="intent-value">' + cloudStr + '</td>';
      h += '<td class="intent-label">\u6EAB\u5EA6/\u9732\u9EDE</td><td class="intent-value">' + tempStr + '</td></tr>';

      // Pressure + Local time
      var localTime = '';
      if (wx.updated_iso) {
        try {
          var utc = new Date(wx.updated_iso);
          var tz = currentTimezone || 'UTC+8';
          var off = parseInt(tz.replace(/[^0-9+-]/g,'')) || 8;
          var local = new Date(utc.getTime() + off * 3600000);
          localTime = local.getFullYear()+'-'+String(local.getMonth()+1).padStart(2,'0')+'-'+String(local.getDate()).padStart(2,'0')+' '+String(local.getHours()).padStart(2,'0')+':'+String(local.getMinutes()).padStart(2,'0')+' '+tz;
        } catch(e) {}
      }
      h += '<tr><td class="intent-label">\u4FEE\u6B63\u6D77\u58D3</td><td class="intent-value">' + (m.pressure_hpa!=null?m.pressure_hpa+' hPa':'\u2014') + '</td>';
      h += '<td class="intent-label">\u7576\u5730\u6642\u9593</td><td class="intent-value">' + (localTime || '\u2014') + '</td></tr>';

      h += '</tbody></table>';

      // Second table: trends + TEMPO (2-column)
      h += '<table class="data-table"><tbody>';

      // Trend
      var rawUpper = rawText.toUpperCase();
      var trendParts = [];
      if (rawUpper.indexOf('NOSIG') >= 0) trendParts.push('(NOSIG) \u672A\u4F862\u5C0F\u6642\u5167\u7121\u986F\u8457\u8B8A\u5316');
      if (rawUpper.indexOf('BECMG') >= 0) trendParts.push('(BECMG) \u5929\u6C23\u5C07\u9010\u6F38\u8F49\u8B8A');
      if (rawUpper.indexOf('TEMPO') >= 0) trendParts.push('(TEMPO) \u672A\u4F862\u5C0F\u6642\u5167\u6703\u6709\u77ED\u66AB\u7684\u5929\u6C23\u6CE2\u52D5');
      if (rawUpper.indexOf('RMK') >= 0) trendParts.push('(RMK) \u5099\u8A3B');
      var trendStr = trendParts.length > 0 ? trendParts.join('; ') : '\u2014';
      h += '<tr><td class="intent-label">\u8DA8\u52E2\u8207\u5099\u8A3B</td><td class="intent-value">' + trendStr + '</td></tr>';

      // TEMPO details
      var tempoMatch = rawText.match(/TEMPO\s+(.+)/i);
      if (tempoMatch) {
        var tempoStr = tempoMatch[1].trim();
        // Remove any trailing BECMG section
        var becmgIdx = tempoStr.toUpperCase().indexOf('BECMG');
        if (becmgIdx > 0) tempoStr = tempoStr.substring(0, becmgIdx).trim();
        tempoStr = tempoStr.replace(/(FEW|SCT|BKN|OVC)(\d{3})/gi, function(_,c,h){
          var cn = {FEW:"\u5C11\u96F2", SCT:"\u758F\u96F2", BKN:"\u88C2\u96F2", OVC:"\u9670\u5929"};
          return cn[c.toUpperCase()] + "\uFF08" + c.toUpperCase() + "\uFF09\u4F4E\u81F3 " + (parseInt(h) * 100) + "\u82F1\u5C3A";
        });
        tempoStr = tempoStr.replace(/(\d{4})/g, '\u80FD\u898B\u5EA6 $1\u7C73');
        tempoStr = tempoStr.replace(/\bBR\b/gi, '\u9744');
        tempoStr = tempoStr.replace(/\bFG\b/gi, '\u9727');
        tempoStr = tempoStr.replace(/\bRA\b/gi, '\u96E8');
        tempoStr = tempoStr.replace(/\bTS\b/gi, '\u96F7\u66B4');
        h += '<tr><td class="intent-label">\u77ED\u66AB\u6CE2\u52D5(TEMPO)</td><td class="intent-value">\u9810\u8A08\u77ED\u6642\u9593\u5167\uFF0C' + tempoStr + '</td></tr>';
      }

      // BECMG details
      var becmgMatch = rawText.match(/BECMG\s+(.+)/i);
      if (becmgMatch) {
        var becmgStr = becmgMatch[1].trim();
        // Remove any trailing TEMPO section
        var tempoIdx = becmgStr.toUpperCase().indexOf('TEMPO');
        if (tempoIdx > 0) becmgStr = becmgStr.substring(0, tempoIdx).trim();
        // Parse wind: 26005KT
        becmgStr = becmgStr.replace(/(\d{3})(\d{2,3})(G\d{2,3})?KT/gi, function(_,d,s,g){
          return d + '\u00B0 @ ' + parseInt(s) + ' KT' + (g ? ' Gust ' + g.substring(1) + 'kt' : '');
        });
        h += '<tr><td class="intent-label">\u9010\u6F38\u8F49\u8B8A(BECMG)</td><td class="intent-value">' + becmgStr.trim() + '</td></tr>';
      }

      h += '</tbody></table></div>';
    } else if (wx.metar_raw) {
      h += '<div class="weather-section"><div class="weather-section-title">\uD83D\uDCE1 METAR</div>';
      h += '<pre class="weather-raw">' + escapeHtml(stripMetarPrefix(wx.metar_raw)) + '</pre></div>';
    }

    if (wx.taf) {
      var t = wx.taf;
      h += '<div class="weather-section"><div class="weather-section-title">\uD83D\uDCE1 TAF \u5929\u6C23\u9810\u5831</div>';
      h += '<pre class="weather-raw">' + escapeHtml(stripTafPrefix(t.raw || wx.taf_raw || '')) + '</pre>';
            h += '<div class="weather-section-title">\uD83D\uDCCB TAF \u5831\u6587\u89E3\u6790</div>';
      h += '<table class="data-table"><tbody>';

      // Airport + update time
      h += '<tr><td class="intent-label">\u6A5F\u5834\u4EE3\u78BC</td><td class="intent-value">' + escapeHtml(icao) + ' (' + escapeHtml(apName) + ')</td>';
      h += '<td class="intent-label">\u66F4\u65B0\u6642\u9593</td><td class="intent-value">' + (wx.updated_iso || '\u2014') + '</td></tr>';

      // Validity
      h += '<tr><td class="intent-label">\u9810\u5831\u6642\u6548</td><td class="intent-value" colspan="3">' + (t.time_from||'\u2014') + ' \u81F3 ' + (t.time_to||'\u2014') + ' (UTC)</td></tr>';

      // Base weather: wind + vis + clouds
      var baseStr = '';
      var tw = t.wind || {};
      if (tw.dir_cn && tw.dir != null) {
        baseStr += '(' + (tw.arrow||'') + ' ' + tw.dir_cn + ') ' + tw.dir + '\u00B0 @ ' + (tw.speed_kts||'?') + ' KT';
      } else if (t.wind_text) { baseStr += t.wind_text; }
      if (t.visibility_str) baseStr += (baseStr?'\uFF1B':'') + '\u80FD\u898B\u5EA6' + t.visibility_str;
      else if (t.visibility_m != null && t.visibility_m < 9999) baseStr += (baseStr?'\uFF1B':'') + '\u80FD\u898B\u5EA6' + t.visibility_m + 'm';
      if (t.clouds && t.clouds.length > 0) {
        baseStr += (baseStr?'\uFF1B':'');
        t.clouds.forEach(function(c){ baseStr += (c.emoji||'')+' '+(c.cover_cn||c.cover)+'\u9AD8 '+c.height_ft+' \u82F1\u5C3A'; });
      }
      if (baseStr) h += '<tr><td class="intent-label">\u57FA\u790E\u5929\u6C23</td><td class="intent-value" colspan="3">' + baseStr + '</td></tr>';

      // Max/Min temp
      if (t.max_temp_c != null || t.min_temp_c != null) {
        h += '<tr><td class="intent-label">\u6700\u9AD8\u6EAB\u5EA6</td><td class="intent-value">' + (t.max_temp_c!=null?t.max_temp_c+'\u00B0C'+(t.max_temp_time?' ('+t.max_temp_time+')':''):'\u2014') + '</td>';
        h += '<td class="intent-label">\u6700\u4F4E\u6EAB\u5EA6</td><td class="intent-value">' + (t.min_temp_c!=null?t.min_temp_c+'\u00B0C'+(t.min_temp_time?' ('+t.min_temp_time+')':''):'\u2014') + '</td></tr>';
      }

      // Trends from raw TAF text
      var rawTaf = (t.raw || wx.taf_raw || '').toUpperCase();
      // Remove base part (before first trend keyword)
      var trendSection = rawTaf.replace(/^[\s\S]*?(?=TEMPO|BECMG|PROB)/i, '');
      // Split by trend keywords
      var trendParts = trendSection.split(/\b(?=TEMPO|BECMG|PROB)/gi);
            for (var ti = 0; ti < trendParts.length; ti++) {
        var tp = trendParts[ti].trim();
        if (!tp) continue;
        var kind = tp.match(/^(TEMPO|BECMG|PROB\d+)/i);
        if (!kind) continue;
        var kindStr = kind[1].toUpperCase();
        var rest = tp.substring(kind[0].length).trim();

        // Parse time range
        var timeMatch = rest.match(/(\d{4})\/(\d{4})/);
        var timeStr = '';
        if (timeMatch) {
          timeStr = timeMatch[1].substring(0,2)+'\u65E5 '+timeMatch[1].substring(2,4)+':00 \u2013 '+timeMatch[2].substring(0,2)+'\u65E5 '+timeMatch[2].substring(2,4)+':00 (UTC)';
          rest = rest.replace(timeMatch[0], '').trim();
        }

        var desc = rest;
        // Translate clouds
        desc = desc.replace(/FEW(\d{3})/gi, '\u5C11\u91CF\u96F2 $1\u82F1\u5C3A');
        desc = desc.replace(/SCT(\d{3})/gi, '\u758F\u6563\u96F2 $1\u82F1\u5C3A');
        desc = desc.replace(/BKN(\d{3})/gi, '\u591A\u96F2 $1\u82F1\u5C3A');
        desc = desc.replace(/OVC(\d{3})/gi, '\u9670\u5929 $1\u82F1\u5C3A');
        // Translate visibility
        desc = desc.replace(/\b(\d{4})\b/g, '\u80FD\u898B\u5EA6 $1\u7C73');
        // Translate weather
        desc = desc.replace(/\bBR\b/gi, '\u8F15\u9727');
        desc = desc.replace(/\bFG\b/gi, '\u5927\u9727');
        desc = desc.replace(/\bBCFG\b/gi, '\u7247\u72C0\u9727');
        desc = desc.replace(/\bRA\b/gi, '\u96E8');
        desc = desc.replace(/\bTS\b/gi, '\u96F7\u66B4');
        desc = desc.replace(/\bSHRA\b/gi, '\u9663\u96E8');
        desc = desc.replace(/\bDZ\b/gi, '\u6BDB\u6BDB\u96E8');
        desc = desc.replace(/\bHZ\b/gi, '\u973E');
        // Translate wind
        var windM = desc.match(/(\d{3})(\d{2,3})(G\d{2,3})?KT/);
        if (windM) {
          var wd = windM[1], ws = windM[2], wg = windM[3];
          desc = desc.replace(windM[0], wd+'\u00B0'+(ws?'\uFF0C\u98CE\u901F '+parseInt(ws)+' \u7BC0':'')+(wg?'\uFF0C\u9663\u98CE'+wg.substring(1)+'\u7BC0':''));
        }

        var label = kindStr;
        if (kindStr === 'TEMPO') label = '\u77ED\u66AB\u6CE2\u52D5(TEMPO)';
        else if (kindStr === 'BECMG') label = '\u9010\u6F38\u8F49\u8B8A(BECMG)';
        else if (kindStr.indexOf('PROB') === 0) label = 'PROB' + kindStr.substring(4) + '\uFF05';
        // Include time in label
        var contentStr = desc.trim();
        h += '<tr><td class="intent-label">' + label + '</td><td class="intent-value" style="white-space:nowrap">' + (timeStr || '\u2014') + '</td><td class="intent-value" style="width:100%">' + contentStr + '</td></tr>';
      }

      h += '</tbody></table></div>';
    } else if (wx.taf_raw) {
    } else if (wx.taf_raw) {
      h += '<div class="weather-section"><div class="weather-section-title">\uD83D\uDCE1 TAF</div>';
      h += '<pre class="weather-raw">' + escapeHtml(stripTafPrefix(wx.taf_raw)) + '</pre></div>';
    }
    return h;
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
    var ec = document.getElementById('settingsEval');
    if (ec) {
      useEvaluator = ec.checked;
      localStorage.setItem('ai_flight_planner_evaluator', useEvaluator ? 'true' : 'false');
    }
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
