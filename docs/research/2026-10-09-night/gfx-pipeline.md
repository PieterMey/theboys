The audit is done. I measured counts and CPU timings in the software lane and read the rest from code, the live logs and the existing artifacts. One caution first: this session used 2 guarded runs. The scratch folder also holds 2 failed probes from an earlier session of this task (`runs/low`, `runs/low2`, both stopped at the menu join), so 4 guarded runs in total.

# gfx-pipeline: rendering audit and target architecture (v1.2 @ 25058ac, three 0.186.1)

## 1. Top findings

1. **Every machine we have data for is CPU-bound or draw-bound, not pixel-bound.**
   - P1 (host, WebGPU, Medium, 1920x1027) uses only 0.7–1.3 ms of GPU per frame, while frames take about 5–10 ms (median ≈140 fps).
   - P2 and P3 (WebGL2, Low): auto-quality pushed the internal resolution down to its floor (960x364 at pr 0.28; 960x476 at pr 0.38). They still ran 13–20 fps, so resolution was not the bottleneck.
   - Software-lane measurement at the friends' resolution (Low, WebGL2, 9950X3D): **206 draws per frame (76 shadow, 116 main, 14 post) and 7.0 ms of renderer JS per frame**. That is about 34 µs per draw, and about 68 µs per site prop-batch draw.
   - Cause: three r186 does a full per-object node and binding refresh, every pass, for any material that has a TSL node property (`NodeMaterialObserver.js:335/929`). That covers every material we have, so cost scales with draws × passes.
2. **The multi-second freezes come from the pipeline count.**
   - One Low site on WebGL2 needs **244 pipelines (181 vertex / 156 fragment programs)**; Ultra needs 386–390 (gate P artifact).
   - Fragment programs are **53 KB of GLSL at the median** (max 79 KB, 27 texture fetches, 5–8 loops).
   - TSL code generation alone takes **about 14 ms per variant on the fastest consumer CPU**: 307 builds cost 4.2 s. On top of that come 8.2 s of synchronous WebGL2 link waits.
   - The first facility frame took 2.9 s. `warmSite` took 23 s over 30 frames, the longest 0.78 s.
   - Normal WebGL2 rendering links synchronously (`WebGLBackend.js:1551/1581`, `_completeCompile`). On a mid laptop with D3D11/FXC this is consistent with P2's 6.0, 15.9 and 17.8 s frames.
3. **About 40% of those pipelines are self-inflicted and cheap to remove:**
   - Per-material JS constants are baked into the TSL graph (roughness, grime, wet, minRough: `render/materials.ts:105,175,185`). The result is 66 `level.*` fragment programs in the main pass.
   - The KTX2 upgrade swaps node graphs in place (`level/materials.ts:188-216`). Every textured level material therefore compiles twice, in both main and shadow passes: flat first, then textured. The attribution shows `p2 f2` for textured materials and `p1 f1` for untextured ones (pole, fence, wood).
   - Every InstancedMesh with ≤1024 instances gets a uniform-array instance buffer named `buffer<nodeId>` (three `Instance.js:41-47`, `GLSLNodeBuilder.js:1792`, `WGSLNodeBuilder.js:1398`). So each batch gets its own vertex and fragment program: 57 instanced pipelines, 57 vertex programs.
   - The same mechanism explains why "an InstancedMesh proxy only warms itself" (`render/index.ts:493-497`). It also means the monsters' dust and trail warm proxies (`monsters/index.ts:182-187`) never warm the real batches.
4. **Flashlights that are switched off still render shadow maps.** `flashlights.ts:431-438` arms every assigned shadowed slot whether the beam is on or not. Measured: 76 shadow draws (37% of the frame) with 0–1 beams lit. Your own slot is reserved for you, so hiding with your light off still costs a full shadow pass.
5. **The WebGPU warm-up pacing can't see shader compiles.**
   - `sitewarm.ts` sizes each batch from `renderMs` (`index.ts:1184-1189`). On WebGPU that excludes pipeline compiles, which happen in the GPU process and stall the *next* frame.
   - Its idle term then raises the target to 1200 ms and the batch to 40 units per frame (`sitewarm.ts:238-239`). That produces P1's 8.5 s join frame and 6.6 s drive frame.
   - Skinned meshes (avatars, monsters) are excluded from `warmSite` and from the proxy warm-up (`index.ts:487, 506`).
6. **P1 is on Medium because of a stored choice, not GPU detection.**
   - A read-only scan of the desktop app's localStorage (values only) shows `deadair.render.preset = "medium"` and `deadair.meta.settings.preset = "medium"`.
   - Detection (`presets.ts:60-71`) returns Ultra for an RTX 5090. But `index.ts:186` prefers the stored value, and the settings select has no Auto entry (`meta/menus.tsx:85`, `menu/panels.tsx:162`).
   - Auto-quality never climbs above its starting preset (`perf.ts:224`).
   - At Medium the 5090 is about 10% busy. Ultra measured 2–3 ms of GPU at 2560x1440 (hostperf, 6 Oct). Raising it is the user's call because of the GPU fault.
7. **P2 froze for 17.8 s in the contract, and the session ended right after.**
   - The freeze ran from about 23:00:02 to 23:00:20, eight minutes into the contract and about a minute after the Snatcher's second attack on P2.
   - P3 was killed by the hound ("heard your VOICE") at 23:00:18, inside that window. P2 left at 23:00:37 and P3 at 23:00:50.
   - P3 also had a stall of ≥10 s at contract start: no frame completed in a 10 s window, with a 2.1 s ping.
   - The logs cannot say why. There is no compile counter, no long-frame attribution and no context-loss event. Candidates are a first-sight compile outside the warm-up sets (findings 3 and 5) or a GPU reset on P2's machine.
   - Freezes also stall the voice, net and pose JavaScript.
8. **Telemetry can't explain why 2 of 3 players ran WebGL2 at Low.** The server line has no GPU string, no fallback reason, no draw or pipeline counts and no long-frame attribution. The auto-quality reason is in the payload, but the server doesn't log it.
9. **The current design is at its WebGL2 ceiling.**
   - Lit shaders already use 12 of 12 fragment uniform blocks (`render/index.ts:195-197`, render.json `_doc`).
   - The sampler limit is 16.
   - Every pixel runs a global light loop of up to 17 batched spot lights on Low and 23 on Medium.
   - GTAO needs a second full opaque scene pass (`pipeline.ts:259`), and that pass still builds every material's full lighting graph (`NodeMaterial.setup` builds lighting before the MRT override).
   - **Direction: stay on three r186 and rebuild the pipeline around hard budgets, with a new Lite tier first.** Babylon 9 or PlayCanvas 2.21 would not remove these causes, because draw and program counts come from our content. Switching would also mean rewriting 62 client files (about 23.9k lines).

## 2. Evidence

### 2.1 Live telemetry (`theboys-live/logs/server.log`, v1.2 session 22:37–23:03)

Names are replaced by P-labels; scripts are `anon-telemetry.mjs` and `who-died.mjs` in the scratch folder.

| | P1 (host) | P2 | P3 |
|---|---|---|---|
| Client | Desktop app, Electron 44.5.1 / Chrome 152 (desktop.log) | Browser; CSS ≈3404x1289 at dpr 1 (3440-wide monitor) | Browser; CSS ≈2540x1260 at dpr 1.5 (4K at 150%) |
| Backend / preset | WebGPU / Medium (stored) | WebGL2 / Low | WebGL2 / Low |
| Internal resolution | 1920x1027 (pr 0.75 = Medium cap 1920x1080; dpr clamped at CSS width ≥2560, then the browser upscales 2x) | 1600x606 → 960x364 | 1600x794 → 960x476 |
| Contract fps | 68–236, median ≈140; GPU 0.7–1.3 ms | 10–18 | 12–20 (v1.1 session on the same machine: 16–22) |
| Freezes | 8.5 s at hub/join, 6.6 s at drive | 6.0 s at hub join, 15.9 s at drive, 17.8 s in contract | ≥10 s at contract start (no frame in the window, rtt 2.1 s) |

### 2.2 Software lane, this session

Setup:
- 2 guarded runs: `run1.json` and `run2.json`, harness `run2x.e2e.ts`.
- Chrome 154 headless on SwiftShader (Vulkan/Subzero), WebGL2 backend, `?preset=low&autoq=0`.
- Viewport 1280x635, giving 960x476 internal.
- Facility gp-6, 3 players, risk 1, with 2 ws bots holding beams.
- GPU time is meaningless in this lane; JS time and counts are meaningful.
- Dev server on :3811 from a temporary worktree, now removed along with its junction.

**Biggest room view, Low preset:**

| Configuration | Draws (shadow / main / post) | Renderer JS p50 | Game loop JS p50 | Pipelines |
|---|---|---|---|---|
| Baseline | 206 (76 / 116 / 14) | 7.0 ms | 8.2 ms | 244 |
| Every beam off | 204 (76 / 114 / 14) | 7.1 ms | 8.6 ms | 244 |
| Site prop batches hidden | 169 (62 / 93 / 14) | 4.5 ms | 5.9 ms | 244 |
| Post chain bypassed (direct to canvas) | 193 (76 / 116 / 1) | 5.6 ms | 7.3 ms | 322 (+78) |

- **Main-pass draws by category:** items 22, prop batches 20, doors 19, avatars 10, set pieces 9, stencils 7, space meshes 7.
- **Shadow draws (2 slots):** doors 22, prop batches 14, space meshes 14, items 11.
- **Triangles:** 420k per frame, of which prop batches are 233k (55%).

**Compile cost on the 9950X3D:**

| Phase | Pipelines | Node builds (JS) | WebGL2 link waits | Long frames |
|---|---|---|---|---|
| First facility view | 91 → 138 | 84 builds, 1.18 s | 66, 3.06 s | 10; max 2.9 s; sum 4.9 s |
| `warmSite` (1072 meshes, 211 signatures) | 138 → 244 | 223 builds, 3.06 s | 175, 5.13 s | 19; max 0.78 s; 30 frames over 23.2 s |

**Pipeline attribution** (`R.created` in `run2.json`):
- Main pass: 132 pipelines. Plain meshes 73 (73 fragment programs); instanced 57 (57 vertex / 12 fragment programs); skinned 2.
- Shadow pass: 43 pipelines (26 fragment programs).
- Fragment programs by first user: `level.*` 51, ShadowMaterial 36, unnamed 33, bloom 7.

**Previous session's probe:** boot compiled 16 pipelines with 1.37 s of GL wait (max 192 ms). SwiftShader exposes no `KHR_parallel_shader_compile`.

**Existing real-GPU artifacts (taken before the GPU fault):**
- `hostperf` (6 Oct, Ultra 2560x1440):
  - Steady play: hub 163 fps / GPU 2.1 ms / 154 draws; contract walk 110 fps / GPU 2.05 ms / 108 draws.
  - Join max frame was 9.4–20.5 s. One long-animation-frame entry shows a single 20.1 s frame callback, and 18.7 s of main-thread time went to `writeTexture`, meaning the main thread was waiting on the GPU process.
- `drawbudget-final` (8 Oct, Ultra): 229 draws in a mirror view (73 shadow, 137 main including the pre-pass, 19 post), and 386 → 390 pipelines.

### 2.3 Inventory: what renders a frame today

| System | Where | Notes / verdict |
|---|---|---|
| Renderer | `render/index.ts:174-206` | WebGPURenderer, `forceWebGL` with `?webgl=1`; AgX; PCF shadows (5 hardware-compare taps on an IGN-rotated Vogel disk); DynamicLighting caps 17/9 (Low) and 23/9 (Medium). Keep; add budgets. |
| Presets, auto-quality, frame caps | `presets.ts`, `perf.ts:223-311` | Ladder goes features → resolution → preset. Resolution-first does nothing for CPU-bound clients; the ceiling is the starting preset. Rework (B2). |
| Shadowed beam pool | `flashlights.ts` | ProjectorLight with a procedural TSL cookie; 2 slots (Low) or 4 (Medium+); autoUpdate off, armed once per frame; remote beams use an 18 m far plane and half rate when far. Off beams are still armed (A1). |
| Unshadowed beams | `flashlights.ts:232-245` | Batched SpotLight plus an additive cone mesh. Keep. |
| Fixture lights | `fixtures.ts:544-657` | Nearest lit fixtures in visible spaces drive the batched spot and omni pools; instanced emitters, halos and lamp cones. No shadows, so light crosses walls inside the visible set. Replace with room-local lists (C5). |
| Light grid GI | `lightgrid.ts`, `index.ts:277-288` | CPU splat of fixture irradiance into one RGBA16F texture with room tags; read with `textureLoad`. Cheap and WebGL2-friendly; backbone for Lite. Keep. |
| Fog medium | `fog.ts:179-248` | Closed-form height haze, ground mist and ≤8 volumes on every material: 2 3D-noise taps, about 6 grid loads and a volume loop. Keep on Low+; Lite uses the v1.1 exponential fog. |
| Beam march (Medium+) | `mist.ts`, `pipeline.ts:286-311` | ¼ resolution (½ on Ultra), 8/12/16 steps, depth-aware blur and upsample. Keep; v2 in D3. |
| Post chain | `pipeline.ts:252-335` | Medium+: GTAO pre-pass (a **second full opaque scene pass**) → scene pass with AO×GI context → march → NV gain → luminance clamp → bloom (~12 quads) → TRAA → tone map → grade/NV → CA → vignette → grain. Low: MRT with an unused velocity target (A6). Rework (D1). |
| Mirrors | `mirrors.ts` | One live planar reflector on Medium+, which costs a full extra scene render; context shared with the scene pass. Keep. |
| Night vision, puffs | `pipeline.ts:195-214`, `motes.ts` | Uniform-only, one draw. Keep. |
| Warm-up | `index.ts:468-747`, `sitewarm.ts`, monsters warm, level prefetch | Fragmented across systems and incomplete (skips skinned meshes, uses instanced proxies). Level prefetch (`level/materials.ts:171-182`) and the monsters warm (`monsters/index.ts:197-200`) call `compileAsync` on the default context, which matches no RenderPipeline pass: the canvas-direct test needed +78 new pipelines. Unify (A5, B3). |
| Surface materials | `render/materials.ts:74-208` | ≤3 textures plus 3+2-octave MaterialX noise, patterns, puddles, macro noise, vertex masks, specular AA. Constants are baked in. Rework (A3, B1). |
| Level geometry | `level/index.ts:320-331`, `sitebatch.ts`, `doors.ts` | Per-space merged mesh with material groups; floors and ceilings cast shadows too; doors are multi-mesh; prop batches are site-wide InstancedMeshes packed per visible space; culling is a BFS 3 open doors deep. Consolidate (C1–C4). |
| Characters / monsters | `players/avatars.ts`, `monsters/models.ts` | Skinned GLBs. Not covered by `warmSite` (A5). |

### 2.4 three r186: what we don't use, and what blocks

- **Async compile building blocks exist but aren't wired into `render()`:**
  - `NodeManager.getForRenderDeferred` (`NodeManager.js:341`): a yielding `buildAsync` queue.
  - `Pipelines.getForRender(ro, promises)`: uses `createRenderPipelineAsync` on WebGPU (`WebGPUPipelineUtils.js:291`) and `KHR_parallel_shader_compile` polling on WebGL2 (`WebGLBackend.js:1551`).
  - `_renderObjectDirect` already draws an object only when `isReady` (`Renderer.js:3895`).
- **Other display nodes available:**
  - Upscaling and AA: TAAU, FSR1, SMAA, FXAA.
  - Indirect light and reflections: SSGI, stochastic SSR with RecurrentDenoise and TemporalReproject.
  - Camera effects: OIT pass, depth of field, motion blur, LUT.
  - Lights and shadows: VSM, IESSpotLight.
  - LightProbeGrid uses 7 SH textures, which collides with the sampler budget.
- **Blocked:**
  - VXGI and ClusteredLighting are WebGPU-only (ClusteredLighting renders black on WebGL2 and is forbidden).
  - BundleGroup crashes with GTAO (forbidden).
  - `Object3D.static` has no effect on node materials, because `needsRefresh` returns FULL first.
- **Known r186-era CPU overhead** (forum benchmark, r183, 4000 meshes): CPU per frame 4.5 ms (classic WebGLRenderer) vs 9.7 ms (WebGPU backend) vs 10.3 ms (`forceWebGL`); first frame 32 vs 167 vs 344 ms. Linked to issue #30560 (the per-object UBO system).

### 2.5 Alternatives for a rewrite

| | Visual ceiling | WebGL2 fallback | Effort | Risk | CLAUDE.md three.js rules |
|---|---|---|---|---|---|
| **A. Rebuilt three r186 pipeline (recommended)** | High. Keeps cookie + PCF beams, the beam march, the TSL fog medium and grid GI; adds SSGI, SSR and TAAU on WebGPU tiers. | Same TSL compiled to GLSL, but it must be budgeted: about 2x the per-draw CPU of classic WebGLRenderer, and compiles are synchronous unless the async mode is added. | M–L, incremental; every phase ships on its own. | Low–medium. The async mode uses private APIs (version is pinned). | Keep all of them, and add rules for budgets, uniforms instead of constants, placeholder textures, instancing, and parked shadow slots. |
| B. Babylon.js 9.x | High: OpenPBR, clustered Forward+ on both backends, frame graph v1, PCSS, SSR, SSAO2, TAA. Volumetric lighting is a frame-graph post-process; per prior research it is directional-only. | First-class. On WebGL2 each light gets its own uniform block (about 10 active lights per shader; a clustered container counts as one). | XL: 62 files / ~24k lines plus gate tests. | High. Snapshot rendering combined with clustered lights crashed; clustered WGSL fails validation in Firefox's WebGPU. | The three.js list becomes moot; new Babylon-specific rules needed (4 lights per material by default, snapshot limits). |
| C. PlayCanvas 2.21+ | Medium-high: clustered omni and spot lights **with** shadow and cookie atlases (≤255 lights), volumetric fog driven by a directional light, SSAO, TAA. No SSGI or SSR. | First-class. WebGPU is still labeled beta in the manual. | XL | High. Agents know it least, and the content consolidation is still needed. | Moot; new rules needed. |
| D. Custom WebGPU renderer | Highest control (GPU-driven culling, clustering). | Needs a second renderer: WebGPU reaches about 74–81% of users overall and about 88% on Windows. | XXL | Very high | n/a |

If the Lite tier misses its budget on WebGPURenderer's WebGL2 backend, a fallback option is classic `WebGLRenderer` with stock materials for Lite only. It is about 2x cheaper per draw and much faster on first frames. The cost is a second material system and an explicit exception to the "`three/webgpu` only" rule.

### 2.6 Sources

- [three.js forum: WebGPURenderer 2x slower CPU, r183](https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904)
- [three.js forum: why is WebGPURenderer slower](https://discourse.threejs.org/t/why-webgpurenderer-performance-significantly-lower-than-webglrenderer/77629)
- [Babylon.js 9.0 announcement](https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0)
- [Babylon forum: clustered lighting fails on Firefox WebGPU](https://forum.babylonjs.com/t/clustered-lighting-wgsl-fails-validation-on-firefox-webgpu-ptr-storage-function-parameter-requires-unrestricted-pointer-parameters-which-naga-doesnt-implement/63887)
- [Babylon forum: snapshot rendering vs clustered lighting](https://forum.babylonjs.com/t/snapshot-rendering-does-not-support-clustered-lighting/63139)
- [Babylon forum: WebGL2 uniform blocks per light](https://forum.babylonjs.com/t/gl-max-vertex-uniform-buffers/63078)
- [PlayCanvas clustered lighting docs](https://developer.playcanvas.com/user-manual/graphics/lighting/clustered-lighting/)
- [PlayCanvas engine v2.21.0](https://forum.playcanvas.com/t/engine-v2-21-0/42453)
- [PlayCanvas VolumetricFog API](https://api.playcanvas.com/engine/interfaces/VolumetricFog.html)
- [What's new in WebGPU, Chrome 146 (compatibility mode)](https://developer.chrome.com/blog/new-in-webgpu-146)
- [Chromium: intent to remove the SwiftShader fallback](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM/m/oLrB5up_BwAJ)
- [Web3D Survey: WebGPU support](https://web3dsurvey.com/webgpu)

## 3. Recommendations: one direction, "R2", a budgeted three r186 pipeline

**Proposed budgets**, gated by counts in the software lane:

| Tier | Draws per frame | Shadowed beams | Pipelines per site | Max fragment shader size |
|---|---|---|---|---|
| Lite | ≤110 | own beam only | ≤80 | ≤20 KB |
| Low | ≤140 | 2 | ≤120 | — |
| Medium / High | ≤220 | 4 | ≤160 | — |
| Ultra | ≤300 | 4 | ≤200 | — |

On every tier: no frame-loop compile after the loading screen, and no warm-up frame longer than 250 ms.

### Phase A: stop the bleeding (1–3 days, each item ships alone)

- **A1. Park shadow slots whose beam is off.** Applies when `!f.on && cur < 0.01` (`flashlights.ts:373-447`).
  - Impact: −38 shadow draws per dark slot at Low, −37% of the frame when both slots are dark. About −1.3 to −2.6 ms of JS on the 9950X3D.
  - Effort S, owner E2.
  - Verify: the "every beam off" toggle in `run2x.e2e.ts` should drop from 76 shadow draws to 0–38.
- **A2. Use the vertex-attribute instancing path for site batches.** Either capacity ≥1025 or `StorageInstancedBufferAttribute` (`sitebatch.ts:41-49`); same for G3's and E2's InstancedMeshes.
  - Impact: −40 to −50 pipelines per site; the prop batch cost (now 2.5 ms for 37 draws) should roughly halve.
  - Effort S, owner E3. Risk: +64 KB per batch.
  - Verify: vertex-program and pipeline counts after `warmSite`.
- **A3. Turn material parameters into uniforms** (roughness, metalness, grime, wet, minRough, macro, scale), and select patterns with a uniform or a small fixed set of variants.
  - Impact: `level.*` fragment programs drop from 66 to ≤10; shadow programs drop similarly.
  - Effort M, owner E2.
  - Verify: fragment-program count by material in the attribution.
- **A4. Use placeholder 1x1 textures from the start**, and swap `.value` when the KTX2 texture arrives (`level/materials.ts:183-218`).
  - Impact: removes the second compile of every textured level material.
  - Effort S–M, owners E3 + E2.
  - Verify: no `p2 f2` entries for level materials.
- **A5. Fix `warmSite` pacing.** Drive the batch size from rAF-to-rAF wall time, cap WebGPU at about 4 signatures per frame, and warm skinned meshes too.
  - Impact: P1's 6.6 s frame becomes several frames of ≤0.3 s each.
  - Effort S–M, owner E2.
  - Verify: `siteWarm().maxFrameMs` plus long-animation-frame entries; host telemetry next session.
- **A6. On Low, add the velocity MRT only when TRAA is on** (`pipeline.ts:276-279`). Effort S, owner E2.
- **A7. Extend telemetry.** Add:
  - a bucketed GPU string
  - the WebGPU fallback reason
  - the preset source (URL, stored, auto, safe mode)
  - the auto-quality decision
  - draw count and pipeline count, plus pipelines compiled after ready (count and ms)
  - the top script for long-animation frames over 500 ms
  - `webglcontextlost` and WebGPU `device.lost` events
  - Effort S. Owners: integrator (`core/telemetry.ts`); the server line is a request to net.
- **A8. Add "Auto (detected: …)" to the preset select.** When Auto, the auto-quality ceiling is the detected preset.
  - Effort S, owners G4 (`menus.tsx`, `panels.tsx`) and E2 (`index.ts:186`, `perf.ts:224`).
  - The host decides whether to use it, given the GPU fault.
- **A9. Warm the real Snatcher dust and trail InstancedMeshes**, not proxies (`monsters/index.ts:182-187`). Effort S, owner G2.

### Phase B: Lite tier and freeze-proofing (about 1 week)

- **B1. A `lite` preset**, the default on WebGL2 unless the GPU is strong. Contents:
  - only your own beam is shadowed (512²)
  - fixture light comes from grid GI plus emissives, with ≤4 batched spots
  - v1.1 exponential fog
  - no bloom, CA, TRAA, AO or march
  - one fused output pass (tone map, grade, vignette, grain)
  - a noise-free surface material
  - Effort M, owners E2 + E3.
  - Verify: Lite budget counts and screenshots in the lane, then friends' telemetry.
  - Expected: the friends' CPU ceiling roughly doubles. That is an estimate.
- **B2. CPU-bound detection in auto-quality.** If a resolution step doesn't improve p50 by ≥10%, undo it and step to Lite instead; keep a resolution floor of about 0.6 on WebGL2.
  - Effort S, owner E2. Verify with `perf.test.ts` frame series.
- **B3. Async compile mode behind a flag.**
  - Wire deferred node builds and async pipelines into rendering. A starting prototype exists at `prototypes/asynccompile.ts`, untested, from the previous session.
  - Loading screens wait until nothing is pending; post-processing quads stay synchronous.
  - Effort M, owners E2 + integrator (flag). Risk: medium.
  - On WebGL2 it needs `KHR_parallel_shader_compile`. Chrome/ANGLE on Windows normally exposes it; SwiftShader does not, so the lane can only verify the deferred node builds (first-view max frame should go from 2.9 s to under 0.3 s).

### Phase C: content consolidation (1–2 weeks)

- **C1. One draw per room.** Merge each room's shell into one mesh with KTX2 texture arrays and per-vertex layer IDs. Owners E1 (asset pipeline), E3, E2. Effort L.
- **C2. Shadow proxies per space:** walls and frames only; visual meshes stop casting. Owner E3. Expected: −30 to −50% shadow draws.
- **C3. Merge or instance doors:** 19 main + 22 shadow draws. Owner E3.
- **C4. Instance items by type:** 22 main draws. Owner G3.
- **C5. Room-local light lists in the light-grid texture**, replacing the global DynamicLighting loop: ≤8 lights per pixel, WebGL2-compatible, frees uniform blocks, stops light bleeding through walls. Owner E2. Effort L. Needs a real-GPU visual check.

### Phase D: Standard and Ultra rebuild (2–3 weeks, WebGPU tiers; real-GPU pass with the host's OK)

- **D1. Single-pass MRT.** One scene pass writes direct, indirect, normal and velocity; GTAO reads it; composite = direct + indirect × AO. This removes the pre-pass. Expected: about −35 to −45% CPU on Medium+.
- **D2. TAAU on High and Ultra.** P1 currently gets a 2x browser upscale.
- **D3. Beam march v2:** temporal reprojection; step count scales with lit beams.
- **D4. SSGI on Ultra for flashlight bounce, and stochastic SSR on wet floors at High+.**
- **D5. Re-test BundleGroup** only after the pre-pass is gone.

## 4. Quick wins doable tonight (software lane, low risk)

A1, A2, A6, A7, A8, A9, plus the skinned-mesh and wall-clock pacing parts of A5. Each is S and verifiable by counts with `run2x.e2e.ts`:
- shadow draws with all beams off: 76 → ~0
- instanced vertex programs: 57 → ~10
- total pipelines: 244 → ~190, then ≤150 after A3 and A4
- renderer JS in the room view: 7.0 ms → about 4.5–5 ms

## 5. Open questions

- **Why P2 and P3 ran WebGL2** (browser, GPU blocklist, Firefox?), and whether they were CPU- or GPU-bound. Answering this needs A7.
- **The cause of P2's 17.8 s freeze:** a compile or a GPU reset. Needs A7.
- **Real GPU cost per tier on iGPU or mid-range hardware.** No data: lane GPU time is meaningless and the host GPU is faulty. Ideally one friend runs a consented telemetry session comparing `?preset=lite` and `low`.
- **Medium on WebGL2 wasn't measured** (the live preset toggle didn't fit the run budget). The pre-pass cost is inferred from code and the gate P artifact.
- **Whether `compileAsync`-based prefetch produces any reusable pipelines.** Verify by counting before and after entering a prefetched room.
- **Babylon and PlayCanvas per-draw CPU on our content** has not been benchmarked.

Files in `<scratch>/night\gfx-pipeline\`:
- `run1.json`, `run2.json`
- `run2x.e2e.ts`: re-runnable harness for draws, attribution, program sizes and toggles
- `who-died.mjs`, `ls-preset.mjs`, `anon-telemetry.mjs`
- `prototypes\asynccompile.ts`