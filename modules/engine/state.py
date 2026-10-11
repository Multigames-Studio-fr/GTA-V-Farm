"""
state.py — État global partagé entre toutes les macros.

Contient :
  - Compteurs nommés       (counter_inc, counter_get, ...)
  - Variables nommées      (var_set, var_get, ...)
  - Snapshots de pixels    (pour la condition pixel_changed)
  - Zones interdites       (dead_zones — le moteur refuse les clics dedans)
  - Stats d'exécution      (par macro)

Tout est thread-safe. Les données persistent jusqu'à la fin du process.
"""
from __future__ import annotations
import json
import os
import threading
import time

_lock = threading.Lock()

# ── Compteurs ──────────────────────────────────────────────────────────────────
_counters: dict[str, int] = {}

def counter_get(name: str) -> int:
    with _lock:
        return _counters.get(name, 0)

def counter_set(name: str, value: int) -> int:
    with _lock:
        _counters[name] = int(value)
        return _counters[name]

def counter_inc(name: str, by: int = 1) -> int:
    with _lock:
        _counters[name] = _counters.get(name, 0) + by
        return _counters[name]

def counter_dec(name: str, by: int = 1) -> int:
    with _lock:
        _counters[name] = _counters.get(name, 0) - by
        return _counters[name]

def counter_reset(name: str) -> None:
    with _lock:
        _counters.pop(name, None)

def get_all_counters() -> dict[str, int]:
    with _lock:
        return dict(_counters)


# ── Variables ──────────────────────────────────────────────────────────────────
_variables: dict[str, object] = {}

def var_set(name: str, value) -> None:
    with _lock:
        _variables[name] = value

def var_get(name: str, default=None):
    with _lock:
        return _variables.get(name, default)

def var_delete(name: str) -> None:
    with _lock:
        _variables.pop(name, None)

def get_all_variables() -> dict:
    with _lock:
        return dict(_variables)


# ── Snapshots de pixels (pour pixel_changed) ───────────────────────────────────
# key → {'r': int, 'g': int, 'b': int, 'x': int, 'y': int, 'ts': float}
_pixel_snapshots: dict[str, dict] = {}

def pixel_snapshot_save(key: str, x: int, y: int, color: tuple[int, int, int]) -> None:
    """Mémorise la couleur d'un pixel sous une clé nommée."""
    with _lock:
        _pixel_snapshots[key] = {
            'r': color[0], 'g': color[1], 'b': color[2],
            'x': x, 'y': y, 'ts': time.time(),
        }

def pixel_snapshot_get(key: str) -> dict | None:
    with _lock:
        return _pixel_snapshots.get(key)

def pixel_snapshot_clear(key: str) -> None:
    with _lock:
        _pixel_snapshots.pop(key, None)

def clear_all() -> None:
    """Remet à zéro variables, compteurs et snapshots de pixels — utilisé
    par la commande IPC clear_state (bouton Reset de l'UI). Ne touche pas
    aux stats de macro (voir stats_clear_all) ni aux dead zones, qui ont
    leur propre mécanisme."""
    with _lock:
        _counters.clear()
        _variables.clear()
        _pixel_snapshots.clear()


# ── Zones interdites (dead zones) ─────────────────────────────────────────────
# Liste de dicts {x, y, w, h} en coords écran absolues.
# Le moteur vérifie avant chaque clic/drag que la cible n'est PAS dans une dead zone.
_dead_zones: list[dict] = []

def set_dead_zones(zones: list[dict]) -> None:
    """Remplace la liste complète des zones interdites."""
    with _lock:
        _dead_zones.clear()
        _dead_zones.extend(zones)

def add_dead_zone(zone: dict) -> None:
    """Ajoute une zone interdite {x, y, w, h}."""
    with _lock:
        _dead_zones.append(zone)

def clear_dead_zones() -> None:
    with _lock:
        _dead_zones.clear()

def get_dead_zones() -> list[dict]:
    with _lock:
        return list(_dead_zones)

def is_in_dead_zone(x: int, y: int) -> bool:
    """Retourne True si (x, y) tombe dans une zone interdite."""
    with _lock:
        for z in _dead_zones:
            if z['x'] <= x < z['x'] + z['w'] and z['y'] <= y < z['y'] + z['h']:
                return True
    return False


# ── Stats d'exécution ──────────────────────────────────────────────────────────
# macro_id → {start_time, iterations, rules_triggered{label:count}, errors, last_rule}
_stats: dict[str, dict] = {}

def stats_init(macro_id: str) -> None:
    with _lock:
        _stats[macro_id] = {
            'start_time':     time.time(),
            'iterations':     0,
            'rules_triggered': {},
            'errors':         0,
            'last_rule':      None,
            'last_rule_ts':   None,
        }

def stats_iteration(macro_id: str) -> None:
    with _lock:
        if macro_id in _stats:
            _stats[macro_id]['iterations'] += 1

def stats_rule_triggered(macro_id: str, label: str) -> None:
    with _lock:
        if macro_id in _stats:
            rt = _stats[macro_id]['rules_triggered']
            rt[label] = rt.get(label, 0) + 1
            _stats[macro_id]['last_rule']    = label
            _stats[macro_id]['last_rule_ts'] = time.time()

def stats_error(macro_id: str) -> None:
    with _lock:
        if macro_id in _stats:
            _stats[macro_id]['errors'] += 1

def stats_get(macro_id: str) -> dict | None:
    with _lock:
        s = _stats.get(macro_id)
        if s is None:
            return None
        elapsed = time.time() - s['start_time']
        return {**s, 'elapsed_s': round(elapsed, 1)}

def stats_get_all() -> dict:
    with _lock:
        result = {}
        for mid, s in _stats.items():
            elapsed = time.time() - s['start_time']
            result[mid] = {**s, 'elapsed_s': round(elapsed, 1)}
        return result

def stats_clear(macro_id: str) -> None:
    with _lock:
        _stats.pop(macro_id, None)

def stats_clear_all() -> None:
    with _lock:
        _stats.clear()


# ── Historique persistant des runs ──────────────────────────────────────────────
# Un enregistrement par macro terminée (peu importe la raison : boucle finie,
# stop manuel, stop_condition, timeout, max_iterations) — écrit sur disque pour
# survivre au redémarrage de l'app, contrairement à _stats ci-dessus qui est
# perdu à chaque relance du process Python.
_HISTORY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'macro_history.json',
)
_HISTORY_MAX = 300  # entrées totales conservées, toutes macros confondues
# Verrou dédié : l'I/O disque ne doit pas bloquer compteurs/variables/dead zones
# (protégés par _lock), et history_get ne doit pas lire un fichier à moitié écrit.
_history_lock = threading.Lock()

def history_append(record: dict) -> None:
    """Best-effort : une erreur d'écriture ne doit jamais faire planter le runner."""
    with _history_lock:
        try:
            data = []
            if os.path.exists(_HISTORY_PATH):
                with open(_HISTORY_PATH, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                if isinstance(loaded, list):
                    data = loaded
            data.append(record)
            if len(data) > _HISTORY_MAX:
                data = data[-_HISTORY_MAX:]
            # Écriture atomique : fichier temporaire puis os.replace
            tmp_path = _HISTORY_PATH + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, _HISTORY_PATH)
        except Exception:
            pass

def history_get(limit: int = 100) -> list:
    with _history_lock:
        try:
            if not os.path.exists(_HISTORY_PATH):
                return []
            with open(_HISTORY_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, list):
                return []
            return data[-limit:][::-1]  # plus récent en premier
        except Exception:
            return []


# ── Runner registry (partagé avec conditions.py, évite l'import lourd au démarrage) ──
_runners_ref: dict = {}

def set_runners_registry(registry: dict) -> None:
    """Fourni par main.py — permet à macro_is_running d'accéder aux runners actifs."""
    global _runners_ref
    _runners_ref = registry

def get_runners_registry() -> dict:
    return _runners_ref
