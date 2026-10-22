import React, { Suspense, lazy } from 'react';
import type { LiveGraphProps } from './LiveGraph';
import { cn } from '../../theme';
import { PartBoundary } from '../ui/PartBoundary';

/** The live graph's module: React Flow and its layout (dagre). */
const LoadedLiveGraph = lazy(() =>
  import('./LiveGraph').then((module) => ({ default: module.LiveGraph })),
);

/**
 * The live graph of Forge's discovery, review and execution, in a chunk of
 * its own fetched the first time a graph is drawn.
 *
 * React Flow and dagre, 215 kB, were parsed by every panel showing Forge
 * before its input step painted, which draws no graph. The graph takes the
 * box it is given while it loads, so nothing around it moves; the stylesheet
 * it needs is in the panel's from the start (main.tsx). A graph whose chunk
 * cannot be read is said in its box, and the step around it stays up.
 */
export const LiveGraph: React.FC<LiveGraphProps> = (props) => (
  <PartBoundary className={cn('h-full w-full', props.className)} data-testid="live-graph-failed">
    <Suspense
      fallback={
        <div
          className={cn('h-full w-full', props.className)}
          aria-busy="true"
          data-testid="live-graph-loading"
        />
      }
    >
      <LoadedLiveGraph {...props} />
    </Suspense>
  </PartBoundary>
);
