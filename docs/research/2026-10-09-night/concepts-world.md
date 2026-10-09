# DEAD AIR: new concepts for levels, missions, goals and mini-games

This was read-only research. I changed no repo file, started no servers or browsers and made no live AI calls. I wrote one probe script in the scratch folder: `<scratch>/night\concepts-world\probe-site-rules.ts`. It runs made-up English and Dutch phrases through the repo's own transcript analyzer. Player names are withheld: P1 is the host, P2 and P3 are the remote friends.

## 1. Top findings

1. **Every contract is the same mission.** Whatever the board shows, the objective chain is always the same: salvage, twin levers, keypad, then the two-carrier Core, back in the van by 04:00 (`apps/server/src/objectives/contract.ts:1-3`).
   - The only goals that change per order are 2 Company Requests, drawn from 3 kinds (`packages/shared/src/workorder.ts:3`, `apps/server/src/meta/orders.ts:78-81`).
   - Variety today comes from looks (14 themes) and 7 generation modifiers.
   - Mission *types* are the biggest gap. Most concepts below are mission types that plug into one small registry (R0).
2. **Order cards and memos promise rules the game doesn't have.**
   - 11 of the 27 modifier chips are referenced nowhere outside the templates (for example HOUND TERRITORY, FRAGILE LOOT, RADIO HEAVY, LISTENER ACTIVE, DO NOT CLAP). A few more only change looks or sound.
   - 18 of the 24 site memos describe a voice or noise "house rule", for example "rings once whenever someone says a number out loud" (`apps/server/src/meta/templates.ts:53`).
   - Making these real ("Site Rules", #1) is the cheapest high-impact concept. The transcript stream already carries digits, callsigns, names, loudness band, room and hearers (`packages/shared/src/messages/ai.ts:11-63`).
3. **Tonight's live session points to three gaps: early wins, something to do when dead, and meaning that reaches the crew even when the Listener is far away.**
   - Both contracts ended in a wipe after about 5-7 minutes. A wipe sets the haul to 0 by rule (`contract.ts:819-822`).
   - Both deaths were "HOUND heard your VOICE", at 1 m and 6 m.
   - The Listener heard 6 transcripts from the solo host, but **0 of the friends' 55** (the closest speaker was 25.4 m away).
   - The friends met the Snatcher on their very first contract, because the host's solo run had already moved the shift counter to 1 (`apps/server/src/monsters/runtime.ts:132`).
   - P2's client logged one 17.8 s frame that spans P3's death. Both friends disconnected 20 s and 32 s afterwards.
4. **Talking is mostly punished.** Only the lever countdown, the vault code and one of the three request kinds (LURE_IT_WITH_A_LIE) reward speech. The best concepts make speech a resource with a price: Wiretap (#4), Storm Night (#6), Breaker Panel (#7), True Name (#8) and Ouija for the Dead (#3).
5. **Systems that are built but sit idle are cheap fuel for missions.**
   - The paranormal system schedules about 10-13 phenomena per contract, and none of them pays.
   - `receiver` and `lure` gear exist in the catalog but have no item definitions (`packages/shared/src/catalog.ts:18`).
   - The phenomenon kinds `dead_poke`, `radio_on` and `phone_ring` are declared but have no builder (`messages/paranormal.ts:6`, `apps/server/src/paranormal/balance.ts:32`).
   - Curios already include an Ouija planchette, a wax cylinder recording and "Dashcam tape: VAN 3" (`catalog.ts:23-26`).
   - The audio synth already has phone bell, clock chime (1-12 strikes), knock (1-8 hits), music box, radio sweep and pipe groan (`apps/client/src/audio/synth.ts:16`, `audio/api.ts:24-39`).
6. **Design for the friends' machines.** P2 and P3 run the WebGL2 fallback at 13-14 fps, at 0.28-0.63 pixel ratio, with about 130 ms round trip and freezes of 6-18 s. Prefer voice-paced or turn-based mechanics and 2D screens (like the safe dial) over twitch timing and extra render passes. Any new material must go into `render.warmSite()`.
7. **The genre's hits back these picks:**
   - staged extraction points (R.E.P.O.);
   - spotting anomalies (The Exit 8, more than 3 million copies);
   - one player sees, another holds the manual (Keep Talking and Nobody Explodes, We Were Here);
   - cursed objects, photo rewards and "say its name" (Phasmophobia);
   - weather that changes the rules (Lethal Company);
   - rituals that make the monster stronger as you progress (Devour);
   - bluffing tables (Buckshot Roulette, Liar's Bar).
8. **A display-name filter has to come first** for any concept that puts names into the world. Mirror writing already writes roster names (`messages/paranormal.ts:45-49`). Site Rules (name rule), Lost Contractors, Hidden agendas and HR captions would spread a slur further.

## 2. Evidence

### 2.1 What exists today (so the concepts below are new)

| Area | Today | Where |
|---|---|---|
| Mission structure | One fixed chain: salvage, twin levers, keypad/vault, two-carrier Core, van by 04:00 | `objectives/contract.ts:1-3`, `startContract` at :265 |
| Goals that vary | 2 requests from ALL_SURVIVE, EXTRACT_ABOVE, LURE_IT_WITH_A_LIE | `workorder.ts:3`, `orders.ts:78-81` |
| Modifier chips | 27 unique chips. 16 map to generation/look slugs (7 change generation). 11 have no reference outside the templates (MANNEQUINS LIKELY appears once, only to avoid a duplicate chip) | `templates.ts`, `procgen/themes.ts:96-125` |
| Memo house rules (none implemented) | Varga Foundry, numbers ring the bell (:53). Telephone Exchange (:59-60). Kestrel Ferry boarding calls (:72). Fenwick Hall, voices down and no running (:78). Gilded Lantern room service (:47). Our Lady of the Sound, numbers call themselves (:107). Tidewell, plants turn to the speaker (:113). Marrow Lane bus bell (:120). Pellam Courthouse, "I object" (:132). Ironside intercoms call names (:138). Wren's End, do not applaud (:144). Okonkwo, don't count the exhibits (:149). Lindqvist, freeze at the piano (:162). Brightwater echoes (:96) | `apps/server/src/meta/templates.ts` |
| Mini-games | Solo safe dial by ear (`safes/index.ts`). Lockpick is hold E for 5 s with 6 m of noise (`interaction.json`). Searchable containers, van workbench crafting, field-guide pages | |
| Operator | 2D map, security doors, vault code, monster blips within 6 m of a player, SIGNAL SPIKE, intercept log, motion sensors | `meta/console.tsx:1-3` |
| Dead players | Spectate and talk to other dead only; no other actions. Flags `deadStatic` and `radioLeak` are off | `config/flags.json`, `plan-reviews.md:208` |
| Already on ROADMAP (not pitched again here) | Dimmer, Visual Mimic, Static, Tenant, Weeper, Hoarder, Choir, Doppel-Operator, Company terminal, AI dispatcher, Intern, wire splice, pressure valves, terminal hack, arcade | `docs/ROADMAP.md` |

### 2.2 Tonight's session (`theboys-live/logs/server.log`, names withheld)

| | Contract A (P1 solo, WebGPU) | Contract B (P2 + P3, WebGL2 low) |
|---|---|---|
| Start, then first death | 22:39:53, death at 22:46:50 (6 m 57 s) | 22:54:55, death at 23:00:18 (5 m 22 s) |
| Monsters | Hound, Listener (woke at 3:00) | Hound, Listener, **Snatcher**: the friends' first contract, but shift contract index 1 |
| Death | Hound heard VOICE at 1 m | Hound heard VOICE at 6 m |
| What the Listener heard | 6 of 8 transcripts | **0 of 55** (closest speaker 25.4 m) |
| Teamwork moment | none | The Snatcher dropped on P2 at 2:03 and P3 pulled them free (at 78% of the drag) |
| End | wipe, haul 0 | P2 logged one 17.8 s frame ending at 23:00:20.8. Both disconnected 20 s and 32 s after the death. The offline-wipe rule ended the contract at 23:02:08 with haul 0 |

A haul of 0 doesn't mean nothing was deposited: a wipe zeroes it by rule.

### 2.3 Probe results: the transcript stream can already drive site rules

- "de code is vier zeven een negen" and "the code is four seven one nine" both give digits `['4719']`.
- "ik ga naar de ketelruimte" gives the callsign BOILER.
- "who is there", "I object" and "what is inside the parcel" don't count as meaningful, so each rule needs its own phrase list. That is one `norm.includes()` check per rule.
- `withinOneEdit` (`callsign.ts:160`) accepts asch, mor, moore, ren, oral and kel for the syllables ash, moor, wren, orral and kell. It rejects more, rain, coral and call. "vash" matches both "ash" and "vesh", so a name lexicon (#8) must pass the existing `confusable()` check (`callsign.ts:292`).
- `analyze()` takes 21 µs per utterance (measured over 20,000 runs), which is nothing at tonight's 7.6 transcripts a minute.

### 2.4 Genre sources

- **R.E.P.O.**: extraction points are filled one after another ([dotesports](https://dotesports.com/indies/news/how-to-extract-in-r-e-p-o)); 19.6M players in 2025 (`docs/research/game-design.details.md`).
- **Lethal Company**:
  - weather ([Prima](https://primagames.com/tips/lethal-company-all-weather-conditions-explained));
  - the apparatus cuts the facility's power ([Prima](https://primagames.com/gaming/is-the-apparatus-safe-to-remove-in-lethal-company-answered));
  - the Jester's wind-up means evacuate ([KeenGamer](https://www.keengamer.com/articles/guides/how-to-escape-the-jester-in-lethal-company/));
  - radar booster ping and flash ([ProGameGuides](https://progameguides.com/lethal-company/how-to-get-and-use-the-radar-booster-in-lethal-company/));
  - the 9-character signal translator ([Prima](https://primagames.com/tips/how-good-is-signal-translator-in-lethal-company-answered));
  - the Company's bell monster ([Prima](https://primagames.com/tips/what-happens-if-you-ring-the-bell-too-much-in-lethal-company));
  - the Mineshaft interior opens with an elevator ([itemlevel](https://itemlevel.net/lethal-company-mineshaft-complete-guide-new-interior-v60/)).
- **Phasmophobia**:
  - cursed possessions ([Prima](https://primagames.com/news/phasmophobia-cursed-possessions-update-tools));
  - Ouija board questions and costs ([ProGameGuides](https://progameguides.com/phasmophobia/how-to-use-the-ouija-board-phasmophobia/));
  - 7 photo reward types ([Shacknews](https://www.shacknews.com/article/121116/how-to-get-photo-rewards-phasmophobia));
  - saying the ghost's name raises its activity ([Kinetic Games](https://kineticgames.co.uk/blog/phasmophobia-voice-recognition-update)).
- **Content Warning** sponsorships ([Prima](https://primagames.com/gaming/how-to-unlock-and-complete-sponsorships-in-content-warning)).
- **GTFO**: the reactor's REACTOR_VERIFY code, sometimes hidden in terminal logs ([wiki](https://gtfo.wiki.gg/wiki/Reactor_Startup)); team bioscans and sleepers woken by light and noise ([WTMG](https://waytoomany.games/2020/02/05/gtfo-tips-to-survive-the-rundown/)).
- **The Outlast Trials**: generator and fuse objectives ([ProGameGuides](https://progameguides.com/outlast-trials/how-to-complete-kill-the-snitch-program-in-the-outlast-trials-full-walkthrough/)); difficulty modifiers ("variators") and the Invasion mode ([Wikipedia](https://en.wikipedia.org/wiki/The_Outlast_Trials)).
- **Devour**: every ritual item makes the demon faster ([Devour wiki](https://www.shapes.inc/fandom/devour/maps)).
- **Escape the Backrooms**: three breakers, a drain valve, a keypad code ([playnews](https://www.playnews.gg/en/guides/escape-the-backrooms-the-walkthrough-guide-for-levels-4-to-11-terror-hotel-lights-out-thalasso-the-city-in-2026)).
- **Buckshot Roulette** items ([Destructoid](https://www.destructoid.com/all-items-and-uses-in-buckshot-roulette/)) and more than 1M sold ([gamepedia.jp](https://gamepedia.jp/?p=110494)). **Liar's Bar**: 70k Steam players ([GameStar](https://www.gamestar.de/artikel/70000-steam-spieler-liars-bar,3421196.html)).
- **Iron Lung** ([GOG](https://www.gog.com/en/game/iron_lung)). **Inscryption** deathcards ([wiki](https://inscryption.fandom.com/wiki/Deathcard)). **Dredge** ([wiki](https://dredge.wiki.gg/wiki/Sanity)). **Mouthwashing** ([Wikipedia](https://en.wikipedia.org/wiki/Mouthwashing_(video_game))).
- **SCP**: SCP-914 ([SCP wiki](https://scp-wiki.wikidot.com/scp-914)) and the Roblox game 3008 ([Pocket Tactics](https://www.pockettactics.com/roblox/3008)).
- **The Exit 8**: more than 3M copies ([Gematsu](https://www.gematsu.com/2026/09/the-exit-8-sales-top-three-million)). **I'm on Observation Duty** ([itch.io](https://zaster.itch.io/im-on-observation-duty)). **That's Not My Neighbor** ([vaporlens](https://vaporlens.app/app/3431040/thats_not_my_neighbor.md)).
- **Voices of the Void** ([Wikipedia](https://en.wikipedia.org/wiki/Voices_of_the_Void)). **The Mortuary Assistant**: sigils reveal the demon's name ([Wikipedia](https://en.wikipedia.org/wiki/The_Mortuary_Assistant)). **Duskers** ([PC Gamer](https://www.pcgamer.com/uk/duskers-review)).
- **Keep Talking and Nobody Explodes**: modules ([Giant Bomb](https://giantbomb.com/wiki/Games/Keep_Talking_and_Nobody_Explodes)), 97% positive ([raijin](https://raijin.gg/app/341800/Keep_Talking_and_Nobody_Explodes)). **We Were Here** ([TheSixthAxis](https://www.thesixthaxis.com/2023/02/08/we-were-here-forever-review/)).
- **Barotrauma**: active sonar attracts monsters ([wiki](https://www.barotraumagame.com/wiki/Sonar)). **Deep Rock Galactic** mission modifiers and the Haunted Cave warning ([wiki](https://deeprockgalactic.wiki.gg/wiki/Mutator), [wiki](https://deeprockgalactic.wiki.gg/wiki/Haunted)).
- **Pacific Drive** quirks and the 8-guess tinker station ([Siliconera](https://www.siliconera.com/how-to-diagnose-quirks-in-pacific-drive/)). **DOORS** (Roblox): the Figure library ([GamerJournalist](https://gamerjournalist.com/how-to-beat-the-figure-in-roblox-doors/)).
- **Helldivers 2** Major Orders ([GamesRadar](https://gamesradar.com/helldivers-2-major-orders)). **Lockdown Protocol** ([Sportskeeda](https://www.sportskeeda.com/esports/is-worth-playing-lockdown-protocol-2025)). **Murky Divers** ([XboxHub](https://www.thexboxhub.com/murky-divers-sends-you-to-dispose-of-corpses-in-the-deep-sea/)). **Don't Scream** ([Wikipedia](https://en.wikipedia.org/wiki/Don%27t_Scream)).
- **Fatal Frame** camera ([wiki](https://fatalframe.fandom.com/wiki/Camera_Obscura)). **Friday the 13th** escape routes ([GameRevolution](https://www.gamerevolution.com/guides/332375-best-and-worst-ways-to-escape-jason-in-friday-the-13th-the-game)). **Stories Untold**: its Morse puzzle was criticised as hard ([TheSixthAxis](https://www.thesixthaxis.com/2020/01/30/stories-untold-review/)).

## 3. Recommendations

**Effort:** S is about one agent run in one package. M is one package round including tests. L is a round across several packages.

**Owners** follow the v1.2 ownership table in CLAUDE.md. "G7" is a proposed new **missions** package (`apps/*/src/missions/**`, `messages/missions.ts`) that the integrator would need to create. Objectives, net, voice, ai and stt are frozen this round, so changes there go through the integrator as requests.

### 3.0 Two enablers

- **R0. Mission registry.**
  - Add an optional `WorkOrder.mission?: {type, params}` field (integrator, additive).
  - Add a G7 `registerMission(type, {start, tick, onUtterance?, onDeposit?, evaluate})`. Objectives keeps the clock, van and haul, and folds `evaluate()` into the contract result.
  - `makeBoard` (`orders.ts:65`) makes one of the three orders a non-standard mission.
  - Add §13 API lines and new V12_KINDS id prefixes.
  - Effort M. Verify: bots finish each mission type (`tests/bots`).
- **R1. Display-name filter** (G4 plus integrator). Apply a blocklist with normalization at join and in the creator, before names reach nameplates, mirror writing, STT hotwords or AI prompts. Effort S. Verify: unit tests.

### 3.1 The 29 concepts at a glance (★ = top 8)

| # | Concept | Kind | Effort | Owner | Voice hook | Inspired by |
|---|---|---|---|---|---|---|
| 1★ | Site Rules | site gimmick | S→M | E4 + G4 + E5 | your words set off the building | the site memos, Phasmophobia |
| 2★ | Freight Lift | extraction goal | S–M | G3 + E1 (+ objectives) | "hold the lift!" | R.E.P.O. |
| 3★ | Ouija for the Dead | mini-game | M | E4 + G3 | ask the dead yes or no | Phasmophobia Ouija |
| 4★ | Wiretap | mission type | M | G7 + G2 | bait it into speaking | DEAD AIR's own lures |
| 5★ | Claims Adjuster camera | evidence goal | M | G3 + E4 + G4 | "photo or it didn't happen" | Phasmophobia, Content Warning, Fatal Frame |
| 6★ | Storm Night | weather modifier | M | integrator, ① net, G2, E2, E5 | talk during the thunder | Lethal Company weather |
| 7★ | Breaker Panel | objective variant | M | G3 + G4 | talk it through with the manual | Keep Talking, We Were Here |
| 8★ | The True Name | end-of-shift contract | M–L | G7 + E4 + G6 + G2 | say it once, at the altar | Devour, Mortuary Assistant, Phasmophobia |
| 9 | Night Watch | mission type | M–L | G7 + E4 + G4 | "was that there before?" | The Exit 8, Observation Duty |
| 10 | Severance Hearing | meta mini-game | M | G4 | bluff HR | Buckshot Roulette, Liar's Bar |
| 11 | Departments and the Board | Company story | M | G4 | personas and rivalries | Helldivers 2, Mouthwashing, Lobotomy Corp |
| 12 | Lost Contractors | persistence | M | G4 + G3 + G6 | "this is where you died" | Inscryption |
| 13 | Signal work (receiver, Morse, tape) | mini-games | S–M | G3 + E2 + E4 + E5 | pass digits on without being overheard | Voices of the Void, Stories Untold |
| 14 | Console PING and STILLS | operator tools | M | G4 + E1 + E2 | operator callouts | Barotrauma, Iron Lung, FNAF |
| 15 | Switchboard | operator mini-game | M | G4 + E4 + E1 | "patch me through!" | the Telephone Exchange memo |
| 16 | Two-hand tasks | mini-games | S | G3 | whispered timing | Among Us, Keep Talking |
| 17 | Escorts: the Crate and the Survivor | mission type | M / L | G7 + G2 + E4 | soothe it, question them | Maneater, That's Not My Neighbor, Don't Scream |
| 18 | Shifting Building | level gimmick | S–M | E1 + G3 + G4 + E3 | callouts go out of date | SCP-3008 / Roblox 3008, the Halcyon memo |
| 19 | Flood Night | weather and level | M–L | E1 + E3 + G1 + E5 + E2 | "valve's open, go!" | Lethal Company Flooded, Backrooms |
| 20 | Two-floor sites | level | L | E1 + G1 + E3 + ① net | floors you can't hear across | Lethal Company Mineshaft |
| 21 | Curio pitch | van mini-game | S–M | G4 (+ ai) | sell the story | the user's "convince the boss" idea |
| 22 | Hidden agendas | overlay | S / M | G4 + G7 | secret KPIs | Lockdown Protocol, Outlast Trials Invasion |
| 23 | Kill the Signal | mission type | M | G7 + G3 + G2 | the radios are bugged | Devour escalation |
| 24 | Blackout Run | mission type | M | G7 + G3 + G2 | power one wing at a time | GTFO, Backrooms, Dredge |
| 25 | Probation Night | onboarding | S | G4 + G2 | teaches the voice bands | tonight's log |
| 26 | The Refinery | mini-game | M | G5 + G3 + E1 | "set it to fine... cranking" | SCP-914 |
| 27 | Blind Wing | level mini-game | S–M | E2 + E1 + G4 | the operator guides you | Iron Lung, Murky Divers |
| 28 | Van Quirks | van mini-game | S–M | G5 + E4/E5 + G4 | test theories by talking | Pacific Drive |
| 29 | Breakdown | timed event | S–M | G7 + G4 + E1 | split up or stay together under the clock | Friday the 13th |

### 3.2 Top 8

**#1 Site Rules: "the building is listening too"** (★1 · S for 2 rules, M for all 18 · E4 owns the reactions in a new file under `apps/*/src/paranormal/**`; G4 owns the memo and drive rule-card text; E5 the sounds)

- **Pitch.** Each memo already states a house rule. Make it real: check it on the server against the transcript and proximity-text stream, and print it on the drive rule card.
- **How it plays.** One rule per site, built from a few rule types:
  - **Word triggers a sound.** At Varga Foundry, any spoken digit makes the bell strike that many times (`clock_chime` count), with 25 m of noise at the bell hall. The operator can use it on purpose as a distant Hound lure.
  - **Word triggers a lure.** At the Telephone Exchange, saying a callsign makes that room's phone ring for 6 s (`phone_bell`, 25 m). It's a tool for lying to the monsters, and a trap if you name your own room.
  - **Phrase.**
    - Gilded Lantern: someone knocks on the door you're behind; whoever answers "come in" or "who's there" opens it, and the Listener learns that room.
    - Pellam Courthouse: saying "object" cracks a gavel where you stand.
    - Okonkwo: counting three or more digits aloud rattles every exhibit case.
  - **Name** (needs R1). At Ironside, say a teammate's name and the intercom nearest them calls it out 8 s later.
  - **Loudness zone.**
    - Fenwick Hall: shouting or sprinting in a corridor sets off a prefect's whistle at your position (12 m).
    - Wren's End: shouting in the staff hall starts the talent show, which draws the Hound.
  - **Freeze.** At Lindqvist, a piano phrase plays for 10 s; any footstep louder than a crouch during it alerts the Hound.
- **Why it works with voice.** Each site changes what you can safely say. Crews invent code words, which is exactly the counterplay against the Listener, now practised at low stakes. It works even when the Listener is far away (tonight it heard 0 of the friends' 55 transcripts).
- **Fit with existing systems.**
  - `onUtterance` (`apps/server/src/ai/api.ts:36`) delivers normalized text, digits, callsigns, names, band, room and hearers for speech **and** typed proximity text, so players without a mic are included.
  - `emitNoise` (`apps/server/src/players/noise.ts:64`), the existing synth sounds, and `ruleCards` (`templates.ts:253`).
- **Impact.** 18 sites get the mechanic their memo already promises. At 7.6 transcripts a minute, a digit or callsign rule fires several times per contract.
- **Risks.**
  - Transcripts arrive about 1.5 s late (end-of-speech detection plus 50-90 ms STT). Telegraph each reaction with a mechanical wind-up so the delay feels deliberate.
  - False triggers: give each rule its own phrase list and require at least talk-level loudness.
  - Rules make noise or reveal information; they never kill anyone directly.
- **Verify.** `node --test` with synthetic utterances, checking which noises and sounds are emitted. A bot contract using dev-only proximity text. No real-GPU pass.

**#2 Freight Lift: bank loot mid-contract** (★2 · S–M · G3 owns the deposit path, E1 places the lift (a virtual station first), E3 the prop; the wipe-insurance rule needs an objectives change request)

- **Pitch.** R.E.P.O.'s extraction points, DEAD AIR-style: one or two service lifts halfway into the site send loot up to the van without walking it back.
- **How it plays.**
  - Hold E on the call button. The car takes 20 s and clanks every 4 s (12 m), so the Hound comes to look.
  - It carries 2 carry-units. Sending it clanks at 15 m.
  - The Company keeps a 20% handling fee. Loot sent up still counts at 50% after a wipe.
  - Lifts lock at the 03:00 blackout unless that zone has power. The Core never fits.
- **Why it works with voice.** "Hold the lift!": one player guards the corridor, one holds the button.
- **Fit.** `depositLoot`, `onDeposit`, `lootTotal` and `vanValue` (`interaction/api.ts:156-177`), `registerInteractables` (:99), and the wipe rule at `contract.ts:819-822`.
- **Impact.** Both contracts tonight wiped and their hauls were zeroed. Insured freight turns a wipe into a partial result and gives a first-five-minutes win.
- **Risks.** It weakens the walk-back-to-the-van tension. The fee, capacity, noise and blackout lock counter that; tune with bots.
- **Verify.** A bot banks 2 items, then wipes: `result.hauled` should equal 0.5 × 0.8 × the banked value. A unit test for the clank schedule. No real-GPU pass.

**#3 Ouija for the Dead: give the dead something to do** (★3 · M · E4 owns the knock and flicker builders and `dead_poke`; G3 the dead players' actions and the spirit-board item; E5 sounds)

- **Pitch.** The living can't hear the dead, so give the dead a séance toolkit (knocks, flickers, a planchette) and let the Listener use it too.
- **How it plays.** While following a living teammate, a dead player can:
  - **Knock** 1-3 times on the nearest door or wall (8 s cooldown, 4 m of noise). The Hound hears it as static; `hound.ts:42` already has a label for that noise.
  - **Flicker** the light of the room they're watching (20 s cooldown).
  - **Move the planchette.** On a spirit board (the existing Ouija planchette curio) that a living player is holding E on, slide it over YES, NO, letters and digits. The dead get a 2D board; each glyph takes 1.2 s; the planchette scrapes at 3 m.
  - The Listener can move the planchette too, but only to spell callsigns and names it has actually heard. The tell: its glyphs glow red on the van console.
- **Why it works with voice.** "Knock once if the Hound is in DOCK." And the paranoia of not knowing whether it's your friend or the monster.
- **Fit.** The paranormal knock builder (`apps/server/src/paranormal/kinds.ts`), the declared `dead_poke` kind, the brownout and fixture API (PLAN §13), the spectator follow-cam. No AI.
- **Impact.** The dead currently have nothing to do but watch and talk to each other. An early death can mean about 10 minutes of watching, and tonight the friends left within 32 s of the second death.
- **Risks.** Knock spam (cooldowns plus a budget per death). Information is powerful, so the dead only see what their spectator camera shows, and the board is slow.
- **Verify.** Unit tests for the cooldowns and for the Listener only spelling heard words. A two-browser SwiftShader e2e through the GPU guard (one dead, one alive): the knock reaches the living and the Hound reacts. No real-GPU pass.

**#4 Wiretap: Research wants its voice on tape** (★4 · M · G7 missions; G2 for raising lure odds near the recorder; the AI route is used through its API as-is)

- **Pitch.** A contract that flips the rule: you need the Listener to talk.
- **How it plays.**
  - Start the Company reel-to-reel recorder in a room.
  - Get the Listener to deliver a lure within 6 m of it. Its lures are built from what it overheard, so you feed it: name that room on an open channel, say a teammate's name nearby.
  - Collect the recorder (the Listener is now right next to it) and bring it to the van. Bonus goal: "get it to say BOILER".
  - The results screen plays the recording back.
- **Why it works with voice.** Scripted bait conversations. The LURE_IT_WITH_A_LIE request grown into a whole mission, and the playback is the clip people will share.
- **Fit.**
  - `speakLure` (`ai/api.ts:72`) already writes the line from overheard words, generates the audio, caches it under `<ASSETS_DIR>/dist/vo-gen` and plays it from walkies or intercoms (`ai/lure.ts:510`).
  - The lure request check in `contract.ts:900-947` and the Listener's decision events.
- **Impact.** A whole contract where talking is the goal, where today only one request kind rewards it. No new AI cost: it stays inside the existing 40 lures per session and 3,000 TTS characters.
- **Risks.** Lures come at most every 60-75 s, so the running recorder should raise the odds. With AI off, the template line or the garbled clip still counts.
- **Verify.** In mock AI mode, a bot forces a lure next to the recorder: the objective completes and the results include the clip URL. No real-GPU pass.

**#5 Claims Adjuster camera: photo evidence pays** (★5 · M · G3 owns the item; E4 scores phenomena via `paranormal/api.ts`; G4 the contact sheet and stats; G2 the monster checks)

- **Pitch.** The Company insures haunted buildings. Proof of phenomena and monsters is scrip.
- **How it plays.**
  - 12 exposures. Left click is a flash photo that counts as light for 2 s, like the flashbulb: it freezes the Mannequin, makes the Listener flinch and pops at 6 m. Right click takes a photo without flash, which needs light.
  - The server scores each shot from its own state, never from the client's image: an active phenomenon in the frame with line of sight, a monster, a body, a curio still in place.
  - Bounties: footprints 10, poltergeist 20, mirror writing 30, silhouette or presence 40 (these often show to only one player), Hound 40, Mannequin 60, Snatcher 80, Listener 120.
  - The results screen shows a contact sheet.
- **Why it works with voice.** "Get the camera, it's behind you, don't turn around."
- **Fit.** `phenomena()` and `onPhenomenon` with witnesses (`paranormal/api.ts:19-57`), the per-player `to` field on phenomena, the monster sight checks (15 m, 110°), the flashbulb balance (14 m, 25°, 6 m of noise).
- **Impact.** About 10-13 phenomena per contract by the paranormal system's own schedule (first at 40 s, then gaps of 75 s shrinking to 28 s, ×1.6 in calm phases, 12% skipped). None pays today.
- **Risks.**
  - Performance: copy the frame that was just drawn, or render one 256×144 shot per press. Never add a per-frame cost.
  - Timing of reading back a WebGPU canvas is unverified.
  - Each phenomenon pays once.
- **Verify.** Unit tests for the scorer. SwiftShader e2e for the camera HUD and contact sheet. One real-GPU check of the capture timing.

**#6 Storm Night: weather that changes who can hear** (★6 · M · integrator-led: ① net `aud.ts` (frozen, request), G2 monster hearing, E2 lightning, E5 thunder, E4 scheduling, G4 chips and rule cards)

- **Pitch.** Lethal Company's weather, applied to the 1:1 rule: if a friend can't hear you, neither can it.
- **How it plays.**
  - Every 45-90 s, lightning shows through windows and doorways for 1-3 s, then a 2.5 s thunder roll multiplies every voice and footstep radius by 0.25, for players and monsters alike.
  - The MACHINE NOISE chip becomes real: radii ×0.6 inside running machine rooms. ECHOES: ×1.3 in tiled rooms.
  - A subway variant: a train every 3 minutes masks voices for 6 s and kills anyone on the tracks.
- **Why it works with voice.** "Wait for the thunder... NOW: four, seven, one, nine!" It's the clearest possible safe-to-talk mechanic, and it teaches the 1:1 rule by contrast.
- **Fit.** The chips and slugs (`themes.ts:96-125`), server-timed events, the render brownout. The multiplier must live in the one distance function that both voice gating and monster hearing use.
- **Impact.** 10-20 safe-talk windows per contract, aimed at PLAN §9's "crew goes silent" risk and tonight's two voice deaths.
- **Risks.** It touches the audibility contract. Send the multiplier per cell in the snapshot and apply it in both places on the same tick. Lightning must respect the reduce-flicker setting.
- **Verify.** A unit test that voice gating and monster hearing see the same multiplier on the same tick. A fake-mic e2e like gate G2b: talking 8 m from the Hound during thunder causes no alert. A real-GPU pass for how the lightning looks.

**#7 Breaker Panel: talk it through** (★7 · M · G3 as a self-contained module like safes; G4 the console manual; objectives change request so "panel powered" counts as power)

- **Pitch.** The field player sees the panel; only the van has the manual.
- **How it plays.**
  - At Risk 2, or on half the orders, the twin levers are replaced by 2-3 junction panels. Each has 4-6 wires or fuses with a colour, a stripe and a plate code.
  - The console shows a seeded if-then manual. The field player describes what they see, the operator decides what to cut.
  - A wrong cut sparks (12 m of noise) and costs 20 s.
  - Solo players get a slower manual at the panel.
- **Why it works with voice.** Keep Talking's proven loop. Describing is wordy, so crews learn to be terse and to whisper, and every callsign or number they say feeds the Listener and the site rules.
- **Fit.** The safes module is the template: the server sends only outcomes, and the UI is a Preact screen (`safes/index.ts`, `safes/dial.tsx`). Plus the console canvas and `setPower` (`interaction/api.ts:199`).
- **Impact.** The operator gets an essential job from the first minute (the review in `plan-reviews.md` flagged the operator as idle early on). It also adds a second power structure.
- **Risks.** Colour-blind players: use stripes, symbols and printed names. Difficulty tiers by risk.
- **Verify.** A 1,000-seed test that every panel is solvable. A bot solves it with a dev-only peek. SwiftShader e2e. No real-GPU pass.

**#8 The True Name: the end-of-shift contract** (★8 · M–L · G7 missions, E4 for the mirror fragment, G6 for the lore fragment, G2 for the hunt; STT hotwords are frozen, so request them)

- **Pitch.** The third contract of a shift is an exorcism. Find the entity's name in three pieces, then say it once, at the altar. Say it anywhere else and it comes for you.
- **How it plays.**
  - The name is three syllables from a fixed lexicon with English and Dutch forms, and every pair passes `confusable()`.
  - Fragments turn up in mirror writing, on a lore board, and through the spirit board (#3) or the receiver (#13).
  - At the altar, two players hold candles while one says the whole name. Players without a mic can type it, or write it in the Ledger, a slow, two-handed book (the user's "Death Note" idea).
  - Saying all three syllables in one breath outside the altar room makes the Listener hunt you.
  - If it overhears two fragments, one syllable changes and a mirror writes the new one.
  - Success banishes the Listener for the rest of the contract and pays a quota-sized bonus.
- **Why it works with voice.** Speaking is both how you win and the main danger. Crews spell it out, whisper and use code ("the tree one, then the bird").
- **Fit.** Mirror writing already renders words (`messages/paranormal.ts:43-49`), plus lore spots, `normalizeUtterance` and `withinOneEdit` (the probe shows they're forgiving but need a lexicon that can't be confused).
- **Impact.** Gives each shift an arc; today the third contract only differs because the Mannequin joins.
- **Risks.** Speech recognition on invented words: use real-word syllables, match per syllable, keep the typed path. Make it harder with the syllable-change twist.
- **Verify.** Matcher tests with 20 transcript variants per syllable. SAPI WAVs of the lexicon sent to the STT sidecar's HTTP API (allowed in tests). No real-GPU pass.

### 3.3 The other 21

**#9 Night Watch** (M–L · G7 + E4 + G4)
- **Play.** A low-loot "audit" contract. The paranormal system leaves persistent anomalies (a moved prop, an extra object, a door left open, a dead light). The operator flips through camera stills (#14) while the field crew patrols. Reports go in at the console, by voice ("ARCHIVE, moved object") or from a menu: a correct report pays, a wrong one costs scrip.
- **Variant, "The Loop".** A corridor repeats until the crew correctly calls anomaly or no anomaly five times in a row, as in The Exit 8 (3M+ copies).
- **Voice.** Memory arguments ("was that chair there before?"); reports spoken in the field are callsigns the Listener hears.
- **Risks.** Anomalies must be big enough to read on WebGL2 at 0.28 pixel ratio.
- **Verify.** Unit tests on report scoring. A real-GPU pass for how readable the anomalies are.

**#10 Severance Hearing** (M · G4)
- **Play.** When the crew misses the quota, HR calls in on the van speakerphone instead of firing them straight away.
  - A stamp press holds 6 forms: the mix is announced, the order is hidden. On your turn, stamp yourself or HR.
  - Items: Coffee (+1 chance), Magnifier (peek), Shredder (the next stamp counts double), Paperclip (HR skips a turn), Clerical Error (flip the current form).
  - Winning gives the crew one probation contract at a reduced quota.
- **Voice.** Table talk and bluffing in the sealed van, where it's safe to talk. Buckshot Roulette sold more than 1M copies.
- **Fit.** The shift end in `meta/flow.ts` and the termination templates. It stays PG-13: stamps, not guns.
- **Verify.** Unit tests on the game state machine.

**#11 Departments and the Board** (M · G4, plus a request to the AI track for the brief prompts)
- **Play.** Each order is issued by a department with its own head: Accounts, Liability, Research, Facilities, HR.
  - Each department has a standing of 0-5 that unlocks perks: Research 3 gives an 18-exposure camera, Facilities 2 cuts the lift fee to 10%, Liability 3 gives one free badge revive per shift.
  - The Board posts a weekly Directive, like Helldivers 2's Major Orders ("Extract 5 Cores"), paid in cosmetics and lore.
  - Workplace posters in the style of Mouthwashing, and a running mystery: what was VAN 3 carrying?
- **Fit.** `makeBoard`, the templates, and the briefs. Put the persona bible in the cached prompt prefix; Haiku 5.5 briefs cost $0.0016-0.0039.
- **Verify.** Unit tests on standing. Ship template-only first.

**#12 Lost Contractors** (M · G4 + G3 + G6 + E1)
- **Play.** Each death is saved with its site, room, cause and suit. The 24 sites come back around; when a crew draws that site again, the remains are there with the badge and part of the dropped gear. Bringing the badge home pays a bereavement bonus and adds a "✎" margin note to the field guide. Later, the Visual Mimic can wear a remembered suit.
- **Voice.** "This is where you died last week."
- **Risks.** Store the death-card text, never transcripts. Needs R1.
- **Verify.** Save round-trip tests.

**#13 Signal work** (S–M each · G3 + E2/E4 + E5 + G4)
- **Receiver.** The catalog's unused `receiver` becomes a tuning dial built on the safe-dial pattern (the server only reports signal strength). Stations:
  - a numbers station reading two vault digits;
  - the Listener's current memory note as garbled words;
  - the dead crew's static.
  - Its speaker carries 4 m, so the Listener can learn the digits too.
- **Morse.** One light blinks two digits in Morse; the watcher calls the longs and shorts, and the operator decodes them with a chart on the console.
- **Tape.** The Cassette tape salvage and the "Dashcam tape: VAN 3" curio play in the van. Reversed or at half speed they reveal a voice (prebaked at build time), and a spectrogram on the console shows two digits drawn into the audio.
- **Risks.** Morse is hard, so use two digits, play them slowly and always show the chart.
- **Verify.** Unit tests. SwiftShader e2e for the dial.

**#14 Console PING and STILLS** (M · G4 + E1 + E2 + G3)
- **PING**, after Barotrauma's active sonar: show every moving thing within 15 m of a sensor or crewmate for 2 s, at the cost of a 10 m ping that the Hound investigates.
- **STILLS**, after Iron Lung and FNAF: 3-4 fixed cameras. Each camera's background is rendered once during loading at 160×120, and live silhouettes from server state are drawn over it, with no live render at all.
- Doors, pings and stills draw from one 100-unit van battery that refills slowly.
- **Verify.** Unit tests. A real-GPU look at the stills only.

**#15 Switchboard** (comms sites · M · G4 + E4 + E1)
- **Play.** Pick up a wall phone to call the van. The operator has 6 s to patch the jack on a 2D switchboard; unanswered calls ring out at 25 m. One unlabeled line "only listens": patch it and the Listener hears the van cab for 5 s.
- **Voice.** "Patch me through!", and deliberate lies on a line you know is bugged.
- **Fit.** The Telephone Exchange history and the unused `phone_ring` kind.

**#16 Two-hand tasks** (S each · G3)
- **Duo lockpick.** With a partner holding tension, there are 3 pins; for each, the partner must release within ±400 ms of the picker's "now". The server judges the intervals, so 130 ms latency is fine. It takes 3 s and makes 2 m of noise; a solo pick stays 5 s and 6 m.
- **Cross-coupled valves.** The ROADMAP's pressure valves made concrete: valve A moves the gauge in room B and vice versa, so each player reads the other's numbers aloud.
- **Risks.** Use generous windows and never exact frames.

**#17 Escorts** (Crate M, Survivor L · G7 + G2 + E4)
- **The Crate.** A two-carrier crate that only stays asleep while it hears soft speech within 3 m at least every 20 s. Silence or a shout wakes it, and it shrieks at 35 m (Lethal Company's Maneater meets Don't Scream).
- **The Survivor.** VAN 3's last contractor knocks from behind a door, while two intercoms claim to be them. Question them; the real one answers in knocks (That's Not My Neighbor). Then escort them out; they panic in the dark.
- **Risks.** NPC pathfinding.

**#18 The Shifting Building** (S for doors, M for stencils · E1 + G3 + G4 + E3)
- **Play.** At 00:00 and 02:00 the building groans and rearranges: 3-5 doors swap between open and sealed, and two rooms swap their callsigns. Only the console map is up to date, and the Listener's memory of the old layout goes stale too.
- **Voice.** "BOILER is where CHAPEL was."
- **Verify.** Check every swap with the level validator so keycard paths stay reachable.

**#19 Flood Night** (M–L · E1 + E3 + G1 + E5 + E2)
- **Play.** Low rooms flood over the night. Wading is 0.7× speed and 1.5× footstep noise. Drain valves (#16) clear sections, and the vault floods at 03:00, so the Core becomes a race.
- **Risks.** Use flat dark water planes. Needs a real-GPU visual pass.

**#20 Two-floor sites** (L · E1 + G1 + E3 + ① net)
- **Play.** Two regions of one grid joined by a lift shaft, using the crawl-vent transition. Sound only crosses through the shaft, so the radio becomes essential, and the director can stall the lift. Mine or basement themes.
- **Risks.** The generator's invariants and the frozen layout-identity fixtures (gate L1).

**#21 Curio pitch** (S–M · G4, plus a new AI route by request)
- **Play.** Pitch each curio's history to the van's antiques desk in 20 s. Code counts how many of the 3 facts planted in that site's lore you mention, for ×0.8-1.6 value. Haiku only writes the one-line reaction (about $0.0007 a call, with a template fallback).
- Shares infrastructure with the user's "convince the boss on prices" idea.

**#22 Hidden agendas** (S for KPIs, M for the Auditor · G4 + G7)
- **Play.** Each player gets a secret KPI ("carry the Core out", "get a teammate to say 'synergy' on the radio"), revealed at results.
- **Opt-in Audit Night.** One player is the Company Auditor: they win if the haul ends below target and nobody names them in the van vote.
- **Risks.** KPIs never require harming a teammate. Needs R1.

**#23 Kill the Signal** (M · G7 + G3 + G2)
- **Play.** At comms sites, 3 relays forward every walkie call to the Listener (the `radioLeak` flag, turned on for this order). Sabotaging each one (hold E 6 s, 15 m sparks) makes the radios safer and the Listener angrier: lure cooldown 20 s shorter, hunt speed +10%.
- **Voice.** Until the relays fall, the crew is pushed onto proximity voice and whispers.

**#24 Blackout Run** (M · G7/objectives + G3 + G2)
- **Play.** The site starts without power. Each wing's power task is different: levers, the #7 panel, or a fuse fetch. A generator restart can ask for a verification word that is written on a terminal elsewhere in the wing (GTFO's REACTOR_VERIFY).
- Powering a wing lights it and wakes its monster. Unpowered wings hold "aberrant" salvage worth 2×, which whispers like the cursed idol (Dredge's night catches).
- **Fit.** Each room already has a power zone (`layout.ts`), and `setPower` exists (`interaction/api.ts:199`).

**#25 Probation Night** (S · G4 + G2, plus an objectives request)
- **Play.** A crew's first contract, or any contract where half the crew has never finished one: a small site, only the Hound and a dormant Listener, a lift near the entrance, an insured haul, and 3 teaching requests.
- **Evidence.** Tonight's friends got three monsters on their first contract (`runtime.ts:132`).

**#26 The Refinery** (M · G5 + G3 + E1)
- **Play.** An SCP-914 machine: the intake booth is in one room, the dial in another with no line of sight. Settings run Rough, Coarse, 1:1, Fine, Very Fine; cranking clatters at 20 m. Outputs come from a seeded table, for example 3 small salvage becomes 1 medium.
- **Voice.** "Set it to fine... cranking!"
- **Risks.** Cap the output per contract.

**#27 Blind Wing** (S–M · E2 + E1 + G4)
- **Play.** One smoke-filled or dead-flashlight wing at Risk 2. The field player only gets a compass, and the operator talks them to a curio over walkies the Listener can overhear.
- **Risks.** Use height fog on the Low preset. Needs a real-GPU visual pass.

**#28 Van Quirks** (S–M · G5 + E4/E5 + G4)
- **Play.** The van picks up a quirk, for example "the horn honks when someone says Core", which is harmless in the hub but draws the Hound in the lot. Diagnose it at the workbench with Pacific Drive's four-column guess (8 tries), testing theories by talking in the safe van.

**#29 Breakdown** (S–M · G7 + G4 + E1)
- **Play.** At 03:30 the van won't start. The crew needs two of: a battery, a Jerrycan (existing salvage), or the driver's keys. Or they use the payphone plus a fuse to call a second van to the far gate (Friday the 13th's escape routes).
- **Risks.** Guarantee the parts are near the entrance, and only use it on some orders.

## 4. Quick wins doable tonight (software lane, low risk, no GPU)

1. **Probation-lite balance change** (G2). In `config/balance/monsters.json`, set `snatcher.minContractIndex` from 1 to 2. It takes effect after a `server:restart` in the van. Verify: start a contract at index 1 and check `monsterPositions` has no Snatcher.
2. **Site Rules v0 for two sites**, behind a new default-off flag, using only public APIs (`onUtterance`, `emitNoise`, `sfx.synth`):
   - Varga Foundry: a spoken digit makes the bell strike that many times.
   - Telephone Exchange: a spoken callsign makes that room's phone ring.
   - Verify with `node --test` and synthetic utterances.
3. **Make four dead chips real** with balance overlays scoped to the order: HOUND TERRITORY adds a Hound; LISTENER ACTIVE cuts the dormant time from 180 to 90 s; FRAGILE LOOT raises the fragile chance from 0.22 to 0.5; HEAVY SALVAGE raises the heavy share 1.5×. Needs one hook where objectives and monsters read `order.modifiers` (integrator). Verify with bot contracts.
4. **Two talk-positive Company Requests:** SAY_WORD_NEAR_LISTENER (met when an utterance the Listener heard contains the chosen word) and LURE_HOUND_WITH_BOTTLE ×2. Additive request kinds (integrator) plus template text (G4). Verify with unit tests.
5. **Dead knock v0** (E4). A `dead_poke` builder: 1 or 2 knocks on the door nearest the teammate being watched, 8 s cooldown, 4 m of static noise. Verify with a unit test and a two-bot test.

## 5. Open questions (not established)

- Whether P2 and P3 used the browser or the desktop app, and whether they left because of the freeze, the death or the time. A thumbs up/down on the results screen would tell.
- Whether this group wants insured hauls (#2, #25), or whether "a wipe means 0" is part of the fun.
- Real speech-recognition accuracy on rule phrases, invented syllables and accents (English and Dutch). I didn't run STT; this needs SAPI WAV tests.
- Reading back a WebGPU canvas for photos (#5) needs one real-GPU check.
- Who owns the new G7 missions package, and which round unfreezes objectives and net (needed for #2, #6, #7, #8).
- Privacy: #12 should store death-card text only. #21 sends the pitch transcript to Claude, so check the current consent covers it.
- Whether this group has the appetite for social deduction (#22's Auditor).
- Overlap with the AI concepts brief: the boss-negotiation idea maps to #21, the Death Note to #8's Ledger, and talking vendors to #11 and #15.