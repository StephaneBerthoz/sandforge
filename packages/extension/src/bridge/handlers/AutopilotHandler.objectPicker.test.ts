import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { AUTOPILOT_COUNTS_PER_REQUEST } from '@sandforge/shared';
import { AutopilotHandler, AUTOPILOT_NOT_READY } from './AutopilotHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { countingConnection, largeOrg } from '../../test/largeOrg.js';
import { SchemaScanner } from '../../modules/autopilot/SchemaScanner.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

function createDeps(): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: { get: vi.fn(), set: vi.fn() } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++id),
  };
}

/** What the handler posted, unwrapped. */
function posted(deps: HandlerDeps): Array<BaseMessage & { payload?: Record<string, unknown> }> {
  const post = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
  return post.mock.calls.map(([message]) => message as BaseMessage & { payload?: never });
}

/** The orchestrator's two calls the object picker makes, over a real scanner. */
function pickerOrchestrator(): Parameters<AutopilotHandler['setOrchestrator']>[0] {
  const scanner = new SchemaScanner();
  return {
    listObjects: scanner.listObjects.bind(scanner),
    countObjects: scanner.countObjects.bind(scanner),
  } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0];
}

describe('the object picker, on an org of six hundred and seventy custom objects', () => {
  let deps: HandlerDeps;
  let handler: AutopilotHandler;
  let source: ReturnType<typeof countingConnection>;
  let target: ReturnType<typeof countingConnection>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    handler = new AutopilotHandler(deps);
    const org = largeOrg({ customObjects: 670 });
    source = countingConnection(org);
    target = countingConnection(org);
    mockGetConn.mockImplementation(async (orgId: string) =>
      orgId === 'src' ? (source.conn as never) : (target.conn as never),
    );
  });

  it('lists the objects in two global describes, describing and counting none', async () => {
    handler.setOrchestrator(pickerOrchestrator());

    await handler.handle(
      inboundRequest({
        id: 'list-1',
        type: 'autopilot:list-objects',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src', targetOrgId: 'tgt', includeStandardObjects: true },
      } as BaseMessage),
    );

    const [answer] = posted(deps);
    expect(answer.type).toBe('autopilot:objects-listed');
    expect(answer.correlationId).toBe('list-1');
    const objects = (answer.payload?.objects ?? []) as Array<{ apiName: string; custom: boolean }>;
    expect(objects.length).toBeGreaterThan(670);
    expect(objects).toContainEqual(expect.objectContaining({ apiName: 'Lead', custom: false }));
    expect(source.total() + target.total()).toBe(2);
    expect(source.calls.describes).toEqual([]);
    expect(source.calls.queries).toEqual([]);
  });

  it('counts the objects it is asked about, and no other', async () => {
    handler.setOrchestrator(pickerOrchestrator());

    await handler.handle(
      inboundRequest({
        id: 'count-1',
        type: 'autopilot:count-objects',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src', objectApiNames: ['Lead', 'PostalCode__c'] },
      } as BaseMessage),
    );

    const [answer] = posted(deps);
    expect(answer.type).toBe('autopilot:objects-counted');
    expect(answer.correlationId).toBe('count-1');
    expect(answer.payload?.counts).toEqual({ Lead: 30, PostalCode__c: 61_635 });
    expect(source.calls.queries).toHaveLength(2);
    expect(target.total()).toBe(0);
  });

  it('refuses a count of more objects than a page holds, asking the org nothing', async () => {
    handler.setOrchestrator(pickerOrchestrator());
    const names = Array.from(
      { length: AUTOPILOT_COUNTS_PER_REQUEST + 1 },
      (_, n) => `Obj${String(n).padStart(3, '0')}__c`,
    );

    await handler.handle(
      inboundRequest({
        id: 'count-2',
        type: 'autopilot:count-objects',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src', objectApiNames: names },
      } as BaseMessage),
    );

    expect(posted(deps).map((m) => m.type)).toEqual(['autopilot:error']);
    expect(source.total()).toBe(0);
  });

  it('answers both requests with the not-ready code before the module has loaded', async () => {
    for (const request of [
      {
        type: 'autopilot:list-objects',
        payload: { sourceOrgId: 'src', targetOrgId: 'tgt', includeStandardObjects: true },
      },
      {
        type: 'autopilot:count-objects',
        payload: { sourceOrgId: 'src', objectApiNames: ['Lead'] },
      },
    ]) {
      await handler.handle(
        inboundRequest({ id: request.type, timestamp: Date.now(), ...request } as BaseMessage),
      );
    }

    const answers = posted(deps);
    expect(answers.map((m) => m.type)).toEqual(['autopilot:error', 'autopilot:error']);
    expect(answers.map((m) => m.payload?.code)).toEqual([
      AUTOPILOT_NOT_READY.code,
      AUTOPILOT_NOT_READY.code,
    ]);
    expect(source.total() + target.total()).toBe(0);
  });
});
