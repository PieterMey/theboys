# Concepts: monsters and interactions for DEAD AIR

I changed no repo files. I started no servers, browsers, worktrees or live AI calls; I only ran CPU scripts in my scratchpad. Players are P1 (the host), P2 and P3, as in the brief.

## 1. Top findings

1. **The Listener, the signature AI monster, never heard the friends.**
   - In tonight's 2-player contract it heard 0 of 55 transcripts. The closest any speaker got was 25.4 m.
   - In both contracts it woke at 3:00 with 0 lines in memory (server.log 22:42:53 and 22:57:55), so the "it understood you" moment never happened.
   - Cause: it spawns in the deepest 30% of the map (facility.ts:670, `d >= 0.7`) and stands still while dormant (listener.ts:1122-1127).
   - Simulation over 120 layouts: route talk reaches the dormant Listener 0.0-0.3% of the time before it wakes. 2-3 "Earwigs" on the route raise that to 48-76%. Existing intercoms reach 1.5-5.8% and vent grates 0.8-1.6%.
2. **The Hound did all of tonight's killing, and both deaths read "heard your VOICE"** (P1 at 1 m, P3 at 6 m). The game currently teaches players to stay silent, which PLAN §9 names as its top risk. The roster below is built around talk-positive counterplay: lie to ears and tape recorders, whisper to the Weeper, take turns for the Choir, roll-call the Extra.
3. **The telegraphed attack plus teammate rescue loop works.** The Snatcher stalked P2 after 37 s alone, dropped on them, and P3 pulled them out of the duct at 78% (22:56:55-22:57:14). The new grab-type monsters (Visitor, Squatter, Drain) reuse this pattern: warn first, knockdown first, teammate rescue.
4. **Real crews are 1-2 players on low-end PCs.**
   - Tonight's contracts had 1 and 2 players. Both friends ran WebGL2 at the Low preset, at 13-14 fps.
   - On Low, mirrors don't reflect live (mirrors.ts:37 `live: 0`) and volumetric fog is off (presets.ts:23).
   - All six top monsters work with 1-2 players (three even solo) and rely on audio, decals or emissive glow rather than costly effects. Ideas that need mirrors or fog are ranked lower and come with fallbacks.
5. **Server CPU is not the constraint; ownership is.**
   - Measured: a 35 m sound flood p95 ≤0.10 ms, a 160 m walk field p95 ≤0.31 ms, A* p95 ≤0.31 ms. Ten extra hearing agents cost under 1 ms of the 33 ms tick.
   - Every transcript already reaches the monsters track with position, band and hearers (stt/bridge.ts:409 → monsters/index.ts:86-111). Transcript-driven monsters fit entirely in G2's code.
   - Only designs that relocate or replay voices touch frozen tracks (voice, stt).
6. **Two crafted items are designed but missing.**
   - "Noise lures" and "Field receiver" have recipes (crafting.json:18,24) and pool slots (catalog.ts:18,35).
   - Neither has an ITEM_DEFS entry (interactables.ts:75-109), so the bench hides them (crafting.ts:98-105). The live log shows "15/17 recipes offered".
   - Each maps onto one of the top-6 interactions, at small effort.
7. **The dead have nothing to do.**
   - `paranormal.poke` (knock, brownout, write) is a stub (paranormal/index.ts:160-161). `deadStatic` has a noise kind (players/noise.ts:11) but nothing emits it.
   - Both contracts wiped, and the last survivor, P2, disconnected 19 s after P3 died (23:00:18 → 23:00:37).
8. **Names are a live hazard.** There is no name filter, and paranormal mirror writing already puts a lone player's roster name on mirrors as lasting residue (kinds.ts:208-209). Any name-driven monster has to wait for a name gate.
9. **AI stays cheap** (logs/ai-usage.jsonl):
   - a Haiku 5.5 Listener decision costs $0.00018 (p50 1.86 s, n=4);
   - a lure line costs $0.000125;
   - a JEV director pick costs $0.00002 (p50 286 ms, n=88).

   The AI-voiced designs below come to $0.01-0.04 per contract, mostly ElevenLabs. The lure TTS budget is 3000 chars per 12 h (ai.json:47,63), so new voiced monsters need their own budget.

## 2. Evidence

### 2.1 Tonight's live session (server.log, read-only)

| time | event |
|---|---|
| 22:39:53 | Contract 1 starts: risk 1, P1 alone; Hound + Listener |
| 22:42:53 | Listener wakes with 0 lines in memory |
| 22:46:50 | Hound kills P1, "VOICE (1 m)". STT: 24 segments → 8 transcripts (15 empty). Listener heard 6. Loudest band SCREAM. |
| 22:54:55 | Contract 2 starts: risk 1, P2 + P3; Hound + Listener + Snatcher |
| 22:56:55-22:57:14 | Snatcher stalks P2 (alone 37 s) and drops; P3 rescues P2 at 78% |
| 22:57:55 | Listener wakes with 0 lines in memory |
| 22:58:57 | Snatcher stalks P2 again (alone 8 s) |
| 23:00:18 | Hound kills P3, "VOICE (6 m)" |
| 23:00:37 | P2, alive and alone, disconnects |
| 23:02:08 | Wipe. STT: 120 segments → 55 transcripts (58 empty, 7 dropped). Listener heard 0; closest speaker 25.4 m. |

- **Speech time** (from STT chunk counts, 100 ms each):

  | player | speech | contract length | share of contract |
  |---|---|---|---|
  | P2 | 172.8 s | 433 s | 40% |
  | P3 | 150.9 s | 433 s | 35% |
  | P1 | 44.1 s | 417 s | 11% |

  If P2 and P3 spoke independently, they'd overlap about 14% of the time, roughly 60 s per contract. That figure anchors the Choir's tuning.
- **Transcript yield:** STT produced text for 63 of 144 segments (44%), so word-based monsters must fall back to loudness.

### 2.2 Measurements (scripts in the scratchpad)

**Primitive costs** (bench-hearing.ts, 300 samples per size, risk 2):

| players | map | spaces | doors | vents | intercoms | hiding spots |
|---|---|---|---|---|---|---|
| 2 | 40×42 m | 29 | 46 | 4 | 2 | 18 |
| 4 | 54×52 m | 42 | 66 | 6 | 2 | 25 |
| 6 | 64×60 m | 55 | 78 | 6 | 2 | 32 |

| operation | p95 |
|---|---|
| sound flood, 10 m | 0.022-0.029 ms |
| sound flood, 25 m | 0.050-0.053 ms |
| sound flood, 35 m | 0.083-0.102 ms |
| walk field, 160 m | 0.14-0.31 ms |
| A* | 0.18-0.31 ms |

**Coverage simulation** (sim-earwig*.ts, sim-intercom.ts, sim-vent.ts):
- 60 seeds each at 2 and 4 players, risk 1.
- Speech is sampled every 3 m along the shortest route: entrance → lever A → lever B → keypad → Core (86 m at 2 players, 109 m at 4).
- Talk radius is 10 m of path, with doors in their initial state. "Pre-wake" means the first 40% of the route.

| what can hear the talk | pre-wake (2p / 4p) | whole route (2p / 4p) |
|---|---|---|
| Dormant Listener at its spawn (today) | 0.3% / 0.0% | 4.4% / 2.6% (shouts: 26.8% / 14.3%) |
| Existing intercoms (2-3) | 5.8% / 1.5% | 3-17% |
| Vent grates (4-6) | 0.8% / 1.6% | 6.7% / 4.9% |
| 2 ears placed on the route, ≥10 m apart, depth 0.1-0.7 | 65.1% / 48.3% | 58.0% / 47.2% |
| 3 route ears | 75.7% / 69.1% | 65.4% / 60.0% |
| 4 route ears | 77.4% / 76.3% | 66.7% / 66.9% |
| Ears only in named rooms on the route (about 2 exist) | 20-23% | 21-23% (whispers: 7-9%) |

Real crews detour for loot, so these figures are upper bounds. Gains flatten after 3 ears.

### 2.3 Code facts the designs rely on

**Listener lifecycle**
- Spawn rules: runtime.ts:103-138. Wake time: runtime.ts:121.
- The wake acts on memory: listener.ts:635-647. A forced decision with no lines falls back to patrol: listener.ts:500.

**Hearing and transcripts**
- Voice becomes noise every 0.15 s: runtime.ts:308-339. Noise is flooded and the perceived doorway found: runtime.ts:375-414 and geo.ts:71-111.
- Every transcript is published: stt/bridge.ts:409. The monsters' `heard()` returns early when there is no Listener: monsters/index.ts:86-90.
- STT decides who heard what from the Listener's position and the band radius: stt/bridge.ts:210-218.
- A per-receiver snapshot hook may change `aud` distances: core/snapshot.ts:20-31.

**Fairness precedents**
- Hound warns first: hound.ts:67-96.
- Listener knockdown and solo grab: listener.ts:666-715. Listener notice: listener.ts:1043-1062.
- Snatcher never takes a solo player: snatcher.ts:186.
- Door slam stuns the Listener: listener.ts:796-825.
- Monsters open only `door` and `fire` doors: geo.ts:125-130.

**Client hooks**
- A visor's glow only switches between dead and alive: avatars.ts:539.
- VoiceService exposes only the local player's band: core/services.ts:38-42.
- Battery drain is client-side: interaction/index.ts:710.
- Flashlight cut-off is counted per reason; G2 already writes 'knockdown' (PLAN §13).

**Cheap existing effects**
- E2 render: brownout, failSpace, fog volumes, puff, beamInterference (render/api.ts:45-61). The mirror handle has `ghost`, `setFog` and `setCrack` (render/api.ts:20-35).
- E5 synth sounds: knock (wood/metal/locker), phone_bell, music_box, radio_sweep, tv_static, clock_chime, pipe_groan, wet_step, glass_crack (audio/api.ts:12-22).
- 31 of the 64 ElevenLabs SFX clips are used (sfx-manifest budget).

**Reserved tell channels**
- Paranormal effects never use strobe, walkies, intercoms, vents, ceiling scratching, the scrape loop, breath or whisper (kinds.ts:3).
- Breath is the Listener's retreat cue (audio/api.ts:10-11).

**Other constraints**
- Monster bodies are variants of the UAL rig and cast shadows (models.ts:1-7, :184), so every extra skinned body costs a pass per shadowed light.
- The flags `mimic`, `radioLeak` and `deadStatic` exist and are off (flags.json:9-13). The consent fields `{transcribe, mimic}` exist (core/types.ts:29).
- Each new monster type touches files owned by others:
  - the MonsterKind list (integrator, state.ts:18);
  - interactable id prefixes (integrator, catalog.ts:51-58);
  - the field guide's monster order (G6, content.ts:19);
  - the drive screen's rule cards (G4, drive.tsx:1);
  - the client cue-to-sound map (G2, monsters/index.ts:80-98).
- There is no physics engine. Rapier is only pulled in by @types/three (package-lock.json:2184), and RapierPhysics is banned. Props would be scripted, like the bottle arcs.

### 2.4 Genre research (mechanics borrowed; fandom wikis returned HTTP 402)

**Lethal Company**
- Bracken retreats when looked at.
- Butler attacks players who are alone.
- Snare Flea drops from the ceiling and muffles your voice.
- Ghost Girl is visible only to the player she haunts.
- Nutcracker detects movement.
- Maneater is calmed by rocking it.
- The boombox lures, spray paint marks walls, the radar booster pings and flashes.

Sources: https://www.thegamer.com/lethal-company-all-monsters-how-to-avoid-deal-with/ , https://www.thegamer.com/lethal-company-ghost-girl-survival-tips/ , https://www.thegamer.com/lethal-company-every-equipment-explained/

**Phasmophobia**
- Yokai: talking near it raises its attack chance.
- Raiju is drawn to electronics; Mare thrives in the dark.
- Onryo: blown-out flames trigger hunts.
- Dayan feeds on nearby movement.
- Monkey Paw grants spoken wishes; the Ouija board answers spoken questions.

Sources: https://www.pcgamesn.com/phasmophobia/ghost-types-all , https://www.keengamer.com/articles/guides/phasmophobia-all-cursed-possessions-guide-locations-effects-and-downsides/

**R.E.P.O.**
- Huntsman is blind and hears talking.
- Robe enrages if you look at its face.
- Hidden carries players off; teammates grab them back.
- Reaper opens doors, and closing doors resets it.

Source: https://www.gfinityesports.com/article/repo-all-monsters-and-best-strategies-against-them

**Content Warning**
- Snatcho is weak to light.
- The Bell traps a player until teammates solve a captcha.

Source: https://www.dexerto.com/gaming/all-content-warning-monsters-how-to-escape-them-2624155/

**GTFO**
- Sleepers wake on light, noise and movement.
- Glowsticks don't wake them, and crouching is the quietest way past.
- C-foam reinforces doors.

Sources: https://gtfo.wiki.gg/wiki/Enemies , https://gtfo.wiki.gg/wiki/Doors

**SCP** (mechanics only; the text is CC BY-SA 3.0)
- SCP-939 mimics victims' voices and is held back by light.
- SCP-096 is triggered by seeing its face.
- SCP-106 moves through walls.

Sources: https://scp-wiki.wikidot.com/scp-939 , /scp-096 , /scp-106

**Dead by Daylight**
- Crouching avoids the Hag's traps.
- Ghost Face is revealed when looked at.
- The Dredge moves through lockers and brings darkness.
- The Onryo travels through TVs.
- The Doctor causes illusions.

Sources: https://deadbydaylight.wiki.gg/wiki/The_Hag , https://dotesports.com/general/news/all-dredge-perks-and-abilities-in-dead-by-daylight-explained , https://deadbydaylight.wiki.gg/wiki/TV , https://deadbydaylight.wiki.gg/wiki/Madness

**Alien: Isolation**
- A director that knows where you are steers a monster that has to find you itself.
- A menace gauge sends the alien into the vents for a break.
- New behaviours unlock over time, such as checking lockers.

Source: https://www.gamedeveloper.com/design/the-perfect-organism-the-ai-of-alien-isolation

**Other references**
- **MIMESIS:** an AI mimic of teammates; over 2M copies sold. https://worthplaying.com/article/2026/7/13/news/150426-mimesis-sells-more-than-two-million-early-access-copies/
- **YAPYAP:** voice-cast spells; 500k copies in the first week. https://en.wikipedia.org/wiki/Yapyap
- **Don't Scream:** screaming restarts the game. https://mp1st.com/news/dont-scream-is-a-90s-camcorder-horror-game-that-needs-a-microphone-to-play-if-you-scream-the-game-restarts/
- **Iron Lung:** blind navigation by sensors and sound. https://www.gog.com/en/game/iron_lung
- **Amnesia: The Bunker:** barricades, and generator light against a beast that hunts by noise. https://www.superjumpmagazine.com/amnesia-the-bunker-takes-two-scary-steps-forward
- **The Mimic (Roblox):** I couldn't find detailed mechanics. https://brightchamps.com/blog/the-mimic-roblox/
- **ElevenLabs Flash:** about $0.05 per 1K characters (third-party source). https://techjacksolutions.com/ai-tools/elevenlabs/elevenlabs-pricing/

## 3. Recommendations

**Effort**
- S = up to half a day for one track, under 300 lines plus tests.
- M = 1-2 days, including client work and one request to another track.
- L = 3+ days, or needs a frozen track or several owners.

**What every new monster type also needs:** a MonsterKind entry (integrator), a flag and balance section, a field guide page (G6), and a drive card plus death-card text (G4).

**Verification lanes**
- U = node unit test.
- B = ws-bot test using `dbg.monsters.*`.
- S = SwiftShader screenshot through gpu-guard.
- A = headless test with 2 browsers and fake microphones, through gpu-guard.
- G = real-GPU look pass, done by the integrator with the user's OK.

### 3.1 Systemic

**R1. Wildcard slot**
- From the second contract on, add at most one "wildcard" monster per contract on top of the core roster.
- Pick it with a seeded random draw, weighted by theme, crew size and monsters this crew hasn't met yet. A 4th drive card and a field guide bulletin announce it.
- Theme weighting:

  | theme | wildcard monsters |
  |---|---|
  | hospital | Weeper, Reflection, Night Shift |
  | waterworks, baths, laundry | Drain |
  | records, comms | Earwig, Name-Eater, Static, Doppel-Operator |
  | parish | Choir |
  | hospitality | Visitor, Tenant |
  | cold_storage | Night Shift, Dimmer |
  | industry, transport, greenhouse | Moth |
  | retail | Extra |

- Effort S-M; owners G2 and G4. Verify with U (same seed gives the same pick).

**R2. "It learns" (as in Alien: Isolation)**
- Count habits per shift (meta recordStat) and unlock one monster behaviour per habit:
  - 6 or more locker hides: lockers get searched with probability 0.6 instead of 0.35.
  - 8 or more bottles thrown: the Hound checks where the thrower last stood.
  - 2 or more lures followed: the Listener lures that player first.
- The HR memo mentions each unlock.
- Effort S each; owners G2 and G4. Verify with U.

**R3. Name gate (prerequisite for any name-based design)**
- One `safeDisplayName()` with a block-list that falls back to an alias like "CONTRACTOR-7".
- Use it for nameplates, AI prompts, TTS, mirror writing (kinds.ts:208-209) and the name-based monsters.
- Effort S; integrator, then E4 and the AI track. Verify with U.

**R4. A registry of tells, so warnings don't clash**
- **One shared grammar:** a knock, growl, chord or click always means "go quiet". Each monster warns before its first attack, and that first attack is a knockdown, not a kill.
- **Cheap bodies:** at most one skinned body per new monster, with tells that still work on Low.
- **Proposed tells:**

  | monster | tell |
  |---|---|
  | Choir | chord |
  | Visitor | three slow knocks plus a shadow under the door |
  | Static | white walkie light (the Listener's is red) |
  | Earwig | wet tick |
  | Weeper | sobbing |
  | Moth | wingbeats |
  | Dimmer | flashlight stutter plus frost |
  | Squatter | knocks back from inside a locker |
  | Extra | visor doesn't pulse when it "talks" |
  | Name-Eater | glyph flicker plus chime |
  | Drain | pipe groan |
  | Reflection | mirror crack |

- **Reserved sounds:** never use breath or whisper.
- **Coordination with E4:** pause E4's harmless knocks while a Visitor is in play, and reuse E4's dark_walk as the Dimmer's trail.
- Owners G2, E4 and E5; effort S.

### 3.2 Monsters (19; TOP-1 to TOP-6 first)

**TOP-1 The Earwig (the Listener's ears)**
- **Effort / owner:** M (the server side is S). G2; the integrator adds an `ear` id prefix so ears can be crushed.
- **Behaviour:**
  - Fleshy ears grow on walls along the route the crew must take (entrance → levers → keypad → Core), placed for maximum coverage at depth 0.1-0.7.
  - Ears sit at least 10 m apart and never in the lobby, van or vault.
  - Count: 2 for up to 2 players, 3 for 3-4, 4 for 5-6. The director may grow up to 2 more near the crew during quiet phases.
  - An ear hears exactly what a teammate standing there would, and passes transcripts and loudness to the Listener, even while it's dormant.
  - The Listener only learns "voices near the ARCHIVE ear", never the speaker's exact position.
- **Tells:**
  - A wet sheen, and the ear twitches toward voices.
  - A wet tick (audible 4 m) each time it relays.
  - The console intercept line names the ear's room.
- **Counterplay:**
  - Whisper (3 m radius).
  - Keep a flashlight on it: a lit ear is deaf for 6 s.
  - Crush it: hold E for 1.2 s, which makes a 4 m squelch.
  - Feed it a lie, which makes the LURE_IT_WITH_A_LIE request something you can set up on purpose.
- **Solo vs crew:** a solo player faces 2 ears and keeps the Listener's softer solo grab rules.
- **Talk / panic:** one player recites a fake plan to the ear while pinging the real one.
- **AI:** nothing new; it feeds the existing brain. 30 extra decisions per contract cost under $0.01.
- **Fit:** server:
  - Store `L.ears[]` inside ListenerAgent, so no new monster type is needed.
  - Add a branch in monsters/index.ts `heard()`: one sound flood per utterance (≤0.1 ms), then check each ear.
  - Loudness goes through voiceNoise (runtime.ts:332-338).

  Client:
  - A `monsters.ears` event.
  - A small static mesh in the Listener's wet-skin material.
  - 1-2 SFX.
- **Impact:** route talk the Listener hears before waking goes from 0.0-0.3% to 48-76%.
- **Risk:** the Listener gets too well informed. Start with 2 ears, keep "lit = deaf", and log "heard N lines (M via ears)".
- **Verify:** U (an utterance at an ear lands in memory with the ear's room); B (deaf and crush); S; G is optional.

**TOP-2 The Choir**
- **Effort / owner:** M. G2, with E5 for a chord synth or one 8 s ElevenLabs loop.
- **Behaviour:**
  - Three hooded shapes sleep in a hall or chapel.
  - Crosstalk wakes them: two or more living players above a whisper, within 12 m (by path) of each other, talking in the same 0.15 s sample.
  - Each second of overlap adds 0.1 "harmony" (shouting counts double). Harmony fades by 0.05 per second.
  - At 0.35 the Choir hums and turns. At 0.6 it drifts toward the last overlap at 1.6 m/s.
  - At 1.0, within 8 m, it sings for 3 s:
    - the room browns out;
    - flashlights within 10 m stutter;
    - everyone who was overlapping is knocked down for 2 s;
    - a 25 m noise baits the Hound.
  - At risk 2 or higher, a second song within 90 s kills the loudest overlapper. Afterwards it backs off for 45 s.
- **Tells:**
  - A positional chord (30 m) that swells with harmony, plus a faint non-positional chord only the overlappers hear.
  - An "OVERLAP" flash on the HUD meter.
  - The console shows the Choir's harmony level.
- **Counterplay:** "over"-style turn-taking or whispering. The radio doesn't count for the Choir, but the Listener hears it. Spreading out past 12 m invites the Snatcher.
- **Solo vs crew:** inactive solo; best with 3-6 players.
- **Talk / panic:** "ONE AT A TIME!" A single speaker is never punished.
- **AI:** none. It uses loudness bands only, so it still works for players who opted out of transcription and for the 56% of segments STT left empty.
- **Fit:**
  - Overlap detection goes in voiceNoise (runtime.ts:308-339).
  - It reuses the Listener's knockdown path and the E2 brownout and beam effects.
  - Three figures in fixed poses, with no skinning.
- **Impact:** about 14% natural overlap for two talkative players. Only sustained crosstalk (over 25-30% across 20 s) should reach the drift threshold.
- **Risk:** players don't see the rule. The HUD cue and the telemetry (quick win 5) come first.
- **Verify:** U (synthetic band traces); A (two overlapping fake-mic recordings); S.

**TOP-3 The Ventriloquist**
- **Effort / owner:** M-L. G2, plus a request to the frozen voice track for `voice.setAnchor(pid, pos|null)`.
- **Behaviour:**
  - A thin ceiling-crawler (an upside-down variant of the Snatcher rig) stalks a lone player from 2-4 m, clicking.
  - It warns first: the clicks, and the victim's visor flickers. Then, after 2 s within 3 m, it takes their voice for 25 s.
  - The victim's live proximity voice now plays from its body as it crawls (3 m/s) toward the teammates or the Hound. Monsters hear the voice there too.
  - It drops on the first teammate who comes within 2 m: a knockdown, or a kill at risk 2+ if that teammate is alone.
  - Flashing it, hitting it or finding it ends the effect early.
- **Tells:**
  - The victim's HUD says "your voice is elsewhere" and their own voice sounds muffled to them.
  - The displaced voice has a faint comb filter.
  - Clicking at the monster's position.
  - The victim's visor doesn't light up when they talk.
- **Counterplay:** confirm by sight, use pings and emotes, flashbulb or crowbar it. The victim's words are still true; only the direction lies.
- **Solo vs crew:** inactive solo; once per contract, at least 60 s between steals.
- **Talk / panic:** "I'm right HERE!" coming from the wrong corridor. No shipped game I found relocates a live voice; other games replay recordings.
- **AI:** none. Nothing is recorded, so no consent gate.
- **Fit:**
  - The 1:1 hearing distance is recomputed from the monster through the per-receiver snapshot hook that can change `aud` (core/snapshot.ts:20-31).
  - The noise origin is overridden in voiceNoise.
  - Only the client panner anchor needs the frozen voice track.
- **Impact:** the most clip-worthy minute in the game.
- **Risk:** confusion; keep it rare and well telegraphed.
- **Verify:** U (the `aud` override); A (the voice moves with the anchor).

**TOP-4 The Weeper**
- **Effort / owner:** S-M. G2, with G3's giveItem and a crying loop.
- **Behaviour:**
  - A sobbing, faceless former employee sits in a dark room at depth 0.3-0.7. Keep it an adult, for PG-13.
  - Soothe meter: rises 0.25 per second while a player within 2.2 m whispers, or stays silent and crouched, with no light on it. At 1.0 it gives a reward and fades:
    - a curio;
    - a keycard;
    - or one vault digit, whispered and checked by the server.
  - Upset meter. When it reaches 1.0:
    - a 1.2 s scream: 25 m noise that baits the Hound, and nearby flashlights stutter;
    - then a 5 s charge at the offender at 6.5 m/s: knockdown at risk 1, kill at risk 2+.

    | what upsets it | rate |
    |---|---|
    | flashlight on it | +0.5/s |
    | talking within 6 m | +0.35/s |
    | shouting within 25 m | +0.6/s |
    | sprinting within 5 m | +0.3/s |
    | room light switched on | fills it instantly |

- **Tells:** sobbing audible from 15 m, rising in pitch as it gets upset; humming as it calms down.
- **Counterplay:** light off, crouch, whisper. One person comforts it while the others wait outside in silence.
- **Solo vs crew:** solo-friendly. In a crew, the danger is the friend who talks.
- **Talk / panic:** whispered "light… off…" until someone says "IS THAT A PERSON?" and the scream brings the Hound.
- **AI:** optional. Comforting words in English or Dutch double the soothe rate.
- **Fit:**
  - A static agent that checks bands, flashlight cones (as litAt does) and light switches.
  - One posed mesh.
  - No breath or whisper SFX.
- **Impact:** a counterweight to tonight's two VOICE deaths: whispering becomes a skill that pays off.
- **Risk:** low.
- **Verify:** U, B, S.

**TOP-5 The Extra**
- **Effort / owner:** M-L. G2, plus a request to G1 for `players.avatarFor(profile)`.
- **Behaviour:**
  - It appears at risk 2+ or from the third contract, with 2+ players. After a brownout in the crew's room, one more contractor stands 6-10 m behind the group.
  - It wears a living or freshly dead crewmate's suit, with one glyph wrong.
  - It follows at 5-9 m (the Listener's stalk logic at listener.ts:1276-1300), copies stance and emotes, and pretends to loot when watched.
  - It only attacks a player who is alone with it and turns their back within 3 m. It warns first, and the first attack is a knockdown.
  - If it's within 6 m of the van when the leave lever is pulled, it "clocks out" with 20% of the haul.
  - Once identified, it shrieks, dissolves into static and drops a curio.
- **Tells:**
  - It casts no flashlight beam (or a beam with no shadow).
  - Its visor stays dark while it seems to talk.
  - It never uses a walkie, and its steps make no sound.
  - The console's monster blip within 6 m of the crew lets the operator count it.
- **Counterplay:** call "sound off" (interaction TOP-5), take the operator's head count, or flash it.
- **Solo vs crew:** inactive solo.
- **Talk / panic:** "How many of us are there?" MIMESIS showed the demand; in DEAD AIR the check is your voice.
- **AI:** none.
- **Impact:** the strongest paranoia for crews of 3-6.
- **Risk:** depends on G1's avatar code.
- **Verify:** U (follow distance and the van rule); S.

**TOP-6 The Visitor**
- **Effort / owner:** M. G2, with G3 (holding doors), E5 (knock sound), E3 (handle rattle) and E4 (pausing its knocks).
- **Behaviour:**
  - It lives on the far side of closed doors, moving only through empty spaces out of everyone's sight.
  - It picks a closed hand or fire door with a living player 2-10 m beyond it, knocks three slow knocks, and casts a shadow in the gap under the door.
  - It then waits 8-12 s:
    - Open the door and it lunges (its knock was the warning): knockdown, or a kill at risk 2+.
    - Talk above a whisper within 5 m and it forces the door: the handle rattles and the door creeps open over 3 s unless someone holds it. One holder struggles; two holders win.
    - Stay quiet and it walks away.
- **Tells:** the knocks, the shadow, the rattling handle, a cold puff of breath-fog.
- **Counterplay:** don't open it, don't answer, hold the door, listen at it, wedge it, or go round.
- **Solo vs crew:** solo-safe; holding the door alone is tuned to be winnable.
- **Talk / panic:** "DON'T answer it". Someone always says "who's there?"
- **AI:** optional "It's me. Open up." through the door, using a name only if it passed the name gate; about $0.004 per line.
- **Fit:**
  - Doors use setDoorOpen (interaction api.ts:21) and the onDoor hook (ext.ts:72-75).
  - The shadow is a floor decal, so it works on Low.
  - Pause E4's knocks (kinds.ts:384) while a Visitor is in play.
- **Impact:** turns the 46-78 doors per site into decisions.
- **Risk:** door-state edge cases.
- **Verify:** U, B, S.

**Other monsters** (shorter entries, same fields)

7. **The Echo** (replays recorded clips, with consent)
   - **Effort / owner:** M. G2, plus the frozen STT track (keep clips of up to 2.5 s in RAM only for players who opted in to `mimic`), plus E5.
   - **Behaviour:** a crawling "mouth" plays a teammate's real recent clips as proximity audio from dark spots 10-25 m away, leading the crew toward the Hound or vent grates. It flees light.
   - **Tells:** the clips are slightly detuned and never answer questions; no visor pulse.
   - **Counterplay:** passphrases, and checking for a pulsing visor.
   - **Solo vs crew:** inactive solo.
   - **AI:** an optional Haiku pick of the clip, about $0.0002.
   - **Fit:** the flag `mimic` already exists.
   - **Risk:** privacy (RAM only, opt-in).
   - **Verify:** U, A.
8. **The Dimmer**
   - **Effort / owner:** M. G2, with E2's beam interference and G1's flashlight cut-off.
   - **Behaviour:**
     - It moves only through unlit cells (litAt) at 2.2 m/s.
     - Within 6 m it eats light and leaves frost. Within 1.2 m in the dark it grabs: knockdown first, then a kill at risk 2+.
     - A flashlight held on it for 1.5 s, a flare or a light switch sends it away for 20 s.
   - **Counterplay:** power, switches, flares, a dedicated light-bearer.
   - **Solo vs crew:** works solo.
   - **Talk / panic:** battery management.
   - **Fit:** it conflicts with the Mannequin (which needs light), so never pair it with the Moth.
   - **Risk:** derivative, but cheap.
   - **Verify:** U, S, G.
9. **The Static**
   - **Effort / owner:** S-M. G2 (+G3 to remove and return the walkie).
   - **Behaviour:**
     - It charges from walkie push-to-talk seconds over the last 60 s.
     - From 15 s a minute, every walkie hisses. At 25 s a minute, it stands 2 m behind the last speaker for 8 s.
     - Transmit again then and you're knocked down and lose your walkie, which turns up in a random room.
   - **Tells:** a white walkie light (the Listener's is red); carrier level on the console.
   - **Counterplay:** short messages, one radio lead.
   - **Solo vs crew:** inactive solo.
   - **Fit:** audio only, so no render cost.
   - **Risk:** it blurs the Listener's claim on radios.
   - **Verify:** U, B.
10. **The Squatter**
    - **Effort / owner:** S-M. G2 + G3 (a pre-hide veto and a "knock on locker" tap).
    - **Behaviour:** it lives in hiding spots and hops locker to locker every 20-40 s. Hiding in its locker gets you grabbed; standing still next to it for 5 s also does.
    - **Tells:** fogged slats; it knocks back when you knock (the locker knock sound exists).
    - **Counterplay:** knock before hiding, shine a light through the slats, or have two players hold the locker shut to trap it.
    - **Talk / panic:** "it KNOCKED BACK."
    - **Fit:** stops locker-camping, as in Alien: Isolation.
    - **Verify:** U, B.
11. **The Night Shift** (the previous crew)
    - **Effort / owner:** M. G2 (+G4 for past-death suits).
    - **Behaviour:** 3-6 slumped contractors from an earlier crew, including your own deaths from this shift. They wake on:
      - a flashlight in the face for 1 s within 8 m;
      - talking within 6 m;
      - footsteps within 3 m.

      Woken, they shamble at 2.4 m/s and grab.
    - **Reward:** their badges pay a bounty.
    - **Counterplay:** lights off (glowsticks are safe), crouch, whisper.
    - **Fit:** keep sleeping bodies as static meshes and animate at most 3 at once. Don't use breath as a tell.
    - **Verify:** U, S, G.
12. **The Name-Eater**
    - **Effort / owner:** S-M. G2; needs the name gate (R3) first.
    - **Behaviour:**
      - Each time a roster name shows up in a transcript (brain.ts:32-51), that player gets a mark (up to 3; one fades every 90 s).
      - At 3 marks it hunts them for 25 s, warning first.
    - **Tells:** the named player's glyphs flicker and a chime plays.
    - **Counterplay:** code names, decoy names.
    - **Solo vs crew:** inactive solo.
    - **Risk:** how well STT recognises names is unmeasured.
13. **The Moth**
    - **Effort / owner:** S-M. G2 (+G1's flashlight cut-off).
    - **Behaviour:**
      - It senses flashlight beams (light on plus facing, 15 m, line of sight) and flies to the source at 5 m/s.
      - Contact "dusts" you: light off for 10 s. A second contact within 60 s knocks you down.
      - A burning flare holds it in orbit for the flare's full 60 s.
    - **Talk / panic:** "LIGHTS OFF!", the opposite of the Mannequin.
    - **Fit:** two quads with a dust shader; the cheapest body on this list.
    - **Verify:** U, S.
14. **The Tenant**
    - **Effort / owner:** S. G2.
    - **Behaviour:**
      - One named room shows as OCCUPIED, and its loot is worth 2.5×.
      - Take loot out and the Tenant follows whoever holds it at 3.2 m/s, without ever losing track.
      - Contact is a knockdown, and it takes the item back. Loot deposited in the van makes it wait at the door.
    - **Counterplay:** pass the loot between players, use security doors.
    - **Verify:** U, B.
15. **The Throng**
    - **Effort / owner:** S. G2 (on Low, a vignette replaces the fog).
    - **Behaviour:** if 3+ living players stay within 4 m of each other for 18 s, a pulse knocks them all down for 2 s, kills their flashlights for 6 s, blows the room's lights and makes a 25 m noise.
    - **Solo vs crew:** only with 4+ players. It rewards pairs over one big blob.
    - **Verify:** U.
16. **The Doppel-Operator**
    - **Effort / owner:** M. G2 + the frozen AI track (an operator-voice variant of the lure pipeline) + G4 + G3.
    - **Behaviour:** when the van console has been unattended for 60 s, it sends operator-style walkie lines every 60-90 s, built from what the Listener heard, mixing truth and lies. It really toggles security doors.
    - **Tells:** no push-to-talk click; it never uses your code words.
    - **Counterplay:** keep someone on the console.
    - **Solo vs crew:** inactive solo.
    - **AI:** about 8 lines per contract ≈ $0.03.
17. **The Auditor**
    - **Effort / owner:** M. G2 + the frozen AI track + G4. This overlaps with the AI/NPC research.
    - **Behaviour:** if nothing is deposited for 3 in-game hours, a slow 2.5 m/s auditor hunts the lowest earner.
    - **Counterplay:** give an excuse over the intercom within 10 s.
    - **AI:** Haiku scores the excuse from 1 to 5 (structured output, taunt guard). A 3 or better sends it away for 60 s; anything lower docks 5% of the haul. About $0.004 per audit.
18. **The Drain**
    - **Effort / owner:** M. G2 + E1 (floor-drain spots).
    - **Behaviour:** through the pipe network it hears footsteps on wet floors, then surfaces at the nearest drain and drags you, reusing the Snatcher's drag-and-rescue code (snatcher.ts:241-425).
    - **Tells:** a pipe groan (the synth exists).
    - **Counterplay:** crouch on wet tiles.
    - **Solo vs crew:** never snatches a solo player.
19. **The Reflection**
    - **Effort / owner:** M. G2 + E2/E4.
    - **Behaviour:**
      - A lone player watching a mirror sees their reflection lag behind. Keep looking for 2 s and it steps out and knocks them down.
      - That player then has no reflection for the rest of the contract, a lasting tell.
      - Two players in the same mirror are safe.
    - **Fit:** on Low (no live mirrors), use fog and a crack instead.
    - **Verify:** needs G.

### 3.3 Interactions (14; TOP-1 to TOP-6 first)

**TOP-1 Tape recorder: "record a lie"**
- **Effort / owner:** M. G3 for the item, G2 to feed monsters.
- **What:**
  - Hold LMB and it captures your next utterance as text, loudness band and duration from the public `onUtterance` stream. No raw audio is involved.
  - Place it or throw it with a 0, 10 or 20 s delay, or let a teammate trigger it with E.
  - On playback, monsters hear a voice noise of the original loudness, the Listener gets a "heard" line placed in the recorder's room, and clients hear a tape hiss.
  - Players who opted out of transcription record loudness only.
- **Why:** remote lies, which work against the Listener and the Hound alike.
- **Fit:** G2 already subscribes to item events (monsters/index.ts:193-201).
- **Verify:** U, B.

**TOP-2 Dead-crew poltergeist kit**
- **Effort / owner:** S-M. E4 implements `paranormal.poke`; G3 adds the spectator UI and the dead-static emitter.
- **What:** dead players get three actions:
  - KNOCK near their camera: 8 m, every 12 s.
  - FLICKER the room they watch: every 20 s.
  - STATIC through a living player's walkie within 15 m: a 6 m noise that can bait the Hound, every 20 s.
- **Why:** both contracts wiped, and the survivor quit 19 s after their teammate died. The dead can see monsters, so they become scouts.
- **Fit:** the request already exists (messages/paranormal.ts:37) and the knock builder exists (kinds.ts:384).
- **Verify:** U, B.

**TOP-3 Barricades and door holds**
- **Effort / owner:** M. G3 and G2 (+E1/E3 for movable furniture).
- **What:**
  - A wedge jams a hand door. The Listener needs 3 loud seconds to break through (heard 15 m away); the Hound and Mannequin can't open it at all.
  - Furniture can be dragged into a doorway.
  - Hold E against a monster pushing a door: two holders always win.
- **Fit:** extends the existing door-slam stun; monsterCanOpen (geo.ts:125-130) checks the jam.
- **Risk:** soft-locks, so any wedge clears in 1 s from either side.
- **Verify:** U, B.

**TOP-4 Noise lures**
- **Effort / owner:** S. G3 adds the item; G2 makes the Hound treat it like a bottle (hound.ts:134).
- **What:**
  - Throw it, or set a 5, 10 or 20 s timer. It rattles three times over 8 s (12 m).
  - The Hound goes for it, the Listener investigates, the Weeper gets upset, the Choir ignores it.
- **Fit:** the hidden recipe goes live automatically.
- **Verify:** U, B.

**TOP-5 Visor speech light and "Sound off"**
- **Effort / owner:** S. G1, plus a read-only `voice.bandOf(pid)` from the frozen voice track (or the band added to the snapshot by the integrator).
- **What:**
  - Every visor glows with its owner's voice (avatars.ts:539).
  - The T key "Sound off" shows nameplates over every visor that's glowing.
- **Why:** gives "trust only voices you can see" a visual check against the Extra, the Echo, the Ventriloquist and the Listener's lures.
- **Verify:** S, A.

**TOP-6 Field receiver and ear-to-door**
- **Effort / owner:** S. G3 adds the item; G2 multiplies cue radii.
- **What:**
  - Each charge gives 6 s of listening: monster cues within 30 m (by path) are audible at 2.5× range through a radio filter. The cost is that your own hearing is muffled meanwhile.
  - Holding E on a closed door for 1 s lets you hear the next room.
- **Why:** scouting, and the counter to the Visitor, the Squatter and the Night Shift.
- **Verify:** U, A.

**Other interactions**

| # | Interaction | What it does | Effort | Owner |
|---|---|---|---|---|
| 7 | Chalk glyphs | Mark walls with your glyph; marks show on the console. Silent communication. | S-M | G3, E2/E3 |
| 8 | Can-line tripwires | Cans across a doorway rattle (8 m) when crossed and blip the console. | S-M | G3, G2 |
| 9 | Hiding variants | Under desks or gurneys (low cover exists in cover.ts), morgue body bags (searched at p 0.35), a two-person wardrobe. | M | E1, G3, G2 |
| 10 | Scripted physics props | Rolling carts, rolling canisters as moving lures, toppled shelves (20 m crash). Kinematic, no physics engine. | M-L | G3, E1/E3 |
| 11 | The Confessional (chapel) | Confess aloud and an AI priest voice gives one true clue. The confession enters the Listener's memory and the HR memo. Haiku + TTS ≈ $0.004 per use, 2 per contract. | M | frozen AI track, G3 |
| 12 | The Ledger ("Death Note", made safe) | Write a room name to send a monster there for 30 s, but your own name is marked too. A monster's true name, hidden in AI-written notes, banishes it for 90 s once. Players' names can never be used. | M | G3, G2, AI brief placeholder |
| 13 | Radio leak to monsters | Turn `radioLeak` on and add the monster-side noise at receiving walkies (0.6× radius, G2). Loud operator calls give the field team away; a dropped walkie becomes bait. | S (monster side) | G2, G3 |
| 14 | Breaker panels | One per power zone: wing-wide lights on or off for Moth, Dimmer and Mannequin trade-offs. | S | G3 |

## 4. Quick wins doable tonight (software only, low risk, behind flags)

1. **Make the Listener's wake moment land** (G2, S)
   - If it has heard no meaningful line by wake time, stay dormant until its first one, or for 90 s more at most.
   - Log at contract end: "heard N lines (M before waking), nearest speaker D m".
   - Verify: U, B.
2. **Earwig server slice** (G2, S-M, flag `earwigs` off by default)
   - Route placement, relaying, "lit = deaf", the tick cue, the `monsters.ears` event, a placeholder blob.
   - Crushing waits for the integrator's id prefix.
   - Verify: U (at least 45% route coverage with 2 ears); S.
3. **Ship the noise lure and field receiver items** (G3, S each, plus one line for the Hound in G2). The two hidden recipes go live on their own. Verify: U, B.
4. **Dead pokes: knock and flicker** (E4, S-M). Verify: U.
5. **Telemetry for tuning** (G2, tiny). Per contract, counts only:
   - overlap seconds for pairs within 12 m;
   - walkie push-to-talk seconds;
   - Listener lines before and after waking;
   - nearest speaker distance.

   This sizes the Choir, the Static and the Earwig.
6. **Name gate** (integrator + E4, S). Covers nameplates, AI prompts and mirror writing (kinds.ts:208-209). Verify: U.
7. **Visor speech light** (G1, S). Needs the voice owner's OK for a read-only `bandOf`. Verify: S.

## 5. Open questions

- Walkie use, player positions and crosstalk aren't logged; the telemetry only has fps. My Choir, Static and Earwig numbers are estimates until quick win 5 lands.
- Did players consent to `mimic`? The Echo needs it, and the flag is off. All three players did produce transcripts.
- How well does STT recognise roster names? This matters for the Name-Eater and is unmeasured.
- Will the voice owner accept `setAnchor` and `bandOf` this round? The Ventriloquist and the visor light depend on them.
- Do the UAL animation clips include seated or slumped poses for the Weeper and the Night Shift? I didn't check.
- The project facts say ElevenLabs runs only at build time, but ai/lure.ts generates voice lines at runtime: flag `listenerVoice`, with 4 cached files in .assets/dist/vo-gen. Please confirm the policy before adding voiced monsters (Doppel-Operator, the Visitor's line, Auditor, Confessional).
- Both Hound deaths came from the second-noise-after-growl rule. Whether players learned that lesson in the kennel tutorial is a G2 balance question outside this brief.

Scratch files (read-only scripts and results) are in <scratch>/night\concepts-monsters\:
- bench-hearing.ts
- sim-earwig.ts
- sim-earwig2.ts
- sim-intercom.ts
- sim-vent.ts