# perf-server-net report: server, network, loading and voice latency (DEAD AIR v1.2, main = 25058ac)

I changed no repo files, and no players were on :3000 during my runs (checked with netstat). All my processes are stopped and I made no worktrees. My scripts and raw outputs are in `<scratch>/night\perf-server-net\`. The main ones:
- `srv.mts`: instrumented server with no Vite
- `bots.mts`: 6-bot load
- `out/run6-srv.json`, `out/run6np-srv.json`, `out/smoke-srv.json`, `out/cap6/`: captured frames
- `encode.mts`, `deflate-rx.mjs`, `big.mts`, `clocksim.mts`, `telemetry-analyze.mjs`, `assets-audit.mjs`, `timers.mjs`, `drive-probe.mts`
- `clientbuild/`: a temp v1.2 build
- `live-server.anon.log`

In the anonymised log, N2 = P1, N3 = P2 and N1 = P3. The 6-bot contract runs are from this agent's earlier interrupted session last night (23:39–00:18); I re-ran the drive probe, timers, encoding, asset and telemetry analyses today.

## 1. Top findings

1. **The remote friends' "130 ms rtt" is mostly the client's own frame time, not the network or the server.**
   - On a CPU-bound client, the pong waits for the end of the frame it lands in, so the app RTT ≈ ceil(net RTT / frame time) × frame time.
   - Afternoon, P3: rtt ≈ one frame (median rtt − frame = 5 ms), so the network RTT was under ~50 ms.
   - Evening, P2 and P3: rtt ≈ two frames (P3: corr(rtt, frame time) = 0.90; median rtt − frame = 65 / 72 ms). So the network RTT was about 65–130 ms for **both** friends at the same time. Something on the shared path got worse in the evening; I could not establish what.
   - The server and host side are fast:
     - The server answers pings in the socket handler: p50 0.17 ms, p99 0.84 ms under 6 bots.
     - Host to the Cloudflare edge (ZRH) is 5–11 ms ICMP.
2. **The drive phase sends the whole facility, and that defeats the drive preload for slow clients.**
   - `generateFacilityForCrew` sets `crew.layout = L` as a side effect (`apps/server/src/level/index.ts:71`). This contradicts the "hub while driving" comment at `:101`.
   - So the `phase: drive` event already carries the facility (100–155 KB per player).
   - Clients rebuild it synchronously inside the WebSocket handler (`apps/client/src/level/index.ts:1040` → `rebuild()` at `:296`).
   - A slow client freezes before it can send `net.preload` (`apps/client/src/loading/index.ts:239-243`, which runs after a 1.2 s sleep). The server only waits for clients that asked (`meta/flow.ts:1366`), so it doesn't wait.
   - Evidence: the evening drive ended at exactly `driveSec` = 12.0 s, with no "preloaded" line for P2 or P3, and P2's 15.9 s frame started at the drive. In the earlier session the van waited 28.4 s for P1.
3. **The same layout is sent about 4 times per player per contract** (`core/context.ts:90` sends a full `FullState` on every phase):

   | Message | Size per player |
   |---|---|
   | drive event | 155 KB |
   | `net.preload` reply | 119 KB |
   | contract event | 157 KB |
   | results event | 166 KB |

   That is about 600 KB per player per cycle, of which about 440 KB is redundant. Each `setPhase` costs the server 10–31 ms. Layout items are 103 KB of the 119 KB layout. Deflate level 1 shrinks 166 KB to 33 KB.
4. **Server CPU is a non-issue.** For a 6-bot crew at risk 2 on a 64×60 site:
   - tick p50 0.36–0.43 ms, p99 1.4–1.6 ms (33 ms budget)
   - process CPU 43–69 ms/s, i.e. 4–7 % of one core, including ws I/O
   - GC 0.35–0.5 ms/s, max pause 2.9 ms, heap 22–32 MB

   Hot paths: monsters 4.6–4.8 ms/s, aud sound floods 2.6–2.7 ms/s, STT bridge 2.0–2.4, objectives 1.6–1.8, footstep noise 1.4–1.75. The only stalls are once per phase: `setPhase` encode, and synchronous save writes at contract end (25–50 ms on Windows).
5. **Bandwidth is modest but larger than PLAN §4.5 estimates.**
   - Snapshots are about 1.0–1.1 KB at 6 players and 20 Hz: 158–171 kbps per client. Plus events, about 185 kbps per client down (the plan said 50–60).
   - Up: poses 13 kbps; STT PCM 256 kbps while talking (the live average was 89–102 kbps per friend).
   - Snapshots are msgpack maps with float64s and string ids (`packages/shared/src/envelope.ts:48`). Quantised tuples would be 209 B and fixed binary 154 B (−79–84 %). Per-receiver permessage-deflate would be about 152 B.

   None of this is a latency cause at these rates.
6. **About 60 MiB of the 65 MiB of game assets probably bypass Cloudflare's cache.**
   - Cloudflare caches by file extension. `.glb`, `.ktx2`, `.wav`, `.json` and `.wasm` are not in the default list. Unless a Cache Rule exists, those are served from the host's uplink through the tunnel for every first-time player.
   - The origin already sends `public, max-age=31536000, immutable` on hashed files.
   - A typical 6-player site download for a new player is roughly 25–40 MB. The join download is about 13 MB (10.6 MB assets plus about 2.4 MB of JS).
7. **The client render clock jumps every 2 s.**
   - The pong handler feeds `m.s + rtt/2` into the same max-filter as the one-way snapshot samples (`apps/client/src/core/net.ts:244`, `core/world.ts:157`).
   - Simulated for a 14 fps client with 45 ms one-way delay: interpolation delay 158 ms, and render-clock jumps of up to 65–78 ms every ping.
   - With snapshot samples only: 123 ms delay and at most 18–20 ms jumps. This is a one-line fix.
8. **Voice media is fine, but its control data runs on the main thread.**
   - The WebRTC mesh, Chrome-default Opus (32 kbps mono, 20 ms frames, FEC, DTX off), NetEq and Cloudflare TURN are all right. Estimated mouth-to-ear is about 110–180 ms in Europe.
   - But band/push-to-talk, `loud` and STT chunks all go through the main thread. During a freeze of more than 3 s, others gate the frozen speaker to whisper range (`voice/index.ts:321`, `playback.ts:222-224`), and monsters stop hearing them after 1.5 s.
   - Afterwards, the queued PCM (about 512 KB for a 16 s freeze) is burst-sent with no `bufferedAmount` guard (`core/net.ts:386`).
9. **Windows timers quantise the server loop to 15.6 ms.**
   - `setTimeout(1)` wakes at p50 15.52 ms, and `Atomics.wait(1)` is the same.
   - Snapshot gaps are therefore 46.9 or 62.5 ms (p50 46.87, p99 63.3 without a profiler).
   - It's harmless, because snapshots carry server timestamps and the adaptive buffer absorbs about 15 ms. No action needed. Note that attaching the CPU profiler hides it (gaps became 48.5–51.4 ms).

## 2. Evidence

### 2.1 Server CPU and tick (6 ws bots, risk 2, 64×60 site, 994 items, 87 doors, monsters on, fake 60 ms STT, all bots talking about 50 % of the time)

| Metric (contract window) | run6 (with profiler) | run6np (no profiler) |
|---|---|---|
| tick p50 / p90 / p99 / max | 0.36 / 0.74 / 1.58 / 48.9 ms | 0.43 / 0.79 / 1.37 / 32.3 ms |
| steady-state tick max | 19.1 ms | 8.05 ms |
| snapshot round (build + 6 encodes + sends) p50 / p99 | 0.46 / 1.07 ms | 0.46 / 0.99 ms |
| snapshot gap p1 / p50 / p99 | 48.5 / 50.0 / 51.4 ms | 45.4 / 46.9 / 63.3 ms |
| process CPU | 69 ms/s | 43–48 ms/s |
| event-loop utilisation | 0.046 | 0.038 |
| GC | 0.36 ms/s (max 2.9 ms) | 0.49 ms/s |
| server out / in | 145 / 69 KB/s | 144 / 67 KB/s |

- **Systems (ms per second, contract):** monsters 4.6–4.8 · ai.stt 2.0–2.4 · objectives 1.6–1.8 · players.noise 1.4–1.75 · meta 1.0–1.1 · paranormal 1.0–1.1 · interaction 0.6–0.7 · director 0.4–0.5.
- **Hooks (ms per second):** `crewSnapshot:netAudCrew` 2.6–2.7 · `pose:netValidatePose` 0.6–0.75 · `snapshot:netAudReceiver` 0.4.
- **Top repo self-time** (all trivial): `doorView` (`net/grid.ts:41`, rebuilds a signature string and Map per call), `floodCells`, interaction `slice`, `netBalance` (copies the defaults per call, `net/balance.ts:33`).
- **Spikes:**
  - `setPhase` drive 22–31 ms, contract 14–16 ms, results 14–21 ms. With 3 players, drive was 10.4 ms / 303 KB.
  - Results save flush: the slow tick was "objectives = 30–47 ms". The profile shows `rename` 25.7 and 26.4 ms buckets from `writeJsonAtomic`. These are synchronous mkdir, write and rename calls (`meta/saves.ts:15-30`, `net/session.ts:68`).
- **Server share of the RTT:** a localhost request/reply under load took p50 0.17 ms, p99 0.84 ms, max 53–57 ms (the max was at phase changes). Pongs are sent straight from the socket handler (`core/ws.ts:98-101`).

### 2.2 Network: sizes and rates (6 clients, contract, msgpack payload)

| Stream | Size | Rate | Per client |
|---|---|---|---|
| snapshot | 990 B median, 1.05 KB mean, 1.12 KB max | 20 Hz | 158–171 kbps down |
| snapshot breakdown | players 486 B (81 B each) · monsters 345 B (86 B each) · aud 65 B · dyn 40 B · envelope 67 B | | |
| events (contract) | objectives.state 3.9 KB per change, crew 1.3 KB, interaction.patch up to 8 KB | | ≈14 kbps |
| meta.update (hub) | about 10 KB full view per player per change | up to about 1/s | up to about 80 kbps in the hub |
| phase events | 155 / 157 / 166 KB (drive / contract / results), hub 14 KB | per phase | bursts |
| `net.preload` reply | 119 KB (items 103: props 68, lights 19, loot 13) | once per drive | redundant |
| pose (up) | 80 B | 20 Hz | 12.8 kbps |
| STT PCM (up) | 3.2 KB per 100 ms | while talking | 256 kbps |
| WebRTC voice (P2P) | Opus 32 kbps + RTP/SRTP/UDP overhead | 50 pps × 5 peers | ≈275 kbps up and ≈275 down |

Snapshot encodings, measured on 600 captured contract snapshots (`encode.mts`, `deflate-rx.mjs`):

| Encoding | Bytes | At 20 Hz |
|---|---|---|
| current msgpack map (float64) | 990 | 158 kbps |
| + float32 | 930 | 149 kbps |
| msgpackr records | 530 | 85 kbps |
| JSON | 1340 | 214 kbps |
| quantised tuples (cm ints, u16 yaw, id index) | 209 | 33 kbps |
| fixed binary | 154 | 25 kbps |
| per-receiver permessage-deflate, level 1 / level 6 | 152 / 124 | 24 / 20 kbps |

Bots move more predictably than humans, so expect deflate to do worse on real traffic. Decoding a 166 KB phase message takes 0.85 ms, plus 0.76 ms for `verifyLayoutHash`, on this CPU. Network decode is not a freeze cause.

### 2.3 Latency

Live telemetry, from `telemetry-analyze.mjs` over the anonymised log:

| Player, window | fps (median) | frame p50 | app rtt median (min–max) | rtt − frame | corr(rtt, frame) |
|---|---|---|---|---|---|
| P1 host (local) | 145 | 6.0 ms | 4 (0–11) ms | −1 | — |
| P3 afternoon (v1.1) | 18 | 52 ms | 60 (47–432) ms | 5 | 0.24 (0.99 vs p95 frame) |
| P2 evening | 14 | 71 ms | 139 (45–252) ms | 72 | 0.54 |
| P3 evening | 14 | 65 ms | 130 (80–352) ms | 65 | 0.90 |

- The 5003 ms and 2111 ms samples are pongs stuck behind 6 s and 15.9 s frames.
- **Path components measured:**
  - Host to `play.dead-air.io` anycast edge: 5–11 ms, average 7 ms. The host is in CH, nearest colo ZRH.
  - The October 6 quick tunnel registered `fra15`/`fra16` over QUIC (`logs/cloudflared.log`). The named-tunnel colos are not visible.
  - Connecting to `[::1]` with no listener fails in 1.3 ms, so a `localhost` origin costs nothing.
- **Render-clock simulation** (`clocksim.mts`, which drives the real `core/world.ts` plus the `net/stats.ts` formula):

  | Client | Current: interp delay / max clock jump | Snapshot-only: interp delay / max clock jump |
  |---|---|---|
  | Host-like | 80 ms / 3.6 ms | identical |
  | 14 fps, 45 ms one-way | 158 ms / 65 ms | 123 ms / 20 ms |
  | 14 fps, 45 ms one-way, +40 ms upload queue | 176 ms / 78 ms | 127 ms / 18 ms |

- **Remote-entity budget for a 14 fps friend:** about 190 ms render-behind-server, plus a 70 ms frame and display, plus about 25 ms snapshot cadence, gives about 280–300 ms. For the host it is about 90 ms.
  - Lag samples include up to one frame of main-thread queueing (`net/stats.ts:63`), which pushes the delay toward the 250 ms cap.
  - A 300 ms monster wind-up leaves a 14 fps friend about 0–150 ms to react: about 0 ms for the interpolated body, about 150 ms for the telegraph event.
  - Low-fps senders also publish poses at about 14 Hz unevenly (the timer is blocked by 70 ms frames), so others see their motion stair-stepped.

### 2.4 Loading

- **v1.2 client bundle** (temp build): main 920 KB (323 KB gzip), assets 1,306 KB (361 KB), voice 91 KB, config 31 KB, ui 22 KB, CSS 98 KB (23 KB), basis wasm 527 KB (249 KB). Total initial JS is about 2.4 MB raw, about 0.8 MB compressed.
- **Assets** (manifest 68.5 MB: boot 3.4, lobby 7.2, site 58.0), by referenced file:

  | Type | Size | Notes | HTTP-compression gain |
  |---|---|---|---|
  | KTX2 | 33.1 MiB | ETC1S/BasisLZ 51 files, 11.3 MiB; UASTC+zstd 25 normal maps (1024²), 21.8 MiB | 0 % |
  | GLB | 23.6 MiB | all 53 meshopt + quantised, 173 embedded KTX2 images | 7–9 % site, 38–44 % boot |
  | MP3 | 4.3 MiB | | 0 % |
  | WAV | 3.5 MiB | 4 loops | 11 % |
  | OGG | 0.8 MiB | | |

  Overall gain from gzip/brotli would be about 6 %.
- A 6-player "transport" site used 16 distinct GLB props (10.7 MB), plus theme textures and site sound effects.
- **Headers on my server** (`curl`):
  - Hashed files: `public, max-age=31536000, immutable`, weak ETag, no `Content-Encoding`. sirv is configured without gzip or brotli (`core/http.ts:67,100`).
  - `manifest.json` and `/assets/basis/*`: `no-cache`.
  - Node's keep-alive timeout is 5 s versus cloudflared's 90 s.

## 3. Recommendations

1. **Edge-cache the static files: a Cache Rule plus Smart Tiered Cache.**
   - What: in the dead-air.io zone, set `URI path starts with /assets/ or /app/` → eligible for cache, edge TTL "respect origin". Do not match `/ws`, `/healthz` or `/api/*`; a cache rule once broke WebSockets at GitLab. Enable Smart Tiered Cache (available on Free).
   - Impact: the host serves each new asset once instead of once per player (−83 % uplink at 6 players), and friends download at their own speed from ZRH. Files sent as `no-cache` stay uncached, which is correct.
   - Effort S (dashboard, no code). Risk low. Owner: host/integrator.
   - Verify: `curl -sI https://play.dead-air.io/assets/tex/carpet/normal.c8747a656c.ktx2` twice; expect `cf-cache-status` MISS then HIT. No GPU needed.
2. **Keep the hub during the drive and stop re-sending the layout.**
   - (a) E1: drop the `crew.layout = L` side effect (`level/index.ts:71`). `startContract` already passes the layout (`meta/flow.ts:769`). Then the drive event shrinks to about 14 KB and the designed preload flow (paint, `net.preload`, build, `net.loaded`, server waits) actually runs.
   - (b) Integrator: send the layout in `FullState` only when the receiver doesn't have its hash. This means an additive `FullState.layoutHash` and having `world.applyFull` keep the current layout.
   - Impact: −440 KB per player per contract (−2.6 MB at 6 players); `setPhase` 10–31 ms → a few ms; no post-phase snapshot skips. Slow clients hold the van (up to 30 s) instead of arriving unbuilt.
   - Effort S + M. Risk medium: the drive spawn position changes, so the drive/v12r gates must pass.
   - Verify: `srv.mts` bytes per `setPhase`, `drive-probe.mts`, a SwiftShader 2-client drive.
3. **Server-side preload intent.** Treat every connected non-bot client as preloading at drive start, so a frozen client is waited for (capped by `driveLoadWaitSec`). This is `meta/flow.ts` `crewLoaded` (G4); `net/loading.ts` is ① net, which is frozen this round. Effort S, risk low. Verify with bots that ask late.
4. **Render clock.** Stop feeding pong midpoints into `observeServerTime` (`core/net.ts:244`); keep the RTT median.
   - Impact: −35–50 ms interpolation delay, and render-clock jumps of 65–78 ms → about 20 ms for slow or remote clients.
   - Effort S. Risk low: UI countdowns shift by ≤ one-way delay. Owner: integrator.
   - Verify: turn `clocksim.mts` into a unit test.
5. **Network-only RTT telemetry.**
   - Time `ws.ping()` → `'pong'` per connection every 5 s (`core/ws.ts:129,158`) and log it next to the app RTT.
   - Clients add the WebRTC selected-candidate-pair `currentRoundTripTime` and `jitterBufferDelay`.
   - This settles what made the evening +65 ms. Chrome should answer ws pings from its network stack even when the page's main thread is frozen (Chromium's WebSocketChannel runs in the network service); verify that once with a 30 s busy-loop page.
   - Effort S. Owner: integrator, plus voice (v1.3).
6. **Guard voice chunks.** In `core/net.ts:386`, skip STT chunks when `ws.bufferedAmount > 32 KB`. This prevents 0.5 MB post-freeze bursts that delay poses and pings for seconds. Effort S, risk low (STT already drops stale segments). Owner: integrator.
7. **Socket in a Worker (v1.3).**
   - Worker-owned WebSocket that decodes and timestamps arrivals, with the mic worklet's port wired straight to it.
   - Impact: −~70 ms interpolation at 14 fps; `loud` and STT keep flowing during freezes, so monsters stay fair. An honest HUD RTT.
   - Effort M–L, risk medium. Owner: integrator + voice.
8. **Compact snapshots.** Quantised binary snapshot (−84 %, 158 → 25 kbps per client) or tuples (−79 %).
   - Alternative: permessage-deflate (`core/ws.ts:47`), but only after testing that Cloudflare passes the extension through; I found no documentation either way. Big messages can instead be deflated at the app level with a new FRAME kind (166 → 33 KB).
   - Effort M, risk medium (frozen envelope, additive only). Value: robustness and garbage collection, not latency.
9. **Async saves.** Use `fs.promises` in `meta/saves.ts` (G4); ① net's `session.ts` later. Impact: removes 25–50 ms loop stalls at results. Effort S.
10. **Node keep-alive.** Set `server.keepAliveTimeout = 95_000` and `headersTimeout = 96_000` (`core/http.ts:64`) so it outlives cloudflared's 90 s pool. Effort S, hygiene.
11. **Smaller assets** (E1 / E5): RDO-encoded UASTC normal maps (expect −25–40 %), or 512² normals for the low preset (−75 % of 21.8 MiB); WAV loops → OGG (−3 MB); pre-compressed `.br` GLBs via sirv `brotli: true` (−3 MB). Needs a real-GPU visual pass for quality.
12. **Voice requests (v1.3, voice is frozen this round):**
    - `usedtx=1` cuts idle mesh traffic by about 90 %.
    - Receiver-side band estimation, so a frozen speaker isn't gated to whisper range.
    - Opus-encode the STT stream with WebCodecs (256 → about 24 kbps).
    - Pose timestamps for low-fps senders (M).
13. **No action needed:** server CPU, GC, tunnel protocol (QUIC), the `localhost` origin, the Windows timer quantisation. Alternatives to the tunnel (port-forward, Argo, a VPS) would save ≤ 5–15 ms for CH/EU friends and aren't worth it.

## 4. Quick wins tonight (software lane, low risk)
- **#1 Cache Rule + Tiered Cache:** dashboard clicks by the host, then the curl check.
- **#4** `core/net.ts:244`: one line.
- **#6** `core/net.ts:386` `bufferedAmount` guard: one line.
- **#5** ws-ping RTT logged from core: about 15 lines.
- **#10** keep-alive timeouts: 2 lines.
- **#3 and #9** if G4 is available.

All of these verify with `npm run check`, `node --test`, and a `bots.mts` / `drive-probe.mts` run. None needs a GPU.

## 5. Open questions
- What is the host's uplink speed? Run speed.cloudflare.com when not gaming. It decides how critical #1 is.
- Does a Cache Rule already exist? I didn't send requests to the zone, to keep away from :3000.
- What caused the evening +65 ms on both friends? Candidates: Discord running alongside, friends' uplink while streaming voice and STT, the host's uplink, or ISP congestion. #5 will tell.
- Did the friends use the browser or the desktop app?
- Which colos does the named tunnel use?
- Does Cloudflare pass permessage-deflate through to the origin?
- The 6-human load is extrapolated from bots; real poses have more entropy.
- The host's preset dropped to medium and render scale 0.75 because of the `render/perf.ts` governor. The friends' render scale of 0.28 didn't raise fps because they are CPU-bound. Both are for the render agents.

**Sources**
- [Cloudflare default cache behaviour](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
- [Cloudflare content compression](https://developers.cloudflare.com/speed/optimization/content/compression/)
- [Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Smart Tiered Cache on all plans](https://developers.cloudflare.com/changelog/post/2026-04-17-smart-tiered-cache-for-public-cloud/), [cache plans](https://developers.cloudflare.com/cache/plans/)
- [Tunnel origin parameters](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/origin-configuration/), [tunnel configuration](https://developers.cloudflare.com/tunnel/configuration)
- [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets), [WebSocket message size limit](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)
- [GitLab: cache rule broke WebSocket upgrades](https://gitlab.com/gitlab-com/gl-infra/production/-/issues/8457)
- [RFC 7692 permessage-deflate](https://www.rfc-editor.org/rfc/rfc7692)
- [WebRTC Opus default config](https://webrtc.googlesource.com/src/+/9f4a5163fa/api/audio_codecs/opus/audio_encoder_opus_config.h), [Opus DTX](https://getstream.io/resources/projects/webrtc/advanced/dtx/)
- [timeBeginPeriod](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod), [high-resolution waitable timers (Dawson)](https://groups.google.com/a/chromium.org/g/scheduler-dev/c/0GlSPYreJeY)