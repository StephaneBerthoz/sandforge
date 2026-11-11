import { create } from 'zustand';
import { isForgeGraphView } from '@sandforge/shared';
import type { ForgeGraphView } from '@sandforge/shared';

/** What the discovery, Review and execution screens show a graph's objects as. */
export type ForgeObjectsView = 'graph' | 'table';

/**
 * The most objects `auto` draws as a graph; past it, the discovery, Review
 * and execution screens list them in a table.
 *
 * Measured in Chromium on the production bundle, at 1280×720: each progress
 * event of a run redraws the whole execution graph, about 2.5 ms per object —
 * 65 ms at 25 objects, 98 ms at 40, 120 ms at 50, 1.1 s at 400 — while the
 * extension sends a run's progress up to ten times a second. Past about 40
 * objects the graph takes longer to redraw than the time between two events,
 * and the panel stops answering until the run ends. At 25 a redraw keeps a
 * third of that time free. The table redraws the one row an event is about:
 * one frame per event, 400 objects or 10.
 */
export const FORGE_GRAPH_MAX_OBJECTS = 25;

/**
 * The most objects a screen draws as a graph because the setting says
 * `graph`, or because the switch was set to the graph on a smaller one; past
 * it, and for every clone of the whole org, the graph is large
 * ({@link forgeGraphIsLarge}).
 *
 * Laying a graph out (dagre) then drawing it (ReactFlow) grows faster than
 * its objects: at 400 it held the panel still about a second at each redraw,
 * and a clone of the whole org takes up to 1,950. A large graph is listed
 * whatever the setting says, the discovery does not draw it at all, and
 * Review and the execution offer it only with a warning of how slow it is.
 */
export const FORGE_GRAPH_SLOW_OBJECTS = 150;

/**
 * Whether a graph of `objectCount` objects is too large to be drawn unless
 * the user asks for it on it: past {@link FORGE_GRAPH_SLOW_OBJECTS}, or a
 * clone of the whole org, whose graph grows to that and past it as the org
 * is counted.
 */
export function forgeGraphIsLarge(objectCount: number, wholeOrg = false): boolean {
  return wholeOrg || objectCount > FORGE_GRAPH_SLOW_OBJECTS;
}

/**
 * What a screen shows a graph of `objectCount` objects as: the view picked
 * with the Graph/Table switch, once one was, over what the setting says.
 *
 * A large graph (`large`) is listed unless the switch was set to the graph
 * on a large graph (`choiceOnLarge`): neither the setting nor the graph
 * picked on a run of a dozen objects draws 1,950 of them, which would hold
 * the panel still at every progress of the run.
 */
export function forgeObjectsView(
  setting: ForgeGraphView,
  choice: ForgeObjectsView | null,
  objectCount: number,
  large = false,
  choiceOnLarge = false,
): ForgeObjectsView {
  if (large) return choice === 'graph' && choiceOnLarge ? 'graph' : 'table';
  if (choice !== null) return choice;
  if (setting !== 'auto') return setting;
  return objectCount > FORGE_GRAPH_MAX_OBJECTS ? 'table' : 'graph';
}

/** The graph view setting and the choice made with the switch. */
export interface ForgeViewState {
  /** `sandforge.forge.graphView`, as the extension last said it. */
  setting: ForgeGraphView;
  /**
   * The view picked with the Graph/Table switch of any of those screens, or
   * null until one is picked. Kept as long as the panel, as the store is: it
   * holds on all three and for every run, over the setting, but for a large
   * graph ({@link forgeGraphIsLarge}). That one is listed unless the graph
   * was picked on a large graph too (`choiceOnLarge`), and the discovery,
   * which offers no switch then, never draws it.
   */
  choice: ForgeObjectsView | null;
  /**
   * Whether `choice` was picked on a large graph ({@link forgeGraphIsLarge}):
   * only then does it draw one.
   */
  choiceOnLarge: boolean;
  /**
   * Take the setting from an extension message. A message that names none,
   * or a value the setting does not offer, leaves the one held.
   */
  adoptSetting: (value: unknown) => void;
  /** Keep the view picked with the switch, on a large graph or not. */
  choose: (view: ForgeObjectsView, onLarge?: boolean) => void;
}

/** Zustand store for how the Forge screens show a graph's objects. */
export const useForgeViewStore = create<ForgeViewState>((set) => ({
  setting: 'auto',
  choice: null,
  choiceOnLarge: false,

  adoptSetting(value: unknown): void {
    // Read without zod: the bridge calls this in every panel, and a schema
    // here put zod in the code every page shares (isForgeGraphView).
    if (isForgeGraphView(value)) set({ setting: value });
  },

  choose(view: ForgeObjectsView, onLarge = false): void {
    set({ choice: view, choiceOnLarge: onLarge });
  },
}));

/**
 * What a screen shows a graph of `objectCount` objects as, followed as it
 * changes; `wholeOrg` for a clone of the whole org, whose graph is large
 * whatever it holds yet.
 */
export function useForgeObjectsView(objectCount: number, wholeOrg = false): ForgeObjectsView {
  const large = forgeGraphIsLarge(objectCount, wholeOrg);
  return useForgeViewStore((state) =>
    forgeObjectsView(state.setting, state.choice, objectCount, large, state.choiceOnLarge),
  );
}
