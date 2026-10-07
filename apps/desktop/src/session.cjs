// @ts-check
'use strict';
// Unclean-exit marker. <userData>/running.json is written at launch, refreshed by the shell's heartbeat (when, and what
// the page was doing: loading / menu / crew / parked) and removed on a clean quit or when Windows ends the session.
// Still there at the next launch = the previous session never quit: a BSOD or hard reset (2026-10-07: five on the
// host PC with the app in the main menu), a killed process or a crash of the shell itself. main.cjs logs it with the
// last heartbeat and starts that one launch on safe graphics (config gpu.safeModeAfterCrash).
const fs = require('node:fs');

/**
 * @typedef {{
 *   v: 1, pid: number, startedAt: string, beatAt: string, version: string,
 *   phase: string, gpuFailures: number, safe: string
 * }} Marker
 */

/** @param {string} file @returns {Marker | null} */
function readMarker(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.v === 1 ? /** @type {Marker} */ (j) : null;
  } catch {
    return null;
  }
}

/** Durable write (fsync + rename): the file only matters if it survives a BSOD. @param {string} file @param {Marker} m */
function writeMarker(file, m) {
  const tmp = `${file}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(m));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file */
function removeMarker(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Did the previous session (the marker left behind) end without quitting?
 * @param {Marker | null} prev
 * @param {{ locked: boolean, bootTimeMs: number, isAlive: (pid: number) => boolean }} env
 *   locked: this process holds the single-instance lock of this userData, so no live instance can own the marker
 *   (the default profile); test profiles run unlocked and may share a folder with a live instance.
 * @returns {{ unclean: boolean, note: string }}
 */
function assessPrevious(prev, env) {
  if (!prev) return { unclean: false, note: '' };
  const last = Date.parse(prev.beatAt) || Date.parse(prev.startedAt);
  const rebooted = Number.isFinite(last) && last < env.bootTimeMs;
  if (!env.locked && !rebooted && env.isAlive(Number(prev.pid))) {
    return { unclean: false, note: `another instance (pid ${prev.pid}) owns this profile` };
  }
  const what = `started ${prev.startedAt || '?'}, last heartbeat ${prev.beatAt || '?'}, ${prev.phase || '?'}`
    + `${prev.gpuFailures ? `, ${prev.gpuFailures} GPU failure(s)` : ''}${prev.version ? `, v${prev.version}` : ''}`;
  return { unclean: true, note: `${rebooted ? 'Windows restarted while it ran' : 'it never quit'} (${what})` };
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

module.exports = { readMarker, writeMarker, removeMarker, assessPrevious, pidAlive };
