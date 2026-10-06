# Playtest findings (5 scenarios)

## AREA: ai (2)
- [LOW] STT sidecar unreachable during the run (Listener falls back to loudness-only)  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Watch the dev server log while players talk.
  observed: '[stt] WARN STT sidecar not reachable at http://127.0.0.1:3100 (start it with npm run stt); voice stays loudness-only until it is', twice (19:33:44, 19:42:11).
  expected: Sidecar up for the live session (the host should check it before 20:45).
  evidence: tests/playtest/first-run/server.log lines 42 and 52
  files: apps/server/src/stt
- [LOW] Server event-loop stalls up to ~0.55-0.6 s under host load; STT health check flaps to 'not reachable'  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: Soak: 4 Chrome walking (WASD) + bot in the hub for 8.5 min; dbg.perf sampled every 15 s.
  observed: Event-loop delay p99 was normally 23-30 ms, with spikes to p99 119-139 ms and max 266-606 ms (17:36:44, 17:41-17:43). The tracked game systems cost <15 ms/s at those moments, so the cause is outside the systems (host contention / dev Vite). Three times the server logged 'STT sidecar not reachable' and dropped to loudness-only for about 10 s, while the sidecar itself was healthy (uptime 2300 s). Cumulative tick (29.9 Hz) and snapshot (19.8 Hz) rates held, and clients saw short snapHz dips to 11-14.
  expected: No multi-100 ms stalls. A single slow STT health probe should not switch voice to loudness-only.
  evidence: tests/playtest/robustness/monitor.jsonl (e.g. 17:41:19 eld p99 133.56 max 540.54; 17:43:12 p99 138.94 max 548.93; pid 84876 eldMax 606); server.log lines 105/149/151 '[stt] WARN STT sidecar not reachable at http://127.0.0.1:3100' at 19:33:57, 19:41:14, 19:42:58 followed by 'STT sidecar healthy (cuda)'. Likely environmental (shared host, dev mode); keep the host quiet tonight.
  files: apps/server/src/stt/index.ts, apps/server/src/core/loop.ts

## AREA: core (5)
- [HIGH] Disconnected player keeps 'talking/shouting' on the server for 90 s: monsters hear a ghost  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: 1) 2 players in a contract (bots LoudX + QuietY in crew LOUD, followup.ts test H). 2) Hound placed about 6 m from LoudX. 3) LoudX sends loud(3) (shout) and its connection dies (ws terminate; same as closing the tab or Wi-Fi dropping mid-sentence, or 'ok bye guys' + close tab). 4) Read dbg.state and dbg.monsters.state every second.
  observed: LoudX connected=false, band=3 for the whole 12 s observed (it is never reset, so it lasts until the 90 s slot expiry). The Hound went alert (+1 s), then investigate (+2 s) straight to LoudX's last position [22.8,26.6], then searched there until +10 s. The server keeps injecting a 25 m 'voice' noise at the disconnected player's spot every 150 ms.
  expected: When a socket closes (or no 'loud' update arrives for >1.5 s; the client resends every 500 ms while not silent), the server treats the player as silent. Monsters never hear players who are not connected.
  evidence: tests/playtest/robustness/run.log lines '[17:47:52] H: +1s LoudX connected=false band=3 alive=true | hound {"state":"alert"...}', '[17:47:53] ... investigate ... target [22.8,26.6]', '[17:47:54..57] ... search at [22.8,26.6]', '[17:48:03] H: +12s LoudX connected=false band=3'. Code: apps/server/src/core/crews.ts handleClose() sets connected=false but never resets player.band/radio; apps/server/src
  files: apps/server/src/core/crews.ts, apps/server/src/monsters/runtime.ts, apps/server/src/net/aud.ts
- [MEDIUM] 'ENTERING THE LOT…' waits 20–30 s after JOIN CREW with no progress indicator  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Fresh profile, click JOIN CREW, and time it until the van appears.
  observed: Bob: joined at 6.8 s, then 'ENTERING THE LOT…' until 37.1 s; Ann about 20 s. waitForStableFrames needs 12 consecutive frames under 60 ms, capped at 25 s, so any machine under about 17 fps always waits the full 25 s. Only the button label changes, so it looks like a hang.
  expected: A short, visible loading step (progress or 'compiling shaders…'), or a lower cap (about 8 s).
  evidence: Step 05 samples ('6.82s joined ENTERING THE LOT…' -> '37.06s screen=none'). Code: JoinScreen.tsx waitForStableFrames(500, 25000, 12). Caveat: several headless Chromes were sharing the GPU.
  files: apps/client/src/core/ui/JoinScreen.tsx
- [MEDIUM] Welcome that changes phase (reconnect after a server restart, or a drop across a phase change) fires no 'world:phase': contract drone keeps playing in the van  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: 1) 4 Chrome + bot in a contract (run.ts stage 'server restart mid-contract'). 2) Kill the dev server, restart it (session restore puts the crew back in the hub). 3) Clients auto-reconnect (2.6 s) and get a welcome with phase 'hub'. 4) Check window.__audioDebug.ambience() on Bob.
  observed: Before the restart in the contract: drone:true. After the reconnect: phase hub, hub layout, screen none, and still drone:true, so the facility ambience drone keeps droning in the sealed van. The same path skips the other 'world:phase' cleanups: objectives (prompt/leverWait reset, render setPower('all', true) for the hub), monsters (grab vignette and freeze reset), and meta resetMirror.
  expected: Every change of world.phase, whether from a 'phase' event or a welcome, emits bus 'world:phase' {from,to}, so the drone stops and the per-phase UI and render state reset.
  evidence: run.log '[17:34:33] drone in contract (Bob): {"drone":true}', '[17:34:50] Bob after contract restart: phase hub screen none layout {"seed":"hub"...}', '[17:34:51] drone after restart (Bob): {"drone":true,"fear":0}'; shot tests/playtest/robustness/shots/21-bob-after-contract-restart.png. Code: apps/client/src/core/net.ts emits 'world:phase' only in the 'ev'/'phase' branch (line ~186), not in 'welco
  files: apps/client/src/core/net.ts, apps/client/src/audio/index.ts, apps/client/src/objectives/index.ts, apps/client/src/monsters/index.ts
- [MEDIUM] A held slot (disconnected or 'Leave the shift') blocks a new friend for 90 s while the HUD shows 5/6  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: followup.ts test B: 6 bots join crew FULL; Full6's connection drops (or a Chrome player uses Esc > Leave the shift > LEAVE, which only closes the socket); a 7th friend joins within 90 s.
  observed: The roster shows 'Full1..Full5 Full6(away)', connected 5/6, and the van HUD shows 5/6 (it counts only connected players). The newcomer still gets 'crew_full: crew is full (6)'. 'Leave the shift' releases nothing: the leaver stays AWAY and holds the slot for 90 s.
  expected: Either the cap counts the held slot visibly ('6/6 · 1 slot held for Full6, frees in 74 s'), or a deliberate leave releases the slot immediately (explicit leave op), and the refusal says why.
  evidence: run.log '[17:48:27] B: roster after Full6 dropped: Full1 Full2 Full3 Full4 Full5 Full6(away) connected 5/6', '[17:48:27] B: new friend joins: LateFriend: crew_full: crew is full (6)'. Code: apps/server/src/core/crews.ts handleHello `if (crew.players.size >= cap())` counts disconnected players; apps/client/src/meta/hub.tsx HubCrew shows connected/maxPlayers; apps/client/src/meta/menus.tsx LEAVE cal
  files: apps/server/src/core/crews.ts, apps/client/src/meta/menus.tsx, apps/client/src/meta/hub.tsx
- [LOW] Toasts draw over full-screen menus  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Have the other player buy something in the shop while you have the Esc menu open.
  observed: The toast 'Bob bought Bottles x3 (15 scrip)' overlaps the menu header ('· CREW PLAY1').
  expected: Toasts sit below or beside screen headers, or are suppressed while a full-screen screen is open.
  evidence: shots/25-A-menu.png
  files: apps/client/src/core/ui/App.tsx, apps/client/src/core/ui/styles.css

## AREA: interaction (7)
- [HIGH] A dead player's badge can never be picked up: the crosshair always targets the disabled body, so badge-to-van revive is impossible  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: 1) Start a contract with 3 players. 2) Kill Cat (hound, or dbg.interaction.kill). 3) Bob walks to the body and puts the crosshair on the small blue badge card on the floor next to it. Try from all 4 sides (I aimed with __ix.aim at the badge's exact coordinates). 4) Press E. 5) Wait past the 30 s medkit window and look at Cat's spectator HUD.
  observed: The prompt always reads 'Cat's body · carry their badge to the van deposit' with no key and enabled:false. E does nothing and Bob's inventory stays [null,null,null,null]. Cat's HUD then says 'YOUR BADGE IS ON THE FLOOR · A TEAMMATE CAN CARRY IT TO THE VAN', which nobody can do. Cat stays dead for the rest of the contract and the crew is always fined 10% for the badge.
  expected: Aiming at the badge targets it and E picks it up. Depositing it in the van starts the 20 s respawn ('BADGE FILED · RESPAWN AT THE VAN IN 20 S'), per PLAN §3.7.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\play2.log: 'E target when aiming at the badge {"id":"body:pC8EO2uylIk","kind":"body",..."enabled":false}', 'E retry from offset 0,1 / 1,0 / 0,-1: target body:pC8EO2uylIk', 'E bob inventory after retries [null,null,null,null]'. Screenshot C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots2\E1-aim-at-badge-bob.png (badge unde
  files: apps/client/src/interaction/targeting.ts, apps/server/src/interaction/engine.ts, packages/shared/src/interactables.ts
- [MEDIUM] A dropped Core next to a powered breaker can't be re-grabbed: the disabled breaker takes over the crosshair  (from: contract-run)
  repro: Let the Core drop near a breaker (here 0.9 m from lever:0 in LAUNDRY). Both players stand at the Core and aim at it on the floor, then press E.
  observed: The 'Grab a Core handle (needs 2)' prompt showed for a moment, but at the E press Ann's prompt read 'Breaker (power restored)', a disabled interactable. The grab silently failed, and the Core stayed 'dropped' with 0 carriers; it ran past blackout and the crew left without it.
  expected: An enabled, high-value target (a dropped Core on the floor) should win over a disabled one, or the Core should have a generous hit volume when dropped.
  evidence: tests/playtest/contract-run/shots/33-dropped-core-view.png; out/s20.json ('regrab state dropped').
  files: apps/client/src/interaction/targeting.ts, apps/server/src/objectives/contract.ts
- [MEDIUM] Company store prompt only appears when aiming at the lower crate (≤0.8 m)  (from: contract-run)
  repro: Hub: walk up to the store crates (shop:0 at 17.4, 13.9) and look at them at chest/eye height.
  observed: No prompt with the crosshair on the top crate at 1.0-1.4 m. The 'Company store' prompt only shows when aiming at 0.4-0.8 m, i.e. looking down at the bottom crate. E does nothing until you look down.
  expected: The whole crate stack, or at least its front face at eye level, shows 'Company store'.
  evidence: tests/playtest/contract-run/out/s25.json (hit sweep: hits only at y 0.4/0.8); shots/42-shop.png (crosshair on the crate, no prompt).
  files: apps/client/src/interaction/targeting.ts, packages/shared/src/interactables.ts, apps/server/src/meta/flow.ts
- [MEDIUM] Teammate death toast reuses the victim's second-person reason: 'Ann is down: hound heard your SHOUT'  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Two or more players in a contract. The hound kills Ann after she shouts. Watch Cat's or Bob's screen.
  observed: Teammates get the toast 'Ann is down: hound heard your SHOUT', which reads as if the viewer's own shout killed Ann. It also overlaps the results header if the contract ends right away. The mannequin case is fine ('Ann is down: mannequin nobody was watching it').
  expected: A third-person line such as 'Ann is down: the HOUND heard her SHOUT, 5 m' or 'heard Ann's SHOUT'.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots-run1\11-hound-alert-on-walk-cat.png (toast at top centre, on Cat's screen). Code: apps/client/src/interaction/index.ts:284 ctx.ui.toast(`${d.name} is down: ${d.cause.killer} ${d.cause.reason}`). The reason comes from hound.ts killCause() as 'heard your <LABEL>'.
  files: apps/client/src/interaction/index.ts, apps/server/src/monsters/hound.ts
- [LOW] Stale 'Breaker down: the other one must follow within 1 s' message shown after the twin pull succeeded  (from: contract-run)
  repro: Two players pull both breakers 250 ms apart with E.
  observed: The POWER RESTORED banner and 'Breaker (power restored)' prompt are shown together with the first puller's leftover waiting message.
  expected: Success clears the waiting message.
  evidence: tests/playtest/contract-run/shots/23-ann-after-twin-pull.png
  files: apps/client/src/interaction/hud.tsx, apps/client/src/objectives/index.ts
- [LOW] Balance note: the flashlight battery runs out about 03:25, right after the 03:00 blackout, if the player never goes back to the van  (from: contract-run)
  repro: Keep the flashlight on for the whole contract without visiting the van.
  observed: Bob's battery was at 22% by 02:29 (about 11 real minutes). It would hit 0 at about the same time the blackout kills every light.
  expected: Intentional? If so, players should be warned (e.g. a battery warning at 25%). Otherwise a slightly longer battery life.
  evidence: tests/playtest/contract-run/shots/31-carry-bob-1.png (LIGHT 22% at 02:29); config flashlightBatterySec 840.
  files: config/balance/interaction.json, apps/client/src/interaction/index.ts
- [LOW] Receiving walkie shows no RX indicator (who is talking on the radio?)  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: Talker (walkie) in the Infirmary holds Q; Shouter (walkie) 40 m away in the lot receives.
  observed: The receiver's radio HUD stays 'RADIO · Q' with a green dot, and the view-model LED keeps its idle blink. Besides the squelch and the filtered 2D voice there is no LED change, 'RX' tag or speaker name. With 2D radio you can't tell which teammate is calling, which matters for the 'verify radio calls' counterplay against Listener lures.
  expected: A receive tell, such as an RX LED or a 'RX · Talker' line on the radio HUD while a teammate transmits, kept distinct from the planned red flicker for Listener lures.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\shots\19-shouter-rx.png (receiver) vs shots\19-talker-tx.png (sender: 'TALK ● TX' and 'TX · RADIO'). Radio HUD state lives in apps/client/src/interaction/hud.tsx RadioHud; incoming radio state is only in the voice track's peer state (radio flag).
  files: apps/client/src/interaction/hud.tsx, apps/client/src/interaction/index.ts, apps/client/src/voice/index.ts

## AREA: level (4)
- [MEDIUM] Locker mirror can't be found: it's on the van's outside wall and looks like a plain black wall  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: New player in the van, HUD says 'E USE'. Look for the mirror: it is at (13, 11.2), facing -X, on the outer left wall of the van.
  observed: From inside the van (where you spawn) you face the back of that wall: no prompt, E does nothing, and meta's distance-only 'near' check (d=1.93) still thinks the mirror is in range. From outside, the spot is a black surface with no mirror or locker look; the prompt only appears at about 0.9 m. A solid collider inside the van stops you at x=14.38. The board (corkboard) is likewise on the outer right wall; only the B key works from inside.
  expected: The mirror is visible and recognizable (lit mirror or locker mesh, a stencil), ideally inside the van, and reachable with E.
  evidence: shots/08-A-at-mirror.png (inside, brown wall, no prompt). shots/28-A-mirror-outside.png (outside: dark wall plus prompt). Step 15/16 outputs (blocked at x=14.38; board no target from inside).
  files: packages/shared/src/procgen/van.ts, packages/shared/src/procgen/hub.ts, apps/client/src/level/props.ts, apps/client/src/meta/index.ts
- [MEDIUM] Spawn views face a wall: on site you spawn 1 m from a blank wall, and the hub spawns sit on the van wall line  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Ready up and drive to site 1 (seed PLAY1-000-7696). Also look at the first view after joining the hub.
  observed: Facility spawns are rot=pi at (16.8/18/19.2, 26.6): the first view is a blank exterior wall with a barred window 1 m ahead and 'OBBY' cut off at the edge; the LOBBY door is 90° left and the van is behind. Hub spawns 0 and 2 (x=13.8 and 16.2) are on the van's side-wall lines, so the very first frame after joining is split down the middle by a wall edge.
  expected: Players spawn facing the entrance or the open lot, with a clear line to the LOBBY door.
  evidence: shots/34-A-arrival.png, 36-A-arrival-look-W.png (LOBBY door to the left), 05-A-first-screen-after-join.png, 07-B-after-join.png. Step 31 items (spawn_player rot 3.14159).
  files: packages/shared/src/procgen/van.ts, packages/shared/src/procgen/facility.ts, packages/shared/src/procgen/place.ts
- [LOW] On-site spawn faces a blank facility wall 2.6 m away; the entrance isn't in view  (from: contract-run)
  repro: Arrive on site (seed wo1-0-JBLS-000-7905): both players spawn at (14.8 / 16, 26.6), yaw pi.
  observed: The first view is a concrete wall with a barred window and a half-cut 'LOBBY' stencil. The exit door to the lot is off to the side, so new players don't know where to go.
  expected: Spawn facing the entrance door (or put a marked entrance in the first view).
  evidence: tests/playtest/contract-run/shots/08-ann-after-ready.png, 09-bob-after-ready.png
  files: packages/shared/src/procgen
- [LOW] Breaker levers only 16.6 m apart in a straight line (PLAN: at least 18 m)  (from: contract-run)
  repro: Seed wo1-0-JBLS-000-7905: lever:0 (21.5, 16.8) in LAUNDRY, lever:1 (20.5, 0.2) in FURNACE.
  observed: Straight-line distance 16.6 m; the walls do block line of sight.
  expected: 18 m or more, per PLAN §3.4 (fine if the rule is meant as path distance).
  evidence: tests/playtest/contract-run/out/s05.json (levers)
  files: packages/shared/src/procgen

## AREA: meta (16)
- [HIGH] One-time brightness check never opens for brand-new players  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Fresh browser profile, open http://127.0.0.1:3201/?test=1#PLAY1 (no nobright). Type a name, click JOIN CREW, and wait until you are in the van.
  observed: No brightness screen, for both Ann and Bob. After landing, screen is 'none' and localStorage has no deadair.meta.settings (brightnessDone never set). The Join screen stays on 'ENTERING THE LOT…' for 20–30 s after welcome (waitForStableFrames), so when the 600 ms check runs the current screen is still 'join', not 'none'.
  expected: PLAN §1/§4.11: a one-time brightness check right after landing in the van.
  evidence: shots/05-A-first-screen-after-join.png and shots/07-B-after-join.png (no brightness screen). Step 03/05 outputs: screen='none', localStorage keys without deadair.meta.settings. Code: the net:welcome handler in meta/index.ts uses setTimeout 600 ms and checks ui.screen.value.name === 'none'; JoinScreen.tsx only calls setScreen('none') after waitForStableFrames (min 0.5 s, max 25 s).
  files: apps/client/src/meta/index.ts, apps/client/src/core/ui/JoinScreen.tsx
- [HIGH] Gear hand-out duplicates items every contract (1 bottle pack = 9 bottles, 2 walkies each) and carries the previous site's keycard over; inventory starts full  (from: contract-run)
  repro: 2 players. Contract 1: each gets a company walkie; Bob picks up the site keycard (E); leave via the lever. In the hub, Ann buys 'Bottles x3' once (15 scrip; balance 266 -> 251). Pick the next contract, both ready. On arrival read __ix.state().inventories.
  observed: Ann = [walkie it14 (kept from contract 1), walkie it30 (new issue), bottle x3 it31, bottle x3 it32]: all 4 slots full. A third 'Bottle x3' stack (it33) was spawned on the floor at her spawn (14.8, 0, 26.2) because her inventory overflowed, so 9 bottles came from one 15-scrip pack. Bob = [walkie it15, keycard it1 (from contract 1's site), walkie it34, empty]. The new site has its own keycard it16 in the world, and Bob's stale card is in his inventory where the new site's locked door 4 is. Ann can't pick up loot without first dropping things. Walkies will multiply every contract.
  expected: One walkie per player (2 company walkies per shift), exactly the bought quantity (3 bottles), and no level items (keycards) carried between sites.
  evidence: tests/playtest/contract-run/out/s27.json, s28.json, s31.json (inventories with ids/counts); shots/46-bottle-thrown.png (slots: Walkie, Walkie, x2 Bottle, x3 Bottle + 'Pick up Bottle x3' on the floor). Code: buyItem adds item.qty (3) to s.gear[player].bottle (meta/flow.ts ~line 1002); handOutGear loops `for (let i = 0; i < n; i++) A.giveItem(crew, to.id, type)`, and each giveItem('bottle') creates 
  files: apps/server/src/meta/flow.ts, apps/server/src/interaction/engine.ts
- [HIGH] Van console map shows no breaker levers, keypad or Core; nothing helps players locate the twin breakers  (from: contract-run)
  repro: Contract start, walk into the van, E on 'Van console'. Look for where the two breakers are (HUD says 'POWER twin breakers, 1 s').
  observed: The map shows rooms and callsigns, doors (open, security, locked), player dots, the vault room highlighted, the code '2287' and the intercept log. There are no lever, keypad or Core markers. We only found the breakers (LAUNDRY south wall and FURNACE north wall) because the harness read the objective state; a real crew would have to search about 20 rooms on a clock that hit 00:08 just 5 real minutes in.
  expected: Console marks both breakers (and ideally the keypad/vault door and the Core), or the checklist or console names the breaker rooms ('BREAKERS: LAUNDRY + FURNACE'). PLAN §1.4/§3.4 makes the console the information half of the split.
  evidence: tests/playtest/contract-run/shots/19-console-map.png; apps/client/src/meta/console.tsx draws no 'lever' or 'keypad' anywhere (grep finds only the keypad power flag, line ~336).
  files: apps/client/src/meta/console.tsx
- [MEDIUM] Hub interactables registered at floor height (y=0): E aim only works within the 1.3 m proximity fallback  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: In the hub, read __ix.state().ints: console, kennel, mirror, board and shop all have p[1] = 0. Stand 1.5–2 m from the mirror or board and look at it at eye level.
  observed: No prompt at normal distances (ray from 1.62 m eye height vs. sphere r≈0.6 at y=0). The mirror only targets within about 0.9–1.3 m. meta.hubInteractables registers p: [it.x, it.y ?? 1, it.z]; hub items have y: 0, and ?? keeps the 0, which overrides interaction's KIND_Y heights (mirror 1.4, board 1.4, shop 1.0, console 0.95).
  expected: Prompts appear when you look at the object from about 2 m, as everywhere else.
  evidence: Step 09 output (ints with p[1]=0). Step 07/10 (no target at pitch 0/-0.3/-0.7). Step 27 (target only at 0.87 m). Code: apps/server/src/meta/flow.ts hubInteractables ~L551; apps/server/src/interaction/engine.ts KIND_Y ~L189/251.
  files: apps/server/src/meta/flow.ts, apps/server/src/interaction/engine.ts
- [MEDIUM] Drive screen is too short to read and freezes while the level builds  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Both players press R. Watch the drive screen (rule cards).
  observed: driveSec is 6 for a site memo plus 3 rule cards (title, rule, hint each, about 120 words) plus typewriter chatter. In practice the main thread is blocked during the drive: client level buildMs = 3234; a CDP frame requested 0.8 s into the drive came back about 12 s later, after arrival; DOM polling only caught the final about 2 s ('ARRIVING IN 1 s'). Players probably see a frozen card screen and then get dropped in. The drive phase took about 13 s in total on contract 1.
  expected: Rule cards readable (about 10–12 s, or press-to-continue once loaded), with the progress and typewriter still animating while the level builds.
  evidence: Step 30 log (drive 5.4 s -> contract 18.5 s; shot1 returned at 18.1 s). Step 34 drive DOM text. Step 37 diag.level.buildMs 3234.5.
  files: apps/client/src/meta/drive.tsx, config/balance/meta.json, apps/client/src/level/index.ts
- [MEDIUM] The drive screen, the main place the three monster rules are taught, lasts only 6 s, too short to read  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Hub: pick a work order, everyone presses Ready, read the drive screen.
  observed: Three rule cards of 2–3 lines each plus typed dispatch chatter. At 'ARRIVING IN 3 s' the second dispatch line is still typing ('DISPATC▌'). Nothing on screen hints that holding extends the drive (holdDriveSec exists).
  expected: Enough time to read the HOUND, LISTENER and MANNEQUIN cards (about 15–20 s on a crew's first contract), or a visible 'hold to keep reading' hint.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots-run1\01-drive-ann.png. config/balance/meta.json "driveSec": 6, "holdDriveSec": 3. server.log 'phase hub -> drive' 19:23:49.77 to 'drive -> contract' 19:23:55.77.
  files: config/balance/meta.json, apps/client/src/meta/drive.tsx, apps/server/src/meta/flow.ts
- [MEDIUM] 'EVERYONE CONNECTED · LEAVE DISCORD VOICE NOW' only checks the local client's links  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: 4-player lobby where one pair (Tone and Quiet) failed to link (finding 1). Look at the hub banner on the Shouter's and Talker's screens.
  observed: Shouter's banner said 'EVERYONE CONNECTED - LEAVE DISCORD VOICE NOW' and its roster showed DIRECT for everyone. At the same moment Quiet's banner said 'VOICE LINKING 2/3' and Tone showed LINKING. The crew would leave Discord while two friends cannot hear each other.
  expected: The green 'leave Discord' banner appears only when every pair in the crew is linked. Each client should report its linked-peer count to the server and the banner should use the crew-wide result. Roster badges could show the worst link per player.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\shots\06-hud-Shouter.png vs shots\06-hud-Quiet.png. HubBanner / crewVoice in apps/client/src/meta/hub.tsx L141: if (v.linked === v.others) uses only this client's links.
  files: apps/client/src/meta/hub.tsx
- [LOW] Two different prompt styles; the kennel prompt is low contrast  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Compare the kennel prompt (meta HubPrompt) with the shop and mirror prompts ((b) PromptHud).
  observed: Kennel: grey stencil text 'E TRAINING KENNEL · CALIBRATE MIC' over the bright, flashlight-lit fence and sign, hard to read. Shop: amber key 'E Company store', clear.
  expected: One consistent, high-contrast prompt style.
  evidence: shots/13-A-at-kennel.png vs shots/22-B-at-shop.png
  files: apps/client/src/meta/hub.tsx, apps/client/src/meta/meta.css, apps/client/src/interaction/hud.tsx
- [LOW] Settings lack crouch toggle and invert-Y  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Esc -> Settings -> Controls.
  observed: Only mouse sensitivity is offered, although the players track supports crouchToggle and invertY, and PLAN §3.5 says crouch 'hold, toggle in settings'.
  expected: Crouch hold/toggle and invert-Y toggles.
  evidence: shots/27-A-settings-changed.png; players/input.ts DEFAULT_SETTINGS
  files: apps/client/src/meta/menus.tsx
- [LOW] First-night board offers effectively one contract  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: A new crew (all L1) opens the board.
  observed: 2 of 3 orders show LOCKED (crew average level 2 or Core Business), so the 'pick one of three' choice is really one.
  expected: At least two choosable Risk-1 orders on the first contract (design note).
  evidence: shots/19-A-board.png
  files: apps/server/src/meta/orders.ts
- [LOW] One player's 'BACK TO THE VAN' click closes the results screen for the whole crew  (from: contract-run)
  repro: Contract ends (leave lever); Ann clicks BACK TO THE VAN while Bob is still reading (countdown 25 s left).
  observed: The phase goes straight to hub, and Bob's results screen disappears mid-read (his button never became clickable).
  expected: Per-player continue, or move on when all have continued or the countdown expires.
  evidence: tests/playtest/contract-run/out/s22b.json; server.log 'phase results -> hub' right after Ann's click.
  files: apps/server/src/meta/flow.ts, apps/client/src/meta/results.tsx
- [LOW] Both players got the same cyan visor colour; console map dots and labels are hard to tell apart  (from: contract-run)
  repro: Two fresh players join the crew.
  observed: Ann and Bob both have cyan dots in the crew list and on the console map. On the console, Ann's dot and name cover the 'VAN' label when she's in the van.
  expected: Distinct default visor colours per crew member; labels that don't overlap.
  evidence: tests/playtest/contract-run/shots/03-bob-in-hub.png, 19-console-map.png
  files: packages/shared/src/profile.ts, apps/client/src/meta/console.tsx
- [LOW] Results screen: the death-card list is clipped by the footer (the 3rd card is half hidden)  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Wipe with 3 deaths, then open the results screen at 1600x900.
  observed: The third death card (ANN) is cut off by the footer and 'BACK TO THE VAN' bar. With 5–6 players most cards would be hidden.
  expected: All death cards visible (scrolling list or compact rows).
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots-run1\12-hound-bottle-ann.png
  files: apps/client/src/meta
- [LOW] Board footer says 'Press R … to ready up' but R does nothing while the board is open  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: In the hub press B to open the work-order board, then press R.
  observed: Ready stays false (before R=false, after R=false). The non-leader footer reads 'The crew leader picks the contract. Press [R] or the button to ready up'.
  expected: R toggles ready on the board too (or the footer stops saying it).
  evidence: run.log '[17:49:17] C: screen=board ready before R=false after R=false'; shots/30-gus-board-press-R.png. Code: apps/client/src/meta/index.ts:166 handles KeyR only when screen === 'none'; apps/client/src/meta/board.tsx:133 footer text.
  files: apps/client/src/meta/index.ts, apps/client/src/meta/board.tsx
- [LOW] Non-leader clicking a work order gets no feedback  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: Leader Ann and non-leader Bob both open the board (B) and click different order cards at the same moment.
  observed: Ann's pick wins, which is correct and race-free. Bob's click is silently ignored: no toast, no highlight. Bob only sees 'Ann picked Varga Brothers Foundry…'.
  expected: A short hint on the non-leader's click, e.g. 'Only the crew leader (★ Ann) picks; tell them which one'.
  evidence: run.log '[17:27:07] picked: wo1-0-RBST-000-5239 ...' and 'Bob toasts: ["Ann picked Varga Brothers Foundry. Waiting for ..."]'; shots/04-bob-board-nonleader-click.png. Code: apps/client/src/meta/board.tsx OrderCard onClick `o.available && canPick && onPick()`.
  files: apps/client/src/meta/board.tsx
- [LOW] Server restart mid-hub forgets the picked work order  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: Leader picks an order in the van, then the server restarts (run.ts stage 'server restart mid-hub').
  observed: After the reconnect: picked=null (was wo1-1-RBST-001-9645), and every ready flag is reset. The orders, shift (scrip 150, quota 625) and leader are restored correctly.
  expected: The pick survives a restart (it is part of the crew's hub state), or the leader is told to pick again.
  evidence: run.log '[17:28:29] before restart: picked wo1-1-RBST-001-9645 shift {...}', '[17:28:44] after restart: picked null shift {...same...}'.
  files: apps/server/src/meta/flow.ts, apps/server/src/meta/saves.ts

## AREA: monsters (6)
- [HIGH] Hound: one continuous sentence, shout or walk counts as the 'second noise', so alert turns into charge and a kill with no time to freeze  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: 1) Hound idle in a lit hall. 2) A player about 9 m away holds V (push-to-talk) and shouts once for about 1 s, then releases and stays silent. Variant: a player walks (W) toward a hound that has just alerted.
  observed: Run 2 D1: shout bands 3,3,3,3,3 (1.0 s). 0.5 s after release the hound was already in 'charge' and Ann died, with no second utterance. The death card read 'hound / heard your SHOUT / 5 m'. Run 2 H2, walking: alert 0.0 s, wind-up 0.7 s, charge 1.2 s, kill 1.4 s. Run 1 with default open mics: all 3 players were killed in the hound's hall within about 15 s (CREW LOST).
  expected: PLAN §3.3 and the drive card: the first sound gives Alert (1.5 s head tilt plus a growl, the 'everyone freeze' moment) and an investigation. It charges only on a second noise within 6 s and 12 m. One utterance or one burst of steps should count as one sound, and players need at least 1–1.5 s after the growl to react.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\play.log: '[135.2] D1 ann shout bands 3,3,3,3,3', '[135.7] D1 after 1st shout: hound charge tdoor=-1 lastNoise=voice/5', '[144.3] D2 ann dead=true', 'H2 cat walks toward it hound0 states: 0.0s:alert -> 0.7s:windup -> 1.2s:charge -> 1.4s:eat'. Death card: shots\21-hound-investigating-ann.png. Wipe: run1-play.log, shots-run1\11-hound-alert-
  files: apps/server/src/monsters/hound.ts, apps/server/src/monsters/runtime.ts, config/balance/monsters.json
- [HIGH] Hound: freezing after the growl doesn't save you in the same room; it walks to your exact spot and bump-kills ('heard your PRESENCE')  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: ws-bot probe C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\hound-bot.ts, scenario S2: bot about 5 m from an idle hound in the same space says one 0.4 s talk-level word, then stays completely silent and still.
  observed: Growl at 126 ms, then alert, investigate at 1649 ms, wind-up at 2557 ms, charge at 3067 ms and kill at 3152 ms: 'HOUND heard your PRESENCE, 1 m'. The player did exactly what the rule card says and still died.
  expected: The drive card says 'When it growls, everyone FREEZE'. PLAN: it investigates the doorway the sound came through, and freezing, whispering or creeping away are the counters. Freezing should usually be survivable, or the card should say to creep away.
  evidence: hound-bot.ts output: 'S2 short talk 0.4 s, then silent: 1ms:idle -> 172ms:alert -> 1649ms:investigate -> 2557ms:windup -> 3067ms:charge -> 3152ms:eat | cues: growl@126ms bark@2538ms eat@3152ms | kills: {..."reason":"heard your PRESENCE","detail":"1 m"}'. server.log: '[monsters] crew MDTG: HOUND killed Probe: heard your PRESENCE (1 m)'. Cause: hound.ts investigateTarget() returns the exact source [
  files: apps/server/src/monsters/hound.ts, apps/client/src/meta/drive.tsx
- [MEDIUM] Training kennel: the hound can't be seen, doesn't visibly react, and the calibration panel covers the whole view  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Walk to the kennel fence (6, 13.4), press E, START calibration, talk (talk_en.wav). Then press Esc and look through the fence with the flashlight on; Bob also stands at the fence.
  observed: Beyond the fence is pitch black; the hound at (5.1, 17.2), about 6 m away, is invisible. Hound snapshot anim stays 44 and yaw only jitters ±0.2 while players talk; no lunge seen. The calibration panel is an opaque full-screen 'MEET THE DOG' screen, so you can't watch the dog during calibration. Calibration finished in about 4.5 s although the copy says 'about 8 seconds', with no whisper/shout step. The kennel sign is a blank white board. Bob's shout.wav reads as TALK (relative baseline).
  expected: PLAN §1: the chained Hound visibly ignores whispers, turns at talk and lunges at shouting, and calibration is done while watching it.
  evidence: shots/13-A-at-kennel.png, 14-A-kennel-screen.png, 17-A-hound-view.png, 18-B-shouting-at-kennel.png. Step 18/20 hound samples (anim 44 constant).
  files: apps/client/src/meta/menus.tsx, apps/server/src/monsters, apps/client/src/monsters/index.ts, apps/client/src/render/fixtures.ts
- [MEDIUM] Mannequin: nothing stops two watchers' visor blinks from overlapping, and an overlap let it move about 2.6 m while both players watched it  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Risk-2 contract (crew levelled with meta.setXp, risk-2 order picked from the board). Ann and Bob stand 12 m from a lit mannequin and both look straight at it. Spawn it with dbg.monsters.spawnMannequin {blinkIn:5}, which schedules every player's blink at the same instant (index.ts:367).
  observed: States went frozen, then move at 2.2 s (33.41,19.37), then frozen at 2.5 s (33.26,17.74), while the sight map listed both players. The move lined up with the blinks. The real scheduler (mannequin.ts:125 uses 4+rng*8 s, later 18–30 s per player) never staggers blinks either, so in normal play two watchers' blinks will sometimes overlap.
  expected: PLAN §3.3: 'two watchers are safe and one is risky'. With two or more living watchers, never let all of them blink at once.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\play3.log: '[91.2] M2 two watchers ... 0.0s:frozen@33.5,20.3 -> 2.2s:move@33.41,19.37 -> 2.5s:frozen@33.26,17.74', '[91.5] M2 sight {"mannequin0":["pzwFykqhBP4","ppe8JUWfOO5"]}'. Fix: in scheduleBlink/blinkTick, push a blink back when another living player's blink window falls within ±0.5 s. Stagger the dbg spawn's blinkIn per player too.
  files: apps/server/src/monsters/mannequin.ts, apps/server/src/monsters/index.ts
- [LOW] Death card shows the killer in lowercase ('hound', 'listener', 'mannequin')  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Get killed by any monster and read the incident report.
  observed: The big killer line says 'hound' or 'listener' in lowercase. The results screen and PLAN use 'HOUND'.
  expected: 'HOUND heard your SHOUT · 5 m', matching the rest of the uppercase HUD.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots\21-hound-investigating-ann.png; play2.log 'G1 bob HUD ix-deathcard: ... listener heard "boiler, meat in boiler"'. Cause: runtime.ts kill() sets cause.killer = a.kind. Fix: uppercase it there, or in DeathCardHud or its CSS.
  files: apps/server/src/monsters/runtime.ts, apps/client/src/interaction/hud.tsx
- [LOW] Grab victim never sees the Listener: the camera isn't turned toward it during the 3 s grab  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: A lone player (no living teammate within 8 m) is grabbed by the Listener while looking elsewhere.
  observed: Red pulsing vignette and 'IT HAS YOU — SCREAM FOR HELP' over a view of the floor or wall. The Listener is off-screen for the whole grab, and input is frozen, so you can't turn to see it.
  expected: Turn the victim's view to the Listener's face (or the grab point) for a readable, scary grab.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots2\G1-grab-victim-bob.png. The client 'monsters.grab' start handler in apps/client/src/monsters/index.ts freezes the player but doesn't set the look direction.
  files: apps/client/src/monsters/index.ts

## AREA: net (6)
- [HIGH] /voicetest participant is a full living crew member in the game: blocks the leave lever, gets 'left behind', heard 2D by everyone  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: While a crew is in a contract, a friend opens http://<host>/voicetest on a phone, types the crew code and taps JOIN VOICE. The page tip suggests this ('on mobile data this proves the TURN relay works'). Let the van leave at 04:00, or try the leave-now lever with every real player inside the van.
  observed: The server treats the voicetest identity as a normal player: alive, connected, placed at a van spawn (22, 31.5) outside the van, roster 'CREW VRAD 3/6', talk band 2. The server log says '[interaction] crew VRAD: voicetest killed by company: left behind'. The leave lever counts every living connected player outside the van (contract.ts L746), so it can never fire while such a tab is open, and an ALL_SURVIVE request fails. Every game client hears that phone in 2D at full volume, with no distance gating, even mid-contract (voice/index.ts L290, route 'monitor'). Quiet in the lot heard it at about 11 m with rms 0.064. That breaks the proximity rule. The monsters runtime also queues voice noise for any living player whose band is above silent (runtime.ts L218), so the Hound and Listener can hear the phone at the spawn.
  expected: A voicetest connection should be a voice-only observer: no spawn, not counted as alive, in the roster, in objectives, in departure or in monster hearing. During a contract either nobody hears it or it is clearly marked and gated.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\server.log (19:47:10 voicetest joined crew VRAD [5]; 19:48:44 voicetest killed by company: left behind). cmd\30-voicetest-in-game.out.txt (voicetest alive=true, band=2, pos [22,0,31.5]). cmd\29-phone-mic.out.txt (Quiet hears voicetest at rms 0.064). shots\30-quiet-with-voicetest-in-crew.png.
  files: apps/client/src/voice/voicetest/main.tsx, apps/client/src/voice/index.ts, apps/server/src/objectives/contract.ts, apps/server/src/monsters/runtime.ts, apps/server/src/core/crews.ts
- [MEDIUM] Van seal cuts voices at the visibly open rear doors (1-2 m apart, fully in view, total silence)  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: Lobby or site van: player A inside the cargo area at (15, 11.6) facing the open rear doors; player B just outside at (15, 9.4), about 0.6 m past the threshold, looking in. Both talk.
  observed: Path distance is 255 both ways and both sides are completely silent: inside hears outside max 0, outside hears inside max 0. Meanwhile someone inside at 1 m is heard (aud 1). The doors render wide open, avatars and name tags are clearly visible about 2 m away, and nothing tells you where the seal starts. Players will think voice is broken ('I'm right at the door!').
  expected: The seal follows the design, but its edge is readable: for example a 'VAN · SEALED - safe to talk' HUD tag while inside, the doors drawn closed or a visible threshold, or a short soft zone at the door line instead of a hard cut.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\shots\12-van-inside-looking-out.png and shots\12-van-outside-looking-in.png. cmd\12-vancab.out.txt (Talker_outside aud 255 max 0; Shouter_inside aud 1 max 0.37; outside hears inside aud 255 max 0). aud.ts L133: if (r.sealed !== s.sealed) return UNREACH.
  files: apps/server/src/net/aud.ts, packages/shared/src/procgen/van.ts, apps/client/src/voice/ui.tsx
- [LOW] A frame handler that throws during join leaves the player stuck on 'CONNECTING…' with no error  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Happened when Bob loaded while another agent was mid-edit on level/index.ts (transient 'sameLayout is not defined'). A re-run worked.
  observed: Console: 'bad server frame: sameLayout is not defined' and 'event meta.update: …'. The button showed CONNECTING… for 30+ s with no error and no RELOAD prompt.
  expected: A join timeout or error panel with RELOAD, so a client bug doesn't look like a hang.
  evidence: Step 04 output console lines; file level/index.ts modified at 19:19:42 during the load.
  files: apps/client/src/core/net.ts, apps/client/src/net/NetHud.tsx
- [LOW] No notice after a mid-contract server restart: crew silently lands back in the van  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: Start a contract with 4 Chrome players, then kill and restart the server (run.ts stage 'server restart mid-contract').
  observed: During the outage the only cue is a small red 'RECONNECTING' in the top-right (shot 20). After the reconnect everyone stands in the van with the normal hub HUD and no message. The contract counter (2/3) and scrip (60) are correctly unchanged. The 'contract void' message exists only in the server log.
  expected: A toast or banner such as 'The host restarted the game. Contract voided, no penalty.', so friends don't think they failed or lost loot.
  evidence: server.log '19:34:40.916 [session] crew RBST was in 'contract' when the server stopped: back to the hub (contract void)'; shots/20-bob-during-outage.png, shots/21-bob-after-contract-restart.png (no message).
  files: apps/server/src/net/session.ts, apps/server/src/meta/index.ts
- [LOW] Crew-full refusal is a tiny red line under the buttons (and logged as a console error)  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: With 6 in the crew, a 7th player opens the invite link and clicks JOIN CREW.
  observed: The only feedback is small red text 'crew is full (6)' under JOIN/CREATE (shot 02). It is easy to miss, and it gives no hint that someone has to leave or that held slots free after 90 s. The client also reports 'server: crew_full' as an error (console + __game.errors()), because crew_full is not in the expected-outcome list.
  expected: A clear CREW FULL panel (NetErrorScreen already has the 'crew_full' text) with a hint, and no error logged for an expected outcome.
  evidence: shots/02-eve-7th-player.png; run.log '[17:26:47] Eve (7th) sees: crew is full (6) screen= join net= idle', 'Eve errors: ["console: server: crew_full: crew is full (6)", ...]'. Code: apps/client/src/net/index.ts shows net-error screens only `|| everJoined`; apps/client/src/core/net.ts excludes only stale_build/kicked/unknown_crew from onError.
  files: apps/client/src/core/ui/JoinScreen.tsx, apps/client/src/net/index.ts, apps/client/src/core/net.ts
- [LOW] Leader cannot kick anyone in the van (roster/KICK hidden in the hub)  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: As crew leader in the hub, look for the roster: the top-right net widget shows only 'LINK x MS'; the meta CREW panel rows have no KICK.
  observed: In the hub, .nethud-count=0 and there are 0 KICK buttons. The net HUD hides its code/roster row whenever another 'COPY INVITE' button exists (meta's hub panel). KICK appears only in drive/contract/results, and it worked there (Bot6 got 'removed by Ann').
  expected: The leader can kick from the van, which is where griefers or ghost players get dealt with.
  evidence: run.log '[17:49:15] G: hub kick UI for the leader: {"count":0,"kick":0,"nethud":"LINK 1 MS"}'; shots/29-gus-hub-leader-view.png; shots/10-ann-roster-open.png (contract roster with KICK works). Code: apps/client/src/net/NetHud.tsx `otherInvite` (line ~67, ~94, ~102); apps/client/src/meta/hub.tsx HubCrew.
  files: apps/client/src/net/NetHud.tsx, apps/client/src/meta/hub.tsx

## AREA: objectives (2)
- [HIGH] Exploit: leaving instantly pays the 'everyone survives' request and full XP for zero work  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Pick the first order, both press R. On arrival walk about 3 m into the van and press E on the leave-now lever at 22:0x.
  observed: Results: LEFT EARLY, +0 hauled, but '✓ Headcount at 04:00 must match headcount at 22:00' +110 scrip (balance 135 -> 245), and Ann and Bob each get +90 XP (contract completed +25, survived +40, 1 Company Request +25). Two such loops (about 1 minute each) pass the 150 XP level-2 threshold, which unlocks Risk 2 and the box helmet.
  expected: The survive request and the completion/survival XP need real participation (some salvage, or a minimum time on site), or are void when leaving early with 0 hauled.
  evidence: shots/38-A-results.png. Step 33 text. Code: contract.ts ~L796 (ALL_SURVIVE done = !wipe && all && leftBehind.length === 0, with no haul or time condition); meta/flow.ts ~L853 (XP for contract and survive always granted).
  files: apps/server/src/objectives/contract.ts, apps/server/src/meta/flow.ts, config/balance/meta.json
- [HIGH] Core carry drops on a 3.2 m leash with 0.5 s grace and no coupling or warning: dropped at the first doorway corner  (from: contract-run)
  repro: Power on, open the vault, both players E on the Core handles (state 'carried'). The leader holds W toward the van (path vault -> corridor -> LAUNDRY -> south door -> corridor -> LOBBY -> lot), and the follower holds W after the leader.
  observed: The carriers stayed 1.4-1.8 m apart on the straight sections. When the leader turned through the LAUNDRY south doorway, the follower snagged on the door frame for about 1 s, and the Core was dropped at (21.8, 17.7): server log 'Core dropped (leash), -66'. The only HUD feedback beforehand was 'CARRYING THE CORE · stay together'. There is no distance warning, and the leader isn't slowed or pulled back.
  expected: A soft tether (the carrier who is ahead slows down as separation grows, or the follower is pulled along), or at least a visible 'TOO FAR APART (3.0 m)' warning with a longer grace (1.5-2 s). Doorways are where real pairs will desync.
  evidence: tests/playtest/contract-run/out/s19.json (separation trace and drop at t=17.4 s); server.log 19:31:56.855; shots/31-carry-bob-1.png and 31-carry-ann-2.png (HUD during the carry). config/balance/objectives.json coreLeashM 3.2, coreLeashGraceSec 0.5; logic at objectives/contract.ts ~546-552. Caveat: my first follower steered straight at the leader, but a human follower will also clip a corner they c
  files: apps/server/src/objectives/contract.ts, config/balance/objectives.json, apps/client/src/objectives/hud.tsx

## AREA: players (3)
- [HIGH] Local player can get permanently frozen (velocity becomes NaN; only a reload fixes it), with a flood of non-finite AudioParam errors  (from: FIRST-TIME PLAYER EXPERIENCE)
  repro: Seen once with Ann: walk from the hub spawn into the van toward the left wall (stops at x=14.38, z=11.2), look around (look yaw -pi/2, pitch -0.15/-0.35), press E, then idle about 10 s. Not reproduced with Bob on the same path, so the trigger is intermittent.
  observed: W/A/S/D do nothing (position unchanged after 700 ms holds). Players diag shows st.forward=1, frozen=[], vel=[null,null] (NaN). Between 358 s and 430 s the page logged 1,861 'Failed to execute linearRampToValueAtTime on AudioParam: The provided float value is non-finite' errors (the audio listener is fed from the camera matrix). The audio errors stopped once look() reset yaw/pitch, but the velocity stayed NaN until a page reload.
  expected: Movement can never be wedged by a single non-finite value; the camera, listener and velocity stay finite.
  evidence: Step 12 output (vel [null,null], forward 1, frozen []). Step 35/36 output (errCount 1861, first at 358.1 s, last at 430.4 s). shots/10-A-stuck-view.png. Code: in stepLocal (players/local.ts) a NaN vel never recovers: vel += (target - vel)*k stays NaN, Math.hypot(NaN) < 0.02 is false so no reset, and moveCircle with a NaN delta returns the old position. applyListener/setPannerPos (audio/graph.ts) r
  files: apps/client/src/players/local.ts, apps/client/src/players/index.ts, apps/client/src/audio/graph.ts
- [MEDIUM] On site the camera view jumped while the player stood still (3 times); not reproducible in the hub  (from: contract-run)
  repro: Stand still on site after aiming at something (e.g. look down at loot on the floor), wait 30-60 s, then press E.
  observed: (a) Ann aimed at the reading glasses (prompt shown, shots/12-ann-at-glasses.png). On the next E, about 40 s later, her view was level and facing a light switch (shots/13). The pickup failed and had to be redone. (b) Bob stood at the LAUNDRY breaker at (21.55, 15.51); about 60 s later his pose was (21.07, 15.46) with yaw rotated by about pi (camera and server snapshot agreed). (c) Ann's confirmed aim at the dropped Core changed to the wall and breaker within about 1 s (shots/33). net.corrections stayed 0, and nothing in the logs shows a reconnect. A dedicated hub test (idle, screenshot, W, mouse move) stayed stable.
  expected: The view only changes from player input.
  evidence: out/s06/s07/s09 (glasses), s12/s13/s14 (Bob pose jump), s20/s23. The only client code that rewrites yaw/pitch/pose: players/local.ts:90 (mouse delta), players/index.ts:146-157 (syncFromServer on net:welcome: pose from snapshot, pitch=0), :319 (setHidden), look/teleport. Low confidence: could be a headless pointer-lock artifact. Worth a quick check that no silent re-welcome or spurious large mousem
  files: apps/client/src/players/index.ts, apps/client/src/players/local.ts, apps/client/src/players/input.ts
- [LOW] Spectator follow-cam pulls in to 0.6 m near walls, so the followed player's helmet fills the centre of the screen  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Die while the teammate you follow stands with their back near a wall (a common spot).
  observed: The camera sits right behind the helmet at head height, covering about a quarter of the screen centre. In run 1 the followed player's giant nameplate also showed while it faded out on the switch. In open halls the cam is fine.
  expected: A readable over-the-shoulder or raised view, even when the boom is short.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\shots\23-death-card-ann.png and shots-run1\10-hound-close-lit-bob.png (bad); shots2\C2-spectate-after-cycle-cat.png (good, open hall). Code: the spectator boom loop [2.2, 1.7, 1.25, 0.9, 0.6] in apps/client/src/players/index.ts. Raise the camera and pitch it down when the boom drops below about 1.2 m.
  files: apps/client/src/players/index.ts

## AREA: render (2)
- [MEDIUM] Join and mid-contract rejoin stall ~25-33 s behind 'ENTERING THE LOT…' with no frames; the rejoining player is frozen and exposed in the facility  (from: ROBUSTNESS LIKE A CHAOTIC FRIEND GROUP. )
  repro: probe3.ts: one Chrome (Ivy) + 1 bot. 1) Click JOIN CREW from the new main menu. 2) Sample screen/fps every 2.5 s. 3) Start a contract, reload the page mid-contract, JOIN CREW again, sample again.
  observed: First join: screen 'join' with the 'CREW IVYY · SIGNAL ACQUIRED / ENTERING THE LOT…' overlay at +0 s (frameMs 202). The next page.evaluate/CDP capture only returned at +26.3 s, so the page produced no frames for about 26 s. Then it ran at 113-120 fps. Mid-contract rejoin: 33.4 s, and the contract clock was at 22:25 when the view appeared. A single-Chrome follow-up measured 24.6 s at 25 fps. In the 6-player run, Fay (mid-contract joiner) and Cat (reload) were still behind the panel 6-8 s after welcome (shots 11, 12b). While a screen is open, meta freezes the controller, but the server keeps the player alive at their pose for monsters. The waitForStableFrames cap (maxMs 25000, needs 12 frames <60 ms) means low-fps friend PCs always wait the full 25 s.
  expected: Entering the van or rejoining a running contract takes a few seconds. A rejoining player should not be killable while their client is still loading.
  evidence: run.log '[17:56:25] 41-ivy-first-join +0.0s {"screen":"join"..."entering":"CREW IVYY · SIGNAL ACQUIRED ENTERING THE LOT…","fps":77,"frameMs":202}' then '[17:56:52] +26.3s {"screen":"none"..."fps":120}'; '[17:57:22] 44-ivy-rejoin-mid-contract +0.1s ... phase contract' then '[17:57:55] +33.4s screen none'; '[17:49:14] D: join panel ("ENTERING THE LOT") closed after 24616 ms'; shots 44-ivy-rejoin-mid
  files: apps/client/src/core/ui/JoinScreen.tsx, apps/client/src/menu/MainMenu.tsx, apps/client/src/render/index.ts, apps/client/src/meta/index.ts, apps/server/src/players/index.ts
- [LOW] Console warnings: about 25 materials over the 3-texture budget, plus multiple KTX2Loader instances  (from: contract-run)
  repro: Load the hub or a facility.
  observed: Each client logs '[render] material X uses 5-6 textures (> 3): risks the 16-sampler limit with shadowed flashlights' (wooden_crate_01, metal_jerrycan, vintage_flashlight, power_box_01 …) and 'THREE.KTX2Loader: Multiple active KTX2 loaders'.
  expected: Fewer texture slots per material and a single shared KTX2Loader; no warnings.
  evidence: tests/playtest/contract-run/console.log
  files: apps/client/src/render/materials.ts, apps/client/src/level/assets.ts

## AREA: voice (5)
- [BLOCKER] WebRTC mesh gets stuck in an endless 'new remote session -> rebuilding' loop; the pair never connects again  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: Natural: 1 player in crew VRAD, then launch 3 more Chrome players at once with autojoin. Joining all at once causes multi-second long frames from shader compiles. Tone (pq6inO5Ghlh, impolite) and Quiet (pT21aCqwhqG, polite) never connected. Deterministic: take two connected players A (impolite = larger id) and B. On A run services.voice.setRelayOnly(true) (the 'force relay' toggle; it closes every connection). Poll until A's new connection to B is in 'have-local-offer', then block A's main thread for 400 ms (a long frame) and call setRelayOnly(false). Exact script: tests/playtest/voice-radio/cmd/32-storm-repro2.js.
  observed: Both pages log 'peer X: new remote session -> rebuilding the connection', then 'got answer sid=<new> state=stable', then 'setRemoteDescription failed: Called in wrong state: stable', about 4 times per second, forever. Natural case: 1048 rebuilds per side over about 4 minutes. It only stopped when Tone closed its tab; Tone2 then connected to everyone within about 8 s. Deterministic case: 92 rebuilds in 24 s; the connection state stays new or connecting and never reaches connected. Quiet's HUD showed 'VOICE LINKING 2/3' with Tone stuck on 'LINKING' while the other 5 pairs were DIRECT. The loop also re-creates connections, RemoteVoice graphs and audio elements several times a second and floods the game socket with signalling messages.
  expected: After a reconnect or late signalling, the two players reconnect within a few seconds. A stale answer for a connection that no longer exists is dropped, and an answer never causes a rebuild.
  evidence: Logs: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\logs\Tone.console.log and logs\Quiet.console.log (from 163.9 s). cmd outputs: cmd\05-mesh-recheck.out.txt and cmd\32-storm-repro2.out.txt ('t+24s Quiet->Talker new | Talker->Quiet connecting | rebuilds Quiet 92 Talker 93'). Screenshot: shots\06-hud-Quiet.png. Cause in mesh.ts: Peer.onSignal returns false for ANY description whose sid d
  files: apps/client/src/voice/mesh.ts
- [HIGH] Cold-start band detection: normal speech reads SHOUT for about 20 s, and whispers read TALK  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: Fresh browser profile with no calibration (tonight's tunnel URL is a new origin, so every friend starts fresh). Join (I used /voicetest #VFRS with talk_en.wav, whisper.wav and shout.wav) and sample __voiceDebug.band() every 100 ms for 40 s.
  observed: talk_en.wav (normal speech): first 5 s shout 19 vs talk 12 samples; 10-15 s shout 26 vs talk 11; only after about 25 s mostly talk (baseline -30, -27.8, -24.5, -22.5 dBFS). whisper.wav: TALK almost always (0-5 s talk 29 vs whisper 5; still talk 23 vs whisper 2 at 35-40 s), because the default whisper limit is -40 dBFS and the baseline then adapts to the whisper itself. A fresh tone880 relay player also showed up as band 1 (whisper) to peers at first. During this window the HUD tells a normal talker SHOUT, peers and monsters use the 25 m radius, and the training-kennel Hound lunges at what should be talk. Whispering, the main counter to the Hound, fails for a new player.
  expected: A new player talking normally reads TALK and whispering reads WHISPER from the first sentence, or at least the game never reports SHOUT before the baseline has enough evidence.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\cmd\33-fresh-bands.out.txt. Fixture levels (tests\playtest\voice-radio\wavstats.mjs): talk_en median -21 dBFS, whisper -35, shout -8. In mic.ts the default baseDb is -30 (L112). Adaptation needs 80 speech frames (about 8 s of voiced audio, L286) and then moves only 15% every 2 s (L292). Ideas: a more neutral default (about -24), seed the bas
  files: apps/client/src/voice/mic.ts, config/balance/voice.json
- [MEDIUM] Without calibration the adaptive baseline has no bound: a constant shouter becomes TALK after about 30 s  (from: PROXIMITY VOICE, RADIO, VOICE-AS-GAMEPLA)
  repro: A player shouts most of the time (shout.wav, about -8 dBFS; in real life a hot mic, a loud friend or a deliberate exploit). Watch the HUD meter and band(), then stand that player 20 m from a listener in open space.
  observed: Fresh shout.wav: 0-10 s SCREAM/SHOUT (correct). By 30-35 s it reads talk 37 vs shout 2 (baseline -30 moving to -11.4 dBFS). In the 4-player session the Shouter's baseline sat at -9.2 dBFS and its HUD said TALK: 64 talk samples, no shout. At 20 m the Shouter was gated silent (aud 20, gate 0), although a shout should carry 25 m. Monsters use the same band, so constant screaming earns only the 10 m talk radius.
  expected: Shouting stays SHOUT. An uncalibrated baseline stays in a plausible talk range (for example -38 to -18 dBFS), or tracks a lower percentile of speech instead of the median.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\voice-radio\cmd\06-bands.out.txt (Shouter base -9.2, no shout samples). cmd\33-fresh-bands.out.txt (shout drifts to talk). cmd\10-gating.out.txt (Shouter at 20 m: max 0, gate 0, band 2). shots\06-hud-Shouter.png (meter shows TALK). In mic.ts L290-292, seed = cal?.talkDb ?? med, so without calibration the +/-8 dB clamp around seed does nothing and the ba
  files: apps/client/src/voice/mic.ts
- [LOW] A player who mostly whispers on an open mic drifts into 'talk': the adaptive baseline sinks toward the whisper level  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Calibrated player (talk about -21 dBFS, whisper about -35) leaves the mic open and mostly whispers for more than a minute (whisper.wav looping), then whispers near a hound.
  observed: Run 1 (open mic for about 80 s): whisper bands 1,2,1,0,0,1,1,1,0,0,1,2, intermittently TALK (10 m noise). Run 2 (push-to-talk, little speech): 1,0,1,1,1,0,0,1,1,1,1,1, clean. In these runs the hound never visibly reacted to it.
  expected: A whisper stays a whisper. Baseline adaptation should only learn from talk-band frames, or never let whisperMax fall below the calibrated whisper level.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\run1-play.log '[112.9] H1 bob whisper bands: 1,2,1,0,0,1,1,1,0,0,1,2' vs play.log '[104.7] H1 bob whisper bands: 1,0,1,1,1,0,0,1,1,1,1,1'. Code: mic.ts onLevel adaptive baseline (median of all speech frames, clamped to cal.talkDb±8) and thresholds() whisperMax = max(base-10, (base+whisperDb)/2-2).
  files: apps/client/src/voice/mic.ts
- [LOW] (unconfirmed, possibly load) A freshly dead player heard a living teammate at gain 0 while another dead player heard the same speaker at 0.92  (from: MONSTERS, DEATH, SPECTATING, REVIVE)
  repro: Cat has been dead about 30 s, then Ann is killed. 3–8 s after Ann's death, living Bob holds V and talks within 10 m of both spectator cameras.
  observed: cat<-bob gain 0.92, RMS 0.04–0.09; ann<-bob gain 0, RMS 0 in all 4 samples. Bob's client was on the WebGL2 fallback, and LINK read about 1 s on the loaded machine.
  expected: PLAN §3.7: the dead hear the living with normal proximity at the camera.
  evidence: C:\Users\Pieter\repos\theboys\tests\playtest\monsters-death\play2.log 'D control (living Bob talking, heard by the dead)' block. Check the aud distance for a just-died listener (pose source switches to the spectator camera) in apps/client/src/voice/index.ts (route/dist) and net's aud computation.
  files: apps/client/src/voice/index.ts, apps/server/src/net

# Works well (do not break)
- Join screen: clean and on-theme; crew code prefilled from the URL hash; name field easy to edit; ALLOW MICROPHONE gives a 'Microphone OK.' note; consent and AI disclosure are visible; name remembered after a reload.
- Van hub HUD: crew list with voice badges (DIRECT), ready dots, leader star; leader sees 'Pick a work order at the board [B]', others see 'The leader picks…'; 'EVERYONE CONNECTED · LEAVE DISCORD VOICE NOW' banner appears as soon as voice links.
- Board (B key): readable, flavourful order cards; LOCKED stamp states the exact requirement; clicking a card picks it, toasts the crew and updates the other player's HUD ('ORDER: … waiting for Ann, Bob').
- Shop (E from outside the van): clear amber prompt; BUY deducts scrip (150 -> 135), updates YOUR GEAR and toasts the crew.
- Mirror screen: excellent UI; level locks on helmets and visor colours are clear; claim code shown; changes sync live (Bob saw Ann's blue suit and 'ANN' visor glyphs in-world within about 1 s).
- Van console via E: map with player dots, vault-code panel, built-in radio and intercept log are all legible.
- Esc menu: How to play is thorough and readable; Settings apply immediately and persist (exposure to the renderer, preset saved, master volume, sensitivity to players settings).
- R ready-up on both players starts the drive reliably; walkie auto-issued with a 'Hold Q to talk on the radio' hint; the HUD checklist (POWER twin breakers 1 s / VAULT no power / CORE two carriers / SALVAGE 0/7 / Company Requests) is understandable at a glance.
- Leave-now lever prompt ('everyone alive must be in the van') is clear; results screen (ledger, XP reasons, IT HEARD -> IT DID) is readable and auto-returns to the van.
- Reloading recovers a stuck player (they rejoin at the server position with working movement).
- Server log clean apart from the STT sidecar warning: no exceptions over about 30 minutes of play.
- Join flow: the join screen is clean; ALLOW MICROPHONE then CREATE CREW; a friend arrives through the #CODE link and JOIN CREW, lands in the van hub, and voice badges show DIRECT with an 'Everyone connected · leave Discord' banner.
- Lobby: B opens a readable work-order board, clicking a card picks it (with toast 'Ann picked … waiting for …'), the READY UP button and the R key both work, and the van leaves as soon as both are ready. The drive screen shows 3 rule cards, dispatch text and an arrival countdown.
- Pointer lock engages on a canvas click (even headless); mouse look works (0.0022 rad/px); after a modal closes, the 'CLICK TO LOOK AROUND' hint shows.
- Movement: WASD is smooth (about 2.9 m/s walk), C crouch lowers the camera to about 1.0 m at about 1.5 m/s, and Shift sprint has a stamina bar. The walker crossed 3 doors and the whole facility without getting stuck on props.
- Doors: E 'Open door' opens; the keycard pickup ('Pick up Keycard') and 'Unlock with the keycard' on the locked door work.
- Loot: a clear 'Pick up Reading glasses ($31)' prompt with a ring highlight; the van deposit box shows 'Deposit loot' and then 'Deposited 1 item ($31)', and the HUD salvage counter updates.
- Twin breakers: two real E presses 250 ms apart give POWER RESTORED, the checklist ticks and the keypad goes live.
- Van console: a very readable vault code, live player dots, door states and the intercept log; Esc leaves.
- Keypad: E opens the modal; keyboard digits + Enter work, giving ACCESS GRANTED, the vault opens and a banner shows.
- Core: the 'Grab a Core handle (needs 2)' prompt, the one-handle message, and the 'carried' state once both have pressed E; the carry HUD and 'Core: let go (drops it, -15%)' prompt are clear; carry speed is about 1.7 m/s.
- The leave lever ('Leave now (everyone alive must be in the van)') ends the contract instantly. The results ledger is accurate (150 + 31 + 85 = 266, XP +92 each, quota bar), and the hub shows 31/375 and 266 scrip afterwards.
- The store screen is clear, BUY deducts scrip, and gear is listed.
- LMB bottle throw decrements the stack; G drops the active item; 1-4 switch slots; the light switch toggles with a 'Lights off / a lit room shows you, too' prompt; the locker hide shows the slat overlay 'HIDING · STAY QUIET · [E] LEAVE LOCKER', and E exits.
- Stability: the server log has no errors or exceptions for the whole run, there were no client pageerrors, and blocking HMR with routeWebSocket(/token=/) kept both pages alive through several Vite reload broadcasts.
- Push-to-talk from the Esc-menu setting gates the mic correctly: band 0 when idle, 3 while V is held. The SILENT/PTT [V] meter is readable. (A test that sets only localStorage 'deadair.voice.ptt' gets overridden by 'deadair.meta.settings', which is expected because the menu toggle is the source of truth.)
- Hound ignores a whisper plus a crouch-walk 2.4 m away (stays idle, no cues). It growls on alert (growl cue about 126 ms after the noise), barks on wind-up, eats the body, then goes 'out' for about 20 s and respawns far away.
- Bottle lure: LMB throw, smash about 12 m away, 'huff', the hound runs to the impact point and sniffs repeatedly. The inventory hint 'LMB throw (15 m smash: Hound bait)' is clear.
- Death card (INCIDENT REPORT · CONTRACTOR DECEASED) is readable and explains the cause, the distance and both revive options. The Listener card quotes the overheard line, who said it and how long ago ('heard "boiler, meat in boiler" · Cat's voice, 22 s ago').
- Results screen: death cards ('HOUND heard Ann's SHOUT · 3 m'), 'died (for science) +10' XP, badge fines and CREW LOST all read well and are funny.
- Spectating: 'STATIC // SPECTATING · following Bob · click to cycle' follows a living teammate. LMB cycles Ann → Bob → Ann once the pointer is locked (the first click locks), and nameplates are hidden while following. The revive countdown text is correct.
- Dead voice: living players get gain 0 from the dead; the dead hear each other in 2D (RMS up to 0.22) and hear living players by proximity (gain 0.92).
- Medkit revive: 'E Revive Ann (medkit) · 10 s left' over the body with a ring; E revives at 50% HP within the window (+12.7 s) with the toast 'Someone patched you up (50% HP)'.
- Listener signature loop: Whisper large-v3-turbo transcribed the callsign, the fuzzy normaliser matched BOILER, and the line went into memory as meaningful. On wake: all rooms flicker, walkie LEDs flash, walkies squelch, a BOILER room telegraph, an INTERCEPT event and the decision log line 'it heard ... -> searched BOILER'. 'Lure it with a lie' completed with the toast 'it went to BOILER and found nobody'.
- Listener grab: only grabs a lone player; red vignette plus 'IT HAS YOU — SCREAM FOR HELP'; kills after 3 s and then retreats ('out').
- Mannequin: the risk-2 order unlocks at crew level 2 and the mannequin agent exists. It stays frozen while one or two players watch it lit, including lit only by a teammate's flashlight in a dark room. Unwatched it moves at about 6.3 m/s and kills within 1.4 s ('nobody was watching it'), then retreats. The visor blink is a clear near-black frame.
- Visuals: the Listener (glossy black, elongated) is genuinely creepy lit, dark and in the flashlight (shots/45-47). The hound reads well in fog (shots2/A1). Lit halls look good.
- Stability: zero client console errors (__game.errors()) in every run and no server exceptions. The only server warning was a momentary 'STT sidecar not reachable' under shared load, which recovered by itself.
- Mic constraints hold on every client: echoCancellation on, noiseSuppression on, autoGainControl off (micSettings); the join screen's Allow Microphone and gain/band readout work through the real UI.
- Mesh without stalls: all pairs connect directly (host candidates); Tone2, launched after Tone closed its tab, linked to all 3 others in under 8 s; the 15 s grace window after a tab closes worked.
- 1:1 distance gating with talk band: 2 m audible (gate 0.96), 8 m audible (gate 0.62), 20 m fully silent (gate 0); server path distances (aud) match the placements.
- HRTF plus stereo-width panning: about 8 dB level difference toward the correct side, and sides swap when the listener turns 180 degrees.
- Closed door through real E input: aud 9 m, -35.9 dB and muffled when closed; aud 4 m, -26.5 dB when opened; the 'E Open door' prompt is clear.
- Van seal logic is correct per the design: inside to inside audible, inside to outside 255 both ways.
- Walkie: a holder heard 40 m away over the 2D radio chain (left and right equal, squelch); a non-holder standing next to the receiver hears nothing; gated again after release; the TX HUD reads 'TALK ● TX' / 'TX · RADIO'; Q without a walkie does nothing; releasing Q during Esc, or a window blur, resets TX (no stuck PTT).
- Dead channel: the living never hear the dead (route mute); the dead hear the living at the spectator camera; dead to dead is 2D; the dead lose their walkie, so no dead radio; the server ignores dead voices for monsters (runtime.ts uses isAlive).
- TURN relay: credentials minted from the CLOUDFLARE_* aliases ('TURN credentials minted (2 ice server entries, relay=true)'); :53 URLs filtered and turns:443 present; with relay=1 all 4 links show connected/relay, bytes flow and audio is heard both ways at normal levels.
- /voicetest at 390x844: clean, readable layout; typing a crew code and tapping JOIN VOICE works; peers show DIRECT (host) badges and live levels.
- Voice-as-gameplay chain end to end: the shared speech-to-text sidecar transcribed the fixtures, the Listener killed the isolated Talker with a clear death card ('heard "meet me in the boiler room"'), and the 'Lure it with a lie' request completed.
- Blocking Vite HMR with routeWebSocket on non-/ws sockets kept every test page stable while other agents edited files (the server log shows many page reloads that never reached my pages).
- Six players (4 Chrome + 2 ws bots) join. The 7th is refused server-side with crew_full for both a Chrome and a bot.
- Leader leaves mid-hub: leadership passes to the next-earliest connected player at once (roster 'Ann(away) *Bob'). Bob's board says 'You are the crew leader' and his pick applies. When Ann returns within 90 s she resumes with the same id and is leader again, and Bob's pick stays.
- Leader leaves mid-contract: the new leader (Bob) can press 'BACK TO THE VAN' on results. Note: the server saw that closing tab only 22 s later (the hub close took under 1 s), and the 64 KB backpressure guard skipped 113 snapshots to the dead socket, as designed.
- Picks are race-free: only the leader's click counts.
- Server restart mid-hub: all clients auto-reconnect in ~3.8 s with resume tokens. Crew RBST is restored, the leader order is preserved, and shift, scrip and quota come back from the saves. Bots reconnect too.
- Server restart mid-contract: clients reconnect in 2.6 s into the van with the hub layout. The contract is voided with no penalty (contract counter and scrip unchanged).
- Reload mid-contract: same player id, position kept, inventory kept (walkie, crowbar, bottle x3 before and after; shot 34). Mid-contract joiner Fay spawns on the van spawn line (~5 m from the van), alive, with the contract HUD.
- beforeunload guard in the contract (?guard=1 in test mode): the dialog appears and 'stay' keeps the tab open.
- Tab frozen for 60 s (CDP lifecycle freeze; headless keeps tabs 'visible'): the socket stays up and the server keeps the player connected. State resyncs within 3 s (snapHz back to 19.8) and the pause menu opens on return because pointer lock was lost.
- Spamming E/LMB/Q/G/1-4/R/B/Esc/T/F/C/Tab in the hub and the contract causes no errors or exceptions, only a 'Nothing there' toast. R toggles ready cleanly (true, then false).
- C crouches (stance 1 while held); nothing needs Ctrl.
- Kick from the contract roster UI works ('removed by Ann'), and the freed slot lets a new player join.
- Wipe goes to results (CREW LOST, death cards, fines, XP) immediately when all connected players die. With one survivor offline, the contract still wipes after the 20 s offlineWipeGraceSec instead of waiting out the 90 s hold. Death card and spectate (STATIC // SPECTATING, following Bot5) are clear.
- Server health: no exceptions or stack traces in ~25 min across 5 boots. Memory 129-228 MB per instance and 131 to 140 MB over the 8.5 min soak (no leak). Tick ~29.9 Hz, snapshots ~19.8 Hz, bot clients receive 20 Hz.
- The new main menu (invite link opens PLAY with the code prefilled and JOIN CREW focused) works with the existing join flow.