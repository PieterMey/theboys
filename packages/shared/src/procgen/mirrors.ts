// Owner: env-layout (v1.2). Van mirror (hub kind 'mirror' item / facility prop van_mirror) + decorative mirrors
// (kind 'prop' with data.mirror). Contract skeleton derived from items; keep exports.
import type { LevelLayout } from '../layout.ts';

export type MirrorKind = 'strip' | 'hand' | 'hall' | 'dressing' | 'van';
export interface MirrorSpot {
  id: string;
  kind: MirrorKind;
  space: number;
  /** glass centre (y = mount height) */
  x: number; y: number; z: number;
  /** glass faces normalOfYaw(rot) */
  rot: number;
  w: number; h: number;
}
const MIRROR_DIMS: Readonly<Record<MirrorKind, { w: number; h: number; y: number }>> = {
  strip: { w: 1.6, h: 0.7, y: 1.55 }, hand: { w: 0.45, h: 0.6, y: 1.5 }, hall: { w: 0.8, h: 1.4, y: 1.45 },
  dressing: { w: 0.8, h: 1.0, y: 1.5 }, van: { w: 0.45, h: 0.9, y: 1.5 },
};
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export function mirrorsOf(L: Pick<LevelLayout, 'items'>): MirrorSpot[] {
  const out: MirrorSpot[] = [];
  for (const it of L.items) {
    const dk = it.data?.mirror;
    const kind: MirrorKind | null = typeof dk === 'string' && dk in MIRROR_DIMS ? (dk as MirrorKind) : it.kind === 'mirror' ? 'van' : null;
    if (!kind) continue;
    const dim = MIRROR_DIMS[kind];
    out.push({ id: it.id, kind, space: it.space, x: it.x, y: it.y || dim.y, z: it.z, rot: it.rot ?? 0, w: num(it.data?.w, dim.w), h: num(it.data?.h, dim.h) });
  }
  return out;
}
