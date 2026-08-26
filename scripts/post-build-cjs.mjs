#!/usr/bin/env node
/**
 * post-build-cjs — rename CJS build .js -> .cjs so exports require: "./dist/*.cjs" resolves.
 * tsc with CommonJS emits .js; rslib emits .cjs natively. This script makes tsc fallback match exports.
 * Run after `tsc -p tsconfig.cjs.json` in packages that have dual ESM+CJS exports.
 * Usage: node scripts/post-build-cjs.mjs [distDir]
 */
import { readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && p.endsWith('.js')) {
      const cjs = p.replace(/\.js$/, '.cjs');
      const map = p + '.map';
      const cjsMap = cjs + '.map';
      try {
        copyFileSync(p, cjs);
        if (existsSync(map)) copyFileSync(map, cjsMap);
      } catch {}
    }
  }
}

// When invoked from package dir, dist is ./dist; from repo root, need to handle each package
if (existsSync(dist) && dist !== 'dist') {
  walk(dist);
  console.log(`post-build-cjs: copied ${dist}/*.js -> *.cjs`);
} else {
  const dists = [
    'protocol/dist',
    'packages/core/dist',
    'packages/transport/dist',
    'packages/quality/dist',
    'packages/react/dist',
    'packages/test-utils/dist',
    'packages/server/dist',
    'packages/sfu-gateway/dist',
    'packages/backend-supabase/dist',
    'packages/backend-convex/dist',
    'packages/backend-firebase/dist',
    'packages/backend-appwrite/dist',
    'packages/backend-postgres/dist',
    'packages/backend-sqlite/dist',
  ];
  for (const d of dists) {
    if (existsSync(d)) {
      walk(d);
      console.log(`post-build-cjs: copied ${d}/*.js -> *.cjs`);
    }
  }
  if (existsSync('dist')) {
    walk('dist');
    console.log(`post-build-cjs: copied dist/*.js -> *.cjs`);
  }
}
