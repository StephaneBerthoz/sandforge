import type { ForgeGraphView } from '../types/forge.types.js';

/**
 * The values of the `sandforge.forge.graphView` setting, in a module that
 * holds no schema.
 *
 * The webview reads the setting from every settings message its bridge
 * receives, in the code every panel shares. It read it with
 * `forgeGraphViewSchema`, and that one parse put zod and the module of
 * Forge's schemas in every panel, Organizations or Settings alike.
 */
export const FORGE_GRAPH_VIEWS = [
  'auto',
  'graph',
  'table',
] as const satisfies readonly ForgeGraphView[];

/** Whether `value` is a value of the `sandforge.forge.graphView` setting. */
export function isForgeGraphView(value: unknown): value is ForgeGraphView {
  return typeof value === 'string' && (FORGE_GRAPH_VIEWS as readonly string[]).includes(value);
}
