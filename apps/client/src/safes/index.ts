// Owner: safes feature (flag 'safes', default off; ?safes=1 forces it on for dev tests). Safe-cracking mini-game client:
// the 'safe' dial screen (dial.tsx), safe props in the scene, and the crew-wide clunk / unlock sounds.
// Server: apps/server/src/safes/index.ts. Request/event names are cast (no messages/safes.ts: index.ts is integrator-owned).
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SafeScreen } from './dial.tsx';

export interface SafeInfo {
  id: string;
  x: number;
  z: number;
  face: [number, number];
  open: boolean;
}

type AnyReq = (r: string, a: unknown, timeoutMs?: number) => Promise<unknown>;
type AnyOn = (e: string, fn: (d: unknown, t: number) => void) => () => void;

export const safeReq = (ctx: ClientContext): AnyReq => ctx.net.req as unknown as AnyReq;

export function install(ctx: ClientContext): void {
  if (ctx.flags.safes !== true && ctx.params.get('safes') !== '1') return;
  ctx.ui.registerScreen('safe', SafeScreen);
  const on = ctx.net.on as unknown as AnyOn;
  const req = safeReq(ctx);
  const props = new Map<string, { root: THREE.Group; door: THREE.Group }>();
  let group: THREE.Group | null = null;

  const play = (key: string, p?: [number, number, number], volume = 0.9) => {
    try { ctx.services.use('sfx')?.play(key, p, p ? { volume } : { ui: true, volume }); } catch { /* optional */ }
  };

  on('safes.open', (d) => {
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    ctx.ui.setScreen('safe', { ...(d as Record<string, unknown>) });
  });
  on('safes.close', () => {
    if (ctx.ui.screen.value.name === 'safe') ctx.ui.setScreen('none');
  });
  on('safes.fx', (d) => {
    const f = d as { id: string; fx: string; p: [number, number, number] };
    if (f.fx === 'clunk') play('sfx.lever_clunk_heavy', f.p, 1);
    if (f.fx === 'open') {
      play('sfx.vault_unlock_heavy', f.p, 1);
      const pr = props.get(f.id);
      if (pr) pr.door.rotation.y = -1.9;
    }
  });

  // ---------------------------------------------------------------- props (simple steel safe with a brass dial)
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x2a2f33, roughness: 0.45, metalness: 0.85 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x15181a, roughness: 0.6, metalness: 0.7 });
  const brass = new THREE.MeshStandardNodeMaterial({ color: 0xb08a3e, roughness: 0.3, metalness: 1 });
  const W = 0.7, H = 0.9, D = 0.6;
  const build = (s: SafeInfo) => {
    const root = new THREE.Group();
    root.position.set(s.x, 0, s.z);
    root.rotation.y = Math.atan2(s.face[0], s.face[1]); // local +z = front
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), steel);
    body.position.y = H / 2 + 0.06;
    const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 0.06, D + 0.04), dark);
    base.position.y = 0.03;
    const inner = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, H - 0.1, 0.02), dark);
    inner.position.set(0, H / 2 + 0.06, D / 2 + 0.002);
    // door hinged on the left edge
    const door = new THREE.Group();
    door.position.set(-W / 2 + 0.04, H / 2 + 0.06, D / 2 + 0.03);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W - 0.08, H - 0.08, 0.05), steel);
    slab.position.x = (W - 0.08) / 2;
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.035, 32), brass);
    dial.rotation.x = Math.PI / 2;
    dial.position.set((W - 0.08) / 2, 0.12, 0.04);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.18, 0.04), brass);
    handle.position.set((W - 0.08) / 2 + 0.2, -0.05, 0.045);
    door.add(slab, dial, handle);
    for (const m of [body, base, inner, slab, dial, handle]) { m.castShadow = true; m.receiveShadow = true; }
    root.add(body, base, inner, door);
    if (s.open) door.rotation.y = -1.9;
    return { root, door };
  };

  const clear = () => {
    for (const pr of props.values()) {
      pr.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
      pr.root.removeFromParent();
    }
    props.clear();
  };

  let gen = 0;
  const refresh = async () => {
    const my = ++gen;
    clear();
    if (ctx.world.phase !== 'contract') return;
    let list: SafeInfo[] = [];
    try {
      list = ((await req('safes.list', {}, 5000)) as { safes?: SafeInfo[] } | undefined)?.safes ?? [];
    } catch { return; }
    if (my !== gen) return;
    const three = ctx.services.use('three');
    if (!three) return;
    if (!group) {
      group = new THREE.Group();
      group.name = 'safes';
    }
    if (!group.parent) three.scene.add(group);
    for (const s of list) {
      const pr = build(s);
      group.add(pr.root);
      props.set(s.id, pr);
    }
  };
  if (ctx.testMode) (window as unknown as { __safes: unknown }).__safes = { count: () => props.size, inScene: () => !!group?.parent, refresh };
  ctx.bus.on('world:phase', () => void refresh());
  ctx.bus.on('net:welcome', () => void refresh());
  if (ctx.net.status === 'joined') void refresh();
}
