import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SYNC_LINKS_DIR,
  SyncIdMap,
  nodeSyncIdMap,
  savedConfigIdMap,
  type SyncIdMapDeps,
} from './SyncIdMap.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORGS = { sourceOrgId: 'src-org', targetOrgId: 'tgt-org' };
const OTHER_TARGET = { sourceOrgId: 'src-org', targetOrgId: 'other-org' };

describe('SyncIdMap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-links-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a later run what earlier runs wrote between the same orgs, the last copy of each record', async () => {
    const map = nodeSyncIdMap(dir);
    await map.record('cfg-1', ORGS, 'Account', [
      [fakeId('001', 1), fakeId('001', 901)],
      [fakeId('001', 2), fakeId('001', 902)],
    ]);
    // A later run wrote the first again: its newer copy is the one named.
    await map.record('cfg-1', ORGS, 'Account', [[fakeId('001', 1), fakeId('001', 911)]]);
    await map.record('cfg-1', OTHER_TARGET, 'Account', [[fakeId('001', 3), fakeId('001', 903)]]);

    const read = await nodeSyncIdMap(dir).load('cfg-1', ORGS);

    expect([...read]).toEqual([
      [fakeId('001', 2).slice(0, 15), fakeId('001', 902)],
      [fakeId('001', 1).slice(0, 15), fakeId('001', 911)],
    ]);
    expect([...(await map.load('cfg-1', OTHER_TARGET))]).toEqual([
      [fakeId('001', 3).slice(0, 15), fakeId('001', 903)],
    ]);
    expect([...(await map.load('cfg-2', ORGS))]).toEqual([]);
  });

  it('forgets the records a removal took, between the orgs it took them from alone', async () => {
    const map = nodeSyncIdMap(dir);
    await map.record('cfg-1', ORGS, 'Account', [
      [fakeId('001', 1), fakeId('001', 901)],
      [fakeId('001', 2), fakeId('001', 902)],
    ]);
    await map.record('cfg-1', OTHER_TARGET, 'Account', [[fakeId('001', 1), fakeId('001', 901)]]);

    // Named by its fifteen characters, as an org may name it.
    const forgotten = await map.forget('cfg-1', ORGS, [fakeId('001', 901).slice(0, 15)]);

    expect(forgotten).toBe(1);
    expect([...(await map.load('cfg-1', ORGS)).keys()]).toEqual([fakeId('001', 2).slice(0, 15)]);
    expect((await map.load('cfg-1', OTHER_TARGET)).size).toBe(1);
    // Nothing kept of what it names: nothing written.
    const size = statSync(join(dir, SYNC_LINKS_DIR, 'cfg-1.ndjson')).size;
    expect(await map.forget('cfg-1', ORGS, [fakeId('001', 999)])).toBe(0);
    expect(statSync(join(dir, SYNC_LINKS_DIR, 'cfg-1.ndjson')).size).toBe(size);
  });

  it('reads past a line a closed window cut short, and keeps no pair that is not of ids', async () => {
    const map = nodeSyncIdMap(dir);
    await map.record('cfg-1', ORGS, 'Account', [
      [fakeId('001', 1), fakeId('001', 901)],
      ['not an id', fakeId('001', 902)],
    ]);
    const file = join(dir, SYNC_LINKS_DIR, 'cfg-1.ndjson');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"s":"src-org","t":"tgt-org","o":"Acc`);

    expect([...(await map.load('cfg-1', ORGS)).values()]).toEqual([fakeId('001', 901)]);
  });

  it('says a file it cannot read, rather than take it for empty', async () => {
    const map = new SyncIdMap({
      ...memoryDeps(),
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    });

    await expect(map.load('cfg-1', ORGS)).rejects.toThrow('EACCES');
  });

  it('writes a file past its size again whole, the oldest pairs past the most it keeps gone', async () => {
    const deps = memoryDeps({ maxPairs: 3, compactBytes: 400 });
    const map = new SyncIdMap(deps);
    for (let n = 1; n <= 6; n++) {
      await map.record('cfg-1', ORGS, 'Account', [[fakeId('001', n), fakeId('001', 900 + n)]]);
    }
    await map.forget('cfg-1', ORGS, [fakeId('001', 906)]);

    // Past 400 bytes at the fifth pair, the file kept the last three of them.
    expect([...(await map.load('cfg-1', ORGS)).values()]).toEqual([
      fakeId('001', 903),
      fakeId('001', 904),
      fakeId('001', 905),
    ]);
    expect(deps.files.get(join('/store', SYNC_LINKS_DIR, 'cfg-1.ndjson'))?.length).toBeLessThan(
      400,
    );
    expect(deps.rename).toHaveBeenCalled();
  });

  it('forgets everything of a configuration that is deleted', async () => {
    const map = nodeSyncIdMap(dir);
    await map.record('cfg-1', ORGS, 'Account', [[fakeId('001', 1), fakeId('001', 901)]]);

    await map.delete('cfg-1');

    expect((await map.load('cfg-1', ORGS)).size).toBe(0);
  });
});

describe('savedConfigIdMap', () => {
  it('reads and keeps the pairs of a saved configuration alone', async () => {
    const map = new SyncIdMap(memoryDeps());
    const saved = savedConfigIdMap(map, (configId) => configId === 'saved');

    await saved.record('saved', ORGS, 'Account', [[fakeId('001', 1), fakeId('001', 901)]]);
    await saved.record('adhoc', ORGS, 'Account', [[fakeId('001', 2), fakeId('001', 902)]]);

    expect((await saved.load('saved', ORGS))?.size).toBe(1);
    expect(await saved.load('adhoc', ORGS)).toBeNull();
    expect((await map.load('adhoc', ORGS)).size).toBe(0);
  });
});

/** The store's files in memory, under `/store`. */
function memoryDeps(
  bounds: Pick<SyncIdMapDeps, 'maxPairs' | 'compactBytes'> = {},
): SyncIdMapDeps & { files: Map<string, string>; rename: ReturnType<typeof vi.fn> } {
  const files = new Map<string, string>();
  const missing = (filePath: string) =>
    Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
  const rename = vi.fn(async (from: string, to: string) => {
    files.set(to, files.get(from) ?? '');
    files.delete(from);
  });
  return {
    storagePath: '/store',
    files,
    readFile: async (filePath) => {
      const text = files.get(filePath);
      if (text === undefined) throw missing(filePath);
      return text;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    rename,
    mkdir: async () => undefined,
    rm: async (filePath) => {
      files.delete(filePath);
    },
    listFiles: async (dirPath) =>
      [...files]
        .filter(([filePath]) => filePath.startsWith(`${dirPath}/`))
        .map(([filePath, text]) => ({
          name: filePath.slice(dirPath.length + 1),
          size: Buffer.byteLength(text),
        })),
    ...bounds,
  };
}
