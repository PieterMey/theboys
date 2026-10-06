// Owner: track ③ Render (apps/client/src/render/**). TEMPORARY P0 stub so G0 can screenshot WebGPU:
// WebGPURenderer (WebGL2 with ?webgl=1), dark fog, a lit test cube, services.three, backend label.
// ③ replaces all of this (post stack, light pools, presets).
import * as THREE from 'three/webgpu';
import { h } from 'preact';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';

export async function install(ctx: ClientContext): Promise<void> {
  const done = ctx.readiness.require('render');
  const container = document.getElementById('game')!;
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: ctx.params.get('webgl') === '1' });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  const device = (renderer.backend as unknown as { device?: EventTarget }).device;
  device?.addEventListener('uncapturederror', (e) => {
    ctx.reportError(`WebGPU: ${(e as unknown as { error?: { message?: string } }).error?.message ?? 'uncaptured error'}`);
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040507);
  scene.fog = new THREE.FogExp2(0x040507, 0.085);
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, 1.55, 3.4);
  camera.lookAt(-0.9, 0.8, 0); // cube right of centre: the Join panel sits left

  scene.add(new THREE.HemisphereLight(0x5a6878, 0x060606, 0.35));
  const lamp = new THREE.PointLight(0xffc27a, 55, 14, 2);
  lamp.position.set(1.3, 2.3, 1.4);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  scene.add(lamp);
  const rim = new THREE.SpotLight(0x5f8cff, 45, 12, Math.PI / 7, 0.5, 2);
  rim.position.set(-2.5, 3, -2);
  rim.target.position.set(0, 0.8, 0);
  scene.add(rim, rim.target);

  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x8c1d18, roughness: 0.42, metalness: 0.25 }));
  cube.position.y = 0.85;
  cube.castShadow = true;
  scene.add(cube);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardNodeMaterial({ color: 0x15181b, roughness: 0.92 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // keepNames proof (DynamicLighting batches by class name): must survive the production build
  ctx.diag.keepNames = lamp.constructor.name === 'PointLight';
  if (!ctx.diag.keepNames) ctx.reportError(`keepNames missing: PointLight minified to '${lamp.constructor.name}'`);
  ctx.diag.backend = backend;

  ctx.services.provide('three', { renderer, scene, camera, backend });
  ctx.ui.registerHud('bottom-right', () => h('div', { class: 'hud-chip' }, `RENDER ${backend.toUpperCase()}`), { id: 'render-backend', order: 100 });

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let frames = 0;
  ctx.registerSystem({
    name: 'render',
    order: SYS.render,
    update(dt) {
      cube.rotation.y += dt * 0.5;
      cube.rotation.x += dt * 0.15;
      renderer.render(scene, camera);
      if (++frames === 3) done();
    },
  });
}
