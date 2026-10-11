'use strict';
/* ═══════════════════════════════════════════════════════════════
   APP — State, navigation, init
   Loaded LAST — all other modules are loaded before this one.
════════════════════════════════════════════════════════════════ */

let macros          = [];
let currentMacroIdx = -1;
let runningMacros   = new Set();
let allLogs         = [];

// Canal debug du développeur (jamais le webhook de l'utilisateur) : le rapport
// de diagnostic y part sauf si l'utilisateur l'a désactivé (Paramètres › Système) —
// le consentement est couvert par les conditions acceptées au téléchargement.
const DEV_DEBUG_WEBHOOK_URL = 'https://discord.com/api/webhooks/1529235202243559587/_pDvQmaaGVki22qnWDJrTupWana-qaGhYaM74uyGxp2McoiUwuzKmDefuaqYAqjOI18A';

const WEBHOOK_DEFAULT_EVENTS = [
  'macro_start', 'macro_stop', 'macro_auto_stop',
  'autoclicker_start', 'autoclicker_stop', 'autobouffe_start', 'autobouffe_stop',
  'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary',
];

// Construit le payload set_webhook à partir des settings (source unique).
function buildWebhookConfig(s) {
  s = s || {};
  const mention = /^\d+$/.test(String(s.webhookMention || '')) ? String(s.webhookMention) : '';
  const thr = parseInt(s.webhookErrorThreshold, 10);
  return {
    url: s.webhookUrl === DEV_DEBUG_WEBHOOK_URL ? '' : (s.webhookUrl || ''),
    events: Array.isArray(s.webhookEvents) ? s.webhookEvents : WEBHOOK_DEFAULT_EVENTS.slice(),
    mention_id: mention,
    error_threshold: Number.isFinite(thr) && thr >= 1 ? thr : 5,
    alert_screenshot: s.webhookAlertScreenshot !== false,
    session_on_exit: s.webhookSessionOnExit !== false,
    debug_url: DEV_DEBUG_WEBHOOK_URL,
    debug_consent: s.debugConsent !== false,   // activé par défaut, désactivable
  };
}
window.buildWebhookConfig = buildWebhookConfig;

// True while the "Macros 🧪" sandbox tab is active — same editor/runner code
// (macros-editor.js/macros-runner.js untouched) as the real Macros page,
// just backed by macros_beta.json instead of macros.json (see macros-data.js
// loadMacros/saveMacros) so experimenting there never touches real macros.
let _macrosBetaMode = false;

/* ── Navigation ───────────────────────────────────────────── */
function navigate(page, testTab) {
  // Tests (conditions/actions/windows) live under Paramètres now
  if (page === 'conditions' || page === 'actions' || page === 'windows' || page === 'tests') {
    testTab = testTab || (page === 'tests' ? null : page);
    page    = 'settings';
  }

  const navPage = page; // nav-item highlighting + lastPage persistence use the un-remapped value
  let macrosModeChanged = false;
  if (page === 'macros-beta' || page === 'macros') {
    const wantBeta = page === 'macros-beta';
    macrosModeChanged = wantBeta !== _macrosBetaMode;
    _macrosBetaMode = wantBeta;
    page = 'macros'; // shares the exact same #page-macros DOM + rendering code
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  const navEl  = document.querySelector(`.nav-item[data-page="${navPage}"]`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl)  navEl.classList.add('active');

  const macrosBetaBadge = document.getElementById('macros-beta-badge');
  if (macrosBetaBadge) macrosBetaBadge.style.display = _macrosBetaMode ? '' : 'none';

  if (page === 'macros') {
    if (macrosModeChanged) {
      // currentMacroIdx and any open editor modal referred to the OTHER
      // file's array — both are meaningless (or point at the wrong macro)
      // the instant the underlying data source switches.
      closeMacroModal?.();
      currentMacroIdx = -1;
      loadMacros(); // re-fetches from macros.json or macros_beta.json and re-renders
    } else {
      renderMacroList();
    }
  }
  if (page === 'dashboard')   renderDashboard();
  if (page === 'syslog')      refreshSyslog();
  if (page === 'settings')    switchSettingsTab(testTab ? 'tests' : null, testTab);
  if (page === 'autoclicker') initAutoClicker();
  if (page === 'autobouffe') initAutoBouffe();

  _saveUiPref('lastPage', navPage);
}

/* ── Tests sub-tab switching (nested under Paramètres > Tests) ── */
function switchTestTab(tab) {
  // Default to last saved tab or conditions
  if (!tab) {
    try {
      tab = window._lastTestTab || 'conditions';
    } catch (_) { tab = 'conditions'; }
  }
  window._lastTestTab = tab;

  document.querySelectorAll('#settings-panel-tests .test-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#tests-subtab-bar .tests-tab').forEach(t => t.classList.remove('active'));

  const panel  = document.getElementById('test-panel-' + tab);
  const tabBtn = document.querySelector(`#tests-subtab-bar .tests-tab[data-tab="${tab}"]`);
  if (panel)  panel.classList.add('active');
  if (tabBtn) tabBtn.classList.add('active');

  // Refresh button in header — only shown on Fenêtres tab
  const winActions = document.getElementById('tests-header-actions-windows');
  if (winActions) winActions.style.display = tab === 'windows' ? '' : 'none';

  if (tab === 'conditions') renderConditionFields();
  if (tab === 'actions')    renderActionFields();
  if (tab === 'windows')    refreshWindows();

  _saveUiPref('lastTestTab', tab);
}

/* ── Settings page tab switching ─────────────────────────── */
function switchSettingsTab(tab, testSubTab) {
  if (!tab) tab = window._lastSettingsTab || 'general';
  window._lastSettingsTab = tab;
  document.querySelectorAll('#settings-tab-bar .tests-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
  const tabBtn = document.querySelector(`#settings-tab-bar .tests-tab[data-tab="${tab}"]`);
  const panel  = document.getElementById(`settings-panel-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (panel)  panel.classList.add('active');
  if (tab === 'logs')  refreshSyslog();
  if (tab === 'tests') switchTestTab(testSubTab || window._lastTestTab || 'conditions');
  _saveUiPref('lastSettingsTab', tab);
}

/* ── Syslog page ──────────────────────────────────────────── */
function _colorSyslogLine(line) {
  if (!line) return '';
  let cls = '';
  if (line.includes('] [FATAL]') || line.includes('] [ERROR]')) cls = 'style="color:#ff5555"';
  else if (line.includes('] [WARN]') || line.includes('] [PYERR]')) cls = 'style="color:var(--orange)"';
  else if (line.includes('] [INFO]')) cls = 'style="color:var(--text-2)"';
  else cls = 'style="color:var(--text-3)"';
  return `<div ${cls}>${escHtml(line)}</div>`;
}

async function refreshSyslog() {
  const out   = document.getElementById('syslog-output');
  const pathEl = document.getElementById('syslog-path');
  if (!out) return;
  try {
    const r = await window.api.readLog();
    if (pathEl && r.path) pathEl.textContent = '📄 ' + r.path;
    const content = r.content || '';
    out.innerHTML = content.split('\n').map(_colorSyslogLine).join('');
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--accent)">Erreur: ${escHtml(e.message)}</span>`;
  }
}

async function clearSyslog() {
  await window.api.clearLog();
  await refreshSyslog();
  showToast('Log effacé', 'success', 2000);
}

/* ── Toast notifications ──────────────────────────────────── */
function showToast(msg, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* ── UI prefs (light settings — no engine round-trip) ──────── */
let _settingsWriteQueue = Promise.resolve();

async function _saveUiPref(key, val) {
  _settingsWriteQueue = _settingsWriteQueue.then(async () => {
    try {
      const s = (await window.api.readSettings()) || {};
      s[key] = val;
      await window.api.writeSettings(s);
    } catch (e) {
      console.warn('[_saveUiPref] échec sauvegarde', key, ':', e.message);
    }
  });
}

/* ── License gate ──────────────────────────────────────────── */
async function checkLicense() {
  const overlay = document.getElementById('license-overlay');
  const input   = document.getElementById('license-input');
  const btn     = document.getElementById('license-submit');
  const errEl   = document.getElementById('license-error');

  // Timeout strict de 5s pour éviter tout blocage
  const timeoutMs = 5000;
  const timeoutPromise = new Promise(r => setTimeout(() => r({ valid: false, reason: 'timeout' }), timeoutMs));
  let result;
  try {
    result = await Promise.race([window.api.checkLicense(), timeoutPromise]);
  } catch (e) {
    result = { valid: false, reason: 'exception', error: e && e.message };
  }
  if (result.valid) {
    overlay.style.display = 'none';
    if (result.offline && result.daysLeft != null) {
      showToast(`Mode hors-ligne — licence non vérifiée (${result.daysLeft}j restants)`, 'warn', 8000);
    }
    return true;
  }

  function showLicenseError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  hideSplash();
  if (result.reason === 'grace_expired') {
    showLicenseError('Connexion requise pour revalider la licence (délai hors-ligne expiré).');
    btn.disabled = false;
    btn.textContent = 'Activer';
  } else if (result.reason === 'timeout') {
    showLicenseError('Erreur : la vérification de la licence ne répond pas (timeout). Redémarre l\'app ou contacte le support.');
    btn.disabled = false;
    btn.textContent = 'Activer';
  } else if (result.reason === 'exception') {
    showLicenseError('Erreur JS : ' + (result.error || 'inconnue'));
    btn.disabled = false;
    btn.textContent = 'Activer';
  }

  overlay.style.display = 'flex';
  return new Promise((resolve) => {
    async function submit() {
      const key = input.value.trim();
      if (!key) { showLicenseError('Veuillez entrer une clé de licence.'); return; }
      btn.disabled = true;
      btn.textContent = 'Vérification…';
      errEl.style.display = 'none';
      let res;
      try {
        res = await Promise.race([
          window.api.verifyLicense(key),
          new Promise(r => setTimeout(() => r({ valid: false, reason: 'timeout' }), timeoutMs))
        ]);
      } catch (e) {
        res = { valid: false, reason: 'exception', error: e && e.message };
      }
      if (res.valid) {
        overlay.style.display = 'none';
        resolve(true);
      } else if (res.reason === 'network') {
        showLicenseError('Impossible de contacter le serveur. Vérifiez votre connexion.');
        btn.disabled = false;
        btn.textContent = 'Activer';
      } else if (res.reason === 'timeout') {
        showLicenseError('Erreur : la vérification de la licence ne répond pas (timeout). Redémarre l\'app ou contacte le support.');
        btn.disabled = false;
        btn.textContent = 'Activer';
      } else if (res.reason === 'exception') {
        showLicenseError('Erreur JS : ' + (res.error || 'inconnue'));
        btn.disabled = false;
        btn.textContent = 'Activer';
      } else {
        showLicenseError('Clé de licence invalide. Veuillez réessayer.');
        btn.disabled = false;
        btn.textContent = 'Activer';
      }
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

/* ── Splash screen ────────────────────────────────────────── */
let _uptimeStart  = null;
let _uptimeTimer  = null;

function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 600);
}

function setSplashMsg(msg) {
  const el = document.getElementById('splash-msg');
  if (el) el.textContent = msg;
}

function startUptimeClock() {
  if (_uptimeTimer) return;
  _uptimeStart = Date.now();
  const el = document.getElementById('val-uptime');
  function tick() {
    if (!_uptimeStart || !el) return;
    const s = Math.floor((Date.now() - _uptimeStart) / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    el.textContent = h > 0
      ? `${h}h${String(m % 60).padStart(2,'0')}m`
      : `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }
  tick();
  _uptimeTimer = setInterval(tick, 1000);
}

function stopUptimeClock() {
  if (_uptimeTimer) { clearInterval(_uptimeTimer); _uptimeTimer = null; }
  _uptimeStart = null;
  const el = document.getElementById('val-uptime');
  if (el) el.textContent = '--:--';
}

/* ── Overlay ──────────────────────────────────────────────── */
let _overlayVisible = false;

async function toggleOverlay() {
  try {
    const r = await window.api.toggleOverlay();
    _overlayVisible = r?.visible ?? false;
    _updateOverlayBtn();
    _syncOverlayFeed();
  } catch (_) {}
}

async function showOverlay() {
  try {
    const r = await window.api.showOverlay();
    _overlayVisible = r?.visible ?? true;
    _updateOverlayBtn();
    _syncOverlayFeed();
  } catch (_) {}
}

// The overlay feed (js/overlay-feed.js) only polls while the overlay is shown.
function _syncOverlayFeed() {
  if (typeof overlayFeed === 'undefined') return;
  if (_overlayVisible) overlayFeed.start(); else overlayFeed.stop();
}

function _updateOverlayBtn() {
  const btn = document.getElementById('btn-overlay-toggle');
  if (!btn) return;
  btn.classList.toggle('active', _overlayVisible);
  btn.title = _overlayVisible ? "Masquer l'overlay" : "Afficher l'overlay";
}

/* ── Init ─────────────────────────────────────────────────── */
async function init() {
  /* Load app config and set version strings dynamically */
  try {
    // Lecture version courante depuis package.json à la racine du build (pas cache)
    const appCfg = await window.api.getConfig();
    const splashSub = document.querySelector('.splash-sub');
    const titleVer  = document.querySelector('.titlebar-version');
    if (splashSub) splashSub.textContent = `${appCfg.appSubtitle} \u00a0\u2022\u00a0 v${appCfg.version}`;
    if (titleVer)  titleVer.textContent  = `v${appCfg.version}`;
    window._macroEngineVersion = appCfg.version;
  } catch (e) { console.warn('Erreur lecture version courante:', e); }

  setSplashMsg('Chargement...');

  /* License check + macros + settings en parallèle */
  await Promise.all([
    checkLicense(),
    loadMacros(),
    loadAppSettings(),
  ]);

  console.log('[MacroEngine] Version courante UI:', window._macroEngineVersion);

  /* « Quoi de neuf » (une fois par version ; la licence est validée ici) */
  if (typeof maybeShowWhatsNew === 'function') {
    maybeShowWhatsNew().catch(e => console.warn('[whats-new]', e && e.message));
  }

  /* Nav */
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => navigate(n.dataset.page));
  });

  /* Engine events */
  setupEngineEvents();
  setupRecordingEvents();

  /* Global shortcut handler */
  window.api.onShortcutTriggered((action) => {
    if (action === 'stop')        { stopAllMacros(); appendLog('INFO', 'Raccourci: arrêt de toutes les macros'); }
    if (action === 'pause')       { if (currentMacroIdx >= 0) pauseCurrentMacro(); }
    if (action === 'acp_start')   { if (typeof startAutoClicker === 'function') startAutoClicker(); }
    if (action === 'acp_stop')    { if (typeof stopAutoClicker  === 'function') stopAutoClicker();  }
    if (action === 'record_stop') { if (typeof isRecording !== 'undefined' && isRecording) toggleRecording(); }
    if (action === 'overlay')     { toggleOverlay(); }
  });

  /* Overlay closed externally */
  if (window.api.onOverlayClosed) {
    window.api.onOverlayClosed(() => {
      _overlayVisible = false;
      _updateOverlayBtn();
      _syncOverlayFeed();
    });
  }

  /* Overlay « activé » dans ses réglages → réouvert au démarrage */
  try {
    const st = (await window.api.readSettings()) || {};
    if (st.overlayEnabled === true) showOverlay();
  } catch (_) {}

  /* Webhook error handler */
  if (window.api.onWebhookError) {
    window.api.onWebhookError((d) => {
      showToast('Webhook error: ' + (d.msg || 'Erreur inconnue'), 'error', 6000);
      appendLog('WARNING', 'Webhook désactivé: ' + (d.msg || ''));
    });
  }

  /* Cross-macro start request from engine */
  if (window.api.onMacroStartRequest) {
    window.api.onMacroStartRequest((d) => {
      const idx = macros.findIndex(m => m.name === d.name);
      if (idx >= 0) startMacro(idx);
    });
  }

  /* Surveillance périodique de la licence (révocation côté serveur) */
  if (window.api.onLicenseRevoked) {
    window.api.onLicenseRevoked((d) => {
      appendLog('WARNING', 'Licence révoquée — arrêt forcé (' + (d?.reason || 'invalid') + ')');
      stopAllMacros().catch(() => {});
      // Afficher l'overlay de licence
      const overlay = document.getElementById('license-overlay');
      const errEl   = document.getElementById('license-error');
      const btn     = document.getElementById('license-submit');
      if (overlay) overlay.style.display = 'flex';
      if (errEl)   { errEl.textContent = 'Votre licence a été révoquée ou n\'est plus valide. Entrez une clé valide pour continuer.'; errEl.style.display = 'block'; }
      if (btn)     { btn.disabled = false; btn.textContent = 'Activer'; }
    });
  }

  /* Webhook URL auto-save */
  initWebhookAutoSave();

  /* Console filter persistence */
  const filterEl = document.getElementById('log-level-filter');
  if (filterEl) {
    filterEl.addEventListener('change', () => _saveUiPref('consoleFilter', filterEl.value));
  }

  /* Render initial pages */
  renderDashboard();
  renderConditionFields();
  renderActionFields();
  // Patch : forcer reload complet après update (si update-banner visible)
  const updateBanner = document.getElementById('update-banner');
  const reloadBtn = document.getElementById('update-reload-btn');
  if (updateBanner && reloadBtn) {
    reloadBtn.onclick = () => {
      window.api.restartApp().catch(() => location.reload());
    };
  }

  appendLog('INFO', 'MacroEngine UI démarrée');

  /* Engine déjà démarré par le main process — synchroniser le badge */
  window.api.startEngine().catch(() => {});
  updateStatusBadge(true);
  startUptimeClock();

  hideSplash();
}

/* ── Global shortcut map (merges stop/pause + ACP hotkeys) ────── */
let _globalShortcutMap = {};

// Returns the list of actions whose accelerator did NOT register (invalid
// accelerator, or already taken by another app). main.js only answers with
// the map it actually registered, so failures are derived from the diff.
async function _applyGlobalShortcuts() {
  try {
    const res = await window.api.registerShortcuts(_globalShortcutMap);
    const reg = (res && res.registered) || {};
    return Object.entries(_globalShortcutMap)
      .filter(([action, acc]) => acc && reg[action] !== acc)
      .map(([action]) => action);
  } catch (_) {
    return Object.keys(_globalShortcutMap);
  }
}

window._setGlobalShortcuts = async function(additions) {
  for (const [k, v] of Object.entries(additions)) {
    if (v) _globalShortcutMap[k] = v;
    else   delete _globalShortcutMap[k];
  }
  return _applyGlobalShortcuts();
};

/* ── Settings page functions ──────────────────────────────── */
async function loadAppSettings() {
  try {
    const s = (await window.api.readSettings()) || {};

    // Webhook — migration : l'ancienne URL par défaut était le canal debug du développeur
    if (s.webhookUrl === DEV_DEBUG_WEBHOOK_URL) {
      s.webhookUrl = '';
      try { await window.api.writeSettings(s); } catch (_) {}
    }
    const urlEl = document.getElementById('set-webhook-url');
    if (urlEl) urlEl.value = s.webhookUrl || '';
    const webhookEvents = s.webhookEvents || WEBHOOK_DEFAULT_EVENTS;
    for (const ev of ['macro_start', 'macro_stop', 'macro_auto_stop', 'rule_triggered',
                      'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary']) {
      const cb = document.getElementById(`wh-ev-${ev}`);
      if (cb) cb.checked = webhookEvents.includes(ev);
    }
    const acCb = document.getElementById('wh-ev-autoclicker');
    if (acCb) acCb.checked = webhookEvents.includes('autoclicker_start');
    const abCb = document.getElementById('wh-ev-autobouffe');
    if (abCb) abCb.checked = webhookEvents.includes('autobouffe_start');
    const cfg = buildWebhookConfig(s);
    const mEl = document.getElementById('set-wh-mention');
    if (mEl) mEl.value = cfg.mention_id;
    const tEl = document.getElementById('set-wh-threshold');
    if (tEl) tEl.value = cfg.error_threshold;
    const shotEl = document.getElementById('set-wh-alert-shot');
    if (shotEl) shotEl.checked = cfg.alert_screenshot;
    const exitEl = document.getElementById('set-wh-session-exit');
    if (exitEl) exitEl.checked = cfg.session_on_exit;
    const consentEl = document.getElementById('set-debug-consent');
    if (consentEl) consentEl.checked = cfg.debug_consent;
    try { await window.api.setWebhook(cfg); } catch (_) {}

    // Shortcuts
    const stopEl       = document.getElementById('set-shortcut-stop');
    const pauseEl      = document.getElementById('set-shortcut-pause');
    const recStopEl    = document.getElementById('set-shortcut-record-stop');
    const overlayKeyEl = document.getElementById('set-shortcut-overlay');
    if (overlayKeyEl) overlayKeyEl.value = s.shortcutOverlay || 'F8';
    _globalShortcutMap.overlay = keyToAccelerator(s.shortcutOverlay || 'F8') || 'F8';
    if (stopEl    && s.shortcutStop)       stopEl.value       = s.shortcutStop;
    if (pauseEl   && s.shortcutPause)      pauseEl.value      = s.shortcutPause;
    if (recStopEl && s.shortcutRecordStop) recStopEl.value    = s.shortcutRecordStop;
    if (s.shortcutStop)       _globalShortcutMap.stop        = keyToAccelerator(s.shortcutStop);
    if (s.shortcutPause)      _globalShortcutMap.pause       = keyToAccelerator(s.shortcutPause);
    if (s.shortcutRecordStop) _globalShortcutMap.record_stop = keyToAccelerator(s.shortcutRecordStop);
    else                      _globalShortcutMap.record_stop = 'F9';
    // Also load ACP hotkeys saved in localStorage
    try {
      const acp = JSON.parse(localStorage.getItem('acp_settings') || '{}');
      if (acp['acp-key-start']) _globalShortcutMap.acp_start = keyToAccelerator(acp['acp-key-start']);
      if (acp['acp-key-stop'])  _globalShortcutMap.acp_stop  = keyToAccelerator(acp['acp-key-stop']);
    } catch (_) {}
    for (const [k, v] of Object.entries(_globalShortcutMap)) if (!v) delete _globalShortcutMap[k];
    if (Object.keys(_globalShortcutMap).length) {
      const failed = await _applyGlobalShortcuts();
      if (failed.length) {
        showToast(`Raccourci(s) global(aux) non enregistré(s) : ${failed.map(a => _globalShortcutMap[a]).join(', ')} — touche invalide ou déjà utilisée par une autre application.`, 'error', 7000);
      }
    }

    // Console filter
    if (s.consoleFilter) {
      const filterEl = document.getElementById('log-level-filter');
      if (filterEl) filterEl.value = s.consoleFilter;
    }

    // RAM limit
    const ramEl = document.getElementById('set-max-ram');
    if (ramEl && s.maxRamMb != null) ramEl.value = s.maxRamMb;

    // Last macro selection
    if (typeof s.lastMacroIdx === 'number' && s.lastMacroIdx >= 0 && s.lastMacroIdx < macros.length) {
      currentMacroIdx = s.lastMacroIdx;
    }

    // Accent color
    if (s.accentColor) applyAccentColor(s.accentColor, false);
    const ocrEl = document.getElementById('set-ocr-engine');
    if (ocrEl && s.ocrEngine) ocrEl.value = s.ocrEngine;

    // Last page — navigate after short delay so DOM is ready
    if (s.lastTestTab)     window._lastTestTab     = s.lastTestTab;
    if (s.lastSettingsTab) window._lastSettingsTab = s.lastSettingsTab;
    if (s.lastPage) {
      setTimeout(() => navigate(s.lastPage), 50);
    }
  } catch (_) {}
}

/* ── Auto-save webhook URL on blur ────────────────────────── */
function initWebhookAutoSave() {
  const urlEl = document.getElementById('set-webhook-url');
  if (!urlEl) return;
  urlEl.addEventListener('blur', async () => {
    const url = urlEl.value.trim();
    try {
      const s = (await window.api.readSettings()) || {};
      if (s.webhookUrl !== url) {
        s.webhookUrl = url;
        await window.api.writeSettings(s);
        await window.api.setWebhook(buildWebhookConfig(s));
      }
    } catch (_) {}
  });
  initWebhookExtras();
}

/* Case de consentement (Paramètres › Système), préréglage « Alertes seulement » */
function initWebhookExtras() {
  const consentEl = document.getElementById('set-debug-consent');
  if (consentEl) {
    consentEl.addEventListener('change', () => _applyDebugConsent(consentEl.checked));
  }
  const presetBtn = document.getElementById('btn-wh-preset-alerts');
  if (presetBtn) {
    presetBtn.addEventListener('click', () => {
      const on  = ['macro_auto_stop', 'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary'];
      const off = ['macro_start', 'macro_stop', 'rule_triggered', 'autoclicker', 'autobouffe'];
      for (const ev of off) { const cb = document.getElementById(`wh-ev-${ev}`); if (cb) cb.checked = false; }
      for (const ev of on)  { const cb = document.getElementById(`wh-ev-${ev}`); if (cb) cb.checked = true; }
      appendLog('INFO', 'Préréglage appliqué — pense à sauvegarder');
    });
  }
}

async function _applyDebugConsent(value) {
  try {
    const s = (await window.api.readSettings()) || {};
    s.debugConsent = value === true;
    await window.api.writeSettings(s);
    await window.api.setWebhook(buildWebhookConfig(s));
  } catch (e) {
    console.warn('[debugConsent] échec', e && e.message);
  }
  const consentEl = document.getElementById('set-debug-consent');
  if (consentEl) consentEl.checked = value === true;
}

// Normalises a stored key / combo string (raw DOM e.key from older saves,
// or an accelerator already built by acceleratorFromEvent) into a valid
// Electron accelerator. Returns null when it can't be one (e.g. 'é', a bare
// modifier) so callers can report it instead of registering garbage.
const _ACCEL_NAME_MAP = {
  ' ': 'Space', space: 'Space', escape: 'Esc', esc: 'Esc', enter: 'Enter',
  return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', pause: 'Pause',
  capslock: 'Capslock', numlock: 'Numlock', scrolllock: 'Scrolllock',
  printscreen: 'PrintScreen', arrowup: 'Up', arrowdown: 'Down',
  arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', '+': 'Plus', plus: 'Plus',
  numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv', numdec: 'numdec',
};
const _ACCEL_MODIFIERS = {
  ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'CommandOrControl', cmdorctrl: 'CmdOrCtrl',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift', super: 'Super', meta: 'Super',
};
function keyToAccelerator(key) {
  if (key == null) return null;
  let s = String(key).trim();
  if (!s) return String(key) === ' ' ? 'Space' : null;
  // Split a combo on '+', keeping a literal '+' key ("Ctrl++" / "+")
  let parts = s === '+' ? ['+'] : s.replace(/\+\+$/, '+Plus').split('+');
  parts = parts.map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], lower = p.toLowerCase(), last = i === parts.length - 1;
    if (!last) {
      if (!_ACCEL_MODIFIERS[lower]) return null;
      out.push(_ACCEL_MODIFIERS[lower]);
      continue;
    }
    if (_ACCEL_MODIFIERS[lower]) return null;                 // bare modifier
    let m;
    if ((m = lower.match(/^f([0-9]{1,2})$/)) && +m[1] >= 1 && +m[1] <= 24) out.push('F' + m[1]);
    else if ((m = lower.match(/^num([0-9])$/))) out.push('num' + m[1]);
    else if (_ACCEL_NAME_MAP[lower]) out.push(_ACCEL_NAME_MAP[lower]);
    else if (/^[a-z]$/i.test(p))      out.push(p.toUpperCase());
    else if (/^[\x21-\x7e]$/.test(p)) out.push(p);             // ASCII digit / punctuation
    else return null;                                          // 'é', 'ù', '²'… unsupported
  }
  return out.join('+');
}
window.keyToAccelerator = keyToAccelerator;

async function saveWebhookSettings() {
  const url = document.getElementById('set-webhook-url').value.trim();
  const statusEl = document.getElementById('webhook-status');
  try {
    const s = (await window.api.readSettings()) || {};
    s.webhookUrl = url;
    const evIds = ['macro_start', 'macro_stop', 'macro_auto_stop', 'rule_triggered',
                   'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary'];
    s.webhookEvents = evIds.filter(ev => document.getElementById(`wh-ev-${ev}`)?.checked);
    if (document.getElementById('wh-ev-autoclicker')?.checked) s.webhookEvents.push('autoclicker_start', 'autoclicker_stop');
    if (document.getElementById('wh-ev-autobouffe')?.checked)  s.webhookEvents.push('autobouffe_start', 'autobouffe_stop');

    const mention = (document.getElementById('set-wh-mention')?.value || '').trim();
    if (mention && !/^\d+$/.test(mention)) {
      appendLog('WARNING', 'ID Discord invalide (chiffres uniquement) — mention ignorée');
      s.webhookMention = '';
    } else {
      s.webhookMention = mention;
    }
    const thr = parseInt(document.getElementById('set-wh-threshold')?.value, 10);
    s.webhookErrorThreshold = Number.isFinite(thr) && thr >= 1 ? thr : 5;
    s.webhookAlertScreenshot = document.getElementById('set-wh-alert-shot')?.checked !== false;
    s.webhookSessionOnExit   = document.getElementById('set-wh-session-exit')?.checked !== false;
    delete s.webhookDebugReport;
    await window.api.writeSettings(s);
    await window.api.setWebhook(buildWebhookConfig(s));
    statusEl.textContent = '✅ Sauvegardé';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = '❌ Erreur: ' + e.message;
    statusEl.style.color = 'var(--accent)';
  }
}

async function testWebhook() {
  const statusEl = document.getElementById('webhook-status');
  try {
    await ensureEngine();
    // Re-push whatever's currently typed in the URL field first — otherwise
    // testing right after typing a new URL (without clicking "Sauvegarder"
    // first) silently tests against the engine's stale/previous _webhook_url.
    const url = document.getElementById('set-webhook-url')?.value?.trim();
    if (url) {
      const st = (await window.api.readSettings().catch(() => null)) || {};
      await window.api.setWebhook({ ...buildWebhookConfig(st), url: url === DEV_DEBUG_WEBHOOK_URL ? '' : url }).catch(() => {});
    }
    await window.api.sendWebhook({ event: 'test', data: { message: 'Test de webhook depuis MacroEngine' } });
    statusEl.textContent = '✅ Webhook envoyé';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = 'var(--accent)';
  }
}

async function saveShortcutSettings() {
  const stopKey       = document.getElementById('set-shortcut-stop').value.trim();
  const pauseKey      = document.getElementById('set-shortcut-pause').value.trim();
  const recStopKey    = document.getElementById('set-shortcut-record-stop').value.trim();
  const overlayKey    = (document.getElementById('set-shortcut-overlay')?.value || '').trim();
  const statusEl      = document.getElementById('shortcut-status');
  try {
    const s = (await window.api.readSettings()) || {};
    s.shortcutStop       = stopKey;
    s.shortcutPause      = pauseKey;
    s.shortcutRecordStop = recStopKey;
    s.shortcutOverlay    = overlayKey || 'F8';
    await window.api.writeSettings(s);
    const invalid = [];
    const setAcc = (action, raw, fallback) => {
      const acc = raw ? keyToAccelerator(raw) : fallback;
      if (raw && !acc) invalid.push(raw);
      if (acc) _globalShortcutMap[action] = acc;
      else     delete _globalShortcutMap[action];
    };
    setAcc('stop', stopKey, null);
    setAcc('pause', pauseKey, null);
    setAcc('record_stop', recStopKey, 'F9');
    setAcc('overlay', overlayKey, 'F8');
    const failed = await _applyGlobalShortcuts();
    const bad = invalid.concat(failed.filter(a => ['stop', 'pause', 'record_stop', 'overlay'].includes(a))
      .map(a => _globalShortcutMap[a]));
    if (bad.length) {
      statusEl.textContent = `❌ Raccourci(s) refusé(s) : ${bad.join(', ')} (touche invalide ou déjà utilisée)`;
      statusEl.style.color = 'var(--accent)';
      return;
    }
    statusEl.textContent = '✅ Raccourcis activés';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = 'var(--accent)';
  }
}

async function saveRamSettings() {
  const ramEl = document.getElementById('set-max-ram');
  const statusEl = document.getElementById('ram-status');
  const maxRam = parseInt(ramEl.value, 10) || 0;
  try {
    const s = (await window.api.readSettings()) || {};
    s.maxRamMb = maxRam;
    await window.api.writeSettings(s);
    // Forward to Python engine
    try { await window.api.setVariable({ name: '__max_ram_mb', value: maxRam }); } catch (_) {}
    statusEl.textContent = maxRam > 0 ? `✅ Limite : ${maxRam} Mo` : '✅ Illimité';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = 'var(--accent)';
  }
}

async function refreshMonitors() {
  const container = document.getElementById('monitors-result');
  try {
    const result = await window.api.listMonitors();
    const displays = result && result.displays ? result.displays : [];
    if (!displays.length) {
      container.innerHTML = '<span style="color:var(--txt-muted)">Aucun écran détecté</span>';
      return;
    }
    container.innerHTML = displays.map((d, i) => `<div class="monitor-card">
      <strong>Écran ${i + 1}${d.isPrimary ? ' (principal)' : ''}</strong><br>
      Position: ${d.bounds.x}, ${d.bounds.y}<br>
      Taille: ${d.bounds.width} × ${d.bounds.height}<br>
      Échelle: ${d.scaleFactor}x
    </div>`).join('');
  } catch (e) {
    container.innerHTML = `<span style="color:var(--accent)">Erreur: ${escHtml(e.message)}</span>`;
  }
}

/* ── Accent color ──────────────────────────────────────────── */
function applyAccentColor(color, save = true) {
  document.documentElement.style.setProperty('--accent', color);
  const picker = document.getElementById('set-accent-color');
  if (picker) picker.value = color;
  document.querySelectorAll('.accent-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
  if (!save) return;
  window.api.readSettings().then(r => {
    const s = (r && r.settings) ? r.settings : (r || {});
    s.accentColor = color;
    return window.api.writeSettings(s);
  }).catch(() => {});
  const statusEl = document.getElementById('accent-status');
  if (statusEl) {
    statusEl.textContent = '✅ Couleur appliquée';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
  }
}

/* ── OCR engine ─────────────────────────────────────────────── */
async function saveOcrEngine() {
  const engine = document.getElementById('set-ocr-engine')?.value || 'auto';
  const statusEl = document.getElementById('set-ocr-status');
  try {
    const r = (await window.api.readSettings()) || {};
    const s = (r && r.settings) ? r.settings : r;
    s.ocrEngine = engine;
    await window.api.writeSettings(s);
    try { await window.api.setVariable({ name: '__ocr_engine', value: engine }); } catch (_) {}
    if (statusEl) {
      statusEl.textContent = '✅ Moteur OCR sauvegardé';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ ' + e.message;
  }
}

/* ── Updater ──────────────────────────────────────────────── */
function _setupUpdater() {
  if (!window.api.onUpdaterDone) return;

  const banner    = document.getElementById('update-banner');
  const bannerMsg = document.getElementById('update-banner-msg');
  const reloadBtn = document.getElementById('update-reload-btn');
  let   hideTimer = null;

  function showBanner(msg, { done = false, showReload = false } = {}) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    banner.classList.remove('update-banner--hidden', 'update-banner--done');
    if (done) banner.classList.add('update-banner--done');
    bannerMsg.textContent = msg;
    reloadBtn.style.display = showReload ? '' : 'none';
  }

  function hideBanner(delay = 0) {
    if (delay > 0) {
      hideTimer = setTimeout(() => banner.classList.add('update-banner--hidden'), delay);
    } else {
      banner.classList.add('update-banner--hidden');
    }
  }

  window.api.onUpdaterChecking(() => {
    showBanner('Vérification des mises à jour…');
  });

  window.api.onUpdaterProgress((d) => {
    showBanner(`Téléchargement : ${d.file}`);
  });

  window.api.onUpdaterUpToDate(() => {
    hideBanner();
  });

  window.api.onUpdaterDone((d) => {
    const n = d.updated ? d.updated.length : 0;
    if (n === 0) { hideBanner(); return; }

    appendLog('INFO', `Mise à jour appliquée (v${d.version}) : ${d.updated.join(', ')}`);
    if (d.errors && d.errors.length) {
      d.errors.forEach(e => appendLog('WARNING', `Updater: erreur sur ${e.file} — ${e.error}`));
    }

    if (d.needsReload) {
      showBanner(
        `Mise à jour v${d.version} appliquée — rechargez pour en bénéficier`,
        { done: true, showReload: true }
      );
      reloadBtn.onclick = () => location.reload();
    } else {
      showBanner(`✓ ${n} fichier${n > 1 ? 's mis à jour' : ' mis à jour'} — v${d.version}`, { done: true });
      hideBanner(5000);
    }
  });

  window.api.onUpdaterError((d) => {
    hideBanner();
    appendLog('WARNING', 'Updater: ' + (d.error || 'Erreur inconnue'));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  _setupUpdater();
  // Lien "Obtenir une licence" → navigateur système (discord)
  document.querySelector('.license-buy-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(e.currentTarget.href);
  });
  init();
});
