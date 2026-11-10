// Boot: load the pack, put the 3D table on a full-screen canvas, register the service worker, start the app.
import type { SceneCallbacks, SceneView } from './contracts';
import type { Pack } from './rules/types';
import { createScene } from './scene/scene';
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
  // the page itself never zooms (the scene handles its own pinch on the canvas)
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
  // right-click on the table opens the ring menu, not the browser menu
  document.addEventListener('contextmenu', (e) => { if (e.target instanceof HTMLCanvasElement) e.preventDefault(); });
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
  const cb: SceneCallbacks = {
    onTap: (hit) => app?.callbacks.onTap(hit),
    onHold: (hit, at) => app?.callbacks.onHold(hit, at),
    canDrag: (hit) => app?.callbacks.canDrag(hit) ?? false,
    onDrag: (hit, at, phase) => app?.callbacks.onDrag(hit, at, phase),
    onDiceThrown: (t) => app?.callbacks.onDiceThrown(t),
  };
  const scene: SceneView = createScene(canvas, cb);
  if (new URLSearchParams(location.search).has('debug')) {             // test/debug handle: ?debug
    (window as unknown as Record<string, unknown>).__sb = { scene, cb, get state() { return app?.ctx.store?.state ?? null; } };
  }
  const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || (matchMedia('(max-width: 420px)').matches && devicePixelRatio > 2.5);
  try { scene.setQuality(prefs.quality ?? (lowEnd ? 'low' : 'high')); } catch { /* optional */ }

  const progressCbs = new Set<(p: number) => void>();
  const sceneReady = scene.load(pack, './', (p) => { for (const f of progressCbs) f(p); })
    .then(() => { for (const f of progressCbs) f(1); })
    .catch((err) => { console.error('scene load', err); for (const f of progressCbs) f(1); });

  let resizeT = 0;
  const onResize = () => { cancelAnimationFrame(resizeT); resizeT = requestAnimationFrame(() => { try { scene.resize(); } catch { /* ignore */ } }); };
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);
  visualViewport?.addEventListener('resize', onResize);

  app = createApp({ pack, scene, root, sceneReady, progress: (f) => progressCbs.add(f) });
  setBoot(1);
  hideBoot();
  await app.start();
  (window as unknown as { SB_READY: boolean }).SB_READY = true;
}

boot();
