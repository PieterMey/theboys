// Owner: track (e) AI. Route director.pick (PLAN §3.10): JEV only, choosing among the events the deterministic
// director already allowed; any failure -> null -> the monsters track's weighted random pick. No Claude call.
import type { DirectorOption } from '@dead-air/shared/messages/ai.ts';
import { jevChoose, stableJson } from './gateway.ts';
import { balNum, flagOn, log } from './hub.ts';

const DEFAULT_DESC: Record<string, string> = {
  flicker: 'Lights flicker in a room near the crew',
  door_slam: 'A door slams somewhere close to the crew',
  doorSlam: 'A door slams somewhere close to the crew',
  hound_relocate: 'The Hound pads off to a different room',
  houndRelocate: 'The Hound pads off to a different room',
  mannequin_relocate: 'The Mannequin moves somewhere nobody is watching',
  mannequinRelocate: 'The Mannequin moves somewhere nobody is watching',
  fixture_fail: 'A light fixture dies for good',
  fixtureFail: 'A light fixture dies for good',
  radio_static: 'Every walkie hisses with static',
  radioStatic: 'Every walkie hisses with static',
  quiet: 'Nothing happens: let the crew breathe',
  quiet_period: 'Nothing happens: let the crew breathe',
};

const INSTRUCTIONS =
  'You are the pacing director of a co-op horror game. Given the tension state, which of these allowed events keeps the night scary but fair? ' +
  'Build dread when tension is low, let the crew breathe right after a peak or a death, and avoid repeating the last event.';

function normalize(allowed: readonly DirectorOption[]): { id: string; desc: string }[] {
  const out: { id: string; desc: string }[] = [];
  for (const o of allowed ?? []) {
    const id = typeof o === 'string' ? o : o && typeof o.id === 'string' ? o.id : '';
    if (!id || out.some((x) => x.id === id)) continue;
    const desc = typeof o === 'object' && o.desc ? String(o.desc).slice(0, 120) : DEFAULT_DESC[id] ?? id.replace(/[_-]+/g, ' ');
    out.push({ id, desc });
  }
  return out;
}

function compactState(state: unknown): unknown {
  try {
    const s = JSON.stringify(state ?? {});
    return s.length <= 2000 ? JSON.parse(s) : { summary: s.slice(0, 2000) };
  } catch {
    return {};
  }
}

export async function pick(state: unknown, allowed: readonly DirectorOption[]): Promise<string | null> {
  try {
    if (!flagOn('ai') || !flagOn('jev')) return null;
    const opts = normalize(allowed);
    if (opts.length === 0) return null;
    if (opts.length === 1) return opts[0].id;
    const criteria = Object.fromEntries(opts.map((o) => [o.id, o.desc]));
    const st = compactState(state);
    const res = await jevChoose({
      route: 'director.jev',
      state: st,
      questions: { event: { instructions: INSTRUCTIONS, criteria } },
      timeoutMs: balNum('directorTimeoutMs', 900),
      mock: () => {
        // deterministic: hash of the state picks an option
        let h = 0;
        for (const ch of stableJson(st)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
        const choice = opts[Math.abs(h) % opts.length].id;
        return { answers: { event: { choice, confidence: 0.6, probabilities: { [choice]: 0.6 } } }, usage: { input_tokens: 300 } };
      },
    });
    if (!res.ok) return null;
    const c = res.answers.event.choice;
    return opts.some((o) => o.id === c) ? c : null;
  } catch (e) {
    log().warn(`director route failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
