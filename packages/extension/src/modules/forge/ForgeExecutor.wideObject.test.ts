import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import {
  accountFieldName,
  countingConnection,
  describeOf,
  fakeId,
  largeOrg,
} from '../../test/largeOrg.js';
import { MAX_STATEMENT_URI_CHARS, uriLength } from '../../core/common/wideRead.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An Account of nine hundred custom fields, which an Unlimited Edition org
 * can have, cloned with its contacts. Each field costs its name and the
 * `%2C%20` between two names in the query URI, and the org refuses a URI past
 * 16 000 characters: named in one statement, the fields made the root read
 * be refused (414, or 431 on a scratch org) before a row was read, and the reads by id threw
 * an error telling the user to exclude fields the read named all the same.
 */

const WIDE = 900;

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 0,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'rest',
  };
}

const graph: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** A source org of wide accounts, an empty target, and what the run sent to each. */
function orgs() {
  const org = largeOrg({ wideAccount: WIDE });
  const { conn, calls } = countingConnection(org);
  const inserted: Record<string, Array<Record<string, unknown>>> = {};
  const fieldsOf = (objectApiName: string): FieldInfo[] =>
    describeOf(org, objectApiName).fields.map((f) => ({
      name: f.name,
      type: f.type,
      queryable: true,
      createable: f.createable,
      updateable: f.updateable,
      isReference: f.type === 'reference',
      referenceTo: f.referenceTo,
      nillable: f.nillable,
    }));
  const deps: ForgeExecutorDeps = {
    describeFields: async (_orgId, objectApiName) => fieldsOf(objectApiName),
    queryRecords: async (orgId, soql) => (orgId === 'src' ? (await conn.query(soql)).records : []),
    insertRecords: async (_orgId, objectApiName, rows) => {
      (inserted[objectApiName] ??= []).push(...rows);
      return rows.map((_, i) => ({
        id: `${objectApiName === 'Account' ? '001' : '003'}T${String(i).padStart(11, '0')}AAA`,
        success: true,
        errors: [],
      }));
    },
  };
  return { org, calls, deps, inserted };
}

describe('a clone of an object too wide for one query', () => {
  it('reads the root and the rows under it in column groups, and writes every field of the root', async () => {
    const { org, calls, deps, inserted } = orgs();
    const root = fakeId(org, 'Account', 1);

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => {}, {
      rootRecordId: root,
      rootObjectApiName: 'Account',
    });

    expect(summary.errors).toEqual([]);
    for (const soql of calls.queries) {
      expect(uriLength(soql)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
    expect(inserted.Account).toHaveLength(1);
    expect(inserted.Account?.[0]?.[accountFieldName(1)]).toBe('A1-1');
    expect(inserted.Account?.[0]?.[accountFieldName(WIDE)]).toBe(`A1-${WIDE}`);
    // The contacts of the account: two of the forty, by AccountId.
    expect(inserted.Contact).toHaveLength(2);
  });

  it('reads by id the accounts the contacts name, every field of each', async () => {
    const { org, calls, deps, inserted } = orgs();
    const contactGraph: ForgeGraph = {
      ...graph,
      nodes: [node('Contact', 0), node('Account', 1)],
      edges: [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
      ],
    };

    const summary = await new ForgeExecutor(deps).execute(contactGraph, 'src', 'tgt', () => {}, {
      rootRecordId: fakeId(org, 'Contact', 3),
      rootObjectApiName: 'Contact',
    });

    expect(summary.errors).toEqual([]);
    for (const soql of calls.queries) {
      expect(uriLength(soql)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
    expect(inserted.Account).toHaveLength(1);
    expect(inserted.Account?.[0]?.[accountFieldName(WIDE)]).toBe(`A3-${WIDE}`);
  });
});
