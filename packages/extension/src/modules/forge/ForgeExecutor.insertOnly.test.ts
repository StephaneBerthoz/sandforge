import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  UpdateResult,
} from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The lookups the second pass fills in: by an update, as the user the run
 * writes as. A lookup only an insert sets — createable, not updateable — is
 * written with its row or never; one the user the run reads as may not set,
 * and the one it writes as may, is the second pass's to fill in.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TICKET = id('a01', 1);
const NOTE = id('a02', 1);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});
const lookup = (name: string, target: string, overrides: Partial<FieldInfo> = {}): FieldInfo =>
  field(name, { isReference: true, referenceTo: [target], nillable: true, ...overrides });

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const edge = (
  parent: string,
  child: string,
  more: Partial<ForgeGraphEdge> = {},
): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName: `${parent}To${child}`,
  type: 'lookup',
  ...more,
});

/**
 * A ticket and its first note pointing at each other, met note first. The
 * note's ticket is set by an insert alone; the ticket's first note, by an
 * update as well — unless `bothInsertOnly`.
 */
function graphOf(edgeFlags: Partial<ForgeGraphEdge> = {}): ForgeGraph {
  return {
    nodes: [node('Note__c'), node('Ticket__c')],
    edges: [edge('Ticket__c', 'Note__c', edgeFlags), edge('Note__c', 'Ticket__c')],
    totalRecords: 2,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/**
 * A source holding a ticket and its note, described by `sourceFields` — and
 * the target by `targetFields`, when it describes them otherwise — and a
 * target that creates what it is sent, and refuses an update of a field its
 * describe says no update sets, as the platform does.
 */
function orgs(
  sourceFields: Record<string, FieldInfo[]>,
  targetFields: Record<string, FieldInfo[]> = sourceFields,
) {
  const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const updated: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  let next = 0;
  const deps = {
    describeFields: vi.fn(
      async (org: string, object: string) =>
        (org === 'src' ? sourceFields : targetFields)[object] ?? [],
    ),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      if (/FROM Ticket__c\b/.test(soql)) {
        return [{ Id: TICKET, Name: 'T-1', First_Note__c: NOTE, Reviewer__c: NOTE }];
      }
      if (/FROM Note__c\b/.test(soql)) return [{ Id: NOTE, Name: 'N-1', Ticket__c: TICKET }];
      return [];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      inserted.push({ object, rows: rows.map((row) => ({ ...row })) });
      return rows.map(() => ({
        id: id(object === 'Ticket__c' ? 'a01' : 'a02', 900 + ++next),
        success: true,
        errors: [],
      }));
    }),
    updateRecords: vi.fn(
      async (
        _org: string,
        object: string,
        rows: Record<string, unknown>[],
      ): Promise<UpdateResult[]> => {
        updated.push({ object, rows: rows.map((row) => ({ ...row })) });
        const fixed = (targetFields[object] ?? []).filter((f) => f.updateable === false);
        return rows.map((row) => {
          const refused = fixed.filter((f) => f.name in row).map((f) => f.name);
          return refused.length > 0
            ? {
                id: String(row['Id']),
                success: false,
                errors: [
                  `INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: ${refused.join(', ')}`,
                ],
              }
            : { id: String(row['Id']), success: true, errors: [] };
        });
      },
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, updated };
}

/** The note's ticket set by an insert alone; the ticket's first note by an update as well. */
const FIELDS: Record<string, FieldInfo[]> = {
  Ticket__c: [field('Id'), field('Name'), lookup('First_Note__c', 'Note__c', { updateable: true })],
  Note__c: [field('Id'), field('Name'), lookup('Ticket__c', 'Ticket__c', { updateable: false })],
};

const ROOTED_AT_THE_TICKET: ExecuteOptions = {
  rootRecordId: TICKET,
  rootObjectApiName: 'Ticket__c',
};

describe('ForgeExecutor, a lookup only an insert sets', () => {
  it('writes its record first though discovery met the other one first, and fills the other lookup in by the second pass', async () => {
    // Note first, the note went in without its ticket, and the second pass
    // could not set it: the platform refuses the update.
    const { deps, inserted, updated } = orgs(FIELDS);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_TICKET,
    );

    expect(inserted.map(({ object }) => object)).toEqual(['Ticket__c', 'Note__c']);
    expect(inserted[1].rows).toEqual([{ Name: 'N-1', Ticket__c: summary.remapTable[TICKET] }]);
    expect(updated).toEqual([
      {
        object: 'Ticket__c',
        rows: [{ Id: summary.remapTable[TICKET], First_Note__c: summary.remapTable[NOTE] }],
      },
    ]);
    expect(summary.errors).toEqual([]);
  });

  it('writes its record first in a run of whole tables, as discovery marked the edge', async () => {
    const { deps, inserted } = orgs(FIELDS);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf({ insertOnly: true }),
      'src',
      'tgt',
      () => undefined,
    );

    expect(inserted.map(({ object }) => object)).toEqual(['Ticket__c', 'Note__c']);
    expect(inserted[1].rows[0]['Ticket__c']).toBe(summary.remapTable[TICKET]);
  });

  it('sends no update for one left empty in a cycle of them, and says it stays empty', async () => {
    // Both set by an insert alone: whichever goes first keeps its lookup at
    // the other empty. Sent, the update was refused, as the platform does.
    const bothInsertOnly: Record<string, FieldInfo[]> = {
      ...FIELDS,
      Ticket__c: [
        field('Id'),
        field('Name'),
        lookup('First_Note__c', 'Note__c', { updateable: false }),
      ],
    };
    const { deps, updated } = orgs(bothInsertOnly);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_TICKET,
    );

    expect(updated).toEqual([]);
    expect(summary.errors).toEqual([
      expect.objectContaining({
        objectApiName: '__pass2__',
        failedCount: 1,
        samples: [
          expect.objectContaining({
            messages: [
              expect.stringMatching(
                /^Lookup '(First_Note__c|Ticket__c)' left empty: only an insert sets it/,
              ),
            ],
          }),
        ],
      }),
    ]);
  });
});

describe('ForgeExecutor, a lookup the source user may not set and the target user may', () => {
  it("is filled in by the second pass, as the target's describe allows", async () => {
    // Read from the source's describe, no write could set it, and it was
    // never written. The second pass writes as the target's user.
    const reviewer = lookup('Reviewer__c', 'Note__c', { createable: false, updateable: false });
    const source: Record<string, FieldInfo[]> = {
      ...FIELDS,
      Ticket__c: [...FIELDS.Ticket__c, reviewer],
    };
    const target: Record<string, FieldInfo[]> = {
      ...FIELDS,
      Ticket__c: [...FIELDS.Ticket__c, { ...reviewer, createable: true, updateable: true }],
    };
    const { deps, updated } = orgs(source, target);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_TICKET,
    );

    expect(updated).toEqual([
      {
        object: 'Ticket__c',
        rows: [
          {
            Id: summary.remapTable[TICKET],
            First_Note__c: summary.remapTable[NOTE],
            Reviewer__c: summary.remapTable[NOTE],
          },
        ],
      },
    ]);
    expect(summary.errors).toEqual([]);
  });
});
