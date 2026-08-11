import type { Mock } from 'vitest';

import fr from '../locales/fr.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ja from '../locales/ja.json';
import ptBR from '../locales/pt-BR.json';

/**
 * Test double for the extension-side locale bridge (`i18n:locale` →
 * `i18n:locale:response`). Excluded from coverage — test infrastructure.
 *
 * The real locale JSONs are served so tests keep asserting against genuine
 * translations; the webview-under-test cannot tell the difference from the
 * packaged files the extension reads.
 */
const TEST_BUNDLES: Record<string, Record<string, unknown>> = {
  fr,
  de,
  es,
  ja,
  'pt-BR': ptBR,
};

/** Envelope shape the webview posts (see postEnvelopedMessage). */
interface CapturedEnvelope {
  payload?: { id?: unknown; type?: unknown; payload?: { lng?: unknown } };
}

/** Extract the inner bridge message from a captured postMessage call. */
function unwrapRequest(message: unknown): { id: string; lng: string } | undefined {
  const request = (message as CapturedEnvelope | undefined)?.payload;
  if (request?.type !== 'i18n:locale' || typeof request.id !== 'string') {
    return undefined;
  }
  const lng = request.payload?.lng;
  return { id: request.id, lng: typeof lng === 'string' ? lng : '' };
}

/** Dispatch a correlated `i18n:locale:response` on window (empty origin = test). */
export function dispatchLocaleResponse(requestId: string, lng: string): void {
  const bundle = TEST_BUNDLES[lng];
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: `test-locale-resp-${requestId}`,
        type: 'i18n:locale:response',
        timestamp: Date.now(),
        correlationId: requestId,
        payload: bundle ? { lng, bundle } : { lng, error: `No test bundle for '${lng}'` },
      },
    }),
  );
}

/**
 * Answer every `i18n:locale` request captured by the postMessage mock so far,
 * then let the response events flush. Use for requests fired outside the
 * test body (e.g. the boot restore during module import).
 */
export async function answerCapturedLocaleRequests(postMessageMock: Mock): Promise<void> {
  for (const call of postMessageMock.mock.calls) {
    const request = unwrapRequest(call[0]);
    if (request) {
      dispatchLocaleResponse(request.id, request.lng);
    }
  }
  // Let the dispatched events and the resulting promise chains settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Make the postMessage mock auto-answer every future `i18n:locale` request
 * (asynchronous dispatch, like the real extension). Install in a beforeEach
 * once module-load-time requests are impossible or already answered.
 */
export function stubLocaleBridge(postMessageMock: Mock): void {
  postMessageMock.mockImplementation((message: unknown) => {
    const request = unwrapRequest(message);
    if (request) {
      setTimeout(() => dispatchLocaleResponse(request.id, request.lng), 0);
    }
  });
}
