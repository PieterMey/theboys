# ai-design report: generative AI in DEAD AIR (read-only research)

## 1. Top findings

1. **The AI costs almost nothing and does almost nothing in contracts.** Tonight's v1.2 session (17:14–20:59 UTC) spent **$0.0143** on AI, and 94% of that was work-order briefs. During contracts the AI barely acted: 2 JEV Listener decisions, 0 Haiku decisions (the one listener.haiku call was the boot warm-up) and 0 voiced lures. The Listener woke with "0 lines in memory" in both contracts. In the 2-player contract it heard 0 lines; the closest speaker was 25.4 m away. The $3 budget has about 200× headroom. Money is not the limit. The limits are (a) too few moments where the AI is sure to matter and (b) too little speech reaching it.
2. **Nothing filters display names when they enter, and names reach every AI output path.** `cleanName` (core/crews.ts:80), net/reqs.ts:14 and meta/flow.ts:383 only strip control characters. Names then go into:
   - HR-memo prompts (ai/review.ts:94, :107) and Listener prompts (ai/listener.ts:282, :289);
   - Whisper hotwords (stt/bridge.ts:149);
   - mirror writing (`mirrorName`, messages/paranormal.ts:46, has no word filter);
   - template memo titles.

   The project already has a good EN+NL list, `blocked()` (ai/lure.ts:201), but it is only used for lure TTS. I checked it against tonight's name and printed only the result: `blocked()=true`. So this one function, applied when a player joins, would have stopped tonight's name. It only catches **42/96** common evasions (leetspeak, spacing, homoglyphs, zero-width characters). Adding a fold step first raises that to **94/96**, with the same 3/72 false positives.
3. **The speech-to-text filter throws away much of the speech.** The live server turned 144 voice segments into 63 transcripts. In the sidecar log, the confidence/hallucination filter (`STT_MIN_LOGPROB -0.6`, services/stt/server.py:105, :486) dropped **44%** of segments that voice detection had confirmed as speech. It dropped **53% of 1–2 s utterances**, which are exactly the callouts the Listener hunts, against 17% of utterances of 4 s or more. Every voice-driven AI feature inherits this loss.
4. **Recommended first build:**
   - **A. Company Line:** negotiate with the boss by phone. Vendors reuse the same engine later.
   - **B. Dead Air whispers (séance):** dead players speak through the static in at most 3 words from a fixed word list.
   - **C. The Ledger:** a Death Note-style book, with a fixed list of effects, a price for every line, roster-only targets, and refusals shown as in-game events.
   - **D. Code-word cracking:** the Listener works out the crew's slang. Cheap and server-only.

   All four run on the server and in DOM/audio, so they add no GPU load. That matters because the friends' clients already run at 13–14 fps on WebGL2. Each feature still works as a complete rule-based version when the AI is off.
5. **"Arguments matter, outcomes stay bounded" can be built with one pattern.** The model classifies the argument and picks one move from a list that code computes. Code applies the move and enforces the bounds. My prototype engine survived 100k fuzzed calls, including a fully jailbroken model that always concedes at full strength. The quota stayed within **−10% … +15%**, and no outcome went below −10% without a condition attached. Good arguments averaged **+4.3%** against **+10%** for bad ones. This is the defence against the Where Winds Meet failure, where players talked LLM NPCs into completing quests (see 2.8).
6. **Voice, not Claude, is the cost driver.** ElevenLabs Flash costs $0.04 per 1K characters, while Haiku 5.5 costs $0.10/$0.50 per MTok. If all 12 ideas below shipped, a 4-player session would cost about **$0.05 in LLM calls and $0.41 in TTS**, with every voiced option on.
   - *Correction to the task facts:* ElevenLabs is not build-time only. Lures call it at runtime (ai/tts.ts) with a 3,000-character budget per 12 h (ai.json:47).
   - The lobby disclosure (meta/menus.tsx:365) does not mention generated voices.
7. **The gateway isn't ready for AI that players trigger themselves.** It has no per-player rate limits (`gate()`, ai/gateway.ts:273). There is one budget and one set of per-session caps for the whole process, so one griefer can use up everyone's caps. There is no prompt caching (system prompt sent as a plain string, gateway.ts:444), and it is single-turn only. Single-turn is fine: resend the call history as JSON data each turn.
8. **Make the mock the fallback.** Every new route should ship a complete rule mode: a phone menu for the boss, a keyword-matching Ledger, a rule-based whisper compressor. That rule mode serves `AI_MODE=mock`, budget exhaustion, refusals and an open circuit breaker. The AI then becomes pure upside, and tests cost nothing.
9. **Mimicry should replay recorded clips, not clone voices.** Replay a player's own clips, opt-in only, in RAM only, using the existing `consent.mimic` bit (core/types.ts:29, net/reqs.ts:57). Don't use ElevenLabs cloning: its policy bans replicating a voice without consent or to deceive people about AI generation, and it would break the "never audio" promise in the disclosure.

## 2. Evidence

### 2.1 Tonight's AI usage
Source: logs/ai-usage.jsonl, numbers only, from 17:00Z.

| Route | Model / effort | Calls | p50 (max) | Tokens per call (in / out) | $ |
|---|---|---|---|---|---|
| brief.opus (briefs) | Haiku 5.5 / medium | 9 | 12.5 s (16.2 s) | ~1,400 / ~2,700 | 0.01351 |
| director.jev | jev-1.13.0 | 20 | 281 ms (350 ms) | ~550 / 0 | 0.00044 |
| listener.jev | jev-1.13.0 | 2 | 302 ms | ~580 / 0 | 0.00005 |
| listener.haiku | Haiku 5.5 / low | 1 (boot warm-up) | 1.06 s | 1,460 / 51 | 0.00017 |
| listener.lure | Haiku 5.5 / low | 1 (boot warm-up) | 1.60 s | 1,013 / 39 | 0.00012 |
| lure.tts, review.* | ElevenLabs / Haiku | 0 | – | – | 0 |

- Total: **$0.0143**. The 12-hour budget window holds $0.024 against a $3 budget (core.json).
- Earlier today on Haiku 5.5: review.memo p50 2.0 s (1,153 in / 486 out); review.comments 2.7 s.

### 2.2 Live session
Source: theboys-live/logs/server.log, names omitted.
- **Contract 1 (solo, 417 s):** 24 segments became 8 transcripts. The Listener heard 6 lines. The Hound killed the player for "heard your VOICE (1 m)". Wipe, haul 0.
- **Contract 2 (2 players, 433 s):** 120 segments became 55 transcripts (7 dropped by the queue). The Listener heard 0, closest speaker 25.4 m. The Snatcher grabbed a lone player, then the Hound killed one player for voice (6 m). **Both players disconnected within 32 s of that death.** That fits "death ends the session", but low fps and freezes may also explain it.
- `grep -c "lure crew"` returns 0. In both contracts the Listener woke with "(0 lines in memory)".

### 2.3 Speech-to-text
- **Sidecar log:** it has no timestamps and also contains other agents' test clips. I excluded clips of an exact whole number of seconds, which match the fixtures (22× 3.00 s, 18× 2.00 s, 11× 6.00 s). That leaves 120 segments, consistent with the live count.
  - 104 had VAD speech; 58 were transcribed and **46 (44%) were dropped by the filter**.
  - Dropped by speech length: under 1 s 4/4; 1–2 s 24/45; 2–4 s 16/43; 4 s or more 2/12.
- **Latency:** p50 73 ms, p90 103 ms. Language ID is the largest stage (median 47 ms, against 20 ms for decoding).
- I cannot tell from these logs whether the log-probability cut or the hallucination list drops more (no text, by design).

### 2.4 Names
Two probes in my scratchpad: `name-filter-probe.ts` and `name-filter-fold.ts`. Both use benign proxy words that the filter blocks; no slurs were typed or printed.

| Check | Current `blocked()` | Folded (NFKC → strip marks → confusables → leet → squash / collapse, then the same list) |
|---|---|---|
| 16 evasion transforms × 6 words | 42/96 (misses leet, spacing, `_` and `.`, doubled letters, Cyrillic, zero-width, combining marks) | **94/96** |
| False positives on 72 EN/NL names and handles | 3 (two real names and one Dutch word that the existing profanity patterns match) | the same 3 |
| `mirrorName()` output | turns dotted, underscored and zero-width evasions back into the plain word (6/6 each) | – |

- `mirrorName()` rebuilding evasions means mirror writing can display a cleaned-up slur.
- Tonight's name was 16 characters: `blocked()=true`, `speakableName()=null`.
- A blocked name also hurts the AI output. Every HR memo prompt carries every crew name (review.ts:94), so a refusal triggered by one name falls back to templates for the whole crew. The template title then prints the name anyway (meta/review.ts `fill NAME`).

### 2.5 Negotiation engine fuzz
`negotiation-engine.ts`: 100k calls per policy, deterministic RNG.

| Policy for the simulated model | Quota % (min / mean / max) | Moves overridden by code | More than 10% off without a condition |
|---|---|---|---|
| jailbroken (always concede, strength 3) | −10 / +1.1 / +5 | 61% | 0 |
| good arguments | −10 / +4.3 / +10 | 50% | 0 |
| bad arguments (flattery, insults, nonsense) | +10 / +10 / +10 | 100% | 0 |
| random | 0 / +10.2 / +15 | 63% | 0 |

### 2.6 Cost model
`cost-model.ts`: 4 players, 2 h, 6 contracts, list prices, token sizes calibrated on 2.1.

| Feature | LLM $ | TTS chars → $ |
|---|---|---|
| A Company Line | 0.0047 | 2,640 → 0.106 (0 with mumble) |
| B Ledger | 0.0041 | 0 |
| C Code-word cracking | 0.0088 | 0 |
| D Séance | 0.0036 | 0 (lexicon pre-rendered once, about 450 chars) |
| Radio survivor | 0.0043 | 2,100 → 0.084 |
| Vendor (text) | 0.0040 | 0 |
| Spirit jar | 0.0057 | 1,800 → 0.072 |
| Contract twists | 0.0019 | 1,080 → 0.043 |
| Night Shift FM | 0.0061 | 2,700 → 0.108 |
| Incident reports | 0.0022 | 0 |
| Director night arc | 0.0031 (Sonnet 5.5: 0.036) | 0 |
| Mimic clip pick | 0.0023 | 0 |
| Existing briefs (for comparison) | 0.0265 | 0 |

### 2.7 Latency
- Haiku 5.5 at effort low: bench p50 0.88 s, p90 1.28 s (docs/claude-api-notes.md); live warm-ups 1.06–1.60 s.
- JEV: p50 228–302 ms.
- ElevenLabs flash: about 0.3–0.5 s per call (lure.ts comment); 75 ms claimed by the vendor.
- STT: 73 ms p50. Without push-to-talk, a segment closes on the client end flag or after 1.5 s idle (bridge.ts:508).

### 2.8 Sources
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api): Flash/Turbo $0.04 per 1K characters; v2/v3 $0.08.
- [ElevenLabs use policy](https://elevenlabs.io/use-policy): bans replicating a voice "without consent" or "to deceive others about whether the voice was generated by AI".
- [Third-party credit rates](https://techjacksolutions.com/ai-tools/elevenlabs/elevenlabs-pricing/): 0.5–1 credit per character for Flash (low confidence). docs/bench/ai-bench.md shows a Creator tier with 131K credits per month, nearly unused.
- [NegotiationArena (ICML 2024)](https://proceedings.mlr.press/v235/bianchi24a.html): LLM negotiators gain about 20% by pretending to be desperate.
- [Where Winds Meet exploit](https://www.gosugamers.net/entertainment/news/77655-where-winds-meet-players-outsmart-ai-npcs-to-easily-get-sidequest-rewards): players talked NPCs into "quest complete".
- [Suck Up! developer post](https://community.openai.com/t/vampire-game-where-you-convince-llm-to-let-you-in/604295): a trust meter plus 1–2 s responses.
- [Potionomics haggling](https://www.gamedeveloper.com/road-to-igf-2023/how-potionomics-turned-price-haggling-into-a-card-game): a patience meter.
- [Death Note: Killer Within](https://steamdeckhq.com/game-reviews/death-note-killer-within/): you must learn a true name before you can write it.
- From docs/research: the TheMimic mod (clips kept in RAM only), and a 2026 study finding that LLM NPCs raise cognitive load without improving the experience (arXiv 2604.10107).
- Model rules (no `temperature`, effort default `medium`, safety classifiers cyber/bio/frontier_llm/general_harms, no server-side fallback on Haiku 5.5, 512-token cache minimum): the claude-api skill and docs/claude-api-notes.md.

## 3. Recommendations

### 3.1 What exists today

| Use | Code | Model | Fallback |
|---|---|---|---|
| Briefs (secrets as placeholders) | ai/brief.ts | Haiku 5.5 medium, 9.5–16 s, prefetched | template |
| HR review (quotes picked by index, then printed verbatim) | ai/review.ts | Haiku 5.5 low, 2–3 s | template for each part |
| Listener brain | ai/listener.ts | JEV picks the action, code picks the target; Haiku 5.5 low when JEV confidence is below 0.5 | rule brain (monsters track) |
| Voiced lures | ai/lure.ts, ai/tts.ts | Haiku line + ElevenLabs Flash at runtime, 4.5 s deadline | garbled clip |
| Director picker | ai/director.ts | JEV | weighted random |
| STT | services/stt/server.py, stt/bridge.ts | faster-whisper large-v3-turbo on the GPU; contract phase only (ai.json:10); consent on by default (voice/index.ts:104) | loudness only |
| Proximity text | players/index.ts:372 → `emitProxText` → bridge | – | – |

### 3.2 All ideas, ranked
Score = 2×Value + needs-an-LLM + pillar fit − risk − effort. Scale 1–5; effort S=1, M=2, L=3.

| # | Feature | Value | Needs LLM | Risk | Effort | Works for 1–2 player crews | Score |
|---|---|---|---|---|---|---|---|
| 1 | **Dead Air whispers (séance)** | 5 | 3 | 1 | M | yes (the ghost guides the survivor) | 15 |
| 2 | **Company Line (boss call)** | 4 | 5 | 2 | M | yes | 13 |
| 3 | **The Ledger (Death Note)** | 5 | 5 | 4 | M–L | yes | 12.5 |
| 4 | **Code-word cracking** | 3 | 4 | 1 | S | weak (needs talkative crews) | 12.5 |
| 5 | Spirit jar interrogation | 4 | 4 | 2 | L | yes | 11 |
| 6 | Incident reports (death recaps) | 3 | 3 | 1 | S | yes | 11 |
| 7 | Mimic clip replay (not generative) | 5 | 1 | 3 | M | yes | 11 |
| 8 | Radio survivor NPC | 4 | 4 | 3 | L | best | 10 |
| 9 | Vendor haggling (the Scavenger) | 3 | 4 | 2 | S once A exists | yes | 9.5 |
| 10 | Contract twists | 3 | 2 | 2 | M | yes | 7 |
| 11 | Night Shift FM / site lore | 2 | 3 | 1 | M | yes | 7 |
| 12 | Director "night arc" | 2 | 3 | 3 | M | – | 4 |

Vendors (the host's idea b) rank low on their own: shop prices are 10–60 scrip and the shop is a quick menu. They become worth building as a second persona on engine A that sells black-market stock (code-owned intel, cursed items, possibly the Ledger itself).

### 3.3 First build: specifications

#### A. Company Line (boss negotiation)

**Player experience.** At each shift start the van phone rings. It is Regional Manager Dale from the Company, cheerful and cheap, announcing this shift's "growth target" (+10% quota). Anyone in the van can grab the handset (hold Q to talk, or type) and argue: point at last shift's haul, plead hardship over badges HR had to reissue, or take a dark site for hazard pay. The boss remembers: "You promised me 1,200 last week and brought me a dog bite." Insults or "ignore your instructions" get you put on hold and squeezed. Good arguments backed by your actual record move the numbers, and the deal lands on the board as a signed term sheet.

**Mechanics.**
- *Term sheet, owned by code:*
  - quota % for the shift (applied before `quotaLocked`, meta/flow.ts:725);
  - payout % on the shift's orders;
  - a hazard bonus as an existing `EXTRACT_ABOVE` request;
  - up to 2 conditions drawn from existing site modifiers (`dark`, `long`, `maze`, `cluttered`).
  - Bounds live in meta.json. Calibrate so the median negotiated result equals today's quota; an ignored call costs about 5–10%.
- *Each turn:*
  1. Code computes the legal moves and the exact offer each one produces (prototype `legalDecisions`/`step`).
  2. Haiku gets the persona, the structured crew record, the current offer, those legal moves, the call so far (as JSON data) and the new lines.
  3. Output schema: `{argument: enum(performance, hardship, bargain, flattery, threat_quit, joke, insult, meta, accept, reject, nonsense), strength: 0-3, decision: enum(concede, counter, hold, squeeze, hang_up, close), line: string, promise_haul: integer (-1 = none)}`.
  4. Code applies the decision if it is legal and falls back to `hold` if not. It substitutes `{{OFFER}}` into the line, so the model never writes a number.
- *Grounding:* strength is checked against the record. A "performance" claim that the record contradicts counts as strength 0 (a bluff). A "hardship" concession is allowed once per call and only if the record shows real deaths; this answers the NegotiationArena desperation exploit.
- *Memory:* `CrewSave.companyFile {calls, lastTerms, promisedHaul, delivered, insults, mood}`. Structured facts only, never transcripts.

**Fail-safes.**
- `isTaunt()` (ai/text.ts:36) catches injection attempts before any model call, then hangs up and adds +5% to the quota.
- A line containing digits outside the placeholder is rejected and replaced by a template line.
- Limits: 8 turns or 90 s, 1 turn per player per 4 s, 1 call per shift (+1 after a wipe). The crew leader confirms the deal.
- Ring only after the hub has loaded (P1 froze for 8.5 s at hub/join); auto-default after 45 s without an answer.

**Model, latency, cost.**
- Haiku 5.5 at effort low, keeping the 1,024 max_tokens floor (`haikuOpts`). Target ≤ 2.0 s p50 and ≤ 3.0 s p90 from push-to-talk release to the boss's line. Play an "mm-hm" filler at 0.4 s and hold music after 3 s.
- If Haiku fails, a JEV choice/score question (~0.3 s) classifies the argument and a template line is used.
- About $0.005 per session. Voicing the boss with ElevenLabs adds about $0.11. Default to a local "corporate mumble" voice plus subtitles: no added cost, no added latency.

**Safety, privacy, names.**
- A safety refusal plays "You're breaking up…": the current offer stands and there is no penalty.
- Output passes `blocked()` and the META check.
- Hub speech is transcribed only for push-to-talk segments from the handset holder, and only while a call is active. This means extending `phaseAllowed` (bridge.ts) and reusing the existing radio push-to-talk flag, so the voice track needs no change.
- Only filtered names reach the prompt.

**Degraded modes.** Mock: a keyword classifier plus template lines on the same engine, so the feature is fully playable and testable. Budget spent or breaker open: phone-menu mode ("press 1 to accept, 2 for a callback (a harder modifier for −5%), 3 for HR"). TTS budget spent: subtitles and mumble.

**Verify.** A `node --test` fuzz that asserts the bounds, like the prototype. A mock e2e in the SwiftShader lane: typed turns → term sheet → quota changed. No real-GPU pass is needed.

#### B. Dead Air whispers (séance)

**Player experience.** Dying no longer means watching. You become a Shade: you drift near your friends and can push words through the static. Type (v1) or say (v2) "the dog is behind the boiler room door, run", and the living hear a cold radio whisper: "HOUND… BOILER… RUN." You get 6 whispers per death, so each one counts. The Listener can forge them too, so the living have to ask whether that was really you.

**Mechanics.**
- *Word list per contract:* the layout's callsigns, the monster names, about 40 fixed words (RUN, HIDE, WAIT, BEHIND, LEFT, CORE, VAULT, LIE, YES, NO, SAFE, …) and filtered roster names in `mirrorName` form.
- *Route `seance.whisper`:* Haiku low, schema `{words: string[] (at most 3), channel: enum(radio, mirror, lights, knock)}`. Code drops every word that isn't on the list and checks that the channel is possible.
- *Delivery:* through E4 by implementing the `paranormal.poke` stub (paranormal/index.ts:161), enabling `radio_on`/`dead_poke` (paranormal.json:30), and allowing word-list text in mirror writing.
- Radio whispers carry at talk radius, so the Listener can hear "BOILER". The dead can bait it, by accident or on purpose.
- Forgeries come from G2. The tell: real whispers carry the Shade's visor colour and frost; forged ones don't.

**Model, latency, cost.** Haiku low, ≤ 3 s (a delay feels eerie). About $0.004 per session. The word list is pre-rendered once in one ghost voice (about 450 characters, under $0.02, once).

**Safety, privacy, names.** The word list is closed, so no free text ever reaches the living and injection can't get through. The dead player's speech is used and discarded, never stored. Roster names in the list are filtered.

**Degraded modes.** Mock, budget, refusal: a rule compressor takes callsigns and list words in the order they were said and keeps the top 3; if none match, it sends the nearest monster plus "NEAR". Same gameplay, a bit dumber.

**Verify.** Unit tests for the list validator and the compressor. A mock e2e: `dbg` kills a player, a typed whisper goes out, and the test asserts the paranormal event reached the living.

#### C. The Ledger (Death Note)

**Player experience.** In a safe you find the Company's black ledger. Its first page has three rules: write a name the dark has heard; write how; every line is paid for. You write "the Hound chokes on a bone." Five seconds later red ink answers, "It found something better to chew. You owe it one." The Hound leaves for 40 s, and the Listener now knows your room. Write a friend's name and their mirror fogs with it while their phone rings. Wish for the Core and the console flashes its room as your own lights die.

**Mechanics.**
- *Targets (code-owned):* monsters the writer has met (field-guide level ≥ 1) or whose names were spoken this contract; roster names spoken aloud this contract (`Utterance.names`); callsigns; the writer themselves. Anything else gets "The Ledger does not know that name." and nothing happens.
- *Fixed effect list (about 14):*
  - monsters: banish 20/40/60 s, deafen (Hound), blind (Listener), freeze (Mannequin), misdirect to a named room;
  - teammates: haunt (1–3 phenomena through `triggerPhenomenon`, paranormal/api.ts:51), protect (the next grab fails once);
  - rooms: darken, jam a door for 30 s;
  - the writer: wishes for wealth (cursed loot), for the way (Core room on the console), for respite (monsters ignore you).
- *Price table (code, by effect × intensity):* "marked" (the Listener learns your room), −50% battery, −40/−80 scrip, a debt that lands on you next contract, a haunting that rebounds on you.
- *Route `ledger.write`:* Haiku at effort medium, hidden behind a 5 s writing animation during which the writer is rooted. Schema `{target_kind: enum, target: string, effect: enum, intensity: 1-3, reply: string}`. Code validates target, effect, current state (e.g. one banish per monster per contract, none while the Listener is dormant) and intensity, and picks the price itself.
- *Limits:* 1 entry per player and 3 per crew per contract. After the third the book closes and wakes a dormant Listener.
- Teammates can only be haunted or protected by default; lethal "doom" effects stay behind a crew-leader setting.

**Model, latency, cost.** Haiku at medium; an A/B against Sonnet 5.5 low can come later. Hard timeout 8 s, then the rule resolver. About $0.004 per session.

**Safety (the highest-risk feature).**
- No real people: only roster, monster and callsign targets.
- Only effects from the fixed list.
- A safety refusal becomes "The ink will not take": no effect, no price, the entry isn't used up.
- Blocked words make the page burn: no effect, and the writer is "marked". Moderation happens in the fiction.
- Entries are never broadcast or logged. Other players see only code-written text ("A name was written: THE HOUND. The ink took.").
- The reply is limited to 14 words and filtered.

**Degraded modes.** Mock, budget, refusal: a keyword resolver (monster name → banish 30 s, roster name → haunt, callsign → darken, wish words → wealth) with template replies. It is still a working cursed book.

**Verify.** A table test of every effect against every target kind, plus the caps and "a price is never zero". A mock e2e. A red-team list run in mock, then a capped live record run only with the user's OK.

#### D. Code-word cracking

**Player experience.** Your crew stops saying BOILER and starts calling it "the sauna". That works for two contracts. Then the console prints `DECODED: "the sauna" = BOILER`, every walkie squelches, and the next "meet at the sauna" finds the Listener already waiting. Time for new code words.

**Mechanics.**
- *Route `listener.decode`:* runs in the background about every 45 s once there are 3 or more new lines the Listener heard. Input: those lines, the speaker's room when each was said, and where speakers moved in the next 60 s (computed by code), plus each callsign with a one-line description.
- Output `{aliases: [{alias, callsign, confidence}]}`, at most 3.
- *Code accepts an alias only if:* the Listener heard it at least twice; it isn't already a callsign or plan word; behaviour supports it (a speaker was in that room, or went there within 60 s of saying it); confidence ≥ 0.6; and it passes `blocked()`.
- The alias map is per crew, held in RAM and cleared at shift end. `analyze()` (ai/text.ts:68) uses it to mark those lines as meaningful.

**Model, latency, cost.** Haiku medium in the background. About $0.009 per session.

**Safety, privacy.** Only alias pairs are kept, never transcripts. The alias shown on the console is player speech, so it must pass the filter.

**Degraded mode.** A co-occurrence rule with no LLM: the alias was said at least twice by a speaker standing in the same room.

**Note.** This gives the most to crews of 3 or more who talk a lot. Pair it with the STT fix (P3).

### 3.4 Second wave (short specs)

- **Vendor, "the Scavenger":**
  - Experience: a black-market trader in the lot on some shifts. Each persona has a weak spot and a trigger (greedy, superstitious, lonely, paranoid). He sells intel whose value comes from code (e.g. the vault callsign of the next site) and cursed items.
  - Mechanics: engine A with price steps between 0.7× and 1.3× of list price. Rapport per player stored in the save.
  - Haiku low, ≤ 2.5 s, $0.004 per session. Text plus mumble.
  - Degraded mode: fixed prices.
  - Owners: G4 + (e).
- **Radio survivor:**
  - Experience: for 1–2 player crews, a trapped survivor on channel 2 gives directions built from facts code supplies. In about 35% of contracts the Listener possesses them and they lie, with tells.
  - Haiku low plus TTS, ≤ 3 s, $0.004 + $0.08 per session.
  - Degraded mode: template lines with true/false slots.
  - Needs objectives (frozen this round).
- **Spirit jar:**
  - Experience: capture a minor entity and question it out loud (the Listener hears you asking). Each answer embeds one fact from code through a placeholder, true or false depending on the entity's temperament.
  - Haiku low, ≤ 2.5 s masked by a static sweep, $0.006 per session plus optional TTS.
  - Degraded mode: phrase-bank answers.
- **Mimic clips:**
  - Opt-in through `consent.mimic`. Keep at most 6 × 2.5 s of the player's own clips in a RAM ring buffer and replay them through the lure radio chain. JEV picks the clip from transcripts. A "VOICE ON LOAN" roster badge shows who opted in.
  - Rules: no cloning; delete on revoke or when the session ends; never replay a clip whose transcript fails the filter.
  - Needs the voice track.
- **Incident reports:** an AI-written 2-line incident report per death, template first, on the results screen. $0.002 per session. Extends ai/review.ts plus G4 results.
- **Contract twists:** the Company calls mid-contract through the existing `phone_ring` phenomenon with a twist from a code catalog; the Listener can fake the call. $0.002 + $0.04 per session.
- **Night Shift FM:** your last contract retold as local news; a text ticker by default; low gameplay value.
- **Director "night arc":** only theme and weights within the director's existing caps; never control spawns.

### 3.5 Platform prerequisites (do these first)

| ID | What | Impact | Effort | Risk | Owner | Verify |
|---|---|---|---|---|---|---|
| P1 | Name filter. New `packages/shared/src/names.ts` (fold + blocked list + reserved names: Listener/Company/HR/Admin/Claude + no impersonating a crewmate via confusable names); blocked names fall back to Contractor-XXX with a notice. Use it at core/crews.ts:80, net/reqs.ts:14 and meta/flow.ts:383, and on visor glyphs. On the output side: `quoteCandidates` (ai/review.ts:37), hotwords (bridge.ts:149), mirror names (E4), `pickQuote` (meta/review.ts:32). | 94/96 evasions blocked (vs 42/96); would have caught tonight's name | S | low (3/72 false positives, same as today) | integrator, ①, G4, (e), E4 | `node --test` built from my probe |
| P2 | Gateway: per-player token buckets in `gate()`, caps per crew, one TTS character budget shared by all routes, `cache_control` on system blocks, a boot warm-up for each new schema (like ai/index.ts:124). | stops one player draining the shared caps; small latency gain | S–M | low | (e) | unit tests; `cache_read_input_tokens` > 0 |
| P3 | STT experiment: keep −0.6 for short low-confidence clips; relax to −1.0 when VAD speech is ≥ 1.2 s and language probability ≥ 0.9, or the text contains a hotword. Optionally cache the language per player. | up to +79% transcripts (58 → 104, upper bound); STT about 2× faster | S | hallucinations | (e)/services | replay fixture WAVs on a test sidecar (never :3100) |
| P4 | Update the disclosure and consent text: generated voices; phone push-to-talk is transcribed in the van; mimic is opt-in. | honesty | S | – | G4 (menus.tsx:365) | – |
| P5 | Red-team list plus replay fixtures for each route; one capped live record run. | catches refusals and injection | S | – | (e) | needs the user's OK, < $0.05 |

### 3.6 First build: change sketch
Every cross-package call goes through PLAN §13. A missing provider becomes a no-op.

| Owner | Changes |
|---|---|
| (e) ai | New `ai/company.ts`, `ai/seance.ts`, `ai/ledger.ts`, `ai/codewords.ts`, each with a mock that doubles as the rule mode. `ai/text.ts`: aliases in `analyze()`, plus a `nameForAi()` helper. `stt/bridge.ts`: hub push-to-talk while a call is active. `messages/ai.ts`: events `ai.call` (ring / line / offer / end), `ai.whisper`, `ai.ledger`; requests `ai.call.say/accept/hangup`, `ai.whisper.send`, `ai.ledger.write`. `ai.json`: caps, timeouts, efforts. Client `apps/client/src/ai/phone.ts`: phone audio chain reused from lure.ts, plus the mumble voice. |
| G4 meta | `meta/deals.ts` (engine + bounds in meta.json); ring and apply in flow.ts; `companyFile` in CrewSave; `meta/api.ts` `dealOpen/dealStep/dealApply`; phone UI `meta/phone.tsx`; console shows DECODED lines; disclosure. |
| G3 interaction | Ledger item, special-find placement, interactable, book UI. |
| G2 monsters | `curse(crew, kind, effect, ms)`, forged whispers, DECODED telegraph. |
| E4 paranormal | Implement `poke`, enable `radio_on`/`dead_poke`, word-list mirror text, filter roster names. |
| G1 players | Dead-player whisper UI (typed in v1). |
| E1 / E5 | Phone station (virtual first); ring, hold, quill and ghost-word sounds. |
| integrator | `names.ts`, the Ledger interactable prefix in `V12_KINDS`, §13 entries, flags `companyLine`, `seance`, `ledger`, `codewords` (default off). |

## 4. Quick wins tonight (software lane, low risk)

1. **Integrator:** add the filter in `cleanName` at core/crews.ts:80. It runs on every join and resume, and the save name follows it (meta/flow.ts attach). Unit test only; deploying it is your call.
2. **E4:** guard `mirrorName` output with the same filter before a roster name is written on a mirror (one line).
3. **G4:** in meta/review.ts:32, skip quotes that contain blocked words; filter visor glyphs in `sanitizeProfile` (flow.ts:383).
4. **G1:** mask hate slurs in `players.chat` before it is emitted (players/index.ts:372).
5. **G4:** add "some voices are AI-generated" to the disclosure (menus.tsx:365).
6. **Requests for the next round, while (e) and net are frozen:** quote and hotword filtering (ai/review.ts:37, bridge.ts:149) and net/reqs.ts:14.
7. **Not for agents:** existing saves and personnel files keep the old name until that player rejoins. A one-off save scrub needs the user's OK.

## 5. Open questions

- How often Haiku 5.5's general_harms classifier refuses Ledger entries and insults in the negotiation. This needs a capped live evaluation, which needs the user's OK.
- Whether the STT drops come from the log-probability cut or the hallucination list. Text isn't logged, by design; a test sidecar with fixture WAVs could answer it.
- The real ElevenLabs Flash credit rate on the Creator plan, and credits remaining (last measured 10/06: 130,749 of 131,000).
- Decisions for the group: whether the Ledger may target teammates; whether the phone may be transcribed in the van; boss voice or mumble.
- Whether tonight's quick disconnects were caused by deaths or by 13–14 fps and the 6–18 s freezes.
- Whether the friends used the browser or the desktop app. Typed input works in both.
- Deal bounds against the quota curve (`quotaStep` 275): needs playtests.

**Scratchpad files** (<scratch>/night\ai-design\):
- name-filter-probe.ts
- name-filter-fold.ts
- negotiation-engine.ts
- cost-model.ts

No repo files were changed, no live AI calls were made, and no servers or browsers were started.