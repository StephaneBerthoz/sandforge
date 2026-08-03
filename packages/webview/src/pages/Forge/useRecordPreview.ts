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

  useMessageListener<BaseMessage & { payload: RecordPreview }>(
    'forge:preview:response',
    useCallback((msg) => {
      setPreview(msg.payload);
      setPreviewLoading(false);
      setPreviewError(null);
    }, []),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:preview:error',
    useCallback((msg) => {
      setPreviewLoading(false);
      setPreviewError(msg.payload.message);
    }, []),
  );

  /** Clear preview + error — called when the user edits the record input. */
  const resetPreview = useCallback(() => {
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
    sendMessage(
      buildMessage<{ recordId: string; orgId: string }>('forge:preview', {
        recordId: id,
        orgId: sourceOrgId,
      }),
    );
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
