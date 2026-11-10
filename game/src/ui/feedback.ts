// Sound effects (synthesised with WebAudio, no files), haptics, read-aloud and toasts.
import { h } from './dom';

const PREF = 'sb.prefs';
interface Prefs { muted: boolean; voice: boolean; name?: string; color?: string; quality?: 'low' | 'high' }
export const prefs: Prefs = (() => {
  try { return { muted: false, voice: true, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { muted: false, voice: true }; }
})();
export function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch { /* ignore */ } }

// ---------------------------------------------------------------- sound
let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  if (prefs.muted) return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch { return null; }
}
// Browsers only allow audio after a gesture: unlock on the first tap.
addEventListener('pointerdown', () => { if (!prefs.muted) ac(); }, { once: true, capture: true });

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', vol = 0.18, slideTo?: number) {
  const a = ac(); if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(at: number, dur: number, vol = 0.2, hp = 1200) {
  const a = ac(); if (!a) return;
  const t = a.currentTime + at;
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

export const sfx = {
  tap() { tone(660, 0, 0.06, 'triangle', 0.06); },
  dice() { for (let i = 0; i < 7; i++) noise(i * 0.07 + Math.random() * 0.03, 0.05, 0.25 - i * 0.025, 1800 + Math.random() * 1500); },
  chime() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.08, 0.6, 'sine', 0.12)); },
  twist() { [659, 784, 740].forEach((f, i) => tone(f, i * 0.1, 0.35, 'triangle', 0.1)); },
  oops() { tone(440, 0, 0.25, 'triangle', 0.14, 300); tone(330, 0.22, 0.4, 'triangle', 0.14, 196); },
  twinkle() { [1319, 1760, 2093].forEach((f, i) => tone(f, i * 0.05, 0.3, 'sine', 0.07)); },
  flip() { noise(0, 0.12, 0.12, 2500); tone(520, 0.05, 0.12, 'sine', 0.05, 780); },
  step() { tone(200, 0, 0.08, 'sine', 0.08, 140); },
  fanfare() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.12, i === 5 ? 0.9 : 0.2, 'triangle', 0.12)); },
  error() { tone(220, 0, 0.18, 'square', 0.04); },
};

export function setMuted(m: boolean) {
  prefs.muted = m; savePrefs();
  if (m) { ctx?.suspend().catch(() => {}); speechSynthesis?.cancel?.(); }
}

// ---------------------------------------------------------------- haptics
export function buzz(pattern: number | number[]) {
  try { if (!prefs.muted && 'vibrate' in navigator) navigator.vibrate(pattern); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- read-aloud
let voice: SpeechSynthesisVoice | null = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  voice = vs.find((v) => v.lang.startsWith(lang) && /natural|enhanced|premium|google/i.test(v.name))
    || vs.find((v) => v.lang.startsWith(lang)) || vs.find((v) => v.lang.startsWith('en')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

export const canSpeak = () => 'speechSynthesis' in window;
export function speak(text: string) {
  if (!canSpeak()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#]/g, ''));
  if (voice) u.voice = voice;
  u.rate = 0.92; u.pitch = 1.05;
  speechSynthesis.speak(u);
}
/** Queue a line after whatever is being read (story bubbles arriving one after another). */
export function speakQueued(text: string) {
  if (!canSpeak() || prefs.muted) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#]/g, ''));
  if (voice) u.voice = voice;
  u.rate = 0.92; u.pitch = 1.05;
  speechSynthesis.speak(u);
}
export function stopSpeaking() { if (canSpeak()) speechSynthesis.cancel(); }

/** A 🔊 button that reads `text()` aloud. */
export function readAloud(text: () => string, label = 'Read it to me'): HTMLElement {
  if (!canSpeak()) return h('span');
  const b = h('button', { type: 'button', class: 'btn icon speak', 'aria-label': label, title: label, onclick: (e: Event) => { e.stopPropagation(); speak(text()); } });
  b.innerHTML = '<span class="ic" aria-hidden="true">🔊</span>';
  return b;
}

// ---------------------------------------------------------------- toasts
let toastBox: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' | 'good' = 'info', ms = 3200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
  const t = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, msg);
  t.addEventListener('click', () => t.remove());
  toastBox.appendChild(t);
  while (toastBox.children.length > 3) toastBox.firstElementChild!.remove();
  if (kind === 'error') { sfx.error(); buzz(40); }
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
}
