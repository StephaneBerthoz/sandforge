import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InsideRepoPathError, SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import {
  REFERENCEID_MAPPING_FILENAME,
  SasReferenceIdMappingStore,
} from './SasReferenceIdMappingStore.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-mapping-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('SasReferenceIdMappingStore', () => {
  it('returns an empty mapping when the file does not exist yet', async () => {
    const store = new SasReferenceIdMappingStore(makeTmpDir(), {
      guard: new SasPathGuard(repoRoot),
    });
    await expect(store.load()).resolves.toEqual(new Map());
  });

  it('persists and reloads the referenceId→Id mapping (roundtrip)', async () => {
    const dir = makeTmpDir();
    const store = new SasReferenceIdMappingStore(dir, {
      guard: new SasPathGuard(repoRoot),
      orgId: '00D-target',
      now: () => new Date('2026-02-01T10:00:00.000Z'),
    });
    const mapping = new Map([
      ['Contact-000001', '003REAL0000000001'],
      ['Account-000001', '001REAL0000000001'],
    ]);

    await store.persist(mapping);

    expect(store.filePath).toBe(path.join(dir, REFERENCEID_MAPPING_FILENAME));
    const payload = JSON.parse(fs.readFileSync(store.filePath, 'utf8')) as {
      version: number;
      orgId: string;
      updatedAt: string;
      mapping: Record<string, string>;
    };
    expect(payload.version).toBe(1);
    expect(payload.orgId).toBe('00D-target');
    expect(payload.updatedAt).toBe('2026-02-01T10:00:00.000Z');
    // Sorted keys for stable diffs of the sas artifact.
    expect(Object.keys(payload.mapping)).toEqual(['Account-000001', 'Contact-000001']);

    const reloaded = await new SasReferenceIdMappingStore(dir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(reloaded).toEqual(mapping);
  });

  it('replaces the file on persist (purged entries disappear)', async () => {
    const dir = makeTmpDir();
    const guard = new SasPathGuard(repoRoot);
    const store = new SasReferenceIdMappingStore(dir, { guard });
    await store.persist(new Map([['Account-000001', '001OLD']]));
    await store.persist(new Map([['Contact-000001', '003NEW']]));
    await expect(store.load()).resolves.toEqual(new Map([['Contact-000001', '003NEW']]));
  });

  it('refuses to read an unreadable mapping as empty', async () => {
    const dir = makeTmpDir();
    // A directory where the mapping file should be: it exists, yet cannot be
    // read as a file, which is not the same as a first load.
    fs.mkdirSync(path.join(dir, REFERENCEID_MAPPING_FILENAME));
    const store = new SasReferenceIdMappingStore(dir, { guard: new SasPathGuard(repoRoot) });
    await expect(store.load()).rejects.toThrow();
  });

  describe('after a sandbox refresh', () => {
    // Org ids in the shape `Organization.Id` answers with: the target as it
    // was when the load wrote its records, and as it is after a refresh.
    const LOADED_INTO = '00DXX00000AbCdE2A1';
    const REFRESHED_TO = '00Dxx00000FgHiJ3B2';

    async function writtenTo(dir: string, organizationId: string | undefined): Promise<void> {
      await new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-target',
        organizationId,
      }).persist(new Map([['Account-000001', '001XX00000AbCdEAAA']]));
    }

    function readBy(dir: string, organizationId: string | undefined): SasReferenceIdMappingStore {
      return new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-target',
        organizationId,
      });
    }

    it('records the org the records were written to', async () => {
      const dir = makeTmpDir();
      await writtenTo(dir, LOADED_INTO);

      const payload = JSON.parse(
        fs.readFileSync(path.join(dir, REFERENCEID_MAPPING_FILENAME), 'utf8'),
      ) as { organizationId?: string };
      expect(payload.organizationId).toBe(LOADED_INTO);
    });

    it('answers with no mapping once the target is another org', async () => {
      const dir = makeTmpDir();
      await writtenTo(dir, LOADED_INTO);

      const store = readBy(dir, REFRESHED_TO);

      await expect(store.load()).resolves.toEqual(new Map());
      await expect(store.isStale()).resolves.toBe(true);
    });

    it('keeps the mapping of the org the target still is, whatever the id length', async () => {
      const dir = makeTmpDir();
      await writtenTo(dir, LOADED_INTO);

      const store = readBy(dir, LOADED_INTO.slice(0, 15));

      await expect(store.load()).resolves.toEqual(
        new Map([['Account-000001', '001XX00000AbCdEAAA']]),
      );
      await expect(store.isStale()).resolves.toBe(false);
    });

    it('never calls stale a mapping that recorded no org', async () => {
      // Written before the org was recorded: nothing says which org it was.
      const dir = makeTmpDir();
      await writtenTo(dir, undefined);

      const store = readBy(dir, REFRESHED_TO);

      await expect(store.isStale()).resolves.toBe(false);
      await expect(store.load()).resolves.toHaveProperty('size', 1);
    });

    it('never calls stale a mapping read without knowing the org the target is', async () => {
      const dir = makeTmpDir();
      await writtenTo(dir, LOADED_INTO);

      await expect(readBy(dir, undefined).isStale()).resolves.toBe(false);
    });

    it('has nothing stale before the first load', async () => {
      await expect(readBy(makeTmpDir(), REFRESHED_TO).isStale()).resolves.toBe(false);
    });

    it('asks the target which org it is on first use, and once', async () => {
      const dir = makeTmpDir();
      await writtenTo(dir, LOADED_INTO);
      let asked = 0;
      const store = new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-target',
        organizationId: async () => {
          asked += 1;
          return REFRESHED_TO;
        },
      });
      expect(asked).toBe(0);

      await expect(store.isStale()).resolves.toBe(true);
      await expect(store.load()).resolves.toEqual(new Map());
      await store.persist(new Map());

      expect(asked).toBe(1);
      const payload = JSON.parse(
        fs.readFileSync(path.join(dir, REFERENCEID_MAPPING_FILENAME), 'utf8'),
      ) as { organizationId?: string };
      expect(payload.organizationId).toBe(REFRESHED_TO);
    });
  });

  it('refuses a sas directory inside the repository', async () => {
    const store = new SasReferenceIdMappingStore(path.join(repoRoot, 'exports'), {
      guard: new SasPathGuard(repoRoot),
    });
    await expect(store.persist(new Map())).rejects.toThrow(InsideRepoPathError);
    await expect(store.load()).rejects.toThrow(InsideRepoPathError);
  });
});
