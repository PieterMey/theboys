# Night review (8–9 Oct 2026)

On the night of 8–9 October, nine research agents studied the live v1.2 build (commit `25058ac`) and a tenth merged their findings into one plan. The host asked for four things: a review of performance and latency, an upgrade path for the graphics, a rethink of generative AI in the game, and new concepts for levels, monsters, interactions, missions and mini-games.

The research was read-only. It used the live server log (player names anonymised as P1/P2/P3), CPU benchmarks and the software-rendering test lane. It made no real-GPU runs and no AI calls. Claims are marked **[C]** verified in code, **[M]** measured and **[I]** inferred.

Start with [synthesis.md](synthesis.md). It is the de-conflicted, ranked plan; its "Next sessions backlog" is the current to-do list. Tonight's build (v1.3-night) shipped most of its "Tonight" items.

| Report | What it covers |
|---|---|
| [synthesis.md](synthesis.md) | The merged plan: tonight's fixes and feature slices, the graphics direction, the backlog, the host's decisions, risks, and a critic pass on the other reports |
| [perf-lowend.md](perf-lowend.md) | Why remote friends on WebGL2 Low ran at 13–14 fps, why the host was on Medium, and a measured path toward 60 fps (the Lite/potato tier) |
| [perf-freezes.md](perf-freezes.md) | The multi-second freezes at join, drive and contract start: shader compiles, unpaced frames, and how to keep voice alive |
| [perf-server-net.md](perf-server-net.md) | Server CPU per crew, snapshot sizes and rates, the network clock, the drive flow, loading bytes, Cloudflare caching, the voice path |
| [gfx-pipeline.md](gfx-pipeline.md) | A full audit of the rendering, three.js r186 options vs Babylon.js, PlayCanvas and a custom WebGPU renderer, and the phased plan (stay on three.js) |
| [gfx-art.md](gfx-art.md) | Art direction: the SIGNAL bodycam look that makes low resolution intentional, ranked visual upgrades, asset sources |
| [ai-design.md](ai-design.md) | Generative AI game design: the Company Line (boss negotiation), Dead Air whispers (séance), the Ledger (Death Note), code-word cracking and eight more, ranked |
| [ai-tech.md](ai-tech.md) | Live voice and costs: TTS and STT options and prices (Oct 2026), the STT sidecar's losses and its CPU fallback, prompt caching, per-session cost models |
| [concepts-world.md](concepts-world.md) | 29 concepts for missions, levels, goals and mini-games, with the top 8 marked |
| [concepts-monsters.md](concepts-monsters.md) | 19 new monsters and 14 interactions built around voice, darkness and doors, with the top 6 of each marked |

`<scratch>/` paths in the reports point to local probe scripts and screenshots on the host PC that are not in the repo.
