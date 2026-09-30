import { create } from 'zustand';
import { forgeGraphViewSchema } from '@sandforge/shared';
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
 * What a screen shows a graph of `objectCount` objects as: the view picked
 * with the Graph/Table switch, once one was, over what the setting says.
 */
export function forgeObjectsView(
  setting: ForgeGraphView,
  choice: ForgeObjectsView | null,
  objectCount: number,
): ForgeObjectsView {
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
    const read = forgeGraphViewSchema.safeParse(value);
    if (read.success) set({ setting: read.data });
  },

  choose(view: ForgeObjectsView): void {
    set({ choice: view });
  },
}));

/** What a screen shows a graph of `objectCount` objects as, followed as it changes. */
export function useForgeObjectsView(objectCount: number): ForgeObjectsView {
  return useForgeViewStore((state) => forgeObjectsView(state.setting, state.choice, objectCount));
}
