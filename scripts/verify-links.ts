/**
 * verify-links — port of TanStack/form#2278 concept.
 * Checks every relative markdown link in docs/ resolves to a file on disk.
 * Run: bun run scripts/verify-links.ts  (or: bunx tsx scripts/verify-links.ts)
 * Exit 1 on broken links so CI can gate.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const DOCS_ROOT = resolve(import.meta.dirname ?? '.', '../docs');
const REPO_ROOT = resolve(DOCS_ROOT, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

let broken = 0;
let checked = 0;

for (const file of walk(DOCS_ROOT)) {
  const text = readFileSync(file, 'utf8');
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text))) {
    const raw = m[2].trim();
    // Skip external, hash-only, mailto, and image-absolute links
    if (/^(https?:|mailto:|#|data:)/.test(raw)) continue;
    // Strip hash and query
    const [withoutHash] = raw.split('#');
    const [withoutQuery] = (withoutHash ?? '').split('?');
    const target = (withoutQuery ?? '').trim();
    if (!target) continue;
    // Strip leading /docs/ or / mapping to docs/
    let resolved: string;
    if (target.startsWith('/')) {
      // Treat /docs/* or /packages/* as repo-relative
      resolved = resolve(REPO_ROOT, target.slice(1));
    } else {
      resolved = resolve(dirname(file), target);
    }
    // Allow links to directories with index/readme, and to .md without extension
    const candidates = [resolved, `${resolved}.md`, join(resolved, 'README.md'), join(resolved, 'index.md')];
    const exists = candidates.some((c) => existsSync(c) && statSync(c).isFile()) || (existsSync(resolved) && statSync(resolved).isDirectory());
    checked++;
    if (!exists) {
      const rel = relative(REPO_ROOT, file);
      console.error(`BROKEN: ${rel} -> ${raw} (resolved ${relative(REPO_ROOT, resolved)})`);
      broken++;
    }
  }
}

console.log(`verify-links: checked ${checked} relative links, ${broken} broken`);
if (broken > 0) process.exit(1);
