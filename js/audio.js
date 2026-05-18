let ctx = null;
let masterGain = null;
let initialized = false;
let enabled = false;

function ensureContext() {
  if (initialized) return ctx;
  initialized = true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    masterGain = ctx.createGain();
    masterGain.gain.value = enabled ? 0.18 : 0;
    masterGain.connect(ctx.destination);
  } catch (err) {
    console.warn('audio init failed', err);
    ctx = null;
  }
  return ctx;
}

function resumeIfSuspended() {
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function setEnabled(on) {
  enabled = !!on;
  if (masterGain) {
    masterGain.gain.value = enabled ? 0.18 : 0;
  }
  if (enabled) {
    ensureContext();
  }
}

export function isEnabled() {
  return enabled;
}

function tone({ freq = 440, dur = 0.15, type = 'sine', gain = 0.6, attack = 0.005, decay = 0.04, sustain = 0.0, release = 0.08, startAt = 0, freqEnd = null, detune = 0 }) {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime + startAt;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) {
    osc.frequency.linearRampToValueAtTime(freqEnd, t0 + dur);
  }
  osc.detune.value = detune;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.linearRampToValueAtTime(gain * (1 - decay), t0 + attack + decay);
  g.gain.setValueAtTime(gain * (1 - decay), t0 + Math.max(attack + decay, dur - release));
  g.gain.linearRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  g.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseBurst({ dur = 0.05, gain = 0.4, startAt = 0, lowpass = 1200 } = {}) {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime + startAt;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpass;
  src.connect(filter);
  filter.connect(g);
  g.connect(masterGain);
  src.start(t0);
}

export function play(name) {
  if (!enabled) return;
  ensureContext();
  resumeIfSuspended();
  if (!ctx) return;

  switch (name) {
    case 'tap': {
      tone({ freq: 880, freqEnd: 660, dur: 0.06, type: 'triangle', gain: 0.35, attack: 0.001, decay: 0.02, release: 0.04 });
      break;
    }
    case 'add': {
      tone({ freq: 520, freqEnd: 780, dur: 0.14, type: 'triangle', gain: 0.45, attack: 0.003, decay: 0.04, release: 0.08 });
      tone({ freq: 1040, freqEnd: 1560, dur: 0.14, type: 'sine', gain: 0.18, attack: 0.003, decay: 0.04, release: 0.08, detune: 6 });
      break;
    }
    case 'complete': {
      tone({ freq: 660, dur: 0.10, type: 'triangle', gain: 0.5, attack: 0.003, decay: 0.04, release: 0.05, startAt: 0.0 });
      tone({ freq: 880, dur: 0.10, type: 'triangle', gain: 0.5, attack: 0.003, decay: 0.04, release: 0.05, startAt: 0.08 });
      tone({ freq: 1320, dur: 0.18, type: 'triangle', gain: 0.55, attack: 0.003, decay: 0.04, release: 0.10, startAt: 0.16 });
      tone({ freq: 1320, freqEnd: 1760, dur: 0.20, type: 'sine', gain: 0.22, attack: 0.005, decay: 0.04, release: 0.12, startAt: 0.20 });
      noiseBurst({ dur: 0.12, gain: 0.10, startAt: 0.22, lowpass: 3500 });
      break;
    }
    case 'delete': {
      tone({ freq: 280, freqEnd: 140, dur: 0.18, type: 'sawtooth', gain: 0.25, attack: 0.003, decay: 0.04, release: 0.10 });
      noiseBurst({ dur: 0.08, gain: 0.18, startAt: 0, lowpass: 600 });
      break;
    }
    case 'levelup': {
      tone({ freq: 660, dur: 0.14, type: 'triangle', gain: 0.5, startAt: 0.0 });
      tone({ freq: 990, dur: 0.14, type: 'triangle', gain: 0.5, startAt: 0.10 });
      tone({ freq: 1320, dur: 0.20, type: 'triangle', gain: 0.55, startAt: 0.20 });
      tone({ freq: 1980, dur: 0.30, type: 'sine', gain: 0.30, startAt: 0.30 });
      break;
    }
    default:
      break;
  }
}

export function unlockOnFirstGesture() {
  const handler = () => {
    ensureContext();
    resumeIfSuspended();
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
}
