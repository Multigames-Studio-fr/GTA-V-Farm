'use strict';
/* ═══════════════════════════════════════════════════════════════
   MACROS EDITOR — form, rules, conditions, actions inline
════════════════════════════════════════════════════════════════ */

/* ── Modal control ──────────────────────────────────────────── */
function openMacroModal(idx) {
  try {
    currentMacroIdx = idx;
    const modal = document.getElementById('macro-modal');
    if (!modal) { console.error('[openMacroModal] #macro-modal introuvable'); return; }
    const macro = macros[idx];
    if (!macro) { console.error('[openMacroModal] macro idx', idx, 'introuvable'); return; }

    // Show modal FIRST — before any rendering so a crash in render doesn't block opening
    const titleEl = document.getElementById('macro-modal-title-text');
    if (titleEl) titleEl.textContent = macro.name || 'Macro';
    modal.style.display = 'flex';
    if (modal.focus) modal.focus();
    document.removeEventListener('keydown', _modalEscHandler);
    document.addEventListener('keydown', _modalEscHandler);

    // Render content — wrapped so errors don't prevent modal from being visible
    try { renderMacroEditor(); } catch (e) { console.error('[openMacroModal] renderMacroEditor error:', e); }
    try { _initMacroUndo(); _updateUndoRedoButtons(); } catch (e) { console.error('[openMacroModal] undo init error:', e); }
  } catch (e) {
    console.error('[openMacroModal] critical error:', e);
  }
}

/* ── Undo / Redo (Ctrl+Z / Ctrl+Y) ────────────────────────────
   Snapshots the whole macro's JSON on the modal's capture phase, BEFORE
   the click/change/focusin that's about to mutate it — so by the time our
   listener runs, macros[currentMacroIdx] still holds the pre-mutation
   state. One history stack per modal session (reset every time a macro
   is opened). */
let _macroUndoStack = [];
let _macroRedoStack = [];
let _macroUndoReady = false;

function _initMacroUndo() {
  _macroUndoStack = macros[currentMacroIdx] ? [JSON.stringify(macros[currentMacroIdx])] : [];
  _macroRedoStack = [];
  if (_macroUndoReady) return;
  _macroUndoReady = true;
  const modal = document.getElementById('macro-modal');
  if (!modal) return;
  ['click', 'change', 'focusin'].forEach(evt => modal.addEventListener(evt, _captureMacroUndoSnapshot, true));
  document.addEventListener('keydown', (e) => {
    if (modal.style.display === 'none') return;
    const z = e.key === 'z' || e.key === 'Z';
    const y = e.key === 'y' || e.key === 'Y';
    if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) { e.preventDefault(); undoMacroEdit(); }
    else if ((e.ctrlKey || e.metaKey) && (y || (z && e.shiftKey))) { e.preventDefault(); redoMacroEdit(); }
  });
}

function _captureMacroUndoSnapshot() {
  if (currentMacroIdx < 0 || !macros[currentMacroIdx]) return;
  const snap = JSON.stringify(macros[currentMacroIdx]);
  if (_macroUndoStack.length && _macroUndoStack[_macroUndoStack.length - 1] === snap) return;
  _macroUndoStack.push(snap);
  if (_macroUndoStack.length > 50) _macroUndoStack.shift();
  _macroRedoStack = [];
  _updateUndoRedoButtons();
}

function undoMacroEdit() {
  if (currentMacroIdx < 0 || _macroUndoStack.length < 2) return;
  _macroRedoStack.push(_macroUndoStack.pop());
  macros[currentMacroIdx] = JSON.parse(_macroUndoStack[_macroUndoStack.length - 1]);
  try { renderMacroEditor(); } catch (e) { console.error('[undoMacroEdit] render error:', e); }
  _updateUndoRedoButtons();
  showToast?.('Annulé', 'info', 1000);
}

function redoMacroEdit() {
  if (currentMacroIdx < 0 || !_macroRedoStack.length) return;
  const snap = _macroRedoStack.pop();
  _macroUndoStack.push(snap);
  macros[currentMacroIdx] = JSON.parse(snap);
  try { renderMacroEditor(); } catch (e) { console.error('[redoMacroEdit] render error:', e); }
  _updateUndoRedoButtons();
  showToast?.('Rétabli', 'info', 1000);
}

function _updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-macro-undo');
  const redoBtn = document.getElementById('btn-macro-redo');
  if (undoBtn) undoBtn.disabled = _macroUndoStack.length < 2;
  if (redoBtn) redoBtn.disabled = _macroRedoStack.length === 0;
}

function closeMacroModal() {
  const modal = document.getElementById('macro-modal');
  if (!modal || modal.style.display === 'none') return;
  if (currentMacroIdx >= 0 && macros[currentMacroIdx]) {
    try { flushEditorToMacro(); } catch (e) { console.error('[closeMacroModal] flush error:', e); }
  }
  modal.style.display = 'none';
  _cancelKsCapture();
  document.removeEventListener('keydown', _modalEscHandler);
  try { renderMacroList(); } catch (e) { console.error('[closeMacroModal] renderMacroList error:', e); }
  try { renderDashboard(); } catch (e) {}
}

function _modalEscHandler(e) {
  if (e.key === 'Escape') closeMacroModal();
}

async function saveMacroFromModal() {
  if (currentMacroIdx >= 0 && macros[currentMacroIdx]) {
    try { flushEditorToMacro(); } catch (e) { console.error('[saveMacroFromModal] flush error:', e); }
  }
  const macro   = macros[currentMacroIdx];
  const titleEl = document.getElementById('macro-modal-title-text');
  if (titleEl && macro) titleEl.textContent = macro.name || 'Macro';
  try { renderMacroList(); } catch (e) {}
  await saveMacros();
}

/* ── N8N canvas ─────────────────────────────────────────────── */
let _selectedRuleIdx = -1;
let _selectedActIdx  = -1;

function filterRuleNodes() {
  const query = (document.getElementById('n8n-rule-search')?.value || '').toLowerCase().trim();
  const macro = macros[currentMacroIdx];
  if (!macro) return;
  (macro.rules || []).forEach((rule, ri) => {
    const node = document.getElementById('n8n-node-' + ri);
    if (!node) return;
    const match = !query || (rule.label || '').toLowerCase().includes(query);
    node.style.display = match ? '' : 'none';
    const connector = node.nextElementSibling;
    if (connector && connector.classList.contains('n8n-connector')) connector.style.display = match ? '' : 'none';
  });
}

/* Dispatch: macro-level or rule-level canvas */
function renderN8nCanvas() {
  const canvas = document.getElementById('n8n-canvas');
  const macro  = macros[currentMacroIdx];
  if (!canvas || !macro) return;
  const searchBar = document.getElementById('n8n-rule-search-bar');
  if (_selectedRuleIdx >= 0) {
    if (searchBar) searchBar.style.display = 'none';
    _renderRuleCanvas(canvas, macro.rules[_selectedRuleIdx] || {}, _selectedRuleIdx);
  } else {
    if (searchBar) searchBar.style.display = (macro.rules || []).length > 4 ? 'flex' : 'none';
    _renderMacroCanvas(canvas, macro);
    filterRuleNodes();
  }
}

/* Macro-level canvas: CONFIG node + RULE nodes */
function _renderMacroCanvas(canvas, macro) {
  const rules = macro.rules || [];
  let html = '';

  // START / CONFIG node
  html += `<div class="n8n-node n8n-start-node${_selectedRuleIdx === -1 ? ' n8n-selected' : ''}"
      onclick="n8nSelectMacroSettings()" title="Paramètres de la macro" id="n8n-node-config">
    <div class="n8n-node-header">
      <div class="n8n-node-icon n8n-icon-config">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
      </div>
      <div class="n8n-node-label">
        <div class="n8n-node-type">Configuration</div>
        <div class="n8n-node-name">${escHtml(macro.name || 'Sans nom')}</div>
      </div>
    </div>
    <div class="n8n-node-body">
      <div class="n8n-node-pills">
        <span class="n8n-node-pill">${macro.loop !== false ? '∞ boucle' : '1×'}</span>
        <span class="n8n-node-pill">${macro.loop_delay ?? 0.1}s</span>
        ${macro.humanize ? '<span class="n8n-node-pill">humanisé</span>' : ''}
      </div>
    </div>
  </div>`;

  html += _n8nConnectorHTML(0);

  rules.forEach((rule, ri) => {
    const condCount  = (rule.conditions || []).length;
    const actCount   = (rule.actions   || []).length;
    const isDisabled = rule.enabled === false;
    html += `<div class="n8n-node n8n-rule-node${isDisabled ? ' n8n-node-disabled' : ''}${_selectedRuleIdx === ri ? ' n8n-selected' : ''}"
        onclick="n8nSelectRule(${ri})" id="n8n-node-${ri}">
      <div class="n8n-node-header">
        <div class="n8n-node-icon${isDisabled ? ' n8n-icon-disabled' : ' n8n-icon-rule'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
        </div>
        <div class="n8n-node-label">
          <div class="n8n-node-type">Règle ${ri + 1}</div>
          <div class="n8n-node-name" id="n8n-node-name-${ri}">${escHtml(rule.label || 'Sans nom')}</div>
        </div>
      </div>
      <div class="n8n-node-body">
        <div class="n8n-node-pills">
          <span class="n8n-node-pill">${condCount} cond.</span>
          <span class="n8n-node-pill">${actCount} action${actCount !== 1 ? 's' : ''}</span>
          ${rule.stop_on_match ? '<span class="n8n-node-pill">stop on match</span>' : ''}
        </div>
        <div class="n8n-node-btns" onclick="event.stopPropagation()">
          <button class="icon-btn" title="Monter" onclick="moveRuleUp(${ri})" ${ri === 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="icon-btn" title="Descendre" onclick="moveRuleDown(${ri})" ${ri === rules.length - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="icon-btn" title="Dupliquer" onclick="duplicateRule(${ri})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
    </div>`;
    html += _n8nConnectorHTML(ri + 1);
  });

  canvas.innerHTML = html;
}

/* Rule-level canvas: RULE header node + ACTION nodes */
function _renderRuleCanvas(canvas, rule, ri) {
  const actions = rule.actions || [];
  let html = '';

  // Rule header node — click → rule overview panel
  html += `<div class="n8n-node n8n-rule-header-node${_selectedActIdx === -1 ? ' n8n-selected' : ''}"
      onclick="n8nSelectRuleOverview()" id="n8n-rulenode-hdr">
    <div class="n8n-node-header">
      <div class="n8n-node-icon n8n-icon-rule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      </div>
      <div class="n8n-node-label">
        <div class="n8n-node-type">Règle ${ri + 1}</div>
        <div class="n8n-node-name">${escHtml(rule.label || 'Sans nom')}</div>
      </div>
      <div class="n8n-node-btns" onclick="event.stopPropagation()">
        <button class="icon-btn" onclick="closeRulePanel()" title="Retour aux règles">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>
    </div>
    <div class="n8n-node-body">
      <div class="n8n-node-pills">
        <span class="n8n-node-pill">${(rule.conditions || []).length} cond.</span>
        <span class="n8n-node-pill">${rule.condition_mode === 'any' ? '≥1' : rule.condition_mode === 'none' ? 'toujours' : 'tout'}</span>
        ${rule.stop_on_match ? '<span class="n8n-node-pill">stop</span>' : ''}
        ${rule.enabled === false ? '<span class="n8n-node-pill" style="color:var(--text-3)">off</span>' : ''}
      </div>
    </div>
  </div>`;

  html += _n8nActConnectorHTML(0);

  actions.forEach((a, ai) => {
    const label   = ACT_LABELS[a.type] || a.type;
    const summary = _actionNodeSummary(a);
    const cat     = _actCategory(a.type);
    html += `<div class="n8n-node n8n-act-node n8n-act-cat-${cat}${_selectedActIdx === ai ? ' n8n-selected' : ''}"
        id="n8n-act-node-${ai}" onclick="n8nSelectAct(${ai})" draggable="true" data-ai="${ai}">
      <div class="n8n-node-header">
        <div class="n8n-act-drag-handle n8n-node-icon n8n-act-icon-${cat}" onclick="event.stopPropagation()" title="Glisser pour déplacer">
          ${_actIconSVG(a.type)}
        </div>
        <div class="n8n-node-label">
          <div class="n8n-node-type">${escHtml(label)}</div>
          ${summary ? `<div class="n8n-act-summary">${escHtml(summary)}</div>` : ''}
        </div>
        <div class="n8n-node-btns" onclick="event.stopPropagation()">
          <button class="icon-btn btn-danger-icon" onclick="deleteAction(${ri},${ai})" title="Supprimer action">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>`;
    html += _n8nActConnectorHTML(ai + 1);
  });

  if (actions.length === 0) {
    html += `<div class="n8n-canvas-empty-hint">Cliquez "+ Action" dans le panneau pour ajouter une action</div>`;
  }

  canvas.innerHTML = html;
  _initCanvasActDnD();
}

/* Brief text summary shown inside each action node */
function _actionNodeSummary(a) {
  const t = a.type || 'key_tap';
  const s = v => String(v ?? '');
  if (['key_tap', 'key_hold', 'key_release'].includes(t)) return s(a.key);
  if (t === 'key_combo')        return Array.isArray(a.keys) ? a.keys.join('+') : s(a.keys);
  if (t === 'type_text')        return `"${s(a.text).slice(0, 22)}"`;
  if (t === 'wait')             return `${a.duration ?? 0}s`;
  if (t === 'random_wait')      return `${a.min_s ?? 0}–${a.max_s ?? 0}s`;
  if (['mouse_move', 'mouse_click', 'mouse_double_click'].includes(t))
    return `📍 ${a.x ?? '?'}, ${a.y ?? '?'}`;
  if (t === 'mouse_drag')       return `📍 ${a.x1 ?? 0},${a.y1 ?? 0} → ${a.x2 ?? 0},${a.y2 ?? 0}`;
  if (t === 'scroll')           return `${a.clicks ?? 3}× ${a.direction || 'down'}`;
  if (t === 'set_variable')     return `${s(a.name)} = ${s(a.value)}`;
  if (['counter_inc','counter_dec','counter_set','counter_reset'].includes(t)) return s(a.name);
  if (['macro_start','macro_stop'].includes(t)) return s(a.name);
  if (t === 'send_webhook')     return s(a.event);
  if (t === 'log_message')      return s(a.message).slice(0, 22);
  return '';
}

/* Map action type → category key */
function _actCategory(type) {
  if (['key_tap','key_hold','key_release','key_combo','type_text'].includes(type)) return 'kbd';
  if (['mouse_move','mouse_click','mouse_double_click','mouse_drag','scroll'].includes(type)) return 'mouse';
  if (['wait','random_wait'].includes(type)) return 'wait';
  if (['macro_start','macro_stop','stop_self','repeat'].includes(type)) return 'ctrl';
  if (['set_variable','counter_set','counter_inc','counter_dec','counter_reset'].includes(type)) return 'var';
  if (['send_webhook','log_message','notify_toast','play_sound'].includes(type)) return 'notif';
  if (['auto_clicker'].includes(type)) return 'autoclk';
  return 'sys';
}

/* SVG icon for each action category */
function _actIconSVG(type) {
  const icons = {
    kbd:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M6 11h0M10 11h0M14 11h0M18 11h0M6 15h12"/></svg>`,
    mouse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><path d="M12 2a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0V8a6 6 0 0 1 6-6z"/><line x1="12" y1="2" x2="12" y2="9"/></svg>`,
    wait:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    ctrl:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    var:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    notif: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    sys:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>`,
    autoclk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><path d="M12 2a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0V8a6 6 0 0 1 6-6z"/><line x1="12" y1="2" x2="12" y2="9"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`,
  };
  return icons[_actCategory(type)] || icons.sys;
}

/* Map condition type → category key (mirrors _actCategory; shares the
   'kbd'/'var'/'sys' colors+icons with actions so the same concept reads as
   the same color on both sides of a rule) */
function _condCategory(type) {
  if (['pixel_color','pixel_color_not','pixel_changed','pixel_not_changed','region_color_avg',
       'text_contains','text_not_contains','text_regex','template_match','template_not_found'].includes(type)) return 'vis';
  if (['window_focused','window_not_focused','window_exists','window_not_exists',
       'process_running','process_not_running'].includes(type)) return 'win';
  if (['macro_is_running','macro_not_running'].includes(type)) return 'macro';
  if (['counter_eq','counter_not_eq','counter_gte','counter_lte','counter_gt','counter_lt','counter_between',
       'variable_equals','variable_contains'].includes(type)) return 'var';
  if (['time_between','random_chance'].includes(type)) return 'time';
  if (['key_is_held','key_not_held','clipboard_contains'].includes(type)) return 'kbd';
  return 'sys'; // always / never
}

/* SVG icon for each condition category */
function _condIconSVG(type) {
  const icons = {
    vis:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
    win:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>`,
    macro: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><path d="M19 11h-1V7a2 2 0 0 0-2-2h-4V4a2 2 0 0 0-4 0v1H4a2 2 0 0 0-2 2v4h1a2 2 0 0 1 0 4H2v4a2 2 0 0 0 2 2h4v-1a2 2 0 0 1 4 0v1h4a2 2 0 0 0 2-2v-4h1a2 2 0 0 0 0-4z"/></svg>`,
    var:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    time:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    kbd:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M6 11h0M10 11h0M14 11h0M18 11h0M6 15h12"/></svg>`,
    sys:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>`,
  };
  return icons[_condCategory(type)] || icons.sys;
}

/* Type <select> grouped by category (instead of one long flat list) —
   shared by every condition/action row builder below */
function _groupedTypeOptions(labels, categoryFn, groupLabels, current) {
  const cats = {};
  for (const [type, label] of Object.entries(labels)) {
    const cat = categoryFn(type);
    (cats[cat] = cats[cat] || []).push([type, label]);
  }
  return Object.entries(cats).map(([cat, entries]) => `
    <optgroup label="${escHtml(groupLabels[cat] || cat)}">
      ${entries.map(([type, label]) => `<option value="${type}" ${type === current ? 'selected' : ''}>${escHtml(label)}</option>`).join('')}
    </optgroup>`).join('');
}

const COND_GROUP_LABELS = {
  vis: 'Vision & OCR', win: 'Fenêtres & processus', macro: 'Macros',
  var: 'Variables & compteurs', time: 'Temporel & aléatoire',
  kbd: 'Clavier & presse-papier', sys: 'Constantes',
};
const ACT_GROUP_LABELS = {
  kbd: 'Clavier', mouse: 'Souris', wait: 'Temporisation', ctrl: 'Contrôle de macros',
  var: 'Variables & compteurs', notif: 'Notifications & logs', sys: 'Système', autoclk: 'Auto-clic',
};

/* Swaps a category-icon badge's color class + SVG after its <select> changes type.
   colorPrefix must match whichever color classes the badge was first rendered with
   ('item-cat-icon-' for conditions, 'n8n-act-icon-' for actions — the two class sets
   aren't identical, e.g. mouse/wait/ctrl/notif/autoclk only exist under n8n-act-icon-). */
function _refreshCatIcon(iconId, newType, categoryFn, iconFn, colorPrefix) {
  const el = document.getElementById(iconId);
  if (!el) return;
  el.className = 'item-cat-icon ' + (colorPrefix || 'item-cat-icon-') + categoryFn(newType);
  el.innerHTML = iconFn(newType);
}

/* Connector between action nodes (with insert button) */
function _n8nActConnectorHTML(insertIdx) {
  return `<div class="n8n-connector">
    <div class="n8n-conn-line"></div>
    <button class="n8n-add-btn" title="Insérer une action ici" onclick="addActionAt(${_selectedRuleIdx},${insertIdx})">+</button>
    <div class="n8n-conn-line"></div>
  </div>`;
}

/* Drag-and-drop for action nodes on the canvas */
let _dndActSrc = -1;
function _initCanvasActDnD() {
  const canvas = document.getElementById('n8n-canvas');
  if (!canvas || canvas._actDndReady) return;
  canvas._actDndReady = true;

  canvas.addEventListener('dragstart', e => {
    const node = e.target.closest('.n8n-act-node');
    if (!node) return;
    _dndActSrc = parseInt(node.dataset.ai);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => node.classList.add('dnd-dragging'), 0);
  });

  canvas.addEventListener('dragover', e => {
    if (_dndActSrc < 0) return;
    const node = e.target.closest('.n8n-act-node');
    canvas.querySelectorAll('.n8n-act-node').forEach(n => n.classList.remove('dnd-over-top', 'dnd-over-bot'));
    if (!node) return;
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    node.classList.add(e.clientY < rect.top + rect.height / 2 ? 'dnd-over-top' : 'dnd-over-bot');
  });

  canvas.addEventListener('dragleave', e => {
    if (!canvas.contains(e.relatedTarget)) {
      canvas.querySelectorAll('.n8n-act-node').forEach(n => n.classList.remove('dnd-over-top', 'dnd-over-bot'));
    }
  });

  canvas.addEventListener('drop', e => {
    e.preventDefault();
    const node = e.target.closest('.n8n-act-node');
    canvas.querySelectorAll('.n8n-act-node').forEach(n => n.classList.remove('dnd-over-top', 'dnd-over-bot', 'dnd-dragging'));
    if (!node || _dndActSrc < 0) { _dndActSrc = -1; return; }
    const dropAi = parseInt(node.dataset.ai);
    if (_dndActSrc === dropAi) { _dndActSrc = -1; return; }
    const acts = macros[currentMacroIdx]?.rules[_selectedRuleIdx]?.actions;
    if (!acts) { _dndActSrc = -1; return; }
    const rect   = node.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const [moved] = acts.splice(_dndActSrc, 1);
    let tgt = dropAi > _dndActSrc ? dropAi - 1 : dropAi;
    if (!before) tgt++;
    acts.splice(tgt, 0, moved);
    // Adjust selected index
    if      (_selectedActIdx === _dndActSrc)                              _selectedActIdx = tgt;
    else if (_selectedActIdx > _dndActSrc && _selectedActIdx <= tgt)      _selectedActIdx--;
    else if (_selectedActIdx < _dndActSrc && _selectedActIdx >= tgt)      _selectedActIdx++;
    _dndActSrc = -1;
    renderN8nCanvas();
    if (_selectedActIdx >= 0) renderN8nActPanel(_selectedRuleIdx, _selectedActIdx);
  });

  canvas.addEventListener('dragend', () => {
    canvas.querySelectorAll('.n8n-act-node').forEach(n => n.classList.remove('dnd-dragging', 'dnd-over-top', 'dnd-over-bot'));
    _dndActSrc = -1;
  });
}

function _n8nConnectorHTML(insertIdx) {
  return `<div class="n8n-connector">
    <div class="n8n-conn-line"></div>
    <button class="n8n-add-btn" title="Ajouter une règle ici" onclick="addRuleAt(${insertIdx})">+</button>
    <div class="n8n-conn-line"></div>
  </div>`;
}

function n8nSelectMacroSettings() {
  _selectedRuleIdx = -1;
  _selectedActIdx  = -1;
  const ruleProps  = document.getElementById('n8n-rule-props');
  const macroProps = document.getElementById('n8n-macro-props');
  if (ruleProps)  ruleProps.style.display = 'none';
  if (macroProps) macroProps.style.display = '';
  renderN8nCanvas();
}

function n8nSelectRule(ri) {
  _selectedRuleIdx = ri;
  _selectedActIdx  = -1;
  const ruleProps  = document.getElementById('n8n-rule-props');
  const macroProps = document.getElementById('n8n-macro-props');
  if (macroProps) macroProps.style.display = 'none';
  if (ruleProps)  ruleProps.style.display  = '';
  // Show rule overview, hide action editor
  const overview  = document.getElementById('n8n-rule-overview');
  const actEditor = document.getElementById('n8n-act-editor');
  if (overview)  overview.style.display  = '';
  if (actEditor) actEditor.style.display = 'none';
  // Back bar: "< Macro"
  const backLabel = document.getElementById('n8n-panel-back-label');
  if (backLabel) backLabel.textContent = 'Macro';
  const macro = macros[currentMacroIdx];
  const rule  = macro?.rules[ri];
  const titleEl = document.getElementById('n8n-rule-panel-title');
  if (titleEl) titleEl.textContent = rule?.label || `Règle ${ri + 1}`;
  renderN8nRulePanel(ri);
  renderN8nCanvas();
}

function closeRulePanel() {
  n8nSelectMacroSettings();
}

function deleteSelectedRule() {
  if (_selectedRuleIdx < 0) return;
  const ri = _selectedRuleIdx;
  closeRulePanel();
  deleteRule(ri);
}

/* ── N8N panel navigation ──────────────────────────────────── */

/** Back button in rule/action panel header — dispatches based on current view */
function _n8nBackBtn() {
  if (_selectedActIdx >= 0) {
    n8nSelectRuleOverview();
  } else {
    closeRulePanel();
  }
}

/** Delete button in rule/action panel header — dispatches based on current view */
function _n8nDelBtn() {
  if (_selectedActIdx >= 0) {
    deleteSelectedAct();
  } else {
    deleteSelectedRule();
  }
}

/** Show rule overview in the right panel (settings + conditions list) */
function n8nSelectRuleOverview() {
  _selectedActIdx = -1;
  const overview  = document.getElementById('n8n-rule-overview');
  const actEditor = document.getElementById('n8n-act-editor');
  if (overview)  overview.style.display  = '';
  if (actEditor) actEditor.style.display = 'none';
  const backLabel = document.getElementById('n8n-panel-back-label');
  if (backLabel) backLabel.textContent = 'Macro';
  if (_selectedRuleIdx >= 0) {
    const rule = macros[currentMacroIdx]?.rules[_selectedRuleIdx];
    const titleEl = document.getElementById('n8n-rule-panel-title');
    if (titleEl) titleEl.textContent = rule?.label || `Règle ${_selectedRuleIdx + 1}`;
    renderN8nRulePanel(_selectedRuleIdx);
  }
  renderN8nCanvas();
}

/** Select an action node — shows its editor in the right panel */
function n8nSelectAct(ai) {
  if (_selectedRuleIdx < 0) return;
  const rule = macros[currentMacroIdx]?.rules[_selectedRuleIdx];
  if (!rule || ai < 0 || ai >= (rule.actions || []).length) return;
  _selectedActIdx = ai;
  const overview  = document.getElementById('n8n-rule-overview');
  const actEditor = document.getElementById('n8n-act-editor');
  if (overview)  overview.style.display  = 'none';
  if (actEditor) actEditor.style.display = '';
  const backLabel = document.getElementById('n8n-panel-back-label');
  if (backLabel) backLabel.textContent = 'Règle';
  const titleEl = document.getElementById('n8n-rule-panel-title');
  const label   = ACT_LABELS[rule.actions[ai].type] || rule.actions[ai].type;
  if (titleEl) titleEl.textContent = label;
  renderN8nActPanel(_selectedRuleIdx, ai);
  renderN8nCanvas();
}

/** Delete the currently selected action and return to rule overview */
function deleteSelectedAct() {
  if (_selectedActIdx < 0 || _selectedRuleIdx < 0 || currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[_selectedRuleIdx].actions.splice(_selectedActIdx, 1);
  _selectedActIdx = -1;
  n8nSelectRuleOverview();
}

/** Insert a new key_tap action at position idx in rule ri, then select it */
function addActionAt(ri, idx) {
  if (currentMacroIdx < 0) return;
  const acts = macros[currentMacroIdx].rules[ri].actions;
  acts.splice(idx, 0, { type: 'key_tap', key: 'f', duration: 0.05, count: 1 });
  if (_selectedActIdx >= idx) _selectedActIdx++;
  if (ri === _selectedRuleIdx && document.getElementById('n8n-canvas')) {
    n8nSelectAct(idx);
    return;
  }
  renderRules();
}

/** Render rule settings + conditions list into #n8n-rule-overview */
function renderN8nRulePanel(ri) {
  const container = document.getElementById('n8n-rule-overview');
  if (!container) return;
  const rule = macros[currentMacroIdx]?.rules[ri];
  if (!rule) return;
  rule.conditions = rule.conditions || [];
  rule.actions    = rule.actions    || [];
  const condMode  = rule.condition_mode || 'all';

  container.innerHTML = `
    <div class="n8n-rule-settings">
      <div class="n8n-rule-field">
        <label>Nom</label>
        <input type="text" value="${escHtml(rule.label || '')}" placeholder="Nom de la règle"
          oninput="setRuleField(${ri},'label',this.value)">
      </div>
      <div class="n8n-rule-field">
        <label>Mode conditions</label>
        <select onchange="setRuleField(${ri},'condition_mode',this.value)">
          <option value="all"  ${condMode === 'all'  ? 'selected' : ''}>Toutes vraies</option>
          <option value="any"  ${condMode === 'any'  ? 'selected' : ''}>Au moins une</option>
          <option value="none" ${condMode === 'none' ? 'selected' : ''}>Aucune (toujours)</option>
        </select>
      </div>
      <div class="n8n-rule-toggle-row">
        <label><input type="checkbox" ${rule.stop_on_match ? 'checked' : ''}
          onchange="setRuleField(${ri},'stop_on_match',this.checked)"> Stop si match</label>
        <label><input type="checkbox" ${rule.enabled !== false ? 'checked' : ''}
          onchange="setRuleField(${ri},'enabled',this.checked)"> Règle active</label>
      </div>
    </div>
    <div class="n8n-panel-section-hdr" style="padding-top:10px">
      <span class="n8n-panel-section-title">CONDITIONS</span>
      <button class="btn btn-xs btn-secondary" onclick="addCondition(${ri})">+ Condition</button>
    </div>
    <div id="n8n-ro-conds" class="n8n-ro-conds">
      ${rule.conditions.length === 0
        ? '<div class="n8n-empty-hint">Pas de condition — règle toujours active</div>'
        : rule.conditions.map((c, ci) => renderConditionRowHTML(c, ri, ci, rule.conditions.length)).join('')
      }
    </div>
    <div class="n8n-panel-section-hdr" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">
      <span class="n8n-panel-section-title">ACTIONS</span>
      <button class="btn btn-xs btn-secondary" onclick="addAction(${ri})">+ Action</button>
    </div>
    <div class="n8n-empty-hint">
      ${rule.actions.length} action${rule.actions.length !== 1 ? 's' : ''} — cliquez un nœud pour éditer
    </div>
  `;
}

/** Render action type selector + inline fields into #n8n-act-editor */
function renderN8nActPanel(ri, ai) {
  const container = document.getElementById('n8n-act-editor');
  if (!container) return;
  const rule = macros[currentMacroIdx]?.rules[ri];
  if (!rule) return;
  const a     = rule.actions[ai];
  if (!a) return;
  const total = rule.actions.length;

  container.innerHTML = `
    <div class="n8n-act-nav-bar">
      <button class="icon-btn" onclick="n8nSelectAct(${ai - 1})" ${ai === 0 ? 'disabled' : ''} title="Action précédente">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
      <span class="n8n-act-nav-label">${ai + 1} / ${total}</span>
      <button class="icon-btn" onclick="n8nSelectAct(${ai + 1})" ${ai >= total - 1 ? 'disabled' : ''} title="Action suivante">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid var(--border)">
      <label style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:5px">Type d'action</label>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="item-cat-icon n8n-act-icon-${_actCategory(a.type)}" id="actpanel-icon" style="width:26px;height:26px;border-radius:6px">${_actIconSVG(a.type)}</div>
        <select style="flex:1;width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--text-1)" onchange="setActType(${ri},${ai},this.value);_refreshCatIcon('actpanel-icon',this.value,_actCategory,_actIconSVG,'n8n-act-icon-')">
          ${_groupedTypeOptions(ACT_LABELS, _actCategory, ACT_GROUP_LABELS, a.type)}
        </select>
      </div>
    </div>
    <div class="n8n-act-fields-section">
      <div class="item-row" id="arow-${ri}-${ai}">
        <div class="item-fields">${renderActionInlineFields(a)}</div>
      </div>
    </div>
    <div class="n8n-act-actions-bar">
      <button class="btn btn-xs btn-secondary" onclick="execActionInline(${ri},${ai})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Tester
      </button>
      <button class="btn btn-xs btn-secondary" onclick="addActionAt(${ri},${ai + 1})">
        + Insérer après
      </button>
    </div>
  `;
}

function addRuleAt(idx) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules.splice(idx, 0, {
    id: 'rule_' + Date.now(),
    label: 'Règle ' + (idx + 1),
    enabled: true, condition_mode: 'all', conditions: [], actions: [], stop_on_match: false,
  });
  if (_selectedRuleIdx >= idx) _selectedRuleIdx++;
  n8nSelectRule(idx);
}

function moveRuleUp(ri) {
  if (currentMacroIdx < 0 || ri <= 0) return;
  const rules = macros[currentMacroIdx].rules;
  [rules[ri - 1], rules[ri]] = [rules[ri], rules[ri - 1]];
  if (_selectedRuleIdx === ri) _selectedRuleIdx = ri - 1;
  else if (_selectedRuleIdx === ri - 1) _selectedRuleIdx = ri;
  renderRules();
}

function moveRuleDown(ri) {
  if (currentMacroIdx < 0) return;
  const rules = macros[currentMacroIdx].rules;
  if (ri >= rules.length - 1) return;
  [rules[ri], rules[ri + 1]] = [rules[ri + 1], rules[ri]];
  if (_selectedRuleIdx === ri) _selectedRuleIdx = ri + 1;
  else if (_selectedRuleIdx === ri + 1) _selectedRuleIdx = ri;
  renderRules();
}

const COND_LABELS = {
  // Vision
  pixel_color: '🎨 Pixel couleur', pixel_color_not: '🎨 Pixel couleur ≠',
  pixel_changed: '👁️ Pixel a changé', pixel_not_changed: '👁️ Pixel n\'a pas changé',
  region_color_avg: '🎨 Couleur moyenne zone',
  text_contains: '🔤 Texte contient', text_not_contains: '🔤 Texte ≠',
  text_regex: '🔤 Texte regex',
  template_match: '🖼️ Template match', template_not_found: '🖼️ Template absent',
  // Fenêtres & processus
  window_focused: '🪟 Fenêtre active', window_not_focused: '🪟 Fenêtre inactive',
  window_exists: '🪟 Fenêtre existe', window_not_exists: '🪟 Fenêtre absente',
  process_running: '⚙️ Processus actif', process_not_running: '⚙️ Processus inactif',
  // Macros
  macro_is_running: '🧩 Macro en cours', macro_not_running: '🧩 Macro arrêtée',
  // Variables & compteurs
  counter_eq: '🔢 Compteur =', counter_not_eq: '🔢 Compteur ≠',
  counter_gte: '🔢 Compteur ≥', counter_lte: '🔢 Compteur ≤',
  counter_gt: '🔢 Compteur >', counter_lt: '🔢 Compteur <',
  counter_between: '🔢 Compteur entre',
  variable_equals: '🏷️ Variable =', variable_contains: '🏷️ Variable contient',
  // Temporel & aléatoire
  time_between: '🕒 Heure entre', random_chance: '🎲 Chance aléatoire',
  // Entrées
  key_is_held: '⌨️ Touche enfoncée', key_not_held: '⌨️ Touche relâchée',
  clipboard_contains: '📋 Presse-papier contient',
  // Universel
  always: '♾️ Toujours vrai', never: '🚫 Toujours faux',
};

const ACT_LABELS = {
  // Clavier
  key_tap: '⌨️ Appui touche', key_hold: '⌨️ Maintien touche', key_release: '⌨️ Relâcher touche',
  key_combo: '⌨️ Combo touches', type_text: '📝 Taper du texte',
  // Souris
  mouse_move: '🖱️ Déplacer souris', mouse_click: '🖱️ Clic souris',
  mouse_double_click: '🖱️ Double-clic souris', mouse_drag: '🖱️ Drag souris', scroll: '🖱️ Scroll',
  // Temporisation
  wait: '⏱️ Attendre (fixe)', random_wait: '⏱️ Attendre (aléatoire)',
  // Contrôle macro
  macro_start: '▶️ Lancer macro', macro_stop: '⏹️ Arrêter macro', stop_self: '⏹️ Arrêter cette macro',
  // Variables & Compteurs
  set_variable: '🏷️ Définir variable', counter_set: '🔢 Définir compteur',
  counter_inc: '🔢 ++ Incrémenter', counter_dec: '🔢 -- Décrémenter', counter_reset: '🔢 Reset compteur',
  // Notifications
  send_webhook: '🪝 Envoyer webhook', log_message: '📜 Log message',
  notify_toast: '💬 Notification Windows', play_sound: '🔊 Jouer son',
  // Flux
  repeat: '🔁 Répéter bloc',
  // Système
  focus_window: '🪟 Focus fenêtre', screenshot_save: '📸 Sauvegarder screenshot',
  clipboard_set: '📋 Copier presse-papier',
  // Auto-clic
  auto_clicker: '🖱️ Auto Clicker',
};

/* ── Editor form ──────────────────────────────────────────── */
function _setEl(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el[prop] = val;
}

function renderMacroEditor() {
  const macro = macros[currentMacroIdx];
  if (!macro) return;

  _setEl('macro-editor-empty', 'style', { display: 'none' });
  const emptyEl = document.getElementById('macro-editor-empty');
  if (emptyEl) emptyEl.style.display = 'none';
  const formEl = document.getElementById('macro-editor-form');
  if (formEl) formEl.style.display = '';

  _setEl('me-name',           'value',   macro.name || '');
  _setEl('me-loop',           'checked', macro.loop !== false);
  _setEl('me-loop-delay',     'value',   macro.loop_delay != null ? macro.loop_delay : 0.1);
  _setEl('me-max-iter',       'value',   macro.max_iterations != null ? macro.max_iterations : 0);
  _setEl('me-timeout',        'value',   macro.timeout_s != null ? macro.timeout_s : 0);
  _setEl('me-humanize',       'checked', !!macro.humanize);
  _setEl('me-humanize-factor','value',   macro.humanize_factor != null ? macro.humanize_factor : 0.12);

  const ks = macro.kill_switch || {};
  _setEl('me-ks-enabled', 'checked', !!ks.enabled);
  _setEl('me-ks-key',     'value',   ks.key || '');
  const ksConfig = document.getElementById('kill-switch-config');
  if (ksConfig) ksConfig.style.display = ks.enabled ? '' : 'none';

  const scopeEl = document.getElementById('me-target-window');
  if (scopeEl) {
    scopeEl.innerHTML = '<option value="">Aucune (toutes les fenêtres)</option>';
    if (macro.target_hwnd) {
      scopeEl.innerHTML += `<option value="${macro.target_hwnd}" selected>hwnd: ${macro.target_hwnd}</option>`;
    }
    _populateWindowScopeDropdown(scopeEl, macro.target_hwnd);
  }

  _selectedRuleIdx = -1;
  const ruleProps  = document.getElementById('n8n-rule-props');
  const macroProps = document.getElementById('n8n-macro-props');
  if (ruleProps)  ruleProps.style.display  = 'none';
  if (macroProps) macroProps.style.display = '';
  const panelName = document.getElementById('n8n-panel-macro-name');
  if (panelName) panelName.textContent = macro.name || 'Paramètres';

  // Beta sandbox reuses the exact same n8n canvas editor as production —
  // the flat-accordion rule list that used to live here didn't land with
  // the user, so it was removed; the canvas is the shared base instead.
  try { renderN8nCanvas(); } catch (e) { console.error('[renderMacroEditor] canvas error:', e); }
  try { renderAdvancedSections(); } catch (e) { console.error('[renderMacroEditor] sections error:', e); }
  try { updateMacroRunButtons(); }  catch (e) {}
}

async function _populateWindowScopeDropdown(scopeEl, selectedHwnd) {
  try {
    await ensureEngine();
    const res = await window.api.listWindows();
    if (res.ok === false || !res.windows) {
      // Engine error — keep placeholder
      return;
    }
    const wins = res.windows;
    scopeEl.innerHTML = '<option value="">Aucune (toutes les fenêtres)</option>';
    let found = false;
    for (const w of wins) {
      const sel = (selectedHwnd != null && String(w.hwnd) === String(selectedHwnd)) ? 'selected' : '';
      if (sel) found = true;
      scopeEl.innerHTML += `<option value="${w.hwnd}" ${sel}>${escHtml(w.title)} (${escHtml(w.exe)})</option>`;
    }
    // If saved hwnd is not in the current list, keep it as option
    if (selectedHwnd && !found) {
      scopeEl.innerHTML += `<option value="${selectedHwnd}" selected>hwnd: ${selectedHwnd} (fermée?)</option>`;
    }
  } catch (e) {
    // Silently keep the placeholder options
  }
}

function macroFieldChanged() {
  if (currentMacroIdx < 0) return;
  const m = macros[currentMacroIdx];
  if (!m) return;
  try {
    m.name            = document.getElementById('me-name')?.value ?? m.name;
    m.loop            = !!document.getElementById('me-loop')?.checked;
    m.loop_delay      = parseFloat(document.getElementById('me-loop-delay')?.value) || 0.1;
    m.max_iterations  = parseInt(document.getElementById('me-max-iter')?.value, 10) || 0;
    m.timeout_s       = parseFloat(document.getElementById('me-timeout')?.value) || 0;
    m.humanize        = !!document.getElementById('me-humanize')?.checked;
    m.humanize_factor = parseFloat(document.getElementById('me-humanize-factor')?.value) || 0.12;
    const scopeEl = document.getElementById('me-target-window');
    if (scopeEl) m.target_hwnd = scopeEl.value || null;
    const ksEnabled = !!document.getElementById('me-ks-enabled')?.checked;
    const ksKey     = document.getElementById('me-ks-key')?.value?.trim() || '';
    m.kill_switch = { enabled: ksEnabled, key: ksKey };
    const items = document.querySelectorAll('.macro-list-item, .wf-card');
    if (items[currentMacroIdx]) {
      const nameEl = items[currentMacroIdx].querySelector('.macro-list-name, .wf-card-name');
      if (nameEl) nameEl.textContent = m.name || 'Sans nom';
    }
    const titleEl   = document.getElementById('macro-modal-title-text');
    if (titleEl)    titleEl.textContent = m.name || 'Sans nom';
    const panelName = document.getElementById('n8n-panel-macro-name');
    if (panelName)  panelName.textContent = m.name || 'Paramètres';
    const startName = document.querySelector('#n8n-node-config .n8n-node-name');
    if (startName)  startName.textContent = m.name || 'Sans nom';
  } catch (e) { console.error('[macroFieldChanged] error:', e); }
}

function flushEditorToMacro() {
  if (currentMacroIdx < 0) return;
  if (!macros[currentMacroIdx]) return;
  macroFieldChanged();
}

/* ── Rules ────────────────────────────────────────────────── */
function renderRules() {
  renderN8nCanvas();
  if (_selectedRuleIdx >= 0) {
    const rule = macros[currentMacroIdx]?.rules[_selectedRuleIdx];
    if (_selectedActIdx >= 0 && rule) {
      renderN8nActPanel(_selectedRuleIdx, _selectedActIdx);
    } else if (rule) {
      renderN8nRulePanel(_selectedRuleIdx);
      const titleEl = document.getElementById('n8n-rule-panel-title');
      if (titleEl) titleEl.textContent = rule.label || `Règle ${_selectedRuleIdx + 1}`;
    }
  }
}

function setRuleField(ri, field, value) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[ri][field] = value;
  // Live update canvas without full re-render
  if (field === 'label') {
    const nodeNameEl = document.getElementById(`n8n-node-name-${ri}`);
    if (nodeNameEl) nodeNameEl.textContent = value || `Règle ${ri + 1}`;
    if (ri === _selectedRuleIdx) {
      const titleEl = document.getElementById('n8n-rule-panel-title');
      if (titleEl) titleEl.textContent = value || `Règle ${ri + 1}`;
    }
  }
  if (field === 'enabled') renderN8nCanvas();
}

function deleteRule(ri) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules.splice(ri, 1);
  if (_selectedRuleIdx === ri) { _selectedRuleIdx = -1; n8nSelectMacroSettings(); return; }
  if (_selectedRuleIdx > ri)  { _selectedRuleIdx--; }
  renderRules();
}

function duplicateRule(ri) {
  if (currentMacroIdx < 0) return;
  const copy = JSON.parse(JSON.stringify(macros[currentMacroIdx].rules[ri]));
  copy.id    = 'rule_' + Date.now();
  copy.label = (copy.label || 'Règle') + ' (copie)';
  macros[currentMacroIdx].rules.splice(ri + 1, 0, copy);
  if (_selectedRuleIdx > ri) _selectedRuleIdx++;
  if (document.getElementById('n8n-canvas')) { n8nSelectRule(ri + 1); return; }
  renderRules();
}

function moveCondUp(ri, ci) {
  if (currentMacroIdx < 0 || ci <= 0) return;
  const conds = macros[currentMacroIdx].rules[ri].conditions;
  [conds[ci - 1], conds[ci]] = [conds[ci], conds[ci - 1]];
  renderRules();
}

function moveCondDown(ri, ci) {
  if (currentMacroIdx < 0) return;
  const conds = macros[currentMacroIdx].rules[ri].conditions;
  if (ci >= conds.length - 1) return;
  [conds[ci], conds[ci + 1]] = [conds[ci + 1], conds[ci]];
  renderRules();
}

/* ── Condition rows ───────────────────────────────────────── */
function renderConditionRowHTML(c, ri, ci, total) {
  const type = c.type || 'pixel_color';
  return `
  <div class="item-row" id="crow-${ri}-${ci}" draggable="true">
    <div class="item-row-head">
      <div class="item-drag-handle cond-drag-handle" title="Glisser pour réorganiser">
        <svg viewBox="0 0 16 16" fill="currentColor" width="9" height="9">
          <circle cx="4.5" cy="3.5" r="1.1"/><circle cx="11.5" cy="3.5" r="1.1"/>
          <circle cx="4.5" cy="8"   r="1.1"/><circle cx="11.5" cy="8"   r="1.1"/>
          <circle cx="4.5" cy="12.5" r="1.1"/><circle cx="11.5" cy="12.5" r="1.1"/>
        </svg>
      </div>
      <div class="item-cat-icon item-cat-icon-${_condCategory(type)}" id="cicon-${ri}-${ci}">${_condIconSVG(type)}</div>
      <select class="item-type-select" onchange="setCondType(${ri},${ci},this.value);_refreshCatIcon('cicon-${ri}-${ci}',this.value,_condCategory,_condIconSVG)">
        ${_groupedTypeOptions(COND_LABELS, _condCategory, COND_GROUP_LABELS, type)}
      </select>
      <div class="item-row-btns">
        <button class="icon-btn" title="Tester" onclick="testConditionInline(${ri},${ci})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </button>
        <button class="icon-btn" title="Monter" onclick="moveCondUp(${ri},${ci})" ${ci === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="icon-btn" title="Descendre" onclick="moveCondDown(${ri},${ci})" ${ci === (total||0) - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="icon-btn btn-danger-icon" onclick="deleteCondition(${ri},${ci})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="item-fields">${renderConditionInlineFields(c)}</div>
    <div class="inline-test-result" id="ctest-${ri}-${ci}" style="display:none"></div>
  </div>`;
}

function renderConditionInlineFields(c) {
  const t = c.type || 'pixel_color';
  if (t === 'always' || t === 'never') return '';

  const coordFields = `<div class="fields-row">
    <span class="coord-summary" title="X=${c.x || 0}, Y=${c.y || 0}">📍 ${c.x || 0}, ${c.y || 0}</span>
    <input type="hidden" class="cf x" value="${c.x || 0}">
    <input type="hidden" class="cf y" value="${c.y || 0}">
    <button class="pick-btn" title="Choisir un point à l'écran" onclick="pickPointForCondField(this)">🎯 Point</button>
  </div>`;
  const sizeFields = `<div class="fields-row">
    <span class="coord-summary" title="Zone: ${c.x || 0},${c.y || 0} ${c.w || 100}x${c.h || 50}">🔲 ${c.x || 0},${c.y || 0} — ${c.w || 100}×${c.h || 50}</span>
    <input type="hidden" class="cf x" value="${c.x || 0}">
    <input type="hidden" class="cf y" value="${c.y || 0}">
    <input type="hidden" class="cf w" value="${c.w || 100}">
    <input type="hidden" class="cf h" value="${c.h || 50}">
    <button class="pick-btn" title="Sélectionner une zone à l'écran" onclick="pickRegionForCondField(this)">🔲 Zone</button>
    <button class="pick-btn" title="Choisir un point à l'écran" onclick="pickPointForCondField(this)">🎯 Point</button>
  </div>`;

  if (t === 'pixel_color' || t === 'pixel_color_not') {
    return coordFields + `<div class="fields-row">
      <span>Couleur</span>
      <input type="color" class="cf color" value="${rgbToHex(c.color) || '#ff0000'}" onchange="syncCondField(this,'color',false,'color')">
      <span>Tol.</span><input type="number" class="cf tol" value="${c.tolerance || 10}" min="0" max="255" onchange="syncCondField(this,'tolerance',true)">
    </div>`;
  }
  if (t === 'region_color_avg') {
    return sizeFields + `<div class="fields-row">
      <span>Couleur</span>
      <input type="color" class="cf color" value="${rgbToHex(c.color) || '#ff0000'}" onchange="syncCondField(this,'color',false,'color')">
      <span>Tol.</span><input type="number" class="cf tol" value="${c.tolerance || 20}" min="0" max="255" onchange="syncCondField(this,'tolerance',true)">
    </div>`;
  }
  if (t === 'text_contains' || t === 'text_not_contains') {
    return sizeFields + `<div class="fields-row">
      <span>Texte</span><input type="text" class="cf text" value="${escHtml(c.text || '')}" placeholder="texte attendu" onchange="syncCondField(this,'text',false)">
    </div>`;
  }
  if (t === 'text_regex') {
    return sizeFields + `<div class="fields-row">
      <span>Regex</span><input type="text" class="cf pattern" value="${escHtml(c.pattern || '')}" placeholder="expression régulière" onchange="syncCondField(this,'pattern',false)">
    </div>`;
  }
  if (t === 'template_match' || t === 'template_not_found') {
    return sizeFields + `<div class="fields-row">
      <span>Fichier</span><input type="text" class="cf template_path" value="${escHtml(c.template_path || '')}" placeholder="chemin/vers/image.png" onchange="syncCondField(this,'template_path',false)">
      <span>Seuil</span><input type="number" class="cf threshold" value="${c.threshold || 0.8}" min="0" max="1" step="0.05" onchange="syncCondField(this,'threshold',true)">
    </div>`;
  }
  if (t === 'pixel_changed' || t === 'pixel_not_changed') {
    return coordFields + `<div class="fields-row">
      <span>Tol.</span><input type="number" class="cf tolerance" value="${c.tolerance != null ? c.tolerance : 10}" min="0" max="255" onchange="syncCondField(this,'tolerance',true)">
    </div>`;
  }
  if (t === 'window_focused' || t === 'window_not_focused' ||
      t === 'window_exists'  || t === 'window_not_exists') {
    return `<div class="fields-row">
      <span>Titre fenêtre</span>
      <input type="text" class="cf title" style="flex:1" value="${escHtml(c.title || '')}" placeholder="FiveM" onchange="syncCondField(this,'title',false)">
    </div>`;
  }
  if (t === 'process_running' || t === 'process_not_running') {
    return `<div class="fields-row">
      <span>Processus (.exe)</span>
      <input type="text" class="cf exe" style="flex:1" value="${escHtml(c.exe || '')}" placeholder="GTA5.exe" onchange="syncCondField(this,'exe',false)">
    </div>`;
  }
  if (t === 'macro_is_running' || t === 'macro_not_running') {
    return `<div class="fields-row">
      <span>Nom macro</span>
      <input type="text" class="cf name" style="flex:1" value="${escHtml(c.name || '')}" placeholder="Nom de la macro" onchange="syncCondField(this,'name',false)">
    </div>`;
  }
  if (t === 'counter_eq' || t === 'counter_not_eq' || t === 'counter_gte' ||
      t === 'counter_lte' || t === 'counter_gt'    || t === 'counter_lt') {
    return `<div class="fields-row">
      <span>Compteur</span>
      <input type="text" class="cf name" style="width:120px" value="${escHtml(c.name || '')}" placeholder="score" onchange="syncCondField(this,'name',false)">
      <span>Valeur</span>
      <input type="number" class="cf value" value="${c.value != null ? c.value : 0}" onchange="syncCondField(this,'value',true)">
    </div>`;
  }
  if (t === 'counter_between') {
    return `<div class="fields-row">
      <span>Compteur</span>
      <input type="text" class="cf name" style="width:100px" value="${escHtml(c.name || '')}" placeholder="score" onchange="syncCondField(this,'name',false)">
      <span>Min</span>
      <input type="number" class="cf min" value="${c.min != null ? c.min : 0}" onchange="syncCondField(this,'min',true)">
      <span>Max</span>
      <input type="number" class="cf max" value="${c.max != null ? c.max : 10}" onchange="syncCondField(this,'max',true)">
    </div>`;
  }
  if (t === 'variable_equals' || t === 'variable_contains') {
    return `<div class="fields-row">
      <span>Variable</span>
      <input type="text" class="cf name" style="width:120px" value="${escHtml(c.name || '')}" placeholder="ma_var" onchange="syncCondField(this,'name',false)">
      <span>Valeur</span>
      <input type="text" class="cf value" style="flex:1" value="${escHtml(String(c.value != null ? c.value : ''))}" onchange="syncCondField(this,'value',false)">
    </div>`;
  }
  if (t === 'time_between') {
    return `<div class="fields-row">
      <span>De</span>
      <input type="time" class="cf start" value="${c.start || '08:00'}" onchange="syncCondField(this,'start',false)">
      <span>À</span>
      <input type="time" class="cf end" value="${c.end || '22:00'}" onchange="syncCondField(this,'end',false)">
    </div>`;
  }
  if (t === 'random_chance') {
    const _pct = Math.round((c.probability != null ? c.probability : 0.5) * 100);
    return `<div class="fields-row">
      <span>Probabilité</span>
      <input type="number" class="cf probability" value="${_pct}" min="0" max="100" step="1" onchange="syncCondProbability(this)">
      <span>%</span>
    </div>`;
  }
  if (t === 'key_is_held' || t === 'key_not_held') {
    return `<div class="fields-row">
      <span>Touche</span>
      <input type="text" class="cf key key-capture" value="${escHtml(c.key || 'f')}" placeholder="Cliquez puis appuyez" readonly onfocus="startKeyCaptureCond(this,'key')" data-field="key">
    </div>`;
  }
  if (t === 'clipboard_contains') {
    return `<div class="fields-row">
      <span>Texte</span>
      <input type="text" class="cf text" style="flex:1" value="${escHtml(c.text || '')}" placeholder="texte recherché" onchange="syncCondField(this,'text',false)">
    </div>`;
  }
  return '';
}

function syncCondField(inputEl, field, isNum, inputType) {
  const row = inputEl.closest('.item-row');
  if (!row) return;
  let c;
  const section = row.dataset.section;
  if (section) {
    const idx = parseInt(row.dataset.idx);
    c = macros[currentMacroIdx]?.[section]?.[idx];
  } else {
    const [, ri, ci] = row.id.split('-').map(Number);
    c = macros[currentMacroIdx]?.rules[ri]?.conditions[ci];
  }
  if (!c) return;
  if (inputType === 'color') c[field] = hexToRgb(inputEl.value);
  else if (isNum) c[field] = parseFloat(inputEl.value);
  else c[field] = inputEl.value;
}

function syncCondProbability(inputEl) {
  const row = inputEl.closest('.item-row');
  if (!row) return;
  let c;
  const section = row.dataset.section;
  if (section) {
    const idx = parseInt(row.dataset.idx);
    c = macros[currentMacroIdx]?.[section]?.[idx];
  } else {
    const [, ri, ci] = row.id.split('-').map(Number);
    c = macros[currentMacroIdx]?.rules[ri]?.conditions[ci];
  }
  if (!c) return;
  c.probability = Math.max(0, Math.min(100, parseFloat(inputEl.value) || 0)) / 100;
}

function startKeyCaptureCond(input, field) {
  input.value = '⌨ Appuyez…';
  input.classList.add('capturing');
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    // key_pressed conditions use GetAsyncKeyState(VK) → VK-style name
    input.value = keyVkNameFromEvent(e);
    input.classList.remove('capturing');
    input.removeEventListener('keydown', handler);
    input.removeEventListener('blur', blurHandler);
    input.blur();
    syncCondField(input, field, false);
  };
  const blurHandler = () => {
    if (input.classList.contains('capturing')) {
      input.value = '';
      input.classList.remove('capturing');
      input.removeEventListener('keydown', handler);
    }
  };
  input.addEventListener('keydown', handler);
  input.addEventListener('blur', blurHandler, { once: true });
}

// Default fields injected when switching to a condition type that needs them
const COND_DEFAULTS = {
  pixel_color:      { x: 0, y: 0, color: [255, 0, 0], tolerance: 10 },
  pixel_color_not:  { x: 0, y: 0, color: [255, 0, 0], tolerance: 10 },
  pixel_changed:    { x: 0, y: 0, tolerance: 10 },
  region_color_avg: { x: 0, y: 0, w: 200, h: 100, color: [255, 0, 0], tolerance: 20 },
  text_contains:    { x: 0, y: 0, w: 300, h: 60, text: '' },
  text_not_contains:{ x: 0, y: 0, w: 300, h: 60, text: '' },
  text_regex:       { x: 0, y: 0, w: 300, h: 60, pattern: '' },
  template_match:   { x: 0, y: 0, w: 400, h: 300, template_path: '', threshold: 0.85 },
  template_not_found:{ x: 0, y: 0, w: 400, h: 300, template_path: '', threshold: 0.85 },
  window_focused:   { title: '' },
  window_not_focused:{ title: '' },
  window_exists:    { title: '' },
  window_not_exists:{ title: '' },
  process_running:  { exe: '' },
  process_not_running:{ exe: '' },
  macro_is_running: { name: '' },
  macro_not_running:{ name: '' },
  counter_eq:       { name: '', value: 0 },
  counter_not_eq:   { name: '', value: 0 },
  counter_gte:      { name: '', value: 0 },
  counter_lte:      { name: '', value: 0 },
  counter_gt:       { name: '', value: 0 },
  counter_lt:       { name: '', value: 0 },
  counter_between:  { name: '', min: 0, max: 10 },
  variable_equals:  { name: '', value: '' },
  variable_contains:{ name: '', value: '' },
  time_between:     { start: '08:00', end: '22:00' },
  random_chance:    { probability: 0.5 },
  key_is_held:      { key: 'f' },
  key_not_held:     { key: 'f' },
  clipboard_contains:{ text: '' },
  pixel_changed:    { x: 0, y: 0, tolerance: 10 },
  pixel_not_changed: { x: 0, y: 0, tolerance: 10 },
};

function setCondType(ri, ci, type) {
  if (currentMacroIdx < 0) return;
  const c = macros[currentMacroIdx].rules[ri].conditions[ci];
  c.type = type;
  // Inject missing defaults for the new type
  const defaults = COND_DEFAULTS[type] || {};
  for (const [k, v] of Object.entries(defaults)) {
    if (c[k] === undefined || c[k] === null) c[k] = v;
  }
  const fieldsEl = document.querySelector(`#crow-${ri}-${ci} .item-fields`);
  if (fieldsEl) fieldsEl.innerHTML = renderConditionInlineFields(c);
}

function addCondition(ri) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[ri].conditions.push({ type: 'pixel_color', x: 0, y: 0, color: [255, 0, 0], tolerance: 10 });
  renderRules();
}

function deleteCondition(ri, ci) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[ri].conditions.splice(ci, 1);
  renderRules();
}

async function testConditionInline(ri, ci) {
  if (currentMacroIdx < 0) return;
  const cond = macros[currentMacroIdx].rules[ri].conditions[ci];
  const resultEl = document.getElementById(`ctest-${ri}-${ci}`);
  if (!resultEl) return;
  resultEl.style.display = '';
  resultEl.className = 'inline-test-result testing';
  resultEl.textContent = 'Test en cours…';
  try {
    await ensureEngine();
    const res = await window.api.testCondition(cond);
    const ok = res.result === true;
    resultEl.className = 'inline-test-result ' + (ok ? 'test-ok' : 'test-fail');
    resultEl.textContent = ok ? '✅ Condition vraie' : '❌ Condition fausse';
  } catch (e) {
    resultEl.className = 'inline-test-result test-fail';
    resultEl.textContent = 'Erreur: ' + e.message;
  }
}

function renderActionInlineFields(a) {
  const t = a.type || 'key_tap';
  const _chk = (field, label) => `<label style="display:flex;align-items:center;gap:3px;font-size:11px">${label}<input type="checkbox" class="af ${field}" ${a[field] ? 'checked' : ''} onchange="syncActField(this,'${field}',false,'check')"></label>`;
  const _keyCapture = (field, val) => `<input type="text" class="af ${field} key-capture" value="${escHtml(val || '')}" placeholder="Cliquez puis appuyez" readonly onfocus="startKeyCapture(this)" data-field="${field}">`;
  const _coordSummary = (x, y) => `<span class="coord-summary" title="X=${x}, Y=${y}">📍 ${x}, ${y}</span><input type="hidden" class="af x" value="${x}"><input type="hidden" class="af y" value="${y}">`;

  if (t === 'key_tap') {
    return `<div class="fields-row">
      <span>Touche</span>${_keyCapture('key', a.key || 'f')}
      <span>Durée</span><input type="number" class="af dur" value="${a.duration || 0.05}" min="0.01" step="0.01" onchange="syncActField(this,'duration',true)">
      <span>×</span><input type="number" class="af cnt" value="${a.count || 1}" min="1" onchange="syncActField(this,'count',true)">
      ${_chk('use_direct', 'Direct')}
    </div>`;
  }
  if (t === 'key_hold') {
    return `<div class="fields-row">
      <span>Touche</span>${_keyCapture('key', a.key || 'w')}
      <span>Durée (s)</span><input type="number" class="af dur" value="${a.duration || 1}" min="0.01" step="0.1" onchange="syncActField(this,'duration',true)">
      ${_chk('use_direct', 'Direct')}
    </div>`;
  }
  if (t === 'key_release') {
    return `<div class="fields-row"><span>Touche</span>${_keyCapture('key', a.key || 'w')}</div>`;
  }
  if (t === 'type_text') {
    return `<div class="fields-row">
      <span>Texte</span><input type="text" class="af text" style="flex:2" value="${escHtml(a.text || '')}" placeholder="Texte à taper" onchange="syncActField(this,'text')">
      <span>Interval</span><input type="number" class="af interval" value="${a.interval || 0.05}" min="0.01" step="0.01" onchange="syncActField(this,'interval',true)">
    </div>`;
  }
  if (t === 'wait') {
    return `<div class="fields-row"><span>Durée (s)</span><input type="number" class="af dur" value="${a.duration || 1}" min="0.01" step="0.1" onchange="syncActField(this,'duration',true)"></div>`;
  }
  if (t === 'mouse_move') {
    return `<div class="fields-row">
      ${_coordSummary(a.x || 0, a.y || 0)}
      <button class="pick-btn" title="Choisir un point à l'écran" onclick="pickPointForActField(this)">🎯 Point</button>
      <span>Durée</span><input type="number" class="af dur" value="${a.duration || 0.2}" min="0" step="0.05" onchange="syncActField(this,'duration',true)">
      ${_chk('relative', 'Relat.')}
    </div>`;
  }
  if (t === 'mouse_click') {
    return `<div class="fields-row">
      <span class="coord-summary" title="X=${a.x != null ? a.x : 'actuel'}, Y=${a.y != null ? a.y : 'actuel'}">📍 ${a.x != null ? a.x : '?'}, ${a.y != null ? a.y : '?'}</span>
      <input type="hidden" class="af x" value="${a.x != null ? a.x : ''}">
      <input type="hidden" class="af y" value="${a.y != null ? a.y : ''}">
      <button class="pick-btn" title="Choisir un point à l'écran" onclick="pickPointForActField(this)">🎯 Point</button>
      <span>Btn</span><select class="af btn" onchange="syncActField(this,'button')">
        <option value="left" ${(a.button || 'left') === 'left' ? 'selected' : ''}>left</option>
        <option value="right" ${a.button === 'right' ? 'selected' : ''}>right</option>
        <option value="middle" ${a.button === 'middle' ? 'selected' : ''}>middle</option>
      </select>
      <span>×</span><input type="number" class="af cnt" value="${a.count || 1}" min="1" onchange="syncActField(this,'count',true)">
    </div>`;
  }
  if (t === 'mouse_double_click') {
    return `<div class="fields-row">
      <span class="coord-summary" title="X=${a.x != null ? a.x : 'actuel'}, Y=${a.y != null ? a.y : 'actuel'}">📍 ${a.x != null ? a.x : '?'}, ${a.y != null ? a.y : '?'}</span>
      <input type="hidden" class="af x" value="${a.x != null ? a.x : ''}">
      <input type="hidden" class="af y" value="${a.y != null ? a.y : ''}">
      <button class="pick-btn" title="Choisir un point à l'écran" onclick="pickPointForActField(this)">🎯 Point</button>
      <span>Btn</span><select class="af btn" onchange="syncActField(this,'button')">
        <option value="left" ${(a.button || 'left') === 'left' ? 'selected' : ''}>left</option>
        <option value="right" ${a.button === 'right' ? 'selected' : ''}>right</option>
        <option value="middle" ${a.button === 'middle' ? 'selected' : ''}>middle</option>
      </select>
    </div>`;
  }
  if (t === 'mouse_drag') {
    return `<div class="fields-row">
      <span class="coord-summary">📍 Départ: ${a.x1 || 0},${a.y1 || 0}</span>
      <input type="hidden" class="af x1" value="${a.x1 || 0}">
      <input type="hidden" class="af y1" value="${a.y1 || 0}">
      <button class="pick-btn" title="Choisir le point de départ" onclick="pickPointForActField(this,'x1','y1')">🎯 Départ</button>
      <span class="coord-summary">📍 Arrivée: ${a.x2 || 100},${a.y2 || 100}</span>
      <input type="hidden" class="af x2" value="${a.x2 || 100}">
      <input type="hidden" class="af y2" value="${a.y2 || 100}">
      <button class="pick-btn" title="Choisir le point d'arrivée" onclick="pickPointForActField(this,'x2','y2')">🎯 Arrivée</button>
      <span>Durée</span><input type="number" class="af dur" value="${a.duration || 0.5}" min="0.05" step="0.05" onchange="syncActField(this,'duration',true)">
    </div>`;
  }
  if (t === 'scroll') {
    return `<div class="fields-row">
      <span>Clics</span><input type="number" class="af clicks" value="${a.clicks || 3}" min="1" onchange="syncActField(this,'clicks',true)">
      <span>Dir.</span><select class="af direction" onchange="syncActField(this,'direction')">
        <option value="up" ${(a.direction || 'up') === 'up' ? 'selected' : ''}>up</option>
        <option value="down" ${a.direction === 'down' ? 'selected' : ''}>down</option>
      </select>
      <span class="coord-summary">📍 ${a.x != null ? a.x + ',' + a.y : 'position actuelle'}</span>
      <input type="hidden" class="af x" value="${a.x != null ? a.x : ''}">
      <input type="hidden" class="af y" value="${a.y != null ? a.y : ''}">
      <button class="pick-btn" title="Position du scroll" onclick="pickPointForActField(this)">🎯 Position</button>
    </div>`;
  }
  if (t === 'key_combo') {
    return `<div class="fields-row">
      <span>Combo</span><input type="text" class="af keys" style="width:160px" value="${escHtml(Array.isArray(a.keys) ? a.keys.join('+') : (a.keys || 'ctrl+c'))}" placeholder="ctrl+shift+s" onchange="syncActComboKeys(this)">
      <span>Durée(s)</span><input type="number" class="af dur" value="${a.duration || 0.05}" min="0.01" step="0.01" onchange="syncActField(this,'duration',true)">
    </div>`;
  }
  if (t === 'random_wait') {
    return `<div class="fields-row">
      <span>Min(s)</span><input type="number" class="af min_s" value="${a.min_s || 0.5}" min="0" step="0.1" onchange="syncActField(this,'min_s',true)">
      <span>Max(s)</span><input type="number" class="af max_s" value="${a.max_s || 2.0}" min="0.1" step="0.1" onchange="syncActField(this,'max_s',true)">
    </div>`;
  }
  if (t === 'send_webhook') {
    return `<div class="fields-row">
      <span>Événement</span><input type="text" class="af event" style="width:130px" value="${escHtml(a.event || 'custom_event')}" onchange="syncActField(this,'event')">
      <span>Message</span><input type="text" class="af message" style="flex:1" value="${escHtml((a.data && a.data.message) || '')}" placeholder="Message Discord…" onchange="syncActWebhookMsg(this)">
    </div>`;
  }
  if (t === 'log_message') {
    return `<div class="fields-row">
      <span>Msg</span><input type="text" class="af message" style="flex:1" value="${escHtml(a.message || '')}" placeholder="Message de log" onchange="syncActField(this,'message')">
      <select class="af level" onchange="syncActField(this,'level')">
        <option value="INFO" ${(a.level || 'INFO') === 'INFO' ? 'selected' : ''}>INFO</option>
        <option value="DEBUG" ${a.level === 'DEBUG' ? 'selected' : ''}>DEBUG</option>
        <option value="WARNING" ${a.level === 'WARNING' ? 'selected' : ''}>WARNING</option>
      </select>
    </div>`;
  }
  if (t === 'notify_toast') {
    return `<div class="fields-row">
      <span>Titre</span><input type="text" class="af title" style="width:120px" value="${escHtml(a.title || 'MacroEngine')}" onchange="syncActField(this,'title')">
      <span>Msg</span><input type="text" class="af message" style="flex:1" value="${escHtml(a.message || '')}" placeholder="Notification…" onchange="syncActField(this,'message')">
    </div>`;
  }
  if (t === 'play_sound') {
    return `<div class="fields-row">
      <span>Fichier .wav</span><input type="text" class="af file" style="flex:1" value="${escHtml(a.file || '')}" placeholder="(vide = bip)" onchange="syncActField(this,'file')">
    </div>`;
  }
  if (t === 'screenshot_save') {
    return `<div class="fields-row">
      <span>Chemin</span><input type="text" class="af path" style="flex:1" value="${escHtml(a.path || 'screenshots\\{timestamp}.png')}" onchange="syncActField(this,'path')">
    </div>`;
  }
  if (t === 'focus_window') {
    return `<div class="fields-row">
      <span>Titre fenêtre</span><input type="text" class="af title" style="flex:1" value="${escHtml(a.title || '')}" placeholder="FiveM" onchange="syncActField(this,'title')">
    </div>`;
  }
  if (t === 'clipboard_set') {
    return `<div class="fields-row">
      <span>Texte</span><input type="text" class="af text" style="flex:1" value="${escHtml(a.text || '')}" placeholder="Texte…" onchange="syncActField(this,'text')">
    </div>`;
  }
  if (t === 'set_variable') {
    return `<div class="fields-row">
      <span>Nom</span><input type="text" class="af name" style="width:120px" value="${escHtml(a.name || '')}" placeholder="ma_var" onchange="syncActField(this,'name')">
      <span>Valeur</span><input type="text" class="af value" style="flex:1" value="${escHtml(String(a.value != null ? a.value : ''))}" onchange="syncActField(this,'value')">
    </div>`;
  }
  if (t === 'counter_set') {
    return `<div class="fields-row">
      <span>Compteur</span><input type="text" class="af name" style="width:120px" value="${escHtml(a.name || '')}" placeholder="score" onchange="syncActField(this,'name')">
      <span>Valeur</span><input type="number" class="af value" value="${a.value || 0}" onchange="syncActField(this,'value',true)">
    </div>`;
  }
  if (t === 'counter_inc' || t === 'counter_dec') {
    return `<div class="fields-row">
      <span>Compteur</span><input type="text" class="af name" style="width:120px" value="${escHtml(a.name || '')}" placeholder="score" onchange="syncActField(this,'name')">
      <span>Montant</span><input type="number" class="af amount" value="${a.amount || 1}" min="1" onchange="syncActField(this,'amount',true)">
    </div>`;
  }
  if (t === 'counter_reset') {
    return `<div class="fields-row">
      <span>Compteur</span><input type="text" class="af name" style="width:160px" value="${escHtml(a.name || '')}" placeholder="score" onchange="syncActField(this,'name')">
    </div>`;
  }
  if (t === 'macro_start') {
    return `<div class="fields-row">
      <span>Macro</span><input type="text" class="af name" style="flex:1" value="${escHtml(a.name || '')}" placeholder="Nom de la macro" onchange="syncActField(this,'name')">
    </div>`;
  }
  if (t === 'macro_stop') {
    return `<div class="fields-row">
      <span>Macro</span><input type="text" class="af name" style="flex:1" value="${escHtml(a.name || '')}" placeholder="(vide = toutes)" onchange="syncActField(this,'name')">
    </div>`;
  }
  if (t === 'stop_self') {
    return `<div class="fields-row"><span style="color:var(--text-3);font-size:11px">Arrête immédiatement cette macro.</span></div>`;
  }
  if (t === 'repeat') {
    const actJson = JSON.stringify(a.actions || [], null, 2);
    return `<div class="fields-row">
      <span>Répétitions</span><input type="number" class="af count" value="${a.count || 1}" min="1" onchange="syncActField(this,'count',true)">
      <span>Délai (s)</span><input type="number" class="af delay" value="${a.delay || 0}" min="0" step="0.1" onchange="syncActField(this,'delay',true)">
    </div>
    <div class="fields-row" style="flex-direction:column;align-items:stretch">
      <span style="font-size:11px;color:var(--text-3)">Sous-actions (JSON)</span>
      <textarea class="af actions-json" style="width:100%;min-height:80px;font-family:monospace;font-size:11px;resize:vertical" onchange="syncRepeatActions(this)">${escHtml(actJson)}</textarea>
    </div>`;
  }
  if (t === 'auto_clicker') {
    const isCount    = (a.repeat_mode || 'until_stopped') === 'count';
    const isPick     = (a.position_mode || 'current') === 'pick';
    const hasOffset  = !!a.random_offset;
    return `
    <div class="fields-row ac-row">
      <span class="ac-section-lbl">Intervalle</span>
      <input type="number" class="af interval_h ac-narrow" value="${a.interval_h || 0}" min="0" onchange="syncActField(this,'interval_h',true)" title="Heures"><span class="ac-unit">h</span>
      <input type="number" class="af interval_m ac-narrow" value="${a.interval_m || 0}" min="0" max="59" onchange="syncActField(this,'interval_m',true)" title="Minutes"><span class="ac-unit">m</span>
      <input type="number" class="af interval_s ac-narrow" value="${a.interval_s || 0}" min="0" max="59" onchange="syncActField(this,'interval_s',true)" title="Secondes"><span class="ac-unit">s</span>
      <input type="number" class="af interval_ms ac-mid" value="${a.interval_ms != null ? a.interval_ms : 100}" min="1" max="999" onchange="syncActField(this,'interval_ms',true)" title="Millisecondes"><span class="ac-unit">ms</span>
    </div>
    <div class="fields-row ac-row">
      <label class="ac-chk-lbl"><input type="checkbox" class="af random_offset" ${hasOffset ? 'checked' : ''} onchange="syncActField(this,'random_offset',false,'check');_acToggleOffset(this)"> Offset aléatoire ±</label>
      <input type="number" class="af random_offset_ms ac-mid" value="${a.random_offset_ms != null ? a.random_offset_ms : 40}" min="0" onchange="syncActField(this,'random_offset_ms',true)" ${hasOffset ? '' : 'disabled'}><span class="ac-unit">ms</span>
    </div>
    <div class="fields-row ac-row">
      <span class="ac-section-lbl">Bouton</span>
      <select class="af button" onchange="syncActField(this,'button')">
        <option value="left"   ${(a.button || 'left') === 'left'   ? 'selected' : ''}>Gauche</option>
        <option value="right"  ${a.button === 'right'              ? 'selected' : ''}>Droit</option>
        <option value="middle" ${a.button === 'middle'             ? 'selected' : ''}>Milieu</option>
      </select>
      <span>Type</span>
      <select class="af click_type" onchange="syncActField(this,'click_type')">
        <option value="single" ${(a.click_type || 'single') === 'single' ? 'selected' : ''}>Simple</option>
        <option value="double" ${a.click_type === 'double'               ? 'selected' : ''}>Double</option>
        <option value="triple" ${a.click_type === 'triple'               ? 'selected' : ''}>Triple</option>
      </select>
    </div>
    <div class="fields-row ac-row">
      <span class="ac-section-lbl">Répétition</span>
      <select class="af repeat_mode" onchange="syncActField(this,'repeat_mode');_acToggleRepeat(this)">
        <option value="until_stopped" ${!isCount ? 'selected' : ''}>Jusqu'à arrêt</option>
        <option value="count"         ${isCount  ? 'selected' : ''}>Nombre de fois</option>
      </select>
      <input type="number" class="af repeat_count ac-mid" value="${a.repeat_count || 1}" min="1" onchange="syncActField(this,'repeat_count',true)" ${isCount ? '' : 'disabled'} title="Répétitions">
    </div>
    <div class="fields-row ac-row">
      <span class="ac-section-lbl">Position</span>
      <select class="af position_mode" onchange="syncActField(this,'position_mode');_acTogglePosition(this)">
        <option value="current" ${!isPick ? 'selected' : ''}>Position actuelle</option>
        <option value="pick"    ${isPick  ? 'selected' : ''}>Point fixe</option>
      </select>
      <span class="ac-pos-fields" style="display:${isPick ? 'contents' : 'none'}">
        <span>X</span><input type="number" class="af x ac-narrow" value="${a.x || 0}" onchange="syncActField(this,'x',true)">
        <span>Y</span><input type="number" class="af y ac-narrow" value="${a.y || 0}" onchange="syncActField(this,'y',true)">
        <button class="pick-btn" onclick="pickPointForActField(this)" title="Choisir un point">🎯</button>
      </span>
    </div>`;
  }
  return '';
}

function _acToggleOffset(chk) {
  const row = chk.closest('.ac-row');
  if (!row) return;
  const inp = row.querySelector('.random_offset_ms');
  if (inp) inp.disabled = !chk.checked;
}
function _acToggleRepeat(sel) {
  const row = sel.closest('.ac-row');
  if (!row) return;
  const inp = row.querySelector('.repeat_count');
  if (inp) inp.disabled = sel.value !== 'count';
}
function _acTogglePosition(sel) {
  const row = sel.closest('.ac-row');
  if (!row) return;
  const posFields = row.querySelector('.ac-pos-fields');
  if (posFields) posFields.style.display = sel.value === 'pick' ? 'contents' : 'none';
}

function syncActField(inputEl, field, isNum, inputType) {
  const row = inputEl.closest('.item-row');
  if (!row) return;
  let a;
  const section = row.dataset.section;
  if (section) {
    const idx = parseInt(row.dataset.idx);
    a = macros[currentMacroIdx]?.[section]?.[idx];
  } else {
    const [, ri, ai] = row.id.split('-').map(Number);
    a = macros[currentMacroIdx]?.rules[ri]?.actions[ai];
  }
  if (!a) return;
  let val;
  if (inputType === 'check') val = inputEl.checked;
  else if (isNum) val = parseFloat(inputEl.value);
  else val = inputEl.value;
  a[field] = (typeof val === 'number' && isNaN(val)) ? undefined : val;
}

// key_combo: actions._key_combo iterates `keys` as a list — a raw "ctrl+c"
// string would be pressed char by char ('c','t','r','l','+','c').
function syncActComboKeys(inputEl) {
  syncActField(inputEl, 'keys');
  const row = inputEl.closest('.item-row');
  if (!row) return;
  let a;
  const section = row.dataset.section;
  if (section) a = macros[currentMacroIdx]?.[section]?.[parseInt(row.dataset.idx)];
  else {
    const [, ri, ai] = row.id.split('-').map(Number);
    a = macros[currentMacroIdx]?.rules[ri]?.actions[ai];
  }
  if (!a) return;
  const raw = String(inputEl.value || '');
  // '+' is the separator; a trailing '++' (or 'plus') means the + key itself
  const keys = raw.replace(/\+\+$/, '+plus').split('+')
    .map(k => k.trim().toLowerCase()).filter(Boolean)
    .map(k => (k === 'plus' ? '+' : k));
  a.keys = keys;
}

// Special sync for webhook message (nested in data.message)
function syncActWebhookMsg(inputEl) {
  const row = inputEl.closest('.item-row');
  if (!row) return;
  let a;
  const section = row.dataset.section;
  if (section) {
    const idx = parseInt(row.dataset.idx);
    a = macros[currentMacroIdx]?.[section]?.[idx];
  } else {
    const [, ri, ai] = row.id.split('-').map(Number);
    a = macros[currentMacroIdx]?.rules[ri]?.actions[ai];
  }
  if (!a) return;
  const msg = inputEl.value.trim();
  if (msg) {
    a.data = { ...(a.data || {}), message: msg };
  } else {
    delete a.data;
  }
}

function setActType(ri, ai, type) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[ri].actions[ai].type = type;
  // Update inline fields in action panel
  const fieldsEl = document.querySelector(`#arow-${ri}-${ai} .item-fields`);
  if (fieldsEl) fieldsEl.innerHTML = renderActionInlineFields(macros[currentMacroIdx].rules[ri].actions[ai]);
  // Refresh canvas node (category/icon/label may change)
  renderN8nCanvas();
  // Update panel title if this is the currently displayed action
  if (_selectedActIdx === ai && _selectedRuleIdx === ri) {
    const titleEl = document.getElementById('n8n-rule-panel-title');
    if (titleEl) titleEl.textContent = ACT_LABELS[type] || type;
  }
}

function addAction(ri) {
  if (currentMacroIdx < 0) return;
  const acts  = macros[currentMacroIdx].rules[ri].actions;
  const newAi = acts.length;
  acts.push({ type: 'key_tap', key: 'f', duration: 0.05, count: 1 });
  if (ri === _selectedRuleIdx && document.getElementById('n8n-canvas')) {
    n8nSelectAct(newAi);
    return;
  }
  renderRules();
}

function deleteAction(ri, ai) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx].rules[ri].actions.splice(ai, 1);
  if (ri === _selectedRuleIdx) {
    if (_selectedActIdx === ai) {
      _selectedActIdx = -1;
      n8nSelectRuleOverview();
      return;
    }
    if (_selectedActIdx > ai) _selectedActIdx--;
  }
  renderRules();
}

async function execActionInline(ri, ai) {
  if (currentMacroIdx < 0) return;
  const action = macros[currentMacroIdx].rules[ri].actions[ai];
  try {
    await ensureEngine();
    await window.api.execAction(action);
    appendLog('INFO', 'Action exécutée: ' + action.type);
  } catch (e) { appendLog('ERROR', 'Erreur action: ' + e.message); }
}

/* ── Screen picker helpers ─────────────────────────────── */
async function pickPointForCondField(btn) {
  try {
    const res = await window.api.pickPoint();
    if (!res || res.cancelled) return;
    const row = btn.closest('.item-row');
    if (!row) return;
    const xInput = row.querySelector('.cf.x');
    const yInput = row.querySelector('.cf.y');
    if (xInput) { xInput.value = res.x; syncCondField(xInput, 'x', true); }
    if (yInput) { yInput.value = res.y; syncCondField(yInput, 'y', true); }
    renderMacroEditor();
  } catch (e) { appendLog('ERROR', 'Picker: ' + e.message); }
}

async function pickRegionForCondField(btn) {
  try {
    const res = await window.api.pickRegion();
    if (!res || res.cancelled) return;
    const row = btn.closest('.item-row');
    if (!row) return;
    const xInput = row.querySelector('.cf.x');
    const yInput = row.querySelector('.cf.y');
    const wInput = row.querySelector('.cf.w');
    const hInput = row.querySelector('.cf.h');
    if (xInput) { xInput.value = res.x; syncCondField(xInput, 'x', true); }
    if (yInput) { yInput.value = res.y; syncCondField(yInput, 'y', true); }
    if (wInput) { wInput.value = res.w; syncCondField(wInput, 'w', true); }
    if (hInput) { hInput.value = res.h; syncCondField(hInput, 'h', true); }
    renderMacroEditor();
  } catch (e) { appendLog('ERROR', 'Picker: ' + e.message); }
}

async function pickPointForActField(btn, xField, yField) {
  try {
    const res = await window.api.pickPoint();
    if (!res || res.cancelled) return;
    const row = btn.closest('.item-row');
    if (!row) return;
    const xInput = row.querySelector('.af.' + (xField || 'x'));
    const yInput = row.querySelector('.af.' + (yField || 'y'));
    if (xInput) { xInput.value = res.x; syncActField(xInput, xField || 'x', true); }
    if (yInput) { yInput.value = res.y; syncActField(yInput, yField || 'y', true); }
    renderMacroEditor();
  } catch (e) { appendLog('ERROR', 'Picker: ' + e.message); }
}

/* ── Key capture helper ────────────────────────────────── */
function startKeyCapture(input) {
  input.value = '⌨ Appuyez sur une touche…';
  input.classList.add('capturing');
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // key_tap/key_hold/key_release are sent via pydirectinput → physical name
    input.value = keyNameFromEvent(e);
    input.classList.remove('capturing');
    input.removeEventListener('keydown', handler);
    input.removeEventListener('blur', blurHandler);
    input.blur();
    syncActField(input, input.dataset.field);
  };
  const blurHandler = () => {
    if (input.classList.contains('capturing')) {
      input.value = '';
      input.classList.remove('capturing');
      input.removeEventListener('keydown', handler);
    }
  };
  input.addEventListener('keydown', handler);
  input.addEventListener('blur', blurHandler, { once: true });
}

/* ── Repeat action: sync nested actions JSON ───────────── */
function syncRepeatActions(textarea) {
  const row = textarea.closest('.item-row');
  if (!row) return;
  let a;
  const section = row.dataset.section;
  if (section) {
    const idx = parseInt(row.dataset.idx);
    a = macros[currentMacroIdx]?.[section]?.[idx];
  } else {
    const [, ri, ai] = row.id.split('-').map(Number);
    a = macros[currentMacroIdx]?.rules[ri]?.actions[ai];
  }
  if (!a) return;
  try {
    a.actions = JSON.parse(textarea.value);
    textarea.style.borderColor = '';
  } catch (_) {
    textarea.style.borderColor = 'var(--danger)';
  }
}

/* ══════════════════════════════════════════════════════════════
   ADVANCED SECTIONS: start_guard, stop_conditions, pre_stop_actions
══════════════════════════════════════════════════════════════ */

function renderAdvancedSections() {
  const macro = macros[currentMacroIdx];
  if (!macro) return;

  const guardList = document.getElementById('guard-conditions-list');
  if (guardList) {
    macro.start_guard = macro.start_guard || [];
    if (macro.start_guard.length === 0) {
      guardList.innerHTML = '<div class="empty-mini">Aucune condition de garde</div>';
    } else {
      guardList.innerHTML = macro.start_guard.map((c, ci) =>
        renderSectionCondRow(c, ci, 'start_guard', 'gcrow')).join('');
    }
  }

  const stopList = document.getElementById('stop-conditions-list');
  if (stopList) {
    macro.stop_conditions = macro.stop_conditions || [];
    if (macro.stop_conditions.length === 0) {
      stopList.innerHTML = '<div class="empty-mini">Aucune condition d\'arrêt auto</div>';
    } else {
      stopList.innerHTML = macro.stop_conditions.map((c, ci) =>
        renderSectionCondRow(c, ci, 'stop_conditions', 'scrow')).join('');
    }
  }

  const preStopList = document.getElementById('pre-stop-actions-list');
  if (preStopList) {
    macro.pre_stop_actions = macro.pre_stop_actions || [];
    if (macro.pre_stop_actions.length === 0) {
      preStopList.innerHTML = '<div class="empty-mini">Aucune action de nettoyage</div>';
    } else {
      preStopList.innerHTML = macro.pre_stop_actions.map((a, ai) =>
        renderSectionActRow(a, ai, 'pre_stop_actions', 'parow')).join('');
    }
  }
}

/* ── Kill Switch helpers ──────────────────────────────────────── */
function killSwitchChanged() {
  if (currentMacroIdx < 0) return;
  const m       = macros[currentMacroIdx];
  const enabled = !!document.getElementById('me-ks-enabled')?.checked;
  m.kill_switch = m.kill_switch || {};
  m.kill_switch.enabled = enabled;
  const cfg = document.getElementById('kill-switch-config');
  if (cfg) cfg.style.display = enabled ? '' : 'none';
}

let _ksKeyListener = null;
function captureKillSwitchKey(inputEl) {
  if (_ksKeyListener) return;
  const hint = document.getElementById('ks-capture-hint');
  if (hint) hint.style.display = '';
  if (inputEl) inputEl.style.borderColor = 'var(--accent)';

  _ksKeyListener = function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    // Consumed by keyboard.add_hotkey (Python `keyboard` lib, layout-aware
    // names). Bare modifier / dead key → keep waiting for the real key.
    const k = keyboardLibNameFromEvent(e);
    if (!k) return;
    const parts = [];
    if (e.ctrlKey)  parts.push('ctrl');
    if (e.altKey)   parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(k);
    const combo = parts.join('+');
    if (inputEl) { inputEl.value = combo; inputEl.style.borderColor = ''; }
    if (hint) hint.style.display = 'none';
    _cancelKsCapture();
    macroFieldChanged();
  };
  document.addEventListener('keydown', _ksKeyListener, true);
}

function _cancelKsCapture() {
  if (_ksKeyListener) {
    document.removeEventListener('keydown', _ksKeyListener, true);
    _ksKeyListener = null;
  }
  const hint = document.getElementById('ks-capture-hint');
  if (hint) hint.style.display = 'none';
  const inp = document.getElementById('me-ks-key');
  if (inp) inp.style.borderColor = '';
}

function clearKillSwitchKey() {
  _cancelKsCapture();
  const inputEl = document.getElementById('me-ks-key');
  if (inputEl) inputEl.value = '';
  macroFieldChanged();
}

function renderSectionCondRow(c, idx, section, prefix) {
  const type = c.type || 'pixel_color';
  return `
  <div class="item-row" id="${prefix}-${idx}" data-section="${section}" data-idx="${idx}">
    <div class="item-row-head">
      <div class="item-cat-icon item-cat-icon-${_condCategory(type)}" id="${prefix}-icon-${idx}">${_condIconSVG(type)}</div>
      <select class="item-type-select" onchange="setSectionCondType('${section}',${idx},this.value);_refreshCatIcon('${prefix}-icon-${idx}',this.value,_condCategory,_condIconSVG)">
        ${_groupedTypeOptions(COND_LABELS, _condCategory, COND_GROUP_LABELS, type)}
      </select>
      <div class="item-row-btns">
        <button class="icon-btn" title="Tester" onclick="testSectionCondInline('${section}',${idx})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </button>
        <button class="icon-btn btn-danger-icon" onclick="deleteSectionCond('${section}',${idx})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="item-fields">${renderConditionInlineFields(c)}</div>
    <div class="inline-test-result" id="${prefix}-test-${idx}" style="display:none"></div>
  </div>`;
}

function renderSectionActRow(a, idx, section, prefix) {
  const type = a.type || 'key_tap';
  return `
  <div class="item-row" id="${prefix}-${idx}" data-section="${section}" data-idx="${idx}">
    <div class="item-row-head">
      <div class="item-cat-icon n8n-act-icon-${_actCategory(type)}" id="${prefix}-icon-${idx}">${_actIconSVG(type)}</div>
      <select class="item-type-select" onchange="setSectionActType('${section}',${idx},this.value);_refreshCatIcon('${prefix}-icon-${idx}',this.value,_actCategory,_actIconSVG,'n8n-act-icon-')">
        ${_groupedTypeOptions(ACT_LABELS, _actCategory, ACT_GROUP_LABELS, type)}
      </select>
      <div class="item-row-btns">
        <button class="icon-btn" title="Exécuter" onclick="execSectionActInline('${section}',${idx})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="icon-btn btn-danger-icon" onclick="deleteSectionAct('${section}',${idx})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="item-fields">${renderActionInlineFields(a)}</div>
  </div>`;
}

function setSectionCondType(section, idx, type) {
  if (currentMacroIdx < 0) return;
  const c = macros[currentMacroIdx][section][idx];
  c.type = type;
  const defaults = COND_DEFAULTS[type] || {};
  for (const [k, v] of Object.entries(defaults)) {
    if (c[k] === undefined || c[k] === null) c[k] = v;
  }
  renderAdvancedSections();
}

function setSectionActType(section, idx, type) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx][section][idx].type = type;
  renderAdvancedSections();
}

function addSectionCond(section) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx][section] = macros[currentMacroIdx][section] || [];
  macros[currentMacroIdx][section].push({ type: 'window_focused', title: '' });
  renderAdvancedSections();
}

function deleteSectionCond(section, idx) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx][section].splice(idx, 1);
  renderAdvancedSections();
}

function addSectionAct(section) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx][section] = macros[currentMacroIdx][section] || [];
  macros[currentMacroIdx][section].push({ type: 'key_tap', key: 'escape', duration: 0.05 });
  renderAdvancedSections();
}

function deleteSectionAct(section, idx) {
  if (currentMacroIdx < 0) return;
  macros[currentMacroIdx][section].splice(idx, 1);
  renderAdvancedSections();
}

async function testSectionCondInline(section, idx) {
  if (currentMacroIdx < 0) return;
  const cond = macros[currentMacroIdx][section][idx];
  const prefix = section === 'start_guard' ? 'gcrow' : 'scrow';
  const resultEl = document.getElementById(`${prefix}-test-${idx}`);
  if (!resultEl) return;
  resultEl.style.display = '';
  resultEl.className = 'inline-test-result testing';
  resultEl.textContent = 'Test en cours…';
  try {
    await ensureEngine();
    const res = await window.api.testCondition(cond);
    const ok = res.result === true;
    resultEl.className = 'inline-test-result ' + (ok ? 'test-ok' : 'test-fail');
    resultEl.textContent = ok ? '✅ Condition vraie' : '❌ Condition fausse';
  } catch (e) {
    resultEl.className = 'inline-test-result test-fail';
    resultEl.textContent = 'Erreur: ' + e.message;
  }
}

async function execSectionActInline(section, idx) {
  if (currentMacroIdx < 0) return;
  const action = macros[currentMacroIdx][section][idx];
  try {
    await ensureEngine();
    await window.api.execAction(action);
    appendLog('INFO', 'Action exécutée: ' + action.type);
  } catch (e) { appendLog('ERROR', 'Erreur action: ' + e.message); }
}
