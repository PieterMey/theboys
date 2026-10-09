// v1.3 P1a/P1b/P2b on a real server (in-process, mode 'test', port 0): a blocked or reserved join name shows as
// Contractor-NNNN in the roster with a private notice to that player only; a profile.set rename goes through the same
// filter; hello build 'bot' marks ServerPlayer.bot. Blocked names are ROT13 codes decoded at run time (no slur in here).
//   node --test tests/core/names-join.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from '../../apps/server/src/core/boot.ts';
import { setQuiet } from '../../apps/server/src/core/log.ts';
import { isBot } from '../../apps/server/src/core/crews.ts';
import { installReqs } from '../../apps/server/src/net/reqs.ts';
import { contractorName, defaultName, rot13 } from '../../packages/shared/src/names.ts';
import type { CrewPublic } from '../../packages/shared/src/state.ts';
import { TestClient, sleep } from './lib.ts';

const rosterName = (crew: CrewPublic | undefined | null, id: string): string | undefined => crew?.players.find((p) => p.id === id)?.name;
const isNotice = (ev: { e: string; d: unknown }) => ev.e === 'notice' && /not allowed|reserved/.test(String((ev.d as { text?: string }).text));

test('join + rename: blocked and reserved names become Contractor-NNNN, the notice is private, bots are flagged', async () => {
  setQuiet(true);
  const srv = await boot({ mode: 'test', port: 0, tracks: [['net-reqs', installReqs]] });
  const clients: TestClient[] = [];
  try {
    const crew = 'NAMES';
    const bad = new TestClient(`${rot13('onfgneq')}_99`, { build: 'bot' });
    const ok = new TestClient('Sanne');
    const res = new TestClient('The Listener');
    clients.push(bad, ok, res);
    const wBad = await bad.connect(srv.port, crew);
    const wOk = await ok.connect(srv.port, crew);
    const wRes = await res.connect(srv.port, crew);

    // the roster everyone sees carries the replacement, never the refused name
    const expectBad = contractorName(wBad.you);
    assert.equal(rosterName(wOk.crew, wBad.you), expectBad);
    assert.equal(rosterName(wRes.crew, wRes.you), contractorName(wRes.you), 'reserved name replaced');
    assert.equal(rosterName(wOk.crew, wOk.you), 'Sanne');
    for (const c of clients) {
      const json = JSON.stringify(c.events) + JSON.stringify(c.welcome);
      assert.ok(!json.toLowerCase().includes(rot13('onfgneq')), 'the refused name never reaches a client');
    }
    // private notice: the renamed players get one each, the clean one gets none
    await bad.waitEvent(isNotice);
    await res.waitEvent(isNotice);
    await sleep(150);
    assert.equal(ok.events.filter(isNotice).length, 0, 'no rename notice for the crew');
    assert.equal(bad.events.filter(isNotice).length, 1);

    // P2b: hello build 'bot' -> ServerPlayer.bot (isBot), other builds -> false
    const sc = srv.ctx.crews.get(crew)!;
    assert.equal(isBot(sc.players.get(wBad.you)!), true);
    assert.equal(sc.players.get(wBad.you)!.bot, true);
    assert.equal(isBot(sc.players.get(wOk.you)!), false);

    // P1b: profile.set renames through the same filter (and notices privately)
    const before = ok.events.length;
    await ok.req('profile.set', { profile: { ...wOk.crew.players.find((p) => p.id === wOk.you)!.profile, name: `xX${rot13('anmv')}Xx` } });
    const roster = (await ok.waitEvent((ev) => ev.e === 'crew' && rosterName(ev.d as CrewPublic, wOk.you) !== 'Sanne')).d as CrewPublic;
    assert.equal(rosterName(roster, wOk.you), contractorName(wOk.you));
    await ok.waitEvent((ev) => isNotice(ev) && ok.events.indexOf(ev) >= before);
    await sleep(150);
    assert.equal(bad.events.filter(isNotice).length, 1, 'the crew does not hear about it');
    assert.equal(sc.players.get(wOk.you)!.name, contractorName(wOk.you));
    // a clean rename goes through unchanged; an empty one keeps the current name
    await ok.req('profile.set', { profile: { ...roster.players.find((p) => p.id === wOk.you)!.profile, name: 'Sanne B' } });
    assert.equal(sc.players.get(wOk.you)!.name, 'Sanne B');
    await ok.req('profile.set', { profile: { ...roster.players.find((p) => p.id === wOk.you)!.profile, name: '  \u200b ' } });
    assert.equal(sc.players.get(wOk.you)!.name, 'Sanne B');

    // a resume with the same blocked name keeps the same replacement (stable from the player id)
    await bad.close();
    await sleep(100);
    const again = new TestClient(`${rot13('onfgneq')}_99`, { build: 'bot' });
    again.key = bad.key;
    clients.push(again);
    const wAgain = await again.connect(srv.port, crew);
    assert.equal(wAgain.you, wBad.you);
    assert.equal(rosterName(wAgain.crew, wAgain.you), expectBad);
  } finally {
    for (const c of clients) await c.close();
    await srv.close();
  }
});

test('defaults on join: only the exact defaults skip the filter (the client default for the key, the own Contractor-NNNN)', async () => {
  setQuiet(true);
  const srv = await boot({ mode: 'test', port: 0, tracks: [['net-reqs', installReqs]] });
  const clients: TestClient[] = [];
  const hex = (n: number) => Array.from({ length: n }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
  try {
    const crew = 'DEFAULTS';
    // a typed Contractor-<the hate code> (built at run time) is replaced like any blocked name
    const typed = new TestClient(`Contractor-${String(14)}${String(88)}`);
    // the client's own default for its key passes; so does the v1.2 default of an ordinary key
    const keyA = `b7e${hex(29)}`;
    const dflt = new TestClient(defaultName(keyA), { key: keyA });
    // a leet hex head (ROT13 code): the old default is refused even with its own key; the new client sends defaultName
    const old = rot13('Pbagenpgbe-N55');
    const keyB = `${old.slice(-3).toLowerCase()}${hex(29)}`;
    const legacy = new TestClient(old, { key: keyB });
    const fresh = new TestClient(defaultName(keyB), { key: `${keyB.slice(0, 31)}0` }); // same head, another player
    clients.push(typed, dflt, legacy, fresh);
    const wTyped = await typed.connect(srv.port, crew);
    const wDflt = await dflt.connect(srv.port, crew);
    const wLegacy = await legacy.connect(srv.port, crew);
    const wFresh = await fresh.connect(srv.port, crew);
    assert.equal(defaultName(keyA), `Contractor-${keyA.slice(0, 3).toUpperCase()}`, 'an ordinary key keeps its v1.2 default');
    assert.notEqual(defaultName(keyB), old, 'a refused head gets another default');
    const roster = wFresh.crew;
    assert.equal(rosterName(roster, wTyped.you), contractorName(wTyped.you), 'typed code name replaced');
    assert.equal(rosterName(roster, wDflt.you), defaultName(keyA), 'client default kept');
    assert.equal(rosterName(roster, wLegacy.you), contractorName(wLegacy.you), 'refused legacy default replaced');
    assert.equal(rosterName(roster, wFresh.you), defaultName(keyB), "the new default passes (for its own key, and as another player's name)");
    await typed.waitEvent(isNotice);
    await legacy.waitEvent(isNotice);
    await sleep(150);
    assert.equal(dflt.events.filter(isNotice).length, 0, 'no notice for a default name');
    assert.equal(fresh.events.filter(isNotice).length, 0, 'no notice for a default name');

    // a reconnect that sends the player's own replacement keeps it, without a notice
    await typed.close();
    await sleep(100);
    const back = new TestClient(contractorName(wTyped.you), { key: typed.key });
    clients.push(back);
    const wBack = await back.connect(srv.port, crew);
    assert.equal(wBack.you, wTyped.you);
    assert.equal(rosterName(wBack.crew, wBack.you), contractorName(wTyped.you));
    await sleep(150);
    assert.equal(back.events.filter(isNotice).length, 0, 'its own Contractor-NNNN is no news');
    // profile.set to the typed code name is replaced too (same filter, private notice)
    const before = dflt.events.length;
    await dflt.req('profile.set', { profile: { ...wDflt.crew.players.find((p) => p.id === wDflt.you)!.profile, name: `Contractor-${String(14)}${String(88)}` } });
    await dflt.waitEvent((ev) => isNotice(ev) && dflt.events.indexOf(ev) >= before);
    assert.equal(srv.ctx.crews.get(crew)!.players.get(wDflt.you)!.name, contractorName(wDflt.you));
  } finally {
    for (const c of clients) await c.close();
    await srv.close();
  }
});
