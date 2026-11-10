// Seeded randomness (mulberry32). The generator state lives in GameState.seed so every reduce is reproducible.

export function rand(s: { seed: number }): number {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randInt = (s: { seed: number }, n: number): number => Math.floor(rand(s) * n);
export const d6 = (s: { seed: number }): number => 1 + randInt(s, 6);
export function pick<T>(s: { seed: number }, list: T[]): T | undefined {
  return list.length ? list[randInt(s, list.length)] : undefined;
}
export function shuffle<T>(s: { seed: number }, list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
