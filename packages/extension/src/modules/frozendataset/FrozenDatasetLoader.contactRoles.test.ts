import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { FrozenDatasetLoader, type FrozenDatasetLoaderDeps } from './FrozenDatasetLoader.js';
import type { FrozenDataset } from './types.js';
import type { FrozenDmlWriter, TargetFieldDescribe, TargetObjectDescribe } from './loadTypes.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

const ROLE = 'OpportunityContactRole';

/** The key prefix of each object's ids, as an org gives them. */
const PREFIX: Readonly<Record<string, string>> = {
  Account: '001',
  Contact: '003',
  Opportunity: '006',
  [ROLE]: '00K',
};

/**
 * A target in memory that writes what a real org writes as it takes an
 * opportunity with its `ContactId`: a contact role of that contact, primary,
 * with no role, written by the platform the second the opportunity goes in.
 * Learnt in a real org: the clone of an opportunity with its contact and its
 * one primary role left the target two of them until the run linked to the
 * platform's. An update of a field no update can set is refused as the org
 * refuses it.
 */
function contactRoleOrg() {
  const held = new Map<string, Array<Record<string, unknown>>>();
  let counter = 0;
  const idFor = (objectApiName: string): string =>
    `${PREFIX[objectApiName] ?? '0XX'}xx${String(++counter).padStart(10, '0')}AAA`;
  const rowsOf = (objectApiName: string): Array<Record<string, unknown>> => {
    const rows = held.get(objectApiName) ?? [];
    held.set(objectApiName, rows);
    return rows;
  };
  const writer: FrozenDmlWriter = {
    insert: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) =>
        records.map((record) => {
          const id = idFor(objectApiName);
          rowsOf(objectApiName).push({ ...record, Id: id });
          const contact = record.ContactId;
          if (objectApiName === 'Opportunity' && typeof contact === 'string' && contact !== '') {
            rowsOf(ROLE).push({
              Id: idFor(ROLE),
              OpportunityId: id,
              ContactId: contact,
              IsPrimary: true,
              Role: null,
            });
          }
          return { id, success: true, errors: [] };
        }),
    ),
    update: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) =>
        records.map((record) => {
          const row = rowsOf(objectApiName).find((r) => r.Id === record.Id);
          if (!row) {
            return { id: String(record.Id), success: false, errors: ['ENTITY_IS_DELETED'] };
          }
          if (objectApiName === ROLE && 'OpportunityId' in record) {
            return {
              id: String(record.Id),
              success: false,
              errors: [
                'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: OpportunityId. ' +
                  'Please check the security settings of this field and verify that it is ' +
                  'read/write for your profile or permission set.',
              ],
            };
          }
          Object.assign(row, record);
          return { id: String(record.Id), success: true, errors: [] };
        }),
    ),
    delete: vi.fn(async (_org: string, objectApiName: string, ids: string[]) =>
      ids.map((id) => {
        const rows = rowsOf(objectApiName);
        const at = rows.findIndex((r) => r.Id === id);
        if (at >= 0) rows.splice(at, 1);
        return { id, success: true, errors: [] };
      }),
    ),
  };
  /** The org's answer to a query of the roles of some opportunities, its columns as asked. */
  const query = vi.fn(async (_org: string, soql: string) => {
    const roles = new RegExp(`^SELECT (.+) FROM ${ROLE} WHERE OpportunityId IN \\((.*)\\)$`).exec(
      soql,
    );
    if (!roles) return [];
    const columns = roles[1].split(',').map((c) => c.trim());
    const ids = roles[2].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    return rowsOf(ROLE)
      .filter((row) => ids.includes(String(row.OpportunityId)))
      .map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
  });
  return { writer, query, rolesOf: () => [...rowsOf(ROLE)] };
}

function field(overrides: Partial<TargetFieldDescribe>): TargetFieldDescribe {
  return {
    name: 'Field__c',
    type: 'string',
    createable: true,
    nillable: true,
    defaultedOnCreate: false,
    ...overrides,
  };
}

/** The objects as a real org describes them: what an insert and an update can set. */
const DESCRIBES: Record<string, TargetObjectDescribe> = {
  Account: { name: 'Account', fields: [field({ name: 'Name', nillable: false })] },
  Contact: {
    name: 'Contact',
    fields: [
      field({ name: 'LastName', nillable: false }),
      field({ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }),
    ],
  },
  Opportunity: {
    name: 'Opportunity',
    fields: [
      field({ name: 'Name', nillable: false }),
      field({ name: 'StageName', type: 'picklist', nillable: false }),
      field({ name: 'CloseDate', type: 'date', nillable: false }),
      field({ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }),
      // Its primary contact's: an insert sets it, no update does.
      field({
        name: 'ContactId',
        type: 'reference',
        referenceTo: ['Contact'],
        updateable: false,
      }),
    ],
  },
  [ROLE]: {
    name: ROLE,
    fields: [
      field({
        name: 'OpportunityId',
        type: 'reference',
        referenceTo: ['Opportunity'],
        nillable: false,
        updateable: false,
      }),
      field({ name: 'ContactId', type: 'reference', referenceTo: ['Contact'], nillable: false }),
      field({ name: 'Role', type: 'picklist' }),
      field({ name: 'IsPrimary', type: 'boolean', nillable: false, defaultedOnCreate: true }),
    ],
  },
};

/** An account, its contact, its opportunity with that contact, and the contact's primary role on it. */
function dossier(): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [
      { objectApiName: 'Account', records: [{ referenceId: 'A1', fields: { Name: 'Acme' } }] },
      {
        objectApiName: 'Contact',
        records: [{ referenceId: 'C1', fields: { LastName: 'Doe', AccountId: 'A1' } }],
      },
      {
        objectApiName: 'Opportunity',
        records: [
          {
            referenceId: 'O1',
            fields: {
              Name: 'Deal',
              StageName: 'Prospecting',
              CloseDate: '2026-12-01',
              AccountId: 'A1',
              ContactId: 'C1',
            },
          },
        ],
      },
      {
        objectApiName: ROLE,
        records: [
          {
            referenceId: 'R1',
            fields: {
              OpportunityId: 'O1',
              ContactId: 'C1',
              IsPrimary: true,
              Role: 'Decision Maker',
            },
          },
        ],
      },
    ],
    recordTypes: {},
    personContactSidecar: [],
  };
}

function depsOf(org: ReturnType<typeof contactRoleOrg>): FrozenDatasetLoaderDeps & {
  sasDir: string;
  mappingStore: SasReferenceIdMappingStore;
} {
  const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-contact-roles-'));
  tmpDirs.push(sasDir);
  return {
    orgAccess: {
      query: org.query,
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = DESCRIBES[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer: org.writer,
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => null) },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    sasGuard: new SasPathGuard(repoRoot),
    sasDir,
  };
}

describe('a Frozen load of an opportunity with its contact and the contact’s role', () => {
  async function load(dataset: FrozenDataset, org = contactRoleOrg()) {
    const deps = depsOf(org);
    const progress: string[] = [];
    const report = await new FrozenDatasetLoader(deps).load({
      orgId: '00D-target',
      orgTier: 'development',
      dataset,
      sasDir: deps.sasDir,
      onProgress: (event) => {
        if (event.objectName === ROLE && event.status !== 'started') progress.push(event.message);
      },
    });
    const [recorded] = await deps.mappingStore.recordedLoads();
    return { org, report, progress, recorded };
  }

  it('leaves the target the one role the source held, the platform’s given its role', async () => {
    // Inserted beside the platform's, the source's role left the opportunity
    // two primary roles of one contact.
    const { org, report, progress, recorded } = await load(dossier());

    const roles = org.rolesOf();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ IsPrimary: true, Role: 'Decision Maker' });
    expect(report.perObject.find((o) => o.objectApiName === ROLE)).toMatchObject({
      inserted: 0,
      reused: 1,
      writtenByThePlatform: 1,
      failed: [],
    });
    // Given by an update the field the platform left empty, and nothing an update cannot set.
    expect(vi.mocked(org.writer.update).mock.calls).toEqual([
      ['00D-target', ROLE, [{ Id: roles[0].Id, Role: 'Decision Maker' }]],
    ]);
    expect(vi.mocked(org.writer.insert).mock.calls.map(([, object]) => object)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
    ]);
    expect(progress).toEqual([
      `${ROLE}: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ` +
        '1 written by the platform with their opportunity, for its contact',
    ]);
    // It goes with its opportunity, which the platform deletes it with: no
    // removal takes it on its own.
    expect(recorded?.withTheirRecord).toEqual({ R1: 'O1' });
  });

  it('inserts as read the role of another contact, which the platform wrote none of', async () => {
    const dataset = dossier();
    dataset.objects[1].records.push({
      referenceId: 'C2',
      fields: { LastName: 'Roe', AccountId: 'A1' },
    });
    dataset.objects[3].records.push({
      referenceId: 'R2',
      fields: { OpportunityId: 'O1', ContactId: 'C2', IsPrimary: false, Role: 'Influencer' },
    });

    const { org, report } = await load(dataset);

    expect(org.rolesOf().map((r) => r.Role)).toEqual(['Decision Maker', 'Influencer']);
    expect(report.perObject.find((o) => o.objectApiName === ROLE)).toMatchObject({
      inserted: 1,
      reused: 1,
      writtenByThePlatform: 1,
    });
  });

  it('inserts as read the role of an opportunity that went in without its contact', async () => {
    const dataset = dossier();
    delete dataset.objects[2].records[0].fields.ContactId;

    const { org, report } = await load(dataset);

    expect(org.rolesOf()).toEqual([
      expect.objectContaining({ IsPrimary: true, Role: 'Decision Maker' }),
    ]);
    const roles = report.perObject.find((o) => o.objectApiName === ROLE);
    expect(roles).toMatchObject({ inserted: 1, reused: 0 });
    expect(roles).not.toHaveProperty('writtenByThePlatform');
  });

  it('keeps the platform’s role linked when the target refuses its role, and says so', async () => {
    const org = contactRoleOrg();
    const update = org.writer.update;
    org.writer.update = vi.fn(
      async (orgId: string, objectApiName: string, records: Array<Record<string, unknown>>) =>
        objectApiName === ROLE
          ? records.map((record) => ({
              id: String(record.Id),
              success: false,
              errors: [
                'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Role: bad value for restricted picklist ' +
                  'field: Decision Maker',
              ],
            }))
          : update(orgId, objectApiName, records),
    );

    const { report, progress } = await load(dossier(), org);

    expect(org.rolesOf()).toEqual([expect.objectContaining({ IsPrimary: true, Role: null })]);
    expect(report.perObject.find((o) => o.objectApiName === ROLE)).toMatchObject({
      inserted: 0,
      reused: 1,
      writtenByThePlatform: 1,
    });
    expect(progress[0]).toContain(
      "1 written by the platform with their opportunity, for its contact, 1 of them left as it wrote it, without the fields of the source's role: " +
        'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Role: bad value for restricted picklist field: Decision Maker',
    );
  });
});
