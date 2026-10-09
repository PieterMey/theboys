# DEAD AIR synthesis plan (night of 8–9 Oct 2026, main = 25058ac)

This merges the 9 research reports into one plan, checked against the code, the live logs and the older logs. Legend for every claim:
- **[C]** verified in code by me
- **[M]** measured (I say by whom)
- **[I]** inferred or estimated

I changed no repo files, started no servers or browsers and made no AI calls. My scratch scripts are in `<scratch>/night\synthesis\`: `check-anon*.mjs` (confirms the anonymised logs hold no names) and `clients.mjs` (per-client backend summary, prints no names).

---

## 1. Top findings

1. **The multi-second freezes are shader compiles, and they predate v1.2.** [M]
   - The Oct 7 logs (v1.1, before `warmSite` existed) already show single frames of 8.2 s (host, WebGPU, Ultra), 10.8 s and 13.4 s (friends, at hub join) and 13.2 s (a friend, at drive start). Today's warm-up did not cause them.
   - The real causes are four [C, plus perf-freezes and gfx-pipeline]:
     - three r186 compiles synchronously in the render path;
     - frames draw the whole view without pacing (under the drive screen, and in the first warm frame);
     - there are too many programs (244 pipelines per Low site);
     - `warmSite` pacing grows its batch when the GPU stalls.
2. **The friends' freezes at drive start come from a drive flow that has never worked as designed.**
   - Meta prefers a pure `level.generateFacility` (`meta/adapters.ts:132-147`). The level module never exported one; git history has no such export, and the boot log lists level's exports without it. Meta therefore falls back to `generateFacilityForCrew`, which writes `crew.layout = L` (`level/index.ts:71`). The drive event then ships the facility (`core/context.ts:84-93`) [C].
   - Each client rebuilds the facility at once, and the 3D view draws it at full rate under the opaque drive screen. The drive screen is not a cover (`loading/index.ts:96`, `render/perf.ts:166-173`) [C].
   - The client asks for `net.preload` only after a 1.2 s sleep (`loading/index.ts:239-243`), and the server waits only for clients that asked (`meta/flow.ts:1366-1373`) [C].
   - Tonight the drive ended at exactly 12.04 s with no "preloaded" line for either friend [M, server.log]. P2's 15.9 s frame began about 0.4 s after the drive event [M]. Both friends then played a cold site.
3. **WebGL2 Low is the main path for remote friends, not a fallback.**
   - Of the 4 distinct remote friends seen on Oct 7–8, 3 always ran WebGL2 at preset `low`; 1 ran WebGPU at High with 4.6 ms median GPU time [M, `clients.mjs`].
   - Both of tonight's WebGL2 friends were on `low` from their first sample. Unknown GPUs default to `medium` (`presets.ts:60-71`), so their renderer string matched a low pattern (iGPU, GTX 1050/1060, MX, or a software adapter), or they had a stored preset [C+M].
4. **Whether the friends are CPU-bound or GPU-bound is not established. Two reports claim opposite answers, and neither has the data.**
   - WebGL2 telemetry has no GPU timing (`gpu -`).
   - The two-resolution hub samples suggest about 60–70 ms per megapixel, but both high-resolution samples were taken in join or brightness screens [M, weak].
   - The rtt-to-frame correlation (0.90) says the main thread is busy for most of each frame [M, perf-server-net].
   - Both can be true. The plan cuts both pixel work and per-draw work, so it doesn't depend on the answer.
5. **Low still pays for features it doesn't need, and the cuts are small, verified, low-risk edits** [C]:
   - shadow maps render for beams that are switched off (`flashlights.ts:431-436`);
   - batched lights at intensity 0 stay in the per-pixel loop, which has no range or intensity check (three `SpotLightDataNode.js:117-160`); the count is a uniform, so hiding them needs no recompile;
   - a velocity buffer is written without TRAA (`pipeline.ts:276-279`);
   - bloom, CA, vignette and grain run on every preset (`:321-332`);
   - the scene is audited every 5 s (`index.ts:1222-1226`);
   - `setPreset` rebuilds the whole pipeline even when the preset is unchanged, and it is re-applied 600 ms after every welcome (`index.ts:686-693`, `meta/index.ts:139-143`).
6. **The host is on Medium because of a stored choice.** The stored value beats GPU detection (`index.ts:183-186`), auto-quality never climbs above the starting preset (`perf.ts:224`), and the settings menu has no AUTO entry (`meta/menus.tsx:85`, `menu/panels.tsx:162`) [C]. perf-server-net's "the governor did it" is wrong: `pr 0.75` is the Medium 1920 cap divided by 2560 CSS px, not an auto-quality scale.
7. **Display names are unfiltered, and the join filter alone would leave a hole.** `cleanName` (`core/crews.ts:80-83`), `profile.set` (`net/reqs.ts:14`) and `sanitizeProfile` (`meta/flow.ts:383`) only strip control characters and `<>` [C]. A player can join under a clean name and rename later through `profile.set`. Names reach `Utterance.speakerName` (`messages/ai.ts:18`), AI prompts, Whisper hotwords, mirror writing and saves.
8. **The AI is cheap but mostly idle during contracts, and two infrastructure gaps limit new AI features.**
   - Cost is $0.0143 per session [M]. The Listener heard 0 of the friends' 55 transcripts and woke with 0 lines in memory twice [M].
   - Roughly half of speech segments produce no text (58 of 120 empty in contract 2) [M].
   - No prompt caching: 0 of 218 usage rows show cache reads, and the system prompt is sent as a plain string (`ai/gateway.ts:440-449`) [C].
   - TTS spend is logged as `usd: 0` (`gateway.ts:183`) [C].
   - The STT CPU fallback (Whisper int8) takes about 4 s per clip [M, ai-tech]. With `sttTimeoutMs` 4000 (`ai.json:3`), every request would time out if CUDA fails [C].
9. **Telemetry cannot answer the open questions, and adding fields isn't free.** The server-side parser whitelists fields (`net/telemetry.ts:60-75`) [C], and net is frozen this round. Use a new integrator-owned request instead.

## 2. Evidence: what is measured, verified or inferred

| Claim | Status | Source |
|---|---|---|
| Drive event carries the facility layout | C | `meta/adapters.ts:132-147` (prefers `generateFacility`), level exports at boot (server.log: `generateFacilityForCrew, hubLayout, install, levelOf, levelTuning, summarize`), `level/index.ts:71`, `meta/flow.ts:734-745`, `core/context.ts:84-93`; `git log -S` finds no export ever |
| Van left without the friends | M | server.log: drive 22:54:43.8 → contract 22:54:55.9 (12.04 s), no `[loading] preloaded` line for either friend; host's solo drive waited 28.4 s |
| 3D view draws at full rate under the drive screen | C | `holdOk()` (`loading/index.ts:96`), `coverMode` (`perf.ts:166-173`), inputs (`render/index.ts:984-991`); `'hold'` = 1 draw/s (`perf.ts:180`) |
| Monster warm-up on every phase, twice, with fresh InstancedMesh proxies | C | `monsters/index.ts:968-969`, `:182-187`; render-object key includes `object.uuid` for InstancedMesh and the context id (three `RenderObject.js:846-854`) |
| Uniform-array instancing gives each batch its own program; capacity ≥1025 uses attributes | C | three `Instance.js:41-66`; `level/sitebatch.ts:41-43` allocates exact capacity |
| `warmSite` counts GPU stalls as idle time and grows its batch to 40 | C | `sitewarm.ts:190`, `:236-239` |
| Off beams still render shadow maps; parked slots stay in the light loop | C | `flashlights.ts:376-389`, `:431-436`; `SpotLightDataNode.js:52,73-75,117-160`; fixtures already hide parked lights (`render.json` `hideParked`) |
| Velocity, bloom, CA and grain on Low | C | `pipeline.ts:276-279, 321-332` |
| Stored preset, ceiling, no AUTO, re-apply on welcome, no unchanged-check | C | `index.ts:183-186, 384-394, 686-693`; `perf.ts:224`; `meta/index.ts:139-143` |
| Freezes existed in v1.1 | M | Oct 7 server.log: host 8,231 ms; friends 10,848 / 13,382 ms at hub join; 13,193 ms at drive |
| 3 of 4 remote friends on WebGL2 | M | `clients.mjs` over both logs |
| Name paths | C | `core/crews.ts:80`, `net/reqs.ts:14`, `meta/flow.ts:383`; `blocked()` used only for lures (`ai/lure.ts:201`) |
| No prompt caching; TTS not priced | C+M | `gateway.ts:440-449, 183`; 0 of 218 usage rows with `cacheR > 0` |
| STT fallback times out | C+M | `server.py:243`, `ai.json:3`; about 4 s on CPU (ai-tech) |
| Cloudflare doesn't cache `.glb`, `.ktx2`, `.wav`, `.wasm` or `.json` by default | M (docs) | [Cloudflare default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) |
| Runtime ElevenLabs is enabled but has never fired | C+M | `flags.json` `listenerVoice: true`; 0 `lure.tts` usage rows (ai-tech) |
| Lane numbers (draws, pipelines, potato −52% / −55%) | M (SwiftShader lane) | gfx-pipeline `run1/run2.json`, perf-lowend `run2.json`, perf-freezes `run1/run2`. JS times and counts are real; GPU times are not |
| ElevenLabs v4 Turbo price and latency | M (secondary sources only) | [eesel](https://www.eesel.ai/blog/eleven-v4), [Digital Applied](https://www.digitalapplied.com/blog/eleven-v4-turbo-voice-agents-latency-pricing); confirm on the official pricing page |

## 3. The plan

### Tonight, part 1: fixes that matter most for players now

Order is priority. Every item is software-lane verifiable. Lane runs go through `node tools/gpu-guard.mjs --max-sec 120 -- node tests/<track>/<name>.e2e.ts`. Every item also needs `npm run check` and `node --test` for its unit tests.

Reusable harnesses from tonight (copy into your own `tests/<track>/`):
- `night/gfx-pipeline/run2x.e2e.ts`: draws, pipelines, attribution
- `night/perf-freezes/scripts/freeze-probe.mts`: per-phase builds, pipelines and gaps
- `night/perf-server-net/{drive-probe,bots,srv}.mts`: drive flow and bytes
- `night/ai-design/name-filter-fold.ts`: name evasion probe

**P1. Name safety (do this first, then deploy).**

| # | What | Owner | Effort / risk | Verify |
|---|---|---|---|---|
| 1a | New `packages/shared/src/names.ts`: a fold step (NFKC, strip marks, confusables, leet, strip separators and zero-width, collapse repeats), a hate/sexual/harassment blocklist (EN+NL), reserved names (Listener, Company, HR, Admin, Claude, System), and `safeDisplayName()`. A blocked name becomes `Contractor-NNNN` and the player gets a private notice. Apply it in `cleanName` (`core/crews.ts:80`). | integrator | S / low (about 3 of 72 false positives, which become a rename) | Unit test with benign proxy words: 94 of 96 evasions caught vs 42 of 96 today (ai-design probe). Bot join with a blocked proxy name shows `Contractor-NNNN` in the roster. |
| 1b | The same call in `profile.set` (`net/reqs.ts:14`). Without it, renaming bypasses 1a. | ① net is frozen: integrator grants a one-line exception | S / low | Bot `profile.set` rename test |
| 1c | `sanitizeProfile` (name and visor glyphs, `meta/flow.ts:383`); skip blocked quotes (`meta/review.ts:32`); add the disclosure line "some voices are AI-generated" (`menus.tsx:365`) | G4 | S / low | Unit tests |
| 1d | Guard `mirrorName()` output (E4); mask slurs in proximity chat (`players/index.ts:372`, G1) | E4, G1 | S / low | Unit tests |

Filtering at the source also cleans `speakerName`, AI prompts and hotwords for new joins. Player speech quoted in memos stays unfiltered (ai is frozen: request it for next round).

**P2. No more cold arrivals (the drive flow).**

| # | What | Owner | Effort / risk | Expected / verify |
|---|---|---|---|---|
| 2a | Send `net.preload` before the 1.2 s paint sleep; build after it. Arrival cover waits up to 45 s (not 12) for a client whose preload did not finish (`loading/index.ts:239-243, 281`). | integrator (`loading/index.ts` has no v1.2 owner) | S / low | The request leaves before the freeze. Bot test plus one guarded 2-client lane drive. |
| 2b | Additive `ServerPlayer.bot` flag (`hello.build === 'bot'`, `core/crews.ts`). `crewLoaded` then waits for every connected non-bot, non-observer player, capped by `driveLoadWaitSec` (30 s). | integrator + G4 (`meta/flow.ts:1366`) | S / low | Bot that asks late or never: van waits ≤30 s and bots are never waited for |
| 2c | Drive phase counts as `'hold'`; `'hold'` = no normal frames (Infinity, `perf.ts:180`); warm frames still draw but isolate every non-batch mesh (`sitewarm.ts:218-223`) | E2 | S–M / low–medium | Lane: zero pipelines created outside warm frames during the drive; per-frame pipelines stay within the cap |
| 2d | Monster warm-up once per page using the real dust and trail meshes; remove the per-phase double re-warm and the default-context `compileAsync` (`monsters/index.ts:182-201, 968-969`) | G2 | S / low | Lane: 0 new pipelines at a phase change |
| 2e (optional, gated) | Export a pure `generateFacility(req)` from `apps/server/src/level/index.ts` (alias the shared import) so the existing adapter stops writing `crew.layout` at drive start. Drive event drops from about 155 KB to about 14 KB, and clients stop rebuilding at the drive event. This activates the hub-during-drive path for the first time, so run the drive and v12r gates and the 2-client lane drive. | E1 | S / medium | `drive-probe.mts` bytes per `setPhase`; gates |

Expected [I]: tonight's failure mode (van leaves at 12 s, cold contract, 6–18 s freezes in play) cannot recur. The compile work moves behind the drive screen, which can then last up to 42 s. Total compile work is unchanged until P3 lands.

**P3. Fewer compiles.**

| # | What | Owner | Effort / risk | Expected / verify |
|---|---|---|---|---|
| 3a | Site batches use the instanced-attribute path: `new InstancedMesh(g, m, Math.max(cap, 1025))` (`sitebatch.ts:43`) | E3 | S / low (+64 KB per batch) | Expected −40 to −50 pipelines per site; instanced vertex programs 57 → about 10 [I, gfx-pipeline]. Count with `run2x`. |
| 3b | Placeholder 1×1 textures from the start; swap `.value` when the KTX2 arrives, so each level material compiles once (`level/materials.ts:183-218`) | E3 + E2 (`makeSurfaceMaterial`) | S–M / medium (colour-space and sampler keys) | No material compiles twice in attribution; −15+ big programs per session [M lane] |
| 3c | `warmSite` cost model: charge the next rAF gap to the frame; cap about 6 units per frame on WebGL2 and about 4 signatures per frame on WebGPU (`sitewarm.ts:190, 236-239`) | E2 | S / low | Lane: `siteWarm().maxFrameMs`. The host's 6.6 s frame becoming several ≤0.3–1 s frames is [I] and needs real-GPU or friend telemetry. |
| 3d | `setPreset`: do nothing if the preset is unchanged (`index.ts:686`) | E2 | S / low | Lane: no node rebuilds after welcome. Removes a full pipeline rebuild 600 ms after each join for anyone with a stored preset, the host included [I, cost unmeasured]. |
| 3e | No 3D menu backdrop on Low or WebGL2; show a static image (`index.ts:792-806`) | E2 | S / low | Lane: −67 to −91 boot programs [M, perf-lowend / perf-freezes] |

**P4. Cheaper Low frames.**

| # | What | Owner | Effort / risk | Expected / verify |
|---|---|---|---|---|
| 4a | Arm a shadowed slot only when its beam is on or fading (`flashlights.ts:431-436`) | E2 | S / low | Lane: 76 → 0–38 shadow draws with beams off (−37% of draws) [M+I] |
| 4b | `visible=false` for parked flashlight slots and the zero-intensity mirror bounce/rim lights (E2); same for flare and flashbulb lights (`interaction/visuals.ts:2262-2283`, G3) | E2, G3 | S / low, no recompile [C] | −10–15% per-pixel lighting work on real GPUs [I]; pipeline count must stay flat |
| 4c | Velocity MRT only when TRAA is on (`pipeline.ts:276-279`) | E2 | S / low | Lane counts; drops one RGBA16F write and previous-frame skinning |
| 4d | `auditSceneMaterials` only in test or dev | E2 | XS | – |
| 4e (stretch) | `lite` preset, opt-in only (`?preset=lite` plus a settings entry): own beam shadowed only, tone map + vignette in one pass (no bloom, CA, TRAA or velocity), no GI, closed-form fog, noise-free surface variant, cap 1280×720 with a 0.5 rung, low-poly halos | E2 | M / medium (look) | Lane: the potato prototype measured −52% SwiftShader frame and −55% main thread [M]. Real gain on friends' GPUs [I]: 65–74 → about 25–30 ms. Friend A/B next session. |

**P5–P8. Telemetry, settings, host actions, small core fixes.**
- **P5. Telemetry v2 (integrator, S).** Add a new integrator-owned request (for example `core.diag`) logged without names, once per join and on any backend or preset change. It avoids the frozen net parser.
  - Once per join:
    - GPU vendor and tier bucket;
    - backend and the WebGPU fallback reason (`navigator.gpu` missing / adapter null / device error);
    - browser brand and major version;
    - desktop app or browser;
    - cores, device memory, `KHR_parallel_shader_compile`;
    - preset source (URL / stored / auto / safe mode).
  - Per window:
    - largest rAF gap;
    - main-thread blocked time (Long Animation Frame entries with top script);
    - pipelines and node builds created;
    - draw calls.
- **P6. "AUTO (detected: X)" in both preset menus (G4).** Choosing it clears the stored preset; with AUTO, the ladder ceiling becomes the detected preset (E2, `index.ts:186`, `perf.ts:224`). The host keeps Medium (Decision 3).
- **P7. Host-only actions, no code.**
  - (a) Cloudflare Cache Rule for `/assets/*` and `/app/*`, excluding `/ws`, `/api/*` and `/healthz`, plus Smart Tiered Cache. Verify with two `curl -sI` on a hashed `.ktx2`: expect `cf-cache-status` MISS, then HIT.
  - (b) Ask both friends for `chrome://gpu` (Firefox: `about:support`) and whether they used the browser or the desktop app. Five minutes, and it settles most open questions.
- **P8. Optional core one-liners (integrator, S each).**
  - Stop feeding pong midpoints into `observeServerTime` (`core/net.ts:244`). Unit-test it with `clocksim.mts`: interpolation delay −35 to −50 ms and clock jumps 65–78 → ~20 ms for slow clients [M, simulation].
  - Skip STT chunks when `ws.bufferedAmount` > 32 KB (`core/net.ts:386`).
  - Log protocol-level ping RTT per socket (`core/ws.ts`), to separate network from frame time.
  - `keepAliveTimeout` 95 s (`core/http.ts:64`).

**E2 load.** E2 owns most of P2–P4. Suggested order: 4a, 4c, 3d, 4d, 2c, 3c, 3e, 4b, then 4e. Each edit should be complete and shippable alone (the shared dev servers import every file).

### Tonight, part 2: first feature slices (no GPU; frozen tracks untouched)

None of these needs a real GPU. They respond to three signals that show up in several reports: dead players have nothing to do, talking is mostly punished, and the Listener never hears the crew. New flags (all default off) are added by the integrator in `config/flags.json`: `deadPokes`, `earwigs`, `companyLine`, `siteRules`.

| # | Slice | Owner | Effort | Why now | Verify |
|---|---|---|---|---|---|
| F1 | Listener wake fix: if it has heard nothing meaningful by wake time, stay dormant until its first meaningful line (at most 90 s more). Log "heard N lines (M before waking), nearest speaker D m" at contract end. | G2 | S | It woke with 0 lines in memory both times | Unit test plus a bot contract with dev proximity text |
| F2 | Snatcher from the crew's 3rd contract (`snatcher.minContractIndex` 1 → 2, `monsters.json:140`) | G2 | XS | Friends met 3 monsters on their first contract, because the host's solo run had already moved the counter | `dbg` contract index 1 has no Snatcher |
| F3 | Noise lure and field receiver items (`ITEM_DEFS`); Hound treats a lure like a bottle | G3 (+1 line G2) | S each | Recipes exist but the workbench hides them (15 of 17 offered) | Unit test plus bots |
| F4 | Dead pokes v0: implement `paranormal.poke` with knock 1–3 (8 s cooldown, 4 m noise) and flicker of the watched room (20 s cooldown); spectator buttons | E4 + G1 | S–M | Both friends left within 32 s of the second death | Unit test for cooldowns; two-bot test; one guarded 2-browser lane shot |
| F5 | Company Line v0, rule mode: phone call at shift start, typed lines, keyword classifier, the bounded deal engine (quota −10% … +15%, from ai-design's `negotiation-engine.ts`, which held its bounds over 100k fuzzed calls), `CrewSave.companyFile`, LLM hook stubbed as `// TODO(ai)` | G4 | M | The host's main AI ask; LLM routes need (e), which is frozen | `node --test` bounds fuzz; mock-mode lane UI shot |
| F6 | Earwig server slice: route-placed ears relay what they hear to the dormant Listener; a lit ear is deaf for 6 s; tick cue. The client mesh reuses the Listener's material and is warmed with the monster templates (no new programs). | G2 | S–M | Simulated pre-wake hearing rises from 0.0–0.3% to 48–76% [I, concepts-monsters sim] | Unit test for coverage; bots |
| F7 | Site Rules v0 for 2 sites (spoken digits ring the foundry bell; a spoken callsign rings that room's phone), using public `onUtterance` (`ai/api.ts:36`) and existing synth sounds | E4 + G4 (rule-card text) + E5 | S–M | 18 site memos promise house rules that don't exist | `node --test` with synthetic utterances |

Not tonight:
- **The Ledger**: the highest safety risk, and it needs an LLM.
- **Séance with LLM compression**: it needs (e). The typed closed-word-list version can follow F4 if E4 has capacity.
- **Freight Lift wipe insurance**: needs objectives, which is frozen.
- **Voice-dependent monsters**: Ventriloquist and Echo.

### Graphics direction

**The recommendation: stay on three r186 and rebuild the pipeline around hard budgets.**
- Make **WebGL2 "Lite" the first-class target**, because 3 of the 4 remote friends run WebGL2.
- Adopt gfx-art's **"SIGNAL" bodycam look** so that low resolution looks intentional: integer pixel scaling with `image-rendering: pixelated`, Bayer dithering, and a full-resolution OSD.
- Reject a Babylon, PlayCanvas or custom WebGPU rewrite. It is extra-large effort, the draw and program counts come from our content rather than the engine, and a WebGPU-only renderer would drop most of the actual audience.

| Phase | Content | When | Real-GPU OK needed? |
|---|---|---|---|
| A: stop the bleeding | P2–P4 above, plus a budget gate `tests/render/budget.e2e.ts` (from `run2x`): Low ≤140 draws, ≤120 pipelines per site, 0 shadow draws with beams off, no frame-loop compile after a cover drops | Tonight to 2 days | No (counts) |
| B: Lite and freeze-proofing | Lite as default for WebGL2 after a friend A/B. SIGNAL look on Lite/Low. Ladder rework: don't cut resolution for compile hitches, detect CPU-bound clients and step to Lite. Async compile behind a flag (`getForRender(ro, promises)`; `isReady` draw gate, `Renderer.js:3895` [C]; covers wait for pending = 0). Material constants as uniforms; noise volume instead of `mx_fractal_noise` | Next 1–2 sessions | Async compile: yes (the lane has no WebGPU or KHR_parallel), or the friend lane below |
| C: content consolidation | One draw per room shell, shadow proxies, door and item instancing, room-local light lists in the light grid, uber-materials | 1–2 weeks | Visual check only |
| D: WebGPU tiers | Single-pass MRT (drop the GTAO pre-pass), TAAU for 4K, beam march v2, SSGI/SSR on Ultra, BundleGroup retest | 2–3 weeks | Yes |
| Art track (parallel) | Halos → soft sprites; beam dust motes (one draw); crew bodies from Quaternius UBC (CC0, same rig); monster materials; Listener "signal corruption" effects; death shown as a "NO SIGNAL" card | Rolling | Look-dev of bloom, halos and TAAU: yes |

**A real-GPU lane that doesn't use the host's GPU:** a consented `?diag=1` session on a friend's own machine. It would run a scripted 60 s A/B (low vs lite, async compile on vs off) and report through P5. The friends' machines are the target hardware anyway.

### Next sessions backlog (ranked)

1. Async compile mode (Phase B) plus the follow-up telemetry. It is the root fix for compile freezes on real GPUs.
2. Lite as default for WebGL2, the SIGNAL look and the ladder rework, after one friend A/B.
3. Material uniforms, noise volume and the noise-free Lite variant. Target ≤150 pipelines per site and ≤20 KB fragment shaders at Lite.
4. Voice, once unfrozen: gates that fail open under covers, an AudioWorklet gate, VAD/STT off the main thread, Opus DTX.
5. AI platform, once (e) is unfrozen:
   - per-player rate limits;
   - `cache_control` on system blocks;
   - TTS priced in the $ budget;
   - name-safe quotes and hotwords.

   Then the Company Line with an LLM, the séance and code-word cracking. The Ledger only after a red-team pass.
6. STT: Parakeet int8 on CPU (104–253 ms per clip [M, ai-tech]) as the fallback first, then possibly the default; sticky language per speaker; drop-reason counters.
7. Network:
   - send the layout in FullState only when the receiver lacks its hash (−440 KB per player per contract [M]);
   - async saves;
   - later, the socket in a Worker and compact snapshots.
8. Content consolidation (Phase C).
9. A missions registry (new G7 package) with Freight Lift, Wiretap, Breaker Panel and True Name; Site Rules for all 18 sites.
10. More monsters: Choir, Weeper, Visitor, a wildcard slot.
11. WebGPU tiers (Phase D).
12. Crew and monster art.

### Decisions the host must make

1. **Names.** Recommended:
   - block a name and rename it to `Contractor-NNNN` with a private notice, rather than refusing the join;
   - OK a one-off scrub of the slur from `saves/` (player saves, personnel files, stored memos);
   - deploy P1 to live tonight, when nobody is connected (the restart drops players).
2. **Look and low-end default.** Recommended: Lite (with the optional SIGNAL pixel look) opt-in tonight, and the default for WebGL2 after one friend session of telemetry. This is a taste call.
3. **Real-GPU verification and your own preset.** Recommended:
   - use consented diagnostic sessions on the friends' machines rather than real-GPU passes on your RTX 5090;
   - keep your own client on Medium while the PCIe fault persists. AUTO will exist, but use it only if you choose to.
4. **AI next round.** Recommended:
   - unfreeze (e) for the platform fixes, then the Company Line LLM and the séance;
   - resolve the policy conflict: CLAUDE.md says ElevenLabs runs at build time only, but `listenerVoice` enables runtime lures. Allow runtime TTS only for short lines inside a $-priced shared budget, with the boss defaulting to a free "corporate mumble" plus subtitles;
   - OK a capped live check (under $0.05) to measure steady-state Haiku latency with streaming and caching, and to red-team the Ledger;
   - limit Ledger targets on teammates to haunt and protect.
5. **Cloudflare zone.** Recommended: add the Cache Rule and Smart Tiered Cache from P7. About 60 MiB of assets are not edge-cached by default, so the host's uplink serves every new player.

### Risks and dependencies

- **Frozen tracks.** net, ai, stt, voice and objectives are frozen. P1b needs a net exception. Telemetry must go through a new core request. Voice robustness, the STT fallback, AI routes and wipe insurance wait for the next round.
- **E2 is the bottleneck.** Keep its edits serial, each one complete and shippable alone.
- **Recompiles and looks.** Pipeline, MRT and material changes recompile everything once at load and may change the look. Gate them on pipeline counts (they must not rise) and on lane screenshots.
- **The drive flow is new territory.** 2e runs a path that has never run in production. Run the drive and v12r gates and watch spawn positions. 2b can hold the van 30 s for a client that never reports loaded, so bots must be excluded or tests slow down.
- **Private three.js API.** Async compile (Phase B) relies on private three r186 internals. Keep three pinned. The WebGPU error-scope behaviour over awaits can mark a pipeline as errored, so it is never drawn.
- **What the lane can't show.** SwiftShader has no KHR_parallel and no WebGPU, so GPU-side effects stay [I] until there is friend telemetry or the host OKs a real-GPU pass.
- **Total compile time is unchanged by P2.** A full site warm took about 25 s even on the host (preload 28.4 s, probably hitting the 25 s cap [I]). Weak machines will still arrive partly warm until P3 and Phase B land.
- **Privacy.** Bucket the GPU strings in P5, and never write names into the new log lines.

## 4. Quick wins doable tonight (software lane, low risk)

- P1a–P1d (names);
- P2a, P2b, P2c, P2d (drive flow);
- P3d, P3e;
- P4a–P4d;
- P5 (telemetry), P6 (AUTO);
- P8 core one-liners;
- F1, F2, F3.

All verify with `npm run check`, `node --test`, bot tests, and at most a few guarded SwiftShader runs.

## 5. Open questions

- The friends' GPU, browser and shell, and why WebGPU was unavailable. Answered by P7b and P5.
- The CPU, GPU-process and fill split on the friends' machines. Needs P5 per-window data and the `?diag=1` A/B.
- How much of each giant frame is main-thread blocking and how much is a GPU-process stall. Telemetry "frame time" is the rAF interval, so it can't tell them apart. On WebGPU (Dawn) and likely on ANGLE D3D11 (lazy executables), the compile can stall the GPU process while the main thread is free [I]. Main-thread fixes (deferred node builds) may not remove those stalls. Long Animation Frame data in P5 separates the two.
- What started P2's 17.8 s mid-contract freeze (about 23:00:03). Nothing is logged around then.
- Whether the evening's extra ~65 ms of RTT was the network or main-thread queueing. The P8 protocol-level ping answers it.
- Steady-state Haiku 5.5 time-to-first-token with streaming. Every in-game sample so far was a cold warm-up.
- Whether a Cloudflare Cache Rule already exists, and the host's uplink speed.

---

## Critic notes (what the reports missed or got wrong)

1. **The brief's freeze hypothesis is only partly right.** v1.1 (Oct 7) had equal freezes, 8–13 s, before `warmSite` existed. `warmSite`'s pacing can enlarge frames on WebGPU, but the root causes are the program count, synchronous compiles and unpaced draws.
2. **The drive preload never ran as designed.** perf-server-net found the side effect, but proposed removing it, which would break the join and contract fallbacks that depend on it. The safe fix is an additive pure export (2e). Even then it activates an untested path, so the low-risk fixes (2a–2d) should go first.
3. **CPU-bound vs GPU-bound is overclaimed on both sides.**
   - perf-lowend ("GPU-bound") rests on a hub comparison across different screens (field guide vs none).
   - gfx-pipeline and perf-server-net ("CPU-bound") have no GPU timing at all.
   - perf-lowend's "v1.2 is 23% slower than v1.1" compares a 1-player contract with a 2-player one (an extra beam and avatar), so it is confounded.
4. **perf-server-net's "the governor put the host on Medium at 0.75" is contradicted by the code** and by the localStorage evidence (stored `medium`; `pr` is the cap divided by the CSS width).
5. **Nobody flagged that new telemetry fields can't reach the log without touching frozen net code** (`net/telemetry.ts` parser whitelist). That makes "add telemetry" harder than the S effort the reports gave it.
6. **The `setPreset` re-apply 600 ms after every welcome**, a full pipeline rebuild for anyone with a stored preset, was only mentioned in passing. It is a likely contributor to the host's 8.5 s join freeze [I].
7. **No report proposed the friends' machines as the real-GPU lane.** While the host's GPU is faulty, it is the only real-hardware option, and it is the actual target.
8. **The STT dependency on the faulty RTX 5090 is a reliability risk, not only a latency one.** If CUDA fails, the current CPU fallback times out, and the Listener goes deaf.
9. **Moderation beyond the filter is missing.** `crew.kick` exists, but there is no ban or forced rename, so a kicked player can rejoin under the same name.
10. **The strongest design signals come from convergence across reports, which none of them called out:**
    - dead players need something to do (concepts-world, concepts-monsters, ai-design);
    - talking must sometimes pay off (the same three);
    - the Listener must actually hear the crew (concepts-monsters, ai-design, concepts-world).

    These drove the part 2 ranking.
11. **Minor:** gfx-pipeline's "≥10 s" stall for P3 at contract start is the safe reading. The 39 s gap between log lines is the server's 30 s throttle plus late sends, not proof of a 39 s freeze.