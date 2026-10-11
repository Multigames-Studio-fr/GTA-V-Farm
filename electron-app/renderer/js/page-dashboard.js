'use strict';
/* ═══════════════════════════════════════════════════════════════
   PAGE: DASHBOARD
════════════════════════════════════════════════════════════════ */

let _dashRunningStats = {}; // macro name → {iterations, errors, last_rule, elapsed_s, ...} from engine:get_stats
let _dashStatsPoller  = null;

// Inline stroke icons (replace the old emoji pills)
const _DASH_ICONS = {
  cycle: '<svg class="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  clock: '<svg class="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  bolt:  '<svg class="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  warn:  '<svg class="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  play:  '<svg class="dash-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  stop:  '<svg class="dash-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  edit:  '<svg class="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
};

function renderDashboard() {
  _renderDashCounters();
  _renderDashKpisFromStats();
  _renderDashMacroList();
  _renderDashNextMeal();
  _refreshDashHistory();
  _renderDashSession();
  _bindDashSession();
  _startDashStatsPoll();
}

function _renderDashCounters() {
  const totalEl = document.getElementById('val-total-macros');
  if (totalEl) totalEl.textContent = macros.length;
  const countEl = document.getElementById('val-running-count');
  if (countEl) countEl.textContent = runningMacros.size;
  const subEl = document.getElementById('val-running-sub');
  if (subEl) {
    const names = [...runningMacros];
    subEl.textContent = names.length ? '● ' + names.slice(0, 2).join(', ') + (names.length > 2 ? '…' : '') : 'Aucune macro active';
    subEl.classList.toggle('ok', names.length > 0);
  }
}

/* ── Run history (persisted server-side, survives app restarts) ──── */
async function _refreshDashHistory() {
  const el = document.getElementById('dash-history');
  if (!el) return;
  let history = [];
  try {
    const res = await window.api.getMacroHistory({ limit: 30 });
    history = (res && res.ok !== false && Array.isArray(res.history)) ? res.history : [];
  } catch (e) { /* engine not started yet — keep empty */ }
  if (history.length === 0) {
    el.innerHTML = '<div class="empty-state">Aucun run terminé pour l\'instant</div>';
    return;
  }
  el.innerHTML = history.map(h => {
    const date = h.ended_at ? new Date(h.ended_at * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
    return `
    <div class="history-item">
      <span class="history-item-name" title="${escHtml(h.name || '?')}">${escHtml(h.name || '?')}</span>
      <span class="history-item-date">${date}</span>
      <div class="dash-macro-meta" style="margin-left:auto">
        <span class="dash-macro-stat">${_DASH_ICONS.cycle} ${h.iterations ?? 0}</span>
        <span class="dash-macro-stat">${_DASH_ICONS.clock} ${_fmtElapsed(h.elapsed_s)}</span>
        ${h.errors ? `<span class="dash-macro-stat err">${_DASH_ICONS.warn} ${h.errors}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ── Live stats (real backend data via engine:get_stats — iterations,
   rules_triggered, errors, elapsed_s per running macro) ─────────── */
async function _refreshDashStats() {
  if (runningMacros.size === 0) { _dashRunningStats = {}; return; }
  try {
    const res = await window.api.getStats();
    _dashRunningStats = (res && res.ok !== false && res.stats) ? res.stats : {};
  } catch (e) { _dashRunningStats = {}; }
}

function _renderDashKpisFromStats() {
  let cycles = 0, errors = 0;
  for (const name of runningMacros) {
    const s = _dashRunningStats[name];
    if (s) { cycles += s.iterations || 0; errors += s.errors || 0; }
  }
  const cyclesEl = document.getElementById('val-total-cycles');
  const errorsEl = document.getElementById('val-total-errors');
  if (cyclesEl) cyclesEl.textContent = cycles.toLocaleString('fr-FR');
  if (errorsEl) errorsEl.textContent = errors;
}

/* ── Prochain repas (Auto Bouffe exposes abfNextCycleAt) ─────────── */
function _renderDashNextMeal() {
  const valEl = document.getElementById('val-next-meal');
  const subEl = document.getElementById('val-next-meal-sub');
  if (!valEl || !subEl) return;
  const at = (typeof abfNextCycleAt === 'number') ? abfNextCycleAt : null;
  if (!at) {
    valEl.textContent = '—';
    subEl.textContent = (typeof _abfRunning !== 'undefined' && _abfRunning) ? 'Cycle en cours…' : 'Auto Bouffe arrêté';
    return;
  }
  valEl.textContent = new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  subEl.textContent = 'dans ' + (h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : m > 0 ? `${m} min` : `${s} s`);
}

function _fmtElapsed(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function _fmtAgo(ts) {
  if (!ts) return null;
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 2) return 'à l\'instant';
  if (s < 60) return `il y a ${s}s`;
  return `il y a ${Math.floor(s / 60)}m`;
}

/* ── Merged macro list: running first (with live stats), then idle ── */
function _renderDashMacroList() {
  const el = document.getElementById('dash-ql-grid');
  if (!el) return;
  if (!macros || macros.length === 0) {
    el.innerHTML = '<div class="empty-state">Aucune macro créée</div>';
    return;
  }
  const rows = macros.map((m, i) => ({ m, i, on: runningMacros.has(m.name) }));
  rows.sort((a, b) => (b.on - a.on) || (a.i - b.i));
  const html = rows.map(({ m, i, on }) => {
    const name = escHtml(m.name || 'Sans nom');
    const meta = [];
    if (on) {
      const s = _dashRunningStats[m.name];
      if (s) {
        meta.push(`<span class="dash-macro-stat">${_DASH_ICONS.cycle} ${s.iterations ?? 0} cycle${(s.iterations ?? 0) !== 1 ? 's' : ''}</span>`);
        meta.push(`<span class="dash-macro-stat">${_DASH_ICONS.clock} ${_fmtElapsed(s.elapsed_s)}</span>`);
        if (s.last_rule) meta.push(`<span class="dash-macro-stat">${_DASH_ICONS.bolt} ${escHtml(s.last_rule)}${_fmtAgo(s.last_rule_ts) ? ' — ' + _fmtAgo(s.last_rule_ts) : ''}</span>`);
        if (s.errors) meta.push(`<span class="dash-macro-stat err">${_DASH_ICONS.warn} ${s.errors} erreur${s.errors !== 1 ? 's' : ''}</span>`);
      } else {
        meta.push('<span class="dash-macro-stat">Démarrage…</span>');
      }
    } else {
      const rulesCount = (m.rules || []).length;
      meta.push(`<span>${rulesCount} règle${rulesCount !== 1 ? 's' : ''}</span>`);
      meta.push(`<span>${m.loop !== false ? 'Boucle' : '1 passe'}</span>`);
    }
    const action = on
      ? `<button class="btn btn-danger btn-sm" type="button" data-macro-stop="${name}" onclick="stopMacroByName(this.dataset.macroStop)">${_DASH_ICONS.stop} Arrêter</button>`
      : `<button class="btn btn-success btn-sm" type="button" onclick="startMacro(${i})">${_DASH_ICONS.play} Lancer</button>`;
    return `
      <div class="dash-macro-row">
        <span class="dash-macro-dot${on ? ' on' : ''}" aria-hidden="true"></span>
        <div class="dash-macro-main">
          <div class="dash-macro-name" title="${name}">${name}</div>
          <div class="dash-macro-meta">${meta.join('')}</div>
        </div>
        <div class="dash-macro-actions">
          ${action}
          <button class="btn btn-secondary btn-sm" type="button" onclick="selectMacro(${i});navigate('macros')" aria-label="Modifier ${name}" title="Modifier">${_DASH_ICONS.edit}</button>
        </div>
      </div>`;
  }).join('');
  // Rebuilt every 2 s by the poll: only touch the DOM when something changed,
  // otherwise keyboard focus and in-flight clicks get dropped.
  if (html !== el.dataset.lastHtml) {
    el.innerHTML = html;
    el.dataset.lastHtml = html;
  }
}

function _startDashStatsPoll() {
  if (_dashStatsPoller) return;
  _dashStatsPoller = setInterval(async () => {
    const pageEl = document.getElementById('page-dashboard');
    if (!pageEl || !pageEl.classList.contains('active')) {
      clearInterval(_dashStatsPoller);
      _dashStatsPoller = null;
      return;
    }
    await _refreshDashStats();
    _renderDashCounters();
    _renderDashKpisFromStats();
    _renderDashMacroList();
    _renderDashNextMeal();
    _refreshDashHistory();
    _renderDashSession();
  }, 2000);
  _refreshDashStats().then(() => { _renderDashKpisFromStats(); _renderDashMacroList(); });
}

/* ── Session panel (stats since app launch / last reset) ─────────── */
async function _renderDashSession() {
  if (typeof sessionStats === 'undefined') return;
  const lineEl = document.getElementById('dash-session-line');
  const tblEl  = document.getElementById('dash-session-table');
  if (!lineEl || !tblEl) return;
  const sm = await sessionStats.refresh();
  const n = v => (v || 0).toLocaleString('fr-FR');
  const dur = sm.durationS >= 3600
    ? `${Math.floor(sm.durationS / 3600)} h ${String(Math.floor((sm.durationS % 3600) / 60)).padStart(2, '0')}`
    : `${Math.floor(sm.durationS / 60)} min`;
  lineEl.textContent = `${dur} · ${n(sm.cycles)} cycle${sm.cycles !== 1 ? 's' : ''} · ${sm.abf.meals} repas · ${sm.errors} erreur${sm.errors !== 1 ? 's' : ''}`;
  const body = sm.macros.length
    ? sm.macros.map(m => `<tr><td>${escHtml(m.name)}</td><td>${n(m.runs)}</td><td>${n(m.cycles)}</td><td>${n(m.errors)}</td><td>${_fmtElapsed(m.activeS)}</td><td>${escHtml(sessionStats.reasonsLabel(m.stopReasons))}</td></tr>`).join('')
    : '<tr><td colspan="6" class="dash-muted">Aucune macro sur cette session</td></tr>';
  const tbody = tblEl.querySelector('tbody');
  if (tbody && body !== tbody.dataset.lastHtml) {
    tbody.innerHTML = body;
    tbody.dataset.lastHtml = body;
  }
}

let _dashSessionBound = false;
function _bindDashSession() {
  if (_dashSessionBound) return;
  const send = document.getElementById('dash-session-send');
  const csv  = document.getElementById('dash-session-csv');
  const rst  = document.getElementById('dash-session-reset');
  if (!send || !csv || !rst) return;
  _dashSessionBound = true;

  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      const sm = await sessionStats.refresh();
      const res = await window.api.sendWebhook({
        event: 'session_summary',
        data: { summary_lines: sessionStats.summaryLines(sm), message: 'Résumé de session' },
      });
      if (res && res.ok) appendLog('INFO', 'Résumé de session envoyé sur Discord');
      else appendLog('WARNING', 'Résumé Discord non envoyé : ' + ((res && res.error) || 'erreur inconnue'));
    } catch (e) {
      appendLog('WARNING', 'Résumé Discord non envoyé : ' + (e && e.message ? e.message : e));
    } finally {
      send.disabled = false;
    }
  });

  csv.addEventListener('click', async () => {
    await sessionStats.refresh();
    const blob = new Blob([sessionStats.toCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const d = new Date(), p2 = x => String(x).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  rst.addEventListener('click', () => {
    sessionStats.reset();
    _renderDashSession();
  });
}
