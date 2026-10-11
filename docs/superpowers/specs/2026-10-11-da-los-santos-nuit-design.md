# DA « Los Santos Nuit » — Lot 1 (tokens globaux, sidebar, dashboard)

Maquette de référence : artboard « A · Los Santos Nuit » sur https://claude.ai/artifact/BTazkxU6URJ8MBz1Jw9oJM

## Périmètre

- **Lot 1 (ce spec)** : tokens globaux dans `electron-app/renderer/styles.css` + sidebar + page Dashboard.
- **Lot 2 (hors périmètre)** : retouches page par page (éditeur macros, Auto Bouffe, Autoclicker, Paramètres), puis `overlay.html` / `picker.html`.

Principe : on **garde les noms des variables CSS existantes** (`--accent`, `--bg-card`, `--text-2`, …) et on change leurs valeurs, pour que toutes les pages héritent sans réécriture. Les variables décoratives devenues inutiles (`--purple`, `--cyan`, `--gold`…) restent définies, mais sont remappées sur la palette neutre ou d'état, pour ne rien casser.

## Tokens

| Rôle | Valeur |
|---|---|
| Fond app `--bg` | `#0c0c0f` |
| Sidebar `--bg-panel` | `#101014` |
| Carte `--bg-card` | `#141418` |
| Carte imbriquée / ligne `--bg-card-2` | `#0f0f13` |
| Survol `--bg-hover` | `#1c1c22` |
| Bordure `--border` / `--border-2` / `--border-3` | `#1f1f26` / `#2a2a33` / `#3a3a46` |
| Accent unique `--accent` / `--accent-2` | `#e5372b` / `#ff6b5e` |
| Texte `--text` / `--text-2` / `--text-3` / `--label` | `#ededf0` / `#a3a3b2` / `#6e6e7c` / `#9a9aa8` |
| États | succès `#4ade80`, attention `#fbbf24`, erreur `#ef4444` |
| Rayons | `--radius` 12px, `--radius-sm` 8px |

- `--text-3` passe de `#3a3a50` (illisible) à `#6e6e7c`. Il ne sert plus jamais pour du texte porteur d'information de moins de 14px ; dans ce cas on utilise `--text-2`.
- Le fond en grille de points (`body::before`) est supprimé.

## Typographie

- Titres de page, titres de section et gros chiffres KPI : **Barlow Condensed** (600/700), en capitales, `letter-spacing: .02em`.
- Texte : **Barlow** (400/500/600), corps à 14px (aujourd'hui 13px).
- Code et logs : `--mono` inchangé.
- Les polices sont **embarquées localement** dans `electron-app/renderer/fonts/` (woff2, via `@font-face`) ; on retire l'`@import` Google Fonts, pour que l'app fonctionne hors ligne et sans requête externe.

## Composants (globaux)

- **Boutons** : hauteur min 36px (`.btn`), et 44px pour les actions principales d'en-tête. Primaire = fond accent, texte blanc. Secondaire = bordure `--border-2`, fond transparent. Danger = fond accent (le « Stop tout » est l'action rouge principale).
- **Cartes** : `--bg-card`, bordure 1px `--border`, rayon 12px, sans ombre portée ni glow.
- **Navigation** : item actif = fond `--bg-hover` + barre intérieure gauche de 3px couleur accent (`box-shadow: inset 3px 0 0`).
- **Icônes** : les emojis de stats (🔁 ⏱️ ⚡ ⚠️) du dashboard sont remplacés par des SVG en trait de 12px.

## Sidebar

- Marque : carré accent avec « M » + « MACROENGINE » en Barlow Condensed.
- Items existants conservés (`data-page`, titres, ordre) ; seul le style change.
- Pied : carte licence (utilisateur + état + version), qui reprend les données déjà affichées dans `.sidebar-footer`.

## Dashboard (`#page-dashboard`)

Disposition, de haut en bas :

1. **En-tête** : surtitre « SESSION EN COURS · hh:mm:ss » (alimenté par le timer qui remplit aujourd'hui `#val-uptime`), titre « TABLEAU DE BORD », boutons « Nouvelle macro » (secondaire, ouvre l'éditeur) et « ■ Stop tout (F12) » (`#btn-stop-all`, conservé).
2. **4 KPI**, en grille de 4 colonnes :
   - *Macros en cours* : `x / total` (`#val-running-count` / `#val-total-macros`), avec un sous-texte d'état.
   - *Cycles* : `#val-total-cycles`.
   - *Prochain repas* : nouvel élément `#val-next-meal`, qui affiche `hh:mm` et « dans X » quand l'Auto Bouffe tourne, sinon « — » et « Auto Bouffe arrêté ».
   - *Erreurs* : `#val-total-errors`.
3. **Grille 3 colonnes** :
   - **Macros** (2 colonnes) : liste fusionnée qui remplace « Exécution en cours » et « Lancement rapide ». Les macros actives sont en tête, avec un point vert, leurs stats (cycles, durée, dernière règle, erreurs) et un bouton Arrêter. Viennent ensuite les inactives, avec un point gris, leur méta (nb de règles, boucle ou 1 passe), un bouton Lancer et un bouton Modifier. Le conteneur est `#dash-ql-grid`, réutilisé ; `#dash-running` est supprimé et son rendu fusionné.
   - **Activité** (1 colonne) : `#dash-console`, restylé en fil horodaté.
4. **Historique des runs** : `#dash-history`, dans un bloc `<details>` replié par défaut.

On supprime le bloc `.dash-quicknav` (4 raccourcis qui doublent la sidebar) et les classes de couleur des KPI (`dash-kpi-purple`, etc.).

### Donnée nouvelle : prochain repas

`page-autobouffe.js` expose une globale `abfNextCycleAt` (timestamp ms, ou `null`), mise à jour à chaque planification de cycle dans `_abfIntervalLoop` et remise à `null` dans `stopAutoBouffe()`. `page-dashboard.js` la lit à chaque tick de son poll existant (2s). Aucun changement côté Python.

## Contraintes

- Ne pas renommer les IDs ni les fonctions globales utilisées par `app.js` et `page-*.js`, sauf les deux éléments que le spec supprime explicitement (`#dash-running`, `.dash-quicknav`).
- Toutes les chaînes affichées venant des macros passent par `escHtml` (déjà le cas).
- Contraste du texte ≥ 4.5:1 sur fond carte.

## Vérification

- `npm run dev` : le dashboard s'affiche sans erreur console. Lancer et arrêter une macro depuis le dashboard met la liste et les KPI à jour en 2s ou moins. Démarrer l'Auto Bouffe remplit « Prochain repas ».
- Passer rapidement sur chaque autre page : rien de cassé visuellement (Lot 2 fera le polish).
