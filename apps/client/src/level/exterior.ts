// Owner: track ② Level. Outdoor set dressing: chain-link fences (lot boundary, kennel), sodium lot lamps (housings only:
// ③ Render draws the light + glow at the fixture), facade extension + parapet, ground beyond the fence, parking lines,
// and the crew van (boxy procedural vehicle, hollow cargo area the crew stands in, cab is solid).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { VAN_CAB_L } from '@dead-air/shared/procgen/van.ts';
import { FACADE_H } from './mesher.ts';
import type { FenceRun } from './mesher.ts';
import type { LevelMaterials } from './materials.ts';
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

export function buildExterior(L: LevelLayout, fences: FenceRun[], lm: LevelMaterials): ExteriorParts {
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
      const y = it.y ?? 6;
      lampParts.push(new THREE.CylinderGeometry(0.07, 0.11, y + 0.25, 10).translate(it.x, (y + 0.25) / 2, it.z + 0.9));
      lampParts.push(box(0.08, 0.08, 1.0, it.x, y + 0.2, it.z + 0.45));
      headParts.push(box(0.42, 0.14, 0.62, it.x, y + 0.13, it.z));
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
    const facade = lm.get('facade');
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

  out.push(buildVan(L, lm));
  return { outdoor: out };
}

/** The crew van: cargo box (hollow, the edge grid gives it walls on the cab rect), cab (solid), wheels, open rear doors. */
export function buildVan(L: LevelLayout, lm: LevelMaterials): THREE.Group {
  const v = L.van;
  const c = v.cab;
  const g = new THREE.Group();
  g.name = 'van';
  const body = lm.get('van_body');
  const dark = lm.get('metal_dark');
  const trim = lm.get('trim');
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x0f1416, roughness: 0.05, metalness: 0.7 });
  glass.name = 'level.van.glass';
  const tyre = new THREE.MeshStandardNodeMaterial({ color: 0x141414, roughness: 0.9, metalness: 0 });
  tyre.name = 'level.van.tyre';
  const x0 = c.x - 0.07, x1 = c.x + c.w + 0.07; // outer skin (collision line at c.x, players stop 0.38 m off it)
  const zr = c.y - 0.04; // rear face
  const zp = c.y + c.h; // partition between cargo and cab
  const zn = c.y + c.h + VAN_CAB_L + 0.12; // nose
  const roof = 2.45, floorY = 0.03, sill = 0.22;
  const W = x1 - x0, cx = (x0 + x1) / 2;
  const skin = 0.09;
  const parts: THREE.BufferGeometry[] = [];
  // cargo box: side walls, roof, partition (with a small window), floor
  parts.push(box(skin, roof - sill, zp - zr, x0 + skin / 2, sill + (roof - sill) / 2, (zr + zp) / 2));
  parts.push(box(skin, roof - sill, zp - zr, x1 - skin / 2, sill + (roof - sill) / 2, (zr + zp) / 2));
  parts.push(box(W, 0.1, zp - zr, cx, roof - 0.05, (zr + zp) / 2));
  parts.push(box(W - 2 * skin, roof - sill - 0.1, 0.08, cx, sill + (roof - sill - 0.1) / 2, zp));
  // rear frame around the opening (pillars + header)
  parts.push(box(0.12, roof - sill, 0.1, x0 + 0.06, sill + (roof - sill) / 2, zr + 0.05));
  parts.push(box(0.12, roof - sill, 0.1, x1 - 0.06, sill + (roof - sill) / 2, zr + 0.05));
  parts.push(box(W, 0.28, 0.1, cx, roof - 0.14, zr + 0.05));
  // cab: lower body, hood, A-pillars + roof
  parts.push(box(W, 1.0, zn - zp - 0.5, cx, sill + 0.5, zp + (zn - zp - 0.5) / 2));
  parts.push(box(W, 0.75, 0.55, cx, sill + 0.38, zn - 0.28));
  parts.push(box(W, 0.12, zn - zp - 0.9, cx, 2.16, zp + (zn - zp - 0.9) / 2));
  for (const px of [x0 + 0.06, x1 - 0.06]) {
    const pillar = box(0.1, 1.15, 0.1, 0, 0, 0).rotateX(-0.42).translate(px, 1.68, zn - 0.86);
    parts.push(pillar);
    parts.push(box(0.1, 0.95, 0.12, px, 1.7, zp + 0.06));
  }
  const bodyMesh = new THREE.Mesh(mergeGeometries(parts.map((p) => p.toNonIndexed())), body);
  bodyMesh.name = 'van.body';
  g.add(bodyMesh);
  // interior: floor plate + ribbed side liners + roof liner
  const inner: THREE.BufferGeometry[] = [];
  inner.push(box(c.w - 0.06, floorY, c.h - 0.06, c.x + c.w / 2, floorY / 2, c.y + c.h / 2));
  for (let z = c.y + 0.35; z < zp - 0.2; z += 0.55) for (const xs of [c.x + 0.02, c.x + c.w - 0.02]) inner.push(box(0.035, 1.6, 0.06, xs, 1.15, z));
  const innerMesh = new THREE.Mesh(mergeGeometries(inner), dark);
  innerMesh.name = 'van.interior';
  g.add(innerMesh);
  // cargo liner (the bare body skin is near-white and blew the cargo light out to a white box): plywood kick panels,
  // grey-green painted upper walls + partition, dark roof liner. Thin panels just inside the skin, behind the ribs.
  const ply: THREE.BufferGeometry[] = [];
  const upper: THREE.BufferGeometry[] = [];
  const zl0 = c.y + 0.02, zl1 = zp - 0.05, zlc = (zl0 + zl1) / 2, zlen = zl1 - zl0;
  const yTop = roof - 0.11, yMid = 1.15;
  for (const xs of [c.x + 0.026, c.x + c.w - 0.026]) {
    ply.push(box(0.01, yMid - floorY, zlen, xs, floorY + (yMid - floorY) / 2, zlc));
    upper.push(box(0.01, yTop - yMid, zlen, xs, yMid + (yTop - yMid) / 2, zlc));
  }
  upper.push(box(c.w - 0.06, yTop - floorY, 0.01, c.x + c.w / 2, floorY + (yTop - floorY) / 2, zp - 0.046));
  const plyMesh = new THREE.Mesh(mergeGeometries(ply), lm.get('wood'));
  plyMesh.name = 'van.liner.ply';
  g.add(plyMesh);
  const upMesh = new THREE.Mesh(mergeGeometries(upper), lm.get('metal_painted'));
  upMesh.name = 'van.liner.upper';
  g.add(upMesh);
  const roofLiner = new THREE.Mesh(box(c.w - 0.04, 0.01, zlen, c.x + c.w / 2, yTop + 0.005, zlc), dark);
  roofLiner.name = 'van.liner.roof';
  g.add(roofLiner);
  // skirt + bumpers + wheel arches
  const low: THREE.BufferGeometry[] = [];
  low.push(box(W, sill - 0.05, zn - zr - 1.9, cx, 0.05 + (sill - 0.05) / 2, (zr + zn) / 2));
  low.push(box(W + 0.04, 0.18, 0.16, cx, 0.32, zr - 0.06));
  low.push(box(W + 0.04, 0.2, 0.16, cx, 0.42, zn + 0.04));
  low.push(box(W - 0.6, 0.12, 0.05, cx, 0.62, zn + 0.01)); // grille
  const lowMesh = new THREE.Mesh(mergeGeometries(low), trim);
  lowMesh.name = 'van.trim';
  g.add(lowMesh);
  // wheels
  const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18).rotateZ(Math.PI / 2);
  const wheels: THREE.BufferGeometry[] = [];
  for (const wz of [c.y + 0.7, zn - 1.05]) for (const wx of [x0 + 0.1, x1 - 0.1]) wheels.push(wheel.clone().translate(wx, 0.36, wz));
  const wheelMesh = new THREE.Mesh(mergeGeometries(wheels), tyre);
  wheelMesh.name = 'van.wheels';
  g.add(wheelMesh);
  // windscreen + side windows
  const win: THREE.BufferGeometry[] = [];
  win.push(box(W - 0.2, 1.0, 0.04).rotateX(-0.42).translate(cx, 1.68, zn - 0.82));
  for (const wx of [x0 - 0.005, x1 + 0.005]) win.push(box(0.02, 0.62, zn - zp - 1.2, wx, 1.68, zp + 0.3 + (zn - zp - 1.2) / 2));
  const winMesh = new THREE.Mesh(mergeGeometries(win), glass);
  winMesh.name = 'van.glass';
  g.add(winMesh);
  // lights: headlights (dim warm), tail lights (red), interior partition indicator
  const head = new THREE.Mesh(mergeGeometries([box(0.3, 0.14, 0.04, x0 + 0.32, 0.86, zn + 0.01), box(0.3, 0.14, 0.04, x1 - 0.32, 0.86, zn + 0.01)]), lm.glow(0xffe1a8, 2.2));
  head.name = 'van.headlights';
  g.add(head);
  const tail = new THREE.Mesh(mergeGeometries([box(0.1, 0.4, 0.04, x0 + 0.07, 1.25, zr - 0.02), box(0.1, 0.4, 0.04, x1 - 0.07, 1.25, zr - 0.02)]), lm.glow(0xff2010, 2.5));
  tail.name = 'van.tail';
  g.add(tail);
  // rear barn doors swung open flat against the sides
  const doorGeo = mergeGeometries([box(0.05, roof - sill - 0.1, 0.95, 0, 0, 0), box(0.06, 0.5, 0.7, 0.01, 0.55, 0)]);
  for (const s of [-1, 1]) {
    const dm = new THREE.Mesh(doorGeo, body);
    dm.position.set(s < 0 ? x0 - 0.05 : x1 + 0.05, sill + (roof - sill - 0.1) / 2, zr - 0.5);
    dm.name = 'van.reardoor';
    g.add(dm);
  }
  // company livery on both flanks
  const { aspect } = stencilTexture('DEAD AIR SALVAGE', '#1f2a24');
  const lw = 2.6, lh = lw / aspect;
  for (const s of [-1, 1]) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), stencilMaterial('DEAD AIR SALVAGE', '#1f2a24'));
    decal.position.set(s < 0 ? x0 - 0.004 : x1 + 0.004, 1.45, (zr + zp) / 2);
    decal.rotation.y = s < 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(decal);
  }
  return g;
}
