import * as audio from './audio.js';

const DEFAULTS = {
  sound: false,
  haptics: true,
  motion: 'auto'
};

let _settings = { ...DEFAULTS };
let _store = null;
const listeners = new Set();

function applyMotionAttr() {
  const reduced = isReducedNow();
  document.documentElement.dataset.motion = reduced ? 'reduce' : 'full';
}

function isReducedNow() {
  if (_settings.motion === 'reduce') return true;
  if (_settings.motion === 'full') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function notify() {
  applyMotionAttr();
  audio.setEnabled(!!_settings.sound);
  for (const fn of listeners) {
    try { fn(_settings); } catch (err) { console.error(err); }
  }
}

export const settings = {
  attach(store) {
    _store = store;
    const raw = store.raw();
    if (raw && raw.meta && raw.meta.settings) {
      _settings = { ...DEFAULTS, ...raw.meta.settings };
    } else {
      _settings = { ...DEFAULTS };
      ensurePersisted();
    }
    notify();

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', () => {
        if (_settings.motion === 'auto') notify();
      });
    }
    audio.unlockOnFirstGesture();
  },

  get() {
    return { ..._settings };
  },

  set(patch) {
    _settings = { ..._settings, ...patch };
    ensurePersisted();
    notify();
  },

  isReduced() {
    return isReducedNow();
  },

  isSoundOn() { return !!_settings.sound; },
  isHapticsOn() { return !!_settings.haptics; },

  haptic(durationMs = 15) {
    if (!_settings.haptics) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(durationMs); } catch (_) {}
    }
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};

function ensurePersisted() {
  if (!_store) return;
  const raw = _store.raw();
  if (!raw.meta) raw.meta = {};
  raw.meta.settings = { ..._settings };
  _store.save();
}
