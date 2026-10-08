// players (v1.2 fix round: avatar draw budget) unit tests, no browser:
//   - merge.ts: baked parts land exactly where Object3D placement puts them; bakeChildMeshes merges per material and
//     leaves bones / anchors alone
//   - helmets are 2 meshes (hard parts casting + visor not casting), sharing one hard material across profiles;
//     the placeholder body is 3 meshes
//   - the real UAL mannequins (.assets/dist): the two skinned primitives merge into ONE skinned mesh whose skinned
//     vertices match the originals in a bent pose, clones keep the merged mesh + its cull sphere, and every vertex of
//     every clip the players use stays inside the fixed cull sphere (no limb ever culled away)
//   node --test tests/players/avatar-merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { bakeChildMeshes, mergeParts, placeGeometry } from '../../apps/client/src/players/merge.ts';
import { bodyMaterial, buildHelmet, buildPlaceholderBody } from '../../apps/client/src/players/cosmetics.ts';
import { cleanClip, prepareBody } from '../../apps/client/src/players/rig.ts';
import type { Profile } from '../../packages/shared/src/profile.ts';

// a do-nothing 2D canvas for the visor / badge CanvasTextures (no DOM in node)
const ctx2d: object = new Proxy({}, { get: () => () => ctx2d, set: () => true });
(globalThis as Record<string, unknown>).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const ROOT = join(import.meta.dirname, '../..');
const DIST = process.env.ASSETS_DIR ? (existsSync(join(process.env.ASSETS_DIR, 'manifest.json')) ? process.env.ASSETS_DIR : join(process.env.ASSETS_DIR, 'dist')) : join(ROOT, '.assets/dist');
const manifest = existsSync(join(DIST, 'manifest.json')) ? JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as { files: Record<string, { url: string }> } : null;
const assetPath = (key: string): string | null => {
  const f = manifest?.files[key];
  return f && existsSync(join(DIST, f.url)) ? join(DIST, f.url) : null;
};
const NO_ASSETS = !assetPath('char.mannequin_m') || !assetPath('anim.ual1');

const profile = (helmet: Profile['helmet'], suit: [string, string] = ['#d4a017', '#2c3e50'], visor = '#7dfcff'): Profile =>
  ({ name: 'T', body: 'm', suit, helmet, visor: { glyphs: 'AB', color: visor }, badge: 117 }) as Profile;

const meshesOf = (o: THREE.Object3D) => { const out: THREE.Mesh[] = []; o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); }); return out; };

test('placeGeometry bakes exactly what Object3D placement does', () => {
  const geo = new THREE.BoxGeometry(0.2, 0.1, 0.3);
  const part = { geo, p: [0.1, -0.2, 0.3] as const, r: [0.4, -1.1, 0.25] as const, s: [1, 1.05, 0.8] as const };
  const mesh = new THREE.Mesh(geo);
  mesh.position.set(...part.p);
  mesh.rotation.set(...part.r);
  mesh.scale.set(...part.s);
  mesh.updateMatrixWorld(true);
  const x0 = geo.attributes.position.getX(0);
  const baked = placeGeometry(part);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < geo.attributes.position.count; i++) {
    a.fromBufferAttribute(geo.attributes.position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(baked.attributes.position as THREE.BufferAttribute, i);
    assert.ok(a.distanceTo(b) < 1e-6, `vertex ${i}`);
  }
  assert.equal(geo.attributes.position.getX(0), x0, 'the source geometry is untouched');
  const m = mergeParts([part, { geo, p: [1, 0, 0] }]);
  assert.ok(m);
  assert.equal(m.attributes.position.count, geo.attributes.position.count * 2);
  assert.equal(m.index!.count, geo.index!.count * 2);
});

test('bakeChildMeshes: one mesh per material, bones / anchors untouched, shadow flags kept', () => {
  const bone = new THREE.Bone();
  const child = new THREE.Bone();
  bone.add(child);
  const matA = new THREE.MeshStandardNodeMaterial(), matB = new THREE.MeshStandardNodeMaterial();
  const add = (m: THREE.Material, x: number, cast: boolean) => { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), m); mesh.position.x = x; mesh.castShadow = cast; bone.add(mesh); };
  add(matA, 0, false); add(matA, 1, false); add(matA, 2, false); add(matB, 3, true);
  const anchor = new THREE.Object3D();
  bone.add(anchor);
  const out = bakeChildMeshes(bone);
  assert.equal(out.length, 2);
  const meshes = bone.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
  assert.equal(meshes.length, 2, 'A x3 -> 1, B stays');
  assert.ok(bone.children.includes(child) && bone.children.includes(anchor));
  const a = meshes.find((m) => m.material === matA)!;
  assert.equal(a.geometry.attributes.position.count, 12);
  assert.equal(a.castShadow, false);
  assert.equal(meshes.find((m) => m.material === matB)!.castShadow, true);
  a.geometry.computeBoundingBox();
  assert.ok(Math.abs(a.geometry.boundingBox!.max.x - 2.05) < 1e-6, 'parts kept their x offsets');
});

test('helmets: 2 meshes (hard casts, visor does not), one shared hard material, cached geometry', () => {
  const hardMats = new Set<THREE.Material>();
  for (const kind of ['dome', 'box', 'diver'] as const) {
    const h = buildHelmet(profile(kind));
    const ms = meshesOf(h.group);
    assert.equal(ms.length, 2, `${kind}: 2 meshes (was 7-14)`);
    const hard = ms.find((m) => m.material !== h.visorMat)!;
    const visor = ms.find((m) => m.material === h.visorMat)!;
    assert.ok(hard && visor, kind);
    assert.equal(hard.castShadow, true, `${kind} hard parts cast the head's shadow`);
    assert.equal(visor.castShadow, false, `${kind} visor casts nothing`);
    for (const a of ['hcol', 'hpbr', 'hemi']) assert.ok(hard.geometry.getAttribute(a), `${kind} ${a}`);
    hardMats.add(hard.material as THREE.Material);
    // the lamp lens glows (2.2 x warm white), the shell does not
    const emi = hard.geometry.getAttribute('hemi');
    let glowing = 0;
    for (let i = 0; i < emi.count; i++) if (emi.getX(i) > 1.5) glowing++;
    assert.ok(glowing > 0 && glowing < emi.count / 4, `${kind}: only the lens glows warm (${glowing}/${emi.count})`);
    // same profile -> same merged geometry object; another shell colour -> another geometry, same material
    assert.equal(meshesOf(buildHelmet(profile(kind)).group).find((m) => m.material !== undefined && (m.material as THREE.Material).name === 'M_Helmet')!.geometry, hard.geometry);
    const other = meshesOf(buildHelmet(profile(kind, ['#d4a017', '#c0392b'], '#ff4d4d')).group).find((m) => (m.material as THREE.Material).name === 'M_Helmet')!;
    if (kind !== 'diver') assert.notEqual(other.geometry, hard.geometry, `${kind}: colours are baked per shell colour`);
    assert.equal(other.material, hard.material);
    // lamp anchor at the helmet lamp
    assert.ok(Math.abs(h.lamp.position.x) > 0.15 && h.lamp.position.z > 0.1);
    hard.geometry.computeBoundingBox();
    const bb = hard.geometry.boundingBox!;
    assert.ok(bb.max.x < 0.25 && bb.min.x > -0.25 && bb.max.y < 0.25 && bb.min.y > -0.25, `${kind}: helmet-sized (${bb.min.toArray()} .. ${bb.max.toArray()})`);
  }
  assert.equal(hardMats.size, 1, 'one hard material for every helmet');
});

test('placeholder body: 3 casting meshes', () => {
  const { group } = buildPlaceholderBody(profile('dome'));
  const ms = meshesOf(group);
  assert.equal(ms.length, 3, 'suit, boots, accents (was 13)');
  assert.ok(ms.every((m) => m.castShadow && m.receiveShadow));
  const box = new THREE.Box3().setFromObject(group);
  assert.ok(box.min.y > -0.01 && box.max.y > 1.4 && box.max.y < 1.7, `body extents ${box.min.y}..${box.max.y}`);
});

test('bodyMaterial: one physical material with the suit sheen and the joint clearcoat', () => {
  const m = bodyMaterial(new THREE.Color('#d4a017'), new THREE.Color('#2c3e50'), new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 2, 1)));
  assert.ok(m.isMeshPhysicalNodeMaterial);
  assert.ok(m.useSheen && m.useClearcoat);
  assert.ok(m.colorNode && m.roughnessNode && m.metalnessNode && m.sheenNode && m.clearcoatNode);
});

async function loadGlb(key: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const p = assetPath(key);
  if (!p) throw new Error(`asset ${key} missing`);
  const buf = readFileSync(p);
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (g) => res(g as unknown as { scene: THREE.Group; animations: THREE.AnimationClip[] }), rej));
}

const skinned = (o: THREE.Object3D) => { const out: THREE.SkinnedMesh[] = []; o.traverse((c) => { if ((c as THREE.SkinnedMesh).isSkinnedMesh) out.push(c as THREE.SkinnedMesh); }); return out; };

test('mannequins: two skinned primitives merge into one that skins identically', { skip: NO_ASSETS && 'no .assets/dist' }, async () => {
  for (const key of ['char.mannequin_m', 'char.mannequin_f']) {
    if (!assetPath(key)) continue;
    const ref = await loadGlb(key);
    const tplScene = (await loadGlb(key)).scene;
    const parts = skinned(ref.scene);
    assert.equal(parts.length, 2, `${key}: the asset has 2 skinned primitives`);
    const tpl = prepareBody(key.endsWith('_f') ? 'f' : 'm', tplScene);
    const merged = skinned(tpl.scene);
    assert.equal(merged.length, 1, `${key}: one skinned mesh after the merge`);
    const body = merged[0];
    const jm = body.geometry.getAttribute('jmask');
    const main = parts.find((p) => !/joint/i.test((p.material as THREE.Material).name))!;
    const joint = parts.find((p) => p !== main)!;
    const nMain = main.geometry.attributes.position.count, nJoint = joint.geometry.attributes.position.count;
    assert.equal(jm.count, nMain + nJoint);
    let ones = 0;
    for (let i = 0; i < jm.count; i++) ones += jm.getX(i);
    assert.equal(ones, nJoint, 'jmask = 1 on exactly the joint vertices');
    assert.equal(body.geometry.index!.count, main.geometry.index!.count + joint.geometry.index!.count);
    assert.ok(body.frustumCulled && body.boundingSphere && body.castShadow, 'culled against its sphere, casts');
    assert.ok(body.geometry.userData.suitBox instanceof THREE.Box3);
    // bend both skeletons the same way: the merged body's skinned vertices equal the original parts'
    const bend = (root: THREE.Object3D) => {
      for (const [name, x] of [['spine_02', 0.5], ['upperarm_l', -0.9], ['thigh_r', 0.7], ['Head', 0.4]] as const) {
        const b = root.getObjectByName(name);
        if (b) b.rotation.x += x;
      }
      root.updateMatrixWorld(true);
    };
    bend(ref.scene);
    bend(tpl.scene);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), wa = new THREE.Vector3(), wb = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < jm.count; i += 7) {
      const part = i < nMain ? main : joint;
      body.getVertexPosition(i, va);
      part.getVertexPosition(i < nMain ? i : i - nMain, vb);
      wa.copy(va).applyMatrix4(body.matrixWorld);
      wb.copy(vb).applyMatrix4(part.matrixWorld);
      worst = Math.max(worst, wa.distanceTo(wb));
    }
    assert.ok(worst < 1e-5, `${key}: skinned positions match (worst ${worst} m)`);
    // avatars are SkeletonUtils clones: one merged skinned mesh bound to the clone's own bones, sphere copied
    const clone = SkeletonUtils.clone(tpl.scene);
    const cs = skinned(clone);
    assert.equal(cs.length, 1);
    assert.ok(cs[0].geometry === body.geometry && cs[0].boundingSphere && cs[0].boundingSphere.equals(body.boundingSphere!));
    let ownBones = true;
    cs[0].skeleton.bones.forEach((b) => { let p: THREE.Object3D | null = b; while (p && p !== clone) p = p.parent; if (!p) ownBones = false; });
    assert.ok(ownBones, 'the clone skins with its own bones');
  }
});

test('the fixed cull sphere holds every vertex of every player clip (no limb culled away)', { skip: NO_ASSETS && 'no .assets/dist' }, async () => {
  const anims = [...(await loadGlb('anim.ual1')).animations.map((c) => ['anim.ual1', c] as const), ...(assetPath('anim.ual2') ? (await loadGlb('anim.ual2')).animations.map((c) => ['anim.ual2', c] as const) : [])];
  // the clips players use: the clip map's players section + rig.ts's fallbacks (all of them when no clip map)
  const cmPath = assetPath('anim.clipmap');
  const cm = cmPath ? JSON.parse(readFileSync(cmPath, 'utf8')) as { players?: unknown } : null;
  const used = new Set<string>(['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Interact', 'PickUp_Table', 'Walk_Carry_Loop', 'OverhandThrow', 'Sword_Regular_A', 'Death01', 'Spell_Simple_Idle_Loop', 'Spell_Simple_Shoot', 'Idle_Talking_Loop', 'Yes', 'Hit_Knockback']);
  // what rig.ts plays: players[<ANIM name>] (not the alternatives, not 'extra' such as the root-motion climbs)
  for (const [name, ref] of Object.entries((cm?.players ?? {}) as Record<string, unknown>)) {
    const clip = name !== 'extra' && ref && typeof ref === 'object' ? (ref as { clip?: unknown }).clip : null;
    if (typeof clip === 'string') used.add(clip);
  }
  const clips = anims.filter(([, c]) => used.has(c.name)).map(([, c]) => cleanClip(c));
  assert.ok(clips.length >= 12, `found the player clips (${clips.length})`);
  for (const key of ['char.mannequin_m', 'char.mannequin_f']) {
    if (!assetPath(key)) continue;
    const tpl = prepareBody(key.endsWith('_f') ? 'f' : 'm', (await loadGlb(key)).scene);
    const model = SkeletonUtils.clone(tpl.scene);
    model.scale.setScalar(tpl.scale);
    const body = skinned(model)[0];
    const sphere = body.boundingSphere!;
    const mixer = new THREE.AnimationMixer(model);
    const v = new THREE.Vector3();
    let worst = 0, worstAt = '';
    for (const clip of clips) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.reset().play();
      for (let s = 0; s <= 16; s++) {
        mixer.setTime((clip.duration * s) / 16);
        model.updateMatrixWorld(true);
        for (let i = 0; i < body.geometry.attributes.position.count; i++) {
          body.getVertexPosition(i, v);
          const k = v.distanceTo(sphere.center) / sphere.radius;
          if (k > worst) { worst = k; worstAt = `${clip.name} @${s}/16`; }
        }
      }
      mixer.uncacheClip(clip);
    }
    console.log(`  ${key}: ${clips.length} clips, worst vertex at ${(worst * 100).toFixed(0)}% of the cull radius (${worstAt}); radius ${(sphere.radius * body.matrixWorld.getMaxScaleOnAxis()).toFixed(2)} m`);
    assert.ok(worst <= 1, `${key}: every pose inside the cull sphere (worst ${worst.toFixed(3)} at ${worstAt})`);
  }
});
