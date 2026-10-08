// Owner: meta-records (v1.2). The Company PERSONNEL FILE. One file component, three ways in:
//   - the 'stats' screen (the records board on the van facade, meta.open 'stats'): your file + your crewmates'
//   - the pause menu 'Record' tab (meta.stats + this shift's lines from MetaState)
//   - the main-menu 'Personnel file' panel (GET /api/stats with the x-deadair-key header, before joining; cached in
//     localStorage 'deadair.meta.stats')
// Counters only: the file never shows what anyone said.
import './stats.css';
import { useEffect, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import type { CollectionEntry, PlayerStatsV1, StatsReply } from '@dead-air/shared/progress.ts';
import { ACHIEVEMENTS, CORE_BUSINESS, collectionCatalog } from '@dead-air/shared/messages/meta.ts';
import type { CollectionDef, MetaShiftLine } from '@dead-air/shared/messages/meta.ts';
import { SuitPreview } from './creator.tsx';
import { metaOf, sfx, useWorldV } from './state.ts';
import { closeScreen } from './nav.ts';

// ---------------------------------------------------------------- formatting

const n0 = (v: number | undefined): string => Math.round(v ?? 0).toLocaleString('en-GB');
const dist = (m: number | undefined): string => ((m ?? 0) >= 1000 ? `${((m ?? 0) / 1000).toFixed(1)} km` : `${Math.round(m ?? 0)} m`);
function dur(s0: number | undefined): string {
  const s = Math.max(0, Math.round(s0 ?? 0));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${s} s`;
}
function day(iso: string | undefined, year = true): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(year ? { year: 'numeric' as const } : {}) }).toUpperCase() : '--';
}

const KILLERS = ['HOUND', 'LISTENER', 'MANNEQUIN', 'SNATCHER', 'LEFT BEHIND'];
const GROUP_LABEL: Record<CollectionDef['group'], string> = { gear: 'Equipment', material: 'Materials', salvage: 'Salvage', curio: 'Curios', idol: 'Cursed' };
const GROUP_ORDER: CollectionDef['group'][] = ['gear', 'material', 'salvage', 'curio', 'idol'];

function achievementAt(ctx: ClientContext, name: string, d: number): number {
  const o = (ctx.balance.meta as Record<string, unknown> | undefined)?.achievements as Record<string, unknown> | undefined;
  const v = o?.[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function progressOf(stat: string, st: PlayerStatsV1, collection: Record<string, CollectionEntry>): number {
  if (stat === 'monsterKinds') return Object.entries(st.killedBy ?? {}).filter(([k, n]) => n > 0 && KILLERS.slice(0, 4).includes(k)).length;
  if (stat === 'curioFinds') return Object.keys(collection).filter((k) => k.startsWith('curio:')).length;
  return Number((st as unknown as Record<string, unknown>)[stat] ?? 0);
}

// ---------------------------------------------------------------- pieces

function Num({ label, v, sub }: { label: string; v: string; sub?: string }) {
  return (
    <div class="m-pf-num">
      <b>{v}</b>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl class="m-pf-rows">
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function Deaths({ st }: { st: PlayerStatsV1 }) {
  const kb = st.killedBy ?? {};
  const keys = [...KILLERS, ...Object.keys(kb).filter((k) => !KILLERS.includes(k))].filter((k) => (kb[k] ?? 0) > 0 || KILLERS.slice(0, 4).includes(k));
  const max = Math.max(1, ...keys.map((k) => kb[k] ?? 0));
  return (
    <div>
      {st.deaths === 0 && <p class="m-pf-note">No deaths on file. Human Resources finds this suspicious.</p>}
      <div class="m-pf-bars">
        {keys.map((k) => (
          <div key={k} class={`m-pf-bar ${(kb[k] ?? 0) > 0 ? '' : 'zero'}`}>
            <span>{k}</span>
            <i><u style={{ width: `${((kb[k] ?? 0) / max) * 100}%` }} /></i>
            <b>{kb[k] ?? 0}</b>
          </div>
        ))}
      </div>
      <p class="m-pf-fine">
        Hound alerts {n0(st.houndAlerts)} · grabbed {n0(st.grabbed)} · knocked down {n0(st.knockdowns)} · snatched {n0(st.snatched)} · got away {n0(st.escapes)}
      </p>
    </div>
  );
}

function Commendations({ ctx, you }: { ctx: ClientContext; you: NonNullable<StatsReply['you']> }) {
  const st = you.stats;
  const extra = you.achievements.filter((a) => a !== CORE_BUSINESS && !ACHIEVEMENTS.some((x) => x.name === a));
  return (
    <div class="m-pf-awards">
      {[{ name: CORE_BUSINESS, desc: 'Extracted a Core', stat: 'coresExtracted', at: 1 }, ...ACHIEVEMENTS].map((a) => {
        const got = you.achievements.includes(a.name);
        const at = a.name === CORE_BUSINESS ? 1 : achievementAt(ctx, a.name, a.at);
        const v = progressOf(String(a.stat), st, you.collection);
        return (
          <div key={a.name} class={`m-pf-award ${got ? 'got' : ''}`} title={a.desc}>
            <b>{a.name}</b>
            <span>{a.desc}</span>
            {!got && <small>{v >= at ? 'QUALIFIES · STAMPED AFTER YOUR NEXT CONTRACT' : a.stat === 'crouchM' ? `${dist(v)} / ${dist(at)}` : `${n0(v)} / ${n0(at)}`}</small>}
          </div>
        );
      })}
      {extra.map((a) => <div key={a} class="m-pf-award got"><b>{a}</b><span>Commendation</span></div>)}
    </div>
  );
}

function Collection({ collection, size }: { collection: Record<string, CollectionEntry>; size: number }) {
  const cat = collectionCatalog();
  const found = cat.filter((d) => collection[d.key]).length;
  return (
    <div>
      <div class="m-pf-colhead"><span>{found} / {size || cat.length} ENTRIES</span><i><u style={{ width: `${(found / Math.max(1, size || cat.length)) * 100}%` }} /></i></div>
      {GROUP_ORDER.map((g) => {
        const list = cat.filter((d) => d.group === g);
        if (!list.length) return null;
        return (
          <div key={g} class="m-pf-colgroup">
            <h5>{GROUP_LABEL[g]} <small>{list.filter((d) => collection[d.key]).length}/{list.length}</small></h5>
            <div class="m-pf-tiles">
              {list.map((d) => {
                const e = collection[d.key];
                return e
                  ? <div key={d.key} class={`m-pf-tile ${g}`} title={`${d.label} · first found ${day(e.at)} · ${e.site}`}><b>{d.label}</b><small>{day(e.at)} · {e.site}</small></div>
                  : <div key={d.key} class="m-pf-tile unknown"><b>???</b><small>not found yet</small></div>;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ShiftTable({ lines, me }: { lines: MetaShiftLine[]; me: string | null }) {
  return (
    <table class="m-pf-table">
      <thead><tr><th>Contractor</th><th>Contracts</th><th>Survived</th><th>Deaths</th><th>Hauled</th><th>Revives</th><th>Crafted</th><th>Scrapped</th></tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.saveId} class={l.player && l.player === me ? 'me' : ''}>
            <td>{l.name}{l.player ? '' : <small> (off shift)</small>}</td><td>{l.contracts}</td><td>{l.survived}</td><td>{l.deaths}</td>
            <td>{n0(l.hauled)}</td><td>{l.revives}</td><td>{l.crafted}</td><td>{l.scrapped}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Crews({ reply, current, onPick }: { reply: StatsReply; current: string | null; onPick?: (saveId: string) => void }) {
  if (!reply.crews.length) return <p class="m-pf-note">No crew on file yet. Clock in with a crew and finish a contract.</p>;
  return (
    <div class="m-pf-crews">
      {reply.crews.map((c) => {
        const r = c.records;
        return (
          <div key={c.code} class={`m-pf-crew ${c.code === current ? 'now' : ''}`}>
            <div class="m-pf-crewhead">
              <b>CREW {c.code}</b>
              {c.code === current && <span class="m-pf-tag">ON SHIFT</span>}
              {r && <span>{r.contracts} contract{r.contracts === 1 ? '' : 's'} · {r.cores} core{r.cores === 1 ? '' : 's'} · {r.wipes} wipe{r.wipes === 1 ? '' : 's'} · quota streak {r.quotaStreak} (best {r.bestQuotaStreak})</span>}
            </div>
            {r && r.bestHaul > 0 && <p class="m-pf-fine">Best haul: <b>{n0(r.bestHaul)} scrip</b> at {r.bestHaulSite} ({day(r.bestHaulAt)})</p>}
            <table class="m-pf-table">
              <thead><tr><th>Contractor</th><th>Lvl</th><th>Contracts</th><th>Salvage</th><th>Deaths</th><th>Revives</th><th>Log</th></tr></thead>
              <tbody>
                {c.members.map((m) => (
                  <tr key={m.saveId} class={`${m.saveId === reply.you?.saveId ? 'me' : ''} ${onPick ? 'pick' : ''}`} onClick={() => onPick?.(m.saveId)}>
                    <td>#{m.badge} {m.name}</td><td>{m.level}</td><td>{m.contracts}</td><td>{n0(m.lootValue)}</td><td>{m.deaths}</td><td>{m.revivesGiven}</td>
                    <td>{m.collection}/{reply.collectionSize}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the file

export interface FileProps {
  ctx: ClientContext;
  reply: StatsReply | null;
  /** mugshot (own profile, or a crewmate's when they are in the crew) */
  profile?: Profile | null;
  /** this shift so far (in-game only) */
  shift?: MetaShiftLine[] | null;
  /** current crew code (highlights it) */
  crew?: string | null;
  /** live id of the reader (shift table highlight) */
  me?: string | null;
  onPick?: (saveId: string) => void;
  loading?: boolean;
  error?: string | null;
  /** a line above the file (cached copy, offline...) */
  note?: string | null;
}

export function PersonnelFile({ ctx, reply, profile, shift, crew, me, onPick, loading, error, note }: FileProps) {
  const you = reply?.you ?? null;
  if (!you) {
    return (
      <div class="m-pf m-pf-empty" data-testid="personnel-file">
        <div class="m-pf-paper">
          <div class="m-pf-kicker">THE COMPANY · HUMAN RESOURCES · NIGHT DIVISION</div>
          <h2 class="m-pf-name">{loading ? 'Retrieving your file…' : 'No file on record'}</h2>
          <p class="m-pf-note">{error ? `Records office unreachable (${error}).` : loading ? 'One moment. The archive is in the basement.' : 'Clock in for your first shift. Human Resources opens a file the moment you sign the waiver you have not read.'}</p>
          <div class="m-pf-stamp">{loading ? 'PENDING' : 'NEW HIRE'}</div>
        </div>
      </div>
    );
  }
  const st = you.stats;
  const lv = (ctx.balance.core.xpLevels as number[] | undefined) ?? [0, 150, 400, 750, 1200, 1800, 2600];
  const lo = lv[you.level - 1] ?? 0;
  const hi = lv[you.level] ?? null;
  const k = hi ? Math.min(1, (you.xp - lo) / Math.max(1, hi - lo)) : 1;
  const used = Object.entries(st.itemsUsed ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const stamp = st.fired > 0 && st.quotasMet === 0 ? 'TERMINATED (REHIRED)' : st.deaths === 0 && st.contracts > 0 ? 'NO INCIDENTS' : st.contracts >= 25 ? 'VETERAN' : 'CONFIDENTIAL';
  return (
    <div class="m-pf" data-testid="personnel-file" data-save={you.saveId}>
      {note && <div class="m-pf-banner">{note}</div>}
      <div class="m-pf-paper">
        <header class="m-pf-head">
          <div class="m-pf-photo">
            {profile ? <SuitPreview p={profile} size={250} /> : <div class="m-pf-nophoto">NO PHOTO<br />ON FILE</div>}
            <span>BADGE #{you.badge}</span>
          </div>
          <div class="m-pf-id">
            <div class="m-pf-kicker">FORM HR-7 · CONTRACTOR RECORD</div>
            <h2 class="m-pf-name">{you.name}</h2>
            <div class="m-pf-sub">CONTRACTOR · LEVEL {you.level} · BADGE #{you.badge}<br />ON FILE SINCE {day(st.firstAt)} · LAST SEEN {day(st.lastAt, false)}</div>
            <div class="m-pf-xp"><i style={{ width: `${k * 100}%` }} /></div>
            <div class="m-pf-xpl">{n0(you.xp)} XP{hi ? ` · ${n0(hi - you.xp)} to level ${you.level + 1}` : ' · MAXIMUM LEVEL'} · {you.achievements.length} commendation{you.achievements.length === 1 ? '' : 's'}</div>
          </div>
          <div class="m-pf-stamp">{stamp}</div>
        </header>

        <section class="m-pf-career">
          <Num label="Contracts" v={n0(st.contracts)} sub={`${n0(st.shifts)} shifts`} />
          <Num label="Survived" v={n0(st.survived)} sub={`streak ${st.cleanStreak} · best ${st.bestCleanStreak}`} />
          <Num label="Deaths" v={n0(st.deaths)} sub={st.leftBehind ? `${st.leftBehind} left behind` : 'none left behind'} />
          <Num label="Scrip hauled" v={n0(st.lootValue)} sub={`${n0(st.lootItems)} items deposited`} />
          <Num label="Best haul" v={n0(st.bestHaul)} sub="in one contract" />
          <Num label="Cores" v={n0(st.coresExtracted)} sub={`${n0(st.extracted)} extractions`} />
          <Num label="Quotas met" v={n0(st.quotasMet)} sub={st.fired ? `fired ${st.fired}×` : 'never fired'} />
          <Num label="On site" v={dur(st.timeOnSiteSec)} sub={`${n0(st.wipes)} wipes`} />
        </section>

        <div class="m-pf-cols">
          <section class="m-pf-sec"><h4>Deaths by monster</h4><Deaths st={st} /></section>
          <section class="m-pf-sec">
            <h4>Teamwork</h4>
            <Rows rows={[
              ['Revives given', n0(st.revivesGiven)], ['Times revived', n0(st.revivedTimes)], ['Badges filed', n0(st.badgesFiled)],
              ['Rescues', n0(st.rescues)], ['Doors opened', n0(st.doorsOpened)], ['Crowbar hits', `${n0(st.crowbarHits)} of ${n0(st.crowbarSwings)} swings`],
            ]} />
          </section>
          <section class="m-pf-sec">
            <h4>Salvage</h4>
            <Rows rows={[
              ['Items deposited', n0(st.lootItems)], ['Heavy items', n0(st.heavyItems)], ['Curios', n0(st.curios)], ['Cursed idols', n0(st.idols)],
              ['Safes cracked', n0(st.safesCracked)], ['Drawers searched', n0(st.drawersSearched)], ['Materials', n0(st.materials)],
              ['Scrapped / crafted', `${n0(st.scrapped)} / ${n0(st.crafted)}`], ['Scrip spent', n0(st.scripSpent)],
            ]} />
          </section>
          <section class="m-pf-sec">
            <h4>Movement</h4>
            <Rows rows={[
              ['Distance', dist(st.distanceM)], ['Sprinted', dist(st.sprintM)], ['Crept', `${dist(st.crouchM)} · ${dur(st.crouchSec)}`],
              ['Steps crept / walked / sprinted', `${n0(st.stepsCrept)} / ${n0(st.stepsWalked)} / ${n0(st.stepsSprinted)}`],
              ['Hidden', dur(st.hiddenSec)], ['Flashlight on', dur(st.flashlightSec)], ['Night vision', dur(st.nvSec)],
              ['Ducts crawled', n0(st.ductsCrawled)], ['Doors eased', n0(st.doorsEased)],
            ]} />
          </section>
          <section class="m-pf-sec">
            <h4>On the record</h4>
            <Rows rows={[
              ['Lines spoken', n0(st.chatLines)], ['Screams', n0(st.screams)], ['On the radio', dur(st.radioSec)],
              ['The Listener used your words', `${n0(st.listenerUsedYourWords)}×`], ['Field-guide pages', n0(st.pagesFiled)], ['Phenomena witnessed', n0(st.phenomenaSeen)],
              ...used.map(([t, v]) => [`Used: ${t}`, `${n0(v)}×`] as [string, string]),
            ]} />
            <p class="m-pf-fine">Counts only. The Company keeps no recordings of what you said. (It says.)</p>
          </section>
        </div>

        <section class="m-pf-sec wide"><h4>Commendations</h4><Commendations ctx={ctx} you={you} /></section>
        <section class="m-pf-sec wide"><h4>Collection log</h4><Collection collection={you.collection} size={reply!.collectionSize} /></section>
        {shift && shift.length > 0 && <section class="m-pf-sec wide"><h4>This shift</h4><ShiftTable lines={shift} me={me ?? null} /></section>}
        <section class="m-pf-sec wide"><h4>Crew records</h4><Crews reply={reply!} current={crew ?? null} onPick={onPick} /></section>
        <div class="m-pf-foot">FORM HR-7 · RETAIN FOR THE DURATION OF YOUR EMPLOYMENT AND APPROXIMATELY FOREVER{loading ? ' · UPDATING…' : ''}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- in-game: 'stats' screen + pause tab

/** a crewmate's PlayerPublic profile by save id (only while they are in the crew) */
function profileFor(ctx: ClientContext, reply: StatsReply | null, own: boolean): Profile | null {
  if (own) {
    const me = ctx.world.crew?.players.find((p) => p.id === ctx.world.me);
    return me?.profile ?? ctx.net.identity().profile;
  }
  const name = reply?.you?.name;
  const p = ctx.world.crew?.players.find((x) => x.name === name && x.profile?.badge === reply?.you?.badge);
  return p?.profile ?? null;
}

function useStats(ctx: ClientContext, saveId: string | null): { reply: StatsReply | null; loading: boolean; error: string | null } {
  const [reply, setReply] = useState<StatsReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    ctx.net.req('meta.stats', saveId ? { saveId } : {}).then(
      (r) => { if (alive) { setReply(r); setLoading(false); } },
      (e: unknown) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [ctx, saveId]);
  return { reply, loading, error };
}

export function StatsScreen({ ctx, saveId: sid0 }: ScreenProps) {
  useWorldV(ctx);
  const [saveId, setSaveId] = useState<string | null>(typeof sid0 === 'string' ? sid0 : null);
  const own = metaOf(ctx)?.you?.saveId ?? null;
  const { reply, loading, error } = useStats(ctx, saveId);
  useEffect(() => { sfx(ctx, 'sfx.ui_confirm'); }, [ctx]);
  const mine = !saveId || saveId === own;
  return (
    <div class="m-screen m-solid m-pf-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>CLOSE [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">VAN 9 · RECORDS BOARD · {mine ? 'YOUR FILE' : 'CREWMATE FILE'}</div>
            <h1 class="m-h1">Personnel file</h1>
          </div>
          {!mine && <button class="m-btn" onClick={() => setSaveId(null)}>BACK TO MY FILE</button>}
        </div>
        <PersonnelFile
          ctx={ctx} reply={reply} loading={loading} error={error} profile={profileFor(ctx, reply, mine)}
          shift={mine ? (metaOf(ctx)?.shiftLines ?? null) : null} crew={ctx.world.crew?.code ?? null} me={ctx.world.me}
          onPick={(id) => setSaveId(id === own ? null : id)}
        />
      </div>
    </div>
  );
}

/** pause menu 'Record' tab */
export function RecordTab({ ctx }: { ctx: ClientContext }) {
  useWorldV(ctx);
  const { reply, loading, error } = useStats(ctx, null);
  return (
    <div class="m-pf-tab">
      <PersonnelFile
        ctx={ctx} reply={reply} loading={loading} error={error} profile={profileFor(ctx, reply, true)}
        shift={metaOf(ctx)?.shiftLines ?? null} crew={ctx.world.crew?.code ?? null} me={ctx.world.me}
      />
    </div>
  );
}

// ---------------------------------------------------------------- main menu (before joining)

const LS_STATS = 'deadair.meta.stats';

function cached(): { at: string; reply: StatsReply } | null {
  try {
    const raw = localStorage.getItem(LS_STATS);
    const j = raw ? (JSON.parse(raw) as { at?: string; reply?: StatsReply }) : null;
    return j?.reply && typeof j.at === 'string' ? { at: j.at, reply: j.reply } : null;
  } catch {
    return null;
  }
}

/** main menu 'Personnel file': GET /api/stats with the browser key in a header (never the URL) */
export function MenuFilePanel({ ctx }: { ctx: ClientContext }) {
  const [c0] = useState(cached);
  const [reply, setReply] = useState<StatsReply | null>(c0?.reply ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let alive = true;
    const key = ctx.net.identity().playerKey;
    fetch('/api/stats', { headers: { 'x-deadair-key': key }, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<StatsReply>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!alive) return;
        setReply(j);
        setFresh(true);
        setLoading(false);
        try { localStorage.setItem(LS_STATS, JSON.stringify({ at: new Date().toISOString(), reply: j })); } catch { /* private mode */ }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [ctx]);
  const note = !fresh && c0 && reply ? `Copy on file from ${day(c0.at)}${error ? ' · the records office is offline' : ' · updating…'}` : null;
  return (
    <div class="m-pf-menu">
      <PersonnelFile ctx={ctx} reply={reply} loading={loading && !reply} error={reply ? null : error} profile={ctx.net.identity().profile} note={note} />
    </div>
  );
}
