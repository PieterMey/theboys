// Owner: track (c) Monsters (v1.3 F6, flag earwigs). Client side of the Earwigs: fleshy ears the Listener grows on
// the walls of the crew's route; what they hear reaches the (dormant) Listener. The server places them and sends
// them in the snapshot's dyn list as 'ear:<n>' (p = the mount point on the wall surface, p[1] = height; yaw = the
// wall normal, pointing into the room); the transform is static.
// TODO(integrator, messages/monsters.ts): an explicit `'monsters.ears': { ears: { id; p; yaw; space }[] }` event would
// replace the dyn entries; the dyn channel works today without any contract change (core crewSnapshot hook).
// Each ear is ONE small static mesh: one shared geometry + the Listener's own wet-skin material (no new material),
// castShadow off. Its pipeline is compiled by the monsters' once-per-page warm-up (index.ts warmMesh), so an ear
// coming into view compiles nothing. Tells: it twitches when it relays (server 'monsters.cue' 'tick' with the ear's
// id, a wet tick audible 4 m) and it curls shut while your flashlight is on it (the server makes a lit ear deaf 6 s).
import * as THREE from 'three/webgpu';

export const EAR_PREFIX = 'ear:';

/** indexed position / normal / uv geometries merged into one (all parts share the attribute layout) */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const g of parts) {
    const base = pos.length / 3;
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), U = g.getAttribute('uv');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    const I = g.getIndex();
    if (I) for (let i = 0; i < I.count; i++) idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) idx.push(base + i);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** ~19 x 27 cm ear in local space: +Z out of the wall, +Y up (helix rim, bowl, lobe, a flat growth patch on the wall).
 *  The server mounts it 1 cm in front of the visible wall face; it stands ~5 cm proud of it (its back 1-2 cm in). */
export function earGeometry(): THREE.BufferGeometry {
  const helix = new THREE.TorusGeometry(0.052, 0.014, 6, 18, Math.PI * 1.62);
  helix.rotateZ(-Math.PI * 0.42);
  helix.scale(1, 1.38, 1);
  helix.translate(0, 0.012, 0.02);
  const bowl = new THREE.SphereGeometry(0.04, 10, 8);
  bowl.scale(1, 1.25, 0.32);
  bowl.translate(0.004, 0.004, 0.008);
  const lobe = new THREE.SphereGeometry(0.021, 8, 6);
  lobe.scale(1, 1.2, 0.62);
  lobe.translate(-0.014, -0.066, 0.014);
  const patch = new THREE.SphereGeometry(0.07, 10, 8);
  patch.scale(1.05, 1.45, 0.16);
  patch.translate(0, -0.004, -0.002);
  const g = merge([patch, bowl, helix, lobe]);
  g.scale(1.3, 1.3, 1.3);
  g.computeBoundingSphere();
  return g;
}

interface EarView { id: string; mesh: THREE.Mesh; base: THREE.Vector3; yaw: number; twitchAt: number; curl: number }

export interface EarEntry { p: [number, number, number]; yaw: number }

export interface Ears {
  /** the Listener's wet-skin material (models loaded); null = a plain dark fallback (degraded, compiles on sight) */
  setSkin(m: THREE.Material | null): void;
  /** one mesh exactly like a real ear (geometry, material, shadow flags) for the warm-up; null before the skin */
  warmMesh(): THREE.Mesh | null;
  /** per frame: show the ears in `entries` (id -> latest transform), drop the rest; `lit(p)` = your beam is on it */
  update(entries: ReadonlyMap<string, EarEntry>, scene: THREE.Object3D | null, dt: number, lit: (p: THREE.Vector3) => boolean): void;
  /** a relay: the ear twitches */
  twitch(id: string): void;
  clear(): void;
  list(): { id: string; p: [number, number, number]; yaw: number; curl: number; visible: boolean }[];
}

export function createEars(): Ears {
  let geo: THREE.BufferGeometry | null = null;
  let skin: THREE.Material | null = null;
  let fallback: THREE.Material | null = null;
  const views = new Map<string, EarView>();
  const tmp = new THREE.Vector3();
  const material = (): THREE.Material => skin ?? (fallback ??= new THREE.MeshStandardNodeMaterial({ color: 0x0a0809, roughness: 0.15, metalness: 0.05 }));
  const mesh = (): THREE.Mesh => {
    geo ??= earGeometry();
    const m = new THREE.Mesh(geo, material());
    m.name = 'monsters:ear';
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  };
  return {
    setSkin(m) {
      skin = m;
      for (const v of views.values()) v.mesh.material = material();
    },
    warmMesh: () => (skin ? mesh() : null),
    update(entries, scene, dt, lit) {
      for (const [id, v] of views) {
        if (entries.has(id)) continue;
        v.mesh.removeFromParent();
        views.delete(id);
      }
      if (!scene) return;
      const now = performance.now();
      for (const [id, e] of entries) {
        let v = views.get(id);
        if (!v) {
          const m = mesh();
          m.name = `monsters:ear:${id}`;
          v = { id, mesh: m, base: new THREE.Vector3(), yaw: 0, twitchAt: 0, curl: 0 };
          views.set(id, v);
        }
        if (v.mesh.parent !== scene) scene.add(v.mesh);
        v.base.set(e.p[0], e.p[1], e.p[2]);
        v.yaw = e.yaw;
        // curls shut under your beam (eased), twitches after a relay (a quick squeeze + shiver)
        const want = lit(v.base) ? 1 : 0;
        v.curl += (want - v.curl) * Math.min(1, dt * (want ? 10 : 2.5));
        const tw = v.twitchAt ? (now - v.twitchAt) / 1000 : 9;
        const k = tw < 0.6 ? Math.exp(-tw * 7) : 0;
        const s = 1 - 0.22 * v.curl;
        v.mesh.position.copy(v.base);
        tmp.set(Math.sin(e.yaw), 0, Math.cos(e.yaw)).multiplyScalar(-0.012 * v.curl);
        v.mesh.position.add(tmp);
        v.mesh.rotation.set(0.25 * v.curl + Math.sin(tw * 48) * 0.12 * k, e.yaw, Math.sin(tw * 31) * 0.1 * k);
        v.mesh.scale.set(s * (1 + 0.18 * k), s * (1 - 0.12 * k), s * (1 + 0.35 * k));
        v.mesh.updateMatrix();
      }
    },
    twitch(id) {
      const v = views.get(id);
      if (v) v.twitchAt = performance.now();
    },
    clear() {
      for (const v of views.values()) v.mesh.removeFromParent();
      views.clear();
    },
    list: () => [...views.values()].map((v) => ({ id: v.id, p: [v.base.x, v.base.y, v.base.z] as [number, number, number], yaw: v.yaw, curl: Math.round(v.curl * 100) / 100, visible: !!v.mesh.parent && v.mesh.visible })),
  };
}
