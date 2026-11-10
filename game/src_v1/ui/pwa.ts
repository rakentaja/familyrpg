// PWA plumbing: service worker + updates, install prompt, screen wake lock, offline/reconnecting banners.
import { h } from './dom';

// ---------------------------------------------------------------- banners (top of the screen)
let bannerBox: HTMLElement | null = null;
function banners() {
  if (!bannerBox) { bannerBox = h('div', { class: 'banners' }); document.getElementById('ui')!.appendChild(bannerBox); }
  return bannerBox;
}
export function banner(id: string, text: string | null, onTap?: () => void, kind = 'info') {
  const box = banners();
  let el = box.querySelector<HTMLElement>(`[data-b="${id}"]`);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = h(onTap ? 'button' : 'div', { class: 'banner ' + kind, 'data-b': id, type: 'button' });
    if (onTap) el.addEventListener('click', onTap);
    box.appendChild(el);
  }
  el.textContent = text;
}

// ---------------------------------------------------------------- service worker
let swReg: ServiceWorkerRegistration | null = null;
const offlineListeners = new Set<(done: number, total: number) => void>();

export function registerSW() {
  const ok = 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
  if (!ok) return;
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;   // first install takes control silently
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'offline') for (const cb of offlineListeners) cb(d.done, d.total);
  });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    swReg = reg;
    const showUpdate = () => banner('update', 'Update available — tap to reload', () => reg.waiting?.postMessage({ type: 'skipWaiting' }), 'good');
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
    });
    // check for updates when the app comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('service worker', err));
}

/** Ask the service worker to download every game model for offline play. */
export function cacheAllForOffline(onProgress: (done: number, total: number) => void): boolean {
  const sw = swReg?.active || navigator.serviceWorker?.controller;
  if (!sw) return false;
  offlineListeners.add(onProgress);
  sw.postMessage({ type: 'cacheAll' });
  return true;
}
export function offlineStatus(onStatus: (done: number, total: number) => void) {
  const sw = swReg?.active || navigator.serviceWorker?.controller;
  if (!sw) return;
  const once = (d: number, t: number) => { offlineListeners.delete(once); onStatus(d, t); };
  offlineListeners.add(once);
  sw.postMessage({ type: 'offlineStatus' });
}

// ---------------------------------------------------------------- install prompt
interface BIPEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: BIPEvent | null = null;
const installListeners = new Set<() => void>();
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BIPEvent;
  for (const cb of installListeners) cb();
});
addEventListener('appinstalled', () => { deferred = null; for (const cb of installListeners) cb(); });

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export function installState(): 'prompt' | 'ios' | 'none' {
  if (isStandalone()) return 'none';
  if (deferred) return 'prompt';
  if (isIOS()) return 'ios';
  return 'none';
}
export function onInstallChange(cb: () => void) { installListeners.add(cb); return () => installListeners.delete(cb); }
export async function promptInstall() {
  if (!deferred) return;
  const d = deferred; deferred = null;
  await d.prompt();
  await d.userChoice.catch(() => null);
  for (const cb of installListeners) cb();
}

// ---------------------------------------------------------------- wake lock
interface WakeLockSentinelLike { release(): Promise<void>; released?: boolean }
let wakeWanted = false;
let sentinel: WakeLockSentinelLike | null = null;
async function acquire() {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
  if (!wl || !wakeWanted || document.visibilityState !== 'visible') return;
  try { sentinel = await wl.request('screen'); } catch { /* battery saver etc. */ }
}
document.addEventListener('visibilitychange', () => { if (wakeWanted && document.visibilityState === 'visible') acquire(); });
export function keepAwake(on: boolean) {
  if (on === wakeWanted) return;
  wakeWanted = on;
  if (on) acquire();
  else { sentinel?.release().catch(() => {}); sentinel = null; }
}

// ---------------------------------------------------------------- offline banner
export function watchOnline() {
  const upd = () => banner('offline', navigator.onLine ? null : 'You are offline — play on this device still works', undefined, 'warn');
  addEventListener('online', upd); addEventListener('offline', upd); upd();
}
