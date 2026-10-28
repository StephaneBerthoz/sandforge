/**
 * A checkpoint taken by SandForge 1.69 or earlier holds its snapshot plain —
 * `.ndjson` files, an index of their line offsets (`SFCKIDX1`), the field
 * prints in `fingerprints.json` — and is kept 30 days after it, never
 * converted. Taken of the same org through the same history, it previews,
 * rewinds and undoes as a compressed one does, record for record.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  T0,
  baseRecords,
  changedSince,
  clock,
  previewed,
  removeTaken,
  resultOf,
  rewound,
  stateOf,
  taken,
  undone,
  RewindTestOrg,
  PICKED,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import { indexFileOf, type CheckpointFolder } from './OrgCheckpointStore.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

/** The field prints as SandForge 1.69 kept them: `fingerprints.json`, plain. */
function printsAsBefore(folder: CheckpointFolder): void {
  writeFileSync(folder.plainFingerprintsFile, gunzipSync(readFileSync(folder.fingerprintsFile)), {
    mode: 0o600,
  });
  rmSync(folder.fingerprintsFile);
}

/** The first bytes of each object's index: the form it is of. */
function indexHeads(t: Taken): string[] {
  return t.checkpoint.objects.map(({ objectApiName }) =>
    readFileSync(indexFileOf(t.folder, objectApiName)).toString('latin1', 0, 8),
  );
}

/** The checkpoint of the base records, a colleague's changes since, its preview, rewind and undo. */
async function wholeRun(plain: boolean) {
  const t = await taken(
    baseRecords,
    new RewindTestOrg(),
    PICKED,
    {},
    plain ? nodeBackupFiles : undefined,
  );
  if (plain) printsAsBefore(t.folder);
  // Named by object, each take's snapshot id aside.
  const files = readdirSync(join(t.folder.dir, 'backups'))
    .map((name) => name.slice(name.indexOf('__') + 2))
    .sort();
  const heads = indexHeads(t);
  const prints = readdirSync(t.folder.dir).filter((name) => name.startsWith('fingerprints'));
  changedSince(t.org);
  const diff = await previewed(t);
  const beforeRewind = stateOf(t.org);
  const result = resultOf(await rewound(t, diff.previewId));
  const afterRewind = stateOf(t.org);
  const undo = await undone(t, result.rewindId);
  return {
    t,
    files,
    heads,
    prints,
    diff,
    beforeRewind,
    result,
    afterRewind,
    undo,
    afterUndo: stateOf(t.org),
  };
}

describe('a checkpoint taken before the compression', () => {
  it('previews, rewinds and undoes from its plain files as a compressed checkpoint of the same org does', async () => {
    const compressed = await wholeRun(false);
    const plain = await wholeRun(true);

    // Each as its SandForge wrote it.
    expect(compressed.files.every((name) => name.endsWith('.ndjson.gz'))).toBe(true);
    expect(new Set(compressed.heads)).toEqual(new Set(['SFCKIDX2']));
    expect(compressed.prints).toEqual(['fingerprints.json.gz']);
    expect(plain.files).toEqual(compressed.files.map((name) => name.replace(/\.gz$/, '')));
    expect(new Set(plain.heads)).toEqual(new Set(['SFCKIDX1']));
    expect(plain.prints).toEqual(['fingerprints.json']);

    // The same preview, the same rewind, the same undo.
    expect(plain.diff.objects).toEqual(compressed.diff.objects);
    expect(plain.diff.unread).toEqual(compressed.diff.unread);
    // Values given back and records brought back: both read from the snapshot.
    expect(plain.diff.objects.some((object) => object.toGiveBack.records > 0)).toBe(true);
    expect(plain.diff.objects.some((object) => object.toBringBack.inBin > 0)).toBe(true);
    expect(plain.result.status).toBe('success');
    expect(plain.afterRewind.live).toEqual(plain.t.atCheckpoint.live);
    expect(plain.afterRewind).toEqual(compressed.afterRewind);
    for (const part of ['deleted', 'undeleted', 'restored', 'residual'] as const) {
      expect(plain.result[part]).toEqual(compressed.result[part]);
    }
    expect(plain.undo.status).toBe(compressed.undo.status);
    expect(plain.afterUndo.live).toEqual(plain.beforeRewind.live);
    expect(plain.afterUndo).toEqual(compressed.afterUndo);
  });
});
