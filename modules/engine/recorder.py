"""
recorder.py — Record keyboard + mouse events into macro action steps
"""
from __future__ import annotations
import queue
import time
import threading
from typing import Callable

try:
    from pynput import keyboard, mouse
    _PYNPUT_AVAILABLE = True
except ImportError:
    _PYNPUT_AVAILABLE = False


_DRAG_THRESHOLD = 5  # pixels — en dessous = clic simple, au-dessus = drag
_HOLD_THRESHOLD = 0.3  # s — une touche maintenue plus longtemps est rejouée en key_hold

# ── Noms de touches pydirectinput ─────────────────────────────────────────────
# Le replay (key_tap/key_hold/key_combo avec use_direct) passe par pydirectinput,
# qui envoie des scancodes matériels nommés en QWERTY ('a' → 0x1E) et ignore
# silencieusement tout nom inconnu. Enregistrer key.char (caractère traduit par
# la disposition : 'a' sur la touche Q d'un AZERTY, 'é', '&', '\x03' pour
# Ctrl+C) ou les noms pynput (ctrl_l, page_up…) donnait donc des touches fausses
# ou inertes au replay. On dérive ici le nom de la position physique.

# Key pynput (touches spéciales) → nom pydirectinput
_PYNPUT_SPECIAL: dict[str, str] = {
    'alt': 'alt', 'alt_l': 'altleft', 'alt_r': 'altright', 'alt_gr': 'altright',
    'backspace': 'backspace', 'caps_lock': 'capslock',
    'cmd': 'winleft', 'cmd_l': 'winleft', 'cmd_r': 'winright',
    'ctrl': 'ctrlleft', 'ctrl_l': 'ctrlleft', 'ctrl_r': 'ctrlright',
    'shift': 'shiftleft', 'shift_l': 'shiftleft', 'shift_r': 'shiftright',
    'delete': 'delete', 'insert': 'insert', 'home': 'home', 'end': 'end',
    'page_up': 'pageup', 'page_down': 'pagedown',
    'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right',
    'enter': 'enter', 'esc': 'esc', 'space': 'space', 'tab': 'tab',
    'menu': 'apps', 'num_lock': 'numlock', 'scroll_lock': 'scrolllock',
    'pause': 'pause', 'print_screen': 'printscreen',
    **{f'f{n}': f'f{n}' for n in range(1, 13)},
}

_MODIFIERS = frozenset({
    'ctrl', 'ctrlleft', 'ctrlright', 'shift', 'shiftleft', 'shiftright',
    'alt', 'altleft', 'altright', 'win', 'winleft', 'winright',
})

# Scancode (set 1, non étendu) → nom pydirectinput, pour les touches « caractère »
_SCAN_TO_NAME: dict[int, str] = {}
try:
    import pydirectinput as _pdi
    for _n in list('abcdefghijklmnopqrstuvwxyz0123456789') + \
              ['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/',
               'multiply', 'subtract', 'add', 'decimal']:
        _sc = _pdi.KEYBOARD_MAPPING.get(_n)
        if _sc is not None and _sc < 0x100:
            _SCAN_TO_NAME.setdefault(_sc, _n)
except Exception:  # pydirectinput absent : table de secours (QWERTY set 1)
    _row = {0x02: '1234567890-=', 0x10: 'qwertyuiop[]', 0x1E: "asdfghjkl;'`",
            0x2B: '\\zxcvbnm,./'}
    for _base, _chars in _row.items():
        for _i, _c in enumerate(_chars):
            _SCAN_TO_NAME.setdefault(_base + _i, _c)
    _SCAN_TO_NAME.update({0x37: 'multiply', 0x4A: 'subtract', 0x4E: 'add', 0x53: 'decimal'})

# VK pavé numérique → nom pydirectinput (pas de noms « num0..9 » côté
# pydirectinput : on retombe sur les chiffres de la rangée du haut).
_NUMPAD_VK: dict[int, str] = {
    **{0x60 + d: str(d) for d in range(10)},
    0x6A: 'multiply', 0x6B: 'add', 0x6D: 'subtract', 0x6E: 'decimal', 0x6F: 'divide',
}


def _vk_to_scan(vk: int) -> int:
    try:
        import ctypes
        return int(ctypes.windll.user32.MapVirtualKeyW(vk, 0))  # MAPVK_VK_TO_VSC
    except Exception:
        return 0


class MacroRecorder:
    """Record keyboard and mouse events, output them as macro action dicts."""

    def __init__(self, on_event: Callable[[dict], None] | None = None):
        self.on_event = on_event or (lambda e: None)
        self._actions: list[dict] = []
        self._recording = False
        self._start_time = 0.0
        self._last_time = 0.0
        self._kb_listener = None
        self._ms_listener = None
        self._lock = threading.RLock()
        self._event_queue: queue.Queue = queue.Queue()
        self._sender_thread: threading.Thread | None = None
        # drag tracking
        self._drag_start: dict | None = None   # {x, y, button, time}
        self._current_pos: tuple[int, int] = (0, 0)
        # keyboard state
        self._held: dict[str, float] = {}      # touche → instant du keydown
        self._mods_down: list[str] = []         # modificateurs enfoncés (ordre)
        self._mods_used: set[str] = set()       # modificateurs déjà combinés
        self._pending: dict[str, dict] = {}     # touche → action émise au keydown

    def start(self):
        if not _PYNPUT_AVAILABLE:
            raise RuntimeError('pynput not installed — pip install pynput')
        if self._recording:
            return
        self._recording = True
        self._actions = []
        self._held.clear(); self._mods_down.clear()
        self._mods_used.clear(); self._pending.clear()
        self._start_time = time.time()
        self._last_time = self._start_time

        self._sender_thread = threading.Thread(target=self._sender_loop, daemon=True)
        self._sender_thread.start()

        self._kb_listener = keyboard.Listener(
            on_press=self._on_key_press,
            on_release=self._on_key_release,
        )
        self._ms_listener = mouse.Listener(
            on_move=self._on_mouse_move,
            on_click=self._on_mouse_click,
            on_scroll=self._on_mouse_scroll,
        )
        self._kb_listener.start()
        self._ms_listener.start()

    def stop(self) -> list[dict]:
        self._recording = False
        if self._kb_listener:
            self._kb_listener.stop()
            self._kb_listener = None
        if self._ms_listener:
            self._ms_listener.stop()
            self._ms_listener = None
        with self._lock:
            self._flush_drag()
        # drain queue before returning so on_event flushes all pending events
        self._event_queue.join()
        if self._sender_thread:
            self._event_queue.put(None)  # sentinel to stop sender
            self._sender_thread.join(timeout=2)
            self._sender_thread = None
        with self._lock:
            return list(self._actions)

    def is_recording(self) -> bool:
        return self._recording

    def _elapsed(self) -> float:
        with self._lock:
            now = time.time()
            dt = round(now - self._last_time, 3)
            self._last_time = now
        return dt

    def _sender_loop(self):
        """Drain event queue on dedicated thread so listener threads never block on I/O."""
        while True:
            item = self._event_queue.get()
            if item is None:
                self._event_queue.task_done()
                break
            try:
                self.on_event(item)
            finally:
                self._event_queue.task_done()

    def _add(self, action: dict):
        with self._lock:
            self._actions.append(action)
        self._event_queue.put(action)

    # ── Keyboard ──────────────────────────────────────────────
    def _key_name(self, key) -> str | None:
        """Nom pydirectinput de la touche *physique* (indépendant de la disposition)."""
        if isinstance(key, keyboard.Key):
            return _PYNPUT_SPECIAL.get(key.name)  # media/f13+ → None (ignorées)
        vk = getattr(key, 'vk', None)
        if vk is not None:
            if vk in _NUMPAD_VK:
                return _NUMPAD_VK[vk]
            scan = getattr(key, '_scan', None) or _vk_to_scan(vk)
            name = _SCAN_TO_NAME.get(scan & 0xFF) if scan else None
            if name:
                return name
        # Dernier recours (KeyCode synthétique sans vk) : caractère ASCII
        # imprimable seulement — jamais un caractère de contrôle type '\x03'.
        ch = getattr(key, 'char', None)
        if ch and len(ch) == 1 and ch.lower() in _SCAN_TO_NAME.values():
            return ch.lower()
        return None

    def _on_key_press(self, key):
        if not self._recording:
            return
        name = self._key_name(key)
        if not name:
            return
        now = time.time()
        with self._lock:
            # Auto-répétition Windows : keydown répétés sans keyup → ignorés
            if name in self._held:
                return
            self._held[name] = now
            if name in _MODIFIERS:
                # Différé : soit combiné à la prochaine touche (key_combo),
                # soit rejoué seul au relâchement s'il n'a servi à rien.
                self._mods_down.append(name)
                return
            mods = list(self._mods_down)
            self._mods_used.update(mods)
        dt = self._elapsed()
        if dt > 0.05:
            self._add({'type': 'wait', 'duration': dt})
        if mods:
            action = {'type': 'key_combo', 'keys': mods + [name],
                      'duration': 0.05, 'use_direct': True}
        else:
            action = {'type': 'key_tap', 'key': name, 'duration': 0.05,
                      'count': 1, 'use_direct': True}
        self._add(action)
        with self._lock:
            self._pending[name] = action

    def _on_key_release(self, key):
        if not self._recording:
            return
        name = self._key_name(key)
        if not name:
            return
        now = time.time()
        with self._lock:
            t0 = self._held.pop(name, None)
            if t0 is None:
                return
            held = round(now - t0, 3)
            if name in _MODIFIERS:
                if name in self._mods_down:
                    self._mods_down.remove(name)
                if name in self._mods_used:
                    self._mods_used.discard(name)
                    return
                # Modificateur pressé/relâché seul → tap (ou hold s'il a duré)
                wait = round(t0 - self._last_time, 3)
                self._last_time = now
                if wait > 0.05:
                    self._add({'type': 'wait', 'duration': wait})
                if held > _HOLD_THRESHOLD:
                    self._add({'type': 'key_hold', 'key': name, 'duration': held,
                               'use_direct': True})
                else:
                    self._add({'type': 'key_tap', 'key': name, 'duration': 0.05,
                               'count': 1, 'use_direct': True})
                return
            action = self._pending.pop(name, None)
            # Touche maintenue longtemps et rien enregistré entre-temps :
            # le tap devient un key_hold (ou un combo maintenu) de même durée.
            if (held > _HOLD_THRESHOLD and action is not None
                    and self._actions and self._actions[-1] is action):
                if action['type'] == 'key_tap':
                    new = {'type': 'key_hold', 'key': name, 'duration': held,
                           'use_direct': True}
                else:
                    new = dict(action, duration=held)
                self._actions[-1] = new
                self._last_time = now

    # ── Mouse ─────────────────────────────────────────────────
    def _flush_drag(self):
        """Finalise un drag en cours — appelé sous self._lock."""
        if self._drag_start is None:
            return
        start = self._drag_start
        self._drag_start = None
        ex, ey = self._current_pos
        dx = abs(ex - start['x'])
        dy = abs(ey - start['y'])
        if dx > _DRAG_THRESHOLD or dy > _DRAG_THRESHOLD:
            drag_duration = round(time.time() - start['time'], 3)
            self._add({
                'type': 'mouse_drag',
                'x1': start['x'], 'y1': start['y'],
                'x2': ex, 'y2': ey,
                'button': start['button'],
                'duration': max(drag_duration, 0.1),
            })
        else:
            self._add({'type': 'mouse_click', 'x': start['x'], 'y': start['y'],
                       'button': start['button'], 'count': 1})

    def _on_mouse_move(self, x, y):
        if not self._recording:
            return
        with self._lock:
            self._current_pos = (x, y)

    def _on_mouse_click(self, x, y, button, pressed):
        if not self._recording:
            return
        btn = 'left'
        if button == mouse.Button.right:
            btn = 'right'
        elif button == mouse.Button.middle:
            btn = 'middle'

        if pressed:
            dt = self._elapsed()
            if dt > 0.05:
                self._add({'type': 'wait', 'duration': dt})
            with self._lock:
                self._drag_start = {'x': x, 'y': y, 'button': btn, 'time': time.time()}
                self._current_pos = (x, y)
        else:
            with self._lock:
                if self._drag_start is None:
                    return
                self._flush_drag()
                self._last_time = time.time()

    def _on_mouse_scroll(self, x, y, dx, dy):
        if not self._recording:
            return
        dt = self._elapsed()
        if dt > 0.05:
            self._add({'type': 'wait', 'duration': dt})
        direction = 'up' if dy > 0 else 'down'
        self._add({'type': 'scroll', 'clicks': abs(dy), 'direction': direction, 'x': x, 'y': y})
