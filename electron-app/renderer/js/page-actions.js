'use strict';
/* ═══════════════════════════════════════════════════════════════
   PAGE: ACTIONS TESTER
════════════════════════════════════════════════════════════════ */

function renderActionFields() {
  const typeEl = document.getElementById('act-type');
  const container = document.getElementById('act-fields');
  if (!typeEl || !container) return;
  container.innerHTML = buildActTestForm(typeEl.value);
}

function buildActTestForm(type) {
  const _keyCapture = (id, val) => `<input type="text" id="${id}" class="key-capture" value="${val}" placeholder="Cliquez puis appuyez" readonly onfocus="startKeyCapture(this)" data-field="${id}">`;

  if (type === 'key_tap') {
    return `<div class="form-row">
      <div class="form-group"><label>Touche</label>${_keyCapture('at-key', 'f')}</div>
      <div class="form-group"><label>Durée appui (s)</label><input type="number" id="at-dur" value="0.05" min="0.01" step="0.01"></div>
      <div class="form-group"><label>Répétitions</label><input type="number" id="at-count" value="1" min="1"></div>
      <div class="form-group form-group-check"><label class="check-label"><input type="checkbox" id="at-direct"> DirectInput</label></div>
    </div>`;
  }
  if (type === 'key_hold') {
    return `<div class="form-row">
      <div class="form-group"><label>Touche</label>${_keyCapture('at-key', 'w')}</div>
      <div class="form-group"><label>Durée (s)</label><input type="number" id="at-dur" value="1" min="0.1" step="0.1"></div>
      <div class="form-group form-group-check"><label class="check-label"><input type="checkbox" id="at-direct"> DirectInput</label></div>
    </div>`;
  }
  if (type === 'key_release') {
    return `<div class="form-row"><div class="form-group"><label>Touche</label>${_keyCapture('at-key', 'w')}</div></div>`;
  }
  if (type === 'wait') {
    return `<div class="form-row"><div class="form-group"><label>Durée (s)</label><input type="number" id="at-dur" value="1" min="0.1" step="0.1"></div></div>`;
  }
  if (type === 'mouse_move') {
    return `<div class="form-row">
      <div class="form-group"><label>Position</label><span id="at-coord-lbl" class="coord-summary">📍 500, 300</span><input type="hidden" id="at-x" value="500"><input type="hidden" id="at-y" value="300"></div>
      <div class="form-group"><label>Durée (s)</label><input type="number" id="at-dur" value="0.2" min="0" step="0.05"></div>
      <div class="form-group form-group-check"><label class="check-label"><input type="checkbox" id="at-rel"> Relatif</label></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest()">🎯 Point</button></div>
    </div>`;
  }
  if (type === 'mouse_click') {
    return `<div class="form-row">
      <div class="form-group"><label>Position</label><span id="at-coord-lbl" class="coord-summary">📍 ?, ?</span><input type="hidden" id="at-x" value=""><input type="hidden" id="at-y" value=""></div>
      <div class="form-group"><label>Bouton</label>
        <select id="at-btn"><option value="left">left</option><option value="right">right</option><option value="middle">middle</option></select>
      </div>
      <div class="form-group"><label>×</label><input type="number" id="at-count" value="1" min="1"></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest()">🎯 Point</button></div>
    </div>`;
  }
  if (type === 'mouse_double_click') {
    return `<div class="form-row">
      <div class="form-group"><label>Position</label><span id="at-coord-lbl" class="coord-summary">📍 ?, ?</span><input type="hidden" id="at-x" value=""><input type="hidden" id="at-y" value=""></div>
      <div class="form-group"><label>Bouton</label>
        <select id="at-btn"><option value="left">left</option><option value="right">right</option><option value="middle">middle</option></select>
      </div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest()">🎯 Point</button></div>
    </div>`;
  }
  if (type === 'type_text') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Texte</label><input type="text" id="at-text" placeholder="Texte à taper"></div>
      <div class="form-group"><label>Interval (s)</label><input type="number" id="at-interval" value="0.05" min="0.01" step="0.01"></div>
    </div>`;
  }
  if (type === 'scroll') {
    return `<div class="form-row">
      <div class="form-group"><label>Clics</label><input type="number" id="at-clicks" value="3" min="1"></div>
      <div class="form-group"><label>Direction</label>
        <select id="at-dir"><option value="up">up</option><option value="down">down</option></select>
      </div>
      <div class="form-group"><label>Position</label><span id="at-coord-lbl" class="coord-summary">📍 position actuelle</span><input type="hidden" id="at-x" value=""><input type="hidden" id="at-y" value=""></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest()">🎯 Position</button></div>
    </div>`;
  }
  if (type === 'mouse_drag') {
    return `<div class="form-row">
      <div class="form-group"><label>Départ</label><span class="coord-summary">📍 100, 100</span><input type="hidden" id="at-x1" value="100"><input type="hidden" id="at-y1" value="100"></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest('at-x1','at-y1')">🎯 Départ</button></div>
      <div class="form-group"><label>Arrivée</label><span class="coord-summary">📍 400, 300</span><input type="hidden" id="at-x2" value="400"><input type="hidden" id="at-y2" value="300"></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-xs btn-secondary pick-btn" onclick="pickPointForActTest('at-x2','at-y2')">🎯 Arrivée</button></div>
      <div class="form-group"><label>Durée (s)</label><input type="number" id="at-dur" value="0.5" min="0.05" step="0.05"></div>
    </div>`;
  }
  if (type === 'key_combo') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Combo (ex: ctrl+c, alt+tab)</label><input type="text" id="at-keys" value="ctrl+c" placeholder="ctrl+shift+s"></div>
      <div class="form-group"><label>Durée (s)</label><input type="number" id="at-dur" value="0.05" min="0.01" step="0.01"></div>
    </div>`;
  }
  if (type === 'random_wait') {
    return `<div class="form-row">
      <div class="form-group"><label>Min (s)</label><input type="number" id="at-min" value="0.5" min="0" step="0.1"></div>
      <div class="form-group"><label>Max (s)</label><input type="number" id="at-max" value="2.0" min="0.1" step="0.1"></div>
    </div>`;
  }
  if (type === 'send_webhook') {
    return `<div class="form-row">
      <div class="form-group flex-1"><label>Événement</label><input type="text" id="at-event" value="custom_event" placeholder="nom_event"></div>
      <div class="form-group flex-2"><label>Message (optionnel)</label><input type="text" id="at-message" placeholder="Message Discord…"></div>
    </div>`;
  }
  if (type === 'log_message') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Message</label><input type="text" id="at-message" placeholder="Message de log"></div>
      <div class="form-group"><label>Niveau</label>
        <select id="at-level"><option value="INFO">INFO</option><option value="DEBUG">DEBUG</option><option value="WARNING">WARNING</option></select>
      </div>
    </div>`;
  }
  if (type === 'notify_toast') {
    return `<div class="form-row">
      <div class="form-group flex-1"><label>Titre</label><input type="text" id="at-title" value="MacroEngine" placeholder="Titre"></div>
      <div class="form-group flex-2"><label>Message</label><input type="text" id="at-message" placeholder="Notification…"></div>
    </div>`;
  }
  if (type === 'play_sound') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Fichier .wav (vide = bip)</label><input type="text" id="at-file" placeholder="C:\\sons\\alerte.wav"></div>
    </div>`;
  }
  if (type === 'screenshot_save') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Chemin (supporte {timestamp})</label><input type="text" id="at-path" value="screenshots\\{timestamp}.png" placeholder="screenshots\\{timestamp}.png"></div>
    </div>`;
  }
  if (type === 'focus_window') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Titre de la fenêtre (partiel)</label><input type="text" id="at-title" placeholder="FiveM"></div>
    </div>`;
  }
  if (type === 'clipboard_set') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Texte</label><input type="text" id="at-text" placeholder="Texte dans le presse-papier"></div>
    </div>`;
  }
  if (type === 'set_variable') {
    return `<div class="form-row">
      <div class="form-group"><label>Nom</label><input type="text" id="at-name" placeholder="ma_variable"></div>
      <div class="form-group flex-2"><label>Valeur</label><input type="text" id="at-value" placeholder="42"></div>
    </div>`;
  }
  if (type === 'counter_set' || type === 'counter_inc' || type === 'counter_dec') {
    return `<div class="form-row">
      <div class="form-group"><label>Compteur</label><input type="text" id="at-name" placeholder="score"></div>
      ${type === 'counter_set' ? `<div class="form-group"><label>Valeur</label><input type="number" id="at-value" value="0"></div>` : ''}
      ${type !== 'counter_set' ? `<div class="form-group"><label>Montant</label><input type="number" id="at-amount" value="1" min="1"></div>` : ''}
    </div>`;
  }
  if (type === 'counter_reset') {
    return `<div class="form-row">
      <div class="form-group"><label>Compteur</label><input type="text" id="at-name" placeholder="score"></div>
    </div>`;
  }
  if (type === 'macro_start') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Nom de la macro</label><input type="text" id="at-name" placeholder="Mon Farm"></div>
    </div>`;
  }
  if (type === 'macro_stop') {
    return `<div class="form-row">
      <div class="form-group flex-2"><label>Nom de la macro (vide = toutes)</label><input type="text" id="at-name" placeholder="Mon Farm"></div>
    </div>`;
  }
  if (type === 'stop_self') {
    return `<div class="form-row"><span style="color:var(--text-2);font-size:12px">Arrête la macro courante immédiatement.</span></div>`;
  }
  if (type === 'repeat') {
    return `<div class="form-row">
      <div class="form-group"><label>Répétitions</label><input type="number" id="at-count" value="3" min="1"></div>
      <div class="form-group"><label>Délai entre (s)</label><input type="number" id="at-delay" value="0" min="0" step="0.1"></div>
    </div>
    <div class="form-row">
      <div class="form-group flex-2">
        <label>Sous-actions (JSON)</label>
        <textarea id="at-actions-json" style="width:100%;min-height:80px;font-family:monospace;font-size:12px;resize:vertical">[{"type":"key_tap","key":"e"},{"type":"wait","duration":0.3}]</textarea>
      </div>
    </div>`;
  }
  return '';
}

function getActTestObj() {
  const type = document.getElementById('act-type').value;
  const g  = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const gn = id => { const v = g(id); return (v !== null && v !== '') ? parseFloat(v) : null; };
  const gb = id => { const el = document.getElementById(id); return el ? el.checked : false; };
  const obj = { type };
  if (g('at-key'))       obj.key       = g('at-key');
  if (g('at-keys'))      obj.keys      = g('at-keys').split('+').map(k => k.trim()).filter(Boolean);
  if (gn('at-dur'))      obj.duration  = gn('at-dur');
  if (gn('at-count'))    obj.count     = gn('at-count');
  if (gb('at-direct'))   obj.use_direct = true;
  const ax = gn('at-x'); if (ax !== null) obj.x = ax;
  const ay = gn('at-y'); if (ay !== null) obj.y = ay;
  if (gb('at-rel'))      obj.relative  = true;
  if (g('at-btn'))       obj.button    = g('at-btn');
  if (g('at-text'))      obj.text      = g('at-text');
  if (gn('at-interval')) obj.interval  = gn('at-interval');
  if (gn('at-clicks'))   obj.clicks    = gn('at-clicks');
  if (g('at-dir'))       obj.direction = g('at-dir');
  const ax1 = gn('at-x1'); if (ax1 !== null) obj.x1 = ax1;
  const ay1 = gn('at-y1'); if (ay1 !== null) obj.y1 = ay1;
  const ax2 = gn('at-x2'); if (ax2 !== null) obj.x2 = ax2;
  const ay2 = gn('at-y2'); if (ay2 !== null) obj.y2 = ay2;
  if (gn('at-min'))      obj.min_s     = gn('at-min');
  if (gn('at-max'))      obj.max_s     = gn('at-max');
  // Webhook
  if (g('at-event'))     obj.event     = g('at-event');
  if (g('at-message') && g('at-message').trim()) obj.data = { message: g('at-message') };
  // Log / toast
  if (g('at-level'))     obj.level     = g('at-level');
  if (g('at-title'))     obj.title     = g('at-title');
  // Sound / screenshot
  if (g('at-file') && g('at-file').trim())  obj.file  = g('at-file');
  if (g('at-path') && g('at-path').trim())  obj.path  = g('at-path');
  // Variable / counter
  if (g('at-name') && g('at-name').trim())  obj.name  = g('at-name');
  if (g('at-value') !== null && g('at-value') !== '') obj.value = g('at-value');
  if (gn('at-amount') !== null) obj.amount = gn('at-amount');
  // Repeat
  if (gn('at-delay') !== null) obj.delay = gn('at-delay');
  const actJson = g('at-actions-json');
  if (actJson) { try { obj.actions = JSON.parse(actJson); } catch (_) {} }
  return obj;
}

async function testAction() {
  const resultEl = document.getElementById('act-result');
  resultEl.style.display = '';
  resultEl.className = 'test-result testing';
  resultEl.textContent = 'Exécution…';
  try {
    await ensureEngine();
    const action = getActTestObj();
    await window.api.execAction(action);
    resultEl.className = 'test-result result-ok';
    resultEl.textContent = '✅ Action exécutée';
  } catch (e) {
    resultEl.className = 'test-result result-fail';
    resultEl.textContent = 'Erreur: ' + e.message;
  }
}

/* ── Screen picker helper for Actions Tester ──────────── */
async function pickPointForActTest(xId, yId) {
  try {
    const res = await window.api.pickPoint();
    if (!res || res.cancelled) return;
    const xEl = document.getElementById(xId || 'at-x');
    const yEl = document.getElementById(yId || 'at-y');
    if (xEl) xEl.value = res.x;
    if (yEl) yEl.value = res.y;
    const lbl = document.getElementById('at-coord-lbl');
    if (lbl) lbl.textContent = `📍 ${res.x}, ${res.y}`;
  } catch (e) { appendLog('ERROR', 'Picker: ' + e.message); }
}
