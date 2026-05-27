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
      'zh-CN': 'AI 飞行计划',
      'zh-TW': 'AI 飛行計劃',
      'en': 'AI Flight Planner'
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
      'zh-CN': '⚙️ LLM API 设置',
      'zh-TW': '⚙️ LLM API 設定',
      'en': '⚙️ LLM API Settings'
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
    }
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

    // Update LLM settings button text
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.textContent = t('btn-settings');

    // Update plan button
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

    // Update all labels inside the modal
    const modalLabels = document.querySelectorAll('.modal .form-group > label');
    const labelKeys = ['label-provider', 'label-base-url', 'label-model', 'label-api-key', 'label-temperature'];
    modalLabels.forEach((label, i) => {
      if (i < labelKeys.length) label.textContent = t(labelKeys[i]);
    });
  }

  /** Initialize: load persisted lang, apply, attach change listener. */
  function init() {
    load();
    document.getElementById('langSelect').value = currentLang;
    refresh();

    document.getElementById('langSelect').addEventListener('change', (e) => {
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
