
## Rendering platform: three.js r186 (npm 0.186.1) WebGPU/WebGL2 behavior, lighting systems (DynamicLighting, ClusteredLighting, VolumeNodeMaterial, VXGI), GPU binding limits, browser support, headless GPU testing. Source files were read from the 0.186.1 npm tarball and the r186 GitHub tag. Behavior was checked with local probes: Chrome 154 headless via playwright-core 1.63, RTX 5090 on D3D12. Probe scripts are in C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\fc_render\scripts\ (run.js plus pages\*.js) and raw results in ...\fc_render\out\results_*.json. The shared WebSearch budget ran out early, so all later evidence comes from direct fetches of primary sources and from the local probes. I could not search for third-party benchmarks.
- Q: What does DynamicLighting do when the number of unshadowed point lights exceeds maxPointLights: drop the extras, route them through the default per-light path, or recompile? Is a pool of 16-32 fixture lights reassigned every frame the right pattern?
  - (high) It drops the extras. They are not routed to the per-light path and nothing recompiles. PointLightDataNode.setLights warns 'N lights exceed the configured max of 16. Excess lights are ignored.', and update() fills only the first Math.min(count, maxCount) entries. The order is render-list order, which follows scene-graph traversal; nothing is sorted by distance or importance.

Probe (r186, WebGPU), DynamicLighting with defaults:
- 16 far lights plus 4 bright lights added last near the center: center luminance stayed 1.02 (the 4 bright lights were ignored).
- Removing 16 far lights: luminance jumped to 129.52.
- 0 new programs in every one of those steps.
- About one console.warn per render call, not deduplicated. With a RenderPipeline that is one warning per lit pass per frame.

The pool pattern is right, with these rules:
1. Size it explicitly with new DynamicLighting({ maxPointLights: 32 }) (or 16). Keep at most that many batchable point lights visible, and choose them yourself (nearest to the camera, or per room). Hide the rest with visible = false or by removing them; both are free (0 programs). intensity = 0 still counts toward the limit and still costs ALU.
2. Changing position, color, intensity or distance every frame is free (0 programs).
3. Every lit fragment loops over all batched lights in every lit pass; there is no per-tile culling. 16-32 lights is fine on desktop GPUs at 1080p, but cost scales with pixels × lights.
4. Batched lights cannot cast shadows and do not light VolumeNodeMaterial fog. Shadowed flashlights need the per-light path: create them once and never toggle castShadow or add/remove them, because each change recompiles (74-210 ms hitches measured on a 5090 in a tiny scene).
5. In production builds, preserve class names, for example Vite 8 build.rolldownOptions.output.keepNames = true. Without it, batching silently turns off (Vite 8.3.3 default minify renamed PointLight to 'Wa').
6. For more than about 32 unshadowed point lights on WebGPU, ClusteredLighting is the alternative, but it has no working WebGL2 path.
  - sources: https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/lighting/data/PointLightDataNode.js, https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/lighting/DynamicLightsNode.js, https://github.com/mrdoob/three.js/blob/r186/examples/jsm/lighting/DynamicLighting.js, https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/RenderList.js
- Q: Does ClusteredLighting run on WebGPURenderer's WebGL2 backend, where three emulates compute via transform feedback, or does it break?
  - (high) It breaks, and it does so silently. With forceWebGL: true, an identical 64-point-light scene produced mean luminance 0 under ClusteredLighting, against 230.35 with default lighting on WebGL2 and 230.35 with ClusteredLighting on WebGPU. There were no errors, warnings or exceptions, and the compute pipeline was still created.

Why, from the r186 source:
- The cluster-assignment compute writes several ivec4 chunks per invocation at index instanceIndex*chunks + i into an attributeArray storage buffer.
- The fragment shader reads arbitrary indices from that same buffer.
- On WebGL, StorageArrayElementNode ignores the index unless isPBO is set. It uses the per-invocation transform-feedback attribute instead.
- This buffer is created without setPBO(true), so both the scattered writes and the indexed reads collapse.

ClusteredLightsNode has no backend check; the official example only shows an error when WebGPU.isAvailable() is false.

What to do: after `await renderer.init()`, check renderer.backend.isWebGPUBackend. Use ClusteredLighting only when it is true, and DynamicLighting otherwise (or decide up front with WebGPU.isAvailable(), which awaits requestAdapter). Separately, clustered point lights do not light VolumeNodeMaterial fog on either backend (probe → 0). The cluster grid is also sized from the canvas, so reduced-resolution passes map to the wrong tiles (source-derived).
  - sources: https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/lighting/ClusteredLightsNode.js, https://github.com/mrdoob/three.js/blob/r186/src/nodes/utils/StorageArrayElementNode.js, https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_lights_clustered.html, local probe: ...\scratchpad\fc_render\scripts\pages\clustered.js (results in fc_render\out)
- Q: Can renderer.lighting = DynamicLighting coexist in one scene with shadowed ProjectorLights that use colorNode cookies and with VolumeNodeMaterial?
  - (high) Yes. It compiles and renders with no errors on both the WebGPU and WebGL2 backends. ProjectorLights are never batched, because their constructor name is not in the batching table. They keep the normal ProjectorLightNode path, so shadows and the colorNode cookie still work, and they scatter in VolumeNodeMaterial multiplied by their shadowNode, with the cookie evaluated at the ray position.

Probe fog luminance:
- Shadowed ProjectorLight with cookie: 7.08 with a blocker, 7.96 without, the same under DynamicLighting and default lighting.
- Shadowed point light: 21.03 in both modes.
- 4 unshadowed point lights: 0 under DynamicLighting, 56.96 under default lighting.

The catch is that last row: batched lights are invisible in the fog. The data nodes call lightingModel.direct() with a fake lightNode {light: {}, shadowNode: null}, and VolumetricLightingModel.direct() returns early unless lightNode.isAnalyticLightNode is set.

Rules that follow:
- Any light meant to make shafts must use the per-light path (shadowed, or a projector/mapped spot) and have the volumetric layer enabled (light.layers.enable(LAYER)).
- Every such light adds a depth texture and a sampler_comparison to every lit material, against a 16-per-stage budget; see the limits answer.
- Adding or removing one, or toggling castShadow, recompiles.
- Create the fog-casting lights (for example the 4 player flashlights) at level load and keep them for the whole session.
- Fake fixture glow in the fog with scatteringEmissiveNode, emissive sprites or billboards.
  - sources: https://github.com/mrdoob/three.js/blob/r186/src/nodes/functions/VolumetricLightingModel.js, https://github.com/mrdoob/three.js/blob/r186/src/nodes/lighting/ProjectorLightNode.js, https://github.com/mrdoob/three.js/blob/r186/src/nodes/lighting/SpotLightNode.js, https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/lighting/data/PointLightDataNode.js
- Q: What do adapter.limits.maxSampledTexturesPerShaderStage and maxSamplersPerShaderStage typically report on Chrome/D3D12 for RTX 30/40, RX 6000/7000 and Intel Arc or integrated GPUs (for example, webgpureport.org data)?
  - (medium) Chrome's Dawn buckets these limits into tiers (google/dawn src/dawn/native/Limits.cpp, main branch fetched 2026-10-06):
- maxSampledTexturesPerShaderStage: 16 / 16 / 16 / 48 across the compat / tier0 / tier1 / tier2 tiers.
- maxSamplersPerShaderStage: 16 in every tier.

So on Chrome or Edge, any GPU reports at most 48 sampled textures and exactly 16 samplers.

Measured here (Chrome 154, D3D12, RTX 5090): adapter 48 / 16. A device created without requiredLimits, which is what three does, gets 16 / 16.

Aggregate data from web3dsurvey.com (undated, all browsers):
- Sampled textures: NVIDIA ≥48 on 98% of devices, AMD ≥48 on 97%, Intel ≥48 on 75%; Windows ≥44 on 98%.
- Samplers: Windows ≥22 on only 8% (probably non-Chromium browsers), NVIDIA 16 on 100%, AMD ≥22 on 1%.

The practical expectation for RTX 30/40, RX 6000/7000 and Arc on Chrome/D3D12 is therefore 48 / 16. Some Intel iGPU systems report 16 / 16.

What this means for three: it binds one sampler per filterable texture, so 16 samplers is the real ceiling. Raising the texture limit to 48 does not help once the materials use linear filtering.

Probe budget: a 6-map MeshStandardMaterial plus scene.environment (8 fragment textures in r186) supports at most 8 PCF-shadowed lights in the scene. At 9 lights, WebGPU fails pipeline creation, and WebGL2 fails at 9 because MAX_TEXTURE_IMAGE_UNITS is 16. With 3 maps the maximum is 11.

Ways out:
- Fewer filtered maps (pack ORM into one texture).
- Nearest-filtered data textures, which need no sampler.
- Texture arrays or an atlas.
- Fewer shadow casters: every shadowed light in the scene is bound into every lit material.

I could not search for webgpureport.org aggregates because the search budget was exhausted; that site reports only the visitor's own GPU anyway.
  - sources: https://github.com/google/dawn/blob/main/src/dawn/native/Limits.cpp, https://web3dsurvey.com/webgpu/limits/maxSampledTexturesPerShaderStage, https://web3dsurvey.com/webgpu/limits/maxSamplersPerShaderStage, https://www.w3.org/TR/webgpu/#limits
- Q: Is there any measured cost for r18x running 4 shadowed 1024² spotlights, quarter-res volumetrics, half-res GTAO and TRAA at 1080p on an RTX 3060/4060? What does a shadow pass cost with 100-300 meshes, and does BundleGroup help shadow passes?
  - (low) I found no published measurement. The search budget ran out, so I could not look for third-party benchmarks. Instead I measured on this host: three r186, Chrome 154 headless, RTX 5090 plus Ryzen 9 9950X3D, 1920x1080. GPU time comes from unquantized WebGPU timestamps summed over all passes.

Test scene: 300 meshes averaging about 1.3k triangles, 6 MeshStandardMaterials, 8 unshadowed point lights and a hemisphere light.

| Config | GPU ms | CPU ms (render call) | Draws |
|---|---|---|---|
| Base | 0.084 | 0.53 | 266 |
| + 4 shadowed 1024² spots (PCF) | 0.129 (about 0.01 ms per shadow pass) | 1.57 | 707 |
| + RenderPipeline scene pass | 0.124 | 1.53 | – |
| + quarter-res volumetric (12 steps, bayer16, gaussianBlur) | 0.184 | 1.64 | – |
| + half-res GTAO (MRT normal/velocity pre-pass, builtinAOContext) | 0.318 | 3.80 | 976 |
| + TRAA (full stack) | 0.379 (p95 0.378) | 3.92 | – |

The GTAO step roughly doubles CPU work because the pre-pass submits the scene a second time.

Other data points:
- Full stack with 100 meshes: GPU 0.297 ms, CPU 1.31 ms.
- 2048² shadow maps instead of 1024²: +0.02 ms GPU.
- Object3D.static = true: no measurable change.

Extrapolation (low confidence):
- NVIDIA's own spec pages give FP32 core×clock ratios of 8.2× for 5090 vs RTX 3060 (3584 × 1.78 GHz) and 6.9× vs RTX 4060 (3072 × 2.46 GHz). That puts the full stack at roughly 2.5-3 ms GPU on a 3060/4060 for this synthetic scene.
- With real textured assets and skinned characters, budget about 2-4× that, so roughly 5-10 ms, still inside 16.7 ms.
- The bigger risk is CPU: about 4 µs per draw on a 9950X3D, likely about 2× on mid-range CPUs. That is about 8 ms per frame for the full stack at 300 meshes, before game logic, physics, networking and voice.

Shadow pass cost: GPU time is negligible because each spot frustum culls to about 110 draws. CPU cost is about +1.0 ms per frame for 4 spots at 300 meshes, and +0.39 ms at 100 meshes.

BundleGroup does apply to shadow passes, because bundles are keyed by camera and render context. With 300 meshes and 4 shadows, CPU fell from 1.57 to 0.82 ms and backend draw calls per frame from 707 to 2.

BundleGroup caveats, all verified:
- Frustum culling is frozen at record time. A bundled mesh outside the camera on the first frame never appears until bundle.needsUpdate = true. Set frustumCulled = false, which raised GPU time to 0.216 ms because every pass then draws all meshes, or rebuild bundles per room.
- In r186, BundleGroup combined with GTAO's builtinAOContext crashes: TypeError "Cannot read properties of null (reading 'isDepthTexture')" in WebGPUTextureUtils.updateSampler. Bundles worked with TRAA and with the volumetric pass.
- BundleGroup gives no benefit on the WebGL2 backend.
  - sources: local probe: C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\fc_render\scripts\pages\perf.js and bundlecull.js (results in fc_render\out\results_*.json), https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js, https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/BundleGroup.js, https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_postprocessing_ao.html
- Q: Does renderer.compileAsync(scene, camera) also precompile the shadow and volumetric pass pipelines, so nothing hitches when a player joins?
  - (high) No. ShadowNode.updateBefore returns early while compiling ('do not render shadow maps during precompilation'), so shadow depth pipelines are first created on a real frame. compileAsync also compiles only for the current render target and MRT (canvas or framebuffer target), and only for objects in the camera's current layers. Pipelines for pass() render targets, the layer-filtered volumetric pass, and post-processing QuadMesh passes (blur, TRAA, tone-mapping output) are not covered.

Probe scene: 60 meshes, 4 shadowed spots, volumetric pass with blur.

| Strategy | Precompiled | First frame |
|---|---|---|
| No precompile | – | 15 programs / 8 pipelines, CPU 73 ms, 572 ms until the GPU was idle |
| compileAsync(scene, camera) | 6 programs / 3 pipelines (329 ms, async) | still 11 programs / 8 pipelines, about 212 ms hitch |
| r186 PassNode.compileAsync(renderer) on the scene pass | similar | still 11 new programs |

Precompiling the layer-filtered volumetric pass with PassNode.compileAsync, after swapping camera.layers, triggered a WebGPU validation error ('[Texture "depth"] ... writable usage and another usage in the same synchronization scope'), so I would not rely on that path.

On WebGL2, the first frame without precompile blocked the main thread for 566 ms; with compileAsync it was 101 ms.

Player join: compileAsync(newPlayerMesh, camera, scene) precompiled the main-pass program (197 ms, async). The first frame after adding the mesh still created 1 pipeline (the shadow pass for the new vertex layout); skinned meshes will likely also need a new shadow program.

Recommended:
1. Behind the loading screen, render 2-3 warm-up frames of the real RenderPipeline at the real resolution, with the final light and shadow set already present.
2. During loading, pre-spawn one instance of every character and material variant (skinned, held items) and render it once, offscreen or behind the camera with frustumCulled = false. Reuse or pool those instances when someone joins.
3. Never add or remove shadowed lights, or toggle castShadow, mid-game. Turn lights off with intensity instead.
4. Set renderer.lighting = DynamicLighting with keepNames enabled so fixture-light changes don't recompile.
  - sources: https://github.com/mrdoob/three.js/blob/r186/src/nodes/lighting/ShadowNode.js, https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js, https://github.com/mrdoob/three.js/blob/r186/src/nodes/display/PassNode.js, local probe: ...\scratchpad\fc_render\scripts\pages\compile.js (strategies none/scene/scenepass/passes, both backends) and join.js

## Hosting, invites, transport and NAT traversal (Cloudflare quick tunnel, Tailscale Funnel, TURN/SFU options, Node timing). Method: primary docs and source code fetched 2026-10-06, plus local tests on the host. Tests used the official cloudflared 2026.10.0 binary (sha256 checked) and Node v24.14.0, all run from the scratchpad. The repo and .env were not touched, and every tunnel and server was stopped afterwards. The shared WebSearch budget ran out early in this run, so later checks used WebFetch on known primary URLs only. A follow-up search could still look for 2024-2026 TURN-share datasets and reports of 429s from api.trycloudflare.com. Test scripts: C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\timing\ (interval.mjs, accum.mjs) and ...\scratchpad\cfd-test\ (server*.mjs, wsclient.mjs, streamtest.mjs, wsrtt.mjs). Logs from the runs are kept in the same folders.
- Q: Do TryCloudflare's terms, or rate limits on api.trycloudflare.com, restrict a 4-6 h session serving about 100 MB to 6 users, or repeated tunnel creation?
  - (medium) No published limit blocks it, but you get no guarantees either. (1) Terms: on every start cloudflared prints (seen live with 2026.10.0) that account-less tunnels 'have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use'. Those terms (effective 2025-08-01) ban use that could 'overburden, disrupt or impair any Cloudflare servers or APIs' and exceeding 'limitations ... including on any API calls'. They also let Cloudflare 'suspend or terminate your access ... at any time ... for any reason'. The docs call quick tunnels 'for testing and development'. The only hard limits published are 200 in-flight requests per tunnel (429 beyond that) and no SSE. No limit on duration, bandwidth or tunnel creation is published. The CDN clause in the Service-Specific Terms (updated 2026-09-28) reserves the right to limit serving 'a disproportionate percentage of pictures, audio files, or other large files'. That clause sits in the CDN section, so it may not apply to quick tunnels, and about 600 MB in one evening is small. (2) api.trycloudflare.com: no rate limit is documented. cloudflared POSTs once to {quick-service}/tunnel with a 15 s timeout. Any non-2xx response is fatal ('quick tunnel provisioning failed with status %d') with no retry or backoff. I created 2 tunnels about 9 minutes apart without error; each took about 6 s to get a URL and about 1 s to register. I could not check public reports of 429s because the search budget was used up. (3) Practical risks: a single edge connection (ha-connections=1), a server restart on Cloudflare's side drops all WebSockets, and the URL changes on any cloudflared restart. Mitigations: run cloudflared under a supervisor and read the new URL from 127.0.0.1:20241/quicktunnel. Then re-share it automatically. Back off at least 30-60 s between restarts instead of looping. Keep Tailscale Funnel (stable *.ts.net name) or a named tunnel on your own domain ready as a fallback.
  - sources: https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go, https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/, https://www.cloudflare.com/website-terms/, https://www.cloudflare.com/service-specific-terms-application-services/
- Q: Does creating a Cloudflare Realtime TURN key need only a free account, with no card? What is the exact dashboard path, and how long until the first credential?
  - (medium) Account: the docs ask only for 'a Cloudflare account', and the 1,000 GB/month free allowance (shared by SFU and TURN) applies to self-serve accounts. The FAQ says enterprise and self-serve have 'no performance or feature level difference'. I found NO primary source that says whether a payment method is needed before creating a key, so that part is UNVERIFIED. Be ready for the dashboard to ask for a card, and keep a fallback (Metered Open Relay: free signup, 20 GB/month). Usage beyond 1,000 GB is billed at $0.05/GB, which obviously needs billing set up. For scale: even if every voice stream is relayed (6 clients × 5 incoming Opus streams × ~50 kbps ≈ 1.5 Mbps), 6 h comes to about 4 GB. Dashboard: the TURN docs link 'https://dash.cloudflare.com/?to=/:account/calls', which is the Realtime section; 'calls' is the old product name. The SFU guide's menu path is 'Realtime > Serverless SFU', and the TURN key entry sits in the same Realtime section; I did not verify the exact TURN menu label. API alternative: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys with an API token that has 'Calls Write' and body {"name":"theboys"}. The response has uid (32 chars = TURN_KEY_ID) and key (64 chars = the Bearer token for generate-ice-servers). Keep the key server-side only. Time to first credential: no wait is documented. The key comes back in the create response, and generate-ice-servers can be called right away (201 with iceServers). TURN usage shows in analytics within 30 s. In practice it is minutes, mostly account signup and email verification. Credential issuance has no defined limit (start at 500/s).
  - sources: https://developers.cloudflare.com/realtime/turn/generate-credentials/, https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/, https://developers.cloudflare.com/realtime/sfu/get-started/, https://developers.cloudflare.com/realtime/pricing/
- Q: Is there recent (2024-2026) data on what share of residential or EU WebRTC pairs need TURN? Do CGNAT and mobile-hotspot peers succeed through Cloudflare TURN over UDP and turns:443?
  - (low) Share needing TURN: I found no first-party 2024-2026 dataset split by residential or EU networks. The search budget ran out, so this is an open gap. Best available: bloggeek.me (updated 2025-11-10) says 'around 80% of all connections can be resolved by either using the local IP address or by use of STUN', implying about 20% need TURN. The author puts the observed range at 0-50% depending on the deployment, and notes callstats.io once reported 30%, which is old. Tailscale (2020, possibly stale) estimates direct connections 'over 90% of the time'. When both sides are 'hard' NATs (the mapping changes per destination), hole punching essentially fails; their model gives a 0.01% chance. RFC 6888 requires carrier-grade NATs to meet transport behaviour rules (REQ-1 MUST; for UDP that means RFC 4787 endpoint-independent mapping) and recommends endpoint-independent filtering (REQ-7). Real mobile carriers vary, and a phone hotspot adds a second NAT. Planning number: expect about 1 in 5 peer pairs to need a relay, and most pairs that involve a mobile hotspot. In a 6-player mesh (15 pairs) at least one relayed pair is likely, so always include TURN in iceServers. Through Cloudflare TURN: a TURN client only makes outbound connections, so CGNAT and hotspot clients can get relays like anyone else. Options are UDP 3478 (or 443/udp), TCP 3478 (or 80), and TLS 5349 (or turns:443) for networks that block UDP. Clients on IPv6-only networks connect over IPv6 but receive IPv4 relay addresses. Relaying is UDP-only, which is fine for WebRTC media. Caveats: CreatePermission to private IP addresses is denied; maintenance can break allocations, so implement ICE restart; credentials last at most 48 h. Cloudflare publishes no success rate for CGNAT or hotspot clients, so test tonight. One player on a phone hotspot, with RTCPeerConnection iceTransportPolicy:'relay', checks the selected candidate pair in chrome://webrtc-internals (type relay; protocol udp/tcp/tls). Fallback that needs no NAT traversal: send Opus frames (WebCodecs AudioEncoder) over the game WebSocket and have the server apply proximity gating and volume falloff. Measured WebSocket echo round trips through a quick tunnel from this host were 21-33 ms median (29-48 ms p90). Host upload for 6 players is about 6×5×32 kbps ≈ 1 Mbps. TCP head-of-line blocking means it needs a 60-100 ms jitter buffer.
  - sources: https://bloggeek.me/webrtc-turn/, https://tailscale.com/blog/how-nat-traversal-works, https://www.rfc-editor.org/rfc/rfc6888, https://developers.cloudflare.com/realtime/turn/
- Q: Do quick tunnels have a per-tunnel bandwidth cap when 5-6 clients download 60-100 MB at the same time?
  - (medium) None is documented: the docs list only the 200 in-flight request limit, no SSE and no uptime guarantee. The source shows each quick tunnel uses ONE edge connection (ha-connections=1, QUIC by default). Measured 2026-10-06 on this host, which is on Wi-Fi. Client and origin were on the same PC, so traffic went host → edge → host. Payload was incompressible bytes with no-store; edges were ZRH for the client and fra19/zrh01 for the tunnel. QUIC tunnel: 1×20 MB at 4.57 MB/s, and 3.19 MB/s on a rerun. 2×10 MB together: 3.24 MB/s. 5×10 MB together: 4.12 MB/s (about 0.88 MB/s each, shared fairly). One earlier 5×20 MB run collapsed to about 1.4 MB/s total (54-70 s per stream); it did not happen again and was probably other traffic on the network. HTTP/2 tunnel (--protocol http2): 1×20 MB at 3.28 MB/s; 5×10 MB together: 4.72 MB/s. Baseline straight to speed.cloudflare.com: upload 1.33 MB/s on one stream, 3.88 MB/s on 5; download 9.34 MB/s on 5. So the tunnel's total matches the host's upload speed, and I saw no tunnel cap at about 30-40 Mbps. I could not test above this host's upload speed. Expected load: 6 clients × 100 MB = 600 MB, about 2.5 min if everyone downloads at once (each about 0.7 MB/s). Actions: keep the first download to about 30-50 MB (KTX2/Basis textures, meshopt or Draco meshes, Opus audio) and use content-hashed files with immutable caching, because the edge caches nothing. Load assets in a lobby or stagger them, use wired Ethernet on the host, and keep --protocol http2 as a fallback switch.
  - sources: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/, https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go, local test: scratchpad\cfd-test\server2.mjs (blob endpoint), cloudflared.log, cloudflared-h2.log
- Q: Is Tailscale #18651 still open in 1.98.x? Does enabling Funnel need the admin console again after the first time?
  - (medium) #18651 is still OPEN as of 2026-10-06. Title: 'Tailscale serve strips query parameters from WebSocket upgrade requests'. It was opened 2026-02-08 by one reporter (macOS, Node ws backend, 'current stable' at the time), carries the label waiting-for-info, and has 0 comments and no linked PR or commit. No changelog entry through v1.102.5 (latest; GitHub tag 2026-09-29, changelog date 2026-10-05) mentions WebSocket query strings. This host runs 1.98.4. Code review: Serve and Funnel proxy HTTP backends with httputil.ReverseProxy, using a Rewrite that calls r.SetURL(rp.url). The standard library appends the incoming query string there, and only Path/RawPath are changed. So query strings should survive on 1.98.x and 1.102.x and the bug is unconfirmed. Do not rely on query-string tokens anyway: authenticate in the first WebSocket message. For comparison, the Cloudflare quick tunnel kept ?token=abc in my test. Admin console: the first `tailscale funnel` opens an approval page. Approving 'automatically creates valid HTTPS certificates and updates your tailnet policy file', adding nodeAttrs {"target":["autogroup:member"],"attr":["funnel"]}, and needs an Owner, Admin or Network admin. The setting lives in the policy file, so later runs need no console unless someone removes it. `tailscale funnel --bg <port>` keeps running across reboots until you turn it off or run `tailscale funnel reset`. The docs do not literally say 'one-time', hence medium-high confidence. This host's node has the HTTPS-cert capability but NOT the funnel capability and no serve config, so expect one approval click tonight. Allow up to 10 min for public DNS, and avoid repeated certificate re-issuance (Let's Encrypt rate limits can mean a 34 h wait).
  - sources: https://github.com/tailscale/tailscale/issues/18651, https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go, https://tailscale.com/changelog, https://github.com/tailscale/tailscale/releases
- Q: Does a muted keep-alive <audio> element count as 'playing audio' for Chrome's background-throttling exemption, or does only the active-WebRTC exemption apply?
  - (medium) A muted element does not count. Chrome exempts a page that 'has made noises in the past 30 seconds', but 'a silent audio track doesn't count'. A muted <audio> element or a silent buffer produces no audible output, so it earns nothing. Only the WebRTC exemption applies, defined as 'an RTCPeerConnection with an open RTCDataChannel or a live MediaStreamTrack'. That exemption only prevents intensive throttling (once per minute after 5 min hidden). A hidden tab is still throttled to wake-ups 'once per second'. When friends' voices actually play through the tab, it counts as audible during the audio and for 30 s after, and its timers run normally. requestAnimationFrame stops completely when the tab is hidden. Design consequences: (a) keep the simulation authoritative on the Node server; the client should not need its timers while hidden. (b) Keep connections alive with server-sent WebSocket ping frames. The browser answers pings with pongs at the network level, independent of JS timers, and pings every 30 s held a connection through Cloudflare for 230+ s in my test. (c) On visibilitychange, mark the avatar idle and resync from a full snapshot when the player returns. (d) Do not use a muted-audio hack. The source is dated 2021-01-18, older than 2025, so it may be stale; I found no newer official doc.
  - sources: https://developer.chrome.com/blog/timer-throttling-in-chrome-88, local test: scratchpad\cfd-test\wsclient.mjs (ping keep-alive)

## Browser voice and audio fact-check: WebRTC into Web Audio, AEC/AGC, PannerNode, clip capture, Web Speech and WebCodecs. Note: the WebSearch budget shared by all agents ran out after my first query, so everything here comes from direct WebFetch of primary sources (Chromium, Firefox, WebKit and three.js source; MDN BCD JSON; W3C specs; npm registry; Chrome and Edge release notes) plus my own runs on the host's Chrome 154.0.8037.94 (headless Playwright 1.63, fresh profile, so no Finch field trials). Probe files are in C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\fc_voice\ (probe.html, run.js, levels.js, mklevels.js, bg.js, bg2.js; results in out\result_chrome.json, out\levels_result.json, out\levels_result2.json). Version context: Chrome 155 goes stable 2026-10-06 and 156 on 2026-10-20 (chromiumdash). Firefox release is 157.0 (2026-09-29) and ESR is 140.17, so 'Firefox 14x' is out of date. Edge cannot be tested on this host: only 144.0.3719.104 leftovers remain and there is no msedge.exe.
- Q: In Chrome 154 and current Edge on speakers, with echoCancellation:true and the far-end voice rendered via AudioContext, PannerNode and destination, is the far-end voice actually cancelled? What about Firefox 14x?
  - (medium) CHROME 154 (Windows, code defaults): Yes, the Web Audio far-end is fed to the AEC. A trace with echoCancellation:true showed OutputDeviceMixerImpl::StartListening, then MixTrack::StartProvidingAudioToMixingGraph for the AudioContext's output stream, then BroadcastToListeners, AudioProcessorHandler::OnPlayoutData and AudioProcessor::AnalyzePlayoutData each about 249 times in 2.5 s. That is Chrome-wide AEC running in the audio service, with the mix of every Chrome output stream to the AEC device as the reference. With 'all', the reference comes from system loopback (OnPlayoutData 349x, no mixer), which also covers Web Audio. With 'remote-only', processing ran in the renderer, the AudioContext stream was 'independent' and nothing from it reached the reference, so Web Audio-rendered voices are NOT cancelled. Never use 'remote-only' with a Web Audio voice pipeline. What I did not measure is the actual echo-return-loss enhancement (no acoustic loop). Expect AEC3 to struggle with loud game SFX double-talk and with moving HRTF panning (a time-varying echo path). Conditions for it to work: (1) the AudioContext must output to the AEC device, which is the default output or the mic's associated output, so don't setSinkId elsewhere; (2) Finch can flip true to loopback via kSystemLoopbackAsAecReference forced_on, and that still includes Web Audio; (3) only Chrome's own audio is cancelled; other apps need 'all'. EDGE: unverified. msedge.exe is not installed on the host, and no primary source says Edge disables Chrome-wide AEC. Edge 141 shipped 'all' and 'remote-only' per Microsoft. Practical mitigation for every browser: an in-game 'echo check' that plays a 1 s log chirp through the exact voice chain (AudioContext, PannerNode, destination) while recording the processed mic track with an AudioWorklet. Compute the cross-correlation peak or residual level against a raw capture of the same chirp. If cancellation is under about 20 dB, nag for headphones or switch that player to push-to-talk with ducking. FIREFOX: the current release is 157, not 14x. From code (not runtime-tested): yes, if the AudioContext shares the mic's MediaTrackGraph. MTG::Process passes the mixed chunk for mOutputDeviceForAEC to NotifyOutputData, which reaches AudioInputProcessing::ProcessOutputData and AnalyzeReverseStream. AudioDestinationNode calls AddAudioOutput on GetInstance(window, ctx.sampleRate, DEFAULT_OUTPUT_DEVICE), and graphs are keyed on (windowID, sampleRate, primary output device). Requirements: same window, no forced AudioContext sampleRate different from the device rate, default output device. Audio from other tabs is not cancelled. Recommended constraints everywhere: {echoCancellation:true, noiseSuppression:true, autoGainControl:false or true}, plus headphones by default.
  - sources: https://raw.githubusercontent.com/chromium/chromium/main/media/base/media_switches.cc, https://raw.githubusercontent.com/chromium/chromium/main/media/media_options.gni, https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/mediastream/media_stream_audio_processor_options.cc, https://raw.githubusercontent.com/chromium/chromium/main/services/audio/output_device_mixer_manager.cc
- Q: Can Chrome 154 give two tracks from one mic with different processing (AGC/NS/AEC on for voice, raw for loudness), or does the second getUserMedia call reuse the first call's settings?
  - (high) Yes, verified on Chrome 154.0.8037.94 with a fake device. Track A {echoCancellation:true, autoGainControl:true, noiseSuppression:true} and track B {false, false, false} coexist, and A's settings did not change after B was opened. Their levels on the same input really differ: A measured -14.7 dBFS RMS (peak 0.398) and B -25.2 dBFS (peak 0.100, exactly the file level). The rules, from current Chromium code and confirmed by the test, are as follows. (1) A fresh getUserMedia uses is_full_reconfiguration_allowed=true. (2) A session is reused only if its echo_cancellation_mode (plus voice isolation) matches, via DetermineExistingAudioSessionId and HasSameSessionIdentityProperties; otherwise the browser opens a new session. (3) AGC and NS are interlocked per device: 'If the device is already opened, restrict supported values for non-reconfigurable settings to what is already configured' ('opening multiple instances of the APM is costly'). The fully unprocessed container is exempt. Observed: E {echoCancellation:{exact:'remote-only'}, autoGainControl:false, noiseSuppression:false} got a new session but AGC and NS stayed true, interlocked with A. (4) Gotchas. C {echoCancellation:true, autoGainControl:false, noiseSuppression:false} as ideals, and D {echoCancellation:true, autoGainControl:{exact:false}}, both silently returned the raw source with echoCancellation:false and no OverconstrainedError. F {ec:false, agc:true, ns:false} also returned raw. Always read getSettings(). (5) applyConstraints cannot switch processing type; use a new getUserMedia. (6) Hardware coupling: with AGC on, the voice track's input-volume controller (kWebRtcAllowInputVolumeAdjustment) moves the OS mic level, which also changes the raw track's level. For stable loudness, prefer a single track with {echoCancellation:true, noiseSuppression:true, autoGainControl:false}. In my test that track preserved the input level spacing within 0.8 dB, so a second track is unnecessary; add your own transmit-side gain or limiter in Web Audio if needed. Firefox (code reading only): each microphone source creates its own AudioInputProcessing (APM) on a shared native input, so per-track processing is likely possible but untested.
  - sources: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc, https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/mediastream/user_media_processor.cc, https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/mediastream/media_stream_audio_source.cc, https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/mediastream/media_stream_audio_processor_options.cc
- Q: With autoGainControl:true, how far apart are whisper, talk and shout in RMS dBFS on typical headsets? What calibration approach is recommended?
  - (medium) I found no primary per-headset dataset (WebSearch budget exhausted), so here is a controlled Chrome 154 measurement instead. Test signal: Windows SAPI speech fed through a fake mic, with active-speech RMS of whisper -51.5, talk -30.0 and shout -13.9 dBFS (spacing 21.5 and 16.1 dB, 37.6 dB total) over a -65 dBFS noise floor. Raw track: output equals input. AGC only: talk1 -22.2, whisper -36.7 (rising from -38.3 to -35.6 within the segment), shout -13.0, talk2 -27.5. Whisper-to-shout shrinks to about 24 dB, and the same talk input differs by 5.3 dB depending on what came before. Full EC+AGC+NS: talk1 -21.8, whisper -31.7 (second half -29.4), shout -12.4, talk2 -27.6. A sustained whisper ends up within about 2 dB of talk, whisper-to-shout is about 19 dB, and AGC lifted the gaps' noise floor to about -50 dBFS. EC+NS with AGC off: -52.3, -30.5, -14.6, -30.4, i.e. spacing preserved within 1 dB, and NS cut the noise floor to about -84 dBFS. These match AGC2's defaults (initial gain 15 dB, max 50 dB, 6 dB/s, headroom 5 dB, output noise cap -50 dBFS). On real Windows mics the input-volume controller additionally moves the OS mic gain, which a fake device cannot show. Conclusion: with AGC on, whisper, talk and shout are not reliably separable, and the result depends on recent history. Caveats: TTS voiced speech scaled down is not real whispering, which is unvoiced and may be gated by NS or VAD. Unverified acoustics background, low confidence (from memory; I could not fetch the source): ANSI S3.5-1997 gives about 62/68/75/82 dB SPL at 1 m for normal/raised/loud/shout, and whisper is roughly 20-30 dB below normal. So expect a 40-50 dB physical spread, compressed by mic clipping and headset onboard DSP. Calibration recipe: (1) measure on a track with autoGainControl:false (EC+NS on is fine); (2) gate with a VAD (vad-web Silero) and compute 100 ms-window energy averages over speech frames only; (3) at join, a 6-8 s check: 2 s silence for the noise floor, a read phrase for the talk baseline, optional 'whisper it' and 'shout it' prompts, then put thresholds at the dB midpoints; (4) defaults if skipped: whisper is at or below baseline -10 to -12 dB, shout is at or above baseline +8 to +10 dB, or any peak at or above -1 dBFS; use 2-3 dB hysteresis and a 150-300 ms hold; (5) slowly track the baseline with a long-window median of speech segments and recalibrate on 'devicechange'; (6) show a live meter. Map the result to the monster 'noise radius' rather than to absolute dBFS.
  - sources: https://webrtc.googlesource.com/src/+/refs/heads/main/api/audio/audio_processing.h, https://raw.githubusercontent.com/chromium/chromium/main/media/webrtc/helpers.cc, https://raw.githubusercontent.com/chromium/chromium/main/media/webrtc/webrtc_features.cc, local: ...\scratchpad\fc_voice\out\levels_result.json and levels_result2.json (levels.js, mklevels.js)
- Q: Is changing PannerNode.maxDistance or refDistance at runtime glitch-free, or should distance attenuation be a separate GainNode driven with setTargetAtTime?
  - (high) Changing them is not glitch-free. refDistance, maxDistance and rolloffFactor are plain double attributes, not AudioParams, and the spec defines no smoothing. Measured on Chrome 154 with an OfflineAudioContext, a DC source and a change at 0.5 s: refDistance 1 to 2 (inverse, d=4) stepped 0.1768 to 0.3536 within one sample at frame 24064 (render-quantum boundary 188x128). maxDistance 8 to 16 (linear) stepped 0.4041 to 0.5657 in one sample. rolloffFactor 1 to 0 stepped 0.1768 to 0.7071 in one sample. Assigning positionZ.value also stepped in one sample. With real audio each of these is an audible click. By contrast, positionZ.setTargetAtTime(tau 20 ms) took 2634 samples for 10-90% with a max per-sample delta of 0.0001, and GainNode.gain.setTargetAtTime(tau 20 ms) took 2109 samples (about 2.2 tau). Recommendation: use the PannerNode for direction only, with fixed parameters (rolloffFactor = 0 makes distanceGain 1 in all three models). Do distance, occlusion and wall attenuation in a GainNode, plus a BiquadFilter lowpass for muffling, driven every tick with gain.setTargetAtTime(target, ctx.currentTime, 0.03-0.08), or cancelAndHoldAtTime followed by linearRampToValueAtTime over the tick. Keep moving positions with AudioParam ramps, as three r186 already does with linearRampToValueAtTime. Avoid three's setRefDistance, setMaxDistance and setRolloffFactor during playback: they set the attributes directly. Firefox was not tested, but per the spec its attributes have no smoothing requirement either.
  - sources: https://webaudio.github.io/web-audio-api/#PannerNode, https://raw.githubusercontent.com/mrdoob/three.js/r186/src/audio/PositionalAudio.js, local: ...\scratchpad\fc_voice\out\result_chrome.json (glitch section), probe.html pannerGlitch()
- Q: Does the muted keep-alive element cause double playback or AEC-reference problems in Firefox or Safari?
  - (medium) Short answer: no double playback in any engine as long as the element is muted (or volume 0). The AEC risk lies in Chrome 'remote-only' mode and in Safari, not Firefox. CHROME (it needs the element): on 154, muted plus play(), volume=0 plus play(), and even srcObject without play() all unblocked the remote track for Web Audio (about -25 dBFS versus -240 dBFS without). With echoCancellation:true (Chrome-wide), the reference is the audio-service mix, which my trace shows includes the Web Audio output, so the muted element causes no reference problem (its own stream volume is 0; that last part is inferred). With 'remote-only', or on Chrome builds without Chrome-wide AEC (Android, ChromeOS), the renderer APM's reference comes from WebRtcAudioDeviceImpl::RenderData calling OnPlayoutData. That is the WebRTC playout mix before any per-element volume (code shows no volume applied), while the Web Audio output is not in the reference (trace). The reference then contains full-level, unspatialized voices of every peer, including far or inaudible ones, which can make AEC3 suppress local speech. Use true, not 'remote-only'. FIREFOX (element not needed): an element renders MediaStream audio via track->AddAudioOutput and SetAudioOutputVolume in the same graph, so a muted element contributes silence to the AEC mix while the Web Audio output (same graph) is the reference. No double playback and no reference distortion expected (code reading, not runtime-tested). SAFARI/WebKit: in AudioTrackPrivateMediaStream::updateRenderer, a muted or volume-0 element calls stopRenderer(), so no double playback, but it also contributes nothing to echo cancellation. In the GPU process, only media-element WebRTC audio on the default device is rendered through the VPIO capture unit as speaker samples (registerSpeakerSamplesProducer). The Web Audio destination (RemoteAudioDestinationManager) does not register, so Web Audio-rendered voices are likely not echo-cancelled on Safari speakers (code reading, low-medium confidence). Practical rules: keep a strong reference to a muted element per remote stream and call play(); create one element per stream; detach on peer leave; on Safari default to headphones.
  - sources: https://issues.chromium.org/action/issues/40094084, https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/webrtc/webrtc_audio_device_impl.cc, https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/media/mediaelement/HTMLMediaElement.cpp, https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/media/MediaTrackGraph.cpp
- Q: Does @ricky0123/vad-web 0.0.31 MicVAD accept an existing MediaStream (getStream), and are its options really named preSpeechPadMs and minSpeechMs?
  - (high) Yes on both counts. 0.0.31 is npm 'latest', published 2026-09-12 (gitHead de9b3ff83fd44cd7a2b3e07e9454e6b6f0bc249d), and depends on onnxruntime-web ^1.17.0. RealTimeVADOptions has no 'stream' option. Instead it has getStream: () => Promise<MediaStream>, pauseStream: (stream) => Promise<void>, resumeStream: (stream) => Promise<MediaStream>, plus audioContext?, startOnLoad (true), processorType ('AudioWorklet' | 'ScriptProcessor' | 'auto', default 'auto'), model ('v5' | 'v6' | 'legacy', default 'legacy'), workletOptions, baseAssetPath ('./') and onnxWASMBasePath ('./'). FrameProcessorOptions and their defaults: positiveSpeechThreshold 0.3, negativeSpeechThreshold 0.25, redemptionMs 1400, preSpeechPadMs 800, minSpeechMs 400, submitUserSpeechOnPause false. All the duration options are in ms; the old *Frames names are gone. Gotchas when sharing the voice stream: the default pauseStream stops all audio tracks, and the default resumeStream calls getUserMedia again with {channelCount:1, echoCancellation:true, autoGainControl:true, noiseSuppression:true}. Override both, e.g. MicVAD.new({getStream: async () => voiceStream, pauseStream: async () => {}, resumeStream: async () => voiceStream, audioContext: sharedCtx, model: 'v5', preSpeechPadMs: 300, minSpeechMs: 250, redemptionMs: 600, baseAssetPath: '/vad/', onnxWASMBasePath: '/ort/'}). destroy() closes the AudioContext only if the VAD created it. Frame sizes: 1536 samples for legacy, 512 for v5/v6. You must self-host vad.worklet.bundle.min.js, silero_vad_legacy.onnx / silero_vad_v5.onnx / silero_vad_v6.onnx, and the ORT wasm files.
  - sources: https://registry.npmjs.org/@ricky0123/vad-web/latest, https://registry.npmjs.org/@ricky0123/vad-web, https://raw.githubusercontent.com/ricky0123/vad/de9b3ff83fd44cd7a2b3e07e9454e6b6f0bc249d/packages/web/src/real-time-vad.ts, https://raw.githubusercontent.com/ricky0123/vad/de9b3ff83fd44cd7a2b3e07e9454e6b6f0bc249d/packages/web/src/frame-processor.ts

## Fact-check of the AI services (as of 2026-10-06): what JEV is, how to route Claude models and which API limits apply, latency, and the host-side STT/TTS stack. WebSearch was not available (the shared per-turn search budget was already used up), so the evidence comes from fetching primary docs directly, from the npm/PyPI registries, from reading the package source of @typesafe-ai/sdk 0.6.0, @tanstack/ai-typesafe 0.1.7, @ai-sdk/typesafe-ai 3.0.13, @anthropic-ai/sdk 0.131.0 and faster-whisper 1.2.1, and from re-running the benchmarks on this host's RTX 5090. Probes to api.typesafe.ai sent no key or a dummy key. No .env file or API key was read or used, and nothing was written to the repo. Scripts and results are in C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\scripts (bench_whisper.py, halluc_stats.py, bench_parakeet.py, kokoro_bench.mjs, make_conditions.py, make_tts.ps1) and ...\scratchpad\data\bench_results.json. One model download first landed under C:\c\Users\... because of a path-format mistake. It was moved into the scratchpad and the stray C:\c folder tree was deleted.
- Q: What key format does console.typesafe.ai issue (prefix and length)? Does any other provider ship a model named 'JEV' with 'apikey_' keys? Check the TypeSafe console docs, the TanStack adapter source and Vercel AI Gateway's TypeSafe docs.
  - (medium) No source documents the key format.
- TypeSafe docs (about 110 pages via llms.txt): the quickstart says only 'Get your API key from the dashboard (console.typesafe.ai/keys)'. The console returns Cloudflare 403 to non-browser clients.
- @typesafe-ai/sdk 0.6.0 reads TYPESAFE_API_KEY with no format check.
- TanStack: the docs use 'your-typesafe-api-key'; the @tanstack/ai-typesafe 0.1.7 example uses 'ts-...'.
- @ai-sdk/typesafe-ai 3.0.13 uses 'your-api-key'. It reads TYPESAFE_AI_API_KEY (not TYPESAFE_API_KEY) and defaults to https://api.typesafe.ai/v1.
- Vercel's TypeSafe-compatible API (https://ai-gateway.vercel.sh/typesafe/v1/systemone) authenticates with an AI Gateway key (prefix 'vck_', per Vercel's leaked-key example) or OIDC. A TypeSafe key can only be added as BYOK.

No other provider ships a model named Jev:
- Vercel's public catalog (409 models, fetched 2026-10-06) lists only typesafe-ai/jev ($0.042/MTok input, output 0, released 2026-09-15). It also lists other System One-compatible models: liquid/d1 (2026-09-29) and convaiinnovations/laya and laya-free (2026-10-01).
- OpenRouter (464 models) lists only TypeSafe's ~typesafe/jev-latest and typesafe/jev-router.
- TypeSafe's Python docs also list Pydantic AI Gateway (https://gateway-us.pydantic.dev/proxy/typesafe), whose keys are 'pylf_v...'.

The 107-character 'apikey_' key matches none of these gateway formats, so it is most likely a direct TypeSafe console key, but that is unproven. Check it without spending tokens or printing the key: curl -s -o NUL -w "%{http_code}" -H "Authorization: Bearer $JEV_API_KEY" https://api.typesafe.ai/v1/models. A 200 with jev-latest listed means it works. A 401 'Cannot authenticate with the server' means it is not a valid TypeSafe key. In code, pass it explicitly: new TypeSafeClient({ apiKey: process.env.JEV_API_KEY }).

Caveat: the wider web could not be searched for other 'JEV' products.
  - sources: https://docs.typesafe.ai/llms.txt, https://docs.typesafe.ai/introduction/quickstart.md, https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md, https://tanstack.com/ai/latest/docs/adapters/typesafe
- Q: Does TypeSafe gate API calls for waitlisted accounts, and with which 401/403 semantics? Is there an EU region or any latency data from Europe?
  - (medium) Gating of waitlisted accounts is undocumented. TypeSafe's api.md lists only 401 'Missing or invalid API key', 422, 429 and 529. The SDK maps 403 to PermissionDeniedError ('access is denied').

Live probes from this host (2026-10-06, no real key used):
- No Authorization header returns HTTP 403 {"detail":{"error_type":"authentication_error","message":"Must supply an API key! ..."}}.
- A dummy key returns HTTP 401 {"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}, on both GET /v1/models and POST /v1/systemone. Responses carry x-typesafe-request-id.

The SDK retries neither 401 nor 403 (it retries 408, 429 and 5xx with 500 ms to 5 s backoff). Access appears to be gated when keys are issued: waitlist from 9/15, open 9/20, signups paused 9/22 (secondary source). Nothing documents what a waitlisted account's key gets back. Treat any 401/403 as 'Jev unavailable' and fall back to Claude or rules. Use GET /v1/models ('the models available to the account') as a startup check that jev-latest is listed.

No EU region exists. The launch post says 'our published evals are generally run from our laptops on the West Coast (this is where our service is currently based)'. Vercel serves its gateway from fra1, but the upstream is still TypeSafe's US-West service. TypeSafe's docs list only the gateway-us Pydantic URL.

No published European latency data was found. Measured from this host (Cloudflare edge ZRH):
- api.typesafe.ai, keep-alive round trip for a rejected request: 174-222 ms (211-260 ms on a fresh connection).
- api.anthropic.com: 131-151 ms.
- Vercel gateway model list from fra1: 100-282 ms.
Expect about 175-220 ms of network time on top of TypeSafe's claimed 70-500 ms, so roughly 250-700 ms per Jev decision from Europe, compared with the 227 ms average of the US-East Runtime Wire demo.
  - sources: https://docs.typesafe.ai/api.md, https://docs.typesafe.ai/sdk/javascript/api/classes/PermissionDeniedError.md, https://docs.typesafe.ai/sdk/python/api/exceptions.md, https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Q: What are p50/p95 time to first token and total time for Haiku 4.5 versus Sonnet 5.5 with between_tools, using output_config.format on prompts of about 2K tokens (not 10K)? Are there published numbers, or must the build's ai:bench measure it?
  - (medium) No published numbers exist for 2K-token prompts, between_tools or structured outputs; ai:bench has to measure them.

The only public source is Artificial Analysis: about 10K-token prompts, sent from GCP us-central1-a, P50 over 72 h, first-party API.
- Haiku 4.5: 0.69 s TTFT, 91.4 tok/s.
- Sonnet 5.5 Low (adaptive thinking, not between_tools): 1.05 s to first answer token, 100.9 tok/s.
- Sonnet 5.5 Medium: 7.16 s.
AA shows no p95 on its model pages and has no between_tools variant. Runtime Wire's demo had Haiku 4.5 averaging 2.5 s per short decision (US East).

Rough estimate, low confidence, for a 2K prompt with about 100 output tokens from this host (+130-150 ms network):
- Haiku 4.5: TTFT about 0.5-0.8 s, total about 1.5-2.5 s.
- Sonnet 5.5 between_tools: TTFT about 0.7-1.2 s, total about 1.7-2.5 s.

Pitfalls for the benchmark:
1. A 2K prompt cannot cache on Haiku 4.5 (minimum 4,096 tokens). Sonnet 5.5's minimum is 512.
2. Each new schema pays a one-time grammar compile (cached 24 h). Structured outputs add a system prompt, and changing output_config.format invalidates the prompt cache. A max_tokens:0 pre-warm cannot include output_config.format, so warm up with one real call per schema.
3. With structured outputs at low or medium effort, Sonnet 5.5 sometimes thinks until max_tokens. Count stop_reason 'max_tokens' as a failure.
4. Don't send effort to Haiku 4.5. Send between_tools only at effort high or below.

Suggested ai:bench protocol, per model and config:
- 5 warm-up calls, then at least 30 sequential calls and one burst of 20 concurrent calls.
- stream:true. TTFT = first text_delta; total = message_stop.
- Record stop_reason, refusal category, usage.cache_read_input_tokens and the anthropic-ratelimit-* headers.
- Report p50 and p95 separately for warm-cache and cold runs.
  - sources: https://artificialanalysis.ai/models/claude-4-5-haiku, https://artificialanalysis.ai/models/claude-sonnet-5-5-low, https://artificialanalysis.ai/models/claude-sonnet-5-5-medium, https://artificialanalysis.ai/methodology/performance-benchmarking
- Q: Does Sonnet 5.5 accept between_tools together with output_config.format, and together with fallbacks:'default', on the Claude API?
  - (medium) With fallbacks:'default': yes, documented. Under the server-side-fallback-2026-07-01 header, between_tools is the stated exception: 'when a Claude Sonnet 5.5 request falls back to Claude Sonnet 5, the fallback attempt runs with thinking: {"type": "disabled"} and display: "omitted"'. Under the older 2026-06-01 header you must set thinking on the Sonnet 5 entry, or the request is rejected up front.
- Server-side fallback works only on the Claude API. It isn't available on Batches (the item comes back errored), Bedrock, Google Cloud or Foundry.
- For Sonnet 5.5 it retries only cyber and frontier_llm declines (on Sonnet 5). bio, reasoning_extraction and general_harms refusals still come back as stop_reason 'refusal'.

With output_config.format: no documented incompatibility. Structured outputs are incompatible only with citations and assistant prefill. between_tools is rejected only at xhigh/max effort, with extra thinking fields, or with a per-message effort change. Anthropic's Sonnet 5.5 prompting guide discusses structured outputs under between_tools, which implies the pair is accepted, but says without tools the model answers with no thinking and accuracy on multi-step reasoning drops. For those requests it recommends adaptive thinking plus 'Think the problem through before you answer.'. No page states outright that the pair is accepted, so confirm it with one ai:bench call.

SDK (@anthropic-ai/sdk 0.131.0): between_tools is in the non-beta types, but fallbacks exists only on client.beta.messages. For the fallback route, use client.beta.messages.parse with betaZodOutputFormat from '@anthropic-ai/sdk/helpers/beta/zod' and betas ['server-side-fallback-2026-07-01']. If you retry manually on another model, drop between_tools first, because every other model returns 400 for it.
  - sources: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback, https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5, https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Q: Which usage tier does a new Anthropic org get, and are its RPM/ITPM limits for Haiku 4.5 and Sonnet 5.5 enough for bursts of about 20 calls per minute?
  - (high) Tiers are now named Start, Build, Scale and Custom, not Tier 1-4. The rate-limits page says 'New organizations and organizations with limited usage history may start in the Evaluation tier, with limits below the standard limits shown on this page'. The Evaluation tier's numbers are not published, and limits rise automatically with usage history.

Start-tier standard limits for both Haiku 4.5 and Sonnet 5.5 (each model has its own bucket):
- 1,000 requests/min
- 2,000,000 input tokens/min (uncached plus cache writes; cache reads don't count)
- 400,000 output tokens/min
Monthly spend caps: Start $500, Build $1,000, Scale $200,000.

For 20 calls/min at about 2K input tokens (about 40K input tokens/min), that is about 2% of Start limits, so plenty. Caveats:
- Enforcement is a token bucket over short intervals ('60 RPM might be enforced as 1 request per second'), so firing 20 calls at once could hit 429 on an Evaluation-tier org.
- Sharp ramps can trip acceleration limits.
- 429s include retry-after, and the SDK retries twice.

Action: read the real limits from the anthropic-ratelimit-requests-limit and -input-tokens-limit headers on the first ai:bench response, or from Console > Settings > Limits. Spread game calls out (a queue with concurrency of about 4 per model). Set an org spend limit on Billing; hitting it returns 400. Handle the 429 'enforced_spend_limit_reached', which has no retry-after, by switching to non-AI fallbacks.
  - sources: https://platform.claude.com/docs/en/api/rate-limits, https://platform.claude.com/docs/en/api/errors
- Q: How accurate is Whisper large-v3-turbo on noisy, overlapping gaming-headset speech, and how often does it hallucinate? Which no_speech_prob and avg_logprob filters work best? Does faster-whisper 1.2.1 transcribe() accept hotwords?
  - (medium) Published figures (HF model card, Open ASR Leaderboard): mean WER 7.83, AMI meeting corpus WER 16.13. The card warns about hallucination and repetition and recommends condition_on_prev_tokens False, logprob_threshold -1.0, no_speech_threshold 0.6, and compression_ratio_threshold 1.35 (an HF/zlib metric; faster-whisper's equivalent default is 2.4).

Local test on this RTX 5090: 32 synthetic Windows-TTS English clips per condition, so a small sample of clean voices and probably optimistic. Setup: faster-whisper 1.2.1, fp16, language 'en', greedy.

WER by condition:
- clean 0.5%
- white noise at SNR 10 / 5 / 0 dB: 0.5% / 0-0.5% / 7.9-8.4%
- pink noise at 5 dB: 0.5-1%
- 200-3800 Hz headset band plus pink noise at 15 dB: 0.5%
- Opus 24 kbps plus 10 dB noise: 1%
- a second talker at +6 dB: 10.9%
- a second talker at 0 dB: 36-39%
With a second talker, Whisper transcribes the other person's words too, so run STT on each player's own mic stream, never on the mixed proximity audio.

Hallucination without VAD: 40 of 40 non-speech clips produced text, mostly 'Thank you.' or 'you'. The clips were digital silence, -60 and -35 dBFS white noise, -30 and -15 dBFS pink noise, 50 Hz hum, keyboard clicks and breathing.

no_speech_prob was about 1e-10 on every segment, speech and non-speech alike. Turbo's no-speech detection is effectively dead, so faster-whisper's built-in no_speech_threshold never fires and any no_speech_prob filter is useless.

avg_logprob was -0.35 to -1.31 (median -0.64) on hallucinations and -0.006 to -0.75 (median -0.11) on real speech, including the 0 dB and overlap clips:
- dropping segments below -0.6 leaves 13 of 40 hallucinations and drops 1 of 160 real segments
- dropping below -0.5 leaves 6 of 40 and drops 2 of 160
The default 'no_speech_prob > 0.6 or avg_logprob < -1.0' leaves 35 of 40. 'Thank you.' on digital silence scores -0.35, so logprob filtering cannot catch it.

What works: vad_filter=True (Silero; threshold 0.5, 2000 ms minimum silence, 400 ms padding) gave 0 of 40 hallucinations with no WER change and about +3 ms latency. Recommended pipeline:
1. A VAD gate (Silero, or client-side VAD or push-to-talk).
2. A minimum speech duration of about 300 ms.
3. language='en' (saves about 40 ms versus auto-detect).
4. condition_on_previous_text=False.
5. Drop segments with avg_logprob < -0.6 or compression_ratio > 2.4.
6. A blocklist of exact outputs: 'thank you.', 'you', '.', 'thanks for watching'.

Hotwords: yes. WhisperModel.transcribe(..., hotwords: Optional[str] = None) in 1.2.1. It is injected as previous-context prompt tokens (sot_prev), capped at about 223 tokens, and ignored if prefix is set. Without VAD, hotwords made non-speech output much worse: long loops like 'click click click...' and 'and the light of the light...'. Post-filters left 3-5 of 40. With VAD, 0 of 40.

Comparison: Parakeet v3 int8 on CPU produced 0 of 40 outputs on non-speech even without VAD, but had a higher WER at 0 dB SNR (16.3%) and with a second talker (16-43%).
  - sources: https://huggingface.co/openai/whisper-large-v3-turbo, https://pypi.org/project/faster-whisper/1.2.1/, faster_whisper-1.2.1 wheel source: faster_whisper/transcribe.py (transcribe signature, get_prompt, should_skip logic) and vad.py (VadOptions defaults), C:\Users\Pieter\AppData\Local\Temp\claude\c--Users-Pieter-repos-theboys\b25379a1-4fa9-46dd-9195-d6aff2b89bad\scratchpad\data\bench_results.json

## Assets, licensing and scriptable downloads; asset toolchain; MCP and agent tooling install on Windows. Checked live on 2026-10-06 against primary sources, plus hands-on tests on the host (Windows 11, Node 24.14, Git Bash MINGW64). All downloads went to the scratchpad; nothing was written to C:\Users\Pieter\repos\theboys; .env and API keys were not touched.
- Q: Can UAL1 clips on the OGA DEF-* rig be retargeted reliably to the UAL2 UE-style rig with SkeletonUtils.retargetClip and a name map, given rest-pose differences? Or must UAL1 v3 come from itch.io, and if so, what are the exact upload ids and flow for Playwright?
  - (high) Neither retargeting nor a browser is needed. There is no rest-pose difference to correct.

**Option A: rename the OGA tracks.** I compared the OGA Godot GLB with UAL2_Standard.glb. All 52 DEF bones map 1:1 with identical local rest rotations (0.0°) and identical offsets, and both rigs have the same root (-90° X). The only differences are the names, the armature node name ('Rig' vs 'Armature'), and 12 extra UE leaf bones that get no tracks. A plain track rename is therefore exact; retargetClip would only resample the clip, and it needs options.hip='pelvis' (default 'hip').
- Gotcha: GLTFLoader passes names through PropertyBinding.sanitizeNodeName, which strips '.', so map the sanitized names:
  - DEF-hips→pelvis, DEF-spine001/002/003→spine_01/02/03, DEF-neck→neck_01, DEF-head→Head
  - DEF-shoulderL→clavicle_l, DEF-upper_armL→upperarm_l, DEF-forearmL→lowerarm_l, DEF-handL→hand_l
  - DEF-f_{index,middle,pinky,ring}0{1-3}L→{finger}_0{1-3}_l, DEF-thumb0{1-3}L→thumb_0{1-3}_l
  - DEF-thighL→thigh_l, DEF-shinL→calf_l, DEF-footL→foot_l, DEF-toeL→ball_l
  - R variants map to _r.
- Rename code: split each track name at the last '.' and replace the bone part.
- The OGA zip's 'Unreal Engine/AL_Standard.fbx' is already UE-named (65 bones, *_end_* leaves, 45 clips), but it is FBX.

**Option B (simplest): itch.io v3.** The Standard zip from 2026-06-16 has UAL1_Standard.glb and UAL1_Standard_RM.glb. Their names and rest pose are identical to UAL2 (max 0.05°), with 43 clips. It drops in with no rename.
- Free upload id: 17958403 (game id 3408034). Pro ($9.99+) and Source ($14.99+) are paid.
- curl/Node flow, verified today:
  1. GET https://quaternius.itch.io/universal-animation-library with a cookie jar; read <meta name="csrf_token" value>.
  2. POST https://quaternius.itch.io/universal-animation-library/file/17958403?source=game_download with form body csrf_token=<token> and header X-Requested-With: XMLHttpRequest. It returns {"external":false,"url":"https://itchio-mirror.<id>.r2.cloudflarestorage.com/upload2/game/3408034/17958403?...X-Amz-Expires=60..."}.
  3. GET that URL within 60 s. I got 15,904,933 B.
  - Never send key= (it returns {"errors":["invalid key"]}).
- Playwright flow:
  1. goto the game page and click a.buy_btn ('Download Now').
  2. Click a.direct_download_btn ('No thanks, just take me to the downloads').
  3. On /download/<key>, run Promise.all([page.waitForEvent('download'), page.click('a.download_btn[data-upload_id="17958403"]')]), then download.saveAs().

**Character creation base: Universal Base Characters (CC0).** The free Standard zip (upload 15861669, 128,968,391 B, same curl flow) holds Superhero_Male/Female_FullBody.gltf with all 65 UAL joint names. Its rest pose differs (neck_01 17–23°, spine_03 11–14°, offsets up to 8 cm), and the same is true of Mannequin_F. UAL clips carry position, rotation and scale tracks on every joint, so on these bodies drop the .position tracks except root/pelvis and the .scale tracks, then check visually.
  - sources: https://opengameart.org/content/universal-animation-library, https://opengameart.org/content/universal-animation-library-2, https://quaternius.itch.io/universal-animation-library, https://quaternius.itch.io/universal-base-characters
- Q: Does the Quaternius Zombie Apocalypse Kit, or Ultimate Monsters, include a rigged, animated quadruped that could serve as the Hound? Exact download URL/slug and format?
  - (high) **Yes: the Zombie Apocalypse Kit (CC0, March 2024).** The pack page (https://quaternius.com/packs/zombieapocalypsekit.html) says: '4 Playable characters, 20 animations each, 4 enemies, and best of all 2 DOGS'. Formats are FBX, OBJ, glTF and Blend.
- Source: the 'Download' button opens a Google Drive folder, https://drive.google.com/drive/folders/1mWP6sCHun7OUMHQeDNZLrXTteXlzWg_t. The glTF files are in Characters (1wSDApzpOZtYAFCk8UIgr91KjXWrWznZd) → glTF (1wtzW_rZvTQ0yiYb6-4P0zwohF6KwCQ6H).
- Hound: Characters_GermanShepherd.gltf, file id 1QovajqzAj7gFG8vCG4DmQ_vm7OP0cVLq.
  - URL: https://drive.usercontent.google.com/download?id=1QovajqzAj7gFG8vCG4DmQ_vm7OP0cVLq&export=download (200, 1,377,304 B, no confirm page).
  - Self-contained glTF 2.0 (Blender glTF I/O 1.7.33) with a base64 buffer and an embedded PNG atlas: one mesh, 4,898 tris.
  - 50-joint skin: Body/Back/Torso1-3/Neck1-3/Head/Ears, front and back legs, Tail1-3, plus IK/pole helper joints.
  - 11 clips: Attack 1.2 s, Death, Eating, HitReact_Left, HitReact_Right, Idle, Idle_2, Idle_2_HeadLow, Run 0.57 s, Run_Jump, Walk 1.07 s.
- Second dog: Characters_Pug.gltf, id 1JafmFjjMky0u_ljSk4o_84IfxCJpkvhW (36 joints, same 11 clips).
- Zombie enemies from the same kit:
  - Zombie_Basic, id 1S6EfXv0Fc6SiqyoPx5gNF48MI0OajNLr: 50 joints, 16 clips including Crawl, Run_Attack, Idle_Attack, Punch, HitReact and Death.
  - Zombie_Chubby: 1PKHYBqygDy3ztkJLOQWx4fY00eFL0epN.
  - Zombie_Ribcage: 1mcGcs5UeeBpgbSwhu3r2yZWoB0V4dazt.
  - Zombie_Arm: 19MMkSg5NkpeSNb6271EoN_pNeBlQpt4Z.
- Listing folders needs no login: https://drive.google.com/embeddedfolderview?id=<folderId>.

**Ultimate Monsters (CC0, October 2022)** lives in Drive folder 18m4KpzpEzhC9wl7jzr6dUc0N8Jozr79C (Big, Blob and Flying, each with glTF, FBX, OBJ and Blends). Its quadrupeds are all chibi: Blob/Dog.gltf (id 1zLzeCmfxleaolUOPvAEDSWzWXSlKAnQe) is 142 KB with only 4 joints and clips Bite_Front, Walk and so on; Cat, Bunny, Dino, Frog and Monkroose are similar. None works as a horror Hound.

**Notes.** There are no itch.io or OGA mirrors of either kit (404). The ZAK style is flat-colour low-poly on a single atlas, so it needs horror art direction: dark palette, fog, rim light, and maybe a custom material.
  - sources: https://quaternius.com/packs/zombieapocalypsekit.html, https://quaternius.com/packs/ultimatemonsters.html, https://drive.google.com/drive/folders/1mWP6sCHun7OUMHQeDNZLrXTteXlzWg_t, https://drive.google.com/drive/folders/18m4KpzpEzhC9wl7jzr6dUc0N8Jozr79C
- Q: Do the cited Kenney and OpenGameArt audio zip URLs still return HTTP 200?
  - (high) Yes. Every URL below returned 200 on a full GET (206 on a Range request) on 2026-10-06. I did not have the exact list the assets-audio researcher cited, so these are the current links taken from the asset pages.

**Kenney (CC0, all .ogg):**
- https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip (800,850 B, 130 files)
- https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip (964,837 B, 52 files)
- https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip (5,875,104 B, 73 files)
- https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip (834,536 B, 100 files)

**OpenGameArt, rubberduck (CC0, .ogg), all under https://opengameart.org/sites/default/files/:**
- 100-CC0-SFX_0.zip (2,921,904 B)
- sfx_100_v2.zip (2,367,871 B)
- 80-CC0-creature-SFX_0.zip (1,885,648 B, 80 files)
- 100-CC0-wood-metal-SFX.zip (1,990,361 B, 100 files)
- sfx_breaking_and_falling.zip (1,624,406 B)
- water-splash-slime-sfx.zip (2,259,262 B)
- 80-CC0-RPG-SFX_0.zip (1,845,114 B)
- 50-CC0-retro-synth-SFX.zip
- 25-CC0-bang-sfx.zip

**Little Robot Sound Factory (CC-BY 3.0):**
- https://opengameart.org/sites/default/files/Horror%20Sound%20Library.zip (70,038,824 B, MP3 + WAV)

The Kenney links embed a hash and timestamp, so scrape kenney.nl/assets/<slug> for the current link rather than hard-coding it.
  - sources: https://kenney.nl/assets/impact-sounds, https://kenney.nl/assets/rpg-audio, https://kenney.nl/assets/sci-fi-sounds, https://kenney.nl/assets/interface-sounds
- Q: Can the gltfpack 1.3 Windows binary turn Poly Haven glTF into KTX2 with no other tools? How do size and VRAM compare with WebP?
  - (high) Yes. gltfpack-windows.zip from the v1.3 release (1,482,895 B, containing gltfpack.exe at 2,985,984 B, which reports 'gltfpack 1.3') needs nothing else. I tested it on Poly Haven metal_tool_chest at 2k (3 × 2048² JPG, 7,301,139 B):

| Mode | Output | Time |
|---|---|---|
| `-cc -tc` (ETC1S/BasisLZ, 12 mips) | 1,726,724 B | 1.5 s |
| `-cc -tc -tu normal` (UASTC normals, ETC1S elsewhere; best size/quality trade-off) | 4,564,400 B | 2.5 s |
| `-cc -tc -tu` (all UASTC+zstd) | 10,764,124 B | 3.0 s |
| `-cc -tw` (WebP) | 1,998,128 B | 0.6 s |
| `-cc` (JPGs kept) | 7,391,620 B | — |

**VRAM:**
- WebP or JPG decodes to RGBA8: 2048²×4 B = 16 MiB, about 21.3 MiB with mips per texture, so about 64 MiB for this model.
- KTX2 (ETC1S or UASTC) is transcoded in a worker by three r186 KTX2Loader to BC7 on Windows desktop (WebGPU 'texture-compression-bc', or WebGL2 BPTC): 1 B/px, about 5.3 MiB per texture, about 16 MiB total. That is 4× less than WebP.
- Download size: ETC1S is about the same as WebP; UASTC is 2–5× larger.

**Loader setup:** the output requires KHR_mesh_quantization, EXT_meshopt_compression and KHR_texture_basisu (or EXT_texture_webp). Call GLTFLoader.setMeshoptDecoder(MeshoptDecoder) and setKTX2Loader(new KTX2Loader().setTranscoderPath('<three>/examples/jsm/libs/basis/').detectSupport(renderer)) after await renderer.init().

**Pitfall:** the npm gltfpack@1.3.0 cannot do any of this. It fails with 'built without BasisU support' and 'built without WebP support'.
  - sources: https://github.com/zeux/meshoptimizer/releases/tag/v1.3, https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md, https://github.com/mrdoob/three.js/blob/r186/examples/jsm/loaders/KTX2Loader.js, https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPUBackend.js
- Q: Does 'claude mcp add <name> -- npx -y chrome-devtools-mcp@1.10.1 ...' start on Windows Claude Code 2.1.2xx without 'cmd /c', i.e. does Claude Code spawn MCP servers through a shell?
  - (high) Yes, it works without 'cmd /c'. I tested it with the user's CLI (claude.exe 2.1.214), using an isolated CLAUDE_CONFIG_DIR in the scratchpad so the real config was not touched.
- `claude mcp add -s user cdtest -- npx -y chrome-devtools-mcp@1.10.1 --headless --isolated --no-usage-statistics --no-performance-crux` stored command 'npx'.
- `claude mcp list` then reported '✔ Connected', with no warning.

It does not go through a general shell. The binary bundles the MCP SDK StdioClientTransport, which spawns with shell:false and windowsHide through a bundled cross-spawn (the binary contains its hookChildProcess and verifyENOENTSync code). For .cmd shims, cross-spawn rewrites the call to `%COMSPEC% /d /s /c "<escaped cmd>"` with windowsVerbatimArguments. That is why npx (npx.cmd) works, and why 2.1.119 removed the 'cmd /c' warning.

Pitfall: if you add `cmd /c` from Git Bash, MSYS rewrites it. The stored args became ["C:/","npx",...], which is broken. Use `cmd //c` or PowerShell, or just plain npx.

Plain Node spawn('npx') without a shell fails with ENOENT (and npx.cmd throws EINVAL), which explains why some other MCP hosts still need the wrapper.
  - sources: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/stdio.ts, https://code.claude.com/docs/en/mcp
- Q: Does installing winget Gyan.FFmpeg avoid a UAC prompt? Is ffmpeg needed tonight at all, or can audio conversion be skipped?
  - (high) **UAC: it should not prompt.** `winget show --id Gyan.FFmpeg -e` (winget v1.29.380 is installed) reports version 9.0.2, released 2026-09-20, 'Installer Type: portable (zip)', from https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip. Per the winget portable spec, portable apps install in User scope by default (the manifest scope is ignored) to %LOCALAPPDATA%\Microsoft\WinGet\Packages\<id>_<source>.

**PATH (inferred, not tested with ffmpeg):** on this host Developer Mode is off (the AppModelUnlock value is absent) and %LOCALAPPDATA%\Microsoft\WinGet\Links is empty. The earlier portable Terraform install was added to HKCU PATH as its package directory. So expect ffmpeg's ...\ffmpeg-9.0.2-full_build\bin to be appended to the user PATH. Only new shells will see it; inside the running Claude Code session, call it by full path.

**Command:** `winget install --id Gyan.FFmpeg -e --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity`.

**Not needed tonight.** The Kenney and rubberduck packs are Ogg Vorbis, LRSF ships MP3 + WAV, and Freesound previews are preview-hq-ogg or mp3. Web Audio decodeAudioData in Chrome, Edge and Firefox decodes all of these directly, so conversion can be skipped. ffmpeg only matters for later polish (loudnorm, trimming, Opus re-encode for size) or for chrome-devtools-mcp --experimentalScreencast. Options that avoid winget and PATH changes: unzip the GitHub zip above into a tools folder, or use npm ffmpeg-static 5.3.0.
  - sources: https://github.com/microsoft/winget-cli/blob/master/doc/specs/%23182%20-%20Support%20for%20installation%20of%20portable%20standalone%20apps.md, https://learn.microsoft.com/en-us/windows/package-manager/winget/install, https://www.gyan.dev/ffmpeg/builds/, https://kenney.nl/assets/impact-sounds
- Q: Research process notes
  - (high) - The shared WebSearch budget (200 per turn, across all agents) was already used up at my first query. I verified everything through WebFetch and curl against primary sources (official docs, raw GitHub files at release tags, the npm registry, the Poly Haven and ambientCG APIs) and through local tests. If more open-ended searching is wanted, the user can send a follow-up.
- The claude.ai Google Calendar and Google Drive connectors are unauthenticated in this session. They were not needed here; authorize them in claude.ai connector settings if a later task needs them.
- The test MCP config lives only in the scratchpad (CLAUDE_CONFIG_DIR) and no test processes were left running.
  - sources: https://registry.npmjs.org/, https://api.polyhaven.com/assets, https://ambientcg.com/api/v3/assets