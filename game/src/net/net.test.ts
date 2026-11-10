import { describe, expect, test } from 'bun:test';
import {
  activePeers, batchItems, CROCKFORD, decryptPayload, deriveRoomKey, encryptPayload, generateRoomCode, isFresh,
  isNewerSnapshot, joinLink, normalizeRoomCode, parseJoinInput, pickNewestSnapshot, ROOM_WORDS, roomTag, SeenSet,
} from './codec';
import { createLocalNet } from './local';

const CODE_RE = new RegExp(`^(${ROOM_WORDS.join('|')})-[${CROCKFORD}]{3}-[${CROCKFORD}]{3}-[${CROCKFORD}]{3}$`);

describe('room codes', () => {
  test('generated codes have the expected shape and are distinct', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateRoomCode();
      expect(c).toMatch(CODE_RE);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
  });

  test('generated codes round-trip through normalisation', () => {
    for (let i = 0; i < 100; i++) {
      const c = generateRoomCode();
      expect(normalizeRoomCode(c)).toBe(c);
    }
  });

  test('normalisation tolerates case, spaces, missing dashes, look-alikes', () => {
    const c = 'SNOW-7KQ-M4X-P2A';
    expect(normalizeRoomCode('snow-7kq-m4x-p2a')).toBe(c);
    expect(normalizeRoomCode('snow 7kq m4x p2a')).toBe(c);
    expect(normalizeRoomCode('SNOW7KQM4XP2A')).toBe(c);
    expect(normalizeRoomCode('  Snow--7KQ.M4X_P2A ')).toBe(c);
    expect(normalizeRoomCode('BELL-0O1-IL1-ABC')).toBe('BELL-001-111-ABC');
    expect(normalizeRoomCode('dove-uuu-000-000')).toBe('DOVE-VVV-000-000');
  });

  test('rejects too short / empty', () => {
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('SNOW-7KQ')).toBeNull();
    expect(normalizeRoomCode('SNOW-7KQ-M4X-P2')).toBeNull();
  });

  test('parseJoinInput accepts links, fragments, roomId.secret and bare codes', () => {
    const c = 'STAR-ABC-DEF-GHJ';
    expect(parseJoinInput(`https://x.github.io/game/#join=${c}`)).toBe(c);
    expect(parseJoinInput(`#join=${c.toLowerCase()}`)).toBe(c);
    expect(parseJoinInput(`https://x.github.io/game/?a=1#join=${encodeURIComponent(c)}`)).toBe(c);
    expect(parseJoinInput(`${c}.${c}`)).toBe(c);
    expect(parseJoinInput('star abc def ghj')).toBe(c);
    expect(parseJoinInput('hello')).toBeNull();
  });

  test('joinLink drops any existing fragment', () => {
    expect(joinLink('https://a.b/g/#old', 'SNOW-111-222-333')).toBe('https://a.b/g/#join=SNOW-111-222-333');
  });
});

describe('keys and encryption', () => {
  test('room tag is deterministic, hex, and code-specific', async () => {
    const a = await roomTag('SNOW-7KQ-M4X-P2A');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await roomTag('SNOW-7KQ-M4X-P2A')).toBe(a);
    expect(await roomTag('SNOW-7KQ-M4X-P2B')).not.toBe(a);
    expect(await roomTag('SNOW-7KQ-M4X-P2A', 'other')).not.toBe(a);
  });

  test('key derivation is deterministic', async () => {
    const raw = async (c: string) => new Uint8Array(await crypto.subtle.exportKey('raw', await deriveRoomKey(c, 'familyrpg', true)));
    const k1 = await raw('SNOW-7KQ-M4X-P2A');
    const k2 = await raw('SNOW-7KQ-M4X-P2A');
    const k3 = await raw('SNOW-7KQ-M4X-P2B');
    expect(k1.length).toBe(32);
    expect([...k1]).toEqual([...k2]);
    expect([...k1]).not.toEqual([...k3]);
  });

  test('encrypt/decrypt round trip (plain and compressed)', async () => {
    const key = await deriveRoomKey('SNOW-7KQ-M4X-P2A');
    const value = { v: 7, names: ['Ada-Marlowe-Kidname', 'Ben'], big: 'x'.repeat(5000), nested: { a: [1, 2, 3] } };
    for (const compress of [false, true]) {
      const ct = await encryptPayload(key, value, { compress, aad: 'k' });
      expect(ct).not.toContain('Ada-Marlowe-Kidname');
      expect(await decryptPayload(key, ct, 'k')).toEqual(value);
    }
    const z = await encryptPayload(key, value, { compress: true });
    const p = await encryptPayload(key, value, { compress: false });
    expect(z.length).toBeLessThan(p.length);
  });

  test('wrong key, wrong aad, tampering, garbage → undefined', async () => {
    const key = await deriveRoomKey('SNOW-7KQ-M4X-P2A');
    const other = await deriveRoomKey('SNOW-7KQ-M4X-P2B');
    const ct = await encryptPayload(key, { hi: 1 }, { aad: 'a' });
    expect(await decryptPayload(other, ct, 'a')).toBeUndefined();
    expect(await decryptPayload(key, ct, 'b')).toBeUndefined();
    const bad = (ct[5] === 'A' ? 'B' : 'A');
    expect(await decryptPayload(key, ct.slice(0, 5) + bad + ct.slice(6), 'a')).toBeUndefined();
    expect(await decryptPayload(key, 'not base64 !!', 'a')).toBeUndefined();
    expect(await decryptPayload(key, '', 'a')).toBeUndefined();
  });

  test('same plaintext encrypts differently each time (random IV)', async () => {
    const key = await deriveRoomKey('SNOW-7KQ-M4X-P2A');
    expect(await encryptPayload(key, { a: 1 })).not.toBe(await encryptPayload(key, { a: 1 }));
  });
});

describe('snapshot ordering and helpers', () => {
  const m = (v: number, createdAt = 100, id = 'a', author = 'p') => ({ v, createdAt, id, author });

  test('higher v wins, equal v does not re-fire, missing current accepts', () => {
    expect(isNewerSnapshot(null, m(0))).toBe(true);
    expect(isNewerSnapshot(m(3), m(4))).toBe(true);
    expect(isNewerSnapshot(m(4), m(4, 999))).toBe(false);
    expect(isNewerSnapshot(m(5), m(4, 999))).toBe(false);
    expect(isNewerSnapshot(null, m(NaN))).toBe(false);
  });

  test('pickNewest: v, then created_at, then id', () => {
    expect(pickNewestSnapshot([])).toBeNull();
    expect(pickNewestSnapshot([m(1), m(9, 1), m(3, 500)])!.v).toBe(9);
    expect(pickNewestSnapshot([m(9, 1, 'a'), m(9, 2, 'b')])!.createdAt).toBe(2);
    expect(pickNewestSnapshot([m(9, 2, 'a'), m(9, 2, 'c'), m(9, 2, 'b')])!.id).toBe('c');
  });

  test('intent freshness window', () => {
    expect(isFresh(1000, 1000)).toBe(true);
    expect(isFresh(880, 1000)).toBe(true);
    expect(isFresh(879, 1000)).toBe(false);
    expect(isFresh(1120, 1000)).toBe(true);
    expect(isFresh(1121, 1000)).toBe(false);
  });

  test('SeenSet dedupes and stays bounded', () => {
    const s = new SeenSet(3);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b'); s.add('c'); s.add('d');
    expect(s.has('a')).toBe(false);
    expect(s.has('d')).toBe(true);
  });

  test('batchItems keeps order and splits by size', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ c: 'draw', d: 'x'.repeat(100) + i }));
    const b = batchItems(items, 1000);
    expect(b.length).toBeGreaterThan(1);
    expect(b.flat()).toEqual(items);
    expect(batchItems([])).toEqual([]);
  });

  test('activePeers filters by window and sorts newest first', () => {
    const now = 100_000;
    const list = activePeers([{ id: 'a', lastSeen: now - 31_000 }, { id: 'b', lastSeen: now - 5_000 }, { id: 'c', lastSeen: now - 1 }], now);
    expect(list.map((p) => p.id)).toEqual(['c', 'b']);
  });
});

describe('local net', () => {
  test('loops state, intents and ephemeral back', async () => {
    const net = createLocalNet();
    const info = await net.host();
    expect(info.isHost).toBe(true);
    expect(net.myId).toBe('local');
    expect(net.status).toBe('online');
    const got: string[] = [];
    net.onIntent((e) => got.push('intent:' + e.t));
    net.onState((s) => got.push('state:' + s.v));
    net.onEphemeral((c, d, from) => got.push(`eph:${c}:${d}:${from}`));
    net.sendIntent({ t: 'leave', by: 'local' });
    net.publishState({ v: 3 } as any);
    net.sendEphemeral('ping', 1);
    await Promise.resolve(); await Promise.resolve();
    expect(got).toEqual(['intent:leave', 'state:3', 'eph:ping:1:local']);
    // late subscriber gets the last state
    const late: number[] = [];
    net.onState((s) => late.push(s.v));
    await Promise.resolve();
    expect(late).toEqual([3]);
    net.leave();
    expect(net.status).toBe('offline');
    expect(net.info).toBeNull();
  });
});
