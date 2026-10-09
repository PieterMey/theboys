## gfx-art report: art direction and the biggest visual win per GPU cost

I changed no repo files (`git status` shows only the `tests/playlist/v11/` folder that was already untracked). I did one guarded software-lane run. It exited 0 after 92 s, on my own backend (:3813, dev mode, mock AI) plus `tests/gates/v12r-proxy.mjs` (:3814) serving a temporary production build. I killed both PIDs afterwards. Nobody was connected to :3000 at any point. Everything I made is in `<scratch>/night\gfx-art\`.

### 1. Top findings

1. **The weak-PC image looks broken, not styled, and it is the most common view.** Both friends tonight, and 3 of the 4 friend clients on Oct 7, ran the WebGL2 Low path.
   - Tonight they rendered 960×364 and 960×476. The browser then stretched that 3.6–4× with bilinear filtering onto 3440- and 3840-pixel monitors.
   - P3's frame is about 457k pixels. Lethal Company's default 860×520 is about 447k: the same pixel count. Lethal Company looks deliberate because it is point-filtered (no smoothing) and posterized on purpose.
   - **The cheapest big visual win is to make low resolution intentional.** That means four pieces:
     - scale up by whole numbers with sharp pixels (CSS `image-rendering: pixelated`);
     - ordered dithering at the render resolution;
     - no bloom or chromatic aberration on Low;
     - an overlay drawn at full screen resolution that frames the image as a bodycam feed.
   - I prototyped this inside the live r186 pipeline (about 15 TSL lines plus one CSS property). It compiles and runs on the WebGL2 backend. GPU cost is zero or lower than today.
2. **The friends' frame time is mostly per-pixel shading cost.**
   - From Oct 7 telemetry, where each friend appears at two resolutions in the hub: about **62 ms per megapixel**, plus 10–17 ms of fixed cost. The 4K@150% friend: 1600×794 gave a median of about 88 ms, 960×476 about 38 ms. The ultrawide friend: 1600×606 about 77 ms, 960×364 about 39 ms.
   - Low fragment shaders are very heavy:
     - 50–79 KB of GLSL each; the largest is 2,387 lines;
     - each pixel loops over 10–11 analytic lights at contract start;
     - each pixel samples two shadow maps, the light grid and a 3D noise texture;
     - each pixel computes MaterialX Perlin noise (5 octaves in the largest program).
   - Cutting this per-pixel cost is the second-biggest win.
3. **The art direction is split.**
   - The 2D UI is the best art in the game: Company forms, stencil type, hazard stripes, "CH 07 · 104.7 MHz · NO CARRIER".
   - The 3D world is generic "realism-lite": photoreal Poly Haven props next to procedural boxes and stock mannequins.
   - Proposed direction, **"SIGNAL"**: every frame is a Company bodycam feed. Feed quality is part of the fiction, which gives every preset a reason to look the way it does.
4. **Characters and monsters look like stock assets.**
   - The crew are bare Quaternius UAL mannequins with tinted "suits", which reads as nude dummies (`players/avatars.ts:80-150`).
   - The Hound looks like a husky in light; the Mannequin is an art-store wooden dummy (`tests/artifacts/monsters/contact-sheet.png`).
   - The TV-visor helmet is the best character idea in the game. Keep it and replace the bodies.
5. **Free lighting fixes:**
   - Fixture "halos" are flattened ellipsoid shells (`render/fixtures.ts:255-278`) that render as solid white saucers (`render/v12/run4/ultra_room.png`, `world/r2/hospital_corridor.png`).
   - Low has no volumetrics, so its flashlight beams have no dust or air at all.
6. **The host's MEDIUM preset is almost certainly a stored manual choice, not GPU detection.**
   - Preset precedence is URL, then stored, then the GPU heuristic (`render/index.ts:183-186`).
   - Only the settings menu writes the stored value (`index.ts:688`). Auto-quality never saves its choice.
   - The heuristic maps "RTX 5090" to ultra (`presets.ts:57`).
   - Telemetry shows the host on medium since at least Oct 7 11:35.
   - Medium caps rendering at 1920×1080, so the host's 4K@150% screen gets 1920×1027 stretched 2×. GPU time is only 0.7–1.3 ms; the frame is CPU-bound.
7. **Auto-quality turns hitches into blur.** On Oct 7 a WebGPU friend (ultrawide, preset High, GPU 1–7 ms) was stepped down from High at 2560×945 to Low at 960×354 within about 8 minutes, because of long frames. At Low it then ran 139–171 fps and never climbed back.
8. **Gate-R screenshots give a misleading look.** They are taken with `levelLight=1`, which adds a debug hemisphere light of 3.5 and turns fog off (`level/index.ts:1009-1015`). They make the game look brighter and flatter than players see it, so art reviews should use runs without that flag (my run didn't use it).
9. **Shader variety has a cost.** One hub plus one facility contract on Low/WebGL2 produced **130 fragment programs** (126 vertex, 173 pipelines), each 50–79 KB. Variety comes from separate shader graphs, not data. On ANGLE/D3D11, the first compile of shaders this size is slow. This may explain the 6–18 s freezes; that's the perf-freezes agent's area, not something I verified.

### 2. Evidence

**Tonight's telemetry** (live `logs/server.log`, players anonymized; my labels match the task's):

| | Backend / preset | Screen (CSS@dpr) | Render resolution | Stretch factor | Hub median frame | Contract median frame |
|---|---|---|---|---|---|---|
| P1 host | WebGPU medium | 2560×1369@1.5 (4K) | 1920×1027 (medium cap) | 2.0× | 4.2–4.4 ms | 4.3–10 ms (GPU 0.7–1.3 ms) |
| P2 | WebGL2 low | ~3430×1300@1 (3440 ultrawide) | 960×364 (pixel ratio 0.28) | 3.6× | 37–66 ms | ~74 ms (13 fps) |
| P3 | WebGL2 low | ~2550×1265@1.5 (4K) | 960×476 (pixel ratio 0.38) | 4.0× | 40–57 ms | ~53–65 ms |

The weakest friend on Oct 7 (1440p monitor, WebGL2) had a contract median of about 110 ms (9 fps), with 25–75 long frames per window. Friends on WebGL2 also means their browser offered no WebGPU adapter.

**Software-lane counts** (WebGL2, Low, facility contract; `run1/notes.json`):
- 139–219 draw calls and 160k–500k triangles per frame. CPU-side submission cost is modest.
- Lights at contract start: 8 of 16 unshadowed spotlights on, 2 of 7 point lights, 1 of 2 shadowed beams, 1 hemisphere light. Light caps are 17 spots and 9 points (`index.ts:202-204`). DynamicLighting makes every fragment loop over all active lights.
- 130 fragment programs; 118 contain loops. The median lit program is 53.8k characters.
- The largest program (`run1/biggest-fragment.glsl`, 78.9k characters) contains:
  - 2 `mx_fractal_noise_float` calls, 2 + 3 octaves; each octave is a 3D gradient noise with 8 integer hashes;
  - 2 shadow samplers (`sampler2DShadow`);
  - a loop over a grid table (13 `textureSize` calls);
  - a 3D texture sample.
- Per-pixel MaterialX noise appears in `render/materials.ts:88-89,115,130,151`, `monsters/models.ts` (8 uses), `level/van.ts` (4), `players/cosmetics.ts` (3), `monsters/index.ts` (3) and `paranormal/figure.ts` (2).
- Low pays for passes it doesn't use:
  - Bloom runs on every preset, including Low: 12 passes (1 bright pass, 5 mip levels × 2 blurs, 1 composite) (`pipeline.ts:321-324`).
  - Chromatic aberration, vignette and grain also run on every preset (`pipeline.ts:328-332`).
  - The scene pass writes a velocity buffer even when temporal AA is off (`pipeline.ts:277`; it's only read at line 325). On Low that velocity output is wasted, and skinned meshes pay previous-frame skinning for it.
- SwiftShader ran at 2–5 fps at 640×360 here. The friends are 20–30× faster per pixel than that, so they have real but weak GPUs, not software rendering.

**In-engine prototype** (it works):
- `mockups/ingame_corridor_4x.png`: today's bilinear stretch next to the prototype (sharp pixels plus Bayer posterize), at the friends' 4× magnification.
- `mockups/ingame_room_signal_osd.png` and `mockups/ingame_corridor_signal_osd.png`: the full look with the bodycam overlay.
- The prototype also shows a legibility problem: the wall stencil "FURNACE" renders as "FURNABE" at 640 pixels wide.
- The core of the prototype, as it ran (paste-ready for `pipeline.ts`):
```ts
const sx = floor(screenCoordinate.x), sy = floor(screenCoordinate.y);
const m = mod(mod(sx,2).mul(2).add(mod(sy,2).mul(3)),4).mul(4).add(mod(mod(floor(sx.div(2)),2).mul(2).add(mod(floor(sy.div(2)),2).mul(3)),4));
const g = sqrt(c.rgb.mul(1.08).clamp(0,1));            // more levels in the darks
const q = floor(g.mul(19).add(m.add(0.5).div(16))).div(19); out = q.mul(q);
// + canvas.style.imageRendering = 'pixelated'; pixelRatio = dpr / k (k a whole number)
```
- Offline A/B mockups of the 1.1 ultra look-dev frames: `mockups/f0_corridor_dark_pair.png`, `f0_room_lit_pair.png`, `hub_lot_pair.png`.

**Genre precedents for a cheap but striking look:**
- **Lethal Company:** renders at 860×520 with a posterization/outline effect and gives players no graphics options except brightness ([twinfinite](https://twinfinite.net/news/improve-lethal-companys-graphics-with-this-mod/), [no-posterization mod](https://thunderstore.io/c/lethal-company/p/Sparronator9999/No_Posterization_Shader/)). A WebGL jam game copied the recipe: 860×520 point-filtered render target, Sobel outline, 32-band posterize mixed 50% ([itch](https://itch.io/post/16757830)).
- **R.E.P.O.:** ships a "Pixelation" graphics setting ([Steam](https://steamcommunity.com/app/3241660/discussions/0/597394233225139709)).
- **Signalis:** low-poly 3D rendered at low resolution, PS1 influence ([wiki](https://signalis.wiki.gg/wiki/Signalis)).
- **Iron Lung:** a grainy low-resolution camera is the player's only view outside ([Wikipedia](https://en.wikipedia.org/wiki/Iron_Lung_(video_game))).
- **Mouthwashing:** point-filtered low-res textures, desaturated palette, flat baked lighting ([foro3d](https://foro3d.com/en/2026/mayo/mouthwashing-como-el-terror-ps1-en-unity-redefine-la-baja-fidelidad.html); secondary source).
- **Puppet Combo:** PS1 models with a VHS filter ([Murder House](https://en.wikipedia.org/wiki/Murder_House_(video_game))).
- **Alien: Isolation:** lo-fi rule that nothing could exist that wasn't possible on the 1979 film set; UI artefacts made with damaged VHS ([hudsandguis](https://hudsandguis.com/home/2014/06/04/alien-isolation)).
- **Dead Space:** fully diegetic HUD on the suit ([hudsandguis](https://www.hudsandguis.com/2012/08/22/dead-space-2-diegetic-interface-design)).
- **Content Warning:** camera footage is itself the core mechanic ([Wikipedia](https://en.wikipedia.org/wiki/Content_Warning)).
- **Phasmophobia:** van monitors and night-vision cameras ([ginx](https://www.ginx.tv/en/video-camera-set-up)).
- **Dithering that stays put on surfaces:** [Obra Dinn](https://www.alanzucconi.com/?p=10365), [runevision](https://runevision.com/tech/dither3d).
- **Canvas pixel scaling:** `image-rendering: pixelated` works on canvas; non-integer DPR makes pixel sizes uneven ([MDN](https://developer.mozilla.org/en-US/docs/Games/Techniques/Crisp_pixel_art_look)). Baseline support since 2020.

### 3. Recommendations

**Art direction "SIGNAL":**
- **Every frame is a Company bodycam feed.** Low is the "contractor cam": 640–960 px wide, crisp pixels, dithered. Medium is the "field cam": double-size pixels, light dithering. High and Ultra are the "studio feed": clean, with grain.
- **Light is the only colour.** Shadows are near-monochrome. Colour comes from practical lights only: fluorescent green-white, sodium amber, emergency red, Core cyan, and the flashlight's warm or cool tier. Each room gets one strong pool of light, not an even fill.
- **The Listener shows up as signal corruption.**
- **The UI's "Company paperwork" moves into the 3D world.** Company yellow is reserved for things you can use.
- **Silhouettes beat detail** at low resolution: rim light, eyeshine, hi-vis strips.

Ranked by impact per cost:

| # | What | Impact | GPU / CPU | Effort | Risk | Owner | How to verify |
|---|---|---|---|---|---|---|---|
| 1 | **Contractor-cam Low path.** Render at physical width ÷ whole-number k (k=2–6, target 640–960 px wide), scale with `pixelated`. Auto-quality steps k up instead of the fractional scales `[1,.85,.72,.6]` (`perf.ts:110-122`, `render.json:197`). The Bayer posterize above replaces grain; bloom and chromatic aberration off on Low; CSS vignette; feature flag `signalLook` | Very high for most players. At the same pixel count it goes from blurry to sharp. At k=5–6, 1.5–2.2× fewer pixels → est. hub ~38 ms to ~25 ms at 62 ms/MP | Lower: removes 12 bloom passes plus the 3-tap chromatic aberration / ~0 | S–M | Low | E2 render; integrator for the flag | Software-lane A/B shots (done as a prototype); friends' telemetry |
| 2 | **Per-pixel diet** | High: estimated 30–50% less fragment cost on Low; with #1, ~1.5–2× fps for friends (estimate) | Big saving / 0 | S → M | Low–Med | E2 for render code; G1, G2, E3 and E4 for their noise uses | Shader size and count in the software lane; GPU time needs real hardware or friend telemetry |
| | (a) Drop the velocity buffer when temporal AA is off (`pipeline.ts:277`) | | | | | | |
| | (b) Replace `mx_fractal_noise` with samples of the existing shared `noiseTexture3D`: all presets, no new sampler | | | | | | |
| | (c) Low only: diffuse-only lighting; fixtures come from the light grid only, with no per-pixel fixture spotlights; keep the player's own shadowed beam | | | | | | |
| 3 | **Bodycam overlay at full resolution, never pixelated.** REC, shift clock as timestamp, BATT, mic level from the voice band, SIG from round-trip time, LOC with the current room's callsign (stencils are unreadable at 640 px). Later retire the LIGHT, LINK and RENDER chips | High identity, better legibility | 0 / ~0 | S, then M to consolidate | Low | E2 (register like `index.ts:783`); data through PLAN §13 (integrator) | Software-lane screenshots |
| 4 | **Listener interference.** A `render.signal(k, kind)` call drives chroma tear, a rolling tracking bar, a brief frame-hold and "SIG LOST" in the overlay. The Mannequin shows as frame skips. The existing flicker/chromatic-aberration accessibility toggle must turn it off | High: identity and gameplay feedback | ~0 (a frame-hold skips rendering) | S–M | Low | E2 provides it, G2 calls it; PLAN §13 | Software lane |
| 5 | **Replace halo shells with camera-facing soft glow sprites** (and the bloom'd emitter on High+) | Medium | ~0 | S | Low | E2 (`fixtures.ts:255-278`) | Shape in the software lane; bloom balance needs a real GPU |
| 6 | **Dust motes in the beam.** 300–600 instanced points, lit only inside the local beam cone, one draw call. On Low it stands in for the missing volumetrics | Medium–high | ~0.1 ms | S | Low | E2 (`motes.ts`) | Software lane |
| 7 | **Crew bodies.** Quaternius Universal Base Characters ([CC0](https://quaternius.itch.io/universal-base-characters): free Standard version, ~13k triangles, same 65-joint UAL rig), plus gear parented to bones (tool belt, chest radio, kneepads, hi-vis bands) built procedurally like the helmet. Keep the TV visors | High | ~same | M | Med | G1, plus E1 for the manifest | `avatar-draws.json` deltas plus shots |
| 8 | **Monster materials.** Rim/fresnel light, eyeshine under the beam, wet clearcoat on the Listener, cracked dirty porcelain on the Mannequin, a mangier Hound | Medium–high | Small | S–M | Low | G2 | Shots, dark and lit |
| 9 | **Voice-driven breath.** In cold spaces, breath puffs appear only while someone talks, scaled by the voice band, teammates included, so you can see who is talking | Medium, plus gameplay | ~0 (the 64-sprite puff system exists) | S | Low | E4 (`paranormal/ambient.ts:126-131`), G1 | Software lane |
| 10 | **Death and spectating as broadcast.** Death shows a "NO SIGNAL / DEAD AIR" test card with the death text; spectating becomes "CAM 0n · callsign" feeds with static between them | Medium (fits the "dying is funny" pillar) | 0 | S–M | Low | G1, G3 | Shots |
| 11 | **Company colour language.** Company yellow only on interactables, hazard stripes on objective props, Company posters and memos in the decal atlas | Medium | 0 | S–M | Low | E3, E1, G3 | Shots |
| 12 | **Variety as data.** Fewer, uber-materials, so pattern, wet and mask options don't each create a new program | High, indirect (freezes) | Large compile savings | M–L | Med | E2, E3, with perf-freezes | Program counts in the software lane |
| 13 | **Studio feed on strong GPUs.** TAAU or FSR1 (both in r186) instead of bilinear stretching on 4K screens. The host could go ultra or native, but **the host GPU has a PCIe fault: the user decides** | Medium | +GPU | M | Med | E2 and the user | Real-GPU pass, integrator only |
| 14 | **Auto-quality:** don't lower resolution because of long frames when the median frame is fine | Medium | 0 | S | Low | E2 (`perf.ts:291-296`) | Unit test |
| 15 | **Telemetry:** add the GPU renderer string and why WebGPU wasn't available; warn the player if the renderer is SwiftShader | Enables everything above | 0 | XS | Low | Integrator (`core/telemetry.ts`); net is frozen, so request the server log-line change | Log line |

**Asset sources and licence notes:**

| Source | Licence | Use it for |
|---|---|---|
| Poly Haven, ambientCG | CC0 (already in use) | More set dressing and decals |
| Quaternius | CC0 | UAL (in use), Universal Base Characters, Modular Outfits (Fantasy only, so only boots/gloves/trousers fit), Zombie Kit; the Bestiary kit on quaternius.com still needs checking |
| [MakeHuman exports](https://static.makehumancommunity.org/oldsite/faq/can_i_sell_models_created_with_makehuman.html) | CC0 (community assets are CC0 or CC-BY) | Gaunt Listener bodies |
| [Smithsonian Open Access](https://www.cgchannel.com/2020/03/get-2000-free-3d-models-from-the-smithsonian-collection/) | CC0, glTF | Scanned curio loot |
| Kenney particles | CC0 | Sparks, smoke |
| Sketchfab | Per model; CC-BY needs credits (`credits.json` already supports them) | Individual picks |

Avoid Mixamo: it isn't CC0, and the browser downloads the raw GLBs. Avoid SCP-derived content: CC-BY-SA requires share-alike.

### 4. Quick wins doable tonight (software lane, low risk, all behind a flag)
1. The `pixelated` CSS plus whole-number k on Low (#1, part one). This is E2-only and its look is verifiable in the software lane.
2. Bayer posterize replacing grain; bloom, chromatic aberration and the velocity buffer off on Low (`pipeline.ts:277,321-332`).
3. Swap per-pixel noise for the 3D noise texture in `render/materials.ts` (look-parity shots in the software lane; the perf benefit has to be confirmed later on real hardware).
4. An additive bodycam overlay, and move the RENDER chip into the F3 panel only.
5. Halo shells replaced with glow sprites.
6. GPU string added to telemetry (integrator).

### 5. Open questions
- **The friends' GPUs and browsers.** Telemetry has no GPU string. WebGL2 means no WebGPU adapter: likely older Intel/AMD integrated GPUs. Whether they used the browser or the desktop app is unknown.
- **Is the contract also mostly per-pixel cost?** The ~62 ms/MP figure comes from the hub (v1.1, Oct 7). No contract samples exist at two resolutions, so the fps estimates are model-based.
- **The host's stored medium preset** can't be confirmed from here; check `localStorage` (browser or desktop profile).
- **Real-GPU cost and taste.** Nothing here measured GPU time on real hardware (software lane only). Whether players like the pixel look: Lethal Company and R.E.P.O. suggest yes. Ship it as a toggle with Low defaulting on.
- **Scanlines with a non-integer DPR (1.5)** can moiré, so they're optional. The in-engine dithering pattern hasn't been tested for crawl while moving.

Files are in `<scratch>/night\gfx-art\`:
- `run1\` — counts (`notes.json`), the largest shader (`biggest-fragment.glsl`), A/B captures
- `mockups\` — in-engine and offline mock-ups
- `signal-run.e2e.mjs`, `mockup.mjs`, `osd.mjs`, `crop4x.mjs`, `anon2.mjs` — scripts