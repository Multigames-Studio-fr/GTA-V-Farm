/* ── Auto Bouffe page ────────────────────────────────────── */
let _abfRunning  = false;
let _abfBound    = false;      // guard against duplicate event listener registration
let _abfCapturing = null;      // { el, fieldId } while waiting for key press
let abfNextCycleAt = null;     // timestamp ms of the next scheduled cycle (read by the dashboard), null when stopped
let abfCycleIntervalMs = 0;     // interval (ms) used to schedule abfNextCycleAt — read by the overlay feed (meal progress)

// Incremented on every start. _abfIntervalLoop captures its value and bails out
// as soon as it no longer matches, so a loop left over from a previous run can
// never resurrect itself: Stop → Start used to leave the OLD loop sleeping in a
// timer that resolved true, saw _abfRunning back at true, and resumed alongside
// the new one (two loops eating on offset schedules, double the API spend).
let _abfLoopGen = 0;

const _ABF_STORAGE_KEY = 'abf_settings';

const _ABF_MIN_INTERVAL_S = 30;

const _ABF_FIELDS = [
  { id: 'abf-key-inventory', type: 'str', def: ''      },
  { id: 'abf-key-trunk',     type: 'str', def: ''      },
  { id: 'abf-h',             type: 'int', def: 2       },
  { id: 'abf-m',             type: 'int', def: 0       },
  { id: 'abf-s',             type: 'int', def: 0       },
  { id: 'abf-eat-x',         type: 'int', def: 0       },
  { id: 'abf-eat-y',         type: 'int', def: 0       },
  { id: 'abf-eat-button',    type: 'str', def: 'right' },
  { id: 'abf-eat-clicks',    type: 'int', def: 1       },
  { id: 'abf-drink-x',       type: 'int', def: 0       },
  { id: 'abf-drink-y',       type: 'int', def: 0       },
  { id: 'abf-drink-button',  type: 'str', def: 'right' },
  { id: 'abf-drink-clicks',  type: 'int', def: 1       },
  { id: 'abf-moondream-key', type: 'str', def: ''      },
];

// IA state-detection zone is calibrated once as a % of the game window's rect
// (not absolute screen pixels) so it keeps tracking correctly if the window
// moves or is resized — the window itself is re-resolved by title/exe on
// every detection cycle instead of trusting a possibly-stale hwnd.
let _abfWindowTitle    = null; // string — game window title captured at detect time
let _abfWindowExe      = null; // string — its exe, extra matching signal
let _abfStateZoneRel   = null; // { relX, relY, relW, relH } — fractions 0..1 of the window rect

// Third-panel retry/wait tuning
const _ABF_MAX_CLOSE_RETRIES = 3;
const _ABF_UI_DELAY_MS       = 500; // wait for inventory open/close animation

// Fraction of the calibrated zone's width checked on each side (own title on
// the far left, 3rd-party title on the far right) — deliberately less than
// 50% so the middle (action button column, always present) is never read.
const _ABF_SIDE_FRACTION = 0.3;

// Asking the model to directly classify the whole zone (OWN/THIRD/CLOSED, or
// "list every title") turned out unreliable in testing: it defaults to one
// answer, ignores a second title elsewhere in a wide image, or hallucinates.
// A plain "what text is at the top" question is reliable, but ONLY on a
// small crop showing a single title location — on the full wide zone (own
// title on the left, 3rd-party title on the right) it silently reports only
// one side and ignores the other. So the single user-calibrated zone is
// split into two edge crops internally (own inventory is always on the left,
// any vehicle/crate/container panel always opens on the right, see
// _ABF_SIDE_FRACTION) and asked about independently — one calibration click
// for the user, two small reliable questions under the hood.
const _ABF_TITLE_QUESTION =
  "What text, if any, is written at the top of this image? Reply with just the text, " +
  "or NONE if there is no text.";

/* Called by navigate() in app.js when entering the Auto Bouffe page */
async function initAutoBouffe() {
  _abfLoad();
  _abfBindAutoSave();
  _abfEnforceMinInterval();
}

/* Every precondition a cycle needs, checked in one place. Returns an error
   message, or null when the config is usable. Previously these checks were
   duplicated (and had already drifted apart) between _abfIntervalLoop and
   _abfForceCycle, and neither validated the two settings whose absence is
   silent and fatal: the Moondream API key and the calibrated zone. Without
   them _abfDetectState returns 'unknown' forever and the cycle degenerates
   into tapping the inventory key open once per interval. */
function _abfValidateConfig() {
  if (!document.getElementById('abf-key-inventory').value) return 'touche inventaire non configurée';
  if (!_abfWindowTitle)   return 'fenêtre du jeu non choisie — clique "Choisir fenêtre"';
  if (!_abfStateZoneRel)  return 'zone de détection non calibrée — clique "Bande titre"';
  if (!document.getElementById('abf-moondream-key')?.value.trim()) {
    return 'clé API Moondream Cloud manquante — colle-la dans "Détection IA"';
  }
  const eatX = parseInt(document.getElementById('abf-eat-x').value) || 0;
  const eatY = parseInt(document.getElementById('abf-eat-y').value) || 0;
  if (eatX === 0 && eatY === 0) return 'point Manger non configuré (0,0)';
  const drinkX = parseInt(document.getElementById('abf-drink-x').value) || 0;
  const drinkY = parseInt(document.getElementById('abf-drink-y').value) || 0;
  if (drinkX === 0 && drinkY === 0) return 'point Boire non configuré (0,0)';
  return null;
}

function startAutoBouffe() {
  if (_abfRunning) return;
  // Validate BEFORE flipping the status to "En cours" — otherwise the UI
  // claimed to be running for a whole interval before the loop noticed.
  const err = _abfValidateConfig();
  if (err) {
    appendLog('WARNING', 'Auto Bouffe: démarrage impossible — ' + err + '.');
    return;
  }
  _abfRunning = true;
  document.getElementById('abf-btn-start').disabled = true;
  document.getElementById('abf-btn-stop').disabled  = false;
  document.getElementById('abf-status').textContent = '🟢 En cours…';
  _abfNotifyWebhook('autobouffe_start');
  _abfPushSnapshot();
  _abfIntervalLoop(++_abfLoopGen);
}

function stopAutoBouffe() {
  _abfRunning = false;
  _abfLoopGen++;      // invalidate any loop still in flight
  _abfCancelWaits();  // wake it now instead of up to `intervalMs` from now
  abfNextCycleAt = null;
  document.getElementById('abf-btn-start').disabled = false;
  document.getElementById('abf-btn-stop').disabled  = true;
  document.getElementById('abf-status').textContent = 'Arrêté';
  _abfNotifyWebhook('autobouffe_stop');
  _abfPushSnapshot();
}

/* Auto Bouffe never touches the engine's macro registry (pure JS interval
   loop, see _abfIntervalLoop) so unlike macros/Auto Clicker it never goes
   through macro_runner.py's webhook path — sent directly here instead.
   No early return on an empty user URL: the engine decides the routing (user
   channel needs a URL, the dev debug channel only needs consent). */
async function _abfNotifyWebhook(event) {
  try {
    const settings = await window.api.readSettings().catch(() => ({}));
    await window.api.setWebhook(buildWebhookConfig(settings)).catch(() => {});
    await window.api.sendWebhook({ event, data: { name: 'Auto Bouffe' } });
  } catch (_) {}
}

/* ── Low-level helpers (single action/wait, checked against _abfRunning) ── */
// Every _abfWait currently sleeping, so Stop can resolve them immediately.
// The previous implementation only sampled _abfRunning ONCE, before the sleep,
// then resolved true unconditionally — so Stop during the (typically hours
// long) inter-meal wait was not noticed until the timer finally fired.
const _abfPendingWaits = new Set();

function _abfCancelWaits() {
  for (const w of _abfPendingWaits) {
    clearTimeout(w.timer);
    w.resolve(false);
  }
  _abfPendingWaits.clear();
}

/* Resolves true if the full delay elapsed while still running, false if Stop
   interrupted it (callers treat false as "abort the cycle immediately"). */
function _abfWait(ms) {
  if (!_abfRunning) return Promise.resolve(false);
  return new Promise(resolve => {
    const entry = { resolve };
    entry.timer = setTimeout(() => {
      _abfPendingWaits.delete(entry);
      resolve(_abfRunning);
    }, ms);
    _abfPendingWaits.add(entry);
  });
}

async function _abfKeyTap(key) {
  if (!key) return;
  await _abfFocusGameWindow();
  try {
    const res = await window.api.execAction({ type: 'key_tap', key });
    if (res && res.ok === false) appendLog('WARNING', `Auto Bouffe: touche "${key}" — action échouée: ` + (res.error || '?'));
  } catch (e) { appendLog('WARNING', `Auto Bouffe: touche "${key}" indisponible: ` + (e.message || e)); }
}

async function _abfClick(x, y, button) {
  await _abfFocusGameWindow();
  try {
    const res = await window.api.execAction({ type: 'mouse_click', x, y, button: button || 'left', count: 1 });
    if (res && res.ok === false) appendLog('WARNING', 'Auto Bouffe: clic — action échouée: ' + (res.error || '?'));
  } catch (e) { appendLog('WARNING', 'Auto Bouffe: clic indisponible: ' + (e.message || e)); }
}

/* ── IA-based detection (single calibration zone, no reference image) ─────
   Pixel-color/OCR/template-matching all proved too brittle for this — a
   vision-language model hosted on Moondream Cloud instead just answers a
   plain-text question about the calibrated zone: closed / own inventory /
   own + a 3rd-party panel (vehicle/crate/box). Requires a free API key
   (moondream.ai), entered in abf-moondream-key and sent with every ask. ── */
function _abfNoTitleDetected(raw) {
  const norm = raw.trim().toLowerCase();
  return !norm || /\bnone\b/.test(norm) || norm.includes('no discernible') || norm.includes('no text');
}

/* The moondream2-era VRAM warmup/unload helpers used to be called around every
   scan. They are no-ops on both sides now (Moondream Cloud holds no local
   model — see main.py _cmd_vlm_warmup) and only produced two extra IPC
   round-trips per cycle plus log lines that lied to the user about
   "préchauffage IA" and freeing VRAM. Removed with the interval rewrite; the
   vlm_warmup/vlm_unload IPC commands still exist for interface compatibility. */

/* `debug` gates only the verbose per-crop transcript, which is noise outside
   the Tester button. Failures are ALWAYS logged: they used to be gated too,
   and since the real cycle never passed debug, a missing API key or a 401 was
   completely silent — the run just degraded into "unknown" forever with a
   misleading "inventaire refermé" message as the only clue. */
async function _abfAskTitle(zone, debug, label) {
  const apiKey = document.getElementById('abf-moondream-key')?.value.trim() || '';
  if (!apiKey) {
    appendLog('WARNING', 'Auto Bouffe IA: clé API Moondream Cloud manquante — configure-la dans "Détection IA".');
    return null;
  }
  const res = await window.api.vlmAsk({ ...zone, question: _ABF_TITLE_QUESTION, api_key: apiKey });
  if (!res?.ok) {
    appendLog('WARNING', `Auto Bouffe IA (${label}) erreur: ` + (res?.error || 'réponse invalide'));
    return null;
  }
  const raw = String(res?.answer || '').trim();
  if (debug) appendLog('INFO', `Auto Bouffe IA (${label}) → "${raw}"`);
  return raw;
}

/* Re-find the game window by title/exe (not a stored hwnd, which goes stale
   if the window closes/reopens) — shared by rect resolution (for the %-based
   detection zone) and focus (so key/mouse actions reliably reach the game
   instead of whatever window currently has OS focus, e.g. this app).
   Short-cached: a full cycle calls this before every key/click (open,
   close/reopen retries, eat, drink, close, trunk reopen — up to ~8-10 times),
   each otherwise round-tripping to Python to re-enumerate every window and
   process on the system. The window's hwnd doesn't change within a couple
   seconds in practice, and a stale hit just fails the same way a miss
   already does (focus/rect calls on a dead hwnd are handled gracefully). */
let _abfWindowCache = null; // { match, ts }
const _ABF_WINDOW_CACHE_MS = 2000;

async function _abfFindGameWindow() {
  if (!_abfWindowTitle) return null;
  const now = Date.now();
  if (_abfWindowCache && (now - _abfWindowCache.ts) < _ABF_WINDOW_CACHE_MS) {
    return _abfWindowCache.match;
  }
  try {
    const res = await window.api.listWindows();
    const wins = res?.windows || [];
    const match = wins.find(w => w.title === _abfWindowTitle)
        || (_abfWindowExe && wins.find(w => w.exe && w.exe.toLowerCase() === _abfWindowExe.toLowerCase()))
        || wins.find(w => w.title && w.title.toLowerCase().includes('fivem'))
        || null;
    _abfWindowCache = { match, ts: now };
    return match;
  } catch (_) {
    return null;
  }
}

async function _abfResolveWindowRect() {
  const match = await _abfFindGameWindow();
  if (!match) return null;
  try {
    const rectRes = await window.api.getWindowRect({ hwnd: match.hwnd });
    return rectRes?.rect || null;
  } catch (_) {
    return null;
  }
}

/* Bring the game window to the foreground before sending it input — a mouse
   click happens to activate whatever window is under the cursor, but a key
   press does not, so without this, key_tap silently goes to whichever
   window currently has OS focus (e.g. this app while watching the logs)
   instead of the game. */
async function _abfFocusGameWindow() {
  const match = await _abfFindGameWindow();
  if (!match) {
    appendLog('WARNING', 'Auto Bouffe: fenêtre du jeu introuvable pour le focus — l\'action part peut-être vers la mauvaise fenêtre.');
    return;
  }
  try {
    await window.api.focusWindow({ hwnd: match.hwnd });
    await new Promise(r => setTimeout(r, 60)); // let SetForegroundWindow land before the input
  } catch (e) {
    appendLog('WARNING', 'Auto Bouffe: focus fenêtre échoué: ' + (e.message || e));
  }
}

async function _abfListWindowsForPicker() {
  const sel = document.getElementById('abf-window-select');
  if (!sel) return;
  try {
    await ensureEngine();
    const res = await window.api.listWindows();
    if (!res?.ok) {
      appendLog('WARNING', 'Auto Bouffe: liste fenêtres erreur: ' + (res?.error || 'réponse invalide'));
      return;
    }
    const wins = res?.windows || [];
    if (wins.length === 0) {
      appendLog('WARNING', 'Auto Bouffe: aucune fenêtre détectée.');
      return;
    }
    sel.innerHTML = '<option value="" disabled selected>— Choisir une fenêtre —</option>' +
      wins.map((w, i) => `<option value="${i}">${escHtml(w.title)} — ${escHtml(w.exe || '?')}</option>`).join('');
    sel.dataset.windows = JSON.stringify(wins);
    sel.style.display = '';
  } catch (e) {
    appendLog('WARNING', 'Liste fenêtres indisponible: ' + (e.message || e));
  }
}

function _abfSelectWindow(selectEl) {
  let wins = [];
  try { wins = JSON.parse(selectEl.dataset.windows || '[]'); } catch (_) {}
  const w = wins[selectEl.value];
  if (!w) return;
  _abfWindowTitle = w.title;
  _abfWindowExe = w.exe || null;
  _abfWindowCache = null; // invalidate — was keyed to whatever was picked before
  _abfUpdateWindowLabel();
  _abfSave();
  appendLog('INFO', `Auto Bouffe: fenêtre choisie "${w.title}"`);
}

function _abfUpdateWindowLabel() {
  const lbl = document.getElementById('abf-window-lbl');
  if (!lbl) return;
  lbl.textContent = _abfWindowTitle ? `🎮 ${_abfWindowTitle}` : '';
}

async function _abfDetectState(debug) {
  if (!_abfStateZoneRel) {
    appendLog('WARNING', 'Auto Bouffe IA: zone de détection non calibrée — clique "Bande titre".');
    return 'unknown';
  }
  const rect = await _abfResolveWindowRect();
  if (!rect) {
    appendLog('WARNING', 'Auto Bouffe IA: fenêtre du jeu introuvable — reclique "Choisir fenêtre" et sélectionne-la.');
    return 'unknown';
  }
  const winW = rect.right - rect.left;
  const winH = rect.bottom - rect.top;
  const w = Math.max(2, Math.round(_abfStateZoneRel.relW * winW));
  const h = Math.max(1, Math.round(_abfStateZoneRel.relH * winH));
  const x = Math.round(rect.left + _abfStateZoneRel.relX * winW);
  const y = Math.round(rect.top  + _abfStateZoneRel.relY * winH);
  // Only the outer edges of the calibrated zone are checked, not a strict
  // 50/50 split — a full-width own+3rd-party band also crosses the action
  // button column (Utiliser/Donner/Renommer/Supprimer) in the middle, which
  // is present whenever OUR OWN inventory is open regardless of whether a
  // 3rd-party panel exists, so a wider right half kept reading "Renommer,
  // Supprimer" as if it were a container title.
  const sideW = Math.max(1, Math.round(w * _ABF_SIDE_FRACTION));
  const leftZone  = { x, y, w: sideW, h };
  const rightZone = { x: x + w - sideW, y, w: sideW, h };
  try {
    const [leftRaw, rightRaw] = await Promise.all([
      _abfAskTitle(leftZone, debug, 'gauche/inventaire'),
      _abfAskTitle(rightZone, debug, 'droite/tiers'),
    ]);
    if (leftRaw === null || rightRaw === null) return 'unknown';
    const ownVisible   = leftRaw.toLowerCase().includes('inventaire');
    const thirdVisible = !_abfNoTitleDetected(rightRaw);
    if (thirdVisible) return 'third';
    if (ownVisible)   return 'own';
    return 'closed';
  } catch (e) {
    appendLog('WARNING', 'Auto Bouffe IA erreur: ' + (e.message || e));
    return 'unknown';
  }
}

const _ABF_STATE_LABELS = { own: 'inventaire seul', third: 'panneau tiers', closed: 'fermé', unknown: 'inconnu (IA)' };

/* One _abfDetectState() call already answers both "is anything open" and
   "is a 3rd panel open" at once — logging it here (instead of each call site
   re-deriving + re-announcing it) keeps the loop below to exactly one
   detection per checkpoint instead of two. */
async function _abfDetectStateLogged() {
  const state = await _abfDetectState();
  appendLog('INFO', 'Auto Bouffe: état — ' + (_ABF_STATE_LABELS[state] || state));
  return state;
}

/* Non-gated wait for _abfForceCycle (manual one-shot, runs to completion
   regardless of _abfRunning) — same signature as _abfWait (resolves a bool)
   so _abfRunCycle below doesn't need to know which caller it's in. */
function _abfPlainWait(ms) {
  return new Promise(resolve => setTimeout(() => resolve(true), ms));
}

/* ── Shared cycle body: open inventory, close any 3rd panel, eat, drink,
   close, restore 3rd panel — used by both _abfIntervalLoop (passes _abfWait,
   abortable by Stop) and _abfForceCycle (passes _abfPlainWait, always runs to
   completion). Returns { ok, outcome }: ok is false only if wait() aborted
   mid-cycle (caller should stop immediately, outcome is unset); ok is true
   otherwise, with outcome a short human-readable summary of what happened
   (surfaced by _abfForceCycle next to its button). ── */
function _abfPushSnapshot() {
  try { if (typeof sessionStats !== 'undefined') sessionStats.pushSnapshot(); } catch (e) { /* ignore */ }
}

/* Session stats + failure collection. Failures of one cycle (meal and/or
   trunk) are flushed as ONE autobouffe_fail alert by _abfRunCycle. Never throws. */
let _abfCycleFails = [];
function _abfRecord(kind, outcome) {
  try {
    if (typeof sessionStats === 'undefined') return;
    sessionStats.recordAbf(kind);
    if (kind === 'mealFail' || kind === 'trunkFail') _abfCycleFails.push(outcome);
  } catch (e) { /* stats must never break a cycle */ }
}

/* Wrapper: one alert per failing cycle + snapshot push at the end of every cycle. */
async function _abfRunCycle(wait) {
  _abfCycleFails = [];
  try {
    return await _abfRunCycleInner(wait);
  } finally {
    const fails = _abfCycleFails.filter((o, i, a) => !a.some((p, j) => j > i && String(p).includes(o)));
    _abfCycleFails = [];
    if (fails.length) {
      try {
        const p = window.api.sendWebhook({ event: 'autobouffe_fail', data: { outcome: fails.join(' ; '), message: 'Cycle Auto Bouffe en échec' } });
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
      try {
        if (typeof overlayFeed !== 'undefined') overlayFeed.alert('Auto Bouffe', 'Cycle en échec — ' + fails.join(' ; '));
      } catch (e) { /* ignore */ }
    }
    _abfPushSnapshot();
  }
}

async function _abfRunCycleInner(wait) {
  const invKey = document.getElementById('abf-key-inventory').value;
  const trunkKey = document.getElementById('abf-key-trunk').value;
  let hadThirdPanel = false; // was a trunk/vehicle/crate open before we forced it closed to eat?
  let outcome = '';
  let closeUncertain = false;

  appendLog('INFO', 'Auto Bouffe: cycle — analyse de l\'écran…');
  let state = await _abfDetectStateLogged();

  // 1. Make sure OUR OWN inventory is actually open — the key toggles, so
  //    pressing it blind could just as easily close it if it were already
  //    open (e.g. left open from a previous failed cycle).
  if (state === 'closed') {
    appendLog('INFO', 'Auto Bouffe: inventaire fermé — ouverture…');
    await _abfKeyTap(invKey);
    if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
    state = await _abfDetectStateLogged();
    if (state === 'closed') {
      appendLog('WARNING', 'Auto Bouffe: impossible de confirmer l\'ouverture de l\'inventaire — cycle passé.');
      _abfRecord('mealFail', 'inventaire jamais confirmé ouvert');
      return { ok: true, outcome: 'inventaire jamais confirmé ouvert' };
    }
  }

  // 2. If a 3rd panel (vehicle/crate/etc.) is also open, close EVERYTHING
  //    with the inventory key (it closes any open panel, own or 3rd-party —
  //    the trunk key is only for opening the trunk, never for closing it)
  //    then reopen just our own inventory. Retry a bounded number of times.
  //    Remember it was open so step 4b can restore it later with trunkKey.
  let aborted = false;
  for (let i = 0; i < _ABF_MAX_CLOSE_RETRIES && state === 'third' && !aborted; i++) {
    hadThirdPanel = true;
    appendLog('INFO', `Auto Bouffe: panneau tiers détecté — fermeture puis réouverture inventaire seul (tentative ${i + 1}/${_ABF_MAX_CLOSE_RETRIES})…`);
    await _abfKeyTap(invKey); // close everything
    if (!(await wait(_ABF_UI_DELAY_MS))) { aborted = true; break; }
    await _abfKeyTap(invKey); // reopen our own inventory only
    if (!(await wait(_ABF_UI_DELAY_MS))) { aborted = true; break; }
    state = await _abfDetectStateLogged();
  }
  if (aborted) return { ok: false };

  if (state === 'third') {
    appendLog('WARNING', 'Auto Bouffe: panneau tiers toujours ouvert après plusieurs tentatives — cycle passé.');
    outcome = 'panneau tiers toujours ouvert — repas sauté';
    _abfRecord('mealFail', outcome);
  } else if (state === 'unknown') {
    // Kept distinct from 'closed': the two used to share one message that
    // blamed the inventory, hiding the real cause (no API key, HTTP error,
    // game window gone). _abfAskTitle/_abfDetectState have now logged the
    // actual reason just above this line.
    appendLog('WARNING', 'Auto Bouffe: état de l\'inventaire indéterminé (l\'IA n\'a pas répondu) — cycle passé, voir l\'erreur ci-dessus.');
    outcome = 'état indéterminé — repas sauté';
    _abfRecord('mealFail', outcome);
  } else if (state !== 'own') {
    appendLog('WARNING', 'Auto Bouffe: inventaire fermé après les tentatives de réouverture — cycle passé.');
    outcome = 'inventaire refermé avant de pouvoir manger';
    _abfRecord('mealFail', outcome);
  } else {
    // 3. Eat, then drink — each repeated abf-*-clicks times (configurable,
    //    e.g. eating 2+ items per cycle), one _ABF_UI_DELAY_MS pause
    //    between clicks so the game processes each one individually.
    const eatX = parseInt(document.getElementById('abf-eat-x').value) || 0;
    const eatY = parseInt(document.getElementById('abf-eat-y').value) || 0;
    const eatBtn = document.getElementById('abf-eat-button').value;
    const eatClicks = Math.max(1, parseInt(document.getElementById('abf-eat-clicks').value) || 1);
    appendLog('INFO', `Auto Bouffe: mange (${eatClicks}×)…`);
    for (let i = 0; i < eatClicks; i++) {
      await _abfClick(eatX, eatY, eatBtn);
      if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
    }

    const drinkX = parseInt(document.getElementById('abf-drink-x').value) || 0;
    const drinkY = parseInt(document.getElementById('abf-drink-y').value) || 0;
    const drinkBtn = document.getElementById('abf-drink-button').value;
    const drinkClicks = Math.max(1, parseInt(document.getElementById('abf-drink-clicks').value) || 1);
    appendLog('INFO', `Auto Bouffe: boit (${drinkClicks}×)…`);
    for (let i = 0; i < drinkClicks; i++) {
      await _abfClick(drinkX, drinkY, drinkBtn);
      if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
    }
    outcome = `mangé ${eatClicks}×, bu ${drinkClicks}×`;
    _abfRecord('meal', outcome);
  }

  // 4. Close the inventory — ONLY when something is actually open. The key is
  //    a toggle, so tapping it on a 'closed'/'unknown' state OPENS the menu
  //    instead of closing it. This used to be unconditional (justified by "we
  //    just ate, so it must be open"), but it also ran on the failure branches
  //    above where nothing was eaten — so a run without an API key left the
  //    player's inventory forced open in game, every single cycle.
  if (state === 'own' || state === 'third') {
    appendLog('INFO', 'Auto Bouffe: ferme l\'inventaire…');
    await _abfKeyTap(invKey);
    if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
    state = await _abfDetectStateLogged();
    if (state !== 'closed') {
      appendLog('WARNING', 'Auto Bouffe: l\'inventaire semble toujours ouvert après fermeture.');
      closeUncertain = true;
    }
  } else if (state === 'closed') {
    // Already closed and we know it — nothing to do, and the trunk restore
    // below is still safe to run.
    appendLog('INFO', 'Auto Bouffe: inventaire déjà fermé — touche non envoyée.');
  } else {
    // 'unknown': the menu state is genuinely unknown, so neither closing nor
    // reopening the trunk can be done safely.
    appendLog('INFO', 'Auto Bouffe: état inconnu — touche inventaire non envoyée (elle ouvrirait le menu).');
    closeUncertain = true;
  }

  // 4b. A trunk/vehicle/crate was open before we ate — reopen it with its
  //     own key (separate from the inventory toggle) to restore the state
  //     the player was in. Only when step 4 actually confirmed a closed menu:
  //     the trunk key only opens correctly from a fully closed state, and
  //     firing it blind on top of a still-open menu makes things worse.
  if (hadThirdPanel) {
    if (closeUncertain) {
      appendLog('WARNING', 'Auto Bouffe: fermeture non confirmée — réouverture du coffre annulée (elle ne fonctionne que menu fermé).');
    } else if (!trunkKey) {
      appendLog('WARNING', 'Auto Bouffe: panneau tiers refermé mais touche coffre non configurée — pas de réouverture.');
    } else {
      // Verified + retried: the inventory close animation can still be
      // running when the first tap lands, and the game just drops it. Only
      // retry on a confirmed 'closed' — on 'unknown' (AI failure) a second
      // tap could just as well toggle a trunk that did open back shut.
      for (let i = 0; i < _ABF_MAX_CLOSE_RETRIES; i++) {
        appendLog('INFO', `Auto Bouffe: réouverture du coffre/véhicule (tentative ${i + 1}/${_ABF_MAX_CLOSE_RETRIES})…`);
        await _abfKeyTap(trunkKey);
        if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
        state = await _abfDetectStateLogged();
        if (state !== 'closed') break;
        if (!(await wait(_ABF_UI_DELAY_MS))) return { ok: false };
      }
      if (state === 'closed') {
        appendLog('WARNING', `Auto Bouffe: le coffre ne s'est pas rouvert avec la touche "${trunkKey}" — re-capture la touche dans le champ "Touche coffre/véhicule".`);
        outcome += ' — coffre non rouvert';
        _abfRecord('trunkFail', outcome);
      } else {
        _abfRecord('trunk', outcome);
      }
    }
  }
  return { ok: true, outcome: outcome + (closeUncertain ? ' (fermeture incertaine)' : '') };
}

/* ── Main interval-mode cycle ─────────────────────────────── */
/* `gen` is the generation token this loop was started with — any mismatch
   means a newer Start (or a Stop) has superseded it and it must exit. */
async function _abfIntervalLoop(gen) {
  try { await ensureEngine(); } catch (e) {
    appendLog('ERROR', 'Auto Bouffe: ' + e.message);
    stopAutoBouffe();
    return;
  }
  while (_abfRunning && gen === _abfLoopGen) {
    // Re-checked every iteration, not just at Start: the fields stay editable
    // while running, so a point can be cleared mid-session.
    const err = _abfValidateConfig();
    if (err) {
      appendLog('WARNING', 'Auto Bouffe: ' + err + ' — arrêt.');
      stopAutoBouffe();
      return;
    }
    const h = parseInt(document.getElementById('abf-h').value) || 0;
    const m = parseInt(document.getElementById('abf-m').value) || 0;
    const s = parseInt(document.getElementById('abf-s').value) || 0;
    const intervalMs = Math.max(_ABF_MIN_INTERVAL_S, h * 3600 + m * 60 + s) * 1000;

    abfNextCycleAt = null; // cycle running now — dashboard shows "Cycle en cours…"
    const result = await _abfRunCycleExclusive(_abfWait);
    if (!result.ok || gen !== _abfLoopGen) return;

    if (!_abfRunning || gen !== _abfLoopGen) return; // stopped meanwhile — don't resurrect a next-meal time
    abfCycleIntervalMs = intervalMs;
    abfNextCycleAt = Date.now() + intervalMs;
    appendLog('INFO', `Auto Bouffe: cycle terminé (${result.outcome}) — ` +
      `prochain dans ${Math.round(intervalMs / 1000)}s.`);
    if (!(await _abfWait(intervalMs))) return;
  }
}

// True while a cycle (interval tick or forced) is executing, from either
// caller — without this, the interval loop firing at the same moment as a
// user-triggered "Forcer un cycle" ran two _abfRunCycle()s concurrently,
// each tapping the inventory/eat/drink keys against the same game window
// with no awareness of the other (one cycle's "open inventory" step could
// close what the other had just opened).
let _abfCycleInFlight = false;

async function _abfRunCycleExclusive(wait) {
  if (_abfCycleInFlight) {
    appendLog('WARNING', 'Auto Bouffe: un autre cycle est déjà en cours — celui-ci est sauté.');
    return { ok: true, outcome: 'sauté (un autre cycle était déjà en cours)' };
  }
  _abfCycleInFlight = true;
  try {
    return await _abfRunCycle(wait);
  } finally {
    _abfCycleInFlight = false;
  }
}

/* ── Manual "force a cycle now" — same steps as the interval loop (open,
   close 3rd panel, eat, drink, close, restore) but triggered once, on
   demand, independent of the h/m/s interval and _abfRunning. Runs to
   completion (uses _abfPlainWait, not the abortable _abfWait) since it's a
   short one-shot foreground action, not something Stop needs to interrupt. */
let _abfForcing = false; // re-entrancy guard — ignore a second click while one is in flight
async function _abfForceCycle() {
  if (_abfForcing) {
    appendLog('WARNING', 'Auto Bouffe: cycle forcé déjà en cours.');
    return;
  }
  const resultEl = document.getElementById('abf-force-cycle-result');
  // Same preconditions as a scheduled run — this used to check a narrower
  // (and diverging) subset, so a forced cycle could start without an API key
  // or a calibrated zone and fail in a way nothing explained.
  const err = _abfValidateConfig();
  if (err) {
    appendLog('WARNING', 'Auto Bouffe: cycle forcé impossible — ' + err + '.');
    if (resultEl) { resultEl.textContent = '❌ ' + err; resultEl.style.color = 'var(--accent)'; }
    return;
  }
  if (resultEl) { resultEl.textContent = '⏳ Cycle forcé en cours…'; resultEl.style.color = 'var(--text-2)'; }
  _abfForcing = true;
  try {
    await ensureEngine();
    appendLog('INFO', 'Auto Bouffe: cycle forcé…');
    const result = await _abfRunCycleExclusive(_abfPlainWait);
    appendLog('INFO', 'Auto Bouffe: cycle forcé terminé — ' + result.outcome);
    const succeeded = result.outcome.startsWith('mangé');
    if (resultEl) {
      resultEl.textContent = (succeeded ? '✅ ' : '⚠️ ') + result.outcome;
      resultEl.style.color = succeeded ? 'var(--green)' : 'var(--accent)';
    }
  } catch (e) {
    appendLog('ERROR', 'Auto Bouffe: cycle forcé — ' + e.message);
    if (resultEl) { resultEl.textContent = '❌ ' + e.message; resultEl.style.color = 'var(--accent)'; }
  } finally {
    _abfForcing = false;
  }
}

/* ── Interval validation (min 30s) ────────────────────────── */
function _abfEnforceMinInterval() {
  const hEl = document.getElementById('abf-h');
  const mEl = document.getElementById('abf-m');
  const sEl = document.getElementById('abf-s');
  const warnEl = document.getElementById('abf-interval-warning');
  if (!hEl || !mEl || !sEl) return;

  const h = parseInt(hEl.value) || 0;
  const m = parseInt(mEl.value) || 0;
  const s = parseInt(sEl.value) || 0;
  const totalS = h * 3600 + m * 60 + s;

  if (totalS < _ABF_MIN_INTERVAL_S) {
    hEl.value = 0; mEl.value = 0; sEl.value = _ABF_MIN_INTERVAL_S;
    if (warnEl) {
      warnEl.style.display = 'block';
      clearTimeout(_abfEnforceMinInterval._t);
      _abfEnforceMinInterval._t = setTimeout(() => { warnEl.style.display = 'none'; }, 3000);
    }
  }
}

/* ── Save / load (localStorage, same convention as Auto Clicker) ── */
function _abfSave() {
  const data = {};
  _ABF_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    data[f.id] = f.type === 'bool' ? el.checked : el.value;
  });
  data.windowTitle = _abfWindowTitle;
  data.windowExe = _abfWindowExe;
  data.stateZoneRel = _abfStateZoneRel;
  localStorage.setItem(_ABF_STORAGE_KEY, JSON.stringify(data));
}

function _abfLoad() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(_ABF_STORAGE_KEY) || '{}'); } catch (_) {}
  _ABF_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const val = data[f.id] !== undefined ? data[f.id] : f.def;
    if (f.type === 'bool') { el.checked = val === true || val === 'true'; }
    else                   { el.value = val; }
  });
  _abfWindowTitle = data.windowTitle || null;
  _abfWindowExe = data.windowExe || null;
  _abfUpdateWindowLabel();
  _abfStateZoneRel = data.stateZoneRel || null;
  _abfUpdateStateZoneLabel();
}

function _abfBindAutoSave() {
  if (_abfBound) return;
  _abfBound = true;
  _ABF_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const evt = (f.type === 'bool' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, _abfSave);
  });
  // Enforce the 30s minimum on blur only (not every keystroke), so typing a
  // multi-digit value like "45" isn't fought/clamped mid-edit.
  ['abf-h', 'abf-m', 'abf-s'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      _abfEnforceMinInterval();
      _abfSave();
    });
  });
}

/* ── Hotkey capture (inventaire) ──────────────────────────── */
function _abfCapKey(el, fieldId) {
  _abfCapturing = { el, fieldId };
  el.value = '⏳ Appuyer sur une touche…';
  el.style.color = 'var(--accent)';
  document.removeEventListener('keydown', _abfCaptureHandler, true);
  document.addEventListener('keydown', _abfCaptureHandler, true);
}

// Keys are sent with pydirectinput (QWERTY-position scancodes) — the shared
// keyNameFromEvent() (utils.js) derives the name from the physical key.
function _abfCaptureHandler(e) {
  if (!_abfCapturing) return;
  const key = keyNameFromEvent(e);
  e.preventDefault();
  e.stopPropagation();
  _abfCapturing.el.value       = key;
  _abfCapturing.el.style.color = '';
  _abfCapturing = null;
  _abfSave();
}

/* ── Point pickers (Manger / Boire) ──────────────────────── */
async function _abfPickPoint(which) {
  try {
    const pos = await window.api.pickPoint();
    if (!pos) return;
    document.getElementById(`abf-${which}-x`).value = pos.x;
    document.getElementById(`abf-${which}-y`).value = pos.y;
    _abfSave();
  } catch (e) { appendLog('WARNING', 'Sélecteur de point indisponible: ' + (e.message || e)); }
}

/* Single immediate click, outside the interval cycle — lets the user verify
   a Manger/Boire point lands correctly without waiting for a full cycle. */
async function _abfTestPoint(which) {
  const x = parseInt(document.getElementById(`abf-${which}-x`).value) || 0;
  const y = parseInt(document.getElementById(`abf-${which}-y`).value) || 0;
  const btn = document.getElementById(`abf-${which}-button`).value;
  const label = which === 'eat' ? 'Manger' : 'Boire';
  if (x === 0 && y === 0) {
    appendLog('WARNING', `Auto Bouffe: point ${label} non configuré (0,0).`);
    return;
  }
  await ensureEngine();
  appendLog('INFO', `Auto Bouffe: test clic ${label} à (${x},${y})…`);
  await _abfClick(x, y, btn);
}

/* ── Single IA calibration zone picker (stored relative to the game
   window) + manual test ──────────────────────────────────── */
async function _abfPickStateZone() {
  if (!_abfWindowTitle) {
    appendLog('WARNING', 'Auto Bouffe: choisis d\'abord la fenêtre du jeu ("Choisir fenêtre").');
    return;
  }
  const rect = await _abfResolveWindowRect();
  if (!rect) {
    appendLog('WARNING', 'Auto Bouffe: fenêtre du jeu introuvable — ouvre FiveM d\'abord.');
    return;
  }
  try {
    const res = await window.api.pickRegion();
    if (!res) return;
    const winW = rect.right - rect.left;
    const winH = rect.bottom - rect.top;
    _abfStateZoneRel = {
      relX: (res.x - rect.left) / winW,
      relY: (res.y - rect.top) / winH,
      relW: res.w / winW,
      relH: res.h / winH,
    };
    _abfUpdateStateZoneLabel();
    _abfSave();
  } catch (e) { appendLog('WARNING', 'Sélecteur de zone indisponible: ' + (e.message || e)); }
}

async function _abfTestStateZone() {
  const resultEl = document.getElementById('abf-state-test-result');
  if (!_abfStateZoneRel) {
    appendLog('WARNING', 'Auto Bouffe: détecte la fenêtre puis dessine la bande titre d\'abord.');
    return;
  }
  if (resultEl) { resultEl.textContent = '… (IA en cours, peut prendre plusieurs secondes)'; resultEl.style.color = 'var(--text-2)'; }
  try {
    await ensureEngine();
    const state = await _abfDetectState(true);
    if (resultEl) {
      const labels = {
        own:     ['🟢 Inventaire seul',        'var(--green)'],
        third:   ['🟠 Panneau tiers détecté',  'var(--accent)'],
        closed:  ['🔴 Fermé',                  'var(--text-2)'],
        unknown: ['⚠️ Réponse IA ambiguë',      'var(--accent)'],
      };
      const [text, color] = labels[state] || labels.unknown;
      resultEl.textContent = text;
      resultEl.style.color = color;
    }
  } catch (e) { appendLog('WARNING', 'Test indisponible: ' + (e.message || e)); }
}

function _abfUpdateStateZoneLabel() {
  const lbl = document.getElementById('abf-state-zone-lbl');
  if (!lbl) return;
  const r = _abfStateZoneRel;
  lbl.textContent = r
    ? `${(r.relX * 100).toFixed(1)}%,${(r.relY * 100).toFixed(1)}% — ${(r.relW * 100).toFixed(1)}%×${(r.relH * 100).toFixed(1)}%`
    : '';
}
