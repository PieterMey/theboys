// Owner: env-world (v1.2). Lore holders on the walls (board, clipboard, plaque, blackboard, frame, safety card) and
// pages in drawers. The holder geometry is static furniture (merged per space + material by the level); each spot has
// a named 'page' mesh with its own CanvasTexture, drawn by setLorePage (title + body, <= 600 chars, the staged OFL
// handwriting font with a system fallback). null / visible:false = an empty holder; dim greys a filed page; glow lifts
// it a little in the dark. Page text never comes from the layout: the fieldguide sends it (server-side content).
import * as THREE from 'three/webgpu';
import type { LoreSpot, LoreStyle } from '@dead-air/shared/procgen/lore.ts';
import { getAssetManifest } from '@dead-air/shared/assets.ts';
import type { LorePageVisual } from './api.ts';
import type { Part } from './setpieces.ts';

const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
export const LORE_TEXT_MAX = 600;
/** page size (m) and centre offset on the holder face, per style */
const PAGE: Readonly<Record<LoreStyle, { w: number; h: number; y: number; z: number; tilt: number }>> = {
  board: { w: 0.3, h: 0.4, y: 0.0, z: 0.019, tilt: -0.03 },
  clipboard: { w: 0.21, h: 0.27, y: -0.025, z: 0.02, tilt: 0 },
  plaque: { w: 0.4, h: 0.24, y: 0, z: 0.0215, tilt: 0 },
  blackboard: { w: 0.8, h: 0.5, y: 0.02, z: 0.0135, tilt: 0 },
  frame: { w: 0.38, h: 0.52, y: 0, z: 0.012, tilt: 0 },
  safety_card: { w: 0.28, h: 0.4, y: 0, z: 0.0125, tilt: 0 },
  drawer: { w: 0.21, h: 0.297, y: 0, z: 0, tilt: 0 },
};
/** holder size (m) when the spot item carries none (env-layout LORE_DIMS) */
const DIMS: Readonly<Record<Exclude<LoreStyle, 'drawer'>, { w: number; d: number; h: number }>> = {
  board: { w: 0.9, d: 0.03, h: 0.6 }, clipboard: { w: 0.25, d: 0.03, h: 0.34 }, plaque: { w: 0.5, d: 0.03, h: 0.35 },
  blackboard: { w: 0.9, d: 0.04, h: 0.6 }, frame: { w: 0.5, d: 0.04, h: 0.65 }, safety_card: { w: 0.32, d: 0.02, h: 0.45 },
};

/** static holder geometry of a wall spot, local frame (centre at the mount point, back at z = -d/2) */
export function loreHolderParts(style: LoreStyle, dims?: { w?: number; d?: number; h?: number }): Part[] {
  if (style === 'drawer') return [];
  const D = DIMS[style];
  const w = dims?.w ?? D.w, d = dims?.d ?? D.d, h = dims?.h ?? D.h;
  const P: Part[] = [];
  const add = (mat: string, ...gs: THREE.BufferGeometry[]) => { for (const geo of gs) P.push({ mat, geo }); };
  const z0 = -d / 2;
  switch (style) {
    case 'board':
      add('cork', B(w - 0.04, h - 0.04, d * 0.6, 0, 0, z0 + d * 0.3));
      add('woodDark', B(w, 0.03, d, 0, h / 2 - 0.015, 0), B(w, 0.03, d, 0, -h / 2 + 0.015, 0), B(0.03, h - 0.06, d, -w / 2 + 0.015, 0, 0), B(0.03, h - 0.06, d, w / 2 - 0.015, 0, 0));
      // old notices nobody reads (the lore page goes in the middle)
      add('paper', B(0.15, 0.2, 0.002, -w / 2 + 0.14, h / 2 - 0.16, z0 + d * 0.6 + 0.001).rotateZ(0.04), B(0.12, 0.09, 0.002, w / 2 - 0.13, -h / 2 + 0.12, z0 + d * 0.6 + 0.001));
      break;
    case 'clipboard':
      add('cardboardDark', B(w, h, 0.006, 0, 0, z0 + 0.006));
      add('steel', B(0.1, 0.035, 0.016, 0, h / 2 - 0.03, z0 + 0.016), B(0.06, 0.012, 0.012, 0, h / 2 - 0.006, z0 + 0.02));
      add('steelDark', B(0.008, 0.008, 0.02, 0, h / 2 + 0.01, z0 + 0.01));
      break;
    case 'plaque':
      add('woodDark', B(w, h, d * 0.6, 0, 0, z0 + d * 0.3));
      add('brass', B(w - 0.07, h - 0.07, 0.004, 0, 0, z0 + d * 0.6 + 0.002));
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) add('brass', new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8).rotateX(Math.PI / 2).translate(sx * (w / 2 - 0.022), sy * (h / 2 - 0.022), z0 + d * 0.6 + 0.004));
      break;
    case 'blackboard':
      add('slate', B(w - 0.05, h - 0.05, d * 0.4, 0, 0, z0 + d * 0.2));
      add('wood', B(w, 0.025, d, 0, h / 2 - 0.0125, 0), B(0.025, h, d, -w / 2 + 0.0125, 0, 0), B(0.025, h, d, w / 2 - 0.0125, 0, 0));
      add('wood', B(w, 0.03, d + 0.05, 0, -h / 2 + 0.015, 0.025));
      add('enamel', B(0.07, 0.012, 0.012, w * 0.3, -h / 2 + 0.036, 0.04), B(0.05, 0.012, 0.012, w * 0.3 + 0.1, -h / 2 + 0.036, 0.035));
      break;
    case 'frame':
      add('woodDark', B(w, 0.045, d, 0, h / 2 - 0.0225, 0), B(w, 0.045, d, 0, -h / 2 + 0.0225, 0), B(0.045, h - 0.09, d, -w / 2 + 0.0225, 0, 0), B(0.045, h - 0.09, d, w / 2 - 0.0225, 0, 0));
      add('brass', B(w - 0.09, 0.008, 0.006, 0, h / 2 - 0.049, d / 2 - 0.006), B(w - 0.09, 0.008, 0.006, 0, -h / 2 + 0.049, d / 2 - 0.006));
      add('sheet', B(w - 0.08, h - 0.08, 0.004, 0, 0, z0 + 0.004));
      break;
    case 'safety_card':
      add('enamel', B(w, h, 0.008, 0, 0, z0 + 0.004));
      add('steel', B(w * 0.6, 0.012, 0.01, 0, h / 2 - 0.01, z0 + 0.012));
      break;
  }
  return P;
}

// ---------------------------------------------------------------- pages (DOM: browser only)

let fontFamily = "'Reenie Beanie', 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive";
let fontPromise: Promise<boolean> | null = null;
/** load the staged OFL handwriting font once (manifest key font.*; absent -> system fallback). Resolves true when loaded. */
export function loadLoreFont(): Promise<boolean> {
  fontPromise ??= (async () => {
    try {
      const m = getAssetManifest();
      if (!m || typeof FontFace === 'undefined') return false;
      const keys = Object.keys(m.files).filter((k) => k.startsWith('font.') && !/licen[cs]e|ofl/i.test(k));
      const key = keys.find((k) => /reenie|hand|script/i.test(k)) ?? keys[0];
      if (!key) return false;
      const url = `${m.base}${m.files[key].url}`;
      const face = new FontFace('DeadAirHand', `url(${url})`);
      await face.load();
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      fontFamily = `'DeadAirHand', ${fontFamily}`;
      return true;
    } catch { return false; }
  })();
  return fontPromise;
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word;
      if (g.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** draw a page into its canvas (style-specific look) */
export function drawPage(c: HTMLCanvasElement, style: LoreStyle, page: LorePageVisual): void {
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const title = (page.title ?? '').slice(0, 80);
  const body = (page.text ?? '').slice(0, LORE_TEXT_MAX);
  const chalk = style === 'blackboard', engraved = style === 'plaque', card = style === 'safety_card';
  // background
  if (!chalk && !engraved) {
    g.fillStyle = card ? '#ecebe2' : '#d9d2bd';
    g.fillRect(0, 0, W, H);
    // age: foxing + a coffee ring, deterministic per text
    let h = 7;
    for (const ch of body + title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let k = 0; k < 26; k++) { g.fillStyle = `rgba(110,85,40,${0.03 + rnd() * 0.06})`; g.beginPath(); g.arc(rnd() * W, rnd() * H, 6 + rnd() * 28, 0, Math.PI * 2); g.fill(); }
    if (!card && rnd() < 0.5) { g.strokeStyle = 'rgba(90,60,25,0.18)'; g.lineWidth = 7; g.beginPath(); g.arc(W * (0.6 + rnd() * 0.25), H * (0.7 + rnd() * 0.2), W * 0.12, 0, Math.PI * 2); g.stroke(); }
    if (card) { g.fillStyle = '#c99a10'; g.fillRect(0, 0, W, H * 0.15); g.fillStyle = '#7a1c16'; g.fillRect(0, H * 0.15, W, H * 0.02); }
    if (style === 'board') { g.fillStyle = '#9a1a14'; g.beginPath(); g.arc(W / 2, H * 0.035, W * 0.025, 0, Math.PI * 2); g.fill(); }
  }
  const ink = chalk ? 'rgba(232,232,222,0.92)' : engraved ? 'rgba(40,30,12,0.9)' : '#22232b';
  const pad = W * (engraved ? 0.07 : 0.09);
  let y = card ? H * 0.21 : H * 0.07;
  if (card) {
    g.fillStyle = '#141414';
    g.font = `900 ${Math.round(W * 0.085)}px 'Arial Black', Impact, sans-serif`;
    g.textAlign = 'center';
    g.fillText((title || 'NOTICE').toUpperCase(), W / 2, H * 0.105, W - pad * 2);
    g.textAlign = 'left';
  } else if (title) {
    g.fillStyle = ink;
    g.font = engraved ? `700 ${Math.round(W * 0.07)}px Georgia, 'Times New Roman', serif` : chalk ? `${Math.round(W * 0.075)}px ${fontFamily}` : `700 ${Math.round(W * 0.062)}px 'Courier New', Courier, monospace`;
    g.textAlign = engraved || chalk ? 'center' : 'left';
    for (const ln of wrap(g, title.toUpperCase(), W - pad * 2).slice(0, 2)) {
      y += W * 0.075;
      g.fillText(ln, engraved || chalk ? W / 2 : pad, y, W - pad * 2);
    }
    g.textAlign = 'left';
    if (!engraved && !chalk) { g.fillStyle = 'rgba(30,30,40,0.6)'; g.fillRect(pad, y + W * 0.025, W - pad * 2, 2); }
    y += W * 0.05;
  }
  // body: handwriting (typed on a safety card, engraved serif on a plaque)
  const size = Math.round(W * (engraved ? 0.05 : card ? 0.048 : chalk ? 0.058 : 0.062));
  g.font = card ? `600 ${size}px 'Segoe UI', Arial, sans-serif` : engraved ? `${size}px Georgia, serif` : `${size}px ${fontFamily}`;
  g.fillStyle = card ? '#1d1d1d' : ink;
  const lines = wrap(g, body, W - pad * 2);
  const lh = size * (engraved || card ? 1.25 : 1.15);
  for (const ln of lines) {
    y += lh;
    if (y > H - pad * 0.6) break;
    g.textAlign = engraved ? 'center' : 'left';
    g.fillText(ln, engraved ? W / 2 : pad, y, W - pad * 2);
  }
  g.textAlign = 'left';
}

export interface LorePage {
  spot: LoreSpot;
  /** the named 'page' mesh (child of the holder object) */
  mesh: THREE.Mesh;
  holder: THREE.Object3D;
  canvas: HTMLCanvasElement | null;
  tex: THREE.CanvasTexture | null;
  mat: THREE.MeshStandardNodeMaterial;
  visual: LorePageVisual | null;
  /** drawer spots: offset of the page in the part frame (follow) or in the host frame (hinged doors / lids) */
  drawerOffset: THREE.Matrix4 | null;
  /** drawer spots: the page rides on its drawer / tray (true) or lies still in the host behind a door or lid (false) */
  follow: boolean;
  /** drawer spots: where it lies (env-layout's slot, host-local) and how it fits; null for wall spots */
  drawer: DrawerPageSpec | null;
}

/** a page lying in a container part: env-layout's slot (host-local, the part OPEN), the part's slide (drawers / trays
 *  carry the page, hinged parts do not), and the free floor it must fit on */
export interface DrawerPageSpec {
  slotLocal: [number, number, number];
  /** drawer / tray travel (m); 0 for hinged parts (the page stays in the host frame) */
  slide: number;
  /** free floor (m): x across the part, z into it */
  width: number;
  depth: number;
}

/** host-or-part-local matrix of a drawer page lying flat at its slot (floorY puts it on a measured part floor) */
export function drawerPageOffset(spec: DrawerPageSpec, seed: number, floorY?: number | null, out = new THREE.Matrix4()): THREE.Matrix4 {
  const P = PAGE.drawer;
  // long side across the part when the floor is shallower than a page; a small skew; shrink to fit narrow drawers
  const across = spec.depth < P.h + 0.06;
  const skew = ((seed % 7) - 3) * 0.03;
  const yaw = (across ? Math.PI / 2 : 0) + skew;
  const bw = Math.abs(P.w * Math.cos(yaw)) + Math.abs(P.h * Math.sin(yaw)), bd = Math.abs(P.w * Math.sin(yaw)) + Math.abs(P.h * Math.cos(yaw));
  const s = Math.max(0.5, Math.min(1, (spec.width - 0.04) / bw, (spec.depth - 0.04) / bd));
  const [x, y, z] = spec.slotLocal;
  // on the part's real floor once a model host measured it, else on env-layout's slot height
  const lift = (floorY ?? y) + 0.004;
  return out.makeTranslation(x, lift, z - spec.slide).multiply(_r.makeRotationY(yaw)).multiply(_r2.makeRotationX(-Math.PI / 2)).multiply(_r3.makeScale(s, s, 1));
}
const _r = new THREE.Matrix4(), _r2 = new THREE.Matrix4(), _r3 = new THREE.Matrix4();

const pageGeo = new Map<string, THREE.PlaneGeometry>();
let blank: THREE.DataTexture | null = null;
/** 1x1 white stand-in so a page material has its final shape (map + emissiveMap) from the start: setting the real
 *  canvas later swaps a binding instead of compiling a new pipeline mid-game */
function blankTex(): THREE.DataTexture {
  if (!blank) { blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); blank.colorSpace = THREE.SRGBColorSpace; blank.needsUpdate = true; }
  return blank;
}
/** a holder object + its (hidden) page mesh for one spot, positioned in world space (drawer spots: by the level, from
 *  drawerOffset and the live part / host matrix) */
export function makeLorePage(spot: LoreSpot, drawer?: DrawerPageSpec): LorePage {
  const P = PAGE[spot.style];
  const holder = new THREE.Group();
  holder.name = `lore:${spot.id}`;
  holder.userData.loreId = spot.id;
  const k = `${P.w}x${P.h}`;
  let geo = pageGeo.get(k);
  if (!geo) { geo = new THREE.PlaneGeometry(P.w, P.h); pageGeo.set(k, geo); }
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, alphaTest: 0.3, emissive: 0xffffff, emissiveIntensity: 0, map: blankTex(), emissiveMap: blankTex() });
  mat.name = 'level.lore.page';
  mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'page';
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  let drawerOffset: THREE.Matrix4 | null = null;
  if (spot.style === 'drawer' && drawer) {
    // flat at env-layout's slot (where searched items lie), in the part's closed pose for drawers / trays (the level
    // multiplies the live part matrix) or in the host frame behind a door or lid
    drawerOffset = drawerPageOffset(drawer, spot.idx);
    holder.matrixAutoUpdate = false;
  } else {
    holder.position.set(spot.x, spot.y, spot.z);
    holder.rotation.y = spot.rot;
    mesh.position.set(0, P.y, P.z);
    mesh.rotation.z = P.tilt;
  }
  holder.add(mesh);
  return { spot, mesh, holder, canvas: null, tex: null, mat, visual: null, drawerOffset, follow: !!drawer && drawer.slide > 0, drawer: spot.style === 'drawer' ? drawer ?? null : null };
}

/** set (or clear with null) a page's content */
export function applyLorePage(p: LorePage, v: LorePageVisual | null): void {
  p.visual = v;
  const show = !!v && v.visible !== false && !!((v.title ?? '') || (v.text ?? ''));
  p.mesh.visible = show;
  if (!show || !v) return;
  if (typeof document === 'undefined') return;
  if (!p.canvas) {
    const P = PAGE[p.spot.style];
    p.canvas = document.createElement('canvas');
    p.canvas.width = 512;
    p.canvas.height = Math.round(512 * (P.h / P.w));
    p.tex = new THREE.CanvasTexture(p.canvas);
    p.tex.colorSpace = THREE.SRGBColorSpace;
    p.tex.anisotropy = 8;
    p.mat.map = p.tex;
    p.mat.emissiveMap = p.tex;
  }
  drawPage(p.canvas, p.spot.style, v);
  p.tex!.needsUpdate = true;
  p.mat.color.setScalar(v.dim ? 0.45 : 1);
  p.mat.emissiveIntensity = Math.max(0, Math.min(1, v.glow ?? 0)) * (v.dim ? 0.12 : 0.35);
}

/** redraw every visible page (the handwriting font finished loading) */
export function redrawLorePages(pages: Iterable<LorePage>): void {
  for (const p of pages) if (p.visual && p.mesh.visible) applyLorePage(p, p.visual);
}

export function disposeLorePage(p: LorePage): void {
  p.tex?.dispose();
  p.mat.dispose();
  p.holder.removeFromParent();
}
