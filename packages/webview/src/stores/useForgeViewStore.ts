import { useSyncExternalStore } from 'react';
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
 * The narrowest panel, in CSS pixels, `auto` draws a graph in; under it, the
 * discovery, Review and execution screens list the objects in a table.
 *
 * The graph keeps a strip down its right for the minimap, 230 pixels, and a
 * node is 220 pixels wide: under 560 the panel leaves less than one node
 * beside that strip. At 360, the four objects of an account's clone opened
 * at React Flow's smallest zoom, all but one outside the box, the minimap
 * taking most of what was left. It is the width under which the orgs'
 * ribbon stacks too.
 */
export const FORGE_GRAPH_MIN_PANEL_PX = 560;

/** What, besides the setting and the switch, decides how a screen shows a graph. */
export interface ForgeObjectsViewContext {
  /** The panel is narrower than {@link FORGE_GRAPH_MIN_PANEL_PX}. */
  narrow?: boolean;
  /** The graph is large ({@link forgeGraphIsLarge}). */
  large?: boolean;
  /** The switch's choice was made on a large graph. */
  choiceOnLarge?: boolean;
}

/**
 * What a screen shows a graph of `objectCount` objects as: the view picked
 * with the Graph/Table switch, once one was, over what the setting says;
 * under `auto`, a table past {@link FORGE_GRAPH_MAX_OBJECTS} objects or on a
 * panel narrower than {@link FORGE_GRAPH_MIN_PANEL_PX}.
 *
 * A large graph (`large`) is listed unless the switch was set to the graph
 * on a large graph (`choiceOnLarge`): neither the setting nor the graph
 * picked on a run of a dozen objects draws 1,950 of them, which would hold
 * the panel still at every progress of the run. The narrow panel does not
 * list it in turn: the graph picked on a large graph is drawn as asked.
 */
export function forgeObjectsView(
  setting: ForgeGraphView,
  choice: ForgeObjectsView | null,
  objectCount: number,
  { narrow = false, large = false, choiceOnLarge = false }: ForgeObjectsViewContext = {},
): ForgeObjectsView {
  if (large) return choice === 'graph' && choiceOnLarge ? 'graph' : 'table';
  if (choice !== null) return choice;
  if (setting !== 'auto') return setting;
  return narrow || objectCount > FORGE_GRAPH_MAX_OBJECTS ? 'table' : 'graph';
}

/** The media query a panel too narrow for the graph matches. */
const NARROW_PANEL = `(max-width: ${String(FORGE_GRAPH_MIN_PANEL_PX - 1)}px)`;

/** Follow whether the panel is narrower than the graph can be drawn in. */
function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(NARROW_PANEL);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the panel is narrower than the graph can be drawn in; false where nothing can tell. */
function narrowNow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_PANEL).matches;
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
 * changes, the panel's width with it: a panel widened past the threshold
 * draws the graph `auto` had listed. `wholeOrg` for a clone of the whole org,
 * whose graph is large whatever it holds yet.
 */
export function useForgeObjectsView(objectCount: number, wholeOrg = false): ForgeObjectsView {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
  const large = forgeGraphIsLarge(objectCount, wholeOrg);
  return useForgeViewStore((state) =>
    forgeObjectsView(state.setting, state.choice, objectCount, {
      narrow,
      large,
      choiceOnLarge: state.choiceOnLarge,
    }),
  );
}
