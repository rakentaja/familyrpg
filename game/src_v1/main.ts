// Boot: load the pack, set up the board on a full-screen canvas, register the service worker, start the app.
import type { BoardCallbacks, BoardView } from './contracts';
import type { Pack } from './engine/types';
import { createBoard } from './render/board';
import { createApp } from './ui/app';
import { injectStyles } from './ui/styles';
import { registerSW, watchOnline } from './ui/pwa';
import { prefs } from './ui/feedback';

const bootBar = document.getElementById('bootBar') as HTMLElement | null;
const bootMsg = document.getElementById('bootMsg') as HTMLElement | null;
const bootEl = document.getElementById('boot') as HTMLElement | null;
const setBoot = (p: number, msg?: string) => {
  if (bootBar) bootBar.style.width = Math.round(Math.max(0.05, Math.min(1, p)) * 100) + '%';
  if (msg && bootMsg) bootMsg.textContent = msg;
};
const hideBoot = () => { bootEl?.classList.add('gone'); setTimeout(() => bootEl?.remove(), 500); };

function preventPageZoom() {
  // the page itself never zooms (the board handles its own pinch on the canvas)
  const stop = (e: Event) => { if (!(e.target instanceof HTMLCanvasElement)) e.preventDefault(); };
  document.addEventListener('gesturestart', stop, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gesturechange', stop, { passive: false } as AddEventListenerOptions);
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && !(e.target instanceof HTMLCanvasElement)) e.preventDefault(); }, { passive: false });
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const t = e.target as HTMLElement;
    if (now - lastTouch < 300 && !(t instanceof HTMLCanvasElement) && !t.closest('input,textarea,select')) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
}

async function boot() {
  injectStyles();
  preventPageZoom();
  registerSW();
  watchOnline();
  setBoot(0.1, 'Waking the reindeer…');

  let pack: Pack;
  try {
    const r = await fetch('packs/sleighbound.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`pack ${r.status}`);
    pack = await r.json();
  } catch (err) {
    console.error(err);
    setBoot(1, 'Could not load the game. Check your connection and try again.');
    bootEl?.appendChild(Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Try again', onclick: () => location.reload() }));
    return;
  }
  setBoot(0.3, 'Unpacking the sleigh…');
  if (pack.theme?.title) document.title = pack.theme.title;

  const canvas = document.getElementById('board') as HTMLCanvasElement;
  const root = document.getElementById('ui') as HTMLElement;
  let app: ReturnType<typeof createApp> | null = null;
  const cb: BoardCallbacks = {
    onCellTap: (c) => app?.callbacks.onCellTap(c),
    onHeroTap: (id) => app?.callbacks.onHeroTap(id),
    onFoeTap: (id) => app?.callbacks.onFoeTap(id),
    onTokenTap: (id) => app?.callbacks.onTokenTap(id),
  };
  const board: BoardView = createBoard(canvas, cb);
  const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || matchMedia('(max-width: 420px)').matches && devicePixelRatio > 2.5;
  try { board.setQuality(prefs.quality ?? (lowEnd ? 'low' : 'high')); } catch { /* optional */ }

  const progressCbs = new Set<(p: number) => void>();
  const boardReady = board.load(pack, './', (p) => { for (const f of progressCbs) f(p); })
    .then(() => { for (const f of progressCbs) f(1); })
    .catch((err) => { console.error('board load', err); for (const f of progressCbs) f(1); });

  let resizeT = 0;
  const onResize = () => { cancelAnimationFrame(resizeT); resizeT = requestAnimationFrame(() => { try { board.resize(); } catch { /* ignore */ } }); };
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);
  visualViewport?.addEventListener('resize', onResize);

  app = createApp({ pack, board, root, boardReady, progress: (f) => progressCbs.add(f) });
  setBoot(1);
  hideBoot();
  await app.start();
  (window as unknown as { SB_READY: boolean }).SB_READY = true;
}

boot();
