// Owner: env-paranormal (v1.2). Safe before install (no-ops until the module runs).
//   onPhenomenon(fn)            G4 (phenomenaSeen stats), G6 (anomalies): called when a phenomenon ends, with its witnesses
//   paranormalQuietUntil(crew)  G2: server ms until other ambient systems should hold back (0 = free)
//   setLoreTargets(crew, ids)   G6: lore spot ids holding a page (footprints may lead there)
//   phenomena / witnessedBy / triggerPhenomenon: records of this contract, per-player counts, dbg/forced triggers
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

/** bound by paranormal/index.ts install */
export interface ParanormalImpl {
  phenomena(crew: Crew): readonly PhenomenonRecord[];
  witnessedBy(crew: Crew, pid: string): number;
  quietUntil(crew: Crew): number;
  setLoreTargets(crew: Crew, spotIds: readonly string[]): void;
  trigger(crew: Crew, kind: ParanormalKind, opts?: { target?: string; space?: number; force?: boolean }): boolean;
}
let impl: ParanormalImpl | null = null;
export function bindParanormalImpl(i: ParanormalImpl | null): void {
  impl = i;
}

/** phenomena that ended this contract (oldest first) */
export function phenomena(crew: Crew): readonly PhenomenonRecord[] { return impl ? impl.phenomena(crew) : []; }
/** how many phenomena of this contract `pid` witnessed */
export function witnessedBy(crew: Crew, pid: string): number { return impl ? impl.witnessedBy(crew, pid) : 0; }
/** server ms until other ambient systems should hold back; 0 = free */
export function paranormalQuietUntil(crew: Crew): number { return impl ? impl.quietUntil(crew) : 0; }
/** fieldguide: lore spot ids holding a page (footprints may lead there) */
export function setLoreTargets(crew: Crew, spotIds: readonly string[]): void { impl?.setLoreTargets(crew, spotIds); }
/** fire one phenomenon now (force skips budgets, novelty, spacing, blocks and the soft gates); false if nothing fits */
export function triggerPhenomenon(crew: Crew, kind: ParanormalKind, opts?: { target?: string; space?: number; force?: boolean }): boolean {
  return impl ? impl.trigger(crew, kind, opts) : false;
}
