// Shared setup for the data scripts: paths, args, pack + lexicon loading, JSONL helpers.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildLexicon, type AiPack, type Lexicon, type PackLike } from '../src/lexicon';

export const AI = resolve(import.meta.dir, '..');
export const REPO = resolve(AI, '..');
export const OUT = join(AI, 'out');

export function args(defaults: Record<string, string>): Record<string, string> {
  const a = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k.slice(2)] = v;
  }
  return a;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface Loaded { pack: PackLike; ai: AiPack; lex: Lexicon; scenes: { id: string; name: string }[] }

/** Training lexicon: pack + theme ai file + the built-in adventures' scenes + the ai file's scene-name pool. */
export function load(packId = 'sleighbound'): Loaded {
  const pack = JSON.parse(readFileSync(join(REPO, 'game/packs', `${packId}.json`), 'utf8')) as PackLike;
  const ai = JSON.parse(readFileSync(join(AI, 'packs', `${packId}.ai.json`), 'utf8')) as AiPack;
  const scenes = new Map<string, { id: string; name: string }>();
  for (const a of pack.adventures ?? []) for (const s of a.scenes) scenes.set(s.id, { id: s.id, name: s.name });
  for (const n of ai.sceneNames ?? []) if (![...scenes.values()].some((s) => s.name === n)) scenes.set(slug(n), { id: slug(n), name: n });
  const list = [...scenes.values()];
  return { pack, ai, lex: buildLexicon(pack, ai, list), scenes: list };
}

export function readJsonl<T = any>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
export function writeJsonl(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
export function appendJsonl(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length) appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
export function writeJson(path: string, v: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + '\n');
}

/** Stable short hash (FNV-1a) for grouping paraphrases of one program into the same split. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Reads KEY=VALUE lines from the repo .env (never printed). */
export function env(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const p = join(REPO, '.env');
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}
