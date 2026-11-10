// Hand-inked SVG icons in the pack palette (ink outline + watercolour fill).
import type { Trait } from '../rules/types';
import { svg } from './dom';

const S = (body: string, vb = '0 0 48 48') =>
  `<svg viewBox="${vb}" fill="none" stroke="#2a2328" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  heart: S('<path d="M24 41 C9 31 5 23 7 16 C9 9 18 7 24 15 C30 7 39 9 41 16 C43 23 39 31 24 41Z" fill="#d8a7a7"/><path d="M13 16c1-3 4-4 6-3" stroke-width="2"/>'),
  heartEmpty: S('<path d="M24 41 C9 31 5 23 7 16 C9 9 18 7 24 15 C30 7 39 9 41 16 C43 23 39 31 24 41Z" fill="#f2eadb" stroke-dasharray="4 3"/>'),
  gift: S('<rect x="8" y="19" width="32" height="22" rx="2" fill="#d8a7a7"/><rect x="6" y="13" width="36" height="8" rx="2" fill="#e8c4c4"/><path d="M24 13v28" stroke="#2a2328"/><path d="M24 13c-4-7-12-7-11-2 1 3 7 2 11 2zM24 13c4-7 12-7 11-2-1 3-7 2-11 2z" fill="#a9bfa0"/>'),
  giftEmpty: S('<rect x="8" y="19" width="32" height="22" rx="2" fill="#f2eadb" stroke-dasharray="4 3"/><rect x="6" y="13" width="36" height="8" rx="2" fill="#f2eadb" stroke-dasharray="4 3"/>'),
  twinkle: S('<path d="M24 5 L28 19 L42 24 L28 29 L24 43 L20 29 L6 24 L20 19Z" fill="#f6e7b0"/><circle cx="38" cy="9" r="2" fill="#2a2328" stroke="none"/>'),
  star: S('<path d="M24 5l5.6 12 13 1.6-9.6 9 2.5 13L24 34l-11.5 6.6 2.5-13-9.6-9 13-1.6z" fill="#f6e7b0"/>'),
  clock: S('<circle cx="24" cy="26" r="16" fill="#f2eadb"/><path d="M24 26V16M24 26l7 4"/><path d="M14 8l-5 4M34 8l5 4"/>'),
  brave: S('<path d="M24 5 L39 11 C39 26 34 36 24 43 C14 36 9 26 9 11Z" fill="#d8a7a7"/><path d="M24 15l2.6 5.6 6 .7-4.5 4.2 1.2 6L24 28.6 18.7 31.5l1.2-6-4.5-4.2 6-.7z" fill="#f2eadb" stroke-width="2.2"/>'),
  clever: S('<path d="M24 5c-8 0-13 6-13 13 0 6 4 9 6 12 1 2 1 4 1 5h12c0-1 0-3 1-5 2-3 6-6 6-12 0-7-5-13-13-13z" fill="#f6e7b0"/><path d="M18 40h12M20 44h8M24 35v-9l-4-4M24 26l4-4" stroke-width="2.4"/>'),
  kind: S('<path d="M8 30c4-2 8-2 12 1l8 5c2 1 1 4-1 4H16" fill="#a9bfa0"/><path d="M8 30v12M8 40c4 0 6 1 9 2h13c3 0 7-3 12-8 1-2-1-4-3-3l-8 5" /><path d="M30 22c-6-4-8-7-7-10 1-3 5-4 7-1 2-3 6-2 7 1 1 3-1 6-7 10z" fill="#d8a7a7" stroke-width="2.4"/>'),
  boot: S('<path d="M15 6h12v20l11 6c3 2 3 6 3 8H9V6z" fill="#b4abc6"/><path d="M9 40h32M15 14h12"/>'),
  sleep: S('<path d="M10 12h10L10 24h10M26 20h8l-8 10h8M34 6h6l-6 8h6" stroke-width="2.6"/>'),
  check: S('<path d="M8 26l10 10L40 12" stroke-width="5" stroke="#4d6b47"/>'),
  sound: S('<path d="M8 19h8l10-8v26l-10-8H8z" fill="#f2eadb"/><path d="M32 17c3 3 3 11 0 14M36 12c6 6 6 18 0 24"/>'),
  mute: S('<path d="M8 19h8l10-8v26l-10-8H8z" fill="#f2eadb"/><path d="M33 19l9 10M42 19l-9 10"/>'),
  speak: S('<path d="M8 19h8l10-8v26l-10-8H8z" fill="#a9bfa0"/><path d="M32 17c3 3 3 11 0 14M36 12c6 6 6 18 0 24"/>'),
  menu: S('<path d="M9 14h30M9 24h30M9 34h30" stroke-width="3.6"/>'),
  close: S('<path d="M12 12l24 24M36 12L12 36" stroke-width="4"/>'),
  left: S('<path d="M30 9L15 24l15 15" stroke-width="4"/>'),
  right: S('<path d="M18 9l15 15-15 15" stroke-width="4"/>'),
  up: S('<path d="M9 30l15-15 15 15" stroke-width="4"/>'),
  share: S('<path d="M24 30V6M15 14l9-9 9 9" /><path d="M12 22H8v20h32V22h-4" fill="none"/>'),
  copy: S('<rect x="14" y="14" width="24" height="26" rx="3" fill="#f2eadb"/><path d="M10 32V8h22"/>'),
  camera: S('<path d="M6 16h8l4-6h12l4 6h8v24H6z" fill="#f2eadb"/><circle cx="24" cy="27" r="7" fill="#b4abc6"/>'),
  dice: S('<rect x="6" y="10" width="22" height="22" rx="4" fill="#f2eadb" transform="rotate(-10 17 21)"/><circle cx="12" cy="17" r="2" fill="#2a2328"/><circle cx="20" cy="24" r="2" fill="#2a2328"/><rect x="22" y="18" width="20" height="20" rx="4" fill="#d8a7a7" transform="rotate(12 32 28)"/><circle cx="27" cy="24" r="1.8" fill="#2a2328"/><circle cx="37" cy="32" r="1.8" fill="#2a2328"/><circle cx="32" cy="28" r="1.8" fill="#2a2328"/>'),
  guide: S('<path d="M10 40V12c6-4 12-4 14 0 2-4 8-4 14 0v28c-6-3-12-3-14 0-2-3-8-3-14 0z" fill="#b4abc6"/><path d="M24 12v28"/>'),
  back: S('<path d="M30 10L16 24l14 14" fill="none" stroke-width="4"/>'),
  log: S('<path d="M12 6h20l6 6v30H12z" fill="#f2eadb"/><path d="M17 18h16M17 25h16M17 32h10"/>'),
  crown: S('<path d="M8 36l-2-20 10 8 8-14 8 14 10-8-2 20z" fill="#f6e7b0"/><path d="M8 40h32"/>'),
  pocket: S('<path d="M8 12h32v12c0 10-7 18-16 18S8 34 8 24z" fill="#b4abc6"/><path d="M8 12c5 6 27 6 32 0"/>'),
  sparkle: S('<path d="M24 6v8M24 34v8M6 24h8M34 24h8M12 12l5 5M31 31l5 5M36 12l-5 5M17 31l-5 5" stroke-width="3.4"/>'),
  install: S('<path d="M24 6v24M14 20l10 10 10-10"/><path d="M8 34v8h32v-8"/>'),
  qr: S('<rect x="7" y="7" width="13" height="13" fill="#f2eadb"/><rect x="28" y="7" width="13" height="13" fill="#f2eadb"/><rect x="7" y="28" width="13" height="13" fill="#f2eadb"/><path d="M28 28h5v5h-5zM36 36h5v5h-5zM36 28h5M28 41h4"/>'),
  foe: S('<path d="M10 36c0-12 6-22 14-22s14 10 14 22z" fill="#b4abc6"/><path d="M17 22l5 3M31 22l-5 3M19 31c3-2 7-2 10 0"/>'),
  walk: S('<path d="M16 8c3 0 5 2 5 4s-2 4-5 4-5-2-5-4 2-4 5-4z" fill="#a9bfa0"/><path d="M26 22c3 0 5 2 5 4s-2 4-5 4-5-2-5-4 2-4 5-4zM18 34c3 0 5 2 5 4s-2 4-5 4-5-2-5-4 2-4 5-4z" fill="#a9bfa0"/>'),
  pause: S('<rect x="12" y="10" width="8" height="28" rx="2" fill="#b4abc6"/><rect x="28" y="10" width="8" height="28" rx="2" fill="#b4abc6"/>'),
  play: S('<path d="M14 9l24 15-24 15z" fill="#a9bfa0"/>'),
  say: S('<path d="M8 10h32v20H22l-9 8v-8H8z" fill="#f2eadb"/><path d="M15 18h18M15 24h11" stroke-width="2.4"/>'),
  flag: S('<path d="M12 42V6"/><path d="M12 8h24l-5 8 5 8H12" fill="#d8a7a7"/>'),
  gear: S('<circle cx="24" cy="24" r="7" fill="#f2eadb"/><path d="M24 5v7M24 36v7M5 24h7M36 24h7M10.5 10.5l5 5M32.5 32.5l5 5M37.5 10.5l-5 5M15.5 32.5l-5 5" stroke-width="3.4"/>'),
  eye: S('<path d="M4 24c6-10 13-14 20-14s14 4 20 14c-6 10-13 14-20 14S10 34 4 24z" fill="#f2eadb"/><circle cx="24" cy="24" r="6" fill="#b4abc6"/>'),
  hand: S('<path d="M16 26V12c0-3 4-3 4 0v10V8c0-3 4-3 4 0v14V10c0-3 4-3 4 0v14-8c0-3 4-3 4 0v14c0 8-5 14-12 14-6 0-9-4-12-9l-4-7c-1-3 2-5 4-3z" fill="#a9bfa0"/>'),
  next: S('<path d="M8 24h28M26 12l12 12-12 12" stroke-width="4"/>'),
  help: S('<circle cx="24" cy="24" r="18" fill="#f2eadb"/><path d="M18 19c0-4 3-6 6-6s6 2 6 6c0 5-6 5-6 10" stroke-width="3.4"/><circle cx="24" cy="35" r="1.8" fill="#2a2328"/>'),
  leave: S('<path d="M20 8H8v32h12"/><path d="M18 24h22M32 16l8 8-8 8" stroke-width="3.4"/>'),
  target: S('<circle cx="24" cy="24" r="17" fill="#f2eadb"/><circle cx="24" cy="24" r="9" fill="#d8a7a7"/><circle cx="24" cy="24" r="2.5" fill="#2a2328"/>'),
  card: S('<rect x="11" y="6" width="26" height="36" rx="3" fill="#b4abc6" transform="rotate(-8 24 24)"/><path d="M24 17l2.5 5 5 .6-3.7 3.4 1 5L24 28.5 19.2 31l1-5-3.7-3.4 5-.6z" fill="#f6e7b0" stroke-width="2"/>'),
  plus: S('<circle cx="24" cy="24" r="17" fill="#e6eee2"/><path d="M24 15v18M15 24h18" stroke-width="4"/>'),
  minus: S('<circle cx="24" cy="24" r="17" fill="#f6e3e1"/><path d="M15 24h18" stroke-width="4"/>'),
  search: S('<circle cx="20" cy="20" r="11" fill="#f2eadb"/><path d="M28 28l12 12" stroke-width="5"/>'),
  trash: S('<path d="M12 14h24l-2 26H14z" fill="#f2eadb"/><path d="M8 14h32M19 14V8h10v6M20 21v13M28 21v13"/>'),
};

/** Icon names the rules use → our drawings. */
const ALIAS: Record<string, string> = {
  calm: 'kind', attack: 'brave', heal: 'heart', ko: 'sleep', event: 'card', give: 'gift', grab: 'hand', inspect: 'eye', item: 'pocket', knack: 'sparkle', reveal: 'twinkle',
  revive: 'heart', roll: 'dice', present: 'gift', goal: 'gift', spark: 'twinkle', sparks: 'twinkle', time: 'clock',
};

export function icon(name: string, cls = 'ic'): HTMLElement {
  if (!ICONS[name] && ALIAS[name]) name = ALIAS[name];
  if (ICONS[name]) return svg(ICONS[name], cls);
  // engine/pack icons may be emoji; unknown icon names fall back to a sparkle
  if (/^[\w-]+$/.test(name)) return svg(ICONS.sparkle, cls);
  const s = document.createElement('span');
  s.className = cls + ' emo';
  s.textContent = name || '•';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export const traitIcon = (t: Trait, cls = 'ic') => icon(t, cls);
