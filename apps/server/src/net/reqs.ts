// Owner: track ① Net. Crew/lobby requests from messages/net.ts: crew.ready, crew.kick, profile.set,
// consent.set, admin.createCrew. ('claim' belongs to the meta track's PlayerSave flow and is NOT registered here.)
import { PROFILE_LIMITS } from '@dead-air/shared/profile.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import type { ServerContext } from '../core/types.ts';
import type { CrewCore } from '../core/crews.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

function cleanProfile(p: unknown, prev: Profile): Profile {
  if (!p || typeof p !== 'object') return prev;
  const q = p as Partial<Profile>;
  const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);
  const name = String(q.name ?? prev.name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, PROFILE_LIMITS.nameMax) || prev.name;
  return {
    name,
    body: q.body === 'f' ? 'f' : q.body === 'm' ? 'm' : prev.body,
    suit: [hex(q.suit?.[0], prev.suit[0]), hex(q.suit?.[1], prev.suit[1])],
    helmet: q.helmet === 'box' || q.helmet === 'diver' || q.helmet === 'dome' ? q.helmet : prev.helmet,
    visor: {
      glyphs: String(q.visor?.glyphs ?? prev.visor.glyphs).slice(0, PROFILE_LIMITS.glyphsMax),
      color: hex(q.visor?.color, prev.visor.color),
    },
    badge: Number.isInteger(q.badge) && (q.badge as number) > 0 && (q.badge as number) < 100000 ? (q.badge as number) : prev.badge,
  };
}

export function installReqs(ctx: ServerContext): void {
  const core = () => ctx.crews as Partial<CrewCore>;
  const isAdmin = (id: string) => core().isAdmin?.(id) === true;

  ctx.registerReq('crew.ready', (crew, player, args) => {
    player.ready = !!args?.ready;
    ctx.crews.broadcastRoster(crew);
    return { ok: true as const };
  });

  ctx.registerReq('crew.kick', (crew, player, args) => {
    const id = String(args?.id ?? '');
    if (!player.isLeader && !isAdmin(player.id)) throw new Error('only the crew leader or the host can kick');
    if (id === player.id) throw new Error('you cannot kick yourself');
    const target = crew.players.get(id);
    if (!target) throw new Error('no such player');
    ctx.notice(crew, `${target.name} was removed from the crew`, 'warn');
    ctx.crews.kick(crew, id, `removed by ${player.name}`);
    return { ok: true as const };
  });

  ctx.registerReq('profile.set', (crew, player, args) => {
    player.profile = cleanProfile(args?.profile, player.profile);
    player.name = player.profile.name;
    ctx.crews.broadcastRoster(crew);
    return { ok: true as const };
  });

  ctx.registerReq('consent.set', (crew, player, args) => {
    player.consent = { transcribe: !!args?.transcribe, mimic: !!args?.mimic };
    ctx.crews.broadcastRoster(crew);
    return { ok: true as const };
  });

  ctx.registerReq('admin.createCrew', (_crew, player, args) => {
    if (!isAdmin(player.id) && !ctx.env.dev) throw new Error('host only');
    const code = typeof args?.code === 'string' && args.code ? args.code : undefined;
    const existing = code ? ctx.crews.get(code) : undefined;
    if (existing) return { code: existing.code };
    const crew = ctx.crews.create(code, { password: typeof args?.password === 'string' && args.password ? args.password : undefined });
    return { code: crew.code };
  });
}
