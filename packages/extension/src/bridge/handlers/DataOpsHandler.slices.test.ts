import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseMessage, ForgeTargetAutomation } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { AnonymizationEngine } from '../../modules/dataops/AnonymizationEngine.js';
import { BackupSetStore } from '../../modules/dataops/slices/backupSet.js';
import type { RunKeyStore } from '../../modules/dataops/slices/runKeyStore.js';
import { MaskingCheckpointStore } from '../../modules/dataops/MaskingCheckpointStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { SlicedOrg, type SlicedRow } from '../../test/slicedOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/*
 * A masking run in slices: an object cut into slices of as many rows as a
 * snapshot holds, each backed up just before it is masked, and masked from
 * that snapshot's file; resumed with the key it was masked with; stopped
 * between two slices on its bound; the rows created late, said and masked
 * with a snapshot of their own; refused before the guard for what it cannot
 * do. The org refuses what the org refuses (`SlicedOrg`).
 */

/** The fields of a contact the templates mask, and one they leave. */
const FIELDS = [
  'Id',
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingPostalCode',
  'Birthdate',
  'Department',
  'CreatedDate',
  'SystemModstamp',
];

/** The `n`-th contact id: ordered by the org as by its number. */
function idOf(n: number): string {
  return `003${String(n).padStart(12, '0')}AAA`;
}

/** `count` contacts, numbered `step` apart, created long before any run. */
function contactsOf(count: number, step = 1): SlicedRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = (i + 1) * step;
    return {
      Id: idOf(n),
      FirstName: `First${n}`,
      LastName: `Last${n}`,
      Email: `person${n}@example.com`,
      Phone: `+33 1 00 00 ${String(n % 100).padStart(2, '0')}`,
      MailingStreet: `${n} rue Example`,
      MailingCity: 'Example City',
      MailingPostalCode: '75000',
      Birthdate: null,
      Department: 'Unmasked',
      CreatedDate: '2020-01-01T00:00:00.000Z',
      SystemModstamp: '2020-01-01T00:00:00.000Z',
    } as SlicedRow;
  });
}

/** What the org runs on Contact: nothing, unless a test gives it duplicate rules. */
function automation(duplicateRules = false): ForgeTargetAutomation {
  return {
    objectsRead: ['Contact'],
    objects: duplicateRules
      ? [
          {
            objectApiName: 'Contact',
            flows: [],
            triggers: [],
            duplicateRules: [{ name: 'Standard', developerName: 'Standard' }],
          },
        ]
      : [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
}

/** The backups' files in memory, every page appended told to `onAppend`. */
function memoryBackups(
  files: Map<string, string>,
  onAppend: (file: string, content: string) => void = () => undefined,
): BackupRecordStore {
  return new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    appendFile: async (p, content) => {
      onAppend(p, content);
      files.set(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      yield* (files.get(p) ?? '').split('\n');
    },
    mkdir: async () => undefined,
    rm: async (p) => {
      files.delete(p);
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => ({ name: path.basename(p), modifiedMs: Date.now() })),
  });
}

/** The ids a snapshot's file holds of Contact. */
function idsIn(files: Map<string, string>, snapshotId: string): string[] {
  return (files.get(`/storage/backups/${snapshotId}__Contact.ndjson`) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => String((JSON.parse(line) as { Id: string }).Id));
}

/** A key store in memory, shared by the handlers of a test as the editor's secret storage is. */
function memoryKeys(): RunKeyStore & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    save: async (setId, key) => {
      held.set(setId, key);
    },
    load: async (setId) => held.get(setId),
    delete: async (setId) => {
      held.delete(setId);
    },
  };
}

type Posted = BaseMessage & { payload: Record<string, unknown> };

describe('DataOpsHandler — masking in slices', () => {
  let config: ConfigStore;
  let files: Map<string, string>;
  let keys: ReturnType<typeof memoryKeys>;
  let registry: BackgroundOperationRegistry;
  /** Snapshot pages and updates, in the order they happened. */
  let timeline: Array<{ kind: 'snapshot' | 'update'; ids: string[]; file?: string }>;
  let settings: Record<string, unknown>;
  let deps: HandlerDeps;
  let handler: DataOpsHandler;

  /** A handler of a window of its own, over the same storage: a new key, as a reopened window has. */
  function newHandler(onCommandLine = true): DataOpsHandler {
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn(() => ({ alias: 'ORG', orgType: 'Sandbox' })) },
      orgRegistry: {},
      configStore: config,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: {
        getSandforgeSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
      },
      infraServices: {
        productionGuard: new ProductionGuard({ requestConfirmation: vi.fn(async () => false) }),
        backgroundRegistry: registry,
      },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    const made = new DataOpsHandler(deps);
    made.setBackupRecordStore(
      memoryBackups(files, (file, content) => {
        if (!file.endsWith('__Contact.ndjson')) return;
        timeline.push({
          kind: 'snapshot',
          file: path.basename(file),
          ids: content
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => String((JSON.parse(line) as { Id: string }).Id)),
        });
      }),
    );
    made.setRunKeyStore(keys);
    made.setDuplicatesSettle(0);
    made.setTargetAutomation({ read: async () => automation() });
    made.setOnCommandLine(onCommandLine);
    return made;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    config = new ConfigStore(new InMemoryConfigStoreBackend());
    config.initialize();
    files = new Map();
    keys = memoryKeys();
    registry = new BackgroundOperationRegistry();
    timeline = [];
    settings = { 'backup.maxRecordsPerObject': 1000 };
    handler = newHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An org of these rows, its updates added to the timeline. */
  function orgOf(rows: SlicedRow[], options: ConstructorParameters<typeof SlicedOrg>[1] = {}) {
    const org = new SlicedOrg(rows, {
      fields: FIELDS,
      ...options,
      afterUpdate: (ids) => {
        timeline.push({ kind: 'update', ids: [...ids] });
        options.afterUpdate?.(ids);
      },
    });
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    return org;
  }

  async function send(
    type: string,
    payload: Record<string, unknown>,
    id = 'run-1',
    by: DataOpsHandler = handler,
  ): Promise<void> {
    await by.handle(inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage));
  }

  function last(type: string): Posted | undefined {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Posted)
      .filter((m) => m.type === type)
      .at(-1);
  }

  const MASK = {
    orgId: 'org-1',
    templateId: 'tpl-gdpr-standard',
    objects: ['Contact'],
    snapshot: true,
    slices: true,
  };

  /** The ids every update sent, in order. */
  function updated(): string[] {
    return timeline.filter((t) => t.kind === 'update').flatMap((t) => t.ids);
  }

  /** The checkpoint a resume names, as the coverage gives it. */
  async function checkpointId(
    by: DataOpsHandler = handler,
    templateId = MASK.templateId,
  ): Promise<string> {
    await send(
      'dataops:anonymize:coverage',
      { orgId: 'org-1', templateId, objects: ['Contact'] },
      'coverage',
      by,
    );
    return String(
      (last('dataops:anonymize:coverage:response')?.payload.checkpoint as { id: string }).id,
    );
  }

  it('cuts 2,500 rows into slices of 1,000, 1,000 and 500, disjoint and contiguous, each backed up before any of its rows is written (T1)', async () => {
    const rows = contactsOf(2500);
    const org = orgOf(rows);

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      slices: {
        setId: string;
        state: string;
        objects: Array<{ slices: Array<Record<string, unknown>> }>;
      };
    };
    expect(result.status).toBe('success');
    expect(result.slices.state).toBe('done');
    const slices = result.slices.objects[0].slices;
    expect(slices.map((s) => s.rows)).toEqual([1000, 1000, 500]);
    const set = new BackupSetStore(config).get('run-1');
    const [s1, s2, s3] = set?.objects[0].slices ?? [];
    expect(s1.afterId).toBeUndefined();
    expect(s2.afterId).toBe(s1.lastId);
    expect(s3.afterId).toBe(s2.lastId);
    expect(s1.lastId).toBe(idOf(1000));
    expect(s2.lastId).toBe(idOf(2000));
    // The union of the snapshots holds every row once.
    const held = [1, 2, 3].map((n) => idsIn(files, `run-1-s000${n}`));
    expect(held.flat()).toEqual(rows.map((r) => r.Id));
    // Every update's rows sit in one snapshot, written before the update.
    const seen = new Map<string, number>();
    timeline.forEach((event, at) => {
      if (event.kind === 'snapshot') for (const id of event.ids) seen.set(id, at);
    });
    timeline.forEach((event, at) => {
      if (event.kind !== 'update') return;
      for (const id of event.ids) expect(seen.get(id)).toBeLessThan(at);
    });
    expect(new Set(updated()).size).toBe(2500);
    expect(org.row(idOf(1))?.Email).not.toBe('person1@example.com');
    expect(config.get('backup:run-1-s0001')).toMatchObject({ origin: 'slice', setId: 'run-1' });
    // One audit entry for the invocation, with the slices it covered.
    expect(new AuditTrailStore(config).list().entries).toEqual([
      expect.objectContaining({
        action: 'anonymize_execute',
        outcome: 'success',
        details: { setId: 'run-1', sliceSize: 1000, slices: '1,2,3' },
      }),
    ]);
    // Its progress names the slice and its phase.
    const steps = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Posted)
      .filter((m) => m.type === 'operation:progress')
      .map((m) => String(m.payload.currentStep ?? m.payload.step ?? ''));
    expect(steps).toContain('Backing up Contact slice 2 of about 3');
    expect(steps.some((step) => step.startsWith('Anonymized Contact slice 2 of about 3 ('))).toBe(
      true,
    );
    // Done: its key goes, and nothing is left to resume.
    expect(keys.held.size).toBe(0);
    expect(new BackupSetStore(config).openFor('org-1', MASK.templateId)).toBeUndefined();
  });

  it('refuses before the guard an object past the snapshot without slices, naming them in the words of who asks (T2)', async () => {
    const org = orgOf(contactsOf(2500));

    await send('dataops:anonymize', { ...MASK, slices: undefined });

    const error = last('dataops:error')?.payload;
    expect(error?.code).toBe('SNAPSHOT_NOT_TAKEN');
    expect(String(error?.message)).toContain('Give --slices to mask Contact in 3 slices');
    expect(org.journal.some((c) => c.soql?.startsWith('SELECT Id, '))).toBe(false);
    expect(updated()).toEqual([]);

    handler = newHandler(false);
    orgOf(contactsOf(2500));
    await send('dataops:anonymize', { ...MASK, slices: undefined, fromPage: true }, 'run-2');
    expect(String(last('dataops:error')?.payload.message)).toContain(
      'Tick "Mask in slices" in the confirmation: Contact is then masked in 3 slices',
    );
  });

  it('keeps every slice whatever the count of backups the retention keeps, and still prunes an eleventh ordinary backup (T3)', async () => {
    settings = { 'backup.maxRecordsPerObject': 100, 'backup.maxCount': 10 };
    orgOf(contactsOf(1500));

    await send('dataops:anonymize', MASK);

    const slices = config.getKeysByPrefix('backup:run-1-s');
    expect(slices).toHaveLength(15);
    // Eleven ordinary backups: the oldest goes, no slice does.
    for (let n = 1; n <= 11; n++) {
      orgOf(contactsOf(3));
      await send('backup:execute', { orgId: 'org-1', objects: ['Contact'] }, `bk-${n}`);
      await handler.swept();
    }
    expect(config.getKeysByPrefix('backup:run-1-s')).toHaveLength(15);
    const ordinary = config
      .getKeysByPrefix('backup:bk-')
      .filter((key) => !key.slice('backup:'.length).includes(':'));
    expect(ordinary).toHaveLength(10);
  });

  it('resumes in another window with the key its slices were masked with: one address, one digest, no row written twice (T4)', async () => {
    const rows = contactsOf(2500);
    rows[4].Email = 'same@example.com';
    rows[2404].Email = 'same@example.com';
    let inSlice2 = 0;
    const org = orgOf(rows, {
      afterUpdate: (ids) => {
        if (ids.some((id) => id > idOf(1000) && id <= idOf(2000)) && ++inSlice2 === 3) {
          registry.abort('run-1');
        }
      },
    });

    await send('dataops:anonymize', { ...MASK, templateId: 'tpl-ccpa-california' });

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ cancelled: true });
    expect(new BackupSetStore(config).get('run-1')?.state).toBe('open');
    const second = newHandler();
    const resumeFrom = await checkpointId(second, 'tpl-ccpa-california');
    await send(
      'dataops:anonymize',
      {
        orgId: 'org-1',
        templateId: 'tpl-ccpa-california',
        objects: ['Contact'],
        resumeFrom,
        slices: true,
      },
      'run-2',
      second,
    );

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    const a = org.row(idOf(5))?.Email;
    const z = org.row(idOf(2405))?.Email;
    expect(a).not.toBe('same@example.com');
    expect(a).toBe(z);
    const sent = updated();
    expect(sent).toHaveLength(2500);
    expect(new Set(sent).size).toBe(2500);
    expect(keys.held.size).toBe(0);
  });

  it('throws away the snapshot of a slice stopped while it was read, writes none of its rows, and takes it again on resume (T5)', async () => {
    settings = { 'backup.maxRecordsPerObject': 3000 };
    const org = orgOf(contactsOf(7000), {
      beforeQuery: (soql) => {
        if (soql.includes(`Id > '${idOf(3000)}'`) && soql.includes('LIMIT 3000')) {
          registry.abort('run-1');
        }
      },
    });

    await send('dataops:anonymize', MASK);

    expect(config.get('backup:run-1-s0002')).toBeUndefined();
    expect([...files.keys()].some((file) => file.includes('run-1-s0002'))).toBe(false);
    expect(updated().some((id) => id > idOf(3000))).toBe(false);
    expect(updated()).toHaveLength(3000);

    const resumeFrom = await checkpointId();
    org.journal.length = 0;
    await send('dataops:anonymize', { ...MASK, snapshot: undefined, resumeFrom }, 'run-2');

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    expect(updated()).toHaveLength(7000);
    expect(idsIn(files, 'run-1-s0002')).toHaveLength(3000);
  });

  it('stops between two slices on its bound of requests, leaves its set open, and a resume ends it (T6)', async () => {
    orgOf(contactsOf(2500));

    await send('dataops:anonymize', { ...MASK, maxRequests: 12 });

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      message: string;
      slices: { stoppedOnBudget?: boolean; state: string; objects: Array<{ slices: unknown[] }> };
    };
    expect(result.status).toBe('partial');
    expect(result.slices).toMatchObject({ stoppedOnBudget: true, state: 'open' });
    expect(result.slices.objects[0].slices).toHaveLength(1);
    expect(result.message).toContain('Stopped between slices');
    expect(result.message).toContain('past the 12 of --max-requests');
    expect(result.message).toContain('The same line with --resume masks the rest');
    expect(updated()).toHaveLength(1000);

    const resumeFrom = await checkpointId();
    await send(
      'dataops:anonymize',
      { ...MASK, snapshot: undefined, resumeFrom, maxRequests: 1000 },
      'run-2',
    );

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    expect(new Set(updated()).size).toBe(2500);
    expect(new BackupSetStore(config).get('run-1')?.state).toBe('done');
  });

  it('says a row created in a range already masked, leaves it, and a resume masks it with a snapshot of its own (T7)', async () => {
    let clock = Date.parse('2026-11-14T10:00:00.000Z');
    const late: SlicedRow = { ...contactsOf(1)[0], Id: idOf(3), Email: 'late@example.com' };
    let inserted = false;
    const org = orgOf(contactsOf(2500, 2), {
      now: () => (clock += 1000),
      beforeQuery: (soql) => {
        if (!inserted && soql.includes(`Id > '${idOf(2000)}'`) && soql.includes('LIMIT 1000')) {
          inserted = true;
          org.insert({ ...late, CreatedDate: undefined } as unknown as SlicedRow);
        }
      },
    });

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      message: string;
      slices: { lateRecords: number; state: string };
    };
    expect(result.status).toBe('partial');
    expect(result.slices).toMatchObject({ lateRecords: 1, state: 'open' });
    expect(result.message).toContain(
      '1 record(s) were created during the run in a range a slice had masked',
    );
    expect(org.row(idOf(3))?.Email).toBe('late@example.com');

    const resumeFrom = await checkpointId();
    await send('dataops:anonymize', { ...MASK, snapshot: undefined, resumeFrom }, 'run-2');

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    expect(org.row(idOf(3))?.Email).not.toBe('late@example.com');
    const set = new BackupSetStore(config).get('run-1');
    const lateSlice = set?.objects[0].slices.find((s) => s.late);
    expect(lateSlice).toMatchObject({ late: true, lateOf: 1, rows: 1, state: 'masked' });
    expect(idsIn(files, String(lateSlice?.snapshotId))).toEqual([idOf(3)]);
    expect(set?.state).toBe('done');
  });

  it('masks a slice from its snapshot, never from the org: a row created in its range as it is masked keeps its values (I1)', async () => {
    // Created just after the first slice was backed up: before the next
    // statement the org answers, whatever the run sends then.
    let snapshotted = false;
    let inserted = false;
    const org = orgOf(contactsOf(2500, 2), {
      now: () => Date.parse('2026-11-14T10:00:00.000Z') + org.journal.length * 1000,
      beforeQuery: (soql) => {
        if (snapshotted && !inserted) {
          inserted = true;
          org.insert({
            ...contactsOf(1)[0],
            Id: idOf(1999),
            Email: 'late@example.com',
            CreatedDate: undefined,
          } as unknown as SlicedRow);
        }
        if (soql.endsWith('FROM Contact ORDER BY Id LIMIT 1000')) snapshotted = true;
      },
    });

    await send('dataops:anonymize', MASK);

    expect(org.row(idOf(1999))?.Email).toBe('late@example.com');
    expect(updated()).not.toContain(idOf(1999));
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      status: 'partial',
      slices: { lateRecords: 1 },
    });
  });

  it('keeps the rows the org refused beside their slice, with no bound on them, and a resume tries them first', async () => {
    const org = orgOf(contactsOf(2500));
    for (const n of [7, 1500, 2400]) org.refuse.set(idOf(n), 'Blocked by a validation rule');

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      recordsFailed: number;
      slices: { state: string; objects: Array<{ slices: Array<{ refused: number }> }> };
    };
    expect(result.status).toBe('partial');
    expect(result.recordsFailed).toBe(3);
    expect(result.slices.state).toBe('open');
    expect(result.slices.objects[0].slices.map((s) => s.refused)).toEqual([1, 1, 1]);
    expect(files.get('/storage/backups/run-1-s0002___refused_Contact.ndjson')).toContain(
      idOf(1500),
    );

    org.refuse.clear();
    const resumeFrom = await checkpointId();
    timeline.length = 0;
    await send('dataops:anonymize', { ...MASK, snapshot: undefined, resumeFrom }, 'run-2');

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      status: 'success',
      slices: { state: 'done' },
    });
    expect(updated().sort()).toEqual([idOf(7), idOf(1500), idOf(2400)].sort());
    expect(org.row(idOf(1500))?.Email).not.toBe('person1500@example.com');
  });

  it('counts a row deleted since its slice was backed up as deleted, neither refused nor left (T8)', async () => {
    let deleted = false;
    const org = orgOf(contactsOf(2500), {
      afterUpdate: (ids) => {
        if (!deleted && ids.includes(idOf(1001))) {
          deleted = true;
          org.delete(idOf(1900));
        }
      },
    });

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      recordsNotMasked: number;
      slices: { objects: Array<{ slices: Array<{ deletedSince: number; refused: number }> }> };
    };
    expect(result.status).toBe('success');
    expect(result.recordsNotMasked).toBe(0);
    expect(result.slices.objects[0].slices[1]).toMatchObject({ deletedSince: 1, refused: 0 });
  });

  it('halves a slice the org will not read in time, and says the size it read with (T10)', async () => {
    orgOf(contactsOf(1500), { timeoutAbove: 600 });

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      slices: { objects: Array<{ slices: Array<{ rows: number; sizeUsed?: number }> }> };
    };
    expect(result.status).toBe('success');
    expect(result.slices.objects[0].slices.map((s) => [s.rows, s.sizeUsed])).toEqual([
      [500, 500],
      [500, 500],
      [500, 500],
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      '[INFO] dataops: the org would not read slice 1 of Contact in time; read again in 500 records.',
    );
  });

  it('stops after the third halving, names --where, and masks nothing of that slice (T10)', async () => {
    orgOf(contactsOf(1500), { timeoutAbove: 100 });

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      message: string;
    };
    expect(result.status).toBe('failure');
    expect(result.message).toContain('even halved 3 times');
    expect(result.message).toContain('narrow --where to an indexed field');
    expect(updated()).toEqual([]);
    // No slice was taken: nothing is left open, and a run with a lower size may go.
    expect(new BackupSetStore(config).openFor('org-1', MASK.templateId)).toBeUndefined();
  });

  // Measured with --expose-gc: 200,000 people drawn by four Fake rules hold
  // 84 MB of heap, 0.1 MB once forgotten; the ids a duplicate watch holds
  // for a slice of 1,000,000 rows, 111 MB. A slice of the most a snapshot
  // holds, masked with Fake rules on an object with a duplicate rule, peaks
  // near 530 MB, whatever the object's size.
  it('holds one slice of people at a time, and reads what the duplicate rules wrote slice by slice (T11)', async () => {
    const org = orgOf(contactsOf(2500));
    handler.setTargetAutomation({ read: async () => automation(true) });
    const held = new Map<string, number>();
    const anonymize = AnonymizationEngine.prototype.anonymize;
    vi.spyOn(AnonymizationEngine.prototype, 'anonymize').mockImplementation(function (
      this: AnonymizationEngine,
      records,
      rules,
    ) {
      held.set(String(records[0]?.Id), this.peopleHeld());
      return anonymize.call(this, records, rules);
    });

    await send('dataops:anonymize', MASK);

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    // Grown through a slice, forgotten as it ended.
    expect(held.get(idOf(1000))).toBe(999);
    expect(held.get(idOf(1001))).toBe(0);
    expect(held.get(idOf(2001))).toBe(0);
    expect(Math.max(...held.values())).toBeLessThan(1000);
    // One read of what the rules wrote per slice, each for its own records.
    const reads = org.journal.filter((c) => c.soql?.includes('FROM DuplicateRecordItem'));
    expect(reads).toHaveLength(3);
  });

  it('plans on the org own figure when it gives up counting, masks by Id all the same, and says what it could not count after', async () => {
    const org = orgOf(contactsOf(1500), { countTimesOut: true });

    await send(
      'dataops:anonymize:coverage',
      { orgId: 'org-1', templateId: MASK.templateId, objects: ['Contact'], slices: true },
      'cov',
    );
    expect(last('dataops:anonymize:coverage:response')?.payload.objects).toEqual([
      expect.objectContaining({
        count: null,
        slicePlan: { objectApiName: 'Contact', size: 1000, slices: 2, approximate: true },
      }),
    ]);

    await send('dataops:anonymize', MASK);

    const result = last('dataops:anonymize:response')?.payload as {
      status: string;
      message: string;
    };
    expect(result.status).toBe('success');
    expect(new Set(updated()).size).toBe(1500);
    expect(result.message).toContain(
      'Whether records were created during the run in a range a slice had masked could not be read for Contact',
    );
    expect(org.journal.some((c) => c.soql?.includes('/limits/recordCount'))).toBe(true);
    // Without slices, a count the org gives up on refuses the run, as it did.
    await send('dataops:anonymize', { ...MASK, slices: undefined }, 'run-2');
    expect(String(last('dataops:error')?.payload.message)).toContain('give --slices');
  });

  it('refuses a new run while its set is open, naming the resume and the abandon; abandoned, keeps its snapshots and forgets its key (T12)', async () => {
    orgOf(contactsOf(2500));
    await send('dataops:anonymize', { ...MASK, maxRequests: 12 });
    expect(keys.held.has('run-1')).toBe(true);

    for (const asked of [MASK, { ...MASK, slices: undefined, snapshot: undefined }]) {
      const before = updated().length;
      await send('dataops:anonymize', asked, `run-again-${String(asked.slices)}`);
      const error = last('dataops:error')?.payload;
      expect(error?.code).toBe('SLICE_RUN_OPEN');
      expect(String(error?.message)).toContain('set run-1, 1 of 1 slice(s) masked');
      expect(String(error?.message)).toContain('the same line with --resume');
      expect(String(error?.message)).toContain('--abandon');
      expect(updated()).toHaveLength(before);
    }

    await send(
      'dataops:anonymize',
      { orgId: 'org-1', templateId: MASK.templateId, objects: ['Contact'], abandon: true },
      'abandon',
    );

    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      abandoned: true,
      slices: { setId: 'run-1', state: 'abandoned' },
    });
    expect(new BackupSetStore(config).get('run-1')?.state).toBe('abandoned');
    expect(keys.held.has('run-1')).toBe(false);
    expect(config.get('backup:run-1-s0001')).toBeDefined();
    expect(config.getKeysByPrefix('anonymization:checkpoint:')).toEqual([]);
    // Nothing open now: a new run goes.
    await send('dataops:anonymize', MASK, 'run-3');
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
  });

  it('refuses a resume elsewhere when the key its slices were masked with is not kept there', async () => {
    orgOf(contactsOf(2500));
    await send('dataops:anonymize', { ...MASK, maxRequests: 12 });
    keys.held.clear();
    const second = newHandler();
    const resumeFrom = await checkpointId(second);

    await send('dataops:anonymize', { ...MASK, snapshot: undefined, resumeFrom }, 'run-2', second);

    expect(last('dataops:error')?.payload.code).toBe('SLICE_KEY_LOST');
    expect(updated()).toHaveLength(1000);
  });

  it('reads the snapshot a checkpoint holds with the very statements it was read with before slices were (T13)', async () => {
    const org = orgOf(contactsOf(3));

    await handler.backupForPipeline({
      operationId: 'ck-1',
      orgId: 'org-1',
      objects: ['Contact'],
      fields: new Map([['Contact', ['Id', 'SystemModstamp', 'Email']]]),
      origin: 'checkpoint',
      failWhenTruncated: true,
    });
    await handler.backupForPipeline({
      operationId: 'ck-2',
      orgId: 'org-1',
      objects: ['Contact'],
      fields: new Map([['Contact', ['Id', 'SystemModstamp', 'Email']]]),
      scanAll: ['Contact'],
      origin: 'checkpoint',
      failWhenTruncated: true,
    });

    expect(org.journal.map((c) => `${c.kind} ${c.soql ?? ''}`)).toEqual([
      'query SELECT Id, SystemModstamp, Email FROM Contact',
      'query SELECT Id FROM Organization',
      'query SELECT Id, SystemModstamp, Email FROM Contact WHERE (IsDeleted = false)',
      'query SELECT Id FROM Organization',
    ]);
  });

  it('refuses before the guard a disk short of what the slices take, naming another store (T15)', async () => {
    handler.setFreeBytes(async () => 1000);
    const org = orgOf(contactsOf(2500));

    await send('dataops:anonymize', MASK);

    const error = last('dataops:error')?.payload;
    expect(error?.code).toBe('SLICE_DISK_SHORT');
    expect(String(error?.message)).toContain('Nothing was masked');
    expect(String(error?.message)).toContain('give --store a folder on another disk');
    expect(org.journal.some((c) => c.soql?.includes('ORDER BY Id LIMIT'))).toBe(false);
    expect(new BackupSetStore(config).list()).toEqual([]);
  });

  it('holds the org backups and restores for the whole run, naming the run and how to go on', async () => {
    let asked: Promise<void> | undefined;
    orgOf(contactsOf(2500), {
      afterUpdate: (ids) => {
        if (!asked && ids.includes(idOf(1001))) {
          asked = send('backup:execute', { orgId: 'org-1', objects: ['Contact'] }, 'bk-during');
        }
      },
    });

    await send('dataops:anonymize', MASK);
    await asked;

    const refusal = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Posted)
      .find((m) => m.type === 'dataops:error');
    expect(String(refusal?.payload.message)).toContain(
      'A masking run in slices (set run-1) writes to org org-1 now',
    );
    expect(config.get('backup:bk-during')).toBeUndefined();
  });

  it('plans a run in slices in its coverage: the slices, the requests against the day, no Bulk batch, the disk and the open set', async () => {
    handler.setFreeBytes(async () => 10 ** 12);
    orgOf(contactsOf(2500), { limits: { Max: 15_000, Remaining: 14_990 } });

    await send(
      'dataops:anonymize:coverage',
      { orgId: 'org-1', templateId: MASK.templateId, objects: ['Contact'], slices: true },
      'cov',
    );

    const coverage = last('dataops:anonymize:coverage:response')?.payload as {
      objects: Array<{ slicePlan?: unknown }>;
      plan: {
        requests: number;
        bulkBatches: number;
        diskBytes: number;
        diskFree: number;
        apiBudget: { verdict: string };
      };
    };
    expect(coverage.objects[0].slicePlan).toEqual({
      objectApiName: 'Contact',
      size: 1000,
      slices: 3,
    });
    expect(coverage.plan.bulkBatches).toBe(0);
    expect(coverage.plan.requests).toBeGreaterThan(0);
    expect(coverage.plan.diskFree).toBe(10 ** 12);
    expect(coverage.plan.apiBudget).toEqual({ verdict: 'fits', remaining: 14_990, max: 15_000 });
  });

  it('keeps where a resume stops the set it carries on, and finds it by the checkpoint the coverage names', async () => {
    orgOf(contactsOf(2500));
    await send('dataops:anonymize', { ...MASK, maxRequests: 12 });

    const id = await checkpointId();
    expect(id).toBe('run-1');
    expect(last('dataops:anonymize:coverage:response')?.payload.sliceSet).toMatchObject({
      setId: 'run-1',
      done: 1,
      total: 1,
      state: 'open',
    });
    expect(
      new MaskingCheckpointStore(config).load(
        'org-1',
        MASK.templateId,
        String(new BackupSetStore(config).get('run-1')?.fingerprint),
      )?.setId,
    ).toBe('run-1');
  });
});
