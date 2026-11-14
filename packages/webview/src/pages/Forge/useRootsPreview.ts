/**
 * What the query of the SOQL tab chooses as the records a clone from a query
 * copies, read before Discover (`forge:previewRoots`): the object, how many,
 * or that it chooses more than a run takes. The extension reads them as the
 * run does, by a statement of its own — their ids alone, to one past the most
 * a run takes —, one request of the source; nothing is written.
 *
 * Read once the query has stayed as it is for a moment, so that typing it
 * sends one read and not one per key; an answer for another query or another
 * source than the form now holds is not shown.
 */
import { useEffect, useState } from 'react';
import type { ForgePreviewRootsResponse, ForgeRootsPreview } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';

/** How long the query stays as it is before what it chooses is read, in milliseconds. */
export const ROOTS_PREVIEW_DELAY_MS = 700;

/** What the page knows of what the query chooses. */
export interface RootsPreviewState {
  /**
   * `idle`: nothing to read — no source, no query, or one that cannot
   * choose records; `reading`; `read`, with `preview`; `failed`, with the
   * extension's words in `error`.
   */
  status: 'idle' | 'reading' | 'read' | 'failed';
  preview?: ForgeRootsPreview;
  error?: string;
  /** Read again, the setting changed or the source with it. */
  readAgain: () => void;
}

/**
 * Read what `query` chooses in the source `sourceOrgId`, when `enabled`:
 * see the module's description.
 */
export function useRootsPreview(input: {
  sourceOrgId: string;
  query: string | undefined;
  enabled: boolean;
}): RootsPreviewState {
  const { sourceOrgId, enabled } = input;
  const query = input.query?.trim() ?? '';
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (settled === query) return undefined;
    const timer = setTimeout(() => setSettled(query), ROOTS_PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, settled]);
  const asked = enabled && sourceOrgId.length > 0 && settled.length > 0 && settled === query;
  const read = useBridgeQuery<ForgePreviewRootsResponse['payload']>(
    'forge:previewRoots',
    asked ? { sourceOrgId, soqlQuery: settled } : undefined,
    {
      responseType: 'forge:previewRoots:response',
      errorType: 'forge:previewRoots:error',
      skip: !asked,
      timeoutMs: 90_000,
    },
  );
  if (!asked) {
    // Between two keys: what it chooses is about to be read.
    const waiting = enabled && sourceOrgId.length > 0 && query.length > 0;
    return { status: waiting ? 'reading' : 'idle', readAgain: read.refetch };
  }
  if (read.loading) return { status: 'reading', readAgain: read.refetch };
  if (read.error) return { status: 'failed', error: read.error, readAgain: read.refetch };
  const preview = read.data;
  if (preview && preview.soqlQuery === settled && preview.sourceOrgId === sourceOrgId) {
    return { status: 'read', preview, readAgain: read.refetch };
  }
  return { status: 'reading', readAgain: read.refetch };
}
