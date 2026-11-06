let audio = null;
let enabled = true;

try {
  enabled = localStorage.getItem('gp-sound') !== 'off';
} catch {}

export function soundEnabled() {
  return enabled;
}

export function setSound(on) {
  enabled = on;
  try {
    localStorage.setItem('gp-sound', on ? 'on' : 'off');
  } catch {}
}

function tone(freq, start, duration, type = 'sine', volume = 0.16) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

const PATTERNS = {
  good: { vibrate: 60, notes: [[880, 0, 0.09], [1320, 0.1, 0.14]], type: 'sine' },
  bad: { vibrate: [180, 80, 180], notes: [[220, 0, 0.2], [170, 0.24, 0.26]], type: 'square', volume: 0.09 },
  warn: { vibrate: [90, 60, 90], notes: [[660, 0, 0.12], [660, 0.18, 0.12]], type: 'triangle' },
  tick: { vibrate: 25, notes: [[1200, 0, 0.05]], type: 'sine', volume: 0.08 }
};

export function feedback(kind) {
  const pattern = PATTERNS[kind];
  if (!pattern) return;
  try {
    navigator.vibrate?.(pattern.vibrate);
  } catch {}
  if (!enabled) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime + 0.01;
    for (const [freq, offset, duration] of pattern.notes) tone(freq, t + offset, duration, pattern.type, pattern.volume);
  } catch {}
}
