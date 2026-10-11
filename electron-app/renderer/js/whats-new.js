'use strict';
/* ═══════════════════════════════════════════════════════════════
   « QUOI DE NEUF » — modal shown once per version after the license
   check and the debug-consent modal (chained in app.js init()).
   CHANGELOG.md is read by the main process (app:changelog) and
   parsed here with a deliberately small Markdown subset; everything
   is inserted with textContent / createElement — no HTML from the
   file is ever parsed as markup.
   Spec : docs/superpowers/specs/2026-10-11-overlay-whatsnew-design.md
════════════════════════════════════════════════════════════════ */

const WN_SECTIONS = {
  added:   { title: 'NOUVEAUTÉS',    cls: 'wn-sec-added' },
  fixed:   { title: 'CORRECTIONS',   cls: 'wn-sec-fixed' },
  changed: { title: 'AMÉLIORATIONS', cls: 'wn-sec-changed' },
  other:   { title: 'AUTRES',        cls: 'wn-sec-other' },
};

function wnSectionKey(heading) {
  const h = String(heading || '').trim().toLowerCase();
  // (?!\p{L}) rather than \b: \b treats « é » as a non-word character.
  if (/^(added|ajoutés?|nouveautés?)(?!\p{L})/u.test(h)) return 'added';
  if (/^(fixed|corrigés?|corrections?)(?!\p{L})/u.test(h)) return 'fixed';
  if (/^(changed|améliorés?|améliorations?)(?!\p{L})/u.test(h)) return 'changed';
  return 'other';
}

// "- 🐛 **Titre** — description" → { t: 'Titre', d: 'description' }
// Without leading bold, a short "Préfixe : reste" prefix becomes the title.
function wnParseItem(raw) {
  let txt = String(raw || '').trim();
  // Leading emoji / pictographs used as bullets in the changelog (🐛 ✨ 🎉 📝 …)
  txt = txt.replace(/^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]+\s*)+/u, '');
  let t = '', d = txt;
  const bold = txt.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (bold) {
    t = bold[1].trim();
    d = bold[2].replace(/^[\s:—–-]+/, '');
  } else {
    const m = txt.match(/^([^:]{2,48}?)\s+:\s+(.+)$/);
    if (m && !/[`*]/.test(m[1])) { t = m[1].trim(); d = m[2]; }
  }
  const clean = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').trim();
  return { t: clean(t), d: clean(d) };
}

// → [{ version, date, sections: [{ key, title, items: [{t, d}] }] }], newest first (file order)
function parseChangelog(md) {
  const versions = [];
  let cur = null, sec = null, lastItem = null;
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    const vm = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?\s*(?:[–—-]\s*(.*))?$/);
    if (vm) {
      cur = { version: vm[1], date: (vm[2] || '').trim(), sections: [] };
      versions.push(cur);
      sec = null; lastItem = null;
      continue;
    }
    if (!cur) continue;
    const sm = line.match(/^###\s+(.+?)\s*$/);
    if (sm) {
      const key = wnSectionKey(sm[1]);
      sec = cur.sections.find(s => s.key === key);
      if (!sec) { sec = { key, title: WN_SECTIONS[key].title, items: [] }; cur.sections.push(sec); }
      lastItem = null;
      continue;
    }
    const im = line.match(/^\s*[-*]\s+(.+)$/);
    if (im) {
      if (!sec) { sec = { key: 'other', title: WN_SECTIONS.other.title, items: [] }; cur.sections.push(sec); }
      lastItem = wnParseItem(im[1]);
      sec.items.push(lastItem);
      continue;
    }
    // Continuation line of a wrapped bullet
    if (lastItem && /^\s{2,}\S/.test(line)) {
      lastItem.d = (lastItem.d + ' ' + wnParseItem(line).d).trim();
      continue;
    }
    if (/^---\s*$/.test(line)) { sec = null; lastItem = null; }
  }
  // Keep the canonical section order whatever the file order
  const order = ['added', 'fixed', 'changed', 'other'];
  for (const v of versions) {
    v.sections = v.sections.filter(s => s.items.length)
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return versions;
}

function changelogFor(md, version) {
  const v = String(version || '').replace(/^v/, '');
  return parseChangelog(md).find(e => e.version === v) || null;
}

/* ── DOM ───────────────────────────────────────────────────── */
function _wnEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function _wnRenderSections(parent, entry) {
  for (const s of entry.sections) {
    const box = _wnEl('div', 'wn-sec ' + (WN_SECTIONS[s.key] || WN_SECTIONS.other).cls);
    const h = _wnEl('h3', 'wn-sec-title');
    h.appendChild(_wnEl('span', 'wn-sec-dot'));
    h.appendChild(document.createTextNode(s.title));
    box.appendChild(h);
    for (const it of s.items) {
      const row = _wnEl('div', 'wn-item');
      if (it.t) row.appendChild(_wnEl('span', 'wn-item-t', it.t));
      if (it.d) row.appendChild(_wnEl('span', 'wn-item-d', it.d));
      box.appendChild(row);
    }
    parent.appendChild(box);
  }
}

let _wnState = null; // { md, version, from, all }

function _wnRender() {
  const body = document.getElementById('wn-body');
  const ver  = document.getElementById('wn-ver');
  const badge = document.getElementById('wn-badge');
  const toggle = document.getElementById('wn-toggle-all');
  if (!body || !_wnState) return;
  body.textContent = '';
  const { md, version, from, all } = _wnState;
  const entries = parseChangelog(md);
  if (all) {
    badge.textContent = 'HISTORIQUE';
    ver.textContent = `${entries.length} version${entries.length > 1 ? 's' : ''}`;
    toggle.textContent = 'Retour aux nouveautés';
    for (const e of entries) {
      const vh = _wnEl('h3', 'wn-ver-head', `v${e.version}${e.date ? ' · ' + e.date : ''}`);
      body.appendChild(vh);
      _wnRenderSections(body, e);
    }
    if (!entries.length) body.appendChild(_wnEl('p', 'wn-empty', 'Historique indisponible.'));
  } else {
    const e = entries.find(x => x.version === version);
    badge.textContent = 'MISE À JOUR';
    ver.textContent = (from && from !== version ? `v${from} → ` : '') + `v${version}` + (e && e.date ? ` · ${e.date}` : '');
    toggle.textContent = "Voir tout l'historique des versions";
    if (e && e.sections.length) _wnRenderSections(body, e);
    else body.appendChild(_wnEl('p', 'wn-empty', 'Pas de notes pour cette version.'));
  }
  body.scrollTop = 0;
}

// Opens the modal; resolves when it is closed.
async function openWhatsNew(opts = {}) {
  const modal = document.getElementById('whatsnew-modal');
  if (!modal || modal.style.display === 'flex') return;
  let res = null;
  try { res = await window.api.getChangelog(); } catch (_) {}
  const version = (res && res.version) || window._macroEngineVersion || '';
  _wnState = { md: (res && res.ok && res.text) || '', version, from: opts.from || '', all: false };
  _wnRender();

  const closeBtn = document.getElementById('wn-close');
  const toggle   = document.getElementById('wn-toggle-all');
  const prevFocus = document.activeElement;
  return new Promise((resolve) => {
    function close() {
      document.removeEventListener('keydown', onKey, true);
      modal.style.display = 'none';
      closeBtn.onclick = null; toggle.onclick = null;
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
      resolve();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') {
        // Keep focus inside the dialog (two controls + the scrollable body)
        const f = [toggle, closeBtn];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length].focus();
      }
    }
    closeBtn.onclick = close;
    toggle.onclick = () => { _wnState.all = !_wnState.all; _wnRender(); };
    document.addEventListener('keydown', onKey, true);
    modal.style.display = 'flex';
    closeBtn.focus();
  });
}

// Startup: first install → record the version silently; version changed → show, then record.
async function maybeShowWhatsNew() {
  let s, version;
  try {
    s = (await window.api.readSettings()) || {};
    version = (await window.api.getConfig())?.version || window._macroEngineVersion;
  } catch (_) { return; }
  if (!version) return;
  const seen = s.lastSeenVersion;
  if (seen === version) return;
  if (seen !== undefined && seen !== null && seen !== '') {
    await openWhatsNew({ from: seen });
  }
  try {
    const cur = (await window.api.readSettings()) || {};
    cur.lastSeenVersion = version;
    await window.api.writeSettings(cur);
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-open-whatsnew')?.addEventListener('click', () => openWhatsNew());
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseChangelog, changelogFor, wnParseItem, wnSectionKey };
}
