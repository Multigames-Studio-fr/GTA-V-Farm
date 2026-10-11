# 🎮 MacroEngine

> Automatisation visuelle par macros pour GTA V Solo & serveurs FiveM — éditeur de règles SI/ALORS, détection à l'écran, dashboard en direct.

---

## ⚠️ Avertissement légal

**Cet outil est prévu pour le jeu solo et les serveurs FiveM uniquement.** L'utiliser sur GTA Online enfreint les conditions d'utilisation de Rockstar Games et peut entraîner :
- Suspension du compte
- Bannissement définitif
- Perte de progression

**Utilisation à tes risques et périls.**

---

## 🚀 Fonctionnalités

- 🎨 **Éditeur visuel** – Canevas de règles `SI / ALORS` (conditions → actions), sans écrire une ligne de script
- 🔍 **Détection à l'écran** – Couleur de pixel, correspondance d'image (OpenCV) ou lecture de texte (OCR : EasyOCR → WinRT → Tesseract en repli)
- ⚙️ **Conditions avancées** – État de macro/fenêtre/processus, compteurs, variables, minuteurs, aléatoire, clavier, presse-papiers
- 🖱️ **Actions humanisées** – Délais gaussiens et mouvements de souris en courbe de Bézier, pour éviter un rythme parfaitement régulier
- 🖱️ **Auto Clicker** – Cadence, bouton, position et décalage aléatoire configurables, indépendant de l'éditeur de macros
- 🍽️ **Auto Bouffe** – Cycle manger/boire automatique à intervalle configurable, détection de l'état de l'inventaire par IA (Moondream Cloud, clé API gratuite à fournir)
- 📊 **Dashboard en direct** – Cycles, erreurs, dernière règle déclenchée par macro active, plus un historique des runs qui persiste entre les redémarrages
- 🎙️ **Enregistreur** – Capture tes actions en direct pour générer une macro sans tout construire à la main
- 🛡️ **Garde-fous** – Conditions de démarrage, arrêt automatique sur seuil/minuteur, zones interdites, actions de nettoyage, touche d'arrêt d'urgence toujours active
- 🖥️ **Auto-scaling** – Coordonnées calibrées sur une résolution, converties automatiquement pour la résolution réelle de l'écran

---

## 📋 Prérequis système

- **Windows 10/11** (x64) — uniquement, l'app utilise des API Windows natives
- Clavier **AZERTY** (raccourcis par défaut)
- Aucune autre installation requise (Python et dépendances sont embarqués)

---

## 🔧 Installation

### Méthode 1 : Installeur (recommandé)

1. Télécharge `MacroEngine-Setup-<version>.exe` (ex. `MacroEngine-Setup-2.6.0.exe`) depuis les [Releases](https://github.com/Multigames-Studio-fr/GTA-V-Farm/releases)
2. Lance l'installeur
3. Ouvre depuis le menu Démarrer ou le raccourci Bureau

### Méthode 2 : Portable (sans installation)

1. Télécharge `MacroEngine-Portable-<version>.exe` (ex. `MacroEngine-Portable-2.6.0.exe`) depuis les [Releases](https://github.com/Multigames-Studio-fr/GTA-V-Farm/releases)
2. Lance-le directement — aucune installation nécessaire
3. Le premier lancement extrait les dépendances une seule fois (mise en cache par version, pas de réextraction aux lancements suivants)

---

## 🎯 Démarrage rapide

1. **Ouvre MacroEngine**
2. **Crée une macro** dans l'éditeur visuel
3. **Assemble des règles** : conditions (pixel, image, OCR, minuteur...) → actions (touche, clic, souris, variable...)
4. **Teste** chaque condition individuellement avant de lancer la boucle
5. **Lance** la macro et suis-la depuis le Dashboard

### Raccourcis

| Touche | Action |
|--------|--------|
| **F12** | Arrêt d'urgence |
| **F11** | Pause / Reprise |
| **F10** | Recharger les macros |

---

## 📸 Détection d'image personnalisée

1. Ouvre **Outils → Capture d'image**
2. Sélectionne une région, ESPACE pour capturer
3. Enregistre le template
4. Utilise-le dans une règle : condition « Image détectée »

---

## 🔌 Configuration

Tout se règle depuis l'interface — pas besoin d'éditer de fichier :
- **Paramètres jeu** – Touches, résolution, profils de farm
- **Sensibilité de détection** – Seuils OCR / correspondance d'image
- **Performance** – Suivi RAM, niveau de logs

---

## 🛠️ Développement

### Prérequis

- Node.js 18
- Python 3.11

### Build depuis les sources

```bash
cd electron-app
npm install
npm run dev              # Mode dev (Electron + Python, DevTools)
npm run build-nsis       # Build installeur
npm run build-portable   # Build portable
npm run build            # Installeur + portable
```

### Structure du projet

```
GTA V FARM/
├── main.py                    ← Serveur IPC Python — commandes stdin/stdout
├── config.py                  ← Résolution, touches, profils de farm, templates
├── modules/engine/
│   ├── macro_runner.py        ← Boucle d'exécution d'une macro
│   ├── actions.py             ← Types d'actions (clavier/souris/variables/intégrations)
│   ├── conditions.py          ← Types de conditions (visuel/état/compteurs/clavier...)
│   ├── ocr_engine.py          ← Cascade OCR (EasyOCR → WinRT → Tesseract)
│   ├── screen_reader.py       ← Capture d'écran (mss)
│   ├── recorder.py            ← Enregistreur d'actions
│   ├── coord_utils.py         ← Validation/scaling des coordonnées
│   ├── humanizer.py           ← Délais gaussiens, courbes de Bézier
│   └── state.py               ← Compteurs, variables, stats, historique
├── electron-app/
│   ├── main.js                ← Process principal Electron
│   ├── preload.js             ← Passerelle IPC sécurisée
│   ├── renderer/js/           ← Une page = un module (dashboard, éditeur, autoclicker...)
│   └── updater.js             ← Auto-update
└── templates/                 ← Images de référence pour la détection
```

---

## 🐛 Dépannage

### La macro ne s'exécute pas
1. Vérifie que la fenêtre du jeu est au premier plan
2. Vérifie que les templates existent (**Outils → Gérer les templates**)
3. Consulte les logs : **Affichage → Logs**

### Détection peu fiable
1. Recapture les templates en conditions réelles
2. Augmente la sensibilité dans **Paramètres → Détection**
3. Vérifie contraste/luminosité

### Plantage au démarrage
1. Consulte `app.log` (racine du dossier d'installation)
2. Réinstalle si le problème persiste
3. Signale le sur [Issues](https://github.com/Multigames-Studio-fr/GTA-V-Farm/issues)

---

## 📦 Mises à jour

Vérification au lancement de l'app, ou manuellement via **Menu → Vérifier les mises à jour**. Tu peux aussi télécharger la dernière version depuis les [Releases](https://github.com/Multigames-Studio-fr/GTA-V-Farm/releases).

---

## 📝 Licence

MIT License – voir [LICENSE](./LICENSE)

---

## 🤝 Contribuer

Un bug ? Une idée ?
- 🐛 [Signaler un problème](https://github.com/Multigames-Studio-fr/GTA-V-Farm/issues)
- 🍴 [Fork & PR](https://github.com/Multigames-Studio-fr/GTA-V-Farm)

---

## 👨‍💻 Auteur

**Multigames Studio** – [GitHub](https://github.com/Multigames-Studio-fr)
