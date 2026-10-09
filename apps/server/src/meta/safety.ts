// Owner: track (d) Meta. v1.3 P1c: name and text safety for what meta shows other players (profile names and visor
// glyphs set at the locker mirror, saved names, HR-memo quotes, Company Line lines), on top of the integrator's
// packages/shared/src/names.ts (P1a: fold + EN/NL blocklist + reserved names; safeDisplayName, textBlocked, maskText).
import { maskText, nameBlocked, safeDisplayName, textBlocked as namesTextBlocked } from '@dead-air/shared/names.ts';

/** control characters and angle brackets out, trimmed, at most `max` chars (the v1.2 clean, before the filter) */
export function cleanText(raw: unknown, max: number): string {
  return String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

export interface SafeName {
  name: string;
  /** replaced (blocked or reserved): the caller tells that player privately */
  blocked: boolean;
  /** names.ts verdict: 'ok' | 'empty' | 'blocked' | 'reserved' */
  reason: string;
}

/** A display name others will see (seed = the player / save id: a blocked name becomes a stable Contractor-NNNN) */
export function safeName(raw: string, seed: string): SafeName {
  const r = safeDisplayName(raw, seed);
  return { name: r.name, blocked: r.blocked, reason: r.reason };
}

/** would names.ts block this sentence (a quote, a typed line)? */
export function textBlocked(text: string): boolean {
  const t = String(text ?? '');
  return !!t.trim() && namesTextBlocked(t);
}

/** the sentence with every blocked word masked (the Company Line speakerphone) */
export function maskLine(text: string): string {
  return maskText(String(text ?? ''));
}

/**
 * Visor glyphs (at most 3 characters, drawn on every visor): names.ts's name check plus the hate symbols a 3-character
 * field can spell that a word list does not (swastikas, SS runes, 14 / 88). Letters are compared folded. The symbols
 * are \u escapes (the same set as names.ts HATE_SYMBOLS) and the letter acronym a repeat count: this repo is
 * public, so the source carries no literal hate glyph and no invisible character.
 */
const GLYPH_BLOCK: readonly RegExp[] = [/k{3}/, /[\u5350\u534d\u0fd5-\u0fd8]/u, /\u03df{2}|\u16cb{2}/u, new RegExp(`^(14|88|${String(14)}${String(88)})$`)]; // the numeric hate code, built at run time like names.ts does
/** separators a glyph string may hide a symbol behind: whitespace, dot, underscore, dash, the zero-width and
 *  direction marks (U+200B..U+200F), the word joiner (U+2060) and the byte order mark (U+FEFF) */
const GLYPH_SEPARATORS = /[\s._\-\u200b-\u200f\u2060\ufeff]+/g;

export function glyphsBlocked(glyphs: string): boolean {
  const g = String(glyphs ?? '').normalize('NFKC').toLowerCase().replace(GLYPH_SEPARATORS, '');
  if (!g) return false;
  if (GLYPH_BLOCK.some((re) => re.test(g))) return true;
  return nameBlocked(g) || namesTextBlocked(g);
}
