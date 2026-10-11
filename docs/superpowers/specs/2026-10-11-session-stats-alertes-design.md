# Statistiques de session, alertes Discord ciblées, capture sur alerte

## Objectif

1. **Stats de session** : voir ce qu'a produit une session de farm (durée, cycles, erreurs, repas…), l'exporter, et en recevoir le résumé sur Discord.
2. **Alertes ciblées** : être prévenu sur Discord uniquement des problèmes (crash FiveM, erreurs, échec Auto Bouffe), de façon fiable, avec mention pour notifier le téléphone.
3. **Capture sur alerte** : joindre une capture du jeu aux alertes critiques, indépendamment du « rapport debug ».

## 1. Statistiques de session

**Session** = du lancement de l'app à sa fermeture. Le bouton « Nouvelle session » remet à zéro (nouveau `startedAt`).

**Données** (module renderer `electron-app/renderer/js/session-stats.js`, globale `sessionStats`) :
- `startedAt` (ms).
- Par macro : `runs` (lancements), `cycles`, `errors`, `activeS` (temps actif), `stopReasons` (`{manual, condition, timeout, max_iterations, other}`). Sources :
  - runs terminés = entrées de `getMacroHistory` avec `ended_at*1000 >= startedAt` ;
  - runs en cours = `getStats()` (déjà pollé par le dashboard).
- Auto Bouffe : `meals` (cycles où l'on a mangé), `mealFails`, `trunkReopened`, `trunkFails`, incrémentés par `page-autobouffe.js` via `sessionStats.recordAbf(kind)`.
- Total des erreurs : somme des erreurs des macros + `mealFails` + `trunkFails`.

**UI** : panneau « Session » sur le dashboard, placé entre les KPI et la grille Macros/Activité. Il est replié en une ligne de résumé (durée · cycles · repas · erreurs), avec un bouton pour déplier le tableau par macro. Actions :
- « Résumé Discord » : envoie l'événement `session_summary`.
- « Exporter CSV » : télécharge `session-AAAA-MM-JJ-HHMM.csv` via un Blob et un lien de téléchargement, avec une ligne par macro et une ligne Auto Bouffe.
- « Nouvelle session ».

**Résumé à la fermeture** (option, cochée par défaut si le webhook est configuré) :
- Le renderer pousse un instantané de la session au moteur Python toutes les 30 s et à chaque fin de cycle Auto Bouffe (nouvelle commande `set_session_snapshot`).
- À la fermeture (EOF de stdin), le moteur envoie `session_summary` **de manière synchrone**, avec un timeout de 5 s, avant de quitter.
- L'envoi n'a lieu que si la session a duré au moins 5 min ou compte au moins 1 cycle.

## 2. Alertes Discord ciblées

**Nouveaux événements** (cases dans Paramètres › Discord) :

| Événement | Déclencheur | Critique |
|---|---|---|
| `game_closed` | Le moteur ne trouve plus aucun processus FiveM (noms en minuscules contenant `fivem`) alors qu'une macro ou l'Auto Bouffe tourne. Vérification toutes les 10 s. Une alerte par disparition ; réarmée quand le jeu revient. | oui |
| `macro_errors` | Le nombre d'erreurs d'un runner franchit le seuil N (défaut 5, réglable). Une alerte par franchissement de multiple de N. | oui |
| `autobouffe_fail` | Un cycle Auto Bouffe se termine en échec (inventaire jamais ouvert, panneau tiers impossible à fermer, coffre non rouvert). | oui |
| `session_summary` | Résumé de session (manuel ou à la fermeture). | non |

**Fiabilité** : les événements critiques ne sont jamais supprimés par la limite de 2 s. S'ils arrivent trop tôt, ils sont replanifiés au prochain créneau libre (`threading.Timer`). Les autres événements gardent le comportement actuel.

**Mention** : un champ « ID Discord à mentionner » (numérique, facultatif). Sur un événement critique, le message porte `content: "<@ID>"` et `allowed_mentions: {"users": ["ID"]}`.

**Préréglage « Alertes seulement »** : un bouton qui décoche les événements de démarrage et d'arrêt et coche les trois critiques plus le résumé.

## 3. Capture sur alerte

- Option « Joindre une capture du jeu aux alertes critiques », cochée par défaut.
- Sur un événement critique, si le rapport debug n'est **pas** déjà actif (il joint déjà une capture), le moteur capture la fenêtre FiveM. Celle-ci est trouvée via `window_manager.list_windows()` (premier `exe` contenant `fivem`). À défaut, c'est l'écran principal qui est capturé.
- L'image est réduite à 1280 px de large maximum, en PNG, puis jointe en `attachment://alert.png` dans l'embed.
- Si la capture échoue, l'alerte part quand même, sans image.

## Configuration

Settings renderer (`readSettings`/`writeSettings`), poussés au moteur via `setWebhook`. Nouveaux champs :
- `webhookMentionId` (string)
- `webhookErrorThreshold` (int ≥ 1, défaut 5)
- `webhookAlertScreenshot` (bool, défaut true)
- `webhookSessionOnExit` (bool, défaut true)

`_cmd_set_webhook` accepte les clés correspondantes `mention_id`, `error_threshold`, `alert_screenshot`, `session_on_exit`.

## Hors périmètre

Bot Discord bidirectionnel, relance automatique après crash, anti-AFK, profils, planning.

## Vérification

- Script Python headless : `_build_discord_embed` pour chaque nouvel événement, la mise en file des critiques sous rate-limit (avec horloge simulée), le payload avec mention, et la logique de seuil des erreurs.
- `node --check` sur tous les JS. Test vm de `session-stats.js` (agrégation, CSV, filtre `startedAt`).
- Manuel (`npm run dev`) :
  - « Résumé Discord » et « Exporter CSV » ;
  - fermer FiveM pendant qu'une macro tourne → alerte avec capture et mention ;
  - fermer l'app → résumé reçu.
