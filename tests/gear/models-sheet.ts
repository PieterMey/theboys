// v1.2 item models (G3): contact sheets of every procedural model, drawn by a small CPU rasterizer in Node (no GPU, no
// browser): z-buffered triangles, vertex colour x the atlas region's colour (prints show as their ground colour: canvas
// text needs a browser), hemisphere + key light, metal sheen, emissive, clear parts blended. For iterating on shapes,
// proportions and colours; the browser e2e (tests/gear/visual.e2e.ts --models) shows the real thing.
// Run: node tests/gear/models-sheet.ts [outDir] [--keys k1,k2] [--legacy] [--views floor,front,top] [--glb <assets dist>]
//   views: floor (3/4 on a floor), front, top, hand (the view-model pose from the eye), drawer (fitted into a desk drawer)
//   --glb: the real models from that dist (manifest + props/*.glb, decoded here: shapes and rest poses in flat grey)
//   -> <outDir>/sheet-<views>-<n>.png (2 models x 3 views per row, 4 rows) + the cell legend on stdout
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import * as THREE from 'three/webgpu';

const ctx2d: object = new Proxy(function stub() { /* no-op */ }, { get: () => () => ctx2d, set: () => true, apply: () => ctx2d });
(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
const V = await import('../../apps/client/src/interaction/visuals.ts');

const args = process.argv.slice(2);
const optArg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--'))) ?? 'tests/artifacts/gear-v12/sheets';
const keysArg = optArg('--keys');
const only = keysArg ? new Set(keysArg.split(',')) : null;
const legacy = args.includes('--legacy');
type View = 'floor' | 'front' | 'top' | 'hand' | 'drawer';
const VIEWS = ((optArg('--views') ?? 'floor,front,top').split(',') as View[]).slice(0, 3);
const glbDir = optArg('--glb');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- atlas region colours (the print / swatch ground)
const BG: Record<string, string> = {
  brushed: '#dcdcdc', grain: '#b8b8b8', speckle: '#c8c8c8', weave: '#cfcfcf', leather: '#d0d0d0', rust: '#8a5a3c', paper: '#e6dcc2',
  'label.bottle': '#e3d6b0', 'wrap.battery': '#c9a332', 'wrap.cell': '#3f9a3a', 'wrap.flare': '#c8241b', 'label.airhorn': '#e8d8d0',
  'card.key': '#f2c230', 'card.master': '#ff8f3a', 'card.badge': '#c8d4dc', 'bonds.cert': '#d8e0cc', 'paper.typed': '#e8e6de',
  'decal.typewriter': '#6a5a20', 'cross.medical': '#e8c8c4', 'lid.tin': '#9a4a32', 'tag.dog': '#a8adb2', 'plate.deposit': '#c9a24a',
  'label.cryo': '#c8d4e0', 'panel.blade': '#30353a', 'dial.watch': '#e8e4d8', 'page.notes': '#d8d4c6', 'cover.manual': '#c8a030',
  'plaque.employee': '#c9a24a', 'label.wax': '#d0c4a4', 'face.cassette': '#c8c4b0', 'face.dashcam': '#c8b8a8', pcb: '#2f6d44',
  'dial.radio': '#8a8a60', grill: '#18191b', 'label.hazard': '#d8b030', 'face.snowglobe': '#3a3420', white: '#ffffff',
};
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const regionRGB = new Map<string, [number, number, number]>();
for (const [name, hex] of Object.entries(BG)) {
  const n = parseInt(hex.slice(1), 16);
  regionRGB.set(name, [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]);
}
/** which region a uv falls in (the white texel = none) */
const regions = [...regionRGB.keys()].map((name) => ({ name, r: V.atlasRect(name) }));
function regionOf(u: number, v: number): [number, number, number] {
  for (const { name, r } of regions) if (u >= r.u - 1e-4 && u <= r.u + r.w + 1e-4 && v >= r.v - 1e-4 && v <= r.v + r.h + 1e-4) return regionRGB.get(name)!;
  return [1, 1, 1];
}

// ---------------------------------------------------------------- the rasterizer
interface Img { w: number; h: number; rgb: Float32Array; z: Float32Array }
const newImg = (w: number, h: number, bg: [number, number, number]): Img => {
  const img = { w, h, rgb: new Float32Array(w * h * 3), z: new Float32Array(w * h).fill(Infinity) };
  for (let i = 0; i < w * h; i++) { img.rgb[i * 3] = bg[0]; img.rgb[i * 3 + 1] = bg[1]; img.rgb[i * 3 + 2] = bg[2]; }
  return img;
};
const L1 = new THREE.Vector3(0.45, 0.8, 0.55).normalize(), L2 = new THREE.Vector3(-0.6, 0.35, -0.4).normalize();
function shade(n: THREE.Vector3, view: THREE.Vector3, c: [number, number, number], rough: number, metal: number, e: [number, number, number]): [number, number, number] {
  const hemi = 0.28 + 0.22 * (n.y * 0.5 + 0.5);
  const d1 = Math.max(0, n.dot(L1)), d2 = Math.max(0, n.dot(L2)) * 0.35;
  const diff = (1 - metal * 0.75) * (hemi + d1 * 0.95 + d2);
  // a crude sheen: Blinn-Phong on the key light, sharper when smooth; metals tint it
  const hv = L1.clone().add(view).normalize();
  const sp = Math.pow(Math.max(0, n.dot(hv)), 4 + (1 - rough) * 60) * (0.08 + (1 - rough) * 0.9) * (0.4 + metal * 0.8);
  const env = metal * (0.25 + 0.35 * (n.y * 0.5 + 0.5));
  return [0, 1, 2].map((k) => c[k]! * (diff + env) + sp * (metal > 0.5 ? c[k]! * 1.4 : 1) + e[k]!) as [number, number, number];
}
function drawGroup(img: Img, grp: THREE.Object3D, cam: THREE.PerspectiveCamera, clearPass: boolean): void {
  cam.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  grp.updateMatrixWorld(true);
  const camPos = cam.getWorldPosition(new THREE.Vector3());
  grp.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const mat = m.material as THREE.Material;
    if (mat.blending === THREE.AdditiveBlending) return; // halos
    const clear = !!mat.transparent;
    if (clear !== clearPass) return;
    const gm = m.geometry;
    const pos = gm.attributes.position!, nor = gm.attributes.normal, col = gm.attributes.color, ixs = gm.attributes.ixs, ixe = gm.attributes.ixe, uvA = gm.attributes.uv;
    const idx = gm.index;
    const nTri = (idx ? idx.count : pos.count) / 3;
    const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
    const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], W = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const S: number[][] = [[], [], []];
    const std = mat as THREE.MeshStandardMaterial;
    for (let t = 0; t < nTri; t++) {
      const vi = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k));
      for (let k = 0; k < 3; k++) {
        W[k]!.fromBufferAttribute(pos, vi[k]!).applyMatrix4(m.matrixWorld);
        P[k]!.copy(W[k]!).applyMatrix4(vp);
        S[k] = [(P[k]!.x * 0.5 + 0.5) * img.w, (1 - (P[k]!.y * 0.5 + 0.5)) * img.h, P[k]!.z];
      }
      if (S.some((s) => s[2]! < -1 || s[2]! > 1)) continue;
      // per-vertex surface
      const vs = vi.map((i) => {
        const n = nor ? new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(nm).normalize() : new THREE.Vector3(0, 1, 0);
        let c: [number, number, number] = col ? [col.getX(i), col.getY(i), col.getZ(i)] : [std.color?.r ?? 0.8, std.color?.g ?? 0.8, std.color?.b ?? 0.8];
        if (uvA && col) { const r = regionOf(uvA.getX(i), uvA.getY(i)); c = [c[0] * r[0], c[1] * r[1], c[2] * r[2]]; }
        const rough = ixs ? ixs.getX(i) : std.roughness ?? 0.6, metal = ixs ? ixs.getY(i) : std.metalness ?? 0;
        const e: [number, number, number] = ixe ? [ixe.getX(i), ixe.getY(i), ixe.getZ(i)] : [0, 0, 0];
        const a = col && col.itemSize === 4 ? col.getW(i) : 1;
        return { n, c, rough, metal, e, a };
      });
      // face normal toward the camera (back faces of single-sided parts are culled like the GPU does)
      const fn = new THREE.Vector3().subVectors(W[1]!, W[0]!).cross(new THREE.Vector3().subVectors(W[2]!, W[0]!));
      const toCam = new THREE.Vector3().subVectors(camPos, W[0]!);
      const front = fn.dot(toCam) > 0;
      if (!front && mat.side !== THREE.DoubleSide) continue;
      const view = toCam.normalize();
      const shaded = vs.map((s) => { const n = front ? s.n : s.n.clone().negate(); return { rgb: shade(n, view, s.c, s.rough, s.metal, s.e), a: s.a }; });
      // raster
      const [a, b, c] = S as [number[], number[], number[]];
      const minX = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!))), maxX = Math.min(img.w - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)));
      const minY = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!))), maxY = Math.min(img.h - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)));
      const area = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0]! - px) * (c[1]! - py) - (b[1]! - py) * (c[0]! - px)) / area;
        const w1 = ((c[0]! - px) * (a[1]! - py) - (c[1]! - py) * (a[0]! - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2]! + w1 * b[2]! + w2 * c[2]!;
        const k = y * img.w + x;
        if (z >= img.z[k]!) continue;
        const r = w0 * shaded[0]!.rgb[0] + w1 * shaded[1]!.rgb[0] + w2 * shaded[2]!.rgb[0];
        const gg = w0 * shaded[0]!.rgb[1] + w1 * shaded[1]!.rgb[1] + w2 * shaded[2]!.rgb[1];
        const bb = w0 * shaded[0]!.rgb[2] + w1 * shaded[1]!.rgb[2] + w2 * shaded[2]!.rgb[2];
        if (clear) {
          const al = (w0 * shaded[0]!.a + w1 * shaded[1]!.a + w2 * shaded[2]!.a) * 0.9;
          img.rgb[k * 3] = img.rgb[k * 3]! * (1 - al) + r * al; img.rgb[k * 3 + 1] = img.rgb[k * 3 + 1]! * (1 - al) + gg * al; img.rgb[k * 3 + 2] = img.rgb[k * 3 + 2]! * (1 - al) + bb * al;
        } else { img.z[k] = z; img.rgb[k * 3] = r; img.rgb[k * 3 + 1] = gg; img.rgb[k * 3 + 2] = bb; }
      }
    }
  });
}
/** a floor tile under the model (shaded like the models: a grey concrete) */
function drawFloor(img: Img, cam: THREE.PerspectiveCamera, half: number): void {
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2, 8, 8).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6a6c6e, roughness: 0.95 }));
  drawGroup(img, fl, cam, false);
}

// ---------------------------------------------------------------- real models: GLB -> template (as the level's loader + buildTemplate)
interface MeshoptLike { ready: Promise<void>; decodeGltfBuffer(t: Uint8Array, c: number, s: number, src: Uint8Array, m: string, f: string): void }
const PART_RE = /(_drawer_\d\d|_tray_\d\d|_lid|_door)$/;
function decodeGlb(buf: Buffer, dec: MeshoptLike): { geometry: THREE.BufferGeometry; material: THREE.Material; part: boolean }[] {
  const jlen = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + jlen).toString('utf8'));
  const bin = buf.subarray(20 + jlen + 8);
  const views = new Map<number, Uint8Array>();
  const view = (vi: number): Uint8Array => {
    let v = views.get(vi);
    if (v) return v;
    const bv = j.bufferViews[vi];
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (ext) {
      v = new Uint8Array(ext.count * ext.byteStride);
      dec.decodeGltfBuffer(v, ext.count, ext.byteStride, bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength), ext.mode, ext.filter ?? 'NONE');
    } else v = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
    views.set(vi, v);
    return v;
  };
  const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const NC: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (ai: number): Float32Array => {
    const a = j.accessors[ai], bv = j.bufferViews[a.bufferView];
    const bytes = view(a.bufferView), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nc = NC[a.type]!, cs = SIZE[a.componentType]!;
    const stride = bv.byteStride ?? bv.extensions?.EXT_meshopt_compression?.byteStride ?? nc * cs;
    const out = new Float32Array(a.count * nc);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < nc; k++) {
      const off = (a.byteOffset ?? 0) + i * stride + k * cs;
      const ct = a.componentType;
      let v = ct === 5126 ? dv.getFloat32(off, true) : ct === 5123 ? dv.getUint16(off, true) : ct === 5122 ? dv.getInt16(off, true) : ct === 5121 ? dv.getUint8(off) : ct === 5125 ? dv.getUint32(off, true) : dv.getInt8(off);
      if (a.normalized) v = ct === 5120 ? Math.max(v / 127, -1) : ct === 5121 ? v / 255 : ct === 5122 ? Math.max(v / 32767, -1) : ct === 5123 ? v / 65535 : v;
      out[i * nc + k] = v;
    }
    return out;
  };
  const res: { geometry: THREE.BufferGeometry; material: THREE.Material; part: boolean }[] = [];
  const walk = (ni: number, parent: THREE.Matrix4, part: boolean) => {
    const n = j.nodes[ni];
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const w = parent.clone().multiply(m);
    const isPart = part || (!!n.name && PART_RE.test(n.name));
    if (n.mesh !== undefined) for (const p of j.meshes[n.mesh].primitives) {
      const gm = new THREE.BufferGeometry();
      gm.setAttribute('position', new THREE.BufferAttribute(read(p.attributes.POSITION), 3));
      if (p.attributes.NORMAL !== undefined) gm.setAttribute('normal', new THREE.BufferAttribute(read(p.attributes.NORMAL), 3));
      if (p.indices !== undefined) gm.setIndex(Array.from(read(p.indices)));
      gm.applyMatrix4(w);
      if (!gm.attributes.normal) gm.computeVertexNormals();
      const mj = j.materials?.[p.material] ?? {};
      res.push({ geometry: gm, material: new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.6, metalness: Math.min(0.25, mj.pbrMetallicRoughness?.metallicFactor ?? 1), side: mj.doubleSided ? THREE.DoubleSide : THREE.FrontSide }), part: isPart });
    }
    for (const ch of n.children ?? []) walk(ch, w, isPart);
  };
  for (const ni of j.scenes[j.scene ?? 0].nodes) walk(ni, new THREE.Matrix4(), false);
  return res;
}
if (glbDir) {
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js') as unknown as { MeshoptDecoder: MeshoptLike };
  await MeshoptDecoder.ready;
  const manifest = JSON.parse(readFileSync(join(glbDir, 'manifest.json'), 'utf8')) as { files: Record<string, { url: string; source?: string }> };
  for (const key of V.realModelKeys()) {
    if (only && !only.has(key)) continue;
    const rp = V.realModelProp(key, manifest.files);
    if (!rp) { console.log(`no real model for ${key}`); continue; }
    const buf = readFileSync(join(glbDir, manifest.files[`prop.${rp.prop}`]!.url));
    const all = decodeGlb(buf, MeshoptDecoder);
    // buildTemplate: the whole model (parts included) centred on x/z and standing on y = 0; the body drops the parts
    const bb = new THREE.Box3();
    for (const m of all) { m.geometry.computeBoundingBox(); bb.union(m.geometry.boundingBox!); }
    const c = bb.getCenter(new THREE.Vector3());
    const meshes = all.filter((m) => !rp.body || !m.part);
    for (const m of meshes) m.geometry.translate(-c.x, -bb.min.y, -c.z);
    const t = V.makeItemTemplate(key, rp.prop, meshes.map((m) => ({ geometry: m.geometry, material: m.material })));
    if (t) { V.registerItemTemplate(t); console.log(`real model ${key} <- ${rp.prop}: ${t.size.toArray().map((v) => v.toFixed(3)).join(' x ')}`); }
  }
}

// ---------------------------------------------------------------- the sheet
const CW = 220, CH = 165, SS = 2, COLS = 6;
function boxOf(o: THREE.Object3D): THREE.Box3 {
  const b = new THREE.Box3();
  o.updateMatrixWorld(true);
  o.traverse((q) => { const m = q as THREE.Mesh; if (m.isMesh && (m.material as THREE.Material).blending !== THREE.AdditiveBlending) b.union(new THREE.Box3().setFromObject(m, true)); });
  return b;
}
function cell(s: { type: string; name?: string; key: string }, view: View): Img {
  const img = newImg(CW * SS, CH * SS, [0.035, 0.038, 0.042]);
  const grp = V.buildItemModel(s.type, { name: s.name, legacy, vm: view === 'hand' });
  const size = (grp.userData.size as THREE.Vector3 | undefined) ?? new THREE.Vector3(0.1, 0.1, 0.1);
  const cam = new THREE.PerspectiveCamera(34, CW / CH, 0.005, 20);
  const holder = new THREE.Group();
  holder.add(grp);
  if (view === 'hand') {
    // the view model as the player sees it: the left-hand holder in front of the eye, posed
    const pose = V.viewModelPose(s.type, String(grp.userData.key), !!grp.userData.glb, size, legacy);
    holder.position.set(-0.25, -0.25, -0.5);
    grp.position.set(...pose.pos);
    grp.rotation.set(...pose.rot);
    grp.scale.setScalar(pose.scale);
    const c = boxOf(holder).getCenter(new THREE.Vector3());
    cam.fov = 42;
    cam.updateProjectionMatrix();
    cam.position.set(0, 0, 0);
    cam.lookAt(c);
    drawGroup(img, holder, cam, false);
    drawGroup(img, holder, cam, true);
    return img;
  }
  if (view === 'drawer') {
    // a desk drawer (0.41 x 0.40, 0.16 walls) opened toward the camera: the model fitted the way the game fits it
    const d = V.DESK_DRAWER;
    const lying = s.type === 'bottle';
    const L = Math.max(size.x, size.y, size.z);
    const base = /^(s\.|loot\.(small|medium|heavy))/.test(String(grp.userData.key)) && L < V.MIN_SALVAGE ? V.MIN_SALVAGE / L : 1;
    // a bottle lies front to back in a drawer (as the game lays it)
    const sc = V.drawerFitScale(size, lying, base, lying ? Math.PI / 2 : 0, d.w, d.depth, d.hMax);
    grp.scale.setScalar(sc);
    if (lying) { grp.rotation.set(0, Math.PI / 2, Math.PI / 2 * 0.98); grp.position.set(0, Math.max(size.x, size.z) * sc / 2, -size.y * sc / 2); }
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.8 });
    const tray = new THREE.Group();
    const add = (w: number, h: number, dd: number, x: number, y: number, z: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), wood); m.position.set(x, y, z); tray.add(m); };
    add(0.41, 0.01, 0.4, 0, -0.005, 0);
    add(0.012, 0.16, 0.4, -0.211, 0.07, 0);
    add(0.012, 0.16, 0.4, 0.211, 0.07, 0);
    add(0.434, 0.16, 0.012, 0, 0.07, -0.206);
    add(0.434, 0.12, 0.012, 0, 0.05, 0.206);
    cam.position.set(0.05, 0.55, 0.62);
    cam.lookAt(0, 0.04, 0);
    drawGroup(img, tray, cam, false);
    drawGroup(img, holder, cam, false);
    drawGroup(img, holder, cam, true);
    return img;
  }
  const b = boxOf(holder);
  const c = b.getCenter(new THREE.Vector3()), r = Math.max(0.03, b.getSize(new THREE.Vector3()).length() / 2);
  const dir = view === 'floor' ? new THREE.Vector3(0.62, 0.62, 1).normalize() : view === 'front' ? new THREE.Vector3(0.08, 0.18, 1).normalize() : new THREE.Vector3(0.02, 1, 0.12).normalize();
  cam.position.copy(c).addScaledVector(dir, r / Math.sin((34 * Math.PI) / 360) * 1.08);
  cam.lookAt(c);
  if (view !== 'top') drawFloor(img, cam, Math.max(0.5, r * 4));
  drawGroup(img, holder, cam, false);
  drawGroup(img, holder, cam, true);
  return img;
}

function toPng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; }); }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const enc = (v: number) => { const t = v * 1.15 / (1 + v * 0.55); const s = t <= 0.0031308 ? t * 12.92 : 1.055 * t ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(s * 255))); };

const samples = V.itemSamples().filter((s) => !only || only.has(s.key));
const PER = COLS * 4 / 3 | 0; // models per sheet: 2 per row (3 views each)... 6 cells per row = 2 models
const MODELS_PER_ROW = 2, ROWS = 4, PER_SHEET = MODELS_PER_ROW * ROWS;
void PER;
for (let sheet = 0; sheet * PER_SHEET < samples.length; sheet++) {
  const list = samples.slice(sheet * PER_SHEET, (sheet + 1) * PER_SHEET);
  const W2 = CW * COLS, H2 = CH * ROWS;
  const out = new Uint8Array(W2 * H2 * 3);
  const legend: string[] = [];
  list.forEach((s, i) => {
    const row = Math.floor(i / MODELS_PER_ROW), col0 = (i % MODELS_PER_ROW) * 3;
    legend.push(`row ${row + 1} ${i % MODELS_PER_ROW ? 'right' : 'left '}: ${s.key}${s.name ? ` (${s.name})` : ''}`);
    VIEWS.forEach((view, vi) => {
      const img = cell(s, view);
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        let r = 0, gg = 0, bb = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const k = ((y * SS + sy) * CW * SS + x * SS + sx) * 3; r += img.rgb[k]!; gg += img.rgb[k + 1]!; bb += img.rgb[k + 2]!; }
        const n = SS * SS, o = ((row * CH + y) * W2 + (col0 + vi) * CW + x) * 3;
        // a 1 px separator between cells
        const edge = x === 0 || y === 0 ? 0.6 : 1;
        out[o] = enc(r / n) * edge; out[o + 1] = enc(gg / n) * edge; out[o + 2] = enc(bb / n) * edge;
      }
    });
  });
  const file = join(outDir, `sheet-${VIEWS.join('-')}-${sheet}${legacy ? '-legacy' : ''}${glbDir ? '-glb' : ''}.png`);
  writeFileSync(file, toPng(W2, H2, out));
  console.log(file);
  for (const l of legend) console.log('  ', l);
}
