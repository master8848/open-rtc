/**
 * Builds the vanilla example into a single browser bundle with the repo's
 * esbuild (already installed at the workspace root — no extra install).
 *
 *   node examples/vanilla/build.mjs
 *
 * The @vidcall/* packages are aliased to their TypeScript sources so the
 * example always builds against current code (no dist/ prerequisites).
 * @libsql/client resolves through its package.json `browser` condition.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)); // repo root

await build({
  entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  outfile: fileURLToPath(new URL('./dist/main.js', import.meta.url)),
  alias: {
    '@vidcall/core': root + 'packages/core/src/index.ts',
    '@vidcall/backend-sqlite': root + 'packages/backend-sqlite/src/index.ts',
    '@vidcall/transport': root + 'packages/transport/src/index.ts',
    '@vidcall/protocol': root + 'protocol/types.ts',
    '@vidcall/quality': root + 'packages/quality/src/index.ts',
  },
  logLevel: 'info',
});
