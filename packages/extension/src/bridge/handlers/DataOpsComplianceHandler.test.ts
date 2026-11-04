import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import type { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

// What the org runs as an erasure writes over or deletes the records it
// found: nothing, as an org without flows or triggers on them answers,
// unless a test says what fires. The erasure reads it before its first write.
const automation = vi.hoisted(() => ({
  fires: undefined as
    | undefined
    | { label: string; startsOn: 'update' | 'delete'; timing: 'beforeSave' | 'afterSave' },
}));
vi.mock('../../modules/forge/TargetAutomationReader.js', () => ({
  TargetAutomationReader: class {
    read(_orgId: string, objects: readonly string[]) {
      const fires = automation.fires;
      return Promise.resolve({
        objectsRead: [...objects],
        objects: fires
          ? objects.map((objectApiName) => ({
              objectApiName,
              flows: [
                {
                  apiName: fires.label.replaceAll(' ', '_'),
                  label: fires.label,
                  timing: fires.timing,
                  startsOn: fires.startsOn,
                  condition: 'read',
                  permissions: [],
                },
              ],
              triggers: [],
            }))
          : [],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: fires ? 1 : 0,
      });
    }
  },
  targetAutomationQueries: () => ({}),
}));

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
    automation.fires = undefined;
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

  it('says an erasure writes to the org while it writes, and no longer once it ended; a dry run writes to none: a checkpoint of the org is refused meanwhile', async () => {
    const { requestId } = await searchJane();
    const during: boolean[] = [];
    org.update.mockImplementation(async (records: Array<Record<string, unknown>>) => {
      during.push(handler.isWritingTo('org-1'), handler.isWritingTo('org-2'));
      return records.map((r) => ({ success: true, id: r.Id }));
    });
    let planning: boolean | undefined;
    org.query.mockImplementation(async (soql: string) => {
      planning ??= handler.isWritingTo('org-1');
      if (soql.startsWith('SELECT COUNT()')) return { totalSize: 1, records: [] };
      return { totalSize: 1, records: [janeRecord] };
    });
    const erase = (dryRun: boolean) =>
      handler.handle(
        request('dataops:dsr:erase', {
          orgId: 'org-1',
          requestId,
          mode: 'anonymize',
          records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
          dryRun,
        }),
      );

    await erase(true);
    expect(planning).toBe(false);
    await erase(false);

    expect(during).toEqual([true, false]);
    expect(handler.isWritingTo('org-1')).toBe(false);
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

  it('overwrites nothing an update flow fires on, and logs the request as stopped, until the confirmation accepts it', async () => {
    automation.fires = { label: 'Notify Owner', startsOn: 'update', timing: 'afterSave' };
    const { requestId } = await searchJane();
    const erase = (accord: Record<string, unknown>) =>
      handler.handle(
        request('dataops:dsr:erase', {
          orgId: 'org-1',
          requestId,
          mode: 'anonymize',
          records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
          dryRun: false,
          ...accord,
        }),
      );

    await erase({});

    expect(org.update).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: {
        code: 'AUTOMATION_NOT_ACCEPTED',
        message: expect.stringContaining(
          'dev runs automation as this erasure writes over its records: Contact: flow ' +
            '"Notify Owner" (as it is masked, after save)',
        ),
      },
    });
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'subject_erase',
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'AUTOMATION_NOT_ACCEPTED' }),
    });
    expect(new SubjectRequestLogView(deps).list()[0].events[1]).toMatchObject({
      kind: 'erased',
      mode: 'anonymize',
      outcome: 'stopped',
    });

    await erase({ acceptAutomation: true });
    expect(org.update).toHaveBeenCalled();
    expect(answer<{ outcome: unknown }>('dataops:dsr:erase:response').outcome).toMatchObject({
      status: 'success',
      done: 1,
    });
  });

  it('deletes nothing a flow runs before, until the confirmation accepts it', async () => {
    automation.fires = { label: 'Guard Delete', startsOn: 'delete', timing: 'beforeSave' };
    const { requestId } = await searchJane();
    const erase = (accord: Record<string, unknown>) =>
      handler.handle(
        request('dataops:dsr:erase', {
          orgId: 'org-1',
          requestId,
          mode: 'delete',
          records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
          dryRun: false,
          ...accord,
        }),
      );

    await erase({});

    expect(org.destroy).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: {
        code: 'AUTOMATION_NOT_ACCEPTED',
        message: expect.stringContaining(
          'dev runs automation as this erasure deletes its records: Contact: flow ' +
            '"Guard Delete" (before delete)',
        ),
      },
    });

    await erase({ acceptAutomation: true });
    expect(org.destroy).toHaveBeenCalled();
  });

  it('refuses an erasure in the words of its confirmation, which has boxes where the command line has flags', async () => {
    // As the gate org answered: an update flow that emails, kept quiet by a
    // set's bypass, on an org that delivers every email.
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.conn,
      request: vi.fn(async ({ url }: { url: string }) =>
        url === '/limits'
          ? {
              SingleEmail: { Max: 15, Remaining: 15 },
              DailyWorkflowEmails: { Max: 525, Remaining: 525 },
            }
          : { compiled: true, success: true },
      ),
    } as never);
    handler.setTargetAutomation({
      read: async (_orgId: string, objects: readonly string[]) => ({
        objectsRead: [...objects],
        objects: objects.map((objectApiName) => ({
          objectApiName,
          flows: [
            {
              apiName: 'Contact_Update_Email',
              label: 'Contact Update Email',
              timing: 'afterSave' as const,
              startsOn: 'update' as const,
              condition: 'read' as const,
              permissions: [{ name: 'Gate_Bypass', bypass: true }],
              messages: [{ kind: 'email' as const, name: 'Send', limit: 'SingleEmail' as const }],
            },
          ],
          triggers: [],
        })),
        bypassGrants: [
          {
            permission: 'Gate_Bypass',
            permissionSets: [{ name: 'Gate_Bypass', label: 'Gate Bypass', grants: 1 }],
          },
        ],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 1,
      }),
    });
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

    expect(org.update).not.toHaveBeenCalled();
    const refusal = posted().at(-1);
    expect(refusal).toMatchObject({
      type: 'dataops:error',
      payload: { code: 'AUTOMATION_NOT_ACCEPTED' },
    });
    const said = String((refusal?.payload as { message?: unknown }).message);
    // The banner showed "Add --accept-automation", "--accept-emails" and
    // "--mute-automation": the page has none of them.
    expect(said).not.toMatch(/--[a-z]/);
    expect(said).toContain('Confirm the erasure from its confirmation, which lists what fires');
    expect(said).toContain("Tick the confirmation's box that lets the org send these emails");
    expect(said).toContain(
      "With the confirmation's box that mutes the target's automation ticked, the erasure " +
        'assigns Gate_Bypass',
    );
  });

  it('answers an erasure that muted with what it took back, once it took it back', async () => {
    const events: string[] = [];
    const permissions = memoryPermissionOrg({
      sets: [{ id: '0PSxx0000000001AAA', name: 'Flow_Bypass' }],
      beforeWrite: (write) => {
        events.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });
    const { query, sobject } = org.conn;
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.conn,
      query: (soql: string) =>
        /FROM (Organization|UserPermissionAccess|PermissionSet|PermissionSetAssignment)\b/.test(
          soql,
        )
          ? permissions.connection.query(soql)
          : query(soql),
      identity: permissions.connection.identity,
      sobject: (name: string) =>
        name === 'PermissionSetAssignment' ? permissions.connection.sobject(name) : sobject(),
    } as never);
    vi.mocked(deps.broker.postToWebview).mockImplementation((m: BaseMessage) => {
      if (m.type === 'dataops:dsr:erase:response') {
        events.push(`answered, ${permissions.assignments().length} assigned`);
      }
    });
    const dir = mkdtempSync(join(tmpdir(), 'erase-mute-'));
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    handler.setTargetAutomation({
      read: async (_orgId: string, objects: readonly string[]) => ({
        objectsRead: [...objects],
        objects: objects.map((objectApiName) => ({
          objectApiName,
          flows: [
            {
              apiName: 'Notify_Owner',
              label: 'Notify Owner',
              timing: 'afterSave' as const,
              startsOn: 'update' as const,
              condition: 'read' as const,
              permissions: [{ name: 'Skip_Flows', bypass: true }],
            },
          ],
          triggers: [],
        })),
        bypassGrants: [
          {
            permission: 'Skip_Flows',
            permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
          },
        ],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 1,
      }),
    });
    const { requestId } = await searchJane();

    try {
      await handler.handle(
        request('dataops:dsr:erase', {
          orgId: 'org-1',
          requestId,
          mode: 'anonymize',
          records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
          dryRun: false,
          acceptAutomation: true,
          muteAutomation: true,
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(org.update).toHaveBeenCalled();
    expect(events).toEqual(['assign', 'unassign', 'answered, 0 assigned']);
    expect(answer('dataops:dsr:erase:response')).toMatchObject({
      outcome: { status: 'success', done: 1 },
      mutedAutomation: { assigned: ['Flow_Bypass'], released: true, takenBack: ['Flow_Bypass'] },
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
