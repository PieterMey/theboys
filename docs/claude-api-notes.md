# Claude API notes for this project

These notes are distilled from the official claude-api skill (cached 2026-09-25) and measured in `docs/bench/ai-bench.md`.

## Models and settings tonight (IDs come from env; never hardcode in more than one place)

| Use | Model ID | Pricing ($/MTok in/out) | Notes |
|---|---|---|---|
| Writer (briefs, HR memos) | `claude-opus-5-5` (env `MODEL_WRITER`) | 4 / 20 (cache read 0.20) | Thinking is **always on**: `{type:'disabled'}` and `budget_tokens` return 400. Control depth with `output_config.effort` (`low` \| `medium` \| `high` \| `xhigh` \| `max`); the default is **medium**, so set it explicitly. Thinking tokens count toward `max_tokens`, so use about 16000. Measured: low effort, short output, about 4.2 s. |
| Fast picker fallback (Listener intent) | `claude-haiku-4-5` (env `MODEL_FAST`) | 1 / 5 | Do **not** send `effort`. Thinking is off by default. The minimum cacheable prefix is 4096 tokens. Measured p50 1.67 s, p90 2.0 s total (about 2K-token input, structured output). |
| Optional faster memo | `claude-sonnet-5-5` | 2 / 10 | To turn thinking off, send `thinking:{type:'between_tools'}` (only at effort `high` or lower). Never `disabled`. |

## Request rules (Opus/Sonnet 5.5 and Haiku 4.5)

Each of these returns 400 or misbehaves:
- `temperature`, `top_p`, `top_k` on 5.5 models.
- Assistant prefill.
- `tool_choice` set to `any` or `tool` (forced tool use).
- `budget_tokens`.
- `output_format` (deprecated; use `output_config.format`).

Use **`client.messages.create({...})` with `output_config: { format: { type: 'json_schema', schema } }`**, then branch on `stop_reason`:
- `end_turn`: read the text block and `JSON.parse` it inside try/catch. Validate with zod `safeParse` against a permissive schema, then enforce counts and length limits in code. The grammar does not enforce zod min/max.
- `refusal`: log `stop_details?.category`, then retry once on Haiku 4.5 (it has no safety classifiers), then fall back to the template.
- `max_tokens`: use the template.

Do NOT use `messages.parse()`: it throws on truncated JSON and discards the message.

## Prompt caching

- Put stable content first (system prompt, world bible, schema), with `cache_control: {type: 'ephemeral'}` on the last stable block. The TTL is 5 minutes by default; use `ttl: '1h'` for prompts reused across contracts.
- The minimum prefix is 512 tokens on Opus/Sonnet 5.5 and 4096 on Haiku 4.5. Shorter prefixes silently don't cache.
- Silent invalidators: a timestamp, a random ID, or unsorted JSON anywhere in the prefix.
- Check `usage.cache_read_input_tokens` to confirm caching works.

## Errors and timeouts

- The TypeScript SDK timeout is in **milliseconds**. `maxRetries` defaults to 2; use 0 on real-time routes.
- Catch typed errors, most specific first: `Anthropic.RateLimitError`, then `Anthropic.APIConnectionError`, then `Anthropic.APIError` (has `.status`).
- A user-set spend limit returns 400; the tier cap returns 429 `enforced_spend_limit_reached` with no `retry-after`. Either one should turn AI features off for the session.

## Safety and tone

- PG-13 dread, not gore. The threat is supernatural: never pathogens, chemicals, weapons or lab procedures (this avoids Opus's bio classifier).
- Never name JSON fields `reasoning`, `thinking` or `trace` (this triggers billed `reasoning_extraction` refusals).

## JEV (TypeSafe), measured

- `POST https://api.typesafe.ai/v1/systemone` with a Bearer key and model `jev-1.13.0`. p50 228 ms, p90 250 ms.
- The health check is `GET /v1/models`. It lists `jev-latest` and `jev-preview`, and the pinned `jev-1.13.0` is accepted.
- JEV answers each question **independently**. Choose the *action* with JEV, but derive the *target* in code from what was heard (the newest or loudest meaningful line), or build target options from the heard entries.
- Gate on confidence: below 0.5, fall back to Haiku or the rule brain.
