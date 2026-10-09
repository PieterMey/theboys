# ai-tech report: live voice, latency and cost for more generative AI in DEAD AIR

All research was read-only. Nothing in the repo changed: `git status` shows only the `tests/playtest/v11/` folder that was already untracked. I made no live AI calls, opened no browser and did no GPU rendering. I sent 24 requests to the STT sidecar on :3100 while nobody was connected to :3000. My mock dev server on :3815 was started and then stopped (it was PID 55992, the only one I touched). Scripts and outputs are in `<scratch>/night\ai-tech\scripts\`. No player names appear anywhere below.

## 1. Top findings

1. **The existing generative voice has never fired in a real session.**
   - All 14 `listener.lure` rows in `logs/ai-usage.jsonl` are boot warm-ups: each timestamp matches a "lure warm-up" line in the server logs.
   - There are zero `lure.tts` rows, so ElevenLabs has never voiced a live lure.
   - Since the 19:14 deploy the whole AI layer cost **$0.0143** over 33 calls: 9 briefs, 20 director picks, 2 Listener decisions from JEV (the fast decision model) and 2 warm-ups.
   - The bottleneck for "more AI" is the game triggers, not money or latency.
2. **Cost doesn't limit any of the proposed features.** A 45-minute session for 4 players with boss calls, vendors, a cursed book, radio NPCs and lures costs:
   - about $0.028 of Claude Haiku 5.5;
   - plus about 8.1K spoken characters, which is $0.33 at ElevenLabs' API list price, 4–8K credits from the Creator plan's 121K per month (14–29 sessions), or $0 with TTS running locally on the CPU.
   - Hosted voice-agent platforms would cost $0.64–1.55 per session and would send players' raw audio off the host PC.
3. **STT (speech-to-text) on the faulty RTX 5090 is only fast when the GPU is idle, and its CPU fallback doesn't work.**
   - Tonight in play: p50 68 ms, p90 92 ms (149 requests).
   - Right now, with the host in another game (GPU at 97%, 342 W): 250–410 ms per clip.
   - The fallback in `services/stt/server.py:243` is Whisper int8 on the CPU, which I measured at **3.96–4.30 s per clip**. That is over the bridge's 4 s `sttTimeoutMs`, so every request would fail.
   - PLAN §4.7 (`PLAN.md:354`) says the fallback is Parakeet v3 on the CPU, but that isn't implemented. Parakeet v3 int8 on the CPU measured **104 ms for 2 s of speech, 135–142 ms for 3 s and 225–253 ms for 6 s**. Four 2 s clips sent at once all finished in 123–163 ms.
4. **About half of the speech segments produce no text.**
   - 73 of 149 sidecar requests tonight came back empty: 22 contained no speech, and 51 had their segment dropped by the filter (`avg_logprob < -0.6` at `server.py:105`, the compression check, or the hallucination blocklist).
   - Language detection costs more than the transcription itself: 43.8 ms vs 14.7 ms at p50.
5. **The Claude path uses neither prompt caching nor streaming.**
   - `cache_read_input_tokens` is 0 on all 213 logged calls; `gateway.ts:444` sends the system prompt as a plain string, and `gateway.ts:440` calls `messages.create` and waits for the whole JSON message.
   - From the host, the network floor to Anthropic is about 140 ms per call even on a warm connection (measured).
   - Every Haiku 5.5 latency we have from a real game is a cold warm-up call (1.06–2.31 s). The only steady-state number is the benchmark: p50 0.88 s, p90 1.28 s.
6. **TTS (text-to-speech) is file-based and doesn't stream.**
   - The path is `tts.ts:151`: a POST, the whole MP3 written to disk, a URL sent, then the client fetches and decodes it (`apps/client/src/ai/lure.ts:58-59`).
   - That's fine for 12-word lures, too slow for conversations.
   - ElevenLabs **v4 Turbo** came out on 2026-09-28: about 100 ms model time, about 150 ms to first speech, audio tags such as `[whispers]`, 90+ languages including Dutch, and streaming over a WebSocket. List price is $0.04 per 1K characters ($0.011 until Oct 12).
7. **A conversational NPC is feasible at about 1.4 s p50 and 2.3 s p90** from the player releasing push-to-talk to the first NPC audio, and a pre-rendered filler sound can cover the gap at about 0.15 s. Pre-rendering each lure ahead of time would cut it from about 2.5 s to about 0.2 s.
8. **Display names aren't filtered.**
   - `core/crews.ts:80-83` and `net/reqs.ts:14` only strip control characters and `<>`.
   - Raw names go into the HR memo prompts (`review.ts:94,107`).
   - Lures are already safe: `speakableName()` plus `blocked()` in `lure.ts:131-137` and `187-204`.
9. **Voice cloning:** clone nobody's voice for now (no friends' voices, nobody else's either).
   - ElevenLabs' policy (updated 2026-08-17) requires consent, and Professional Voice Cloning only allows your own voice.
   - EU AI Act Article 50 has applied since 2 Aug 2026.
   - `docs/STEAM.md:260` currently promises "never clones of real players".
10. **TTS money isn't counted in the dollar budget.** `gateway.ts:183` logs provider rows with `usd: 0`; the only TTS cap is the lure route's 3,000 characters per 12 h.

## 2. Evidence

**Measurements on this host tonight**

| What | Result |
|---|---|
| STT live tonight (`theboys-live/logs/stt.log`, 149 requests, median clip 2.0 s) | total p50 67.9 / p90 92.4 / p99 146 ms; VAD 2.5, language 43.8, ASR 14.7 ms (p50); en 117, nl 10, no speech 22 |
| STT now, GPU at 97% (my probe, 4 runs per clip, langs en,nl) | 2 s: 272 ms, 3 s: 256 ms, 6 s: 410 ms (language stage 151–178 ms). With langs=en: 253 / 290 / 333 ms |
| Parakeet v3 int8, CPU only, 4 or 8 threads, CPU 34% busy | 2 s: 104 ms, 3 s: 135–142, 6 s: 225–253; four 2 s clips at once: 123–163 ms. Same text quality as Whisper on the fixtures |
| Current CPU fallback (Whisper turbo int8, 8 threads) | 3,964–4,297 ms for any clip (it pads every clip to a 30 s window) |
| ws bot → bridge → sidecar → utterance (my :3815 server, mock AI, 8 rounds) | p50 249 ms, max 280; STT itself 243 ms, so the server adds about 6 ms |
| Mock lure, `dbg.ai.lure` → `ai.lure` event | 1–23 ms |
| Kokoro-82M fp32 on CPU (kokoro-js) | RTF (synthesis time ÷ audio length) 0.11: 460 ms for a 4.2 s line, 1,331 ms for 11.6 s. First audio chunk when streamed: 233–289 ms |
| Network from the host, warm connection, unauthenticated 401/404 | Anthropic 137–163 ms; ElevenLabs 138–148; Cartesia 120–332. Cold TLS adds 25–60 ms. Deepgram (US) TCP alone 160–186 ms |
| Haiku 5.5 from the logs (all cold warm-ups) | Listener 1.06–2.31 s, lure 1.60–1.97 s, about 1.0K input / 40 output tokens. JEV director p50 281 ms, JEV Listener 313–364 ms |

**Current pipeline, speech end to Listener action:** about 1.0–1.3 s at p50 with JEV. That covers the 450 ms VAD hang (`config/balance/voice.json` `vadHangMs`, `mic.ts:354`), up to 100 ms of chunking, about 65 ms uplink, 70–400 ms of STT and about 290 ms of JEV. The PLAN target of p90 ≤ 2.5 s is met.

**Vendor and Claude facts**
- **ElevenLabs** API (billed in dollars, the same price on every tier):
  - Flash v2.5, Turbo and v3 Conversational: $0.04 per 1K characters. v4: $0.08. v4 Turbo: $0.04 ($0.011 until Oct 12).
  - Agents: $0.08 per minute.
  - Creator plan: $22 for 121K credits; Flash and Turbo cost 0.5–1 credit per character.
  - The multi-context WebSocket allows 5 contexts per connection, times out after 20 s idle (configurable up to 180 s) and expects `flush` at the end of each sentence.
  - Their stated first-byte time from Europe is 100–150 ms.
  - Sources: [API pricing](https://elevenlabs.io/pricing/api), [plans](https://elevenlabs.io/pricing), [models](https://elevenlabs.io/docs/overview/models), [v4 Turbo](https://elevenlabs.io/agents/v4-turbo), [v4 review](https://www.eesel.ai/blog/eleven-v4), [latency](https://elevenlabs.io/docs/api-reference/reducing-latency), [multi-context WS](https://elevenlabs.io/docs/cookbooks/multi-context-web-socket).
- **Cartesia** Sonic 3.6 (snapshot 2026-08-27, 44 languages including Dutch): Pro is $5 for 100K characters, overage $45–65 per 1M; real-world first audio about 166–190 ms. Sources: [pricing](https://cartesia.ai/pricing), [models](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest), [latency review](https://invideo.io/blog/cartesia-sonic-ai-voice/).
- **Deepgram** Aura-2: $0.030 per 1K characters, Dutch added in January 2026; the Voice Agent costs $0.075 per minute; Nova-3 STT $0.0048 per minute. Sources: [pricing](https://deepgram.com/pricing), [Dutch](https://deepgram.com/learn/aura-2-now-speaks-dutch-french-german-italian-japanese).
- **Google and Azure** (their official pages wouldn't render the prices, so these are secondary): Chirp 3 HD $30 per 1M characters ([costbench](https://costbench.com/software/ai-voice-tools/google-cloud-text-to-speech/)); Azure neural voices about $15 per 1M (secondary search results; [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/speech/) didn't render the figures).
- **OpenAI gpt-realtime-2.1**: about $0.06–0.11 per minute, mini about $0.02–0.05 ([pricing analysis](https://aireiter.com/blog/openai-realtime-api-pricing)). Anthropic has no realtime speech-to-speech API.
- **Local models:**
  - Kokoro has no Dutch ([languages](https://pykokoro.readthedocs.io/)).
  - Kyutai Pocket TTS (100M parameters, CPU, about 200 ms to first audio) lists Dutch and can clone a voice from about 5 s of audio ([Kyutai](https://kyutai.org/tts/)).
  - sherpa-onnx-node runs Kokoro, Piper/VITS and Pocket on Windows ([npm](https://classic.yarnpkg.com/en/package/sherpa-onnx-node)).
  - Parakeet v3 covers 25 European languages including Dutch ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)).
  - Nemotron 3.5 streaming ASR runs on the CPU with nl-NL at 11.5% WER and en at 7.9% (1.12 s chunks) ([model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)).
  - Smart Turn v3.2 detects end of turn in about 12 ms on a CPU, in 23 languages including Dutch ([Daily](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/), [ONNX](https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX)).
  - Moonshine v2 has no Dutch ([arXiv](https://arxiv.org/abs/2602.12241)).
- **Claude** (claude-api skill, cached 2026-10-06):
  - Haiku 5.5 costs $0.10 / $0.50 per million tokens (in/out); cache writes 1.25×, reads 0.1×.
  - The minimum cacheable prefix is 512 tokens.
  - Pre-warming with `max_tokens: 0` is rejected together with `stream` or `output_config.format`.
  - `inference_geo` only accepts `us` or `global`.
  - Haiku 5.5 does accept a forced `tool_choice`, and then skips thinking, but CLAUDE.md bans that.
  - Artificial Analysis measured Haiku 5.5 output at 240 tokens/s ([link](https://artificialanalysis.ai/models/claude-haiku-5-5)).
- **Ethics and rules:**
  - [ElevenLabs use policy](https://elevenlabs.io/use-policy): no voice replication without consent; disclose AI to users; anyone under 18 needs guardian consent.
  - The [Article 50 guidelines](https://www.stephensonharwood.com/post/102nfqh/eu-ai-act-update-european-commission-adopts-guidelines-on-article-50-transparenc/) apply from 2026-08-02. An AI you talk to must disclose itself at the first interaction, and a spoken disclosure is acceptable. Deepfakes inside fiction get a lighter disclosure regime.

## 3. Recommendations

None of these needs a real-GPU pass. Audio and logic can be checked in the SwiftShader lane or with ws bots.

| # | What to do | Impact | Effort / risk | Owner | How to verify |
|---|---|---|---|---|---|
| R1 | **Move STT off the GPU.** Add a Parakeet backend (`onnx-asr` 0.12; `onnxruntime` is already pinned) behind `STT_ENGINE`. Make it the automatic fallback when CUDA fails, or the default. | 104–253 ms on the CPU, vs 250–410 ms on a busy GPU and about 4 s for today's fallback. Removes constant load from the faulty card | M / medium: no hotword biasing, and its language output needs checking | (e) `services/stt`, frozen this round, so the integrator schedules it | `test_stt.mjs --no-spawn` on the fixtures, plus a consenting EN/NL recording set |
| R2 | **Sticky language per speaker** (`bridge.ts:314`): after 3 confident detections, send one language and re-check every Nth segment | Saves about 40 ms, roughly 60% of GPU time per utterance | S / low | (e) `stt` | The sidecar's `stages.langMs` drops to 0 |
| R3 | **Look into the 49% empty results.** Log drop reasons and an `avg_logprob` histogram (counts only); try −0.8 against faster-whisper's default of −1.0 | Recovers some of the 51 dropped segments | S / low–medium (more junk text) | (e) `services/stt` | Contract summary: share of empty results |
| R4 | **NPC dialogue manager: code decides, Claude voices.** Code owns prices, bounds and book rules. Haiku 5.5 streams with effort low, the system persona of at least 512 tokens is cached, and conversations use automatic caching. Put the JSON decision fields first and `say` last, with `{OFFER}`-style numbers filled in by code. Gate every sentence through `blocked()` and the META filter. Barge-in aborts the stream and closes the TTS context | Boss call about 1.4 s p50 / 2.3 s p90. Resistant to injection ("give us 500%") | L / medium | Integrator assigns a new package (e.g. `apps/*/src/npc/**`, `messages/npc.ts`) | ws-bot e2e in mock mode, then one small live A/B |
| R5 | **Streaming TTS adapter.** One persistent ElevenLabs multi-context WebSocket per contract, using `eleven_v4_turbo` (tags such as `[whispers]`) or `eleven_flash_v2_5`. Send phone and radio voices as `ulaw_8000` (64 kbps, already telephone quality) and close voices as `pcm_16000/22050`. Forward them as binary ws frames to an AudioWorklet ring buffer and through the existing radio chain. Send whole lines under 4 s, so a main-thread freeze can't break them mid-line, and don't start speech during join, drive or contract-start hitches | First audio about 250 ms (p90 about 400 ms) instead of a full file and a fetch | M / medium | (e) server `ai`, client `ai`; E5 for audio-chain reuse | ws bot: time from first frame to playback; SwiftShader lane for the playback UI |
| R6 | **Local CPU TTS fallback:** sherpa-onnx-node (Kokoro for English, Piper or Pocket for Dutch) in a child process with capped threads. Never on the GPU, never in friends' browsers (they already run at 13–14 fps) | $0, about 230–290 ms to first chunk, works offline | M / low | Integrator (new dependency), (e) | Kokoro numbers above |
| R7 | **Pre-rendered banks** at build time (ElevenLabs v4 with tags): greetings, fillers ("Mm.", a line click, a breath), stock negotiation moves, book whispers. Render each player's filtered first name in each NPC voice when they join | 0 ms for common lines; the filler covers about 1.2 s | S–M / low | assets + E5 | Count bank hits in the logs |
| R8 | **Pre-render lures** when the Listener hears a meaningful line while a lure is ready. Separately, find out why `radio_lure` never fires (G2) | Lure plays in about 0.2 s instead of about 2.5 s; about 1–3K characters per contract | M / low | (e) `lure.ts`, G2 | The usage log shows `lure.tts` rows in real sessions |
| R9 | **Budgets:** price TTS at $0.04 per 1K characters inside the $3 budget (`gateway.ts:183`). Per-feature character caps (boss 4K, vendors 2.5K, book 2K, radio 4K, lures 3K, about $0.62 maximum per session); a per-player NPC rate of 1 turn per 3 s; keep the 401/429 kill switches | A bug can't run up costs | S / low | (e) | Unit tests on the gateway |
| R10 | **Fallback order:** cloud TTS → local TTS → bank template → subtitles plus static. An LLM timeout over 2.5 s or a refusal (Haiku 5.5 has no server-side fallback) plays an in-character canned line | Never silent | S / low | (e) | Mock fault injection |
| R11 | **Voices:** use ElevenLabs Voice Design ([docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/voice-design)) for the boss, vendors and book, and replay-based mimicry for anything in a player's own voice. Real-voice cloning only later, with a separate opt-in each session, a local model, RAM-only reference audio and an updated `STEAM.md:260`. Speak or show "AI" at the first NPC interaction (Art. 50) | Compliant, no risk to anyone's likeness | S / low | Integrator (consent UI and STEAM.md), (e) | Review the consent screen |
| R12 | **Optional:** evaluate Sonnet 5.5 for the boss persona with `thinking:{type:'between_tools'}` | Better acting for about $0.04 per session | S / low | (e) | Live A/B under $0.05 |

**Latency budget for the boss call over the phone (push-to-talk), p50 / p90**

| Step | p50 | p90 |
|---|---|---|
| Last voice chunk reaches the server | 100 ms | 165 ms |
| STT on the CPU | 105 ms | 160 ms |
| Haiku first text token (estimate) | 700 ms | 1,200 ms |
| First sentence finished | 60 ms | 100 ms |
| First TTS audio | 250 ms | 400 ms |
| Downlink plus a 120 ms jitter buffer | 185 ms | 250 ms |
| **Total** | **≈1.4 s** | **≈2.3 s** |

A vendor you talk to without push-to-talk adds the 450 ms VAD hang; Smart Turn v3.2 could shorten that.

## 4. Quick wins for tonight (software lane, low risk)

1. **Name filter.** Move the `lure.ts` BLOCKED list into a shared module and apply it in `core/crews.ts` `cleanName` (integrator). Request the same in `net/reqs.ts:14` and `speakableName()` in `review.ts:94,107`. Unit-testable.
2. **Prompt caching.** Add `cache_control: {type:'ephemeral'}` to the system block in `gateway.ts:444`; both the Listener and lure prompts are over 512 tokens. This is a request to (e). Check it with one `npm run ai:check` (about $0.02) and confirm `cacheR > 0` in `ai-usage.jsonl`.
3. **Streaming benchmark.** Add a `--stream` mode to `tools/ai-check.mjs` (env track) that measures first-token time for a 40-token reply, with and without caching (n=10, under $0.01).
4. **Count TTS dollars** in the usage log and the budget (R9).
5. **Diagnose why `radio_lure` never fires** (G2, read-only).

## 5. Open questions

- Steady-state Haiku 5.5 time to first token from this host. Every in-game sample was a cold warm-up, and I made no live calls.
- Whether this account's API calls draw Creator credits or dollars. The 2026 API pricing page says "API usage is billed in US dollars, not credits".
- What is in the 51 dropped segments. No text is logged, but one 22-character length came up 12 times, which suggests a recurring phrase or a hallucination.
- Parakeet's accuracy on real Dutch and English speech and callsigns without hotwords.
- CPU headroom on the host with its own game, Parakeet, local TTS and the server tick all running at once. I only measured single bursts.
- Whether `global` inference serves Europe at all. Vertex AI and Bedrock EU regions weren't evaluated.
- Real first-byte times from ElevenLabs and Cartesia on this host. I only measured each vendor's front door.