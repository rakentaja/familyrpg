// Sharing adventures through the same public Nostr relays as the tables: the adventure is gzipped and encrypted
// with a key derived from a share code ("STAR-7KQ-M4X-P2A"); relays only see ciphertext under a hashed tag.
// Whoever has the code (or the link) can fetch it. No accounts.
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { decryptPayload, deriveRoomKey, encryptPayload, fromHex, generateRoomCode, normalizeRoomCode, roomTag, toHex } from './codec';
import { DEFAULT_RELAYS, KIND_SNAPSHOT } from './nostr';

const APP = 'familyrpg-adv';
const WAIT_MS = 8000;

function deviceKey(): Uint8Array {
  const k = 'familyrpg:device-key';
  try { const hex = localStorage.getItem(k); if (hex && /^[0-9a-f]{64}$/.test(hex)) return fromHex(hex); } catch { /* ignore */ }
  const sk = generateSecretKey();
  try { localStorage.setItem(k, toHex(sk)); } catch { /* ignore */ }
  return sk;
}

async function connect(url: string, ms: number): Promise<AbstractRelay | null> {
  const r = new AbstractRelay(url, { verifyEvent });
  r.onnotice = () => {};
  try {
    await Promise.race([r.connect(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
    return r;
  } catch { try { r.close(); } catch { /* ignore */ } return null; }
}

/** Share link for a code (opens the app and offers to import). */
export function shareLink(code: string): string {
  return `${location.origin}${location.pathname}#adv=${encodeURIComponent(code)}`;
}
/** Code from a typed code or a pasted link, or null. */
export function parseShareInput(input: string): string | null {
  const m = /[#&]adv=([^&\s]+)/.exec(input);
  return normalizeRoomCode(m ? decodeURIComponent(m[1]!) : input);
}

/** Publish an adventure; resolves with its share code once at least one relay stored it. */
export async function shareAdventure(adv: unknown): Promise<string> {
  const code = generateRoomCode();
  const [tag, key] = await Promise.all([roomTag(code, APP), deriveRoomKey(code, APP)]);
  const content = await encryptPayload(key, { adv }, { compress: true, aad: `${APP}:${KIND_SNAPSHOT}` });
  if (content.length > 120_000) throw new Error('This adventure is too big to share.');
  const ev: Event = finalizeEvent({ kind: KIND_SNAPSHOT, created_at: Math.floor(Date.now() / 1000), tags: [['d', tag]], content }, deviceKey());
  const results = await Promise.all(DEFAULT_RELAYS.map(async (url) => {
    const r = await connect(url, 5000);
    if (!r) return false;
    try { await Promise.race([r.publish(ev), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]); return true; }
    catch { return false; }
    finally { try { r.close(); } catch { /* ignore */ } }
  }));
  if (!results.some(Boolean)) throw new Error('Could not reach the internet to share. Try again?');
  return code;
}

/** Fetch a shared adventure by code (the raw object — clean it before use). */
export async function fetchAdventure(input: string): Promise<unknown> {
  const code = parseShareInput(input);
  if (!code) throw new Error('That doesn’t look like a share code.');
  const [tag, key] = await Promise.all([roomTag(code, APP), deriveRoomKey(code, APP)]);
  const relays: AbstractRelay[] = [];
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let open = DEFAULT_RELAYS.length, done = false;
      const finish = (v: unknown, err?: Error) => { if (done) return; done = true; err ? reject(err) : resolve(v); };
      const giveUp = () => { if (--open <= 0) finish(null, new Error('No adventure found for that code.')); };
      setTimeout(() => finish(null, new Error('No adventure found for that code (or no internet).')), WAIT_MS);
      for (const url of DEFAULT_RELAYS) {
        void connect(url, 5000).then((r) => {
          if (!r) { giveUp(); return; }
          relays.push(r);
          if (done) return;
          r.subscribe([{ kinds: [KIND_SNAPSHOT], '#d': [tag], limit: 3 }], {
            onevent: (ev) => {
              void decryptPayload<{ adv?: unknown }>(key, ev.content, `${APP}:${KIND_SNAPSHOT}`).then((body) => { if (body?.adv) finish(body.adv); });
            },
            oneose: () => setTimeout(giveUp, 300),
            eoseTimeout: 5000,
          });
        });
      }
    });
  } finally {
    for (const r of relays) { try { r.close(); } catch { /* ignore */ } }
  }
}
