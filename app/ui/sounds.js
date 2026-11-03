(() => {
  'use strict';

  const STORAGE_KEY = 'mochi-pocket.audio.v1';
  const DEFAULT_VOLUME = 0.35;
  const MAX_SOUNDS = 4;
  const clampVolume = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value)) : fallback;
  let settings = { muted: false, volume: DEFAULT_VOLUME };
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      settings = {
        muted: typeof saved.muted === 'boolean' ? saved.muted : false,
        volume: clampVolume(saved.volume, DEFAULT_VOLUME),
      };
    }
  } catch { /* Audio remains usable when local storage is unavailable. */ }

  let context;
  let master;
  let gestureActive = false;
  const playing = new Set();

  function persist() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Optional persistence. */ }
  }

  function applyVolume(immediate = false) {
    if (!context || !master) return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    if (immediate) master.gain.setValueAtTime(settings.muted ? 0 : settings.volume, now);
    else master.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, now, 0.012);
  }

  function stopSound(sound) {
    playing.delete(sound);
    for (const voice of [...sound.voices]) {
      try { voice.oscillator.stop(); } catch { /* Already stopped. */ }
      voice.dispose();
    }
  }

  function stopAll() {
    for (const sound of [...playing]) stopSound(sound);
  }

  function prepareContext() {
    if (settings.muted || settings.volume === 0) return null;
    const hasActivation = gestureActive || window.navigator?.userActivation?.isActive === true;
    if (!context) {
      if (!hasActivation) return null;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      try {
        context = new AudioContext({ latencyHint: 'interactive' });
        master = context.createGain();
        master.gain.value = settings.volume;
        master.connect(context.destination);
      } catch {
        try { context?.close()?.catch(() => {}); } catch { /* Unsupported audio device. */ }
        context = null;
        master = null;
        return null;
      }
    }
    if (context.state === 'closed') return null;
    if (context.state === 'suspended' && hasActivation) {
      try { context.resume()?.catch(() => {}); } catch { /* A later gesture can retry. */ }
    }
    return context;
  }

  // Unlock silently from a real gesture. Completion sounds can then follow an async operation.
  function unlock(event) {
    if (!event.isTrusted) return;
    gestureActive = true;
    prepareContext();
    queueMicrotask(() => { gestureActive = false; });
  }
  for (const eventName of ['pointerdown', 'keydown', 'click']) {
    window.document?.addEventListener(eventName, unlock, { capture: true, passive: true });
  }
  window.addEventListener?.('pagehide', stopAll);

  // A rounded triangle carries the melody; quiet, filtered square notes add the handheld character.
  // Each tuple is [delay seconds, frequency Hz, duration seconds, peak gain, waveform, final Hz].
  const sounds = {
    click: [[0, 740, 0.055, 0.13, 'triangle', 620]],
    move: [[0, 1047, 0.045, 0.075, 'square', 1175]],
    confirm: [[0, 784, 0.085, 0.14, 'triangle'], [0.065, 1175, 0.13, 0.13, 'square']],
    back: [[0, 880, 0.07, 0.12, 'triangle'], [0.055, 587, 0.105, 0.11, 'triangle']],
    success: [[0, 784, 0.11, 0.12, 'triangle'], [0.09, 988, 0.11, 0.12, 'triangle'],
      [0.18, 1175, 0.11, 0.12, 'triangle'], [0.27, 1568, 0.22, 0.105, 'square']],
    attention: [[0, 659, 0.075, 0.13, 'triangle'], [0.065, 988, 0.105, 0.105, 'square'],
      [0.23, 659, 0.075, 0.13, 'triangle'], [0.295, 988, 0.145, 0.105, 'square']],
    error: [[0, 330, 0.09, 0.10, 'triangle', 294], [0.12, 262, 0.14, 0.10, 'triangle', 247]],
    power: [[0, 392, 0.085, 0.09, 'triangle'], [0.065, 587, 0.085, 0.10, 'triangle'],
      [0.13, 784, 0.18, 0.11, 'square']],
  };

  function addVoice(sound, spec, start) {
    const [delay, frequency, duration, peak, waveform, finalFrequency] = spec;
    const at = start + delay;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = waveform === 'square' ? 2800 : 4200;
    filter.Q.value = 0.35;
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(frequency, at);
    if (finalFrequency) oscillator.frequency.exponentialRampToValueAtTime(finalFrequency, at + duration);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(peak, at + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    envelope.gain.linearRampToValueAtTime(0, at + duration + 0.006);
    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);

    let disposed = false;
    const voice = {
      oscillator,
      dispose() {
        if (disposed) return;
        disposed = true;
        oscillator.onended = null;
        oscillator.disconnect();
        filter.disconnect();
        envelope.disconnect();
        sound.voices.delete(voice);
        if (!sound.voices.size) playing.delete(sound);
      },
    };
    sound.voices.add(voice);
    oscillator.onended = voice.dispose;
    oscillator.start(at);
    oscillator.stop(at + duration + 0.012);
  }

  function play(type) {
    if (!Object.prototype.hasOwnProperty.call(sounds, type)) return false;
    if (!prepareContext()) return false;
    // Do not queue stale sounds while the device or browser has suspended audio.
    if (context.state !== 'running' && !gestureActive && window.navigator?.userActivation?.isActive !== true) return false;
    while (playing.size >= MAX_SOUNDS) stopSound(playing.values().next().value);
    const sound = { voices: new Set() };
    playing.add(sound);
    try {
      const start = context.currentTime + 0.004;
      for (const spec of sounds[type]) addVoice(sound, spec, start);
      return true;
    } catch {
      stopSound(sound);
      return false;
    }
  }

  window.mochiSounds = Object.freeze({
    play,
    setMuted(value) {
      if (typeof value !== 'boolean') return { ...settings };
      settings.muted = value;
      applyVolume(value);
      if (value) stopAll();
      persist();
      return { ...settings };
    },
    setVolume(value) {
      settings.volume = clampVolume(value, settings.volume);
      applyVolume(settings.volume === 0);
      if (settings.volume === 0) stopAll();
      persist();
      return { ...settings };
    },
    getSettings() { return { ...settings }; },
  });
})();
