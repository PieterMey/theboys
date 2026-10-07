// Owner: env-layout (v1.2). Non-solid GLB props + GLB clutter paranormal may move (never solids). Pure. Keep exports.
import type { LevelLayout } from '../layout.ts';

export interface MovableRef {
  /** 'prop:<n>' or 'clutter:<index into clutterFor(layout)>' */
  ref: string;
  /** asset key ('prop.chair'); clients find the instance by key + position */
  key: string;
  kind: 'prop' | 'clutter';
  space: number;
  x: number; y: number; z: number; rot: number;
}
export function movableRefsOf(_L: LevelLayout): readonly MovableRef[] {
  return [];
}
