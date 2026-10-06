import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AuditLogEntry,
  BaseMessage,
  ForgeExecutionResult,
  ForgeRunVerification,
} from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import type { RunToVerify, RunVerifierDeps } from '../../modules/forge/RunVerifier.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/** What the verifier was built with and asked, per verification. */
const verifierCalls: Array<{ deps: RunVerifierDeps; run: RunToVerify }> = [];
let verifierAnswer: () => Promise<ForgeRunVerification>;
vi.mock('../../modules/forge/RunVerifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/forge/RunVerifier.js')>();
  return {
    ...actual,
    verifiedOrg: (conn: { name: string }) => ({ org: conn.name }),
    RunVerifier: class {
      constructor(private readonly deps: RunVerifierDeps) {}
      verify(run: RunToVerify): Promise<ForgeRunVerification> {
        verifierCalls.push({ deps: this.deps, run });
        return verifierAnswer();
      }
    },
  };
});

/*
 * A run's results verify what it wrote. The page names the run; the
 * extension reads from its history what the run created and the orgs it read
 * from and wrote to, verifies, keeps the verdict on the run's entry and in the
 * audit trail.
 */

/** A run of the history: an account and a contact created, an account it linked to. */
function pastRun(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-run',
    status: 'success',
    graph: {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    },
    duration: 1000,
    timestamp: '2026-10-01T08:00:00.000Z',
    idRemapCount: 3,
    idRemapTable: {
      '001000000000001SRC': '001000000000101AAA',
      '003000000000001SRC': '003000000000101AAA',
      '001000000000002SRC': '001000000000102AAA',
    },
    idRemapExisting: ['001000000000002SRC'],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: ['001000000000001SRC'] },
      { objectApiName: 'Contact', sourceIds: ['003000000000001SRC'] },
    ],
    createdCount: 2,
    targetOrgId: 'tgt-org',
    sourceOrgId: 'src-org',
    writtenBetween: { first: '2026-10-01T07:59:00.000Z', last: '2026-10-01T07:59:58.000Z' },
    config: {
      inputMode: 'record',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: true,
      batchSize: 'auto',
      fieldExclusions: { Contact: ['Birthdate'] },
      fieldMappings: { Account: { Region__c: 'Region__pc' } },
    },
    writtenWithoutFields: [
      {
        objectApiName: 'Contact',
        rows: 1,
        fields: [
          {
            field: 'ReportsToId',
            reason: 'FIELD_FILTER_VALIDATION_EXCEPTION: lookup filter',
            rows: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const VERIFIED: ForgeRunVerification = {
  verdict: 'verified',
  verifiedAt: '2026-10-01T09:00:00.000Z',
  attempts: 2,
  objects: [
    {
      objectApiName: 'Contact',
      expected: 1,
      present: 1,
      deleted: 0,
      notVisible: 0,
      changed: 1,
      changedRecords: [
        { recordId: '003000000000101AAA', modifiedAt: '2026-10-01T08:30:00.000+0000' },
      ],
      deletedIds: [],
      notVisibleIds: [],
      linksChecked: 1,
      linksBroken: 0,
      brokenLinks: [],
    },
    {
      objectApiName: 'Account',
      expected: 1,
      present: 1,
      deleted: 0,
      notVisible: 0,
      changed: 0,
      changedRecords: [],
      deletedIds: [],
      notVisibleIds: [],
      linksChecked: 0,
      linksBroken: 0,
      brokenLinks: [],
    },
  ],
};

describe('forge:verify:request', () => {
  let deps: HandlerDeps;
  let data: Map<string, unknown>;
  let handler: ForgeHandler;
  let registered: Set<string>;

  function request(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-verify',
      type: 'forge:verify:request',
      timestamp: Date.now(),
      payload,
    } as BaseMessage);
  }

  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> });
  }

  function history(): ForgeExecutionResult[] {
    return (data.get('forge:history') as ForgeExecutionResult[] | undefined) ?? [];
  }

  function audit(): AuditLogEntry[] {
    return (data.get('audit:trail') as AuditLogEntry[] | undefined) ?? [];
  }

  /** The one refusal posted, and that nothing was read from an org. */
  function refusedWith(code: string): string {
    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
    expect(verifierCalls).toEqual([]);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'forge:verify:error',
      correlationId: 'wv-verify',
      payload: { code },
    });
    return String(posted()[0].payload.message);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    verifierCalls.length = 0;
    verifierAnswer = async () => VERIFIED;
    data = new Map<string, unknown>([['forge:history', [pastRun()]]]);
    registered = new Set(['tgt-org', 'src-org']);
    mockGetJsforceConnection.mockImplementation(async (orgId: string) => ({ name: orgId }));
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) =>
          registered.has(orgId) ? { id: orgId, alias: orgId.toUpperCase() } : undefined,
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn((key: string) => data.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          data.set(key, value);
        }),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      nextId: () => `ext-${++ids}`,
    };
    handler = new ForgeHandler(deps);
  });

  it('verifies the records the run created, in the org it wrote to, against the org it read from', async () => {
    expect(await handler.handle(request({ forgeId: 'forge-run' }))).toBe(true);

    expect(mockGetJsforceConnection.mock.calls.map((call) => call[0])).toEqual([
      'tgt-org',
      'src-org',
    ]);
    expect(verifierCalls).toHaveLength(1);
    const [{ deps: orgs, run }] = verifierCalls;
    expect(orgs).toEqual({ target: { org: 'tgt-org' }, source: { org: 'src-org' } });
    // What the run created, never the account it linked to; dated as the
    // target dated it; with what the run left out, renamed and wrote without.
    expect(run.records).toEqual([
      { objectApiName: 'Contact', ids: ['003000000000101AAA'] },
      { objectApiName: 'Account', ids: ['001000000000101AAA'] },
    ]);
    expect(run.remapTable).toEqual(pastRun().idRemapTable);
    expect(run.runEndedAt).toEqual(new Date('2026-10-01T07:59:58.000Z'));
    expect(run.runRecordedAt).toBeUndefined();
    expect(run.fieldExclusions).toEqual({ Contact: ['Birthdate'] });
    expect(run.fieldMappings).toEqual({ Account: { Region__c: 'Region__pc' } });
    expect(run.writtenWithout).toEqual({ Contact: ['ReportsToId'] });

    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:verify:response',
        correlationId: 'wv-verify',
        payload: { verification: VERIFIED },
      }),
    ]);
  });

  it("keeps the verdict on the run's entry in the history, and the other runs as they were", async () => {
    const other = pastRun({ forgeId: 'forge-other' });
    data.set('forge:history', [pastRun(), other]);

    await handler.handle(request({ forgeId: 'forge-run' }));

    expect(history()[0].verification).toEqual(VERIFIED);
    expect(history()[1]).toEqual(other);
  });

  it('records the verification in the audit trail with its verdict and its counts, never a record', async () => {
    await handler.handle(request({ forgeId: 'forge-run' }));

    expect(audit()).toHaveLength(1);
    const [entry] = audit();
    expect(entry).toMatchObject({
      action: 'forge_verify',
      module: 'forge',
      orgId: 'tgt-org',
      outcome: 'success',
      verdict: 'verified',
      details: {
        forgeId: 'forge-run',
        expected: 2,
        present: 2,
        deleted: 0,
        notVisible: 0,
        changed: 1,
        linksChecked: 1,
        linksBroken: 0,
        attempts: 2,
      },
    });
    expect(entry.operationId).toMatch(/^forge-verify-/);
    expect(JSON.stringify(entry)).not.toContain('003000000000101AAA');
  });

  it('records a partial or unstable verdict as a partial outcome', async () => {
    verifierAnswer = async () => ({ ...VERIFIED, verdict: 'unstable', attempts: 3 });
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(audit()[0]).toMatchObject({ outcome: 'partial', verdict: 'unstable' });
  });

  it('dates a run the target did not date by when it was recorded', async () => {
    data.set('forge:history', [pastRun({ writtenBetween: undefined })]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(verifierCalls[0].run.runEndedAt).toBeUndefined();
    expect(verifierCalls[0].run.runRecordedAt).toEqual(new Date('2026-10-01T08:00:00.000Z'));
  });

  it('reads back what is left of a run a removal took part of', async () => {
    data.set('forge:history', [
      pastRun({
        undo: {
          removedAt: '2026-10-01T09:00:00.000Z',
          deleted: 1,
          alreadyGone: 0,
          kept: 1,
          refused: 0,
        },
        removalLeft: ['001000000000101AAA'],
        removalStamps: { '001000000000101AAA': '2026-10-01T09:00:01.000+0000' },
      }),
    ]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(verifierCalls[0].run.records).toEqual([
      { objectApiName: 'Account', ids: ['001000000000101AAA'] },
    ]);
    expect(verifierCalls[0].run.removalStamps).toEqual({
      '001000000000101AAA': '2026-10-01T09:00:01.000+0000',
    });
  });

  it('verifies without the lookups when the run did not keep the org it read from', async () => {
    data.set('forge:history', [pastRun({ sourceOrgId: undefined })]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(mockGetJsforceConnection.mock.calls.map((call) => call[0])).toEqual(['tgt-org']);
    expect(verifierCalls[0].deps.source).toEqual({
      unavailable: 'This run was recorded before Forge kept the org it read from.',
    });
  });

  it('verifies without the lookups when the org it read from is gone or cannot be reached', async () => {
    registered.delete('src-org');
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(verifierCalls[0].deps.source).toEqual({
      unavailable: 'The org this run read from is no longer registered.',
    });

    registered.add('src-org');
    mockGetJsforceConnection.mockImplementation(async (orgId: string) => {
      if (orgId === 'src-org') throw new Error('expired access token');
      return { name: orgId };
    });
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(verifierCalls[1].deps.source).toEqual({
      unavailable: 'The org this run read from could not be reached: expired access token',
    });
  });

  it('refuses a run that is no longer in the history', async () => {
    await handler.handle(request({ forgeId: 'forge-gone' }));
    expect(refusedWith('NOT_FOUND')).toBe('This run is no longer in the Forge history.');
  });

  it('refuses a simulation, which wrote nothing', async () => {
    data.set('forge:history', [pastRun({ dryRun: true })]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(refusedWith('SIMULATION')).toContain('A simulation wrote nothing');
  });

  it('refuses a run recorded before runs kept what they created', async () => {
    data.set('forge:history', [pastRun({ idRemapCreated: undefined })]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    refusedWith('NOT_RECORDED');
  });

  it('refuses a run whose records were all removed, and one that created none', async () => {
    data.set('forge:history', [
      pastRun({
        undo: {
          removedAt: '2026-10-01T09:00:00.000Z',
          deleted: 2,
          alreadyGone: 0,
          kept: 0,
          refused: 0,
        },
      }),
    ]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(refusedWith('ALREADY_REMOVED')).toContain('2026-10-01T09:00:00.000Z');

    vi.mocked(deps.broker.postToWebview).mockClear();
    data.set('forge:history', [pastRun({ idRemapCreated: [] })]);
    await handler.handle(request({ forgeId: 'forge-run' }));
    refusedWith('NOTHING_TO_VERIFY');
  });

  it('refuses a run whose target is no longer registered', async () => {
    registered.delete('tgt-org');
    await handler.handle(request({ forgeId: 'forge-run' }));
    refusedWith('ORG_NOT_FOUND');
  });

  it('refuses a request that names records or anything past the run', async () => {
    await handler.handle(request({ forgeId: 'forge-run', recordIds: ['003000000000101AAA'] }));
    expect(verifierCalls).toEqual([]);
    expect(posted()[0]).toMatchObject({ type: 'forge:verify:error', correlationId: 'wv-verify' });
  });

  it('refuses a second verification of a run while the first is under way', async () => {
    let release: (v: ForgeRunVerification) => void = () => undefined;
    verifierAnswer = () =>
      new Promise<ForgeRunVerification>((resolve) => {
        release = resolve;
      });
    const first = handler.handle(request({ forgeId: 'forge-run' }));
    await vi.waitFor(() => expect(verifierCalls).toHaveLength(1));
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:verify:error',
        payload: expect.objectContaining({ code: 'DUPLICATE' }),
      }),
    ]);
    release(VERIFIED);
    await first;
    expect(posted().map((m) => m.type)).toEqual(['forge:verify:error', 'forge:verify:response']);
  });

  it('answers on the error channel, and records a failed verification, when the target cannot be read', async () => {
    mockGetJsforceConnection.mockRejectedValue(new Error('INVALID_SESSION_ID'));
    await handler.handle(request({ forgeId: 'forge-run' }));
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:verify:error',
        correlationId: 'wv-verify',
        payload: expect.objectContaining({ code: 'VERIFY_ERROR', retryable: true }),
      }),
    ]);
    expect(audit()[0]).toMatchObject({ action: 'forge_verify', outcome: 'failure' });
    expect(audit()[0].verdict).toBeUndefined();
    expect(history()[0].verification).toBeUndefined();
  });
});
