// Multiplayer over public Nostr relays. No backend, no login.
//
// Identity: one Nostr keypair per device (localStorage). myId = pubkey hex.
// Room:     human code "SNOW-7KQ-M4X-P2A" → public tag sha256('<app>:room:'+code) for relay routing,
//           and an AES-GCM key (HKDF) — every payload is encrypted, relays only see ciphertext.
// Events:   kind 30078 (NIP-78, parameterized replaceable) ['d', tag]  — latest state snapshot per publisher
//           kind 21078 (ephemeral)                          ['t', tag]  — intent / hello / presence / bye / eph
import { AbstractRelay, type Subscription } from 'nostr-tools/abstract-relay';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import type { NetApi, Peer, RoomInfo } from '../contracts';
import type { Envelope, GameState } from '../engine/types';
import {
  activePeers, backoffMs, batchItems, decryptPayload, deriveRoomKey, encryptPayload, fromHex, generateRoomCode,
  isFresh, isNewerSnapshot, joinLink, parseJoinInput, roomTag, SeenSet, toHex, type SnapshotMeta,
} from './codec';

export const KIND_SNAPSHOT = 30078;
export const KIND_EPHEMERAL = 21078;

// Checked 2026-11-10 with smoke.ts (ephemeral 21078 + kind 30078 store/fetch/live):
// primal, snort, nostr.net passed end-to-end; damus works but bans IPs that exceed its rate limit;
// nos.lol is widely used but timed out from the test network. offchain.pub rejects unknown pubkeys (web of trust).
export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.nostr.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

const STATE_DEBOUNCE_MS = 150;
const STATE_REPUBLISH_MS = 25_000;
const HEARTBEAT_MS = 10_000;
const PEER_WINDOW_MS = 30_000;
const INTENT_MAX_AGE_S = 120;
const EPH_FLUSH_MS = 100;             // ≤ 10 ephemeral events/s per device (a whole family often shares one IP)
const SNAPSHOT_WARN_BYTES = 60_000;
const SNAPSHOT_TTL_S = 14 * 24 * 3600; // NIP-40 expiration so relays can drop old tables
const JOIN_WAIT_MS = 4_000;
const MAX_QUEUED_INTENTS = 50;

type Status = NetApi['status'];

type Msg =
  | { type: 'intent'; env: Envelope }
  | { type: 'hello'; name?: string }
  | { type: 'presence'; name?: string; host?: boolean }
  | { type: 'bye' }
  | { type: 'eph'; items: { c: string; d: unknown }[] };

interface SnapshotBody { state: GameState }

export interface NostrNetOptions {
  relays?: string[];
  appTag?: string;
  baseUrl?: string;
  /** Override the device key (hex). Mostly for tests/scripts; browsers use localStorage. */
  secretKeyHex?: string;
  /** Called with the relay URL whenever a room event arrives through it, duplicates included (diagnostics). */
  onRelayEvent?: (relay: string, eventId: string) => void;
}

/** Extra methods beyond NetApi. */
export interface NostrNet extends NetApi {
  /** Display name sent with hello/presence. */
  setName(name: string): void;
  /** Fires when info changes (host/join/claimHost/step-down). */
  onInfo(cb: (info: RoomInfo | null) => void): () => void;
  /** Relays currently connected. */
  connectedRelays(): string[];
  /** The last room this device was in (code + whether it was host), for "resume" buttons. */
  lastRoom(): { code: string; wasHost: boolean } | null;
}

// ---------------------------------------------------------------- storage helpers
function store(): Storage | null {
  try { return (globalThis as any).localStorage ?? null; } catch { return null; }
}
function loadKey(appTag: string, override?: string): Uint8Array {
  if (override) return fromHex(override);
  const ls = store();
  const k = `${appTag}:device-key`;
  try {
    const hex = ls?.getItem(k);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return fromHex(hex);
  } catch { /* ignore */ }
  const sk = generateSecretKey();
  try { ls?.setItem(k, toHex(sk)); } catch { /* ignore */ }
  return sk;
}

function defaultBase(): string {
  const loc = (globalThis as any).location;
  return loc ? `${loc.origin}${loc.pathname}` : '';
}

// ---------------------------------------------------------------- relay connection
class RelayConn {
  relay: AbstractRelay | null = null;
  sub: Subscription | null = null;
  attempt = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  connecting = false;
  stopped = true;
  constructor(readonly url: string, private net: NostrNetImpl) {}

  get connected(): boolean { return !!this.relay?.connected; }

  start() { this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = this.relay;
    this.relay = null; this.sub = null;
    if (r) { r.onclose = null; try { r.close(); } catch { /* ignore */ } }
  }

  /** Force a fresh socket now (page resumed; sockets may be silently dead). */
  kick() {
    if (this.stopped) return;
    this.attempt = 0;
    const r = this.relay;
    this.relay = null; this.sub = null;
    if (r) { r.onclose = null; try { r.close(); } catch { /* ignore */ } }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.connecting = false;
    void this.connect();
  }

  private async connect() {
    if (this.stopped || this.connecting || this.connected) return;
    this.connecting = true;
    this.net.refreshStatus();
    const r = new AbstractRelay(this.url, { verifyEvent });
    r.onnotice = () => {};
    try {
      await r.connect();
    } catch {
      this.connecting = false;
      try { r.close(); } catch { /* ignore */ }
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    if (this.stopped) { try { r.close(); } catch { /* ignore */ } return; }
    this.relay = r;
    this.attempt = 0;
    r.onclose = () => {
      if (this.relay !== r) return;
      this.relay = null; this.sub = null;
      this.net.refreshStatus();
      this.scheduleReconnect();
    };
    this.subscribe();
    this.net.refreshStatus();
    this.net.relayConnected(this);
  }

  private scheduleReconnect() {
    this.net.refreshStatus();
    if (this.stopped || this.timer) return;
    const d = backoffMs(this.attempt++);
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, d);
  }

  private subscribe() {
    const r = this.relay;
    const tag = this.net.tag;
    if (!r || !tag) return;
    const now = Math.floor(Date.now() / 1000);
    this.sub = r.subscribe(
      [
        { kinds: [KIND_SNAPSHOT], '#d': [tag] },
        { kinds: [KIND_EPHEMERAL], '#t': [tag], since: now - INTENT_MAX_AGE_S },
      ],
      {
        alreadyHaveEvent: (id) => this.net.seen.has(id),
        receivedEvent: (relay, id) => this.net.opts.onRelayEvent?.(relay.url, id),
        onevent: (ev) => this.net.handleEvent(ev, this.url),
        oneose: () => this.net.relayEose(this.url),
        eoseTimeout: JOIN_WAIT_MS,
        onclose: (reason) => {
          // Relay closed our sub (rate limit, restart): retry once the socket is still alive.
          if (this.relay === r && !this.stopped && r.connected && !reason.includes('by us')) {
            setTimeout(() => { if (this.relay === r && r.connected) this.subscribe(); }, 3000);
          }
        },
      },
    );
  }

  /** Relay told us to back off (rate limit / policy): skip writes until this time, to avoid escalating to a ban. */
  private mutedUntil = 0;

  async publish(ev: Event): Promise<boolean> {
    const r = this.relay;
    if (!r?.connected || Date.now() < this.mutedUntil) return false;
    try {
      await r.publish(ev);
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/rate|limit|slow down|banned|blocked|trust|restricted|pow:|auth-required/i.test(msg)) {
        this.mutedUntil = Date.now() + (/banned|trust|restricted/i.test(msg) ? 10 * 60_000 : 60_000);
      }
      return false;
    }
  }
}

// ---------------------------------------------------------------- the net
class NostrNetImpl implements NostrNet {
  readonly myId: string;
  info: RoomInfo | null = null;
  status: Status = 'offline';

  readonly opts: NostrNetOptions;
  private readonly appTag: string;
  private readonly sk: Uint8Array;
  private readonly relayUrls: string[];
  private conns: RelayConn[] = [];

  tag: string | null = null;
  private key: CryptoKey | null = null;
  private code: string | null = null;
  private name: string | undefined;
  readonly seen = new SeenSet(4000);

  // state
  private best: SnapshotMeta | null = null;
  private bestState: GameState | null = null;     // newest known state (from anyone, incl. ourselves)
  private remoteState: GameState | null = null;   // newest state that came from the network (for late onState subscribers)
  private pendingState: GameState | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private republishTimer: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotEvent: Event | null = null;

  // presence
  private peers = new Map<string, Peer>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private presenceReply: ReturnType<typeof setTimeout> | null = null;
  private lastPeerKey = '';

  // ephemeral
  private ephQueue: { c: string; d: unknown }[] = [];
  private ephTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedIntents: Event[] = [];

  // join wait
  private eoseWaiters: (() => void)[] = [];

  private l = {
    intent: new Set<(e: Envelope) => void>(),
    state: new Set<(s: GameState) => void>(),
    eph: new Set<(c: string, d: unknown, from: string) => void>(),
    peers: new Set<(p: Peer[]) => void>(),
    status: new Set<(s: Status) => void>(),
    info: new Set<(i: RoomInfo | null) => void>(),
  };

  private onVisibility = () => {
    const doc = (globalThis as any).document;
    if (doc && doc.visibilityState === 'visible') this.resume();
  };
  private onOnline = () => this.resume();
  private hiddenAt = 0;
  private onHide = () => {
    const doc = (globalThis as any).document;
    if (doc && doc.visibilityState === 'hidden') this.hiddenAt = Date.now();
  };

  constructor(opts: NostrNetOptions = {}) {
    this.opts = opts;
    this.appTag = opts.appTag ?? 'familyrpg';
    this.sk = loadKey(this.appTag, opts.secretKeyHex);
    this.myId = getPublicKey(this.sk);
    this.relayUrls = opts.relays?.length ? opts.relays : DEFAULT_RELAYS;
    try { this.name = store()?.getItem(`${this.appTag}:name`) ?? undefined; } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ NetApi
  async host(): Promise<RoomInfo> {
    const code = generateRoomCode();
    await this.enter(code, true);
    this.sendMsg({ type: 'presence', name: this.name, host: true });
    return this.info!;
  }

  async join(input: string): Promise<RoomInfo> {
    const code = parseJoinInput(input);
    if (!code) throw new Error('That room code does not look right.');
    await this.enter(code, false);
    await this.waitForEose(JOIN_WAIT_MS);
    this.sendMsg({ type: 'hello', name: this.name });
    return this.info!;
  }

  async claimHost(): Promise<void> {
    if (!this.info) throw new Error('Not in a room.');
    this.setInfo({ ...this.info, isHost: true });
    this.remember(true);
    // Become the publisher of the newest state we know, under our own key.
    if (this.bestState) this.publishState(this.bestState);
    this.sendMsg({ type: 'presence', name: this.name, host: true });
    this.startRepublish();
  }

  sendIntent(env: Envelope): void {
    if (!this.info) return;
    if (this.info.isHost) {                     // host talking to itself: no round trip
      const e = { ...env, by: this.myId } as Envelope;
      queueMicrotask(() => this.l.intent.forEach((cb) => cb(e)));
      return;
    }
    this.sendMsg({ type: 'intent', env }, true);
  }

  publishState(state: GameState): void {
    if (!this.info?.isHost) return;             // only the publisher writes snapshots (see claimHost)
    this.pendingState = state;
    this.noteOwnState(state);
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const s = this.pendingState;
      this.pendingState = null;
      if (s) void this.publishSnapshot(s);
    }, STATE_DEBOUNCE_MS);
  }

  sendEphemeral(channel: string, data: unknown): void {
    if (!this.info) return;
    this.ephQueue.push({ c: channel, d: data });
    if (this.ephTimer) return;
    this.ephTimer = setTimeout(() => {
      this.ephTimer = null;
      const items = this.ephQueue;
      this.ephQueue = [];
      for (const batch of batchItems(items)) this.sendMsg({ type: 'eph', items: batch });
    }, EPH_FLUSH_MS);
  }

  onIntent(cb: (env: Envelope) => void) { return this.add(this.l.intent, cb); }
  onState(cb: (state: GameState) => void) {
    const off = this.add(this.l.state, cb);
    const s = this.remoteState;
    if (s) queueMicrotask(() => { if (this.l.state.has(cb)) cb(s); });
    return off;
  }
  onEphemeral(cb: (channel: string, data: unknown, from: string) => void) { return this.add(this.l.eph, cb); }
  onPeers(cb: (peers: Peer[]) => void) {
    const off = this.add(this.l.peers, cb);
    cb(this.peerList());
    return off;
  }
  onStatus(cb: (s: Status) => void) { const off = this.add(this.l.status, cb); cb(this.status); return off; }
  onInfo(cb: (i: RoomInfo | null) => void) { return this.add(this.l.info, cb); }

  leave(): void {
    const conns = this.conns;
    if (this.info && this.key && this.tag) {
      // Say bye on the old sockets, then close them.
      void this.signMsg({ type: 'bye' }, { key: this.key, tag: this.tag })
        .then((ev) => ev && Promise.race([Promise.all(conns.map((c) => c.publish(ev))), new Promise((r) => setTimeout(r, 1500))]))
        .finally(() => conns.forEach((c) => c.stop()));
    } else conns.forEach((c) => c.stop());
    this.conns = [];
    for (const t of [this.stateTimer, this.helloTimer, this.presenceReply, this.ephTimer]) if (t) clearTimeout(t);
    if (this.republishTimer) clearInterval(this.republishTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stateTimer = this.helloTimer = this.presenceReply = this.ephTimer = null;
    this.republishTimer = this.heartbeat = null;
    this.detachPageHooks();
    this.tag = null; this.key = null; this.code = null;
    this.best = null; this.bestState = null; this.remoteState = null; this.lastSnapshotEvent = null;
    this.peers.clear(); this.emitPeers(true);
    this.queuedIntents = []; this.ephQueue = [];
    this.setInfo(null);
    this.refreshStatus();
  }

  // ------------------------------------------------------------ extras
  setName(name: string): void {
    this.name = name;
    try { store()?.setItem(`${this.appTag}:name`, name); } catch { /* ignore */ }
    if (this.info) this.sendMsg({ type: 'presence', name, host: this.info.isHost });
  }
  connectedRelays(): string[] { return this.conns.filter((c) => c.connected).map((c) => c.url); }
  lastRoom(): { code: string; wasHost: boolean } | null {
    try {
      const raw = store()?.getItem(`${this.appTag}:last-room`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------ internals
  private add<T>(set: Set<T>, cb: T): () => void { set.add(cb); return () => { set.delete(cb); }; }

  private async enter(code: string, isHost: boolean) {
    if (this.info) this.leave();
    this.code = code;
    this.tag = await roomTag(code, this.appTag);
    this.key = await deriveRoomKey(code, this.appTag);
    const base = this.opts.baseUrl ?? defaultBase();
    this.setInfo({ roomId: code, secret: code, link: joinLink(base, code), isHost, myId: this.myId });
    this.remember(isHost);
    this.conns = this.relayUrls.map((u) => new RelayConn(u, this));
    this.conns.forEach((c) => c.start());
    this.attachPageHooks();
    this.heartbeat = setInterval(() => {
      if (this.info) this.sendMsg({ type: 'presence', name: this.name, host: this.info.isHost });
      this.emitPeers();
    }, HEARTBEAT_MS);
    if (isHost) this.startRepublish();
  }

  private remember(wasHost: boolean) {
    if (!this.code) return;
    try { store()?.setItem(`${this.appTag}:last-room`, JSON.stringify({ code: this.code, wasHost })); } catch { /* ignore */ }
  }

  private setInfo(i: RoomInfo | null) {
    this.info = i;
    this.l.info.forEach((cb) => cb(i));
  }

  private startRepublish() {
    if (this.republishTimer) return;
    this.republishTimer = setInterval(() => {
      if (this.info?.isHost && this.bestState) void this.publishSnapshot(this.bestState);
    }, STATE_REPUBLISH_MS);
  }

  private noteOwnState(state: GameState) {
    const meta: SnapshotMeta = { v: state.v, createdAt: Math.floor(Date.now() / 1000), id: '', author: this.myId };
    if (isNewerSnapshot(this.best, meta) || !this.bestState) { this.best = meta; }
    this.bestState = state;
  }

  refreshStatus() {
    let s: Status = 'offline';
    if (this.info && this.conns.length) {
      if (this.conns.some((c) => c.connected)) s = 'online';
      else s = 'connecting';
    }
    if (s !== this.status) {
      this.status = s;
      this.l.status.forEach((cb) => cb(s));
    }
  }

  relayConnected(conn: RelayConn) {
    // Fresh socket: push what others may have missed.
    if (this.info?.isHost && this.lastSnapshotEvent) void conn.publish(this.lastSnapshotEvent);
    const fresh = this.queuedIntents.filter((e) => isFresh(e.created_at, Math.floor(Date.now() / 1000), INTENT_MAX_AGE_S));
    this.queuedIntents = [];
    for (const e of fresh) void conn.publish(e).then((ok) => { if (!ok) this.queuedIntents.push(e); });
    if (this.info) void this.signMsg({ type: 'presence', name: this.name, host: this.info.isHost }).then((e) => e && conn.publish(e));
  }

  relayEose(_url: string) {
    const w = this.eoseWaiters;
    this.eoseWaiters = [];
    w.forEach((f) => f());
  }

  private waitForEose(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.eoseWaiters.push(done);
    });
  }

  private async publishSnapshot(state: GameState) {
    if (!this.key || !this.tag) return;
    const tag = this.tag;
    const body: SnapshotBody = { state };
    const content = await encryptPayload(this.key, body, { compress: true, aad: `${this.appTag}:${KIND_SNAPSHOT}` });
    if (this.tag !== tag) return;
    if (content.length > SNAPSHOT_WARN_BYTES) {
      console.warn(`[net] state snapshot is ${(content.length / 1024).toFixed(1)} KB; some relays may reject events over ~64 KB`);
    }
    const now = Math.floor(Date.now() / 1000);
    const ev = finalizeEvent({
      kind: KIND_SNAPSHOT,
      // Strictly increasing: relays keep the replaceable event with the newest created_at.
      created_at: Math.max(now, (this.lastSnapshotEvent?.created_at ?? 0) + 1),
      tags: [['d', tag], ['expiration', String(now + SNAPSHOT_TTL_S)]],
      content,
    }, this.sk);
    this.seen.add(ev.id);
    this.lastSnapshotEvent = ev;
    this.publishAll(ev);
  }

  private publishAll(ev: Event): Promise<boolean[]> {
    return Promise.all(this.conns.map((c) => c.publish(ev)));
  }

  private async signMsg(msg: Msg, ctx?: { key: CryptoKey; tag: string }): Promise<Event | null> {
    const key = ctx?.key ?? this.key;
    const tag = ctx?.tag ?? this.tag;
    if (!key || !tag) return null;
    const content = await encryptPayload(key, msg, { aad: `${this.appTag}:${KIND_EPHEMERAL}` });
    if (!ctx && this.tag !== tag) return null;
    const ev = finalizeEvent({ kind: KIND_EPHEMERAL, created_at: Math.floor(Date.now() / 1000), tags: [['t', tag]], content }, this.sk);
    this.seen.add(ev.id);
    return ev;
  }

  private sendMsg(msg: Msg, queueIfOffline = false) {
    void this.signMsg(msg).then(async (ev) => {
      if (!ev) return;
      const res = await this.publishAll(ev);
      if (queueIfOffline && !res.some(Boolean) && this.queuedIntents.length < MAX_QUEUED_INTENTS) this.queuedIntents.push(ev);
    });
  }

  /** Entry point for every event any relay delivers for our room. */
  async handleEvent(ev: Event, relayUrl: string) {
    if (!this.seen.add(ev.id)) return;
    const key = this.key;
    if (!key) return;
    if (ev.kind === KIND_SNAPSHOT) {
      const body = await decryptPayload<SnapshotBody>(key, ev.content, `${this.appTag}:${KIND_SNAPSHOT}`);
      if (key !== this.key || !body?.state || typeof body.state.v !== 'number') return;
      // Our own older snapshot is fine to accept (host device resuming after a reload).
      this.touchPeer(ev.pubkey, undefined, ev.created_at * 1000);
      this.acceptSnapshot(body.state, { v: body.state.v, createdAt: ev.created_at, id: ev.id, author: ev.pubkey });
      return;
    }
    if (ev.kind !== KIND_EPHEMERAL || ev.pubkey === this.myId) return;
    const now = Math.floor(Date.now() / 1000);
    if (!isFresh(ev.created_at, now, INTENT_MAX_AGE_S)) return;
    const msg = await decryptPayload<Msg>(key, ev.content, `${this.appTag}:${KIND_EPHEMERAL}`);
    if (key !== this.key || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'intent':
        this.touchPeer(ev.pubkey);
        if (this.info?.isHost && msg.env && typeof msg.env === 'object') {
          const env = { ...msg.env, by: ev.pubkey } as Envelope;    // sender identity comes from the signature
          this.l.intent.forEach((cb) => cb(env));
        }
        break;
      case 'hello':
        this.touchPeer(ev.pubkey, msg.name);
        this.onHello();
        break;
      case 'presence':
        this.touchPeer(ev.pubkey, msg.name);
        break;
      case 'bye':
        if (this.peers.delete(ev.pubkey)) this.emitPeers(true);
        break;
      case 'eph':
        if (!Array.isArray(msg.items)) break;
        this.touchPeer(ev.pubkey);
        for (const it of msg.items) {
          if (it && typeof it.c === 'string') this.l.eph.forEach((cb) => cb(it.c, it.d, ev.pubkey));
        }
        break;
    }
  }

  private acceptSnapshot(state: GameState, meta: SnapshotMeta) {
    if (!isNewerSnapshot(this.best, meta)) return;
    this.best = meta;
    this.bestState = state;
    this.remoteState = state;
    if (this.info?.isHost && meta.author !== this.myId) {
      // Someone else published a newer state: they took over. Step down so we don't fork the table.
      this.setInfo({ ...this.info, isHost: false });
      this.remember(false);
      if (this.republishTimer) { clearInterval(this.republishTimer); this.republishTimer = null; }
    }
    this.l.state.forEach((cb) => cb(state));
  }

  private onHello() {
    // Answer quickly so the newcomer sees everyone; the host also re-sends the latest snapshot.
    if (!this.presenceReply) {
      this.presenceReply = setTimeout(() => {
        this.presenceReply = null;
        if (this.info) this.sendMsg({ type: 'presence', name: this.name, host: this.info.isHost });
      }, 300 + Math.random() * 500);
    }
    if (this.info?.isHost && !this.helloTimer) {
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (this.info?.isHost && this.bestState) void this.publishSnapshot(this.bestState);
      }, 400);
    }
  }

  private touchPeer(id: string, name?: string, at = Date.now()) {
    if (id === this.myId) return;
    const p = this.peers.get(id);
    const lastSeen = Math.min(Date.now(), Math.max(at, p?.lastSeen ?? 0));
    this.peers.set(id, { id, name: name ?? p?.name, lastSeen });
    this.emitPeers();
  }

  private peerList(): Peer[] {
    const now = Date.now();
    for (const [id, p] of this.peers) if (now - p.lastSeen > PEER_WINDOW_MS * 4) this.peers.delete(id);
    return activePeers(this.peers.values(), now, PEER_WINDOW_MS).map((p) => ({ ...p }));
  }

  private emitPeers(force = false) {
    const list = this.peerList();
    const k = list.map((p) => `${p.id}:${p.name ?? ''}`).sort().join('|');
    if (!force && k === this.lastPeerKey) return;
    this.lastPeerKey = k;
    this.l.peers.forEach((cb) => cb(list));
  }

  // ------------------------------------------------------------ page lifecycle (phones kill sockets in background)
  private hooked = false;
  private attachPageHooks() {
    const doc = (globalThis as any).document;
    const win = (globalThis as any).window;
    if (this.hooked || !doc || !win) return;
    this.hooked = true;
    doc.addEventListener('visibilitychange', this.onHide);
    doc.addEventListener('visibilitychange', this.onVisibility);
    win.addEventListener('online', this.onOnline);
    win.addEventListener('pageshow', this.onOnline);
  }
  private detachPageHooks() {
    const doc = (globalThis as any).document;
    const win = (globalThis as any).window;
    if (!this.hooked || !doc || !win) return;
    this.hooked = false;
    doc.removeEventListener('visibilitychange', this.onHide);
    doc.removeEventListener('visibilitychange', this.onVisibility);
    win.removeEventListener('online', this.onOnline);
    win.removeEventListener('pageshow', this.onOnline);
  }
  private resume() {
    if (!this.info) return;
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    // After a long pause, sockets that claim to be open are often dead: rebuild all of them.
    for (const c of this.conns) if (away > 15_000 || !c.connected) c.kick();
    this.sendMsg({ type: 'hello', name: this.name });
  }
}

export function createNostrNet(opts?: { relays?: string[]; appTag?: string; baseUrl?: string } & NostrNetOptions): NostrNet {
  return new NostrNetImpl(opts);
}
