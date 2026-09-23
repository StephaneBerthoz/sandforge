import { describe, it, expect, vi } from 'vitest';
import {
  sendHandlerError,
  sendNotification,
  sendOperationFailed,
  objectsFailureContext,
  buildResponse,
  syntheticRequest,
  uncorrelated,
  PRODUCTION_GUARD_MISSING,
  type InboundRequest,
  type SyntheticRequestKind,
  type UncorrelatedReason,
} from './HandlerTypes.js';
import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { ErrorResolver, type AIProvider } from '../../modules/ai/ErrorResolver.js';
import { MessageBroker, type FixSuggestion } from '../MessageBroker.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { CrudFlsGuard, type DescribeFetchFn } from '../../core/metadata/CrudFlsGuard.js';
import { createMockBroker, inboundRequest } from '../../test/mockFactories.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import type { OrgRegistry } from '../../core/connection/OrgRegistry.js';
import type { OrgManager } from '../../core/connection/OrgManager.js';

/**
 * Creates a minimal mock of the handler deps required by sendHandlerError.
 */
function createMockDeps() {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: createMockBroker(),
    nextId: () => String(++idCounter),
  };
}

/** Stand-in for the bridge request a handler is answering. */
const REQUEST: InboundRequest = inboundRequest({
  id: 'req-7',
  type: 'sync:execute',
  timestamp: 1000,
});

describe('sendHandlerError', () => {
  it('logs the error with the context prefix', () => {
    const deps = createMockDeps();
    sendHandlerError(
      deps,
      'sync:describe-global',
      'sync:error',
      REQUEST,
      new Error('connection timeout'),
    );

    expect(deps.log).toHaveBeenCalledWith('[ERR] sync:describe-global: connection timeout');
  });

  it('posts an error message to the webview with the correct type and payload', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'seed:execute', 'seed:error', REQUEST, new Error('invalid template'));

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.type).toBe('seed:error');
    expect(posted.payload.message).toBe('invalid template');
    expect(posted.id).toBeDefined();
  });

  it('sends default code=UNKNOWN and retryable=false when no code/retryable provided', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'sync:error', 'sync:error', REQUEST, new Error('fail'));

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('UNKNOWN');
    expect(posted.payload.retryable).toBe(false);
  });

  it('sends provided code and retryable values in payload', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'forge:plan', 'forge:plan:error', REQUEST, new Error('timed out'), {
      code: 'TIMEOUT',
      retryable: true,
    });

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('TIMEOUT');
    expect(posted.payload.retryable).toBe(true);
  });

  it('sends retryable=false default when only code is provided', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'forge:execute', 'forge:execute:error', REQUEST, new Error('broken'), {
      code: 'EXECUTE_ERROR',
    });

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('EXECUTE_ERROR');
    expect(posted.payload.retryable).toBe(false);
  });

  it('logs the TX line after posting', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'compare:start', 'compare:error', REQUEST, new Error('oops'));

    expect(deps.log).toHaveBeenCalledWith('[TX] compare:error: oops');
  });

  it('handles non-Error values by converting to string', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'monitor:refresh', 'monitor:error', REQUEST, 'raw string error');

    expect(deps.log).toHaveBeenCalledWith('[ERR] monitor:refresh: raw string error');
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(posted.payload.message).toBe('raw string error');
  });

  it('handles null/undefined error values', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'ctx', 'type:error', REQUEST, null);

    expect(deps.log).toHaveBeenCalledWith('[ERR] ctx: null');
  });

  it('generates a unique message id via nextId', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'a', 'a:error', REQUEST, 'x');
    sendHandlerError(deps, 'b', 'b:error', REQUEST, 'y');

    const id1 = (deps.broker.postToWebview.mock.calls[0][0] as { id: string }).id;
    const id2 = (deps.broker.postToWebview.mock.calls[1][0] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  it('stamps the origin request id as correlationId', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'sync:execute', 'sync:error', REQUEST, new Error('boom'));

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.correlationId).toBe('req-7');
  });

  it('omits correlationId and names the reason for an uncorrelated origin', () => {
    const deps = createMockDeps();
    sendHandlerError(
      deps,
      'sync:schedule:tick',
      'sync:error',
      // `UncorrelatedReason` is `never` today: only a test can name a reason, by cast.
      uncorrelated('schedule tick, no request' as never),
      new Error('boom'),
    );

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.correlationId).toBeUndefined();
    // The admission is not only in the source: it reaches the output channel,
    // so an uncorrelated error is visible while debugging, not just at review.
    expect(deps.log).toHaveBeenCalledWith(
      '[ERR] sync:schedule:tick: boom (uncorrelated: schedule tick, no request)',
    );
  });

  it('requires an origin at the type level', () => {
    // The guard is tsc, not the runtime assertion: `pnpm typecheck` covers this
    // file (tsconfig.test.json includes src/**/*). If `origin` becomes optional
    // or accepts `undefined`, the annotation below stops matching `false` and
    // typecheck fails with TS2322 — checked by mutating the signature both ways.
    //
    // Deliberately NOT a `@ts-expect-error` on a call that omits `origin`:
    // dropping an argument shifts `err` into the origin slot, an Error is not an
    // ErrorOrigin, and the directive stays satisfied even with `origin?` — a
    // guard that cannot fail.
    const acceptsUndefined: undefined extends Parameters<typeof sendHandlerError>[3]
      ? true
      : false = false;

    expect(acceptsUndefined).toBe(false);
  });
});

describe('correlation origins', () => {
  it('rejects every origin that did not come from a request, at the type level', () => {
    // The guard is tsc: `pnpm typecheck` covers this file. Each annotation
    // stops matching the moment its shape becomes an accepted origin again.
    // These are the reviewed bypasses, not hypotheticals.
    type Origin = Parameters<typeof sendHandlerError>[3];
    // P1, P2, P8: any message-shaped value — an id of '' (read as "no
    // correlation" by the webview), a fabricated UUID, `{} as BaseMessage`.
    const plainMessage: BaseMessage extends Origin ? true : false = false;
    // A real request whose id was rewritten through a spread: `{ ...msg, id: '' }`.
    const rewrittenId: {
      id: string;
      type: string;
      timestamp: number;
    } extends Origin
      ? true
      : false = false;
    // P6: a hand-built admission that skips the helper.
    const handBuiltOrphan: { uncorrelated: true; reason: string } extends Origin ? true : false =
      false;
    // P3, P4, P5: a free-form reason, whatever its quoting, variable or import alias.
    const freeFormReason: string extends Parameters<typeof uncorrelated>[0] ? true : false = false;
    // Positive controls: without them, `Origin = never` would satisfy every line above.
    const routed: InboundRequest extends Origin ? true : false = true;
    const synthetic: ReturnType<typeof syntheticRequest> extends Origin ? true : false = true;
    const admitted: ReturnType<typeof uncorrelated> extends Origin ? true : false = true;

    expect([plainMessage, rewrittenId, handBuiltOrphan, freeFormReason]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([routed, synthetic, admitted]).toEqual([true, true, true]);
  });

  it('keeps both escape hatches closed lists', () => {
    // Adding a reason or a synthetic kind is a reviewed edit of HandlerTypes.ts
    // and of this pin; widening either one (to `string`, say) fails typecheck.
    type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const reasons: Exactly<UncorrelatedReason, never> = true;
    const kinds: Exactly<SyntheticRequestKind, 'sync:schedule' | 'offline-replay'> = true;

    expect([reasons, kinds]).toEqual([true, true]);
  });

  it('prefixes a synthetic request id with its kind, so it is never empty nor a webview id', () => {
    const scheduled = syntheticRequest('sync:schedule', 'uuid-1', 'sync:execute');
    expect(scheduled).toMatchObject({
      id: 'sync:schedule:uuid-1',
      type: 'sync:execute',
    });
    expect(typeof scheduled.timestamp).toBe('number');
    expect(syntheticRequest('offline-replay', '', 'seed:execute').id).toBe('offline-replay-');
  });
});

describe('buildResponse', () => {
  it('copies request id as correlationId on the response', () => {
    const deps = createMockDeps();
    const request: InboundRequest = inboundRequest({
      id: 'req-42',
      type: 'seed:execute',
      timestamp: 1000,
    });
    const response = buildResponse(deps, request, 'seed:execute:response', {
      total: 10,
    });

    expect(response.correlationId).toBe('req-42');
    expect(response.type).toBe('seed:execute:response');
    expect(response.payload).toEqual({ total: 10 });
    expect(response.id).toBeDefined();
    expect(response.id).not.toBe('req-42');
  });

  it('generates a unique id for the response via nextId', () => {
    const deps = createMockDeps();
    const request: InboundRequest = inboundRequest({
      id: 'req-1',
      type: 'org:list',
      timestamp: 1000,
    });
    const r1 = buildResponse(deps, request, 'org:list:response', {});
    const r2 = buildResponse(deps, request, 'org:list:response', {});

    expect(r1.id).not.toBe(r2.id);
  });
});

describe('sendNotification', () => {
  it('posts a notification message to the webview', () => {
    const deps = { ...createMockDeps() };
    sendNotification(deps, 'error', 'Test', 'Something went wrong');

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { level: string; title: string; message: string };
    };
    expect(posted.type).toBe('notification');
    expect(posted.payload.level).toBe('error');
    expect(posted.payload.title).toBe('Test');
    expect(posted.payload.message).toBe('Something went wrong');
  });

  it('dismisses after five seconds and carries no action unless told otherwise', () => {
    const deps = { ...createMockDeps() };
    sendNotification(deps, 'info', 'Test', 'Done');

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: Record<string, unknown>;
    };
    expect(posted.payload.autoDismissMs).toBe(5000);
    expect(posted.payload).not.toHaveProperty('actions');
  });

  it('can stay up until dismissed and carry an action', () => {
    // Every caller used to get the same five-second toast with no button, so
    // a notification that asks the reader to go and do something could not
    // be written at all.
    const deps = { ...createMockDeps() };
    const action = { label: 'Open', command: 'open-page', url: 'https://example.com' };
    sendNotification(deps, 'error', 'Test', 'Needs a step', {
      autoDismissMs: null,
      actions: [action],
    });

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: Record<string, unknown>;
    };
    expect(posted.payload).not.toHaveProperty('autoDismissMs');
    expect(posted.payload.actions).toEqual([action]);
  });
});

/**
 * The fix suggestion for a failed operation.
 *
 * `sendOperationFailed` is the only emitter of `operation:failed`, and the
 * broker fans that message out to every open panel. The suggestion is decided
 * once, here, and shown once by the host: a curated answer from the table of
 * known Salesforce error codes whether AI is on or off, and a model answer
 * only while AI is on, for a Salesforce message, with a SandForge view open.
 */
describe('sendOperationFailed — fix suggestion', () => {
  /** A broker with real panel bookkeeping, `panels` mock views and a spied host notifier. */
  function createResolvingDeps({ panels = 1, ai = true }: { panels?: number; ai?: boolean } = {}) {
    const showFixSuggestion = vi.fn<(suggestion: FixSuggestion) => void>();
    const broker = new MessageBroker({ showFixSuggestion });
    const webviews = Array.from({ length: panels }, () => {
      const panel = { webview: { onDidReceiveMessage: vi.fn(), postMessage: vi.fn() } };
      broker.registerPanel(panel as unknown as vscode.WebviewPanel, { inbound: false });
      return panel.webview;
    });
    const provider = vi.fn<AIProvider>(() =>
      Promise.resolve(
        JSON.stringify({
          explanation: 'model answer',
          suggestions: [{ title: 'ask', description: 'model fix', probability: 0.5 }],
          confidence: 0.4,
        }),
      ),
    );
    let idCounter = 0;
    return {
      log: vi.fn(),
      broker,
      nextId: () => String(++idCounter),
      ...(ai ? { errorResolver: new ErrorResolver(provider) } : {}),
      provider,
      showFixSuggestion,
      webviews,
    };
  }

  /** Let every pending resolution settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('answers a known error code from the table, without calling the model', () => {
    const deps = createResolvingDeps();

    sendOperationFailed(
      deps,
      'op-1',
      'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
      true,
    );

    expect(deps.provider).not.toHaveBeenCalled();
    // The code travels with the line: the table is written in English, and the
    // host keys its translation on the entry the code selects.
    expect(deps.showFixSuggestion).toHaveBeenCalledWith({
      source: 'knowledge-base',
      text: 'Wait a moment and retry. Row locks are usually transient.',
      code: 'UNABLE_TO_LOCK_ROW',
    });
  });

  it('answers a known error code with AI off', () => {
    // The table is on disk and needs no key: gating it behind one left every
    // user without an Anthropic key with no hint at all.
    const deps = createResolvingDeps({ ai: false });

    sendOperationFailed(
      deps,
      'op-1',
      'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
      true,
    );

    expect(deps.showFixSuggestion).toHaveBeenCalledWith({
      source: 'knowledge-base',
      text: 'API limits reset on a rolling 24-hour basis. Wait before retrying.',
      code: 'REQUEST_LIMIT_EXCEEDED',
    });
  });

  it('finds a known code in a later segment of an aggregated message', () => {
    const deps = createResolvingDeps();

    sendOperationFailed(
      deps,
      'op-1',
      'SOMETHING_EXOTIC: odd | DUPLICATE_VALUE: duplicate value found (+1 more)',
      false,
    );

    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.showFixSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'knowledge-base' }),
    );
  });

  it('shows the suggestion once, with two panels open', async () => {
    const deps = createResolvingDeps({ panels: 2 });

    sendOperationFailed(deps, 'op-2', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', false);
    await vi.waitFor(() => expect(deps.showFixSuggestion).toHaveBeenCalled());
    await settle();

    // The lifecycle message reaches both panels; the suggestion is one model
    // call and one notification for the whole failure.
    for (const webview of deps.webviews) {
      expect(webview.postMessage).toHaveBeenCalledTimes(1);
      expect(webview.postMessage.mock.calls[0][0]).toMatchObject({ type: 'operation:failed' });
    }
    expect(deps.provider).toHaveBeenCalledTimes(1);
    expect(deps.showFixSuggestion).toHaveBeenCalledTimes(1);
    expect(deps.showFixSuggestion).toHaveBeenCalledWith({ source: 'model', text: 'model fix' });
  });

  it('sends the model no context line it does not know', async () => {
    const deps = createResolvingDeps();

    sendOperationFailed(deps, 'op-3', 'Network request failed after 3 attempts', true);
    await vi.waitFor(() => expect(deps.provider).toHaveBeenCalledTimes(1));

    const [prompt] = deps.provider.mock.calls[0];
    expect(prompt).toContain('Error code: UNKNOWN');
    expect(prompt).not.toContain('Module:');
    expect(prompt).not.toContain('Operation:');
    expect(prompt).not.toContain('Target object:');
    expect(prompt).not.toContain('Batch size:');
  });

  it('tells the model which module, operation, object and batch size failed', async () => {
    const deps = createResolvingDeps();

    sendOperationFailed(deps, 'op-8', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true, {
      context: { module: 'sync', operation: 'execute', objectName: 'Account', batchSize: 150 },
    });
    await vi.waitFor(() => expect(deps.provider).toHaveBeenCalledTimes(1));

    const [prompt] = deps.provider.mock.calls[0];
    expect(prompt).toContain('Module: sync');
    expect(prompt).toContain('Operation: execute');
    expect(prompt).toContain('Target object: Account');
    expect(prompt).toContain('Batch size: 150');
  });

  it('asks once about one failure raised from two operations', async () => {
    // The answer is remembered under the code and the message: what differs
    // between the runs is context for the prompt, not a second question.
    const deps = createResolvingDeps();

    sendOperationFailed(deps, 'op-9', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true, {
      context: { module: 'sync', objectName: 'Account' },
    });
    sendOperationFailed(deps, 'op-10', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true, {
      context: { module: 'seed', objectName: 'Contact', batchSize: 50 },
    });
    await vi.waitFor(() => expect(deps.showFixSuggestion).toHaveBeenCalledTimes(2));

    expect(deps.provider).toHaveBeenCalledTimes(1);
  });

  it('still posts the extra payload next to the context', () => {
    const deps = createResolvingDeps({ ai: false });

    sendOperationFailed(deps, 'op-11', 'ECONNRESET', true, {
      extraPayload: { retryHint: 'offline' },
      context: { module: 'seed' },
    });

    for (const webview of deps.webviews) {
      expect(webview.postMessage.mock.calls[0][0]).toMatchObject({
        type: 'operation:failed',
        payload: {
          operationId: 'op-11',
          error: 'ECONNRESET',
          retryable: true,
          retryHint: 'offline',
        },
      });
    }
  });

  it('never sends a message SandForge wrote itself to the model', async () => {
    const deps = createResolvingDeps();
    const productionBlock = new ProductionGuard().check({
      orgId: '00D000000000001AAA',
      orgTier: 'production',
      operation: 'delete',
      objectName: 'Account',
      recordCount: 1,
      module: 'dataops',
    });
    const noDescribe = await new CrudFlsGuard(() => Promise.resolve(undefined)).checkCrudPermission(
      'Account',
      'upsert',
    );
    const noUpsert = await new CrudFlsGuard(() =>
      Promise.resolve({ createable: false, updateable: false, fields: [] } as unknown as Awaited<
        ReturnType<DescribeFetchFn>
      >),
    ).checkCrudPermission('Account', 'upsert');
    const connectionFailure = async (org: unknown, credentials: unknown): Promise<string> => {
      const orgManager = { getOrg: () => org } as unknown as OrgManager;
      const orgRegistry = {
        getCredentials: () => Promise.resolve(credentials),
      } as unknown as OrgRegistry;
      return getJsforceConnection('00D000000000001AAA', orgRegistry, orgManager).then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    };
    const orgNotFound = await connectionFailure(undefined, undefined);
    const noCredentials = await connectionFailure({ alias: 'dev', metadata: {} }, undefined);
    const selfAuthored = [
      orgNotFound,
      noCredentials,
      'Invalid username format: "not a username"',
      'Operation cancelled by user (production confirmation declined).',
      'Duplicate operation: req-9',
      'A backup or rollback operation is already running for org 00D000000000001AAA. Please wait for it to complete.',
      noDescribe.reason,
      noUpsert.reason,
      "FLS violation on 'Account': fields [Secret__c] are not updateable.",
      'No backup found for operation req-3. Cannot rollback.',
      'Backup req-3 was taken from org 00D000000000001AAA and cannot be restored into org 00D000000000002AAA.',
      'Restore not run: uat answers as org 00D000000000002AAA, not as org 00D000000000001AAA, which backup req-3 was taken from, and the restore into the org it is now was not confirmed.',
      `Operation blocked by Production Guard: ${productionBlock.blockedReason ?? ''}`,
      PRODUCTION_GUARD_MISSING.message,
      'Pipeline failed',
    ];
    // The samples are the producers' own text, not a paraphrase of it.
    expect(noDescribe.reason).toMatch(/^Object describe not available for 'Account'/);
    expect(noUpsert.reason).toBe("User lacks 'upsert' permission on 'Account'.");
    expect(productionBlock.blockedReason).toContain('00D000000000001AAA');
    expect(orgNotFound).toBe('Org not found: 00D000000000001AAA');
    expect(noCredentials).toBe(
      'No credentials for org "dev" (00D000000000001AAA). Reconnect the org.',
    );

    for (const message of selfAuthored) {
      sendOperationFailed(deps, 'op-self', message, false);
    }
    await settle();
    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.showFixSuggestion).not.toHaveBeenCalled();

    // Positive control: a Salesforce message on the same deps still reaches it.
    sendOperationFailed(deps, 'op-sf', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', false);
    await vi.waitFor(() => expect(deps.provider).toHaveBeenCalledTimes(1));
  });

  it('asks nothing and shows nothing when no SandForge view is open', async () => {
    // A scheduled sync fails with every panel closed: nobody sees the failure,
    // so a model call about it is paid for and thrown away.
    const deps = createResolvingDeps({ panels: 0 });

    sendOperationFailed(deps, 'op-5', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true);
    sendOperationFailed(deps, 'op-6', 'UNABLE_TO_LOCK_ROW: locked', true);
    await settle();

    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.showFixSuggestion).not.toHaveBeenCalled();
  });

  it('stays silent about an unknown code when the AI stack is not wired', async () => {
    const deps = createResolvingDeps({ ai: false });

    sendOperationFailed(deps, 'op-4', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true);
    await settle();

    expect(deps.showFixSuggestion).not.toHaveBeenCalled();
  });

  it('logs a model call that fails, and shows nothing', async () => {
    const deps = createResolvingDeps();
    deps.provider.mockRejectedValueOnce(new Error('AI offline'));

    sendOperationFailed(deps, 'op-7', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', true);
    await vi.waitFor(() =>
      expect(deps.log).toHaveBeenCalledWith('[ERR] operation:failed resolution: AI offline'),
    );

    expect(deps.showFixSuggestion).not.toHaveBeenCalled();
  });
});

describe('objectsFailureContext', () => {
  it('names the one object of a run and its batch size', () => {
    expect(objectsFailureContext([{ objectApiName: 'Account', batchSize: 200 }])).toEqual({
      objectName: 'Account',
      batchSize: 200,
    });
  });

  it('names every object, and gives a batch size only when they share one', () => {
    expect(
      objectsFailureContext([
        { objectApiName: 'Account', batchSize: 200 },
        { objectApiName: 'Contact', batchSize: 200 },
      ]),
    ).toEqual({ objectName: 'Account, Contact', batchSize: 200 });
    expect(
      objectsFailureContext([
        { objectApiName: 'Account', batchSize: 200 },
        { objectApiName: 'Contact', batchSize: 50 },
      ]),
    ).toEqual({ objectName: 'Account, Contact' });
  });

  it('says nothing about a run with no objects', () => {
    expect(objectsFailureContext([])).toEqual({});
  });
});
