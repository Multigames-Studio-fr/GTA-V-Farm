"""
conditions.py — Tous les types de conditions disponibles dans les macros.

─── VISUELLES ─────────────────────────────────────────────────────────────────
  text_contains / text_not_contains   OCR : texte présent dans une région
  text_regex                          OCR : texte correspond à un pattern
  pixel_color / pixel_color_not       couleur d'un pixel
  region_color_avg                    couleur moyenne d'une région
  template_match / template_not_found correspondance d'image
  pixel_changed                       un pixel a changé depuis le dernier snapshot

─── MACROS ────────────────────────────────────────────────────────────────────
  macro_is_running / macro_not_running  une macro tourne-t-elle ?

─── VARIABLES & COMPTEURS ─────────────────────────────────────────────────────
  counter_eq / counter_not_eq         compteur = valeur
  counter_gte                         compteur >= valeur
  counter_lte                         compteur <= valeur
  counter_gt                          compteur > valeur
  counter_lt                          compteur < valeur
  counter_between                     valeur_min <= compteur <= valeur_max
  variable_equals                     variable = valeur (string ou number)
  variable_contains                   variable contient une sous-chaîne

─── FENÊTRES ──────────────────────────────────────────────────────────────────
  window_focused / window_not_focused  fenêtre au premier plan
  window_exists / window_not_exists    fenêtre visible

─── PROCESSUS ─────────────────────────────────────────────────────────────────
  process_running / process_not_running  un processus tourne-t-il ?

─── HEURE ─────────────────────────────────────────────────────────────────────
  time_between                         heure entre HH:MM et HH:MM

─── ALÉATOIRE ─────────────────────────────────────────────────────────────────
  random_chance                        X% de probabilité

─── CLAVIER ───────────────────────────────────────────────────────────────────
  key_is_held / key_not_held           touche physiquement enfoncée

─── PRESSE-PAPIER ─────────────────────────────────────────────────────────────
  clipboard_contains                   presse-papier contient du texte

─── CONSTANTES ────────────────────────────────────────────────────────────────
  always / never
"""
from __future__ import annotations
import re
import os
import ctypes
import threading

import numpy as np
import cv2

from .screen_reader import capture_region, get_pixel_color
from . import state

# ── Registre des macros en cours (stocké dans state.py pour éviter l'import lourd) ──
def set_runners_registry(registry: dict) -> None:
    """Proxy vers state.set_runners_registry — conservé pour compatibilité."""
    state.set_runners_registry(registry)


# ── OCR — délégué au module ocr_engine ────────────────────────────────────────
from .ocr_engine import read_text as _ocr_read, ocr_status as _ocr_status

def _ocr_available() -> bool:
    return _ocr_status()['available']


# ── Helpers ────────────────────────────────────────────────────────────────────
def _color_distance(c1: tuple, c2: tuple) -> float:
    return float(np.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2))))


# Table partielle nom clé → code virtuel Windows
_VK_MAP: dict[str, int] = {
    'lbutton': 0x01, 'rbutton': 0x02, 'mbutton': 0x04,
    'backspace': 0x08, 'tab': 0x09, 'enter': 0x0D, 'return': 0x0D,
    'shift': 0x10, 'ctrl': 0x11, 'alt': 0x12, 'pause': 0x13,
    'capslock': 0x14, 'esc': 0x1B, 'escape': 0x1B,
    'space': 0x20, 'pageup': 0x21, 'pagedown': 0x22,
    'end': 0x23, 'home': 0x24,
    'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
    'insert': 0x2D, 'delete': 0x2E,
    **{str(d): 0x30 + d for d in range(10)},
    **{chr(c): 0x41 + i for i, c in enumerate(range(ord('a'), ord('z') + 1))},
    **{f'f{n}': 0x6F + n for n in range(1, 13)},
    'numlock': 0x90, 'scrolllock': 0x91,
    'lshift': 0xA0, 'rshift': 0xA1, 'lctrl': 0xA2, 'rctrl': 0xA3,
    'lalt': 0xA4, 'ralt': 0xA5,
}

def _key_to_vk(key: str) -> int | None:
    vk = _VK_MAP.get(key.lower())
    if vk is None and len(key) == 1:
        # Ponctuation/accents absents de la table : VK selon la disposition active
        res = ctypes.windll.user32.VkKeyScanW(ctypes.c_wchar(key))
        if res != -1 and (res & 0xFF) != 0xFF:
            vk = res & 0xFF
    return vk


# ── Dispatch principal ─────────────────────────────────────────────────────────
def eval_condition(cond: dict) -> bool:
    """Évalue une condition et retourne True/False. Toutes les exceptions → False."""
    t = cond.get('type', '')
    try:
        # ── Visuelles ──────────────────────────────────────────────────────
        if t == 'text_contains':        return _text_contains(cond)
        if t == 'text_not_contains':    return not _text_contains(cond)
        if t == 'text_regex':           return _text_regex(cond)
        if t == 'pixel_color':          return _pixel_color(cond)
        if t == 'pixel_color_not':      return not _pixel_color(cond)
        if t == 'region_color_avg':     return _region_color_avg(cond)
        if t == 'template_match':       return _template_match(cond)
        if t == 'template_not_found':   return not _template_match(cond)
        if t == 'pixel_changed':        return _pixel_changed(cond)
        if t == 'pixel_not_changed':    return not _pixel_changed(cond)

        # ── Macros ─────────────────────────────────────────────────────────
        if t == 'macro_is_running':     return _macro_is_running(cond)
        if t == 'macro_not_running':    return not _macro_is_running(cond)

        # ── Variables & compteurs ──────────────────────────────────────────
        if t == 'counter_eq':           return _counter_compare(cond, 'eq')
        if t == 'counter_not_eq':       return _counter_compare(cond, 'neq')
        if t == 'counter_gte':          return _counter_compare(cond, 'gte')
        if t == 'counter_lte':          return _counter_compare(cond, 'lte')
        if t == 'counter_gt':           return _counter_compare(cond, 'gt')
        if t == 'counter_lt':           return _counter_compare(cond, 'lt')
        if t == 'counter_between':      return _counter_between(cond)
        if t == 'variable_equals':      return _variable_equals(cond)
        if t == 'variable_contains':    return _variable_contains(cond)

        # ── Fenêtres ───────────────────────────────────────────────────────
        if t == 'window_focused':       return _window_focused(cond)
        if t == 'window_not_focused':   return not _window_focused(cond)
        if t == 'window_exists':        return _window_exists(cond)
        if t == 'window_not_exists':    return not _window_exists(cond)

        # ── Processus ──────────────────────────────────────────────────────
        if t == 'process_running':      return _process_running(cond)
        if t == 'process_not_running':  return not _process_running(cond)

        # ── Heure ──────────────────────────────────────────────────────────
        if t == 'time_between':         return _time_between(cond)

        # ── Aléatoire ──────────────────────────────────────────────────────
        if t == 'random_chance':        return _random_chance(cond)

        # ── Clavier ────────────────────────────────────────────────────────
        if t == 'key_is_held':          return _key_is_held(cond)
        if t == 'key_not_held':         return not _key_is_held(cond)

        # ── Presse-papier ──────────────────────────────────────────────────
        if t == 'clipboard_contains':   return _clipboard_contains(cond)

        # ── Constantes ─────────────────────────────────────────────────────
        if t == 'always':               return True
        if t == 'never':                return False

    except _TemplateUnavailable as e:
        # Template absent/illisible/trop grand : ni template_match ni
        # template_not_found ne doivent être vrais. Logué une seule fois par
        # message pour ne pas inonder les logs à chaque itération.
        _warn_once(f'Condition [{t}] : {e}')
    except Exception as e:
        import logging
        logging.getLogger('engine').warning(f'Condition [{t}] erreur : {e}')
    return False


# ══════════════════════════════════════════════════════════════════════════════
#  OCR — délégué à ocr_engine.py
# ══════════════════════════════════════════════════════════════════════════════
def _ensure_ocr():
    if not _ocr_available():
        raise RuntimeError(
            "Aucun moteur OCR disponible.\n"
            "Installez EasyOCR (recommandé) :  pip install easyocr\n"
            "ou Tesseract-OCR               :  https://github.com/UB-Mannheim/tesseract/wiki"
        )


def _ocr_region(
    x: int, y: int, w: int, h: int,
    psm:       int | None       = None,
    invert:    bool | None      = None,
    scale:     int              = 0,
    lang:      str              = 'en',
    whitelist: str              = '',
    engine:    str              = 'auto',
) -> str:
    """Capture la région et lance le pipeline OCR via ocr_engine."""
    _ensure_ocr()
    img = capture_region(x, y, w, h)
    return _ocr_read(
        img, scale=scale, lang=lang,
        psm=psm, whitelist=whitelist,
        invert=invert, engine=engine,
    )


def ocr_region_raw(cond: dict) -> str:
    """API publique — texte brut OCR d'une région (pour le tester UI)."""
    x, y, w, h = _get_region(cond)
    inv = cond.get('invert'); inv = None if inv is None else bool(inv)
    return _ocr_region(
        x, y, w, h,
        psm=cond.get('psm'),
        invert=inv,
        scale=int(cond.get('scale', 0)),
        lang=cond.get('lang', 'en'),
        whitelist=cond.get('whitelist', ''),
        engine=cond.get('engine', 'auto'),
    )


def _get_region(cond: dict) -> tuple:
    """Extrait (x, y, w, h) avec un message clair si un champ est manquant ou invalide."""
    missing = [k for k in ('x', 'y', 'w', 'h') if cond.get(k) is None]
    if missing:
        raise ValueError(
            f"Champs manquants pour la région : {missing}. "
            f"Utilisez le bouton 🎯 Zone pour sélectionner une région."
        )
    x, y, w, h = int(cond['x']), int(cond['y']), int(cond['w']), int(cond['h'])
    if w <= 0 or h <= 0:
        raise ValueError(
            f"Region invalide : largeur={w} hauteur={h}. "
            f"Selectionnez une zone via le bouton Zone dans le tester."
        )
    return x, y, w, h


def _text_contains(cond: dict) -> bool:
    """
    True si l'OCR de la région contient `text` (insensible à la casse).
    Paramètres : x, y, w, h, text, [psm, invert, scale, lang, whitelist]
    """
    x, y, w, h = _get_region(cond)
    inv = cond.get('invert'); inv = None if inv is None else bool(inv)
    ocr = _ocr_region(
        x, y, w, h,
        psm=cond.get('psm'), invert=inv,
        scale=int(cond.get('scale', 0)), lang=cond.get('lang', 'eng'),
        whitelist=cond.get('whitelist', ''),
    ).lower()
    return cond.get('text', '').lower() in ocr


def _text_regex(cond: dict) -> bool:
    """
    True si l'OCR de la région correspond au pattern regex.
    Paramètres : x, y, w, h, pattern, [psm, invert, scale, lang]
    """
    x, y, w, h = _get_region(cond)
    inv = cond.get('invert'); inv = None if inv is None else bool(inv)
    ocr = _ocr_region(
        x, y, w, h,
        psm=cond.get('psm'), invert=inv,
        scale=int(cond.get('scale', 0)), lang=cond.get('lang', 'eng'),
    )
    return bool(re.search(cond.get('pattern', ''), ocr, re.IGNORECASE))


# ══════════════════════════════════════════════════════════════════════════════
#  COULEURS & PIXELS
# ══════════════════════════════════════════════════════════════════════════════
def _pixel_color(cond: dict) -> bool:
    """
    True si la couleur du pixel (x,y) correspond à `color` [R,G,B] ± `tolerance`.
    Paramètres : x, y, color [R,G,B], tolerance (défaut 15)
    """
    x = cond.get('x'); y = cond.get('y')
    if x is None or y is None:
        raise ValueError("Champs manquants : x, y requis pour pixel_color")
    actual = get_pixel_color(int(x), int(y))
    return _color_distance(actual, tuple(cond['color'])) <= cond.get('tolerance', 15)

def _region_color_avg(cond: dict) -> bool:
    """
    True si la couleur moyenne de la région correspond à `color` ± `tolerance`.
    Paramètres : x, y, w, h, color [R,G,B], tolerance (défaut 20)
    """
    x, y, w, h = _get_region(cond)
    img     = capture_region(x, y, w, h)
    mean    = img.mean(axis=(0, 1))
    actual  = (float(mean[2]), float(mean[1]), float(mean[0]))
    return _color_distance(actual, tuple(cond['color'])) <= cond.get('tolerance', 20)

def _pixel_changed(cond: dict) -> bool:
    """
    True si la couleur du pixel (x,y) a changé depuis le dernier snapshot.
    À la première évaluation, mémorise la couleur et retourne False.
    Paramètres :
      x, y       int  — position du pixel
      key        str  — identifiant unique du snapshot (défaut 'pixel_{x}_{y}')
      tolerance  int  — distance de couleur pour considérer un changement (défaut 10)
      save       bool — re-sauvegarder après détection (défaut False)

    Exemple : {"type":"pixel_changed","x":960,"y":540,"key":"health_pixel"}
    """
    x = cond.get('x'); y = cond.get('y')
    if x is None or y is None:
        raise ValueError("Champs manquants : x, y requis pour pixel_changed")
    x, y      = int(x), int(y)
    key       = cond.get('key', f'pixel_{x}_{y}')
    tolerance = int(cond.get('tolerance', 10))
    current   = get_pixel_color(x, y)
    snap      = state.pixel_snapshot_get(key)

    if snap is None:
        # Premier appel — on mémorise et on retourne False
        state.pixel_snapshot_save(key, x, y, current)
        return False

    prev   = (snap['r'], snap['g'], snap['b'])
    changed = _color_distance(current, prev) > tolerance

    if changed and cond.get('save', False):
        state.pixel_snapshot_save(key, x, y, current)

    return changed


# ══════════════════════════════════════════════════════════════════════════════
#  TEMPLATE MATCHING
# ══════════════════════════════════════════════════════════════════════════════
_template_cache: dict = {}
_template_cache_lock = threading.Lock()


class _TemplateUnavailable(Exception):
    """Template inutilisable (fichier absent/illisible, plus grand que la région).
    Distinct de « non trouvé » : les deux polarités doivent s'évaluer à False."""


_warned_once: set = set()
_warned_once_lock = threading.Lock()


def _warn_once(msg: str) -> None:
    with _warned_once_lock:
        if msg in _warned_once:
            return
        _warned_once.add(msg)
    import logging
    logging.getLogger('engine').warning(msg)


def _load_template(path: str):
    """Charge et cache un template cv2 depuis le disque (une seule fois par path)."""
    with _template_cache_lock:
        if path not in _template_cache:
            img = cv2.imread(path)
            if img is None:
                return None
            _template_cache[path] = img
        return _template_cache[path]


def clear_template_cache() -> None:
    """Vide le cache de templates (utile après modification de fichiers template)."""
    with _template_cache_lock:
        _template_cache.clear()


def _template_match(cond: dict) -> bool:
    """
    True si le template est trouvé dans la région avec un score ≥ threshold.
    Paramètres : x, y, w, h, template_path, threshold (défaut 0.85)
    Lève _TemplateUnavailable si le template est inutilisable (≠ non trouvé).
    """
    tmpl_path = cond.get('template_path', '')
    if not os.path.exists(tmpl_path):
        raise _TemplateUnavailable(f'template introuvable : {tmpl_path!r}')
    tmpl = _load_template(tmpl_path)
    if tmpl is None:
        raise _TemplateUnavailable(f'template illisible : {tmpl_path!r}')
    x, y, w, h = _get_region(cond)
    scene = capture_region(x, y, w, h)
    sg = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY)
    tg = cv2.cvtColor(tmpl,  cv2.COLOR_BGR2GRAY)
    if tg.shape[0] > sg.shape[0] or tg.shape[1] > sg.shape[1]:
        raise _TemplateUnavailable(
            f'template {tmpl_path!r} ({tg.shape[1]}x{tg.shape[0]}) plus grand '
            f'que la région ({sg.shape[1]}x{sg.shape[0]})'
        )
    res = cv2.matchTemplate(sg, tg, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, _ = cv2.minMaxLoc(res)
    return max_val >= cond.get('threshold', 0.85)


# ══════════════════════════════════════════════════════════════════════════════
#  MACROS
# ══════════════════════════════════════════════════════════════════════════════
def _macro_is_running(cond: dict) -> bool:
    """
    True si la macro `macro_id` est actuellement en cours d'exécution.
    Paramètres : macro_id (str)

    Exemple : {"type":"macro_is_running","macro_id":"mon_farm"}
    """
    runner = state.get_runners_registry().get(cond.get('macro_id', ''))
    return runner is not None and runner.is_running()


# ══════════════════════════════════════════════════════════════════════════════
#  VARIABLES & COMPTEURS
# ══════════════════════════════════════════════════════════════════════════════
def _counter_compare(cond: dict, op: str) -> bool:
    """
    Compare un compteur à une valeur.
    Paramètres : name (str), value (int)
    Opérateurs : eq, neq, gte, lte, gt, lt

    Exemples :
      {"type":"counter_gte","name":"cycles","value":5}  → cycles >= 5
      {"type":"counter_eq", "name":"phase", "value":0}  → phase == 0
    """
    val = state.counter_get(cond.get('name', ''))
    ref = int(cond.get('value', 0))
    return {
        'eq':  val == ref,
        'neq': val != ref,
        'gte': val >= ref,
        'lte': val <= ref,
        'gt':  val >  ref,
        'lt':  val <  ref,
    }[op]

def _counter_between(cond: dict) -> bool:
    """
    True si min <= compteur <= max.
    Paramètres : name (str), min (int), max (int)

    Exemple : {"type":"counter_between","name":"cycles","min":3,"max":7}
    """
    val = state.counter_get(cond.get('name', ''))
    return int(cond.get('min', 0)) <= val <= int(cond.get('max', 0))

def _variable_equals(cond: dict) -> bool:
    """
    True si la variable nommée est égale à `value` (comparaison string ou numérique).
    Paramètres : name (str), value (any)

    Exemple : {"type":"variable_equals","name":"phase","value":"mining"}
    """
    actual = state.var_get(cond.get('name', ''))
    ref    = cond.get('value')
    # Comparaison numérique si les deux sont des nombres
    try:
        return float(actual) == float(ref)
    except (TypeError, ValueError):
        return str(actual) == str(ref)

def _variable_contains(cond: dict) -> bool:
    """
    True si la variable nommée (convertie en string) contient `text`.
    Paramètres : name (str), text (str)

    Exemple : {"type":"variable_contains","name":"status","text":"farm"}
    """
    actual = str(state.var_get(cond.get('name', ''), ''))
    return cond.get('text', '').lower() in actual.lower()


# ══════════════════════════════════════════════════════════════════════════════
#  FENÊTRES
# ══════════════════════════════════════════════════════════════════════════════
def _window_focused(cond: dict) -> bool:
    """
    True si la fenêtre au premier plan contient `title` dans son titre.
    Paramètres : title (str)

    Exemple : {"type":"window_focused","title":"FiveM"}
    """
    import win32gui
    hwnd  = win32gui.GetForegroundWindow()
    title = win32gui.GetWindowText(hwnd)
    return cond.get('title', '').lower() in title.lower()

def _window_exists(cond: dict) -> bool:
    """
    True si au moins une fenêtre visible contient `title`.
    Paramètres : title (str)
    """
    from .window_manager import find_window
    return find_window(title_contains=cond.get('title', '')) is not None


# ══════════════════════════════════════════════════════════════════════════════
#  PROCESSUS
# ══════════════════════════════════════════════════════════════════════════════
def _process_running(cond: dict) -> bool:
    """
    True si un processus avec ce nom d'exécutable tourne sur le système.
    Paramètres : exe (str) — ex: "FiveM.exe", "GTA5.exe"

    Essentiel pour arrêter les macros si le jeu crashe :
      {"type":"process_not_running","exe":"FiveM.exe"}  → dans stop_conditions

    Note : utilise le cache de psutil pour la performance.
    """
    import psutil
    exe = cond.get('exe', '').lower()
    if not exe:
        return False
    return any(
        p.info.get('name', '').lower() == exe
        for p in psutil.process_iter(['name'])
    )


# ══════════════════════════════════════════════════════════════════════════════
#  HEURE
# ══════════════════════════════════════════════════════════════════════════════
def _time_between(cond: dict) -> bool:
    """
    True si l'heure actuelle est entre `start` et `end` (format HH:MM).
    Gère le passage minuit (ex: start="23:00", end="06:00").
    Paramètres : start, end

    Exemple : {"type":"time_between","start":"08:00","end":"22:00"}
    """
    from datetime import datetime
    now   = datetime.now().strftime('%H:%M')
    start = cond.get('start', '00:00')
    end   = cond.get('end',   '23:59')
    if start <= end:
        return start <= now <= end
    return now >= start or now <= end   # passage minuit


# ══════════════════════════════════════════════════════════════════════════════
#  ALÉATOIRE
# ══════════════════════════════════════════════════════════════════════════════
def _random_chance(cond: dict) -> bool:
    """
    Retourne True avec `chance`% de probabilité (0-100).
    Paramètres : chance (float, défaut 50.0)

    Exemple : {"type":"random_chance","chance":30}  → vrai ~30% du temps
    """
    import random
    return random.random() * 100 < float(cond.get('chance', 50.0))


# ══════════════════════════════════════════════════════════════════════════════
#  CLAVIER
# ══════════════════════════════════════════════════════════════════════════════
def _key_is_held(cond: dict) -> bool:
    """
    True si la touche `key` est physiquement enfoncée (GetAsyncKeyState).
    Paramètres : key (str)

    Exemple : {"type":"key_is_held","key":"shift"}
    """
    vk = _key_to_vk(cond.get('key', ''))
    if vk is None:
        return False
    return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)


# ══════════════════════════════════════════════════════════════════════════════
#  PRESSE-PAPIER
# ══════════════════════════════════════════════════════════════════════════════
def _clipboard_contains(cond: dict) -> bool:
    """
    True si le presse-papier contient `text` (insensible à la casse).
    Paramètres : text (str)
    """
    search = cond.get('text', '').lower()
    try:
        CF_UNICODETEXT = 13
        ctypes.windll.user32.OpenClipboard(0)
        h = ctypes.windll.user32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return False
        ptr  = ctypes.windll.kernel32.GlobalLock(h)
        size = ctypes.windll.kernel32.GlobalSize(h)
        raw  = ctypes.string_at(ptr, size)
        ctypes.windll.kernel32.GlobalUnlock(h)
        return search in raw.decode('utf-16-le').rstrip('\x00').lower()
    except Exception:
        return False
    finally:
        try:
            ctypes.windll.user32.CloseClipboard()
        except Exception:
            pass
