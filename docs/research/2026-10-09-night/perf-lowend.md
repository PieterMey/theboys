# perf-lowend: why friends on WebGL2 run at 13-14 fps, why the host is on Medium, and a path to 60 fps

**Basis.** v1.2 at 25058ac, read-only. I used both of my 2 guarded software-lane runs (SwiftShader, exit 0, no driver events), plus the production-build CPU profiles a previous perf-lowend instance left last night in the same scratch folder. Software-lane "frame time" is SwiftShader time: SwiftShader is a CPU rasterizer that is heavy on texture work, so read it as relative GPU work only. Main-thread JS timings are real. Players are P1, P2, P3 as in the brief.

## 1. Top findings

1. **The friends were GPU-bound (fragment shading), not CPU-bound.**
   - The whole client loop costs 8.5 ms (dev build) to 11.6 ms (production build) per frame on the host's 9950X3D, measured in a 6-player Low/WebGL2 contract. The friends played a 2-player contract, which is cheaper. A CPU-bound 65-74 ms frame would need a CPU about 6-9x slower than the host's.
   - Their frame time followed resolution. P3 in the hub: 1152x571 to 960x476 cut p50 from 57 ms to 45 ms.
   - v1.2 made the same machine at the same 960x476 Low 23% slower than v1.1 (P3 contract p50 53.4 ms to 65.6 ms). That matches v1.2's extra per-pixel work.
   - The auto-quality ladder reached its last rung (Low at 0.6 scale) within about 1 minute of joining. It has nothing lower to go to.

2. **"Low" still runs almost all of v1.2's per-pixel shading.** Each lit pixel does:
   - about 23 light evaluations: 16 batched spots, 4 points, the hemisphere and 2 shadowed projector beams (5-tap PCF plus a cookie). There is no range early-out, and 6-10 of these lights sit visible at intensity 0;
   - 5-11 octaves of MaterialX Perlin noise and triplanar texture fetches;
   - the fog12 medium plus light-grid GI (13 `texelFetch` per pixel);
   - a velocity render target that nothing reads at Low;
   - bloom (12 passes), a chromatic-aberration render-to-texture pass, grade and grain.

   Lit fragment shaders are 44 KB of GLSL at the median and 77 KB at the largest (clearcoat/sheen physical materials). By the first contract view there are 105 fragment programs and 139 pipelines.

3. **A potato prototype, measured on the same view at the same resolution, roughly halves both GPU work and main-thread time.**
   - SwiftShader frame p50: 460 ms to 223 ms (−52%).
   - Main-thread loop: 9.75 ms to 4.4 ms per frame (−55%).
   - Draws per frame: 220 to 111. Triangles: 0.5 M to 0.25 M.
   - Fragment shader median: 44 KB to 28 KB, with no `texelFetch` left.

4. **CPU is the second wall on weak laptops.**
   - About 90% of the loop is three.js render submission (about 220 draws in 2 shadow passes, the main pass and 14 post passes).
   - Shadow maps cost 2.8 ms per frame; `scene.updateMatrixWorld` over about 1,700 static level meshes costs 1.1-1.2 ms.
   - Players, audio, interaction, level and monsters together cost under 1 ms. GC, Preact and the audio graph are negligible.
   - Scaled by laptop single-thread speed (1.6x to 3.5x slower), Low needs about 14-40 ms per frame of CPU. The potato tier would need about 7-15 ms (estimate).

5. **The multi-second freezes are shader compiles.**
   - On WebGL2, every new program blocks the main thread on `getProgramParameter(LINK_STATUS)`, which also stalls networking, poses and STT chunks.
   - The game compiles 67 programs at boot for the title-menu 3D backdrop, then 38 more at the first contract view (3.6 MB of GLSL in total).
   - On WebGPU, the site warm paces itself by main-thread render time. Dawn compiles happen off the main thread and look like idle time, so the batch grows toward 40 units per frame. That is the likely cause of the host's 8.5 s and 6.6 s single frames (from reading the code, not verified on hardware).

6. **Weak clients miss the drive preload, so the van leaves without them.**
   - The friends' drive ended at exactly 12 s with no "preloaded the site" line; the host's solo drive waited 28.4 s for his preload.
   - Both froze around the drive start, before the client sends `net.preload` (it waits 1.2 s first). `crewLoaded()` saw no preloaders and started the contract.
   - They arrived in a live contract while still compiling: P2 had a 15.9 s frame, and P3 had at least 10 s with zero frames.

7. **The host's MEDIUM is a manual setting saved in the desktop app, not auto-quality.**
   - It has been stored in the desktop app's localStorage since at least 2026-10-07 13:25 UTC, about 5 h after that day's device-lost crash.
   - It overrides GPU detection, which would have picked Ultra. It is re-applied on every welcome, and it also becomes the auto-quality ceiling.
   - The settings menu has no "Auto" option to go back to.
   - At Medium the host renders 1920x1027 on a 4K panel at 150% scaling, which is 25% of native pixels.
   - The host is CPU-bound anyway: p50 6.65 ms with the GPU busy 0.7-1.3 ms.

8. **We can't tell why the friends got WebGL2.**
   - The game never forces WebGL2. three.js falls back on any WebGPU init error and doesn't keep the reason.
   - Telemetry has no GPU name, fallback reason, browser/shell or CPU ms.
   - Most likely cause: integrated or weak GPUs (both auto-detected as 'low'), possibly an Optimus laptop with the browser on the iGPU. Other candidates are a browser or platform without WebGPU, hardware acceleration turned off, or a blocklisted driver.
   - It is not SwiftShader: Chrome removed the automatic SwiftShader fallback for WebGL around M139, and the friends ran about 6x faster than SwiftShader would.

## 2. Evidence

### 2.1 Field telemetry (theboys-live server.log, anonymised; contract values are medians of the 30 s lines)

| | P1 host | P2 | P3 |
|---|---|---|---|
| shell / backend | desktop app (Electron 44.5.1 / Chrome 152), WebGPU | unknown, WebGL2 | unknown, WebGL2 |
| viewport (from res / pr) | 2560x1369 CSS @1.5 | ~3440x1290 @1.0 (21:9) | ~2540x1260 @1.5 (4K at 150%) |
| internal resolution | Medium, 1920x1027 (25% of native) | Low cap 1600x606, ladder to 960x364 (8%) | 1600x794 to 1152x571 to 960x476 (9.5%) |
| contract fps / p50 / p95 | 133 / 6.65 / 10.6 ms, GPU 0.7-1.3 ms | 13 / 74 / 94 ms | 14.5 / 65.6 / 88.8 ms |
| v1.1, same machine | – | – | 17 fps / 53.4 ms at the same 960x476 Low (1-player contract) |
| freezes | 8.5 s at join, 6.6 s at drive | 6.0 s hub, 15.9 s drive, 17.8 s contract | 0 frames for ≥10 s at contract start (22:55:23, rtt 2111 ms) |

Drive timing from server.log: the host's drive at 22:39:25 lasted 28.4 s ("preloaded the site in 28.4 s"). The friends' drive at 22:54:43 lasted 12.0 s with no preloaded line.

### 2.2 What Low still renders (code)

- **Per-pixel lighting.** DynamicLighting caps are sized at load: at Low, `capSpots` = 17 and `capPoints` = 9 (`render/index.ts:198-200`). The batched loop runs over every visible light with no range test (`three/examples/jsm/tsl/lighting/data/SpotLightDataNode.js:117-160`). In-game, the visible zero-intensity lights were:
  - flashlight slots u2-u5 (parked but never hidden, `flashlights.ts:381-389`);
  - `mirror-bounce` and `mirror-ghost-rim` (`mirrors.ts:298-310`);
  - `flare-light-0`, `flare-light-1` and `flashbulb-light` (`interaction/visuals.ts:2262-2283`).

  Fixtures do hide parked lights (`fixtures.ts:464-470`).
- **Materials.** `materials.ts:88-89` adds stains (3 octaves) and speck (2 octaves). Patterns add more: `:115`, `:126`, `:130` (3 octaves) and wet `:151` (3 octaves). There is triplanar albedo and ORM (`:102`, `:179`) and specular AA (`:190`). Other procedural-noise call sites: monsters/models.ts (8), level/van.ts (4), players/cosmetics.ts (3), paranormal/figure.ts (2). `noise3d.ts` already offers a 64³ noise volume "replacing ALU-heavy mx_fractal_noise", but surface materials don't use it.
- **Fog and GI.** The fog12 node is used on every preset (`index.ts:271`), and so is GI (`index.ts:279-288`).
- **Velocity target.** Without GTAO the scene pass always writes velocity (`pipeline.ts:277`), but only TRAA reads it, and TRAA is off at Low.
- **Post.** Bloom is always on (`:322`). The CA, vignette and grain chain (`:329-331`) costs 14 post draws per frame.
- **Shadows.** 2 shadowed beams with 512² maps. A beam that is assigned but switched off still re-renders its map every frame (`flashlights.ts:437`).
- **Other work.** `scene.updateMatrixWorld()` runs every frame (`index.ts:1149`); `auditSceneMaterials` runs every 5 s (`index.ts:1225`, about 2 ms per call); the title-menu 3D backdrop is built at boot (`index.ts:795`).

### 2.3 Software-lane runs

Setup: my dev server on :3801 (mock AI, scratch saves, staged assets), one Chrome with `?webgl=1&preset=low&autoq=0`, and 5 ws bots walking with beams on. Seed gp-6, arrival view, 960x540 internal, monsters live.

**Run 1: per-frame numbers**

| window | SwiftShader frame p50 | main-thread loop, ms/frame (rAF time) | render submit, ms (shadow/main/post) | draws (shadow/main/post) |
|---|---|---|---|---|
| E0 steady + CPU profile | 445 | 9.75 | 7.31 (1.93/4.71/0.67) | 97/109/14 |
| E1 shadow maps frozen | 421 | 6.93 | 4.84 (0/4.39/0.46) | 0/109/14 |
| E2 remote beams off | 434 | 9.39 | 6.87 | 100/100/14 |
| E3 fixtures off (7 spots leave the loop) | 437 | 9.41 | 6.69 | 94/109/14 |
| E4 half resolution (480x270) | 157 | 8.21 | 6.11 | same |

- Triangles per frame: about 250k in shadow passes and 246k in the main pass.
- CPU profile (15 frames): loop median 8.5 ms. Render 6.91 ms (89%), players 0.44, audio 0.12, interaction 0.09, level 0.06, monsters 0.06. Steady JS outside the loop is about 1 ms per second; GC about 0.3 ms per second.
- Previous instance, production build (22 frames): loop median 11.6 ms, render 10.4 ms. Biggest self-time costs per frame:

  | function | ms/frame |
  |---|---|
  | `Object3D.updateMatrixWorld` (+ `multiplyMatrices` 0.4) | 1.2 |
  | `bufferSubData` + `bufferData` | 0.62 |
  | `UniformsGroup.update` | 0.58 |
  | `_renderObjectDirect` | 0.53 |
  | `TextureNode.update` | 0.47 |
  | `_projectObject` | 0.28 |
  | `getMaterialCacheKey` | 0.25 |

- **Where the triangles go** (previous instance, same view):
  - 5 remote avatars: 142.6k skinned triangles in shadow passes plus 71.3k in the main pass, about 42% of the total;
  - instanced GLB props: 78.6k shadow + 41.4k main;
  - fixture halos: 83.2k in one instanced draw (about 189 spheres of 20x12 segments, `fixtures.ts:257`).
- **Shaders:** 3.56 MB of fragment GLSL by the first contract view. The heaviest are physical materials whose per-light loop also evaluates clearcoat GGX and sheen (D_Charlie). The average lit shader has 12 `texture()` calls, 13 `texelFetch` calls and 5-8 loops.
- **The E2/E3 caveat:**
  - E2: switching the remote beams off saved ≤2%, because those lights stay in the loop at intensity 0.
  - E3: unpowered fixtures do leave the loop (7 spots), and even that saved only about 2% here. That means SwiftShader is bound by texture work.
  - ALU estimate from op counts: about 1,800 ops of noise, ~1,400 ops of lights (20 × ~70) and ~500 more ops for PCF, fog and GI, so about 4,000 ops per lit pixel. On a UHD-620-class iGPU that is roughly 15 ms per 0.69 M shaded pixels before overdraw (estimate).

**Run 2: potato prototype, applied at runtime**

The potato step removes shadow casters, removes noise from the 27 surface materials, drops the fog node and GI, and replaces the post chain with the tone-mapped scene pass only.

| window | SwiftShader frame p50 | loop ms/frame | render ms | draws |
|---|---|---|---|---|
| B0 baseline | 460 | (compiles in the window) | – | 92/99/14 |
| W2 potato | 223 | 5.44 | 6.87 (frames right after recompiling) | 0/110/1 |
| W3 + static level matrices | 222 | 4.36 | 2.10 | 0/109/1 |
| W4 + half resolution | 81.5 | 3.96 | 2.58 | 0/109/1 |

Fitted per-pixel model in SwiftShader: baseline costs 0.73 µs per pixel plus 62 ms fixed; potato costs 0.36 µs per pixel plus 34 ms fixed.

### 2.4 Freezes

- **WebGL2 compiles block.** The sync link-status check is at `three/src/renderers/webgl-fallback/WebGLBackend.js:1707`. Only `compileAsync` with `KHR_parallel_shader_compile` avoids it (`:1551-1575`).
  - In the previous instance's 42 s arrival profile, `getProgramParameter` alone took 6.3 s.
  - Its compile experiment, in SwiftShader where the parallel extension is absent:
    - drawing 12 fresh programs stalled 4.7 s;
    - a naive `compileAsync` built 6 programs and the real draw then built 12 more;
    - `compileAsync` under the scene pass's render target, MRT and context built 6, and the draw still added 6.
  - The remaining programs include shadow programs, which compileAsync never builds because ShadowNode skips precompilation (`ShadowNode.js:794-796`).
- **Program count.** 303 unique mesh signatures in a 6-player site. Each InstancedMesh gets its own programs (`sitewarm.ts` header comment).
- **WebGPU warm pacing.** `sitewarm.ts:236-239` sets the budget from main-thread render ms and "idle" time, which off-thread Dawn compiles inflate.
- **Background on slow Windows compiles:** ANGLE translates to HLSL and FXC compiles it, which is slow for large shaders with loops and dynamic constant-buffer indexing. See the [WebGL list (2013)](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1302/msg00019.php), [ANGLE performance wiki](https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE) and [three.js compileAsync PR](https://github.com/mrdoob/three.js/pull/19752).

### 2.5 Host preset

- `%APPDATA%\DEAD AIR\logs\desktop.log` logs `preset=medium` on every heartbeat since 2026-10-07T13:25:01Z, including in the menu. That value comes from `?preset=` or localStorage (`preload.cjs:74`). The desktop config query is empty and there is no user `config.json`, so it is localStorage.
- Only `service.setPreset` writes that key (`render/index.ts:686-693`), and it is called by the settings menus (`meta/menus.tsx:85`, `menu/panels.tsx:162`, via `meta/state.ts:120`).
- A stored preset beats detection (`index.ts:183-186`) and is re-applied about 600 ms after every welcome (`meta/index.ts:139-143`). Each `setPreset` call rebuilds the post pipeline, gives the scene pass a new context node, and so forces node rebuilds for every render object (`RenderObject.js:951`). It also resets the auto scale to 1. This probably adds to join hitches (not measured).
- The ladder's ceiling is the initial preset (`perf.ts:224`, `:266`). All 24 host telemetry lines show Medium at pr 0.75 (scale 1) despite p95 of 4-10 ms. Detection would have returned Ultra (`presets.ts:64`).

### 2.6 WebGPU availability (sources)

- Chrome uses the GPU already allocated to its other work, so `powerPreference` has no effect on Windows. WebGPU is off when graphics acceleration is off ([Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)).
- The Windows blocklist blocks D3D11-backend and CPU adapters, Qualcomm (unless a feature flag is on) and NVIDIA on x86; Intel, AMD and Microsoft are allowed on D3D12 ([webgpu_blocklist_impl.cc](https://chromium.googlesource.com/chromium/src.git/+/main/gpu/config/webgpu_blocklist_impl.cc)).
- Firefox has WebGPU on Windows since 141 and on Apple Silicon Macs; Linux and Intel Macs are Nightly only ([implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [Firefox 141](https://simonwillison.net/2025/Jul/16/webgpu-firefox)).
- Chrome no longer falls back to SwiftShader for WebGL automatically ([Intent to Remove](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM/m/oLrB5up_BwAJ), [Samsung policy note (M139)](https://developer.samsung.com/browser/policy/enable-unsafe-swift-shader.html)).
- three r186 falls back to WebGL2 on any `backend.init` error and only logs a warning (`WebGPURenderer.js:57-71`, `Renderer.js:798-812`).

## 3. Recommendations

**R1. A real "potato" tier, chosen at load.** Pool sizes are fixed at load, so the ladder should offer "switch to Potato (reload)" when it is stuck at Low ×0.6.
- What it cuts:
  - shadows: none;
  - lights: at most 4-6 per pixel;
  - materials: the noise-volume or no-noise variant (R3), one texture fetch, no clearcoat/sheen;
  - fog: closed-form only, no GI;
  - post: tone mapping only, no velocity;
  - resolution: cap 1280x720 with scale rungs down to 0.5;
  - geometry: no halo shells, avatars don't cast shadows;
  - menu: a static image instead of the 3D backdrop.
- Impact (measured on the software lane): about −52% GPU-side work and −55% main-thread time; draws and triangles halved.
- Estimate for a friend-class GPU:
  - all cuts together: about 65-74 ms down to about 25-30 ms at their current resolution;
  - 60 fps would also need about 0.25 MP internal, or a Lambert/Blinn lighting model.
  - The CPU would land around 7-15 ms on weak laptops.
- Effort L; risk medium (the look).
- Owners: E2 (render/**, render.json), G4 (settings), G1/G2/E4 for their noise call sites.
- Verify: software-lane counts and ratios (`run2-potato.mts`); real-iGPU A/B on any non-host laptop.

**R2. Take zero-intensity batched lights out of the loop.** Set `visible=false` for parked flashlight slots, the mirror bounce/rim lights, flares and the flashbulb, keeping one sentinel per light type.
- Impact: at 2 players about 8 of 16 spot evaluations per pixel are dead; at 6 players about 4. Estimated −10-15% of lit-pixel ALU on real GPUs (≤2% in SwiftShader).
- Effort S; low risk, no recompile.
- Owners: E2 (`flashlights.ts`, `mirrors.ts`), G3 (`visuals.ts`).
- Verify: pipeline count stays flat (drawbudget-style) and the visible-light list.

**R3. Surface grime from the 64³ noise volume (`noise3d.ts`) instead of `mx_fractal_noise` at Low.** This replaces about 1,800 ALU ops per lit pixel with 2-3 texture fetches.
- Impact: probably the largest real-iGPU win; it also shrinks shaders and compile time.
- Effort M; risk: a look-dev change.
- Owner: E2 (`materials.ts`); G2/G1/E3/E4 for their call sites.

**R4. No velocity render target when TRAA is off** (`pipeline.ts:276-283`).
- Impact: removes per-object VelocityNode CPU updates, previous-position vertex work (double skinning) and one RGBA16F write. It is part of why the main pass dropped from 4.7 to 2.0 ms in the potato test.
- Effort S; low risk. Owner E2.

**R5. Don't render shadow maps for beams that are off** (`flashlights.ts:437`; only arm a slot when its light is visibly on).
- Impact: about −1.4 ms CPU and −100-125k triangles per shadow pass skipped (host numbers). Common in stealth play.
- Effort S; low risk. Owner E2.

**R6. Static level matrices.** Set `matrixAutoUpdate=false` on static meshes and `matrixWorldAutoUpdate=false` on static groups after the build; doors and animated parts keep updating.
- Impact: −1.1 to −1.2 ms per frame on the host, about 2-4 ms on laptops.
- Effort M; risk: anything moved later must update itself. Owner E3.
- Verify: tests/world and the software-lane CPU profile.

**R7. Light-loop cost.** Copy SpotLightDataNode and PointLightDataNode into render/ and add a range check (`If(dist < cutoff)`), and/or rank the 4-6 most relevant batched lights per frame on the CPU (only visible lights are counted, so no recompile).
- Effort M; risk: maintaining a fork of a three.js addon. Owner E2.

**R8. Ladder and presets.**
- Make "AUTO" the default in settings, show the detected GPU and preset, and stop treating a stored preset as a permanent ceiling (G4, E2).
- `setPreset` should do nothing when the preset is unchanged (`index.ts:686`).
- Tell CPU-bound from GPU-bound: if the loop time is at least 0.7× the frame interval, cut draws (fewer shadowed beams, half-rate shadows) rather than resolution.
- Add a 0.5 scale rung and the potato prompt.
- Effort M; low risk. Verify with `tests/render/perf.test.ts`.

**R9. Compile freezes.**
- WebGPU site warm: pace by rAF interval instead of render ms/idle (`sitewarm.ts:236-239`), or await `compileAsync` (async pipeline creation) per batch.
- WebGL2: run `compileAsync` under the scene pass's render target, MRT and context, then draw once for the shadow programs.
- Skip the 3D menu backdrop on Low/potato.
- Expected: the 6-18 s single frames become spread-out work behind the loading screen (estimate).
- Effort L; medium risk. Owner E2; the loading flow is the integrator's.
- Verify: software-lane long-frame counts; the WebGPU path needs a real-GPU pass with the user's OK.

**R10. Drive preload robustness.**
- Client: send `net.preload` immediately and move the 1.2 s paint delay after the request (`loading/index.ts:239-243`; no v1.2 owner, so integrator).
- Server: `crewLoaded()` (`meta/flow.ts:1366-1373`) should also wait, within `driveLoadWaitSec`, for connected humans who haven't asked yet (G4).
- Effort S-M; low risk.
- Verify: bots e2e plus a CPU-throttled client (CDP CPU throttling).

**R11. Telemetry.**
- Add to the client report: loop ms, render ms, draws, a GPU vendor/family bucket, backend plus fallback reason (`navigator.gpu` missing / adapter null / device error), browser brand, desktop-or-browser shell, core count, device memory, `KHR_parallel_shader_compile`, and program count / compile ms at join and drive.
- Owners: integrator (`core/telemetry.ts`) and a request to net (`net/telemetry.ts` `formatReport`).
- Effort S; low risk.

**R12. WebGPU for more users.** Don't force `enable-unsafe-webgpu` or `ignore-gpu-blocklist`.
- Point Windows friends to the desktop app: it has WebGPU on and forces the high-performance GPU (`main.cjs:189`).
- Show a one-line hint when the backend fell back to WebGL2 or the renderer string is an iGPU (G4/G1).
- WebGPU won't fix fill rate, but it removes main-thread compile blocking and adds GPU timing.

**R13. Geometry at Low.** Remote avatars out of beam shadow passes (G1); halo spheres at 10x6 segments, cutting 83k to about 21k triangles (E2). Effort M; low risk.

**Host decision.** Medium was very likely a deliberate mitigation after the GPU-fault crashes. Restoring Auto/Ultra is the user's call, and any real-GPU check needs their OK.

## 4. Quick wins doable tonight (low risk, verifiable in the software lane)

1. R2: hide zero-intensity lights (E2 now, G3 by request). Check that pipelines stay flat.
2. R4: no velocity target without TRAA (E2).
3. R5: skip shadow maps for beams that are off (E2).
4. `setPreset` no-op when unchanged, and `auditSceneMaterials` only in test/dev (E2).
5. R10: client sends `net.preload` first (integrator); `crewLoaded` waits for humans (G4).
6. R11: client telemetry fields (integrator); log line by request to net.
7. "AUTO" entry in the settings preset select (G4).

## 5. Open questions / not established

- The friends' GPU, browser and shell are unknown. Ask them for `chrome://gpu`, or for the `gpu:` line in `%APPDATA%\DEAD AIR\logs\desktop.log` if they used the desktop app.
- SwiftShader ratios are biased toward texture work. The real-iGPU split between noise, lights and fill needs a non-host laptop; I made no real-GPU runs.
- What froze both friends right at the drive start is not identified. It needs a profile of the hub-to-drive transition on a WebGL2 machine.
- WebGPU vs WebGL2 per-draw CPU cost in three r186 is unmeasured.
- The host's 8.5 s join freeze: Dawn cache misses after the deploy vs the re-apply rebuild on welcome vs the pacing feedback loop is not separated.
- Housekeeping: my runs reused the previous instance's tags. Its `run2.json` is restored as `out/prev-instance-run2.json`; its `run1.json` is lost, but its profiles remain. My dev server is stopped, there were no worktrees, and the repo is untouched.

**Scratch files** (all under `<scratch>/night\perf-lowend\`):
- `out\run1.json`, `out\run1.cpuprofile`, `out\run1-fs0.glsl` … `out\run1-fs2.glsl`
- `out\run2.json`, `out\prev-instance-run2.json`
- `out\run1.steady.cpuprofile`, `out\run1.arrival.cpuprofile` (production build, previous instance)
- `run1-contract.mts`, `run2-potato.mts`, `anon-log.mjs`
- `scripts\cpuprof-dev-v2.mjs`, `scripts\cpuprof-v2.mjs`