/**
 * Packaging guard child entry (run via `node --conditions=development`).
 *
 * Registers the blocking loader FIRST, then dynamically imports whatever
 * module `VIDCALL_TARGET` points at and exercises it:
 *
 *  - target = src/index.ts        → must load cleanly (exit 0, prints OK)
 *  - target = a SQL store module  → constructing with a connection string
 *    and calling bootstrap() must fail with an actionable message naming
 *    the missing optional peer's install command.
 */
import { register } from 'node:module';

register('./no-driver-loader.ts', import.meta.url);

const target = process.env.VIDCALL_TARGET;
if (!target) {
  console.error('VIDCALL_TARGET not set');
  process.exit(1);
}

const mod = await import(target);
const exportName = process.env.VIDCALL_EXPORT;

if (!exportName) {
  // Barrel mode: loading the entry at all is the assertion.
  console.log('OK', Object.keys(mod).length > 0 ? '' : 'no exports');
  process.exit(0);
}

const Store = mod[exportName];
if (typeof Store !== 'function') {
  console.error(`${exportName} not exported`);
  process.exit(1);
}
try {
  const url = process.env.VIDCALL_URL;
  const store = new Store(url);
  await store.bootstrap();
  console.error('UNEXPECTED: bootstrap succeeded without the driver');
  process.exit(1);
} catch (err) {
  console.log(`ACTIONABLE: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
