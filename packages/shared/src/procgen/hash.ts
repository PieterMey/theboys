// Owned by track ② Level. Stable layout hash: FNV-1a (32-bit) over JSON.stringify(layout without `hash`).
import type { LevelLayout } from '../layout.ts';

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function layoutHash(L: LevelLayout): string {
  const rest: Partial<LevelLayout> = { ...L };
  delete rest.hash;
  return fnv1a(JSON.stringify(rest));
}

/** true if L.hash matches its content (clients can sanity-check what they received). */
export function verifyLayoutHash(L: LevelLayout): boolean {
  return layoutHash(L) === L.hash;
}
