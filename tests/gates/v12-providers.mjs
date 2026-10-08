#!/usr/bin/env node
// Gate G (v1.2): the real cross-package providers of PLAN.md section 13 exist and none of the MUST ones still behaves
// like its contract stub. Boots the whole server in-process (dev mode, all 12 tracks) on PORT (default 3892) with a
// scratch SAVES_DIR / SESSION_FILE, drives one crew through the real meta flow (hub -> drive -> contract) with two
// ws bots and calls the server APIs on the live Crew object:
//   interaction (G3): onItemEvent (a real 'acquire' reaches a subscriber), takeVanMaterials / vanMaterials (a pouch in
//     the van is counted, then taken), stockContainer (a real container takes a private item; an unknown id refuses),
//     hideIn / unhide, hasInteractHandler for container, workbench, stash, records, fieldguide and bulletin
//   monsters (G2): onMonsterEvent (a grab reaches a subscriber), isGrabbed, ventInUse bound, ListenerDecision.speakerId
//   meta (G4/G5): poolAdd / poolView (units land, the cap refuses), updatePlayerSave, recordStat, unlocks
//   paranormal (E4): onPhenomenon (a fired phenomenon ends with a record), setLoreTargets (the state takes the ids)
//   players (G1): stealthStance (a fake hidden claim is not trusted); level (E1): generateFacilityForCrew(theme)
// plus a static check that the client services expose the section 13 names (the browser half is gate R).
// Run: node tests/gates/v12-providers.mjs      (exit 0 = every check passed; never touches :3000 or saves/)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, ROOT, bootServer, crewCode, recorder, sleep, waitFor } from './v12lib.mjs';

const PORT = Number(process.env.PORT ?? 3892);
const { results, check, guard, summary } = recorder();

// ---------------------------------------------------------------- static: client services (gate R runs them)
const CLIENT = {
  'E3-env-world': { dir: 'apps/client/src/level', names: ['stations', 'stationObject', 'setVanUpgrades', 'containers', 'setContainerOpen', 'containerOpen', 'containerAnim', 'setContainerProgress', 'containerPartMatrix', 'loreSpots', 'setLorePage', 'setDoorProgress', 'rattleDoor', 'surfaceAt', 'propHandle', 'mirrorOf'] },
  'E2-env-render': { dir: 'apps/client/src/render', names: ['layers', 'brownout', 'failSpace', 'fixtureCurve', 'fixtureLevels', 'mirrors', 'setFogVolumes', 'puff', 'beams', 'beamInterference', 'ambientAt', 'coverMode', 'setNightVision'] },
  'G1-players-stealth': { dir: 'apps/client/src/players', names: ['setMirrorSelf', 'setFlashlightEnabled', 'ctrlCrouch'] },
  'G3-interaction-gear': { dir: 'apps/client/src/interaction', names: ['holds'] },
  'E4-env-paranormal': { dir: 'apps/client/src/paranormal', names: ['settings', 'setSettings'] },
  'E5-env-audio': { dir: 'apps/client/src/audio', names: ['synth', 'fear', 'setFear'] },
};
function srcOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && e.name !== 'api.ts' && e.name !== 'types.ts') out.push(readFileSync(join(ROOT, p), 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}
for (const [pkg, { dir, names }] of Object.entries(CLIENT)) {
  const src = srcOf(dir);
  const missing = names.filter((n) => !new RegExp(`(^|[\\s{,])${n}\\s*(\\(|:|,|\\n|\\})`, 'm').test(src));
  check(pkg, `client ${dir.split('/').pop()} service implements ${names.length} section-13 names (static)`, !missing.length, missing.length ? `missing: ${missing.join(', ')}` : '');
}

// ---------------------------------------------------------------- boot in-process
const { srv, ctx } = await bootServer(PORT, 'v12-providers-');
check('integrator', 'all 12 server tracks install without errors', srv.installErrors.length === 0, srv.installErrors.map((e) => e.split(/\r?\n/)[0]).join(' | '));

const IX = await import('../../apps/server/src/interaction/api.ts');
const MON = await import('../../apps/server/src/monsters/api.ts');
const META = await import('../../apps/server/src/meta/api.ts');
const PARA = await import('../../apps/server/src/paranormal/api.ts');
const PLAYERS = await import('../../apps/server/src/players/api.ts');
const LEVEL = await import('../../apps/server/src/level/index.ts');
const { STANCE } = await import('../../packages/shared/src/state.ts');
const { containersOf } = await import('../../packages/shared/src/procgen/containers.ts');
const { stationOf } = await import('../../packages/shared/src/procgen/van.ts');
const { POOL_TYPES, POOL_STACK } = await import('../../packages/shared/src/catalog.ts');
const CODE = crewCode('G');
const A = new Bot('Ada'), B = new Bot('Bea');
let crew = null;
try {
  await A.connect(srv.port, CODE);
  await B.connect(srv.port, CODE);
  crew = ctx.crews.get(CODE);
  check('integrator', 'crew exists in-process', !!crew && crew.players.size === 2, crew ? `${crew.players.size} players, phase ${crew.phase}` : 'none');

  // ---------------------------------------------------------------- hub
  await guard('G3-interaction-gear', 'hasInteractHandler', async () => {
    const kinds = ['container', 'workbench', 'stash', 'records', 'fieldguide', 'bulletin'];
    const owner = { container: 'G3-interaction-gear', workbench: 'G5-workshop', stash: 'G5-workshop', records: 'G4-meta-records', fieldguide: 'G6-fieldguide', bulletin: 'G6-fieldguide' };
    for (const k of kinds) check(owner[k], `hasInteractHandler('${k}')`, IX.hasInteractHandler(k) === true);
    check('G3-interaction-gear', "hasInteractHandler('no_such_kind') is false", IX.hasInteractHandler('gate_no_such_kind') === false);
  });

  await guard('G1-players-stealth', 'stealthStance', async () => {
    const p = crew.players.get(A.id);
    const was = p.pose.stance;
    p.pose.stance = STANCE.hidden; // a claim without a real hiding spot
    const s = PLAYERS.stealthStance(crew, A.id);
    p.pose.stance = was;
    check('G1-players-stealth', 'stealthStance is bound (a fake hidden claim is not trusted)', s !== STANCE.hidden, `claim hidden -> ${s}`);
  });

  await guard('G4-meta-records', 'pool', async () => {
    const type = POOL_TYPES.includes('flare') ? 'flare' : POOL_TYPES[0];
    const before = META.poolView(crew, A.id);
    const r = META.poolAdd(crew, A.id, type, 1);
    const after = META.poolView(crew, A.id);
    check('G4-meta-records', `poolAdd(${type}, 1) ok and poolView shows it`, r.ok === true && (after.units[type] ?? 0) === (before.units[type] ?? 0) + 1, `${JSON.stringify(r)} ${before.units[type] ?? 0} -> ${after.units[type] ?? 0}, slots ${after.slots}/${after.maxSlots}`);
    const big = META.poolAdd(crew, A.id, 'crowbar', 99);
    check('G4-meta-records', 'poolAdd past the slot cap refuses with a reason', big.ok === false && !!big.reason, JSON.stringify(big));
    const bad = META.poolAdd(crew, A.id, 'gate_not_gear', 1);
    check('G4-meta-records', 'poolAdd of a non-pool type refuses', bad.ok === false, JSON.stringify(bad));
    check('G4-meta-records', 'poolView.maxSlots = 8 slot-equivalents', after.maxSlots === 8 && typeof POOL_STACK === 'object', String(after.maxSlots));
  });

  await guard('G4-meta-records', 'updatePlayerSave / playerSave', async () => {
    const ok = META.updatePlayerSave(crew, A.id, (sv) => { sv.collection = { ...(sv.collection ?? {}), 'gate.probe': { at: new Date().toISOString(), site: 'GATE', crew: CODE } }; });
    const sv = META.playerSave(crew, A.id);
    check('G4-meta-records', 'updatePlayerSave writes and playerSave reads it back', ok === true && !!sv?.collection?.['gate.probe'], `ok ${ok}`);
  });

  await guard('G4-meta-records', 'recordStat', async () => {
    const before = META.playerSave(crew, A.id)?.stats?.itemsUsed?.flare ?? 0;
    META.recordStat(crew, A.id, 'itemsUsed.flare', 2);
    const after = META.playerSave(crew, A.id)?.stats?.itemsUsed?.flare ?? 0;
    check('G4-meta-records', 'recordStat in the hub lands in the save (itemsUsed.flare +2)', after === before + 2, `${before} -> ${after}`);
  });

  await guard('G5-workshop', 'unlocks', async () => {
    const r = await A.dbg('workshop.unlock', { id: 'scanner' });
    const u = META.unlocks(crew);
    check('G5-workshop', "unlocks() returns the crew's van upgrades (G5 craftView, read by G3)", u.includes('scanner'), `${JSON.stringify(r)} -> ${JSON.stringify(u)}`);
    await A.dbg('workshop.unlock', { id: 'scanner', remove: true });
  });

  await guard('E1-env-layout', 'generateFacilityForCrew(theme)', async () => {
    const L = LEVEL.generateFacilityForCrew(crew, { seed: 'gate-theme', players: 2, risk: 1, theme: 'hospital', modifiers: [] });
    check('E1-env-layout', 'generateFacilityForCrew honours a theme', L?.theme === 'hospital' || L?.theme?.id === 'hospital', `theme ${JSON.stringify(L?.theme)}`);
    check('E1-env-layout', 'themed layout has containers, stations and lore spots', containersOf(L).length > 0 && !!stationOf(L, 'workbench'), `${containersOf(L).length} containers`);
  });

  // ---------------------------------------------------------------- contract through the real meta flow
  const order = A.full?.workOrders?.find((o) => o.available) ?? A.full?.workOrders?.[0];
  if (!order) throw new Error('no work order on the board');
  await A.req('meta.pick', { orderId: order.id });
  await A.req('meta.ready', { ready: true });
  await B.req('meta.ready', { ready: true });
  check('G4-meta-records', 'pick + ready -> drive', await A.waitPhase('drive', 15000), A.phase);
  await sleep(200);
  await A.dbg('meta.skipDrive');
  check('G4-meta-records', 'skipDrive -> contract', await A.waitPhase('contract', 60000), A.phase);
  await sleep(600);
  const L = crew.layout;
  check('G4-meta-records', 'currentOrder() is the picked order', META.currentOrder(crew)?.id === order.id, META.currentOrder(crew)?.id ?? 'null');

  // ---- interaction
  await guard('G3-interaction-gear', 'onItemEvent', async () => {
    const got = [];
    const off = IX.onItemEvent((c, e) => { if (c === crew) got.push(e); });
    const it = IX.giveItem(crew, A.id, 'flare', { via: 'api' });
    off();
    check('G3-interaction-gear', "onItemEvent: giveItem publishes 'acquire' to subscribers", !!it && got.some((e) => e.kind === 'acquire' && e.pid === A.id && e.type === 'flare'), JSON.stringify(got.slice(0, 2)));
  });

  await guard('G3-interaction-gear', 'takeVanMaterials', async () => {
    const wb = stationOf(L, 'workbench');
    const dx = wb.p[0] - wb.x, dz = wb.p[2] - wb.z, l = Math.hypot(dx, dz) || 1;
    await A.dbg('interaction.pose', { x: wb.x + (dx / l) * 0.9, z: wb.z + (dz / l) * 0.9, yaw: 0 });
    await sleep(150);
    IX.giveItem(crew, A.id, 'mat.wiring', { count: 2 });
    const pouch = IX.pouchOf(crew, A.id);
    const seen = IX.vanMaterials(crew);
    const taken = IX.takeVanMaterials(crew);
    const again = IX.takeVanMaterials(crew);
    check('G3-interaction-gear', 'pouchOf shows a given material', (pouch['mat.wiring'] ?? 0) >= 2, JSON.stringify(pouch));
    check('G3-interaction-gear', 'vanMaterials counts the pouch of a player in the van', (seen['mat.wiring'] ?? 0) >= 2, JSON.stringify(seen));
    check('G3-interaction-gear', 'takeVanMaterials returns it once, then nothing', (taken['mat.wiring'] ?? 0) >= 2 && !again['mat.wiring'], `${JSON.stringify(taken)} then ${JSON.stringify(again)}`);
  });

  await guard('G3-interaction-gear', 'stockContainer', async () => {
    const list = containersOf(L);
    const c = list[0];
    check('E1-env-layout', 'the contract site has containers', list.length > 0, `${list.length}`);
    const ok = c ? IX.stockContainer(crew, c.id, { type: 'bottle', name: 'gate probe', value: 1 }) : false;
    const bad = IX.stockContainer(crew, 'prop:gate-nope', { type: 'bottle' });
    check('G3-interaction-gear', 'stockContainer takes a private item into a real closed container', ok === true, c?.id ?? 'none');
    check('G3-interaction-gear', 'stockContainer refuses an unknown container', bad === false);
  });

  await guard('G3-interaction-gear', 'hideIn', async () => {
    const vent = L.items.find((i) => i.kind === 'vent');
    const spot = vent ? `duct:${vent.id}` : 'duct:gate';
    const ok = IX.hideIn(crew, B.id, spot);
    const hid = IX.isHidden(crew, B.id) && IX.hiddenIn(crew, B.id) === spot;
    const st = PLAYERS.stealthStance(crew, B.id);
    IX.unhide(crew, B.id);
    check('G3-interaction-gear', 'hideIn hides (isHidden, hiddenIn) and unhide ends it', ok === true && hid && !IX.isHidden(crew, B.id), `${spot} ok ${ok}`);
    check('G1-players-stealth', 'stealthStance reads hidden while really hidden', st === STANCE.hidden, String(st));
  });

  // ---- paranormal
  await guard('E4-env-paranormal', 'setLoreTargets', async () => {
    const { loreSpotsOf } = await import('../../packages/shared/src/procgen/lore.ts');
    const spots = loreSpotsOf(L).slice(0, 2).map((s) => s.id);
    PARA.setLoreTargets(crew, spots);
    const st = await A.dbg('paranormal.state');
    check('E4-env-paranormal', 'setLoreTargets reaches the paranormal state', spots.length > 0 && JSON.stringify(st.lore) === JSON.stringify(spots), `${JSON.stringify(spots)} -> ${JSON.stringify(st.lore)}`);
    check('E4-env-paranormal', 'paranormalQuietUntil is a number', typeof PARA.paranormalQuietUntil(crew) === 'number');
  });

  await guard('E4-env-paranormal', 'onPhenomenon', async () => {
    const recs = [];
    const off = PARA.onPhenomenon((c, r) => { if (c === crew) recs.push(r); });
    // phenomena need a placement that fits (indoor, not the van): walk A over indoor cells like E4's sync test does,
    // with the other bot parked far away (lone target)
    const { indoor } = await import('../../apps/server/src/paranormal/gates.ts');
    const cells = [];
    for (let c = 0; c < L.owner.length; c++) {
      const s = L.owner[c];
      if (s >= 0 && indoor(L, s)) cells.push([(c % L.W) + 0.5, Math.floor(c / L.W) + 0.5]);
    }
    const [bx, bz] = cells[(997 + 13) % cells.length];
    await A.dbg('interaction.pose', { pid: B.id, x: bx, z: bz, yaw: 0, light: 0 });
    let fired = null, why = '', tries = 0;
    outer: for (const kind of ['knock', 'handle_rattle', 'cold_spot']) {
      for (let i = 0; i < cells.length && tries < 160; i += 7, tries++) {
        await A.dbg('interaction.pose', { pid: A.id, x: cells[i][0], z: cells[i][1], yaw: [0, Math.PI / 2, Math.PI, -Math.PI / 2][i % 4], light: 1 });
        await A.dbg('paranormal.tune', { lastAgoSec: 60, clearBudgets: true });
        const r = await A.dbg('paranormal.fire', { kind, target: A.id, force: true }).catch((e) => ({ ok: false, reason: e.message }));
        if (r?.ok) { fired = kind; break outer; }
        why = r?.reason ?? why;
      }
    }
    const rec = fired ? await waitFor(() => recs.find((r) => r.kind === fired), 30000, 100) : null;
    off();
    check('E4-env-paranormal', 'a forced phenomenon fires (dbg.paranormal.fire)', !!fired, fired ? `${fired} after ${tries + 1} spots` : `nothing fit in ${tries} spots: ${why}`);
    check('E4-env-paranormal', 'onPhenomenon gets its record when it ends (G4, G6 consume it)', !!rec, rec ? `${rec.kind} tier ${rec.tier}, witnesses ${rec.witnesses.length}` : 'no record in 30 s');
    check('E4-env-paranormal', 'phenomena() lists ended records', PARA.phenomena(crew).length >= (rec ? 1 : 0) && (!rec || PARA.phenomena(crew).some((r) => r.id === rec.id)));
  });

  // ---- monsters
  await guard('G2-monsters-fair', 'ventInUse', async () => {
    const vent = L.items.find((i) => i.kind === 'vent');
    const src = readFileSync(join(ROOT, 'apps/server/src/monsters/index.ts'), 'utf8');
    check('G2-monsters-fair', 'ventInUse and isGrabbed are bound in the monsters impl', /ventInUse:\s*\(/.test(src) && /isGrabbed:\s*\(/.test(src) && /bindMonstersImpl\(/.test(src));
    check('G2-monsters-fair', 'ventInUse returns false while no snatch or vent trip runs', MON.ventInUse(crew, vent?.id ?? 'vent:0') === false);
  });

  await guard('G2-monsters-fair', 'speakerId', async () => {
    const decs = [];
    const off = MON.listener.onDecision((c, d) => { if (c === crew) decs.push(d); });
    const pos = MON.monsterPositions(crew);
    const lis = pos.find((m) => m.kind === 'listener');
    check('G2-monsters-fair', 'monsterPositions lists the Listener', !!lis, JSON.stringify(pos.map((m) => m.kind)));
    if (lis) {
      await A.dbg('monsters.place', { id: lis.id, state: 'patrol', active: true }).catch(() => null);
      await sleep(3300); // decision cooldown
      const cs = L.spaces.find((s) => s.callsign && s.callsign !== 'VAN' && s.callsign !== 'LOBBY')?.callsign ?? 'STORES';
      await A.dbg('monsters.utter', { segId: 'gate-1', text: `ok everyone meet in the ${cs.toLowerCase()} now`, listener: true });
      const d = await waitFor(() => decs.find((x) => x.speaker), 8000, 100);
      check('G2-monsters-fair', 'ListenerDecision.speakerId = the speaker it heard', d?.speakerId === A.id, d ? `${d.action} speaker ${d.speaker} id ${d.speakerId}` : `no decision (${decs.length} without a speaker)`);
    }
    off();
  });

  await guard('G2-monsters-fair', 'onMonsterEvent + isGrabbed', async () => {
    const evs = [];
    const off = MON.onMonsterEvent((c, e) => { if (c === crew) evs.push(e); });
    const r = await A.dbg('monsters.grab', { id: B.id, knockdown: true });
    await sleep(300);
    const g = MON.isGrabbed(crew, B.id);
    const ev = await waitFor(() => evs.find((e) => (e.event ?? e.kind) === 'grab' || (e.event ?? e.kind) === 'knockdown'), 3000);
    off();
    check('G2-monsters-fair', 'isGrabbed reports the Listener grab', g === 'listener', `grab ${JSON.stringify(r?.ok)} -> ${g}`);
    check('G2-monsters-fair', 'onMonsterEvent delivers grab / knockdown to subscribers', !!ev, ev ? JSON.stringify(ev) : JSON.stringify(evs.slice(0, 3)));
    check('G2-monsters-fair', 'isGrabbed is null for a free player', MON.isGrabbed(crew, A.id) === null);
  });
} catch (e) {
  check('integrator', 'run', false, e instanceof Error ? e.stack : String(e));
} finally {
  A.close();
  B.close();
  await sleep(200);
  await srv.close().catch(() => undefined);
}

const nFailed = summary();
process.exitCode = nFailed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 1500).unref();
