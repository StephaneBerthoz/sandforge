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

/**
 * What a screen shows a graph of `objectCount` objects as: the view picked
 * with the Graph/Table switch, once one was, over what the setting says;
 * under `auto`, a table past {@link FORGE_GRAPH_MAX_OBJECTS} objects or on a
 * panel narrower than {@link FORGE_GRAPH_MIN_PANEL_PX}.
 */
export function forgeObjectsView(
  setting: ForgeGraphView,
  choice: ForgeObjectsView | null,
  objectCount: number,
  narrow = false,
): ForgeObjectsView {
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
   * holds on all three and for every run, over the setting.
   */
  choice: ForgeObjectsView | null;
  /**
   * Take the setting from an extension message. A message that names none,
   * or a value the setting does not offer, leaves the one held.
   */
  adoptSetting: (value: unknown) => void;
  /** Keep the view picked with the switch. */
  choose: (view: ForgeObjectsView) => void;
}

/** Zustand store for how the Forge screens show a graph's objects. */
export const useForgeViewStore = create<ForgeViewState>((set) => ({
  setting: 'auto',
  choice: null,

  adoptSetting(value: unknown): void {
    // Read without zod: the bridge calls this in every panel, and a schema
    // here put zod in the code every page shares (isForgeGraphView).
    if (isForgeGraphView(value)) set({ setting: value });
  },

  choose(view: ForgeObjectsView): void {
    set({ choice: view });
  },
}));

/**
 * What a screen shows a graph of `objectCount` objects as, followed as it
 * changes, the panel's width with it: a panel widened past the threshold
 * draws the graph `auto` had listed.
 */
export function useForgeObjectsView(objectCount: number): ForgeObjectsView {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
  return useForgeViewStore((state) =>
    forgeObjectsView(state.setting, state.choice, objectCount, narrow),
  );
}
