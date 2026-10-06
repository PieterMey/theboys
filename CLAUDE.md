# DEAD AIR: rules for build agents

The browser co-op horror game we're building tonight. The full design is in PLAN.md, and the research is in docs/research/. Read the PLAN.md sections relevant to your track before coding.

## Working model
- All agents share ONE working tree: `C:\Users\Pieter\repos\theboys`. File ownership is strict (see the table below).
  - Only edit files your track owns.
  - If you need something in a file you don't own, write the request in your final report. You may also add a clearly marked `// TODO(<track>):` stub in YOUR OWN code that works without it.
- Shared contracts (`packages/shared/src/*.ts`) are owned by the integrator and are additive-only. Each track owns exactly one `packages/shared/src/messages/<track>.ts`, where it adds its events and requests.
- Do NOT `git commit`, `git push`, or change git config. The integrator commits at green gates. **This repo is PUBLIC on GitHub.**
- Do NOT edit `package.json` or `package-lock.json`, and do NOT run `npm install <pkg>`. Every dependency is pre-installed. If one is missing, report it.
- Ports: each track has its own (table below), and the tunnel targets `main` on :3000 only. Read `PORT`, `BASE_URL` and `STT_URL` from the environment.
- **The live server is always on.** :3000 (https://play.dead-air.io via the 'Cloudflared' Windows service), the STT sidecar on :3100 and cloudflared are the host's. Never connect test players to them, and never stop, restart or kill them (no `taskkill /IM node.exe`, `python*` or `cloudflared`; kill only PIDs you started). Using the STT sidecar's HTTP API from tests is fine.
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
- **Claude API.** Read `docs/claude-api-notes.md` first. Then read the SDK docs in `C:\Users\Pieter\AppData\Local\Temp\claude\bundled-skills\2.1.291\47bac98defa643f89cebfe3371a586f9\claude-api\typescript\claude-api\*.md` and `...\claude-api\shared\prompt-caching.md`.
  - No `temperature`/`top_p`/`top_k`, no `budget_tokens`, no `thinking:{type:'disabled'}`, no forced `tool_choice`, no prefill, no `effort` on Haiku 4.5, no `messages.parse`. Use `create()` with `output_config.format` json_schema, then branch on `stop_reason`.
  - Model IDs come from env (`MODEL_WRITER=claude-opus-5-5`, `MODEL_FAST=claude-haiku-4-5`).
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
