'use strict';
/* ═══════════════════════════════════════════════════════════════
   MACROS RUN CONTROLS + RECORDING
════════════════════════════════════════════════════════════════ */

let isRecording = false;
let recordedActions = [];

function updateMacroRunButtons() {
  if (currentMacroIdx < 0) return;
  const macro = macros[currentMacroIdx];
  if (!macro) return;
  const running = runningMacros.has(macro.name);
  const btnRun   = document.getElementById('btn-run-macro');
  const btnPause = document.getElementById('btn-pause-macro');
  const btnStop  = document.getElementById('btn-stop-macro');
  const badge    = document.getElementById('macro-running-badge');
  if (btnRun)   btnRun.style.display   = running ? 'none' : '';
  if (btnPause) btnPause.style.display = running ? '' : 'none';
  if (btnStop)  btnStop.style.display  = running ? '' : 'none';
  if (badge)    badge.style.display    = running ? '' : 'none';
}

async function runCurrentMacro() {
  if (currentMacroIdx < 0) return;
  if (macros[currentMacroIdx]) { try { flushEditorToMacro(); } catch (e) {} }
  const macro = macros[currentMacroIdx];
  runningMacros.add(macro.name);
  updateMacroRunButtons();
  try {
    await ensureEngine();
    const settings = await window.api.readSettings().catch(() => ({}));
    await window.api.setWebhook(buildWebhookConfig(settings));
    await window.api.macroStart({ macro, macro_id: macro.name });
    renderDashboard();
    appendLog('INFO', 'Macro démarrée: ' + macro.name);
  } catch (e) {
    runningMacros.delete(macro.name);
    updateMacroRunButtons();
    renderDashboard();
    appendLog('ERROR', 'Erreur démarrage: ' + e.message);
  }
}

async function pauseCurrentMacro() {
  if (currentMacroIdx < 0) return;
  const macro = macros[currentMacroIdx];
  if (!macro) return;
  try {
    await window.api.macroPause({ macro_id: macro.name });
    appendLog('INFO', 'Macro en pause: ' + macro.name);
  } catch (e) { appendLog('ERROR', e.message); }
}

async function stopCurrentMacro() {
  try {
    // kill switch : arrête macro courante + auto-clicker d'un coup
    await window.api.stopAll();
    runningMacros.clear();
    updateMacroRunButtons();
    renderDashboard();
    appendLog('INFO', 'Stop — toutes les macros arrêtées');
  } catch (e) { appendLog('ERROR', e.message); }
}

/* Auto Bouffe ne s'enregistre jamais dans le registre _runners de l'engine
   (boucle JS pure côté renderer, voir page-autobouffe.js) — `stop_all` ne peut
   donc pas l'atteindre. Sans cet appel, F12, le bouton stop de l'overlay et la
   révocation de licence (les trois convergent ici) arrêtaient les macros en
   annonçant "Toutes les macros arrêtées" pendant qu'Auto Bouffe continuait à
   forcer le focus et à taper dans le jeu. */
function _stopRendererLoops() {
  if (typeof stopAutoBouffe === 'function' && typeof _abfRunning !== 'undefined' && _abfRunning) {
    stopAutoBouffe();
    appendLog('INFO', 'Auto Bouffe arrêté');
  }
}

async function stopAllMacros() {
  _stopRendererLoops();
  try {
    await ensureEngine();
    await window.api.stopAll();
    runningMacros.clear();
    updateMacroRunButtons();
    renderDashboard();
    appendLog('INFO', 'Toutes les macros arrêtées');
  } catch (e) { appendLog('ERROR', e.message); }
}

async function stopMacroByName(name) {
  try {
    await window.api.macroStop({ macro_id: name });
    runningMacros.delete(name);
    renderDashboard();
    updateMacroRunButtons();
    appendLog('INFO', 'Macro arrêtée: ' + name);
  } catch (e) { appendLog('ERROR', e.message); }
}

async function startMacro(idx) {
  if (idx < 0 || idx >= macros.length) return;
  // Only flush form data if the modal is open for this exact macro
  const modal = document.getElementById('macro-modal');
  const modalOpen = modal && modal.style.display !== 'none';
  if (modalOpen && currentMacroIdx === idx && macros[idx]) {
    try { flushEditorToMacro(); } catch (e) {}
  }
  currentMacroIdx = idx;
  const macro = macros[idx];
  try {
    await ensureEngine();
    const settings = await window.api.readSettings().catch(() => ({}));
    await window.api.setWebhook(buildWebhookConfig(settings));
    await window.api.macroStart({ macro, macro_id: macro.name });
    runningMacros.add(macro.name);
    updateMacroRunButtons();
    renderDashboard();
    appendLog('INFO', 'Macro démarrée: ' + macro.name);
  } catch (e) { appendLog('ERROR', 'Erreur démarrage: ' + e.message); }
}

/* ── Recording ─────────────────────────────────────────────── */
async function toggleRecording() {
  if (isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (currentMacroIdx < 0) {
    appendLog('WARNING', 'Sélectionnez ou créez une macro avant d\'enregistrer');
    return;
  }
  try {
    await ensureEngine();
    const res = await window.api.recordStart();
    if (res.ok === false) {
      appendLog('ERROR', 'Erreur record: ' + (res.error || ''));
      return;
    }
    isRecording = true;
    recordedActions = [];
    updateRecordingUI(true);
    appendLog('INFO', 'Enregistrement démarré — effectuez vos actions (clavier/souris)');
  } catch (e) {
    appendLog('ERROR', 'Erreur record: ' + e.message);
  }
}

async function stopRecording() {
  try {
    const res = await window.api.recordStop();
    isRecording = false;
    const actions = res.actions || recordedActions;
    updateRecordingUI(false);

    if (actions.length === 0) {
      appendLog('INFO', 'Enregistrement terminé — aucune action capturée');
      return;
    }

    // Add recorded actions to the current macro
    if (currentMacroIdx >= 0) {
      const macro = macros[currentMacroIdx];
      macro.rules = macro.rules || [];

      // Create a new rule with all recorded actions
      const rule = {
        id: 'rule_rec_' + Date.now(),
        label: 'Enregistré (' + actions.length + ' actions)',
        enabled: true,
        condition_mode: 'none',
        conditions: [],
        actions: actions,
        stop_on_match: false,
      };
      macro.rules.push(rule);
      renderRules();
      appendLog('INFO', `Enregistrement terminé — ${actions.length} actions ajoutées`);
    }
  } catch (e) {
    isRecording = false;
    updateRecordingUI(false);
    appendLog('ERROR', 'Erreur stop record: ' + e.message);
  }
}

function updateRecordingUI(recording) {
  const btnRec  = document.getElementById('btn-record-macro');
  const btnStop = document.getElementById('btn-stop-record');
  const badge   = document.getElementById('macro-recording-badge');
  if (btnRec)  btnRec.style.display  = recording ? 'none' : '';
  if (btnStop) btnStop.style.display = recording ? '' : 'none';
  if (badge)   badge.style.display   = recording ? '' : 'none';
}

function setupRecordingEvents() {
  window.api.onRecordEvent(action => {
    recordedActions.push(action);
  });
}
