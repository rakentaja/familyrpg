// App shell: owns the store/net lifecycle and switches between Home, Lobby and the game (the 3D table).
import type { NetApi, RoomInfo, SceneCallbacks, SceneView } from '../contracts';
import type { Adventure, GameState, Pack } from '../rules/types';
import { rules } from '../rules';
import { createNostrNet } from '../net/nostr';
import { createLocalNet } from '../net/local';
import { createStore, clearSession, loadSession, type AppStore, type StoreRole } from '../store';
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { homeScreen, myName, myColor } from './home';
import { lobbyScreen } from './lobby';
import { playScreen, type PlayScreen } from './play';
import { toast, sfx, stopSpeaking } from './feedback';
import { keepAwake } from './pwa';
import { safe } from './common';
import { adventuresScreen } from './advscreen';
import { getAdventure } from './adventures';

type Screen = { el: HTMLElement; update?(s: GameState, prev: GameState | null): void; destroy?(): void };
type NetExtras = NetApi & { onInfo?(cb: (i: RoomInfo | null) => void): () => void; setName?(name: string): void };

export function createApp(opts: { pack: Pack; scene: SceneView; root: HTMLElement; sceneReady: Promise<void>; progress(cb: (p: number) => void): void }) {
  const { pack, scene, root } = opts;
  let screen: Screen | null = null;
  let screenKind: 'home' | 'lobby' | 'play' | 'joining' | 'adventures' | null = null;
  let net: NetApi | null = null;
  let unsub: (() => void) | null = null;
  const offs: (() => void)[] = [];
  let progress = 0;
  const progressCbs = new Set<(p: number) => void>();
  opts.progress((p) => { progress = p; for (const cb of [...progressCbs]) cb(p); });
  let sceneShown = false;

  const ctx: Ctx = {
    pack, scene, root,
    store: null,
    get me() { return net?.myId ?? 'local'; },
    get sceneProgress() { return progress; },
    sceneReady: opts.sceneReady,
    onSceneProgress(cb) { progressCbs.add(cb); return () => { progressCbs.delete(cb); }; },
    hostOnline, join, playLocal, leave, playAgain, openAdventures, editAdventure,
  };

  // ---------------------------------------------------------------- scene callbacks → the play screen
  const play = () => (screenKind === 'play' ? (screen as PlayScreen) : null);
  const callbacks: SceneCallbacks = {
    onTap: (hit) => play()?.callbacks.onTap(hit),
    onHold: (hit, at) => play()?.callbacks.onHold(hit, at),
    canDrag: (hit) => play()?.callbacks.canDrag(hit) ?? false,
    onDrag: (hit, at, phase) => play()?.callbacks.onDrag(hit, at, phase),
    onDiceThrown: (t) => play()?.callbacks.onDiceThrown(t),
  };

  function show(kind: typeof screenKind, next: Screen) {
    screen?.destroy?.();
    screen?.el.remove();
    for (const m of [...root.querySelectorAll('.modal.creator, .modal.scan')]) m.remove();
    screen = next; screenKind = kind;
    root.prepend(next.el);
    document.body.dataset.screen = kind ?? '';
  }

  function setSceneVisible(on: boolean) {
    if (on === sceneShown) return;
    sceneShown = on;
    document.body.classList.toggle('scene-on', on);
    if (on) safe(() => scene.resize(), undefined);
  }

  function goHome(joinCode?: string) {
    keepAwake(false);
    setSceneVisible(false);
    show('home', homeScreen(ctx, { joinCode }));
  }

  function joiningScreen(text: string, onCancel: () => void): Screen {
    return {
      el: h('section', { class: 'screen joining' },
        h('div', { class: 'paper sheet-card center' },
          h('div', { class: 'spinner', 'aria-hidden': 'true' }),
          h('h2', null, text),
          btn('Cancel', onCancel, 'ghost'))),
    };
  }

  // ---------------------------------------------------------------- store wiring
  function attach(role: StoreRole, n: NetApi, state: GameState | null): AppStore {
    detach(false);
    net = n;
    const store = createStore({ pack, net: n, role, state });
    ctx.store = store;
    offs.push(store.onError((m) => toast(m, 'error')));
    const nn = n as NetExtras;
    nn.setName?.(myName());
    // host stepped down (another device took over) → become a client
    if (nn.onInfo && role === 'host') {
      offs.push(nn.onInfo((info) => {
        if (info && !info.isHost && ctx.store?.role === 'host') { toast('Another device is hosting now'); attach('client', n, ctx.store.state); }
      }));
    }
    let joinSent = 0;
    unsub = store.subscribe((s, prev) => {
      // clients announce themselves until the host lists them (also after "Play again")
      if (role === 'client' && prev !== s && !s.players.some((p) => p.id === n.myId) && Date.now() - joinSent > 4000) {
        joinSent = Date.now();
        store.dispatch({ t: 'join', name: myName(), color: myColor() });
      }
      render(s, prev);
    });
    if (state) render(state, null);
    else show('joining', joiningScreen('Finding the table…', () => leave()));
    if (role === 'client' && !state) {
      setTimeout(() => { if (ctx.store === store && !store.state) store.dispatch({ t: 'join', name: myName(), color: myColor() }); }, 1500);
      setTimeout(() => { if (ctx.store === store && !store.state) toast('Still looking… is the host’s app open?'); }, 12000);
    }
    return store;
  }

  function detach(leaveNet: boolean) {
    unsub?.(); unsub = null;
    for (const o of offs.splice(0)) o();
    ctx.store?.close();
    ctx.store = null;
    if (leaveNet) { net?.leave(); net = null; }
  }

  function render(s: GameState, prev: GameState | null) {
    const inGame = s.phase !== 'lobby';
    // scene first, so overlays sit on a fresh picture
    if (inGame) {
      setSceneVisible(true);
      const tick = prev === s;
      const fx = !tick && prev && s.fx.seq !== prev.fx.seq ? s.fx.list : [];
      safe(() => scene.update(s, prev && prev.phase !== 'lobby' ? prev : null, fx), undefined);
    } else setSceneVisible(false);

    const kind = inGame ? 'play' : 'lobby';
    if (kind !== screenKind) {
      show(kind, kind === 'lobby' ? lobbyScreen(ctx) : playScreen(ctx));
      keepAwake(kind === 'play');
    } else screen?.update?.(s, prev);
  }

  /** A fresh table. The host (this device) is the Guide unless rules picked someone already.
   *  Uses my edited version of an adventure if I have one. */
  function freshGame(hostId: string, adventureId?: string, adventure?: Adventure): GameState {
    const adv = adventure ?? getAdventure(pack, adventureId ?? pack.adventures[0]?.id ?? '') ?? undefined;
    return rules.createGame(pack, { hostId, hostName: myName(), hostColor: myColor(), at: Date.now(), adventureId, adventure: adv });
  }

  /** My adventures (from the home screen, or the editor's Done). */
  function openAdventures(importCode?: string) {
    if (ctx.store) { stopSpeaking(); detach(true); clearSession(); }
    keepAwake(false);
    setSceneVisible(false);
    show('adventures', adventuresScreen(ctx, { importCode, back: () => goHome() }));
  }

  /** The scene editor: a local table with just me (host + Guide), no heroes, opened on scene 1. */
  async function editAdventure(adv: Adventure) {
    const n = createLocalNet();
    await n.host().catch(() => null);
    const s0 = freshGame(n.myId, adv.id, adv);
    const res = rules.reduce(s0, { t: 'edit', by: n.myId, at: Date.now() }, pack);
    if (!res.ok) { toast(res.error || 'Could not open the editor', 'error'); n.leave(); return; }
    attach('local', n, res.state);
  }
  function ensureGuide(store: AppStore) {
    const s = store.state;
    if (s && !s.players.some((p) => p.guide)) store.dispatch({ t: 'setGuide', playerId: store.me });
  }

  // ---------------------------------------------------------------- flows
  async function hostOnline() {
    const n = createNostrNet();
    n.setName(myName());
    await n.host();
    const store = attach('host', n, freshGame(n.myId));
    ensureGuide(store);
    n.publishState(store.state!);
    sfx.chime();
  }

  async function join(code: string) {
    const n = createNostrNet();
    n.setName(myName());
    let cancelled = false;
    show('joining', joiningScreen('Knocking on the door…', () => { cancelled = true; n.leave(); goHome(); }));
    try { await n.join(code); }
    catch (err) { n.leave(); goHome(code); throw err; }
    if (cancelled) return;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    attach('client', n, null);
  }

  async function playLocal() {
    const n = createLocalNet();
    await n.host().catch(() => null);
    const store = attach('local', n, freshGame(n.myId));
    ensureGuide(store);
    sfx.chime();
  }

  function leave() {
    stopSpeaking();
    detach(true);
    clearSession();
    goHome();
  }

  function playAgain() {
    const store = ctx.store;
    if (!store || !store.isHost()) return;
    const old = store.state;
    const fresh = freshGame(store.me, old?.adventureId, old?.adv);
    // keep the family together: same players (and Guide), same settings, same heroes
    if (old?.players.length) fresh.players = old.players.map((p) => ({ ...p }));
    if (old?.settings) fresh.settings = { ...old.settings };
    store.replace(fresh);
    ensureGuide(store);
    for (const x of old?.heroes ?? []) store.dispatch({ t: 'addHero', roleId: x.roleId, name: x.name, traits: x.traits, owner: x.owner });
  }

  // ---------------------------------------------------------------- boot routing
  async function start() {
    const adv = /#adv=([^&]+)/.exec(location.hash);
    if (adv) {
      history.replaceState(null, '', location.pathname + location.search);
      openAdventures(decodeURIComponent(adv[1]!));
      return;
    }
    const m = /#join=([^&]+)/.exec(location.hash);
    if (m) {
      const code = decodeURIComponent(m[1]);
      goHome(code);
      try { await join(code); } catch (err) { toast(String((err as Error)?.message || 'Could not find that table'), 'error'); }
      return;
    }
    const saved = loadSession();
    if (saved && (saved.role === 'local' || saved.link || saved.info)) {
      try {
        if (saved.role === 'local' && saved.state) {
          const n = createLocalNet(); await n.host().catch(() => null);
          attach('local', n, saved.state);
          toast('Welcome back! Your game is just where you left it.', 'good');
          return;
        }
        const code = saved.info?.roomId || saved.link!;
        if (saved.role === 'host' && saved.state) {
          const n = createNostrNet();
          n.setName(myName());
          show('joining', joiningScreen('Reopening your table…', () => { n.leave(); clearSession(); goHome(); }));
          await n.join(code);
          await n.claimHost();
          const store = attach('host', n, saved.state);
          n.publishState(store.state!);
          toast('Welcome back! Your table is open again.', 'good');
          return;
        }
        if (saved.role === 'client') { await join(code); return; }
      } catch (err) {
        console.warn('resume failed', err);
        detach(true);
        toast('Could not reopen the last table', 'error');
      }
    }
    goHome();
  }

  addEventListener('hashchange', () => {
    const a = /#adv=([^&]+)/.exec(location.hash);
    if (a && !ctx.store) { history.replaceState(null, '', location.pathname + location.search); openAdventures(decodeURIComponent(a[1]!)); return; }
    const m = /#join=([^&]+)/.exec(location.hash);
    if (m && !ctx.store) join(decodeURIComponent(m[1])).catch((err) => toast(String(err?.message || err), 'error'));
  });

  return { ctx, callbacks, start };
}
