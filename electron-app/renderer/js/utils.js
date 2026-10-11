'use strict';
/* ═══════════════════════════════════════════════════════════════
   UTILITIES — escHtml, hexToRgb, rgbToHex
════════════════════════════════════════════════════════════════ */

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return [0, 0, 0];
  return m.map(h => parseInt(h, 16));
}

/* ═══════════════════════════════════════════════════════════════
   KEY CAPTURE — keydown event → key name, per consumer.
   Each backend resolves key names differently, so there is one helper
   per consumer. Never store raw e.key: on AZERTY it is the layout char
   ('é', '&', 'a' on the physical Q key) and DOM spellings ('Control',
   'ArrowUp', 'Tab') are unknown to every consumer below.
════════════════════════════════════════════════════════════════ */

// ── pydirectinput (key_tap / key_hold / key_release, Auto Bouffe) ──
// pydirectinput sends hardware scancodes named after QWERTY positions
// ('a' → 0x1E) and silently no-ops unknown names, so the name must come
// from the *physical* key (e.code), not the layout char (e.key).
const _PDI_CODE_MAP = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Space: 'space', Escape: 'esc', Enter: 'enter',
  Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  CapsLock: 'capslock', NumLock: 'numlock', ScrollLock: 'scrolllock',
  Pause: 'pause', PrintScreen: 'printscreen', ContextMenu: 'apps',
  ControlLeft: 'ctrlleft', ControlRight: 'ctrlright', ShiftLeft: 'shiftleft',
  ShiftRight: 'shiftright', AltLeft: 'altleft', AltRight: 'altright',
  MetaLeft: 'winleft', MetaRight: 'winright', OSLeft: 'winleft', OSRight: 'winright',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  NumpadAdd: 'add', NumpadSubtract: 'subtract', NumpadMultiply: 'multiply',
  NumpadDivide: 'divide', NumpadDecimal: 'decimal', NumpadEnter: 'enter',
  // IntlBackslash (the AZERTY '<>' key, scancode 0x56) has no pydirectinput
  // name — deliberately unmapped rather than aliased to a different key.
};
const _PDI_KEY_FALLBACK = {
  control: 'ctrl', shift: 'shift', alt: 'alt', meta: 'win', ' ': 'space',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  escape: 'esc',
};
function keyNameFromEvent(e) {
  const code = e.code || '';
  let m;
  if ((m = code.match(/^Key([A-Z])$/)))        return m[1].toLowerCase();
  if ((m = code.match(/^(?:Digit|Numpad)([0-9])$/))) return m[1]; // no numpad names in pydirectinput
  if ((m = code.match(/^F([0-9]{1,2})$/)))     return 'f' + m[1];
  if (_PDI_CODE_MAP[code])                     return _PDI_CODE_MAP[code];
  const lower = (e.key || '').toLowerCase();
  return _PDI_KEY_FALLBACK[lower] || lower;
}

// ── `keyboard` Python lib (macro kill switch → keyboard.add_hotkey) ──
// That lib resolves names through the *current layout*, so the layout char
// (e.key) is right for printable keys ('é', '&', 'a' all map to the key the
// user pressed). Only special keys need its own spelling. '+' and ',' are
// hotkey separators there and must be spelled out.
const _KBLIB_KEY_MAP = {
  ' ': 'space', escape: 'esc', enter: 'enter', tab: 'tab', backspace: 'backspace',
  delete: 'delete', insert: 'insert', home: 'home', end: 'end',
  pageup: 'page up', pagedown: 'page down', capslock: 'caps lock',
  numlock: 'num lock', scrolllock: 'scroll lock', pause: 'pause',
  printscreen: 'print screen', contextmenu: 'menu',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  '+': 'plus', ',': 'comma',
};
const _KBLIB_MODIFIER_KEYS = ['control', 'shift', 'alt', 'altgraph', 'meta', 'os'];
/** Returns null for a bare modifier or a dead/unidentified key. */
function keyboardLibNameFromEvent(e) {
  const lower = (e.key || '').toLowerCase();
  if (!lower || lower === 'dead' || lower === 'unidentified') return null;
  if (_KBLIB_MODIFIER_KEYS.includes(lower)) return null;
  if (/^f[0-9]{1,2}$/.test(lower)) return lower;
  if (_KBLIB_KEY_MAP[lower]) return _KBLIB_KEY_MAP[lower];
  return lower.length === 1 ? lower : null;
}

// ── Win32 GetAsyncKeyState (keyboard conditions, conditions.py _VK_MAP) ──
// Virtual-key codes follow the layout for letters (VK_A = the key labelled
// A, i.e. e.key) but are positional for the number row (VK_1 = the '&' key
// on AZERTY, i.e. e.code Digit1). Names must exist in conditions._VK_MAP.
const _VK_CODE_MAP = {
  Space: 'space', Escape: 'esc', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab',
  Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home',
  End: 'end', PageUp: 'pageup', PageDown: 'pagedown', CapsLock: 'capslock',
  NumLock: 'numlock', ScrollLock: 'scrolllock', Pause: 'pause',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift',
  AltLeft: 'alt', AltRight: 'alt',
};
function keyVkNameFromEvent(e) {
  const code = e.code || '';
  let m;
  if ((m = code.match(/^Digit([0-9])$/)))    return m[1];
  if ((m = code.match(/^F([0-9]{1,2})$/)))   return 'f' + m[1];
  if (_VK_CODE_MAP[code])                    return _VK_CODE_MAP[code];
  const lower = (e.key || '').toLowerCase();
  if (/^[a-z]$/.test(lower))                 return lower;
  if ((m = code.match(/^Key([A-Z])$/)))      return m[1].toLowerCase();
  return lower;
}

// ── Electron accelerator (globalShortcut: auto-clicker, settings) ──
// Electron maps an accelerator letter to its VK (layout-dependent, like
// e.key) and digits to the number-row VK (positional, like e.code), and
// only understands ASCII — 'é'/'ù'/'²' can't be registered at all.
const _ACCEL_CODE_MAP = {
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', CapsLock: 'Capslock',
  NumLock: 'Numlock', ScrollLock: 'Scrolllock', Pause: 'Pause',
  PrintScreen: 'PrintScreen', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
/**
 * Accelerator for a keydown (with Ctrl/Alt/Shift modifiers), or:
 *   null          — bare modifier press, keep waiting for the real key
 *   { error }     — key Electron cannot register (non-ASCII char, dead key…)
 */
function acceleratorFromEvent(e) {
  const code = e.code || '';
  const key  = e.key || '';
  if (['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'].includes(key)) return null;
  let main = null, m;
  if      ((m = code.match(/^F([0-9]{1,2})$/)))     main = 'F' + m[1];
  else if ((m = code.match(/^Digit([0-9])$/)))      main = m[1];
  else if ((m = code.match(/^Numpad([0-9])$/)))     main = 'num' + m[1];
  else if (_ACCEL_CODE_MAP[code])                   main = _ACCEL_CODE_MAP[code];
  else if (/^[a-z]$/i.test(key))                    main = key.toUpperCase();
  else if (key === '+')                             main = 'Plus';
  else if (/^[\x21-\x7e]$/.test(key))               main = key;
  if (!main) return { error: `Touche « ${key || code} » non supportée comme raccourci global` };
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey && !/^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(main)) parts.push('Shift');
  parts.push(main);
  return parts.join('+');
}

function rgbToHex(colorArr) {
  if (!colorArr || !Array.isArray(colorArr)) return '#000000';
  const [r, g, b] = colorArr;
  return '#' + [r, g, b].map(v => ((v || 0) & 0xFF).toString(16).padStart(2, '0')).join('');
}
