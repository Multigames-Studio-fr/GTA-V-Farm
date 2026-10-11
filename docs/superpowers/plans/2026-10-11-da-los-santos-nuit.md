# DA « Los Santos Nuit » — Lot 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Appliquer la DA « Los Santos Nuit » (spec `docs/superpowers/specs/2026-10-11-da-los-santos-nuit-design.md`) aux tokens globaux, à la sidebar et au dashboard de l'app Electron.

**Architecture:** On ne réécrit pas les 95 Ko de `styles.css`. On ajoute une feuille `electron-app/renderer/da.css`, chargée **après** `styles.css`, qui redéfinit les valeurs des tokens (`:root`) et surcharge les composants globaux (boutons, cartes, sidebar). Elle contient aussi les nouveaux styles du dashboard. Les polices Barlow sont embarquées en woff2 local. Le dashboard garde ses IDs ; seuls `#dash-running` et `.dash-quicknav` disparaissent. Une globale `abfNextCycleAt` exposée par l'Auto Bouffe alimente le KPI « Prochain repas ».

**Tech Stack:** Electron 28 (renderer HTML/CSS/JS vanilla, globals par fichier `page-*.js`), aucune lib UI.

## Global Constraints

- Couleurs exactes du spec : `--bg #0c0c0f`, `--bg-panel #101014`, `--bg-card #141418`, `--bg-card-2 #0f0f13`, `--bg-hover #1c1c22`, bordures `#1f1f26 / #2a2a33 / #3a3a46`, `--accent #e5372b`, `--accent-2 #ff6b5e`, texte `#ededf0 / #a3a3b2 / #6e6e7c`, `--label #9a9aa8`, états `#4ade80 / #fbbf24 / #ef4444`, `--radius 12px`, `--radius-sm 8px`.
- Polices : Barlow Condensed (600/700) pour les titres et les chiffres KPI, Barlow (400/500/600) pour le texte, corps à 14px. Fichiers locaux, plus d'`@import` Google Fonts.
- Ne renommer aucun ID ni aucune fonction globale existante, sauf la suppression de `#dash-running` et `.dash-quicknav`.
- Toute chaîne issue d'une macro injectée en HTML passe par `escHtml()` (défini dans `utils.js`).
- Pas de suite de tests dans le projet : la vérification se fait par `node --check` sur chaque JS modifié, puis contrôle visuel via `npm run dev` (depuis `electron-app/`).
- **Écart assumé vs spec :** le pied de sidebar garde son contenu actuel (statut moteur `#sidebar-dot` / `#sidebar-status-text` + bouton overlay), seulement restylé. Il n'existe pas aujourd'hui de données licence dans la sidebar, et en ajouter sort du lot.
- Ne pas commiter les fichiers hors périmètre (le working tree contient des corrections de bugs non commitées : `git add` uniquement les fichiers listés dans chaque tâche).

---

### Task 1: Polices Barlow locales

**Files:**
- Create: `electron-app/renderer/fonts/` (6 fichiers woff2)
- Modify: `electron-app/renderer/styles.css:5` (supprimer l'`@import` Google Fonts)

**Interfaces:**
- Produces: les familles CSS `'Barlow'` (400/500/600) et `'Barlow Condensed'` (600/700), déclarées en Task 2 via `@font-face` sur `fonts/*.woff2`.

- [ ] **Step 1: Télécharger les woff2 (sous-ensemble latin, qui couvre les accents français)**

```bash
cd "/d/GTAV/Script/GTA V FARM/electron-app/renderer" && mkdir -p fonts && cd fonts
B=https://cdn.jsdelivr.net/npm/@fontsource/barlow@5.0.13/files
C=https://cdn.jsdelivr.net/npm/@fontsource/barlow-condensed@5.0.13/files
for w in 400 500 600; do curl -fsSLo barlow-$w.woff2 $B/barlow-latin-$w-normal.woff2; done
for w in 600 700; do curl -fsSLo barlow-condensed-$w.woff2 $C/barlow-condensed-latin-$w-normal.woff2; done
ls -la
```

Expected : 5 fichiers `.woff2`, chacun > 10 Ko (barlow-400/500/600, barlow-condensed-600/700).

- [ ] **Step 2: Retirer l'import Google Fonts**

Dans `electron-app/renderer/styles.css`, supprimer la ligne 5 :

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
```

- [ ] **Step 3: Vérifier que les polices sont embarquées dans le build**

Run : `grep -n '"renderer/\*\*"\|asarUnpack\|"files"' electron-app/package.json`
Expected : `renderer/**` est couvert par `files`/`asarUnpack`, donc `renderer/fonts/` est inclus sans changement. Si ce n'est pas le cas, ajouter `"renderer/fonts/**"` au tableau `files`.

- [ ] **Step 4: Commit**

```bash
git add electron-app/renderer/fonts electron-app/renderer/styles.css
git commit -m "feat(ui): embarquer les polices Barlow en local"
```

---

### Task 2: `da.css` — tokens, base, composants, sidebar

**Files:**
- Create: `electron-app/renderer/da.css`
- Modify: `electron-app/renderer/index.html:9` (lier `da.css` après `styles.css`)

**Interfaces:**
- Consumes: `fonts/*.woff2` (Task 1).
- Produces: les tokens CSS du spec, plus les variables `--font-display: 'Barlow Condensed'` et `--ok / --warn / --err` utilisées en Task 3.

- [ ] **Step 1: Créer `electron-app/renderer/da.css`**

```css
/* ═══════════════════════════════════════════════════════════════
   DA « Los Santos Nuit » — surcouche chargée après styles.css.
   Redéfinit les valeurs des tokens existants (les noms restent pour
   que toutes les pages héritent) + composants globaux + dashboard.
   Spec : docs/superpowers/specs/2026-10-11-da-los-santos-nuit-design.md
   ═══════════════════════════════════════════════════════════════ */

@font-face { font-family: 'Barlow'; font-weight: 400; font-display: swap; src: url('fonts/barlow-400.woff2') format('woff2'); }
@font-face { font-family: 'Barlow'; font-weight: 500; font-display: swap; src: url('fonts/barlow-500.woff2') format('woff2'); }
@font-face { font-family: 'Barlow'; font-weight: 600; font-display: swap; src: url('fonts/barlow-600.woff2') format('woff2'); }
@font-face { font-family: 'Barlow Condensed'; font-weight: 600; font-display: swap; src: url('fonts/barlow-condensed-600.woff2') format('woff2'); }
@font-face { font-family: 'Barlow Condensed'; font-weight: 700; font-display: swap; src: url('fonts/barlow-condensed-700.woff2') format('woff2'); }

:root {
  --bg:          #0c0c0f;
  --bg-panel:    #101014;
  --bg-card:     #141418;
  --bg-card-2:   #0f0f13;
  --bg-input:    #0f0f13;
  --bg-hover:    #1c1c22;

  --border:      #1f1f26;
  --border-2:    #2a2a33;
  --border-3:    #3a3a46;
  --border-glow: rgba(229,55,43,.35);

  --accent:       #e5372b;
  --accent-2:     #ff6b5e;
  --accent-dim:   #8a1f17;
  --accent-glow:  rgba(229,55,43,.18);
  --accent-glow2: rgba(229,55,43,.08);

  /* États — seules couleurs autorisées en plus de l'accent */
  --ok:   #4ade80;
  --warn: #fbbf24;
  --err:  #ef4444;
  --green: var(--ok);  --green-dim: rgba(74,222,128,.12);
  --orange: var(--warn); --orange-dim: rgba(251,191,36,.12);
  /* Décoratives retirées : remappées sur le neutre */
  --gold: var(--text-2);   --gold-dim: rgba(255,255,255,.04);
  --cyan: var(--text-2);   --cyan-dim: rgba(255,255,255,.04);
  --purple: var(--text-2); --purple-dim: rgba(255,255,255,.04);

  --text:   #ededf0;
  --text-2: #a3a3b2;
  --text-3: #6e6e7c;
  --label:  #9a9aa8;

  --font:         'Barlow', 'Segoe UI', system-ui, sans-serif;
  --font-display: 'Barlow Condensed', 'Barlow', 'Segoe UI', sans-serif;

  --radius:    12px;
  --radius-sm: 8px;
  --sidebar-w: 232px;

  --shadow-sm: none;
  --shadow-md: 0 4px 16px rgba(0,0,0,.4);
}

html, body { font-size: 14px; }
body::before { display: none; }

/* ── Titres ──────────────────────────────────────────────────── */
.page-header h1 {
  font-family: var(--font-display); font-weight: 700;
  font-size: 34px; letter-spacing: .02em; text-transform: uppercase;
}
.page-header { border-bottom: none; padding-bottom: 6px; }

/* ── Boutons ─────────────────────────────────────────────────── */
.btn { min-height: 36px; border-radius: var(--radius-sm); font-size: 14px; }
.btn-primary,
.btn-danger,
.btn-stop {
  background: var(--accent); color: #fff; border: 0; box-shadow: none;
}
.btn-primary:hover:not(:disabled),
.btn-danger:hover:not(:disabled),
.btn-stop:hover:not(:disabled) { background: var(--accent-2); box-shadow: none; opacity: 1; }
.btn-secondary { background: transparent; border: 1px solid var(--border-2); color: var(--text); }
.btn-success,
.btn-start { background: var(--ok); color: #06210f; box-shadow: none; }
.btn-success:hover:not(:disabled),
.btn-start:hover:not(:disabled) { box-shadow: none; opacity: .9; }
.btn-lg { min-height: 44px; padding: 0 18px; }

/* ── Cartes (sans glow ni dégradé) ───────────────────────────── */
.card, .settings-card, .dash-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: none;
}
.card::before, .settings-card::before, .dash-card::before { display: none; }
.settings-card:hover { box-shadow: none; }

/* ── Sidebar ─────────────────────────────────────────────────── */
#sidebar::before { display: none; }
.sidebar-brand { padding: 22px 18px; border-bottom: none; background: none; }
.brand-icon {
  width: 30px; height: 30px; border-radius: 7px;
  background: var(--accent); box-shadow: none;
}
.brand-icon svg { width: 16px; height: 16px; }
.brand-name {
  font-family: var(--font-display); font-weight: 700;
  font-size: 20px; letter-spacing: .02em; text-transform: uppercase;
}
.brand-ver { font-size: 11px; color: var(--text-3); }
.sidebar-nav { padding: 6px 12px; }
.nav-item {
  color: var(--text-2); border: 0; border-radius: var(--radius-sm);
  padding: 10px 12px; font-weight: 500;
}
.nav-item span { font-size: 14px; }
.nav-item:hover { background: var(--bg-hover); color: var(--text); border: 0; }
.nav-item.active {
  background: var(--bg-hover); color: #fff; border: 0;
  box-shadow: inset 3px 0 0 var(--accent);
}
.nav-item.active::before { display: none; }
.nav-item.active svg { color: var(--accent); }
.sidebar-footer { background: none; padding: 14px 16px; }
.status-badge { font-size: 12px; color: var(--text-2); }
.dot.running { background: var(--ok); box-shadow: none; }
.overlay-toggle-btn.active {
  background: var(--accent-glow2); color: var(--accent-2);
  border-color: rgba(229,55,43,.35); box-shadow: none;
}

/* ── États vides ─────────────────────────────────────────────── */
.empty-state { color: var(--text-2); }
```

- [ ] **Step 2: Lier la feuille dans `index.html`**

Remplacer la ligne 9 :

```html
  <link rel="stylesheet" href="styles.css">
```

par :

```html
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="da.css">
```

- [ ] **Step 3: Vérifier dans l'app**

Run : `cd electron-app && npm run dev`
Expected :
- fond plus neutre, sans grille de points ;
- sidebar avec le titre « MACROENGINE » en condensé et l'item actif marqué d'une barre rouge à gauche ;
- texte en Barlow (DevTools `Ctrl+Shift+I` → Network : les `fonts/barlow-*.woff2` sont chargées en 200, sans requête vers `fonts.googleapis.com`).

Ouvrir aussi Macros, Auto Bouffe, Auto Clicker et Paramètres : rien ne doit être cassé (le polish par page relève du lot 2).

- [ ] **Step 4: Commit**

```bash
git add electron-app/renderer/da.css electron-app/renderer/index.html
git commit -m "feat(ui): DA Los Santos Nuit — tokens, composants et sidebar"
```

---

### Task 3: Dashboard — markup + styles

**Files:**
- Modify: `electron-app/renderer/index.html:132-241` (bloc `<section id="page-dashboard">`)
- Modify: `electron-app/renderer/da.css` (ajout en fin de fichier)

**Interfaces:**
- Consumes: tokens de Task 2.
- Produces, pour Task 4, ces IDs : `#val-uptime`, `#val-running-count`, `#val-total-macros`, `#val-running-sub`, `#val-total-cycles`, `#val-next-meal`, `#val-next-meal-sub`, `#val-total-errors`, `#dash-ql-grid`, `#dash-console`, `#dash-history`, `#btn-stop-all`. Ainsi que les classes `.dash-macro-row`, `.dash-macro-dot`, `.dash-macro-dot.on`, `.dash-macro-main`, `.dash-macro-name`, `.dash-macro-meta`, `.dash-macro-stat`, `.dash-macro-actions`, `.dash-icon`.

- [ ] **Step 1: Remplacer le bloc dashboard dans `index.html`**

Remplacer tout le contenu, de `<section class="page active" id="page-dashboard">` jusqu'à son `</section>` fermant (lignes 132-241), par :

```html
    <section class="page active" id="page-dashboard">
      <header class="dash-head">
        <div class="dash-head-text">
          <div class="dash-eyebrow">Session · <span id="val-uptime">--:--</span></div>
          <h1 class="dash-title">Tableau de bord</h1>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-lg" type="button" onclick="navigate('macros');addMacro()">Nouvelle macro</button>
          <button class="btn btn-danger btn-lg" type="button" id="btn-stop-all" onclick="stopAllMacros()" title="Arrêter toutes les macros">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            Stop tout <span class="dash-kbd">F12</span>
          </button>
        </div>
      </header>

      <div class="dash-kpis" role="group" aria-label="Indicateurs">
        <div class="dash-kpi2">
          <div class="dash-kpi2-label">Macros en cours</div>
          <div class="dash-kpi2-value"><span id="val-running-count">0</span><span class="dash-kpi2-of"> / <span id="val-total-macros">0</span></span></div>
          <div class="dash-kpi2-sub" id="val-running-sub">Aucune macro active</div>
        </div>
        <div class="dash-kpi2">
          <div class="dash-kpi2-label">Cycles (macros actives)</div>
          <div class="dash-kpi2-value" id="val-total-cycles">0</div>
          <div class="dash-kpi2-sub">Rafraîchi toutes les 2 s</div>
        </div>
        <div class="dash-kpi2">
          <div class="dash-kpi2-label">Prochain repas</div>
          <div class="dash-kpi2-value" id="val-next-meal">—</div>
          <div class="dash-kpi2-sub" id="val-next-meal-sub">Auto Bouffe arrêté</div>
        </div>
        <div class="dash-kpi2">
          <div class="dash-kpi2-label">Erreurs (macros actives)</div>
          <div class="dash-kpi2-value" id="val-total-errors">0</div>
          <div class="dash-kpi2-sub">Depuis le lancement des macros</div>
        </div>
      </div>

      <div class="dash-main">
        <section class="dash-panel dash-panel-wide" aria-labelledby="dash-macros-title">
          <div class="dash-panel-head">
            <h2 class="dash-panel-title" id="dash-macros-title">Macros</h2>
            <button class="btn btn-secondary btn-sm" type="button" onclick="navigate('macros')">Tout voir</button>
          </div>
          <div id="dash-ql-grid" class="dash-macro-list">
            <div class="empty-state">Aucune macro créée</div>
          </div>
        </section>

        <section class="dash-panel" aria-labelledby="dash-activity-title">
          <div class="dash-panel-head">
            <h2 class="dash-panel-title" id="dash-activity-title">Activité</h2>
          </div>
          <div id="dash-console" class="console-output dash-activity"></div>
        </section>
      </div>

      <details class="dash-panel dash-history-wrap">
        <summary class="dash-panel-title">Historique des runs <span class="dash-muted">— persiste entre les redémarrages</span></summary>
        <div id="dash-history" class="dash-history-list">
          <div class="empty-state">Aucun run terminé pour l'instant</div>
        </div>
      </details>
    </section>
```

- [ ] **Step 2: Ajouter les styles du dashboard à la fin de `da.css`**

```css
/* ═══════════════ DASHBOARD ═══════════════ */
#page-dashboard { gap: 24px; }
.dash-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dash-head-text { display: flex; flex-direction: column; gap: 4px; }
.dash-eyebrow { font-size: 13px; color: var(--label); text-transform: uppercase; letter-spacing: .12em; font-variant-numeric: tabular-nums; }
.dash-title {
  font-family: var(--font-display); font-weight: 700; font-size: 44px;
  line-height: 1; letter-spacing: .01em; text-transform: uppercase; color: var(--text);
}
.dash-kbd { font-size: 12px; opacity: .75; font-weight: 500; }

.dash-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.dash-kpi2 {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.dash-kpi2-label { font-size: 13px; color: var(--label); }
.dash-kpi2-value {
  font-family: var(--font-display); font-weight: 600; font-size: 40px; line-height: 1;
  color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dash-kpi2-of { color: var(--text-3); }
.dash-kpi2-sub { font-size: 12px; color: var(--label); }
.dash-kpi2-sub.ok { color: var(--ok); }

.dash-main { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
.dash-panel {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 20px; display: flex; flex-direction: column; gap: 14px; min-width: 0;
}
.dash-panel-wide { grid-column: span 2; }
.dash-panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.dash-panel-title {
  font-family: var(--font-display); font-weight: 600; font-size: 22px;
  letter-spacing: .02em; text-transform: uppercase; color: var(--text);
}
.dash-muted { font-family: var(--font); font-size: 13px; font-weight: 400; color: var(--label); text-transform: none; letter-spacing: 0; }

.dash-macro-list { display: flex; flex-direction: column; gap: 8px; }
.dash-macro-row {
  display: flex; align-items: center; gap: 14px; padding: 12px 14px;
  border-radius: 10px; background: var(--bg-card-2); border: 1px solid #1c1c22;
}
.dash-macro-dot { width: 8px; height: 8px; border-radius: 50%; background: #4a4a55; flex-shrink: 0; }
.dash-macro-dot.on { background: var(--ok); }
.dash-macro-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-macro-name { font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-macro-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--label); }
.dash-macro-stat { display: inline-flex; align-items: center; gap: 5px; }
.dash-macro-stat.err { color: var(--err); }
.dash-macro-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dash-icon { width: 12px; height: 12px; flex-shrink: 0; }

.dash-activity { max-height: 360px; background: transparent; border: 0; padding: 0; font-size: 13px; }
.dash-activity .log-line { display: flex; gap: 10px; padding: 3px 0; line-height: 1.4; }
.dash-activity .log-ts { color: var(--text-3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.dash-activity .log-lvl { display: none; }
.dash-activity .log-msg { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.dash-activity .log-warning .log-msg { color: var(--warn); }
.dash-activity .log-error .log-msg { color: var(--err); }
.dash-activity .log-debug .log-msg { color: var(--text-2); }

.dash-history-wrap > summary { cursor: pointer; list-style: none; }
.dash-history-wrap > summary::-webkit-details-marker { display: none; }
.dash-history-wrap > summary::before { content: '▸ '; color: var(--text-3); }
.dash-history-wrap[open] > summary::before { content: '▾ '; }

@media (max-width: 1100px) {
  .dash-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dash-main { grid-template-columns: minmax(0, 1fr); }
  .dash-panel-wide { grid-column: auto; }
}
```

- [ ] **Step 3: Vérifier que `addMacro` et `navigate` existent comme globales**

Run : `grep -n "^function addMacro\|^function navigate\|^async function navigate" electron-app/renderer/js/*.js`
Expected : `macros-data.js: function addMacro()` et `app.js: function navigate(`.

- [ ] **Step 4: Commit**

```bash
git add electron-app/renderer/index.html electron-app/renderer/da.css
git commit -m "feat(ui): nouveau layout du dashboard (KPI, macros, activité, historique)"
```

---

### Task 4: Dashboard — rendu JS + « Prochain repas »

**Files:**
- Modify: `electron-app/renderer/js/page-autobouffe.js` (globale `abfNextCycleAt` : déclaration en tête, mise à jour dans `_abfIntervalLoop` ~l.501, remise à zéro dans `stopAutoBouffe` ~l.81)
- Modify: `electron-app/renderer/js/page-dashboard.js` (fichier entier)

**Interfaces:**
- Consumes : les IDs et classes de Task 3 ; les globales existantes `macros` (array), `runningMacros` (Set de noms), `escHtml`, `startMacro(idx)`, `stopMacroByName(name)`, `selectMacro(idx)`, `navigate(page)`, `window.api.getStats()`, `window.api.getMacroHistory({limit})`.
- Produces : `let abfNextCycleAt = null` (timestamp ms du prochain cycle Auto Bouffe, ou `null`).

- [ ] **Step 1: Exposer `abfNextCycleAt` dans `page-autobouffe.js`**

Juste après `let _abfCapturing = null;` (ligne 4), ajouter :

```js
let abfNextCycleAt = null;     // timestamp ms of the next scheduled cycle (read by the dashboard), null when stopped
```

Dans `stopAutoBouffe()`, après `_abfRunning = false;`, ajouter :

```js
  abfNextCycleAt = null;
```

Dans `_abfIntervalLoop`, juste avant la ligne `appendLog('INFO', \`Auto Bouffe: cycle terminé (...`, ajouter :

```js
    abfNextCycleAt = Date.now() + intervalMs;
```

- [ ] **Step 2: Réécrire `electron-app/renderer/js/page-dashboard.js`**

Contenu complet :

```js
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
  el.innerHTML = rows.map(({ m, i, on }) => {
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
  }, 2000);
  _refreshDashStats().then(() => { _renderDashKpisFromStats(); _renderDashMacroList(); });
}
```

- [ ] **Step 3: Vérifier qu'aucun autre fichier n'appelle les fonctions supprimées ou renommées**

Run : `grep -rn "_renderDashRunningList\|_renderDashQuickLaunch\|dash-running\|dash-quicknav\|dash-qnav" electron-app/renderer --include=*.js --include=*.html`
Expected : aucun résultat. Si un appelant existe (par exemple dans `macros-runner.js` après un start ou un stop), remplacer l'appel par `_renderDashMacroList()`.

- [ ] **Step 4: Syntax check**

Run : `node --check electron-app/renderer/js/page-dashboard.js && node --check electron-app/renderer/js/page-autobouffe.js && echo OK`
Expected : `OK`

- [ ] **Step 5: Vérifier dans l'app**

Run : `cd electron-app && npm run dev`
Expected :
1. Le dashboard s'affiche, sans erreur dans la console DevTools.
2. « Lancer » sur une macro : en 2 s ou moins, elle passe en tête avec un point vert et ses stats, « Macros en cours » passe à 1, et le surtitre « Session · » avance.
3. « Arrêter » : la macro redescend parmi les inactives.
4. Démarrer l'Auto Bouffe, puis revenir sur le dashboard après le premier cycle : « Prochain repas » affiche `hh:mm` et « dans … ». Arrêter l'Auto Bouffe : « — » et « Auto Bouffe arrêté ».
5. « Historique des runs » est replié, et s'ouvre au clic.

- [ ] **Step 6: Commit**

```bash
git add electron-app/renderer/js/page-dashboard.js electron-app/renderer/js/page-autobouffe.js
git commit -m "feat(ui): dashboard — liste de macros fusionnée, icônes, KPI prochain repas"
```

---

### Task 5: Finalisation

**Files:**
- Modify: aucun (vérification + graph)

- [ ] **Step 1: Tour visuel des autres pages**

`npm run dev`, puis ouvrir Macros, Macros 🧪, Auto Clicker, Auto Bouffe et Paramètres. Noter, sans corriger (lot 2), tout élément illisible ou cassé.

- [ ] **Step 2: Rafraîchir le graph**

Run : `graphify update .`

- [ ] **Step 3: Rapport**

Lister ce qui a été livré, plus les défauts notés au Step 1, en candidats pour le lot 2.
