// @ts-check
'use strict';
// Steam (main process only) via steamworks.js 0.4.0 (N-API, Steamworks SDK 1.60, steam_api64.dll bundled).
// Everything degrades to "not available": the game must run without Steam (Steam closed, not owned, no DLL).
//   * init() runs synchronously BEFORE app 'ready' (the overlay only hooks when SteamAPI_Init precedes the D3D device)
//   * invites / "Join Game": a FriendsOnly lobby carries the crew code (lobby data 'crew'); game traffic stays on the
//     game WebSocket. Friends join via GameLobbyJoinRequested (game running) or "+connect_lobby <id>" (cold start).
//   * rich presence: 'status' (free text, "view game info") + 'steam_display' token (friends list). App 480 (Spacewar)
//     only has Spacewar's tokens, so it shows "#StatusWithoutScore" + gamestatus instead.
const path = require('node:path');
const { normalizeCrew } = require('./config.cjs');

const LOBBY_FRIENDS_ONLY = 1; // matchmaking.LobbyType.FriendsOnly (a const enum in the d.ts: use the number)
const DIALOG_FRIENDS = 0; // overlay.Dialog.Friends
const GAME_TAG = 'deadair';
const SPACEWAR = 480;

/** @typedef {typeof import('steamworks.js')} SteamworksModule */
/** @typedef {ReturnType<SteamworksModule['init']>} SteamClient */
/** @typedef {import('steamworks.js/client').matchmaking.Lobby} Lobby */
/** @typedef {(msg: string) => void} LogFn */
/** @typedef {{ info: LogFn, warn: LogFn }} Logger */

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @template T
 * @param {Promise<T>} p @param {number} ms @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Packaged builds carry a trimmed copy in <app>/vendor/steamworks.js (scripts/pack.mjs; its win64 folder is
 * asar-unpacked next to steam_api64.dll); dev runs use node_modules.
 * @returns {{ mod: SteamworksModule | null, error: string | null }}
 */
function loadModule() {
  let last = 'not found';
  for (const id of [path.join(__dirname, '..', 'vendor', 'steamworks.js'), 'steamworks.js']) {
    try {
      return { mod: /** @type {SteamworksModule} */ (require(id)), error: null };
    } catch (e) {
      const code = /** @type {{ code?: string }} */ (e).code;
      if (code !== 'MODULE_NOT_FOUND') last = msg(e); // a real load error (e.g. VCRUNTIME140.dll missing) beats "not found"
    }
  }
  return { mod: null, error: `steamworks.js failed to load: ${last}` };
}

/**
 * @param {{ cfg: import('./config.cjs').DesktopConfig['steam'], log: Logger, serverOrigin: string }} opts
 */
function createSteam({ cfg, log, serverOrigin }) {
  const st = {
    enabled: cfg.enabled,
    available: false,
    appId: cfg.appId,
    error: /** @type {string | null} */ (null),
    personaName: /** @type {string | null} */ (null),
    steamId: /** @type {string | null} */ (null),
    overlay: false,
    restarting: false,
    lobbyId: /** @type {string | null} */ (null),
    crew: '',
    presence: '',
  };
  /** @type {SteamworksModule | null} */
  let sw = null;
  /** @type {SteamClient | null} */
  let client = null;
  /** @type {Lobby | null} */
  let lobby = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {((lobbyId: string, friendId: string) => void)[]} */
  const joinHandlers = [];

  /** serialize lobby / presence work (createLobby is async; presence updates can arrive in bursts) */
  /** @template T @param {() => Promise<T> | T} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  /** @param {string} key @param {string | null} value */
  const rp = (key, value) => {
    try {
      client?.localplayer.setRichPresence(key, value ?? undefined);
    } catch (e) {
      log.warn(`steam: setRichPresence(${key}) failed: ${msg(e)}`);
    }
  };

  const leaveLobby = () => {
    if (!lobby) return;
    try { lobby.leave(); } catch (e) { log.warn(`steam: leave lobby failed: ${msg(e)}`); }
    log.info(`steam: left lobby ${st.lobbyId}`);
    lobby = null;
    st.lobbyId = null;
    st.crew = '';
  };

  /** @param {string} crew */
  const ensureLobby = async (crew) => {
    if (!client || !cfg.lobby) return;
    if (!crew) return leaveLobby();
    if (lobby && st.crew === crew) return;
    leaveLobby();
    try {
      const l = await withTimeout(client.matchmaking.createLobby(LOBBY_FRIENDS_ONLY, cfg.lobbySize), 10_000, 'createLobby');
      l.mergeFullData({ game: GAME_TAG, crew, server: serverOrigin, v: '1' });
      lobby = l;
      st.lobbyId = String(l.id);
      st.crew = crew;
      log.info(`steam: friends-only lobby ${st.lobbyId} for crew ${crew}`);
    } catch (e) {
      log.warn(`steam: createLobby failed: ${msg(e)}`);
    }
  };

  /** @param {string} text @param {string} crew */
  const applyPresence = (text, crew) => {
    if (!client) return;
    st.presence = text;
    rp('status', text || null);
    if (st.appId === SPACEWAR) {
      // Spacewar's own localization: "#StatusWithoutScore" -> {#Status_%gamestatus%}
      rp('steam_display', text ? '#StatusWithoutScore' : null);
      rp('gamestatus', text ? (crew ? 'WaitingForMatch' : 'AtMainMenu') : null);
    } else {
      rp('steam_display', text ? cfg.presenceToken : null);
    }
    rp('crew', crew || null);
    rp('steam_player_group', crew || null);
    let size = null;
    try { size = crew && lobby ? String(Number(lobby.getMemberCount())) : null; } catch { size = null; }
    rp('steam_player_group_size', size);
    // off by default: with upstream steamworks.js a running friend gets GameRichPresenceJoinRequested, which it
    // cannot receive; the lobby is the join vehicle instead
    if (cfg.richPresenceConnect) rp('connect', crew ? `+crew ${crew}` : null);
  };

  return {
    state: st,

    /** Call synchronously before app 'ready'. @param {import('electron').App} app */
    initEarly(app) {
      if (!cfg.enabled) {
        st.error = 'disabled (config steam.enabled=false / --no-steam)';
        return st;
      }
      const loaded = loadModule();
      if (!loaded.mod) {
        st.error = loaded.error;
        return st;
      }
      sw = loaded.mod;
      if (cfg.restartIfNecessary && app.isPackaged && cfg.appId !== SPACEWAR) {
        try {
          if (sw.restartAppIfNecessary(cfg.appId)) {
            st.restarting = true;
            st.error = 'not launched by Steam: Steam relaunches the game';
            return st;
          }
        } catch (e) {
          log.warn(`steam: restartAppIfNecessary failed: ${msg(e)}`);
        }
      }
      try {
        client = sw.init(cfg.appId);
      } catch (e) {
        st.error = `Steam not available: ${msg(e)}`;
        client = null;
        return st;
      }
      st.available = true;
      try { st.appId = client.utils.getAppId(); } catch { /* keep the configured one */ }
      try { st.personaName = client.localplayer.getName(); } catch { st.personaName = null; }
      try { st.steamId = String(client.localplayer.getSteamId().steamId64); } catch { st.steamId = null; }
      try {
        const GameLobbyJoinRequested = /** @type {8} */ (sw.SteamCallback.GameLobbyJoinRequested);
        client.callback.register(GameLobbyJoinRequested, (v) => {
          const lobbyId = String(v.lobby_steam_id);
          log.info(`steam: GameLobbyJoinRequested lobby=${lobbyId}`);
          for (const h of joinHandlers) h(lobbyId, String(v.friend_steam_id));
        });
      } catch (e) {
        log.warn(`steam: callback register failed: ${msg(e)}`);
      }
      if (cfg.overlay) {
        // the overlay hooks D3D in the process that called SteamAPI_Init: keep the GPU in the browser process.
        // (steamworks.js electronEnableSteamOverlay() also adds disable-direct-composition and a 16 ms repaint
        // timer; the game canvas repaints every frame and the extra switch is only needed if the overlay is grey)
        app.commandLine.appendSwitch('in-process-gpu');
        if (cfg.overlayDisableDirectComposition) app.commandLine.appendSwitch('disable-direct-composition');
        st.overlay = true;
      }
      return st;
    },

    /** @param {(lobbyId: string, friendId: string) => void} fn */
    onJoinRequest(fn) {
      joinHandlers.push(fn);
    },

    /**
     * Joins a friend's DEAD AIR lobby and returns its crew code.
     * @param {string} lobbyId
     * @returns {Promise<{ crew: string, server: string, error: string | null }>}
     */
    joinLobby(lobbyId) {
      return serial(async () => {
        if (!client) return { crew: '', server: '', error: 'Steam not available' };
        if (!/^\d{1,20}$/.test(lobbyId)) return { crew: '', server: '', error: 'bad lobby id' };
        if (lobby && st.lobbyId === lobbyId) return { crew: st.crew, server: serverOrigin, error: null };
        try {
          const l = await withTimeout(client.matchmaking.joinLobby(BigInt(lobbyId)), 10_000, 'joinLobby');
          const crew = normalizeCrew(l.getData('crew') ?? '');
          if (l.getData('game') !== GAME_TAG || !crew) {
            try { l.leave(); } catch { /* ignore */ }
            return { crew: '', server: '', error: 'not a DEAD AIR lobby' };
          }
          if (lobby) leaveLobby();
          lobby = l;
          st.lobbyId = lobbyId;
          st.crew = crew;
          const server = l.getData('server') ?? '';
          log.info(`steam: joined lobby ${lobbyId}: crew ${crew}${server && server !== serverOrigin ? ` (lobby server ${server} differs from ours ${serverOrigin})` : ''}`);
          return { crew, server, error: null };
        } catch (e) {
          return { crew: '', server: '', error: msg(e) };
        }
      });
    },

    /**
     * Rich presence + the invite lobby. `crew` = the crew code the player is in ('' = not in a crew).
     * @param {string} text @param {string} crew
     */
    setPresence(text, crew) {
      return serial(async () => {
        if (!client) return false;
        await ensureLobby(crew);
        applyPresence(text, crew);
        return true;
      });
    },

    /**
     * Steam invite dialog for the crew's lobby (falls back to the Steam client window without the overlay).
     * @param {string} crew
     * @returns {Promise<{ ok: boolean, how: 'lobby' | 'friends' | 'none', error?: string }>}
     */
    inviteFriends(crew) {
      return serial(async () => {
        if (!client) return { ok: false, how: /** @type {const} */ ('none'), error: 'Steam not available' };
        if (crew) await ensureLobby(crew);
        try {
          if (lobby) {
            lobby.openInviteDialog();
            return { ok: true, how: /** @type {const} */ ('lobby') };
          }
          client.overlay.activateDialog(DIALOG_FRIENDS);
          return { ok: true, how: /** @type {const} */ ('friends') };
        } catch (e) {
          return { ok: false, how: /** @type {const} */ ('none'), error: msg(e) };
        }
      });
    },

    snapshot() {
      if (client) {
        try { st.personaName = client.localplayer.getName(); } catch { /* keep */ }
      }
      return { ...st };
    },

    /** Create a lobby, write + read its data, leave; set and clear presence. For scripts/smoke.mjs. */
    selftest() {
      return serial(async () => {
        /** @type {Record<string, unknown>} */
        const r = { init: st.available, appId: st.appId, personaName: !!st.personaName, error: null };
        if (!client) return { ...r, error: st.error };
        try {
          applyPresence('Steam self-test', '');
          r.presenceSet = true;
          const l = await withTimeout(client.matchmaking.createLobby(LOBBY_FRIENDS_ONLY, 2), 10_000, 'createLobby');
          r.lobbyCreated = true;
          r.lobbyDataSet = l.mergeFullData({ game: GAME_TAG, crew: 'SELFTEST' });
          r.lobbyDataRead = l.getData('crew');
          r.lobbyMembers = Number(l.getMemberCount());
          r.lobbyOwnerIsMe = String(l.getOwner().steamId64) === st.steamId;
          r.lobbyIdIsDigits = /^\d+$/.test(String(l.id));
          l.leave();
          r.lobbyLeft = true;
        } catch (e) {
          r.error = msg(e);
        } finally {
          applyPresence('', '');
        }
        return r;
      });
    },

    shutdown() {
      if (!client) return;
      leaveLobby();
      applyPresence('', '');
    },
  };
}

module.exports = { createSteam, GAME_TAG };
