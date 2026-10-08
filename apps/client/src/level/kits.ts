// Owner: env-world (v1.2). Procedural furniture kits for the themed PROP_DEFS keys (env-layout's MUST list:
// hospital ward_bed, curtain_rail, iv_stand, sink_row; waterworks pump_flywheel, pipe_bank; records card_catalogue,
// display_case; cold_storage meat_rail, strip_curtain) + a RoundedBox fallback for any procedural key without a kit,
// so a solid prop is never invisible. Same contract as setpieces.ts procParts: parts in the item's local frame (origin
// on the floor at the item centre, +X along its width, +Z = its front, back at z = -d/2; wall items centred on their
// mount height). Everything is merged per space + material by the level (still 1 draw per material per room).
// Visual furniture stays inside its collision box (+0.06 m at most): sizes come from the item / PROP_DEFS.
import * as THREE from 'three/webgpu';
import type { Rng } from '@dead-air/shared/rng.ts';
import { GeoRef, box, cyl, part, rbox, shape, transformPart } from './geo.ts';
import type { AnyGeo, Part } from './geo.ts';

// shared prototypes placed by matrices (geo.ts): kits allocate matrices, not geometries; rounded boxes are cached
const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0): GeoRef => box(w, h, d, x, y, z);
/** rounded box (1-3 cm bevel); seg 1 for small parts */
export const RB = (w: number, h: number, d: number, x = 0, y = 0, z = 0, r = 0.02, seg = 2): GeoRef => rbox(w, h, d, x, y, z, r, seg);
const CY = (r: number, h: number, x = 0, y = 0, z = 0, seg = 12, r2 = r): GeoRef => cyl(r, h, x, y, z, seg, r2);
const CX = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): GeoRef => cyl(r, len, 0, 0, 0, seg).rotateZ(Math.PI / 2).translate(x, y, z);
const CZ = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): GeoRef => cyl(r, len, 0, 0, 0, seg).rotateX(Math.PI / 2).translate(x, y, z);

/** pleated cloth hanging in the x-y plane: x0..x1, y0..y1 (bottom..top), folds of `pitch` m, depth amp, at z */
function pleats(x0: number, x1: number, y0: number, y1: number, z: number, pitch: number, amp: number): THREE.BufferGeometry {
  const len = Math.max(0.05, x1 - x0);
  const segs = Math.max(4, Math.round(len / (pitch / 4)));
  const g = new THREE.PlaneGeometry(len, y1 - y0, segs, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, amp * Math.sin(((x + len / 2) / pitch) * Math.PI * 2));
  }
  g.computeVertexNormals();
  return g.translate(x0 + len / 2, (y0 + y1) / 2, z);
}

interface KitIn { w: number; d: number; h: number; n: number; rng: Rng; roomType: string }
type Kit = (k: KitIn, add: (mat: string, ...g: AnyGeo[]) => void) => void;

const KITS: Record<string, Kit> = {
  ward_bed({ w, d, h, rng }, add) {
    // tubular cream-enamel hospital bed, head to the wall (-Z), mattress, folded blanket, pillow, castors, foot chart
    const tube = 0.022, hz = -d / 2 + 0.04, fz = d / 2 - 0.04, x = w / 2 - 0.04;
    for (const sx of [-x, x]) {
      add('enamel', CY(tube, h - 0.02, sx, (h - 0.02) / 2 + 0.02, hz, 10), CY(tube, h * 0.72, sx, h * 0.36 + 0.02, fz, 10));
      add('enamel', CZ(tube * 0.8, d - 0.1, sx, 0.42, 0, 8));
    }
    for (const y of [h - 0.05, h * 0.62]) add('enamel', CX(tube * 0.8, w - 0.08, 0, y, hz, 8));
    for (const y of [h * 0.7, h * 0.42]) add('enamel', CX(tube * 0.8, w - 0.08, 0, y, fz, 8));
    for (let k = 1; k < 5; k++) add('enamel', CY(0.01, h * 0.3, -x + (k * (2 * x)) / 5, h * 0.62 + h * 0.15 - 0.02, hz, 6));
    add('steelDark', B(w - 0.12, 0.04, d - 0.14, 0, 0.44, 0));
    add('sheet', RB(w - 0.1, 0.15, d - 0.16, 0, 0.535, 0, 0.05));
    add('blanket', RB(w - 0.06, 0.05, d * 0.52, 0, 0.62, d * 0.2, 0.025));
    add('sheet', RB(0.56, 0.11, 0.34, (rng.next() - 0.5) * 0.06, 0.66, hz + 0.26, 0.05));
    for (const sx of [-x, x]) for (const sz of [hz, fz]) add('black', cyl(0.04, 0.03, 0, 0, 0, 10).rotateZ(Math.PI / 2).translate(sx, 0.04, sz));
    if (rng.chance(0.7)) add('paper', B(0.22, 0.3, 0.006, x * 0.3, h * 0.56, fz + 0.026));
  },
  curtain_rail({ w, d, h, rng }, add) {
    // ceiling-hung privacy curtain: rail + drop rods + a pleated curtain drawn over part of the run + the gathered rest
    const yr = Math.max(1.9, h - 0.02), z = 0;
    add('steel', CX(0.014, w, 0, yr, z, 8));
    for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) add('steel', CY(0.008, 0.6, sx, yr + 0.3, z, 6));
    const drawn = 0.45 + rng.next() * 0.4;
    const xe = -w / 2 + 0.04 + (w - 0.08) * drawn;
    add('curtain', pleats(-w / 2 + 0.04, xe, 0.32, yr - 0.03, z, 0.14, Math.min(0.035, d * 0.3)));
    add('curtain', pleats(w / 2 - 0.2, w / 2 - 0.04, 0.32, yr - 0.03, z, 0.05, Math.min(0.04, d * 0.35)));
    for (let xx = -w / 2 + 0.06; xx < xe; xx += 0.14) add('steelDark', B(0.012, 0.03, 0.012, xx, yr - 0.02, z));
  },
  iv_stand({ w, h, rng }, add) {
    // five-star castor base, chrome pole, two hooks, a saline bag + drip line
    const r = Math.min(0.28, w / 2 - 0.02);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      add('steel', B(r, 0.025, 0.035, r / 2, 0.09, 0).rotateY(-a));
      add('black', CY(0.025, 0.05, r * Math.cos(a), 0.035, r * Math.sin(a), 8));
    }
    add('steel', CY(0.014, h - 0.12, 0, (h - 0.12) / 2 + 0.1, 0, 8), CY(0.04, 0.05, 0, 0.1, 0, 10));
    add('steel', CX(0.007, 0.32, 0, h - 0.04, 0, 6));
    for (const sx of [-0.15, 0.15]) add('steel', CY(0.006, 0.07, sx, h - 0.075, 0, 6));
    const bx = rng.chance(0.5) ? -0.15 : 0.15;
    add('glassGreen', RB(0.11, 0.2, 0.04, bx, h - 0.22, 0, 0.018, 1));
    add('glassGreen', CY(0.003, h * 0.45, bx, h - 0.33 - h * 0.225, 0.02, 4));
  },
  sink_row({ w, d, n, rng }, add) {
    // row of wall-hung porcelain basins on brackets, chrome taps, chrome traps into the wall, a tiled splashback
    const count = Math.max(1, Math.min(6, n > 1 ? n : Math.round(w / 0.75)));
    const pitch = w / count, bd = Math.min(0.46, d - 0.04), bz = -d / 2 + bd / 2 + 0.02;
    add('enamel', B(w, 0.3, 0.012, 0, 1.05, -d / 2 + 0.006));
    for (let i = 0; i < count; i++) {
      const x = -w / 2 + pitch * (i + 0.5), bw = Math.min(0.56, pitch - 0.08);
      add('enamel', RB(bw, 0.17, bd, x, 0.78, bz, 0.05));
      add('black', B(bw - 0.1, 0.012, bd - 0.12, x, 0.866, bz + 0.02));
      add('steel', CY(0.012, 0.14, x, 0.93, -d / 2 + 0.06, 8), CZ(0.01, 0.12, x, 0.99, -d / 2 + 0.11, 8));
      for (const sx of [-0.08, 0.08]) add(rng.chance(0.5) ? 'red' : 'blue', CY(0.016, 0.02, x + sx, 0.9, -d / 2 + 0.07, 8));
      add('steel', CY(0.02, 0.32, x, 0.53, bz, 8), CZ(0.018, bd / 2, x, 0.38, -d / 2 + bd / 4 + 0.02, 8));
      add('steelDark', B(0.03, 0.12, bd * 0.6, x - bw / 2 + 0.05, 0.66, -d / 2 + bd * 0.3 + 0.02), B(0.03, 0.12, bd * 0.6, x + bw / 2 - 0.05, 0.66, -d / 2 + bd * 0.3 + 0.02));
    }
  },
  pump_flywheel({ w, d, h }, add) {
    // concrete plinth, a cast-iron pump casing, a big spoked flywheel on one end, inlet/outlet pipes into the floor
    add('wall_concrete_dark', B(w, 0.22, d, 0, 0.11, 0));
    const R = Math.min(h * 0.38, d / 2 - 0.04, 0.75), wx = w / 2 - 0.16;
    add('pumpGreen', CX(Math.min(0.38, d * 0.3), w * 0.5, -w * 0.1, 0.22 + Math.min(0.38, d * 0.3) + 0.04, 0, 20));
    add('pumpGreen', RB(w * 0.32, h * 0.45, d * 0.5, -w * 0.28, 0.22 + h * 0.225, 0, 0.04));
    add('steelDark', new THREE.TorusGeometry(R, 0.05, 8, 32).rotateY(Math.PI / 2).translate(wx, 0.24 + R, 0));
    for (let k = 0; k < 3; k++) add('steelDark', B(0.04, R * 2 - 0.06, 0.05).rotateX((k * Math.PI) / 3).translate(wx, 0.24 + R, 0));
    add('brass', CX(0.09, 0.14, wx, 0.24 + R, 0, 14));
    add('steelDark', CX(0.05, w * 0.42, wx - w * 0.21, 0.24 + R, 0, 10), B(0.12, 0.24 + R, 0.16, wx - 0.12, (0.24 + R) / 2, 0));
    for (const sz of [-1, 1]) add('metal_rusty', CY(0.11, 0.3, -w * 0.1, 0.11, sz * (d / 2 - 0.14), 14), CZ(0.11, d * 0.3, -w * 0.1, 0.2, sz * (d / 2 - 0.14 - d * 0.15), 14));
    add('enamel', CZ(0.07, 0.02, -w * 0.28, 0.22 + h * 0.36, d * 0.25 + 0.01, 16));
  },
  pipe_bank({ w, d, h, rng }, add) {
    // three to four horizontal mains on steel stands, flanges every ~0.9 m, valves with hand wheels, a gauge
    const rows = h > 1.2 ? 4 : 3;
    for (let r = 0; r < rows; r++) {
      const y = 0.3 + (r * (h - 0.45)) / Math.max(1, rows - 1), pr = Math.min(0.12, d / 2 - 0.06) * (r === 0 ? 1 : 0.8);
      const mat = r % 2 === 0 ? 'metal_painted' : 'metal_rusty';
      add(mat, CX(pr, w, 0, y, (r % 2 === 0 ? 0.04 : -0.04), 14));
      for (let x = -w / 2 + 0.3; x < w / 2; x += 0.9) add('steelDark', CX(pr + 0.025, 0.05, x, y, (r % 2 === 0 ? 0.04 : -0.04), 14));
      if (rng.chance(0.6)) {
        const vx = (rng.next() - 0.5) * (w - 0.6);
        add('steelDark', CY(0.03, 0.18, vx, y + pr + 0.09, 0.04, 8));
        add('red', shape('torus:0.1:0.014:6:16', () => new THREE.TorusGeometry(0.1, 0.014, 6, 16)).rotateX(Math.PI / 2).translate(vx, y + pr + 0.19, 0.04));
      }
    }
    for (const sx of [-w / 2 + 0.12, w / 2 - 0.12]) add('steelDark', B(0.08, h, 0.08, sx, h / 2, 0), B(0.1, 0.05, d - 0.04, sx, 0.025, 0));
    add('enamel', CZ(0.08, 0.03, w * 0.2, h * 0.55, d / 2 - 0.03, 16));
    add('black', B(0.01, 0.06, 0.004, w * 0.2, h * 0.565, d / 2 - 0.013).rotateZ(0.5));
  },
  card_catalogue({ w, d, h, rng }, add) {
    // oak card catalogue: carcass on turned legs, a grid of small drawers with brass pulls and label frames
    // the carcass stops 4 cm short of the front so the drawer fronts + pulls stay inside the footprint
    const legH = 0.32, top = h, fz = d / 2 - 0.04;
    add('woodDark', RB(w, top - legH, d - 0.04, 0, legH + (top - legH) / 2, -0.02, 0.012));
    add('woodDark', RB(w, 0.03, d, 0, top - 0.015, 0, 0.01, 1));
    for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) for (const sz of [-d / 2 + 0.05, d / 2 - 0.07]) add('woodDark', CY(0.025, legH, sx, legH / 2, sz, 8, 0.018));
    add('woodDark', B(w - 0.1, 0.04, 0.03, 0, legH + 0.02, fz - 0.03));
    const cols = Math.max(3, Math.round(w / 0.15)), rws = Math.max(3, Math.round((top - legH - 0.06) / 0.13));
    const cw = (w - 0.06) / cols, ch = (top - legH - 0.06) / rws;
    for (let r = 0; r < rws; r++) for (let c = 0; c < cols; c++) {
      const x = -w / 2 + 0.03 + cw * (c + 0.5), y = legH + 0.03 + ch * (r + 0.5);
      const out = rng.chance(0.05) ? 0.015 + rng.next() * 0.02 : 0;
      add('wood', RB(cw - 0.012, ch - 0.012, 0.02, x, y, fz + 0.008 + out, 0.004, 1));
      add('brass', B(0.05, 0.022, 0.004, x, y + ch * 0.18, fz + 0.02 + out), CZ(0.007, 0.02, x, y - ch * 0.12, fz + 0.028 + out, 6));
      if (rng.chance(0.85)) add('paper', B(0.04, 0.014, 0.002, x, y + ch * 0.18, fz + 0.0225 + out));
    }
  },
  display_case({ w, d, h, rng }, add) {
    // museum vitrine: panelled wooden base, glass case with a brass frame, specimens inside on a felt bed
    const baseH = Math.min(0.85, h * 0.62);
    add('woodDark', RB(w, baseH, d, 0, baseH / 2, 0, 0.015));
    add('wood', B(w - 0.1, baseH - 0.2, 0.01, 0, baseH / 2, d / 2 + 0.003));
    add('cloth', B(w - 0.08, 0.02, d - 0.08, 0, baseH + 0.01, 0));
    const gh = Math.max(0.2, h - baseH - 0.02);
    add('glassCase', B(w - 0.04, gh, d - 0.04, 0, baseH + gh / 2, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('brass', B(0.02, gh, 0.02, sx * (w / 2 - 0.03), baseH + gh / 2, sz * (d / 2 - 0.03)));
    for (const sz of [-1, 1]) add('brass', B(w - 0.04, 0.02, 0.02, 0, baseH + gh, sz * (d / 2 - 0.03)));
    for (const sx of [-1, 1]) add('brass', B(0.02, 0.02, d - 0.04, sx * (w / 2 - 0.03), baseH + gh, 0));
    const n = 2 + rng.int(0, 2);
    for (let k = 0; k < n; k++) {
      const x = -w / 2 + 0.2 + (k + 0.5) * ((w - 0.4) / n), z = (rng.next() - 0.5) * (d - 0.3);
      const kind = rng.next();
      if (kind < 0.35) add('bone', shape('sph:0.075:12:9', () => new THREE.SphereGeometry(0.075, 12, 9)).scale(1, 0.85, 1.2).translate(x, baseH + 0.09, z), B(0.07, 0.03, 0.06, x, baseH + 0.035, z + 0.06));
      else if (kind < 0.7) add('glassBrown', CY(0.05, 0.16, x, baseH + 0.1, z, 12), CY(0.035, 0.03, x, baseH + 0.195, z, 12));
      else add('bone', new THREE.TorusGeometry(0.07, 0.018, 6, 18, Math.PI * 1.4).rotateX(-Math.PI / 2).translate(x, baseH + 0.04, z));
      add('paper', B(0.06, 0.003, 0.04, x, baseH + 0.022, z + 0.11));
    }
  },
  meat_rail({ w, d, h, rng }, add) {
    // overhead rail on two posts, trolley hooks and muslin-wrapped carcasses swaying at different heights
    const yr = Math.min(h - 0.04, 2.35);
    for (const sx of [-w / 2 + 0.1, w / 2 - 0.1]) add('steel', B(0.07, yr, 0.07, sx, yr / 2, 0), B(0.18, 0.03, Math.max(0.3, d - 0.04), sx, 0.015, 0));
    add('steel', B(w, 0.08, 0.05, 0, yr, 0), B(w, 0.012, 0.11, 0, yr - 0.04, 0));
    const n = Math.max(1, Math.round((w - 0.4) / 0.5));
    for (let k = 0; k < n; k++) {
      const x = -w / 2 + 0.3 + (k * (w - 0.6)) / Math.max(1, n - 1 || 1);
      add('steelDark', B(0.02, 0.2, 0.02, x, yr - 0.14, 0), new THREE.TorusGeometry(0.035, 0.007, 4, 10, Math.PI * 1.5).translate(x, yr - 0.27, 0));
      if (rng.chance(0.25)) continue;
      const len = 0.8 + rng.next() * 0.45, top = yr - 0.3;
      const body = new THREE.CapsuleGeometry(0.15 + rng.next() * 0.05, len, 6, 12).scale(1, 1, 0.75).rotateY(rng.next() * 3).rotateZ((rng.next() - 0.5) * 0.08);
      add(rng.chance(0.75) ? 'muslin' : 'meat', body.translate(x, top - len / 2 - 0.15, 0));
    }
  },
  strip_curtain({ w, h }, add) {
    // PVC strip curtain on a top channel: overlapping translucent strips (walk-through), two side posts
    const yt = Math.min(h, 2.3);
    add('steel', B(w, 0.06, 0.06, 0, yt - 0.03, 0));
    for (const sx of [-w / 2 + 0.02, w / 2 - 0.02]) add('steel', B(0.04, yt, 0.04, sx, yt / 2, 0));
    const sw = 0.2, n = Math.max(1, Math.floor((w - 0.06) / (sw - 0.03)));
    for (let k = 0; k < n; k++) {
      const x = -w / 2 + 0.04 + sw / 2 + k * (sw - 0.03);
      if (x > w / 2 - 0.03) break;
      add('pvc', B(sw, yt - 0.1, 0.004, x, (yt - 0.1) / 2 + 0.02, (k % 2) * 0.006));
    }
  },
};

// ---- SHOULD kits: industry, hospitality, comms
Object.assign(KITS, {
  crucible({ w, d, h }, add) {
    // foundry crucible in a tilting cradle: refractory pot, trunnion frame, a skin of cooling slag glowing at the lip
    const r = Math.min(w, d) / 2 - 0.08;
    for (const sx of [-1, 1]) {
      add('steelDark', B(0.08, h * 0.62, 0.12, sx * (w / 2 - 0.06), h * 0.31, 0), B(0.1, 0.06, d - 0.08, sx * (w / 2 - 0.06), 0.03, 0));
      add('steelDark', CX(0.05, 0.12, sx * (w / 2 - 0.12), h * 0.58, 0, 10));
    }
    add('metal_rusty', CY(r, h * 0.62, 0, h * 0.58, 0, 20, r * 0.72));
    add('wall_concrete_dark', CY(r - 0.04, 0.02, 0, h * 0.89, 0, 20));
    add('ledA', CY(r * 0.55, 0.01, 0, h * 0.9 + 0.006, 0, 16));
    add('steelDark', new THREE.TorusGeometry(r + 0.02, 0.025, 6, 24).rotateX(Math.PI / 2).translate(0, h * 0.88, 0));
  },
  mould_rack({ w, d, h, rng }, add) {
    // steel rack of sand moulds and rough castings
    const lv = [0.08, h * 0.38, h * 0.7];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steelDark', B(0.05, h, 0.05, sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03)));
    for (const y of lv) {
      add('steelDark', B(w - 0.04, 0.03, d - 0.04, 0, y, 0));
      for (let x = -w / 2 + 0.2; x < w / 2 - 0.15; x += 0.3 + rng.next() * 0.1) {
        const k = rng.next();
        if (k < 0.5) add('wall_concrete_dark', B(0.24, 0.16, d - 0.16, x, y + 0.095, 0));
        else if (k < 0.85) add('metal_rusty', CY(0.08 + rng.next() * 0.04, 0.14, x, y + 0.085, (rng.next() - 0.5) * 0.2, 12));
      }
    }
  },
  round_table({ w, h, rng }, add) {
    // hotel dining table: round top with a cloth, a turned pedestal on a cross foot, a candle stub
    const r = w / 2 - 0.02;
    add('wood', CY(r, 0.035, 0, h - 0.0175, 0, 28));
    if (rng.chance(0.7)) add('sheet', CY(r + 0.02, 0.006, 0, h + 0.003, 0, 28), CY(r + 0.02, 0.22, 0, h - 0.11, 0, 28, r + 0.06).translate(0, 0, 0));
    add('woodDark', CY(0.05, h - 0.1, 0, (h - 0.1) / 2 + 0.06, 0, 12, 0.07));
    add('woodDark', B(w * 0.6, 0.05, 0.08, 0, 0.025, 0), B(0.08, 0.05, w * 0.6, 0, 0.025, 0));
    if (rng.chance(0.5)) { add('enamel', CY(0.025, 0.06, 0.1, h + 0.036, -0.05, 10)); add('candle', shape('sph:0.01:6:4', () => new THREE.SphereGeometry(0.01, 6, 4)).scale(1, 1.8, 1).translate(0.1, h + 0.08, -0.05)); }
  },
  linen_cart({ w, d, h, rng }, add) {
    // laundry trolley: steel frame on castors holding a sagging canvas bag of sheets
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add('steel', CY(0.014, h - 0.08, sx * (w / 2 - 0.03), (h - 0.08) / 2 + 0.08, sz * (d / 2 - 0.03), 8));
      add('black', cyl(0.035, 0.025, 0, 0, 0, 10).rotateZ(Math.PI / 2).translate(sx * (w / 2 - 0.05), 0.035, sz * (d / 2 - 0.05)));
    }
    for (const sz of [-1, 1]) add('steel', CX(0.012, w - 0.04, 0, h - 0.02, sz * (d / 2 - 0.03), 8));
    for (const sx of [-1, 1]) add('steel', CZ(0.012, d - 0.04, sx * (w / 2 - 0.03), h - 0.02, 0, 8));
    add('blanket', RB(w - 0.1, h * 0.62, d - 0.1, 0, h * 0.62 / 2 + h * 0.3, 0, 0.06));
    for (let k = 0; k < 3; k++) add('sheet', RB(w * (0.3 + rng.next() * 0.3), 0.08, d * 0.4, (rng.next() - 0.5) * w * 0.3, h * 0.92 + k * 0.05, (rng.next() - 0.5) * d * 0.2, 0.03, 1));
  },
  bunk({ w, d, h, rng }, add) {
    // two-tier steel bunk: posts, two mattresses with blankets, a ladder at the foot
    const tube = 0.025, x = w / 2 - 0.04, zz = d / 2 - 0.04;
    for (const sx of [-x, x]) for (const sz of [-zz, zz]) add('steelDark', CY(tube, h, sx, h / 2, sz, 8));
    for (const y of [0.35, h * 0.62]) {
      for (const sx of [-x, x]) add('steelDark', CZ(tube * 0.8, d - 0.08, sx, y, 0, 8));
      for (const sz of [-zz, zz]) add('steelDark', CX(tube * 0.8, w - 0.08, 0, y, sz, 8));
      add('sheet', RB(w - 0.12, 0.12, d - 0.14, 0, y + 0.08, 0, 0.04));
      add('blanket', RB(w - 0.1, 0.04, d * 0.55, 0, y + 0.15, d * 0.18 + (rng.next() - 0.5) * 0.1, 0.02));
    }
    for (let y = 0.5; y < h * 0.62; y += 0.25) add('steelDark', CX(0.012, 0.3, x - 0.2, y, zz, 6));
  },
  switchboard({ w, d, h, rng }, add) {
    // manual telephone switchboard: wooden cabinet, a jack field over a sloped desk of keys, a few patch cords + lamps
    const deskH = 0.78;
    add('woodDark', RB(w, deskH, d, 0, deskH / 2, 0, 0.015));
    add('woodDark', RB(w, h - deskH, 0.22, 0, deskH + (h - deskH) / 2, -d / 2 + 0.11, 0.015));
    add('black', B(w - 0.12, h - deskH - 0.14, 0.01, 0, deskH + (h - deskH) / 2 + 0.02, -d / 2 + 0.226));
    const cols = Math.round((w - 0.2) / 0.06), rows = 6;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const xx = -w / 2 + 0.13 + c * ((w - 0.26) / (cols - 1)), yy = deskH + 0.14 + r * ((h - deskH - 0.3) / (rows - 1));
      add('brass', CZ(0.007, 0.012, xx, yy, -d / 2 + 0.236, 6));
      if (rng.chance(0.06)) add('ledA', B(0.012, 0.012, 0.004, xx, yy + 0.03, -d / 2 + 0.236));
    }
    add('enamel', B(w - 0.06, 0.02, d - 0.26, 0, deskH + 0.01, 0.1).rotateX(-0.12));
    for (let k = 0; k < 5; k++) add('cable', new THREE.TorusGeometry(0.16 + rng.next() * 0.1, 0.006, 4, 14, Math.PI).rotateX(Math.PI / 2 - 0.4).translate(-w / 2 + 0.3 + rng.next() * (w - 0.6), deskH + 0.12, 0.0));
  },
  phone_booth({ w, d, h }, add) {
    // public phone box: steel frame, glazed sides, a lit TELEPHONE sign band, the handset on its hook inside
    const t = 0.05;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('red', B(t, h - 0.08, t, sx * (w / 2 - t / 2), (h - 0.08) / 2 + 0.04, sz * (d / 2 - t / 2)));
    add('red', RB(w, 0.12, d, 0, h - 0.06, 0, 0.02), B(w, 0.04, d, 0, 0.02, 0));
    add('ledA', B(w - 0.12, 0.05, 0.005, 0, h - 0.18, d / 2 + 0.002));
    for (const sz of [-1, 1]) add('glassCase', B(w - 2 * t, h - 0.36, 0.008, 0, (h - 0.36) / 2 + 0.12, sz * (d / 2 - t / 2)));
    add('glassCase', B(0.008, h - 0.36, d - 2 * t, w / 2 - t / 2, (h - 0.36) / 2 + 0.12, 0));
    add('red', B(0.008, h - 0.36, d - 2 * t, -w / 2 + t / 2, (h - 0.36) / 2 + 0.12, 0));
    add('black', B(0.18, 0.3, 0.12, -w / 2 + 0.12, 1.3, 0), CZ(0.02, 0.2, -w / 2 + 0.2, 1.42, 0.08, 8));
    add('steel', CY(0.008, 0.5, -w / 2 + 0.2, 0.95, 0.08, 6));
  },
} as Record<string, Kit>);

/** keys that have a kit (tests: every proc PROP_DEFS key yields parts, kitted or via the fallback) */
export const KIT_KEYS: readonly string[] = Object.keys(KITS);

/** Parts of a kitted key (null = no kit for it). Kits model on the floor (y 0..h); wall-mounted keys are centred on
 *  their mount height like every other wall item. */
export function kitParts(key: string, dims: { w: number; d: number; h: number; n?: number }, rng: Rng, roomType = '', mount: 'floor' | 'wall' = 'floor'): Part[] | null {
  const kit = KITS[key];
  if (!kit) return null;
  const P: Part[] = [];
  kit({ w: dims.w, d: dims.d, h: dims.h, n: dims.n ?? 1, rng, roomType }, (mat, ...gs) => { for (const g of gs) P.push(part(mat, g)); });
  if (mount === 'wall') { const down = new THREE.Matrix4().makeTranslation(0, -dims.h / 2, 0); for (const p of P) transformPart(p, down); }
  return P;
}

/** a procedural key without a kit: a bevelled box exactly the prop's footprint (solid props are never invisible) */
export function fallbackParts(dims: { w: number; d: number; h: number }, mount: 'floor' | 'wall'): Part[] {
  const w = Math.max(0.05, dims.w), d = Math.max(0.02, dims.d), h = Math.max(0.05, dims.h);
  const r = Math.min(0.03, Math.max(0.01, Math.min(w, d, h) * 0.08));
  const y = mount === 'wall' ? 0 : h / 2;
  return [
    part('metal_painted', RB(w, h, d, 0, y, 0, r)),
    part('steelDark', B(Math.max(0.02, w - 0.06), 0.03, 0.01, 0, y + h * 0.3, d / 2 + 0.004)),
  ];
}
