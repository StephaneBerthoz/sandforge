import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BaseMessage,
  PiiInventoryResult,
  SubjectRequestLogEntry,
  SubjectSearchResult,
} from '@sandforge/shared';

import { DataOpsComplianceHandler } from './DataOpsComplianceHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import type { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * The Compliance tab through its handler: the inventory, a subject request
 * searched, exported and erased — and what the extension keeps of it.
 */

const JANE = 'jane.doe@example.com';

const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  updateable: true,
  deletable: true,
  fields: [
    { name: 'Id', label: 'Contact ID', type: 'id', filterable: true, updateable: false },
    {
      name: 'Name',
      label: 'Full Name',
      type: 'string',
      nameField: true,
      filterable: true,
      updateable: false,
    },
    {
      name: 'FirstName',
      label: 'First Name',
      type: 'string',
      filterable: true,
      updateable: true,
      nillable: true,
    },
    {
      name: 'LastName',
      label: 'Last Name',
      type: 'string',
      filterable: true,
      updateable: true,
      nillable: false,
    },
    {
      name: 'Email',
      label: 'Email',
      type: 'email',
      filterable: true,
      updateable: true,
      nillable: true,
    },
  ],
  childRelationships: [],
};

const janeRecord = {
  Id: '003000000000001AAA',
  Name: 'Jane Doe',
  FirstName: 'Jane',
  LastName: 'Doe',
  Email: JANE,
};

/** A contact org holding Jane, once. */
function janeOrg() {
  const update = vi.fn(async (records: Array<Record<string, unknown>>) =>
    records.map((r) => ({ success: true, id: r.Id })),
  );
  const destroy = vi.fn(async (ids: string[]) => ids.map((id) => ({ success: true, id })));
  const query = vi.fn(async (soql: string) => {
    if (soql.startsWith('SELECT COUNT()')) return { totalSize: 1, records: [] };
    return { totalSize: 1, records: [janeRecord] };
  });
  return {
    conn: {
      describe: vi.fn(async () => contactDescribe),
      describeGlobal: vi.fn(async () => ({ sobjects: [] })),
      query,
      limitInfo: {},
      sobject: vi.fn(() => ({ update, destroy })),
    },
    query,
    update,
    destroy,
  };
}

function createDeps(orgType = 'Sandbox'): HandlerDeps {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: { getOrg: vi.fn(() => ({ orgType, alias: 'dev' })) },
    orgRegistry: {},
    configStore,
    nextId: () => String(++id),
    infraServices: { productionGuard: new ProductionGuard(), piiDetector: new PIIDetector() },
  } as unknown as HandlerDeps;
}

function request(type: string, payload: Record<string, unknown>, id = `req-${type}`) {
  return inboundRequest({ id, type, timestamp: Date.now(), payload });
}

describe('DataOpsComplianceHandler', () => {
  let deps: HandlerDeps;
  let save: ReturnType<typeof vi.fn>;
  let handler: DataOpsComplianceHandler;
  let org: ReturnType<typeof janeOrg>;

  beforeEach(() => {
    vi.mocked(getJsforceConnection).mockReset();
    org = janeOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);
    deps = createDeps();
    save = vi.fn(async () => ({ status: 'saved', path: '/tmp/request.json' }));
    handler = new DataOpsComplianceHandler(deps, { save } as unknown as SaveDialogAdapter);
  });

  const posted = (): Array<BaseMessage & { payload?: unknown }> =>
    vi.mocked(deps.broker.postToWebview).mock.calls.map((c) => c[0] as BaseMessage);
  /** The last answer of a type: each test may have sent several requests. */
  const answer = <T>(type: string): T =>
    posted()
      .filter((m) => m.type === type)
      .at(-1)?.payload as T;
  const logged = (): string =>
    vi
      .mocked(deps.log)
      .mock.calls.map((c) => c[0])
      .join('\n');

  /** Search for Jane, and return the request it opened. */
  async function searchJane(): Promise<SubjectSearchResult> {
    await handler.handle(
      request('dataops:dsr:search', { orgId: 'org-1', objects: ['Contact'], email: JANE }),
    );
    return answer<SubjectSearchResult>('dataops:dsr:search:response');
  }

  it('answers the inventory on its own channel, correlated to the request', async () => {
    await handler.handle(
      request('dataops:pii-inventory', { orgId: 'org-1', objects: ['Contact'] }, 'req-inv'),
    );

    const [reply] = posted();
    expect(reply.type).toBe('dataops:pii-inventory:response');
    expect(reply.correlationId).toBe('req-inv');
    const result = reply.payload as PiiInventoryResult;
    expect(result.objects[0]).toMatchObject({ status: 'scanned', sampled: 1 });
    expect(JSON.stringify(result)).not.toContain(JANE);
  });

  it('refuses an inventory of more objects than it reads, before it reaches the org', async () => {
    await handler.handle(
      request('dataops:pii-inventory', {
        orgId: 'org-1',
        objects: Array.from({ length: 11 }, (_, i) => `Object${i}__c`),
      }),
    );

    expect(getJsforceConnection).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({
      type: 'dataops:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });

  it('refuses a search with nothing to search for', async () => {
    await handler.handle(request('dataops:dsr:search', { orgId: 'org-1', objects: ['Contact'] }));

    expect(getJsforceConnection).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({
      type: 'dataops:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });

  it('finds the records, opens a request in the log, and keeps nothing it searched for', async () => {
    const result = await searchJane();

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.objects[0]).toMatchObject({
      status: 'searched',
      records: [{ id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email'] }],
    });
    const [entry] = new SubjectRequestLogView(deps).list();
    expect(entry).toMatchObject({
      requestId: result.requestId,
      events: [
        {
          kind: 'searched',
          searchedBy: ['email'],
          objects: [{ objectApiName: 'Contact', found: 1, truncated: false }],
        },
      ],
    });
    const kept = JSON.stringify(deps.configStore.get('dataops:subject-requests'));
    expect(kept).not.toContain(JANE);
    expect(kept).not.toContain('003000000000001AAA');
    expect(kept).not.toContain('Jane');
    expect(logged()).not.toContain(JANE);
  });

  it('adds a second search to the request it names', async () => {
    const first = await searchJane();
    vi.mocked(deps.broker.postToWebview).mockClear();

    await handler.handle(
      request('dataops:dsr:search', {
        orgId: 'org-1',
        objects: ['Contact'],
        name: 'Jane Doe',
        requestId: first.requestId,
      }),
    );

    expect(answer<SubjectSearchResult>('dataops:dsr:search:response').requestId).toBe(
      first.requestId,
    );
    expect(new SubjectRequestLogView(deps).list()[0].events).toHaveLength(2);
  });

  it('writes the export where the user picks, logs it once written, and sends no record back', async () => {
    const { requestId } = await searchJane();

    await handler.handle(request('dataops:dsr:export', { orgId: 'org-1', requestId }));

    const [name, content, extensions] = save.mock.calls[0];
    expect(name).toBe(`sandforge-subject-request-${requestId.slice(0, 8)}.json`);
    expect(JSON.parse(content).objects.Contact[0]).toMatchObject({ Email: JANE });
    expect(extensions).toEqual(['json']);
    const reply = answer<Record<string, unknown>>('dataops:dsr:export:response');
    expect(reply).toMatchObject({ requestId, records: 1, saved: { status: 'saved' } });
    expect(JSON.stringify(reply)).not.toContain(JANE);
    expect(new SubjectRequestLogView(deps).list()[0].events.map((e) => e.kind)).toEqual([
      'searched',
      'exported',
    ]);
  });

  it('logs no export the user cancelled', async () => {
    save.mockResolvedValueOnce({ status: 'cancelled' });
    const { requestId } = await searchJane();

    await handler.handle(request('dataops:dsr:export', { orgId: 'org-1', requestId }));

    expect(new SubjectRequestLogView(deps).list()[0].events.map((e) => e.kind)).toEqual([
      'searched',
    ]);
  });

  it('exports nothing for a request no search in this window found', async () => {
    await handler.handle(
      request('dataops:dsr:export', {
        orgId: 'org-1',
        requestId: '5b0a9b8c-0000-4000-8000-000000000000',
      }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({ type: 'dataops:error' });
  });

  it('plans an erasure on a dry run, and writes nothing', async () => {
    const { requestId } = await searchJane();

    await handler.handle(
      request('dataops:dsr:erase', {
        orgId: 'org-1',
        requestId,
        mode: 'anonymize',
        records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
        dryRun: true,
      }),
    );

    const reply = answer<{ plan: Array<{ fields: Array<{ fieldApiName: string }> }> }>(
      'dataops:dsr:erase:response',
    );
    expect(reply.plan[0].fields.map((f) => f.fieldApiName)).toEqual(
      expect.arrayContaining(['Email', 'FirstName', 'LastName']),
    );
    expect(org.update).not.toHaveBeenCalled();
    expect(new AuditTrailStore(deps.configStore).list().entries).toEqual([]);
  });

  it('erases in place through the guard, and records it in the audit trail and the request', async () => {
    const { requestId } = await searchJane();

    await handler.handle(
      request('dataops:dsr:erase', {
        orgId: 'org-1',
        requestId,
        mode: 'anonymize',
        records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
        dryRun: false,
      }),
    );

    const [written] = org.update.mock.calls[0];
    expect(written[0].Id).toBe('003000000000001AAA');
    expect(written[0].Email).not.toBe(JANE);
    expect(answer<{ outcome: unknown }>('dataops:dsr:erase:response').outcome).toMatchObject({
      status: 'success',
      done: 1,
    });
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'subject_erase',
      outcome: 'success',
      guard: 'allowed',
      objects: [{ objectApiName: 'Contact', updated: 1 }],
    });
    const erased = new SubjectRequestLogView(deps).list()[0].events[1];
    expect(erased).toMatchObject({ kind: 'erased', mode: 'anonymize', outcome: 'success' });
  });

  it('erases only what the request found', async () => {
    const { requestId } = await searchJane();

    await handler.handle(
      request('dataops:dsr:erase', {
        orgId: 'org-1',
        requestId,
        mode: 'delete',
        records: [{ objectApiName: 'Contact', ids: ['003000000000009AAA'] }],
        dryRun: false,
      }),
    );

    expect(org.destroy).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: { message: expect.stringContaining('not found by this request') },
    });
  });

  it('deletes nothing on production, and logs the request as stopped', async () => {
    deps = createDeps('Production');
    handler = new DataOpsComplianceHandler(deps, { save } as unknown as SaveDialogAdapter);
    const { requestId } = await searchJane();

    await handler.handle(
      request('dataops:dsr:erase', {
        orgId: 'org-1',
        requestId,
        mode: 'delete',
        records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
        dryRun: false,
      }),
    );

    expect(org.destroy).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: { message: expect.stringMatching(/^Operation blocked by Production Guard: /) },
    });
    expect(new SubjectRequestLogView(deps).list()[0].events[1]).toMatchObject({
      kind: 'erased',
      outcome: 'stopped',
    });
  });

  it('lists the log, the newest request first', async () => {
    const first = await searchJane();
    const second = await searchJane();

    await handler.handle(request('dataops:dsr:log', {}, 'req-log'));

    const entries = answer<{ entries: SubjectRequestLogEntry[] }>(
      'dataops:dsr:log:response',
    ).entries;
    expect(entries.map((e) => e.requestId)).toEqual([second.requestId, first.requestId]);
  });
});

/** The log as the next session reads it: from the store alone. */
class SubjectRequestLogView {
  constructor(private readonly deps: HandlerDeps) {}

  list(): SubjectRequestLogEntry[] {
    const raw =
      this.deps.configStore.get<SubjectRequestLogEntry[]>('dataops:subject-requests') ?? [];
    return [...raw].reverse();
  }
}
