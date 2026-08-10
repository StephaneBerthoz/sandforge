import { useState, useCallback, useEffect, useRef } from 'react';
import type { BaseMessage } from '@sandforge/shared';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { extractRecordId } from './forgeUtils';
import type { RecordPreview } from './forgeUtils';

/** Return type for the useRecordPreview hook. */
export interface RecordPreviewState {
  /** Preview data for the current record, or null when not loaded. */
  preview: RecordPreview | null;
  /** Whether a preview request is in flight. */
  previewLoading: boolean;
  /** Error message from the last preview request, if any. */
  previewError: string | null;
  /** Fetch a preview of the record from the source org. */
  handlePreview: () => void;
  /** Clear both preview and error (used when the record input changes). */
  resetPreview: () => void;
  /** Dismiss the preview card only (keeps a standing error visible). */
  closePreview: () => void;
}

/**
 * Hook managing the record preview lifecycle for the Forge input form:
 * bridge request/response listeners, loading/error state, and the
 * auto-trigger debounce that fires when the record ID becomes valid.
 */
export function useRecordPreview(recordId: string, sourceOrgId: string): RecordPreviewState {
  const sendMessage = useSendMessage();

  const [preview, setPreview] = useState<RecordPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /**
   * Last-call-wins correlation guard. The extension echoes the request id as
   * `correlationId` on responses built with buildResponse — without a guard,
   * a late response from a superseded request would overwrite the preview of
   * the record the user is currently editing. `null` means no request was
   * sent yet (uncorrelated responses keep the legacy behavior, e.g. tests);
   * `''` means the input was reset and any correlated response is stale.
   */
  const pendingRequestIdRef = useRef<string | null>(null);

  /** True only when the response positively correlates to a DIFFERENT request. */
  const isStaleResponse = useCallback((correlationId: string | undefined): boolean => {
    const pending = pendingRequestIdRef.current;
    return pending != null && correlationId != null && correlationId !== pending;
  }, []);

  useMessageListener<BaseMessage & { payload: RecordPreview }>(
    'forge:preview:response',
    useCallback(
      (msg) => {
        if (isStaleResponse(msg.correlationId)) return;
        setPreview(msg.payload);
        setPreviewLoading(false);
        setPreviewError(null);
      },
      [isStaleResponse],
    ),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:preview:error',
    useCallback(
      (msg) => {
        if (isStaleResponse(msg.correlationId)) return;
        setPreviewLoading(false);
        setPreviewError(msg.payload.message);
      },
      [isStaleResponse],
    ),
  );

  /** Clear preview + error — called when the user edits the record input. */
  const resetPreview = useCallback(() => {
    // Invalidate the in-flight request: its late response must not
    // re-populate the preview the user just cleared.
    pendingRequestIdRef.current = '';
    setPreview(null);
    setPreviewError(null);
  }, []);

  /** Dismiss only the preview card (close button on the card). */
  const closePreview = useCallback(() => {
    setPreview(null);
  }, []);

  /** Fetch a preview of the record from the source org. */
  const handlePreview = useCallback(() => {
    const id = extractRecordId(recordId);
    if (!id || !sourceOrgId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    const request = buildMessage<{ recordId: string; orgId: string }>('forge:preview', {
      recordId: id,
      orgId: sourceOrgId,
    });
    pendingRequestIdRef.current = request.id;
    sendMessage(request);
  }, [recordId, sourceOrgId, sendMessage]);

  /* ---- Auto-trigger preview when record ID is valid ---- */
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror loading state in a ref so the debounce effect only re-runs when
  // the inputs change — depending on `previewLoading` directly would
  // re-schedule a preview after every response and loop forever.
  const previewLoadingRef = useRef(previewLoading);
  previewLoadingRef.current = previewLoading;
  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const id = extractRecordId(recordId);
    if (id && sourceOrgId && !previewLoadingRef.current) {
      previewTimerRef.current = setTimeout(() => handlePreview(), 400);
    }
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [recordId, sourceOrgId, handlePreview]);

  return {
    preview,
    previewLoading,
    previewError,
    handlePreview,
    resetPreview,
    closePreview,
  };
}
