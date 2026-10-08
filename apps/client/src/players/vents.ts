// Owner: players-stealth (v1.2, stretch). Client side of the crawl vents (flag crawlVents; server: players/vents.ts):
// - 'players.crawl' for you: movement frozen ('crawl'), the camera inside a cramped duct behind the entry grate that
//   creeps forward until the server's `until`, a dark overlay with the time left (hud.tsx CrawlHud), the vent-crawl
//   scrape; on 'exit' you are teleported to the twin grate, facing out of it
// - for teammates: a grate latch + thump at each end (the server's 4 m / 6 m ductThump noise is for monsters)
// - crawlable grates get a bigger hatch frame (level.setItemObject: a scaled clone of the vent's own visual with a
//   handle, same materials, so no new pipelines)
// The duct idea is copied from the monsters package's Snatcher duct (never edited, never imported).
import * as THREE from 'three/webgpu';
import type { CrawlEvent } from '@dead-air/shared/messages/players.ts';
import type { ClientContext } from '../core/context.ts';
import { ui } from './social.ts';
import type { V3 } from './types.ts';
import { useLoose } from './types.ts';

interface LevelItemsLike {
  itemObject?(id: string): THREE.Object3D | null | undefined;
  setItemObject?(id: string, obj: THREE.Object3D | null): void;
}
interface IxStateLike { state?(): { ints?: Record<string, { kind?: string; ref?: unknown }> } }

export interface CrawlDeps {
  meId(): string | null;
  freeze(on: boolean): void;
  teleport(x: number, z: number, yaw: number): void;
  play(key: string, pos: V3 | undefined, volume: number, rate?: number): void;
}

interface CrawlView {
  /** performance.now() at the start / end */
  t0: number;
  t1: number;
  /** grate front (floor) and the direction into the duct */
  front: THREE.Vector3;
  dir: THREE.Vector3;
}

const DUCT_LEN = 6;

export function createCrawl(ctx: ClientContext, scene: THREE.Scene, deps: CrawlDeps) {
  // ---- the duct (local only): a dark metal box with ribs and a faint warm opening far down ----
  const duct = new THREE.Group();
  duct.name = 'players:duct';
  const wall = new THREE.MeshBasicNodeMaterial({ color: 0x121417, side: THREE.BackSide });
  const rib = new THREE.MeshBasicNodeMaterial({ color: 0x23272c });
  const glow = new THREE.MeshBasicNodeMaterial({ color: 0x3a2a1c });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.52, DUCT_LEN), wall);
  box.position.z = DUCT_LEN / 2;
  duct.add(box);
  const ribGeo = new THREE.BoxGeometry(0.66, 0.025, 0.04);
  const ribSide = new THREE.BoxGeometry(0.025, 0.52, 0.04);
  for (let i = 1; i < DUCT_LEN / 0.6; i++) {
    const z = i * 0.6;
    for (const y of [-0.245, 0.245]) { const m = new THREE.Mesh(ribGeo, rib); m.position.set(0, y, z); duct.add(m); }
    for (const x of [-0.315, 0.315]) { const m = new THREE.Mesh(ribSide, rib); m.position.set(x, 0, z); duct.add(m); }
  }
  const end = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.46), glow);
  end.position.z = DUCT_LEN - 0.02;
  end.rotation.y = Math.PI;
  duct.add(end);
  duct.traverse((o) => { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; });
  duct.visible = false;

  let view: CrawlView | null = null;
  const tmpQ = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  const look = new THREE.Vector3();

  const begin = (d: CrawlEvent, serverT: number) => {
    const now = performance.now();
    const ms = Math.max(500, Math.min(10_000, d.until - serverT));
    // into the duct = the facing the server sent (towards the wall)
    const dir = new THREE.Vector3(Math.sin(d.yaw), 0, Math.cos(d.yaw)).normalize();
    view = { t0: now, t1: now + ms, front: new THREE.Vector3(d.p[0], 0, d.p[2]), dir };
    ui.crawl.value = { until: now + ms, total: ms };
    // the duct starts at the wall, 0.6 m behind the front spot, and runs on into the wall
    duct.position.set(d.p[0] + dir.x * 0.6, 0.33, d.p[2] + dir.z * 0.6);
    duct.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
    if (!duct.parent) scene.add(duct);
    duct.visible = true;
    deps.freeze(true);
    deps.play('sfx.metal_latch', undefined, 0.6);
    deps.play('sfx.listener_vent_crawl', undefined, 0.55, 1.05);
  };
  const finishLocal = (d: CrawlEvent | null) => {
    view = null;
    duct.visible = false;
    ui.crawl.value = null;
    deps.freeze(false);
    if (d) {
      deps.teleport(d.p[0], d.p[2], d.yaw);
      deps.play('sfx.metal_latch', undefined, 0.7, 0.9);
    }
  };

  ctx.net.on('players.crawl', (d, t) => {
    if (!d || !Array.isArray(d.p)) return;
    const mine = d.pid === deps.meId();
    if (d.phase === 'enter') {
      if (mine) begin(d, t);
      else { deps.play('sfx.metal_latch', d.p, 0.7); deps.play('sfx.metal_hit', d.p, 0.35, 0.8); }
    } else if (d.phase === 'exit') {
      if (mine) finishLocal(d);
      else { deps.play('sfx.metal_hit', d.p, 0.55, 0.75); deps.play('sfx.metal_latch', d.p, 0.7); }
    }
  });
  // a new layout (or a reconnect) never leaves you stuck in a duct
  ctx.bus.on('world:phase', () => { if (view) finishLocal(null); });
  ctx.bus.on('net:welcome', () => { if (view) finishLocal(null); });

  // ---- hatch frames on crawlable grates ----
  let hatched = new Map<string, THREE.Object3D>();
  let hatchLayout = '';
  let hatchAt = 0;
  const syncHatches = (now: number) => {
    if (now - hatchAt < 1000) return;
    hatchAt = now;
    const L = ctx.world.layout;
    const lvl = useLoose<LevelItemsLike>(ctx.services, 'level');
    if (!L || !lvl?.itemObject || !lvl.setItemObject) return;
    if (hatchLayout !== L.hash) { hatched = new Map(); hatchLayout = L.hash; }
    const ints = useLoose<IxStateLike>(ctx.services, 'interaction')?.state?.()?.ints ?? {};
    for (const [id, info] of Object.entries(ints)) {
      if (!id.startsWith('crawl:') || info?.kind !== 'vent') continue;
      const ventId = typeof info.ref === 'string' ? info.ref : id.slice(6);
      if (hatched.has(ventId)) continue;
      const old = lvl.itemObject(ventId);
      if (!old) continue;
      const hatch = old.clone(); // shares the vent's geometries + materials
      hatch.name = `hatch:${ventId}`;
      hatch.scale.multiplyScalar(1.35);
      const handleMat = (old.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined)?.material;
      if (handleMat) {
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.035), handleMat as THREE.Material);
        handle.position.set(0, -0.12, 0.045);
        handle.castShadow = false;
        hatch.add(handle);
      }
      lvl.setItemObject(ventId, hatch);
      hatched.set(ventId, hatch);
    }
  };

  return {
    duct,
    active: () => !!view,
    /** per frame: the duct camera while crawling (returns true when it set cam / quat) */
    update(now: number, cam: THREE.Vector3, quat: THREE.Quaternion): boolean {
      syncHatches(now);
      const v = view;
      if (!v) return false;
      const k = Math.max(0, Math.min(1, (now - v.t0) / (v.t1 - v.t0)));
      // crawl from just inside the grate to most of the way down, with a slow shuffle
      const along = 0.75 + k * (DUCT_LEN - 1.6);
      const bob = Math.abs(Math.sin(now / 1000 * 5.2)) * 0.025;
      cam.set(duct.position.x + v.dir.x * along, 0.3 + bob, duct.position.z + v.dir.z * along);
      look.set(cam.x + v.dir.x, cam.y - 0.02, cam.z + v.dir.z);
      tmpQ.lookAt(cam, look, up);
      quat.setFromRotationMatrix(tmpQ);
      if (now > v.t1 + 4000) finishLocal(null); // the exit never came (server restart): never stay in the duct
      return true;
    },
  };
}
