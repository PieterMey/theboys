// Owner: track ⑤ Players. Procedural helmets (dome / box / diver) with an emissive visor (CanvasTexture glyphs),
// a helmet lamp housing, badge decals and nameplates. All geometry is built in "helmet space":
// origin = centre of the head, +Y up, +Z forward (character facing), metres.
import * as THREE from 'three/webgpu';
import type { HelmetKind, Profile } from '@dead-air/shared/profile.ts';

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
  shellMat: THREE.MeshStandardNodeMaterial;
  /** lamp lens (local flashlight origin on remote avatars), helmet space */
  lamp: THREE.Object3D;
}

const shellMats = new Map<string, THREE.MeshStandardNodeMaterial>();
function shellMaterial(color: string, kind: HelmetKind): THREE.MeshStandardNodeMaterial {
  const key = `${kind}|${color}`;
  let m = shellMats.get(key);
  if (!m) {
    const c = new THREE.Color(color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    if (hsl.l < 0.32) c.setHSL(hsl.h, hsl.s, 0.32);
    m = new THREE.MeshStandardNodeMaterial({
      color: c,
      roughness: kind === 'diver' ? 0.32 : 0.45,
      metalness: kind === 'diver' ? 0.85 : 0.15,
    });
    shellMats.set(key, m);
  }
  return m;
}
let darkMetal: THREE.MeshStandardNodeMaterial | null = null;
function trimMaterial(): THREE.MeshStandardNodeMaterial {
  return (darkMetal ??= new THREE.MeshStandardNodeMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.7 }));
}
const accentMats = new Map<string, THREE.MeshStandardNodeMaterial>();
/** thin hi-vis strip in the visor colour: teammates stay readable in the dark */
function accentMaterial(color: string): THREE.MeshStandardNodeMaterial {
  let m = accentMats.get(color);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ color: 0x111111, emissive: new THREE.Color(color), emissiveIntensity: 0.9, roughness: 0.4 });
    accentMats.set(color, m);
  }
  return m;
}
let lensMat: THREE.MeshStandardNodeMaterial | null = null;
function lampLensMaterial(): THREE.MeshStandardNodeMaterial {
  return (lensMat ??= new THREE.MeshStandardNodeMaterial({ color: 0x111111, emissive: new THREE.Color(0xfff1c8), emissiveIntensity: 2.2, roughness: 0.2 }));
}

/**
 * Build a helmet. `shell` = suit secondary (accents), visor glyphs/colour from the profile.
 * Sized for a head of ~0.24 m (UAL mannequin).
 */
export function buildHelmet(profile: Profile): HelmetParts {
  const kind = profile.helmet;
  const group = new THREE.Group();
  group.name = `helmet_${kind}`;
  const shellMat = shellMaterial(kind === 'diver' ? '#b08d57' : profile.suit[1], kind);
  const visorMat = new THREE.MeshStandardNodeMaterial({
    color: 0x050607,
    roughness: 0.08,
    metalness: 0.4,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: visorTexture(profile.visor.glyphs, profile.visor.color),
    emissiveIntensity: 2.6,
  });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, p?: [number, number, number], r?: [number, number, number], s?: [number, number, number]) => {
    const mesh = new THREE.Mesh(g, m);
    if (p) mesh.position.set(...p);
    if (r) mesh.rotation.set(...r);
    if (s) mesh.scale.set(...s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  if (kind === 'box') {
    add(geo('box.shell', () => roundedBox(0.3, 0.3, 0.31, 0.05)), shellMat, [0, 0.01, -0.005]);
    add(geo('box.visor', () => new THREE.PlaneGeometry(0.24, 0.12)), visorMat, [0, 0.015, 0.152]);
    add(geo('box.frame', () => new THREE.BoxGeometry(0.27, 0.025, 0.02)), trimMaterial(), [0, 0.088, 0.152]);
    add(geo('box.frame', () => new THREE.BoxGeometry(0.27, 0.025, 0.02)), trimMaterial(), [0, -0.058, 0.152]);
    add(geo('box.vent', () => new THREE.BoxGeometry(0.12, 0.05, 0.05)), trimMaterial(), [0, -0.135, 0.11]);
    add(geo('box.strip', () => new THREE.BoxGeometry(0.31, 0.012, 0.012)), accentMaterial(profile.visor.color), [0, 0.16, 0.1]);
  } else if (kind === 'diver') {
    add(geo('diver.shell', () => new THREE.SphereGeometry(0.175, 32, 20)), shellMat, [0, 0.01, 0]);
    add(geo('diver.port', () => new THREE.CircleGeometry(0.085, 32)), visorMat, [0, 0.015, 0.171]);
    add(geo('diver.ring', () => new THREE.TorusGeometry(0.088, 0.016, 10, 32)), shellMat, [0, 0.015, 0.168]);
    add(geo('diver.side', () => new THREE.CircleGeometry(0.045, 20)), visorMat, [0.168, 0.02, 0.02], [0, Math.PI / 2, 0]);
    add(geo('diver.side', () => new THREE.CircleGeometry(0.045, 20)), visorMat, [-0.168, 0.02, 0.02], [0, -Math.PI / 2, 0]);
    add(geo('diver.collar', () => new THREE.CylinderGeometry(0.15, 0.17, 0.06, 28)), shellMat, [0, -0.16, 0]);
    for (const a of [0, 1, 2, 3, 4, 5]) {
      const ang = (a / 6) * Math.PI * 2;
      add(geo('diver.bolt', () => new THREE.SphereGeometry(0.012, 8, 6)), trimMaterial(), [Math.sin(ang) * 0.105, 0.015 + Math.cos(ang) * 0.105, 0.162]);
    }
  } else {
    // dome: rounded shell + wrap-around visor band
    add(geo('dome.shell', () => new THREE.SphereGeometry(0.165, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.62)), shellMat, [0, 0.0, 0], undefined, [1, 1.05, 1.08]);
    add(geo('dome.visor', () => new THREE.SphereGeometry(0.168, 32, 10, Math.PI * 0.2, Math.PI * 0.6, Math.PI * 0.38, Math.PI * 0.25)), visorMat, [0, 0.0, 0.004], undefined, [1, 1.05, 1.08]);
    add(geo('dome.brim', () => new THREE.TorusGeometry(0.163, 0.011, 8, 40)), trimMaterial(), [0, -0.062, 0], [Math.PI / 2, 0, 0], [1, 1.08, 1]);
    add(geo('dome.ridge', () => new THREE.BoxGeometry(0.03, 0.03, 0.3)), shellMat, [0, 0.168, -0.01]);
    add(geo('dome.strip', () => new THREE.BoxGeometry(0.012, 0.012, 0.26)), accentMaterial(profile.visor.color), [0, 0.186, -0.01]);
  }
  // helmet lamp on the wearer's right side (-X when facing +Z): the remote flashlight originates here
  const lx = kind === 'box' ? -0.165 : -0.158;
  add(geo('lamp.body', () => new THREE.CylinderGeometry(0.026, 0.03, 0.08, 14)), trimMaterial(), [lx, 0.03, 0.08], [Math.PI / 2, 0, 0]);
  const lens = add(geo('lamp.lens', () => new THREE.CircleGeometry(0.024, 14)), lampLensMaterial(), [lx, 0.03, 0.121]);
  lens.castShadow = false;
  const lamp = new THREE.Object3D();
  lamp.position.set(lx, 0.03, 0.13);
  group.add(lamp);
  return { group, visorMat, shellMat, lamp };
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

/** placeholder body (capsule suit + backpack + accent stripes), feet at y=0, facing +Z */
export function buildPlaceholderBody(profile: Profile): { group: THREE.Group; headY: number; mats: THREE.MeshStandardNodeMaterial[] } {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(profile.suit[0]), roughness: 0.78, metalness: 0.02 });
  const accent = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(profile.suit[1]), roughness: 0.6, metalness: 0.1 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, p: [number, number, number], s?: [number, number, number]) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(...p);
    if (s) mesh.scale.set(...s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  add(geo('ph.torso', () => new THREE.CapsuleGeometry(0.21, 0.55, 6, 16)), suit, [0, 1.12, 0], [1, 1, 0.78]);
  add(geo('ph.hips', () => new THREE.CapsuleGeometry(0.17, 0.12, 6, 14)), suit, [0, 0.82, 0], [1.05, 1, 0.8]);
  add(geo('ph.leg', () => new THREE.CapsuleGeometry(0.085, 0.62, 6, 12)), suit, [0.1, 0.43, 0]);
  add(geo('ph.leg', () => new THREE.CapsuleGeometry(0.085, 0.62, 6, 12)), suit, [-0.1, 0.43, 0]);
  add(geo('ph.boot', () => new THREE.BoxGeometry(0.12, 0.08, 0.24)), trimMaterial(), [0.1, 0.04, 0.03]);
  add(geo('ph.boot', () => new THREE.BoxGeometry(0.12, 0.08, 0.24)), trimMaterial(), [-0.1, 0.04, 0.03]);
  add(geo('ph.arm', () => new THREE.CapsuleGeometry(0.07, 0.5, 6, 12)), suit, [0.29, 1.1, 0.02]);
  add(geo('ph.arm', () => new THREE.CapsuleGeometry(0.07, 0.5, 6, 12)), suit, [-0.29, 1.1, 0.02]);
  add(geo('ph.stripe', () => new THREE.TorusGeometry(0.205, 0.022, 8, 28)), accent, [0, 1.02, 0], [1, 0.78, 1]).rotation.x = Math.PI / 2;
  add(geo('ph.stripe', () => new THREE.TorusGeometry(0.205, 0.022, 8, 28)), accent, [0, 1.3, 0], [1, 0.78, 1]).rotation.x = Math.PI / 2;
  add(geo('ph.pack', () => roundedBox(0.3, 0.38, 0.14, 0.03)), accent, [0, 1.18, -0.2]);
  add(geo('ph.neck', () => new THREE.CylinderGeometry(0.07, 0.08, 0.12, 12)), suit, [0, 1.47, 0]);
  return { group, headY: 1.6, mats: [suit, accent] };
}
