// Owner: workshop (v1.2). 'workbench' screen; registered by installWorkshop.
//   COMPANY WORKBENCH · VAN 9: Craft (crew stash, tier I/II recipes against the stash, store prices, CRAFT),
//   Upgrades (scrip + materials, BUY, owned ticks), Locker (your gear pool, slots, hand-out order -> meta.loadout).
//   Denials show inline; Esc closes. While open, the bench lamp is lit (craft tab) and the locker door swings open
//   (locker tab) through the level service's station parts, when present.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import * as THREE from 'three/webgpu';
import type { ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import type { MetaRecipe, MetaUpgrade, MetaWorkbench } from '@dead-air/shared/messages/meta.ts';
import { ITEM_DEFS } from '@dead-air/shared/interactables.ts';
import { MATERIAL_LABEL, MATERIAL_TYPES, POOL_STACK } from '@dead-air/shared/catalog.ts';
import type { MaterialType } from '@dead-air/shared/catalog.ts';
import { normalOfYaw } from '@dead-air/shared/procgen/common.ts';
import { stationOf } from '@dead-air/shared/procgen/van.ts';
import type { LevelService } from '../level/index.ts';
import type { LevelServiceV12 } from '../level/api.ts';
import { metaOf, sfx, useWorldV } from './state.ts';
import { closeScreen } from './nav.ts';

type Tab = 'craft' | 'upgrades' | 'locker';
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'craft', label: 'Craft', title: 'Workbench' },
  { id: 'upgrades', label: 'Upgrades', title: 'Van upgrades' },
  { id: 'locker', label: 'Locker', title: 'Crew locker' },
];
const isTab = (v: unknown): v is Tab => v === 'craft' || v === 'upgrades' || v === 'locker';
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- art (inline SVG, Company-issue palette)

const MAT_COLOR: Record<MaterialType, string> = {
  'mat.scrap': '#9a9fa3', 'mat.wiring': '#d0773a', 'mat.chem': '#d9d24c', 'mat.optics': '#8fd3ff', 'mat.cells': '#6fe06a', 'mat.relic': '#b48cff',
};
const MAT_NOTE: Record<MaterialType, string> = {
  'mat.scrap': 'brackets, plates, bolts', 'mat.wiring': 'copper, cable, boards', 'mat.chem': 'reagents, fuel, glue',
  'mat.optics': 'lenses, glass, mirrors', 'mat.cells': 'batteries, capacitors', 'mat.relic': 'it hums when nobody looks',
};

function MatIcon({ m, size = 28 }: { m: string; size?: number }) {
  const c = MAT_COLOR[m as MaterialType] ?? '#888';
  const s = { width: size, height: size };
  switch (m) {
    case 'mat.scrap':
      return <svg {...s} viewBox="0 0 40 40"><path d="M6 30 L10 9 L31 6 L35 27 L22 33 Z" fill="#40464a" stroke={c} stroke-width="1.8" stroke-linejoin="round" /><path d="M10 9 L22 33" stroke="#24282a" stroke-width="1.4" /><circle cx="14" cy="14" r="1.7" fill="#d5d9dc" /><circle cx="28" cy="11" r="1.7" fill="#d5d9dc" /><circle cx="30" cy="24" r="1.7" fill="#d5d9dc" /><path d="M23 17 l4.5 2 -1 4.5 -4.5 -2 z" fill="#6b7175" /></svg>;
    case 'mat.wiring':
      return <svg {...s} viewBox="0 0 40 40"><g fill="none" stroke-linecap="round"><ellipse cx="19" cy="20" rx="12.5" ry="8.5" stroke={c} stroke-width="2.6" /><ellipse cx="19" cy="20" rx="8" ry="5" stroke="#eba06a" stroke-width="2" /><ellipse cx="19" cy="20" rx="3.6" ry="2.2" stroke="#f3c08f" stroke-width="1.6" /><path d="M31 21 C36 25 34 32 27 33.5" stroke={c} stroke-width="2.4" /></g><path d="M26.5 33.5 l5.5 -0.8" stroke="#f6dcb4" stroke-width="2.2" stroke-linecap="round" /></svg>;
    case 'mat.chem':
      return <svg {...s} viewBox="0 0 40 40"><path d="M16 6 h8 v9.5 l9 16 a3 3 0 0 1 -2.7 4.5 h-20.6 a3 3 0 0 1 -2.7 -4.5 l9 -16 z" fill="#171b1d" stroke={c} stroke-width="1.8" stroke-linejoin="round" /><path d="M11.6 25 h16.8 l3.7 6.6 a2 2 0 0 1 -1.8 3 h-20.6 a2 2 0 0 1 -1.8 -3 z" fill={c} opacity="0.88" /><circle cx="18" cy="29.5" r="1.5" fill="#fffbd6" /><circle cx="23.5" cy="31.5" r="1" fill="#fffbd6" /><path d="M14.5 6 h11" stroke={c} stroke-width="2.6" stroke-linecap="round" /></svg>;
    case 'mat.optics':
      return <svg {...s} viewBox="0 0 40 40"><circle cx="20" cy="20" r="13.5" fill="#0c171e" stroke={c} stroke-width="2.2" /><circle cx="20" cy="20" r="8.5" fill="#15303f" stroke="#5aa7d0" stroke-width="1.3" /><path d="M13.5 15.5 a8 8 0 0 1 8 -4.5" stroke="#eefaff" stroke-width="2.2" fill="none" stroke-linecap="round" /><circle cx="20" cy="20" r="2.6" fill={c} opacity="0.65" /></svg>;
    case 'mat.cells':
      return <svg {...s} viewBox="0 0 40 40"><rect x="12" y="8.5" width="16" height="27" rx="2.6" fill="#122012" stroke={c} stroke-width="1.8" /><rect x="16" y="5" width="8" height="4.5" rx="1.1" fill={c} /><rect x="14.6" y="21" width="10.8" height="12" rx="1.2" fill={c} opacity="0.88" /><path d="M20 12 v6.5 M16.8 15.2 h6.4" stroke="#c2f7be" stroke-width="1.8" /></svg>;
    case 'mat.relic':
      return <svg {...s} viewBox="0 0 40 40"><path d="M20 4 L36.5 33.5 H3.5 Z" fill="#191124" stroke={c} stroke-width="1.8" stroke-linejoin="round" /><path d="M10.5 24.5 Q20 15 29.5 24.5 Q20 33 10.5 24.5 Z" fill="#2a1d40" stroke="#dccbff" stroke-width="1.3" /><circle cx="20" cy="24.5" r="3.2" fill={c} style={{ filter: `drop-shadow(0 0 3px ${c})` }} /></svg>;
    default:
      return <svg {...s} viewBox="0 0 40 40"><rect x="8" y="8" width="24" height="24" fill="none" stroke={c} stroke-width="2" /></svg>;
  }
}

const W = (size: number) => ({ width: size, height: size, viewBox: '0 0 64 64' });

function ItemArt({ type, size = 52 }: { type: string; size?: number }) {
  const s = W(size);
  switch (type) {
    case 'battery':
      return <svg {...s}>{[15, 35].map((x, i) => <g key={x} transform={`rotate(${i ? 9 : -9} ${x + 7} 36)`}><rect x={x} y="17" width="14" height="36" rx="3" fill="#162416" stroke="#6fe06a" stroke-width="2" /><rect x={x + 4} y="12.5" width="6" height="5" rx="1" fill="#cde9ca" /><rect x={x + 2.5} y="31" width="9" height="19" rx="1.6" fill="#6fe06a" opacity="0.88" /><path d={`M${x + 7} 21 v6.5 M${x + 3.8} 24.2 h6.4`} stroke="#d9f7d6" stroke-width="2" /></g>)}</svg>;
    case 'lockpick':
      return <svg {...s}><path d="M12 50 L41 21 Q44.5 17.5 47.5 20.5 L51 16" fill="none" stroke="#d5d9dc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><rect x="5" y="46" width="15" height="8.5" rx="2" transform="rotate(-45 12.5 50)" fill="#33393d" stroke="#9a9fa3" stroke-width="1.4" /><path d="M20 56 L50 40 L54 45" fill="none" stroke="#f0b43c" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" /><path d="M16 54 L46 24" stroke="#5d6366" stroke-width="1.2" /></svg>;
    case 'soles':
      return <svg {...s}><path d="M7 41 Q9 23 24 21 L34 21 Q38.5 30 50 33 Q58.5 35.5 57.5 44 L56.5 48 H8 Z" fill="#24313a" stroke="#8fb3c7" stroke-width="2" stroke-linejoin="round" /><path d="M8 49 H57" stroke="#0a0e10" stroke-width="5" />{[13, 21, 29, 37, 45].map((x) => <rect key={x} x={x} y="49.5" width="4.5" height="4.5" fill="#5b7584" />)}<path d="M22 27 Q30 32.5 45 35" stroke="#5b7584" stroke-width="1.6" fill="none" /><path d="M11 38 Q20 35 28 36" stroke="#3d5260" stroke-width="1.4" fill="none" /></svg>;
    case 'glowstick':
      return <svg {...s}>{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={10 + i * 9} y={14 + (i % 2) * 6} width="5" height="34" rx="2.5" fill={['#9dff6b', '#7dfcff', '#ff7df3', '#ffd84d', '#9dff6b'][i]} style={{ filter: 'drop-shadow(0 0 4px currentColor)' }} />)}</svg>;
    case 'flare':
      return <svg {...s}>{[0, 1, 2].map((i) => <g key={i} transform={`rotate(${-20 + i * 20} 32 54)`}><rect x="28" y="20" width="8" height="32" rx="2" fill="#8e1f17" stroke="#ff3b2f" stroke-width="1.5" /><circle cx="32" cy="17" r="4" fill="#ffb199" style={{ filter: 'drop-shadow(0 0 5px #ff3b2f)' }} /></g>)}</svg>;
    case 'medkit':
      return <svg {...s}><rect x="10" y="18" width="44" height="32" rx="3" fill="#ecf0f1" /><rect x="24" y="12" width="16" height="8" fill="none" stroke="#ecf0f1" stroke-width="3" /><rect x="28" y="24" width="8" height="20" fill="#c0392b" /><rect x="22" y="30" width="20" height="8" fill="#c0392b" /></svg>;
    case 'sensor':
      return <svg {...s}><path d="M12 32 A20 20 0 0 1 52 32" fill="none" stroke="#62e0c4" stroke-width="2" opacity="0.45" /><path d="M20 35 A12 12 0 0 1 44 35" fill="none" stroke="#62e0c4" stroke-width="2" opacity="0.8" /><rect x="20" y="40" width="24" height="13" rx="4" fill="#1d2326" stroke="#62e0c4" stroke-width="2" /><circle cx="32" cy="46.5" r="3" fill="#62e0c4" style={{ filter: 'drop-shadow(0 0 4px #62e0c4)' }} /></svg>;
    case 'crowbar':
      return <svg {...s}><path d="M14 52 L46 14 Q50 9 55 13" fill="none" stroke="#c0392b" stroke-width="5" stroke-linecap="round" /><path d="M14 52 L9 49" stroke="#c0392b" stroke-width="5" stroke-linecap="round" /></svg>;
    case 'walkie':
      return <svg {...s}><rect x="22" y="14" width="22" height="42" rx="3" fill="#1d2326" stroke="#f0b43c" stroke-width="2" /><rect x="38" y="3" width="4" height="13" fill="#f0b43c" /><rect x="26" y="20" width="14" height="10" fill="#0b0f10" stroke="#5f8f65" /><circle cx="33" cy="42" r="6" fill="none" stroke="#7c7f7a" stroke-width="2" /><circle cx="27" cy="18" r="1.6" fill="#ff4d4d" /></svg>;
    case 'flashlight_pro':
      return <svg {...s}><path d="M31 25 L61 11 L61 53 L31 39 Z" fill="#bfe3ff" opacity="0.2" /><rect x="5" y="26" width="19" height="12" rx="2" fill="#1d2326" stroke="#bfe3ff" stroke-width="2" /><path d="M24 23 L32 21 L32 43 L24 41 Z" fill="#2a3236" stroke="#bfe3ff" stroke-width="2" /><circle cx="14" cy="32" r="2" fill="#7dfcff" /></svg>;
    case 'lure':
      return <svg {...s}><rect x="13" y="26" width="25" height="23" rx="3" fill="#2b2418" stroke="#f0b43c" stroke-width="2" /><path d="M25.5 26 v-8 M21 17 h9" stroke="#d5d9dc" stroke-width="2.6" stroke-linecap="round" /><circle cx="25.5" cy="37.5" r="4.5" fill="none" stroke="#f0b43c" stroke-width="1.8" /><path d="M44 28 q5 9.5 0 19 M50 23 q8.5 14 0 29" fill="none" stroke="#f0b43c" stroke-width="2.2" stroke-linecap="round" opacity="0.8" /></svg>;
    case 'masterkey':
      return <svg {...s}><g transform="rotate(-9 32 32)"><rect x="9" y="16" width="46" height="31" rx="4" fill="#33280e" stroke="#f2c230" stroke-width="2" /><rect x="15" y="23" width="12" height="10" rx="1.6" fill="#f2c230" /><path d="M15 28 h12 M21 23 v10" stroke="#33280e" stroke-width="1.1" /><path d="M32 24 h17 M32 29.5 h12 M32 35 h15" stroke="#c9a227" stroke-width="2.2" stroke-linecap="round" /><rect x="9" y="40" width="46" height="3.4" fill="#f2c230" opacity="0.55" /></g><g fill="#f2c230">{[0, 1, 2].map((i) => <circle key={i} cx={41 + i * 6} cy="55" r="2.2" style={{ filter: 'drop-shadow(0 0 3px #f2c230)' }} />)}</g></svg>;
    case 'nvg':
      return <svg {...s}><path d="M7 31 h50" stroke="#3a3f44" stroke-width="4" stroke-linecap="round" /><rect x="9" y="22" width="21" height="20" rx="5" fill="#1d2326" stroke="#7c8286" stroke-width="2" /><rect x="34" y="22" width="21" height="20" rx="5" fill="#1d2326" stroke="#7c8286" stroke-width="2" /><circle cx="19.5" cy="32" r="6" fill="#39ff6a" opacity="0.88" style={{ filter: 'drop-shadow(0 0 5px #39ff6a)' }} /><circle cx="44.5" cy="32" r="6" fill="#39ff6a" opacity="0.88" style={{ filter: 'drop-shadow(0 0 5px #39ff6a)' }} /><rect x="28" y="15" width="8" height="9" rx="1.6" fill="#3a3f44" /></svg>;
    case 'syringe':
      return <svg {...s}><g transform="rotate(-40 32 32)"><rect x="16" y="27" width="28" height="10" rx="2" fill="#2a2412" stroke="#ffd23f" stroke-width="2" /><rect x="18" y="29" width="16" height="6" fill="#ffd23f" opacity="0.85" /><path d="M44 32 h13" stroke="#d5d9dc" stroke-width="1.8" /><path d="M16 32 h-6 M10 26 v12" stroke="#d5d9dc" stroke-width="3" stroke-linecap="round" /></g></svg>;
    case 'charm':
      return <svg {...s}>{[0, 90, 180, 270].map((r) => <path key={r} d="M32 31 C24 25 22 15 28 13 C31 12 32 15 32 17 C32 15 33 12 36 13 C42 15 40 25 32 31 Z" fill="#6fdc6a" opacity="0.9" transform={`rotate(${r} 32 31)`} />)}<path d="M32 31 Q37 44 30 55" stroke="#3b6a31" stroke-width="2.6" fill="none" stroke-linecap="round" /></svg>;
    case 'flashbulb':
      return <svg {...s}><g stroke="#fff6c8" stroke-width="2" stroke-linecap="round" opacity="0.85">{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <path key={a} d="M32 6 v6" transform={`rotate(${a} 32 27)`} />)}</g><circle cx="32" cy="27" r="10" fill="#fff9d8" style={{ filter: 'drop-shadow(0 0 8px #fff2a8)' }} /><rect x="26" y="37" width="12" height="13" rx="2" fill="#3a3f44" stroke="#d5d9dc" stroke-width="1.5" /><path d="M26 41.5 h12 M26 45.5 h12" stroke="#7c8286" /></svg>;
    case 'receiver':
      return <svg {...s}><rect x="11" y="26" width="35" height="27" rx="3" fill="#1d2326" stroke="#62e0c4" stroke-width="2" /><path d="M40 26 L50 8" stroke="#d5d9dc" stroke-width="2.2" stroke-linecap="round" /><circle cx="50" cy="8" r="2.2" fill="#62e0c4" /><rect x="16" y="31" width="17" height="9" fill="#0b1513" stroke="#2f6b5c" /><path d="M18 36.5 l3 -3 3 4 3 -5 3 4" stroke="#62e0c4" stroke-width="1.4" fill="none" /><circle cx="39" cy="45" r="4.2" fill="none" stroke="#7c8286" stroke-width="2" /><path d="M54 18 q4 4 0 8 M57.5 14.5 q7.5 7.5 0 15" stroke="#62e0c4" stroke-width="1.8" fill="none" opacity="0.7" /></svg>;
    case 'bottle':
      return <svg {...s}>{[12, 28, 44].map((x, i) => <g key={x}><rect x={x} y={26 - i * 2} width="10" height={30 + i * 2} rx="3" fill="#27ae60" opacity="0.65" stroke="#9dff6b" stroke-width="1" /><rect x={x + 3} y={14 - i * 2} width="4" height="13" fill="#27ae60" opacity="0.8" /></g>)}</svg>;
    default: {
      const d = ITEM_DEFS[type];
      return <svg {...s}><rect x="12" y="16" width="40" height="34" rx="3" fill="#1d2326" stroke={d?.color ?? '#7c8286'} stroke-width="2" /><path d="M12 26 h40" stroke={d?.color ?? '#7c8286'} stroke-width="1.4" opacity="0.6" /><text x="32" y="43" text-anchor="middle" font-size="12" font-family="monospace" font-weight="700" fill={d?.color ?? '#c9cdd0'}>{d?.short ?? '?'}</text></svg>;
    }
  }
}

function UpgradeArt({ id, size = 84 }: { id: string; size?: number }) {
  const s = W(size);
  switch (id) {
    case 'bench_tools':
      return <svg {...s}><rect x="5" y="44" width="31" height="13" rx="2" fill="#1d2326" stroke="#9a9fa3" stroke-width="2" /><circle cx="13" cy="50.5" r="3.2" fill="#f0b43c" /><rect x="21" y="48.5" width="11" height="4.5" fill="#0b0f10" stroke="#d23b2e" /><path d="M36 50 Q46 52 47.5 41" stroke="#3a3f44" stroke-width="2.2" fill="none" /><g transform="rotate(-35 46 26)"><rect x="40" y="18" width="10" height="21" rx="3" fill="#2a3236" stroke="#9a9fa3" stroke-width="1.6" /><rect x="43" y="6" width="4" height="13" fill="#d5d9dc" /><path d="M45 1.5 v5.5" stroke="#ff8a3c" stroke-width="3.2" stroke-linecap="round" style={{ filter: 'drop-shadow(0 0 4px #ff8a3c)' }} /></g><circle cx="53" cy="52" r="7" fill="none" stroke="#d0773a" stroke-width="3" /><circle cx="53" cy="52" r="2" fill="#d0773a" /></svg>;
    case 'charging_rack':
      return <svg {...s}><rect x="5" y="38" width="54" height="17" rx="2" fill="#1d2326" stroke="#9a9fa3" stroke-width="2" />{[13, 25, 37, 49].map((x) => <g key={x}><rect x={x - 4} y="14" width="8" height="26" rx="2" fill="#2a3236" stroke="#bfe3ff" stroke-width="1.4" /><rect x={x - 5} y="9.5" width="10" height="6" rx="1.5" fill="#3a3f44" stroke="#bfe3ff" stroke-width="1" /><circle cx={x} cy="47" r="2.4" fill="#6fe06a" style={{ filter: 'drop-shadow(0 0 3px #6fe06a)' }} /></g>)}</svg>;
    case 'scanner':
      return <svg {...s}><path d="M13 55 h38" stroke="#9a9fa3" stroke-width="3.2" stroke-linecap="round" /><path d="M32 55 V34" stroke="#9a9fa3" stroke-width="3" /><path d="M17 30 Q32 45 47 30 Z" fill="#2a3236" stroke="#d5d9dc" stroke-width="2" transform="rotate(-25 32 34)" /><circle cx="36.5" cy="21.5" r="2.6" fill="#62e0c4" style={{ filter: 'drop-shadow(0 0 4px #62e0c4)' }} /><path d="M42 15 q6.5 4.5 4 13 M46.5 9 q11.5 7.5 7 23" stroke="#62e0c4" stroke-width="2.2" fill="none" stroke-linecap="round" opacity="0.85" /></svg>;
    case 'stretcher':
      return <svg {...s}><path d="M5 20 h54 M5 44 h54" stroke="#9a9fa3" stroke-width="3.2" stroke-linecap="round" /><rect x="11" y="22" width="42" height="20" fill="#4f2420" stroke="#d23b2e" stroke-width="1.6" /><rect x="29" y="25" width="6" height="14" fill="#ecf0f1" /><rect x="25" y="29" width="14" height="6" fill="#ecf0f1" /><path d="M11 22 v20 M53 22 v20" stroke="#3a3f44" stroke-width="2" /></svg>;
    default:
      return <ItemArt type={id} size={size} />;
  }
}

// ---------------------------------------------------------------- van parts (SHOULD: locker door, bench lamp)

type LevelLike = Partial<LevelService> & Partial<LevelServiceV12>;
const levelOf = (ctx: ClientContext): LevelLike | undefined => ctx.services.use('level') as LevelLike | undefined;

function stationPart(ctx: ClientContext, kind: 'stash' | 'workbench', part: string): THREE.Object3D | null {
  try {
    return levelOf(ctx)?.stationObject?.(kind)?.getObjectByName(part) ?? null;
  } catch {
    return null;
  }
}

/** swing the crew-locker door open / shut. The level's hinged 'door' pivot exposes userData.setOpen(t 0..1) (and
 *  openAngle); without it, rotate about the pivot in the direction that moves the leaf into the van. */
function swingStashDoor(ctx: ClientContext, open: boolean): void {
  const door = stationPart(ctx, 'stash', 'door');
  if (!door) return;
  const ud = door.userData as { wbBase?: number; wbSign?: number; wbRaf?: number; wbT?: number; setOpen?: (t: number) => void };
  if (typeof ud.setOpen === 'function') {
    const setOpen = ud.setOpen;
    const from = ud.wbT ?? 0, to = open ? 1 : 0;
    if (from === to && !ud.wbRaf) return;
    if (ud.wbRaf) cancelAnimationFrame(ud.wbRaf);
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 420);
      ud.wbT = from + (to - from) * (1 - Math.pow(1 - k, 3));
      try { setOpen(ud.wbT); } catch { /* level rebuilt under us */ }
      ud.wbRaf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    ud.wbRaf = requestAnimationFrame(step);
    return;
  }
  ud.wbBase ??= door.rotation.y;
  if (ud.wbSign === undefined) {
    const L = ctx.world.layout;
    const st = L ? stationOf(L, 'stash') : null;
    const [nx, nz] = normalOfYaw(st?.rot ?? 0);
    const c = new THREE.Vector3();
    const reach = (sign: number) => {
      door.rotation.y = ud.wbBase! + sign * 1.2;
      door.updateMatrixWorld(true);
      new THREE.Box3().setFromObject(door).getCenter(c);
      return c.x * nx + c.z * nz;
    };
    const plus = reach(1), minus = reach(-1);
    door.rotation.y = ud.wbBase;
    ud.wbSign = plus >= minus ? 1 : -1;
  }
  const from = door.rotation.y;
  const to = ud.wbBase + (open ? ud.wbSign * 1.75 : 0);
  if (ud.wbRaf) cancelAnimationFrame(ud.wbRaf);
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 420);
    const e = 1 - Math.pow(1 - k, 3);
    door.rotation.y = from + (to - from) * e;
    ud.wbRaf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  ud.wbRaf = requestAnimationFrame(step);
}

type Glowable = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number; userData: Record<string, unknown> };
const WARM = new THREE.Color('#ffc45c');

/** bench lamp: brighter while crafting (uniform values only: no new pipelines) */
function lightBenchLamp(ctx: ClientContext, level: number): void {
  const lamp = stationPart(ctx, 'workbench', 'lamp');
  if (!lamp) return;
  lamp.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of (Array.isArray(mats) ? mats : mats ? [mats] : []) as Glowable[]) {
      if (!m.emissive || typeof m.emissiveIntensity !== 'number') continue;
      const ud = m.userData as { wbI?: number; wbC?: number };
      ud.wbI ??= m.emissiveIntensity;
      ud.wbC ??= m.emissive.getHex();
      if (level <= 0) {
        m.emissiveIntensity = ud.wbI;
        m.emissive.setHex(ud.wbC);
      } else {
        if (ud.wbC === 0) m.emissive.copy(WARM);
        m.emissiveIntensity = Math.max(ud.wbI, 1) * (1 + 1.6 * level);
      }
    }
  });
}

// ---------------------------------------------------------------- pieces

const matName = (m: string): string => MATERIAL_LABEL[m as MaterialType] ?? m;
const itemName = (t: string): string => ITEM_DEFS[t]?.name ?? t;

function CostChips({ cost, stash, scrip, balance }: { cost: Record<string, number>; stash: Record<string, number>; scrip?: number; balance?: number }) {
  return (
    <div class="wb-cost">
      {scrip ? <span class={`wb-c scrip ${balance !== undefined && balance < scrip ? 'no' : ''}`}><b>{scrip}</b> SCRIP</span> : null}
      {Object.entries(cost).map(([m, n]) => {
        const have = stash[m] ?? 0;
        return (
          <span key={m} class={`wb-c ${have >= n ? 'ok' : 'no'}`} title={`${matName(m)}: ${have} in the stash`}>
            <MatIcon m={m} size={16} />
            <span><b>{have}</b>/{n}</span>
          </span>
        );
      })}
    </div>
  );
}

function canAfford(cost: Record<string, number>, stash: Record<string, number>): boolean {
  return Object.entries(cost).every(([m, n]) => (stash[m] ?? 0) >= n);
}

function RecipeCard({ r, stash, balance, busy, deny, done, onCraft }: {
  r: MetaRecipe; stash: Record<string, number>; balance: number; busy: boolean; deny?: string; done: boolean; onCraft: () => void;
}) {
  const afford = canAfford(r.cost, stash) && (r.scrip ?? 0) <= balance;
  const cls = r.locked ? 'locked' : afford ? 'can' : 'short';
  return (
    <div class={`m-sheet wb-card ${cls} ${done ? 'done' : ''}`} data-recipe={r.id}>
      <div class="wb-card-top">
        <div class="wb-art"><ItemArt type={r.out} /></div>
        <div class="nm">{r.name}<small>TIER {r.tier === 2 ? 'II' : 'I'} · {itemName(r.out).toUpperCase()}</small></div>
      </div>
      <div class="desc">{r.desc}</div>
      <CostChips cost={r.cost} stash={stash} scrip={r.scrip} balance={balance} />
      <div class="wb-foot">
        {deny ? <span class="wb-deny">{deny}</span>
          : r.shopPrice ? <span class="wb-shop save">SAVES <b>{r.shopPrice}</b> SCRIP<br />VS THE COMPANY STORE</span>
          : <span class="wb-shop">NOT IN THE<br />COMPANY STORE</span>}
        <button class="m-btn small primary" disabled={busy || !!r.locked || !afford} onClick={onCraft}>{busy ? '…' : afford || r.locked ? 'CRAFT' : 'NEED PARTS'}</button>
      </div>
      {r.locked && <div class="m-lock">LOCKED<small>{r.locked.toUpperCase()}</small></div>}
    </div>
  );
}

function UpgradeCard({ u, stash, balance, busy, deny, onBuy }: { u: MetaUpgrade; stash: Record<string, number>; balance: number; busy: boolean; deny?: string; onBuy: () => void }) {
  const afford = canAfford(u.cost, stash) && balance >= u.scrip;
  return (
    <div class={`m-sheet wb-up ${u.owned ? 'owned' : 'accent'}`} data-upgrade={u.id}>
      <div class="wb-art"><UpgradeArt id={u.id} /></div>
      <div>
        <div class="nm">{u.name}</div>
        <div class="desc">{u.desc}</div>
        {!u.owned && <CostChips cost={u.cost} stash={stash} scrip={u.scrip} balance={balance} />}
        <div class="wb-foot">
          {u.owned ? <span class="wb-tick">INSTALLED ✓</span> : deny ? <span class="wb-deny">{deny}</span> : <span class="wb-shop">INSTALLED IN THE VAN<br />FOR THE WHOLE CREW</span>}
          {!u.owned && <button class="m-btn small primary" disabled={busy || !afford} onClick={onBuy}>{busy ? '…' : afford ? 'BUY' : 'CAN’T AFFORD'}</button>}
        </div>
      </div>
    </div>
  );
}

/** the player's hand-out order: saved loadout first (only types they own), then the rest of their pool */
function orderOf(b: MetaWorkbench): string[] {
  const owned = Object.keys(b.pool).filter((t) => (b.pool[t] ?? 0) > 0);
  const head = b.loadout.filter((t) => owned.includes(t));
  return [...head, ...owned.filter((t) => !head.includes(t))];
}

// ---------------------------------------------------------------- screen

export function WorkbenchScreen({ ctx, tab: tab0 }: ScreenProps) {
  useWorldV(ctx);
  const [tab, setTab] = useState<Tab>(isTab(tab0) ? tab0 : 'craft');
  const [bench, setBench] = useState<MetaWorkbench | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'deny' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [deny, setDeny] = useState<Record<string, string>>({});
  const [done, setDone] = useState('');
  const [flash, setFlash] = useState(0);
  const [bumped, setBumped] = useState<string[]>([]);
  const prevStash = useRef<Record<string, number>>({});

  useEffect(() => { if (isTab(tab0)) setTab(tab0); }, [tab0]);

  const load = useCallback(() => {
    void ctx.net.req('meta.workbench', {}).then((b) => {
      setBench(b);
      setLoadErr(null);
    }).catch((e: unknown) => setLoadErr(msgOf(e)));
  }, [ctx]);
  useEffect(() => { load(); }, [load]);
  // the stash changes under us (a crewmate crafts, the contract commits): refetch
  useEffect(() => ctx.net.on('meta.stash', () => load()), [ctx, load]);

  // Esc closes (meta's own Esc handler covers it too once 'workbench' is a META_SCREEN; both are idempotent)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ctx.ui.screen.value.name !== 'workbench') return;
      e.preventDefault();
      closeScreen(ctx);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [ctx]);
  // the bench only works in the hub: close when the van leaves
  const phase = ctx.world.phase;
  useEffect(() => { if (phase !== 'hub') closeScreen(ctx); }, [ctx, phase]);
  // full-screen: hide the HUD layer (meta does this for its META_SCREENS; harmless when it already did)
  useEffect(() => {
    ctx.ui.hudVisible.value = false;
    return () => { if (ctx.ui.screen.value.name === 'none') ctx.ui.hudVisible.value = true; };
  }, [ctx]);

  // van parts: lamp lit while crafting, locker door open on the locker tab
  useEffect(() => {
    lightBenchLamp(ctx, tab === 'craft' ? 1 : 0.35);
    swingStashDoor(ctx, tab === 'locker');
  }, [ctx, tab]);
  useEffect(() => () => {
    lightBenchLamp(ctx, 0);
    swingStashDoor(ctx, false);
  }, [ctx]);
  useEffect(() => {
    if (!flash) return;
    lightBenchLamp(ctx, 2.2);
    const t = setTimeout(() => lightBenchLamp(ctx, tab === 'craft' ? 1 : 0.35), 380);
    return () => clearTimeout(t);
  }, [ctx, flash, tab]);

  // highlight stash counts that changed
  useEffect(() => {
    if (!bench) return;
    const changed = MATERIAL_TYPES.filter((m) => (bench.stash[m] ?? 0) !== (prevStash.current[m] ?? 0));
    prevStash.current = { ...bench.stash };
    if (!changed.length) return;
    setBumped(changed);
    const t = setTimeout(() => setBumped([]), 700);
    return () => clearTimeout(t);
  }, [bench]);

  const meta = metaOf(ctx);
  const balance = meta?.shift.balance ?? bench?.balance ?? 0;
  const stash = bench?.stash ?? {};

  const craft = (r: MetaRecipe) => {
    setBusy(r.id);
    void ctx.net.req('meta.craft', { recipe: r.id }).then((res) => {
      setBench(res.bench);
      if (res.ok) {
        setDeny((d) => ({ ...d, [r.id]: '' }));
        setMsg({ kind: 'ok', text: `${r.name} → your locker. Handed out when the van reaches the site.` });
        setDone(r.id);
        setTimeout(() => setDone((x) => (x === r.id ? '' : x)), 900);
        setFlash((n) => n + 1);
        sfx(ctx, 'sfx.ui_confirm');
      } else {
        setDeny((d) => ({ ...d, [r.id]: res.reason ?? 'Refused' }));
        setMsg({ kind: 'deny', text: res.reason ?? 'Refused' });
      }
    }).catch((e: unknown) => setMsg({ kind: 'deny', text: msgOf(e) })).finally(() => setBusy(''));
  };

  const buy = (u: MetaUpgrade) => {
    setBusy(u.id);
    void ctx.net.req('meta.upgrade', { id: u.id }).then((res) => {
      setBench(res.bench);
      if (res.ok) {
        setDeny((d) => ({ ...d, [u.id]: '' }));
        setMsg({ kind: 'ok', text: `${u.name} installed in the van.` });
        setFlash((n) => n + 1);
        sfx(ctx, 'sfx.ui_confirm');
      } else {
        setDeny((d) => ({ ...d, [u.id]: res.reason ?? 'Refused' }));
        setMsg({ kind: 'deny', text: res.reason ?? 'Refused' });
      }
    }).catch((e: unknown) => setMsg({ kind: 'deny', text: msgOf(e) })).finally(() => setBusy(''));
  };

  const move = (order: string[], i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (!bench || j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    const prev = bench.loadout;
    setBench({ ...bench, loadout: next });
    void ctx.net.req('meta.loadout', { order: next }).then((r) => {
      if (r.ok) setBench((b) => (b ? { ...b, loadout: r.loadout } : b));
      else {
        setBench((b) => (b ? { ...b, loadout: prev } : b));
        setMsg({ kind: 'deny', text: r.reason ?? 'Hand-out order refused' });
      }
    }).catch((e: unknown) => {
      setBench((b) => (b ? { ...b, loadout: prev } : b));
      setMsg({ kind: 'deny', text: `Hand-out order unavailable (${msgOf(e)})` });
    });
  };

  const title = TABS.find((t) => t.id === tab)?.title ?? 'Workbench';
  const owned = bench?.upgrades.filter((u) => u.owned).length ?? 0;
  const tier = (n: 1 | 2) => bench?.recipes.filter((r) => r.tier === n) ?? [];

  return (
    <div class="m-screen wb-screen">
      <div class="wb-peg" />
      <div class={`wb-lamp ${flash ? 'flash' : ''}`} key={`lamp${flash}`} />
      <button class="m-close" onClick={() => closeScreen(ctx)}>CLOSE [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">COMPANY WORKBENCH · VAN 9 · PROPERTY OF THE COMPANY</div>
            <h1 class="m-h1">{title}</h1>
          </div>
          <div class="wb-head-right">
            <div>
              <div class="m-label">VAN UPGRADES</div>
              <div class="wb-ticks">{(bench?.upgrades ?? []).map((u) => <i key={u.id} class={u.owned ? 'on' : ''} title={u.name} />)}<span class="m-small m-dim" style={{ marginLeft: '6px' }}>{owned}/{bench?.upgrades.length ?? 4}</span></div>
            </div>
            <div>
              <div class="m-label">SPENDABLE SCRIP</div>
              <div class="m-num m-amber">{balance}</div>
            </div>
          </div>
        </div>

        <div class="wb-tabs">
          {TABS.map((t) => (
            <button key={t.id} class={`wb-tab ${tab === t.id ? 'on' : ''}`} data-tab={t.id} onClick={() => { setTab(t.id); setMsg(null); }}>
              {t.label}
              {t.id === 'upgrades' && bench ? <small>{owned}/{bench.upgrades.length}</small> : null}
              {t.id === 'locker' && bench ? <small>{bench.poolSlots}/{bench.maxPoolSlots}</small> : null}
            </button>
          ))}
        </div>

        <div class={`wb-msg ${loadErr ? 'deny' : msg?.kind ?? 'info'}`}>{loadErr ?? msg?.text ?? ''}</div>

        {!bench ? (
          <div class="m-sheet m-dim" style={{ maxWidth: '520px' }}>{loadErr ? 'The workbench is out of reach. Stand at the bench in the van.' : 'Opening the toolbox…'}</div>
        ) : tab === 'craft' ? (
          <div class="wb-craft">
            <aside class="m-sheet accent wb-stash">
              <div class="m-label">CREW STASH</div>
              {MATERIAL_TYPES.map((m) => (
                <div key={m} class={`wb-mat ${(stash[m] ?? 0) ? '' : 'zero'} ${bumped.includes(m) ? 'bump' : ''}`} data-mat={m}>
                  <div class="wb-ico"><MatIcon m={m} size={30} /></div>
                  <div class="nm" style={{ color: MAT_COLOR[m] }}>{MATERIAL_LABEL[m]}<small>{MAT_NOTE[m]}</small></div>
                  <div class="n">{stash[m] ?? 0}</div>
                </div>
              ))}
              <div class="wb-hint">
                <b>On a contract:</b> hold <span class="m-keys">E</span> at this bench to scrap the salvage in your hand. The parts reach the stash when the van gets home; a wiped crew loses them. Scrapped salvage no longer counts toward the quota.
              </div>
            </aside>
            <section>
              <div class="wb-tier"><h3><i>I</i>Standard issue</h3><span>crafted gear goes to your locker</span></div>
              <div class="wb-recipes">
                {tier(1).map((r) => <RecipeCard key={r.id} r={r} stash={stash} balance={balance} busy={busy === r.id} deny={deny[r.id]} done={done === r.id} onCraft={() => craft(r)} />)}
              </div>
              {tier(2).length > 0 && (
                <>
                  <div class="wb-tier t2"><h3><i>II</i>Specialist</h3><span>{tier(2)[0].locked ? tier(2)[0].locked : 'soldering station installed'}</span></div>
                  <div class="wb-recipes">
                    {tier(2).map((r) => <RecipeCard key={r.id} r={r} stash={stash} balance={balance} busy={busy === r.id} deny={deny[r.id]} done={done === r.id} onCraft={() => craft(r)} />)}
                  </div>
                </>
              )}
            </section>
          </div>
        ) : tab === 'upgrades' ? (
          <div class="wb-ups">
            {bench.upgrades.map((u) => <UpgradeCard key={u.id} u={u} stash={stash} balance={balance} busy={busy === u.id} deny={deny[u.id]} onBuy={() => buy(u)} />)}
          </div>
        ) : (
          <Locker bench={bench} onMove={move} />
        )}
      </div>
    </div>
  );
}

function Locker({ bench, onMove }: { bench: MetaWorkbench; onMove: (order: string[], i: number, dir: -1 | 1) => void }) {
  const order = orderOf(bench);
  const slots = Array.from({ length: Math.max(bench.maxPoolSlots, bench.poolSlots) }, (_, i) => i < bench.poolSlots);
  return (
    <div class="wb-locker">
      <div class="m-sheet accent">
        <div class="m-label">YOUR LOCKER</div>
        <div class="wb-slots">{slots.map((on, i) => <i key={i} class={on ? 'on' : ''} />)}</div>
        <div class="wb-slotline"><span>GEAR POOL</span><span><b>{bench.poolSlots}</b> / {bench.maxPoolSlots} SLOTS</span></div>
        {order.length ? order.map((t) => {
          const units = bench.pool[t] ?? 0;
          const stack = POOL_STACK[t] ?? 1;
          const n = Math.ceil(units / stack);
          return (
            <div key={t} class="wb-gear" data-gear={t}>
              <div class="wb-art"><ItemArt type={t} size={40} /></div>
              <div class="nm">{itemName(t)}<small>{stack > 1 ? `${units} unit${units === 1 ? '' : 's'} · ${n} slot${n === 1 ? '' : 's'} (stacks of ${stack})` : `${n} slot${n === 1 ? '' : 's'}`}</small></div>
              <div class="n">×{units}</div>
            </div>
          );
        }) : <div class="wb-empty">Your locker is empty. Craft gear at the bench or buy it at the Company store: it waits here until the van reaches a site.</div>}
      </div>
      <div class="m-sheet">
        <div class="m-label">HAND-OUT ORDER</div>
        <div class="m-small m-dim" style={{ lineHeight: 1.6 }}>When the van reaches the site, your gear is handed out top first until your hands are full. The rest stays in the locker for the next contract.</div>
        {order.length > 1 ? (
          <ol class="wb-order">
            {order.map((t, i) => (
              <li key={t} class={i === 0 ? 'first' : ''} data-order={t}>
                <div class="wb-art"><ItemArt type={t} size={30} /></div>
                <div class="nm">{itemName(t)}</div>
                <div class="wb-arrows">
                  <button class="m-btn small" disabled={i === 0} onClick={() => onMove(order, i, -1)} title="Hand out earlier">▲</button>
                  <button class="m-btn small" disabled={i === order.length - 1} onClick={() => onMove(order, i, 1)} title="Hand out later">▼</button>
                </div>
              </li>
            ))}
          </ol>
        ) : <div class="wb-empty">{order.length ? 'One kind of gear: nothing to order yet.' : 'Nothing to hand out yet.'}</div>}
      </div>
    </div>
  );
}
