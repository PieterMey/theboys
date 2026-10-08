#!/usr/bin/env node
// Gate G (v1.2): the flag kill switches. For each v1.2 flag the global server flag (ctx.flags, what config/flags.json +
// SIGHUP / dbg.reloadConfig set) is switched off in-process and the related v1.1 behaviour must come back; switched on
// again, the v1.2 behaviour returns. Each case runs on a fresh crew of the in-process server (PORT, default 3893):
//   stealthV12        a crouch claim at 3.5 m/s: v1.2 walk steps / v1.1 flat 1.5 m crouch steps; stealthStance = claim
//   listenerFairV12   a Listener grab: v1.2 struggle (mash E) works / v1.1 grab has no struggle; drive rule card text
//   containers        cont: interactables + stockContainer / none, refused, loot budget back on the floor
//   easeDoors         interaction.ease on a door starts a hold / is refused (off) and a tap opens the door
//   siteThemes        a themed work order's contract layout carries the theme / is the plain facility
//   paranormal        a forced phenomenon fires / is refused ('disabled') and the api trigger is false
//   crawlVents        crawl: interactables / none;  crafting: meta.workbench works / is refused
//   fieldGuide        fg: shelf interactable / none
//   mirrors           client-only (render): static check that the flag gates the live reflector (gate R runs it)
// Run: node tests/gates/v12-flags.mjs      (exit 0 = every check passed; flags are restored at the end)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, ROOT, bootServer, crewCode, recorder, sleep, toContract, waitFor } from './v12lib.mjs';

const PORT = Number(process.env.PORT ?? 3891);
const { check, guard, summary } = recorder();

// ---------------------------------------------------------------- static: client-only flags
await guard('E2-env-render', 'mirrors flag (static)', async () => {
  const idx = readFileSync(join(ROOT, 'apps/client/src/render/index.ts'), 'utf8');
  const mir = readFileSync(join(ROOT, 'apps/client/src/render/mirrors.ts'), 'utf8');
  check('E2-env-render', "render passes flags.mirrors into the mirror system ('enabled')", /enabled:\s*ctx\.flags\.mirrors !== false/.test(idx));
  check('E2-env-render', 'mirror system: enabled=false means a zero live budget (fallback glass only)', /d\.enabled\s*&&\s*!suspended\s*\?\s*d\.budget\(\)\s*:\s*\{\s*live:\s*0/.test(mir));
  // E2's fix round renamed the gate (`liveBudget = ...` -> `liveMirrorBudget = () => ...`): the warm set's mirror
  // rooms come from it (none when the flag is off) and the automatic mirror warm ends at once without it
  const budgetGate = /liveBudget\s*=\s*ctx\.flags\.mirrors !== false/.test(idx)
    || (/liveMirrorBudget\s*=\s*\(\)\s*=>\s*ctx\.flags\.mirrors !== false/.test(idx)
      && /reg\s*=\s*liveMirrorBudget\(\)\s*\?\s*mirrorSys\.spaces\(\)\s*:\s*\[\]/.test(idx)
      && /if\s*\(!liveMirrorBudget\(\)\s*\|\|\s*mirrorSys\.list\(\)\.length === 0\)\s*\{\s*mirrorWarm\.state = 'done'/.test(idx));
  check('E2-env-render', 'warm set skips the reflection when the flag is off', budgetGate);
});

const { srv, ctx } = await bootServer(PORT, 'v12-flags-');
check('integrator', 'all 12 server tracks install without errors', srv.installErrors.length === 0, srv.installErrors.map((e) => e.split(/\r?\n/)[0]).join(' | '));
const ORIGINAL = { ...ctx.flags };
const setFlag = (name, on) => { ctx.flags[name] = on; };

const IX = await import('../../apps/server/src/interaction/api.ts');
const PARA = await import('../../apps/server/src/paranormal/api.ts');
const PLAYERS = await import('../../apps/server/src/players/api.ts');
const { STANCE } = await import('../../packages/shared/src/state.ts');
const { containersOf } = await import('../../packages/shared/src/procgen/containers.ts');
const { stationOf } = await import('../../packages/shared/src/procgen/van.ts');
const { indoor } = await import('../../apps/server/src/paranormal/gates.ts');

const open = [];
async function fresh(n, prefix) {
  const code = crewCode(prefix);
  const bots = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot(['Ada', 'Bea', 'Cal'][i]);
    await b.connect(srv.port, code);
    bots.push(b);
    open.push(b);
  }
  return { bots, crew: ctx.crews.get(code) };
}
const done = (bots) => { for (const b of bots) b.close(); };
const themeId = (L) => (typeof L?.theme === 'string' ? L.theme : L?.theme?.id) ?? 'facility';
const owner = (L, x, z) => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
};
/** a closed plain door and a walkable stand spot 0.75 m beside it (corridor side first) */
function closedDoor(L) {
  for (const d of L.doors.filter((q) => q.kind === 'door' && !q.initiallyOpen)) {
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2;
    const cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    const sides = d.dir === 'v' ? [[cx - 0.75, cz], [cx + 0.75, cz]] : [[cx, cz - 0.75], [cx, cz + 0.75]];
    const ok = sides.filter(([x, z]) => owner(L, x, z) >= 0);
    if (ok.length) return { door: d, stand: ok[0], id: `door:${d.id}` };
  }
  return null;
}

try {
  // ---------------------------------------------------------------- stealthV12 (G1)
  await guard('G1-players-stealth', 'stealthV12', async () => {
    const { bots: [b], crew } = await fresh(1, 'FS');
    await b.dbg('level.generate', { seed: 'gate-flags-stealth', players: 1, risk: 1 });
    await b.dbg('monsters.freeze', { on: true }).catch(() => null);
    await sleep(2800); // spawn lock + net join grace
    const spots = await b.dbg('players.surfaces');
    const neutral = spots.find((s) => s.surface === 'lino' && s.kind === 'corridor') ?? spots.find((s) => ['lino', 'concrete', 'asphalt'].includes(s.surface));
    if (!neutral) throw new Error('no neutral floor');
    const R = 0.38;
    const lastT = async () => Math.max(0, ...(await b.dbg('players.noise')).map((n) => n.t));
    const run = async (stance, speed, seconds) => {
      const sx = neutral.x + R, sz = neutral.z;
      await b.dbg('net.teleport', { x: sx, z: sz });
      const idle = async (x, z, ms) => { const t0 = performance.now(); let i = 0; while (performance.now() - t0 < ms) { b.pose(x, z, stance); i++; const w = t0 + i * 50 - performance.now(); if (w > 0) await sleep(w); } };
      await idle(sx, sz, 700);
      const t0 = await lastT();
      let ang = 0;
      const n = Math.round((seconds * 1000) / 50);
      const start = performance.now();
      for (let i = 0; i < n; i++) {
        ang += (speed * 0.05) / R;
        b.pose(neutral.x + R * Math.cos(ang), neutral.z + R * Math.sin(ang), stance);
        const w = start + (i + 1) * 50 - performance.now();
        if (w > 0) await sleep(w);
      }
      await idle(neutral.x + R * Math.cos(ang), neutral.z + R * Math.sin(ang), 300);
      return (await b.dbg('players.noise')).filter((s) => s.source === b.id && s.t > t0 && /Step$/.test(s.kind));
    };
    setFlag('stealthV12', true);
    const on = await run(STANCE.crouch, 3.5, 2.4);
    setFlag('stealthV12', false);
    const off = await run(STANCE.crouch, 3.5, 2.4);
    const pl = crew.players.get(b.id);
    pl.pose.stance = STANCE.hidden;
    const claimOff = PLAYERS.stealthStance(crew, b.id);
    setFlag('stealthV12', true);
    const claimOn = PLAYERS.stealthStance(crew, b.id);
    pl.pose.stance = STANCE.stand;
    const k = (st) => st.map((s) => `${s.kind.replace('Step', '')}:${s.radiusM}`).join(',');
    check('G1-players-stealth', 'on: a crouch claim at 3.5 m/s makes walk steps (v1.2)', on.some((s) => s.kind === 'walkStep'), k(on));
    check('G1-players-stealth', 'off: the same walk makes only v1.1 crouch steps, flat 1.5 m', off.length >= 2 && off.every((s) => s.kind === 'crouchStep' && s.radiusM === 1.5), k(off));
    check('G1-players-stealth', 'off: stealthStance is the claim (v1.1); on: a fake hidden claim is not trusted', claimOff === STANCE.hidden && claimOn !== STANCE.hidden, `off ${claimOff}, on ${claimOn}`);
    done([b]);
  });

  // ---------------------------------------------------------------- listenerFairV12 (G2, G4 copy)
  for (const on of [true, false]) {
    await guard('G2-monsters-fair', `listenerFairV12 ${on ? 'on' : 'off'}`, async () => {
      setFlag('listenerFairV12', on);
      const { bots: [a, b] } = await fresh(2, on ? 'FLN' : 'FLF');
      await a.dbg('monsters.start', { seed: 'gate-flags-lis', players: 2, risk: 1 });
      await waitFor(() => a.phase === 'contract', 5000);
      await sleep(300);
      for (const id of ['hound0', 'hound1', 'mannequin0', 'snatcher0']) await a.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
      await a.dbg('monsters.wake').catch(() => null);
      const g = await a.dbg('monsters.grab', { id: b.id, knockdown: false });
      await sleep(250);
      const st = await b.req('monsters.struggle', {}).catch((e) => ({ ok: false, err: e.message }));
      const ev = b.events.filter((e) => e.e === 'monsters.grab').map((e) => e.d.state ?? '?');
      if (on) check('G2-monsters-fair', 'on: a Listener grab can be struggled out of (v1.2 mash E)', g.ok && st.ok === true && st.struggle > 0, `grab ${g.ok}, struggle ${JSON.stringify(st)}, grab events ${ev.join(',')}`);
      else check('G2-monsters-fair', 'off: the v1.1 grab has no struggle (monsters.struggle refused)', g.ok && st.ok === false, `grab ${g.ok}, struggle ${JSON.stringify(st)}, grab events ${ev.join(',')}`);
      done([a, b]);
    });
    await guard('G4-meta-records', `drive rule card (listenerFairV12 ${on ? 'on' : 'off'})`, async () => {
      setFlag('listenerFairV12', on);
      const { bots: [a] } = await fresh(1, on ? 'FRN' : 'FRF');
      const o = a.full?.workOrders?.find((x) => x.available) ?? a.full?.workOrders?.[0];
      await a.req('meta.pick', { orderId: o.id });
      await a.req('meta.ready', { ready: true });
      await a.waitPhase('drive', 15000);
      const rules = await waitFor(() => a.full?.meta?.drive?.rules, 3000);
      const lis = (rules ?? []).find((r) => r.monster === 'listener');
      const v12 = /SEES you at 6 m/.test(lis?.rule ?? ''), v11 = /no teammate within 8 m/.test(lis?.rule ?? '');
      check('G4-meta-records', `${on ? 'on' : 'off'}: the drive screen's Listener card shows the ${on ? 'v1.2' : 'v1.1'} rules`, on ? v12 && !v11 : v11 && !v12, lis?.rule?.slice(0, 70) ?? 'no card');
      done([a]);
    });
  }
  setFlag('listenerFairV12', ORIGINAL.listenerFairV12 ?? true);

  // ---------------------------------------------------------------- containers (G3)
  const cont = {};
  for (const on of [true, false]) {
    await guard('G3-interaction-gear', `containers ${on ? 'on' : 'off'}`, async () => {
      setFlag('containers', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FCN' : 'FCF');
      await a.dbg('level.generate', { seed: 'gate-flags-cont', players: 2, risk: 1 });
      await sleep(600);
      const st = IX.state(crew);
      const ints = Object.values(st.ints).filter((i) => i.kind === 'container' || String(i.id).startsWith('cont:')).length;
      const floor = Object.values(st.items).filter((i) => i.where === 'world' && (i.value ?? 0) > 0);
      const c0 = containersOf(crew.layout)[0];
      const stock = c0 ? IX.stockContainer(crew, c0.id, { type: 'bottle' }) : false;
      cont[on ? 'on' : 'off'] = { ints, floorN: floor.length, floorValue: floor.reduce((s, i) => s + (i.value ?? 0), 0), stock, sites: containersOf(crew.layout).length };
      done([a]);
    });
  }
  check('G3-interaction-gear', 'containers on: cont: interactables and stockContainer work', cont.on?.ints > 0 && cont.on?.stock === true, JSON.stringify(cont.on));
  check('G3-interaction-gear', 'containers off: no cont: interactables, stockContainer refused (drawers stay closed)', cont.off?.ints === 0 && cont.off?.stock === false, JSON.stringify(cont.off));
  check('G3-interaction-gear', 'containers off: the drawer share of the loot budget is back on the floor', cont.off?.floorValue > cont.on?.floorValue, `floor value on ${cont.on?.floorValue} (${cont.on?.floorN} items), off ${cont.off?.floorValue} (${cont.off?.floorN} items)`);
  setFlag('containers', ORIGINAL.containers ?? true);

  // ---------------------------------------------------------------- easeDoors (G3)
  for (const on of [true, false]) {
    await guard('G3-interaction-gear', `easeDoors ${on ? 'on' : 'off'}`, async () => {
      setFlag('easeDoors', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FEN' : 'FEF');
      await a.dbg('level.generate', { seed: 'gate-flags-ease', players: 2, risk: 1 });
      await a.dbg('monsters.freeze', { on: true }).catch(() => null);
      await sleep(600);
      const d = closedDoor(crew.layout);
      if (!d) throw new Error('no closed door');
      await a.dbg('interaction.pose', { x: d.stand[0], z: d.stand[1], yaw: 0 });
      await sleep(300);
      const r = await a.req('interaction.ease', { id: d.id, on: true }).catch((e) => ({ ok: false, err: e.message }));
      if (on) {
        check('G3-interaction-gear', 'easeDoors on: hold-E on a door starts a timed quiet ease', r.ok === true && r.ms > 0, JSON.stringify(r));
        await a.req('interaction.ease', { id: d.id, on: false }).catch(() => null);
      } else {
        await sleep(400); // handDoorCooldownMs
        const u = await a.req('interaction.use', { id: d.id }).catch((e) => ({ ok: false, err: e.message }));
        await sleep(200);
        const isOpen = IX.state(crew).doors[d.door.id]?.open === true;
        check('G3-interaction-gear', 'easeDoors off: the ease request is refused as off (the client falls back to a tap)', r.ok === false && r.off === true, JSON.stringify(r));
        check('G3-interaction-gear', 'easeDoors off: a tap opens the door at once (v1.1)', isOpen, `use ${JSON.stringify(u)}`);
      }
      done([a]);
    });
  }
  setFlag('easeDoors', ORIGINAL.easeDoors ?? true);

  // ---------------------------------------------------------------- siteThemes (G4, E1)
  for (const on of [true, false]) {
    await guard('G4-meta-records', `siteThemes ${on ? 'on' : 'off'}`, async () => {
      setFlag('siteThemes', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FTN' : 'FTF');
      const orders = a.full?.workOrders ?? [];
      const o = orders.find((x) => x.available !== false && x.siteTheme && x.siteTheme !== 'facility');
      if (!o) { check('G4-meta-records', `siteThemes ${on ? 'on' : 'off'}: a themed order on the board`, false, JSON.stringify(orders.map((x) => x.siteTheme ?? null))); done([a]); return; }
      await toContract([a], o);
      const t = themeId(crew.layout);
      if (on) check('G4-meta-records', 'siteThemes on: the contract site carries the order theme', t === o.siteTheme, `order ${o.siteTheme} -> layout ${t}`);
      else check('G4-meta-records', 'siteThemes off: every site is the plain facility', t === 'facility', `order ${o.siteTheme} -> layout ${t}`);
      done([a]);
    });
  }
  setFlag('siteThemes', ORIGINAL.siteThemes ?? true);

  // ---------------------------------------------------------------- paranormal (E4)
  for (const on of [true, false]) {
    await guard('E4-env-paranormal', `paranormal ${on ? 'on' : 'off'}`, async () => {
      setFlag('paranormal', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FPN' : 'FPF');
      await a.dbg('level.generate', { seed: 'gate-flags-para', players: 1, risk: 1 });
      await a.dbg('monsters.freeze', { on: true }).catch(() => null);
      await sleep(800);
      const L = crew.layout;
      const cells = [];
      for (let c = 0; c < L.owner.length; c++) if (L.owner[c] >= 0 && indoor(L, L.owner[c])) cells.push([(c % L.W) + 0.5, Math.floor(c / L.W) + 0.5]);
      let fired = null, why = '';
      for (let i = 0; i < cells.length && i < 7 * 120; i += 7) {
        await a.dbg('interaction.pose', { x: cells[i][0], z: cells[i][1], yaw: [0, Math.PI / 2, Math.PI, -Math.PI / 2][i % 4], light: 1 });
        await a.dbg('paranormal.tune', { lastAgoSec: 60, clearBudgets: true }).catch(() => null);
        const r = await a.dbg('paranormal.fire', { kind: 'knock', target: a.id, force: true }).catch((e) => ({ ok: false, reason: e.message }));
        if (r?.ok) { fired = r.ev; break; }
        why = r?.reason ?? why;
        if (!on) break;
      }
      const api = PARA.triggerPhenomenon(crew, 'knock', { target: a.id, force: true });
      await sleep(400);
      const evs = a.events.filter((e) => e.e === 'paranormal.event').length;
      if (on) check('E4-env-paranormal', 'paranormal on: a forced knock fires and reaches the client', !!fired && evs > 0, fired ? `ev ${fired.id}, ${evs} client events` : why);
      else check('E4-env-paranormal', 'paranormal off: fire refused (disabled), api trigger false, no client events', !fired && /disabled/.test(why) && api === false && evs === 0, `why ${why}, api ${api}, events ${evs}`);
      done([a]);
    });
  }
  setFlag('paranormal', ORIGINAL.paranormal ?? true);

  // ---------------------------------------------------------------- crawlVents (G1), fieldGuide (G6)
  for (const on of [true, false]) {
    await guard('G1-players-stealth', `crawlVents ${on ? 'on' : 'off'}`, async () => {
      setFlag('crawlVents', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FVN' : 'FVF');
      await a.dbg('level.generate', { seed: 'gate-flags-vents', players: 2, risk: 1 });
      await sleep(900);
      const vents = crew.layout.items.filter((i) => i.kind === 'vent').length;
      const crawl = Object.keys(IX.state(crew).ints).filter((id) => id.startsWith('crawl:')).length;
      if (on) check('G1-players-stealth', 'crawlVents on: crawl: interactables on the grates', vents === 0 || crawl > 0, `${vents} vents, ${crawl} crawl ints`);
      else check('G1-players-stealth', 'crawlVents off: no crawl: interactables', crawl === 0, `${vents} vents, ${crawl} crawl ints`);
      done([a]);
    });
  }
  setFlag('crawlVents', ORIGINAL.crawlVents ?? true);
  for (const on of [true, false]) {
    await guard('G6-fieldguide', `fieldGuide ${on ? 'on' : 'off'}`, async () => {
      setFlag('fieldGuide', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FGN' : 'FGF');
      await a.dbg('level.generate', { seed: 'gate-flags-fg', players: 1, risk: 1 });
      const fg = await waitFor(() => Object.keys(IX.state(crew).ints).filter((id) => id.startsWith('fg:') || id.startsWith('lore:')).length || null, 2500, 100) ?? 0;
      if (on) check('G6-fieldguide', 'fieldGuide on: the van shelf / bulletin interactables exist', fg > 0, `${fg}`);
      else check('G6-fieldguide', 'fieldGuide off: no fg: / lore: interactables', fg === 0, `${fg}`);
      done([a]);
    });
  }
  setFlag('fieldGuide', ORIGINAL.fieldGuide ?? true);

  // ---------------------------------------------------------------- crafting (G5)
  for (const on of [true, false]) {
    await guard('G5-workshop', `crafting ${on ? 'on' : 'off'}`, async () => {
      setFlag('crafting', on);
      const { bots: [a], crew } = await fresh(1, on ? 'FWN' : 'FWF');
      const wb = stationOf(crew.layout, 'workbench');
      const dx = wb.p[0] - wb.x, dz = wb.p[2] - wb.z, l = Math.hypot(dx, dz) || 1;
      await a.dbg('interaction.pose', { x: wb.x + (dx / l) * 0.9, z: wb.z + (dz / l) * 0.9, yaw: 0 });
      await sleep(200);
      const r = await a.reqErr('meta.workbench', {});
      if (on) check('G5-workshop', 'crafting on: meta.workbench answers at the bench', r.ok === true, r.ok ? 'ok' : r.err);
      else check('G5-workshop', 'crafting off: meta.workbench is refused', r.ok === false, r.ok ? JSON.stringify(r.d).slice(0, 80) : r.err);
      done([a]);
    });
  }
  setFlag('crafting', ORIGINAL.crafting ?? true);

  // ---------------------------------------------------------------- statsV12 (G4): the recorder stops, saves stay readable
  await guard('G4-meta-records', 'statsV12', async () => {
    const META = await import('../../apps/server/src/meta/api.ts');
    const { bots: [a], crew } = await fresh(1, 'FST');
    META.recordStat(crew, a.id, 'itemsUsed.flare', 2);
    const n0 = META.playerSave(crew, a.id)?.stats?.itemsUsed?.flare ?? 0;
    setFlag('statsV12', false);
    META.recordStat(crew, a.id, 'itemsUsed.flare', 5);
    const n1 = META.playerSave(crew, a.id)?.stats?.itemsUsed?.flare ?? 0;
    const read = await a.reqErr('meta.stats', {});
    setFlag('statsV12', true);
    META.recordStat(crew, a.id, 'itemsUsed.flare', 1);
    const n2 = META.playerSave(crew, a.id)?.stats?.itemsUsed?.flare ?? 0;
    check('G4-meta-records', 'statsV12 off: recordStat is a no-op; on again it records', n0 === 2 && n1 === 2 && n2 === 3, `${n0} -> off ${n1} -> on ${n2}`);
    check('G4-meta-records', 'statsV12 off: the saved stats stay readable (meta.stats)', read.ok === true && read.d?.you?.stats?.itemsUsed?.flare === 2, read.ok ? JSON.stringify(read.d?.you?.stats?.itemsUsed ?? null) : read.err);
    done([a]);
  });
  setFlag('statsV12', ORIGINAL.statsV12 ?? true);

  // ---------------------------------------------------------------- nightVision (G3)
  await guard('G3-interaction-gear', 'nightVision', async () => {
    const { bots: [a], crew } = await fresh(1, 'FNV');
    await a.dbg('level.generate', { seed: 'gate-flags-nv', players: 1, risk: 1 });
    await a.dbg('monsters.freeze', { on: true }).catch(() => null);
    await sleep(500);
    await a.dbg('interaction.give', { type: 'nvg' });
    setFlag('nightVision', false);
    const off = await a.req('interaction.nv', { on: true }).catch((e) => ({ ok: false, msg: e.message }));
    const offOn = IX.nightVision(crew, a.id);
    setFlag('nightVision', true);
    const on = await a.req('interaction.nv', { on: true }).catch((e) => ({ ok: false, msg: e.message }));
    const onOn = IX.nightVision(crew, a.id);
    check('G3-interaction-gear', 'nightVision off: the module refuses ("offline")', off.ok === false && !offOn, JSON.stringify(off));
    check('G3-interaction-gear', 'nightVision on: the module switches on', on.ok !== false && onOn, JSON.stringify(on));
    done([a]);
  });
  setFlag('nightVision', ORIGINAL.nightVision ?? true);
} catch (e) {
  check('integrator', 'run', false, e instanceof Error ? e.stack : String(e));
} finally {
  for (const k of Object.keys(ctx.flags)) if (!(k in ORIGINAL)) delete ctx.flags[k];
  Object.assign(ctx.flags, ORIGINAL);
  for (const b of open) b.close();
  await sleep(200);
  await srv.close().catch(() => undefined);
}
const nFailed = summary();
process.exitCode = nFailed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 1500).unref();
