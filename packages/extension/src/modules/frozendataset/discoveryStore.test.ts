import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DISCOVERY_FILE_NAME,
  DISCOVERY_MAX_AGE_MS,
  readDiscoveryFromSas,
  schemaStampOf,
  whyNotReused,
  writeDiscoveryToSas,
  type KeptDiscovery,
} from './discoveryStore.js';
import { InsideRepoPathError, SasPathGuard, findRepoRoot } from './SasPathGuard.js';

const guard = new SasPathGuard(findRepoRoot(process.cwd()));
const dirs: string[] = [];

function sas(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-discovery-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DISCOVERED_AT = '2026-10-17T08:00:00.000Z';

/** A discovery of cases at a cap of 30, kept by a selection. */
function kept(overrides: Partial<KeptDiscovery> = {}): KeptDiscovery {
  return {
    fileVersion: 1,
    sourceOrgId: 'org-1',
    rootObject: 'Case',
    maxNodes: 30,
    step: 'select',
    discoveredAt: DISCOVERED_AT,
    schemaStamp: '2026-10-17T07:59:59.000Z',
    graph: {
      nodes: [
        {
          objectApiName: 'Case',
          recordCount: 4,
          fieldCount: 2,
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
          batchStrategy: 'auto',
        },
      ],
      edges: [],
      totalRecords: 4,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    },
    describes: {
      Case: {
        name: 'Case',
        fields: [
          {
            name: 'AccountId',
            type: 'reference',
            referenceTo: ['Account'],
            relationshipName: 'Account',
            isMasterDetail: false,
          },
        ],
        childRelationships: [
          {
            childSObject: 'CaseComment',
            field: 'ParentId',
            relationshipName: 'CaseComments',
            isCascadeDelete: true,
          },
        ],
      },
    },
    objects: [
      { name: 'Case', keyPrefix: '500' },
      { name: 'CaseHistory2', keyPrefix: null },
    ],
    ...overrides,
  };
}

const WANTED = { sourceOrgId: 'org-1', rootObject: 'Case', maxNodes: 30 };

describe('the discovery kept in the sas', () => {
  it('is read back as it was written', async () => {
    const dir = sas();

    const written = await writeDiscoveryToSas(dir, kept(), guard);

    expect(written).toBe(path.join(dir, DISCOVERY_FILE_NAME));
    expect(await readDiscoveryFromSas(dir, guard)).toEqual({ kept: kept() });
  });

  it('says there is none when the sas holds none', async () => {
    expect(await readDiscoveryFromSas(sas(), guard)).toEqual({ none: 'no graph kept in the sas' });
  });

  it.each([
    ['text that is no JSON', '{ not json'],
    ['another envelope', JSON.stringify({ fileVersion: 2, graph: {} })],
    ['a graph without its nodes', JSON.stringify({ ...kept(), graph: { edges: [] } })],
    ['a date that is none', JSON.stringify({ ...kept(), discoveredAt: 'yesterday' })],
  ])('takes %s for no graph kept', async (_, content) => {
    const dir = sas();
    fs.writeFileSync(path.join(dir, DISCOVERY_FILE_NAME), content);

    expect(await readDiscoveryFromSas(dir, guard)).toEqual({
      none: 'the graph kept in the sas could not be read',
    });
  });

  it('is refused inside the repository, as every file of the sas', async () => {
    const inside = path.join(findRepoRoot(process.cwd()) ?? process.cwd(), 'sas-inside');
    await expect(writeDiscoveryToSas(inside, kept(), guard)).rejects.toThrow(InsideRepoPathError);
  });
});

describe('whyNotReused', () => {
  const now = new Date(Date.parse(DISCOVERED_AT) + 60 * 60_000);

  it('reuses a graph of the same org, root object and cap, stamped, less than a day old', () => {
    expect(whyNotReused(kept(), WANTED, now)).toBeUndefined();
  });

  it.each([
    ['another org', kept({ sourceOrgId: 'org-2' }), WANTED, 'the graph kept is of another org'],
    [
      'another root object',
      kept({ rootObject: 'Account' }),
      WANTED,
      'the graph kept is of Account, not Case',
    ],
    [
      'another cap',
      kept(),
      { ...WANTED, maxNodes: 50 },
      'the graph kept was discovered at a cap of 30, not 50',
    ],
    [
      'no stamp of the org',
      kept({ schemaStamp: undefined }),
      WANTED,
      'the org did not give its clock when the graph kept was discovered',
    ],
  ])('discovers again a graph of %s', (_, discovery, wanted, reason) => {
    expect(whyNotReused(discovery, wanted, now)).toBe(reason);
  });

  it('discovers again a graph more than a day old, and one dated after now', () => {
    const later = new Date(Date.parse(DISCOVERED_AT) + DISCOVERY_MAX_AGE_MS + 1);
    expect(whyNotReused(kept(), WANTED, later)).toBe(
      `the graph kept was discovered on ${DISCOVERED_AT}, more than a day ago`,
    );
    expect(whyNotReused(kept(), WANTED, new Date(Date.parse(DISCOVERED_AT) - 1))).toBeDefined();
  });
});

describe('schemaStampOf', () => {
  it("stamps a discovery a second before the second the org's clock read", () => {
    // A change in the second the discovery began may have come after it.
    expect(schemaStampOf('2026-10-17T08:00:05.750Z')).toBe('2026-10-17T08:00:04.000Z');
    expect(schemaStampOf('2026-10-17T08:00:05.000+0000')).toBe('2026-10-17T08:00:04.000Z');
  });

  it('gives none for a clock it cannot read', () => {
    expect(schemaStampOf('not a time')).toBeUndefined();
  });
});
