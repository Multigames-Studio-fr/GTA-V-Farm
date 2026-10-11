'use strict';
/* ═══════════════════════════════════════════════════════════════
   OVERLAY FEED — pushes session / meal / per-macro data and critical
   alerts to the in-game overlay (renderer → main 'overlay:data' →
   overlay window). Polls every 2 s, only while the overlay is shown
   (started/stopped by app.js _syncOverlayFeed()). Alerts are pushed
   whatever the visibility.
════════════════════════════════════════════════════════════════ */

// Cycles per hour over the active (running) time. null = not enough data yet.
function overlayCyclesPerHour(cycles, activeS) {
  cycles = Number(cycles) || 0;
  activeS = Number(activeS) || 0;
  if (activeS < 60) return null;
  return Math.max(0, Math.round(cycles * 3600 / activeS));
}

// Elapsed fraction of the current Auto Bouffe interval.
// nextAt null while a cycle is running → full bar, inCycle.
function overlayMealProgress(nextAt, intervalMs, now) {
  intervalMs = Number(intervalMs) || 0;
  if (nextAt == null) return { pct: 1, remainingMs: 0, inCycle: true };
  if (intervalMs <= 0) return { pct: 0, remainingMs: Math.max(0, nextAt - now), inCycle: false };
  const remainingMs = Math.max(0, nextAt - now);
  const pct = Math.min(1, Math.max(0, 1 - remainingMs / intervalMs));
  return { pct, remainingMs, inCycle: false };
}

const overlayFeed = (() => {
  let timer = null;
  let busy = false;
  let lastRunKey = '';

  function _push(data) {
    try {
      if (window.api && window.api.overlayPush) window.api.overlayPush(data);
    } catch (e) { /* never throw */ }
  }

  async function collect() {
    const running = (typeof runningMacros !== 'undefined' && runningMacros) ? [...runningMacros] : [];
    const runKey = running.slice().sort().join('\u0001');
    if (typeof sessionStats !== 'undefined') {
      try {
        if (running.length) {
          const res = await window.api.getStats();
          sessionStats.setLive((res && res.ok !== false && res.stats) ? res.stats : {});
        } else {
          sessionStats.setLive({});
        }
        // A macro just stopped/started: its run moves to history — refresh now
        // instead of waiting for the 30 s tick (cycles would dip meanwhile).
        if (runKey !== lastRunKey) { lastRunKey = runKey; await sessionStats.refresh(); }
      } catch (e) { /* engine busy — keep last values */ }
    }
    const sm = (typeof sessionStats !== 'undefined') ? sessionStats.summary()
      : { durationS: 0, cycles: 0, errors: 0, abf: { meals: 0 }, macros: [] };
    const activeS = sm.macros.reduce((a, m) => a + (m.activeS || 0), 0);
    const macroCycles = {};
    for (const m of sm.macros) macroCycles[m.name] = m.cycles;

    const abfOn = (typeof _abfRunning !== 'undefined') && !!_abfRunning;
    const nextAt = (typeof abfNextCycleAt !== 'undefined') ? abfNextCycleAt : null;
    const intervalMs = (typeof abfCycleIntervalMs !== 'undefined') ? abfCycleIntervalMs : 0;
    const prog = abfOn ? overlayMealProgress(nextAt, intervalMs, Date.now()) : null;

    return {
      session: {
        durationS: sm.durationS,
        cycles: sm.cycles,
        errors: sm.errors,
        cph: overlayCyclesPerHour(sm.cycles, activeS),
      },
      meal: {
        running: abfOn,
        nextAt,
        intervalMs,
        pct: prog ? prog.pct : 0,
        inCycle: prog ? prog.inCycle : false,
        meals: (sm.abf && sm.abf.meals) || 0,
      },
      macroCycles,
    };
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try { _push(await collect()); } catch (e) { /* ignore */ }
    finally { busy = false; }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 2000);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function alert(title, message) {
    _push({ alert: { title: String(title || ''), message: String(message || ''), at: Date.now() } });
  }

  // Engine-side critical alerts (game_closed / macro_errors) relayed by main.js
  if (window.api && window.api.onEngineAlert) {
    window.api.onEngineAlert((d) => {
      if (!d) return;
      alert(d.title || (d.event === 'game_closed' ? 'FiveM fermé' : 'Alerte'), d.message || '');
    });
  }

  // Commands sent from the overlay that only the main renderer can execute
  if (window.api && window.api.onOverlayCommand) {
    window.api.onOverlayCommand((d) => {
      if (d && d.cmd === 'abf_stop' && typeof stopAutoBouffe === 'function') stopAutoBouffe();
      setTimeout(tick, 50);
    });
  }

  return { start, stop, alert, tick };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { overlayCyclesPerHour, overlayMealProgress };
}
