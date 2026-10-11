"""
actions.py — Tous les types d'actions disponibles dans les macros.

─── CLAVIER ───────────────────────────────────────────────────────────────────
  key_tap         appuie et relâche une touche (répétable)
  key_hold        maintient une touche enfoncée
  key_release     relâche une touche maintenue
  key_combo       combinaison de touches (ctrl+c, alt+tab, ...)
  type_text       tape du texte caractère par caractère

─── SOURIS ────────────────────────────────────────────────────────────────────
  mouse_move      déplace la souris (absolu ou relatif, courbe de Bézier)
  mouse_click     clic simple à une position
  mouse_double_click  double-clic
  mouse_drag      glisser-déposer
  scroll          scroll vertical

─── TEMPORISATION ─────────────────────────────────────────────────────────────
  wait            attendre N secondes (fixe)
  random_wait     attendre entre min et max secondes

─── CONTRÔLE DE MACROS ────────────────────────────────────────────────────────
  macro_start     lancer une autre macro
  macro_stop      arrêter une autre macro
  stop_self       arrêter la macro courante

─── FLUX ──────────────────────────────────────────────────────────────────────
  repeat          répéter un bloc d'actions N fois

─── VARIABLES & COMPTEURS ─────────────────────────────────────────────────────
  set_variable    définir une variable nommée
  counter_set     définir un compteur
  counter_inc     incrémenter un compteur
  counter_dec     décrémenter un compteur
  counter_reset   remettre un compteur à zéro

─── NOTIFICATIONS & LOGS ──────────────────────────────────────────────────────
  send_webhook    envoyer un webhook Discord
  log_message     écrire dans les logs
  notify_toast    notification Windows (bulle système)
  play_sound      jouer un son (.wav) ou un bip

─── FENÊTRES ──────────────────────────────────────────────────────────────────
  focus_window    mettre une fenêtre au premier plan

─── CAPTURES ──────────────────────────────────────────────────────────────────
  screenshot_save sauvegarder une capture d'écran

─── PRESSE-PAPIER ─────────────────────────────────────────────────────────────
  clipboard_set   copier du texte dans le presse-papier
"""
from __future__ import annotations
import os
import time
import random
import threading
import subprocess
import ctypes
import ctypes.wintypes

import pyautogui
import pydirectinput

from . import state
from . import humanizer as hum

pyautogui.FAILSAFE = False
pydirectinput.FAILSAFE = False

_user32   = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32


# ══════════════════════════════════════════════════════════════════════════════
#  HELPERS INTERNES
# ══════════════════════════════════════════════════════════════════════════════
def _interruptible_sleep(duration: float, stop_event=None, step: float = 0.05) -> bool:
    """Sleep interruptible par stop_event. Retourne True si interrompu."""
    if duration <= 0:
        return False
    if stop_event is None:
        time.sleep(duration)
        return False
    return stop_event.wait(timeout=duration)


# ── Suivi des touches / boutons souris actuellement enfoncés ──────────────────
# (kind, name, direct) → ident du thread qui l'a enfoncé.
#   kind   'key' | 'mouse'
#   direct True = pydirectinput, False = pyautogui (mouse : toujours pyautogui)
# Permet de tout relâcher sur arrêt d'urgence (F12, stop_all, EOF) ou en fin de
# runner, au lieu de laisser une touche « collée » côté jeu.
_held: dict[tuple, int] = {}
_held_lock = threading.Lock()


def _mark_held(kind: str, name: str, direct: bool = False) -> None:
    with _held_lock:
        _held[(kind, name, bool(direct))] = threading.get_ident()


def _mark_released(kind: str, name: str, direct: bool | None = None) -> None:
    with _held_lock:
        if direct is None:
            _held.pop((kind, name, True), None)
            _held.pop((kind, name, False), None)
        else:
            _held.pop((kind, name, bool(direct)), None)


def _press_key(key: str, direct: bool) -> None:
    (pydirectinput.keyDown if direct else pyautogui.keyDown)(key)
    _mark_held('key', key, direct)


def _release_key(key: str, direct: bool) -> None:
    try:
        (pydirectinput.keyUp if direct else pyautogui.keyUp)(key)
    finally:
        _mark_released('key', key, direct)


def release_all_held_keys(owner: int | None = None) -> None:
    """
    Relâche toutes les touches / boutons souris enfoncés par le moteur.
    owner : ident de thread — ne relâche que ce que ce thread a enfoncé
            (None = tout relâcher). Les erreurs par touche sont ignorées.
    """
    with _held_lock:
        items = [k for k, o in _held.items() if owner is None or o == owner]
        for k in items:
            _held.pop(k, None)
    for kind, name, direct in items:
        try:
            if kind == 'mouse':
                pyautogui.mouseUp(button=name)
            elif direct:
                pydirectinput.keyUp(name)
            else:
                pyautogui.keyUp(name)
        except Exception:
            pass


def _set_cursor(x: int, y: int) -> None:
    _user32.SetCursorPos(int(x), int(y))


def _smooth_move(x: int, y: int, duration: float, use_bezier: bool = True,
                 stop_event=None) -> None:
    """
    Déplace la souris vers (x, y).
    Si use_bezier=True et duration>0, utilise une courbe de Bézier naturelle.
    Interrompt le mouvement si stop_event est setté.
    """
    if duration <= 0:
        _set_cursor(x, y)
        return
    pt = ctypes.wintypes.POINT()
    _user32.GetCursorPos(ctypes.byref(pt))
    sx, sy = pt.x, pt.y

    if use_bezier:
        points = hum.bezier_points(sx, sy, x, y,
                                   steps=max(20, int(duration * 180)),
                                   curve=0.25)
        delay = duration / len(points)
        for px, py in points:
            if stop_event and stop_event.is_set():
                return
            _set_cursor(px, py)
            time.sleep(delay)
    else:
        steps = max(20, int(duration * 200))
        delay = duration / steps
        for i in range(1, steps + 1):
            if stop_event and stop_event.is_set():
                return
            t = i / steps
            _set_cursor(int(sx + (x - sx) * t), int(sy + (y - sy) * t))
            time.sleep(delay)
    _set_cursor(x, y)


def _guard_dead_zone(x: int, y: int, action_type: str) -> bool:
    """
    Vérifie que (x, y) n'est pas dans une zone interdite.
    Retourne False et logue si la position est bloquée.
    """
    if state.is_in_dead_zone(x, y):
        import logging
        logging.getLogger('engine').warning(
            f'[dead_zone] Action "{action_type}" bloquée : '
            f'({x},{y}) est dans une zone interdite.'
        )
        return False
    return True


def _set_clipboard_text(text: str) -> None:
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE  = 0x0002
    data = (text + '\x00').encode('utf-16-le')
    h = _kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    ptr = _kernel32.GlobalLock(h)
    ctypes.memmove(ptr, data, len(data))
    _kernel32.GlobalUnlock(h)
    _user32.OpenClipboard(0)
    _user32.EmptyClipboard()
    _user32.SetClipboardData(CF_UNICODETEXT, h)
    _user32.CloseClipboard()


# ══════════════════════════════════════════════════════════════════════════════
#  DISPATCH PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════
def exec_action(action: dict, ctx: dict | None = None) -> None:
    """
    Exécute une action.

    ctx (optionnel) — callbacks du runner :
      on_macro_start(id)  lancer une macro
      on_macro_stop(id)   arrêter une macro
      on_webhook(ev, d)   envoyer un webhook
      on_log(msg, lvl)    écrire dans les logs
      stop_self()         arrêter la macro courante
      _stop               threading.Event() du runner (pour repeat)
      _pause_lock         threading.Event() pause (pour repeat)
      _humanize           bool  — humaniser les timings
      _humanize_factor    float — intensité (défaut 0.12)
    """
    ctx  = ctx or {}

    # Humanisation globale : si la macro a humanize=True, on varie les durées
    if ctx.get('_humanize'):
        factor = float(ctx.get('_humanize_factor', 0.12))
        action = hum.apply_to_action(action, factor)

    t = action.get('type', '')

    # ── Clavier ────────────────────────────────────────────────────────────
    if   t == 'key_tap':             _key_tap(action, ctx)
    elif t == 'key_hold':            _key_hold(action, ctx)
    elif t == 'key_release':         _key_release(action)
    elif t == 'key_combo':           _key_combo(action)
    elif t == 'type_text':           _type_text(action, ctx)

    # ── Souris ─────────────────────────────────────────────────────────────
    elif t == 'mouse_move':          _mouse_move(action, ctx)
    elif t == 'mouse_click':         _mouse_click(action)
    elif t == 'mouse_double_click':  _mouse_double_click(action)
    elif t == 'mouse_drag':          _mouse_drag(action, ctx)
    elif t == 'scroll':              _scroll(action)

    # ── Temporisation ──────────────────────────────────────────────────────
    elif t == 'wait':                _wait(action, ctx)
    elif t == 'random_wait':         _random_wait(action, ctx)

    # ── Contrôle de macros ─────────────────────────────────────────────────
    elif t == 'macro_start':         _macro_start(action, ctx)
    elif t == 'macro_stop':          _macro_stop(action, ctx)
    elif t == 'stop_self':           _stop_self(ctx)

    # ── Flux ───────────────────────────────────────────────────────────────
    elif t == 'repeat':              _repeat(action, ctx)

    # ── Variables & compteurs ──────────────────────────────────────────────
    elif t == 'set_variable':        _set_variable(action)
    elif t == 'counter_set':         _counter_set(action)
    elif t == 'counter_inc':         _counter_inc(action)
    elif t == 'counter_dec':         _counter_dec(action)
    elif t == 'counter_reset':       _counter_reset(action)

    # ── Notifications & logs ───────────────────────────────────────────────
    elif t == 'send_webhook':        _send_webhook(action, ctx)
    elif t == 'log_message':         _log_message(action, ctx)
    elif t == 'notify_toast':        _notify_toast(action)
    elif t == 'play_sound':          _play_sound(action)

    # ── Fenêtres ───────────────────────────────────────────────────────────
    elif t == 'focus_window':        _focus_window(action)

    # ── Captures ───────────────────────────────────────────────────────────
    elif t == 'screenshot_save':     _screenshot_save(action)

    # ── Presse-papier ──────────────────────────────────────────────────────
    elif t == 'clipboard_set':       _clipboard_set(action)

    elif t == 'loop_back':           pass  # géré par le runner


# ══════════════════════════════════════════════════════════════════════════════
#  CLAVIER
# ══════════════════════════════════════════════════════════════════════════════
def _key_tap(a: dict, ctx: dict | None = None) -> None:
    """
    Appuie et relâche une touche.
    Paramètres :
      key            str   — nom de la touche (ex: "e", "f1", "shift")
      duration       float — durée de pression (défaut 0.05s)
      count          int   — répétitions (défaut 1)
      delay_between  float — délai entre répétitions (défaut 0.05s)
      use_direct     bool  — pydirectinput (recommandé jeux) ou pyautogui
    """
    key    = a.get('key', '')
    dur    = float(a.get('duration', 0.05))
    count  = int(a.get('count', 1))
    delay  = float(a.get('delay_between', 0.05))
    direct = a.get('use_direct', True)
    stop   = (ctx or {}).get('_stop')
    for i in range(count):
        if stop and stop.is_set():
            break
        _press_key(key, direct)
        try:
            time.sleep(dur)
        finally:
            _release_key(key, direct)   # keyUp garanti, même sur exception
        if i < count - 1:
            if _interruptible_sleep(delay, stop):
                break


def _key_hold(a: dict, ctx: dict | None = None) -> None:
    """
    Maintient une touche enfoncée pendant `duration` secondes.
    Paramètres : key, duration (défaut 1.0s), use_direct
    """
    key    = a.get('key', '')
    dur    = float(a.get('duration', 1.0))
    direct = a.get('use_direct', True)
    stop   = (ctx or {}).get('_stop')
    _press_key(key, direct)
    try:
        _interruptible_sleep(dur, stop)
    finally:
        _release_key(key, direct)


def _key_release(a: dict) -> None:
    """
    Relâche une touche maintenue.
    Paramètres : key, use_direct
    """
    key = a.get('key', '')
    _release_key(key, a.get('use_direct', True))


def _key_combo(a: dict) -> None:
    """
    Appuie sur une combinaison de touches simultanément.
    Paramètres :
      keys       list[str] — touches dans l'ordre de pression (ex: ["ctrl","c"])
      duration   float     — durée de maintien (défaut 0.05s)
      use_direct bool      — pydirectinput ou pyautogui

    Exemple : {"type":"key_combo","keys":["ctrl","shift","esc"]}
    """
    keys   = a.get('keys', [])
    if isinstance(keys, str):   # anciennes macros : "ctrl+c" au lieu de ["ctrl","c"]
        keys = [k.strip() for k in keys.split('+') if k.strip()]
    dur    = float(a.get('duration', 0.05))
    direct = a.get('use_direct', False)   # pyautogui gère mieux les combos
    if not keys:
        return
    pressed: list[str] = []
    try:
        for k in keys:
            _press_key(k, direct)
            pressed.append(k)
        time.sleep(dur)
    finally:
        # Relâche dans l'ordre inverse, même si un keyDown/sleep a levé
        for k in reversed(pressed):
            try:
                _release_key(k, direct)
            except Exception:
                pass


_KEYBDINPUT_FIELDS = [
    ('wVk',         ctypes.c_ushort),
    ('wScan',       ctypes.c_ushort),
    ('dwFlags',     ctypes.c_ulong),
    ('time',        ctypes.c_ulong),
    ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong)),
]

class _KEYBDINPUT(ctypes.Structure):
    _fields_ = _KEYBDINPUT_FIELDS

class _INPUT_KB(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [('ki', _KEYBDINPUT)]
    _anonymous_ = ('_u',)
    _fields_    = [('type', ctypes.c_ulong), ('_u', _U), ('_pad', ctypes.c_ubyte * 8)]

_KEYEVENTF_UNICODE = 0x0004
_KEYEVENTF_KEYUP   = 0x0002


_VK_RETURN = 0x0D


def _send_kb_event(vk: int, scan: int, flags: int) -> None:
    inp = _INPUT_KB()
    inp.type       = 1  # INPUT_KEYBOARD
    inp.ki.wVk     = vk
    inp.ki.wScan   = scan
    inp.ki.dwFlags = flags
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))


def _send_unicode_char(char: str) -> None:
    """SendInput with KEYEVENTF_UNICODE — layout-independent character injection.
    Les caractères hors BMP (> U+FFFF, ex. emojis) sont envoyés en paire de
    substitution UTF-16 (wScan est sur 16 bits)."""
    data  = char.encode('utf-16-le')
    units = [int.from_bytes(data[i:i + 2], 'little') for i in range(0, len(data), 2)]
    for u in units:
        _send_kb_event(0, u, _KEYEVENTF_UNICODE)
    for u in units:
        _send_kb_event(0, u, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP)


def _send_enter() -> None:
    """Entrée via VK_RETURN (un '\\n' en unicode 0x0A n'est pas interprété comme Entrée)."""
    _send_kb_event(_VK_RETURN, 0, 0)
    _send_kb_event(_VK_RETURN, 0, _KEYEVENTF_KEYUP)


def _type_text(a: dict, ctx: dict | None = None) -> None:
    """
    Tape du texte caractère par caractère via SendInput KEYEVENTF_UNICODE.
    Layout-indépendant : fonctionne sur AZERTY, QWERTY, etc.
    '\\n', '\\r' et '\\r\\n' → une seule pression sur Entrée. Interruptible.
    Paramètres : text, interval (défaut 0.05s entre chaque caractère)
    """
    text     = a.get('text', '')
    interval = float(a.get('interval', 0.05))
    stop     = (ctx or {}).get('_stop')
    text     = text.replace('\r\n', '\n').replace('\r', '\n')
    for ch in text:
        if stop and stop.is_set():
            break
        if ch == '\n':
            _send_enter()
        else:
            _send_unicode_char(ch)
        if interval > 0:
            if _interruptible_sleep(interval, stop):
                break


# ══════════════════════════════════════════════════════════════════════════════
#  SOURIS
# ══════════════════════════════════════════════════════════════════════════════
def _mouse_move(a: dict, ctx: dict | None = None) -> None:
    """
    Déplace la souris vers (x, y) ou de manière relative.
    Paramètres :
      x, y       int   — position cible
      relative   bool  — déplacement relatif à la position courante
      duration   float — durée du mouvement (défaut 0.1s)
      bezier     bool  — courbe naturelle (défaut True)
      jitter     int   — rayon de jitter aléatoire en pixels (défaut 0)
    """
    x        = int(a.get('x', 0))
    y        = int(a.get('y', 0))
    relative = a.get('relative', False)
    duration = float(a.get('duration', 0.1))
    use_bez  = a.get('bezier', True)
    jitter_r = int(a.get('jitter', 0))
    stop     = (ctx or {}).get('_stop')

    if relative:
        pt = ctypes.wintypes.POINT()
        _user32.GetCursorPos(ctypes.byref(pt))
        x, y = pt.x + x, pt.y + y

    if jitter_r > 0:
        x, y = hum.jitter(x, y, jitter_r)

    _smooth_move(x, y, duration, use_bezier=use_bez, stop_event=stop)


def _mouse_click(a: dict) -> None:
    """
    Clic de souris à (x, y) optionnel.
    Paramètres :
      x, y     int  — position (optionnel, clic sur place si absent)
      button   str  — 'left'|'right'|'middle' (défaut 'left')
      count    int  — nombre de clics (défaut 1)
      jitter   int  — rayon de jitter (défaut 0)
    """
    x      = a.get('x', None)
    y      = a.get('y', None)
    button = a.get('button', 'left')
    count  = int(a.get('count', 1))
    jitter_r = int(a.get('jitter', 0))

    if x is not None and y is not None:
        fx, fy = int(x), int(y)
        if jitter_r > 0:
            fx, fy = hum.jitter(fx, fy, jitter_r)
        if not _guard_dead_zone(fx, fy, 'mouse_click'):
            return
        _set_cursor(fx, fy)

    pyautogui.click(clicks=count, button=button)


def _mouse_double_click(a: dict) -> None:
    """
    Double-clic à (x, y) optionnel.
    Paramètres : x, y (optionnels), button, jitter
    """
    x = a.get('x', None)
    y = a.get('y', None)
    button = a.get('button', 'left')
    jitter_r = int(a.get('jitter', 0))

    if x is not None and y is not None:
        fx, fy = int(x), int(y)
        if jitter_r > 0:
            fx, fy = hum.jitter(fx, fy, jitter_r)
        if not _guard_dead_zone(fx, fy, 'mouse_double_click'):
            return
        _set_cursor(fx, fy)

    pyautogui.doubleClick(button=button)


def _mouse_drag(a: dict, ctx: dict | None = None) -> None:
    """
    Glisser-déposer de (x1, y1) vers (x2, y2).
    Paramètres : x1, y1, x2, y2, duration (défaut 0.3s), button, bezier, jitter
    """
    x1, y1   = int(a.get('x1', 0)), int(a.get('y1', 0))
    x2, y2   = int(a.get('x2', 0)), int(a.get('y2', 0))
    duration = float(a.get('duration', 0.3))
    button   = a.get('button', 'left')
    jitter_r = int(a.get('jitter', 0))
    use_bez  = a.get('bezier', True)
    stop     = (ctx or {}).get('_stop')

    if jitter_r > 0:
        x1, y1 = hum.jitter(x1, y1, jitter_r)
        x2, y2 = hum.jitter(x2, y2, jitter_r)

    if not _guard_dead_zone(x1, y1, 'mouse_drag'):
        return
    if not _guard_dead_zone(x2, y2, 'mouse_drag'):
        return

    _set_cursor(x1, y1)
    if _interruptible_sleep(0.05, stop): return
    pyautogui.mouseDown(button=button)
    _mark_held('mouse', button)
    try:
        if _interruptible_sleep(0.05, stop):
            return
        _smooth_move(x2, y2, duration, use_bezier=use_bez, stop_event=stop)
    finally:
        # mouseUp garanti, même si le mouvement lève une exception
        try:
            pyautogui.mouseUp(button=button)
        finally:
            _mark_released('mouse', button)


def _scroll(a: dict) -> None:
    """
    Scroll vertical.
    Paramètres : clicks (défaut 3), direction ('up'|'down'), x, y (optionnels)
    """
    clicks    = int(a.get('clicks', 3))
    direction = a.get('direction', 'down')
    x         = a.get('x', None)
    y         = a.get('y', None)
    if x is not None and y is not None:
        _set_cursor(int(x), int(y))
    pyautogui.scroll(-clicks if direction == 'down' else clicks)


# ══════════════════════════════════════════════════════════════════════════════
#  TEMPORISATION
# ══════════════════════════════════════════════════════════════════════════════
def _wait(a: dict, ctx: dict | None = None) -> None:
    """
    Attend `duration` secondes (fixe). Interruptible par le signal d'arrêt.
    Paramètres : duration (défaut 1.0s)
    """
    _interruptible_sleep(float(a.get('duration', 1.0)), (ctx or {}).get('_stop'))


def _random_wait(a: dict, ctx: dict | None = None) -> None:
    """
    Attend une durée aléatoire entre `min` et `max` secondes. Interruptible.
    Paramètres : min (défaut 0.5s), max (défaut 2.0s)
    """
    dur = hum.vary_range(float(a.get('min', 0.5)), float(a.get('max', 2.0)))
    _interruptible_sleep(dur, (ctx or {}).get('_stop'))


# ══════════════════════════════════════════════════════════════════════════════
#  CONTRÔLE DE MACROS
# ══════════════════════════════════════════════════════════════════════════════
def _macro_start(a: dict, ctx: dict) -> None:
    """
    Lance une autre macro par son ID.
    Paramètres : macro_id (str)
    """
    cb = ctx.get('on_macro_start')
    if cb:
        cb(a.get('macro_id', ''))
    else:
        import logging
        logging.getLogger('engine').warning(
            'Action macro_start : contexte runner manquant'
        )


def _macro_stop(a: dict, ctx: dict) -> None:
    """
    Arrête une autre macro par son ID.
    Paramètres : macro_id (str) — vide = arrête la macro courante
    """
    macro_id = a.get('macro_id', '')
    if not macro_id:
        _stop_self(ctx)
        return
    cb = ctx.get('on_macro_stop')
    if cb:
        cb(macro_id)
    else:
        import logging
        logging.getLogger('engine').warning(
            'Action macro_stop : contexte runner manquant'
        )


def _stop_self(ctx: dict) -> None:
    """Arrête la macro courante depuis l'intérieur d'une règle."""
    cb = ctx.get('stop_self')
    if cb:
        cb()


# ══════════════════════════════════════════════════════════════════════════════
#  FLUX
# ══════════════════════════════════════════════════════════════════════════════
def _repeat(a: dict, ctx: dict) -> None:
    """
    Répète un bloc d'actions `count` fois.
    Respecte le signal d'arrêt du runner entre chaque action.
    Paramètres :
      count    int        — nombre de répétitions (défaut 1)
      actions  list[dict] — actions à répéter
      delay    float      — délai entre chaque répétition (défaut 0s)

    Exemple :
      {"type":"repeat","count":5,"actions":[
        {"type":"key_tap","key":"e"},
        {"type":"wait","duration":0.3}
      ]}
    """
    count    = int(a.get('count', 1))
    actions  = a.get('actions', [])
    delay    = float(a.get('delay', 0.0))
    stop_ev  = ctx.get('_stop')
    pause_lk = ctx.get('_pause_lock')

    for i in range(count):
        if stop_ev and stop_ev.is_set():
            break
        if pause_lk:
            pause_lk.wait()
        for action in actions:
            if stop_ev and stop_ev.is_set():
                break
            exec_action(action, ctx)
        if delay > 0 and i < count - 1:
            if _interruptible_sleep(delay, stop_ev):
                break


# ══════════════════════════════════════════════════════════════════════════════
#  VARIABLES & COMPTEURS
# ══════════════════════════════════════════════════════════════════════════════
def _set_variable(a: dict) -> None:
    """
    Définit une variable nommée.
    Paramètres : name (str), value (any)

    Exemple : {"type":"set_variable","name":"phase","value":"mining"}
    """
    state.var_set(a.get('name', ''), a.get('value'))


def _counter_set(a: dict) -> None:
    """
    Définit un compteur à une valeur précise.
    Paramètres : name (str), value (int)
    """
    state.counter_set(a.get('name', ''), int(a.get('value', 0)))


def _counter_inc(a: dict) -> None:
    """
    Incrémente un compteur de `by` (défaut 1).
    Paramètres : name (str), by (int, défaut 1)

    Exemple : {"type":"counter_inc","name":"cycles"}
    """
    state.counter_inc(a.get('name', ''), int(a.get('by', 1)))


def _counter_dec(a: dict) -> None:
    """
    Décrémente un compteur de `by` (défaut 1).
    Paramètres : name (str), by (int, défaut 1)
    """
    state.counter_dec(a.get('name', ''), int(a.get('by', 1)))


def _counter_reset(a: dict) -> None:
    """
    Remet un compteur à zéro (le supprime).
    Paramètres : name (str)
    """
    state.counter_reset(a.get('name', ''))


# ══════════════════════════════════════════════════════════════════════════════
#  NOTIFICATIONS & LOGS
# ══════════════════════════════════════════════════════════════════════════════
def _send_webhook(a: dict, ctx: dict) -> None:
    """
    Envoie un webhook Discord.
    Paramètres : event (str), data (dict)
    """
    cb = ctx.get('on_webhook')
    if cb:
        cb(a.get('event', 'action'), a.get('data', {}))
    else:
        import logging
        logging.getLogger('engine').warning(
            'Action send_webhook : contexte runner manquant'
        )


def _log_message(a: dict, ctx: dict) -> None:
    """
    Écrit un message dans les logs.
    Paramètres : message (str), level ('DEBUG'|'INFO'|'WARNING'|'ERROR')
    """
    msg   = a.get('message', '')
    level = a.get('level', 'INFO').upper()
    cb = ctx.get('on_log')
    if cb:
        cb(msg, level)
    else:
        import logging
        getattr(logging.getLogger('engine'), level.lower(), logging.info)(msg)


def _notify_toast(a: dict) -> None:
    """
    Affiche une notification Windows (bulle système), sans alt-tab.
    Paramètres :
      title    str — titre (défaut 'MacroEngine')
      message  str — corps du message
      duration int — durée d'affichage en secondes (défaut 5)

    Utilise PowerShell — fonctionne sur Windows 10/11 sans dépendances.
    """
    title    = a.get('title',   'MacroEngine').replace('"', "'")
    message  = a.get('message', '').replace('"', "'")
    duration = int(a.get('duration', 5))

    script = (
        'Add-Type -AssemblyName System.Windows.Forms;'
        '$n = New-Object System.Windows.Forms.NotifyIcon;'
        '$n.Icon = [System.Drawing.SystemIcons]::Information;'
        '$n.Visible = $true;'
        f'$n.ShowBalloonTip({duration * 1000},"{title}","{message}",'
        '[System.Windows.Forms.ToolTipIcon]::Info);'
        f'Start-Sleep -Seconds {duration};'
        '$n.Dispose()'
    )
    try:
        subprocess.Popen(
            ['powershell', '-WindowStyle', 'Hidden', '-Command', script],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except Exception as e:
        import logging
        logging.getLogger('engine').warning(f'notify_toast failed: {e}')


def _play_sound(a: dict) -> None:
    """
    Joue un son ou émet un bip système.
    Paramètres :
      path         str — chemin vers un fichier .wav (optionnel)
      freq         int — fréquence du bip en Hz (défaut 800, si pas de path)
      duration_ms  int — durée du bip en ms (défaut 300, si pas de path)
      async_play   bool — lecture asynchrone (défaut True)

    Si `path` est fourni et existe, joue le fichier .wav.
    Sinon, émet un bip système avec la fréquence et durée spécifiées.
    """
    import winsound
    path = a.get('path', '')
    if path and os.path.isfile(path):
        flags = winsound.SND_FILENAME
        if a.get('async_play', True):
            flags |= winsound.SND_ASYNC
        winsound.PlaySound(path, flags)
    else:
        freq = int(a.get('freq', 800))
        dur  = int(a.get('duration_ms', 300))
        try:
            winsound.Beep(freq, dur)
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
#  FENÊTRES
# ══════════════════════════════════════════════════════════════════════════════
def _focus_window(a: dict) -> None:
    """
    Met une fenêtre au premier plan.
    Paramètres :
      hwnd   int — handle de fenêtre (prioritaire)
      title  str — substring du titre (si hwnd non fourni)

    Exemple : {"type":"focus_window","title":"FiveM"}
    """
    from .window_manager import focus_window, find_window
    hwnd = a.get('hwnd', None)
    if hwnd:
        focus_window(int(hwnd))
    else:
        title = a.get('title', '')
        if title:
            w = find_window(title_contains=title)
            if w:
                focus_window(w['hwnd'])


# ══════════════════════════════════════════════════════════════════════════════
#  CAPTURES
# ══════════════════════════════════════════════════════════════════════════════
def _screenshot_save(a: dict) -> None:
    """
    Sauvegarde une capture d'écran dans un fichier.
    Paramètres :
      path    str  — chemin du fichier. Supporte {timestamp} et {date}.
                     Ex: "logs/debug_{timestamp}.png"
      x, y, w, h  — région à capturer (capture plein écran si absent)

    Crée les dossiers manquants automatiquement.
    Exemple : {"type":"screenshot_save","path":"logs/farm_{timestamp}.png"}
    """
    from .screen_reader import capture_region_pil, get_primary_screen_size
    import datetime

    now  = datetime.datetime.now()
    path = a.get('path', 'screenshot_{timestamp}.png')
    path = path.replace('{timestamp}', now.strftime('%Y%m%d_%H%M%S'))
    path = path.replace('{date}',      now.strftime('%Y-%m-%d'))

    os.makedirs(os.path.dirname(os.path.abspath(path)) if os.path.dirname(path) else '.', exist_ok=True)

    if 'x' in a and 'y' in a and 'w' in a and 'h' in a:
        img = capture_region_pil(int(a['x']), int(a['y']), int(a['w']), int(a['h']))
    else:
        w, h = get_primary_screen_size()
        img  = capture_region_pil(0, 0, w, h)

    img.save(path)
    import logging
    logging.getLogger('engine').debug(f'Screenshot sauvegardé : {path}')


# ══════════════════════════════════════════════════════════════════════════════
#  PRESSE-PAPIER
# ══════════════════════════════════════════════════════════════════════════════
def _clipboard_set(a: dict) -> None:
    """
    Copie du texte dans le presse-papier Windows.
    Paramètres : text (str)
    """
    _set_clipboard_text(a.get('text', ''))
