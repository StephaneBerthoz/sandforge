import { useState, useCallback, useRef, useEffect } from 'react';
// The i18next singleton rather than `../i18n`: that module initialises it for
// React once at boot, and every hook-level test that mocks react-i18next would
// otherwise have to provide its initialiser.
import i18n from 'i18next';

import { panelWordingOf, type BaseMessage } from '@sandforge/shared';
import { offerReconnect } from '../bridge/offerReconnect';
import { listWords } from '../utils/listWords';

/**
 * Options for the useMessageResponse hook.
 */
export interface UseMessageResponseOptions {
  /** The original request type, named in the error messages (e.g. `'org:list'`). */
  requestType: string;
  /** The message type to listen for (e.g. `'org:list:response'`). */
  responseType: string;
  /** Timeout in milliseconds before the request is considered failed. */
  timeoutMs: number;
  /**
   * Optional error channel to listen for (e.g. `'monitor:error'`). When a
   * handler rejects a request it replies on this channel instead of the
   * success channel; without a listener the user only saw the 30 s timeout.
   */
  errorType?: string;
  /**
   * Whether a message of the response type carrying no correlationId is taken
   * as the answer (default `false`). Every handler reply is correlated
   * (`buildResponse` takes a typed origin), so an uncorrelated message of a
   * response type is a host broadcast with no request behind it — and taken
   * as the answer, one landing between a request and its reply closed the
   * request and the real reply was then dropped: `ai:status:response` is
   * pushed to the panels whenever the AI wiring changes. Set it to `true` only
   * where a caller wants such a push to stand in for its answer.
   */
  acceptUncorrelated?: boolean;
  /**
   * Whether the request starts a run the extension goes on with once the page
   * stops waiting (default `false`): the timeout then says the run may still
   * be writing, and that Live Operations shows it, instead of "Try again" —
   * a second run would write its records twice.
   */
  runOutlivesWait?: boolean;
}

/**
 * The code of a wait that ended before a run it waited on did: the run may
 * still be writing, and a page offers neither to retry nor to start it again.
 */
export const RUN_OUTLIVED_WAIT = 'RUN_OUTLIVED_WAIT';

/** Duration in milliseconds before the `timedOut` flag is set. */
const FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * A request's failure, in the interface language. These are the fallback of
 * every query and mutation in the panel, and read as developer text in English
 * whatever the language: "Bridge query 'reports:list' timed out after 30000ms".
 * Before i18next is initialised — a hook mounted alone in a test — the key is
 * returned, as `t` does for a missing one.
 */
function requestError(
  key: 'bridge.timedOut' | 'bridge.runOutlivedWait' | 'bridge.failed' | 'bridge.rejected',
  options: { request: string; seconds?: number; hours?: number },
): string {
  return i18n.isInitialized ? i18n.t(key, options) : key;
}

/** What every write path writes before the reason Production Guard gave. */
const GUARD_BLOCKED_PREFIX = 'Operation blocked by Production Guard: ';

/**
 * A refusal of Production Guard's in the interface language, by the code the
 * host sends beside its message, or `undefined` for any other error.
 *
 * Every write path words these in English — "Operation blocked by Production
 * Guard: …", "Operation cancelled by user (production confirmation
 * declined)." — and Compare, Frozen, DataOps, Sync, Seed and Autopilot showed
 * them as they came, in every language. The reason the guard gave stays as it
 * gave it, after the translated sentence. Before i18next is initialised the
 * host's own words are kept. A masking template DataOps no longer finds is
 * said here too, and an Autopilot request its module was not loaded for.
 */
function guardRefusal(
  code: string | null,
  message: string | undefined,
  payload: Record<string, unknown> = {},
): string | undefined {
  if (!i18n.isInitialized) return undefined;
  // A connection the user can act on, worded by the host in English with a
  // CLI command once: an expired session, an org that failed several times
  // in a row and is left alone for a moment, an import that found no org in
  // the CLI. The error catalogue words them, what happened and what to do.
  const worded = panelWordingOf(code);
  if (worded) return `${i18n.t(worded.explanationKey)} ${i18n.t(worded.actionKey)}`;
  // A seed its records' data storage stopped before the first write, with the
  // figures the host measured: the host's sentence is English.
  if (code === 'SEED_STORAGE_EXCEEDED') {
    const { estimateMB, remainingMB, maxMB, org } = payload;
    return typeof estimateMB === 'number' &&
      typeof remainingMB === 'number' &&
      typeof maxMB === 'number' &&
      typeof org === 'string'
      ? i18n.t('common.refusal.seedStorageExceeded', {
          estimate: estimateMB,
          remaining: remainingMB,
          max: maxMB,
          org,
        })
      : undefined;
  }
  // A seed its records' emails stopped before the first write, past what the
  // org has left today, with the figures and the ways out the host found.
  if (code === 'SEED_EMAILS_EXCEEDED') {
    const { org, limit, emails, remaining, max, objects, senders } = payload;
    const names = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
    const objectNames = names(objects);
    const senderNames = names(senders);
    if (
      typeof org !== 'string' ||
      (limit !== 'SingleEmail' && limit !== 'DailyWorkflowEmails') ||
      typeof emails !== 'number' ||
      typeof remaining !== 'number' ||
      typeof max !== 'number' ||
      !objectNames ||
      !senderNames
    ) {
      return undefined;
    }
    const list = (items: readonly string[]): string => listWords(items, (key) => i18n.t(key));
    return i18n.t('common.refusal.seedEmailsExceeded', {
      org,
      limit: i18n.t(
        limit === 'SingleEmail' ? 'seed.automation.limit.single' : 'seed.automation.limit.workflow',
      ),
      emails,
      remaining,
      max,
      objects: list(objectNames),
      senders: list(senderNames.map((name) => i18n.t('seed.automation.quoted', { name }))),
    });
  }
  if (code === 'GUARD_BLOCKED') {
    const said = message ?? '';
    const reason = said.startsWith(GUARD_BLOCKED_PREFIX)
      ? said.slice(GUARD_BLOCKED_PREFIX.length)
      : said;
    return i18n.t('common.refusal.guardBlocked', { reason });
  }
  if (code === 'GUARD_DECLINED') return i18n.t('common.refusal.guardDeclined');
  // Not the guard's, but worded in English the same way and shown as it came.
  if (code === 'TEMPLATE_NOT_FOUND') return i18n.t('common.refusal.templateNotFound');
  // Autopilot asked before its module reached the host: the host's line is English.
  if (code === 'AUTOPILOT_NOT_READY') return i18n.t('common.refusal.autopilotNotReady');
  // An Autopilot run its write gate stopped before the first write.
  if (code === 'AUTOPILOT_STORAGE_EXCEEDED') {
    return i18n.t('common.refusal.autopilotStorageExceeded');
  }
  if (code === 'AUTOPILOT_WRITE_DECLINED') return i18n.t('common.refusal.autopilotWriteDeclined');
  // A second run asked for while one writes to the same target.
  if (code === 'AUTOPILOT_RUNNING') return i18n.t('common.refusal.autopilotRunning');
  // Backups of an org a backup or a restore is running on are not deleted.
  if (code === 'BACKUP_BUSY') return i18n.t('common.refusal.backupBusy');
  if (code === 'AUTOPILOT_CONFIRMATION_UNAVAILABLE') {
    return i18n.t('common.refusal.autopilotConfirmationUnavailable');
  }
  return undefined;
}

/**
 * Return value of the useMessageResponse hook.
 */
export interface MessageResponseHandler<T> {
  /** Start listening for a response to the given message ID. Returns a cleanup function. */
  listen: (messageId: string) => () => void;
  /** Response data, or null if not yet received. */
  data: T | null;
  /** Whether a response is currently being awaited. */
  loading: boolean;
  /** Error message if the request timed out. */
  error: string | null;
  /**
   * The code the handler's error carried (`payload.code`), or null: no error,
   * one with no code, a timeout or a rejection at the bridge. Lets a page key
   * off the kind of refusal rather than its English. The wait for a run that
   * goes on once it ends (`runOutlivesWait`) ends under
   * {@link RUN_OUTLIVED_WAIT}: the run is not known to have failed.
   */
  errorCode: string | null;
  /** Whether the response has been waiting longer than 10 seconds without a reply. */
  timedOut: boolean;
  /** Manually set the loading state. */
  setLoading: (loading: boolean) => void;
  /** Manually set the error state. */
  setError: (error: string | null) => void;
  /** Reset all state (data, loading, error, timedOut) back to idle. */
  reset: () => void;
}

/**
 * Shared hook that encapsulates the listen-for-response pattern used by
 * both `useBridgeQuery` and `useBridgeMutation`.
 *
 * Manages:
 * - `mountedRef` tracking to prevent state updates after unmount
 * - `activeRequestId` tracking to ignore stale responses
 * - `setTimeout` for configurable timeout
 * - `window.addEventListener('message', ...)` with response-type matching
 * - Cleanup of timer and event listener
 *
 * @param options - Configuration for request type, response type, timeout and label.
 */
export function useMessageResponse<T>(
  options: UseMessageResponseOptions,
): MessageResponseHandler<T> {
  const {
    requestType,
    responseType,
    timeoutMs,
    errorType,
    acceptUncorrelated = false,
    runOutlivesWait = false,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const mountedRef = useRef(true);
  const activeRequestId = useRef<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const listen = useCallback(
    (messageId: string): (() => void) => {
      activeRequestId.current = messageId;
      setTimedOut(false);
      setErrorCode(null);

      // Start feedback timer — sets timedOut after 10s if still waiting
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
      feedbackTimerRef.current = setTimeout(() => {
        if (mountedRef.current && activeRequestId.current === messageId) {
          setTimedOut(true);
        }
      }, FEEDBACK_TIMEOUT_MS);

      const timer = setTimeout(() => {
        if (mountedRef.current && activeRequestId.current === messageId) {
          setLoading(false);
          // A run waited on that may still write is not a failed one: the page
          // keeps it in view rather than offer to start it again.
          if (runOutlivesWait) setErrorCode(RUN_OUTLIVED_WAIT);
          setError(
            runOutlivesWait
              ? requestError('bridge.runOutlivedWait', {
                  request: requestType,
                  hours: Math.round(timeoutMs / 3_600_000),
                })
              : requestError('bridge.timedOut', {
                  request: requestType,
                  seconds: Math.round(timeoutMs / 1000),
                }),
          );
          activeRequestId.current = null;
        }
      }, timeoutMs);

      function listener(event: MessageEvent): void {
        // SECURITY: Validate origin — only accept messages from the VSCode
        // webview host. In VSCode webviews the origin is 'vscode-webview://...'
        // or may be empty in some environments (e.g., tests).
        if (event.origin && !event.origin.startsWith('vscode-webview://')) {
          return;
        }
        const eventData = event.data as BaseMessage | undefined;
        if (!eventData || eventData.type !== responseType) {
          return;
        }

        // A response carrying a correlationId must carry ours. One carrying
        // none is a broadcast, not our answer, and is only accepted when the
        // caller asked for the pushes: handler responses are always correlated
        // (`buildResponse` takes a typed origin), while some messages of a
        // response type are pushed with no request behind them —
        // `ai:status:response` whenever the AI wiring changes.
        if (eventData.correlationId ? eventData.correlationId !== messageId : !acceptUncorrelated) {
          return;
        }

        if (!mountedRef.current || activeRequestId.current !== messageId) {
          return;
        }

        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        activeRequestId.current = null;

        const responsePayload = (eventData as BaseMessage & { payload: T }).payload;
        setData(responsePayload);
        setLoading(false);
        // Clears any provisional error claimed off the uncorrelated error
        // channel (see below): this request's own answer is the last word.
        setError(null);
        setErrorCode(null);
        setTimedOut(false);
      }

      window.addEventListener('message', listener);

      // Error channel: handlers reply on `<domain>:error` when the request
      // fails server-side. Same origin and correlation rules as the success
      // channel; without this the user only saw the generic timeout.
      let removeErrorListener: (() => void) | undefined;
      if (errorType) {
        const errorListener = (event: MessageEvent): void => {
          if (event.origin && !event.origin.startsWith('vscode-webview://')) {
            return;
          }
          const eventData = event.data as
            (BaseMessage & { payload?: { message?: unknown; code?: unknown } }) | undefined;
          if (!eventData || eventData.type !== errorType) {
            return;
          }
          // An error names the request it answers, or it is not ours. Handler
          // errors are correlated at the source — `sendHandlerError` takes a
          // typed origin — so one without a correlationId cannot be attributed,
          // and claiming it is how a long sync showed another request's failure.
          if (eventData.correlationId !== messageId) {
            return;
          }
          if (!mountedRef.current || activeRequestId.current !== messageId) {
            return;
          }

          clearTimeout(timer);
          if (feedbackTimerRef.current !== null) {
            clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = null;
          }
          activeRequestId.current = null;

          const payloadMessage = eventData.payload?.message;
          const payloadCode = eventData.payload?.code;
          const code = typeof payloadCode === 'string' ? payloadCode : null;
          const said = typeof payloadMessage === 'string' ? payloadMessage : undefined;
          setErrorCode(code);
          setError(
            guardRefusal(code, said, eventData.payload) ??
              said ??
              requestError('bridge.failed', { request: requestType }),
          );
          setLoading(false);
          setTimedOut(false);
          if (code === 'ORG_AUTH_EXPIRED') {
            offerReconnect(eventData.payload as Record<string, unknown> | undefined);
          }
        };
        window.addEventListener('message', errorListener);
        removeErrorListener = () => window.removeEventListener('message', errorListener);
      }

      // Envelope-level rejection: the broker dropped the message before any
      // handler saw it, so no `<domain>:error` will ever arrive and the request
      // would otherwise sit out its full timeout and show the raw timeout
      // string. Matched on correlationId ONLY — bridge:error is a broadcast,
      // and any rule that claims it by timing gives every concurrent hook the
      // wrong verdict.
      const bridgeErrorListener = (event: MessageEvent): void => {
        if (event.origin && !event.origin.startsWith('vscode-webview://')) {
          return;
        }
        const eventData = event.data as
          (BaseMessage & { payload?: { reason?: unknown } }) | undefined;
        if (!eventData || eventData.type !== 'bridge:error') {
          return;
        }
        if (eventData.correlationId !== messageId) {
          return;
        }
        if (!mountedRef.current || activeRequestId.current !== messageId) {
          return;
        }

        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        activeRequestId.current = null;

        setError(requestError('bridge.rejected', { request: requestType }));
        setLoading(false);
        setTimedOut(false);
      };
      window.addEventListener('message', bridgeErrorListener);

      return () => {
        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        window.removeEventListener('message', listener);
        window.removeEventListener('message', bridgeErrorListener);
        removeErrorListener?.();
      };
    },
    [requestType, responseType, timeoutMs, errorType, acceptUncorrelated, runOutlivesWait],
  );

  const reset = useCallback(() => {
    activeRequestId.current = null;
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setData(null);
    setLoading(false);
    setError(null);
    setErrorCode(null);
    setTimedOut(false);
  }, []);

  return { listen, data, loading, error, errorCode, timedOut, setLoading, setError, reset };
}
