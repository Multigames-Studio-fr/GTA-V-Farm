"""
macro_runner.py — Exécute une macro dans un thread de fond.

Couches configurables (toutes optionnelles dans le JSON de la macro) :
  humanize          bool  — variation gaussienne des timings (défaut false)
  humanize_factor   float — intensité de la variation 0.0–1.0 (défaut 0.12)
  kill_switch       dict  — {enabled: bool, key: str} touche d'arrêt d'urgence
  stop_conditions   list  — arrêt auto quand l'une est vraie
  start_guard       list  — attend que toutes soient vraies avant de boucler
  max_iterations    int   — arrêt après N boucles (0 = illimité)
  timeout_s         float — arrêt après N secondes (0 = illimité)
  pre_stop_actions  list  — actions exécutées avant l'arrêt (nettoyage)

Structure complète :
{
  "name": "Mon Farm",
  "loop": true,
  "loop_delay": 0.1,
  "humanize": true,
  "humanize_factor": 0.12,
  "stop_conditions":  [{"type": "process_not_running", "exe": "FiveM.exe"}],
  "start_guard":      [{"type": "window_focused",      "title": "FiveM"}],
  "max_iterations":   1000,
  "timeout_s":        7200,
  "pre_stop_actions": [{"type": "key_tap", "key": "esc"}],
  "rules": [...]
}
"""
from __future__ import annotations
import time
import logging
import threading
from typing import Callable

from .conditions   import eval_condition
from .actions      import exec_action
from .window_manager import is_window_focused
from . import state

logger = logging.getLogger('engine')

# Auto Clicker runs as a regular macro under the hood (see page-autoclicker.js
# _acpBuildMacro) using this fixed name as both its runner registry key and
# its macro.name — detected here so its webhook notifications get their own
# event name/label (and their own on/off toggle in Settings > Discord)
# instead of showing up as an anonymous "Macro démarrée: __auto_clicker__".
_SYNTHETIC_MACRO_EVENTS = {
    '__auto_clicker__': ('Auto Clicker', 'autoclicker'),
}

# Thread actif par nom de macro — un nouveau runner du même nom attend la fin
# de l'instance précédente (encore en train de s'arrêter : key_hold en cours,
# pre_stop_actions...) au lieu de tourner en parallèle avec elle.
_active_by_name: dict[str, threading.Thread] = {}
_active_lock = threading.Lock()


class MacroRunner:
    """Exécute une macro dans un thread de fond avec support des couches de cycle de vie."""

    def __init__(
        self,
        macro:          dict,
        on_log:         Callable[[str, str], None] | None = None,
        on_webhook:     Callable[[str, dict], None] | None = None,
        on_macro_start: Callable[[str], None] | None = None,
        on_macro_stop:  Callable[[str], None] | None = None,
        on_finish:      Callable[[], None] | None = None,
    ):
        self.macro          = macro
        self.on_log         = on_log         or (lambda msg, lvl: None)
        self.on_webhook     = on_webhook     or (lambda ev,  d:   None)
        self.on_macro_start = on_macro_start or (lambda mid:      None)
        self.on_macro_stop  = on_macro_stop  or (lambda mid:      None)
        self.on_finish      = on_finish      or (lambda:          None)
        self._done          = False   # True une fois le nettoyage de _run terminé
        self._self_stopped  = False   # arrêt demandé par l'action stop_self

        self._stop       = threading.Event()
        self._thread: threading.Thread | None = None
        self._paused     = False
        self._pause_lock = threading.Event()
        self._pause_lock.set()

        # Couches configurables
        self._target_hwnd           = macro.get('target_hwnd',           None)
        self._stop_conditions       = macro.get('stop_conditions',       [])
        self._start_guard           = macro.get('start_guard',           [])
        self._start_guard_timeout_s = float(macro.get('start_guard_timeout_s', 0))
        self._max_iterations        = int(macro.get('max_iterations',    0))
        self._timeout_s             = float(macro.get('timeout_s',       0))
        self._pre_stop_actions      = macro.get('pre_stop_actions',      [])
        self._humanize              = bool(macro.get('humanize',         False))
        self._humanize_factor       = float(macro.get('humanize_factor', 0.12))
        self._kill_switch           = macro.get('kill_switch',           {})
        self._ks_hook: object | None = None

    # ── Cycle de vie public ────────────────────────────────────────────────────
    def start(self):
        self._stop.clear()
        self._done = False
        self._self_stopped = False
        self._paused = False
        self._pause_lock.set()
        # Hook enregistré AVANT le thread : une macro très courte pourrait
        # sinon finir (et désenregistrer) avant l'enregistrement → fuite.
        ks = self._kill_switch
        if ks.get('enabled') and ks.get('key'):
            self._register_kill_switch(ks['key'].strip())
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _register_kill_switch(self, key: str) -> None:
        import keyboard as _kb
        try:
            _kb.parse_hotkey(key)  # validate before registering
            self._ks_hook = _kb.add_hotkey(key, self._on_kill_switch_triggered, suppress=False)
            self._log(f'Kill switch [{key}] enregistré.', 'INFO')
        except Exception as e:
            self._log(f'Kill switch clé invalide [{key}] : {e}', 'WARNING')

    def _on_kill_switch_triggered(self) -> None:
        if not self._stop.is_set():
            key = self._kill_switch.get('key', '')
            self._log(f'Kill switch [{key}] activé — arrêt forcé.', 'WARNING')
            self.stop()

    def _unregister_kill_switch(self) -> None:
        """Idempotent — appelé par stop() ET en fin de _run (arrêts naturels)."""
        hook, self._ks_hook = self._ks_hook, None
        if hook is not None:
            try:
                import keyboard as _kb
                _kb.remove_hotkey(hook)
            except Exception:
                pass

    def stop(self):
        self._stop.set()
        self._pause_lock.set()   # débloquer un éventuel pause.wait()
        self._unregister_kill_switch()
        # On garde self._thread : is_running() reste True tant que le thread
        # (daemon, pas de join bloquant) n'a pas fini son nettoyage.

    def pause(self):
        self._paused = True
        self._pause_lock.clear()
        self._log('Macro en pause.', 'INFO')

    def resume(self):
        self._paused = False
        self._pause_lock.set()
        self._log('Macro reprise.', 'INFO')

    def is_running(self) -> bool:
        return (self._thread is not None and self._thread.is_alive()
                and not self._done)

    def _stop_self(self):
        self._self_stopped = True
        self.stop()

    def get_stats(self) -> dict | None:
        return state.stats_get(self.macro.get('name', ''))

    # ── Contexte passé aux actions ─────────────────────────────────────────────
    def _build_ctx(self) -> dict:
        """
        Dict transmis à chaque exec_action pour permettre aux actions
        de communiquer avec le moteur (macro_start/stop, webhook, stop_self).
        """
        return {
            'on_macro_start':   self.on_macro_start,
            'on_macro_stop':    self.on_macro_stop,
            'on_webhook':       self.on_webhook,
            'on_log':           self._log,
            'stop_self':        self._stop_self,
            '_stop':            self._stop,        # pour repeat()
            '_pause_lock':      self._pause_lock,  # pour repeat()
            '_humanize':        self._humanize,
            '_humanize_factor': self._humanize_factor,
        }

    # ── Boucle principale ──────────────────────────────────────────────────────
    def _run(self):
        name = self.macro.get('name', 'unnamed')
        me   = threading.current_thread()
        with _active_lock:
            prev = _active_by_name.get(name)
            _active_by_name[name] = me
        try:
            # Instance précédente du même nom encore en arrêt → on attend.
            if prev is not None and prev is not me and prev.is_alive():
                self._log('Attente de la fin de l\'instance précédente...', 'INFO')
                while prev.is_alive() and not self._stop.is_set():
                    prev.join(timeout=0.1)
            if not self._stop.is_set():
                self._run_loop()
        finally:
            # Nettoyage garanti, quelle que soit la raison de fin (boucle finie,
            # stop manuel, stop_condition, timeout, max_iterations, exception).
            self._unregister_kill_switch()
            try:
                from .actions import release_all_held_keys
                release_all_held_keys(owner=threading.get_ident())
            except Exception:
                pass
            try:
                from .screen_reader import release_thread_sct
                release_thread_sct()
            except Exception:
                pass
            with _active_lock:
                if _active_by_name.get(name) is me:
                    del _active_by_name[name]
            # Fin naturelle ou manuelle : is_running() devient False AVANT le
            # callback pour que le statut poussé ne liste plus cette macro.
            self._done = True
            try:
                self.on_finish()
            except Exception:
                pass

    def _run_loop(self):
        macro      = self.macro
        name       = macro.get('name', 'unnamed')
        loop       = macro.get('loop', True)
        loop_delay = float(macro.get('loop_delay', 0.1))
        rules      = macro.get('rules', [])
        ctx        = self._build_ctx()

        display_name, event_prefix = _SYNTHETIC_MACRO_EVENTS.get(name, (name, None))
        start_event = f'{event_prefix}_start' if event_prefix else 'macro_start'
        stop_event  = f'{event_prefix}_stop'  if event_prefix else 'macro_stop'

        state.stats_init(name)
        self._log(
            f'Macro "{name}" démarrée '
            f'({len(rules)} règles'
            + (f', humanize={self._humanize_factor:.0%}' if self._humanize else '')
            + (f', timeout={self._timeout_s:.0f}s'      if self._timeout_s   else '')
            + (f', max={self._max_iterations} iter'     if self._max_iterations else '')
            + ')',
            'INFO'
        )
        self.on_webhook(start_event, {'name': display_name})

        start_time       = time.time()
        iteration        = 0
        _guard_wait_start = time.time()
        stop_reason      = 'other'   # manual | condition | timeout | max_iterations | other

        while not self._stop.is_set():
            if not self._pause_lock.wait(timeout=0.5):
                continue  # timeout → re-check stop, ne bloque pas indéfiniment
            if self._stop.is_set():
                break

            # NB : stop_conditions / timeout / max_iterations sont évalués AVANT
            # start_guard et la fenêtre cible — sinon un guard jamais satisfait
            # (ex. FiveM crashé) faisait tourner la macro indéfiniment.

            # ── Conditions d'arrêt automatique ──────────────────────────────
            if self._stop_conditions:
                triggered_stop = None
                for sc in self._stop_conditions:
                    try:
                        if eval_condition(sc):
                            triggered_stop = sc
                            break
                    except Exception as e:
                        self._log(f'Erreur stop_condition : {e}', 'WARNING')
                if triggered_stop:
                    self._log(
                        f'stop_condition déclenchée [{triggered_stop.get("type","")}] — arrêt auto.',
                        'INFO'
                    )
                    self.on_webhook('macro_auto_stop', {
                        'name':      name,
                        'reason':    'stop_condition',
                        'condition': triggered_stop,
                    })
                    stop_reason = 'condition'
                    break

            # ── Timeout global ──────────────────────────────────────────────
            elapsed = time.time() - start_time
            if self._timeout_s > 0 and elapsed >= self._timeout_s:
                self._log(f'Timeout {self._timeout_s:.0f}s atteint — arrêt auto.', 'INFO')
                self.on_webhook('macro_auto_stop', {
                    'name':    name,
                    'reason':  'timeout',
                    'elapsed': round(elapsed, 1),
                })
                stop_reason = 'timeout'
                break

            # ── Max itérations ──────────────────────────────────────────────
            if self._max_iterations > 0 and iteration >= self._max_iterations:
                self._log(
                    f'Max itérations {self._max_iterations} atteint — arrêt auto.', 'INFO'
                )
                self.on_webhook('macro_auto_stop', {
                    'name':      name,
                    'reason':    'max_iterations',
                    'iteration': iteration,
                })
                stop_reason = 'max_iterations'
                break

            # ── Garde de démarrage ──────────────────────────────────────────
            if self._start_guard:
                if not all(eval_condition(c) for c in self._start_guard):
                    if self._start_guard_timeout_s > 0:
                        if time.time() - _guard_wait_start >= self._start_guard_timeout_s:
                            self._log(
                                f'start_guard timeout ({self._start_guard_timeout_s:.0f}s) — arrêt.',
                                'WARNING'
                            )
                            stop_reason = 'condition'
                            break
                    self._stop.wait(timeout=loop_delay)
                    continue
                _guard_wait_start = time.time()  # reset timer dès que guard passe

            # ── Fenêtre cible ───────────────────────────────────────────────
            if self._target_hwnd:
                try:
                    if not is_window_focused(int(self._target_hwnd)):
                        self._stop.wait(timeout=loop_delay)
                        continue
                except Exception as e:
                    self._log(f'Erreur window scope : {e}', 'WARNING')

            iteration += 1
            state.stats_iteration(name)

            # ── Évaluation des règles ───────────────────────────────────────
            for rule in rules:
                if self._stop.is_set():
                    break
                if not rule.get('enabled', True):
                    continue

                try:
                    triggered = self._eval_rule(rule)
                except Exception as e:
                    self._log(
                        f'  [{rule.get("label","?")}] erreur condition : {e}', 'WARNING'
                    )
                    state.stats_error(name)
                    continue

                if triggered:
                    label = rule.get('label', '?')
                    self._log(f'  [{label}] déclenchée', 'DEBUG')
                    state.stats_rule_triggered(name, label)
                    self.on_webhook('rule_triggered', {'macro': name, 'rule': label})

                    try:
                        self._exec_actions(rule.get('actions', []), ctx)
                    except Exception as e:
                        self._log(f'  [{label}] erreur action : {e}', 'WARNING')
                        state.stats_error(name)

                    if rule.get('stop_on_match', False):
                        break

            if not loop:
                break

            self._stop.wait(timeout=loop_delay)

        # Arrêt demandé de l'extérieur (stop(), F12, stop_self) sans cause auto → manuel
        if stop_reason == 'other' and self._stop.is_set():
            stop_reason = 'condition' if self._self_stopped else 'manual'

        # ── Actions de pré-arrêt ───────────────────────────────────────────
        if self._pre_stop_actions:
            self._log('Exécution des actions pre_stop...', 'DEBUG')
            try:
                self._exec_actions(self._pre_stop_actions, ctx, ignore_stop=True)
            except Exception as e:
                self._log(f'Erreur pre_stop_actions : {e}', 'WARNING')

        elapsed = round(time.time() - start_time, 1)
        stats   = state.stats_get(name) or {}
        self._log(
            f'Macro "{name}" terminée — {iteration} itération(s) en {elapsed}s, '
            f'{stats.get("errors", 0)} erreur(s).',
            'INFO'
        )
        self.on_webhook(stop_event, {
            'name':       display_name,
            'iterations': iteration,
            'elapsed_s':  elapsed,
            'errors':     stats.get('errors', 0),
        })
        state.history_append({
            'name':       display_name,
            'started_at': start_time,
            'ended_at':   time.time(),
            'iterations': iteration,
            'elapsed_s':  elapsed,
            'errors':     stats.get('errors', 0),
            'rules_triggered': stats.get('rules_triggered', {}),
            'stop_reason': stop_reason,
        })

    # ── Helpers ────────────────────────────────────────────────────────────────
    def _eval_rule(self, rule: dict) -> bool:
        conditions = rule.get('conditions', [])
        if not conditions:
            return True
        mode    = rule.get('condition_mode', 'all')
        results = [eval_condition(c) for c in conditions]
        return any(results) if mode == 'any' else all(results)

    def _exec_actions(self, actions: list[dict], ctx: dict, ignore_stop: bool = False) -> None:
        # ignore_stop=True is for pre_stop_actions only: stop() sets
        # self._stop BEFORE the post-loop cleanup that runs pre_stop_actions,
        # so the normal `if self._stop.is_set(): return` guard used to bail
        # out before a single pre-stop action ran on every manual/emergency
        # stop (F12, macro_stop, kill-switch) — the one case a "cleanup on
        # stop" feature exists for. Auto-stop paths (stop_conditions/
        # timeout/max_iterations) never set _stop, so they were unaffected.
        for action in actions:
            if not ignore_stop and self._stop.is_set():
                return
            # Pause : on attend (re-check stop toutes les 0.5s) puis on exécute
            # CETTE action — avant, `continue` sautait à la suivante et la fin
            # de la règle était perdue après une reprise F11.
            while not self._pause_lock.wait(timeout=0.5):
                if not ignore_stop and self._stop.is_set():
                    return
            if not ignore_stop and self._stop.is_set():
                return
            exec_action(action, ctx)

    def _log(self, msg: str, level: str = 'INFO') -> None:
        self.on_log(msg, level)
        getattr(logger, level.lower(), logger.info)(msg)
