'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, dialog, screen } = require('electron');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const { spawn, execSync } = require('child_process');
const { checkForUpdates } = require('./updater');

// ── Config centralisée ────────────────────────────────────────────────────────
const APP_CONFIG = require('./app.config.json');

// ── Logger fichier ────────────────────────────────────────────────────────────
// Écrit dans <dossier du .bat>/app.log  (accessible même si la fenêtre ne s'ouvre pas)
const LOG_PATH = path.join(__dirname, '..', 'app.log');

function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function writeLog(level, ...args) {
  const line = `[${_ts()}] [${level}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line, 'utf-8'); } catch (_) {}
  if (level === 'ERROR' || level === 'WARN') console.error(line.trim());
  else console.log(line.trim());
}

// Vider le log au démarrage (garde les 500 dernières lignes si le fichier existe)
try {
  if (fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n');
    if (lines.length > 600) {
      fs.writeFileSync(LOG_PATH, lines.slice(-500).join('\n') + '\n', 'utf-8');
    }
  }
  writeLog('INFO', `═══ ${APP_CONFIG.appName} démarrage ═══`);
} catch (_) {}

// Capture globale des exceptions non gérées
process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'uncaughtException:', err.stack || err.message);
  // The process is in an undefined state past this point (Node's own
  // guidance) — don't leave the Python engine (and its game-input actions)
  // running unsupervised underneath a main process that might be about to
  // become unresponsive. Fire-and-forget: we're already in a crash path,
  // not waiting for confirmation here.
  try { killEngine(); } catch (_) {}
  try {
    dialog.showErrorBox('MacroEngine — Erreur fatale', err.stack || err.message);
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', 'unhandledRejection:', reason?.stack || String(reason));
});

// ── Chemins ───────────────────────────────────────────────────────────────────
const IS_PACKED      = app.isPackaged;
const BOT_DIR        = IS_PACKED
  ? path.join(process.resourcesPath, 'bot')
  : path.join(__dirname, '..');
const RENDERER_DIR   = IS_PACKED
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'renderer')
  : path.join(__dirname, 'renderer');

// Secondary windows (picker/overlay) load from RENDERER_DIR like the main
// window, so auto-updated copies are used — falling back to the copy bundled
// in the asar if the unpacked file is somehow missing.
function _rendererFile(name) {
  const p = path.join(RENDERER_DIR, name);
  return fs.existsSync(p) ? p : path.join(__dirname, 'renderer', name);
}

const ROOT_DIR      = BOT_DIR;
const MAIN_PY       = path.join(BOT_DIR, 'main.py');
const USERDATA_DIR  = app.getPath('userData');
const MACROS_PATH   = path.join(USERDATA_DIR, 'macros.json');
// Separate file for the "Macros 🧪" sandbox tab — same editor/runner code as
// the real Macros page (see app.js's navigate() macros-beta remap), just a
// different JSON file, so bidouiller in the sandbox never touches real
// macros.json.
const MACROS_PATH_BETA = path.join(USERDATA_DIR, 'macros_beta.json');
const LICENSE_PATH  = path.join(USERDATA_DIR, 'license.json');
const SETTINGS_PATH = path.join(USERDATA_DIR, 'settings.json');
// Cible pip stable, hors de python-embed/ (qui, lui, est recree a chaque
// install/mise a jour/reextraction portable) — torch/transformers/easyocr
// installes ici survivent aux reinstalls, seul le marker + `pip install
// --target` change, plus jamais de re-telechargement une fois fait une fois.
const AI_DEPS_DIR   = path.join(USERDATA_DIR, 'ai-deps');
try { fs.mkdirSync(AI_DEPS_DIR, { recursive: true }); } catch (_) {}

// ── Résolution du chemin Python ───────────────────────────────────────────────
function resolvePython() {
  // 0. Variable injectée par le .bat (chemin local portable)
  if (process.env.PYTHON_OVERRIDE && fs.existsSync(process.env.PYTHON_OVERRIDE)) {
    return process.env.PYTHON_OVERRIDE;
  }

  // 1. Bundled embedded Python (ships with the app) — on cherche d'abord à la racine
  const embedDirs = IS_PACKED
    ? [path.join(process.resourcesPath, 'python-embed')]
    : [
        path.join(__dirname, '..', 'python-embed'), // racine du projet (nouvelle loc)
        path.join(__dirname, 'python-embed'),        // ancien emplacement fallback
      ];
  for (const d of embedDirs) {
    const exe = path.join(d, 'python.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // 2. where python (skip Windows Store stub)
  try {
    const out = execSync('where python', { windowsHide: true, timeout: 1000 }).toString();
    const real = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
                    .find(p => !p.toLowerCase().includes('windowsapps'));
    if (real) return real;
  } catch (_) {}
  // 3. py launcher
  try {
    const exe = execSync('py -3 -c "import sys;print(sys.executable)"', { windowsHide: true, timeout: 1000 })
                  .toString().trim();
    if (exe && fs.existsSync(exe)) return exe;
  } catch (_) {}
  // 4. Known install locations
  const dirs = ['Python311','Python312','Python313','Python310','Python39'];
  return [
    ...dirs.map(d => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', d, 'python.exe')),
    ...dirs.map(d => path.join('C:\\', d, 'python.exe')),
  ].find(p => fs.existsSync(p)) || null;
}

let PYTHON_EXE = resolvePython();

writeLog('INFO', 'BOT_DIR    :', BOT_DIR);
writeLog('INFO', 'MAIN_PY    :', MAIN_PY, '| existe:', fs.existsSync(MAIN_PY));
writeLog('INFO', 'PYTHON_EXE :', PYTHON_EXE || 'INTROUVABLE');
writeLog('INFO', 'NODE       :', process.version, '| Electron:', process.versions.electron);

// ── Settings helpers ─────────────────────────────────────────────────────────
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (_) { return {}; }
}

function saveSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  _atomicWrite(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// ── Global shortcuts state ───────────────────────────────────────────────────
let registeredShortcuts = {}; // { action: accelerator }

// ── License helpers ──────────────────────────────────────────────────────────
const LICENSE_GRACE_DAYS    = 7;
const LICENSE_TIMEOUT_MS    = 5000;

function readLicenseData() {
  try {
    if (!fs.existsSync(LICENSE_PATH)) return null;
    return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf-8'));
  } catch (_) { return null; }
}

function readLicense() {
  const d = readLicenseData();
  return d ? (d.key || null) : null;
}

function saveLicense(key) {
  fs.mkdirSync(path.dirname(LICENSE_PATH), { recursive: true });
  _atomicWrite(LICENSE_PATH, JSON.stringify({ key, validatedAt: Date.now() }));
}

function verifyLicenseOnline(key) {
  // Clé master hardcodée (bypass total)
  if (key === '140278161281') {
    return Promise.resolve({ valid: true, offline: false, master: true });
  }
  return new Promise((resolve) => {
    const safeKey = encodeURIComponent(key);
    const url = `${APP_CONFIG.licenseApiBase}/${APP_CONFIG.licenseApiId}/${safeKey}/verify`;

    // AbortController garantit un timeout total (DNS + connexion + réponse)
    // req.setTimeout ne couvre que l'inactivité socket, pas la résolution DNS
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ valid: false, offline: true });
    }, LICENSE_TIMEOUT_MS);

    const req = https.get(url, {
      headers: { 'User-Agent': `${APP_CONFIG.appName}/${app.getVersion()}` },
      signal: controller.signal,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(body);
          // data.result: raison précise renvoyée par LicenseGate — VALID, NOT_FOUND,
          // NOT_ACTIVE, EXPIRED, LICENSE_SCOPE_FAILED, IP_LIMIT_EXCEEDED, RATE_LIMIT_EXCEEDED
          resolve({ valid: !!data.valid, offline: false, result: data.result || null });
        } catch (_) {
          resolve({ valid: false, offline: false, result: null });
        }
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve({ valid: false, offline: true });
    });
  });
}

// ── Utilitaires ──────────────────────────────────────────────────────────────
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// ── État global ───────────────────────────────────────────────────────────────
let mainWindow    = null;
let overlayWindow = null;
let engineProc    = null;          // Python macro engine process
const _pending    = new Map();     // request id → { resolve, reject }
let _msgBuf       = '';            // line buffer for engine stdout
let _licenseRevoked = false;       // set by _onLicenseRevoked — engine refuses to (re)start

function _sendToOverlay(channel, data) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send(channel, data); } catch (_) {}
  }
}

// ── Fenêtre principale ────────────────────────────────────────────────────────
function createWindow () {
  writeLog('INFO', 'createWindow() appelé');
  const saved   = readSettings();
  const bounds  = saved.windowBounds || {};

  mainWindow = new BrowserWindow({
    width:     bounds.width  || 1340,
    height:    bounds.height || 840,
    x:         bounds.x,
    y:         bounds.y,
    minWidth:  1000,
    minHeight: 640,
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color:       '#0d0d0d',
      symbolColor: '#cccccc',
      height:      34,
    },
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  const htmlPath = path.join(RENDERER_DIR, 'index.html');
  writeLog('INFO', 'loadFile:', htmlPath, '| existe:', fs.existsSync(htmlPath));
  mainWindow.loadFile(htmlPath);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    writeLog('ERROR', 'did-fail-load:', code, desc, url);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    writeLog('ERROR', 'render-process-gone:', JSON.stringify(details));
  });

  mainWindow.on('unresponsive', () => {
    writeLog('WARN', 'Fenêtre non réactive (unresponsive)');
  });

  // Open DevTools in dev mode
  if (!IS_PACKED) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Save window bounds on close/resize/move
  const saveBounds = _debounce(() => {
    if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    const b = mainWindow.getBounds();
    const s = readSettings();
    s.windowBounds = b;
    saveSettings(s);
  }, 500);

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move',   saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Mise à jour automatique ───────────────────────────────────────────────────
async function _runAutoUpdate() {
  writeLog('INFO', 'Updater: vérification des mises à jour…');
  mainWindow?.webContents.send('updater:checking');
  try {
    const result = await checkForUpdates(BOT_DIR, RENDERER_DIR, APP_CONFIG.github, (file) => {
      writeLog('INFO', 'Updater: ↓', file);
      mainWindow?.webContents.send('updater:progress', { file });
    });

    if (result.upToDate) {
      writeLog('INFO', `Updater: à jour (v${result.version})`);
      mainWindow?.webContents.send('updater:up-to-date', { version: result.version });
    } else {
      writeLog('INFO', `Updater: ${result.updated.length} fichier(s) mis à jour → v${result.version}`);
      if (result.errors.length) {
        for (const e of result.errors) writeLog('WARN', `Updater: erreur sur ${e.file} — ${e.error}`);
      }
      const needsReload = result.updated.some(f => f.startsWith('electron-app/renderer/'));
      mainWindow?.webContents.send('updater:done', {
        version    : result.version,
        updated    : result.updated,
        errors     : result.errors,
        needsReload,
      });
    }
  } catch (err) {
    writeLog('WARN', 'Updater: impossible de vérifier les mises à jour —', err.message);
    mainWindow?.webContents.send('updater:error', { error: err.message });
  }
}

ipcMain.handle('updater:check', () => {
  _runAutoUpdate();
  return { ok: true };
});


const ACP_CONFIG_PATH = path.join(USERDATA_DIR, 'acp_settings.json');

// ── Initialisation automatique des fichiers utilisateur ──
function ensureUserFiles() {
  // macros.json
  if (!fs.existsSync(MACROS_PATH)) {
    fs.mkdirSync(path.dirname(MACROS_PATH), { recursive: true });
    fs.writeFileSync(MACROS_PATH, JSON.stringify([], null, 2), 'utf-8');
    writeLog('INFO', 'Fichier macros.json créé dans userData');
  }
  // settings.json
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({}, null, 2), 'utf-8');
    writeLog('INFO', 'Fichier settings.json créé dans userData');
  }
  // acp_settings.json
  if (!fs.existsSync(ACP_CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(ACP_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(ACP_CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
    writeLog('INFO', 'Fichier acp_settings.json créé dans userData');
  }
}

function _runChildStreaming(exe, args, onLine, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true, ...opts });
    let lastLine = '';
    const relay = d => {
      const text = d.toString().trim();
      if (text) {
        lastLine = text.slice(-300);
        // Pip WARNINGs (ex: "Target directory ... already exists. Specify
        // --upgrade...") sont bénins — normal quand 2 installs --target
        // partagent un paquet (ex: torch/torchvision et transformers/einops)
        // — mais font peur affichés tels quels dans la bannière setup. Log
        // seulement, pas dans la bannière utilisateur.
        if (/^WARNING:/i.test(text)) {
          writeLog('WARNING', text.slice(-300));
        } else {
          onLine(text.slice(-200)); // last line usually carries the useful bit (e.g. pip's progress %)
        }
      }
    };
    proc.stdout.on('data', relay);
    proc.stderr.on('data', relay);
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve()
      : reject(new Error(`exit ${code}${lastLine ? ' — ' + lastLine : ''}`)));
  });
}

// ── OCR — first-launch dependency install (EasyOCR + WinRT) ───────────────────
function _ocrDepsMarkerPath() {
  return path.join(AI_DEPS_DIR, '.ocr_deps_installed');
}

function _ocrDepsInstalled() {
  try { return fs.existsSync(_ocrDepsMarkerPath()); } catch (_) { return false; }
}

function _ocrDepsAlreadyImportable() {
  try {
    execSync(`"${PYTHON_EXE}" -c "import sys; sys.path.insert(0, r'${AI_DEPS_DIR}'); import easyocr, winsdk.windows.media.ocr"`,
      { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    return true;
  } catch (_) {
    return false;
  }
}

const _OCR_DEPS_MAX_ATTEMPTS = 3;
const _OCR_DEPS_RETRY_DELAY_MS = 5000;

async function _installOcrDepsOnce(send) {
  send('OCR : installation d\'EasyOCR + WinRT…');
  await _runChildStreaming(
    PYTHON_EXE,
    ['-m', 'pip', 'install', '--target', AI_DEPS_DIR, 'easyocr', 'winsdk'],
    send, { cwd: path.dirname(PYTHON_EXE) }
  );
  fs.writeFileSync(_ocrDepsMarkerPath(), new Date().toISOString(), 'utf-8');
}

async function ensureOcrDeps() {
  writeLog('INFO', "OCR: EasyOCR/WinRT non embarqués dans python-embed (dépendances lourdes, entraînent leur propre torch/opencv/scipy) — installation en tâche de fond au premier lancement. Sans ça, ocr_engine.py retombe silencieusement sur Tesseract.");
  if (!PYTHON_EXE || !PYTHON_EXE.toLowerCase().includes('python-embed')) return;
  if (_ocrDepsInstalled()) return;
  const send = (message) => mainWindow?.webContents.send('setup:progress', { message });

  try {
    if (_ocrDepsAlreadyImportable()) {
      try { fs.writeFileSync(_ocrDepsMarkerPath(), new Date().toISOString(), 'utf-8'); } catch (_) {}
      writeLog('INFO', 'OCR: EasyOCR/WinRT déjà présents, rien à installer.');
      return;
    }

    for (let attempt = 1; attempt <= _OCR_DEPS_MAX_ATTEMPTS; attempt++) {
      try {
        await _installOcrDepsOnce(send);
        writeLog('INFO', 'OCR: EasyOCR/WinRT installés.');
        return;
      } catch (e) {
        writeLog('WARNING', `OCR: tentative ${attempt}/${_OCR_DEPS_MAX_ATTEMPTS} échouée —`, e.message);
        if (attempt === _OCR_DEPS_MAX_ATTEMPTS) throw e;
        send(`Échec (${e.message}) — nouvel essai dans ${_OCR_DEPS_RETRY_DELAY_MS / 1000}s…`);
        await new Promise(r => setTimeout(r, _OCR_DEPS_RETRY_DELAY_MS));
      }
    }
  } catch (e) {
    writeLog('ERROR', 'OCR: installation EasyOCR/WinRT échouée après plusieurs tentatives —', e.message);
    // Non-fatal — ocr_engine.py falls back to native WinRT / Tesseract on its own.
  }
}

app.whenReady().then(() => {
  writeLog('INFO', 'app ready');
  ensureUserFiles();
  createWindow();

  mainWindow.webContents.once('did-finish-load', async () => {
    writeLog('INFO', 'Renderer chargé (did-finish-load)');
    // ── Check Python is available ──────────────────────────────
    if (!PYTHON_EXE) {
      const msg = 'Python introuvable. Le Python embarqué est manquant et aucun Python système n\'a été trouvé.';
      writeLog('ERROR', msg);
      mainWindow?.webContents.send('setup:error', { msg });
      return;
    }
    writeLog('INFO', 'Python OK →', PYTHON_EXE);
    mainWindow?.webContents.send('setup:done');
    startEngine(); // pré-démarre Python dès que l'UI est prête
    _pushLicenseKeyToEngine();
    // en arrière-plan — n'attend pas, l'app est utilisable pendant ce temps.
    ensureOcrDeps();

    // ── Vérification automatique des mises à jour ──────────────
    // IS_PACKED only: en dev, RENDERER_DIR pointe sur le dossier source réel —
    // l'updater écraserait les modifs locales non commit à chaque lancement.
    if (IS_PACKED) _runAutoUpdate();

    // ── Surveillance périodique de la licence ──────────────────
    _startLicenseWatcher();
  });
}).catch(err => {
  writeLog('FATAL', 'app.whenReady() rejeté:', err.stack || err.message);
});

app.on('window-all-closed', () => {
  _stopLicenseWatcher();
  // Non-darwin : app.quit() déclenche before-quit (résumé de session envoyé
  // au moteur) puis will-quit, qui tue le moteur. On ne le tue donc pas ici.
  if (process.platform !== 'darwin') app.quit();
  else killEngine();
});

// Résumé de session Discord à la fermeture : une seule fois, 7 s max.
// (app:restart passe par app.exit() et ne déclenche pas ce hook.)
let _sessionShutdownDone = false;
app.on('before-quit', (event) => {
  if (_sessionShutdownDone || !engineProc) return;
  _sessionShutdownDone = true;
  event.preventDefault();
  Promise.race([
    engineCmd({ cmd: 'session_shutdown' }, 7000),
    new Promise((resolve) => setTimeout(resolve, 7000)),
  ]).catch((e) => {
    writeLog('WARN', 'session_shutdown:', e && e.message);
  }).finally(() => {
    app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Macro Engine : démarrage / arrêt ─────────────────────────────────────────
function startEngine() {
  if (engineProc) return;
  if (_licenseRevoked) { writeLog('WARN', 'startEngine() refusé — licence révoquée'); return; }

  writeLog('INFO', 'startEngine() →', PYTHON_EXE, MAIN_PY);
  // Local handle: every handler below checks `engineProc !== proc` so a
  // killed process's late 'close'/'data' can't clobber a newer engine
  // (stop → start before the old one has actually exited).
  const proc = spawn(PYTHON_EXE, ['-u', MAIN_PY], {
    cwd:         ROOT_DIR,
    windowsHide: true,
    env:         { ...process.env, PYTHONUNBUFFERED: '1', MACROENGINE_AI_DEPS_DIR: AI_DEPS_DIR, MACROENGINE_USERDATA_DIR: USERDATA_DIR },
  });
  engineProc = proc;
  // Decode as a stream — chunk.toString() would turn a multibyte UTF-8 char
  // split across two chunks into U+FFFD.
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  // Without these, a broken pipe (e.g. engineCmd writing to stdin the
  // instant the Python process dies) emits an unhandled 'error' on that
  // stream — Node treats an unhandled stream 'error' as fatal, surfacing as
  // the top-level uncaughtException dialog for what should be a routine,
  // locally-recoverable IPC failure (engineCmd's own try/catch already
  // handles the write failing).
  proc.stdin.on('error', err => writeLog('WARNING', 'Engine stdin error:', err.message));
  proc.stdout.on('error', err => writeLog('WARNING', 'Engine stdout error:', err.message));
  proc.stderr.on('error', err => writeLog('WARNING', 'Engine stderr error:', err.message));

  // Line-by-line stdout reader
  proc.stdout.on('data', chunk => {
    if (engineProc !== proc) return;
    _msgBuf += chunk;
    const lines = _msgBuf.split('\n');
    _msgBuf = lines.pop();          // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      _dispatchFromEngine(msg);
    }
  });

  proc.stderr.on('data', d => {
    if (engineProc !== proc) return;
    const txt = d.trim();
    writeLog('PYERR', txt);
    mainWindow?.webContents.send('engine:log', { level: 'ERROR', msg: txt });
    _sendToOverlay('overlay:log', { level: 'PYERR', msg: txt });
  });

  proc.on('close', code => {
    writeLog('INFO', 'Engine fermé, code:', code);
    // A newer engine already owns the shared buffer/pending map — leave it be.
    if (engineProc && engineProc !== proc) return;
    engineProc = null;
    _msgBuf    = '';
    for (const [, { reject }] of _pending) reject(new Error('Engine stopped'));
    _pending.clear();
    mainWindow?.webContents.send('engine:stopped', { code });
    _sendToOverlay('overlay:stopped');
    _overlayAcpRunning = false;
    _sendToOverlay('overlay:acp-status', { running: false });
  });

  proc.on('error', err => {
    writeLog('ERROR', 'Engine spawn error:', err.message);
    if (engineProc !== proc) return;
    engineProc = null;
    mainWindow?.webContents.send('engine:stopped', { error: err.message });
  });
}

function killEngine() {
  if (!engineProc) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(engineProc.pid)], { windowsHide: true });
    } else {
      engineProc.kill('SIGTERM');
    }
  } catch (_) {}
  engineProc = null;
  // The killed proc's 'close' is ignored once a new engine starts, so its
  // buffer/pending requests are flushed here rather than there.
  _msgBuf = '';
  for (const [, { reject }] of _pending) reject(new Error('Engine stopped'));
  _pending.clear();
}

// Poll until engineProc.stdin is writable (or timeoutMs elapses) — shared
// by every call site that needs the engine ready before writing to it, so
// the three previously-separate copies (each with its own constants) can't
// drift out of sync with each other.
async function _waitForEngineReady(timeoutMs = 3000, stepMs = 10) {
  const steps = Math.ceil(timeoutMs / stepMs);
  for (let i = 0; i < steps; i++) {
    if (engineProc?.stdin?.writable) return;
    await new Promise(r => setTimeout(r, stepMs));
  }
}

// Pousse la clé de licence locale vers le moteur Python — sert uniquement à
// identifier l'install dans les rapports debug webhook (screenshot on
// macro start/stop), jamais transmise ailleurs qu'au process Python local.
async function _pushLicenseKeyToEngine() {
  await _waitForEngineReady();
  try { await engineCmd({ cmd: 'set_license_key', key: readLicense() || '', app_version: app.getVersion() }); } catch (_) {}
}

// ── Engine message router ─────────────────────────────────────────────────────
function _dispatchFromEngine(msg) {
  if (msg.type === 'response') {
    const p = _pending.get(msg.id);
    if (p) {
      _pending.delete(msg.id);
      p.resolve(msg);
    }
  } else if (msg.type === 'log') {
    mainWindow?.webContents.send('engine:log', { level: msg.level, msg: msg.msg });
    _sendToOverlay('overlay:log', { level: msg.level, msg: msg.msg });
  } else if (msg.type === 'status') {
    mainWindow?.webContents.send('engine:status', { running: msg.running });
    _sendToOverlay('overlay:status', { running: msg.running });
  } else if (msg.type === 'status_update') {
    mainWindow?.webContents.send('engine:status_update', msg);
    _sendToOverlay('overlay:status', msg);
  } else if (msg.type === 'record_event') {
    mainWindow?.webContents.send('engine:record_event', msg.action);
  } else if (msg.type === 'webhook_error') {
    mainWindow?.webContents.send('engine:webhook_error', { msg: msg.msg });
  } else if (msg.type === 'macro_start_request') {
    mainWindow?.webContents.send('engine:macro_start_request', { name: msg.name });
  } else if (msg.type === 'pick_result') {
    _pickerOnResult?.(msg);
  } else if (msg.type === 'alert') {
    // Critical engine alert (game_closed / macro_errors) — the main renderer
    // relays it to the overlay toast through the overlay feed.
    mainWindow?.webContents.send('engine:alert', {
      event: msg.event, title: msg.title || '', message: msg.message || '',
    });
  }
}

// ── Send command to engine and await response ─────────────────────────────────
function engineCmd(cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!engineProc) { reject(new Error('Engine not running')); return; }
    const id = `${cmd.cmd}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Store timer handle so it can be cancelled when response arrives
    const timer = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        reject(new Error('Engine timeout'));
      }
    }, timeoutMs);
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      engineProc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(e);
    }
  });
}

// ── IPC: engine lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('engine:start', () => {
  startEngine();
  return { ok: true };
});

ipcMain.handle('engine:stop', () => {
  killEngine();
  return { ok: true };
});

ipcMain.handle('engine:status', async () => {
  if (!engineProc) return { ok: true, engineRunning: false, running: [] };
  try {
    const r = await engineCmd({ cmd: 'status' });
    return { ok: true, engineRunning: true, running: r.running || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: forwarded engine commands ───────────────────────────────────────────
for (const cmd of [
  // Windows & display
  'list_windows', 'get_window_rect', 'get_window_info', 'is_window_focused',
  'focus_window', 'get_screen_info', 'find_window_monitor',
  // Coords
  'validate_point', 'validate_region', 'scale_coords',
  // Vision & OCR (check_ocr/ocr_text/test_template_score have their own
  // longer-timeout handler below — see the comment there)
  'preview_region', 'pick_color', 'region_avg_color', 'save_template',
  // Macros
  'macro_start', 'macro_stop', 'macro_pause', 'macro_resume', 'stop_all',
  // Conditions / Actions testing
  'test_condition', 'exec_action',
  // Recording
  'record_start', 'record_stop',
  // Webhook
  'set_webhook', 'send_webhook', 'set_session_snapshot', 'session_shutdown',
  // State / Stats
  'get_stats', 'get_macro_history', 'get_variables', 'set_variable', 'set_counter', 'clear_state',
  // Dead zones
  'set_dead_zones', 'get_dead_zones',
  // Pixel snapshot
  'pixel_snapshot',
]) {
  ipcMain.handle(`engine:${cmd}`, async (_evt, params) => {
    try {
      await _ensureEngineStarted();
      return await engineCmd({ ...params, cmd });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// Auto-start the engine on first use, then poll up to 3s for stdin readiness
// — shared by the generic forwarded commands above and the AI-specific
// handlers below (which need a longer engineCmd timeout, so aren't in that
// generic list).
async function _ensureEngineStarted() {
  if (engineProc) return;
  if (_licenseRevoked) throw new Error('Licence révoquée — moteur désactivé');
  startEngine();
  await _waitForEngineReady();
}

// ── IPC: OCR ──────────────────────────────────────────────────────────────────
// Own handlers, not in the generic 15s forwarded-command loop above: per
// CLAUDE.md the OCR cascade is EasyOCR (6 preprocessing variants, scored) →
// WinRT → Tesseract, and a cold first call (model load) can legitimately
// exceed 15s — that was surfacing as a spurious "Engine timeout" on
// conditions used inside running macros, not an actual failure.
for (const cmd of ['check_ocr', 'ocr_text', 'test_template_score']) {
  ipcMain.handle(`engine:${cmd}`, async (_evt, params) => {
    try {
      await _ensureEngineStarted();
      return await engineCmd({ ...params, cmd }, 60000);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ── IPC: Auto Bouffe vision AI (Moondream Cloud) ─────────────────────────────
// Own handlers (not in the generic forwarded-command loop above) because they
// need a longer timeout than the usual 15s ceiling — a network round-trip to
// the cloud API can occasionally be slow. vlm_warmup/vlm_unload are no-ops on
// the Python side now (no local model/VRAM) but keep the same handler for
// symmetry with vlm_ask.
for (const cmd of ['vlm_ask', 'vlm_warmup', 'vlm_unload']) {
  ipcMain.handle(`engine:${cmd}`, async (_evt, params) => {
    try {
      await _ensureEngineStarted();
      return await engineCmd({ ...params, cmd }, 300000);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ── IPC: Screen picker ───────────────────────────────────────────────────────
// GPU hardware acceleration is disabled on this machine (by design), so any
// transparent full-screen window renders solid black (Chromium's software
// rendering path can't composite per-pixel alpha with the desktop).
//   - Point mode: a tiny OPAQUE marker (fixed pixel size, no transparency
//     needed at all) follows the cursor; pynput (main.py _cmd_pick_start)
//     detects the actual click/escape system-wide. The real screen stays
//     100% visible everywhere outside that small marker.
//   - Region mode: still needs to actually see the content inside the drag
//     rectangle to align it precisely, so it uses a full-screen window per
//     display, background-composited from a real screenshot (mss/GDI) since
//     live transparency isn't possible here.
let _pickerWindows = [];   // region mode — one full-screen window per display
let _pickerWin = null;     // point mode — single tiny marker window
let _pickerPollTimer = null;
let _pickerOnResult = null;
const PICKER_MARKER_SIZE = 22;

function _closeAllPickers() {
  _pickerWindows.forEach(w => { try { if (!w.isDestroyed()) w.close(); } catch (_) {} });
  _pickerWindows = [];
  if (_pickerPollTimer) { clearInterval(_pickerPollTimer); _pickerPollTimer = null; }
  if (_pickerWin && !_pickerWin.isDestroyed()) { try { _pickerWin.close(); } catch (_) {} }
  _pickerWin = null;
  _pickerOnResult = null;
}

function _logicalToPhysical(screen, result) {
  if (!result || result.x === undefined) return result;
  const allDisplays = screen.getAllDisplays();
  const display = screen.getDisplayNearestPoint({ x: result.x, y: result.y });
  const sf = display.scaleFactor || 1;

  // Sum physical widths of all displays strictly to the left/above the target display.
  // This gives the physical pixel offset from the virtual screen's leftmost edge.
  let physX = 0, physY = 0;
  for (const d of allDisplays) {
    if (d.bounds.x + d.bounds.width <= display.bounds.x)
      physX += Math.round(d.bounds.width * d.scaleFactor);
    if (d.bounds.y + d.bounds.height <= display.bounds.y)
      physY += Math.round(d.bounds.height * d.scaleFactor);
  }
  physX += Math.round((result.x - display.bounds.x) * sf);
  physY += Math.round((result.y - display.bounds.y) * sf);

  // mss / Win32 physical coords have origin at primary monitor (0,0), not at
  // the leftmost pixel. Subtract the physical offset of the primary itself.
  // Primary is always at logical (0,0); monitors with logical right-edge <= 0
  // are physically to its left and contribute a positive offset to subtract.
  let primaryOffsetX = 0, primaryOffsetY = 0;
  for (const d of allDisplays) {
    if (d.bounds.x + d.bounds.width <= 0)
      primaryOffsetX += Math.round(d.bounds.width * d.scaleFactor);
    if (d.bounds.y + d.bounds.height <= 0)
      primaryOffsetY += Math.round(d.bounds.height * d.scaleFactor);
  }

  result.x = physX - primaryOffsetX;
  result.y = physY - primaryOffsetY;
  if (result.w !== undefined) result.w = Math.round(result.w * sf);
  if (result.h !== undefined) result.h = Math.round(result.h * sf);
  return result;
}

ipcMain.handle('picker:start', (_evt, opts) => {
  _closeAllPickers();
  const mode = opts?.mode || 'point';
  return mode === 'region' ? _startRegionPicker(opts) : _startPointPicker(opts);
});

// Point mode: tiny opaque marker (no transparency needed) + pynput click detection.
function _startPointPicker(opts) {
  const { screen } = require('electron');

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      _closeAllPickers();
      resolve(result);
    };

    _pickerOnResult = (msg) => finish(msg.cancelled ? null : { x: msg.x, y: msg.y });

    const startPt = screen.getCursorScreenPoint();
    const win = new BrowserWindow({
      x: startPt.x - PICKER_MARKER_SIZE / 2,
      y: startPt.y - PICKER_MARKER_SIZE / 2,
      width:  PICKER_MARKER_SIZE,
      height: PICKER_MARKER_SIZE,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setIgnoreMouseEvents(true); // clicks pass through — pynput detects them globally
    win.loadFile(_rendererFile('picker.html'));
    _pickerWin = win;

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.webContents.send('picker:init', { mode: 'point', markerSize: PICKER_MARKER_SIZE });

      // setBounds (not setPosition) re-asserts the size every frame — on
      // this machine (GPU accel off, software rendering path) setPosition
      // alone let the window's size drift/grow over repeated calls.
      // Skipping the native call when the cursor hasn't moved still avoids
      // ~60 no-op calls/sec while the mouse sits still.
      let lastX = null, lastY = null;
      const half = PICKER_MARKER_SIZE / 2;
      const tick = () => {
        if (win.isDestroyed()) return;
        const pt = screen.getCursorScreenPoint();
        if (pt.x === lastX && pt.y === lastY) return;
        lastX = pt.x; lastY = pt.y;
        win.setBounds({
          x: pt.x - half, y: pt.y - half,
          width: PICKER_MARKER_SIZE, height: PICKER_MARKER_SIZE,
        });
      };
      tick();
      _pickerPollTimer = setInterval(tick, 16);
    });

    win.on('closed', () => finish(null));

    engineCmd({ cmd: 'pick_start', mode: 'point' }).catch(err => {
      writeLog('ERROR', 'picker: pick_start a échoué —', err.message);
      finish(null);
    });
  });
}

// Region mode: full-screen window per display, background composited from a
// real screenshot (mss/GDI) since live transparency isn't possible here —
// needed so the user can actually see what's inside the drag rectangle.
async function _startRegionPicker(opts) {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();

  const cropRects = displays.map(display => _logicalToPhysical(screen, {
    x: display.bounds.x, y: display.bounds.y,
    w: display.bounds.width, h: display.bounds.height,
  }));
  const bboxX0 = Math.min(...cropRects.map(r => r.x));
  const bboxY0 = Math.min(...cropRects.map(r => r.y));
  const bboxX1 = Math.max(...cropRects.map(r => r.x + r.w));
  const bboxY1 = Math.max(...cropRects.map(r => r.y + r.h));

  let desktopB64 = null;
  try {
    const res = await engineCmd({
      cmd: 'preview_region',
      x: bboxX0, y: bboxY0, w: bboxX1 - bboxX0, h: bboxY1 - bboxY0,
    });
    desktopB64 = res?.b64 || null;
  } catch (err) {
    writeLog('ERROR', 'picker: preview_region (desktop) a échoué —', err.message);
  }

  return new Promise((resolve) => {
    let resolved = false;

    const _resultListener = (_e, result) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('picker:result', _resultListener);
      _closeAllPickers();
      resolve(_logicalToPhysical(screen, result));
    };
    ipcMain.on('picker:result', _resultListener);

    displays.forEach((display, i) => {
      const win = new BrowserWindow({
        x:      display.bounds.x,
        y:      display.bounds.y,
        width:  display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        webPreferences: {
          preload: path.join(__dirname, 'picker-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      win.loadFile(_rendererFile('picker.html'));
      const _win = win;
      const r = cropRects[i];
      const cropRect = { x: r.x - bboxX0, y: r.y - bboxY0, w: r.w, h: r.h };
      win.once('ready-to-show', () => {
        if (_win.isDestroyed()) return;
        _win.webContents.send('picker:init', {
          mode:     'region',
          offsetX:  display.bounds.x,
          offsetY:  display.bounds.y,
          desktopImage: desktopB64 ? `data:image/png;base64,${desktopB64}` : null,
          cropRect,
        });
      });

      win.on('closed', () => {
        if (!resolved) {
          resolved = true;
          ipcMain.removeListener('picker:result', _resultListener);
          _closeAllPickers();
          resolve(null);
        }
      });

      _pickerWindows.push(win);
    });
  });
}

// ── Overlay window ────────────────────────────────────────────────────────────
// Transparent, frameless, content-sized: overlay.html measures its own panel
// and calls overlay:set-size (expanded card 250 px / collapsed pill). 8 px of
// transparent margin around the card leaves room for its soft shadow.
// `transparent` can't be toggled after creation on Windows, hence set here;
// transparent windows aren't edge-resizable on Windows — size is content-driven.
const OVERLAY_DEFAULT_OPACITY = 55;

function _overlaySettings(s) {
  s = s || readSettings();
  const op = parseInt(s.overlayOpacity, 10);
  const sec = (s.overlaySections && typeof s.overlaySections === 'object') ? s.overlaySections : {};
  return {
    enabled:      s.overlayEnabled === true,
    opacity:      Number.isFinite(op) ? Math.min(100, Math.max(20, op)) : OVERLAY_DEFAULT_OPACITY,
    locked:       s.overlayLocked === true,
    clickThrough: s.overlayClickThrough === true,
    sections: {
      meal:   sec.meal   !== false,
      macros: sec.macros !== false,
      stats:  sec.stats  !== false,
    },
    shortcut: s.shortcutOverlay || 'F8',
  };
}

function _applyOverlayWindowSettings(os) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.setMovable(!os.locked); } catch (_) {}
  try {
    if (os.clickThrough) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    else                 overlayWindow.setIgnoreMouseEvents(false);
  } catch (_) {}
}

function _setOverlayEnabled(on) {
  try {
    const s = readSettings();
    if (s.overlayEnabled === on) return;
    s.overlayEnabled = on;
    saveSettings(s);
  } catch (_) {}
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
    return;
  }

  const s   = readSettings();
  const pos = s.overlayBounds || { x: 24, y: 80 };

  overlayWindow = new BrowserWindow({
    x:           pos.x,
    y:           pos.y,
    width:       266,
    height:      320,
    frame:       false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow:   false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable:   true,
    show:        false,
    webPreferences: {
      preload:          path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  overlayWindow.loadFile(_rendererFile('overlay.html'));
  overlayWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    writeLog('ERROR', 'overlay did-fail-load:', code, desc, url);
  });
  overlayWindow.webContents.on('render-process-gone', (_e, details) => {
    writeLog('ERROR', 'overlay render-process-gone:', JSON.stringify(details));
  });
  overlayWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) writeLog('WARN', `overlay console: ${message} (${sourceId}:${line})`);
  });

  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.showInactive();          // show WITHOUT stealing focus
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    _applyOverlayWindowSettings(_overlaySettings());
  });

  // Persist position
  const _saveOverlayPos = _debounce(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [x, y] = overlayWindow.getPosition();
    const s = readSettings();
    s.overlayBounds = { x, y };
    saveSettings(s);
  }, 500);

  overlayWindow.on('move', _saveOverlayPos);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    mainWindow?.webContents.send('overlay:closed');
  });
}

ipcMain.handle('overlay:show', () => {
  createOverlayWindow();
  _setOverlayEnabled(true);
  return { ok: true, visible: true };
});

ipcMain.handle('overlay:hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  return { ok: true, visible: false };
});

ipcMain.handle('overlay:toggle', () => {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
    return { ok: true, visible: false };
  }
  createOverlayWindow();
  _setOverlayEnabled(true);
  return { ok: true, visible: true };
});

ipcMain.on('overlay:stop-all', async () => {
  try { await engineCmd({ cmd: 'stop_all' }); } catch (_) {}
  mainWindow?.webContents.send('shortcut:triggered', { action: 'stop' });
});

ipcMain.on('overlay:close', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

ipcMain.on('overlay:minimize', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  mainWindow?.webContents.send('overlay:closed');
});

ipcMain.on('overlay:set-size', (_, { w, h } = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || !Number.isFinite(w) || !Number.isFinite(h)) return;
  const W = Math.max(40, Math.min(600, Math.round(w)));
  const H = Math.max(30, Math.min(1000, Math.round(h)));
  const [cw, ch] = overlayWindow.getSize();
  if (cw === W && ch === H) return;
  // A non-resizable window has min = max = its current size on Windows, so
  // setSize can't shrink it (measured: pill stayed 268×666). Unlock just for
  // the programmatic resize, then lock again (no user edge-resize). Verified
  // with an Electron 28 harness: transparency is preserved.
  try {
    overlayWindow.setResizable(true);
    overlayWindow.setSize(W, H, false);
  } catch (_) {
  } finally {
    try { overlayWindow.setResizable(false); } catch (_) {}
  }
});

// Feed from the main renderer (session / meal / per-macro cycles / alert)
ipcMain.on('overlay:data', (_, d) => {
  if (d && typeof d === 'object') _sendToOverlay('overlay:data', d);
});

// Overlay → main renderer commands (e.g. stop Auto Bouffe, renderer-owned)
ipcMain.on('overlay:command', (_, d) => {
  if (d && typeof d.cmd === 'string') mainWindow?.webContents.send('overlay:command', { cmd: d.cmd });
});

ipcMain.handle('overlay:get-settings', () => _overlaySettings());

ipcMain.on('overlay:set-settings', (_, p = {}) => {
  try {
    const s = readSettings();
    if (typeof p.opacity === 'number' && Number.isFinite(p.opacity)) s.overlayOpacity = Math.min(100, Math.max(20, Math.round(p.opacity)));
    if (typeof p.locked === 'boolean')       s.overlayLocked = p.locked;
    if (typeof p.clickThrough === 'boolean') s.overlayClickThrough = p.clickThrough;
    if (p.sections && typeof p.sections === 'object') {
      s.overlaySections = {
        meal:   p.sections.meal   !== false,
        macros: p.sections.macros !== false,
        stats:  p.sections.stats  !== false,
      };
    }
    if (typeof p.enabled === 'boolean') s.overlayEnabled = p.enabled;
    saveSettings(s);
    const os = _overlaySettings(s);
    // locked / click-through only when they were part of this update — an
    // opacity drag must not re-enable ignore-mouse while the bar is hovered.
    if (typeof p.locked === 'boolean' || typeof p.clickThrough === 'boolean') _applyOverlayWindowSettings(os);
    if (p.enabled === false && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      mainWindow?.webContents.send('overlay:closed');
    }
  } catch (e) {
    writeLog('WARN', 'overlay:set-settings: ' + e.message);
  }
});

// Click-through: the overlay temporarily turns it off while the pointer is
// over its top bar (forwarded mousemove), so ⚙ stays reachable.
ipcMain.on('overlay:set-ignore-mouse', (_, { on } = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    if (on) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    else    overlayWindow.setIgnoreMouseEvents(false);
  } catch (_) {}
});

// Quick placement in a corner of the primary display's work area: 16 px from
// the edge to the card (the window adds 8 px of transparent padding).
ipcMain.on('overlay:snap', (_, { corner } = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = overlayWindow.getSize();
  const m = 16 - 8;
  const left = wa.x + m, right = wa.x + wa.width - w - m;
  const top  = wa.y + m, bottom = wa.y + wa.height - h - m;
  const pos = { tl: [left, top], tr: [right, top], bl: [left, bottom], br: [right, bottom] }[corner];
  if (!pos) return;
  try { overlayWindow.setPosition(Math.round(pos[0]), Math.round(pos[1]), false); } catch (_) {}
});

ipcMain.on('overlay:pause-all', async () => {
  mainWindow?.webContents.send('shortcut:triggered', { action: 'pause' });
});

ipcMain.handle('overlay:get-shortcuts', () => {
  try {
    const s = readSettings();
    return { ok: true, stop: s.shortcutStop || '', pause: s.shortcutPause || '', overlay: s.shortcutOverlay || 'F8' };
  } catch (_) { return { ok: false, stop: '', pause: '', overlay: 'F8' }; }
});

ipcMain.on('overlay:macro-start', async (_, { name } = {}) => {
  if (!name) return;
  try { await engineCmd({ cmd: 'macro_start', name }); } catch (_) {}
});

ipcMain.on('overlay:macro-stop', async (_, { name } = {}) => {
  if (!name) return;
  try { await engineCmd({ cmd: 'macro_stop', name }); } catch (_) {}
});

// ── Overlay: Auto Clicker ─────────────────────────────────────────────────────
let _overlayAcpRunning = false;

ipcMain.on('overlay:acp-start', async (_evt, { macro } = {}) => {
  if (_overlayAcpRunning || !macro) return;
  _overlayAcpRunning = true;
  _sendToOverlay('overlay:acp-status', { running: true });
  try {
    // Ensure engine is alive before sending the macro
    if (!engineProc) {
      startEngine();
      await _waitForEngineReady();
    }
    await engineCmd({ cmd: 'macro_start', macro, macro_id: '__auto_clicker__' });
  } catch (e) {
    _overlayAcpRunning = false;
    _sendToOverlay('overlay:acp-status', { running: false, error: e.message });
  }
});

ipcMain.on('overlay:acp-stop', async () => {
  try { await engineCmd({ cmd: 'macro_stop', macro_id: '__auto_clicker__' }); } catch (_) {}
  _overlayAcpRunning = false;
  _sendToOverlay('overlay:acp-status', { running: false });
});

// Sync _overlayAcpRunning with engine status events
// (handled via existing overlay:status forwarding from engineProc stdout)

ipcMain.handle('overlay:get-acp-config', () => {
  try {
    if (fs.existsSync(ACP_CONFIG_PATH)) return { ok: true, config: JSON.parse(fs.readFileSync(ACP_CONFIG_PATH, 'utf-8')) };
  } catch (_) {}
  return { ok: false };
});

ipcMain.handle('overlay:get-macros', () => {
  try {
    if (!fs.existsSync(MACROS_PATH)) return { macros: [] };
    const data = JSON.parse(fs.readFileSync(MACROS_PATH, 'utf-8'));
    return { macros: Array.isArray(data) ? data.map(m => m.name) : [] };
  } catch (_) { return { macros: [] }; }
});

ipcMain.on('overlay:focus-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── IPC: macros file (save/load JSON) ────────────────────────────────────────
ipcMain.handle('macros:read', (_evt, opts) => {
  const macrosPath = opts?.beta ? MACROS_PATH_BETA : MACROS_PATH;
  try {
    if (!fs.existsSync(macrosPath)) return { ok: true, macros: [] };
    const data = JSON.parse(fs.readFileSync(macrosPath, 'utf-8'));
    return { ok: true, macros: Array.isArray(data) ? data : [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('macros:write', (_evt, macros, opts) => {
  const macrosPath = opts?.beta ? MACROS_PATH_BETA : MACROS_PATH;
  try {
    fs.mkdirSync(path.dirname(macrosPath), { recursive: true });
    _atomicWrite(macrosPath, JSON.stringify(macros, null, 2));
    if (!opts?.beta) _sendToOverlay('overlay:macros-updated', {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: Auto Clicker config (shared with overlay) ───────────────────────────
ipcMain.handle('acp:save-config', (_evt, data) => {
  try {
    _atomicWrite(ACP_CONFIG_PATH, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: app config ───────────────────────────────────────────────────────────
ipcMain.handle('app:getConfig', () => ({
  ...APP_CONFIG,
  version: app.getVersion(),
}));

// ── IPC: « Quoi de neuf » — CHANGELOG.md embarqué (package.json build.files) ──
ipcMain.handle('app:changelog', () => {
  const candidates = [
    path.join(__dirname, 'CHANGELOG.md'),           // dev + packagé (dans app.asar)
    path.join(__dirname, '..', 'CHANGELOG.md'),     // repli : racine du dépôt (dev)
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { ok: true, version: app.getVersion(), text: fs.readFileSync(p, 'utf-8') };
    } catch (_) {}
  }
  return { ok: false, version: app.getVersion(), text: '' };
});

// ── IPC: restart ──────────────────────────────────────────────────────────────
ipcMain.handle('app:restart', () => {
  // app.exit() skips will-quit/window-all-closed — kill the engine explicitly.
  killEngine();
  app.relaunch();
  app.exit(0);
});

// ── Vérification périodique de licence (toutes les 10 min) ───────────────────
const LICENSE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let _licenseWatcherTimer = null;

function _startLicenseWatcher() {
  if (_licenseWatcherTimer) return;
  _licenseWatcherTimer = setInterval(async () => {
    const licData = readLicenseData();
    if (!licData || !licData.key) {
      writeLog('WARN', '[LIC-WATCH] Aucune clé — révocation');
      _onLicenseRevoked('missing');
      return;
    }
    try {
      const result = await verifyLicenseOnline(licData.key);
      if (result.offline) {
        // Réseau KO — on ne révoque pas, grâce hors-ligne encore active
        writeLog('INFO', '[LIC-WATCH] Réseau KO — grâce hors-ligne maintenue');
        return;
      }
      if (!result.valid) {
        writeLog('WARN', '[LIC-WATCH] Licence révoquée/invalide');
        _onLicenseRevoked('invalid');
      } else {
        saveLicense(licData.key);
        writeLog('INFO', '[LIC-WATCH] Licence toujours valide');
      }
    } catch (e) {
      writeLog('WARN', '[LIC-WATCH] Erreur vérif:', e.message);
    }
  }, LICENSE_CHECK_INTERVAL_MS);
  writeLog('INFO', '[LIC-WATCH] Surveillance licence démarrée (10 min)');
}

function _stopLicenseWatcher() {
  if (_licenseWatcherTimer) {
    clearInterval(_licenseWatcherTimer);
    _licenseWatcherTimer = null;
  }
}

function _onLicenseRevoked(reason) {
  _licenseRevoked = true;  // blocks _ensureEngineStarted/startEngine until re-validated
  _stopLicenseWatcher();
  killEngine();
  mainWindow?.webContents.send('license:revoked', { reason });
  writeLog('WARN', '[LIC-WATCH] Engine arrêté — licence révoquée:', reason);
}

// ── IPC: license ─────────────────────────────────────────────────────────────
// Pousse le statut live (valide/hors-ligne/jours restants) vers le moteur
// Python à chaque license:check — s'ajoute à la clé seule déjà poussée au
// démarrage (_pushLicenseKeyToEngine), pour que les rapports debug webhook
// affichent l'état actuel, pas juste la clé brute.
async function _pushLicenseStatusToEngine(key, valid, offline, daysLeft, resultCode) {
  try {
    await engineCmd({ cmd: 'set_license_key', key: key || '', valid: !!valid, offline: !!offline, days_left: daysLeft ?? null, result: resultCode || null });
  } catch (_) {}
}

ipcMain.handle('license:check', async () => {
  writeLog('INFO', '[LIC] Appel license:check');
  const licData = readLicenseData();
  if (!licData || !licData.key) {
    writeLog('WARN', '[LIC] Aucune clé trouvée');
    return { valid: false, reason: 'missing' };
  }
  writeLog('INFO', `[LIC] Vérification online pour ${licData.key}`);
  const result = await verifyLicenseOnline(licData.key);
  writeLog('INFO', `[LIC] Résultat: valid=${result.valid} offline=${result.offline} result=${result.result}`);
  if (result.valid) {
    writeLog('INFO', '[LIC] Licence valide, rafraîchissement validatedAt');
    saveLicense(licData.key);        // Rafraîchir validatedAt
    _licenseRevoked = false;
    _pushLicenseStatusToEngine(licData.key, true, false, null, result.result);
    return { valid: true };
  }

  // Réseau injoignable → grace period
  if (result.offline && licData.validatedAt) {
    const daysSince = (Date.now() - licData.validatedAt) / 86400000;
    if (daysSince <= LICENSE_GRACE_DAYS) {
      const daysLeft = Math.ceil(LICENSE_GRACE_DAYS - daysSince);
      writeLog('WARN', `[LIC] mode hors-ligne, ${daysLeft}j restants`);
      _pushLicenseStatusToEngine(licData.key, true, true, daysLeft, result.result);
      return { valid: true, offline: true, daysLeft };
    }
    writeLog('WARN', '[LIC] Grace period expiré');
    _pushLicenseStatusToEngine(licData.key, false, true, null, result.result);
    return { valid: false, reason: 'grace_expired' };
  }
  writeLog('WARN', `[LIC] Licence invalide ou réseau KO (offline=${result.offline})`);
  _pushLicenseStatusToEngine(licData.key, false, result.offline, null, result.result);
  return { valid: false, reason: result.offline ? 'network' : 'invalid' };
});

ipcMain.handle('license:verify', async (_evt, key) => {
  if (!key || typeof key !== 'string' || !key.trim()) {
    return { valid: false, reason: 'empty' };
  }
  const result = await verifyLicenseOnline(key.trim());
  if (result.valid) {
    saveLicense(key.trim());
    _licenseRevoked = false;
    _startLicenseWatcher();
    _pushLicenseKeyToEngine();
  }
  if (!result.valid && result.offline) return { valid: false, reason: 'network' };
  return result;
});

// ── IPC: settings ────────────────────────────────────────────────────────────
ipcMain.handle('settings:read', () => {
  return { ok: true, settings: readSettings() };
});

ipcMain.handle('app:userDataPath', () => USERDATA_DIR);

ipcMain.handle('settings:write', (_evt, data) => {
  try {
    saveSettings(data);
    // Notify overlay if shortcuts changed
    if (data.shortcutStop !== undefined || data.shortcutPause !== undefined || data.shortcutOverlay !== undefined) {
      _sendToOverlay('overlay:shortcuts-updated', {
        stop:    data.shortcutStop    || '',
        pause:   data.shortcutPause   || '',
        overlay: data.shortcutOverlay || 'F8',
      });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: global shortcuts ────────────────────────────────────────────────────
function registerGlobalShortcuts(shortcuts) {
  const next = shortcuts || {};
  writeLog('DEBUG', 'shortcuts: next =', JSON.stringify(next), '| current =', JSON.stringify(registeredShortcuts));

  // Unregister removed or changed shortcuts only
  for (const [action, accelerator] of Object.entries(registeredShortcuts)) {
    if (next[action] !== accelerator) {
      try { globalShortcut.unregister(accelerator); } catch (_) {}
      delete registeredShortcuts[action];
    }
  }

  // Register new or changed shortcuts
  for (const [action, accelerator] of Object.entries(next)) {
    if (!accelerator || registeredShortcuts[action] === accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        writeLog('DEBUG', 'shortcut fired:', action, accelerator);
        mainWindow?.webContents.send('shortcut:triggered', { action });
      });
      writeLog('DEBUG', 'shortcuts: register', action, accelerator, '→', ok);
      if (ok) registeredShortcuts[action] = accelerator;
    } catch (err) {
      writeLog('ERROR', 'shortcuts: register a échoué', action, accelerator, '—', err.message);
    }
  }
}

ipcMain.handle('shortcuts:register', (_evt, shortcuts) => {
  try {
    registerGlobalShortcuts(shortcuts || {});
    return { ok: true, registered: registeredShortcuts };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: multi-monitor info ──────────────────────────────────────────────────
ipcMain.handle('monitors:list', () => {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  return {
    ok: true,
    displays: displays.map(d => ({
      id: d.id,
      label: d.label || `Display ${d.id}`,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      isPrimary: d.bounds.x === 0 && d.bounds.y === 0,
    })),
  };
});

// ── IPC: log file ────────────────────────────────────────────────────────────
ipcMain.handle('log:read', () => {
  try {
    if (!fs.existsSync(LOG_PATH)) return { ok: true, content: '(aucun log)' };
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n');
    // Retourner les 300 dernières lignes
    return { ok: true, content: lines.slice(-300).join('\n'), path: LOG_PATH };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('log:open', () => {
  const { shell } = require('electron');
  if (fs.existsSync(LOG_PATH)) shell.openPath(LOG_PATH);
  return { ok: true };
});

ipcMain.handle('shell:openExternal', (_evt, url) => {
  const { shell } = require('electron');
  // Whitelist des protocoles autorisés (sécurité)
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
  return { ok: true };
});

ipcMain.handle('log:clear', () => {
  try {
    fs.writeFileSync(LOG_PATH, `[${_ts()}] [INFO] Log effacé\n`, 'utf-8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.on('will-quit', () => {
  writeLog('INFO', '═══ MacroEngine fermeture ═══');
  globalShortcut.unregisterAll();
  killEngine();
});

