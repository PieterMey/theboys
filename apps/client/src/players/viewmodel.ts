// Owner: track ⑤ Players. First-person view model: a held flashlight in the lower right with lag/sway/bob.
// Procedural (rubberised body, flared head, emissive lens); the local flashlight light originates at the lens.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetUrl, basisPath, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
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
  // a gloved hand hint (rounded box under the grip)
  const glove = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.06, 4, 10), flat(0x1a1917));
  glove.rotation.z = Math.PI / 2;
  glove.position.set(0.004, -0.012, 0.045);
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
        const ktx2 = new KTX2Loader().setTranscoderPath(basisPath()).detectSupport(renderer);
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
              mat.emissive = new THREE.Color(0x3a3a3a);
              mat.emissiveMap = mat.map;
              mat.emissiveIntensity = 0.35;
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
