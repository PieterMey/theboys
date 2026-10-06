# Research notes (2026-10-06)

Background research for [PLAN.md](../../PLAN.md). Ten researchers covered the topics below in parallel. A critic then looked for contradictions and gaps, and five fact-checkers re-verified the claims the plan depends on: 50 were confirmed, 17 partially true, 1 refuted and 1 unverified. Many of the fact-checks were measured on the host PC (RTX 5090, Chrome 154, Node 24).

Each topic has two files: `*.core.md` holds the summary, recommendations, risks and open questions, and `*.details.md` holds the implementation notes and sourced key facts.

| Topic | What it covers |
|---|---|
| [graphics-web](graphics-web.core.md) | three.js r186 WebGPU features, the flashlight light pool, the post-processing stack, presets, physics |
| [engines-native](engines-native.core.md) | Browser vs Godot 4.7/4.8 vs Unity 6.6 vs Unreal 5.8, and the v2 path |
| [netcode-hosting](netcode-hosting.core.md) | Node + ws + msgpackr, the Cloudflare quick tunnel (measured), Tailscale Funnel, tick model |
| [voice](voice.core.md) | WebRTC mesh, Cloudflare TURN, Web Audio graph, AEC, VAD, radios, mimic capture |
| [game-design](game-design.core.md) | Genre analysis, DEAD AIR and two other pitches, monsters, economy, progression |
| [procgen](procgen.core.md) | Lattice+BSP+zones generator (prototype in `prototypes/procgen`), edge-grid AI |
| [assets-audio](assets-audio.core.md) | Poly Haven / ambientCG / Quaternius / Kenney sources, licensing, pipeline |
| [ai-llm](ai-llm.core.md) | What JEV is (TypeSafe Jev), Claude routing, budgets, safety, prompt injection |
| [speech](speech.core.md) | faster-whisper on the 5090 (measured), Parakeet fallback, Kokoro TTS, mimic |
| [tooling-mcp](tooling-mcp.core.md) | Playwright on the host GPU (verified), chrome-devtools-mcp, Context7, Blender |

Cross-checks:
- [critique.md](critique.md): contradictions between topics and how each resolves, gaps, the consolidated stack, cut order.
- [verdicts-nonconfirmed.md](verdicts-nonconfirmed.md): every claim that was corrected, refuted or left unverified, with the corrected version.
- [verify-answers.md](verify-answers.md): fresh answers to the gap questions, including GPU timings, the AGC loudness test, Whisper hallucination tests, the UAL1 download flow and the Hound model source.
- [verification.md](verification.md): the full fact-check output.

Other material:
- `prototypes/procgen/`: the tested TypeScript level generator (1000/1000 seeds valid, 1.6 ms per level). The build starts from this code.
- `probes/`: small scripts the fact-checkers used on this PC, including the voice probe, GPU probe, Whisper benchmark and fixed-step timer.

Limitation: the shared web-search budget ran out partway through. Claims checked after that point were verified against primary sources (docs, source code, registries) or measured on this PC; nothing rests on a general web search from that point. The files mark the few remaining open items.
