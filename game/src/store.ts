// Store: glue between the rules engine and the network.
//   host / local → engine.reduce(state, {...action, by: me}) and publish the new state
//   client       → send the intent to the host and wait for the next published state
import type { Store, NetApi, RoomInfo } from './contracts';
import type { Action, Envelope, GameState, Pack } from './engine/types';
import * as engine from './engine';

export type StoreRole = 'host' | 'client' | 'local';

export interface SavedSession {
  role: StoreRole;
  link?: string;                 // join link / code for online tables
  info?: RoomInfo | null;
  state?: GameState | null;      // host + local only
  me: string;
  at: number;
}

const SESSION_KEY = 'sb.session';
const MAX_AGE = 1000 * 60 * 60 * 18;   // a table older than this is not resumed automatically

export function loadSession(): SavedSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as SavedSession | null;
    if (!s || Date.now() - s.at > MAX_AGE) return null;
    return s;
  } catch { return null; }
}
export function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } }

export interface AppStore extends Store {
  readonly role: StoreRole;
  readonly net: NetApi;
  /** Replace the whole state (host/local only), e.g. a fresh game for "Play again". Publishes it. */
  replace(s: GameState): void;
  /** Errors from reduce (host/local) or reported back by the host (client). */
  onError(cb: (msg: string) => void): () => void;
  /** Stop listening to the network (the net itself is left to the caller). */
  close(): void;
}

export function createStore(opts: { pack: Pack; net: NetApi; role: StoreRole; state?: GameState | null }): AppStore {
  const { pack, net, role } = opts;
  const subs = new Set<(s: GameState, prev: GameState | null) => void>();
  const errSubs = new Set<(m: string) => void>();
  const offs: (() => void)[] = [];
  const authoritative = role !== 'client';
  let saveTimer = 0;

  const emitError = (m: string) => { for (const cb of errSubs) cb(m); };

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const s: SavedSession = {
        role, me: net.myId, at: Date.now(),
        info: net.info, link: net.info?.link,
        state: authoritative ? store.state : null,
      };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
    }, 120) as unknown as number;
  };

  const set = (next: GameState) => {
    const prev = store.state;
    store.state = next;
    for (const cb of [...subs]) {
      try { cb(next, prev); } catch (err) { console.error(err); }
    }
    save();
  };

  const apply = (env: Envelope): boolean => {
    const cur = store.state;
    if (!cur) return false;
    let res: ReturnType<typeof engine.reduce>;
    try { res = engine.reduce(cur, env, pack); } catch (err) { console.error(err); res = { ok: false, error: 'Something went wrong.', state: cur }; }
    if (!res.ok) {
      if (env.by === net.myId) emitError(res.error || 'That can’t be done right now.');
      else net.sendEphemeral('err', { to: env.by, error: res.error || 'That can’t be done right now.' });
      return false;
    }
    if (res.state !== cur) {
      set(res.state);
      if (role === 'host') net.publishState(res.state);
    }
    return true;
  };

  const store: AppStore = {
    pack, role, net,
    get me() { return net.myId; },
    state: opts.state ?? null,
    dispatch(a: Action) {
      const env = { ...a, by: net.myId } as Envelope;
      if (authoritative) apply(env);
      else net.sendIntent(env);
    },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    isHost() { return authoritative; },
    replace(s) {
      if (!authoritative) return;
      set(s);
      if (role === 'host') net.publishState(s);
    },
    onError(cb) { errSubs.add(cb); return () => errSubs.delete(cb); },
    close() { for (const o of offs.splice(0)) o(); clearTimeout(saveTimer); },
  };

  if (role === 'host') {
    offs.push(net.onIntent((env) => { apply(env); }));
  }
  if (role === 'client') {
    offs.push(net.onState((s) => {
      const cur = store.state;
      // Accept newer states; also accept a brand-new table (host pressed "Play again").
      const fresh = !cur || s.v > cur.v || (s.phase === 'lobby' && cur.phase !== 'lobby' && s.v < cur.v);
      if (fresh) set(s);
    }));
    offs.push(net.onEphemeral((ch, data) => {
      const d = data as { to?: string; error?: string };
      if (ch === 'err' && d && d.to === net.myId && d.error) emitError(d.error);
    }));
  }
  if (store.state) save();
  return store;
}
