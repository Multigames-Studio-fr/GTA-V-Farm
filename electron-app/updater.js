'use strict';
/**
 * updater.js — Mise à jour automatique incrémentale
 *
 * Télécharge update-manifest.json depuis GitHub, compare les hashes SHA256
 * des fichiers locaux, et télécharge uniquement les fichiers modifiés.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// URLs construites depuis le config (injecté par main.js via checkForUpdates)
let MANIFEST_URL = '';
let BASE_URL     = '';

// No activity (not even a connection) for this long aborts the request —
// an inactivity timeout, not a hard cap, so it's reset on every chunk
// received: a legitimately slow-but-progressing download of a large file
// isn't killed, while a stalled connection (DNS hang, dead socket, proxy
// swallowing the request) can no longer hang checkForUpdates() forever
// with no 'updater:done'/'updater:error' ever firing.
const _GET_INACTIVITY_TIMEOUT_MS = 20000;
const _MAX_REDIRECTS = 5;

// ── Helpers réseau ────────────────────────────────────────────────────────────
function _get(url, asBuffer = false, redirects = 0) {
  return new Promise((resolve, reject) => {
    // https only — the downloaded files are executed (Python) / loaded (renderer).
    if (!url.startsWith('https:')) return reject(new Error(`URL non-https refusée — ${url}`));
    const mod = url.startsWith('https') ? https : http;
    const controller = new AbortController();
    let timer;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), _GET_INACTIVITY_TIMEOUT_MS);
    };
    resetTimer();

    mod.get(url, {
      headers: { 'User-Agent': 'MacroEngine-Updater/1.0', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    }, (res) => {
      resetTimer();
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        clearTimeout(timer);
        res.resume();
        if (redirects >= _MAX_REDIRECTS) return reject(new Error(`Trop de redirections — ${url}`));
        if (!res.headers.location) return reject(new Error(`Redirection sans Location — ${url}`));
        const next = new URL(res.headers.location, url).href;
        return _get(next, asBuffer, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      const chunks = [];
      res.on('data', c => { resetTimer(); chunks.push(c); });
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf-8'));
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function fetchManifest() {
  return _get(MANIFEST_URL).then(body => JSON.parse(body));
}

function downloadFile(relPath, destPath, expectedHash) {
  return _get(BASE_URL + relPath, true).then(buf => {
    // Verify before touching disk — a truncated/tampered download must never
    // replace the working local file. The manifest is generated on a Windows
    // runner (CRLF checkout) while raw.githubusercontent serves the LF blob,
    // so a text file is also accepted in its CRLF form — and written that way,
    // so the next run's local hash matches instead of re-downloading forever.
    const sha = b => crypto.createHash('sha256').update(b).digest('hex');
    const got = sha(buf);
    if (got !== expectedHash) {
      const crlf = Buffer.from(buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
      if (sha(crlf) !== expectedHash) throw new Error(`hash SHA256 invalide (attendu ${expectedHash}, reçu ${got})`);
      buf = crlf;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = destPath + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, destPath);
  });
}

// ── Hash local ────────────────────────────────────────────────────────────────
function fileHash(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null; // fichier absent
  }
}

// ── API principale ────────────────────────────────────────────────────────────
/**
 * checkForUpdates(botDir, rendererDir, github, onProgress?)
 *
 * botDir       — dossier racine du bot (resources/bot/ en prod, ../ en dev)
 * rendererDir  — dossier renderer dépacké (resources/app.asar.unpacked/renderer/ en prod)
 * github       — { user, repo, branch } depuis app.config.json
 * onProgress   — callback(relPath) appelé pour chaque fichier téléchargé
 *
 * Retourne : { upToDate, version, updated[], errors[] }
 *
 * Convention des chemins dans le manifest :
 *   - fichiers Python : clé = "main.py", "modules/engine/actions.py", …
 *     → écrits dans botDir/<clé>
 *   - fichiers renderer : clé = "electron-app/renderer/js/app.js", …
 *     → écrits dans rendererDir/<partie après "electron-app/renderer/">
 */
const RENDERER_MANIFEST_PREFIX = 'electron-app/renderer/';

// Map a manifest key to its local path, or null if it would escape its base
// dir (the manifest is remote data — "../" or an absolute key must not let it
// write anywhere on disk).
function _localPathFor(relPath, botDir, rendererDir) {
  const isRenderer = relPath.startsWith(RENDERER_MANIFEST_PREFIX);
  const base = path.resolve(isRenderer ? rendererDir : botDir);
  const dest = path.resolve(base, isRenderer ? relPath.slice(RENDERER_MANIFEST_PREFIX.length) : relPath);
  return dest.startsWith(base + path.sep) ? dest : null;
}

async function checkForUpdates(botDir, rendererDir, github, onProgress) {
  const base = `https://raw.githubusercontent.com/${github.user}/${github.repo}/${github.branch}`;
  MANIFEST_URL = `${base}/update-manifest.json`;
  BASE_URL     = `${base}/`;
  const manifest = await fetchManifest();
  const { version, files } = manifest;

  // Fichiers exclus de la mise à jour automatique (modifiés localement)
  const SKIP_FILES = new Set(['main.py', 'modules/engine/screen_reader.py']);

  // Comparer les hashes
  // (package.json used to be force-updated on every run "pour version UI",
  // which made upToDate never true — the UI version comes from
  // app.getVersion() anyway, so it now follows the same hash rule.)
  const toUpdate = [];
  const errors   = [];
  for (const [relPath, expectedHash] of Object.entries(files)) {
    if (SKIP_FILES.has(relPath)) continue;
    const localPath = _localPathFor(relPath, botDir, rendererDir);
    if (!localPath) {
      errors.push({ file: relPath, error: 'chemin hors du dossier cible — ignoré' });
      continue;
    }
    if (fileHash(localPath) !== expectedHash) {
      toUpdate.push({ relPath, localPath, expectedHash });
    }
  }

  if (toUpdate.length === 0 && errors.length === 0) {
    return { upToDate: true, version, updated: [], errors: [] };
  }

  // Télécharger les fichiers modifiés
  const updated = [];

  for (const { relPath, localPath: destPath, expectedHash } of toUpdate) {
    try {
      await downloadFile(relPath, destPath, expectedHash);
      updated.push(relPath);
      if (onProgress) onProgress(relPath);
    } catch (e) {
      errors.push({ file: relPath, error: e.message });
    }
  }

  return { upToDate: false, version, updated, errors };
}

module.exports = { checkForUpdates };
