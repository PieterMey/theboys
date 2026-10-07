// Owner: env-layout (v1.2). Lore spots: kind 'prop' items {prop: 'lore_<style>', lore: idx} + 'drawer' spots on
// containers. The fieldguide picks which carry a bulletin or page. Contract skeleton: keep exports.
import type { LevelLayout } from '../layout.ts';

export type LoreStyle = 'board' | 'clipboard' | 'plaque' | 'blackboard' | 'frame' | 'safety_card' | 'drawer';
export interface LoreSpot {
  /** host prop id; 'drawer' spots use the container id */
  id: string;
  idx: number;
  style: LoreStyle;
  space: number;
  roomType: string;
  x: number; y: number; z: number; rot: number;
  /** page aim point */
  p: [number, number, number];
  container?: string;
  part?: number;
}
/** 3..6 wall spots (+ up to 2 drawer spots) per facility; none in hub, van, vault, lobby or clue-note rooms */
export function loreSpotsOf(_L: LevelLayout): readonly LoreSpot[] {
  return [];
}
