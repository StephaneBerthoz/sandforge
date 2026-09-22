import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileConfigStore } from './fileConfigStore.js';

describe('fileConfigStore', () => {
  it('keeps what it was given across two openings of the same file', () => {
    // A handler writes through it and reads it back on the next run — a
    // snapshot to restore, a selection to extract — so a map in memory
    // would lose everything between one run of a script and the next.
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-cli-test-'));
    const path = join(dir, 'snapshots.json');
    try {
      const first = fileConfigStore(path);
      first.set('backup:op-1', { operationId: 'op-1', totalRecords: 3 }, 'backups');

      const second = fileConfigStore(path);
      expect(second.get('backup:op-1')).toEqual({ operationId: 'op-1', totalRecords: 3 });
      expect(second.getKeysByPrefix('backup:')).toEqual(['backup:op-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty on a file that is not there yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-cli-test-'));
    try {
      const store = fileConfigStore(join(dir, 'nothing-here.json'));
      expect(store.getKeysByPrefix('backup:')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
