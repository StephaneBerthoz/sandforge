/** A call to the model a handler waits on, as {@link InFlightCalls.begin} starts it. */
export interface InFlightCall {
  /** Aborted when a stop names the call: handed to the request to the model. */
  readonly signal: AbortSignal;
  /** The call has settled, whichever way: a stop can no longer name it. */
  end(): void;
}

/**
 * The calls to the model a handler waits on, each under the key the page
 * names it by, so a Stop aborts the one it means.
 *
 * The AI chat keeps its questions here by conversation: the composer stayed
 * locked under a spinner until the model answered or the request timed out,
 * with no way to give up on a question asked by mistake. The AI tools keep
 * their drafts here by request — a NL2SOQL draft, a Forge root query, an
 * Automation pipeline — which left their pages waiting the same way on a slow
 * provider.
 */
export class InFlightCalls {
  private readonly calls = new Map<string, AbortController>();

  /**
   * Start a call under `key`. The first call under a key is the one a stop
   * reaches: one started while it waits gets a signal no stop names, and
   * does not take the first one's place — the chat refuses a second question
   * in a conversation before it is sent, and that refusal must not make the
   * first question unstoppable.
   */
  begin(key: string): InFlightCall {
    const controller = new AbortController();
    if (!this.calls.has(key)) this.calls.set(key, controller);
    return {
      signal: controller.signal,
      end: () => {
        if (this.calls.get(key) === controller) this.calls.delete(key);
      },
    };
  }

  /**
   * Abort the call waiting under `key`. A key nothing waits under — a call
   * already answered, or never started — is left as it is.
   *
   * @returns Whether a call was waiting and is now aborted.
   */
  abort(key: string): boolean {
    const controller = this.calls.get(key);
    controller?.abort();
    return controller !== undefined;
  }
}

/**
 * `step`, or a rejection as soon as `signal` aborts.
 *
 * What comes before the model in a draft — the org's catalogue, its describes,
 * its query plan — is a call to the org no signal reaches. Stopped while one
 * of them is out, the draft stops waiting on it: its answer, when it comes,
 * is dropped, and nothing is asked of the model.
 */
export function untilAborted<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Its own rejection is dropped: the step is no longer waited on.
    step.catch(() => {});
    return Promise.reject(stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    step.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Why a step stopped being waited on. */
function stopped(): Error {
  return Object.assign(new Error('Stopped before its answer came.'), { code: 'CANCELLED' });
}
