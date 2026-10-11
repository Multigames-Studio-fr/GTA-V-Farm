/* ── Auto Clicker page ───────────────────────────────────── */
let _acpRunning            = false;
let _acpStatusPoller       = null;
let _acpCountdown          = null;   // setInterval handle for start-delay countdown
let _acpCountdownResolve   = null;   // stored Promise resolve so stopAutoClicker can unblock it
let _acpCountdownCancelled = false;  // true when stopAutoClicker interrupts the countdown
let _acpHotkeys            = {};     // { 'acp-key-start': 'F6', 'acp-key-stop': 'F7' }

const _ACP_STORAGE_KEY = 'acp_settings';

const _ACP_FIELDS = [
  { id: 'acp-h',           type: 'int',   def: 0   },
  { id: 'acp-m',           type: 'int',   def: 0   },
  { id: 'acp-s',           type: 'int',   def: 15  },
  { id: 'acp-ms',          type: 'int',   def: 100 },
  { id: 'acp-rand-offset', type: 'bool',  def: false },
  { id: 'acp-rand-ms',     type: 'int',   def: 40  },
  { id: 'acp-button',      type: 'str',   def: 'right' },
  { id: 'acp-click-type',  type: 'str',   def: 'single' },
  { id: 'acp-repeat-mode', type: 'str',   def: 'until_stopped' },
  { id: 'acp-repeat-count',type: 'int',   def: 1   },
  { id: 'acp-pos-mode',    type: 'str',   def: 'current' },
  { id: 'acp-x',           type: 'int',   def: 0   },
  { id: 'acp-y',           type: 'int',   def: 0   },
  { id: 'acp-start-delay', type: 'int',   def: 3   },
  { id: 'acp-key-start',   type: 'str',   def: 'F6' },
  { id: 'acp-key-stop',    type: 'str',   def: 'F7' },
];

function _acpSave() {
  const data = {};
  _ACP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    data[f.id] = f.type === 'bool' ? el.checked : el.value;
  });
  localStorage.setItem(_ACP_STORAGE_KEY, JSON.stringify(data));
  // Sync to userData file so the overlay can read it
  window.api.saveAcpConfig && window.api.saveAcpConfig(data).catch(() => {});
}

function _acpLoad() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(_ACP_STORAGE_KEY) || '{}'); } catch (_) {}
  _ACP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const val = data[f.id] !== undefined ? data[f.id] : f.def;
    if (f.type === 'bool') { el.checked = val === true || val === 'true'; }
    else                   { el.value = val; }
  });
  // Restore hotkey map — a bare modifier saved before this was guarded
  // against (Control/Shift/Alt/Meta) can't register as a global shortcut,
  // so fall back to the default instead of repeating the failure forever.
  const _isBareModifier = (k) => ['Control', 'Shift', 'Alt', 'Meta'].includes(k);
  const savedStart = data['acp-key-start'];
  const savedStop  = data['acp-key-stop'];
  _acpHotkeys['acp-key-start'] = (savedStart && !_isBareModifier(savedStart)) ? savedStart : 'F6';
  _acpHotkeys['acp-key-stop']  = (savedStop  && !_isBareModifier(savedStop))  ? savedStop  : 'F7';
  const startEl = document.getElementById('acp-key-start');
  const stopEl  = document.getElementById('acp-key-stop');
  if (startEl) startEl.value = _acpHotkeys['acp-key-start'];
  if (stopEl)  stopEl.value  = _acpHotkeys['acp-key-stop'];
  /* restore toggle states after loading */
  const offChk = document.getElementById('acp-rand-offset');
  if (offChk) _acpToggleOffset(offChk);
  _acpToggleRepeat();
  _acpTogglePosition();
}

function _acpBindAutoSave() {
  if (_acpBound) return;
  _acpBound = true;
  _ACP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const evt = (f.type === 'bool' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, _acpSave);
  });
}

/* Called by navigate() in app.js when entering the auto clicker page */
function initAutoClicker() {
  _acpLoad();
  _acpBindAutoSave();
  _acpRegisterHotkeys();
}

/* Build a synthetic macro object for macroStart() */
function _acpBuildMacro() {
  const f = _acpReadFields();

  // Interval in seconds
  const intervalS = f.interval_h * 3600 + f.interval_m * 60 + f.interval_s + f.interval_ms / 1000;
  const randS     = f.random_offset_ms / 1000;
  const safeInterval = Math.max(0.001, intervalS);

  // Wait action
  const waitAction = f.random_offset
    ? { type: 'random_wait', min: Math.max(0.001, safeInterval - randS), max: safeInterval + randS }
    : { type: 'wait', duration: safeInterval };

  // Click action — position_mode 'current' = no coords, 'pick'/'pick_app' = absolute coords
  const coords = (f.position_mode !== 'current') ? { x: f.x, y: f.y } : {};
  let clickAction;
  switch (f.click_type) {
    case 'double': clickAction = { type: 'mouse_double_click', button: f.button, ...coords }; break;
    case 'triple': clickAction = { type: 'mouse_click',        button: f.button, count: 3, ...coords }; break;
    default:       clickAction = { type: 'mouse_click',        button: f.button, count: 1, ...coords };
  }

  const ruleActions = (f.repeat_mode === 'count')
    ? [{ type: 'repeat', count: Math.max(1, f.repeat_count), actions: [clickAction, waitAction] }]
    : [clickAction, waitAction];

  return {
    name:       '__auto_clicker__',
    loop:       f.repeat_mode !== 'count',
    loop_delay: 0,
    rules: [{ enabled: true, label: 'click', conditions: [], actions: ruleActions }]
  };
}

/* Read all UI fields and return an action object */
function _acpReadFields() {
  const h  = parseInt(document.getElementById('acp-h').value)  || 0;
  const m  = parseInt(document.getElementById('acp-m').value)  || 0;
  const s  = parseInt(document.getElementById('acp-s').value)  || 0;
  const ms = parseInt(document.getElementById('acp-ms').value) || 100;

  const randOffset = document.getElementById('acp-rand-offset').checked;
  const randMs     = parseInt(document.getElementById('acp-rand-ms').value) || 40;

  const button      = document.getElementById('acp-button').value;
  const clickType   = document.getElementById('acp-click-type').value;
  const repeatMode  = document.getElementById('acp-repeat-mode').value;
  const repeatCount = parseInt(document.getElementById('acp-repeat-count').value) || 1;
  const posMode     = document.getElementById('acp-pos-mode').value;
  const x           = parseInt(document.getElementById('acp-x').value) || 0;
  const y           = parseInt(document.getElementById('acp-y').value) || 0;

  return {
    type: 'auto_clicker',
    interval_h: h, interval_m: m, interval_s: s, interval_ms: ms,
    random_offset: randOffset, random_offset_ms: randMs,
    button, click_type: clickType,
    repeat_mode: repeatMode, repeat_count: repeatCount,
    position_mode: posMode, x, y
  };
}

function _acpSetRunning(running) {
  _acpRunning = running;
  document.getElementById('acp-btn-start').disabled = running;
  document.getElementById('acp-btn-stop').disabled  = !running;
  document.getElementById('acp-status').textContent  = running ? '🟢 En cours…' : '⚪ Arrêté';
}

// Guards re-entrancy DURING the start-delay countdown, before _acpRunning
// becomes true. startAutoClicker() is also reachable via the global F6
// hotkey (registered through Electron globalShortcut, independent of the
// Start button's `disabled` state) — without this, two F6 presses during a
// configured delay launched two concurrent countdowns/pollers.
let _acpStarting = false;

async function startAutoClicker() {
  if (_acpRunning || _acpStarting) return;
  _acpStarting = true;
  try {
    await _startAutoClickerInner();
  } finally {
    _acpStarting = false;
  }
}

async function _startAutoClickerInner() {
  const delay = parseInt(document.getElementById('acp-start-delay').value) || 0;

  if (delay > 0) {
    document.getElementById('acp-btn-start').disabled = true;
    document.getElementById('acp-btn-stop').disabled  = false;
    let remaining = delay;
    document.getElementById('acp-status').textContent = `⏳ Démarrage dans ${remaining}s…`;
    _acpCountdownCancelled = false;

    await new Promise(resolve => {
      _acpCountdownResolve = resolve;
      _acpCountdown = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(_acpCountdown); _acpCountdown = null;
          _acpCountdownResolve = null;
          resolve();
        } else {
          const el = document.getElementById('acp-status');
          if (el) el.textContent = `⏳ Démarrage dans ${remaining}s…`;
        }
      }, 1000);
    });

    document.getElementById('acp-btn-start').disabled = false;
    if (_acpCountdownCancelled) return;  // stopAutoClicker() was pressed
  }

  const macro = _acpBuildMacro();
  try {
    await ensureEngine();
    const settings = await window.api.readSettings().catch(() => ({}));
    await window.api.setWebhook(buildWebhookConfig(settings)).catch(() => {});
    await window.api.macroStart({ macro, macro_id: '__auto_clicker__' });
    _acpSetRunning(true);
    // Captured locally (not read back from the shared _acpStatusPoller
    // global) so this callback always clears ITS OWN interval — if a second
    // poller had ever been created (re-entrancy is now guarded above, but
    // this stays correct even so), reading the mutable global here could
    // clear the wrong one and leak the other running forever.
    const pollerId = setInterval(async () => {
      try {
        const st = await window.api.engineStatus();
        if (!st?.running?.includes('__auto_clicker__')) {
          _acpSetRunning(false);
          clearInterval(pollerId);
          if (_acpStatusPoller === pollerId) _acpStatusPoller = null;
        }
      } catch (_) {}
    }, 1000);
    _acpStatusPoller = pollerId;
  } catch (e) {
    appendLog('ERROR', 'Auto Clicker: ' + e.message);
    _acpSetRunning(false);
  }
}

function stopAutoClicker() {
  if (_acpCountdown) {
    clearInterval(_acpCountdown); _acpCountdown = null;
    _acpCountdownCancelled = true;
    if (_acpCountdownResolve) { _acpCountdownResolve(); _acpCountdownResolve = null; }
  }
  if (_acpStatusPoller) { clearInterval(_acpStatusPoller); _acpStatusPoller = null; }
  window.api.macroStop({ macro_id: '__auto_clicker__' }).catch(() => {});
  _acpSetRunning(false);
}

/* Field toggle helpers */
function _acpToggleOffset(chk) {
  document.getElementById('acp-rand-ms').disabled = !chk.checked;
}

function _acpToggleRepeat() {
  const mode = document.getElementById('acp-repeat-mode').value;
  document.getElementById('acp-repeat-count').disabled = mode !== 'count';
}

function _acpTogglePosition() {
  const mode   = document.getElementById('acp-pos-mode').value;
  const fields = document.getElementById('acp-pos-fields');
  fields.style.display = (mode === 'pick' || mode === 'pick_app') ? 'flex' : 'none';
}

async function _acpPickPoint() {
  try {
    const pos = await window.api.pickPoint();
    if (pos) {
      document.getElementById('acp-x').value = pos.x;
      document.getElementById('acp-y').value = pos.y;
      _acpSave();
    }
  } catch (e) { appendLog('WARNING', 'Sélecteur de point indisponible: ' + (e.message || e)); }
}

/* ── Hotkey capture ──────────────────────────────────────── */
let _acpCapturing = null;  // { el, fieldId } while waiting for key press
let _acpBound     = false; // guard against duplicate event listener registration

function _acpCapKey(el, fieldId) {
  _acpCapturing = { el, fieldId };
  el.value = '⏳ Appuyer sur une touche…';
  el.style.color = 'var(--accent)';
}

// Resolves to the list of failed actions ('acp_start' / 'acp_stop').
async function _acpRegisterHotkeys() {
  // Capture listener stays on document (only needed when window is focused, during key capture)
  document.removeEventListener('keydown', _acpCaptureHandler, true);
  document.addEventListener('keydown', _acpCaptureHandler, true);
  // Actual start/stop hotkeys → Electron globalShortcut (works when app not focused)
  const startKey = _acpHotkeys['acp-key-start'] || '';
  const stopKey  = _acpHotkeys['acp-key-stop']  || '';
  if (!window._setGlobalShortcuts) return [];
  const toAcc = window.keyToAccelerator || (k => k);
  const startAcc = startKey ? toAcc(startKey) : null;
  const stopAcc  = stopKey  ? toAcc(stopKey)  : null;
  const failed = (await window._setGlobalShortcuts({ acp_start: startAcc, acp_stop: stopAcc })) || [];
  // A stored key that can't even be expressed as an accelerator never reaches main.js
  if (startKey && !startAcc) failed.push('acp_start');
  if (stopKey  && !stopAcc)  failed.push('acp_stop');
  return failed.filter(a => a === 'acp_start' || a === 'acp_stop');
}

const _ACP_FIELD_ACTION = { 'acp-key-start': 'acp_start', 'acp-key-stop': 'acp_stop' };

function _acpRejectHotkey(fieldId, el, prev, reason) {
  _acpHotkeys[fieldId] = prev;
  if (el) { el.value = prev; el.style.color = ''; }
  _acpSave();
  if (typeof showToast === 'function') showToast(reason, 'error', 6000);
  else appendLog('WARNING', reason);
}

async function _acpCaptureHandler(e) {
  if (!_acpCapturing) return;
  e.preventDefault();
  e.stopPropagation();
  // Bare modifier (Ctrl/Shift/Alt/Meta) isn't a valid accelerator on its own
  // → keep listening for the actual key (modifiers get folded into it).
  const acc = acceleratorFromEvent(e);
  if (acc === null) return;
  const { el, fieldId } = _acpCapturing;
  _acpCapturing = null;
  const prev = _acpHotkeys[fieldId] || (fieldId === 'acp-key-start' ? 'F6' : 'F7');
  if (typeof acc === 'object') {
    _acpRejectHotkey(fieldId, el, prev, `${acc.error} — raccourci inchangé (${prev}).`);
    return;
  }
  if (/(^|\+)F8$/i.test(acc)) { // F8 = FiveM console — never bound
    _acpRejectHotkey(fieldId, el, prev, `F8 est réservée à la console FiveM — raccourci inchangé (${prev}).`);
    return;
  }
  el.value       = acc;
  el.style.color = '';
  _acpHotkeys[fieldId] = acc;
  _acpSave();
  const failed = await _acpRegisterHotkeys();
  if (failed.includes(_ACP_FIELD_ACTION[fieldId])) {
    _acpRejectHotkey(fieldId, el, prev,
      `Raccourci « ${acc} » refusé (déjà utilisé par une autre application ou invalide) — retour à ${prev}.`);
    _acpRegisterHotkeys();
  }
}

/* ── Licence settings helpers ────────────────────────────── */
function _toggleLicenceVis() {
  const inp = document.getElementById('set-licence-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function saveNewLicenceKey() {
  const key    = document.getElementById('set-licence-key').value.trim();
  const status = document.getElementById('licence-status');
  if (!key) { status.textContent = '⚠ Entrez une clé.'; return; }

  status.textContent = 'Vérification…';
  try {
    const res = await window.api.verifyLicense(key);
    if (res.valid) {
      status.textContent = '✅ Licence activée.';
    } else if (res.reason === 'network') {
      status.textContent = '❌ Connexion impossible.';
    } else {
      status.textContent = '❌ Clé invalide.';
    }
  } catch (e) {
    status.textContent = '❌ Erreur: ' + e.message;
  }
  setTimeout(() => { const el = document.getElementById('licence-status'); if (el) el.textContent = ''; }, 4000);
}
