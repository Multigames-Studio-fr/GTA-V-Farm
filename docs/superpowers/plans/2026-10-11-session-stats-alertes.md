# Stats de session + alertes Discord ciblées + capture sur alerte — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implémenter la spec `docs/superpowers/specs/2026-10-11-session-stats-alertes-design.md`.

**Architecture:**
- **Moteur Python (`main.py`)** : il gère seul l'envoi Discord. On y ajoute les événements critiques mis en file au lieu d'être supprimés, la mention, la capture du jeu, un thread de surveillance (processus FiveM, seuil d'erreurs), la réception d'un instantané de session poussé par le renderer, et une commande `session_shutdown` qui envoie le résumé de manière synchrone avant la fermeture.
- **Renderer** : il agrège les stats (nouveau `session-stats.js`) et les affiche sur le dashboard. L'Auto Bouffe signale ses succès et échecs. Les réglages sont dans Paramètres › Discord.
- **Electron main** : on autorise les 2 nouvelles commandes et on appelle `session_shutdown` avant `killEngine()` à la fermeture.

**Tech Stack:** Python 3 stdlib (`urllib`, `threading`), `psutil`, `mss`/PIL déjà présents ; Electron 28 ; renderer en JS classique (globales partagées, pas de modules).

## Global Constraints

- **Rien n'est commité** (décision de l'utilisateur : il commite après test en dev). Ne lancer ni `git add` ni `git commit`. Le working tree contient d'autres changements non commités, qui ne doivent pas être touchés.
- Webhook : ne jamais envoyer ailleurs qu'à `_webhook_url`. Rien ne part si l'URL est vide.
- Événements critiques : `{'game_closed', 'macro_errors', 'autobouffe_fail'}`.
- Nouveaux settings et défauts : `webhookMentionId` (`''`), `webhookErrorThreshold` (`5`), `webhookAlertScreenshot` (`true`), `webhookSessionOnExit` (`true`). Côté moteur, les clés `set_webhook` correspondantes sont `mention_id`, `error_threshold`, `alert_screenshot`, `session_on_exit`.
- Toute chaîne venant d'une macro ou de l'utilisateur injectée en HTML passe par `escHtml()`.
- Le JS reste en scripts classiques. Une nouvelle page ou un nouveau module se charge par `<script defer>` avant `app.js` (voir CLAUDE.md « Adding Features »).
- Le moteur IPC n'écrit que du JSON Lines sur stdout. Aucun `print` direct.
- Vérification : pas de suite de tests dans le projet. Chaque tâche écrit un **script de test headless dans le scratchpad** `C:\Users\Pedro\AppData\Local\Temp\claude\D--GTAV-Script-GTA-V-FARM\f40a121e-6fcc-4817-af65-b788252bbd56\scratchpad\`, jamais dans le repo, et colle sa sortie dans le rapport. `python -m py_compile` ou `node --check` sur chaque fichier modifié.

---

### Task 1: Moteur — événements critiques, file d'attente, mention, capture du jeu

**Files:** Modify `main.py` (state webhook ~l.124-142, `_EVENT_STYLE` ~l.704, `_build_discord_embed` ~l.716, `_send_webhook` ~l.790-935, `_cmd_set_webhook` ~l.1242).

**Produces (utilisé par la Task 2) :**
- `_CRITICAL_EVENTS: set[str]`
- `_send_webhook(event, data)`, qui garde sa signature et renvoie `'sent'`, `'queued'` (nouveau), `'no_url'`, `'event_filtered'`, `'disabled'` ou `'rate_limited'`.
- `_send_webhook_sync(event, data, timeout=5.0) -> bool` : envoi bloquant dans le thread appelant, sans limite de débit. Il sert pour le résumé à la fermeture.
- Les globales de config `_webhook_mention_id: str`, `_webhook_error_threshold: int`, `_webhook_alert_screenshot: bool`, `_webhook_session_on_exit: bool`.

- [ ] **Step 1 — État et styles.**
  - Ajouter près de `_webhook_events` les 4 globales de config, avec les défauts des Global Constraints, plus `_CRITICAL_EVENTS`.
  - Ajouter `'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary'` à l'ensemble par défaut `_webhook_events`.
  - Dans `_EVENT_STYLE`, ajouter :
    - `'game_closed': ('💥', 'FiveM fermé / crashé', 0xef4444)`
    - `'macro_errors': ('⚠️', 'Erreurs macro', 0xfbbf24)`
    - `'autobouffe_fail': ('🍔', 'Auto Bouffe en échec', 0xef4444)`
    - `'session_summary': ('📊', 'Résumé de session', 0x5865F2)`
  - Dans `_build_discord_embed`, ajouter à la liste « 📋 Détails » les clés `('errors', 'Erreurs')`, `('threshold', 'Seuil')` et `('outcome', 'Résultat')`.
  - Si `data.get('summary_lines')` (liste de str) est présent, ajouter un champ « 📊 Session » non inline, avec les lignes jointes par `\n` et tronquées à 1024 caractères.

- [ ] **Step 2 — Factoriser l'envoi.**
  - Extraire le corps HTTP de `_do_send` (construction du payload, multipart, `urlopen`, gestion des erreurs 403/429/réseau) dans `_post_webhook(event, data, timeout_cap=None)`, exécutable dans n'importe quel thread.
  - `_do_send` l'appelle, et le comportement existant reste identique.
  - Dans `_post_webhook`, si `event in _CRITICAL_EVENTS` :
    - si `_webhook_mention_id` est non vide et entièrement numérique, ajouter au payload JSON Discord (et au champ `payload_json` du multipart) `content: f'<@{id}>'` et `allowed_mentions: {'users': [id]}` ;
    - si `_webhook_alert_screenshot` est vrai et que `_webhook_debug_screenshot` est faux, capturer via `_capture_game_png()` (Step 3) et joindre `('alert.png', 'image/png', bytes)`, avec `embed['image'] = {'url': 'attachment://alert.png'}`.
  - Vérifier comment `_build_discord_multipart` place l'embed dans `payload_json`, et y faire passer `content`/`allowed_mentions` : ajouter un paramètre `extra: dict | None` fusionné dans `payload_json`.

- [ ] **Step 3 — `_capture_game_png() -> bytes | None`.**
  - Trouver la fenêtre FiveM : `from modules.engine.window_manager import list_windows`, puis la première fenêtre dont `exe.lower()` contient `fivem` et dont le rect a une aire > 0 (vérifier les clés réellement renvoyées par `list_windows`).
  - Capturer ce rect avec `mss` (le pattern de `screen_reader`/`capture_all_screens` déjà utilisé dans `_gather_debug_report`), sinon le moniteur principal.
  - Réduire à 1280 px de large maximum avec PIL (`Image.thumbnail`), encoder en PNG.
  - Toute exception renvoie `None`.
  - Appeler `_release_sct()` si le code passe par `screen_reader`.

- [ ] **Step 4 — File d'attente des critiques.**
  - Dans `_send_webhook`, sous rate-limit (`now - _webhook_last_sent < _webhook_min_interval`) :
    - si l'événement est critique, réserver le prochain créneau (`slot = _webhook_last_sent + _webhook_min_interval`, puis `_webhook_last_sent = slot` sous le lock) ;
    - lancer un `threading.Timer(slot - now, <thread d'envoi>)` en daemon ;
    - renvoyer `'queued'`.
  - Les non critiques gardent `'rate_limited'`.
  - Ajouter `'queued'` à `_WEBHOOK_STATUS_MSG` et traiter `'queued'` comme un succès dans `_cmd_send_webhook`.

- [ ] **Step 5 — `_send_webhook_sync`.**
  - Retour immédiat `False` si l'URL est vide, si le webhook est désactivé ou si l'événement est filtré.
  - Sinon, appel de `_post_webhook(event, data, timeout_cap=timeout)` dans le thread courant, sans rapport debug.
  - Renvoie `True` si HTTP 2xx, `False` sinon.
  - Faire en sorte que `_post_webhook` renvoie un booléen de succès.

- [ ] **Step 6 — `_cmd_set_webhook`.**
  - Lire les clés optionnelles `mention_id` (str, gardée uniquement si `.isdigit()`, sinon `''`), `error_threshold` (int, au moins 1), `alert_screenshot` (bool) et `session_on_exit` (bool).
  - Une clé absente ne change pas la valeur actuelle.

- [ ] **Step 7 — Test headless** (scratchpad, `test_webhook_alerts.py`) :
  - importer `main` sans lancer la boucle stdin (vérifier que `main.py` a un garde `if __name__ == '__main__'`, sinon importer via `importlib` et documenter) ;
  - monkeypatcher `urllib.request.urlopen` pour capturer les requêtes et `_capture_game_png` pour renvoyer des octets factices ;
  - vérifier :
    - (a) l'embed de chaque nouvel événement a le bon titre ;
    - (b) deux critiques à 0,1 s d'intervalle → la 2ᵉ renvoie `'queued'` et part environ 2 s plus tard ;
    - (c) un non critique dans le même cas renvoie `'rate_limited'` ;
    - (d) avec `mention_id='123'`, le payload d'un critique contient `<@123>` et `allowed_mentions` ;
    - (e) `mention_id='abc'` est rejeté ;
    - (f) `_send_webhook_sync` renvoie `True` sur un 204 simulé.
  - `python -m py_compile main.py`.

---

### Task 2: Moteur — surveillance, instantané de session, envoi à la fermeture (+ câblage Electron)

**Files:**
- Modify `main.py` (ajouter le watcher, les commandes `set_session_snapshot` / `session_shutdown`, leur enregistrement dans la table de dispatch ~l.1609).
- Modify `electron-app/main.js` (allowlist ~l.706, flux de fermeture).
- Modify `electron-app/preload.js` (~l.44).

**Consumes:** `_send_webhook`, `_send_webhook_sync`, `_CRITICAL_EVENTS` et les globales de config de la Task 1 ; `_runners`, `_runners_lock` et `r.is_running()` existants ; les stats par runner, avec le même accès que `_cmd_get_stats` (~l.1458, à lire pour obtenir le nombre d'erreurs d'un runner).

**Produces (utilisé par la Task 3) :**
- IPC `set_session_snapshot` avec la charge `{snapshot: {...}, abf_running: bool}`, qui répond `{ok:true}`. `snapshot` a la forme décrite dans la Task 3.
- IPC `session_shutdown` sans paramètre, qui répond `{ok:true, sent: bool}`.
- Preload : `window.api.setSessionSnapshot(p)` et `window.api.sessionShutdown()`.

- [ ] **Step 1 — Watcher.**
  - Thread daemon `alert-watch` démarré au boot du moteur, à côté du RAM monitor. Toutes les 10 s, `active = any runner running or _abf_running` (`_abf_running` est mis à jour par `set_session_snapshot`).
  - **Jeu fermé** :
    - si `active`, tester la présence d'un processus dont le nom en minuscules contient `fivem` (`psutil.process_iter(['name'])`) ;
    - mémoriser `_game_seen` : passage de vrai à faux pendant `active` → `_send_webhook('game_closed', {'message': 'Plus aucun processus FiveM détecté', 'active_macros': ...})` ;
    - réarmer quand le jeu revient ;
    - si le jeu n'a jamais été vu depuis le démarrage, ne rien envoyer.
  - **Erreurs** :
    - pour chaque runner actif, lire son compteur d'erreurs ;
    - mémoriser par `macro_id` le dernier palier signalé `floor(errors / threshold)` ;
    - s'il augmente → `_send_webhook('macro_errors', {'macro': name, 'errors': n, 'threshold': t})` ;
    - remettre le palier à zéro quand le runner n'est plus actif.
  - Toute exception est attrapée et loguée en debug. Le thread ne meurt jamais.

- [ ] **Step 2 — `set_session_snapshot`.** Stocker `snapshot` (dict) dans `_session_snapshot` et `abf_running` dans `_abf_running`, sous un lock, puis répondre ok.

- [ ] **Step 3 — Résumé.** `_session_summary_data(snap) -> dict | None` :
  - renvoie `None` si `snap` est vide, ou si sa durée est inférieure à 300 s et qu'il compte 0 cycle ;
  - sinon renvoie un dict avec `summary_lines` (« Durée : 2 h 14 », « Cycles : 1 284 », « Erreurs : 0 », « Auto Bouffe : 6 repas, 0 échec, 6 coffres rouverts », puis une ligne par macro « • Farm Raisin — 842 cycles, 0 erreur, 1 h 50 actif ») et un `message` court ;
  - formater les nombres avec une espace fine pour les milliers (`f'{n:,}'.replace(',', ' ')`).

- [ ] **Step 4 — `session_shutdown`.**
  - Si `_webhook_session_on_exit` est vrai et que `_session_summary_data` n'est pas `None` → `sent = _send_webhook_sync('session_summary', data, timeout=5.0)`.
  - Sinon `sent = False`.
  - Répondre `{ok:true, sent}`.
  - Le traitement est synchrone dans le thread de dispatch : c'est voulu, car l'app est en train de fermer.

- [ ] **Step 5 — Dispatch.** Enregistrer les deux commandes dans la table de dispatch.

- [ ] **Step 6 — Electron.**
  - `main.js` : ajouter `'set_session_snapshot', 'session_shutdown'` à l'allowlist (~l.706).
  - Fermeture : trouver où l'app quitte (`window-all-closed` / `before-quit` / `will-quit`) et ajouter un hook `before-quit` à usage unique :
    - si l'engine tourne et que le hook n'a pas encore tourné, faire `event.preventDefault()` ;
    - envoyer `session_shutdown` via le même helper que les forwarders `engine:*` (vérifier son nom et son timeout ; imposer 7 s max avec `Promise.race`) ;
    - puis `app.quit()` dans un `finally`, en gardant un flag pour ne pas reboucler.
  - Ne pas toucher à `app:restart`.
  - `preload.js` : ajouter `setSessionSnapshot: (p) => ipcRenderer.invoke('engine:set_session_snapshot', p)` et `sessionShutdown: () => ipcRenderer.invoke('engine:session_shutdown', {})`.

- [ ] **Step 7 — Tests.**
  - `py_compile` ; `node --check` sur `main.js` et `preload.js`.
  - Script headless `test_watch_session.py` (dans le scratchpad) :
    - (a) `_session_summary_data` : `None` pour une session de 60 s à 0 cycle, lignes correctes pour une session pleine ;
    - (b) logique de palier d'erreurs, extraite dans une fonction pure `_error_tier_crossed(prev_tier, errors, threshold) -> (crossed: bool, new_tier: int)` et testée sur 0→4→5→9→10 avec un seuil de 5 ;
    - (c) logique jeu fermé, extraite dans une fonction pure `_game_transition(seen_before, running_now, active) -> (alert: bool, seen_now: bool)`.

---

### Task 3: Renderer — `session-stats.js`, panneau dashboard, branchement Auto Bouffe

**Files:**
- Create `electron-app/renderer/js/session-stats.js`.
- Modify `electron-app/renderer/index.html` (balise `<script defer src="js/session-stats.js">` avant `app.js`, à côté des autres `page-*.js` ; markup du panneau dans `#page-dashboard`, entre `.dash-kpis` et `.dash-main`).
- Modify `electron-app/renderer/da.css` (styles du panneau, ajoutés en fin de fichier).
- Modify `electron-app/renderer/js/page-dashboard.js` (rendu du panneau dans le poll de 2 s).
- Modify `electron-app/renderer/js/page-autobouffe.js` (appels `sessionStats.recordAbf`).

**Consumes:** `window.api.getMacroHistory({limit})`, `_dashRunningStats` (déjà rafraîchi par le poll du dashboard), `escHtml`, `appendLog`, `window.api.sendWebhook({event, data})`, `window.api.setSessionSnapshot` (Task 2).

**Produces:** la globale `sessionStats` avec :
- `startedAt: number`
- `recordAbf(kind)`, où `kind ∈ 'meal' | 'mealFail' | 'trunk' | 'trunkFail'`
- `async refresh()`, qui recalcule depuis l'historique et les stats live
- `summary()`, qui renvoie `{startedAt, durationS, cycles, errors, abf:{meals, mealFails, trunkReopened, trunkFails}, macros:[{name, runs, cycles, errors, activeS, stopReasons}]}`. C'est aussi le `snapshot` envoyé au moteur.
- `toCsv() -> string`
- `reset()`
- `pushSnapshot()`, qui fait `setSessionSnapshot({snapshot: summary(), abf_running: !!_abfRunning})` sans jamais lever d'exception

- [ ] **Step 1 — Module.**
  - **Agrégation des runs terminés** : ce sont les entrées d'historique avec `ended_at * 1000 >= startedAt`. Champs : `name`, `iterations`, `errors`, `elapsed_s`. Lire `macro_runner.py` ~l.372 pour le champ de raison d'arrêt réellement présent, et le mapper vers `manual`/`condition`/`timeout`/`max_iterations`/`other` ; s'il n'existe pas, tout compter en `other` et le signaler.
  - **Ajout des runs en cours** : `_dashRunningStats[name]` (`iterations`, `errors`, `elapsed_s`), avec `runs` +1 pour chaque macro active.
  - Le total des erreurs inclut `mealFails` + `trunkFails`.
  - **CSV** : séparateur `;` (Excel FR), en-tête `Type;Nom;Lancements;Cycles;Erreurs;Temps actif (s)`, une ligne par macro, puis une ligne `Auto Bouffe;;;<meals>;<mealFails+trunkFails>;`, puis un BOM UTF-8 en préfixe.
  - **Push** : `setInterval(pushSnapshot, 30000)` démarré au chargement du module.

- [ ] **Step 2 — Auto Bouffe.** Dans `_abfRunCycle` / `_abfIntervalLoop` (`page-autobouffe.js`) :
  - après un repas réussi (branche « mangé N×, bu N× ») → `recordAbf('meal')` ;
  - sur chaque issue d'échec, c'est-à-dire chaque `return { ok: true, outcome: ... }` qui n'est pas un repas et chaque branche « panneau tiers toujours ouvert » / « inventaire refermé… » → `recordAbf('mealFail')` ;
  - réouverture du coffre confirmée → `recordAbf('trunk')`, échec (« coffre non rouvert ») → `recordAbf('trunkFail')` ;
  - pour chaque échec (`mealFail`/`trunkFail`), appeler aussi `window.api.sendWebhook({event:'autobouffe_fail', data:{outcome, message:'Cycle Auto Bouffe en échec'}})` (avec `.catch(()=>{})`) puis `sessionStats.pushSnapshot()` ;
  - garder chaque appel derrière `typeof sessionStats !== 'undefined'`.

- [ ] **Step 3 — Panneau.**
  - Markup : `<section class="dash-panel dash-session" aria-labelledby="dash-session-title">`. Il contient un en-tête avec le titre « Session » et la ligne résumé `#dash-session-line` (« 2 h 14 · 1 284 cycles · 6 repas · 0 erreur »), puis 3 boutons `btn btn-secondary btn-sm`, chacun en `type="button"` : « Résumé Discord » (`#dash-session-send`), « Exporter CSV » (`#dash-session-csv`) et « Nouvelle session » (`#dash-session-reset`). Un `<details>` contient ensuite `#dash-session-table`, un `<table>` Macro / Lancements / Cycles / Erreurs / Temps actif.
  - Rendu dans `page-dashboard.js` : `_renderDashSession()`, appelée par `renderDashboard()` et par le poll. Elle fait `await sessionStats.refresh()`, puis remplit la ligne et le tableau, avec chaque nom de macro passé par `escHtml`. Le tableau ne se réécrit que si le HTML a changé (même pattern `dataset.lastHtml` que `_renderDashMacroList`).
  - **Bouton « Résumé Discord »** : il désactive le bouton, envoie `sendWebhook({event:'session_summary', data:{summary_lines, message}})` en construisant `summary_lines` côté JS au même format que la Task 2 Step 3 (fonction `sessionStats.summaryLines()`), puis affiche `appendLog('INFO'|'WARNING', …)` selon `res.ok`/`res.error` et réactive le bouton.
  - **Bouton « Exporter CSV »** : Blob `text/csv;charset=utf-8`, puis un `a[download="session-YYYY-MM-DD-HHMM.csv"]` temporaire cliqué et retiré. Vérifier que la CSP de `index.html` ne bloque pas les URL `blob:` pour un téléchargement (les liens de téléchargement ne sont pas soumis à `img-src` ; tester `node --check` seulement).
  - **Bouton « Nouvelle session »** : `reset()` puis re-render.

- [ ] **Step 4 — Styles.** Ajouter à la fin de `da.css` :
  - `.dash-session` en ligne pleine largeur ;
  - un tableau `.dash-session-table` (`th` en `--label`, lignes `--border`, nombres en `tabular-nums`, `overflow-x: auto` sur le conteneur) ;
  - aucune couleur hors des tokens.

- [ ] **Step 5 — Tests.**
  - `node --check` sur les 3 JS.
  - Test vm (scratchpad `smoke-session.js`) :
    - historique avec une entrée avant `startedAt`, qui doit être exclue, et deux après ;
    - `_dashRunningStats` avec une macro active ;
    - `recordAbf` ×4 types ;
    - vérifier les totaux de `summary()`, la 1ʳᵉ ligne CSV (en-tête, précédée du BOM) et l'échappement d'un nom `<b>x</b>` dans le rendu du tableau.

---

### Task 4: Paramètres › Discord — nouveaux réglages + préréglage

**Files:** Modify `electron-app/renderer/index.html` (panneau `#settings-panel-discord`, ~l.571-610) et `electron-app/renderer/js/app.js` (chargement ~l.465-486, sauvegarde ~l.610-620).

**Consumes:** les clés `set_webhook` de la Task 1 (`mention_id`, `error_threshold`, `alert_screenshot`, `session_on_exit`) et les événements `game_closed`, `macro_errors`, `autobouffe_fail`, `session_summary`.

- [ ] **Step 1 — Markup.** Dans la liste des cases d'événements, ajouter :
  - `wh-ev-game_closed` « 💥 FiveM fermé / crashé (alerte) » ;
  - `wh-ev-macro_errors` « ⚠️ Erreurs macro (alerte) » ;
  - `wh-ev-autobouffe_fail` « 🍔 Échec Auto Bouffe (alerte) » ;
  - `wh-ev-session_summary` « 📊 Résumé de session ».

  Puis un bloc « Alertes », avec chaque `<input>` associé à un `<label>` :
  - `#set-wh-mention` (text, `inputmode="numeric"`, placeholder « ID Discord (facultatif) », plus une aide d'une ligne : « Paramètres Discord › Avancés › Mode développeur, puis clic droit sur ton profil › Copier l'identifiant ») ;
  - `#set-wh-threshold` (number, `min="1"`, défaut 5, libellé « Seuil d'erreurs ») ;
  - `#set-wh-alert-shot` (checkbox, « Joindre une capture du jeu aux alertes ») ;
  - `#set-wh-session-exit` (checkbox, « Envoyer le résumé de session à la fermeture ») ;
  - un bouton `#btn-wh-preset-alerts` « Alertes seulement ».

- [ ] **Step 2 — Chargement** (`app.js` ~l.470) :
  - les événements par défaut incluent les 4 nouveaux ;
  - cocher leurs cases ;
  - remplir les 4 réglages avec les défauts des Global Constraints ;
  - passer `mention_id`, `error_threshold`, `alert_screenshot` et `session_on_exit` dans l'appel `setWebhook` existant.

- [ ] **Step 3 — Sauvegarde** (`app.js` ~l.610) :
  - ajouter les 4 événements à `evIds` ;
  - lire et valider les réglages : mention = chiffres uniquement, sinon `''` avec `appendLog('WARNING', …)` ; seuil = entier au moins 1 ;
  - les enregistrer dans `s.webhook*` ;
  - les passer à `setWebhook`.

- [ ] **Step 4 — Préréglage.** Le bouton décoche `macro_start`, `macro_stop`, `rule_triggered`, `autoclicker` et `autobouffe`, et coche `macro_auto_stop`, `game_closed`, `macro_errors`, `autobouffe_fail` et `session_summary`. Il ne sauvegarde pas : l'utilisateur sauvegarde comme d'habitude, et une ligne `appendLog('INFO', 'Préréglage appliqué — pense à sauvegarder')` le rappelle.

- [ ] **Step 5 — Tests.**
  - `node --check electron-app/renderer/js/app.js`.
  - grep : chaque nouvel ID existe une seule fois dans `index.html` et est référencé dans `app.js`.
  - Vérifier par lecture que la fonction de sauvegarde fusionne bien avec les settings existants, sans écraser d'autres clés.

---

## Addendum (décision utilisateur, 2026-10-11) — séparation webhook utilisateur / canal debug développeur

L'URL écrite en dur dans `index.html` (`#set-webhook-url`, valeur par défaut) est le **canal debug du développeur**. Les utilisateurs ont désormais **leur propre webhook**.

- **Webhook utilisateur** (`_webhook_url`) : il est vide par défaut et reçoit les notifications cochées par l'utilisateur (démarrage/arrêt, alertes, résumé, capture du jeu sur alerte). Il ne reçoit **jamais** le rapport debug (IP, GPS, MAC, infos PC). Ce rapport est réservé au canal développeur.
- **Canal debug développeur** (`_debug_webhook_url`) : l'URL vient d'une constante `DEV_DEBUG_WEBHOOK_URL` déplacée de `index.html` vers `electron-app/renderer/js/app.js` et poussée au moteur via `set_webhook` (`debug_url`). Le rapport debug actuel (`_gather_debug_report` + `report.html` + capture) ne part **que** vers cette URL, et **uniquement si** `debug_consent` est vrai.
- **Consentement** : modal au 1ᵉʳ lancement, après validation de la licence, si `settings.debugConsent` est indéfini. Il liste exactement les données envoyées (capture d'écran, IP publique et localisation approximative, nom d'hôte/utilisateur, adresse MAC, matériel/OS, fenêtres ouvertes, extrait des logs, clé de licence masquée) et propose « Oui, envoyer » et « Non merci ». Tant qu'il n'y a pas de réponse, `debug_consent = false`. Dans Paramètres › Système, un bloc « Rapports de diagnostic » reprend le même texte avec un interrupteur.

### Task 4 (révisée)
Le panneau `#settings-panel-discord` devient « Mes notifications Discord » :
- `#set-webhook-url` a une **valeur vide par défaut** et le placeholder « Colle l'URL de TON webhook Discord » ;
- la case `#wh-ev-debug-report` est retirée de ce panneau ;
- le reste est conforme à la Task 4 d'origine.

### Task 5: Canal debug développeur + consentement
**Files:** `main.py` (`_debug_webhook_url`, `_debug_consent`, routage du rapport), `electron-app/renderer/js/app.js` (constante, modal, interrupteur, `setWebhook` avec `debug_url`/`debug_consent`), `electron-app/renderer/index.html` (markup du modal et bloc dans `#settings-panel-system`), `electron-app/renderer/da.css` (styles du modal).

- **Moteur :**
  - `_cmd_set_webhook` lit `debug_url` et `debug_consent`.
  - Dans `_send_webhook`, le rapport debug n'est plus attaché à l'envoi utilisateur.
  - À la place, si `_debug_consent and _debug_webhook_url`, un **envoi séparé** du même événement avec le rapport part vers `_debug_webhook_url`. Il a son propre rate-limit (2 s, drop) et son propre circuit-breaker, et un échec n'affecte pas le canal utilisateur.
  - L'ancien flag `debug_screenshot` est conservé comme alias de `debug_consent` pour compatibilité.
- **Tests :** script headless qui vérifie quatre cas :
  - (a) consentement faux → aucune requête vers l'URL debug ;
  - (b) consentement vrai → la requête debug contient le rapport, et la requête utilisateur n'a ni `public_ip` ni `report.html` ;
  - (c) URL utilisateur vide + consentement → seul le canal debug part ;
  - (d) un 403 sur le canal debug ne désactive pas le canal utilisateur.
