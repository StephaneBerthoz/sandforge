import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

/**
 * Every branch of `org:connect` must answer the request the webview correlated
 * on.
 *
 * OrgManagerPage opens the mutation on `org:statusChanged` and
 * useMessageResponse drops anything whose correlationId is not the request id,
 * so a `notification` is not an answer. Nine of the ten branches returned after
 * a fire-and-forget toast, and `handleOAuthWeb` could not answer at all — it
 * never received the request message. The mutation then ended only on its own
 * 30 s timeout, during which all five auth buttons stayed disabled.
 */

/** The two channels that terminate an org:connect round trip. */
const TERMINAL = new Set(['org:statusChanged', 'org:error']);

function createDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: { updateState: vi.fn() } as unknown as HandlerDeps['stateSync'],
    orgManager: {
      getAllOrgs: vi.fn().mockReturnValue([]),
      getOrg: vi.fn(),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {
      saveOrg: vi.fn().mockResolvedValue(undefined),
      removeOrg: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('gen-id'),
    ...overrides,
  };
}

function connectMsg(payload: Record<string, unknown>): InboundRequest & { payload: unknown } {
  // orgId is required by orgConnectPayloadSchema; the webview sends '' for a
  // fresh connection, so the fixture must too or validation short-circuits.
  return inboundRequest({
    id: 'req-connect',
    type: 'org:connect',
    timestamp: Date.now(),
    payload: { orgId: '', ...payload },
  });
}

/** The correlated terminal replies posted for one connect attempt. */
function terminalReplies(deps: HandlerDeps): { type: string; correlationId?: string }[] {
  const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .map((c) => c[0] as { type: string; correlationId?: string })
    .filter((m) => TERMINAL.has(m.type));
}

describe('org:connect answers on every branch', () => {
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  it('answers when the SF CLI is missing', async () => {
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(false),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'sfdx_import' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
    expect(replies[0].correlationId).toBe('req-connect');
  });

  it('answers when the CLI reports no connected orgs', async () => {
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      listOrgs: vi.fn().mockResolvedValue([]),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'sfdx_import' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
    expect(replies[0].correlationId).toBe('req-connect');
  });

  it('answers on a successful SF CLI import', async () => {
    // This one used to post org:list:response, a channel the mutation does not
    // listen on — so a SUCCESSFUL import still froze the banner for 30 s.
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      listOrgs: vi.fn().mockResolvedValue([{ org: { id: 'org-7' }, credentials: {} }]),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'sfdx_import' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:statusChanged');
    expect(replies[0].correlationId).toBe('req-connect');
  });

  it('answers when the CLI throws', async () => {
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      listOrgs: vi.fn().mockRejectedValue(new Error('sf exploded')),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'sfdx_import' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
  });

  it('answers on OAuth web success', async () => {
    // handleOAuthWeb did not even receive the request message, so no branch of
    // it could build a correlated reply.
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      loginWeb: vi.fn().mockResolvedValue(undefined),
      listOrgs: vi.fn().mockResolvedValue([{ org: { id: 'org-9' }, credentials: {} }]),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'oauth_web' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:statusChanged');
    expect(replies[0].correlationId).toBe('req-connect');
  });

  it('answers when OAuth web fails', async () => {
    deps.sfdxBridge = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      loginWeb: vi.fn().mockRejectedValue(new Error('browser closed')),
    } as unknown as HandlerDeps['sfdxBridge'];

    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'oauth_web' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
  });

  it('answers when credentials are missing', async () => {
    await new OrgHandler(deps).handle(connectMsg({ authMethod: 'usernamePassword' }));

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
  });

  it('answers when authentication is rejected', async () => {
    deps.authProvider = {
      authenticate: vi.fn().mockResolvedValue({ success: false, error: 'bad password' }),
    } as unknown as HandlerDeps['authProvider'];

    await new OrgHandler(deps).handle(
      connectMsg({
        authMethod: 'usernamePassword',
        username: 'u@e.com',
        password: 'p',
      }),
    );

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
  });

  it('answers when the login URL is not HTTPS', async () => {
    await new OrgHandler(deps).handle(
      connectMsg({
        authMethod: 'usernamePassword',
        username: 'u@e.com',
        password: 'p',
        loginUrl: 'http://login.salesforce.com',
      }),
    );

    const replies = terminalReplies(deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('org:error');
  });
});
