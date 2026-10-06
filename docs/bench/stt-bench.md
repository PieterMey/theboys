# STT sidecar benchmark

Measured 2026-10-06T14:16:00.757Z by `node services/stt/test_stt.mjs --write-bench` on this host (RTX 5090).

- Model: faster-whisper `large-v3-turbo`, device `cuda`, compute `float16` (faster-whisper 1.2.1, ctranslate2 4.8.2).
- Startup: model load 1495 ms, warm-up 720 ms.
- Clip: 6.00 s of synthetic speech (tests\fixtures\voice\talk_en.wav), sent as raw PCM16LE 16 kHz over HTTP on localhost, 8 sequential runs each.
- GPU load from other processes just before timing: 99% util, 536 W. Encoder reuse hits: 9.

| Mode | client p50 ms | client p90 ms | server p50 ms | server p90 ms | min-max client ms |
|---|---|---|---|---|---|
| langs=en,nl (VAD + restricted detection + greedy) | 322.6 | 344.2 | 321 | 342.6 | 201.9-345.9 |
| langs=en (fixed language) | 298.5 | 330.7 | 297.2 | 329.2 | 192.4-331.7 |

- Stages of the last en,nl run: VAD 6.5 ms, language 188 ms, decode 135.4 ms.
- First request after warm-up: 345.4 ms client.
- Detection on the English clip: lang=en, restricted probability 1.
- 2 s silence: text empty in 3.2 ms. 2 s white noise: text empty in 2.2 ms.
- Checks: 7/7 passed.

## Earlier runs today (same script, 6.30 s SAPI clip, server-side ms)

| GPU load from other processes | Encoder reuse | langs=en,nl p50 / p90 | langs=en p50 / p90 |
|---|---|---|---|
| quiet (before other agents' GPU tests) | off | 126 / 128 | 84 / 86 |
| about 45% util, 250 W | on | 125 / 137 | 117 / 120 |
| 99% util, 550 W | off | 395 / 450 | 290 / 311 |
| 99% util, 534 W | on | 343 / 424 | 308 / 339 |
| 99% util, 541 W | off | 458 / 479 | 297 / 315 |
| 100% util, 544 W | on | 343 / 414 | 312 / 356 |

Reading: with a quiet GPU a 6 s utterance takes about 85 ms (one language) to 125 ms (en/nl detection). When the GPU is saturated by other work (the host's own game client renders on the same card), expect about 300-450 ms. Reusing the detection encoder pass cuts the detection overhead from about +100-160 ms to about +35 ms under load.
