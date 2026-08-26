#!/usr/bin/env node
/**
 * llms-generate — TanStack pattern: emit llms.txt + llms-full.txt from docs/config.json
 * - .md URL parity: every markdown file maps to /docs/<path-without-.md>
 * - Last-Modified from fs mtime (ISO) so crawlers can diff
 * - Single source of truth is docs/config.json sidebar order
 *
 * Run: node scripts/llms-generate.mjs
 * Outputs: docs/llms.txt (index) and docs/llms-full.txt (concatenated)
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname ? join(import.meta.dirname, '..') : '.');
const CONFIG_PATH = join(REPO_ROOT, 'docs/config.json');
const DOCS_ROOT = join(REPO_ROOT, 'docs');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function titleOf(mdPath) {
  try {
    const text = readFileSync(mdPath, 'utf8');
    const m = text.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : mdPath.replace(REPO_ROOT + '/', '');
  } catch { return mdPath; }
}

function mdUrl(file) {
  const rel = file.replace(DOCS_ROOT + '/', '').replace(/\.md$/, '');
  // getting-started -> /docs/getting-started ; guides/deployment -> /docs/guides/deployment
  return `https://vidcall.dev/docs/${rel}`;
}

let sidebar = [];
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  for (const section of cfg.sidebar ?? []) {
    for (const item of section.items ?? []) {
      if (item.path) sidebar.push({ label: item.label, path: item.path, href: item.href });
    }
  }
} catch (e) {
  console.warn('llms-generate: no docs/config.json, falling back to filesystem walk');
}

let files = [];
if (sidebar.length) {
  files = sidebar.map(s => join(DOCS_ROOT, s.path));
} else {
  files = walk(DOCS_ROOT);
}

// ---- llms.txt (index) ----
const lines = [];
lines.push('# vidcall — llms.txt');
lines.push('> Peer-to-peer calling for any app — mesh WebRTC, pluggable signaling, adaptive quality.');
lines.push('');
lines.push(`> Generated: ${new Date().toISOString()} | Source: docs/config.json`);
lines.push('');
for (const f of files) {
  let mtime = '';
  try { mtime = statSync(f).mtime.toISOString(); } catch {}
  const url = mdUrl(f);
  const mdPath = f.replace(REPO_ROOT + '/', '');
  const title = titleOf(f);
  lines.push(`- [${title}](${url}) — ${mdPath}${mtime ? ` (Last-Modified: ${mtime})` : ''}`);
}
lines.push('');
lines.push('## Full content');
lines.push('See /llms-full.txt for concatenated markdown with URL parity.');
writeFileSync(join(REPO_ROOT, 'docs/llms.txt'), lines.join('\n'), 'utf8');
console.log(`Wrote docs/llms.txt (${files.length} entries)`);

// ---- llms-full.txt (concatenated) ----
const full = [];
full.push('# vidcall — llms-full.txt');
full.push(`> Generated: ${new Date().toISOString()} | Concatenated docs with .md URL parity`);
full.push('');
for (const f of files) {
  let mtime = '';
  try { mtime = statSync(f).mtime.toISOString(); } catch {}
  const url = mdUrl(f);
  const mdPath = f.replace(REPO_ROOT + '/', '');
  full.push(`---`);
  full.push(`## ${titleOf(f)}`);
  full.push(`Source: ${mdPath} | URL: ${url}${mtime ? ` | Last-Modified: ${mtime}` : ''}`);
  full.push('');
  try {
    const content = readFileSync(f, 'utf8');
    full.push(content.trim());
  } catch {}
  full.push('');
}
writeFileSync(join(REPO_ROOT, 'docs/llms-full.txt'), full.join('\n'), 'utf8');
console.log(`Wrote docs/llms-full.txt`);
