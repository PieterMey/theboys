// players (v1.3 P1d) e2e with ws bots (no browser, no GPU): the server masks proximity text itself.
//   Ann skips the client's outgoingChat (a modified client) and types a blocked word in the spellings names.ts folds:
//   plain, shouted, leet, split by a zero-width space, Cyrillic lookalikes, fullwidth, a spaced letter run, split by a
//   bidi override. Bea, Ann's own echo and the proximity-text stream (what the Listener, the AI hub and the site rules
//   get: dbg.players.proxText) all receive the same masked line. Bidi embedding / override / isolate controls never
//   come through (a reversed word would otherwise show the right way round), and clean lines arrive untouched.
//   The blocked word comes from a ROT13 code decoded at run time and every invisible or bidi character is built from
//   its code point, so this file holds neither a swear word nor a hidden character. Delivered lines are printed only
//   when masked or clean.
// Run: PORT=3801 (a dev server there, else the test starts one) node tests/players/chatmask.e2e.ts
import { rot13, textBlocked } from '../../packages/shared/src/names.ts';
import { Bot, crewCode, ensureServer, sleep } from '../stealth/bot.ts';

interface ChatEv { id: string; name: string; text: string; dist: number }
interface ProxLine { id: string; text: string; masked: boolean; heardBy: string[]; t: number }
interface Case {
  name: string;
  send: string;
  /** names.ts finds a blocked word in what was sent (sanity: the case means something) */
  blocked: boolean;
  /** the exact line everyone must get (default: masked lines only need to pass `keep`, clean lines arrive as sent) */
  want?: string;
  /** clean words of a masked line that must survive */
  keep?: string[];
}

const cp = (...n: number[]): string => String.fromCharCode(...n);
const ZWSP = cp(0x200b), RLO = cp(0x202e), PDF = cp(0x202c), RLI = cp(0x2067), PDI = cp(0x2069);
const BIDI = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`);
const BAD = rot13('onfgneq');
const stars = (s: string) => '*'.repeat([...s].length);
const leet = BAD.replace(/a/g, '4').replace(/s/g, '5').replace(/t/g, '7');
const cyr = [...BAD].map((c) => ({ a: cp(0x0430), o: cp(0x043e), e: cp(0x0435), c: cp(0x0441), p: cp(0x0440) } as Record<string, string>)[c] ?? c).join('');
const wide = [...BAD].map((c) => cp(c.charCodeAt(0) - 0x61 + 0xff41)).join('');
const rev = [...BAD].reverse().join('');

const CASES: Case[] = [
  { name: 'plain', send: `you ${BAD} get back here`, blocked: true, want: `you ${stars(BAD)} get back here` },
  { name: 'shouted', send: `${BAD.toUpperCase()}!! run`, blocked: true, want: `${stars(BAD)}** run` },
  { name: 'leet', send: `go away ${leet}`, blocked: true, want: `go away ${stars(leet)}` },
  { name: 'zero-width split', send: `${BAD.slice(0, 3)}${ZWSP}${BAD.slice(3)} behind you`, blocked: true, keep: [' behind you'] },
  { name: 'cyrillic lookalikes', send: `hey ${cyr}`, blocked: true, want: `hey ${stars(cyr)}` },
  { name: 'fullwidth', send: `${wide} in the vents`, blocked: true, want: `${stars(wide)} in the vents` },
  { name: 'spaced letter run', send: `go ${[...BAD].join(' ')} now`, blocked: true, keep: ['go ', ' now'] },
  // the override is dropped first, so the filter and the screen read the same word: masked
  { name: 'bidi-override split', send: `${BAD.slice(0, 3)}${RLO}${BAD.slice(3)} now`, blocked: true, want: `${stars(BAD)} now` },
  // a reversed word under an override / isolate would show the right way round: it arrives in typing order instead
  { name: 'bidi-reversed (override)', send: `look ${RLO}${rev}${PDF} out`, blocked: false, want: `look ${rev} out` },
  { name: 'bidi-reversed (isolate)', send: `${RLI}${rev}${PDI} ok`, blocked: false, want: `${rev} ok` },
  { name: 'clean', send: 'meet me at the BOILER, hound is near', blocked: false },
  { name: 'clean digits', send: 'code is 4 7 1 9', blocked: false },
];

const srv = await ensureServer();
const ann = new Bot('Ann');
const bea = new Bot('Bea');
const results: Record<string, unknown>[] = [];
let failed = false;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failed = true; console.log(`FAIL: ${msg}`); }
};
/** the first players.chat from `from` that `b` got after event index `i0` */
const chatAfter = async (b: Bot, from: string, i0: number, ms = 2000): Promise<ChatEv | null> => {
  const t0 = performance.now();
  for (;;) {
    const ev = b.events.slice(i0).find((e) => e.e === 'players.chat' && (e.d as ChatEv).id === from);
    if (ev) return ev.d as ChatEv;
    if (performance.now() - t0 > ms) return null;
    await sleep(25);
  }
};
try {
  const crew = crewCode('CHM');
  await ann.connect(srv.ws, crew);
  await bea.connect(srv.ws, crew);
  await sleep(400);
  for (const c of CASES) {
    check(textBlocked(c.send) === c.blocked, `${c.name}: names.ts ${c.blocked ? 'blocks' : 'passes'} what was sent`);
    const ia = ann.events.length, ib = bea.events.length;
    const rep = await ann.req<{ ok: boolean; heardBy: number }>('players.chat', { text: c.send });
    const [toBea, echo] = await Promise.all([chatAfter(bea, ann.id, ib), chatAfter(ann, ann.id, ia)]);
    const stream = (await ann.dbg<ProxLine[]>('players.proxText')).filter((l) => l.id === ann.id).pop() ?? null;
    const got = toBea?.text ?? null;
    const want = c.want ?? (c.blocked ? null : c.send);
    check(rep?.ok === true && rep.heardBy >= 1, `${c.name}: sent, Bea in range (${JSON.stringify(rep)})`);
    check(got !== null, `${c.name}: Bea got the line`);
    check(echo?.text === got, `${c.name}: Ann's own echo is the same line`);
    check(stream?.text === got, `${c.name}: the proximity-text stream got the same line`);
    if (got !== null) {
      check(!BIDI.test(got), `${c.name}: no bidi control came through`);
      if (want !== null) check(got === want, `${c.name}: delivered line is the expected one (${c.blocked ? 'masked' : 'clean'})`);
      if (c.blocked) {
        check(!textBlocked(got), `${c.name}: the delivered line holds no blocked word`);
        check(got.includes('*') && got !== c.send, `${c.name}: masked with '*'`);
        for (const k of c.keep ?? []) check(got.includes(k), `${c.name}: kept "${k.trim()}"`);
      }
    }
    check(stream?.masked === c.blocked, `${c.name}: stream masked flag ${stream?.masked} (want ${c.blocked})`);
    const printable = got !== null && (c.blocked ? !textBlocked(got) : !BIDI.test(c.send) && got === c.send);
    results.push({
      case: c.name, ok: rep?.ok, heardBy: rep?.heardBy, masked: stream?.masked,
      delivered: printable ? got : `(${got?.length ?? 0} chars, bidi controls ${got && BIDI.test(got) ? 'present' : 'none'})`,
    });
    await sleep(300); // the 250 ms chat rate limit
  }
  // flag proxText off: nothing goes out (a dev flag override, restored after)
  await ann.dbg('setFlags', { set: { proxText: false } });
  const ib = bea.events.length;
  const off = await ann.req<{ ok: boolean; heardBy: number }>('players.chat', { text: 'anyone there?' });
  const none = await chatAfter(bea, ann.id, ib, 500);
  check(off?.ok === false && none === null, `flag proxText off: refused and nothing delivered (${JSON.stringify(off)})`);
  await ann.dbg('setFlags', { set: { proxText: true } });
} catch (e) {
  failed = true;
  console.log(`FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  ann.close();
  bea.close();
  await srv.stop();
}
console.log(JSON.stringify(results, null, 1));
console.log(failed ? 'chatmask.e2e: FAIL' : `chatmask.e2e: PASS (${CASES.length} spellings + flag off)`);
process.exit(failed ? 1 : 0);
