/**
 * i18n — light-weight client-side internationalization.
 *
 * Translates the UI between 简体中文 (zh-CN), 繁體中文 (zh-TW), and English (en).
 * Strings are selected by data-i18n attributes in the HTML.
 * Language preference is persisted in localStorage.
 */
const I18N = (() => {
  'use strict';

  const STORAGE_KEY = 'ai_flight_planner_lang';
  const DEFAULT_LANG = 'zh-TW';

  const TRANSLATIONS = {
    'title': {
      'zh-CN': 'AI 飞行计划',
      'zh-TW': 'AI 飛行計劃',
      'en': 'AI Flight Planner'
    },
    'title-brand': {
      'zh-CN': 'AI 飞行计划助手',
      'zh-TW': 'AI 飛行計劃助手',
      'en': 'AI FLIGHT PLANNER'
    },
    'header-airac': {
      'zh-CN': 'AIRAC:',
      'zh-TW': 'AIRAC:',
      'en': 'AIRAC:'
    },
    'btn-settings': {
      'zh-CN': '⚙️ LLM 设置',
      'zh-TW': '⚙️ LLM 設定',
      'en': '⚙️ LLM Settings'
    },
    'card-route-request': {
      'zh-CN': '🗣️ 航线请求',
      'zh-TW': '🗣️ 航線請求',
      'en': '🗣️ Route Request'
    },
    'input-placeholder': {
      'zh-CN': '描述你的航班...\n例如：VHHH 到 RJTT，走高空航路，避开台湾空域',
      'zh-TW': '描述你的航班...\n例如：VHHH 到 RJTT，走高層航路，避開台灣空域',
      'en': 'Describe your flight...\ne.g., VHHH to RJTT, high altitude airways, avoid Taiwan airspace'
    },
    'label-candidates': {
      'zh-CN': '候选:',
      'zh-TW': '候選:',
      'en': 'Candidates:'
    },
    'btn-plan': {
      'zh-CN': '✈️ 规划航线',
      'zh-TW': '✈️ 規劃航線',
      'en': '✈️ Plan Route'
    },
    'btn-planning': {
      'zh-CN': '规划中...',
      'zh-TW': '規劃中...',
      'en': 'Planning...'
    },
    'card-parsed-intent': {
      'zh-CN': '📋 解析意图',
      'zh-TW': '📋 解析意圖',
      'en': '📋 Parsed Intent'
    },
    'card-route-results': {
      'zh-CN': '🛫 航线结果',
      'zh-TW': '🛫 航線結果',
      'en': '🛫 Route Results'
    },
    'modal-title': {
      'zh-CN': '⚙️ 设置',
      'zh-TW': '⚙️ 設定',
      'en': '⚙️ Settings'
    },
    'label-provider': {
      'zh-CN': '提供商',
      'zh-TW': '提供商',
      'en': 'Provider'
    },
    'opt-provider-ollama': {
      'zh-CN': 'Ollama',
      'zh-TW': 'Ollama',
      'en': 'Ollama'
    },
    'opt-provider-openai': {
      'zh-CN': 'OpenAI',
      'zh-TW': 'OpenAI',
      'en': 'OpenAI'
    },
    'opt-provider-deepseek': {
      'zh-CN': 'DeepSeek',
      'zh-TW': 'DeepSeek',
      'en': 'DeepSeek'
    },
    'opt-provider-custom': {
      'zh-CN': '自定义 (兼容OpenAI)',
      'zh-TW': '自定義 (兼容OpenAI)',
      'en': 'Custom (OpenAI-compatible)'
    },
    'opt-provider-nvidia': {
      'zh-CN': 'Nvidia NIM',
      'zh-TW': 'Nvidia NIM',
      'en': 'Nvidia NIM'
    },
    'label-base-url': {
      'zh-CN': '接口地址',
      'zh-TW': '接口地址',
      'en': 'Base URL'
    },
    'label-model': {
      'zh-CN': '模型',
      'zh-TW': '模型',
      'en': 'Model'
    },
    'label-api-key': {
      'zh-CN': 'API 密钥',
      'zh-TW': 'API 密鑰',
      'en': 'API Key'
    },
    'label-temperature': {
      'zh-CN': '温度',
      'zh-TW': '溫度',
      'en': 'Temperature'
    },
    'btn-reset-defaults': {
      'zh-CN': '🔄 恢复默认',
      'zh-TW': '🔄 恢復預設',
      'en': '🔄 Reset Defaults'
    },
    'btn-test-connection': {
      'zh-CN': '🧪 测试连接',
      'zh-TW': '🧪 測試連接',
      'en': '🧪 Test Connection'
    },
    'btn-save': {
      'zh-CN': '💾 保存',
      'zh-TW': '💾 儲存',
      'en': '💾 Save'
    },
    'btn-close': {
      'zh-CN': '✕ 关闭',
      'zh-TW': '✕ 關閉',
      'en': '✕ Close'
    },
    'btn-testing': {
      'zh-CN': '测试中...',
      'zh-TW': '測試中...',
      'en': 'Testing...'
    },
    'toast-settings-saved': {
      'zh-CN': '设置已保存！',
      'zh-TW': '設定已儲存！',
      'en': 'Settings saved!'
    },
    'toast-reset-defaults': {
      'zh-CN': '已恢复默认设置',
      'zh-TW': '已恢復預設設定',
      'en': 'Settings reset to defaults'
    },
    'toast-connection-ok': {
      'zh-CN': '✅ 连接成功！',
      'zh-TW': '✅ 連線成功！',
      'en': '✅ Connection successful!'
    },
    'toast-connection-fail': {
      'zh-CN': '❌ 连接失败：',
      'zh-TW': '❌ 連線失敗：',
      'en': '❌ Failed: '
    },
    'toast-route-copied': {
      'zh-CN': '航线已复制！',
      'zh-TW': '航線已複製！',
      'en': 'Route copied!'
    },
    'error-empty-input': {
      'zh-CN': '请输入航线描述（例如：VHHH 到 RJTT）',
      'zh-TW': '請輸入航線描述（例如：VHHH 到 RJTT）',
      'en': 'Please enter a route request (e.g., "VHHH to RJTT")'
    },
    'label-origin': {
      'zh-CN': '出发',
      'zh-TW': '出發',
      'en': 'Origin'
    },
    'label-destination': {
      'zh-CN': '到达',
      'zh-TW': '到達',
      'en': 'Destination'
    },
    'label-airway-type': {
      'zh-CN': '航路类型',
      'zh-TW': '航路類型',
      'en': 'Airway Type'
    },
    'label-cruise-alt': {
      'zh-CN': '巡航高度',
      'zh-TW': '巡航高度',
      'en': 'Cruise Alt'
    },
    'label-confidence': {
      'zh-CN': '置信度',
      'zh-TW': '置信度',
      'en': 'Confidence'
    },
    'label-language': {
      'zh-CN': '语言',
      'zh-TW': '語言',
      'en': 'Language'
    },
    'label-timezone': {
      'zh-CN': '时区',
      'zh-TW': '時區',
      'en': 'Timezone'
    },
    'label-avoid-wps': {
      'zh-CN': '避开航点',
      'zh-TW': '避開航點',
      'en': 'Avoid WPs'
    },
    'label-avoid-airspaces': {
      'zh-CN': '避开空域',
      'zh-TW': '避開空域',
      'en': 'Avoid Airspaces'
    },
    'any': {
      'zh-CN': '不限',
      'zh-TW': '不限',
      'en': 'Any'
    },
    'best-route': {
      'zh-CN': '⭐ 最佳路线',
      'zh-TW': '⭐ 最佳路線',
      'en': '⭐ Best Route'
    },
    'alternative': {
      'zh-CN': '备选',
      'zh-TW': '備選',
      'en': 'Alternative #'
    },
    'btn-copy-route': {
      'zh-CN': '📋 复制航路',
      'zh-TW': '📋 複製航路',
      'en': '📋 Copy Route String'
    },
    'distance-nm': {
      'zh-CN': '距离',
      'zh-TW': '距離',
      'en': 'Distance'
    },
    'segments': {
      'zh-CN': '航段',
      'zh-TW': '航段',
      'en': 'segments'
    },
    'warning-low-confidence': {
      'zh-CN': '解析置信度低 — 结果可能与你的意图不符',
      'zh-TW': '解析置信度低 — 結果可能與你的意圖不符',
      'en': 'Low confidence in parsing — results may not match your intent'
    },
    'warning-no-evaluation': {
      'zh-CN': '航线评估不可用 — 按距离排序',
      'zh-TW': '航線評估不可用 — 按距離排序',
      'en': 'Route evaluation unavailable — routes sorted by distance only'
    },
    'no-routes-found': {
      'zh-CN': '未找到可用的航线',
      'zh-TW': '未找到可用的航線',
      'en': 'No routes found'
    },
    'card-procedures': {
      'zh-CN': '🛫 離場/進場程序',
      'zh-TW': '🛫 離場/進場程序',
      'en': '🛫 SID/STAR Procedures'
    },
    'label-sid': {
      'zh-CN': '離場程序 (SID)',
      'zh-TW': '離場程序 (SID)',
      'en': 'Departure (SID)'
    },
    'label-star': {
      'zh-CN': '進場程序 (STAR)',
      'zh-TW': '進場程序 (STAR)',
      'en': 'Arrival (STAR)'
    },
    'btn-select-route': {
      'zh-CN': '✅ 选择',
      'zh-TW': '✅ 選擇',
      'en': 'Select'
    },
    'btn-refresh': {
      'zh-CN': '🔄 刷新',
      'zh-TW': '🔄 刷新',
      'en': '🔄 Refresh'
    },
    'toast-weather-refreshed': {
      'zh-CN': '天气已刷新',
      'zh-TW': '天氣已刷新',
      'en': 'Weather refreshed'
    },
    'toast-weather-fail': {
      'zh-CN': '天气刷新失败',
      'zh-TW': '天氣刷新失敗',
      'en': 'Weather refresh failed'
    },
    'error-plan-failed': {
      'zh-CN': '规划失败，请检查 LLM 设置或网络连接',
      'zh-TW': '規劃失敗，請檢查 LLM 設定或網路連線',
      'en': 'Planning failed. Check LLM settings or network connection.'
    },
    'card-weather': {
      'zh-CN': '天气',
      'zh-TW': '天氣',
      'en': 'Weather'
    },
    'card-route-candidates': {
      'zh-CN': '🛫 候选航线',
      'zh-TW': '🛫 候選航線',
      'en': '🛫 Route Candidates'
    },
    'label-loading-procedures': {
      'zh-CN': '載入程序中...',
      'zh-TW': '載入程序中...',
      'en': 'Loading procedures...'
    },
    'label-no-procedures': {
      'zh-CN': '此機場無可用程序',
      'zh-TW': '此機場無可用程序',
      'en': 'No procedures available'
    },
    'info-no-procedure-for-fix': {
      'zh-CN': '無程序匹配此航點',
      'zh-TW': '無程序匹配此航點',
      'en': 'No procedure matches this fix'
    },
    'card-weather': {
      'zh-CN': 'Weather',
      'zh-TW': 'Weather',
      'en': 'Weather'
    },
    'card-route-candidates': {
      'zh-CN': '🛫 候選航線',
      'zh-TW': '🛫 候選航線',
      'en': '🛫 Route Candidates'
    },
    'panel-departure': {
      'zh-CN': '離場詳情',
      'zh-TW': '離場詳情',
      'en': 'Departure Details'
    },
    'panel-arrival': {
      'zh-CN': '進場詳情',
      'zh-TW': '進場詳情',
      'en': 'Arrival Details'
    },
    'panel-route': {
      'zh-CN': '航路詳情',
      'zh-TW': '航路詳情',
      'en': 'Route Details'
    },
    'panel-navigation': {
      'zh-CN': '導航詳情',
      'zh-TW': '導航詳情',
      'en': 'Navigation Details'
    },
    'btn-refresh': {
      'zh-CN': '🔄 刷新',
      'zh-TW': '🔄 刷新',
      'en': '🔄 Refresh'
    },

    'card-weather': {
      'zh-CN': '\u26c5 \u6c14\u8c61\u4fe1\u606f',
      'zh-TW': '\u26c5 \u6c23\u8c61\u8cc7\u8a0a',
      'en': '\u26c5 Weather'
    },
    'btn-refresh': {
      'zh-CN': '\ud83d\udd04 \u5237\u65b0',
      'zh-TW': '\ud83d\udd04 \u5237\u65b0',
      'en': '\ud83d\udd04 Refresh'
    },
    'zone-departure': {
      'zh-CN': '\ud83d\udeeb \u79bb\u573a\u8be6\u60c5 (SID)',
      'zh-TW': '\ud83d\udeeb \u96e2\u5834\u8a73\u60c5 (SID)',
      'en': '\ud83d\udeeb Departure Details (SID)'
    },
    'zone-arrival': {
      'zh-CN': '\ud83d\udeec \u8fdb\u573a\u8be6\u60c5 (STAR)',
      'zh-TW': '\ud83d\udeec \u9032\u5834\u8a73\u60c5 (STAR)',
      'en': '\ud83d\udeec Arrival Details (STAR)'
    },
    'zone-route': {
      'zh-CN': '\ud83d\uddfa\ufe0f \u822a\u8def\u8be6\u60c5',
      'zh-TW': '\ud83d\uddfa\ufe0f \u822a\u8def\u8a73\u60c5',
      'en': '\ud83d\uddfa\ufe0f Route Details'
    },
    'zone-nav': {
      'zh-CN': '\ud83e\udded \u5bfc\u822a\u70b9\u8be6\u60c5',
      'zh-TW': '\ud83e\udded \u5c0e\u822a\u9ede\u8a73\u60c5',
      'en': '\ud83e\udded Navigation Waypoints'
    },
    'label-proc-name': {
      'zh-CN': '\u7a0b\u5e8f\u540d',
      'zh-TW': '\u7a0b\u5e8f\u540d',
      'en': 'Procedure'
    },
    'label-runway': {
      'zh-CN': '\u8dd1\u9053',
      'zh-TW': '\u8dd1\u9053',
      'en': 'Runway'
    },
    'label-transitions': {
      'zh-CN': '\u8fc7\u6e21\u70b9',
      'zh-TW': '\u904e\u6e21\u9ede',
      'en': 'Transitions'
    },
    'label-wp-name': {
      'zh-CN': '\u540d\u79f0',
      'zh-TW': '\u540d\u7a31',
      'en': 'Name'
    },
    'label-wp-type': {
      'zh-CN': '\u7c7b\u578b',
      'zh-TW': '\u985e\u578b',
      'en': 'Type'
    },
    'label-wp-freq': {
      'zh-CN': '\u9891\u7387',
      'zh-TW': '\u983b\u7387',
      'en': 'Freq'
    },
    'label-lat': {
      'zh-CN': '\u7eac\u5ea6',
      'zh-TW': '\u7def\u5ea6',
      'en': 'Lat'
    },
    'label-lon': {
      'zh-CN': '\u7ecf\u5ea6',
      'zh-TW': '\u7d93\u5ea6',
      'en': 'Lon'
    },
    'label-flight-plan': {
      'zh-CN': '\u98de\u884c\u8ba1\u5212',
      'zh-TW': '\u98db\u884c\u8a08\u5283',
      'en': 'Flight Plan'
    },
    'btn-copy-flight-plan': {
      'zh-CN': '\ud83d\udccb \u590d\u5236\u98de\u884c\u8ba1\u5212',
      'zh-TW': '\ud83d\udccb \u8907\u88fd\u98db\u884c\u8a08\u5283',
      'en': '\ud83d\udccb Copy Flight Plan'
    },
    'toast-flight-plan-copied': {
      'zh-CN': '\u98de\u884c\u8ba1\u5212\u5df2\u590d\u5236\uff01',
      'zh-TW': '\u98db\u884c\u8a08\u5283\u5df2\u8907\u88fd\uff01',
      'en': 'Flight plan copied!'
    },
    'weather-wind': {
      'zh-CN': '\u98ce',
      'zh-TW': '\u98a8',
      'en': 'Wind'
    },
    'weather-vis': {
      'zh-CN': '\u80fd\u89c1\u5ea6',
      'zh-TW': '\u80fd\u898b\u5ea6',
      'en': 'Vis'
    },
    'weather-temp': {
      'zh-CN': '\u6e29\u5ea6',
      'zh-TW': '\u6eab\u5ea6',
      'en': 'Temp'
    },
    'weather-qnh': {
      'zh-CN': '\u6c14\u538b',
      'zh-TW': '\u6c23\u58d3',
      'en': 'QNH'
    },
    'weather-ceiling': {
      'zh-CN': '\u4e91\u5e95',
      'zh-TW': '\u96f2\u5e95',
      'en': 'Ceiling'
    },
    'label-sid-node': {
      'zh-CN': '\u79bb\u573a\u8282\u70b9',
      'zh-TW': '\u96e2\u5834\u7bc0\u9ede',
      'en': 'SID Node'
    },
    'label-star-node': {
      'zh-CN': '\u8fdb\u573a\u8282\u70b9',
      'zh-TW': '\u9032\u5834\u7bc0\u9ede',
      'en': 'STAR Node'
    },
    'toast-plan-copied': {
      'zh-CN': '\u5df2\u590d\u5236\u822a\u8def\uff01',
      'zh-TW': '\u5df2\u8907\u88fd\u822a\u8def\uff01',
      'en': 'Route copied!'
    },
  };

  let currentLang = DEFAULT_LANG;

  /** Load persisted language preference. */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && TRANSLATIONS['title'][raw]) currentLang = raw;
    } catch (e) { /* ignore */ }
  }

  /** Save language preference. */
  function save(lang) {
    currentLang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
  }

  /** Translate a single key for the current language. */
  function t(key) {
    const entry = TRANSLATIONS[key];
    if (!entry) return key;
    return entry[currentLang] || entry[DEFAULT_LANG] || key;
  }

  /** Apply translations to all elements with data-i18n attribute. */
  function apply() {
    const els = document.querySelectorAll('[data-i18n]');
    els.forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const attr = el.getAttribute('data-i18n-attr') || 'placeholder';
        el.setAttribute(attr, t(key));
      } else if (el.tagName === 'SELECT' && el.options) {
        // For <select>, translate the label sibling instead
        const label = el.parentElement?.querySelector('label');
        if (label) label.textContent = t(key);
      } else {
        el.textContent = t(key);
      }
    });

    // Update <title>
    document.title = t('title');
  }

  /** Full refresh: apply translations and update UI components. */
  function refresh() {
    apply();

    // Plan button
    const planBtn = document.getElementById('planBtn');
    if (planBtn && !planBtn.disabled) planBtn.textContent = t('btn-plan');

    // Update candidate label
    const kLabel = document.querySelector('label[for="kSelect"]');
    if (kLabel) kLabel.textContent = t('label-candidates');

    // Update AIRAC label
    const cycleLabel = document.querySelector('label[for="cycleSelect"]');
    if (cycleLabel) cycleLabel.textContent = t('header-airac');

    // LLM Settings modal
    const modalTitle = document.querySelector('.modal h2');
    if (modalTitle) modalTitle.textContent = t('modal-title');

    // Update LLM API labels inside the modal (skip Language/Timezone which are hardcoded)
    const labelKeys = ['label-language', 'label-timezone'];
    const langLabel = document.querySelector('.modal .form-group:nth-of-type(1) label');
    const tzLabel = document.querySelector('.modal .form-group:nth-of-type(2) label');
    if (langLabel) langLabel.textContent = t('label-language');
    if (tzLabel) tzLabel.textContent = t('label-timezone');

    // Only update LLM API labels (marked with class 'llm-label')
    const apiLabels = document.querySelectorAll('.modal .llm-label');
    const apiLabelKeys = ['label-provider', 'label-base-url', 'label-api-key', 'label-model', 'label-temperature'];
    apiLabels.forEach((label, i) => {
      if (i < apiLabelKeys.length) label.textContent = t(apiLabelKeys[i]);
    });
  }

  /** Initialize: load persisted lang, apply, attach change listener. */
  function init() {
    load();
    document.getElementById('settingsLang').value = currentLang;
    refresh();

    document.getElementById('settingsLang').addEventListener('change', (e) => {
      save(e.target.value);
      refresh();
    });
  }

  return { init, refresh, t };
})();

// Auto-init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => I18N.init());
} else {
  I18N.init();
}
