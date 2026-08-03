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

  it('refuses a sas directory inside the repository', async () => {
    const store = new SasReferenceIdMappingStore(path.join(repoRoot, 'exports'), {
      guard: new SasPathGuard(repoRoot),
    });
    await expect(store.persist(new Map())).rejects.toThrow(InsideRepoPathError);
    await expect(store.load()).rejects.toThrow(InsideRepoPathError);
  });
});
