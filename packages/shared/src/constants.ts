// FROZEN CONTRACT (P0) for cross-track constants. Tunable gameplay numbers live in config/balance/*.json;
// these are the defaults/semantics everyone must agree on.

export const TICK_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const POSE_HZ = 20;
export const MAX_PLAYERS = 6;

/** Loudness bands (index = value of `band`) */
export const BAND = { silent: 0, whisper: 1, talk: 2, shout: 3, scream: 4 } as const;
export type Band = (typeof BAND)[keyof typeof BAND];
export const BAND_NAMES = ['silent', 'whisper', 'talk', 'shout', 'scream'] as const;

/** Default audible / hearable radius in metres per band (path distance). Overridable in balance/voice.json */
export const BAND_RADIUS_M = [0, 3, 10, 25, 35] as const;
/** Receiver keeps the last non-silent radius for this long after a speaker turns silent (ms) */
export const BAND_HOLD_MS = 1500;
/** Detector thresholds relative to the speaker's calibrated talk baseline (dB) */
export const BAND_THRESH_DB = { whisperMax: -10, shoutMin: 8, screamMin: 16, screamHoldMs: 300, hysteresisDb: 2.5, holdMs: 200 } as const;

/** Walkie leak radius multiplier at the RECEIVING walkie (flagged: radioLeak) */
export const RADIO_LEAK_MULT = 0.6;

/** Noise radii (m) for non-voice sounds; monsters hear these through the same path-distance flood */
export const NOISE_M = {
  crouchStep: 1.5,
  walkStep: 5,
  sprintStep: 12,
  door: 6,
  securityDoor: 12,
  coreDrop: 15,
  bottle: 15,
  leverAlarm: 20,
  airhorn: 30,
  crowbar: 8,
  deadStatic: 6,
} as const;

/** Path-distance metric: octile steps (diagonal = SQRT2) over the edge grid; closed door +6 m, open door +1 m */
export const PATH = { diag: Math.SQRT2, doorOpenCost: 1, doorClosedCost: 6, unreachable: 255 } as const;

/** Movement (m/s) */
export const MOVE = { walk: 3.0, crouch: 1.5, sprint: 5.5, carryCoreMult: 0.55, staminaSec: 6, staminaRegenSec: 8 } as const;

/** Player capsule */
export const PLAYER = { radius: 0.3, height: 1.75, eye: 1.62, crouchEye: 1.0, interactRange: 2.0 } as const;

/** Contract clock: 22:00 -> 04:00 (360 in-game minutes) over CONTRACT_REAL_SEC real seconds (overridable in tests) */
export const CLOCK = { startHour: 22, totalGameMin: 360, realSec: 900, blackoutMin: 300, hornMin: 330 } as const;

/** World */
export const WORLD = { cell: 1, wallH: 3.0 } as const;

/** Voice transport */
export const VOICE = { sampleRate: 16000, chunkMs: 100, preRollMs: 300, maxSegmentMs: 10000 } as const;

/** ws */
export const NET = { pingMs: 20000, resumeHoldMs: 90000, maxPayload: 256 * 1024, maxBufferedBytes: 64 * 1024 } as const;

/** Crew code alphabet (consonants, no ambiguous letters) */
export const CREW_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CREW_CODE_LEN = 4;

/** Ports: main = 3000, worktree/track n = 3000 + n. STT sidecar default 3100. */
export const DEFAULT_PORT = 3000;
export const DEFAULT_STT_PORT = 3100;
