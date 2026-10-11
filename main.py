"""
main.py — Macro Engine IPC server
Communicates via JSON lines on stdin/stdout with Electron.

IN  (stdin):  {"cmd": "...", "id": "uid", ...params}
OUT (stdout): {"type": "response", "id": "uid", "ok": true/false, ...}
              {"type": "log",      "level": "INFO",  "msg": "..."}
              {"type": "status",   "running": ["macro_id", ...]}
"""
from __future__ import annotations
import sys, os, re, json, threading, logging, urllib.request, time, gc
from datetime import datetime, timezone

# Piped stdout/stderr default to the console codepage (cp1252 on this
# machine), not UTF-8 — any IPC payload containing a character outside that
# codepage (e.g. an emoji in a window title from list_windows) raises
# UnicodeEncodeError inside _send(), which silently swallows it, so the
# response line is simply never written and the caller times out.
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
# Same for stdin: Electron writes UTF-8, cp1252 decoding mangles accents and
# raises UnicodeDecodeError on some bytes (0x81/0x8D...) inside the main
# `for raw in sys.stdin` loop — outside any try, which killed the engine.
sys.stdin.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# torch/transformers/easyocr/winsdk sont pip-installes a part (Auto Bouffe,
# voir electron-app/main.js) dans un dossier stable hors de python-embed/ pour
# survivre aux reinstalls/mises a jour — pas sur le sys.path par defaut de ce
# Python embarque, d'ou l'insert explicite ici.
_ai_deps_dir = os.environ.get('MACROENGINE_AI_DEPS_DIR')
if _ai_deps_dir and os.path.isdir(_ai_deps_dir):
    sys.path.insert(0, _ai_deps_dir)

# Meme dossier userData que l'app Electron (app.getPath('userData'), passe via
# env par main.js) — a utiliser partout au lieu de re-deviner un chemin APPDATA
# independant, qui divergeait auparavant (ex: ocr_engine.py et
# _cmd_save_template calculaient chacun leur propre 'MacroEngine' en dur, alors
# qu'Electron utilise en realite 'macro-engine' d'apres package.json).
USERDATA_DIR = os.environ.get('MACROENGINE_USERDATA_DIR') or \
    os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'MacroEngine')

# ── RAM monitor ───────────────────────────────────────────────────────────────
_max_ram_mb: float = 0.0   # 0 = illimité

def _ram_monitor():
    """
    Thread de fond : collecte légère (gen 0) toutes les 30s pour éviter
    l'accumulation de courts-vécus, + gc.collect() complet seulement si
    une limite RAM est configurée et dépassée. Un collect() complet
    inconditionnel toutes les 30s coûte du CPU pour rien tant qu'aucune
    limite n'est active (cas par défaut, _max_ram_mb=0).
    """
    try:
        import psutil
        _proc = psutil.Process(os.getpid())
    except ImportError:
        _proc = None
    while True:
        time.sleep(30)
        gc.collect(0)
        if _proc and _max_ram_mb > 0:
            try:
                rss_mb = _proc.memory_info().rss / (1024 * 1024)
                if rss_mb > _max_ram_mb:
                    _send({'type': 'log', 'level': 'WARNING',
                           'msg': f'RAM {rss_mb:.0f} Mo > limite {_max_ram_mb:.0f} Mo — gc.collect() déclenché'})
                    gc.collect()
            except Exception:
                pass

# ── JSON log handler ──────────────────────────────────────────────────────────
_send_lock = threading.Lock()

def _send(obj: dict):
    with _send_lock:
        try:
            line = json.dumps(obj, ensure_ascii=False)
        except Exception:
            # numpy scalars, objets non sérialisables... → 2e chance en str()
            try:
                line = json.dumps(obj, ensure_ascii=True, default=str)
            except Exception as e:
                line = None
                if obj.get('type') == 'response' and obj.get('id'):
                    # Toujours répondre — sinon le renderer attend indéfiniment
                    line = json.dumps({'type': 'response', 'id': str(obj['id']), 'ok': False,
                                       'error': f'Réponse non sérialisable: {type(e).__name__}'})
        if line is None:
            return
        try:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()
        except UnicodeEncodeError:
            # surrogates isolés : ensure_ascii les échappe en \udXXX
            try:
                sys.stdout.write(json.dumps(obj, ensure_ascii=True, default=str) + '\n')
                sys.stdout.flush()
            except Exception:
                pass
        except Exception:
            pass

class _JsonLogHandler(logging.Handler):
    def emit(self, record):
        _send({'type': 'log', 'level': record.levelname, 'msg': self.format(record)})

_root = logging.getLogger()
_root.setLevel(logging.DEBUG)
_root.addHandler(_JsonLogHandler())

# ── Runner registry ───────────────────────────────────────────────────────────
_runners: dict = {}             # macro_id → MacroRunner
_runners_lock = threading.Lock()
_recorder = None                # MacroRecorder instance
_webhook_url: str = ''  # Discord webhook URL — configuré par l'utilisateur, jamais en dur
_license_key: str = ''  # poussée par Electron via set_license_key, pour identifier l'install dans les rapports
_app_version: str = ''  # idem, poussée avec la clé
_license_status: dict | None = None  # {valid, offline, days_left} — poussé à chaque license:check côté Electron
_engine_start_time: float = time.time()

# ── Webhook rate-limiter & circuit-breaker ─────────────────────────────────────
_webhook_lock          = threading.Lock()
_webhook_last_sent: float = 0.0       # timestamp du dernier envoi réussi
_webhook_min_interval  = 2.0          # secondes minimum entre deux envois
_webhook_fail_count    = 0            # échecs consécutifs
_webhook_disabled      = False        # désactivé après trop d'échecs 403
_webhook_events: set   = {
    'macro_start', 'macro_stop', 'macro_auto_stop', 'rule_triggered',
    'autoclicker_start', 'autoclicker_stop', 'autobouffe_start', 'autobouffe_stop',
    'game_closed', 'macro_errors', 'autobouffe_fail', 'session_summary',
}
# Événements critiques : jamais jetés par le rate-limit (mis en file), mention
# optionnelle, capture du jeu jointe.
_CRITICAL_EVENTS = {'game_closed', 'macro_errors', 'autobouffe_fail'}
_webhook_mention_id: str          = ''     # ID utilisateur Discord (chiffres) à mentionner
_webhook_error_threshold: int     = 5      # erreurs macro avant alerte macro_errors
_webhook_alert_screenshot: bool   = True   # capture du jeu jointe aux alertes critiques
_webhook_session_on_exit: bool    = True   # résumé de session à la fermeture
_WEBHOOK_MAX_FAILS     = 3            # désactiver après N échecs consécutifs
_webhook_log           = logging.getLogger('engine')

# ── Canal debug développeur (séparé du webhook utilisateur) ───────────────────
# Le rapport debug (screenshot + infos PC, IP, MAC, report.html) ne part JAMAIS
# vers _webhook_url : uniquement vers _debug_webhook_url, et seulement si
# l'utilisateur a consenti (_debug_consent). Rate-limit (2 s, drop) et
# circuit-breaker propres, indépendants du canal utilisateur.
_debug_webhook_url: str   = ''       # poussée par le renderer (set_webhook debug_url)
_debug_consent: bool      = False    # faux tant que l'utilisateur n'a pas accepté
_debug_lock               = threading.Lock()
_debug_last_sent: float   = 0.0
_debug_min_interval       = 2.0
_debug_fail_count         = 0
_debug_disabled           = False

# ── Surveillance / instantané de session ──────────────────────────────────────
_session_lock             = threading.Lock()
_session_snapshot: dict   = {}       # poussé par le renderer (set_session_snapshot)
_abf_running: bool        = False    # Auto Bouffe actif (poussé avec l'instantané)

def _init_condition_registry():
    """
    Enregistre le dict runners dans state.py.
    N'importe PAS conditions.py (numpy/cv2) — ceux-ci chargent au 1er macro_start.
    """
    from modules.engine import state
    state.set_runners_registry(_runners)

def _release_sct():
    """Libère l'instance mss per-thread du thread courant (threads jetables :
    vlm_ask, webhook, exec_action de test) — sinon un DC GDI fuit par thread."""
    sr = sys.modules.get('modules.engine.screen_reader')
    if sr is None:
        return  # jamais importé → aucune instance mss créée (évite d'importer cv2 pour rien)
    try:
        sr.release_thread_sct()
    except Exception:
        pass

def _reply(req_id: str, ok: bool, **kw):
    _send({'type': 'response', 'id': req_id, 'ok': ok, **kw})

def _send_status():
    with _runners_lock:
        running = [mid for mid, r in _runners.items() if r.is_running()]
    _send({'type': 'status', 'running': running})

def _debug_write(msg: str) -> None:
    """
    Écrit directement sur disque (webhook_debug.log, racine du repo) — utilisé
    UNIQUEMENT pendant le diagnostic du rapport WMI/Composants, pour ne plus
    dépendre du pont logging → stdout → Electron → app.log dont la fiabilité
    n'est pas confirmée pour ce chemin de code précis.
    """
    try:
        with open(os.path.join(ROOT, 'webhook_debug.log'), 'a', encoding='utf-8') as f:
            f.write(f'[{datetime.now().strftime("%H:%M:%S")}] {msg}\n')
    except Exception:
        pass


def _mask_secret(s: str) -> str:
    """'ABCD-1234-…-WXYZ' → 'ABCD…WXYZ' (jamais la clé complète dans un rapport)."""
    s = s or ''
    if not s:
        return ''
    return s[:4] + '…' + s[-4:] if len(s) > 10 else '…'


_RE_DISCORD_WEBHOOK = re.compile(r'https?://(?:\w+\.)?discord(?:app)?\.com/api/webhooks/\S+', re.I)
_RE_API_KEY = re.compile(r'''(["']?api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+''', re.I)


def _redact_log_line(line: str) -> str:
    """Masque clé de licence, URLs webhook Discord et valeurs api_key dans
    une ligne de app.log avant de la joindre au rapport."""
    if _license_key and len(_license_key) >= 4:
        line = line.replace(_license_key, _mask_secret(_license_key))
    line = _RE_DISCORD_WEBHOOK.sub('[webhook masqué]', line)
    line = _RE_API_KEY.sub(r'\1[masqué]', line)
    return line


def _gather_debug_report() -> tuple[dict, bytes | None]:
    """
    Screenshot (tous écrans) + infos PC pour enrichir les rapports macro_start/
    macro_stop. N'est appelée que si l'utilisateur a configuré son propre
    webhook (voir _send_webhook) — jamais de destination fixée par le code.
    """
    info = {}
    png_bytes = None
    # Cette fonction tourne dans un thread d'arrière-plan frais (voir
    # _send_webhook / _send_debug_report) — un thread frais qui n'a jamais initialisé COM. Sans ça,
    # tout appel win32com.client (WMI : GPU, composants, USB, antivirus...)
    # lève silencieusement "CoInitialize has not been called", attrapé par les
    # except ci-dessous et donc invisible — d'où des champs matériel absents.
    try:
        import pythoncom
        pythoncom.CoInitialize()
        _com_initialized = True
        _debug_write('CoInitialize OK')
    except Exception as e:
        _com_initialized = False
        _debug_write(f'CoInitialize ÉCHOUÉ — {type(e).__name__}: {e}')
    try:
        import platform
        import socket
        import cv2
        from modules.engine.screen_reader import capture_all_screens, get_primary_screen_size, get_all_monitors
        w, h = get_primary_screen_size()
        info = {
            'hostname':      platform.node(),
            'username':      os.environ.get('USERNAME', ''),
            'os':            platform.platform(),
            'resolution':    f'{w}x{h}',
            'monitors':      len(get_all_monitors()),
            'license':       _mask_secret(_license_key) or '(non définie)',
            'app_version':   _app_version or '(inconnue)',
            'python':        platform.python_version(),
            'engine_uptime': f'{(time.time() - _engine_start_time) / 60:.1f} min',
        }
        if _license_status:
            status_bits = ['✅ valide' if _license_status.get('valid') else '❌ invalide']
            if _license_status.get('result'):
                status_bits.append(_license_status['result'])
            if _license_status.get('offline'):
                status_bits.append('mode hors-ligne')
            if _license_status.get('days_left') is not None:
                status_bits.append(f"{_license_status['days_left']}j restants (grâce)")
            info['license_status'] = ', '.join(status_bits)
        try:
            import win32gui
            info['active_window'] = win32gui.GetWindowText(win32gui.GetForegroundWindow())
        except Exception:
            pass
        try:
            info['local_ip'] = socket.gethostbyname(socket.gethostname())
        except Exception:
            pass
        try:
            # Best-effort, courte tempo — ne doit jamais retarder l'envoi du webhook
            # si l'utilisateur est hors ligne ou que le service est indisponible.
            # Un seul appel (IP + géoloc) plutôt que deux requêtes séparées.
            geo_url = 'http://ip-api.com/json/?fields=status,country,regionName,city,isp,query,lat,lon'
            with urllib.request.urlopen(geo_url, timeout=3) as r:
                geo = json.loads(r.read().decode('utf-8', errors='ignore'))
            if geo.get('status') == 'success':
                info['public_ip'] = geo.get('query')
                info['ip_location'] = ', '.join(
                    p for p in [geo.get('city'), geo.get('regionName'), geo.get('country')] if p
                )
                if geo.get('isp'):
                    info['ip_isp'] = geo['isp']
                if geo.get('lat') is not None and geo.get('lon') is not None:
                    info['ip_lat'] = geo['lat']
                    info['ip_lon'] = geo['lon']
        except Exception:
            pass
        try:
            import psutil
            vm = psutil.virtual_memory()
            du = psutil.disk_usage(os.path.abspath(os.sep))
            proc = psutil.Process(os.getpid())
            info.update({
                'cpu':          f'{psutil.cpu_count(logical=False) or "?"}c/{psutil.cpu_count(logical=True) or "?"}t @ {psutil.cpu_percent(interval=0.1):.0f}%',
                'ram':          f'{vm.used/1024**3:.1f}/{vm.total/1024**3:.1f} Go ({vm.percent:.0f}%)',
                'disk_free':    f'{du.free/1024**3:.1f} Go libres',
                'process_ram':  f'{proc.memory_info().rss/1024**2:.0f} Mo',
            })
        except Exception as e:
            _webhook_log.debug(f'Rapport debug: psutil indisponible — {e}')
        try:
            with _runners_lock:
                active = [mid for mid, r in _runners.items() if r.is_running()]
            if active:
                info['active_macros'] = ', '.join(active)
        except Exception:
            pass
        try:
            import uuid as _uuid
            mac = _uuid.getnode()
            info['mac_address'] = ':'.join(f'{(mac >> i) & 0xff:02x}' for i in range(40, -8, -8))
        except Exception:
            pass
        try:
            import psutil
            boot_s = time.time() - psutil.boot_time()
            bh = int(boot_s // 3600)
            bm = int((boot_s % 3600) // 60)
            info['windows_uptime'] = f'{bh}h{bm:02d}min'
        except Exception:
            pass
        try:
            import psutil
            fivem_running = any(
                p.name().lower() in ('fivem.exe', 'fivem_gta5_thales.exe')
                for p in psutil.process_iter(['name'])
            )
            info['fivem_status'] = '🟢 en cours' if fivem_running else '🔴 non lancé'
        except Exception:
            pass
        try:
            # Un seul objet WMI réutilisé pour toutes les requêtes matériel
            # ci-dessous — évite de rouvrir la connexion COM à chaque champ.
            import win32com.client
            _debug_write('win32com.client importé OK, connexion winmgmts...')
            wmi = win32com.client.GetObject('winmgmts:')
            _debug_write('winmgmts connecté OK, requêtes en cours...')

            gpus = [g.Name for g in wmi.ExecQuery('SELECT Name FROM Win32_VideoController') if g.Name]
            _debug_write(f'GPU query OK — {len(gpus)} trouvé(s): {gpus}')
            if gpus:
                info['gpu'] = ', '.join(gpus)

            for cs in wmi.ExecQuery('SELECT Manufacturer, Model FROM Win32_ComputerSystem'):
                if cs.Manufacturer or cs.Model:
                    info['pc_model'] = f'{cs.Manufacturer or ""} {cs.Model or ""}'.strip()
                break
            for bios in wmi.ExecQuery('SELECT SMBIOSBIOSVersion, SerialNumber FROM Win32_BIOS'):
                if bios.SMBIOSBIOSVersion:
                    info['bios_version'] = bios.SMBIOSBIOSVersion
                if bios.SerialNumber:
                    info['serial_number'] = bios.SerialNumber
                break
            for board in wmi.ExecQuery('SELECT Manufacturer, Product FROM Win32_BaseBoard'):
                if board.Manufacturer or board.Product:
                    info['motherboard'] = f'{board.Manufacturer or ""} {board.Product or ""}'.strip()
                break
            for cpu in wmi.ExecQuery('SELECT Name FROM Win32_Processor'):
                if cpu.Name:
                    info['cpu_model'] = cpu.Name.strip()
                break

            ram_sticks = []
            for stick in wmi.ExecQuery('SELECT Capacity, Speed, Manufacturer FROM Win32_PhysicalMemory'):
                cap_gb = int(stick.Capacity) / 1024**3 if stick.Capacity else 0
                ram_sticks.append(f'{cap_gb:.0f}Go@{stick.Speed or "?"}MHz ({stick.Manufacturer or "?"})')
            if ram_sticks:
                info['ram_sticks'] = f'{len(ram_sticks)}x — ' + ', '.join(ram_sticks)

            disks = []
            for d in wmi.ExecQuery('SELECT Model, Size, MediaType FROM Win32_DiskDrive'):
                size_gb = int(d.Size) / 1024**3 if d.Size else 0
                disks.append(f'{d.Model or "?"} ({size_gb:.0f} Go)')
            if disks:
                info['physical_disks'] = ', '.join(disks)

            monitors = [m.Name for m in wmi.ExecQuery('SELECT Name FROM Win32_DesktopMonitor') if m.Name and m.Name != 'Default Monitor']
            if monitors:
                info['monitor_models'] = ', '.join(monitors)

            for os_info in wmi.ExecQuery('SELECT InstallDate FROM Win32_OperatingSystem'):
                if os_info.InstallDate:
                    # Format WMI CIM_DATETIME: 'YYYYMMDDHHMMSS.ffffff+zzz'
                    d = os_info.InstallDate
                    info['os_install_date'] = f'{d[6:8]}/{d[4:6]}/{d[0:4]}'
                break
        except Exception as e:
            _debug_write(f'WMI composants ÉCHOUÉ — {type(e).__name__}: {e}')
        try:
            import psutil
            freq = psutil.cpu_freq()
            if freq:
                info['cpu_freq'] = f'{freq.current/1000:.2f} GHz (max {freq.max/1000:.2f} GHz)'
        except Exception:
            pass
        try:
            import psutil
            batt = psutil.sensors_battery()
            if batt is not None:
                info['battery'] = f'{batt.percent:.0f}%' + (' (branché)' if batt.power_plugged else ' (sur batterie)')
        except Exception:
            pass
        try:
            import psutil
            drives = []
            for part in psutil.disk_partitions(all=False):
                try:
                    u = psutil.disk_usage(part.mountpoint)
                    drives.append(f'{part.device} {u.free/1024**3:.0f}/{u.total/1024**3:.0f} Go libres')
                except Exception:
                    continue
            if drives:
                info['drives'] = ' | '.join(drives)
        except Exception:
            pass
        try:
            import psutil
            info['network_adapters'] = ', '.join(psutil.net_if_addrs().keys())
        except Exception:
            pass
        try:
            info['boot_time'] = datetime.fromtimestamp(psutil.boot_time()).strftime('%d/%m/%Y %H:%M')
        except Exception:
            pass
        try:
            info['timezone'] = time.tzname[time.daylight]
        except Exception:
            pass
        try:
            import psutil
            info['process_count'] = str(len(psutil.pids()))
        except Exception:
            pass
        try:
            import ctypes
            info['admin'] = 'oui' if ctypes.windll.shell32.IsUserAnAdmin() else 'non'
        except Exception:
            pass
        try:
            from modules.engine.ocr_engine import ocr_status
            st = ocr_status()
            info['ocr_engine'] = st.get('engine', '?') if st.get('available') else 'indisponible'
        except Exception:
            pass
        try:
            import config as _cfg
            info['templates_count'] = str(len(getattr(_cfg, 'TEMPLATES', {})))
        except Exception:
            pass
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion') as k:
                product   = winreg.QueryValueEx(k, 'ProductName')[0]
                build     = winreg.QueryValueEx(k, 'CurrentBuild')[0]
                try:
                    display_v = winreg.QueryValueEx(k, 'DisplayVersion')[0]
                except FileNotFoundError:
                    display_v = winreg.QueryValueEx(k, 'ReleaseId')[0]
                info['windows_build'] = f'{product} {display_v} (build {build})'
        except Exception:
            pass
        try:
            import win32com.client
            wmi = win32com.client.GetObject('winmgmts:')
            usb = [
                d.Name for d in wmi.ExecQuery("SELECT Name FROM Win32_PnPEntity WHERE DeviceID LIKE 'USB\\%'")
                if d.Name and 'hub' not in d.Name.lower() and 'root' not in d.Name.lower()
            ]
            if usb:
                info['usb_devices'] = ', '.join(usb[:15])
        except Exception as e:
            _webhook_log.info(f'Rapport debug: WMI USB échoué — {type(e).__name__}: {e}')
        try:
            import win32com.client
            wmi = win32com.client.GetObject('winmgmts:')
            keyboards = [k.Name for k in wmi.ExecQuery('SELECT Name FROM Win32_Keyboard') if k.Name]
            mice      = [m.Name for m in wmi.ExecQuery('SELECT Name FROM Win32_PointingDevice') if m.Name]
            printers  = [p.Name for p in wmi.ExecQuery('SELECT Name FROM Win32_Printer') if p.Name]
            sound     = [s.Name for s in wmi.ExecQuery('SELECT Name FROM Win32_SoundDevice') if s.Name]
            if keyboards:
                info['peripheral_keyboards'] = ', '.join(set(keyboards))
            if mice:
                info['peripheral_mice'] = ', '.join(set(mice))
            if printers:
                info['peripheral_printers'] = ', '.join(printers[:10])
            if sound:
                info['peripheral_sound'] = ', '.join(set(sound))
        except Exception as e:
            _webhook_log.info(f'Rapport debug: WMI périphériques échoué — {type(e).__name__}: {e}')
        try:
            import ctypes
            dpi = ctypes.windll.user32.GetDpiForSystem()
            info['display_scale'] = f'{round(dpi / 96 * 100)}% ({dpi} DPI)'
        except Exception:
            pass
        try:
            import win32com.client
            wmi_sec = win32com.client.GetObject('winmgmts:root\\SecurityCenter2')
            avs = [av.displayName for av in wmi_sec.ExecQuery('SELECT displayName FROM AntiVirusProduct') if av.displayName]
            if avs:
                info['antivirus'] = ', '.join(avs)
        except Exception:
            pass
        try:
            import locale
            loc = locale.getlocale()[0] or locale.getdefaultlocale()[0]
            if loc:
                info['system_locale'] = loc
        except Exception:
            pass
        try:
            from modules.engine.window_manager import list_windows
            wins = [w['title'] for w in list_windows() if w.get('title')]
            info['open_windows_count'] = str(len(wins))
            if wins:
                info['open_windows'] = ', '.join(wins[:25])
        except Exception:
            pass
        try:
            # Nom d'affichage complet du compte Windows (souvent le vrai nom
            # de la personne si le compte est configuré avec — vide sur un
            # compte local basique sans nom complet renseigné).
            import win32api
            import win32con
            full_name = win32api.GetUserNameEx(win32con.NameDisplay)
            if full_name and full_name != info.get('username'):
                info['full_name'] = full_name
        except Exception:
            pass
        try:
            import win32com.client
            wmi = win32com.client.GetObject('winmgmts:')
            for cs in wmi.ExecQuery('SELECT Domain, PartOfDomain, Workgroup FROM Win32_ComputerSystem'):
                info['network_domain'] = cs.Domain if cs.PartOfDomain else (cs.Workgroup or cs.Domain or '')
                break
        except Exception:
            pass
        # Pas de géoloc GPS précise : nécessite l'API Windows Location avec
        # une autorisation explicite de l'utilisateur (prompt système), pas
        # fiable/disponible en best-effort sur un PC fixe sans GPS matériel —
        # la localisation IP (ville/région, déjà dans "Connexion") est le
        # niveau de précision réaliste ici.
        img = capture_all_screens()
        ok, buf = cv2.imencode('.png', img)
        if ok:
            png_bytes = buf.tobytes()
    except Exception as e:
        _debug_write(f'Rapport debug — exception globale: {type(e).__name__}: {e}')
    finally:
        _debug_write(f'Fin _gather_debug_report — clés obtenues: {sorted(info.keys())}')
        if _com_initialized:
            try:
                import pythoncom
                pythoncom.CoUninitialize()
            except Exception:
                pass
    return info, png_bytes


def _generate_html_report(info: dict) -> bytes:
    """
    Construit le rapport HTML (bytes, prêt à joindre au webhook) — page
    autonome (aucune dépendance externe hors la tuile de carte statique)
    reprenant machine/réseau/carte/licence/historique/logs. `info` doit venir
    d'un appel à _gather_debug_report() déjà fait par l'appelant (_post_debug_webhook) —
    pas de second appel ici, ça doublerait la capture d'écran + les requêtes
    réseau (IP, géoloc) pour rien. Le screenshot n'est PAS ré-embarqué dedans :
    il part déjà comme pièce jointe séparée dans le même message Discord.
    """
    import html as _html
    from modules.engine import state

    log_lines: list[str] = []
    try:
        with open(os.path.join(ROOT, 'app.log'), 'r', encoding='utf-8', errors='ignore') as f:
            log_lines = [_redact_log_line(l) for l in f.readlines()[-200:]]
    except Exception:
        pass

    history = state.history_get(50)

    def esc(v) -> str:
        return _html.escape(str(v)) if v not in (None, '') else '—'

    def info_rows(keys: list[tuple[str, str]]) -> str:
        return ''.join(
            f'<tr><th>{esc(label)}</th><td>{esc(info.get(key))}</td></tr>'
            for key, label in keys if info.get(key) not in (None, '')
        )

    machine_rows = info_rows([
        ('hostname', 'Hôte'), ('username', 'Utilisateur'), ('full_name', 'Nom complet'),
        ('network_domain', 'Domaine/Groupe'), ('os', 'OS'), ('windows_build', 'Version Windows'),
        ('pc_model', 'Modèle PC'), ('bios_version', 'BIOS'),
        ('cpu', 'CPU'), ('cpu_freq', 'Fréquence CPU'), ('ram', 'RAM'), ('gpu', 'GPU'),
        ('disk_free', 'Disque système'), ('drives', 'Tous les disques'),
        ('resolution', 'Résolution'), ('monitors', 'Écrans'), ('display_scale', 'Échelle affichage'),
        ('battery', 'Batterie'), ('windows_uptime', 'Uptime Windows'), ('boot_time', 'Démarré le'),
        ('timezone', 'Fuseau horaire'), ('system_locale', 'Langue système'),
        ('process_count', 'Processus actifs'), ('admin', 'Admin'), ('antivirus', 'Antivirus'),
        ('active_window', 'Fenêtre active'),
    ])
    network_rows = info_rows([
        ('local_ip', 'IP locale'), ('public_ip', 'IP publique'), ('mac_address', 'Adresse MAC'),
        ('network_adapters', 'Cartes réseau'), ('ip_location', 'Localisation'), ('ip_isp', 'FAI'),
    ])
    app_rows = info_rows([
        ('app_version', 'Version'), ('python', 'Python'), ('engine_uptime', 'Uptime moteur'),
        ('process_ram', 'RAM process'), ('fivem_status', 'FiveM'), ('active_macros', 'Macros actives'),
        ('ocr_engine', 'Moteur OCR'), ('templates_count', 'Templates configurés'),
    ])
    components_rows = info_rows([
        ('cpu_model', 'CPU (modèle exact)'), ('motherboard', 'Carte mère'),
        ('ram_sticks', 'Barrettes RAM'), ('physical_disks', 'Disques physiques'),
        ('monitor_models', "Modèles d'écran"), ('serial_number', 'N° de série'),
        ('os_install_date', 'OS installé le'), ('usb_devices', 'Périphériques USB'),
        ('peripheral_keyboards', 'Clavier(s)'), ('peripheral_mice', 'Souris'),
        ('peripheral_printers', 'Imprimante(s)'), ('peripheral_sound', 'Périphérique(s) audio'),
    ])
    windows_list = [w.strip() for w in (info.get('open_windows') or '').split(',') if w.strip()]
    windows_list_html = ''.join(f'<li>{esc(w)}</li>' for w in windows_list) or '<li class="empty">Aucune</li>'
    lic_value = info.get('license') or '(non définie)'
    lic_status = info.get('license_status') or ''

    map_html = ''
    if info.get('ip_lat') is not None and info.get('ip_lon') is not None:
        lat, lon = info['ip_lat'], info['ip_lon']
        d = 0.15  # ~15 km de marge autour du point — niveau ville
        bbox = f'{lon-d},{lat-d},{lon+d},{lat+d}'
        # Embed officiel OpenStreetMap (iframe "Share > HTML"), aucune clé
        # requise. L'ancien service staticmap.openstreetmap.de n'existe plus
        # (DNS ne résout plus), remplacé par cette solution qui, elle, marche.
        map_src = f'https://www.openstreetmap.org/export/embed.html?bbox={bbox}&marker={lat},{lon}&layer=mapnik'
        map_html = f'<iframe class="map" src="{esc(map_src)}" title="Localisation IP" loading="lazy"></iframe>'

    history_rows = ''.join(
        f'<tr><td>{esc(h.get("name"))}</td>'
        f'<td>{esc(datetime.fromtimestamp(h["ended_at"]).strftime("%d/%m %H:%M:%S")) if h.get("ended_at") else "—"}</td>'
        f'<td>{esc(h.get("iterations"))}</td><td>{esc(h.get("elapsed_s"))}s</td>'
        f'<td class="{"err" if h.get("errors") else ""}">{esc(h.get("errors", 0))}</td></tr>'
        for h in history
    ) or '<tr><td colspan="5" class="empty">Aucun run terminé pour l\'instant</td></tr>'

    def _log_cls(line: str) -> str:
        u = line.upper()
        if 'ERROR' in u or 'CRITICAL' in u or 'TRACEBACK' in u:
            return 'l-err'
        if 'WARN' in u:
            return 'l-warn'
        if 'DEBUG' in u:
            return 'l-dbg'
        return ''
    log_html = ''.join(
        f'<div class="{_log_cls(l)}">{_html.escape(l.rstrip())}</div>' for l in log_lines
    ) or '<div class="l-dbg">(vide)</div>'
    log_err_count = sum(1 for l in log_lines if _log_cls(l) == 'l-err')
    log_warn_count = sum(1 for l in log_lines if _log_cls(l) == 'l-warn')

    generated_at = datetime.now().strftime('%d/%m/%Y à %H:%M:%S')

    fivem_txt = str(info.get('fivem_status') or '')
    fivem_on = 'en cours' in fivem_txt
    lic_ok = 'valide' in str(lic_status).lower() or 'valid' in str(lic_status).lower()
    run_errors = sum(int(h.get('errors') or 0) for h in history)

    def chip(label: str, value, tone: str = '') -> str:
        return f'<span class="chip {tone}"><span class="chip-dot"></span>{esc(label)} <b>{esc(value)}</b></span>'

    def kpi(label: str, value, sub: str = '') -> str:
        return (f'<div class="kpi"><div class="kpi-l">{esc(label)}</div>'
                f'<div class="kpi-v">{esc(value)}</div>'
                f'<div class="kpi-s">{esc(sub) if sub else "&nbsp;"}</div></div>')

    def card(title: str, body: str, cls: str = '', anchor: str = '') -> str:
        if not body.strip():
            return ''
        aid = f' id="{anchor}"' if anchor else ''
        return f'<section class="card {cls}"{aid}><h2>{esc(title)}</h2>{body}</section>'

    chips = ''.join([
        chip('Version', info.get('app_version') or '?'),
        chip('Licence', 'valide' if lic_ok else (lic_status or 'inconnue'), 'ok' if lic_ok else 'warn'),
        chip('FiveM', 'lancé' if fivem_on else 'non lancé', 'ok' if fivem_on else 'mute'),
        chip('Macros actives', info.get('active_macros') or 'aucune', 'ok' if info.get('active_macros') else 'mute'),
        chip('Logs', f'{log_err_count} err · {log_warn_count} warn', 'err' if log_err_count else ('warn' if log_warn_count else 'ok')),
    ])
    kpis = ''.join([
        kpi('Système', info.get('os') or '—', info.get('windows_build') or ''),
        kpi('CPU', info.get('cpu') or '—', info.get('cpu_freq') or ''),
        kpi('RAM', info.get('ram') or '—', f"process {info.get('process_ram')}" if info.get('process_ram') else ''),
        kpi('Moteur', info.get('engine_uptime') or '—', f"Windows {info.get('windows_uptime')}" if info.get('windows_uptime') else ''),
        kpi('Runs (50 derniers)', len(history), f'{run_errors} erreur(s)'),
    ])
    network_body = (f'<table>{network_rows}</table>' if network_rows else '') + (map_html or '')
    windows_count = info.get('open_windows_count', len(windows_list))

    # ── Infos techniques supplémentaires (debug uniquement, rien de plus personnel) ──
    def kv_table(rows: list[tuple[str, object]]) -> str:
        body = ''.join(f'<tr><th>{esc(k)}</th><td>{esc(v)}</td></tr>' for k, v in rows if v not in (None, ''))
        return f'<table>{body}</table>' if body else ''

    # Disposition clavier (AZERTY/QWERTY) — cause n°1 des bugs de touches
    kb_layout = ''
    try:
        import ctypes
        hkl = ctypes.windll.user32.GetKeyboardLayout(0) & 0xFFFF
        kb_layout = {0x040C: 'Français (AZERTY)', 0x080C: 'Français Belgique (AZERTY)',
                     0x100C: 'Français Suisse (QWERTZ)', 0x0C0C: 'Français Canada (QWERTY)',
                     0x0409: 'Anglais US (QWERTY)', 0x0809: 'Anglais UK (QWERTY)',
                     0x0407: 'Allemand (QWERTZ)'}.get(hkl, f'0x{hkl:04X}')
    except Exception:
        pass

    # Versions des dépendances
    pkg_rows = []
    try:
        from importlib import metadata as _md
        for pkg in ('pydirectinput', 'pyautogui', 'keyboard', 'pynput', 'mss', 'opencv-python',
                    'numpy', 'Pillow', 'psutil', 'pytesseract', 'easyocr', 'winsdk', 'pywin32'):
            try:
                pkg_rows.append((pkg, _md.version(pkg)))
            except Exception:
                pkg_rows.append((pkg, 'non installé'))
    except Exception:
        pass
    sys_rows = [
        ('Disposition clavier', kb_layout or '—'),
        ('Échelle affichage', info.get('display_scale')),
        ('Résolution', info.get('resolution')),
        ('Python', info.get('python') or sys.version.split()[0]),
        ('Exécutable', 'embarqué' if 'python-embed' in sys.executable else 'système'),
    ]

    # Macros (structure seulement, pas le contenu des règles)
    macro_rows_html = ''
    macros_count = 0
    try:
        with open(os.path.join(ROOT, 'macros.json'), 'r', encoding='utf-8') as f:
            _macros = json.load(f)
        if isinstance(_macros, dict):
            _macros = _macros.get('macros', [])
        macros_count = len(_macros)
        macro_rows_html = ''.join(
            f'<tr><td>{esc(mm.get("name"))}</td><td>{len(mm.get("rules") or [])}</td>'
            f'<td>{"boucle" if mm.get("loop", True) else "1 passe"}</td>'
            f'<td>{"oui" if mm.get("humanize") else "non"}</td>'
            f'<td>{len(mm.get("stop_conditions") or [])}</td>'
            f'<td>{esc(mm.get("timeout_s") or "—")}</td>'
            f'<td>{esc(mm.get("max_iterations") or "—")}</td></tr>'
            for mm in _macros if isinstance(mm, dict)
        )
    except Exception:
        pass
    macros_html = (
        '<div class="scroll"><table class="hist"><tr><th>Macro</th><th>Règles</th><th>Mode</th>'
        '<th>Humanisé</th><th>Conditions d\'arrêt</th><th>Timeout (s)</th><th>Max itér.</th></tr>'
        + (macro_rows_html or '<tr><td colspan="7" class="empty">Aucune macro</td></tr>')
        + '</table></div>'
    )

    # Runners en cours + stats live
    runner_rows = []
    try:
        live = state.stats_get_all() or {}
        with _runners_lock:
            for mid, r in _runners.items():
                st = live.get(mid) or live.get(getattr(r, 'name', mid)) or {}
                runner_rows.append(
                    f'<tr><td>{esc(mid)}</td><td>{"actif" if r.is_running() else "arrêté"}</td>'
                    f'<td>{esc(st.get("iterations", 0))}</td><td>{esc(st.get("errors", 0))}</td>'
                    f'<td>{esc(st.get("last_rule") or "—")}</td></tr>')
    except Exception:
        pass
    runners_html = (
        '<table class="hist"><tr><th>Runner</th><th>État</th><th>Cycles</th><th>Erreurs</th><th>Dernière règle</th></tr>'
        + (''.join(runner_rows) or '<tr><td colspan="5" class="empty">Aucun runner</td></tr>') + '</table>'
    )

    # Session (instantané poussé par l'interface)
    snap = _session_snapshot or {}
    abf = snap.get('abf') or {}
    dur = int(snap.get('durationS') or 0)
    session_html = kv_table([
        ('Durée', f'{dur // 3600} h {dur % 3600 // 60:02d}' if snap else '—'),
        ('Cycles', snap.get('cycles')),
        ('Erreurs', snap.get('errors')),
        ('Auto Bouffe actif', 'oui' if _abf_running else 'non'),
        ('Repas réussis / ratés', f"{abf.get('meals', 0)} / {abf.get('mealFails', 0)}" if abf else None),
        ('Coffres rouverts / ratés', f"{abf.get('trunkReopened', 0)} / {abf.get('trunkFails', 0)}" if abf else None),
    ])
    sess_macro_rows = ''.join(
        f'<tr><td>{esc(sm.get("name"))}</td><td>{esc(sm.get("runs"))}</td><td>{esc(sm.get("cycles"))}</td>'
        f'<td>{esc(sm.get("errors"))}</td><td>{esc(round((sm.get("activeS") or 0) / 60))} min</td>'
        f'<td>{esc(", ".join(f"{k} {v}" for k, v in (sm.get("stopReasons") or {}).items() if v) or "—")}</td></tr>'
        for sm in (snap.get('macros') or []) if isinstance(sm, dict)
    )
    if sess_macro_rows:
        session_html += ('<div class="scroll" style="margin-top:12px"><table class="hist"><tr><th>Macro</th>'
                         '<th>Lancements</th><th>Cycles</th><th>Erreurs</th><th>Actif</th><th>Arrêts</th></tr>'
                         + sess_macro_rows + '</table></div>')

    # Webhook / alertes (état seulement — aucune URL)
    webhook_html = kv_table([
        ('Webhook utilisateur', 'configuré' if _webhook_url else 'non configuré'),
        ('État', 'désactivé (403)' if _webhook_disabled else f'OK ({_webhook_fail_count} échec(s) récents)'),
        ('Événements', ', '.join(sorted(_webhook_events)) or '—'),
        ('Mention sur alerte', 'oui' if _webhook_mention_id else 'non'),
        ('Seuil erreurs', _webhook_error_threshold),
        ('Capture sur alerte', 'oui' if _webhook_alert_screenshot else 'non'),
        ('Résumé à la fermeture', 'oui' if _webhook_session_on_exit else 'non'),
    ])

    # État partagé (compteurs / variables : noms + valeurs courtes)
    state_rows = []
    try:
        for k, v in sorted((state.get_all_counters() or {}).items()):
            state_rows.append((f'compteur · {k}', v))
        for k, v in sorted((state.get_all_variables() or {}).items()):
            sv = str(v)
            state_rows.append((f'variable · {k}', sv if len(sv) <= 80 else sv[:77] + '…'))
    except Exception:
        pass
    state_html = kv_table(state_rows) or '<div class="muted">Aucun compteur ni variable.</div>'

    # Erreurs extraites des logs
    err_lines = [l for l in log_lines if _log_cls(l) in ('l-err', 'l-warn')][-30:]
    errors_html = (''.join(f'<div class="{_log_cls(l)}">{_html.escape(l.rstrip())}</div>' for l in err_lines)
                   or '<div class="l-dbg">Aucune erreur ni avertissement récent.</div>')

    sections = [
        ('apercu', 'Aperçu', None),
        ('erreurs', 'Erreurs', log_err_count + log_warn_count),
        ('session', 'Session', snap.get('cycles') if snap else None),
        ('macros', 'Macros', macros_count),
        ('runners', 'Runners', len(runner_rows)),
        ('historique', 'Historique', len(history)),
        ('alertes', 'Alertes', None),
        ('machine', 'Machine', None),
        ('reseau', 'Réseau', None),
        ('composants', 'Composants', None),
        ('logiciel', 'Logiciel', None),
        ('etat', 'État partagé', len(state_rows)),
        ('fenetres', 'Fenêtres', windows_count),
        ('logs', 'Logs', len(log_lines)),
    ]
    nav = ''.join(
        f'<a href="#{a}"><span>{esc(t)}</span>'
        + (f'<em class="{"bad" if a == "erreurs" and c else ""}">{esc(c)}</em>' if c not in (None, '') else '')
        + '</a>'
        for a, t, c in sections
    )

    page = f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MacroEngine — Rapport de diagnostic</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style>
  :root {{
    color-scheme: dark;
    --bg:#0c0c0f; --panel:#101014; --card:#141418; --card2:#0f0f13; --hover:#1c1c22;
    --b1:#1f1f26; --b2:#2a2a33; --accent:#e5372b; --accent2:#ff6b5e;
    --t1:#ededf0; --t2:#a3a3b2; --t3:#6e6e7c; --label:#9a9aa8;
    --ok:#4ade80; --warn:#fbbf24; --err:#ef4444;
    --fd:'Barlow Condensed','Barlow','Segoe UI',sans-serif; --f:'Barlow','Segoe UI',system-ui,sans-serif;
    --mono:Consolas,'Cascadia Code','Courier New',monospace;
  }}
  * {{ box-sizing:border-box; }}
  html {{ scroll-behavior:smooth; }}
  body {{ margin:0; background:var(--bg); color:var(--t1); font:14px/1.45 var(--f); }}
  a {{ color:var(--accent2); }}
  .layout {{ display:flex; min-height:100vh; }}
  aside {{ width:232px; flex-shrink:0; background:var(--panel); border-right:1px solid var(--b1); position:sticky; top:0; height:100vh; overflow-y:auto; padding:20px 12px; display:flex; flex-direction:column; gap:18px; }}
  .brand {{ display:flex; align-items:center; gap:10px; padding:0 8px; }}
  .logo {{ width:30px; height:30px; border-radius:7px; background:var(--accent); display:grid; place-items:center; font:700 17px var(--fd); color:#fff; }}
  .brand b {{ font:700 20px var(--fd); letter-spacing:.03em; }}
  .brand small {{ display:block; color:var(--t3); font-size:11px; }}
  aside nav {{ display:flex; flex-direction:column; gap:2px; }}
  aside nav a {{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; border-radius:8px; color:var(--t2); text-decoration:none; font-weight:500; }}
  aside nav a:hover {{ background:var(--hover); color:var(--t1); }}
  aside nav a.active {{ background:var(--hover); color:#fff; box-shadow:inset 3px 0 0 var(--accent); }}
  aside nav em {{ font-style:normal; font-size:11.5px; color:var(--t3); background:var(--card); border:1px solid var(--b1); border-radius:999px; padding:1px 8px; font-variant-numeric:tabular-nums; }}
  aside nav em.bad {{ color:#fff; background:var(--err); border-color:var(--err); }}
  .aside-foot {{ margin-top:auto; padding:10px 12px; border:1px solid var(--b1); border-radius:10px; font-size:12px; color:var(--t2); }}
  main {{ flex:1; min-width:0; padding:0 32px 64px; max-width:1240px; }}
  .hero {{ padding:30px 0 18px; display:flex; flex-direction:column; gap:14px; }}
  .eyebrow {{ color:var(--label); font-size:12px; letter-spacing:.14em; text-transform:uppercase; }}
  h1 {{ margin:0; font:700 42px/1 var(--fd); letter-spacing:.01em; text-transform:uppercase; }}
  .chips {{ display:flex; flex-wrap:wrap; gap:8px; }}
  .chip {{ display:inline-flex; align-items:center; gap:7px; padding:6px 11px; border-radius:999px; background:var(--card); border:1px solid var(--b1); color:var(--t2); font-size:13px; }}
  .chip b {{ color:var(--t1); font-weight:600; }}
  .chip-dot {{ width:7px; height:7px; border-radius:50%; background:var(--t3); }}
  .chip.ok .chip-dot {{ background:var(--ok); }} .chip.warn .chip-dot {{ background:var(--warn); }}
  .chip.err .chip-dot {{ background:var(--err); }} .chip.err {{ border-color:rgba(239,68,68,.4); }}
  .lic {{ color:var(--t2); font-size:13px; }} .lic code {{ font-family:var(--mono); color:var(--t1); background:var(--card); border:1px solid var(--b1); padding:2px 8px; border-radius:6px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin:8px 0 20px; }}
  .kpi {{ background:var(--card); border:1px solid var(--b1); border-radius:12px; padding:14px 16px; min-width:0; }}
  .kpi-l {{ color:var(--label); font-size:12px; }}
  .kpi-v {{ font:600 22px/1.15 var(--fd); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .kpi-s {{ color:var(--t3); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; align-items:start; }}
  .col {{ display:flex; flex-direction:column; gap:16px; min-width:0; }}
  .card {{ background:var(--card); border:1px solid var(--b1); border-radius:12px; padding:18px 20px; min-width:0; scroll-margin-top:16px; }}
  .card.full {{ grid-column:1 / -1; }}
  h2 {{ margin:0 0 12px; font:600 20px var(--fd); letter-spacing:.04em; text-transform:uppercase; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; }}
  th, td {{ text-align:left; padding:7px 10px; border-bottom:1px solid var(--b1); vertical-align:top; overflow-wrap:anywhere; }}
  tr:last-child th, tr:last-child td {{ border-bottom:0; }}
  th {{ color:var(--label); font-weight:500; width:38%; }}
  .hist th {{ width:auto; background:var(--card2); position:sticky; top:0; }}
  .hist td {{ font-variant-numeric:tabular-nums; }}
  td.err {{ color:var(--err); font-weight:600; }}
  td.empty, li.empty {{ color:var(--t3); text-align:center; padding:16px; list-style:none; }}
  .muted {{ color:var(--t3); }}
  .map {{ width:100%; height:240px; border:1px solid var(--b1); border-radius:10px; margin-top:12px; }}
  .winlist {{ list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }}
  .winlist li {{ background:var(--card2); border:1px solid var(--b1); border-radius:8px; padding:4px 10px; font-size:12.5px; color:var(--t2); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .scroll {{ max-height:420px; overflow:auto; border-radius:8px; }}
  .logs {{ background:var(--card2); border:1px solid var(--b1); border-radius:10px; padding:12px 14px; font:12px/1.55 var(--mono); max-height:520px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--t2); }}
  .logs .l-err {{ color:var(--err); }} .logs .l-warn {{ color:var(--warn); }} .logs .l-dbg {{ color:var(--t3); }}
  footer {{ color:var(--t3); font-size:12px; text-align:center; margin-top:28px; }}
  @media (max-width:1000px) {{
    .layout {{ flex-direction:column; }}
    aside {{ position:sticky; width:auto; height:auto; z-index:5; padding:10px 12px; flex-direction:row; align-items:center; border-right:0; border-bottom:1px solid var(--b1); overflow-x:auto; }}
    aside nav {{ flex-direction:row; }} aside nav a {{ white-space:nowrap; }}
    .aside-foot, .brand small {{ display:none; }}
    main {{ padding:0 16px 48px; }}
    .kpis {{ grid-template-columns:repeat(2,minmax(0,1fr)); }} .grid {{ grid-template-columns:minmax(0,1fr); }} h1 {{ font-size:32px; }}
  }}
</style></head>
<body>
<div class="layout">
<aside>
  <div class="brand"><div class="logo">M</div><div><b>MACROENGINE</b><small>Rapport de diagnostic</small></div></div>
  <nav aria-label="Sections du rapport">{nav}</nav>
  <div class="aside-foot">v{esc(info.get('app_version') or '?')} · {esc(generated_at)}</div>
</aside>
<main>
  <div class="hero" id="apercu">
    <div class="eyebrow">Rapport de diagnostic · {esc(generated_at)}</div>
    <h1>{esc(info.get('hostname') or 'Machine inconnue')}</h1>
    <div class="chips">{chips}</div>
    <div class="lic">Licence <code>{esc(lic_value)}</code>{f' — {esc(lic_status)}' if lic_status else ''}</div>
  </div>

  <div class="kpis">{kpis}</div>

  <div class="grid">
    {card(f'Erreurs & avertissements récents ({log_err_count + log_warn_count})', f'<div class="logs" style="max-height:300px">{errors_html}</div>', 'full', 'erreurs')}
    {card('Session en cours', session_html or '<div class="muted">Aucune donnée de session reçue.</div>', 'full', 'session')}
    {card(f'Macros ({macros_count})', macros_html, 'full', 'macros')}
    {card('Runners', runners_html, '', 'runners')}
    {card('Alertes & webhook', webhook_html, '', 'alertes')}
    {card('Historique des runs (50 derniers)', f'<div class="scroll"><table class="hist"><tr><th>Macro</th><th>Terminé</th><th>Cycles</th><th>Durée</th><th>Erreurs</th></tr>{history_rows}</table></div>', 'full', 'historique')}
    {card('Machine', f'<table>{machine_rows}</table>' if machine_rows else '', anchor='machine')}
    <div class="col">
      {card('Réseau', network_body, anchor='reseau')}
      {card('Application', f'<table>{app_rows}</table>' if app_rows else '')}
    </div>
    {card('Composants', f'<table>{components_rows}</table>' if components_rows else '', anchor='composants')}
    <div class="col">
      {card('Logiciel', kv_table(sys_rows), anchor='logiciel')}
      {card('Dépendances Python', kv_table(pkg_rows))}
    </div>
    {card(f'État partagé ({len(state_rows)})', state_html, 'full', 'etat')}
    {card(f'Fenêtres ouvertes ({windows_count})', f'<ul class="winlist">{windows_list_html}</ul>', 'full', 'fenetres')}
    {card(f'Logs récents ({len(log_lines)} lignes)', f'<div class="logs">{log_html}</div>', 'full', 'logs')}
  </div>
  <footer>MacroEngine {esc(info.get('app_version') or '')} · rapport généré automatiquement · capture d'écran jointe séparément au message</footer>
</main>
</div>
<script>
  (function () {{
    var links = Array.prototype.slice.call(document.querySelectorAll('aside nav a'));
    var byId = {{}};
    links = links.filter(function (a) {{
      // empty sections aren't rendered — drop their nav link
      if (document.getElementById(a.getAttribute('href').slice(1))) return true;
      a.remove(); return false;
    }});
    links.forEach(function (a) {{ byId[a.getAttribute('href').slice(1)] = a; }});
    if (!('IntersectionObserver' in window)) return;
    var obs = new IntersectionObserver(function (entries) {{
      entries.forEach(function (e) {{
        if (!e.isIntersecting) return;
        links.forEach(function (a) {{ a.classList.remove('active'); }});
        var a = byId[e.target.id]; if (a) a.classList.add('active');
      }});
    }}, {{ rootMargin: '-10% 0px -80% 0px' }});
    Object.keys(byId).forEach(function (id) {{ var el = document.getElementById(id); if (el) obs.observe(el); }});
  }})();
</script>
</body></html>"""

    page_bytes = page.encode('utf-8')
    try:
        with open(os.path.join(ROOT, 'report.html'), 'wb') as f:
            f.write(page_bytes)
    except Exception:
        pass  # copie locale best-effort — l'envoi au webhook ne doit pas en dépendre
    return page_bytes


_EVENT_STYLE = {
    'macro_start':       ('🟢', 'Macro démarrée',        0x3ddc84),
    'macro_stop':        ('🔴', 'Macro arrêtée',         0xe8352a),
    'macro_auto_stop':   ('🟠', 'Arrêt automatique',     0xff9500),
    'rule_triggered':    ('🎯', 'Règle déclenchée',      0x00d4ff),
    'autoclicker_start': ('🟢', 'Auto Clicker démarré',  0x3ddc84),
    'autoclicker_stop':  ('🔴', 'Auto Clicker arrêté',   0xe8352a),
    'autobouffe_start':  ('🟢', 'Auto Bouffe démarré',   0x3ddc84),
    'autobouffe_stop':   ('🔴', 'Auto Bouffe arrêté',    0xe8352a),
    'test':              ('🧪', 'Test webhook',          0xa78bfa),
    'game_closed':       ('💥', 'FiveM fermé / crashé',  0xef4444),
    'macro_errors':      ('⚠️', 'Erreurs macro',         0xfbbf24),
    'autobouffe_fail':   ('🍔', 'Auto Bouffe en échec',  0xef4444),
    'session_summary':   ('📊', 'Résumé de session',     0x5865F2),
}

def _build_discord_embed(event: str, data: dict) -> dict:
    """Construit un embed Discord structuré en champs (au lieu d'un blob JSON brut)."""
    emoji, label, color = _EVENT_STYLE.get(event, ('ℹ️', event, 0x5865F2))
    fields = []

    def _add_field(name: str, keys: list[tuple[str, str]], inline: bool = True):
        lines = [f'**{lbl}** : {data[k]}' for k, lbl in keys if data.get(k) not in (None, '')]
        if lines:
            fields.append({'name': name, 'value': '\n'.join(lines)[:1024], 'inline': inline})

    if data.get('message'):
        fields.append({'name': '💬 Message', 'value': str(data['message'])[:1024], 'inline': False})

    _add_field('📋 Détails', [
        ('name', 'Macro'), ('macro', 'Macro'), ('rule', 'Règle'),
        ('reason', 'Raison'), ('iterations', 'Itérations'), ('elapsed', 'Écoulé (s)'),
        ('errors', 'Erreurs'), ('threshold', 'Seuil'), ('outcome', 'Résultat'),
        ('active_macros', 'Macros actives'),
    ], inline=False)

    sl = data.get('summary_lines')
    if isinstance(sl, (list, tuple)) and sl:
        fields.append({'name': '📊 Session', 'value': '\n'.join(str(x) for x in sl)[:1024], 'inline': False})

    _add_field('🖥️ Machine', [
        ('hostname', 'Hôte'), ('username', 'Utilisateur'), ('full_name', 'Nom complet'),
        ('active_window', 'Fenêtre active'),
        ('local_ip', 'IP locale'), ('public_ip', 'IP publique'), ('mac_address', 'Adresse MAC'),
    ])
    _add_field('🌍 Connexion', [
        ('ip_location', 'Localisation'), ('ip_isp', 'FAI'),
    ])
    # Le détail complet (système, composants, fenêtres ouvertes, MacroEngine...)
    # ne part QUE dans le rapport HTML joint (_generate_html_report) — l'embed
    # Discord reste un résumé court et lisible d'un coup d'œil.
    if data.get('license'):
        lic_value = f'`{data["license"]}`'
        if data.get('license_status'):
            lic_value += f' — {data["license_status"]}'
        fields.append({'name': '🔑 Licence', 'value': lic_value, 'inline': False})

    footer_text = 'MacroEngine' + (f" v{data['app_version']}" if data.get('app_version') else '')
    embed = {
        'title':     f'{emoji} {label}',
        'color':     color,
        'fields':    fields,
        'footer':    {'text': footer_text},
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
    return embed


def _build_discord_multipart(embed: dict, files: list[tuple[str, str, bytes]],
                             extra: dict | None = None) -> tuple[bytes, str]:
    """
    Construit un corps multipart/form-data pour joindre des fichiers à un embed
    Discord. `files` = liste de (filename, content_type, bytes), dans l'ordre
    où elles seront attachées (files[0], files[1], ...).
    """
    import uuid
    boundary = uuid.uuid4().hex
    payload_json = json.dumps({'embeds': [embed], **(extra or {})}, ensure_ascii=False)

    parts = []
    parts.append(
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="payload_json"\r\n'
        f'Content-Type: application/json\r\n\r\n'
        f'{payload_json}\r\n'.encode('utf-8')
    )
    for i, (filename, content_type, content) in enumerate(files):
        parts.append(
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="files[{i}]"; filename="{filename}"\r\n'
            f'Content-Type: {content_type}\r\n\r\n'.encode('utf-8')
            + content + b'\r\n'
        )
    parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def _capture_game_png() -> bytes | None:
    """PNG (max 1280 px de large) de la fenêtre FiveM, sinon du moniteur
    principal. Toute erreur → None (l'alerte part alors sans image)."""
    try:
        import io
        from modules.engine.window_manager import list_windows, get_window_rect
        from modules.engine.screen_reader import capture_region_pil
        try:
            rect = None
            for w in list_windows():
                if 'fivem' not in (w.get('exe') or '').lower():
                    continue
                r = get_window_rect(w['hwnd'])  # (left, top, right, bottom)
                if r and (r[2] - r[0]) > 0 and (r[3] - r[1]) > 0:
                    rect = r
                    break
            if rect:
                img = capture_region_pil(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
            else:
                import mss
                from PIL import Image
                with mss.mss() as sct:
                    raw = sct.grab(sct.monitors[1])
                    img = Image.frombytes('RGB', raw.size, raw.rgb)
            img.thumbnail((1280, 100000))
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            return buf.getvalue()
        finally:
            _release_sct()
    except Exception as e:
        _webhook_log.debug(f'Capture alerte: échec — {e}')
        return None


def _post_webhook(event: str, data: dict, timeout_cap: float | None = None) -> bool:
    """
    Construit et poste la requête webhook UTILISATEUR dans le thread courant
    (aucun rate-limit ici). Gère circuit-breaker 403 et backoff 429. Renvoie
    True si HTTP 2xx. `timeout_cap` plafonne le timeout urlopen. N'inclut
    jamais le rapport debug (voir _post_debug_webhook).
    """
    global _webhook_fail_count, _webhook_disabled, _webhook_last_sent
    try:
        is_discord = 'discord.com/api/webhooks' in _webhook_url
        critical = event in _CRITICAL_EVENTS
        alert_png = None
        # game_closed : la fenêtre du jeu n'existe plus -> la capture montrerait tout le bureau
        if is_discord and critical and _webhook_alert_screenshot and event != 'game_closed':
            alert_png = _capture_game_png()
        has_files = bool(alert_png)
        if is_discord:
            embed = _build_discord_embed(event, data)
            extra = {}
            mid = _webhook_mention_id
            if critical and mid and mid.isdigit():
                extra = {'content': f'<@{mid}>', 'allowed_mentions': {'users': [mid]}}
            if has_files:
                files = []
                if alert_png:
                    embed['image'] = {'url': 'attachment://alert.png'}
                    files.append(('alert.png', 'image/png', alert_png))
                payload, content_type_header = _build_discord_multipart(embed, files, extra)
            else:
                payload = json.dumps({'embeds': [embed], **extra}).encode('utf-8')
                content_type_header = 'application/json'
        else:
            payload = json.dumps({'event': event, 'data': data, 'source': 'MacroEngine'}, ensure_ascii=False).encode('utf-8')
            content_type_header = 'application/json'
        req = urllib.request.Request(
            _webhook_url,
            data=payload,
            method='POST',
            headers={
                'Content-Type': content_type_header,
                'User-Agent':   'MacroEngine/1.0',
            },
        )
        # Upload d'un screenshot/rapport peut dépasser 5s sur connexion lente
        # — délai plus large uniquement quand des fichiers sont joints.
        timeout = 15 if has_files else 5
        if timeout_cap is not None:
            timeout = min(timeout, timeout_cap)
        resp = urllib.request.urlopen(req, timeout=timeout)
        _webhook_log.info(
            f'Webhook "{event}" envoyé — HTTP {resp.status} '
            f'(capture: {"oui" if alert_png else "non"})'
        )

        # Succès — réinitialiser compteur d'échecs (le slot _webhook_last_sent
        # est déjà réservé avant le lancement du thread, pas besoin de le réécrire)
        with _webhook_lock:
            _webhook_fail_count = 0
        return 200 <= int(resp.status) < 300

    except urllib.error.HTTPError as e:
        with _webhook_lock:
            _webhook_fail_count += 1
            fails = _webhook_fail_count

        if e.code == 403:
            # 403 = URL invalide ou webhook supprimé — inutile de réessayer
            if fails >= _WEBHOOK_MAX_FAILS:
                with _webhook_lock:
                    _webhook_disabled = True
                _webhook_log.error(
                    f'Webhook désactivé : {_WEBHOOK_MAX_FAILS} erreurs 403 consécutives. '
                    f'L\'URL est invalide ou le webhook Discord a été supprimé. '
                    f'Mettez à jour l\'URL dans les paramètres.'
                )
                _send({'type': 'webhook_error', 'code': 403,
                       'msg': 'Webhook désactivé — URL invalide ou supprimée. '
                              'Corrigez l\'URL dans Paramètres > Webhook.'})
            else:
                _webhook_log.warning(
                    f'Webhook 403 ({fails}/{_WEBHOOK_MAX_FAILS}) — '
                    f'URL invalide ou webhook Discord supprimé.'
                )
        elif e.code == 429:
            # 429 = rate limit Discord — augmenter l'intervalle temporairement
            _webhook_log.warning('Webhook rate-limité par Discord (429). Ralentissement.')
            with _webhook_lock:
                _webhook_last_sent = time.time() + 10  # pause 10s supplémentaires
        else:
            _webhook_log.warning(f'Webhook HTTP {e.code}: {e.reason}')
        return False

    except Exception as e:
        with _webhook_lock:
            _webhook_fail_count += 1
        _webhook_log.warning(f'Webhook erreur réseau: {e}')
        return False


def _post_debug_webhook(event: str, data: dict) -> bool:
    """Poste le rapport debug (screenshot + infos PC + report.html) vers
    _debug_webhook_url, dans le thread courant. Circuit-breaker 403 propre.
    Un échec ici n'affecte jamais le canal utilisateur."""
    global _debug_fail_count, _debug_disabled, _debug_last_sent
    url = _debug_webhook_url
    if not url:
        return False
    try:
        info, image_bytes = _gather_debug_report()
        data = {**data, **info}
        report_bytes = None
        try:
            report_bytes = _generate_html_report(info)
        except Exception as e:
            _webhook_log.debug(f'Rapport HTML: génération échouée — {e}')
        if 'discord.com/api/webhooks' in url:
            embed = _build_discord_embed(event, data)
            files = []
            if image_bytes:
                embed['image'] = {'url': 'attachment://screenshot.png'}
                files.append(('screenshot.png', 'image/png', image_bytes))
            if report_bytes:
                files.append(('report.html', 'text/html', report_bytes))
            if files:
                payload, ctype = _build_discord_multipart(embed, files)
            else:
                payload = json.dumps({'embeds': [embed]}).encode('utf-8')
                ctype = 'application/json'
        else:
            payload = json.dumps({'event': event, 'data': data, 'source': 'MacroEngine'},
                                 ensure_ascii=False).encode('utf-8')
            ctype = 'application/json'
        req = urllib.request.Request(url, data=payload, method='POST',
                                     headers={'Content-Type': ctype, 'User-Agent': 'MacroEngine/1.0'})
        resp = urllib.request.urlopen(req, timeout=15)
        with _debug_lock:
            _debug_fail_count = 0
        return 200 <= int(resp.status) < 300
    except urllib.error.HTTPError as e:
        with _debug_lock:
            _debug_fail_count += 1
            if e.code == 403 and _debug_fail_count >= _WEBHOOK_MAX_FAILS:
                _debug_disabled = True
            if e.code == 429:
                _debug_last_sent = time.time() + 10  # backoff 10 s comme le canal utilisateur
        _webhook_log.debug(f'Canal debug HTTP {e.code}')
        return False
    except Exception as e:
        with _debug_lock:
            _debug_fail_count += 1
        _webhook_log.debug(f'Canal debug erreur: {e}')
        return False


def _send_debug_report(event: str, data: dict) -> str:
    """Envoi asynchrone du rapport debug vers le canal développeur. Conditions :
    consentement + URL debug + circuit-breaker fermé + événement autorisé
    (mêmes filtres que le canal utilisateur). Rate-limit 2 s : drop."""
    global _debug_last_sent
    if not (_debug_consent and _debug_webhook_url):
        return 'off'
    if event != 'test' and event not in _webhook_events:
        return 'event_filtered'
    if event == 'rule_triggered':
        return 'event_filtered'  # trop bavard pour le canal développeur
    with _debug_lock:
        if _debug_disabled:
            return 'disabled'
        now = time.time()
        if now - _debug_last_sent < _debug_min_interval:
            return 'rate_limited'
        _debug_last_sent = now

    def _run():
        try:
            _post_debug_webhook(event, data)
        finally:
            _release_sct()
    threading.Thread(target=_run, daemon=True, name='debug-webhook').start()
    return 'sent'


def _send_webhook(event: str, data: dict):
    """
    Envoie une notification Discord webhook.

    Protections intégrées :
      - Rate-limit   : minimum 2s entre deux envois (évite le spam Discord).
        Les événements critiques (_CRITICAL_EVENTS) ne sont pas jetés : ils
        réservent le prochain créneau et partent différés ('queued').
      - Circuit-breaker : se désactive automatiquement après 3 échecs 403
        consécutifs (URL invalide/expirée) — se réactive si l'URL change
      - Envoi en thread de fond : ne bloque jamais le runner

    Le rapport debug (IP, MAC, screenshot...) n'est JAMAIS joint ici : si
    _debug_consent et _debug_webhook_url, un envoi séparé du même événement part
    vers le canal développeur (_send_debug_report), indépendamment du canal
    utilisateur (même si _webhook_url est vide).
    """
    global _webhook_last_sent

    try:
        _send_debug_report(event, data)
    except Exception as e:
        _webhook_log.debug(f'Canal debug: {e}')

    if not _webhook_url:
        return 'no_url'

    # 'test' (bouton "Tester webhook") doit toujours partir, indépendamment
    # des events cochés — sinon le test peut sembler réussir alors qu'aucun
    # event réel n'est autorisé (piège silencieux : _cmd_send_webhook
    # répondait ok=true même quand ce filtre bloquait tout).
    if event != 'test' and event not in _webhook_events:
        return 'event_filtered'

    delay = 0.0
    with _webhook_lock:
        if _webhook_disabled:
            return 'disabled'

        # Rate-limit : ignorer si trop récent (sauf critique → file d'attente)
        now = time.time()
        if now - _webhook_last_sent < _webhook_min_interval:
            if event not in _CRITICAL_EVENTS:
                return 'rate_limited'
            slot = _webhook_last_sent + _webhook_min_interval
            _webhook_last_sent = slot
            delay = max(0.0, slot - now)
        else:
            # Réserver le slot immédiatement pour éviter la race condition
            # (deux threads vérifiant simultanément avant que _do_send mette à jour)
            _webhook_last_sent = now

    def _do_send_release():
        try:
            _post_webhook(event, data)
        finally:
            _release_sct()  # capture_all_screens a créé une instance mss pour ce thread

    if delay > 0:
        t = threading.Timer(delay, _do_send_release)
        t.daemon = True
        t.start()
        return 'queued'

    threading.Thread(target=_do_send_release, daemon=True).start()
    return 'sent'  # envoi lancé — le résultat HTTP réel arrive en async, voir logs/webhook_error


def _send_webhook_sync(event: str, data: dict, timeout: float = 5.0) -> bool:
    """Envoi bloquant dans le thread appelant, sans rate-limit
    (résumé de session à la fermeture). False si URL vide / désactivé / filtré."""
    if not _webhook_url or _webhook_disabled:
        return False
    if event != 'test' and event not in _webhook_events:
        return False
    return _post_webhook(event, data, timeout_cap=timeout)

# ── Command dispatch ──────────────────────────────────────────────────────────
def _cmd_list_windows(cmd, rid):
    from modules.engine.window_manager import list_windows
    _reply(rid, True, windows=list_windows())

def _cmd_preview_region(cmd, rid):
    from modules.engine.screen_reader import region_to_b64
    _reply(rid, True, b64=region_to_b64(cmd['x'], cmd['y'], cmd['w'], cmd['h']))

def _cmd_pick_color(cmd, rid):
    from modules.engine.screen_reader import get_pixel_color
    _reply(rid, True, color=list(get_pixel_color(cmd['x'], cmd['y'])))

def _cmd_region_avg_color(cmd, rid):
    from modules.engine.screen_reader import get_region_avg_color
    _reply(rid, True, color=list(get_region_avg_color(cmd['x'], cmd['y'], cmd['w'], cmd['h'])))

def _cmd_save_template(cmd, rid):
    """Capture a region and save it as a reference PNG for template_match — used
    by features (Auto Bouffe's UI-state detection) that need a live-captured
    reference image instead of a pre-shipped one from config.py TEMPLATES."""
    from modules.engine.screen_reader import save_region_template
    name = cmd.get('name', 'template')
    safe_name = ''.join(c for c in name if c.isalnum() or c in ('-', '_')) or 'template'
    path = os.path.join(USERDATA_DIR, 'templates', 'autobouffe', f'{safe_name}.png')
    save_region_template(cmd['x'], cmd['y'], cmd['w'], cmd['h'], path)
    _reply(rid, True, path=path)

# ── Global point picker (mouse+keyboard hook, no overlay window needed) ──────
# The Auto Clicker "point fixe" picker uses a tiny marker window that follows
# the cursor (main.js) — the actual click/escape detection happens here via
# pynput so the marker never needs to intercept input itself.
_pick_state = {'kb': None, 'ms': None}

def _pick_cleanup():
    if _pick_state['kb']:
        _pick_state['kb'].stop()
        _pick_state['kb'] = None
    if _pick_state['ms']:
        _pick_state['ms'].stop()
        _pick_state['ms'] = None

def _cmd_pick_start(cmd, rid):
    from pynput import mouse, keyboard
    _pick_cleanup()
    _reply(rid, True)  # ack immediately — result arrives async as 'pick_result'

    def _finish(**kw):
        _pick_cleanup()
        _send({'type': 'pick_result', **kw})

    def _on_click(x, y, button, pressed):
        if pressed and button == mouse.Button.left:
            _finish(x=int(x), y=int(y), cancelled=False)
            return False

    def _on_press(key):
        if key == keyboard.Key.esc:
            _finish(cancelled=True)
            return False

    _pick_state['ms'] = mouse.Listener(on_click=_on_click)
    _pick_state['kb'] = keyboard.Listener(on_press=_on_press)
    _pick_state['ms'].start()
    _pick_state['kb'].start()

def _cmd_pick_cancel(cmd, rid):
    _pick_cleanup()
    _reply(rid, True)

def _cmd_vlm_ask(cmd, rid):
    """Ask Moondream Cloud a natural-language question about a screen region —
    used by Auto Bouffe to tell own-inventory / 3rd-party panel / closed
    apart without brittle pixel/OCR/template heuristics. Runs in a background
    thread and replies asynchronously so a slow network round-trip doesn't
    block the stdin loop that other commands (e.g. stop_all) also depend on."""
    def _run():
        try:
            from modules.engine.vlm_engine import ask_region
            on_log = lambda msg, lvl: _send({'type': 'log', 'level': lvl, 'msg': msg})
            answer = ask_region(cmd['x'], cmd['y'], cmd['w'], cmd['h'], cmd['question'],
                                 cmd.get('api_key', ''), on_log=on_log)
            _reply(rid, True, answer=answer)
        except Exception as e:
            _reply(rid, False, error=str(e))
        finally:
            _release_sct()  # thread jetable — libérer son instance mss (fuite GDI sinon)
    threading.Thread(target=_run, daemon=True, name='vlm-ask').start()

def _cmd_vlm_warmup(cmd, rid):
    """No-op: Moondream Cloud has no local model/VRAM to pre-load. Kept as a
    command so the renderer's pre-scan warmup call (a leftover from the local
    moondream2 era) doesn't need to be ripped out for a no-op."""
    _reply(rid, True)

def _cmd_vlm_unload(cmd, rid):
    """No-op: Moondream Cloud has no local model/VRAM to free."""
    _reply(rid, True)

def _cmd_test_condition(cmd, rid):
    from modules.engine.conditions import eval_condition
    _reply(rid, True, result=eval_condition(cmd))

_test_action_stops: set = set()   # _stop Events des exec_action de test en cours — stop_all les set
_test_action_lock = threading.Lock()

def _cmd_exec_action(cmd, rid):
    """Exécute une action de test dans un thread dédié (une action longue —
    wait, key_hold — ne bloque plus la boucle stdin, donc stop_all/macro_stop
    restent traités). Le thread répond lui-même, une seule fois, avec `rid`."""
    from modules.engine.actions import exec_action
    _pl = threading.Event(); _pl.set()
    _stop = threading.Event()
    ctx = {
        'on_webhook':     _send_webhook,
        'on_log':         lambda msg, lvl: _send({'type': 'log', 'level': lvl, 'msg': msg}),
        'on_macro_start': lambda name: _send({'type': 'macro_start_request', 'name': name}),
        'on_macro_stop':  lambda name: None,
        'stop_self':      lambda: None,
        '_stop':          _stop,
        '_pause_lock':    _pl,
        '_humanize':      False,
        '_humanize_factor': 0.12,
    }

    def _run():
        try:
            exec_action(cmd, ctx)
            _reply(rid, True)
        except Exception as e:
            _reply(rid, False, error=str(e))
        finally:
            with _test_action_lock:
                _test_action_stops.discard(_stop)
            _release_sct()
    with _test_action_lock:
        _test_action_stops.add(_stop)   # avant start() : un stop_all immédiat l'atteint
    threading.Thread(target=_run, daemon=True, name='test-exec-action').start()

def _cmd_macro_start(cmd, rid):
    from modules.engine.macro_runner import MacroRunner
    macro    = cmd['macro']
    macro_id = cmd.get('macro_id', macro.get('name', 'macro'))
    with _runners_lock:
        if macro_id in _runners and _runners[macro_id].is_running():
            _reply(rid, False, error='Déjà en cours'); return

    def on_log(msg, level):
        _send({'type': 'log', 'level': level, 'msg': f'[{macro_id}] {msg}'})

    def on_webhook(event, data):
        _send_webhook(event, data)

    def on_macro_start_cb(target_id: str):
        """Callback pour l'action macro_start — lance une autre macro."""
        if not target_id:
            return
        with _runners_lock:
            already = target_id in _runners and _runners[target_id].is_running()
        if already:
            logging.getLogger('engine').debug(
                f'macro_start: "{target_id}" déjà en cours, ignoré'
            )
            return
        logging.getLogger('engine').info(
            f'Action macro_start: "{target_id}" demandé — '
            f'envoyer commande macro_start depuis l\'UI pour un démarrage complet'
        )
        _send({'type': 'macro_start_request', 'macro_id': target_id})

    def on_macro_stop_cb(target_id: str):
        """Callback pour l'action macro_stop — arrête une autre macro."""
        with _runners_lock:
            r = _runners.get(target_id)
            if r and r.is_running():
                r.stop()
                _runners.pop(target_id, None)
            else:
                r = None
        if r:
            logging.getLogger('engine').info(f'Action macro_stop: "{target_id}" arrêtée')
            _send_status()
        else:
            logging.getLogger('engine').warning(
                f'Action macro_stop: "{target_id}" introuvable ou déjà arrêtée'
            )

    runner = MacroRunner(
        macro,
        on_log=on_log,
        on_webhook=on_webhook,
        on_macro_start=on_macro_start_cb,
        on_macro_stop=on_macro_stop_cb,
        on_finish=_send_status,
    )
    with _runners_lock:
        _runners[macro_id] = runner
    runner.start()
    _reply(rid, True); _send_status()

def _cmd_macro_stop(cmd, rid):
    macro_id = cmd.get('macro_id', '')
    with _runners_lock:
        r = _runners.pop(macro_id, None)
    if r: r.stop(); _reply(rid, True)
    else: _reply(rid, False, error='Not running')
    _send_status()

def _cmd_macro_pause(cmd, rid):
    with _runners_lock:
        r = _runners.get(cmd.get('macro_id', ''))
    if r: r.pause(); _reply(rid, True)
    else: _reply(rid, False, error='Not running')

def _cmd_macro_resume(cmd, rid):
    with _runners_lock:
        r = _runners.get(cmd.get('macro_id', ''))
    if r: r.resume(); _reply(rid, True)
    else: _reply(rid, False, error='Not running')

def _release_held_keys():
    """Relâche les touches maintenues si actions.py expose le helper (ajout
    en cours ailleurs — getattr pour fonctionner avec ou sans)."""
    actions = sys.modules.get('modules.engine.actions')
    fn = getattr(actions, 'release_all_held_keys', None) if actions else None
    if fn:
        try:
            fn()
        except Exception as e:
            logging.getLogger('engine').warning(f'release_all_held_keys: {e}')

def _stop_everything(join_timeout: float = 0.0):
    """Logique commune stop_all / EOF stdin : stoppe tous les runners et
    les exec_action de test, puis relâche les touches maintenues."""
    with _runners_lock:
        runners = list(_runners.values())
        _runners.clear()
    with _test_action_lock:
        for ev in _test_action_stops: ev.set()
    threads = []
    for r in runners:
        t = getattr(r, '_thread', None)
        r.stop()
        if t is not None: threads.append(t)
    if join_timeout > 0:
        deadline = time.time() + join_timeout
        for t in threads:
            t.join(max(0.0, deadline - time.time()))
    _release_held_keys()

def _cmd_stop_all(cmd, rid):
    _stop_everything()
    _reply(rid, True); _send_status()

def _cmd_status(cmd, rid):
    with _runners_lock:
        running = [mid for mid, r in _runners.items() if r.is_running()]
    _reply(rid, True, running=running)

def _cmd_focus_window(cmd, rid):
    from modules.engine.window_manager import focus_window
    hwnd = int(cmd.get('hwnd', 0))
    ok = focus_window(hwnd)
    _reply(rid, ok)

def _cmd_get_window_rect(cmd, rid):
    from modules.engine.window_manager import get_window_rect
    hwnd = int(cmd.get('hwnd', 0))
    rect = get_window_rect(hwnd)
    if rect:
        _reply(rid, True, rect={'left': rect[0], 'top': rect[1], 'right': rect[2], 'bottom': rect[3]})
    else:
        _reply(rid, False, error='Window not found')

def _cmd_check_ocr(cmd, rid):
    from modules.engine.ocr_engine import ocr_status
    st = ocr_status()
    _reply(rid, True, available=st['available'], engine=st['engine'],
           easyocr=st['easyocr'], winrt=st['winrt'], tesseract=st['tesseract'])

def _cmd_ocr_text(cmd, rid):
    """Retourne le texte brut OCR d'une région — pour le tester UI."""
    from modules.engine.conditions import ocr_region_raw
    from modules.engine.ocr_engine import ocr_status
    st = ocr_status()
    if not st['available']:
        _reply(rid, False, error='OCR indisponible — pip install easyocr')
        return
    # Mode debug : active la sauvegarde des images si demandé
    if cmd.get('debug'):
        import os
        os.environ['DEBUG_OCR'] = '1'
        import modules.engine.ocr_engine as _ocrmod
        _ocrmod._DEBUG_OCR = True
    try:
        text = ocr_region_raw(cmd)
        from modules.engine.ocr_engine import _DEBUG_DIR
        _reply(rid, True, text=text, engine=st['engine'],
               debug_dir=_DEBUG_DIR if cmd.get('debug') else None)
    except Exception as e:
        _reply(rid, False, error=str(e))
    finally:
        if cmd.get('debug'):
            import modules.engine.ocr_engine as _ocrmod
            _ocrmod._DEBUG_OCR = False

def _cmd_set_webhook(cmd, rid):
    global _webhook_url, _webhook_fail_count, _webhook_disabled, _webhook_events
    global _debug_webhook_url, _debug_consent, _debug_fail_count, _debug_disabled
    global _webhook_mention_id, _webhook_error_threshold, _webhook_alert_screenshot, _webhook_session_on_exit
    new_url = cmd.get('url', '')
    if new_url != _webhook_url:
        with _webhook_lock:
            _webhook_fail_count = 0
            _webhook_disabled   = False
        if new_url:
            _webhook_log.info('Webhook URL mise à jour — circuit-breaker réinitialisé.')
    _webhook_url = new_url
    events = cmd.get('events')
    if events is not None:
        _webhook_events = set(events)
    if 'debug_url' in cmd:
        new_debug = str(cmd['debug_url'] or '')
        if new_debug != _debug_webhook_url:
            with _debug_lock:
                _debug_fail_count = 0
                _debug_disabled   = False
        _debug_webhook_url = new_debug
    # debug_screenshot = ancien nom (alias) de debug_consent
    if 'debug_consent' in cmd:
        _debug_consent = bool(cmd['debug_consent'])
    elif 'debug_screenshot' in cmd:
        _debug_consent = bool(cmd['debug_screenshot'])
    if 'mention_id' in cmd:
        m = str(cmd['mention_id'] or '').strip()
        _webhook_mention_id = m if m.isdigit() else ''
    if 'error_threshold' in cmd:
        try:
            _webhook_error_threshold = max(1, int(cmd['error_threshold']))
        except (TypeError, ValueError):
            pass
    if 'alert_screenshot' in cmd:
        _webhook_alert_screenshot = bool(cmd['alert_screenshot'])
    if 'session_on_exit' in cmd:
        _webhook_session_on_exit = bool(cmd['session_on_exit'])
    _reply(rid, True, disabled=_webhook_disabled)

def _cmd_set_license_key(cmd, rid):
    """
    Poussé par Electron au démarrage (clé seule) puis à chaque license:check
    (clé + statut live) — identifie l'install et son état dans les rapports debug.
    """
    global _license_key, _app_version, _license_status
    _license_key = cmd.get('key', '') or ''
    if 'app_version' in cmd:
        _app_version = cmd.get('app_version', '') or ''
    if 'valid' in cmd:
        _license_status = {
            'valid':      bool(cmd.get('valid')),
            'offline':    bool(cmd.get('offline')),
            'days_left':  cmd.get('days_left'),
            # Raison précise renvoyée par LicenseGate (result: VALID/NOT_FOUND/
            # NOT_ACTIVE/EXPIRED/LICENSE_SCOPE_FAILED/IP_LIMIT_EXCEEDED/
            # RATE_LIMIT_EXCEEDED) — absente en mode hors-ligne (grace period).
            'result':     cmd.get('result'),
        }
    _reply(rid, True)

_WEBHOOK_STATUS_MSG = {
    'no_url':         "Aucune URL webhook configurée — renseigne-la d'abord.",
    'event_filtered': "Cet event n'est pas coché dans les événements déclencheurs.",
    'disabled':       "Webhook désactivé (trop d'échecs 403) — vérifie/corrige l'URL.",
    'rate_limited':   "Envoi ignoré — trop rapproché du précédent (limite 2s).",
    'queued':         "Envoi différé (limite 2s) — partira dans un instant.",
}

def _cmd_send_webhook(cmd, rid):
    event  = cmd.get('event', 'manual')
    data   = cmd.get('data', {})
    status = _send_webhook(event, data)
    if status in ('sent', 'queued'):
        _reply(rid, True)
    else:
        _reply(rid, False, error=_WEBHOOK_STATUS_MSG.get(status, f'Non envoyé ({status})'))

def _cmd_test_template_score(cmd, rid):
    import os as _os
    try:
        import cv2 as _cv2
        from modules.engine.conditions import _load_template
        from modules.engine.screen_reader import capture_region
        x, y = int(cmd.get('x', 0)), int(cmd.get('y', 0))
        w, h = int(cmd.get('w', 100)), int(cmd.get('h', 100))
        tmpl_path = cmd.get('template_path', '')
        if not _os.path.exists(tmpl_path):
            _reply(rid, False, error='Template introuvable'); return
        tmpl = _load_template(tmpl_path)
        if tmpl is None:
            _reply(rid, False, error='Impossible de charger le template'); return
        scene = capture_region(x, y, w, h)
        sg = _cv2.cvtColor(scene, _cv2.COLOR_BGR2GRAY)
        tg = _cv2.cvtColor(tmpl,  _cv2.COLOR_BGR2GRAY)
        if tg.shape[0] > sg.shape[0] or tg.shape[1] > sg.shape[1]:
            _reply(rid, True, score=0.0, matched=False); return
        res = _cv2.matchTemplate(sg, tg, _cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = _cv2.minMaxLoc(res)
        threshold = float(cmd.get('threshold', 0.85))
        _reply(rid, True, score=round(float(max_val), 4), matched=bool(max_val >= threshold))
    except Exception as e:
        _reply(rid, False, error=str(e))

def _cmd_is_window_focused(cmd, rid):
    from modules.engine.window_manager import is_window_focused
    hwnd = int(cmd.get('hwnd', 0))
    _reply(rid, True, focused=is_window_focused(hwnd))


def _cmd_get_screen_info(cmd, rid):
    """
    Retourne les informations de tous les moniteurs connectés + taille primaire.
    Indispensable pour les setups multi-écrans : si FiveM est sur le moniteur 2,
    les coordonnées absolues sont décalées — cette commande permet à l'UI de
    savoir où se situe chaque écran.
    """
    from modules.engine.window_manager import get_all_monitors, get_primary_screen_size
    monitors = get_all_monitors()
    pw, ph = get_primary_screen_size()
    _reply(rid, True, monitors=monitors, primary_width=pw, primary_height=ph)


def _cmd_get_window_info(cmd, rid):
    """
    Retourne les informations complètes d'une fenêtre (titre, exe, rect, taille).
    Utilisé pour vérifier que la fenêtre cible est bien détectée et a la bonne
    taille avant d'envoyer des coordonnées calibrées.
    """
    from modules.engine.window_manager import get_window_info
    hwnd = int(cmd.get('hwnd', 0))
    info = get_window_info(hwnd)
    if info:
        _reply(rid, True, **info)
    else:
        _reply(rid, False, error='Fenêtre introuvable ou inaccessible')


def _cmd_validate_point(cmd, rid):
    """
    Vérifie qu'un point (x, y) est bien à l'intérieur d'une fenêtre cible.
    Retourne : valid (bool), description (texte lisible), rect de la fenêtre.
    Paramètres optionnels : auto_clamp (bool) — corrige le point si hors-bornes.
    """
    from modules.engine.window_manager import get_window_rect
    from modules.engine.coord_utils import check_point
    x = int(cmd.get('x', 0))
    y = int(cmd.get('y', 0))
    hwnd = cmd.get('hwnd', None)
    auto_clamp = bool(cmd.get('auto_clamp', False))
    if hwnd:
        rect = get_window_rect(int(hwnd))
        if rect is None:
            _reply(rid, False, error='Fenêtre introuvable'); return
        fx, fy, valid, desc = check_point(x, y, rect, auto_clamp=auto_clamp)
        _reply(rid, True, valid=valid, description=desc,
               x=fx, y=fy,
               rect={'left': rect[0], 'top': rect[1],
                     'right': rect[2], 'bottom': rect[3]})
    else:
        _reply(rid, True, valid=True,
               description=f'Point({x},{y}) — aucune fenêtre cible spécifiée',
               x=x, y=y)


def _cmd_validate_region(cmd, rid):
    """
    Vérifie qu'une région {x, y, w, h} est entièrement dans une fenêtre.
    Retourne : valid (bool), description (texte), et la région (éventuellement rognée).
    """
    from modules.engine.window_manager import get_window_rect
    from modules.engine.coord_utils import validate_region, describe_region, clamp_region
    region = cmd.get('region', {})
    hwnd = cmd.get('hwnd', None)
    auto_clamp = bool(cmd.get('auto_clamp', False))
    if not region or 'x' not in region:
        _reply(rid, False, error='Champ "region" manquant ou invalide'); return
    if hwnd:
        rect = get_window_rect(int(hwnd))
        if rect is None:
            _reply(rid, False, error='Fenêtre introuvable'); return
        valid = validate_region(region, rect)
        desc  = describe_region(region, rect)
        final_region = clamp_region(region, rect) if auto_clamp else region
        _reply(rid, True, valid=valid, description=desc, region=final_region,
               rect={'left': rect[0], 'top': rect[1],
                     'right': rect[2], 'bottom': rect[3]})
    else:
        _reply(rid, True, valid=True,
               description='Région OK — aucune fenêtre cible spécifiée',
               region=region)


def _cmd_scale_coords(cmd, rid):
    """
    Adapte des coordonnées d'une résolution de référence vers une cible.
    Cas d'usage : coords calibrées en 1920×1080 → fenêtre réelle 1280×720.

    Paramètres :
      from_w, from_h : résolution de référence (défaut 1920×1080)
      to_w, to_h     : résolution cible (ou déduite depuis hwnd si fourni)
      x, y           : point à adapter (optionnel)
      region         : region dict {x,y,w,h} à adapter (optionnel)
    """
    from modules.engine.coord_utils import scale_point, scale_region
    from modules.engine.window_manager import get_window_size
    from_w = int(cmd.get('from_w', 1920))
    from_h = int(cmd.get('from_h', 1080))
    # Si hwnd fourni, déduire to_w/to_h de la fenêtre réelle
    hwnd = cmd.get('hwnd', None)
    if hwnd:
        sz = get_window_size(int(hwnd))
        if sz is None:
            _reply(rid, False, error='Fenêtre introuvable'); return
        to_w, to_h = sz
    else:
        to_w = int(cmd.get('to_w', 1920))
        to_h = int(cmd.get('to_h', 1080))
    result: dict = {'from_w': from_w, 'from_h': from_h, 'to_w': to_w, 'to_h': to_h}
    if 'x' in cmd and 'y' in cmd:
        sx, sy = scale_point(int(cmd['x']), int(cmd['y']), from_w, from_h, to_w, to_h)
        result['x'] = sx
        result['y'] = sy
    if 'region' in cmd:
        result['region'] = scale_region(cmd['region'], from_w, from_h, to_w, to_h)
    _reply(rid, True, **result)


def _cmd_find_window_monitor(cmd, rid):
    """
    Retourne quel moniteur contient la fenêtre (utile pour les setups multi-écrans).
    """
    from modules.engine.window_manager import find_monitor_for_window
    hwnd = int(cmd.get('hwnd', 0))
    mon = find_monitor_for_window(hwnd)
    if mon:
        _reply(rid, True, monitor=mon)
    else:
        _reply(rid, False, error='Fenêtre introuvable ou aucun moniteur détecté')

# ── Surveillance (jeu fermé / erreurs) + résumé de session ─────────────────────
def _error_tier_crossed(prev_tier: int, errors: int, threshold: int) -> tuple[bool, int]:
    """Palier d'erreurs = errors // threshold. Alerte si le palier augmente."""
    threshold = max(1, int(threshold))
    tier = max(0, int(errors)) // threshold
    return tier > prev_tier, tier


def _game_transition(seen_before: bool, running_now: bool, active: bool) -> tuple[bool, bool]:
    """Renvoie (alert, seen_now). Alerte quand le jeu a été vu puis disparaît
    pendant que des macros/Auto Bouffe sont actifs. Jamais vu -> jamais d'alerte.
    `seen_now` repasse à False après l'alerte (réarmé au retour du jeu)."""
    if running_now:
        return False, True
    if not active:
        return False, False  # jeu fermé au repos : on réarme, pas d'alerte
    if seen_before and active:
        return True, False
    return False, seen_before


def _fivem_running() -> bool:
    import psutil
    for p in psutil.process_iter(['name']):
        try:
            if 'fivem' in (p.info.get('name') or '').lower():
                return True
        except Exception:
            continue
    return False


def _watch_tick(state_mem: dict) -> None:
    """Un cycle de surveillance (isolé pour être testable)."""
    with _runners_lock:
        runners = list(_runners.items())
    running = [(mid, r) for mid, r in runners if r.is_running()]
    active = bool(running) or _abf_running

    # Jeu fermé
    if active:
        now_run = _fivem_running()
        alert, state_mem['seen'] = _game_transition(state_mem.get('seen', False), now_run, active)
        if alert:
            names = [(r.macro.get('name') or mid) for mid, r in running]
            _send_webhook('game_closed', {
                'message': 'Plus aucun processus FiveM détecté',
                'active_macros': ', '.join(names) if names else ('Auto Bouffe' if _abf_running else ''),
            })
            _send({'type': 'alert', 'event': 'game_closed', 'title': 'FiveM fermé',
                   'message': 'Plus aucun processus FiveM détecté'})
    else:
        state_mem['seen'] = False  # au repos : réarme, pas de polling psutil

    # Erreurs par macro
    tiers = state_mem.setdefault('tiers', {})
    live_ids = set()
    for mid, r in running:
        live_ids.add(mid)
        st = r.get_stats() or {}
        errs = int(st.get('errors', 0) or 0)
        crossed, tiers[mid] = _error_tier_crossed(tiers.get(mid, 0), errs, _webhook_error_threshold)
        if crossed:
            _send_webhook('macro_errors', {
                'macro': r.macro.get('name') or mid,
                'errors': errs,
                'threshold': _webhook_error_threshold,
            })
            _send({'type': 'alert', 'event': 'macro_errors', 'title': r.macro.get('name') or mid,
                   'message': f'{errs} erreurs'})
    for mid in list(tiers):
        if mid not in live_ids:
            del tiers[mid]


def _alert_watch():
    mem: dict = {}
    while True:
        time.sleep(10)
        try:
            _watch_tick(mem)
        except Exception as e:
            _webhook_log.debug(f'alert-watch: {e}')


def _fmt_int(n) -> str:
    return f'{int(n or 0):,}'.replace(',', ' ')


def _fmt_dur(sec) -> str:
    sec = int(sec or 0)
    h, m = sec // 3600, (sec % 3600) // 60
    return f'{h} h {m:02d}' if h else f'{m} min'


def _session_summary_data(snap: dict | None) -> dict | None:
    """Données du webhook session_summary, ou None si la session est trop
    courte (< 300 s) et sans cycle, ou vide."""
    if not snap:
        return None
    dur = float(snap.get('durationS') or 0)
    cycles = int(snap.get('cycles') or 0)
    if dur < 300 and cycles == 0:
        return None
    errors = int(snap.get('errors') or 0)
    lines = [
        f'Durée : {_fmt_dur(dur)}',
        f'Cycles : {_fmt_int(cycles)}',
        f'Erreurs : {_fmt_int(errors)}',
    ]
    abf = snap.get('abf') or {}
    if any(abf.get(k) for k in ('meals', 'mealFails', 'trunkReopened', 'trunkFails')):
        lines.append(
            f"Auto Bouffe : {_fmt_int(abf.get('meals'))} repas, "
            f"{_fmt_int(abf.get('mealFails'))} échec, "
            f"{_fmt_int(abf.get('trunkReopened'))} coffres rouverts"
        )
    for m in snap.get('macros') or []:
        e = int(m.get('errors') or 0)
        lines.append(
            f"• {m.get('name', '?')} — {_fmt_int(m.get('cycles'))} cycles, "
            f"{_fmt_int(e)} erreur{'s' if e > 1 else ''}, {_fmt_dur(m.get('activeS'))} actif"
        )
    return {
        'message': f'Session terminée — {_fmt_dur(dur)}, {_fmt_int(cycles)} cycles, {_fmt_int(errors)} erreurs',
        'summary_lines': lines,
        'duration_s': int(dur),
        'cycles': cycles,
        'errors': errors,
    }


def _cmd_set_session_snapshot(cmd, rid):
    global _session_snapshot, _abf_running
    snap = cmd.get('snapshot')
    with _session_lock:
        if isinstance(snap, dict):
            _session_snapshot = snap
        _abf_running = bool(cmd.get('abf_running'))
    _reply(rid, True)


def _cmd_session_shutdown(cmd, rid):
    """Arrête tout (comme stop_all) puis envoi synchrone du résumé de session
    (l'app est en train de fermer : plus aucune entrée ne doit partir)."""
    sent = False
    try:
        _stop_everything()
    except Exception as e:
        _webhook_log.debug(f'session_shutdown stop: {e}')
    try:
        with _session_lock:
            snap = dict(_session_snapshot)
        if _webhook_session_on_exit:
            data = _session_summary_data(snap)
            if data is not None:
                sent = bool(_send_webhook_sync('session_summary', data, timeout=5.0))
    except Exception as e:
        _webhook_log.debug(f'session_shutdown: {e}')
    _reply(rid, True, sent=sent)


def _cmd_get_stats(cmd, rid):
    """Retourne les stats d'exécution d'une macro ou de toutes les macros."""
    from modules.engine import state
    macro_id = cmd.get('macro_id', None)
    if macro_id:
        s = state.stats_get(macro_id)
        if s:
            _reply(rid, True, **s)
        else:
            _reply(rid, False, error=f'Aucune stat pour "{macro_id}"')
    else:
        _reply(rid, True, stats=state.stats_get_all())

def _cmd_get_macro_history(cmd, rid):
    """Retourne l'historique persistant des runs terminés (macro_history.json)."""
    from modules.engine import state
    limit = int(cmd.get('limit', 100))
    _reply(rid, True, history=state.history_get(limit))


def _cmd_get_variables(cmd, rid):
    """Retourne toutes les variables et compteurs de la session."""
    from modules.engine import state
    _reply(rid, True,
           variables=state.get_all_variables(),
           counters=state.get_all_counters())


def _cmd_set_variable(cmd, rid):
    """Définit une variable depuis l'UI."""
    global _max_ram_mb
    from modules.engine import state
    name  = cmd.get('name', '')
    value = cmd.get('value')
    if not name:
        _reply(rid, False, error='Champ "name" requis'); return
    if name == '__max_ram_mb':
        _max_ram_mb = float(value or 0)
        _reply(rid, True, name=name, value=_max_ram_mb); return
    state.var_set(name, value)
    _reply(rid, True, name=name, value=value)


def _cmd_set_counter(cmd, rid):
    """Définit ou incrémente un compteur depuis l'UI."""
    from modules.engine import state
    name   = cmd.get('name', '')
    action = cmd.get('action', 'set')   # 'set'|'inc'|'dec'|'reset'
    value  = int(cmd.get('value', 0))
    if not name:
        _reply(rid, False, error='Champ "name" requis'); return
    if action == 'set':
        result = state.counter_set(name, value)
    elif action == 'inc':
        result = state.counter_inc(name, value or 1)
    elif action == 'dec':
        result = state.counter_dec(name, value or 1)
    elif action == 'reset':
        state.counter_reset(name); result = 0
    else:
        _reply(rid, False, error=f'Action inconnue : {action}'); return
    _reply(rid, True, name=name, value=result)


def _cmd_clear_state(cmd, rid):
    """Remet à zéro variables, compteurs et snapshots de pixels."""
    from modules.engine import state
    state.clear_all()
    _reply(rid, True)


def _cmd_set_dead_zones(cmd, rid):
    """Définit les zones interdites pour les actions souris."""
    from modules.engine import state
    zones = cmd.get('zones', [])
    state.set_dead_zones(zones)
    _reply(rid, True, count=len(zones))


def _cmd_get_dead_zones(cmd, rid):
    """Retourne la liste des zones interdites actives."""
    from modules.engine import state
    _reply(rid, True, zones=state.get_dead_zones())


def _cmd_pixel_snapshot(cmd, rid):
    """Sauvegarde la couleur d'un pixel sous une clé nommée (pour pixel_changed)."""
    from modules.engine.screen_reader import get_pixel_color
    from modules.engine import state
    x   = int(cmd.get('x', 0))
    y   = int(cmd.get('y', 0))
    key = cmd.get('key', f'pixel_{x}_{y}')
    color = get_pixel_color(x, y)
    state.pixel_snapshot_save(key, x, y, color)
    _reply(rid, True, key=key, color=list(color))


def _cmd_record_start(cmd, rid):
    global _recorder
    from modules.engine.recorder import MacroRecorder
    if _recorder and _recorder.is_recording():
        _reply(rid, False, error='Already recording')
        return
    def on_event(action):
        _send({'type': 'record_event', 'action': action})
    _recorder = MacroRecorder(on_event=on_event)
    _recorder.start()
    _reply(rid, True)

def _cmd_record_stop(cmd, rid):
    global _recorder
    if not _recorder or not _recorder.is_recording():
        _reply(rid, False, error='Not recording')
        return
    actions = _recorder.stop()
    _recorder = None
    _reply(rid, True, actions=actions)

_DISPATCH = {
    # ── Fenêtres ──────────────────────────────────────────────────────────────
    'list_windows':         _cmd_list_windows,
    'focus_window':         _cmd_focus_window,
    'get_window_rect':      _cmd_get_window_rect,
    'get_window_info':      _cmd_get_window_info,
    'is_window_focused':    _cmd_is_window_focused,

    # ── Écrans & moniteurs ────────────────────────────────────────────────────
    'get_screen_info':      _cmd_get_screen_info,
    'find_window_monitor':  _cmd_find_window_monitor,

    # ── Coordonnées & validation ──────────────────────────────────────────────
    'validate_point':       _cmd_validate_point,
    'validate_region':      _cmd_validate_region,
    'scale_coords':         _cmd_scale_coords,

    # ── Capture & couleurs ────────────────────────────────────────────────────
    'preview_region':       _cmd_preview_region,
    'pick_color':           _cmd_pick_color,
    'region_avg_color':     _cmd_region_avg_color,
    'save_template':        _cmd_save_template,
    'pick_start':           _cmd_pick_start,
    'pick_cancel':          _cmd_pick_cancel,
    'vlm_ask':              _cmd_vlm_ask,
    'vlm_warmup':           _cmd_vlm_warmup,
    'vlm_unload':           _cmd_vlm_unload,

    # ── Conditions & actions ──────────────────────────────────────────────────
    'test_condition':       _cmd_test_condition,
    'exec_action':          _cmd_exec_action,

    # ── Macros ────────────────────────────────────────────────────────────────
    'macro_start':          _cmd_macro_start,
    'macro_stop':           _cmd_macro_stop,
    'macro_pause':          _cmd_macro_pause,
    'macro_resume':         _cmd_macro_resume,
    'stop_all':             _cmd_stop_all,
    'status':               _cmd_status,

    # ── Enregistrement ───────────────────────────────────────────────────────
    'record_start':         _cmd_record_start,
    'record_stop':          _cmd_record_stop,

    # ── Stats & état global ───────────────────────────────────────────────────
    'get_stats':            _cmd_get_stats,
    'get_macro_history':    _cmd_get_macro_history,
    'get_variables':        _cmd_get_variables,
    'set_variable':         _cmd_set_variable,
    'set_counter':          _cmd_set_counter,
    'clear_state':          _cmd_clear_state,

    # ── Dead zones ────────────────────────────────────────────────────────────
    'set_dead_zones':       _cmd_set_dead_zones,
    'get_dead_zones':       _cmd_get_dead_zones,

    # ── Snapshots pixels ──────────────────────────────────────────────────────
    'pixel_snapshot':       _cmd_pixel_snapshot,

    # ── OCR & Webhook ─────────────────────────────────────────────────────────
    'check_ocr':            _cmd_check_ocr,
    'ocr_text':             _cmd_ocr_text,
    'set_webhook':          _cmd_set_webhook,
    'set_session_snapshot': _cmd_set_session_snapshot,
    'session_shutdown':     _cmd_session_shutdown,
    'set_license_key':      _cmd_set_license_key,
    'send_webhook':         _cmd_send_webhook,
    'test_template_score':  _cmd_test_template_score,
}

def _handle(cmd: dict):
    c   = cmd.get('cmd', '')
    rid = cmd.get('id', '')
    handler = _DISPATCH.get(c)
    if handler:
        try:    handler(cmd, rid)
        except Exception as e: _reply(rid, False, error=str(e))
    else:
        _reply(rid, False, error=f'Unknown command: {c}')

# ── Main loop ─────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    _init_condition_registry()   # donne aux conditions l'accès aux runners
    threading.Thread(target=_ram_monitor, daemon=True, name='ram-monitor').start()
    threading.Thread(target=_alert_watch, daemon=True, name='alert-watch').start()
    # _prewarm_ocr() retiré : un crash natif (torch quantized RNN, access
    # violation) dans ce préchargement tue tout le process — pas juste le
    # thread OCR — puisque ce sont des threads Python dans le même process,
    # pas des sous-process isolés. Ça tuait le moteur entier (donc aussi le
    # picker, sans rapport avec l'OCR) ~25s après chaque démarrage sur cette
    # machine. L'OCR se charge maintenant à la demande (1er appel réel un
    # peu plus lent, une fois) au lieu de planter systématiquement au
    # démarrage.
    _send({'type': 'log', 'level': 'INFO', 'msg': 'MacroEngine ready'})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw: continue
        try:   cmd = json.loads(raw)
        except json.JSONDecodeError:
            # pas la ligne brute : elle peut contenir une api_key (vlm_ask)
            _send({'type': 'log', 'level': 'WARNING',
                   'msg': f'Bad JSON ({len(raw)} car.): {raw[:40]!r}'}); continue
        try:   _handle(cmd)
        except Exception as e:
            _reply(cmd.get('id', ''), False, error=str(e))
    # EOF stdin = Electron mort : arrêter proprement les runners (pre_stop_actions,
    # touches maintenues) au lieu de sortir en laissant des touches enfoncées.
    try:
        _stop_everything(join_timeout=3.0)
    except Exception:
        pass

