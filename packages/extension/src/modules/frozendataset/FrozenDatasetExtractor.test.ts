import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import type { ScopableField } from '../forge/ScopedSoqlBuilder.js';
import {
  DEFAULT_RECORD_TYPES_SOQL,
  FrozenDatasetExtractor,
  FrozenExtractionError,
  RT_MAP_FILE_NAME,
  type FrozenExtractionOptions,
} from './FrozenDatasetExtractor.js';
import { InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';
import { to18 } from './salesforceId.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-extract-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeNode(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 0,
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
    batchStrategy: 'auto',
  };
}

const ACCOUNT_A = to18('001A000000aaaaA');
const ACCOUNT_B = to18('001A000000bbbbB');
const CONTACT_1 = to18('003A000000ccccC');
const CONTACT_2 = to18('003A000000ddddD');
const OWNER_OUT_OF_SCOPE = to18('005A000000eeeeE');
const RT_INDIVIDUAL = to18('012A000000ffffF');

const graph: ForgeGraph = {
  nodes: [makeNode('Account', 0), makeNode('Contact', 1), makeNode('Orphan__c', 2)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const fieldsByObject: Record<string, ScopableField[]> = {
  Account: [
    { name: 'Id', type: 'id', referenceTo: [] },
    { name: 'Name', type: 'string', referenceTo: [] },
    { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] },
    { name: 'OwnerId', type: 'reference', referenceTo: ['User'] },
    { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
  ],
  Contact: [
    { name: 'Id', type: 'id', referenceTo: [] },
    { name: 'LastName', type: 'string', referenceTo: [] },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
    { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
  ],
  Orphan__c: [{ name: 'Id', type: 'id', referenceTo: [] }],
};

const AS_OF = '2026-08-01T00:00:00Z';

function buildDeps(captured: string[]) {
  return {
    describeFields: async (objectApiName: string) => fieldsByObject[objectApiName] ?? [],
    query: async (soql: string) => {
      captured.push(soql);
      if (soql.includes('FROM Account')) {
        return [
          { Id: ACCOUNT_B, Name: 'Beta', RecordTypeId: RT_INDIVIDUAL, OwnerId: OWNER_OUT_OF_SCOPE },
          {
            Id: ACCOUNT_A,
            Name: 'Alpha',
            RecordTypeId: RT_INDIVIDUAL,
            OwnerId: OWNER_OUT_OF_SCOPE,
          },
        ];
      }
      if (soql.includes('FROM Contact')) {
        return [
          { Id: CONTACT_1, LastName: 'Dupont', AccountId: ACCOUNT_A },
          { Id: CONTACT_2, LastName: 'Martin', AccountId: ACCOUNT_B },
        ];
      }
      if (soql.includes('FROM RecordType')) {
        return [
          {
            Id: RT_INDIVIDUAL,
            SobjectType: 'Account',
            DeveloperName: 'Individual',
            Name: 'Particulier',
          },
        ];
      }
      return [];
    },
  };
}

function makeOptions(sasDir: string, captured: string[]): FrozenExtractionOptions {
  void captured;
  return {
    graph,
    rootObject: 'Account',
    rootRecordIds: [ACCOUNT_A, ACCOUNT_B],
    asOf: AS_OF,
    sasDir,
    guard: new SasPathGuard(path.join(sasDir, 'fake-repo')),
  };
}

describe('FrozenDatasetExtractor', () => {
  it('scopes every query to the sas-injected root IDs — no hard-coded IDs in code', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const accountSoql = captured.find((q) => q.includes('FROM Account'));
    expect(accountSoql).toBeDefined();
    // Root scope comes from the injected ID list (self-cached branch).
    expect(accountSoql).toContain(`'${ACCOUNT_A}'`);
    expect(accountSoql).toContain(`'${ACCOUNT_B}'`);
    expect(accountSoql).toContain('Id IN (');
  });

  it('freezes a CreatedDate bound on every node query (pitfall 8)', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const dataQueries = captured.filter((q) => !q.includes('FROM RecordType'));
    expect(dataQueries.length).toBeGreaterThanOrEqual(2);
    for (const soql of dataQueries) {
      expect(soql).toContain(`CreatedDate <= ${AS_OF}`);
    }
  });

  it('scopes children via parent FK (Contact via AccountId)', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const contactSoql = captured.find((q) => q.includes('FROM Contact'));
    expect(contactSoql).toContain('AccountId IN (');
    // Unreachable node: never queried (unscoped).
    expect(captured.some((q) => q.includes('FROM Orphan__c'))).toBe(false);
  });

  it('assigns stable referenceIds in source-ID-sorted order (pitfall 7)', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const first = await extractor.extract(makeOptions(dir, []));
    const second = await extractor.extract(makeOptions(dir, []));

    const accountIds = (ds: typeof first) =>
      ds.objects.find((o) => o.objectApiName === 'Account')?.records.map((r) => r.referenceId);
    expect(accountIds(first)).toEqual(accountIds(second));
    // ACCOUNT_A sorts before ACCOUNT_B → gets -000001.
    const accountA = first.objects
      .find((o) => o.objectApiName === 'Account')
      ?.records.find((r) => r.sourceId === ACCOUNT_A);
    expect(accountA?.referenceId).toBe('Account-000001');
    expect(accountA?.fields.Name).toBe('Alpha');
  });

  it('writes rt-map.json into the sas (Id → SobjectType/DeveloperName/Name)', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const result = await extractor.extract(makeOptions(dir, []));

    const rtMapPath = path.join(dir, RT_MAP_FILE_NAME);
    expect(fs.existsSync(rtMapPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(rtMapPath, 'utf8'));
    expect(written).toEqual([
      {
        id: RT_INDIVIDUAL,
        sobjectType: 'Account',
        developerName: 'Individual',
        name: 'Particulier',
      },
    ]);
    expect(result.recordTypeMap).toEqual(written);
    expect(result.asOf).toBe(AS_OF);
  });

  it('renders {{TOKEN}} placeholders of the RecordType template from sas tokens', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    const options = makeOptions(dir, captured);
    options.recordTypesSoqlTemplate =
      'SELECT Id, SobjectType, DeveloperName, Name FROM RecordType WHERE CreatedDate <= {{AS_OF}}';
    options.tokens = { AS_OF };
    await extractor.extract(options);

    const rtSoql = captured.find((q) => q.includes('FROM RecordType'));
    expect(rtSoql).toContain(`CreatedDate <= ${AS_OF}`);
    expect(rtSoql).not.toContain('{{');
  });

  it('uses the default RecordType template otherwise', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));
    expect(captured.find((q) => q.includes('FROM RecordType'))).toBe(DEFAULT_RECORD_TYPES_SOQL);
  });

  it('refuses a sas directory inside the repository', async () => {
    const repoGuard = new SasPathGuard();
    const insideRepo = path.join(repoGuard.repoRoot, 'frozen-sas');
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    await expect(
      extractor.extract({ ...makeOptions('', []), sasDir: insideRepo, guard: repoGuard }),
    ).rejects.toThrow(InsideRepoPathError);
    expect(fs.existsSync(insideRepo)).toBe(false);
  });

  it('rejects a malformed asOf bound and an empty root selection', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const options = makeOptions(dir, []);
    await expect(extractor.extract({ ...options, asOf: '2026-08-01' })).rejects.toThrow(
      FrozenExtractionError,
    );
    await expect(extractor.extract({ ...options, rootRecordIds: [] })).rejects.toThrow(
      /empty selection/,
    );
  });
});
