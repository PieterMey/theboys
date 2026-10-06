// Owner: track ⑤ Players. First-person view model: a held flashlight in the lower right with lag/sway/bob.
// Procedural (rubberised body, flared head, emissive lens); the local flashlight light originates at the lens.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sharedKTX2 } from '../level/materials.ts';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import type { LocalPlayer } from './local.ts';

export interface ViewModel {
  group: THREE.Group;
  /** world-space lens position + beam direction (lagged), valid after update() */
  lensPos: THREE.Vector3;
  beamDir: THREE.Vector3;
  update(dt: number, me: LocalPlayer, visible: boolean, lightOn: boolean, lag: number): void;
  /** swap the procedural model for the 'prop.flashlight' asset (vintage flashlight) when present */
  loadProp(renderer: THREE.WebGPURenderer, onLog: (m: string) => void): Promise<boolean>;
}

export function createViewModel(scene: THREE.Scene): ViewModel {
  const group = new THREE.Group();
  group.name = 'viewmodel';
  const inner = new THREE.Group();
  group.add(inner);
  // unlit, dark shades: the flashlight sits right next to its own (very bright, close) spot light, which blows
  // physically lit materials out to white; a flat dark model reads better in the dark anyway
  const flat = (c: number) => new THREE.MeshBasicNodeMaterial({ color: c, fog: false });
  const body = flat(0x1d2024);
  const grip = flat(0x0f1012);
  const chrome = flat(0x4a4e53);
  const lens = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xfff0cf).multiplyScalar(3), fog: false });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, z: number) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = Math.PI / 2; // cylinders along -Z (forward)
    mesh.position.z = z;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    inner.add(mesh);
    return mesh;
  };
  add(new THREE.CylinderGeometry(0.017, 0.017, 0.15, 20), grip, 0.04);
  add(new THREE.CylinderGeometry(0.0185, 0.0185, 0.012, 20), chrome, -0.035);
  add(new THREE.CylinderGeometry(0.0185, 0.0185, 0.012, 20), chrome, 0.11);
  add(new THREE.CylinderGeometry(0.03, 0.019, 0.055, 24), body, -0.07);
  add(new THREE.CylinderGeometry(0.031, 0.031, 0.012, 24), chrome, -0.1);
  const lensMesh = new THREE.Mesh(new THREE.CircleGeometry(0.027, 24), lens);
  lensMesh.position.z = -0.1065;
  lensMesh.rotation.y = Math.PI; // face -Z
  inner.add(lensMesh);
  const sw = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.02), chrome);
  sw.position.set(0, 0.018, -0.01);
  inner.add(sw);
  // gloved hand round the grip (look pass, ③): palm + four wrapped fingers + thumb in worn work-glove leather.
  // Lit (the lens light points away from it, so it never blows out) with a faint floor so it is never a black hole.
  const gloveMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2520, roughness: 0.82, metalness: 0, emissive: new THREE.Color(0x0b0a09), emissiveIntensity: 1 });
  const cuffMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c1d1f, roughness: 0.6, metalness: 0.1, emissive: new THREE.Color(0x060607), emissiveIntensity: 1 });
  const glove = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.05, 4, 12), gloveMat);
  palm.rotation.x = Math.PI / 2;
  palm.scale.set(1.05, 1, 0.8);
  palm.position.set(0.024, -0.008, 0.052);
  glove.add(palm);
  for (let f = 0; f < 4; f++) {
    const finger = new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.0085, 8, 14, Math.PI * 1.15), gloveMat);
    // wrap from the palm side under the barrel round to the far side; little finger slightly smaller
    finger.rotation.set(0, Math.PI / 2, Math.PI * 0.55);
    finger.position.set(0.004, 0, 0.018 + f * 0.0185);
    finger.scale.setScalar(f === 3 ? 0.92 : 1);
    glove.add(finger);
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085, 0.036, 4, 8), gloveMat);
  thumb.rotation.set(Math.PI / 2, 0, 0);
  thumb.position.set(-0.004, 0.02, 0.03);
  glove.add(thumb);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.035, 14), cuffMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0.03, -0.012, 0.1);
  glove.add(cuff);
  for (const c of glove.children) { c.castShadow = false; c.receiveShadow = false; }
  inner.add(glove);
  inner.rotation.set(0.05, 0.1, 0);
  inner.scale.setScalar(0.85);
  group.visible = false;
  scene.add(group);

  const procedural = [...inner.children];
  let lensMats: THREE.MeshStandardMaterial[] = [];
  const lagQ = new THREE.Quaternion();
  let init = false;
  const offset = new THREE.Vector3();
  const lensLocal = new THREE.Vector3(0, 0, -0.11);
  const vm: ViewModel = {
    group,
    lensPos: new THREE.Vector3(),
    beamDir: new THREE.Vector3(0, 0, -1),
    update(dt, me, visible, lightOn, lag) {
      if (!init) { lagQ.copy(me.camQuat); init = true; }
      lagQ.slerp(me.camQuat, 1 - Math.exp(-lag * dt));
      const bob = Math.sin(me.bobPhase) * me.bobAmp * 0.6;
      const bobY = Math.abs(Math.cos(me.bobPhase)) * me.bobAmp * 0.5;
      const crouchDip = (1.62 - me.eye) * 0.02;
      offset.set(0.2 + bob, -0.2 - bobY - crouchDip, -0.36);
      offset.applyQuaternion(lagQ);
      group.position.copy(me.cam).add(offset);
      group.quaternion.copy(lagQ);
      group.visible = visible;
      lens.color.setHex(lightOn ? 0xfff0cf : 0x2a2a2a);
      if (lightOn) lens.color.multiplyScalar(3);
      for (const m of lensMats) m.emissiveIntensity = lightOn ? 4 : 0;
      group.updateMatrixWorld(true);
      vm.lensPos.copy(lensLocal).applyMatrix4(inner.matrixWorld);
      vm.beamDir.set(0, 0, -1).applyQuaternion(lagQ).normalize();
    },
    async loadProp(renderer, onLog) {
      try {
        if (!getAssetManifest()) await loadAssetManifest();
        const url = assetUrl('prop.flashlight');
        if (!url) return false;
        const ktx2 = sharedKTX2(renderer); // one KTX2 transcoder for the whole client (no 'Multiple active KTX2 loaders')
        const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
        const gltf = await loader.loadAsync(url);
        const prop = gltf.scene;
        prop.updateMatrixWorld(true);
        const all = new THREE.Box3().setFromObject(prop);
        const glass = new THREE.Box3();
        let hasGlass = false;
        const glassMats: THREE.MeshStandardMaterial[] = [];
        prop.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = false;
          m.receiveShadow = false;
          const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
          for (const mat of mats) {
            if (/glass/i.test(mat.name)) {
              glass.expandByObject(m);
              hasGlass = true;
              mat.emissive = new THREE.Color(0xfff0cf);
              mat.emissiveIntensity = 4;
              glassMats.push(mat);
            } else if (mat.map) {
              // dim self-illumination so the prop never reads as a black hole in total darkness
              // (look pass: 0.35 made the red vintage body glow like a toy in the dark)
              mat.emissive = new THREE.Color(0x2a2a2a);
              mat.emissiveMap = mat.map;
              mat.emissiveIntensity = 0.16;
            }
          }
        });
        const size = all.getSize(new THREE.Vector3());
        const centre = all.getCenter(new THREE.Vector3());
        // long axis = barrel; the glass end is the front
        const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
        const front = new THREE.Vector3();
        if (hasGlass) front.copy(glass.getCenter(new THREE.Vector3())).sub(centre);
        const sign = Math.sign(front[axis]) || 1;
        const from = new THREE.Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
        const q = new THREE.Quaternion().setFromUnitVectors(from, new THREE.Vector3(0, 0, -1));
        const len = size[axis];
        const k = 0.17 / Math.max(0.01, len);
        const holder = new THREE.Group();
        prop.position.sub(centre);
        holder.add(prop);
        holder.quaternion.copy(q);
        holder.scale.setScalar(k);
        holder.position.set(0, 0, -0.01);
        for (const c of procedural) c.visible = c === procedural[procedural.length - 1]; // keep the glove
        inner.add(holder);
        lensMats = glassMats;
        lensLocal.set(0, 0, -0.01 - 0.085);
        onLog(`view model: prop.flashlight (axis ${axis}${sign > 0 ? '+' : '-'}, len ${len.toFixed(3)} m)`);
        return true;
      } catch (e) {
        onLog(`view model prop failed: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    },
  };
  return vm;
}
