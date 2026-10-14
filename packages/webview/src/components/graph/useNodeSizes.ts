import { useCallback, useState } from 'react';
import type { Dimensions, Node, OnNodesChange } from '@xyflow/react';

/** What {@link useNodeSizes} gives a graph. */
export interface NodeSizes<N extends Node> {
  /** The size React Flow last measured for each node, by its id. */
  sizes: ReadonlyMap<string, Dimensions>;
  /** Hand to `<ReactFlow onNodesChange>`: it keeps the sizes as they are measured. */
  onNodesChange: OnNodesChange<N>;
}

/**
 * The sizes React Flow measures for the nodes of a graph built from props,
 * kept so the graph can hand each node back its `measured` size.
 *
 * React Flow measures each node it draws and reports the size through
 * `onNodesChange`. A graph that builds new node objects on every update and
 * keeps none of what is reported loses that size each time, and two things
 * read it from the node they are handed rather than from the drawing: the
 * minimap, which drew no node at all without one, and React Flow itself,
 * which measured every node again after each update of the graph — with an
 * `initialWidth` given in place of a size, it drew each node at that size
 * again first, and the nodes jumped on every update of a run.
 *
 * Only a size that changed makes a new map: an update that measures every
 * node at its known size renders nothing more.
 */
export function useNodeSizes<N extends Node>(): NodeSizes<N> {
  const [sizes, setSizes] = useState<ReadonlyMap<string, Dimensions>>(() => new Map());
  const onNodesChange = useCallback<OnNodesChange<N>>((changes) => {
    setSizes((current) => {
      let next: Map<string, Dimensions> | null = null;
      for (const change of changes) {
        if (change.type !== 'dimensions' || !change.dimensions) continue;
        const { width, height } = change.dimensions;
        const known = (next ?? current).get(change.id);
        if (known?.width === width && known.height === height) continue;
        next ??= new Map(current);
        next.set(change.id, { width, height });
      }
      return next ?? current;
    });
  }, []);
  return { sizes, onNodesChange };
}
