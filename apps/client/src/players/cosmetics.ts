// Owner: track ⑤ Players. Procedural helmets (dome / box / diver) with an emissive visor (CanvasTexture glyphs),
// a helmet lamp housing, badge decals and nameplates. All geometry is built in "helmet space":
// origin = centre of the head, +Y up, +Z forward (character facing), metres.
// v1.2 draw budget: a helmet is 2 meshes (the hard parts baked into one geometry whose colour / roughness / metalness /
// glow live in vertex attributes under ONE shared material, plus the per-profile visor), the merged mannequin body is
// one skinned mesh with one material (bodyMaterial), the placeholder body 3 meshes.
import * as THREE from 'three/webgpu';
import { abs, attribute, float, materialColor, materialSheen, max, mix, mx_fractal_noise_float, positionGeometry, smoothstep, uniform, vec3 } from 'three/tsl';
import type { HelmetKind, Profile } from '@dead-air/shared/profile.ts';
import { constantAttribute, mergeParts, placeGeometry } from './merge.ts';
import type { PlacedPart } from './merge.ts';

/**
 * Work-suit fabric for the UAL mannequin body (look pass, track ③): the bare colour slot read as a naked plastic
 * mannequin. No UVs on the rig, so patterns live in normalised bind-pose space (T-pose box: y 0 = soles .. 1 = crown,
 * dx = distance from the body axis in body heights): retro-reflective hi-vis tape on the chest, upper arms and shins,
 * a coarse woven breakup in albedo + roughness, grime rising from the boots, a soft fabric sheen. The profile colour
 * stays in material.color (a uniform), so every suit shares one shader program.
 */
export function suitMaterial(primary: THREE.Color, geo: THREE.BufferGeometry, normalMap?: THREE.Texture | null): THREE.MeshPhysicalNodeMaterial {
  geo.computeBoundingBox();
  const bb = geo.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  const n = suitNodes(bb);
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.color.copy(primary);
  m.colorNode = n.color;
  m.roughnessNode = n.roughness;
  m.metalnessNode = n.metalness;
  m.sheen = 0.55;
  m.sheenRoughness = 0.55;
  m.sheenColor = new THREE.Color(0x9a9a92);
  if (normalMap) m.normalMap = normalMap;
  return m;
}

/**
 * v1.2 draw budget: the merged mannequin body (rig.ts mergeBodyParts) in ONE material. Vertex attribute 'jmask' is
 * 0 on the suit, 1 on the joints: suit = the woven suit above (sheen), joints = jointMaterial's dark rubber
 * (clearcoat). Sheen and clearcoat are each zero on the other part, which shades exactly like the two materials did.
 * `suitBox` = the suit part's own bind-pose box (the pattern space must not grow by the joints).
 */
export function bodyMaterial(primary: THREE.Color, secondary: THREE.Color, suitBox: THREE.Box3): THREE.MeshPhysicalNodeMaterial {
  const n = suitNodes(suitBox);
  const jm = attribute('jmask', 'float');
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'M_Body';
  m.color.copy(primary);
  m.colorNode = mix(n.color, uniform(jointColor(secondary)), jm);
  m.roughnessNode = mix(n.roughness, float(0.5), jm);
  m.metalnessNode = mix(n.metalness, float(0), jm);
  m.sheen = 0.55;
  m.sheenRoughness = 0.55;
  m.sheenColor = new THREE.Color(0x9a9a92);
  m.sheenNode = materialSheen.mul(float(1).sub(jm));
  m.clearcoatNode = jm.mul(0.4);
  m.clearcoatRoughnessNode = float(0.35);
  return m;
}

/** the suit pattern (colour / roughness / metalness nodes) in the normalised space of bind-pose box `bb` */
function suitNodes(bb: THREE.Box3) {
  const size = bb.getSize(new THREE.Vector3());
  const lo = uniform(bb.min.clone());
  const inv = uniform(new THREE.Vector3(1 / Math.max(1e-6, size.x), 1 / Math.max(1e-6, size.y), 1 / Math.max(1e-6, size.z)));
  const aspect = uniform(size.x / Math.max(1e-6, size.y));
  const q = positionGeometry.sub(lo).mul(inv);
  const y = q.y;
  const dx = abs(q.x.sub(0.5)).mul(aspect);
  const torso = smoothstep(0.15, 0.12, dx);
  const arm = smoothstep(0.11, 0.14, dx).mul(smoothstep(0.7, 0.74, y));
  const band = (c: number, w: number) => smoothstep(w, w * 0.55, abs(y.sub(c)));
  const tape = max(max(band(0.675, 0.017).mul(torso), band(0.14, 0.014).mul(smoothstep(0.3, 0.25, y))), smoothstep(0.013, 0.007, abs(dx.sub(0.205))).mul(arm)).clamp(0, 1);
  const weave = mx_fractal_noise_float(q.mul(vec3(46, 70, 46)), 2, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const blot = mx_fractal_noise_float(q.mul(vec3(6, 9, 6)), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const grime = smoothstep(0.34, 0.02, y).mul(0.5).add(blot.mul(0.2)).clamp(0, 0.8);
  // webbing: utility belt + two chest harness straps up to the shoulders (breaks the bare-mannequin torso)
  const belt = band(0.555, 0.02).mul(torso);
  const straps = smoothstep(0.016, 0.009, abs(dx.sub(0.052))).mul(smoothstep(0.55, 0.57, y)).mul(smoothstep(0.82, 0.79, y));
  const web = max(belt, straps).clamp(0, 1);
  const tinted = materialColor.rgb;
  const muted = mix(tinted, vec3(tinted.dot(vec3(0.2126, 0.7152, 0.0722))), 0.22).mul(0.88);
  const base = muted.mul(weave.mul(0.14).add(0.92));
  const dirty = mix(base, base.mul(vec3(0.4, 0.36, 0.31)), grime);
  return {
    color: mix(mix(dirty, vec3(0.045, 0.043, 0.04), web), vec3(0.74, 0.76, 0.72), tape),
    roughness: mix(mix(mix(float(0.7), float(0.92), weave).add(grime.mul(0.06)), float(0.62), web), float(0.3), tape),
    metalness: mix(float(0), float(0.3), tape),
  };
}

/** joint rubber colour: the profile's second colour, darkened */
function jointColor(secondary: THREE.Color): THREE.Color {
  return secondary.clone().multiplyScalar(0.22).add(new THREE.Color(0.018, 0.018, 0.02));
}

/** suit joints (knees, elbows, shoulders, neck ring, gloves): dark rubber tinted by the profile's second colour */
export function jointMaterial(secondary: THREE.Color): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.35 });
  m.color.copy(jointColor(secondary));
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
}

const texCache = new Map<string, THREE.CanvasTexture>();

/** Visor texture: dark glass with glowing glyphs + scanlines. Cached per glyphs/colour. */
export function visorTexture(glyphs: string, color: string): THREE.CanvasTexture {
  const key = `${glyphs}|${color}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, W, H);
  // faint inner glow so the visor reads in the dark even without glyphs
  const grd = g.createRadialGradient(W / 2, H / 2, 8, W / 2, H / 2, W * 0.55);
  grd.addColorStop(0, hexA(color, 0.26));
  grd.addColorStop(1, hexA(color, 0.04));
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  const text = (glyphs || '').slice(0, 3).toUpperCase();
  if (text) {
    const size = text.length === 1 ? 92 : text.length === 2 ? 78 : 62;
    g.font = `900 ${size}px "Courier New", ui-monospace, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = color;
    g.shadowBlur = 18;
    g.fillStyle = color;
    g.fillText(text, W / 2, H / 2 + 4);
    g.shadowBlur = 0;
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.55;
    g.fillText(text, W / 2, H / 2 + 4);
    g.globalAlpha = 1;
  }
  // scanlines
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Badge decal: stencilled number on a hi-vis patch. */
export function badgeTexture(badge: number, accent: string): THREE.CanvasTexture {
  const key = `badge|${badge}|${accent}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const W = 128, H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d2bf';
  g.fillRect(0, 0, W, H);
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 10);
  g.fillRect(0, H - 10, W, 10);
  g.fillStyle = '#121212';
  g.font = '900 38px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(badge).padStart(3, '0'), W / 2, H / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

export function nameplateTexture(name: string, badge: number, color: string): THREE.CanvasTexture {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.font = '700 54px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 10;
  g.fillStyle = '#f2efe6';
  g.fillText(name.slice(0, 16), W / 2, 50);
  g.font = '600 30px ui-monospace, "Courier New", monospace';
  g.fillStyle = color;
  g.fillText(`#${String(badge).padStart(3, '0')}`, W / 2, 104);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hexA(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

export interface HelmetParts {
  group: THREE.Group;
  visorMat: THREE.MeshStandardNodeMaterial;
  /** lamp lens (local flashlight origin on remote avatars), helmet space */
  lamp: THREE.Object3D;
}

/** the look of one hard helmet part, baked into its vertices (hcol / hpbr / hemi) */
interface Look { col: THREE.Color; rough: number; metal: number; emi: THREE.Color | null }

function shellLook(color: string, kind: HelmetKind): Look {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l < 0.32) c.setHSL(hsl.h, hsl.s, 0.32);
  return { col: c, rough: kind === 'diver' ? 0.32 : 0.45, metal: kind === 'diver' ? 0.85 : 0.15, emi: null };
}
const TRIM_LOOK: Look = { col: new THREE.Color(0x23262b), rough: 0.5, metal: 0.7, emi: null };
/** thin hi-vis strip in the visor colour: teammates stay readable in the dark */
const accentLook = (color: string): Look => ({ col: new THREE.Color(0x111111), rough: 0.4, metal: 0, emi: new THREE.Color(color).multiplyScalar(0.9) });
const LENS_LOOK: Look = { col: new THREE.Color(0x111111), rough: 0.2, metal: 0, emi: new THREE.Color(0xfff1c8).multiplyScalar(2.2) };

let darkMetal: THREE.MeshStandardNodeMaterial | null = null;
function trimMaterial(): THREE.MeshStandardNodeMaterial {
  return (darkMetal ??= new THREE.MeshStandardNodeMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.7 }));
}

let hardMat: THREE.MeshStandardNodeMaterial | null = null;
/**
 * Every helmet's hard parts (shell, trim, bolts, hi-vis strip, lamp body + lens) in ONE material: linear colour,
 * roughness / metalness and glow (emissive x intensity) come from vertex attributes, so a whole helmet shell is one
 * draw per pass and one shader program for the crew.
 */
function helmetHardMaterial(): THREE.MeshStandardNodeMaterial {
  if (!hardMat) {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = 'M_Helmet';
    m.colorNode = attribute('hcol', 'vec3');
    const pbr = attribute('hpbr', 'vec2');
    m.roughnessNode = pbr.x;
    m.metalnessNode = pbr.y;
    m.emissiveNode = attribute('hemi', 'vec3');
    hardMat = m;
  }
  return hardMat;
}

function lookAttributes(g: THREE.BufferGeometry, look: Look): void {
  constantAttribute(g, 'hcol', [look.col.r, look.col.g, look.col.b]);
  constantAttribute(g, 'hpbr', [look.rough, look.metal]);
  constantAttribute(g, 'hemi', look.emi ? [look.emi.r, look.emi.g, look.emi.b] : [0, 0, 0]);
}

/** merged helmet geometries: hard parts per kind + shell colour + visor colour, visor parts per kind */
const mergedCache = new Map<string, THREE.BufferGeometry | null>();

/**
 * Build a helmet. `shell` = suit secondary (accents), visor glyphs/colour from the profile.
 * Sized for a head of ~0.24 m (UAL mannequin). Two meshes: the hard parts (casts the head's shadow) and the visor
 * (no shadow: it sits inside the shell's silhouette).
 */
export function buildHelmet(profile: Profile): HelmetParts {
  const kind = profile.helmet;
  const group = new THREE.Group();
  group.name = `helmet_${kind}`;
  const shellColor = kind === 'diver' ? '#b08d57' : profile.suit[1];
  const shell = shellLook(shellColor, kind);
  const accent = accentLook(profile.visor.color);
  const visorMat = new THREE.MeshStandardNodeMaterial({
    color: 0x050607,
    roughness: 0.08,
    metalness: 0.4,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: visorTexture(profile.visor.glyphs, profile.visor.color),
    emissiveIntensity: 2.6,
  });
  const hard: (PlacedPart & { look: Look })[] = [];
  const visor: PlacedPart[] = [];
  const H = (g: THREE.BufferGeometry, look: Look, p?: PlacedPart['p'], r?: PlacedPart['r'], s?: PlacedPart['s']) => { hard.push({ geo: g, look, p, r, s }); };
  const V = (g: THREE.BufferGeometry, p?: PlacedPart['p'], r?: PlacedPart['r'], s?: PlacedPart['s']) => { visor.push({ geo: g, p, r, s }); };

  if (kind === 'box') {
    H(geo('box.shell', () => roundedBox(0.3, 0.3, 0.31, 0.05)), shell, [0, 0.01, -0.005]);
    V(geo('box.visor', () => new THREE.PlaneGeometry(0.24, 0.12)), [0, 0.015, 0.152]);
    H(geo('box.frame', () => new THREE.BoxGeometry(0.27, 0.025, 0.02)), TRIM_LOOK, [0, 0.088, 0.152]);
    H(geo('box.frame', () => new THREE.BoxGeometry(0.27, 0.025, 0.02)), TRIM_LOOK, [0, -0.058, 0.152]);
    H(geo('box.vent', () => new THREE.BoxGeometry(0.12, 0.05, 0.05)), TRIM_LOOK, [0, -0.135, 0.11]);
    H(geo('box.strip', () => new THREE.BoxGeometry(0.31, 0.012, 0.012)), accent, [0, 0.16, 0.1]);
  } else if (kind === 'diver') {
    H(geo('diver.shell', () => new THREE.SphereGeometry(0.175, 32, 20)), shell, [0, 0.01, 0]);
    V(geo('diver.port', () => new THREE.CircleGeometry(0.085, 32)), [0, 0.015, 0.171]);
    H(geo('diver.ring', () => new THREE.TorusGeometry(0.088, 0.016, 10, 32)), shell, [0, 0.015, 0.168]);
    V(geo('diver.side', () => new THREE.CircleGeometry(0.045, 20)), [0.168, 0.02, 0.02], [0, Math.PI / 2, 0]);
    V(geo('diver.side', () => new THREE.CircleGeometry(0.045, 20)), [-0.168, 0.02, 0.02], [0, -Math.PI / 2, 0]);
    H(geo('diver.collar', () => new THREE.CylinderGeometry(0.15, 0.17, 0.06, 28)), shell, [0, -0.16, 0]);
    for (const a of [0, 1, 2, 3, 4, 5]) {
      const ang = (a / 6) * Math.PI * 2;
      H(geo('diver.bolt', () => new THREE.SphereGeometry(0.012, 8, 6)), TRIM_LOOK, [Math.sin(ang) * 0.105, 0.015 + Math.cos(ang) * 0.105, 0.162]);
    }
  } else {
    // dome: rounded shell + wrap-around visor band
    H(geo('dome.shell', () => new THREE.SphereGeometry(0.165, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.62)), shell, [0, 0.0, 0], undefined, [1, 1.05, 1.08]);
    V(geo('dome.visor', () => new THREE.SphereGeometry(0.168, 32, 10, Math.PI * 0.2, Math.PI * 0.6, Math.PI * 0.38, Math.PI * 0.25)), [0, 0.0, 0.004], undefined, [1, 1.05, 1.08]);
    H(geo('dome.brim', () => new THREE.TorusGeometry(0.163, 0.011, 8, 40)), TRIM_LOOK, [0, -0.062, 0], [Math.PI / 2, 0, 0], [1, 1.08, 1]);
    H(geo('dome.ridge', () => new THREE.BoxGeometry(0.03, 0.03, 0.3)), shell, [0, 0.168, -0.01]);
    H(geo('dome.strip', () => new THREE.BoxGeometry(0.012, 0.012, 0.26)), accent, [0, 0.186, -0.01]);
  }
  // helmet lamp on the wearer's right side (-X when facing +Z): the remote flashlight originates here
  const lx = kind === 'box' ? -0.165 : -0.158;
  H(geo('lamp.body', () => new THREE.CylinderGeometry(0.026, 0.03, 0.08, 14)), TRIM_LOOK, [lx, 0.03, 0.08], [Math.PI / 2, 0, 0]);
  H(geo('lamp.lens', () => new THREE.CircleGeometry(0.024, 14)), LENS_LOOK, [lx, 0.03, 0.121]);

  const decorate = (g: THREE.BufferGeometry, i: number) => lookAttributes(g, hard[i].look);
  const place = (parts: PlacedPart[], key: string, mat: THREE.Material, cast: boolean, deco?: (g: THREE.BufferGeometry, i: number) => void) => {
    if (!mergedCache.has(key)) mergedCache.set(key, mergeParts(parts, deco));
    const merged = mergedCache.get(key) ?? null;
    // (never expected) parts that cannot merge stay separate meshes with the same material
    const geos = merged ? [merged] : parts.map((part, i) => { const g = placeGeometry(part); deco?.(g, i); return g; });
    for (const g of geos) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = key.split('|')[0];
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  };
  place(hard, `hard|${kind}|${shellColor}|${profile.visor.color}`, helmetHardMaterial(), true, decorate);
  place(visor, `visor|${kind}`, visorMat, false);
  const lamp = new THREE.Object3D();
  lamp.position.set(lx, 0.03, 0.13);
  group.add(lamp);
  return { group, visorMat, lamp };
}

function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  // cheap rounded box: a box with bevelled look via a slightly inflated sphere-mapped box
  const g = new THREE.BoxGeometry(w, h, d, 6, 6, 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const hw = w / 2 - r, hh = h / 2 - r, hd = d / 2 - r;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = Math.max(-hw, Math.min(hw, v.x)), cy = Math.max(-hh, Math.min(hh, v.y)), cz = Math.max(-hd, Math.min(hd, v.z));
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    pos.setXYZ(i, cx + (dx / len) * r, cy + (dy / len) * r, cz + (dz / len) * r);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * placeholder body (capsule suit + backpack + accent stripes), feet at y=0, facing +Z. v1.2 draw budget: one baked
 * mesh per material (suit, boots, accents), shared by every placeholder (only the materials are per profile).
 */
export function buildPlaceholderBody(profile: Profile): { group: THREE.Group; headY: number; mats: THREE.MeshStandardNodeMaterial[] } {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(profile.suit[0]), roughness: 0.78, metalness: 0.02 });
  const accent = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(profile.suit[1]), roughness: 0.6, metalness: 0.1 });
  const leg = geo('ph.leg', () => new THREE.CapsuleGeometry(0.085, 0.62, 6, 12));
  const boot = geo('ph.boot', () => new THREE.BoxGeometry(0.12, 0.08, 0.24));
  const arm = geo('ph.arm', () => new THREE.CapsuleGeometry(0.07, 0.5, 6, 12));
  const stripe = geo('ph.stripe', () => new THREE.TorusGeometry(0.205, 0.022, 8, 28));
  const sets: [string, THREE.Material, PlacedPart[]][] = [
    ['ph.suit', suit, [
      { geo: geo('ph.torso', () => new THREE.CapsuleGeometry(0.21, 0.55, 6, 16)), p: [0, 1.12, 0], s: [1, 1, 0.78] },
      { geo: geo('ph.hips', () => new THREE.CapsuleGeometry(0.17, 0.12, 6, 14)), p: [0, 0.82, 0], s: [1.05, 1, 0.8] },
      { geo: leg, p: [0.1, 0.43, 0] },
      { geo: leg, p: [-0.1, 0.43, 0] },
      { geo: arm, p: [0.29, 1.1, 0.02] },
      { geo: arm, p: [-0.29, 1.1, 0.02] },
      { geo: geo('ph.neck', () => new THREE.CylinderGeometry(0.07, 0.08, 0.12, 12)), p: [0, 1.47, 0] },
    ]],
    ['ph.boots', trimMaterial(), [{ geo: boot, p: [0.1, 0.04, 0.03] }, { geo: boot, p: [-0.1, 0.04, 0.03] }]],
    ['ph.accent', accent, [
      { geo: stripe, p: [0, 1.02, 0], r: [Math.PI / 2, 0, 0], s: [1, 0.78, 1] },
      { geo: stripe, p: [0, 1.3, 0], r: [Math.PI / 2, 0, 0], s: [1, 0.78, 1] },
      { geo: geo('ph.pack', () => roundedBox(0.3, 0.38, 0.14, 0.03)), p: [0, 1.18, -0.2] },
    ]],
  ];
  for (const [key, mat, parts] of sets) {
    if (!mergedCache.has(key)) mergedCache.set(key, mergeParts(parts));
    const merged = mergedCache.get(key) ?? null;
    for (const g of merged ? [merged] : parts.map((p) => placeGeometry(p))) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return { group, headY: 1.6, mats: [suit, accent] };
}
