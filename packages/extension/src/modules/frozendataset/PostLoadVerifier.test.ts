import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { writeCountingContract, type CountingContract } from './CountingContract.js';
import { buildFrozenManifest, parseManifest, serializeManifest } from './manifest.js';
import { PostLoadVerifier, type PostLoadVerifyOptions } from './PostLoadVerifier.js';
import type { FrozenDataset } from './types.js';

const repoRoot = findRepoRoot(process.cwd());
const guard = new SasPathGuard(repoRoot);
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-verifier-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeContract(sasDir: string, objects: CountingContract['objects']): string {
  return writeCountingContract(guard, sasDir, {
    version: 1,
    orgId: '00D-target',
    datasetVersion: '1.0.0',
    writtenAt: '2026-02-01T10:00:00.000Z',
    objects,
  });
}

const ACCOUNT_CONTRACT = {
  Account: { fromFiles: 2, exclusionReasons: {}, excluded: 0, added: 0, expected: 2 },
  Contact: {
    fromFiles: 3,
    exclusionReasons: { 'duplicate-skipped': 1 },
    excluded: 1,
    added: 0,
    expected: 2,
  },
};

/** Query mock routing on the SOQL text, with per-SOQL response sequences. */
function makeQuery(
  routes: Array<{ match: string; responses: Array<Array<Record<string, unknown>>> }>,
): (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>> {
  return vi.fn(async (_org: string, soql: string) => {
    for (const route of routes) {
      if (soql.includes(route.match)) {
        return route.responses.length > 1
          ? (route.responses.shift() as Array<Record<string, unknown>>)
          : route.responses[0];
      }
    }
    return [];
  });
}

function makeOptions(
  contractPath: string,
  query: (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>>,
  overrides?: Partial<PostLoadVerifyOptions>,
): {
  deps: { orgAccess: { query: typeof query }; sasGuard: SasPathGuard };
  options: PostLoadVerifyOptions;
} {
  return {
    deps: { orgAccess: { query }, sasGuard: guard },
    options: {
      orgId: '00D-target',
      contractPath,
      measurementIntervalMs: 0,
      sleep: vi.fn(async () => {}),
      now: () => new Date('2026-02-01T12:00:00.000Z'),
      ...overrides,
    },
  };
}

describe('PostLoadVerifier — counts vs contract', () => {
  it('passes when every object count matches the contract (files minus exclusions)', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const query = makeQuery([
      { match: 'FROM Account', responses: [[{ cnt: 2 }]] },
      { match: 'FROM Contact', responses: [[{ cnt: 2 }]] },
    ]);
    const { deps, options } = makeOptions(contractPath, query);

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('passed');
    expect(verdict.attempts).toBe(2); // two identical measurements then stop
    expect(verdict.checks.find((c) => c.name === 'counts')?.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === 'stability')?.passed).toBe(true);
    expect(options.sleep).toHaveBeenCalledTimes(1);
  });

  it('fails and lists the mismatch when a count diverges', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const query = makeQuery([
      { match: 'FROM Account', responses: [[{ cnt: 2 }]] },
      { match: 'FROM Contact', responses: [[{ cnt: 1 }]] }, // expected 2
    ]);
    const { deps, options } = makeOptions(contractPath, query);

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('failed');
    const counts = verdict.checks.find((c) => c.name === 'counts');
    expect(counts?.passed).toBe(false);
    expect(counts?.detail).toContain('Contact: expected 2, got 1');
  });
});

describe('PostLoadVerifier — link integrity', () => {
  it('detects orphans of the mandatory lookups of the graph', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 2 }]] },
      { match: 'FROM Contact WHERE AccountId = null', responses: [[{ Id: '003ORPHAN1' }]] },
    ]);
    const { deps, options } = makeOptions(contractPath, query, {
      mandatoryLookups: { Contact: ['AccountId'] },
    });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('failed');
    const orphans = verdict.checks.find((c) => c.name === 'orphans');
    expect(orphans?.passed).toBe(false);
    expect(orphans?.detail).toContain('Contact.AccountId');
    expect(orphans?.detail).toContain('003ORPHAN1');
  });

  it('passes orphans when no mandatory lookup is null', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const query = makeQuery([{ match: 'COUNT(Id)', responses: [[{ cnt: 2 }]] }]);
    const { deps, options } = makeOptions(contractPath, query, {
      mandatoryLookups: { Contact: ['AccountId'] },
    });

    const verdict = await new PostLoadVerifier(deps).verify(options);
    expect(verdict.checks.find((c) => c.name === 'orphans')?.passed).toBe(true);
  });

  it('verifies PersonContact pointers restored via sidecar + mapping', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [],
      recordTypes: {},
      personContactSidecar: [
        { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
      ],
    };
    const mapping = new Map([
      ['Account-000001', '001REAL-ACC'],
      ['Contact-000001', '003REAL-CON'],
    ]);
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 2 }]] },
      {
        match: 'PersonContactId FROM Account',
        responses: [[{ Id: '001REAL-ACC', PersonContactId: '003REAL-CON' }]],
      },
    ]);
    const { deps, options } = makeOptions(contractPath, query, { dataset, mapping });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('passed');
    expect(verdict.checks.find((c) => c.name === 'personcontact')?.detail).toContain(
      '1 PersonContact',
    );
  });

  it('fails when a PersonContact pointer is not restored', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [],
      recordTypes: {},
      personContactSidecar: [
        { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
      ],
    };
    const mapping = new Map([
      ['Account-000001', '001REAL-ACC'],
      ['Contact-000001', '003REAL-CON'],
    ]);
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 2 }]] },
      {
        match: 'PersonContactId FROM Account',
        responses: [[{ Id: '001REAL-ACC', PersonContactId: null }]],
      },
    ]);
    const { deps, options } = makeOptions(contractPath, query, { dataset, mapping });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('failed');
    const check = verdict.checks.find((c) => c.name === 'personcontact');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('Account-000001');
  });
});

describe('PostLoadVerifier — presence by key', () => {
  it('lists ExternalId keys of the shared referential missing from the org', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, ACCOUNT_CONTRACT);
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [
            { referenceId: 'Account-000001', fields: { ExternalId__c: 'ACC-1' } },
            { referenceId: 'Account-000002', fields: { ExternalId__c: 'ACC-2' } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 2 }]] },
      { match: 'ExternalId__c k FROM Account', responses: [[{ k: 'ACC-1' }]] }, // ACC-2 missing
    ]);
    const { deps, options } = makeOptions(contractPath, query, {
      dataset,
      presenceKeys: { Account: 'ExternalId__c' },
    });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('failed');
    const presence = verdict.checks.find((c) => c.name === 'presence');
    expect(presence?.passed).toBe(false);
    expect(presence?.detail).toContain('ACC-2');
  });
});

describe('PostLoadVerifier — robustness (transient inconsistent reads)', () => {
  it('returns the explicit unstable verdict when no two measurements match', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, {
      Account: { fromFiles: 1, exclusionReasons: {}, excluded: 0, added: 0, expected: 1 },
    });
    // Each measurement reads a DIFFERENT count: 1, then 2, then 3.
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 1 }], [{ cnt: 2 }], [{ cnt: 3 }]] },
    ]);
    const sleep = vi.fn(async () => {});
    const { deps, options } = makeOptions(contractPath, query, { sleep });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('unstable');
    expect(verdict.attempts).toBe(3); // max attempts reached
    expect(sleep).toHaveBeenCalledTimes(2);
    const stability = verdict.checks.find((c) => c.name === 'stability');
    expect(stability?.passed).toBe(false);
    expect(stability?.detail).toContain('transiently inconsistent');
  });

  it('accepts the third measurement when it repeats the second', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, {
      Account: { fromFiles: 1, exclusionReasons: {}, excluded: 0, added: 0, expected: 1 },
    });
    // 1 (transient), then 1… wait: 1st reads stale 0, 2nd and 3rd read 1.
    const query = makeQuery([{ match: 'COUNT(Id)', responses: [[{ cnt: 0 }], [{ cnt: 1 }]] }]);
    const { deps, options } = makeOptions(contractPath, query);

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('passed');
    expect(verdict.attempts).toBe(3);
  });
});

describe('PostLoadVerifier — manifest consignation', () => {
  function writeManifest(sasDir: string): string {
    const manifest = buildFrozenManifest({
      version: '1.0.0',
      source: { orgId: '00D-source', decisionDate: '2026-01-15T00:00:00.000Z' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: {
        budgetMax: 2500,
        measured: { Account: 2 },
        measuredAt: '2026-01-15T00:00:00.000Z',
      },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'tester',
        checkedAt: '2026-01-15T00:00:00.000Z',
      },
      author: 'tester',
    });
    expect(manifest.controls.dryRunLoad).toBeNull(); // engine extension point starts null
    const manifestPath = path.join(sasDir, 'manifest.json');
    fs.writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');
    return manifestPath;
  }

  it('consigns a passed verdict into controls.dryRunLoad with author and date', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, {
      Account: { fromFiles: 1, exclusionReasons: {}, excluded: 0, added: 0, expected: 1 },
    });
    const manifestPath = writeManifest(sasDir);
    const query = makeQuery([{ match: 'COUNT(Id)', responses: [[{ cnt: 1 }]] }]);
    const { deps, options } = makeOptions(contractPath, query, {
      manifestPath,
      author: 'load-bot',
    });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('passed');
    const consigned = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    expect(consigned.controls.dryRunLoad).toEqual({
      status: 'passed',
      at: '2026-02-01T12:00:00.000Z',
      detail: expect.stringContaining('post-load check by load-bot: verdict=passed'),
    });
  });

  it('consigns an unstable verdict as failed with the explicit unstable marker', async () => {
    const sasDir = makeTmpDir();
    const contractPath = writeContract(sasDir, {
      Account: { fromFiles: 1, exclusionReasons: {}, excluded: 0, added: 0, expected: 1 },
    });
    const manifestPath = writeManifest(sasDir);
    const query = makeQuery([
      { match: 'COUNT(Id)', responses: [[{ cnt: 1 }], [{ cnt: 2 }], [{ cnt: 3 }]] },
    ]);
    const { deps, options } = makeOptions(contractPath, query, {
      manifestPath,
      author: 'load-bot',
    });

    const verdict = await new PostLoadVerifier(deps).verify(options);

    expect(verdict.status).toBe('unstable');
    const consigned = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    // DryRunLoadControl.status is engine-owned ('pending'|'passed'|'failed'):
    // 'unstable' is explicit in the detail.
    expect(consigned.controls.dryRunLoad?.status).toBe('failed');
    expect(consigned.controls.dryRunLoad?.detail).toContain('verdict=unstable');
  });
});
