import { generate } from './gen.ts';
import { buildNavGeometry } from './navgeo.ts';
import { DEFAULT_QUERY_FILTER, findPath, type Vec3 } from 'navcat';
import { generateSoloNavMesh, type SoloNavMeshOptions } from 'navcat/blocks';

const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const g = buildNavGeometry(L);
const targets = L.spaces.filter((s) => s.zone === 0 && s.kind === 'room' && Number.isFinite(s.dist)).sort((a, b) => b.dist - a.dist).slice(0, 25);
const ent = L.spaces[L.entrance].rect; const start: Vec3 = [ent.x + ent.w / 2, 0, ent.y + ent.h / 2];
for (const [cellSize, r] of [[0.1, 0.3], [0.15, 0.3], [0.15, 0.25], [0.2, 0.25], [0.2, 0.2], [0.25, 0.2]] as const) {
  const cellHeight = 0.2, h = 1.8, climb = 0.4;
  const o: SoloNavMeshOptions = {
    cellSize, cellHeight, walkableRadiusWorld: r, walkableRadiusVoxels: Math.ceil(r / cellSize), walkableClimbWorld: climb,
    walkableClimbVoxels: Math.ceil(climb / cellHeight), walkableHeightWorld: h, walkableHeightVoxels: Math.ceil(h / cellHeight),
    walkableSlopeAngleDegrees: 45, borderSize: 0, minRegionArea: 8, mergeRegionArea: 20, maxSimplificationError: 1.3,
    maxEdgeLength: 12, maxVerticesPerPoly: 5, detailSampleDistance: cellSize * 6, detailSampleMaxError: cellHeight,
  };
  const t0 = performance.now(); const res = generateSoloNavMesh({ positions: g.positions, indices: g.indices }, o); const ms = performance.now() - t0;
  let ok = 0;
  for (const s of targets) {
    const end: Vec3 = [s.rect.x + s.rect.w / 2, 0, s.rect.y + s.rect.h / 2];
    const p = findPath(res.navMesh, start, end, [1, 1, 1], DEFAULT_QUERY_FILTER);
    const last = p.path[p.path.length - 1]?.position;
    if (p.success && last && Math.hypot(last[0] - end[0], last[2] - end[2]) < 0.75) ok++;
  }
  console.log(`cellSize=${cellSize} radius=${r} genMs=${ms.toFixed(0)} reachable ${ok}/${targets.length} (1 m doors, 0.2 m walls)`);
}
