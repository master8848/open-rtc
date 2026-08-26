/**
 * @mbsks/openrtc-server — plugin system.
 *
 * Framework-agnostic extensibility mirroring client composability:
 * plugins contribute routes and lifecycle hooks without extra deps.
 *
 * Usage:
 *   const myPlugin = definePlugin({ name: 'my-plugin', routes: [...] });
 *   const routes = applyPlugins(baseRoutes, [myPlugin]);
 *   // or
 *   const routes = withPluginRoutes(baseRoutes, [myPlugin]);
 *   await dispatch(services, ctx, routes);
 */

import type { Route } from './http.ts';
import type { Services } from './services.ts';

/** A server plugin — contributes routes and optional lifecycle. */
export interface ServerPlugin {
  /** Unique plugin name (used for diagnostics/dedup). */
  name: string;
  /** Optional semver/version string. */
  version?: string;
  /** Routes contributed by the plugin (mounted alongside core routes). */
  routes?: Route[];
  /**
   * One-time setup called with resolved Services. Use to seed state,
   * register webhooks, or augment services via side-effects.
   */
  setup?: (services: Services) => void | Promise<void>;
  /** Optional hook to extend/override Services before setup. */
  extendServices?: (services: Services) => Services | void | Promise<Services | void>;
}

/** Define a plugin with type-checking and passthrough (like client definePlugin). */
export function definePlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin;
}

/**
 * Merge base routes with plugin routes (base first, plugins in order).
 * No dedup — plugins may intentionally override by adding same pattern
 * later; dispatch matches first, so base wins. Reorder if overrides needed.
 */
export function applyPlugins(
  baseRoutes: readonly Route[],
  plugins: readonly ServerPlugin[],
): Route[] {
  const extra: Route[] = [];
  for (const p of plugins) {
    if (p.routes?.length) extra.push(...p.routes);
  }
  return [...baseRoutes, ...extra];
}

/** Alias for applyPlugins — ergonomic when composing route arrays. */
export function withPluginRoutes(
  baseRoutes: readonly Route[],
  plugins: readonly ServerPlugin[],
): readonly Route[] {
  return applyPlugins(baseRoutes, plugins);
}

/**
 *Run plugin lifecycle in order: extendServices then setup.
 * Returns possibly-augmented Services (shallow-merged).
 */
export async function setupPlugins(
  services: Services,
  plugins: readonly ServerPlugin[],
): Promise<Services> {
  let current: Services = services;
  for (const p of plugins) {
    if (p.extendServices) {
      const next = await p.extendServices(current);
      if (next) current = next;
    }
  }
  for (const p of plugins) {
    await p.setup?.(current);
  }
  return current;
}
