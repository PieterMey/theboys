// Client build (integrator-owned). keepNames is REQUIRED: three's DynamicLighting batches by class name.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';

const here = import.meta.dirname;
const repo = resolve(here, '../..').split('\\').join('/');
/** '/assets/' is reserved for .assets/dist (game assets) */
const ASSETS_DIR = 'app';

/**
 * Chunk file names. Both pages (index + voicetest) share one chunk with the client core (context, frame loop, net,
 * world) and the voice code; rolldown named it after a voice module, so the [diag] LoAF 'top script' read
 * 'voice-<hash>.js:frame' for every long frame. The chunk that holds core/loop.ts is 'core-<hash>.js' instead; the
 * rest keep Vite's default ('[name]-[hash].js' under ASSETS_DIR).
 */
function chunkFileNames(chunk: { moduleIds: readonly string[] }): string {
  const hasLoop = chunk.moduleIds.some((id) => id.split('\\').join('/').endsWith('/apps/client/src/core/loop.ts'));
  return `${ASSETS_DIR}/${hasLoop ? 'core' : '[name]'}-[hash].js`;
}

/** Writes dist/build.json; the prod server rejects hellos from other builds with 'stale_build'. */
function buildInfo(build: string): Plugin {
  return {
    name: 'dead-air-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build, at: new Date().toISOString() }) });
    },
  };
}

export default defineConfig(({ command }) => {
  const build = command === 'build' ? `b${Date.now().toString(36)}` : 'dev';
  return {
    root: here,
    publicDir: false,
    plugins: [preact(), buildInfo(build)],
    define: { __BUILD_ID__: JSON.stringify(build) },
    resolve: { alias: [{ find: /^@dead-air\/shared\//, replacement: `${repo}/packages/shared/src/` }] },
    server: {
      fs: { allow: [repo], deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/saves/**', '**/logs/**'] },
    },
    build: {
      outDir: resolve(here, 'dist'),
      emptyOutDir: true,
      assetsDir: ASSETS_DIR,
      target: 'es2023',
      sourcemap: true,
      chunkSizeWarningLimit: 4096,
      rolldownOptions: {
        input: { main: resolve(here, 'index.html'), voicetest: resolve(here, 'voicetest.html') },
        output: { keepNames: true, chunkFileNames },
      },
    },
    worker: { format: 'es' },
  };
});
