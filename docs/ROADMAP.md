# DEAD AIR: roadmap after tonight

> The current, ranked plan is the night review of 8–9 Oct 2026: [docs/research/2026-10-09-night/synthesis.md](research/2026-10-09-night/synthesis.md) ("Next sessions backlog"). This file is the older idea list from 6 Oct; several of its monsters and gear have shipped since.

Today's build: three monsters (Hound, Mannequin, Listener), AI briefs, the HR memo, the Listener's brain (JEV, then Haiku, then rules), proximity voice and radio, procedural facilities, and a quota/XP loop. This file collects the ideas that come next, roughly in order of fun per hour of work.

## Monsters (each forces a different kind of teamwork)

| Monster | Mechanic | Counterplay / teamwork |
|---|---|---|
| **The Snatcher** | Drops from a vent onto a player who is alone and drags them into the ducts. | Buddy system. Teammates follow the drag trail and pull the victim out within 20 s. |
| **The Dimmer** | Exists only in unlit rooms. Flashlights stutter near it and it drains batteries. | Restore power, carry flares, assign a light bearer. Light repels it. |
| **The Visual Mimic** | Wears a dead teammate's suit and visor glyphs and walks next to you. | Learn the tells: one wrong glyph, no flashlight shadow, missing from the console map. Use passphrases. |
| **The Static** | Lives in radios. Too many walkie transmissions in a short window and it manifests at the transmitter. | Ration radio use, keep messages short, pick one radio lead. |
| **The Tenant** | One room per site belongs to it. Taking loot from that room starts a relentless hunt on the thief. | Greed versus safety. The thief has to drop the loot or be escorted out. |
| **The Weeper** | Sounds like a crying child. Approached with the flashlight off, it's safe; with it on, it screams and charges. | Rules that run against instinct, shouted across the team. |
| **The Hoarder** | Steals unattended loot and hoards it in a nest. Harmless unless cornered. | The nest is a jackpot. Bait it away, then raid the nest. |
| **The Choir** | Whispering shapes drawn to *overlapping* voices. | Turn-taking on comms; one person talks at a time. |
| **The Doppel-Operator** | Hijacks the van intercom once the operator leaves the console and gives false directions (AI-written). | Keep someone on the console and verify calls. |

## AI components

1. **The Listener speaks.** Claude writes short situational lures ("I found the vault, come to BOILER"), and ElevenLabs renders them in a distorted radio voice. The key is already in `.env`. Later: consent-based cloned teammate voices.
2. **The Company terminal.** Type to The Company. Claude answers in character, sells hints for scrip, and lies when it's profitable.
3. **AI dispatcher for small crews.** With 2 players, an AI operator (Claude + an ElevenLabs voice) reads the map and guides you. The Listener can hijack it.
4. **Persistent lore.** Sites, people and your past deaths come back in later notes ("Contractor Pieter's badge was found here last week").
5. **Director personality.** Each night gets a theme ("the lights hate you tonight") and the AI tunes difficulty to the crew's skill.
6. **Night recap card.** An AI incident report with stats, best quotes, the deaths and an "employee of the month", shareable in Discord.
7. **Spirit radio gadget.** Ask the Listener questions out loud. It answers through the radio with lies and half-truths, and one of them contains a real clue.
8. **The Intern (escort NPC).** Panics, has to be calmed down verbally (STT + Claude), and cries when left alone, which draws the Hound.
9. **AI sound design.** ElevenLabs sound effects generated per site or monster variant, so every facility sounds different.

## Mini-games, upgrades, special gear

**Mini-games (built around talking and teamwork):**
- *Safe-cracking by ear.* Turn the dial and listen for clicks through the headset while teammates stay silent. Reward: cash or a special item.
- *Wire splice.* One player sees the wires, the other has the manual on the van console, and they talk it through (Keep Talking and Nobody Explodes style).
- *Pressure valves.* Two players balance two valves in separate rooms over the radio.
- *Terminal hack.* Type command sequences under time pressure to open a security wing.
- *Van arcade cabinet* for dead players and the hub.

**Shop upgrades:** Pro flashlight (tier II beam), headlamp (hands-free), flares, motion sensors (blips on the console), hand truck (one-person Core carry, slow and loud), battery pack, encrypted walkie channel (the Listener can't overhear it, but it has a short range), lockpick set, and van upgrades (CCTV feeds, reinforced doors, an earlier horn).

**Special finds (rare, deep in the facility):**

| Find | Effect |
|---|---|
| Night-vision goggles | Green night-vision post effect, on a battery |
| Adrenaline syringe | 15 s of sprint without stamina drain |
| Lucky charm | +10% haul value |
| Cursed idol | Huge value, but every monster gets restless |
| Spirit radio | Hear the Listener's next intent once |
| Gas mask | Needed for toxic wings |
| Master keycard | Opens one locked door |

## Taking it to the next level (platform)

| Phase | What | Why | Effort |
|---|---|---|---|
| **A: Stable hosting** (next session) | Run the server on a small VPS near the crew (e.g. Hetzner, about €5/month) or a named Cloudflare tunnel on your own domain. Put the assets on a CDN. | A permanent link that doesn't depend on the host PC or its Wi-Fi. Friends can play without you hosting. | 1–2 h |
| **B: Desktop app + Steam** | Wrap the same game in Electron or Tauri and add steamworks.js (invites, overlay, achievements). Ship through Steam Playtest. | A real "game" feel and Steam friend invites. Same codebase, same graphics. | 1–2 days + $100 Steam fee |
| **C: Engine upgrade** (only if the group keeps playing) | A native Godot 4.8 client (SDFGI global illumination, volumetric fog) talking to the **same Node server**, or Unreal 5 with a human working in the editor. | The biggest fidelity jump. It means rewriting the client; the server, AI and procgen carry over. | 2–4 weeks with agents (Godot), months (Unreal) |
| **Art pass** (any phase) | Custom monster models (AI-generated with Meshy/Tripo, then rigged), hand-made set-piece rooms, higher-res textures, baked light probes. | In horror, art and lighting beat engine features. This is the cheapest visible upgrade. | ongoing |

**Recommendation:** A, then B soon. That gives a permanent link, a desktop app and Steam invites with no rewrite. Only take on C if the game is still being played in a few weeks.
