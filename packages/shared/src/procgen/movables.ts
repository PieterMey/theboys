// Owner: env-layout (v1.2). Non-solid GLB props + GLB clutter paranormal may move (never solids). Pure, memoised per
// layout hash; server and clients derive the same list (clutter indices are clutterFor(layout) indices).
import type { LevelLayout } from '../layout.ts';
import { clutterFor } from './clutter.ts';
import { PROP_DEFS } from './decor.ts';

export interface MovableRef {
  /** 'prop:<n>' or 'clutter:<index into clutterFor(layout)>' */
  ref: string;
  /** asset key ('prop.chair'); clients find the instance by key + position */
  key: string;
  kind: 'prop' | 'clutter';
  space: number;
  x: number; y: number; z: number; rot: number;
}

const cache = new Map<string, readonly MovableRef[]>();
/** facility only: floor-standing non-solid asset props (chairs, boxes, cans, bottles, med kits) in rooms and corridors,
 *  then every GLB clutter piece; nothing in the van, the lot or outdoors */
export function movableRefsOf(L: LevelLayout): readonly MovableRef[] {
  const k = `${L.seed}|${L.hash}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const out = movableRefsOfFresh(L);
  if (cache.size > 16) cache.clear();
  cache.set(k, out);
  return out;
}
/** movableRefsOf without the memo (tests) */
export function movableRefsOfFresh(L: LevelLayout): MovableRef[] {
  const out: MovableRef[] = [];
  if (L.kind === 'facility') {
    const ok = (space: number) => { const s = L.spaces[space]; return !!s && !s.open && s.type !== 'van'; };
    for (const it of L.items) {
      if (it.kind !== 'prop' || it.data?.solid === true) continue;
      const key = String(it.data?.prop ?? '');
      const def = PROP_DEFS[key];
      if (!def || def.proc || def.solid || def.mount !== 'floor' || Number(it.data?.n ?? 1) > 1 || !ok(it.space)) continue;
      out.push({ ref: it.id, key: `prop.${key}`, kind: 'prop', space: it.space, x: it.x, y: it.y ?? 0, z: it.z, rot: it.rot ?? 0 });
    }
    clutterFor(L).forEach((c, i) => {
      if (c.kind !== 'glb' || !c.key || !ok(c.space)) return;
      out.push({ ref: `clutter:${i}`, key: `prop.${c.key}`, kind: 'clutter', space: c.space, x: c.x, y: c.y, z: c.z, rot: c.rot });
    });
  }
  return out;
}
