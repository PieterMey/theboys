// @ts-check
'use strict';
// Preload for the shell's loading screen (static/splash.html, a local file in its own view over the game).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deadAirSplash', Object.freeze({
  /** @param {(s: unknown) => void} cb */
  onStatus: (cb) => {
    ipcRenderer.on('splash:status', (_e, s) => cb(s));
    ipcRenderer.send('splash:hello');
  },
  /** @param {'retry' | 'quit' | 'config' | 'reload'} what */
  action: (what) => ipcRenderer.send('splash:action', String(what)),
}));
