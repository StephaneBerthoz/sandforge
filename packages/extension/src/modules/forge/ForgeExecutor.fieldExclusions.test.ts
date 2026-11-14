import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps, InsertResult } from './ForgeExecutor.js';
import { forgeRunResult } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A field left out as the user typed it. The run compared the name to the
 * source's at its exact case: `--exclude contact.email` left out nothing, and
 * every contact went to the target with the email address the user believed
 * kept back. A name that is no field at all was said nowhere.
 */

const field = (name: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...extra,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Contact: [field('Id'), field('LastName'), field('Email'), field('Description')],
};

const CONTACT_ID = '003000000000201AAA';

function rows(): Record<string, FakeRow[]> {
  return {
    Contact: [
      {
        Id: CONTACT_ID,
        LastName: 'Doe',
        Email: 'doe@example.invalid',
        Description: 'kept back',
      },
    ],
  };
}

function graph(): ForgeGraph {
  const node: ForgeGraphNode = {
    objectApiName: 'Contact',
    recordCount: 1,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
  return {
    nodes: [node],
    edges: [],
    totalRecords: 1,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

function orgs() {
  const inserted: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => {
      const fields = FIELDS[object];
      if (!fields) {
        throw Object.assign(new Error(`The requested resource does not exist`), {
          errorCode: 'NOT_FOUND',
          name: 'NOT_FOUND',
        });
      }
      return fields;
    }),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      asked.push(soql);
      return selectRows(rows(), soql);
    }),
    insertRecords: vi.fn(async (_org: string, _object: string, sent: Record<string, unknown>[]) => {
      inserted.push(...sent);
      return sent.map((_row, i): InsertResult => ({
        id: `003TGT00000000${i}AAA`,
        success: true,
        errors: [],
      }));
    }),
    updateRecords: vi.fn(async () => []),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, asked };
}

const ROOTED = { rootRecordId: CONTACT_ID, rootObjectApiName: 'Contact' };

describe('ForgeExecutor, the fields the user left out', () => {
  it('leaves out a field named in another case than the source gives it, neither read nor written', async () => {
    const { deps, inserted, asked } = orgs();

    const summary = await new ForgeExecutor(deps).execute(graph(), 'src', 'tgt', () => undefined, {
      ...ROOTED,
      fieldExclusions: { contact: ['email'] },
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toHaveProperty('Email');
    expect(inserted[0]).toMatchObject({ LastName: 'Doe', Description: 'kept back' });
    expect(asked.filter((soql) => /\bFROM Contact\b/.test(soql)).join('\n')).not.toMatch(
      /\bEmail\b/,
    );
    expect(summary.fieldExclusionsUnmatched).toBeUndefined();
  });

  it('says a field left out that the source has no field of, with the nearest it has, in the run’s result', async () => {
    const { deps, inserted } = orgs();

    const summary = await new ForgeExecutor(deps).execute(graph(), 'src', 'tgt', () => undefined, {
      ...ROOTED,
      fieldExclusions: { Contact: ['Descripton'], Acount: ['Name'] },
    });

    const expected = [
      { objectApiName: 'Contact', field: 'Descripton', missing: 'field', nearest: 'Description' },
      { objectApiName: 'Acount', field: 'Name', missing: 'object' },
    ];
    expect(summary.fieldExclusionsUnmatched).toEqual(expected);
    // The run itself goes on: the field it holds is written as the source has it.
    expect(inserted[0]).toMatchObject({ Description: 'kept back' });
    expect(
      forgeRunResult(summary, graph(), { startedAt: 0, status: 'success' })
        .fieldExclusionsUnmatched,
    ).toEqual(expected);
  });
});
