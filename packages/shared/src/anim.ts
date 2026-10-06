// FROZEN CONTRACT (P0): animation ids carried in Pose.anim / SnapMonster.anim.
// Players track maps these to UAL clip names; monsters track to their rigs. Add new ids at the end only.

export const ANIM = {
  idle: 0,
  walk: 1,
  jog: 2,
  sprint: 3,
  crouchIdle: 4,
  crouchWalk: 5,
  interact: 6,
  pickup: 7,
  carry: 8,
  carryWalk: 9,
  throw: 10,
  swing: 11,
  death: 12,
  hidden: 13,
  emoteWave: 14,
  emotePoint: 15,
  emoteBeckon: 16,
  emoteThumbs: 17,
  grabbed: 18,
  // monsters
  mIdle: 40,
  mWalk: 41,
  mRun: 42,
  mAttack: 43,
  mAlert: 44,
  mEat: 45,
  mFrozen: 46,
} as const;

export type AnimId = (typeof ANIM)[keyof typeof ANIM];
