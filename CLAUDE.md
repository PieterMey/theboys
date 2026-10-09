# DEAD AIR: rules for build agents

DEAD AIR is a browser and desktop co-op horror game. The full design is in PLAN.md, and the research is in docs/research/. Read the PLAN.md sections relevant to your track before coding, and the status section below before anything else.

## Status and handoff (updated 2026-10-09)

Read this first when you pick the project up on any PC.

**What's live.** https://play.dead-air.io runs on the host PC (Windows 11, Ryzen 9950X3D, an RTX 5090 with a GPU-side PCIe fault).
- The server runs from a git worktree, `C:\Users\Pieter\repos\theboys-live`, detached at the deployed commit. Its untracked `start-live.cmd` points `SAVES_DIR`, `SESSION_FILE`, `HOST_STATE` and `AI_USAGE_LOG` at this repo's `saves/` and `logs/`, then runs `node tools\host.mjs --no-build`. host.mjs starts the STT sidecar (:3100), checks the tunnel, starts the game server (:3000) and stays open, following `logs/server.log` with the hang watchdog (it restarts a server that stops answering `/healthz` for 60 s).
- The tunnel is a named Cloudflare tunnel in the `Cloudflared` Windows service, which starts at boot. The server starts at login from the Startup-folder shortcut `DEAD AIR Server.lnk` (minimised); the `DEAD AIR Server` shortcuts on the desktop and in the Start menu start it by hand.
- Logs: `theboys-live/logs/server.log`. Player telemetry every 30 s, plus `[diag]` lines from telemetry v2 (no player names). Saves live in this repo's `saves/` (gitignored); backups go to `C:\Users\Pieter\repos\theboys-backups\`.
- Desktop app: `node apps/desktop/scripts/pack.mjs` builds `apps/desktop/out/win-unpacked`; it's installed at `%LOCALAPPDATA%\DEAD AIR Dev Build v3` (the `DEAD AIR` shortcuts). It loads the game from the server, so game updates need no new build; only shell changes do. Friends get a zip of `win-unpacked`. Steam uses app 480 (Spacewar) until the Steamworks app exists; `docs/STEAM.md` is a local, gitignored guide.

**Deploying (integrator, on the host PC).**
1. Check nobody is connected: `netstat -ano | findstr "127.0.0.1:3000" | findstr ESTABLISHED` prints nothing.
2. Commit and push `main`. Back up `saves/` to `..\theboys-backups\saves-before-<version>-<date>`.
3. `git -C ..\theboys-live checkout --detach <commit>`, then in `theboys-live` run `npx vite build --config apps/client/vite.config.ts`. That writes theboys-live's own `apps/client/dist`, which the live server serves; never build this repo's dist.
4. New assets: stage them with `node tools/fetch-assets.mjs --dist <stage>/dist`, then promote with `node tools/promote-assets.mjs <stage>/dist`. It only adds files and swaps the manifest last; the live server reads this repo's `.assets/dist`.
5. Smoke-test from `theboys-live` on a spare port: `node apps/server/src/index.ts --selftest` with `NODE_ENV=development AI_MODE=mock SAVES_DIR=<tmp> SESSION_FILE=<tmp>/session.json`.
6. Restart: open a new window with `start-live.cmd --restart` (it stops the old server and starts the new one; its window owns the watchdog), then close the previous host window. Check `/healthz` locally and on play.dead-air.io, and the boot lines in `logs/server.log`.
To change saves while the server is down (for example a scrub), stop the old host window first, so its watchdog can't restart the server midway.

**Versions.**
- v1.2 (8 Oct): stealth and crouch, a fair Listener, gear, searchable containers, crafting, the field guide, records, themed sites, mirrors, mist, paranormal events, audio, the new van.
- v1.3-night (9 Oct): the name filter (`packages/shared/src/names.ts`; word lists stored ROT13), the drive preload and van wait, fewer shader compiles, cheaper Low frames, the Lite preset and the SIGNAL bodycam look (both opt-in in Settings), an AUTO preset entry, telemetry v2 (`core.diag`), steadier network clock, a Listener wake fix, the Snatcher from the 3rd contract, and flag-gated feature slices.

**Feature flags** live in `config/flags.json`; they gate behaviour, never persistence. Tonight's new features ship OFF: `deadPokes`, `earwigs`, `companyLine`, `siteRules`, `noiseLure`, `fieldReceiver`. The live server reads `config/flags.json` from `theboys-live`, not from this repo. For a quick live test, edit it there, restart the server with the restart shortcut, and have players reload the page; undo it with `git -C ..\theboys-live checkout -- config/flags.json`. To keep a change, commit it on `main` and deploy.

**Host decisions (2026-10-09 night review)**; follow them without asking again:
1. Blocked display names become `Contractor-NNNN` with a private notice; they are not refused.
2. Lite and SIGNAL stay opt-in until one session of friend telemetry shows they help; then they become the WebGL2 default.
3. Real-GPU checks happen on friends' own PCs through consented `?diag=1` sessions (not built yet). Agents never use the host GPU (software lane only). The host keeps their stored Medium preset while the PCIe fault persists.
4. The next AI round unfreezes `ai` and `stt` for platform fixes first: prompt caching, per-player rate limits, TTS spend counted in the budget, the STT confidence filter (it drops 44% of confirmed speech) and a Parakeet CPU fallback. Then the Company Line with an LLM, and the séance. Live TTS only for short lines inside a priced, shared budget; one capped live check under $0.05 is approved. The Ledger comes only after a red-team pass, and it may only haunt or protect teammates.
5. The Cloudflare cache rule for `/assets/*` and `/app/*` (excluding `/ws`, `/api/*` and `/healthz`) plus Smart Tiered Cache is the host's own dashboard action.

**What's next.** The ranked backlog is in `docs/research/2026-10-09-night/synthesis.md` ("Next sessions backlog"), with the nine research reports beside it. Known open items: Low with lit flashlight beams still draws about 206 times against a 140 budget (needs the content consolidation, phase C); asynchronous shader compiles (phase B); the friend `?diag=1` A/B test; the AI platform round.

**Working from another PC.**
- Clone and run `npm ci`.
- Build the desktop app (tested from a clean GitHub clone on 2026-10-09): `node node_modules/electron/install.js` once (Electron 44 has no postinstall, so `npm ci` doesn't fetch its binary), then `node apps/desktop/scripts/pack.mjs`. The app lands in `apps/desktop/out/win-unpacked` (`DeadAir.exe`). It needs no `.env` or `.assets`, because it loads the game from play.dead-air.io; without the host PC's `%APPDATA%\DEAD AIR\host.json` it simply has no host rights.
- Copy `.env` from the host PC by a secure route (never commit it).
- `.assets/` is gitignored: copy it from the host PC. Rebuilding with `tools/fetch-assets.mjs` re-downloads the CC0 sources, and new ElevenLabs takes cost credits.
- The STT sidecar's `.venv` and models are gitignored too (`services/stt/`); voice works without them, the Listener just hears loudness only.
- Develop with `npm run dev` on a port other than 3000.
- The live server, tunnel, saves and logs stay on the host PC: deploy by remote-controlling it.
- Claude Code's local memory doesn't travel between PCs; what it needs is in this file and in `docs/`.

## Working model
- All agents share ONE working tree: `C:\Users\Pieter\repos\theboys`. File ownership is strict (see the table below).
  - Only edit files your track owns.
  - If you need something in a file you don't own, write the request in your final report. You may also add a clearly marked `// TODO(<track>):` stub in YOUR OWN code that works without it.
- Shared contracts (`packages/shared/src/*.ts`) are owned by the integrator and are additive-only. Each track owns exactly one `packages/shared/src/messages/<track>.ts`, where it adds its events and requests.
- Do NOT `git commit`, `git push`, or change git config. The integrator commits at green gates. **This repo is PUBLIC on GitHub.**
- Do NOT edit `package.json` or `package-lock.json`, and do NOT run `npm install <pkg>`. Every dependency is pre-installed. If one is missing, report it.
- Ports: each track has its own (table below), and the tunnel targets `main` on :3000 only. Read `PORT`, `BASE_URL` and `STT_URL` from the environment.
- **The live server is always on.** :3000 (https://play.dead-air.io via the 'Cloudflared' Windows service), the STT sidecar on :3100 and cloudflared are the host's. Never connect test players to them, and never stop, restart or kill them (no `taskkill /IM node.exe`, `python*` or `cloudflared`; kill only PIDs you started). Using the STT sidecar's HTTP API from tests is fine.
- **SOFTWARE RENDERING ONLY for agents (since the 2026-10-08 00:50 crash, when a guarded test set off the host's GPU fault and the PC bugchecked anyway).** The guard sets `DEADAIR_RENDER=swiftshader`; `tests/lib/launch.ts` then launches Chrome with `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader` and `?webgl=1&preset=low`. Any Chrome you launch yourself must do the same when `DEADAIR_RENDER=swiftshader`. The guard kills a run (exit 95) whose processes use the NVIDIA 3D engine. Never launch the desktop app (Electron). Judge layout, logic and UI in these runs, not lighting quality or perf; real-GPU visual and perf passes are the integrator's, only with the user's OK.
- **Every browser or desktop-app test runs through the GPU guard:** `node tools/gpu-guard.mjs --max-sec 30 -- node tests/<track>/<name>.e2e.ts` (max 120 s). The host's RTX 5090 has a GPU-side PCIe fault, so GPU work must never overlap: the guard holds one global lock across all agents, refuses to run during a 10-minute cool-down after any NVIDIA driver event (exit 98), and kills the test on the first driver event (exit 99). Exit 98/99: stop GPU testing and report it; never retry in a loop. Keep tests short, one browser per player, and as few players as the test needs.
- **Never run `npm run build`** (it rewrites `apps/client/dist`, which the live server serves). For a production-like test, build to a temp dir, `npx vite build --config apps/client/vite.config.ts --outDir <tmp> --emptyOutDir`, and start the server with `CLIENT_DIST=<tmp>`.
- `tsc` covers the whole repo, so errors in other tracks' files may show up while they're mid-edit. Only errors in YOUR files block you.

## Ownership
| Owner | Paths |
|---|---|
| integrator | `CLAUDE.md`, `PLAN.md`, root `package.json`/`tsconfig*.json`, `config/flags.json`, `packages/shared/src/{envelope,state,layout,constants,profile,workorder,saves,anim,test-api,rng}.ts`, `packages/shared/src/messages/index.ts`, `apps/client/src/main.ts`, `apps/client/src/core/**`, `apps/server/src/index.ts`, `apps/server/src/core/**` (built by the P0 skeleton agent) |
| ① net (port 3001) | `apps/server/src/net/**`, `apps/client/src/net/**`, `messages/net.ts`, `config/balance/net.json` |
| ② level (3002) | `packages/shared/src/{procgen,nav,collide}/**`, `packages/shared/src/callsign.ts`, `apps/server/src/level/**`, `apps/client/src/level/**`, `tools/gen-cli.ts`, `messages/level.ts`, `config/balance/level.json` |
| ③ render (3003) | `apps/client/src/render/**`, `config/balance/render.json` |
| ④ voice (3004) | `apps/client/src/voice/**`, `apps/client/src/audio/**`, `apps/server/src/voice/**`, `messages/voice.ts`, `config/balance/voice.json` |
| ⑤ players (3005) | `apps/client/src/players/**`, `apps/server/src/players/**`, `messages/players.ts`, `config/balance/players.json` |
| (a) objectives (3011) | `apps/*/src/objectives/**`, `messages/objectives.ts`, `config/balance/objectives.json`, `tests/bots/**` |
| (b) interaction (3012) | `apps/*/src/interaction/**`, `packages/shared/src/interactables.ts`, `messages/interaction.ts`, `config/balance/interaction.json` |
| (c) monsters (3013) | `apps/*/src/monsters/**`, `apps/server/src/director/**`, `messages/monsters.ts`, `config/balance/monsters.json` |
| (d) meta (3014) | `apps/*/src/meta/**`, `messages/meta.ts`, `config/balance/meta.json` (+ the `config/balance/core.json` economy numbers) |
| (e) ai (3015) | `apps/server/src/ai/**`, `apps/server/src/stt/**`, `services/stt/**`, `messages/ai.ts`, `config/balance/ai.json` |
| assets | `tools/fetch-assets.mjs`, `tools/assets.manifest.json`, `tools/sfx-manifest.json`, `packages/shared/src/assets.ts`, `.assets/**` |
| env | `tools/bin/**`, `tools/ai-*.mjs`, `docs/bench/**`, `services/stt/**` (in P0, handed to (e) afterwards) |
| tests | `tests/lib/**` and `tests/gates/**` are integrator/skeleton-owned. Each track owns `tests/<track>/**` |

## Package split (v1.2 and v1.3-night; supersedes the rows above)
Both rounds are finished. A new round reuses this split unless the integrator reassigns it.
| Package (port) | Paths |
|---|---|
| G1 players-stealth (3801) | apps/client/src/players/**, apps/server/src/players/**, apps/server/src/net/movement.ts, apps/client/src/loading/LoadingScreen.tsx, apps/desktop/{src,static,test}/**, messages/players.ts, config/balance/players.json, tests/{players,stealth}/** |
| G2 monsters-fair (3802) | apps/*/src/monsters/**, apps/server/src/director/**, apps/server/src/ai/director.ts, messages/monsters.ts, config/balance/monsters.json, tests/monsters/** |
| G3 interaction-gear (3803) | apps/*/src/interaction/**, apps/*/src/safes/**, packages/shared/src/interactables.ts, messages/interaction.ts, config/balance/{interaction,safes}.json, tests/{interaction,safes,gear}/** |
| G4 meta-records (3804) | apps/server/src/meta/** except crafting.ts, apps/client/src/meta/** except workbench.tsx/workbench.css/workshop.ts, apps/client/src/menu/**, messages/meta.ts, config/balance/meta.json (+ core.json economy), tests/meta/** |
| G5 workshop (3805) | apps/server/src/meta/crafting.ts, apps/client/src/meta/{workbench.tsx,workbench.css,workshop.ts}, config/balance/crafting.json, tests/workshop/** |
| G6 fieldguide (3806) | apps/*/src/fieldguide/**, messages/fieldguide.ts, config/balance/fieldguide.json, tests/fieldguide/** |
| E1 env-layout (3811) | packages/shared/src/{procgen,nav,collide}/**, packages/shared/src/callsign.ts, apps/server/src/level/**, tools/gen-cli.ts, messages/level.ts, config/balance/level.json, tools/fetch-assets.mjs, tools/assets.manifest.json, packages/shared/src/assets.ts, .assets/{src,build}/** (never .assets/dist), C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage, tests/level/** |
| E2 env-render (3812) | apps/client/src/render/**, config/balance/render.json, tests/render/** |
| E3 env-world (3813) | apps/client/src/level/**, tests/world/** |
| E4 env-paranormal (3814) | apps/*/src/paranormal/**, messages/paranormal.ts, config/balance/paranormal.json, tests/paranormal/** |
| E5 env-audio (3815) | apps/client/src/audio/**, tools/sfx-manifest.json, config/balance/audio.json, tests/audio/** |
| integrator | the integrator row above + packages/shared/src/{catalog,progress}.ts, tests/fixtures/** (incl. the frozen tests/fixtures/identity-v11), tools/make-identity-fixtures.ts, apps/desktop/{package.json,config.json,build,scripts}, promotion into .assets/dist |
During v1.2 and v1.3-night, objectives, voice, net (except movement.ts), ai (except director.ts), stt and services were frozen. For the next round, ai, stt and services are unfrozen for the AI platform work (host decision 4); objectives, voice and net stay frozen unless the integrator says otherwise: request instead.

- **Input (replaces the Input rule).** The web client never reads Ctrl or Meta (no ctrlKey/metaKey, no 'ControlLeft'): Ctrl+W closes the tab. Only the desktop shell maps Left Ctrl to crouch, via window.deadAirDesktop.onHotkey, ignoring AltGr. Crouch is C.
- **Assets.** Never run tools/fetch-assets.mjs against .assets/dist. Stage with --dist C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage/dist; test servers use ASSETS_DIR=C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage. The integrator promotes additively.
- **GPU (v1.2).** Dev server outside the guard; --max-sec 120 per run; iterate scenes in one browser session; SwiftShader lane (launchPlayer extraArgs --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader, webgl true, ?preset=low) for UI/layout shots, still through the guard; your brief caps your runs.
- **Cross-package calls** only through PLAN.md §13; a missing provider degrades to a no-op; interactable ids use catalog V12_KINDS prefixes.
- **Flags gate behaviour, never persistence.**
- **Dev and test servers (v1.2).** Every server you start (dev, e2e, selftest) sets `NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json`, with `<scratch>` your own scratchpad folder: the default `saves/` belongs to the live server. Kill only the PIDs you started.
- **Never leave a file unparseable.** Every dev server imports every package at boot, so one syntax error in any file breaks all agents' servers. Write each change as a complete edit (never a half-written statement or file), and if a file you own stops parsing, fixing it comes before anything else.

## Commands (repo root)
- `npm run dev`: game server + Vite middleware with HMR on `PORT` (default 3000).
- `npm run build`: production client build into `apps/client/dist` (integrator only, see above).
- `npm run check`: `tsc --noEmit`, the forbidden-API grep and the secret check. Must pass before you report done.
- `npm run selftest`: boots the server, connects 2 ws clients to one crew, exits 0.
- `node tools/gen-cli.ts --seed X --png out.png`: render a level map to PNG (② track).
- Unit tests: `node --test <file>.test.ts`. E2E: `node tests/<track>/<name>.e2e.ts` using `tests/lib/launch.ts`.

## Code rules (they prevent known failures; see PLAN.md Appendix A/B)
- **TypeScript under Node type stripping.** Write erasable syntax only: no `enum`, `namespace`, or parameter properties; use `as const` objects. Use explicit `.ts` import extensions. **Every type-only import must be `import type`**: tsc passes without it, but Node crashes at load time.
- ESM everywhere (`"type": "module"`). In ESM there is no `__dirname`; use `import.meta.dirname`.
- **Determinism.** Use `makeRng()` from `packages/shared/src/rng.ts` for all gameplay-relevant randomness. Never `Math.random`, and never `Math.sin`/`cos`/`exp` in generation decisions.
- **Server tick** is a `performance.now()` accumulator woken by `setTimeout(…,1)`. Never `setInterval`, which runs at 21 Hz on this Windows host.
- **three.js r186 only.** Use `import * as THREE from 'three/webgpu'`, TSL from `'three/tsl'`, and `RenderPipeline`.
  - Never use `EffectComposer`, `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, `PCFSoftShadowMap`, `RGBELoader`, `BatchedMesh` for the level, `ClusteredLighting` or `BundleGroup`.
  - Never add or remove shadow-casting lights, or toggle `castShadow`, at runtime. Change intensity instead.
  - Copy patterns from the r186 examples in `node_modules/three/examples/`.
- **Input.** Never bind Ctrl or Meta: Ctrl+W closes the tab. Crouch is C.
- **Audio.** No `ScriptProcessorNode`. Mic constraints are `echoCancellation:true, noiseSuppression:true, autoGainControl:false`. Never use `'remote-only'`. Every remote WebRTC stream also gets a muted, playing `<audio>` keep-alive element.
- **Claude API.** Read `docs/claude-api-notes.md` first. Then read the claude-api skill that ships with Claude Code (invoke it with the Skill tool): its `typescript/claude-api/*.md` docs and `shared/prompt-caching.md`.
  - No `temperature`/`top_p`/`top_k`, no `budget_tokens`, no `thinking:{type:'disabled'}`, no forced `tool_choice`, no prefill, no `effort` on Haiku 4.5, no `messages.parse`. Use `create()` with `output_config.format` json_schema, then branch on `stop_reason`.
  - Model IDs come from env; every Claude call is Claude Haiku 5.5 (`MODEL_WRITER`, `MODEL_FAST` and `MODEL_RETRY` all default to `claude-haiku-5-5`; a retry model equal to the writer means a refusal keeps the template). JEV stays the Listener's first brain and the director picker. Haiku 5.5 thinks by default: the gateway adds effort low (briefs: balance `briefEffort` medium) and a 1024 max_tokens floor (see docs/claude-api-notes.md); never size a Haiku 5.5 route's max_tokens for the answer alone.
- **Costs (the user asked to limit them).** Never call live AI in loops or tests. Use `AI_MODE=mock` by default; only `tools/ai-*.mjs` makes live calls, and it's small. ElevenLabs generation happens once, at build time, and is cached.

## Secrets (public repo!)
- Never print, log, copy or commit values from `.env`. Load it with `node --env-file=C:\Users\Pieter\repos\theboys\.env`.
- Never send secrets or transcripts to the client except as designed. Never write transcripts or saves into tracked files (`saves/` and `logs/` are gitignored).
- `node tools/check-secrets.mjs` must pass.

## Testing on this machine
- Playwright: use `playwright-core` with `chromium.launch({ channel: 'chrome', headless: true })`. That gives real RTX 5090 WebGPU, and screenshots capture the canvas. Use `tests/lib/launch.ts`.
  - Fake mic: run one browser process per simulated player, each with its own WAV (`tests/fixtures/voice/*.wav`).
  - Local WebRTC connects directly; the relay-only test uses `iceTransportPolicy:'relay'`.
- Look at your screenshots with the Read tool. Visual quality matters: the user asked for the best graphics possible.
- Test hooks: `window.__game` and `window.__voiceDebug` (`packages/shared/src/test-api.ts`) are enabled with `?test=1`. Server `dbg.*` requests exist only with `NODE_ENV=development`.
- When done, report: what you built, how you verified it (commands + results), and requests for other owners.
