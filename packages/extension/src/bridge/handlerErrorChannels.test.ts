import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Error-channel guard.
 *
 * `sendHandlerError` takes the outgoing message type as its third argument.
 * Passing a `:response` channel there delivers an error payload
 * (`{ message, code, retryable }`) on the success channel, where the webview
 * reads the success shape off it, gets `undefined`, and falls through to its
 * empty state. A failed query then renders pixel-identical to a healthy empty
 * result — the user cannot tell a broken org connection from "no data".
 *
 * 15 call sites shipped that way across Monitor (8), Config (4) and
 * Governance (3). Errors belong on the domain error channel — `monitor:error`,
 * `config:error`, `governance:error` — which is also what useBridgeQuery
 * listens on by default (`${domain}:error`).
 */

const HANDLERS_DIR = join(__dirname, 'handlers');

/** Every `sendHandlerError(...)` call with the message-type argument it passes. */
function errorCalls(): { file: string; messageType: string }[] {
  const calls: { file: string; messageType: string }[] = [];
  for (const file of readdirSync(HANDLERS_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const src = readFileSync(join(HANDLERS_DIR, file), 'utf8');
    // deps arg, context string, then the message type — tolerate line breaks.
    const pattern = /sendHandlerError\(\s*[^,]+,\s*'[^']*',\s*'([^']+)'/g;
    for (const match of Array.from(src.matchAll(pattern))) {
      calls.push({ file, messageType: match[1] });
    }
  }
  return calls;
}

describe('handler error channels', () => {
  it('finds the call sites it is meant to guard', () => {
    // Guards the guard: a regex matching nothing would pass vacuously.
    expect(errorCalls().length).toBeGreaterThan(20);
  });

  it('never posts an error payload on a :response channel', () => {
    const onSuccessChannel = errorCalls()
      .filter((c) => c.messageType.endsWith(':response'))
      .map((c) => `${c.messageType} (${c.file})`);

    expect(onSuccessChannel).toEqual([]);
  });
});
