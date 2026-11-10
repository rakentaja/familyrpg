// App shell: owns the store/net lifecycle and switches between Home, Lobby and Play.
import type { BoardView, BoardCallbacks, NetApi, RoomInfo } from '../contracts';
import type { GameState, Pack, Vec } from '../engine/types';
import * as engine from '../engine';
import { createNostrNet } from '../net/nostr';
import { createLocalNet } from '../net/local';
import { createStore, clearSession, loadSession, type StoreRole } from '../store';
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { homeScreen, myName, myColor } from './home';
import { lobbyScreen } from './lobby';
import { playScreen } from './play';
import { toast, sfx, stopSpeaking } from './feedback';
import { keepAwake, banner } from './pwa';
import { safe } from './common';

type Screen = { el: HTMLElement; update?(s: GameState, prev: GameState | null): void; destroy?(): void };
type PlayScreen = ReturnType<typeof playScreen>;

export function createApp(opts: { pack: Pack; board: BoardView; root: HTMLElement; boardReady: Promise<void>; progress(cb: (p: number) => void): void }) {
  const { pack, board, root } = opts;
  let screen: Screen | null = null;
  let screenKind: 'home' | 'lobby' | 'play' | 'joining' | null = null;
  let net: NetApi | null = null;
  let unsub: (() => void) | null = null;
  let offs: (() => void)[] = [];
  let progress = 0;
  const progressCbs = new Set<(p: number) => void>();
  opts.progress((p) => { progress = p; for (const cb of progressCbs) cb(p); });
  let boardShown = false;

  const ctx: Ctx = {
    pack, board, root,
    store: null,
    get me() { return net?.myId ?? 'local'; },
    get boardProgress() { return progress; },
    set boardProgress(v: number) { progress = v; },
    boardReady: opts.boardReady,
    onBoardProgress(cb) { progressCbs.add(cb); },
    hostOnline, join, playLocal, leave, playAgain,
  };

  // ---------------------------------------------------------------- board callbacks (forwarded to the play screen)
  const callbacks: BoardCallbacks = {
    onCellTap: (c: Vec) => (screen as PlayScreen | null)?.onCellTap?.(c),
    onHeroTap: (id: string) => (screen as PlayScreen | null)?.onHeroTap?.(id),
    onFoeTap: (id: string) => (screen as PlayScreen | null)?.onFoeTap?.(id),
    onTokenTap: (id: string) => (screen as PlayScreen | null)?.onTokenTap?.(id),
  };

  function show(kind: typeof screenKind, next: Screen) {
    screen?.destroy?.();
    screen?.el.remove();
    for (const m of [...root.querySelectorAll('.modal.creator, .modal.scan')]) m.remove();
    screen = next; screenKind = kind;
    root.prepend(next.el);
    document.body.dataset.screen = kind ?? '';
  }

  function goHome(joinCode?: string) {
    keepAwake(false);
    document.body.classList.remove('board-on');
    boardShown = false;
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
  function attach(role: StoreRole, n: NetApi, state: GameState | null) {
    detach(false);
    net = n;
    const store = createStore({ pack, net: n, role, state });
    ctx.store = store;
    offs.push(store.onError((m) => toast(m, 'error')));
    offs.push(n.onStatus((st) => banner('net', role !== 'local' && st === 'connecting' ? 'Reconnecting…' : null, undefined, 'warn')));
    // host stepped down (another device took over) → become a client
    const nn = n as NetApi & { onInfo?(cb: (i: RoomInfo | null) => void): () => void; setName?(name: string): void };
    nn.setName?.(myName());
    if (nn.onInfo && role === 'host') {
      offs.push(nn.onInfo((info) => {
        if (info && !info.isHost && ctx.store?.role === 'host') { toast('Another device is hosting now'); attach('client', n, ctx.store.state); }
      }));
    }
    let joinSent = 0;
    unsub = store.subscribe((s, prev) => {
      // clients announce themselves until the host lists them (also after "Play again")
      if (role === 'client' && !s.players.some((p) => p.id === n.myId) && Date.now() - joinSent > 4000) {
        joinSent = Date.now();
        store.dispatch({ t: 'join', name: myName(), color: myColor() });
      }
      render(s, prev);
    });
    if (state) render(state, null);
    else show('joining', joiningScreen('Finding the table…', () => leave()));
    if (role === 'client' && !state) {
      // nothing arrived yet: say hello anyway so the host adds us
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
    // board first, so overlays sit on a fresh picture
    if (s.phase !== 'lobby') {
      if (!boardShown) { boardShown = true; document.body.classList.add('board-on'); safe(() => board.resize(), undefined); }
      const fx = !prev || s.fx.seq !== prev.fx.seq ? s.fx.list : [];
      safe(() => board.update(s, prev && prev.phase !== 'lobby' ? prev : null, prev ? fx : []), undefined);
    } else if (boardShown) { boardShown = false; document.body.classList.remove('board-on'); }

    const kind = s.phase === 'lobby' ? 'lobby' : 'play';
    if (kind !== screenKind) {
      if (kind === 'lobby') show('lobby', lobbyScreen(ctx));
      else show('play', playScreen(ctx));
      keepAwake(kind === 'play');
    } else screen?.update?.(s, prev);
  }

  // ---------------------------------------------------------------- flows
  async function hostOnline() {
    const n = createNostrNet();
    (n as { setName?(x: string): void }).setName?.(myName());
    await n.host();
    const s = engine.createGame(pack, { hostId: n.myId, hostName: myName(), hostColor: myColor(), mode: 'guideless' });
    const store = attach('host', n, s);
    n.publishState(store.state!);
    sfx.chime();
  }

  async function join(code: string) {
    const n = createNostrNet();
    (n as { setName?(x: string): void }).setName?.(myName());
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
    const s = engine.createGame(pack, { hostId: n.myId, hostName: myName(), hostColor: myColor(), mode: 'guideless' });
    attach('local', n, s);
    sfx.chime();
  }

  function leave() {
    stopSpeaking();
    detach(true);
    clearSession();
    safe(() => board.highlight([], 'move'), undefined);
    goHome();
  }

  function playAgain() {
    const store = ctx.store;
    if (!store || !store.isHost()) return;
    const old = store.state;
    const fresh = engine.createGame(pack, { hostId: store.me, hostName: myName(), hostColor: myColor(), mode: old?.mode ?? 'guideless', adventureId: old?.adventureId });
    store.replace(fresh);
    // bring the heroes back so nobody has to start over (the host can hand them out again in the lobby)
    for (const x of old?.heroes ?? []) store.dispatch({ t: 'addHero', roleId: x.roleId, name: x.name, traits: x.traits });
    if (old?.kidMode) store.dispatch({ t: 'setKidMode', on: true });
  }

  // ---------------------------------------------------------------- boot routing
  async function start() {
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
          (n as { setName?(x: string): void }).setName?.(myName());
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
    const m = /#join=([^&]+)/.exec(location.hash);
    if (m && !ctx.store) join(decodeURIComponent(m[1])).catch((err) => toast(String(err?.message || err), 'error'));
  });

  return { ctx, callbacks, start };
}
