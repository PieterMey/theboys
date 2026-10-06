// Client build (integrator-owned). keepNames is REQUIRED: three's DynamicLighting batches by class name.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';

const here = import.meta.dirname;
const repo = resolve(here, '../..').split('\\').join('/');

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
      assetsDir: 'app', // '/assets/' is reserved for .assets/dist (game assets)
      target: 'es2023',
      sourcemap: true,
      chunkSizeWarningLimit: 4096,
      rolldownOptions: {
        input: { main: resolve(here, 'index.html'), voicetest: resolve(here, 'voicetest.html') },
        output: { keepNames: true },
      },
    },
    worker: { format: 'es' },
  };
});
