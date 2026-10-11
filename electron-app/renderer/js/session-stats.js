'use strict';
/* ═══════════════════════════════════════════════════════════════
   SESSION STATS — aggregates finished runs (history) + live macros
   + Auto Bouffe counters since `startedAt`. Feeds the dashboard
   "Session" panel, the CSV export and the engine-side Discord alerts.
   Finished runs carry a stop_reason (manual / condition / timeout /
   max_iterations); older history entries without one count as 'other'.
════════════════════════════════════════════════════════════════ */

const sessionStats = (() => {
  const REASONS = ['manual', 'condition', 'timeout', 'max_iterations', 'other'];
  const newAbf = () => ({ meals: 0, mealFails: 0, trunkReopened: 0, trunkFails: 0 });
  const ABF_KEY = { meal: 'meals', mealFail: 'mealFails', trunk: 'trunkReopened', trunkFail: 'trunkFails' };

  let startedAt = Date.now();
  let abf = newAbf();
  let finishedStarts = {}; // name → [started_at (s)] of runs already in history
  let finished = {}; // name → {runs, cycles, errors, activeS, stopReasons}
  let ownLive  = {}; // live stats fetched by the 30 s tick (dashboard may not be open)

  const blank = () => ({ runs: 0, cycles: 0, errors: 0, activeS: 0, stopReasons: Object.fromEntries(REASONS.map(r => [r, 0])) });

  function mapReason(h) {
    const r = h && (h.stop_reason || h.reason);
    return REASONS.includes(r) ? r : 'other';
  }

  function build() {
    const byName = {};
    for (const [n, v] of Object.entries(finished)) byName[n] = { ...v, stopReasons: { ...v.stopReasons } };
    // Dashboard poll (2 s) is fresher when visible; ownLive covers other pages.
    // Per macro, keep the freshest of the two sources (largest elapsed_s): the
    // dashboard map can go stale while another page is shown, and ownLive is
    // refreshed by the overlay feed (2 s) or the 30 s tick below.
    const dash = (typeof _dashRunningStats !== 'undefined' && _dashRunningStats) || {};
    const live = { ...ownLive };
    for (const [n, s] of Object.entries(dash)) {
      if (!live[n] || (s && (s.elapsed_s || 0) >= (live[n].elapsed_s || 0))) live[n] = s;
    }
    const running = (typeof runningMacros !== 'undefined' && runningMacros) ? [...runningMacros] : [];
    for (const name of running) {
      const s = live[name];
      if (!s) continue;
      // Dedupe: a run that already ended (in history) can linger in `live`/
      // runningMacros until the engine's status push lands. A live run is the
      // same run as a history entry if their start times match (<2 s).
      if (s.start_time && (finishedStarts[name] || []).some(t => Math.abs(t - s.start_time) < 2)) continue;
      const m = byName[name] || (byName[name] = blank());
      m.runs += 1;
      m.cycles += s.iterations || 0;
      m.errors += s.errors || 0;
      m.activeS += s.elapsed_s || 0;
    }
    const macrosArr = Object.entries(byName).map(([name, v]) => ({
      name, runs: v.runs, cycles: v.cycles, errors: v.errors,
      activeS: Math.round(v.activeS), stopReasons: v.stopReasons,
    }));
    const cycles = macrosArr.reduce((a, m) => a + m.cycles, 0);
    const errors = macrosArr.reduce((a, m) => a + m.errors, 0) + abf.mealFails + abf.trunkFails;
    return {
      startedAt,
      durationS: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      cycles, errors,
      abf: { ...abf },
      macros: macrosArr,
    };
  }

  function summary() { return build(); }

  async function refresh() {
    let history = [];
    try {
      const res = await window.api.getMacroHistory({ limit: 500 });
      history = (res && res.ok !== false && Array.isArray(res.history)) ? res.history : [];
    } catch (e) { /* engine not ready — keep what we have */ }
    const agg = {};
    const starts = {};
    for (const h of history) {
      if (!h || !h.ended_at || h.ended_at * 1000 < startedAt) continue;
      const name = h.name || '?';
      if (h.started_at) (starts[name] || (starts[name] = [])).push(h.started_at);
      const m = agg[name] || (agg[name] = blank());
      m.runs += 1;
      m.cycles += h.iterations || 0;
      m.errors += h.errors || 0;
      m.activeS += h.elapsed_s || 0;
      m.stopReasons[mapReason(h)] += 1;
    }
    finished = agg;
    finishedStarts = starts;
    return build();
  }

  function fmtDur(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
  }
  const nf = n => (n || 0).toLocaleString('fr-FR');

  function summaryLines(sm) {
    sm = sm || build();
    const a = sm.abf;
    const lines = [
      `Durée : ${fmtDur(sm.durationS)}`,
      `Cycles : ${nf(sm.cycles)}`,
      `Erreurs : ${nf(sm.errors)}`,
      `Auto Bouffe : ${a.meals} repas, ${a.mealFails + a.trunkFails} échec, ${a.trunkReopened} coffres rouverts`,
    ];
    for (const m of sm.macros) {
      lines.push(`• ${m.name} — ${nf(m.cycles)} cycles, ${m.errors} erreur${m.errors !== 1 ? 's' : ''}, ${fmtDur(m.activeS)} actif`);
    }
    return lines;
  }

  function reasonsLabel(sr) {
    const L = { manual: 'manuel', condition: 'condition', timeout: 'timeout', max_iterations: 'max itér.', other: 'autre' };
    const parts = REASONS.filter(r => sr && sr[r] > 0).map(r => `${L[r]} ${sr[r]}`);
    return parts.length ? parts.join(' · ') : '—';
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise Excel formula injection
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv() {
    const sm = build();
    const rows = ['Type;Nom;Lancements;Cycles;Erreurs;Temps actif (s);Arrêts;Repas;Coffres rouverts'];
    for (const m of sm.macros) {
      rows.push(['Macro', csvCell(m.name), m.runs, m.cycles, m.errors, m.activeS, csvCell(reasonsLabel(m.stopReasons)), '', ''].join(';'));
    }
    rows.push(`Auto Bouffe;;;;${sm.abf.mealFails + sm.abf.trunkFails};;;${sm.abf.meals};${sm.abf.trunkReopened}`);
    return '﻿' + rows.join('\r\n') + '\r\n';
  }

  function recordAbf(kind) {
    const k = ABF_KEY[kind];
    if (k) abf[k] += 1;
  }

  // Live per-macro stats (engine get_stats) fetched by another poller — the
  // overlay feed — so summary() is fresh without waiting for the 30 s tick.
  function setLive(stats) {
    ownLive = (stats && typeof stats === 'object') ? stats : {};
  }

  function reset() {
    startedAt = Date.now();
    abf = newAbf();
    finished = {};
    finishedStarts = {};
    pushSnapshot();
  }

  function pushSnapshot() {
    try {
      if (window.api?.setSessionSnapshot) {
        const p = window.api.setSessionSnapshot({
          snapshot: build(),
          abf_running: (typeof _abfRunning !== 'undefined') ? !!_abfRunning : false,
        });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { /* never throw */ }
  }

  // Self-sufficient tick: the dashboard only refreshes history/live stats while
  // it is visible, so the engine-side snapshot (used for the on-exit summary)
  // would go stale on other pages without this.
  setInterval(async () => {
    try {
      if (typeof runningMacros !== 'undefined' && runningMacros.size > 0) {
        const res = await window.api.getStats();
        ownLive = (res && res.ok !== false && res.stats) ? res.stats : {};
      } else {
        ownLive = {};
      }
      await refresh();
    } catch (e) { /* keep last values */ }
    pushSnapshot();
  }, 30000);

  return {
    get startedAt() { return startedAt; },
    recordAbf, refresh, summary, summaryLines, reasonsLabel, toCsv, reset, pushSnapshot, setLive,
  };
})();
