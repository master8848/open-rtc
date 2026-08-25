import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Packaging guards for the "zero database drivers by default" split:
 *
 *  1. The manifest keeps better-sqlite3/pg/mysql2 OUT of `dependencies`,
 *     lists each exactly once as an OPTIONAL peer AND as a devDependency
 *     with the identical exact pin (this repo's own tests still run them).
 *  2. No module reachable from the default entry statically imports an
 *     optional peer; dynamic driver loads are confined to `src/stores/*`,
 *     and the adapters hang off subpath exports instead of the barrel.
 *  3. At runtime, importing the barrel with every optional peer made
 *     unresolvable still succeeds (the consumer's zero-driver install).
 *  4. SQL store subpaths fail with an actionable install command when the
 *     driver is missing.
 *
 * These tests do not need the drivers themselves — they pass even on
 * installs where the optional peers are absent.
 */

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = new URL('../src/', import.meta.url);

/** Packages that must never load from the default entry. */
const OPTIONAL_PEERS = ['better-sqlite3', 'mysql2', 'pg', 'express', 'fastify'];

// ---------------------------------------------------------------------------
// 1. manifest conformance
// ---------------------------------------------------------------------------

test('packaging: drivers are optional peers + devDeps, not dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const dep of OPTIONAL_PEERS) {
    assert.ok(
      !(dep in (pkg.dependencies ?? {})),
      `${dep} must not be a regular dependency of @vidcall/server`,
    );
    const peer = pkg.peerDependencies?.[dep];
    assert.ok(peer, `${dep} must be listed in peerDependencies`);
    assert.match(String(peer), /^\d+\.\d+\.\d+$/, `${dep} peer pin must be exact (no ^/~)`);
    assert.equal(pkg.devDependencies?.[dep], peer, `${dep} dev pin must equal the peer pin`);
    assert.equal(pkg.peerDependenciesMeta?.[dep]?.optional, true, `${dep} peer must be optional`);
  }
});

test('packaging: subpath exports follow the types/development/default convention', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const entries = [
    { key: '.', srcPath: 'src/index.ts' },
    { key: './shared-tests', srcPath: 'src/shared-tests.ts' },
    { key: './express', srcPath: 'src/express.ts' },
    { key: './fastify', srcPath: 'src/fastify.ts' },
    { key: './stores/sqlite', srcPath: 'src/stores/SqliteStore.ts' },
    { key: './stores/postgres', srcPath: 'src/stores/PostgresStore.ts' },
    { key: './stores/mysql', srcPath: 'src/stores/MysqlStore.ts' },
  ];
  for (const { key, srcPath } of entries) {
    const entry = pkg.exports[key];
    assert.ok(entry, `exports["${key}"] missing`);
    assert.equal(
      entry.types,
      `./dist/${srcPath.replace(/^src\//, '').replace(/\.ts$/, '.d.ts')}`,
      `${key} types condition`,
    );
    assert.equal(entry.development, `./${srcPath}`, `${key} development condition`);
    assert.equal(
      entry.default,
      `./dist/${srcPath.replace(/^src\//, '').replace(/\.ts$/, '.js')}`,
      `${key} default condition`,
    );
    assert.ok(existsSync(new URL(`../${srcPath}`, import.meta.url)), `${srcPath} must exist`);
  }
});

// ---------------------------------------------------------------------------
// 2. static import graph purity (reachable from the default entry)
// ---------------------------------------------------------------------------

/** Strip comments + type-only re-exports/imports (erased at runtime anyway). */
function runtimeCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bimport\s+type\b[\s\S]*?['"][^'"]*['"];?/g, '')
    .replace(/\bexport\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/g, '');
}

test('packaging: default-entry graph never imports an optional peer statically', async () => {
  const visited = new Set<string>();
  const offenses: string[] = [];

  async function visit(fromUrl: URL): Promise<void> {
    if (visited.has(fromUrl.href)) return;
    visited.add(fromUrl.href);
    const raw = readFileSync(fromUrl, 'utf8');
    const code = runtimeCode(raw);

    // Every remaining specifier occurrence: `from 'x'`, `import('x')`, `import 'x'`.
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*[(]\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      const peer = OPTIONAL_PEERS.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (!peer) continue;
      const isDynamic = /\(\s*$/.test(m[0].replace(/['"][^'"]*['"]$/, ''));
      const inStoresDir = fromUrl.href.startsWith(srcDir.href + 'stores/');
      if (!isDynamic) {
        offenses.push(`${rel(fromUrl)}: static import of ${spec}`);
      } else if (!inStoresDir) {
        offenses.push(`${rel(fromUrl)}: dynamic ${spec} outside src/stores/`);
      }
    }

    // Walk the reachable graph via relative imports.
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*[(]\s*)['"](\.[^'"]+)['"]/g)) {
      const resolved = new URL(m[1]!, fromUrl);
      if (existsSync(resolved)) await visit(resolved);
    }
  }

  await visit(new URL('./index.ts', srcDir));

  // The adapters must hang off subpath exports, not the barrel: a static
  // express import here would crash every consumer without express installed.
  const barrel = runtimeCode(readFileSync(new URL('./index.ts', srcDir), 'utf8'));
  for (const adapter of ['express.ts', 'fastify.ts']) {
    if (barrel.includes(adapter)) offenses.push(`src/index.ts references ${adapter}`);
  }

  assert.deepEqual(offenses, [], 'optional-peer imports leaked into the default entry graph');
});

function rel(url: URL): string {
  return fileURLToPath(url).replace(pkgRoot, '');
}

// ---------------------------------------------------------------------------
// 3 + 4. runtime behavior with every optional peer blocked
// ---------------------------------------------------------------------------

function runGuarded(opts: { target: string; exportName?: string; url?: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(
    process.execPath,
    [
      '--conditions=development',
      fileURLToPath(new URL('./packaging/import-target.ts', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        VIDCALL_TARGET: opts.target,
        ...(opts.exportName ? { VIDCALL_EXPORT: opts.exportName } : {}),
        ...(opts.url ? { VIDCALL_URL: opts.url } : {}),
      },
    },
  );
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('packaging: importing the barrel succeeds with ALL optional peers unresolvable', () => {
  const res = runGuarded({ target: fileURLToPath(new URL('../src/index.ts', import.meta.url)) });
  assert.equal(
    res.status,
    0,
    `barrel failed to load without optional peers:\n${res.stderr}\n${res.stdout}`,
  );
  assert.match(res.stdout, /^OK/);
});

test('packaging: PostgresStore without pg fails with the install command', () => {
  const res = runGuarded({
    target: fileURLToPath(new URL('../src/stores/PostgresStore.ts', import.meta.url)),
    exportName: 'PostgresStore',
    url: 'postgres://vidcall:vidcall@127.0.0.1:5433/vidcall_test',
  });
  assert.match(res.stdout, /npm i pg/);
});

test('packaging: MysqlStore without mysql2 fails with the install command', () => {
  const res = runGuarded({
    target: fileURLToPath(new URL('../src/stores/MysqlStore.ts', import.meta.url)),
    exportName: 'MysqlStore',
    url: 'mysql://vidcall:vidcall@127.0.0.1:3307/vidcall_test',
  });
  assert.match(res.stdout, /npm i mysql2/);
});

// The sqlite driver is injected, not imported — so its actionable error is
// the constructor rejecting a bare file path (the classic misuse).
test('packaging: SqliteStore rejects a file path with the install hint', async () => {
  const { SqliteStore } = await import('../src/stores/SqliteStore.ts');
  const bad = 'vidcall.db' as unknown as ConstructorParameters<typeof SqliteStore>[0];
  assert.throws(() => new SqliteStore(bad), /npm i better-sqlite3/);
});
