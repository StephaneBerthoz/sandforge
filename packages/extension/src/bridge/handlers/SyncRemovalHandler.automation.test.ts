import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ForgeRemovalSteps, ForgeTargetAutomation } from '@sandforge/shared';
import { firedOnRemovalStepsOf } from '@sandforge/shared';

import { SyncRemovalHandler } from './SyncRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import {
  TRIGGERS_SOQL,
  TargetAutomationReader,
  type QueryAnswer,
} from '../../modules/forge/TargetAutomationReader.js';
import {
  nodeSyncRunCreations,
  type SyncRunCreations,
} from '../../modules/sync/SyncRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';
const BACKUP = 'sync-before-run-all';

/** An active Apex trigger of the target, as the Tooling API lists it. */
function triggerRow(objectApiName: string, name: string, flags: string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {
    Name: name,
    NamespacePrefix: null,
    TableEnumOrId: objectApiName,
    EntityDefinition: { QualifiedApiName: objectApiName },
  };
  for (const flag of [
    'UsageBeforeInsert',
    'UsageAfterInsert',
    'UsageBeforeUpdate',
    'UsageAfterUpdate',
    'UsageBeforeDelete',
    'UsageAfterDelete',
    'UsageAfterUndelete',
  ]) {
    row[flag] = flags.includes(flag);
  }
  return row;
}

/**
 * The target's automation, read as Forge reads it: a trigger on cases that
 * runs after an undelete alone, one on contacts that runs as they are
 * updated, and one on orders as they are deleted; no flow, process or rule.
 */
function targetReader(): { reader: TargetAutomationReader; asked: string[] } {
  const asked: string[] = [];
  const answer = (records: Array<Record<string, unknown>>): QueryAnswer => ({
    records,
    requests: 1,
  });
  const reader = new TargetAutomationReader({
    query: async (_orgId, soql) => {
      asked.push(soql);
      return answer([]);
    },
    toolingQuery: async (_orgId, soql) => {
      asked.push(soql);
      return answer(
        soql === TRIGGERS_SOQL
          ? [
              triggerRow('Case', 'CaseRestore', ['UsageAfterUndelete']),
              triggerRow('Contact', 'ContactAudit', ['UsageAfterUpdate']),
              triggerRow('Order', 'OrderGuard', ['UsageBeforeDelete']),
            ]
          : [],
      );
    },
  });
  return { reader, asked };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

/** What `sync:remove:automation:response` carries. */
interface AutomationAnswer {
  runId: string;
  automation: ForgeTargetAutomation;
  steps: ForgeRemovalSteps;
}

describe('what the target runs as the removal of a Sync run takes it back', () => {
  let storage: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let creations: SyncRunCreations;
  let handler: SyncRemovalHandler;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): AutomationAnswer | undefined =>
    posted<BaseMessage & { payload: AutomationAnswer }>('sync:remove:automation:response')[0]
      ?.payload;
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(
      'sync:remove:automation:error',
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-sync-automation-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    creations = nodeSyncRunCreations(storage);
    // A delta run that created an account and an order, wrote over a contact
    // the target held — its values kept first — and deleted a case the
    // source had deleted.
    const recorder = creations.recorder({
      runId: 'run-all',
      configId: 'cfg-1',
      configName: 'Everything',
      sourceOrgId: 'org-source',
      targetOrgId: TARGET_ORG,
      startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    recorder.note('Account', [id('001', 1)]);
    recorder.note('Order', [id('801', 1)]);
    recorder.overwriting?.('Contact', BACKUP, [id('003', 1)]);
    recorder.overwrote?.('Contact', []);
    recorder.deleted?.('Case', [id('500', 1)]);
    await recorder.end({ status: 'success' });
    store.set(
      `backup:${BACKUP}`,
      { operationId: BACKUP, timestamp: new Date(Date.now() - 12 * 60_000).toISOString() },
      'backups',
    );
    handler = new SyncRemovalHandler(deps, { list: () => [] }, () => false);
    handler.setRunCreations(creations);
  });

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it('names the trigger that runs after the undelete of what the run deleted, beside what its updates and deletes fire', async () => {
    handler.setTargetAutomation(targetReader().reader);

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));

    expect(errors()).toEqual([]);
    const response = answer();
    expect(response?.runId).toBe('run-all');
    expect(response?.steps).toEqual({
      bringBack: ['Case'],
      giveBack: ['Contact'],
      setToDraft: ['Order'],
      delete: ['Order', 'Account'],
    });
    const fired = firedOnRemovalStepsOf(response!.automation, response!.steps);
    expect(fired.map((f) => `${f.step} ${f.objectApiName} ${f.name} ${f.when}`)).toEqual([
      'bringBack Case CaseRestore after',
      'giveBack Contact ContactAudit after',
      'delete Order OrderGuard before',
    ]);
  });

  it('reads the objects of every step once, asking for the triggers of an undelete', async () => {
    const read = vi.fn(
      async (
        _orgId: string,
        _objects: readonly string[],
        _options?: { undeletes?: boolean },
      ): Promise<ForgeTargetAutomation> => ({
        objectsRead: [],
        objects: [],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 25,
        requests: 0,
      }),
    );
    handler.setTargetAutomation({ read });

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(TARGET_ORG, ['Case', 'Contact', 'Order', 'Account'], {
      undeletes: true,
    });
  });

  it('reads what fires on deleting every record the run created when the removal takes them all again', async () => {
    // Its removal found what it created gone: none of it is left to delete.
    await creations.updateRemoval('run-all', (state) => ({
      ...state,
      undo: {
        removedAt: new Date().toISOString(),
        deleted: 0,
        alreadyGone: 2,
        kept: 0,
        refused: 0,
      },
      removalLeft: [],
    }));
    handler.setTargetAutomation(targetReader().reader);

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));
    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all', again: true }));

    const [left, again] = posted<BaseMessage & { payload: AutomationAnswer }>(
      'sync:remove:automation:response',
    ).map((m) => m.payload);
    expect(left?.steps.delete).toEqual([]);
    expect(firedOnRemovalStepsOf(left!.automation, left!.steps).map((f) => f.name)).not.toContain(
      'OrderGuard',
    );
    expect(again?.steps).toMatchObject({ setToDraft: ['Order'], delete: ['Order', 'Account'] });
    expect(firedOnRemovalStepsOf(again!.automation, again!.steps).map((f) => f.name)).toContain(
      'OrderGuard',
    );
  });

  it('gives nothing back of what the run wrote over once its backup is gone', async () => {
    store.delete(`backup:${BACKUP}`);
    handler.setTargetAutomation(targetReader().reader);

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));

    expect(answer()?.steps.giveBack).toEqual([]);
    const fired = firedOnRemovalStepsOf(answer()!.automation, answer()!.steps);
    expect(fired.map((f) => f.name)).toEqual(['CaseRestore', 'OrderGuard']);
  });

  it('refuses a run it keeps nothing of, and one whose org is gone, reading nothing', async () => {
    const { reader, asked } = targetReader();
    handler.setTargetAutomation(reader);

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-unknown' }));
    vi.mocked(deps.orgManager.getOrg).mockReturnValue(undefined);
    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));

    expect(errors().map((e) => e.payload.code)).toEqual(['NOT_KEPT', 'ORG_GONE']);
    expect(asked).toEqual([]);
    expect(answer()).toBeUndefined();
  });

  it('says why when the read fails, to be asked again', async () => {
    handler.setTargetAutomation({
      read: async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      },
    });

    await handler.handle(buildMsg('sync:remove:automation', { runId: 'run-all' }));

    expect(errors()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: 'AUTOMATION_ERROR',
          retryable: true,
          message: expect.stringContaining('Session expired'),
        }),
      }),
    ]);
  });

  it('refuses a request that names no run, before anything is read', async () => {
    const { reader, asked } = targetReader();
    handler.setTargetAutomation(reader);

    await handler.handle(buildMsg('sync:remove:automation', {}));

    expect(errors()).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});
