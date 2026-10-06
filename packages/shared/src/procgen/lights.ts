// Owned by track ② Level. Fixture light states and positions ('light' items; the render track owns the light pool).
import type { LayoutDoor, LayoutSpace, LightState } from '../layout.ts';
import type { Rng } from '../rng.ts';
import type { LevelTuning } from './tuning.ts';
import type { ItemList } from './common.ts';

/** Space-level light state: deeper and riskier = more off / broken. */
export function rollLight(rng: Rng, t: LevelTuning, risk: number, depth: number): LightState {
  const pBroken = t.lightBrokenBase + t.lightBrokenDepth * depth + t.lightBrokenPerRisk * (risk - 1);
  const pOff = t.lightOffBase + t.lightOffPerRisk * (risk - 1) + t.lightOffDepth * depth;
  const pFlicker = t.lightFlickerBase + t.lightFlickerPerRisk * (risk - 1);
  const r = rng.next();
  if (r < pBroken) return 'broken';
  if (r < pBroken + pOff) return 'off';
  if (r < pBroken + pOff + pFlicker) return 'flicker';
  return 'on';
}

function fixtureState(rng: Rng, t: LevelTuning, s: LightState, depth: number): LightState {
  if (!rng.chance(t.fixtureDeviate)) return s;
  if (s === 'on') return rng.chance(0.35 + 0.4 * depth) ? 'broken' : 'flicker';
  if (s === 'flicker') return 'on';
  return 'broken';
}

export interface FixtureOpts {
  lot: number;
  van: number;
  exitDoor: LayoutDoor | null;
  lotLamps: number;
}

/** Ceiling fixtures for every indoor space, lot lamps, the van interior light. */
export function addFixtures(S: readonly LayoutSpace[], items: ItemList, rng: Rng, t: LevelTuning, wallH: number, o: FixtureOpts): void {
  let maxDist = 1;
  for (const s of S) if (!s.open && s.type !== 'van') maxDist = Math.max(maxDist, s.dist);
  const yCeil = wallH - 0.04;
  for (const s of S) {
    if (s.open || s.id === o.van) continue;
    const { x, y, w, h } = s.rect;
    const depth = Math.min(1, s.dist / maxDist);
    const pts: [number, number][] = [];
    if (s.kind === 'corridor') {
      if (w <= 2 && h <= 2) pts.push([x + w / 2, y + h / 2]);
      else if (w >= h) { const n = Math.max(1, Math.round(w / 5)); for (let i = 0; i < n; i++) pts.push([x + ((i + 0.5) * w) / n, y + h / 2]); }
      else { const n = Math.max(1, Math.round(h / 5)); for (let i = 0; i < n; i++) pts.push([x + w / 2, y + ((i + 0.5) * h) / n]); }
    } else {
      const nx = Math.max(1, Math.round(w / 4.5)), ny = Math.max(1, Math.round(h / 4.5));
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([x + ((i + 0.5) * w) / nx, y + ((j + 0.5) * h) / ny]);
    }
    for (const [px, pz] of pts) {
      items.add('light', s.id, px, pz, { y: yCeil, data: { state: fixtureState(rng, t, s.light, depth), kind: 'tube' } });
    }
  }
  // parking lot: tall sodium lamps along the far fence + a wall lamp over the entrance
  const lot = S[o.lot];
  if (lot) {
    const r = lot.rect;
    for (let i = 0; i < o.lotLamps; i++) {
      const lx = r.x + ((i + 0.5) * r.w) / o.lotLamps;
      items.add('light', lot.id, lx, r.y + r.h - 1.2, { y: 6, data: { state: i === 1 && rng.chance(0.5) ? 'flicker' : 'on', kind: 'lamp' } });
    }
    if (o.exitDoor) {
      const d = o.exitDoor;
      const cx = d.dir === 'h' ? d.x + d.len / 2 : d.x;
      items.add('light', lot.id, cx, r.y + 0.2, { y: 2.75, rot: 0, data: { state: 'on', kind: 'wall' } });
    }
  }
  const van = S[o.van];
  if (van) items.add('light', van.id, van.rect.x + van.rect.w / 2, van.rect.y + van.rect.h / 2, { y: 2.05, data: { state: 'on', kind: 'van' } });
}
