// Env-layout (v1.2) test helper: per-node bounds of a prop GLB (.assets/build/props/<key>.glb) in the client loader's
// recentred frame (apps/client/src/level/assets.ts buildTemplate: x/z centred on the whole model's box, y = 0 at its
// bottom). Reads only the glTF JSON chunk: POSITION accessor min/max (exact for the quantized uint16 data) through the
// node TRS hierarchy (translation + scale; the props carry no rotations). Also: node -e to print the tables.
import { readFileSync } from 'node:fs';

type V3 = [number, number, number];
interface GNode { name?: string; mesh?: number; children?: number[]; translation?: V3; rotation?: [number, number, number, number]; scale?: V3; matrix?: number[] }
export interface NodeBox { name: string; min: V3; max: V3 }
export interface GlbBounds { model: { min: V3; max: V3 }; shift: V3; nodes: NodeBox[] }

/** bounds of every named node subtree (meshes below it), recentred */
export function glbBounds(file: string): GlbBounds {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')) as {
    nodes: GNode[]; meshes: { primitives: { attributes: Record<string, number> }[] }[]; accessors: { min?: number[]; max?: number[] }[]; scenes: { nodes: number[] }[]; scene?: number;
  };
  const roots = json.scenes[json.scene ?? 0].nodes;
  type M = { s: V3; t: V3 };
  const apply = (m: M, p: V3): V3 => [m.t[0] + m.s[0] * p[0], m.t[1] + m.s[1] * p[1], m.t[2] + m.s[2] * p[2]];
  const compose = (parent: M, n: GNode): M => {
    if (n.rotation && (Math.abs(n.rotation[0]) + Math.abs(n.rotation[1]) + Math.abs(n.rotation[2]) > 1e-6)) throw new Error(`${file}: node ${n.name} has a rotation`);
    if (n.matrix) throw new Error(`${file}: node ${n.name} has a matrix`);
    const s = n.scale ?? [1, 1, 1], t = n.translation ?? [0, 0, 0];
    return { s: [parent.s[0] * s[0], parent.s[1] * s[1], parent.s[2] * s[2]], t: apply(parent, t) };
  };
  const named = new Map<string, { min: V3; max: V3 }>();
  const all = { min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3 };
  const grow = (box: { min: V3; max: V3 }, p: V3) => { for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], p[k]); box.max[k] = Math.max(box.max[k], p[k]); } };
  const walk = (i: number, m: M, owners: string[]) => {
    const n = json.nodes[i];
    const mm = compose(m, n);
    const own = n.name ? [...owners, n.name] : owners;
    if (n.mesh !== undefined) {
      for (const pr of json.meshes[n.mesh].primitives) {
        const a = json.accessors[pr.attributes.POSITION];
        if (!a.min || !a.max) throw new Error(`${file}: POSITION without min/max`);
        for (const c of [a.min, a.max]) {
          const p = apply(mm, [c[0], c[1], c[2]]);
          grow(all, p);
          for (const o of own) { if (!named.has(o)) named.set(o, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }); grow(named.get(o)!, p); }
        }
      }
    }
    for (const ch of n.children ?? []) walk(ch, mm, own);
  };
  for (const r of roots) walk(r, { s: [1, 1, 1], t: [0, 0, 0] }, []);
  const shift: V3 = [-(all.min[0] + all.max[0]) / 2, -all.min[1], -(all.min[2] + all.max[2]) / 2];
  const sh = (p: V3): V3 => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]];
  return { model: { min: sh(all.min), max: sh(all.max) }, shift, nodes: [...named].map(([name, bx]) => ({ name, min: sh(bx.min), max: sh(bx.max) })) };
}

if (import.meta.filename === process.argv[1]) {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (const f of process.argv.slice(2)) {
    const g = glbBounds(f);
    console.log(f, 'model', g.model.min.map(r3), g.model.max.map(r3));
    for (const n of g.nodes) console.log(' ', n.name.padEnd(34), 'c', n.min.map((v, k) => r3((v + n.max[k]) / 2)), 's', n.min.map((v, k) => r3(n.max[k] - v)));
  }
}
