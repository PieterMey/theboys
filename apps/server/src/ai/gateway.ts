// Owner: track (e) AI. The ONE module that talks to Claude and JEV (PLAN §4.8, docs/claude-api-notes.md).
//  - AI_MODE: mock (deterministic canned provider responses, no network) | record (live + save fixture) |
//    replay (fixtures from tests/ai/fixtures, no network) | live.
//  - Per-route timeouts (ms), circuit breaker (opens 60 s after 2 failures), one call in flight per route
//    (configurable), a per-session $ budget from response usage (survives restarts via the usage log window),
//    usage log logs/ai-usage.jsonl (numbers only: never prompts, transcripts or responses), kill switch on
//    spend-limit / auth errors.
//  - Claude: official SDK, client.messages.create with output_config.format json_schema, maxRetries 0,
//    branch on stop_reason (end_turn -> JSON.parse in try/catch; refusal / max_tokens -> caller falls back).
//  - JEV: plain fetch POST /v1/systemone (Bearer JEV_API_KEY, model jev-1.13.0, 900 ms, no retries).
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AiRouteStatus } from '@dead-air/shared/messages/ai.ts';
import type { Logger } from '../core/types.ts';

export type AiMode = 'mock' | 'record' | 'replay' | 'live';
export type Effort = 'low' | 'medium' | 'high';

const ROOT = resolve(import.meta.dirname, '../../../..');

export interface GatewayConfig {
  mode: AiMode;
  flags: Record<string, boolean>;
  /** balance.ai (read live: hot-reload safe) */
  bal: () => Record<string, unknown>;
  budgetUsd: () => number;
  log: Logger;
  /** usage log path (default <repo>/logs/ai-usage.jsonl; env AI_USAGE_LOG) */
  usageLog?: string;
  /** record/replay fixtures dir (default tests/ai/fixtures; env AI_FIXTURES_DIR) */
  fixturesDir?: string;
}

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface RouteState {
  calls: number;
  ok: number;
  fail: number;
  consecutiveFails: number;
  openUntil: number;
  inFlight: number;
  lastMs: number | null;
  recentMs: number[];
}

const envMode = (): AiMode => {
  const m = process.env.AI_MODE;
  return m === 'record' || m === 'replay' || m === 'live' ? m : 'mock';
};

const G = {
  cfg: {
    mode: envMode(),
    flags: {} as Record<string, boolean>,
    bal: (() => ({})) as () => Record<string, unknown>,
    budgetUsd: () => 3,
    log: nullLog,
    usageLog: process.env.AI_USAGE_LOG ?? join(ROOT, 'logs/ai-usage.jsonl'),
    fixturesDir: process.env.AI_FIXTURES_DIR ?? join(ROOT, 'tests/ai/fixtures'),
  },
  spentUsd: 0,
  disabled: null as string | null,
  providerDown: { anthropic: null as string | null, jev: null as string | null },
  routes: new Map<string, RouteState>(),
  client: null as Anthropic | null,
  jevHealthy: null as boolean | null,
  jevLastMs: null as number | null,
  shuffleSeq: 0,
};

export function configureGateway(c: GatewayConfig): void {
  G.cfg.mode = c.mode;
  G.cfg.flags = c.flags;
  G.cfg.bal = c.bal;
  G.cfg.budgetUsd = c.budgetUsd;
  G.cfg.log = c.log;
  G.cfg.usageLog = c.usageLog ?? process.env.AI_USAGE_LOG ?? join(ROOT, 'logs/ai-usage.jsonl');
  G.cfg.fixturesDir = c.fixturesDir ?? process.env.AI_FIXTURES_DIR ?? join(ROOT, 'tests/ai/fixtures');
  if (c.mode === 'live' || c.mode === 'record') G.spentUsd = readSpentFromLog();
}

/** Test helper: forget breakers, stats, spend and kill switches. */
export function resetGateway(): void {
  G.spentUsd = 0;
  G.disabled = null;
  G.providerDown.anthropic = null;
  G.providerDown.jev = null;
  G.routes.clear();
  G.jevHealthy = null;
  G.jevLastMs = null;
}

export function gatewayMode(): AiMode {
  return G.cfg.mode;
}

export function spentUsd(): number {
  return G.spentUsd;
}

/** Test helper: pretend money was spent (budget tests). */
export function addSpendForTest(usd: number): void {
  G.spentUsd += usd;
}

const num = (k: string, d: number): number => {
  const v = G.cfg.bal()[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

// ---------------------------------------------------------------- prices / budget / usage log

interface Price { in: number; out: number; cacheWrite: number; cacheRead: number }
const DEFAULT_PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Claude Haiku 5.5, prompts <= 100K tokens ($0.50 / $2.50 above; our prompts are ~2.6K)
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  jev: { in: 0.042, out: 0, cacheWrite: 0, cacheRead: 0 },
};

function priceOf(model: string): Price {
  const table = (G.cfg.bal().pricesPerMTok ?? {}) as Record<string, Partial<Price>>;
  const key = model.startsWith('jev') ? 'jev' : model;
  const p = table[key] ?? DEFAULT_PRICES[key] ?? (model.includes('haiku') ? DEFAULT_PRICES[model.includes('haiku-4') ? 'claude-haiku-4-5' : 'claude-haiku-5-5'] : DEFAULT_PRICES['claude-opus-5-5']);
  return { in: p.in ?? 4, out: p.out ?? 20, cacheWrite: p.cacheWrite ?? (p.in ?? 4) * 1.25, cacheRead: p.cacheRead ?? (p.in ?? 4) * 0.1 };
}

export interface UsageNums { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }

export function costUsd(model: string, u: UsageNums): number {
  const p = priceOf(model);
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
}

function readSpentFromLog(): number {
  const path = G.cfg.usageLog;
  if (!path || !existsSync(path)) return 0;
  const since = Date.now() - num('budgetWindowHours', 12) * 3600_000;
  let sum = 0;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { t?: string; usd?: number };
        if (typeof e.usd === 'number' && e.t && Date.parse(e.t) >= since) sum += e.usd;
      } catch { /* skip bad line */ }
    }
  } catch { /* unreadable: start at 0 */ }
  return sum;
}

interface UsageEntry { route: string; model: string; ms: number; ok: boolean; reason?: string; usage?: UsageNums; usd: number }

function logUsage(e: UsageEntry): void {
  if (G.cfg.mode !== 'live' && G.cfg.mode !== 'record') return; // mock/replay cost nothing
  const path = G.cfg.usageLog;
  if (!path) return;
  const row = {
    t: new Date().toISOString(), route: e.route, model: e.model, mode: G.cfg.mode, ms: Math.round(e.ms), ok: e.ok,
    reason: e.reason ?? null,
    in: e.usage?.input_tokens ?? 0, out: e.usage?.output_tokens ?? 0,
    cacheW: e.usage?.cache_creation_input_tokens ?? 0, cacheR: e.usage?.cache_read_input_tokens ?? 0,
    usd: Number(e.usd.toFixed(6)),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch (err) {
    G.cfg.log.warn(`usage log write failed (${err instanceof Error ? err.name : 'error'})`);
  }
}

/** Usage row for a non-Claude provider (ElevenLabs TTS): numbers only (characters, ms), never the text. */
export function logProviderUsage(e: { route: string; model: string; ms: number; ok: boolean; reason?: string; chars: number }): void {
  if (G.cfg.mode !== 'live' && G.cfg.mode !== 'record') return;
  const path = G.cfg.usageLog;
  if (!path) return;
  const row = { t: new Date().toISOString(), route: e.route, model: e.model, mode: G.cfg.mode, ms: Math.round(e.ms), ok: e.ok, reason: e.reason ?? null, chars: e.chars, usd: 0 };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch (err) {
    G.cfg.log.warn(`usage log write failed (${err instanceof Error ? err.name : 'error'})`);
  }
}

/** Rows + characters logged for `route` inside the budget window (restart-safe per-session caps). */
export function usageSince(route: string): { rows: number; chars: number } {
  const path = G.cfg.usageLog;
  if (G.cfg.mode !== 'live' && G.cfg.mode !== 'record') return { rows: 0, chars: 0 };
  if (!path || !existsSync(path)) return { rows: 0, chars: 0 };
  const since = Date.now() - num('budgetWindowHours', 12) * 3600_000;
  let rows = 0;
  let chars = 0;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line || !line.includes(route)) continue;
      try {
        const e = JSON.parse(line) as { t?: string; route?: string; chars?: number };
        if (e.route !== route || !e.t || Date.parse(e.t) < since) continue;
        rows++;
        if (typeof e.chars === 'number' && Number.isFinite(e.chars)) chars += e.chars;
      } catch { /* skip bad line */ }
    }
  } catch { /* unreadable: start at 0 */ }
  return { rows, chars };
}

// ---------------------------------------------------------------- route state / breaker

function route(name: string): RouteState {
  let r = G.routes.get(name);
  if (!r) {
    r = { calls: 0, ok: 0, fail: 0, consecutiveFails: 0, openUntil: 0, inFlight: 0, lastMs: null, recentMs: [] };
    G.routes.set(name, r);
  }
  return r;
}

function noteResult(name: string, ok: boolean, ms: number, countsAsFailure: boolean): void {
  const r = route(name);
  r.lastMs = Math.round(ms);
  r.recentMs.push(ms);
  if (r.recentMs.length > 20) r.recentMs.shift();
  if (ok) {
    r.ok++;
    r.consecutiveFails = 0;
    return;
  }
  r.fail++;
  if (!countsAsFailure) return;
  r.consecutiveFails++;
  if (r.consecutiveFails >= num('breakerFailures', 2)) {
    r.openUntil = performance.now() + num('breakerOpenMs', 60_000);
    r.consecutiveFails = 0;
    G.cfg.log.warn(`breaker OPEN for ${name} (${Math.round(num('breakerOpenMs', 60_000) / 1000)} s)`);
  }
}

function p50(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.floor((s.length - 1) / 2)]);
}

export function routeStatus(): Record<string, AiRouteStatus> {
  const out: Record<string, AiRouteStatus> = {};
  const now = performance.now();
  for (const [name, r] of G.routes) {
    out[name] = {
      calls: r.calls, ok: r.ok, fail: r.fail, lastMs: r.lastMs, p50Ms: p50(r.recentMs),
      breaker: r.openUntil > now ? 'open' : 'closed', openForSec: Math.max(0, Math.round((r.openUntil - now) / 1000)), inFlight: r.inFlight,
    };
  }
  return out;
}

export function gatewayHealth(): { enabled: boolean; reason: string | null; jevHealthy: boolean | null; jevLastMs: number | null } {
  const reason = G.disabled ?? (G.cfg.flags.ai === false ? 'flag ai off' : null);
  return { enabled: !reason, reason, jevHealthy: G.jevHealthy, jevLastMs: G.jevLastMs };
}

export type FailReason =
  | 'disabled' | 'nokey' | 'breaker' | 'busy' | 'budget' | 'timeout' | 'network' | 'rate_limit' | 'http' | 'parse'
  | 'refusal' | 'max_tokens' | 'replay_miss' | 'invalid' | 'error';

/** Can this route run right now? Returns the reason it can't, or null. */
function gate(name: string, provider: 'anthropic' | 'jev', estUsd: number, maxInFlight: number): FailReason | null {
  if (G.disabled || G.cfg.flags.ai === false) return 'disabled';
  if (provider === 'jev' && G.cfg.flags.jev === false) return 'disabled';
  if (G.providerDown[provider]) return 'disabled';
  const live = G.cfg.mode === 'live' || G.cfg.mode === 'record';
  // dev cost guard: AI_LIVE_ONLY=listener.lure,... lets only these routes (or prefixes) call a provider
  const only = process.env.AI_LIVE_ONLY;
  if (live && only && !only.split(',').some((r) => r.trim() && name.startsWith(r.trim()))) return 'disabled';
  if (live) {
    if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return 'nokey';
    if (provider === 'jev' && !process.env.JEV_API_KEY) return 'nokey';
  }
  const r = route(name);
  if (r.openUntil > performance.now()) return 'breaker';
  if (r.inFlight >= maxInFlight) return 'busy';
  if (live && G.spentUsd + estUsd > G.cfg.budgetUsd()) return 'budget';
  return null;
}

// ---------------------------------------------------------------- fixtures (record / replay)

export function fixtureKey(input: unknown): string {
  return createHash('sha256').update(stableJson(input)).digest('hex').slice(0, 16);
}

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

interface Fixture { route: string; key: string; provider: 'anthropic' | 'jev'; raw: unknown; ms?: number; error?: { kind: string; status?: number } }

function fixturePath(name: string, key: string): string {
  return join(G.cfg.fixturesDir, name.replace(/[^a-z0-9._-]/gi, '_'), `${key}.json`);
}

function loadFixture(name: string, input: unknown): Fixture | null {
  for (const key of [fixtureKey(input), 'default']) {
    const p = fixturePath(name, key);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Fixture;
    } catch {
      return null;
    }
  }
  return null;
}

function saveFixture(name: string, input: unknown, provider: 'anthropic' | 'jev', raw: unknown, ms: number): void {
  const key = fixtureKey(input);
  const p = fixturePath(name, key);
  try {
    mkdirSync(dirname(p), { recursive: true });
    // the request (which carries player transcripts) is never stored: only its hash and the provider response
    const f: Fixture = { route: name, key, provider, raw, ms: Math.round(ms) };
    writeFileSync(p, JSON.stringify(f, null, 1));
  } catch (e) {
    G.cfg.log.warn(`fixture write failed for ${name} (${e instanceof Error ? e.name : 'error'})`);
  }
}

// ---------------------------------------------------------------- Claude

export interface ClaudeReq {
  route: string;
  model: string;
  /** stable system prompt (cache-friendly: no timestamps/ids) */
  system: string;
  /** user content: JSON-encoded data (player speech is untrusted data) */
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Opus/Sonnet only. NEVER on Haiku 4.5. */
  effort?: Effort;
  timeoutMs: number;
  /** expected output tokens for the pre-call budget check */
  expectedOut?: number;
  /** concurrent calls allowed on this route (default 1) */
  maxInFlight?: number;
  /** stable fixture input (default: {system hash, user, model}) */
  fixtureInput?: unknown;
  /** mock mode: build a provider-shaped Message (content[0].text = JSON) */
  mock: () => MockMessage;
}

export interface MockMessage {
  stop_reason: string;
  content: { type: string; text?: string }[];
  usage?: UsageNums;
  stop_details?: { category?: string | null } | null;
}

export type ClaudeResult =
  | { ok: true; data: unknown; ms: number; usd: number; model: string }
  | { ok: false; reason: FailReason; ms: number; category?: string | null; status?: number };

function anthropicClient(): Anthropic {
  G.client ??= new Anthropic({ maxRetries: 0 });
  return G.client;
}

function isSpendLimit(e: InstanceType<typeof Anthropic.APIError>): boolean {
  const body = e.error as { error?: { type?: string; message?: string } } | undefined;
  const t = `${body?.error?.type ?? ''} ${body?.error?.message ?? ''} ${e.message}`.toLowerCase();
  return t.includes('spend limit') || t.includes('spend_limit') || t.includes('credit balance') || t.includes('usage limit');
}

/** Claude Haiku 5.5+ thinks adaptively by default and its thinking counts toward max_tokens, so a request sized for
 *  Haiku 4.5 (80-120 tokens) can stop at max_tokens before any JSON. Fast routes therefore run at the configured
 *  effort (balance haikuEffort, default 'low': measured p50 0.88 s against 1.70 s on Haiku 4.5, docs/claude-api-notes.md)
 *  with a max_tokens floor (haikuMinMaxTokens, default 1024; only produced tokens are billed). Haiku 4.5 rejects effort. */
export function haikuOpts(model: string, effort: Effort | undefined, maxTokens: number): { effort: Effort | undefined; maxTokens: number } {
  if (!/^claude-haiku-(?!4)/.test(model)) return { effort, maxTokens };
  const e = (G.cfg.bal().haikuEffort as Effort | undefined) ?? 'low';
  return { effort: effort ?? e, maxTokens: Math.max(maxTokens, num('haikuMinMaxTokens', 1024)) };
}

/** Parse a provider-shaped Message: branch on stop_reason, JSON.parse the text block. */
export function parseClaudeMessage(msg: MockMessage): { ok: true; data: unknown } | { ok: false; reason: FailReason; category?: string | null } {
  if (msg.stop_reason === 'refusal') return { ok: false, reason: 'refusal', category: msg.stop_details?.category ?? null };
  if (msg.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
  if (msg.stop_reason !== 'end_turn') return { ok: false, reason: 'invalid' };
  const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'parse' };
  }
}

export async function claudeJson(req: ClaudeReq): Promise<ClaudeResult> {
  const name = req.route;
  const est = costUsd(req.model, { input_tokens: Math.ceil((req.system.length + req.user.length) / 3.5), output_tokens: req.expectedOut ?? Math.min(req.maxTokens, 500) });
  const blocked = gate(name, 'anthropic', est, req.maxInFlight ?? 1);
  if (blocked) return { ok: false, reason: blocked, ms: 0 };
  const r = route(name);
  r.calls++;
  r.inFlight++;
  const t0 = performance.now();
  const fixtureInput = req.fixtureInput ?? { model: req.model, system: createHash('sha256').update(req.system).digest('hex').slice(0, 12), user: req.user };
  try {
    let msg: MockMessage;
    if (G.cfg.mode === 'mock') {
      msg = req.mock();
    } else if (G.cfg.mode === 'replay') {
      const f = loadFixture(name, fixtureInput);
      if (!f) {
        noteResult(name, false, 0, false);
        return { ok: false, reason: 'replay_miss', ms: 0 };
      }
      if (f.error) {
        noteResult(name, false, f.ms ?? 0, true);
        return { ok: false, reason: (f.error.kind as FailReason) ?? 'error', ms: f.ms ?? 0, status: f.error.status };
      }
      msg = f.raw as MockMessage;
    } else {
      const fast = haikuOpts(req.model, req.effort, req.maxTokens);
      const res = await anthropicClient().messages.create(
        {
          model: req.model,
          max_tokens: fast.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: fast.effort
            ? { effort: fast.effort, format: { type: 'json_schema', schema: req.schema } }
            : { format: { type: 'json_schema', schema: req.schema } },
        },
        { timeout: req.timeoutMs, maxRetries: 0 },
      );
      msg = res as unknown as MockMessage;
      if (G.cfg.mode === 'record') saveFixture(name, fixtureInput, 'anthropic', res, performance.now() - t0);
    }
    const ms = performance.now() - t0;
    const usd = G.cfg.mode === 'live' || G.cfg.mode === 'record' ? costUsd(req.model, msg.usage ?? {}) : 0;
    G.spentUsd += usd;
    const parsed = parseClaudeMessage(msg);
    logUsage({ route: name, model: req.model, ms, ok: parsed.ok, reason: parsed.ok ? undefined : parsed.reason, usage: msg.usage, usd });
    if (!parsed.ok) {
      if (parsed.reason === 'refusal') G.cfg.log.warn(`${name}: refusal (category ${parsed.category ?? 'none'})`);
      else G.cfg.log.warn(`${name}: ${parsed.reason}`);
      noteResult(name, false, ms, parsed.reason === 'parse' || parsed.reason === 'invalid');
      return { ok: false, reason: parsed.reason, ms, category: parsed.ok ? undefined : parsed.category };
    }
    noteResult(name, true, ms, false);
    return { ok: true, data: parsed.data, ms, usd, model: req.model };
  } catch (e) {
    const ms = performance.now() - t0;
    let reason: FailReason = 'error';
    let status: number | undefined;
    if (e instanceof Anthropic.APIConnectionTimeoutError) reason = 'timeout';
    else if (e instanceof Anthropic.RateLimitError) {
      reason = 'rate_limit';
      status = 429;
      if (isSpendLimit(e)) G.disabled = 'spend limit reached (429)';
    } else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      reason = 'http';
      status = e.status;
      G.providerDown.anthropic = `auth error ${e.status}`;
    } else if (e instanceof Anthropic.APIConnectionError) reason = 'network';
    else if (e instanceof Anthropic.APIError) {
      reason = 'http';
      status = e.status;
      if (e.status === 400 && isSpendLimit(e)) G.disabled = 'spend limit reached (400)';
    } else if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) reason = 'timeout';
    G.cfg.log.warn(`${name}: ${reason}${status ? ` (HTTP ${status})` : ''} after ${Math.round(ms)} ms`);
    logUsage({ route: name, model: req.model, ms, ok: false, reason, usd: 0 });
    noteResult(name, false, ms, true);
    return { ok: false, reason, ms, status };
  } finally {
    r.inFlight--;
  }
}

// ---------------------------------------------------------------- JEV (TypeSafe)

export interface JevQuestion {
  instructions: string;
  /** option id -> one-line description. Shuffled per call (first-option bias). */
  criteria: Record<string, string>;
}

export interface JevAnswer { choice: string; confidence: number; probabilities: Record<string, number> }

export interface JevReq {
  route: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  timeoutMs: number;
  fixtureInput?: unknown;
  mock: () => { answers: Record<string, Partial<JevAnswer>>; usage?: { input_tokens?: number } };
}

export type JevResult = { ok: true; answers: Record<string, JevAnswer>; ms: number } | { ok: false; reason: FailReason; ms: number; status?: number };

function jevModel(): string {
  const m = G.cfg.bal().jevModel;
  return typeof m === 'string' && m ? m : 'jev-1.13.0';
}

function jevUrl(): string {
  const u = G.cfg.bal().jevUrl;
  return typeof u === 'string' && u ? u.replace(/\/$/, '') : 'https://api.typesafe.ai/v1';
}

/** Deterministic per-call shuffle (no Math.random): rotates through permutations by a sequence counter. */
export function shuffledCriteria(c: Record<string, string>): Record<string, string> {
  const entries = Object.entries(c);
  let s = (++G.shuffleSeq * 2654435761) >>> 0 || 1;
  for (let i = entries.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return Object.fromEntries(entries);
}

function validAnswers(body: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> | null {
  const a = (body as { answers?: Record<string, Partial<JevAnswer>> } | null)?.answers;
  if (!a || typeof a !== 'object') return null;
  const out: Record<string, JevAnswer> = {};
  for (const q of Object.keys(questions)) {
    const x = a[q];
    if (!x || typeof x.choice !== 'string' || !(x.choice in questions[q].criteria)) return null;
    out[q] = {
      choice: x.choice,
      confidence: typeof x.confidence === 'number' && Number.isFinite(x.confidence) ? x.confidence : 0,
      probabilities: x.probabilities && typeof x.probabilities === 'object' ? x.probabilities : {},
    };
  }
  return out;
}

export async function jevChoose(req: JevReq): Promise<JevResult> {
  const name = req.route;
  const blocked = gate(name, 'jev', 0.0005, 1);
  if (blocked) return { ok: false, reason: blocked, ms: 0 };
  const r = route(name);
  r.calls++;
  r.inFlight++;
  const t0 = performance.now();
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
  for (const [k, q] of Object.entries(req.questions)) questions[k] = { type: 'choice', instructions: q.instructions, criteria: shuffledCriteria(q.criteria) };
  const fixtureInput = req.fixtureInput ?? { state: req.state, questions: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, Object.keys(q.criteria).sort()])) };
  try {
    let body: unknown;
    let tokens = 0;
    if (G.cfg.mode === 'mock') {
      body = req.mock();
    } else if (G.cfg.mode === 'replay') {
      const f = loadFixture(name, fixtureInput);
      if (!f) {
        noteResult(name, false, 0, false);
        return { ok: false, reason: 'replay_miss', ms: 0 };
      }
      if (f.error) {
        noteResult(name, false, f.ms ?? 0, true);
        return { ok: false, reason: (f.error.kind as FailReason) ?? 'error', ms: f.ms ?? 0, status: f.error.status };
      }
      body = f.raw;
    } else {
      const res = await fetch(`${jevUrl()}/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.JEV_API_KEY ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: jevModel(), state: req.state, questions }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const ms = performance.now() - t0;
        if (res.status === 401 || res.status === 403) G.providerDown.jev = `auth error ${res.status}`;
        G.cfg.log.warn(`${name}: JEV HTTP ${res.status} after ${Math.round(ms)} ms`);
        logUsage({ route: name, model: jevModel(), ms, ok: false, reason: 'http', usd: 0 });
        noteResult(name, false, ms, true);
        return { ok: false, reason: 'http', ms, status: res.status };
      }
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
      if (G.cfg.mode === 'record' && body) saveFixture(name, fixtureInput, 'jev', body, performance.now() - t0);
    }
    const ms = performance.now() - t0;
    tokens = Number((body as { usage?: { input_tokens?: number } } | null)?.usage?.input_tokens ?? 0) || 0;
    const usd = G.cfg.mode === 'live' || G.cfg.mode === 'record' ? costUsd('jev', { input_tokens: tokens }) : 0;
    G.spentUsd += usd;
    const answers = validAnswers(body, req.questions);
    logUsage({ route: name, model: jevModel(), ms, ok: !!answers, reason: answers ? undefined : 'invalid', usage: { input_tokens: tokens }, usd });
    if (!answers) {
      noteResult(name, false, ms, true);
      return { ok: false, reason: 'invalid', ms };
    }
    noteResult(name, true, ms, false);
    G.jevLastMs = Math.round(ms);
    if (G.cfg.mode === 'live' || G.cfg.mode === 'record') G.jevHealthy = true;
    return { ok: true, answers, ms };
  } catch (e) {
    const ms = performance.now() - t0;
    const reason: FailReason = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network';
    G.cfg.log.warn(`${name}: JEV ${reason} after ${Math.round(ms)} ms`);
    logUsage({ route: name, model: jevModel(), ms, ok: false, reason, usd: 0 });
    noteResult(name, false, ms, true);
    return { ok: false, reason, ms };
  } finally {
    r.inFlight--;
  }
}

/** Free health check (GET /v1/models, no tokens). Live/record only; mock/replay report healthy. */
export async function jevHealthCheck(timeoutMs = 3000): Promise<boolean> {
  if (G.cfg.mode === 'mock' || G.cfg.mode === 'replay') {
    G.jevHealthy = true;
    return true;
  }
  if (!process.env.JEV_API_KEY || G.cfg.flags.jev === false) {
    G.jevHealthy = false;
    return false;
  }
  const t0 = performance.now();
  try {
    const res = await fetch(`${jevUrl()}/models`, { headers: { authorization: `Bearer ${process.env.JEV_API_KEY}` }, signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    G.jevHealthy = res.ok;
    G.jevLastMs = Math.round(performance.now() - t0);
    if (res.status === 401 || res.status === 403) G.providerDown.jev = `auth error ${res.status}`;
    G.cfg.log.info(`JEV health: HTTP ${res.status} in ${G.jevLastMs} ms`);
    return res.ok;
  } catch (e) {
    G.jevHealthy = false;
    G.cfg.log.warn(`JEV health check failed (${e instanceof Error ? e.name : 'error'})`);
    return false;
  }
}
