/**
 * Packaging guard: ESM resolve hook that makes every optional peer of
 * `@vidcall/server` (the SQL drivers + the framework adapters' packages)
 * unresolvable. Used by `../packaging.test.ts` to prove that importing the
 * default entry never loads a database driver, and that store subpaths
 * fail with the actionable install error instead.
 */
const FORBIDDEN = /^(better-sqlite3|mysql2|pg|express|fastify)(\/|$)/;

export async function resolve(
  specifier: string,
  context: object | undefined,
  next: (specifier: string, context: object | undefined) => Promise<unknown>,
): Promise<unknown> {
  if (FORBIDDEN.test(specifier)) {
    throw new Error(`[packaging test] blocked optional peer: ${specifier}`);
  }
  return next(specifier, context);
}
