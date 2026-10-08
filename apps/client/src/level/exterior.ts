// Owner: track ② Level (v1.2: env-world). Outdoor set dressing: chain-link fences (lot boundary, kennel), cobra-head
// sodium lot lamps (housings only: ③ Render draws the light + glow at the fixture), facade extension + parapet in the
// site theme's facade material, ground beyond the fence, parking lines. The crew van lives in van.ts (v1.2).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { FACADE_H } from './mesher.ts';
import type { FenceRun } from './mesher.ts';
import type { LevelMaterials, MatId } from './materials.ts';
import { stencilMaterial, stencilTexture } from './stencils.ts';

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const FENCE_H = 2.3;

function chainLinkTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#c9ccc6';
  g.lineWidth = 5;
  g.beginPath();
  for (let i = -128; i <= 256; i += 32) { g.moveTo(i, 0); g.lineTo(i + 128, 128); g.moveTo(i + 128, 0); g.lineTo(i, 128); }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

let fenceMat: THREE.MeshStandardNodeMaterial | null = null;
let poleMat: THREE.MeshStandardNodeMaterial | null = null;

export interface ExteriorParts {
  /** objects visible whenever the lot (outdoor space) is visible */
  outdoor: THREE.Object3D[];
}

export function buildExterior(L: LevelLayout, fences: FenceRun[], lm: LevelMaterials, opts: { facade?: MatId } = {}): ExteriorParts {
  const out: THREE.Object3D[] = [];
  fenceMat ??= (() => {
    const m = new THREE.MeshStandardNodeMaterial({ map: chainLinkTexture(), roughness: 0.4, metalness: 0.85, alphaTest: 0.45, side: THREE.DoubleSide });
    m.name = 'level.fence';
    return m;
  })();
  poleMat ??= (() => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x6d7275, roughness: 0.35, metalness: 0.9 });
    m.name = 'level.pole';
    return m;
  })();

  // ---- fences ----
  const meshParts: THREE.BufferGeometry[] = [];
  const poleParts: THREE.BufferGeometry[] = [];
  for (const f of fences) {
    const horiz = f.z0 === f.z1;
    const len = horiz ? f.x1 - f.x0 : f.z1 - f.z0;
    const panel = new THREE.PlaneGeometry(len, FENCE_H - 0.08);
    // UVs: one diamond tile per 0.5 m
    const uv = panel.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len * 2, uv.getY(i) * (FENCE_H - 0.08) * 2);
    if (!horiz) panel.rotateY(Math.PI / 2);
    panel.translate(horiz ? (f.x0 + f.x1) / 2 : f.x0, (FENCE_H - 0.08) / 2 + 0.06, horiz ? f.z0 : (f.z0 + f.z1) / 2);
    meshParts.push(panel);
    // rails
    const rail = (y: number) => {
      const g = new THREE.CylinderGeometry(0.022, 0.022, len, 6).rotateZ(Math.PI / 2);
      if (!horiz) g.rotateY(Math.PI / 2);
      return g.translate(horiz ? (f.x0 + f.x1) / 2 : f.x0, y, horiz ? f.z0 : (f.z0 + f.z1) / 2);
    };
    poleParts.push(rail(FENCE_H), rail(0.07));
    const n = Math.max(1, Math.round(len / 2.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = horiz ? f.x0 + t * len : f.x0, z = horiz ? f.z0 : f.z0 + t * len;
      poleParts.push(new THREE.CylinderGeometry(0.035, 0.04, FENCE_H + 0.05, 8).translate(x, (FENCE_H + 0.05) / 2, z));
    }
  }
  if (meshParts.length) {
    const fm = new THREE.Mesh(mergeGeometries(meshParts), fenceMat);
    fm.name = 'fence.mesh';
    out.push(fm);
    const fp = new THREE.Mesh(mergeGeometries(poleParts.map((g) => g.toNonIndexed())), poleMat);
    fp.name = 'fence.poles';
    out.push(fp);
  }

  // ---- lot lamps (housing at the fixture; ③ draws the light + glow) ----
  const lampParts: THREE.BufferGeometry[] = [];
  const headParts: THREE.BufferGeometry[] = [];
  for (const it of L.items) {
    if (it.kind !== 'light') continue;
    const kind = String(it.data?.kind ?? '');
    if (kind === 'lamp') {
      // cobra head: tapered pole, a curved outreach arm, a teardrop housing over the lens (the fixture point)
      const y = it.y ?? 6;
      lampParts.push(new THREE.CylinderGeometry(0.06, 0.12, y - 0.1, 12).translate(it.x, (y - 0.1) / 2, it.z + 0.9));
      const arm = new THREE.QuadraticBezierCurve3(new THREE.Vector3(it.x, y - 0.2, it.z + 0.9), new THREE.Vector3(it.x, y + 0.32, it.z + 0.85), new THREE.Vector3(it.x, y + 0.2, it.z + 0.28));
      lampParts.push(new THREE.TubeGeometry(arm, 10, 0.04, 8, false));
      headParts.push(new THREE.SphereGeometry(0.3, 16, 10).scale(0.78, 0.36, 1.25).translate(it.x, y + 0.17, it.z + 0.04));
      headParts.push(new THREE.CylinderGeometry(0.2, 0.24, 0.05, 16).scale(1, 1, 1.4).translate(it.x, y + 0.07, it.z));
      lampParts.push(new THREE.CylinderGeometry(0.28, 0.32, 0.25, 10).translate(it.x, 0.12, it.z + 0.9));
    } else if (kind === 'wall') {
      headParts.push(box(0.5, 0.12, 0.3, it.x, (it.y ?? 2.75) + 0.12, it.z + 0.02));
    }
  }
  if (lampParts.length) {
    const lp = new THREE.Mesh(mergeGeometries(lampParts.map((g) => g.toNonIndexed())), poleMat);
    lp.name = 'lamps.poles';
    out.push(lp);
  }
  if (headParts.length) {
    const hp = new THREE.Mesh(mergeGeometries(headParts), lm.get('metal_dark'));
    hp.name = 'lamps.heads';
    out.push(hp);
  }

  // ---- facade line: extend the building beyond the lot fence on both sides + parapet along the top ----
  const lot = L.spaces.find((s) => s.open && s.type === 'lot');
  if (lot) {
    const fz = lot.rect.y; // facade line (lot's north edge)
    const ext = 40;
    const facade = lm.get(opts.facade ?? 'facade');
    const parts: THREE.BufferGeometry[] = [];
    parts.push(box(ext, FACADE_H, 10, -ext / 2, FACADE_H / 2, fz + HALF_T - 5));
    parts.push(box(ext, FACADE_H, 10, L.W + ext / 2, FACADE_H / 2, fz + HALF_T - 5));
    const fx = new THREE.Mesh(mergeGeometries(parts), facade);
    fx.name = 'facade.ext';
    out.push(fx);
    const par = new THREE.Mesh(box(L.W + 2 * ext, 0.35, 0.4, L.W / 2, FACADE_H + 0.175, fz - 0.12), lm.get('wall_concrete_dark'));
    par.name = 'facade.parapet';
    out.push(par);
    // facade detail on the lot side: barred dark windows, a canopy over the entrance, plinth band, AC units, sign
    const zf = fz + HALF_T;
    const doorXs: number[] = [];
    for (const d of L.doors) if (d.kind === 'exit' && d.dir === 'h' && d.y === fz) doorXs.push(d.x + d.len / 2);
    for (const it of L.items) if (it.kind === 'prop' && it.data?.prop === 'entrance_door') doorXs.push(it.x);
    const glassParts: THREE.BufferGeometry[] = [];
    const frameParts: THREE.BufferGeometry[] = [];
    const barParts: THREE.BufferGeometry[] = [];
    for (let x = -ext + 3; x < L.W + ext - 2; x += 4.5) {
      if (doorXs.some((dx) => Math.abs(dx - x) < 2.6)) continue;
      glassParts.push(box(1.5, 0.95, 0.04, x, 2.35, zf + 0.01));
      frameParts.push(box(1.66, 0.08, 0.12, x, 1.84, zf + 0.04), box(1.66, 0.08, 0.1, x, 2.86, zf + 0.03));
      frameParts.push(box(0.08, 1.1, 0.1, x - 0.79, 2.35, zf + 0.03), box(0.08, 1.1, 0.1, x + 0.79, 2.35, zf + 0.03));
      for (const bx of [-0.45, -0.15, 0.15, 0.45]) barParts.push(new THREE.CylinderGeometry(0.015, 0.015, 1.0, 6).translate(x + bx, 2.35, zf + 0.07));
    }
    if (glassParts.length) {
      const wg = new THREE.MeshStandardNodeMaterial({ color: 0x0c1214, roughness: 0.12, metalness: 0.6 });
      wg.name = 'level.facade.glass';
      out.push(Object.assign(new THREE.Mesh(mergeGeometries(glassParts), wg), { name: 'facade.windows' }));
      out.push(Object.assign(new THREE.Mesh(mergeGeometries(frameParts), lm.get('wall_concrete_dark')), { name: 'facade.frames' }));
      out.push(Object.assign(new THREE.Mesh(mergeGeometries(barParts.map((g) => g.toNonIndexed())), lm.get('metal_rusty')), { name: 'facade.bars' }));
    }
    // plinth band along the facade foot, cut at every doorway: it used to run straight across the entrance, so the
    // outward-swinging front doors cut through it ("the ground rail goes through the door") and it read as a rail
    // across the threshold. Gaps = the opening plus the frame casing on both sides.
    const gaps: [number, number][] = [];
    for (const d of L.doors) if (d.dir === 'h' && d.y === fz && d.kind !== 'open') gaps.push([d.x + HALF_T - 0.12, d.x + d.len - HALF_T + 0.12]);
    for (const it of L.items) if (it.kind === 'prop' && it.data?.prop === 'entrance_door') { const w = Number(it.data.w ?? 2); gaps.push([it.x - w / 2 - 0.14, it.x + w / 2 + 0.14]); }
    gaps.sort((a, b) => a[0] - b[0]);
    const plinthParts: THREE.BufferGeometry[] = [];
    let px0 = -ext;
    for (const [g0, g1] of [...gaps, [L.W + ext, L.W + ext] as [number, number]]) {
      if (g0 - px0 > 0.02) plinthParts.push(box(g0 - px0, 0.45, 0.1, (px0 + g0) / 2, 0.225, zf + 0.04));
      px0 = Math.max(px0, g1);
    }
    const plinth = new THREE.Mesh(mergeGeometries(plinthParts), lm.get('wall_concrete_dark'));
    plinth.name = 'facade.plinth';
    out.push(plinth);
    const det: THREE.BufferGeometry[] = [];
    for (const dx of doorXs) {
      det.push(box(3.6, 0.16, 1.4, dx, 3.05, zf + 0.7)); // canopy
      det.push(box(0.12, 0.6, 1.3, dx - 1.7, 3.35, zf + 0.65), box(0.12, 0.6, 1.3, dx + 1.7, 3.35, zf + 0.65));
    }
    for (let x = 6; x < L.W - 3; x += 13) det.push(box(1.0, 0.7, 0.55, x, 3.7, zf + 0.3)); // AC units high on the wall
    for (const x of [1.2, L.W - 1.2]) det.push(new THREE.CylinderGeometry(0.07, 0.07, FACADE_H, 8).translate(x, FACADE_H / 2, zf + 0.12)); // downpipes
    if (det.length) out.push(Object.assign(new THREE.Mesh(mergeGeometries(det.map((g) => g.toNonIndexed())), lm.get('metal_painted')), { name: 'facade.details' }));
    if (doorXs.length) {
      const { aspect } = stencilTexture('AUTHORIZED PERSONNEL ONLY', '#d8d2c0');
      const sw = 3.2, sh = sw / aspect;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), stencilMaterial('AUTHORIZED PERSONNEL ONLY', '#d8d2c0'));
      sign.position.set(doorXs[0], 3.85, zf + 0.006);
      sign.name = 'facade.sign';
      out.push(sign);
    }
    // ground beyond the fence (below the lot asphalt, no overlap issues at 2 cm)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2).translate(L.W / 2, -0.02, lot.rect.y + lot.rect.h / 2 + 60), lm.get('floor_dirt'));
    ground.name = 'ground';
    out.push(ground);
    // painted parking stalls along the far fence
    const lineMat = new THREE.MeshStandardNodeMaterial({ color: 0xbdb9a8, roughness: 0.8, metalness: 0 });
    lineMat.polygonOffset = true; lineMat.polygonOffsetFactor = -2; lineMat.polygonOffsetUnits = -2;
    lineMat.name = 'level.paint';
    const lines: THREE.BufferGeometry[] = [];
    const zEnd = lot.rect.y + lot.rect.h;
    const vanX0 = L.van.cab.x - 1.5, vanX1 = L.van.cab.x + L.van.cab.w + 1.5;
    for (let x = 1.5; x < L.W - 1; x += 2.8) {
      if (x > vanX0 && x < vanX1) continue;
      lines.push(new THREE.PlaneGeometry(0.1, 4.6).rotateX(-Math.PI / 2).translate(x, 0.003, zEnd - 2.6));
    }
    if (lines.length) {
      const lm2 = new THREE.Mesh(mergeGeometries(lines), lineMat);
      lm2.name = 'lot.lines';
      out.push(lm2);
    }
  }

  return { outdoor: out };
}
