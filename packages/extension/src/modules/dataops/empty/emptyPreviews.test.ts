import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmptyKeptPreview } from './emptyAct.js';
import { EmptyPreviewStore, KEPT_AT_MOST, isEmptyPreviewId } from './emptyPreviews.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-previews-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60_000;

/** A preview as `previewEmptyAct` keeps one, of `previewId`. */
function kept(previewId: string): EmptyKeptPreview {
  return {
    previewId,
    readAt: '2026-11-13T09:00:00.000Z',
    orgName: 'dev',
    tier: 'development',
    organizationId: '00D000000000001AAA',
    request: { mode: 'objects', objects: ['Contact'] },
    access: { kind: 'org' },
    hardDelete: { permitted: false },
    peopleActive: { people: 0 },
    preview: {
      mode: 'objects',
      deleteMode: 'recycle',
      passes: [{ objectApiName: 'Contact', records: { records: 3 }, sent: { records: 3 } }],
      along: [],
      leftOut: [],
      refusals: [],
      blockers: [],
      beforeParent: [],
      unordered: [],
      undoLost: [],
      undo: true,
      affected: ['Contact'],
      total: { records: 3, objects: 1, uncounted: [] },
      statements: 2,
    },
  } as unknown as EmptyKeptPreview;
}

const ID = 'ep-20261113-090000-a1b2';

describe('EmptyPreviewStore', () => {
  it('keeps a preview on disk, its owner alone reading it, and reads it back for its org', async () => {
    const store = new EmptyPreviewStore(root);
    await store.keep('org-1', kept(ID));

    expect(readdirSync(root)).toEqual([`${ID}.json`]);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, `${ID}.json`)).mode & 0o777).toBe(0o600);
    }
    const read = await new EmptyPreviewStore(root).read(ID);
    expect(read?.orgId).toBe('org-1');
    expect(read?.kept.preview.total.records).toBe(3);
  });

  it('reads none of an id it never kept, nor of one shaped as no preview, which never names a file', async () => {
    const store = new EmptyPreviewStore(root);
    await store.keep('org-1', kept(ID));
    expect(await store.read('ep-20261113-090000-zzzz')).toBeUndefined();
    expect(await store.read('../outside')).toBeUndefined();
    expect(isEmptyPreviewId('ep-20261113-090000-a1b2/../x')).toBe(false);
    await expect(store.keep('org-1', kept('not-a-preview'))).rejects.toThrow("Not a preview's id");
  });

  it('reads none past its day, as a rewind keeps its previews a day', async () => {
    const store = new EmptyPreviewStore(root);
    const now = Date.parse('2026-11-13T10:00:00.000Z');
    await store.keep('org-1', kept(ID), now);
    const file = join(root, `${ID}.json`);
    const written = new Date(now - DAY_MS - 1_000);
    utimesSync(file, written, written);
    expect(await store.read(ID, now)).toBeUndefined();
  });

  it('lets a preview go once a run acted on it', async () => {
    const store = new EmptyPreviewStore(root);
    await store.keep('org-1', kept(ID));
    await store.remove(ID);
    expect(await store.read(ID)).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it('takes no file it did not write whole for a preview', async () => {
    const store = new EmptyPreviewStore(root);
    await store.keep('org-1', kept(ID));
    writeFileSync(join(root, `${ID}.json`), JSON.stringify({ v: 1, orgId: 'org-1', kept: {} }));
    expect(await store.read(ID)).toBeUndefined();
    writeFileSync(join(root, `${ID}.json`), '{"v":1,');
    expect(await store.read(ID)).toBeUndefined();
  });

  it('lets the previews past their day go as the next is kept, and the oldest past its bound', async () => {
    const store = new EmptyPreviewStore(root);
    const now = Date.now();
    await store.keep('org-1', kept('ep-20261112-090000-old1'), now);
    const old = new Date(now - DAY_MS - 1_000);
    utimesSync(join(root, 'ep-20261112-090000-old1.json'), old, old);
    for (let n = 0; n < KEPT_AT_MOST + 2; n++) {
      const second = String(n).padStart(2, '0');
      await store.keep('org-1', kept(`ep-20261113-0900${second}-a1b2`), now);
    }

    const left = readdirSync(root).sort();
    expect(left).toHaveLength(KEPT_AT_MOST);
    expect(left).not.toContain('ep-20261112-090000-old1.json');
    expect(left[0]).toBe('ep-20261113-090002-a1b2.json');
  });
});
