import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgTypeAndEdition } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER, type MemoryOrgRequest } from '../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  FIELDS,
  LONG_AGO,
  ORG_ID,
  RewindTestOrg,
  STAMP_FIELDS,
  T0,
  account,
  clock,
  writable,
} from '../../test/rewindTestOrg.js';
import { openCheckpointStore } from './OrgCheckpointStore.js';
import { readReplayAnnex } from './replay/replayAnnex.js';
import { scopeCheckpoint, takeCheckpoint, type TakeRequest } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The replay annex a take keeps from 1.81 on, on the memory org of the
 * rewinds: a sandbox's accounts owned by users and a queue, its record
 * types, and what its day's limits say of its data storage. The org refuses
 * what an org refuses: `IsPersonType` where person accounts are off, a read
 * of an object its user may not read.
 */

const QUEUE = '00G000000000001AAA';
const REVIEWER = '005000000000004AAA';
/** A user of the org no record of the checkpoint names: never in the annex. */
const BYSTANDER = '005000000000005AAA';

/** Accounts with an owner and a reviewer, of an org without person accounts. */
const SANDBOX_FIELDS = {
  ...FIELDS,
  Account: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('OwnerId', 'reference', { referenceTo: ['Group', 'User'] }),
    writable('Reviewer__c', 'reference', { referenceTo: ['User'] }),
  ],
};

/** A sandbox that says its data storage, as `/limits` lists it. */
class SandboxOrg extends RewindTestOrg {
  dataStorageMb?: number = 5120;

  constructor() {
    super({ fields: SANDBOX_FIELDS });
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: true,
      OrganizationType: 'Enterprise Edition',
    });
    this.missingFields.set('RecordType', new Set(['IsPersonType']));
    for (const [Id, Username, Name, IsActive] of [
      [MEMORY_ORG_USER, 'ada@example.com.uat', 'Ada Admin', true],
      [COLLEAGUE, 'grace@example.com.uat', 'Grace Tester', false],
      [REVIEWER, 'rhea@example.com.uat', 'Rhea Reviewer', true],
      [BYSTANDER, 'bo@example.com.uat', 'Bo Bystander', true],
    ] as const) {
      this.add('User', { Id, Username, Name, IsActive, UserType: 'Standard' });
    }
    this.add('RecordType', {
      Id: '012000000000001AAA',
      SobjectType: 'Account',
      DeveloperName: 'Retail',
      NamespacePrefix: null,
      Name: 'Retail',
      IsActive: true,
    });
    this.add('Group', {
      Id: QUEUE,
      DeveloperName: 'Escalations',
      Name: 'Escalations',
      Type: 'Queue',
    });
    this.add('QueueSobject', { Id: '03g000000000001AAA', QueueId: QUEUE, SobjectType: 'Account' });
    clock.now = LONG_AGO;
    this.add('Account', { Id: account(1), Name: 'One', OwnerId: MEMORY_ORG_USER });
    this.add('Account', { Id: account(2), Name: 'Two', OwnerId: COLLEAGUE, Reviewer__c: REVIEWER });
    this.add('Account', { Id: account(3), Name: 'Three', OwnerId: QUEUE });
    clock.now = T0;
  }

  /** Its REST requests and SOAP calls: the snapshot's own connection reads it too. */
  requestsSent(): number {
    return this.requests + this.soapCalls;
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return {
        DailyApiRequests: this.limits,
        ...(this.dataStorageMb !== undefined
          ? { DataStorageMB: { Max: this.dataStorageMb, Remaining: this.dataStorageMb } }
          : {}),
      };
    }
    return super.request(request);
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  clock.now = T0;
});

/** What the take is asked: the accounts of the sandbox, registered as `registered` says. */
function requestOf(registered: OrgTypeAndEdition): TakeRequest {
  return {
    orgId: 'org-1',
    orgName: 'UAT',
    alias: 'UAT',
    username: 'tester@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    registered,
    mode: 'picked',
    objects: ['Account'],
    name: 'Before UAT',
  };
}

/** The take of the sandbox's accounts, and its store. */
async function take(org: SandboxOrg, registered: OrgTypeAndEdition) {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-annex-take-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const deps = {
    org,
    store: opened.store,
    handler: {
      log: () => undefined,
      orgManager: { getOrg: () => ({ orgType: 'Sandbox' }) } as never,
      orgRegistry: {} as never,
    },
    now: () => new Date(T0),
  };
  const scope = await scopeCheckpoint(deps, requestOf(registered));
  const outcome = await takeCheckpoint(deps, requestOf(registered));
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  const folder = opened.store.folderOf(ORG_ID, outcome.checkpoint.checkpointId);
  return { scope, outcome, folder, store: opened.store };
}

describe('a take keeps what a replay in another org needs', () => {
  it('keeps the org’s data storage and Staging mark, and an annex of its record types, its queues and the users its records name, no other', async () => {
    const org = new SandboxOrg();

    const { outcome, folder } = await take(org, { orgType: 'Sandbox', staging: true });

    const { checkpoint } = outcome;
    expect(checkpoint.org.dataStorageMaxMB).toBe(5120);
    expect(checkpoint.org.staging).toBe(true);
    expect(checkpoint.replayAnnex).toEqual({
      recordTypes: 1,
      users: 3,
      queues: 1,
      standardPricebook: false,
    });
    const annex = await readReplayAnnex(folder);
    expect(annex?.users.map((user) => user.username).sort()).toEqual([
      'ada@example.com.uat',
      'grace@example.com.uat',
      'rhea@example.com.uat',
    ]);
    expect(annex?.queues).toEqual([
      { id: QUEUE, developerName: 'Escalations', name: 'Escalations', sobjectTypes: ['Account'] },
    ]);
    expect(annex?.recordTypes.map((type) => type.developerName)).toEqual(['Retail']);
    // An org without person accounts is never asked the column it does not have.
    expect(annex?.unread).toEqual([]);
  });

  it('reads the annex in the snapshot’s phase, one call, as its estimate said before the take', async () => {
    const org = new SandboxOrg();

    const { scope, outcome } = await take(org, { orgType: 'Sandbox' });

    expect(scope.estimate.requestsByPhase?.snapshot).toBe(
      outcome.estimate.requestsByPhase?.snapshot,
    );
    // A page of accounts, which org the snapshot is of, the annex.
    expect(outcome.requests?.byPhase.snapshot).toBe(1 + 1 + 1);
    expect(outcome.requests?.byPhase.snapshot).toBe(outcome.estimate.requestsByPhase?.snapshot);
  });

  it('keeps no Staging mark the registry did not give, nor one of an org that is no sandbox, and no storage the org did not say', async () => {
    const fromTheCommandLine = await take(new SandboxOrg(), { orgType: 'Sandbox' });
    expect(fromTheCommandLine.outcome.checkpoint.org).not.toHaveProperty('staging');

    const developer = new SandboxOrg();
    developer.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
    });
    developer.dataStorageMb = undefined;
    const { outcome } = await take(developer, { orgType: 'Developer', staging: true });
    expect(outcome.checkpoint.org).not.toHaveProperty('staging');
    expect(outcome.checkpoint.org).not.toHaveProperty('dataStorageMaxMB');
  });

  it('is taken all the same when the org refuses a part of the annex, which it names with the org’s words', async () => {
    const org = new SandboxOrg();
    org.refuseRead.set('QueueSobject', {
      errorCode: 'INSUFFICIENT_ACCESS',
      message: 'insufficient access rights on object id',
    });

    const { outcome, folder } = await take(org, { orgType: 'Sandbox' });

    expect(outcome.checkpoint.status).toBe('ready');
    expect(outcome.checkpoint.replayAnnex).toMatchObject({ queues: 0, unread: ['queues'] });
    const annex = await readReplayAnnex(folder);
    expect(annex?.unread).toEqual([
      { part: 'queues', reason: expect.stringContaining('insufficient access') as unknown },
    ]);
    expect(annex?.users).toHaveLength(3);
  });
});
