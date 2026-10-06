# AI services: health and latency bench

Measured 2026-10-06T14:12:21.293Z from this host by `node --env-file=.env tools/ai-check.mjs`. Numbers only: no keys, prompts or responses.

## JEV (TypeSafe)

- GET /v1/models: HTTP 200 in 260 ms; models: `jev-latest`, `jev-preview`.
- POST /v1/systemone, model `jev-1.13.0`, 8 sequential Listener decisions (2 choice questions per call: intent over the allowed actions, target over the crew; options shuffled per call): 8/8 parsed and valid.
- Latency, all calls: p50 228 ms, p90 250 ms (min 220, max 272, n=8). Warm connection (calls 2-8): p50 228 ms, p90 253 ms (min 220, max 272, n=7). First call: 236 ms.
- Input tokens: 10444 total (about 1306 per call); cost $0.00044.
- Picks (intent/target, intent confidence): ambush/p2 0.34; hunt/p2 0.33; deflect/p3 0.49; retreat/p2 0.92; hunt/p2 0.97; retreat/p2 0.39; hunt/p2 0.84; ignore/p2 0.28. The target answer is independent of the intent answer and picked p2 (the lone, unlit player) in 7 of 8 calls, including when p4 screamed.

## Claude

### `claude-haiku-4-5` (Listener intent: json_schema enum action + target id + note, max_tokens 100, about 1969 input tokens per call)

| Metric | p50 ms | p90 ms | min ms | max ms | n |
|---|---|---|---|---|---|
| Total, all calls | 1670 | 2017 | 867 | 2145 | 8 |
| Total, calls 2-8 (schema grammar cached) | 1660 | 1801 | 867 | 1962 | 7 |
| Time to first token | 1445 | 1786 | 716 | 1953 | 8 |

- First call (includes the one-time schema compile): 2145 ms. Valid decisions: 8/8. Picks: hunt, mimic, deflect, retreat, hunt, ambush, stalk, stalk.
- Usage: 15750 input, 200 output tokens; cost $0.0167.

### `claude-opus-5-5` (writer check: effort low, max_tokens 2000, json_schema)

- 4246 ms total, stop_reason `end_turn`.
- Usage: 426 input, 119 output (thinking included), cache write 0, cache read 0; cost $0.0041.
- Output checks: placeholder appears exactly once: true; memo 26 words; clue 15 words.

Claude spend this run: $0.0208.

## ElevenLabs

- GET /v1/user/subscription: HTTP 200 in 1401 ms. Tier `creator`, status `active`.
- Credits: 251 used of 131000 (130749 remaining). Next reset: 2026-11-06T13:36:50.000Z.

## Total live spend this run: $0.0213
