// Owner: track (a) Objectives. Public server API for other tracks (import from '../objectives/api.ts').
//   startContract(crew, order, opts?)  meta calls this after setPhase(crew, 'contract', layout)
//   onContractEnd(fn(crew, result))    meta: results / quota / saves (result: ObjContractResult extends ContractResult)
//   state(crew)                        the ObjectivesState slice (null outside contracts)
//   clockMin(crew)                     in-game minutes since 22:00 (0..360), -1 outside a running contract
//   carrying(crew, pid)                'core' | 'loot' | null (⑤: carriers move at MOVE.carryCoreMult)
//   endContract(crew, reason)          force the end (meta / dbg)
//   vaultCode(crew)                    the 4-digit code (console UI may also read state(crew).code)
//   inVan(crew, x, z)                  the "inside the van" test objectives uses
import type { Crew } from '../core/types.ts';
import type { ObjContractResult, ObjectivesState } from '@dead-air/shared/messages/objectives.ts';
import * as C from './contract.ts';
import type { OrderLike, StartOpts } from './contract.ts';

export type { OrderLike, StartOpts } from './contract.ts';
export type { ObjContractResult, ObjectivesState } from '@dead-air/shared/messages/objectives.ts';

export function startContract(crew: Crew, order: OrderLike, opts?: StartOpts): ObjectivesState {
  return C.startContract(crew, order, opts);
}

export function onContractEnd(fn: (crew: Crew, result: ObjContractResult) => void): () => void {
  return C.onContractEnd(fn);
}

export function state(crew: Crew): ObjectivesState | null {
  return C.publicState(crew);
}

export function clockMin(crew: Crew): number {
  const r = C.rt(crew);
  if (!r || !r.st.active || crew.phase !== 'contract') return -1;
  return C.clockMinOf(r);
}

export function carrying(crew: Crew, pid: string): 'core' | 'loot' | null {
  return C.carrying(crew, pid);
}

export function endContract(crew: Crew, reason: ObjContractResult['reason'] = 'abort'): ObjContractResult | null {
  return C.endContract(crew, reason);
}

export function vaultCode(crew: Crew): string | null {
  return C.rt(crew)?.st.code ?? null;
}

export function inVan(crew: Crew, x: number, z: number): boolean {
  const r = C.rt(crew);
  return r ? C.inVan(r, x, z) : false;
}

/** last contract result of this crew (until the next startContract) */
export function lastResult(crew: Crew): ObjContractResult | null {
  return C.rt(crew)?.result ?? null;
}
