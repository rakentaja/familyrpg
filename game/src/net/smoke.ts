// Live relay check (≈12 s): `bun src/net/smoke.ts [relay ...]`
// For each relay alone, plus all together: A hosts and stores a snapshot, B joins late and must fetch it,
// B sends an intent, A answers with a new state, B sends an ephemeral message. Prints what arrived.
import { generateSecretKey } from 'nostr-tools/pure';
import { createNostrNet, DEFAULT_RELAYS } from './nostr';
import { toHex } from './codec';

const relays = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RELAYS;
const LIMIT_MS = 12_000;

interface Result { label: string; online: boolean; lateSnapshot: boolean; intent: boolean; liveState: boolean; eph: boolean; peers: boolean; ms: number; relaysUsed: Set<string> }

async function run(label: string, list: string[]): Promise<Result> {
  const t0 = Date.now();
  const used = new Set<string>();
  const a = createNostrNet({ relays: list, secretKeyHex: toHex(generateSecretKey()), baseUrl: 'https://example.test/', onRelayEvent: (r) => used.add(r) });
  const b = createNostrNet({ relays: list, secretKeyHex: toHex(generateSecretKey()), baseUrl: 'https://example.test/', onRelayEvent: (r) => used.add(r) });
  const r: Result = { label, online: false, lateSnapshot: false, intent: false, liveState: false, eph: false, peers: false, ms: 0, relaysUsed: used };
  const state = (v: number) => ({ v, note: 'smoke', names: ['Ada', 'Ben'] }) as any;

  let finish!: () => void;
  const done = new Promise<void>((res) => { finish = res; });
  const timer = setTimeout(finish, LIMIT_MS);
  const check = () => { if (r.lateSnapshot && r.intent && r.liveState && r.eph) finish(); };

  a.setName('Host'); b.setName('Guest');
  a.onIntent((env) => { r.intent = (env as any).t === 'leave' && env.by === b.myId; a.publishState(state(2)); check(); });
  a.onEphemeral((c, d, from) => { r.eph = c === 'draw' && (d as any).x === 1 && from === b.myId; check(); });
  a.onPeers((p) => { if (p.some((x) => x.id === b.myId && x.name === 'Guest')) r.peers = true; });
  b.onState((s) => {
    if (s.v === 1) r.lateSnapshot = true;
    if (s.v === 2) r.liveState = true;
    check();
  });

  const info = await a.host();
  a.publishState(state(1));
  // wait until the host is online and has had a moment to store the snapshot
  while (a.status !== 'online' && Date.now() - t0 < 6000) await Bun.sleep(100);
  r.online = a.status === 'online';
  await Bun.sleep(800);
  await b.join(info.link);
  b.sendIntent({ t: 'leave', by: 'spoofed' } as any);
  b.sendEphemeral('draw', { x: 1 });

  await done;
  clearTimeout(timer);
  r.ms = Date.now() - t0;
  a.leave(); b.leave();
  return r;
}

const jobs = [...relays.map((u) => run(u, [u])), run('ALL', relays)];
const results = await Promise.all(jobs);
const yes = (b: boolean) => (b ? 'yes' : ' NO');
console.log('relay                         online late-snap intent live-state eph peers  ms');
for (const r of results) {
  console.log(`${r.label.padEnd(30)} ${yes(r.online)}    ${yes(r.lateSnapshot)}      ${yes(r.intent)}    ${yes(r.liveState)}     ${yes(r.eph)} ${yes(r.peers)}  ${r.ms}`);
}
const all = results[results.length - 1];
console.log('ALL: events arrived via', [...all.relaysUsed].join(', ') || '(none)');
setTimeout(() => process.exit(0), 1600);
