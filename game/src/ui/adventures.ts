// "My adventures": adventures the Guide made or changed, kept on this device (localStorage).
// An entry with the id of a built-in adventure replaces it here (the built-in one can be reset).
import type { Adventure, Pack } from '../rules/types';
import { cleanAdventure } from '../rules/layout';

const KEY = 'sb2.adventures';

export interface SavedAdventure { adv: Adventure; savedAt: number }
export interface AdventureEntry { adv: Adventure; builtIn: boolean; edited: boolean; savedAt?: number }

function read(): SavedAdventure[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && x.adv && typeof x.adv.id === 'string') : [];
  } catch { return []; }
}
function write(list: SavedAdventure[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Built-in adventures (or my edited version of them) first, then mine, newest first. */
export function allAdventures(pack: Pack): AdventureEntry[] {
  const mine = read();
  const out: AdventureEntry[] = pack.adventures.map((a) => {
    const m = mine.find((x) => x.adv.id === a.id);
    const adv = m ? cleanAdventure(m.adv, pack) : null;
    return adv ? { adv, builtIn: true, edited: true, savedAt: m!.savedAt } : { adv: a, builtIn: true, edited: false };
  });
  for (const m of [...mine].sort((a, b) => b.savedAt - a.savedAt)) {
    if (pack.adventures.some((a) => a.id === m.adv.id)) continue;
    const adv = cleanAdventure(m.adv, pack);
    if (adv) out.push({ adv, builtIn: false, edited: true, savedAt: m.savedAt });
  }
  return out;
}

export function getAdventure(pack: Pack, id: string): Adventure | null {
  return allAdventures(pack).find((e) => e.adv.id === id)?.adv ?? null;
}

export function saveAdventure(adv: Adventure): boolean {
  const list = read().filter((x) => x.adv.id !== adv.id);
  list.push({ adv, savedAt: Date.now() });
  return write(list);
}

export function deleteAdventure(id: string): void { write(read().filter((x) => x.adv.id !== id)); }

/** A fresh id that is not used by a built-in or saved adventure. */
export function newAdventureId(pack: Pack, base = 'my-adventure'): string {
  const used = new Set(allAdventures(pack).map((e) => e.adv.id));
  let id = base, n = 1;
  while (used.has(id)) id = `${base}-${++n}`;
  return id;
}

/** Bring in an adventure from someone else (share code / file): always a new entry, never over a built-in. */
export function importAdventure(pack: Pack, raw: unknown): Adventure | null {
  const adv = cleanAdventure(raw, pack);
  if (!adv) return null;
  const same = allAdventures(pack).find((e) => e.adv.id === adv.id);
  if (same && (same.builtIn || JSON.stringify(same.adv) !== JSON.stringify(adv))) {
    adv.id = newAdventureId(pack, adv.id.replace(/-\d+$/, ''));
    if (same.builtIn) adv.name = `${adv.name} (shared)`.slice(0, 60);
  }
  return saveAdventure(adv) ? adv : null;
}
