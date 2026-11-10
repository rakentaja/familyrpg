// Pure helpers for the network layer: room codes, key derivation, payload encryption, snapshot ordering.
// No DOM, no sockets — everything here is unit-testable under bun.

/** Crockford base32 (no I, L, O, U). */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32 short words → 5 bits. Letters only, all four characters, so they survive normalisation untouched. */
export const ROOM_WORDS = [
  'SNOW', 'STAR', 'BELL', 'MOON', 'LEAF', 'FERN', 'PINE', 'BEAR',
  'DEER', 'FROG', 'HARE', 'WOLF', 'LAMB', 'DOVE', 'SWAN', 'WREN',
  'KITE', 'DRUM', 'HORN', 'LAMP', 'ROSE', 'SAGE', 'MINT', 'PLUM',
  'PEAR', 'CAKE', 'TOYS', 'GIFT', 'SLED', 'BOAT', 'NEST', 'HILL',
] as const;

/** Random characters after the word: 3 groups of 3 → 45 bits (+5 from the word = 50 bits). */
export const CODE_GROUPS = 3;
export const CODE_GROUP_LEN = 3;
const MIN_RANDOM_CHARS = CODE_GROUPS * CODE_GROUP_LEN;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** New room code, e.g. "SNOW-7KQ-M4X-P2A". */
export function generateRoomCode(rand: (n: number) => Uint8Array = randomBytes): string {
  const n = CODE_GROUPS * CODE_GROUP_LEN;
  const bytes = rand(n + 1);
  const word = ROOM_WORDS[bytes[0] & 31];
  let chars = '';
  for (let i = 0; i < n; i++) chars += CROCKFORD[bytes[i + 1] & 31];
  const groups: string[] = [];
  for (let i = 0; i < n; i += CODE_GROUP_LEN) groups.push(chars.slice(i, i + CODE_GROUP_LEN));
  return [word, ...groups].join('-');
}

function crockfordChar(c: string): string | null {
  if (c === 'O') return '0';
  if (c === 'I' || c === 'L') return '1';
  if (c === 'U') return 'V';
  return CROCKFORD.includes(c) ? c : null;
}

/**
 * Canonical form of a typed/pasted room code, or null if it cannot be a code.
 * Tolerates lowercase, spaces, missing/extra dashes, and Crockford look-alikes (o→0, i/l→1).
 */
export function normalizeRoomCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return null;
  let word = '';
  let rest = raw;
  const head = raw.slice(0, 4);
  if ((ROOM_WORDS as readonly string[]).includes(head)) { word = head; rest = raw.slice(4); }
  let chars = '';
  for (const c of rest) {
    const m = crockfordChar(c);
    if (m === null) return null;
    chars += m;
  }
  if (chars.length < MIN_RANDOM_CHARS) return null;
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += CODE_GROUP_LEN) groups.push(chars.slice(i, i + CODE_GROUP_LEN));
  return (word ? [word, ...groups] : groups).join('-');
}

/**
 * Extract and normalise a room code from anything a user might paste:
 * a full link (…#join=CODE), a fragment (#join=CODE), "roomId.secret", or the bare code.
 */
export function parseJoinInput(input: string): string | null {
  let s = input.trim();
  const m = s.match(/[#&?]join=([^&#\s]+)/i);
  if (m) s = m[1];
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  // "<roomId>.<secret>" form from the contract: in this implementation both halves are the code.
  const parts = s.split('.').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const c = normalizeRoomCode(parts[i]);
    if (c) return c;
  }
  return null;
}

export function joinLink(base: string, code: string): string {
  return `${base.replace(/#.*$/, '')}#join=${code}`;
}

// ---------------------------------------------------------------- hashing / keys

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** Public routing tag for relays: hex(sha256('familyrpg:room:' + code)). Reveals nothing about the key. */
export async function roomTag(code: string, appTag = 'familyrpg'): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(`${appTag}:room:${code}`));
  return toHex(new Uint8Array(h));
}

/** AES-GCM-256 key derived from the code with HKDF-SHA256 (domain-separated from the room tag). */
export async function deriveRoomKey(code: string, appTag = 'familyrpg', extractable = false): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`${appTag}:salt:v1`), info: enc.encode(`${appTag}:aes-gcm:v1`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------- base64 / compression

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(data).then(() => w.close());
  const buf = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buf);
}
export const hasCompression = typeof (globalThis as any).CompressionStream === 'function';
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new (globalThis as any).CompressionStream('gzip'));
}
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new (globalThis as any).DecompressionStream('gzip'));
}

// ---------------------------------------------------------------- payload encryption
// content = base64( iv[12] || AES-GCM( flag[1] || body ) ), AAD = "<appTag>:<kind>"
// flag 0 = UTF-8 JSON, flag 1 = gzip(UTF-8 JSON)

const FLAG_JSON = 0;
const FLAG_GZIP = 1;

export async function encryptPayload(key: CryptoKey, value: unknown, opts: { compress?: boolean; aad?: string } = {}): Promise<string> {
  let body = enc.encode(JSON.stringify(value));
  let flag = FLAG_JSON;
  if (opts.compress && hasCompression) {
    try {
      const z = await gzip(body);
      if (z.length < body.length) { body = z; flag = FLAG_GZIP; }
    } catch { /* fall back to plain */ }
  }
  const plain = new Uint8Array(body.length + 1);
  plain[0] = flag;
  plain.set(body, 1);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(opts.aad ?? '') }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return bytesToB64(out);
}

/** Returns undefined when the content is not ours (wrong key, tampered, garbage). Never throws. */
export async function decryptPayload<T = unknown>(key: CryptoKey, content: string, aad = ''): Promise<T | undefined> {
  try {
    const raw = b64ToBytes(content);
    if (raw.length < 12 + 16 + 1) return undefined;
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(aad) }, key, raw.subarray(12)));
    let body = plain.subarray(1);
    if (plain[0] === FLAG_GZIP) {
      if (!hasCompression) return undefined;
      body = await gunzip(body);
    } else if (plain[0] !== FLAG_JSON) return undefined;
    return JSON.parse(dec.decode(body)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- snapshot ordering

export interface SnapshotMeta { v: number; createdAt: number; id: string; author: string }

/** Is `cand` strictly newer than `cur`? Highest state.v wins; equal v is the same state (no re-fire). */
export function isNewerSnapshot(cur: SnapshotMeta | null, cand: SnapshotMeta): boolean {
  if (!Number.isFinite(cand.v)) return false;
  if (!cur) return true;
  return cand.v > cur.v;
}

/** Pick the newest of a batch (e.g. everything relays returned after EOSE). Ties: later created_at, then id. */
export function pickNewestSnapshot<T extends SnapshotMeta>(list: T[]): T | null {
  let best: T | null = null;
  for (const s of list) {
    if (!Number.isFinite(s.v)) continue;
    if (!best || s.v > best.v || (s.v === best.v && (s.createdAt > best.createdAt || (s.createdAt === best.createdAt && s.id > best.id)))) best = s;
  }
  return best;
}

/** Intent freshness: drop anything older than maxAgeSec (relays may replay; clocks may drift a little). */
export function isFresh(createdAtSec: number, nowSec: number, maxAgeSec = 120): boolean {
  return createdAtSec >= nowSec - maxAgeSec && createdAtSec <= nowSec + maxAgeSec;
}

/** Bounded set for event-id de-duplication. */
export class SeenSet {
  private set = new Set<string>();
  private order: string[] = [];
  constructor(private max = 2000) {}
  has(id: string): boolean { return this.set.has(id); }
  /** Returns true if newly added. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.max) this.set.delete(this.order.shift()!);
    return true;
  }
}

/** Split ephemeral items into batches whose JSON stays below maxBytes (roughly). */
export function batchItems<T>(items: T[], maxBytes = 24_000): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (cur.length && size + n > maxBytes) { out.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Peers seen within windowMs, newest first. */
export function activePeers<P extends { lastSeen: number }>(peers: Iterable<P>, now: number, windowMs = 30_000): P[] {
  return [...peers].filter((p) => now - p.lastSeen <= windowMs).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function backoffMs(attempt: number, base = 1000, max = 30_000): number {
  const d = Math.min(max, base * 2 ** Math.min(attempt, 10));
  return Math.round(d * (0.75 + Math.random() * 0.5));
}
