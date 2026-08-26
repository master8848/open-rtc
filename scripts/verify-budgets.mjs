#!/usr/bin/env node
/**
 * verify-budgets — enforces docs/AGENTS.md word budgets in CI.
 * Run: node scripts/verify-budgets.mjs  (or bun scripts/verify-budgets.mjs)
 * Exits 1 if any budget is exceeded.
 */
import { readFileSync } from 'node:fs';

const budgets = [
  { file: 'docs/AGENTS.md', limit: 1000 },
  { file: 'docs/architecture.md', limit: 1800 },
  { file: 'docs/limits.md', limit: 600 },
  { file: 'docs/testing.md', limit: 1000 },
  { file: 'docs/features/call-models.md', limit: 2200 },
  { file: 'docs/features/controls.md', limit: 2200 },
  { file: 'docs/features/scaling.md', limit: 2200 },
  { file: 'docs/guides/deployment.md', limit: 600 },
  { file: 'docs/guides/error-handling.md', limit: 600 },
  { file: 'docs/guides/testing.md', limit: 600 },
  { file: 'docs/guides/migration.md', limit: 600 },
];

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

let failed = false;
for (const { file, limit } of budgets) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const words = countWords(text);
  const ok = words <= limit;
  const tag = ok ? 'OK' : 'OVER';
  console.log(`${tag} ${file}: ${words}/${limit} words${ok ? '' : ' — exceeds budget'}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error('\nWord budget exceeded. Relocate to correct home, condense, then raise budget with justification per docs/AGENTS.md:17.');
  process.exit(1);
}
console.log('verify-budgets: all budgets OK');
