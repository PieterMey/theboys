// Owner: track ② Level. Procedural placeholder meshes for layout items (lever box, keypad, locker, console desk,
// loot crates, the Core canister...). Interaction/objectives replace or extend them via the level service registry
// (level.itemObject(id) / level.setItemObject(id, obj)). Shared geometries + materials; one Group per item.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { LevelMaterials } from './materials.ts';
import { KEY_COLORS } from './doors.ts';
import { loadPropModel } from './assets.ts';
import { PROP_DEFS } from '@dead-air/shared/procgen/decor.ts';

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

type Mats = ReturnType<typeof makeMats>;
let cached: Mats | null = null;

function noteTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 180;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9d4c3';
  g.fillRect(0, 0, 128, 180);
  g.fillStyle = 'rgba(120,90,40,0.25)';
  g.fillRect(0, 0, 128, 14);
  const r = makeRng('note', 'decor');
  g.fillStyle = '#2b2b33';
  for (let y = 26; y < 168; y += 9) {
    let x = 10;
    while (x < 112) { const w = 6 + r.next() * 22; if (x + w > 118) break; g.fillRect(x, y, w, 2); x += w + 4; }
  }
  g.fillStyle = '#7a1c16';
  g.fillRect(84, 140, 30, 18);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#c99a10';
  for (let i = -128; i < 256; i += 32) { g.beginPath(); g.moveTo(i, 128); g.lineTo(i + 16, 128); g.lineTo(i + 144, 0); g.lineTo(i + 128, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeMats(mats: LevelMaterials) {
  const std = (name: string, color: number, roughness: number, metalness: number, extra: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness, ...extra });
    m.name = `level.prop.${name}`;
    return m;
  };
  return {
    cardboard: std('cardboard', 0x8a6a45, 0.9, 0),
    case: std('case', 0x34383b, 0.45, 0.6),
    crate: std('crate', 0x5c4630, 0.75, 0),
    band: std('band', 0x6b6f72, 0.4, 0.8),
    breaker: std('breaker', 0x4f5b56, 0.5, 0.55),
    lever: std('lever', 0x1d1d1d, 0.6, 0.3),
    leverRed: std('leverred', 0x9a1a14, 0.45, 0.2),
    panel: std('panel', 0x2a2d30, 0.5, 0.6),
    locker: std('locker', 0x56635c, 0.5, 0.55),
    lockerDark: std('lockerdark', 0x0c0d0e, 0.8, 0.2),
    desk: std('desk', 0x3b3f42, 0.6, 0.4),
    deskTop: std('desktop', 0x22262a, 0.4, 0.3),
    paper: std('paper', 0xffffff, 0.95, 0, { map: noteTexture() }),
    grate: std('grate', 0x3a3d40, 0.55, 0.7),
    plastic: std('plastic', 0xbab6a8, 0.6, 0),
    glassCyl: std('glasscyl', 0x9fe8ff, 0.05, 0.1, { transparent: true, opacity: 0.35 }),
    chrome: std('chrome', 0xc8ccd0, 0.12, 1),
    mirror: std('mirror', 0xd9dde0, 0.03, 1),
    cork: std('cork', 0x8f6b43, 0.95, 0),
    whiteboard: std('whiteboard', 0xe2e2da, 0.3, 0),
    hatch: std('hatch', 0xffffff, 0.8, 0, { map: stripeTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    wood: mats.get('wood'),
    metalDark: mats.get('metal_dark'),
    rusty: mats.get('metal_rusty'),
    screen: mats.glow(0x3cffb0, 1.6),
    screenBlue: mats.glow(0x48a8ff, 1.4),
    ledRed: mats.glow(0xff2a1a, 3),
    ledGreen: mats.glow(0x30ff60, 2.5),
    ledAmber: mats.glow(0xffa020, 2.5),
    core: mats.glow(0x40f0ff, 6),
    exitSign: mats.glow(0x30ff70, 3),
  };
}

/** a named screen's own material: plain standard + emissive (colour and intensity are uniforms, so every screen
 *  shares the plain-material pipeline while consumers can restyle one screen alone) */
const ownMats = new Map<string, THREE.MeshStandardNodeMaterial>();
/** a CRT face for a console screen (white-on-black, tinted by the material's emissive colour): work orders, the site
 *  map, a dead camera feed, the scanner sweep. null without a DOM (unit tests). */
function screenFace(key: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 160);
  const r = makeRng(key, 'decor:screen');
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.font = "700 15px 'Courier New', Courier, monospace";
  if (key === 'screen0') {
    g.fillText('WORK ORDERS', 12, 22);
    g.fillRect(12, 28, 232, 2);
    for (let i = 0; i < 6; i++) { g.globalAlpha = i === 1 ? 1 : 0.55; g.fillRect(12, 42 + i * 18, 40 + r.next() * 120, 7); g.fillRect(200, 42 + i * 18, 36, 7); }
  } else if (key === 'screen1') {
    g.fillText('SITE MAP', 12, 20);
    g.globalAlpha = 0.35;
    for (let x = 12; x < 250; x += 16) g.fillRect(x, 28, 1, 124);
    for (let y = 28; y < 154; y += 16) g.fillRect(12, y, 232, 1);
    g.globalAlpha = 0.85;
    g.lineWidth = 2;
    g.strokeRect(40, 50, 90, 60); g.strokeRect(130, 70, 70, 50); g.strokeRect(60, 110, 50, 30);
    g.globalAlpha = 1;
    for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(50 + r.next() * 150, 60 + r.next() * 70, 3, 0, Math.PI * 2); g.fill(); }
  } else if (key === 'screen2') {
    for (let k = 0; k < 2600; k++) { g.globalAlpha = r.next() * 0.6; g.fillRect(r.next() * 256, r.next() * 160, 2, 1); }
    g.globalAlpha = 1;
    g.fillText('CAM 03', 12, 22);
    g.fillText('NO SIGNAL', 86, 86);
  } else {
    g.lineWidth = 1.5;
    for (const rr of [20, 40, 60]) { g.globalAlpha = 0.6; g.beginPath(); g.arc(128, 84, rr, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(128, 84); g.arc(128, 84, 64, -0.9, -0.3); g.closePath(); g.fill();
    g.fillText('SCAN', 12, 22);
  }
  g.globalAlpha = 0.25;
  for (let y = 0; y < 160; y += 3) g.clearRect(0, y, 256, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function screenMaterial(color: number, intensity: number, key: string): THREE.MeshStandardNodeMaterial {
  let m = ownMats.get(key);
  if (!m) {
    const face = screenFace(key);
    m = new THREE.MeshStandardNodeMaterial({ color: 0x0a0c0d, roughness: 0.22, metalness: 0, emissive: color, emissiveIntensity: intensity, ...(face ? { map: face, emissiveMap: face } : {}) });
    m.name = `level.prop.${key}`;
    ownMats.set(key, m);
  }
  return m;
}
/** a mirror glass's own material (fallback look until render.mirrors makes it live) */
function glassMaterial(): THREE.MeshStandardNodeMaterial {
  let m = ownMats.get('mirrorglass');
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ color: 0x9aa3a6, roughness: 0.06, metalness: 1 });
    m.name = 'level.prop.mirrorglass';
    ownMats.set('mirrorglass', m);
  }
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, name?: string): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  if (name) o.name = name;
  return o;
}

/** Build the placeholder for one item. Wall items are modelled with their back on local z = -depth/2. */
export function buildItem(it: LayoutItem, L: LevelLayout, lm: LevelMaterials): THREE.Object3D | null {
  const M = (cached ??= makeMats(lm));
  const g = new THREE.Group();
  g.name = `item:${it.id}`;
  g.position.set(it.x, it.y ?? 0, it.z);
  g.rotation.y = it.rot ?? 0;
  g.userData.itemId = it.id;
  g.userData.kind = it.kind;
  switch (it.kind) {
    case 'loot': {
      const tier = Number(it.data?.tier ?? 0);
      const r = makeRng(it.id + L.seed, 'decor:loot');
      if (tier === 0) {
        const w = 0.34 + r.next() * 0.16, h = 0.24 + r.next() * 0.14, d = 0.3 + r.next() * 0.12;
        g.add(mesh(geo(`cb${Math.round(w * 50)}${Math.round(h * 50)}${Math.round(d * 50)}`, () => box(w, h, d, 0, h / 2, 0)), M.cardboard));
        g.add(mesh(geo(`cbt${Math.round(w * 50)}${Math.round(h * 50)}`, () => box(0.06, 0.005, d + 0.004, 0, h + 0.002, 0)), M.plastic));
      } else if (tier === 1) {
        g.add(mesh(geo('case', () => box(0.56, 0.2, 0.4, 0, 0.1, 0)), M.case));
        g.add(mesh(geo('caseh', () => box(0.16, 0.03, 0.03, 0, 0.215, -0.1)), M.chrome));
        g.add(mesh(geo('casel', () => box(0.57, 0.02, 0.41, 0, 0.13, 0)), M.band));
      } else {
        g.add(mesh(geo('crate', () => box(0.72, 0.56, 0.6, 0, 0.28, 0)), M.crate));
        g.add(mesh(geo('crateb', () => mergeGeometries([box(0.74, 0.06, 0.62, 0, 0.08, 0), box(0.74, 0.06, 0.62, 0, 0.48, 0)])), M.band));
      }
      break;
    }
    case 'lever': {
      // breaker cabinet with a big throw lever (child 'handle' rotates about x)
      g.add(mesh(geo('lvbox', () => box(0.42, 0.6, 0.22, 0, 0, 0)), M.breaker));
      g.add(mesh(geo('lvplate', () => box(0.36, 0.5, 0.01, 0, 0, 0.115)), M.panel));
      const handle = new THREE.Group();
      handle.name = 'handle';
      handle.position.set(0, 0, 0.13);
      handle.add(mesh(geo('lvarm', () => box(0.05, 0.32, 0.05, 0, 0.14, 0.03)), M.lever));
      handle.add(mesh(geo('lvgrip', () => new THREE.CylinderGeometry(0.035, 0.035, 0.18, 10).rotateZ(Math.PI / 2).translate(0, 0.3, 0.06)), M.leverRed));
      handle.rotation.x = 0.55;
      g.add(handle);
      g.add(mesh(geo('lvled', () => box(0.04, 0.04, 0.02, 0.15, 0.24, 0.12)), M.ledRed, 'led'));
      break;
    }
    case 'keypad': {
      g.add(mesh(geo('kpbox', () => box(0.17, 0.24, 0.05, 0, 0, 0)), M.panel));
      g.add(mesh(geo('kpscr', () => box(0.12, 0.045, 0.01, 0, 0.075, 0.027)), M.screen, 'screen'));
      g.add(mesh(geo('kpkeys', () => {
        const parts: THREE.BufferGeometry[] = [];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) parts.push(box(0.03, 0.025, 0.012, (c - 1) * 0.04, 0.02 - r * 0.035, 0.028));
        return mergeGeometries(parts);
      }), M.plastic));
      break;
    }
    case 'core': {
      g.add(mesh(geo('corePed', () => mergeGeometries([box(0.7, 0.45, 0.7, 0, 0.225, 0), box(0.5, 0.06, 0.5, 0, 0.48, 0)])), M.metalDark));
      const can = new THREE.Group();
      can.name = 'canister';
      can.position.y = 0.51;
      can.add(mesh(geo('coreGlass', () => new THREE.CylinderGeometry(0.17, 0.17, 0.5, 24).translate(0, 0.32, 0)), M.glassCyl));
      can.add(mesh(geo('coreGlow', () => new THREE.CylinderGeometry(0.075, 0.075, 0.44, 16).translate(0, 0.32, 0)), M.core, 'glow'));
      can.add(mesh(geo('coreCaps', () => mergeGeometries([new THREE.CylinderGeometry(0.2, 0.2, 0.08, 24).translate(0, 0.04, 0), new THREE.CylinderGeometry(0.2, 0.2, 0.08, 24).translate(0, 0.6, 0), new THREE.TorusGeometry(0.1, 0.02, 8, 16).rotateX(Math.PI / 2).translate(0, 0.68, 0)])), M.chrome));
      g.add(can);
      break;
    }
    case 'keycard': {
      g.position.y = 0;
      g.add(mesh(geo('kcPed', () => mergeGeometries([box(0.46, 0.8, 0.4, 0, 0.4, 0), box(0.52, 0.04, 0.46, 0, 0.82, 0)])), M.desk));
      const col = KEY_COLORS[Math.min(KEY_COLORS.length - 1, Math.max(1, Number(it.data?.lock ?? 1)))];
      const card = new THREE.Group();
      card.name = 'card';
      card.position.set(0.04, 0.845, 0.02);
      card.rotation.y = 0.4;
      card.add(mesh(geo('kcCard', () => box(0.086, 0.004, 0.054, 0, 0, 0)), M.plastic));
      card.add(mesh(geo('kcStripe', () => box(0.086, 0.005, 0.014, 0, 0.001, -0.012)), lm.glow(col, 2.5)));
      g.add(card);
      break;
    }
    case 'hiding': {
      // full-height locker with ventilation slats (door child 'door' hinged on its left edge)
      g.add(mesh(geo('lkBody', () => box(0.9, 1.9, 0.55, 0, 0.95, 0)), M.locker));
      const door = new THREE.Group();
      door.name = 'door';
      door.position.set(-0.43, 0, 0.278);
      door.add(mesh(geo('lkDoor', () => box(0.84, 1.82, 0.025, 0.42, 0.95, 0)), M.locker));
      door.add(mesh(geo('lkSlats', () => {
        const parts: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 6; k++) parts.push(box(0.5, 0.025, 0.01, 0.42, 1.45 + k * 0.05, 0.014));
        for (let k = 0; k < 4; k++) parts.push(box(0.5, 0.025, 0.01, 0.42, 0.25 + k * 0.05, 0.014));
        return mergeGeometries(parts);
      }), M.lockerDark));
      door.add(mesh(geo('lkHandle', () => box(0.03, 0.14, 0.03, 0.76, 1.0, 0.03)), M.chrome));
      g.add(door);
      break;
    }
    case 'note': {
      const r = makeRng(it.id + L.seed, 'decor:note');
      const sheet = mesh(geo('note', () => new THREE.PlaneGeometry(0.21, 0.297)), M.paper);
      sheet.position.z = 0.002;
      sheet.rotation.z = (r.next() - 0.5) * 0.25;
      g.add(sheet);
      g.add(mesh(geo('notePin', () => new THREE.SphereGeometry(0.012, 8, 6).translate(0, 0.13, 0.006)), M.leverRed));
      break;
    }
    case 'vent': {
      g.add(mesh(geo('ventFrame', () => mergeGeometries([box(0.64, 0.04, 0.05, 0, 0.18, 0), box(0.64, 0.04, 0.05, 0, -0.18, 0), box(0.04, 0.4, 0.05, -0.3, 0, 0), box(0.04, 0.4, 0.05, 0.3, 0, 0)])), M.grate));
      g.add(mesh(geo('ventBack', () => box(0.56, 0.32, 0.01, 0, 0, -0.02)), M.lockerDark));
      g.add(mesh(geo('ventSlats', () => {
        const parts: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 6; k++) parts.push(box(0.56, 0.018, 0.04, 0, -0.13 + k * 0.052, 0).rotateX(0.5));
        return mergeGeometries(parts);
      }), M.grate));
      break;
    }
    case 'intercom': {
      g.add(mesh(geo('icBox', () => box(0.18, 0.26, 0.06, 0, 0, 0)), M.plastic));
      g.add(mesh(geo('icGrill', () => {
        const parts: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 5; k++) parts.push(box(0.12, 0.01, 0.006, 0, 0.06 - k * 0.022, 0.032));
        return mergeGeometries(parts);
      }), M.panel));
      g.add(mesh(geo('icBtn', () => box(0.05, 0.03, 0.015, 0, -0.08, 0.035)), M.leverRed));
      g.add(mesh(geo('icLed', () => box(0.015, 0.015, 0.008, 0.06, 0.1, 0.034)), M.ledGreen, 'led'));
      break;
    }
    case 'switch': {
      g.add(mesh(geo('swPlate', () => box(0.085, 0.125, 0.012, 0, 0, 0)), M.plastic));
      const toggle = mesh(geo('swToggle', () => box(0.018, 0.035, 0.018, 0, 0, 0.012)), M.panel, 'toggle');
      toggle.position.y = 0.012;
      g.add(toggle);
      break;
    }
    case 'console': {
      // operator desk against the van's front partition: screens face the rear (local +z). v1.2: every screen is a
      // named part with its OWN material (stationObject('console') -> 'screen0'..'screen3'); screen3 + its housing
      // ('scanner') belong to the scanner upgrade and stay hidden until setVanUpgrades lists it
      g.add(mesh(geo('cnDesk', () => mergeGeometries([box(1.7, 0.06, 0.55, 0, 0.76, 0), box(1.6, 0.7, 0.45, 0, 0.36, -0.03)])), M.desk));
      g.add(mesh(geo('cnTop', () => box(1.68, 0.01, 0.53, 0, 0.795, 0)), M.deskTop));
      const screens: [number, number, number, number][] = [[-0.55, 1.12, 0.5, 0.32], [0, 1.18, 0.62, 0.4], [0.55, 1.12, 0.5, 0.32]];
      screens.forEach(([x, y, w, h], k) => {
        const yaw = -x * 0.5;
        const mon = new THREE.Group();
        mon.position.set(x, y, -0.12);
        mon.rotation.y = yaw;
        mon.add(mesh(geo(`cnMon${k}`, () => box(w + 0.04, h + 0.04, 0.04, 0, 0, 0)), M.case));
        mon.add(mesh(geo(`cnScr${k}`, () => box(w, h, 0.005, 0, 0, 0.022)), screenMaterial(k === 1 ? 0x3cffb0 : 0x48a8ff, k === 1 ? 2.4 : 2.1, `screen${k}`), `screen${k}`));
        g.add(mon);
      });
      g.add(mesh(geo('cnKb', () => box(0.45, 0.02, 0.15, 0, 0.81, 0.12)), M.panel));
      const scanner = new THREE.Group();
      scanner.name = 'scanner';
      scanner.position.set(0.66, 0.9, 0.1);
      scanner.rotation.set(-0.35, -0.5, 0);
      scanner.visible = false;
      scanner.add(mesh(geo('cnScanCase', () => box(0.26, 0.2, 0.16, 0, 0, -0.03)), M.case));
      scanner.add(mesh(geo('cnScan', () => box(0.2, 0.14, 0.004, 0, 0.005, 0.052)), screenMaterial(0x6dff4a, 2.6, 'screen3'), 'screen3'));
      g.add(scanner);
      break;
    }
    case 'leave_lever': {
      g.add(mesh(geo('llBox', () => box(0.3, 0.42, 0.16, 0, 0, 0)), M.leverRed));
      const handle = new THREE.Group();
      handle.name = 'handle';
      handle.position.set(0, -0.05, 0.09);
      handle.add(mesh(geo('llArm', () => box(0.04, 0.26, 0.04, 0, 0.12, 0.02)), M.lever));
      handle.add(mesh(geo('llGrip', () => new THREE.SphereGeometry(0.045, 12, 8).translate(0, 0.26, 0.03)), M.ledRed));
      handle.rotation.x = 0.5;
      g.add(handle);
      break;
    }
    case 'deposit': {
      const hatch = mesh(geo('dpHatch', () => new THREE.PlaneGeometry(1.5, 0.9).rotateX(-Math.PI / 2).translate(0, 0.034, 0)), M.hatch);
      g.add(hatch);
      g.add(mesh(geo('dpBin', () => mergeGeometries([box(0.6, 0.35, 0.04, -0.45, 0.2, -0.3), box(0.6, 0.35, 0.04, -0.45, 0.2, 0.3), box(0.04, 0.35, 0.6, -0.75, 0.2, 0), box(0.04, 0.35, 0.6, -0.15, 0.2, 0)])), M.band));
      break;
    }
    case 'mirror': {
      // v1.2: the hub mirror ('Change your look') hangs in the van at the station spot (data.mirror 'van'): a slim
      // framed wall mirror centred on its mount height; before gate L1 it was the free-standing locker mirror. Either
      // way the glass is the named part 'glass' (own material) that the level registers with render.mirrors.
      if (it.data?.mirror === 'van' || it.data?.station === 'mirror') {
        const w = Number(it.data?.w ?? 0.45), h = Number(it.data?.h ?? 0.9), d = Number(it.data?.d ?? 0.03);
        g.add(mesh(geo(`mrvBack${w}${h}`, () => box(w, h, 0.01, 0, 0, -d / 2 + 0.005)), M.lockerDark));
        g.add(mesh(geo(`mrvFrame${w}${h}`, () => mergeGeometries([box(w, 0.022, 0.024, 0, h / 2 - 0.011, 0), box(w, 0.022, 0.024, 0, -h / 2 + 0.011, 0), box(0.022, h - 0.044, 0.024, -w / 2 + 0.011, 0, 0), box(0.022, h - 0.044, 0.024, w / 2 - 0.011, 0, 0)])), M.chrome));
        g.add(mesh(geo(`mrvGlass${w}${h}`, () => new THREE.PlaneGeometry(w - 0.044, h - 0.044).translate(0, 0, 0.008)), glassMaterial(), 'glass'));
        break;
      }
      g.add(mesh(geo('mrBody', () => box(0.9, 2.0, 0.5, 0, 1.0, 0)), M.locker));
      g.add(mesh(geo('mrGlass', () => box(0.66, 1.4, 0.01, 0, 1.15, 0.255)), glassMaterial(), 'glass'));
      g.add(mesh(geo('mrFrame', () => mergeGeometries([box(0.72, 0.04, 0.02, 0, 1.87, 0.255), box(0.72, 0.04, 0.02, 0, 0.43, 0.255)])), M.chrome));
      break;
    }
    case 'board': {
      g.add(mesh(geo('bdBoard', () => box(1.6, 1.0, 0.04, 0, 1.45, 0.11)), M.cork));
      g.add(mesh(geo('bdFrame', () => mergeGeometries([box(1.66, 0.05, 0.06, 0, 1.97, 0.11), box(1.66, 0.05, 0.06, 0, 0.93, 0.11), box(0.05, 1.08, 0.06, -0.81, 1.45, 0.11), box(0.05, 1.08, 0.06, 0.81, 1.45, 0.11)])), M.wood));
      g.add(mesh(geo('bdLegs', () => mergeGeometries([box(0.05, 1.95, 0.05, -0.7, 0.975, 0.06), box(0.05, 1.95, 0.05, 0.7, 0.975, 0.06)])), M.band));
      const r = makeRng('board', 'decor');
      for (let k = 0; k < 3; k++) {
        const sheet = mesh(geo('note', () => new THREE.PlaneGeometry(0.21, 0.297)), M.paper);
        sheet.position.set(-0.5 + k * 0.5, 1.45 + (r.next() - 0.5) * 0.2, 0.135);
        sheet.rotation.z = (r.next() - 0.5) * 0.2;
        sheet.scale.setScalar(1.4);
        g.add(sheet);
      }
      break;
    }
    case 'shop': {
      g.add(mesh(geo('shCrate', () => mergeGeometries([box(1.3, 0.7, 0.7, 0, 0.35, 0), box(0.8, 0.5, 0.55, -0.15, 0.95, 0)])), M.crate));
      g.add(mesh(geo('shBand', () => mergeGeometries([box(1.32, 0.05, 0.72, 0, 0.5, 0), box(0.82, 0.05, 0.57, -0.15, 1.1, 0)])), M.band));
      g.add(mesh(geo('shTop', () => box(0.4, 0.25, 0.35, 0.38, 0.83, 0.05)), M.case));
      break;
    }
    case 'kennel': {
      // sign on the pen's front fence + dog house + chain post inside the pen
      // on the pen's front fence (0.6 m behind this interaction point), facing the player
      g.add(mesh(geo('knSign', () => box(0.9, 0.42, 0.02, 0, 1.55, -0.56)), M.whiteboard));
      g.add(mesh(geo('knSignStripe', () => box(0.9, 0.08, 0.025, 0, 1.72, -0.555)), M.leverRed));
      const pen = it.data?.pen !== undefined ? L.spaces[Number(it.data.pen)] : null;
      if (pen) {
        const house = new THREE.Group();
        house.position.set(pen.rect.x + 1.0 - it.x, -(it.y ?? 0), pen.rect.y + pen.rect.h - 0.9 - it.z);
        house.add(mesh(geo('knHouse', () => box(1.2, 0.9, 1.0, 0, 0.45, 0)), M.wood));
        house.add(mesh(geo('knRoof', () => mergeGeometries([box(1.35, 0.06, 0.62, 0, 1.05, -0.24).rotateX(-0.6), box(1.35, 0.06, 0.62, 0, 1.05, 0.24).rotateX(0.6)])), M.rusty));
        house.add(mesh(geo('knHole', () => box(0.45, 0.55, 0.01, 0, 0.32, -0.505)), M.lockerDark));
        // the house is in world space relative to this item (kennel item faces -Z): undo the item yaw
        house.rotation.y = -(it.rot ?? 0);
        house.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -(it.rot ?? 0));
        g.add(house);
      }
      break;
    }
    case 'prop': {
      const key = String(it.data?.prop ?? '');
      const def = PROP_DEFS[key];
      if (def) {
        // placeholder until the GLB arrives (same footprint as the collision box)
        const ph = mesh(geo(`ph:${key}`, () => box(def.w, def.h, def.d, 0, def.mount === 'wall' ? 0 : def.h / 2, 0)), M.case, 'placeholder');
        g.add(ph);
        void loadPropModel(key).then((tpl) => {
          if (!tpl) return;
          ph.removeFromParent();
          const inst = tpl.clone(true);
          if (def.mount === 'wall') inst.position.y = -def.h / 2;
          g.add(inst);
        });
        break;
      }
      if (it.data?.prop === 'entrance_door') {
        const w = Number(it.data.w ?? 2);
        // closed double doors set into the facade + green EXIT sign + light box
        g.add(mesh(geo(`edFrame${w}`, () => mergeGeometries([box(w + 0.24, 0.14, 0.12, 0, 2.27, 0.02), box(0.12, 2.3, 0.12, -w / 2 - 0.06, 1.15, 0.02), box(0.12, 2.3, 0.12, w / 2 + 0.06, 1.15, 0.02)])), M.band));
        g.add(mesh(geo(`edLeaves${w}`, () => mergeGeometries([box(w / 2 - 0.02, 2.18, 0.06, -w / 4, 1.1, 0), box(w / 2 - 0.02, 2.18, 0.06, w / 4, 1.1, 0)])), M.case));
        g.add(mesh(geo(`edGlass${w}`, () => mergeGeometries([box(w / 2 - 0.3, 1.1, 0.065, -w / 4, 1.35, 0), box(w / 2 - 0.3, 1.1, 0.065, w / 4, 1.35, 0)])), M.glassCyl));
        g.add(mesh(geo('edBars', () => mergeGeometries([box(w / 2 - 0.2, 0.04, 0.05, -w / 4, 1.0, 0.06), box(w / 2 - 0.2, 0.04, 0.05, w / 4, 1.0, 0.06)])), M.chrome));
        g.add(mesh(geo('edSign', () => box(0.42, 0.16, 0.05, 0, 2.6, 0.04)), M.exitSign));
      }
      break;
    }
    default:
      return null;
  }
  return g;
}
