// In-memory NetApi for pass-and-play on one device: no sockets, everything loops back.
import type { NetApi, Peer, RoomInfo } from '../contracts';
import type { Envelope, GameState } from '../engine/types';

export function createLocalNet(): NetApi {
  const myId = 'local';
  let info: RoomInfo | null = null;
  let status: NetApi['status'] = 'offline';
  let last: GameState | null = null;

  const intents = new Set<(e: Envelope) => void>();
  const states = new Set<(s: GameState) => void>();
  const ephs = new Set<(c: string, d: unknown, from: string) => void>();
  const peers = new Set<(p: Peer[]) => void>();
  const statuses = new Set<(s: NetApi['status']) => void>();

  const add = <T>(set: Set<T>, cb: T) => { set.add(cb); return () => { set.delete(cb); }; };
  const defer = (f: () => void) => queueMicrotask(f);
  const setStatus = (s: NetApi['status']) => { status = s; statuses.forEach((cb) => cb(s)); };

  const open = (): RoomInfo => {
    info = { roomId: 'local', secret: '', link: '', isHost: true, myId };
    setStatus('online');
    return info;
  };

  return {
    myId,
    get info() { return info; },
    get status() { return status; },
    async host() { last = null; return open(); },
    async join() { return info ?? open(); },
    async claimHost() { if (!info) open(); else info = { ...info, isHost: true }; },
    sendIntent(env) { const e = { ...env }; defer(() => intents.forEach((cb) => cb(e))); },
    publishState(state) { last = state; defer(() => states.forEach((cb) => cb(state))); },
    sendEphemeral(channel, data) { defer(() => ephs.forEach((cb) => cb(channel, data, myId))); },
    onIntent: (cb) => add(intents, cb),
    onState(cb) {
      const off = add(states, cb);
      const s = last;
      if (s) defer(() => { if (states.has(cb)) cb(s); });
      return off;
    },
    onEphemeral: (cb) => add(ephs, cb),
    onPeers(cb) { const off = add(peers, cb); cb([]); return off; },
    onStatus(cb) { const off = add(statuses, cb); cb(status); return off; },
    leave() { info = null; last = null; setStatus('offline'); },
  };
}
