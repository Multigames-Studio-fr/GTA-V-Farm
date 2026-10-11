# Overlay en jeu léger + « Quoi de neuf »

Maquettes : artboards « Overlay en jeu enrichi » (version légère) et « Quoi de neuf », sur https://claude.ai/artifact/BTazkxU6URJ8MBz1Jw9oJM

## 1. Overlay en jeu (refonte de `electron-app/renderer/overlay.html`)

**Look** (DA Los Santos Nuit, version légère) :
- largeur 250 px, sans bordures ni séparateurs ;
- fond `rgba(10,10,13, opacité)` + `backdrop-filter: blur(8px)`, ombre douce, rayon 12 px ;
- Barlow / Barlow Condensed (polices locales `fonts/`) ;
- accent `#e5372b`, états `#4ade80 / #fbbf24 / #ef4444`.

La fenêtre Electron doit être **transparente** : `transparent: true`, `frame: false`, `backgroundColor: '#00000000'`. Vérifier les options actuelles de la `BrowserWindow` de l'overlay et les adapter.

**Contenu, mode déplié** :
1. **Barre** : poignée ⋮⋮ (`-webkit-app-region: drag` sur la barre, `no-drag` sur les boutons), point d'état, « N actives », puis les boutons ⚙ / – (réduire) / × (masquer).
2. **3 stats** : durée de session, cycles par heure (cycles de la session ÷ durée active, depuis `sessionStats`), erreurs (en `--ok` si 0, sinon `--err`).
3. **Repas** : `hh:mm · dans X` + une barre de progression. Le pourcentage écoulé de l'intervalle vient de `abfNextCycleAt` et de l'intervalle configuré. Le bloc est masqué si l'Auto Bouffe est arrêté.
4. **Macros** : une ligne par macro (point, nom, cycles ou méta, bouton ▶/■). Les actives sont en tête.
5. **Boutons** « ■ Stop · F12 » et « ❚❚ Pause · F11 », qui reprennent les fonctions existantes `doStop` / `doPause`.

On garde la section Auto Clicker actuelle de l'overlay, restylée dans le même langage : une ligne compacte avec état et bouton.

**Mode réduit** : une pastille d'une ligne, avec poignée, point, « N · X cycles · repas 1 h 26 » et un bouton + pour déplier. La fenêtre se redimensionne pour épouser la pastille via l'IPC overlay existant ou un nouveau, et retrouve sa taille dépliée à la réouverture.

**Alerte** : quand le renderer principal reçoit une alerte critique (`autobouffe_fail`, ou un événement `alert` relayé par le moteur pour `game_closed` / `macro_errors`), l'overlay affiche pendant 5 s une pastille avec un liseré rouge (`box-shadow: inset 3px 0 0 #ef4444`) et le message.

**Réglages (popover ⚙)**, persistés dans les settings (`overlay*`) :
- `overlayEnabled` (bool) : overlay activé ;
- `overlayOpacity` (20–100, défaut 55) ;
- `overlayLocked` (bool) : position verrouillée, ce qui désactive la poignée ;
- `overlayClickThrough` (bool) : `setIgnoreMouseEvents(true, {forward: true})`. Le survol de la barre réactive temporairement la souris, sinon il deviendrait impossible de désactiver l'option ;
- `overlaySections` : `{meal, macros, stats}` en booléens ;
- placement rapide dans un des 4 coins de l'écran principal (zone de travail), avec une marge de 16 px.

**Raccourci global** : **F8** (par défaut) pour afficher ou masquer l'overlay. Il est configurable dans Paramètres › Raccourcis, comme les raccourcis existants (même mécanisme `_applyGlobalShortcuts` / `keyToAccelerator`). F9 reste réservé à l'arrêt de l'enregistrement.

**Données** : l'overlay a déjà un flux depuis le main process pour les macros et l'autoclicker. On l'étend avec les champs `session` (durée, cycles, erreurs, cycles par heure), `meal` (`nextAt`, `intervalMs`, `running`) et `alert`. Ces données viennent du renderer principal (`sessionStats.summary()`, `abfNextCycleAt`), relayées par le main process via le canal overlay existant ; ne pas en créer un parallèle si l'existant suffit. Elles sont rafraîchies toutes les 2 s.

## 2. « Quoi de neuf »

- Au démarrage, une fois la licence validée et le modal de consentement debug traité (ils ne doivent pas s'empiler), si `settings.lastSeenVersion !== app version` : on affiche le modal « Quoi de neuf », puis on enregistre `lastSeenVersion = version` à la fermeture.
- Pour une première installation (`lastSeenVersion` indéfini), on enregistre la version **sans** afficher le modal.
- Contenu : la section de la version courante dans `CHANGELOG.md`. Le main process lit le fichier, avec le même chemin dev/packagé que les autres ressources ; vérifier qu'il est bien embarqué dans le build, sinon l'ajouter aux `files` de `package.json`. Le Markdown est parsé simplement :
  - `### Added|Ajouté|Nouveautés` → « Nouveautés » ;
  - `### Fixed|Corrigé|Corrections` → « Corrections » ;
  - `### Changed|Amélioré|Améliorations` → « Améliorations » ;
  - autre `###` → « Autres » ;
  - puces `- ` → items ; `**gras**` en tête → titre, reste → description.
- Tout passe par `escHtml` : on construit du DOM, pas de HTML venu du fichier.
- Le lien « Voir tout l'historique » ouvre le `CHANGELOG` complet dans un panneau qui défile (même modal, vue « tout »).
- Il existe aussi un bouton « Quoi de neuf » dans Paramètres › Système, pour rouvrir le modal.
- Accessibilité : `role="dialog"`, `aria-labelledby`, focus sur « C'est parti », Échap pour fermer.

## Hors périmètre
Thème clair, choix libre de la couleur d'accent, overlay multi-écrans avancé.

## Vérification
- `node --check` sur tous les JS. Test vm du parseur de CHANGELOG sur le vrai `CHANGELOG.md` : la section de la version courante est trouvée, les sections sont mappées, et une ligne contenant `<script>` reste du texte.
- Manuel (`npm run dev`) :
  - overlay transparent, déplaçable, réductible et verrouillable ;
  - F8 affiche et masque l'overlay ;
  - le clic à travers se désactive au survol de la barre ;
  - « Quoi de neuf » s'affiche après un changement de version simulé (mettre `lastSeenVersion` à une ancienne version dans les settings).
