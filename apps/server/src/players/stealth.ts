// Owner: players-stealth (v1.2). Pure footstep-speed tracker for the server's honest footsteps (flag stealthV12):
// the speed a player really moves at, from the poses the server stored, robust to how they arrive.
//
// Timing (plan critic + check #24p): a window of at least `windowSec` of pose sequence numbers (the client sends one
// pose per 50 ms and numbers them), with dt = max(seq steps x 50 ms, arrival-time span - jitterSec) over that window:
//   * bunched frames over the tunnel (3 poses in 2 ms, then 150 ms of nothing) never shorten dt below the seq time, so
//     a creeper never reads as a walker: the estimate is at most the true speed x the client's timer drift (~1.1);
//   * a client that sends fewer poses than 20/s (below ~10 fps its pose timer slips) has an arrival span longer than
//     its seq time, so the arrival span decides;
//   * delivery jitter up to jitterSec does not lengthen dt (a 3.5 m/s walker keeps reading 3.5 with 90 ms of jitter);
//     more jitter only reads slow, never against the player.
// A client whose sequence numbers advance much faster than wall time for `inflateSec` (sustained seq/arrival > 1.6
// over the rate window: a modified client inflating seq to look slow) is timed by arrival spans alone from then on.
// No Math.random / trig: deterministic for tests.

export const SEQ_STEP_SEC = 0.05;

export interface PoseSample {
  seq: number;
  /** arrival time, ms (performance.now()) */
  at: number;
  x: number;
  z: number;
  /** path length (m) from the first sample of this track up to here */
  cum: number;
}

export interface StealthTrack {
  samples: PoseSample[];
  /** windowed speed (>= windowSec), m/s: the crouch rule */
  speed: number;
  /** short-window speed (>= sprintWindowSec), m/s: the sprint rule reacts within ~0.2 s */
  fastSpeed: number;
  /** seconds the windowed speed has stayed above the crouch limit (resets when it drops) */
  overSec: number;
  /** seconds the seq/arrival ratio has stayed above the inflation limit */
  inflatedSec: number;
  /** timed by arrival spans only (seq inflation detected) */
  arrivalOnly: boolean;
  /** dt (s) of the window used for `speed` */
  windowDt: number;
}

export interface TrackOpts {
  /** minimum window (s of seq time) for the speed */
  windowSec: number;
  /** minimum window for fastSpeed (the sprint rule); short windows can only read slow under jitter, never fast */
  sprintWindowSec: number;
  /** history kept for the seq-rate sanity check (s of arrival time) */
  rateWindowSec: number;
  /** a jump longer than this between two stored poses is a teleport / respawn: the track restarts */
  maxJumpM: number;
  /** crouch limit (m/s) whose over-time feeds overSec */
  crouchMaxSpeed: number;
  /** delivery jitter (s) the arrival span may carry before it lengthens dt */
  jitterSec: number;
  /** seq time faster than arrival time by this ratio, sustained for inflateSec, switches to arrival timing */
  inflateRatio: number;
  inflateSec: number;
}

export const DEFAULT_TRACK_OPTS: TrackOpts = {
  windowSec: 0.5, sprintWindowSec: 0.2, rateWindowSec: 3, maxJumpM: 3, crouchMaxSpeed: 3, jitterSec: 0.1, inflateRatio: 1.6, inflateSec: 3,
};

export function newTrack(): StealthTrack {
  return { samples: [], speed: 0, fastSpeed: 0, overSec: 0, inflatedSec: 0, arrivalOnly: false, windowDt: 0 };
}

/** forget the motion history (teleport, respawn, new layout, reconnect); keeps the seq-inflation verdict */
export function resetTrack(t: StealthTrack): void {
  t.samples.length = 0;
  t.speed = 0;
  t.fastSpeed = 0;
  t.overSec = 0;
  t.windowDt = 0;
}

/** speed over the shortest suffix of samples ending at the newest with >= minSec of seq time (arrival time once seq
 *  is not trusted; all of the history when there is less), with dt = max(seq time, arrival span - jitterSec) */
function windowSpeed(t: StealthTrack, minSec: number, o: TrackOpts): { speed: number; dt: number } {
  const n = t.samples.length;
  const cur = t.samples[n - 1];
  const span = (s: PoseSample) => (t.arrivalOnly ? (cur.at - s.at) / 1000 : (cur.seq - s.seq) * SEQ_STEP_SEC);
  let j = n - 2;
  while (j > 0 && span(t.samples[j]) < minSec) j--;
  const w = t.samples[j];
  const wSeq = (cur.seq - w.seq) * SEQ_STEP_SEC;
  const wArr = Math.max(0, (cur.at - w.at) / 1000);
  const dt = t.arrivalOnly ? Math.max(wArr, 0.02) : Math.max(wSeq, wArr - o.jitterSec);
  return { speed: dt > 0 ? (cur.cum - w.cum) / dt : 0, dt };
}

const MAX_SAMPLES = 160;

/**
 * Feed the newest stored pose. Returns the move since the previous sample ({d metres, dt seconds}), or null when the
 * track (re)started here (first pose, a lower seq = new connection, or a teleport-sized jump).
 */
export function feedPose(t: StealthTrack, seq: number, at: number, x: number, z: number, o: TrackOpts = DEFAULT_TRACK_OPTS): { d: number; dt: number } | null {
  if (!Number.isFinite(seq) || !Number.isFinite(at) || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const prev = t.samples[t.samples.length - 1];
  if (!prev) {
    t.samples.push({ seq, at, x, z, cum: 0 });
    return null;
  }
  if (seq <= prev.seq) {
    resetTrack(t);
    t.samples.push({ seq, at, x, z, cum: 0 });
    return null;
  }
  const d = Math.hypot(x - prev.x, z - prev.z);
  if (d > o.maxJumpM) {
    resetTrack(t);
    t.samples.push({ seq, at, x, z, cum: 0 });
    return null;
  }
  const cur: PoseSample = { seq, at, x, z, cum: prev.cum + d };
  t.samples.push(cur);
  // history: the rate window, at least the speed window, never unbounded
  const keepMs = Math.max(o.rateWindowSec, o.windowSec * 2) * 1000;
  let drop = 0;
  while (drop < t.samples.length - 2 && (cur.at - t.samples[drop + 1].at > keepMs || t.samples.length - drop > MAX_SAMPLES)) drop++;
  if (drop) t.samples.splice(0, drop);

  const seqDt = (seq - prev.seq) * SEQ_STEP_SEC;
  const arrDt = Math.max(0, (at - prev.at) / 1000);
  const stepDt = t.arrivalOnly ? arrDt : Math.max(seqDt, arrDt);

  // seq-inflation check over the rate window (sustained only: one late burst after a stall is not inflation)
  const first = t.samples[0];
  const seqSpan = (seq - first.seq) * SEQ_STEP_SEC;
  const arrSpan = (at - first.at) / 1000;
  if (!t.arrivalOnly && arrSpan >= 1 && seqSpan > arrSpan * o.inflateRatio + 0.25) {
    t.inflatedSec += arrDt;
    if (t.inflatedSec >= o.inflateSec) t.arrivalOnly = true;
  } else t.inflatedSec = 0;

  const main = windowSpeed(t, o.windowSec, o);
  t.windowDt = main.dt;
  t.speed = main.speed;
  t.fastSpeed = windowSpeed(t, o.sprintWindowSec, o).speed;
  if (t.speed > o.crouchMaxSpeed) t.overSec += stepDt;
  else t.overSec = 0;
  return { d, dt: stepDt };
}

/** windowed speed, or 0 when the newest pose is older than staleMs (a stalled or idle connection) */
export function speedAt(t: StealthTrack, nowMs: number, staleMs = 1000): number {
  const last = t.samples[t.samples.length - 1];
  if (!last || nowMs - last.at > staleMs) return 0;
  return t.speed;
}

/** the speed the sprint rule reads: the faster of both windows (0 when stale) */
export function sprintProbeAt(t: StealthTrack, nowMs: number, staleMs = 1000): number {
  const last = t.samples[t.samples.length - 1];
  if (!last || nowMs - last.at > staleMs) return 0;
  return Math.max(t.speed, t.fastSpeed);
}

/** STANCE values (packages/shared/src/state.ts), duplicated as numbers to keep this module dependency-free */
const ST = { stand: 0, crouch: 1, sprint: 2, hidden: 3, dead: 4 } as const;

export interface JudgeOpts {
  crouchOverSpeedSec: number;
  sprintSpeed: number;
}

/**
 * The stance the server believes for stealth (footstep kind, Listener crouch sight / low cover): a crouch claim above
 * crouchMaxSpeed for crouchOverSpeedSec reads as stand (walking), any speed above sprintSpeed as sprint, a claimed
 * sprint as sprint, hidden only when `hidden` (interaction's isHidden), dead only when not `alive`; a claimed hidden or
 * dead stance from a living, unhidden player reads as stand. `sprintSpeedNow` (default `speed`) is what the sprint
 * rule reads (sprintProbeAt: the short window, so a sprint shows within ~0.2 s).
 */
export function judgeStance(claim: number, speed: number, overSec: number, alive: boolean, hidden: boolean, o: JudgeOpts, sprintSpeedNow = speed): number {
  if (!alive) return ST.dead;
  if (hidden) return ST.hidden;
  if (Math.max(speed, sprintSpeedNow) > o.sprintSpeed) return ST.sprint;
  if (claim === ST.sprint) return ST.sprint;
  if (claim === ST.crouch) return overSec >= o.crouchOverSpeedSec ? ST.stand : ST.crouch;
  return ST.stand;
}

export type StepKindName = 'crouchStep' | 'walkStep' | 'sprintStep';

/** footstep kind for a judged stance (hidden / dead never step) */
export function stepKindOf(stance: number): StepKindName | null {
  if (stance === ST.crouch) return 'crouchStep';
  if (stance === ST.sprint) return 'sprintStep';
  if (stance === ST.stand) return 'walkStep';
  return null;
}
