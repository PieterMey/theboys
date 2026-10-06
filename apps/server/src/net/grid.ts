// Owner: track ① Net. Per-layout edge grid cache + runtime door state reader shared by audibility and pose
// validation. Door state comes from the interaction track (crew.slices.interaction.doors) when present,
// otherwise from the layout's initial state. Tolerates several shapes because the interaction slice is
// written by another track: Record<id, {open}> | Record<id, boolean> | boolean[] | Uint8Array | Map.
import { buildEdgeGrid, initialDoorOpen } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Crew } from '../core/types.ts';

const grids = new WeakMap<LevelLayout, EdgeGrid | null>();

/** Edge grid for the crew's current layout (built once per layout object); null if no layout / bad layout. */
export function gridFor(layout: LevelLayout | null | undefined): EdgeGrid | null {
  if (!layout) return null;
  let g = grids.get(layout);
  if (g === undefined) {
    try {
      g = Array.isArray(layout.owner) || ArrayBuffer.isView(layout.owner) ? buildEdgeGrid(layout) : null;
    } catch {
      g = null;
    }
    grids.set(layout, g);
  }
  return g;
}

function openOf(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v && typeof v === 'object' && 'open' in v) return Boolean((v as { open: unknown }).open);
  return undefined;
}

export interface DoorView {
  open: DoorOpenFn;
  /** compact signature; changes whenever any door opens/closes */
  sig: string;
}

/** Current door state for a crew (cheap: <= a few dozen doors). */
export function doorView(crew: Crew): DoorView {
  const L = crew.layout;
  if (!L) return { open: () => true, sig: '' };
  const init = initialDoorOpen(L);
  const raw = (crew.slices.interaction as { doors?: unknown } | undefined)?.doors;
  const n = L.doors.length;
  const st = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = L.doors[i].id;
    let o: boolean | undefined;
    if (L.doors[i].kind === 'open') o = true;
    else if (raw instanceof Map) o = openOf(raw.get(id));
    else if (Array.isArray(raw) || ArrayBuffer.isView(raw)) o = openOf((raw as ArrayLike<unknown>)[id]);
    else if (raw && typeof raw === 'object') o = openOf((raw as Record<string, unknown>)[id]);
    st[i] = (o ?? init(id)) ? 1 : 0;
  }
  // doors are indexed by id in generated layouts, but don't assume it
  const byId = new Map<number, number>();
  for (let i = 0; i < n; i++) byId.set(L.doors[i].id, st[i]);
  let sig = '';
  for (let i = 0; i < n; i++) sig += st[i] ? '1' : '0';
  return { open: (id) => byId.get(id) === 1, sig };
}
