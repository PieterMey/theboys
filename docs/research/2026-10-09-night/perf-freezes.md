# perf-freezes: what causes the multi-second freezes at hub join, drive and contract start

**Bottom line.** The freezes come almost entirely from shader work. That work has two parts: building TSL node graphs in JS on the main thread, and compiling programs/pipelines synchronously. The biggest single frames are not today's paced `warmSite` frames. They are the first unpaced draw of each new level, plus `warmSite` frames whose budget grows exactly when the GPU stalls. The two WebGL2 friends also froze at the drive start, missed the preload, and played a cold site. That is why they kept freezing mid-contract.

Method: two guarded software-lane runs (SwiftShader, WebGL2, low preset, 960×540, dev server on :3804 started and killed by me). Software-lane wall times are not representative; JS times and counts are. JS times were measured on a Ryzen 9 9950X3D, so the friends' JS is probably 2–4× slower. All player names are anonymised as P1/P2/P3.

## 1. Top findings

1. **The freezes are shader work; everything else is small.**
   - Per phase, these other costs are each well under 0.3 s: level build (78 ms hub, 137–208 ms facility), GLB parse (~18 ms), texture JS (57/31 ms; KTX2 transcodes in workers), Preact (61 ms), audio.
   - What remains:
     - TSL node building: sync JS, median 15 ms per build, ~130–160 builds per site, about 1.4–2.2 s per site on this CPU.
     - Program/pipeline compile: sync, in the render path.

2. **The worst frames are unpaced first draws of a new level, not warmSite's paced frames.**
   - Hub: the first frame compiled 40 pipelines + 58 node builds (6.5 s gap, run 2). Through the loading screen, the first warm frame compiled 54 pipelines + 75 node builds (8.3 s gap, run 1), although its batch budget was 1 unit. It draws the whole spawn view plus all 6 warm-beam shadow passes.
   - Facility: the 3D view keeps drawing at full rate under the opaque drive screen, and the `'hold'` mode still draws once a second. So 32–63 pipelines compile before warmSite even starts, 27 of them in one frame (5.1 s gap).

3. **warmSite's pacing gets more aggressive when the GPU stalls.**
   - It learns cost per unit from the JS time of `pipe.render()` and books the following rAF gap as "idle" (`sitewarm.ts:190`).
   - The target is then `base + 3·idle`, capped at 1200 ms (`:238`), and the budget climbs to its 40-unit cap (`:239`).
   - Both lane sites ended at budget 40 (idle 297 ms and 345 ms).
   - On WebGPU, a sync `createRenderPipeline` costs almost no JS but stalls the GPU process. So the slower the compile, the more gets packed into each frame. This matches P1's 8.5 s (join) and 6.6 s (~4 s into the drive) single frames.

4. **three r186 always compiles synchronously in the render path; async exists only in `compileAsync`.**
   - WebGL2 calls `LINK_STATUS` right after `linkProgram` (`WebGLBackend.js:1551/1581/1707`), so the main thread blocks for each program.
   - WebGPU calls `device.createRenderPipeline` (`WebGPUPipelineUtils.js:260-262`).
   - r186 already skips drawing objects whose pipeline is not ready (`Renderer.js:3895`). Turning on async creation in the render path is therefore a small patch.

5. **The friends never preloaded, so they played a cold site.**
   - The server only waits for clients that sent `net.preload` (`meta/flow.ts:1366-1373`).
   - The 2-friend drive lasted exactly 12.04 s, and neither friend has a `[loading] preloaded` line. P1's solo drive, by contrast, waited 28.6 s for P1.
   - They arrived cold, and the arrival cover is capped at 12 s, leaving warmSite between 1.5 and ~8.5 s (`loading/index.ts:148,281`). The contract was then played with compiles in game. P2 froze 17.8 s about 5 min in, then closed or reloaded the tab 17 s later.
   - The main thread was really blocked, not just starved of frames. The first telemetry send (due at welcome + 10 s) arrived 3.6 s late for P1, 9.5 s for P2 and 18.7 s for P3. P2's drive-start sample arrived 2.6 s late.

6. **Every phase change compiles and throws away monster programs.**
   - Each phase change runs the monster warm-up twice, immediately and at +1.5 s (`monsters/index.ts:969`).
   - Each run creates new `InstancedMesh` proxies for the dust and trail effects (`:183`), which are lit MeshStandardNodeMaterial programs. three compiles every InstancedMesh separately, so these programs are never reused, and the real effect meshes still compile at first sight.
   - This lands right at the drive start. It is the strongest suspect for P2's 15.9 s frame, which began about 0.2 s after the drive event, before the preload could start (1.2 s sleep).
   - Both `compileAsync` uses compile for the renderer's default render context, not the RenderPipeline's MRT scene pass, so they are wasted work: monsters `:197-201` and level `prefetch` (`level/materials.ts:182`). On WebGL2 without KHR_parallel they still link synchronously.

7. **There are too many, too large lit programs.**
   - Hub + one facility: 369 programs. Of these, 96 are lit fragment programs of 40–80 KB GLSL each (5.7 MB in total).
   - 29 of those 96 differ only in numeric constants.
   - Every site batch (`InstancedMesh`) gets its own programs: 226 distinct `mat4 buffer<id>[count]` instance buffers and 42 shadow pipelines.
   - Every level surface material compiles twice: first flat, then again when the in-place KTX2 upgrade swaps nodes and sets `needsUpdate` (`level/materials.ts:210-216`). This is visible for 15+ materials in run 2.
   - P1 runs medium, where GTAO adds a pre-pass pipeline for each opaque object. That is not measured, because the lane is low-only.

8. **Shader sources are mostly identical across sessions, so Chrome's on-disk caches can hit.**
   - Between two independent browser sessions, all 103 programs with no node-id names matched byte for byte.
   - The DynamicLighting light-buffer ids were identical in both sessions (`NodeBuffer_5630…5643`).
   - Instance buffers break this: 43 of 334 programs (13%) differ only by global node ids, and the instance count is also baked into the array size.

9. **Voice: the audio keeps flowing during a freeze, but the gating stops.**
   - WebRTC media keeps flowing.
   - But the receive gates (a 30 Hz main-thread timer, `voice/index.ts:262`), the mic band/VAD and STT PCM forwarding (worklet port handled on the main thread) all stall during WebGL2 sync-link freezes.
   - A closed gate cannot open, so you don't hear a teammate who starts talking while you are frozen.

## 2. Evidence

### 2.1 Live telemetry, tonight (anonymised copy: `night/perf-freezes/server.anon.log`)

| Player | Join | Drive | Contract |
|---|---|---|---|
| P1 (WebGPU, medium) | One 8468 ms frame; first send 3.6 s late; RTT 6 ms | One 6637 ms frame ~4 s into the drive; preload 28.4 s and the server waited (drive 28.6 s) | 68 fps, 6 long frames at arrival |
| P2 (WebGL2, low) | 0 frames in the window, first send 9.5 s late; then a 6.0 s frame with RTT 5003 ms (pings delayed for seconds: real main-thread blocking) | 15889 ms frame starting ~0.2 s after the drive event; drive ended at 12.04 s without P2's preload | 10 fps, 8 long frames on arrival; 17.8 s freeze ~5 min in, socket closed 17 s later |
| P3 (WebGL2, low) | 0 frames, first send 18.7 s late | No preload | 0 frames in the window at contract start, RTT 2111 ms |

Some ~38–40 s gaps between logged samples are ambiguous: they may be a server-side skip rather than lateness. Only the first-send lateness and the 32.6 s gap are certain.

### 2.2 Software-lane measurements (`run1/report.txt`, `run2/cache.json`, `run2/fp-A.json`)

**Run 1: menu JOIN, then drive with preload, then arrival.**

| Phase | Node builds (count / ms) | Pipelines (count / sync link ms) | Biggest gap |
|---|---|---|---|
| Boot / menu backdrop | n/a | 91 / 3063 | ~3.2 s |
| Join | 131 / 1407 | 91 / 3541 | 8.3 s: first warm frame, 54 pipelines, LoAF 3.25 s, budget 1 unit |
| Drive preload | 125 / 1714 | 108 / 2239 (32 of them before warmSite) | 3.6 s, 18 pipelines |
| Arrival | 6 / 114 | 6 / 279 | 1.7 s |

- Join: the "stable" step never holds in the lane, so the join waited out the 45 s cap.
- Node build: median 15.3 ms, p90 23.5 ms, max 36 ms. Sync link in SwiftShader: median 12.7 ms, p90 86 ms, max 160 ms.
- KHR_parallel_shader_compile is not exposed in this lane (`backend.parallel=false`).
- warmSite: hub 90 meshes / 65 signatures, budget 40; facility 884 meshes / 218 signatures / 19 frames, budget 40.

**Run 2: `__game.join`, then `dbg level.generate`, then a manual `warmSite`.**
- First hub frame: 40 pipelines (29 main + 11 shadow), 58 builds, 6.5 s gap.
- Facility rebuild: first frame 27 pipelines + 34 builds (5.1 s gap). 63 pipelines + 77 builds happened before the warm started.
- warmSite (860 meshes, 202 signatures, 18 frames): 59 pipelines and 85 builds, at most 11 pipelines per frame, longest JS frame 568 ms.
- About 33 more pipelines trickled in over 15 s while playing (no cover). These included texture-upgrade recompiles, 7 programs for `metal_office_desk` part batches, and monsters.

**CPU profile.** In the lane, 87% of main-thread time is `(program)`, i.e. SwiftShader backpressure, which is not representative. JS (three) took about 2.0 s in the join and 1.9 s in the drive.

### 2.3 three r186 (0.186.1): what is sync and what is async

| Step | WebGPU | WebGL2 |
|---|---|---|
| Node build | Sync JS on every new render-object key (`NodeManager.js` getForRender). The key includes node ids (`Node.js:470-474`), the render context (`RenderObject.js:854`) and, for an InstancedMesh, `object.uuid` (`:846`) | Same |
| Program creation | `createShaderModule` (`WebGPUBackend.js:2639`) | `compileShader`, queued without blocking (`WebGLBackend.js:1502`) |
| Pipeline, render path | Sync `createRenderPipeline` (`WebGPUPipelineUtils.js:262`) | `linkProgram`, then a blocking `LINK_STATUS` read (`:1581`, `:1707`) |
| Pipeline, `compileAsync` | `createRenderPipelineAsync` (`:291`). Dawn runs D3D12 pipeline initialisation asynchronously ([Dawn 4ecfc58](https://dawn.googlesource.com/dawn/+/4ecfc58777cbedb373d2db21d4d475a50e4d98fd)) | COMPLETION_STATUS polling per rAF, only if KHR_parallel is exposed (`:1551`) |
| `compileAsync` node builds | `buildAsync` yields after each stage (`NodeBuilder.js:3282`) and between objects (`Renderer.js:1099`) | Same |
| Draw gate | `_pipelines.isReady()` (`Renderer.js:3895`) | Same |

Other relevant details:
- `getForRenderDeferred` exists but nothing calls it (`NodeManager.js:341`).
- Instance matrices go into a `buffer()` uniform array when they fit (`Instance.js:45`). It is named `buffer${node.id}` / `NodeBuffer_${node.id}` (`GLSLNodeBuilder.js:1792/1800`; WGSL `:1398` unless the node is named).
- Render contexts are keyed by attachment state + MRT (`RenderContexts.js`). That is why `compileAsync`, which uses no MRT and the default target, never matches the scene pass (`pipeline.ts:257-283`).

### 2.4 Shader inventory and cross-session cache

- Program sources (run 1): 196 vs + 173 fs. 260 contain id-named buffers.
  - 10 vec4 light buffers are shared by 120 lit programs.
  - 226 distinct `mat4` instance buffers.
- Deduplication potential: 278 unique after normalising ids; 259 unique after normalising ids and instance counts.
- Duplicate pairs also differ only in `nodeUniformN` ordering.
- Run 1 vs run 2 (separate Chrome processes): 262 of 334 exact matches.
  - All 103 id-free programs matched.
  - Of 231 id-named programs, 159 matched exactly and 202 after normalising.
- Disk caches:
  - Chrome hooks ANGLE program binaries through the EGL blob cache ([passthrough_program_cache](https://chromium.googlesource.com/chromium/src/+/195019cd1a4900bbdf372939132fe94de57f6885/gpu/command_buffer/service/passthrough_program_cache.cc), [program_cache.h](https://chromium.googlesource.com/chromium/src/+/main/gpu/command_buffer/service/program_cache.h)).
  - Chrome persists Dawn blobs ([dawn_caching_interface](https://chromium.googlesource.com/chromium/src/+/0617fa211418e43df39b94de1d10bbcf6bbe0fe6/gpu/command_buffer/service/dawn_caching_interface.h)). Since June 2025, a Dawn cache hit skips Tint and the backend compilers on D3D and Vulkan ([Dawn e9cfa26](https://dawn.googlesource.com/dawn/+/e9cfa262db36400a579cac3f2720dd51233c8a8e)).
  - The desktop app keeps a persistent `userData` folder and does not disable the shader cache (`apps/desktop/src/main.cjs:189-195`).

### 2.5 KHR_parallel_shader_compile

COMPLETION_STATUS is the non-blocking poll, and `LINK_STATUS` should be read only after it reports completion ([Khronos spec](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/KHR_parallel_shader_compile)). There are known ANGLE D3D link stalls ([public_webgl 2019](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1905/msg00029.php)) and similar reports from three.js users ([forum](https://discourse.threejs.org/t/webgl2renderingcontext-getprogramparameter-freezes-app/88368)).

## 3. Recommendations

**R1. Async pipeline creation in the render path while a cover is up.**
- What: wrap `renderer._pipelines.getForRender` so it gets a non-null promises array (sketch in `proto/freeze-fixes.ts` (A)). Loading covers then hide only when `pending()===0` and warmSite is done.
- Impact: on WebGPU the GPU process keeps up, so P1's 8.5 s / 6.6 s frames become flowing frames, and compile wall time shrinks because Dawn compiles on worker threads. On WebGL2 with KHR_parallel, the per-program waits leave the main thread (2.2–3.5 s per phase in the lane, likely much more on slow drivers).
- Effort / risk: M / M. Risks: a few frames of pop-in in play; three's error scope spans awaits (`WebGPUPipelineUtils.js:252/315`), so an unrelated validation error can mark a pipeline `error` and it is never drawn.
- Owner: E2.
- Verify: needs a real-GPU pass. The lane has no KHR_parallel and no WebGPU, so there it can only show "no change".

**R2. No unpaced draws under covers.**
- What:
  - `'hold'` draws nothing (Infinity instead of 1000 ms, `perf.ts:180`). Warm frames still bypass the gate (`render/index.ts:1150`).
  - The meta drive screen counts as hold (`coverMode`).
  - Warm frames isolate every non-batch mesh, not only those under forced groups (`sitewarm.ts:218-223`).
  - Non-level objects (avatars, items, monsters, fixtures) register with the same warm queue (a PLAN §13 additive API).
- Impact: hub first frame 40–55 pipelines → at most the per-frame cap; facility 63 pre-warm pipelines → 0 unpaced.
- Effort / risk: S–M / low–M.
- Owner: E2 (+ integrator for the API).
- Verify: lane. No pipelines outside warm frames under covers; max pipelines per frame within the cap.

**R3. Fix warmSite's cost model.**
- What: charge the rAF interval that follows a warm frame to that frame, and cap at about 6 new pipelines per frame on sync paths (sketch (B)).
- Impact: warm frames bounded (today up to 24 pipelines per frame in the lane, and up to the 40-unit cap).
- Effort / risk: S / low.
- Owner: E2.
- Verify: lane for the logic; real GPU for timing.

**R4. No cold arrivals.**
- What: at the drive start, the server counts every connected, preload-capable client as wanting the site (sketch (E): a hello capability, bots excluded). For a client that did not preload, the arrival cover waits for warmSite up to 45 s instead of 12 s.
- Impact: tonight both friends arrived cold.
- Effort / risk: S / low.
- Owner: G4 (`meta/flow.ts`); `loading/index.ts` has no owner in the v1.2 table (`LoadingScreen.tsx` is G1), so the integrator assigns it.
- Verify: ws-bot test; lane.

**R5. Monster warm-up.**
- What: warm the real `dust`/`trail` meshes once per page. Remove the per-phase proxy re-warm and the `compileAsync` call (D).
- Impact: removes 2–4 big lit programs per phase change (35–85 ms each in the lane; on weak WebGL2 drivers my estimate is 0.3–2 s each), plus the first-sight compile of the Snatcher effects.
- Effort / risk: S / low.
- Owner: G2.
- Verify: lane. Pipelines created at a phase change go to 0.

**R6. Compile each level material once.**
- What: build each material with its final node graph, using placeholder textures of the same kind, and swap only the texture value when KTX2 lands. Fix the no-op wait in `prefetch` (`level/materials.ts:169-170`) or drop it (F).
- Impact: removes 15+ duplicate big programs per session.
- Effort / risk: M / M (colorSpace and sampler keys per backend).
- Owner: E3 (+ E2 `makeSurfaceMaterial`).
- Verify: lane. Program count stays flat when textures land.

**R7. Fewer and smaller lit programs.**
- What: per-material constants become uniforms; one shared prop material for GLBs (normalise at asset build or at load); replace `MeshPhysicalMaterial` glass; check whether every lit shader needs 17 spot + 9 point light arrays.
- Impact: 96 big fs → ≤67 from constants alone, → ~15–25 with unification. Compile work scales with program bytes (5.7 MB today).
- Effort / risk: L / M (look changes).
- Owner: E2 / E3 / G3 / E1.
- Verify: lane for counts; real-GPU look pass.

**R8. Deterministic, shared site batches.**
- What: replace each batch `InstancedMesh` with a Mesh + InstancedBufferGeometry and a matrix `positionNode` built from instanced attributes (`nodeAttribute` names are builder-local).
- Impact: about −30% programs, fewer node builds; batches reused across contracts and cacheable across sessions.
- Effort / risk: M / M (shadows, culling, raycasts, drawer animation).
- Owner: E3 + E2.
- Verify: lane for counts and screenshots.

**R9. Attribution telemetry.**
- What: per sample, add maximum rAF gap, longest LoAF (script, function, `blockingDuration`), hidden ms, and node builds / pipelines created in the window. Server: log `net.preload` asks per client.
- Effort / risk: S / low.
- Owner: integrator (`core/telemetry.ts`); request to ① net for the server side.

**R10. Voice keep-alive.**
- What:
  - Fail-open gates while a cover is up (crew in the van, in range).
  - An AudioWorklet energy gate, with the distance gain as an AudioParam updated at 30 Hz.
  - Move band/VAD and STT PCM to a Worker through a MessageChannel from the mic worklet.
  - The root fix is still R1–R3.
- Effort / risk: M / low–M.
- Owner: ④ voice. This is a request, since voice is frozen this round.

**R11. Menu backdrop.**
- What: stop compiling a separate test scene at the menu (91 pipelines, 3 s of link wait in the lane). For invite-link players who click JOIN at once, this probably overlaps the join.
- Effort / risk: S–M / low.
- Owner: E2.

## 4. Quick wins doable tonight (software lane, low risk)

1. G2: R5, monster warm-up. Check in the lane that the pipeline count at a phase change is 0.
2. G4: the server-side half of R4 (`crewLoaded` with a preload capability) and a bot test. The integrator adds the 45 s arrival cap for cold clients.
3. E2: `'hold'` → Infinity, and the drive screen counts as hold (part of R2). The 3D view is not visible there anyway.
4. E2: R3 minimal version: budget cap of about 6–8 units (or a pipeline-count cap) plus the next-gap cost, and isolation of all non-batch level meshes.
5. E3: make `prefetch` actually wait for its textures, or remove the `compileAsync`.
6. Integrator: telemetry fields from R9.

## 5. Open questions / not established

- **Real-GPU costs.** I could not measure the real per-pipeline cost (DXC on WebGPU, FXC through ANGLE on WebGL2), whether KHR_parallel is exposed on the friends' machines, or the effect of medium-preset GTAO and the mirror reflection warm. All of these need a real-GPU pass.
- **Reload cache effect.** The reload test (second load vs first, to measure GPU-cache link savings) did not fit in run 2's budget. My two runs are used up.
- **P2's drive-start trigger.** The monster re-warm is the strongest suspect but is unconfirmed. P2's 17.8 s mid-contract freeze is most likely a room reveal on the cold site, also unconfirmed. R9 telemetry would settle both.
- **Browser or desktop app.** I don't know which one the friends used.
- **Why P1 starts on medium.** Two candidates:
  - A stored `deadair.render.preset`. Auto-quality never climbs above its starting preset (`perf.ts:224`).
  - `gpuName()` reads only the WebGL renderer string; if that string lacks "RTX 50xx", the result falls back to medium (`presets.ts:46-66`).

Artifacts are in `<scratch>/night\perf-freezes\`:
- `run1\`, `run2\`: raw run data and reports
- `scripts\freeze-probe.mts`, `scripts\cache-probe.mts`, `scripts\analyze.mjs`, `scripts\frames.mjs`: the probes and analysis
- `proto\freeze-fixes.ts`: untested fix sketches
- `server.anon.log`: anonymised copy of the live log