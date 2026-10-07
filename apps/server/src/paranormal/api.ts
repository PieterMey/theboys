// Owner: env-paranormal (v1.2). Safe before install (no-ops until the module runs).
import type { Crew } from '../core/types.ts';
import type { ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';

export interface PhenomenonRecord {
  id: number; kind: ParanormalKind; tier: 0 | 1 | 2;
  /** contract seconds */
  t: number;
  space: number; target: string | null; witnesses: string[];
  /** carried an honest monster tell */
  tell: boolean;
}
const subs = new Set<(crew: Crew, rec: PhenomenonRecord) => void>();
/** called when a phenomenon ends, with its witnesses */
export function onPhenomenon(fn: (crew: Crew, rec: PhenomenonRecord) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function emitPhenomenon(crew: Crew, rec: PhenomenonRecord): void {
  for (const f of subs) {
    try { f(crew, rec); } catch { /* subscriber bug */ }
  }
}
export function phenomena(_crew: Crew): readonly PhenomenonRecord[] { return []; }
export function witnessedBy(_crew: Crew, _pid: string): number { return 0; }
/** server ms until other ambient systems should hold back; 0 = free */
export function paranormalQuietUntil(_crew: Crew): number { return 0; }
/** fieldguide: lore spot ids holding a page (footprints may lead there) */
export function setLoreTargets(_crew: Crew, _spotIds: readonly string[]): void {}
export function triggerPhenomenon(_crew: Crew, _kind: ParanormalKind, _opts?: { target?: string; space?: number; force?: boolean }): boolean { return false; }
