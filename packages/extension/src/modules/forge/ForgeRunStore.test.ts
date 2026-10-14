import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgeRunStore, memoryRunFile, nodeRunFile } from './ForgeRunStore.js';

/** The `n`-th source id of an object whose ids begin with `prefix`. */
const src = (prefix: string, n: number): string => `${prefix}S${String(n).padStart(14, '0')}`;
/** The `n`-th target id of an object whose ids begin with `prefix`. */
const tgt = (prefix: string, n: number): string => `${prefix}T${String(n).padStart(14, '0')}`;

const at = new Date('2026-10-14T08:00:00.000Z');

/** A store on a fresh journal, its part begun. */
function freshStore(): { store: ForgeRunStore; file: ReturnType<typeof memoryRunFile> } {
  const file = memoryRunFile('{"run":{"journalId":"j","targetOrgId":"t","startedAt":"x"}}\n');
  const store = ForgeRunStore.open(file);
  store.beginPart(at);
  return { store, file };
}

describe('ForgeRunStore', () => {
  describe('what the run wrote', () => {
    it('reads back what each source id maps onto, its kind and its object', () => {
      const { store } = freshStore();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      store.setMapping('existing', src('001', 2), tgt('001', 2), 'Account');
      store.setMapping('updated', src('003', 1), tgt('003', 1), 'Contact');
      store.setMapping('existing', src('01s', 1), tgt('01s', 1));

      expect(store.mapping(src('001', 1))).toEqual({
        kind: 'created',
        sourceId: src('001', 1),
        targetId: tgt('001', 1),
        objectApiName: 'Account',
        earlier: false,
      });
      expect(store.mapping(src('01s', 1))).toEqual({
        kind: 'existing',
        sourceId: src('01s', 1),
        targetId: tgt('01s', 1),
        earlier: false,
      });
      expect(store.targetOf(src('003', 1))).toBe(tgt('003', 1));
      expect(store.targetOf(src('001', 9))).toBeUndefined();
      expect(store.mappedSize).toBe(4);
      expect(store.countsByObject()).toEqual([
        { objectApiName: 'Account', created: 1, linked: 1 },
        { objectApiName: 'Contact', created: 0, linked: 0, updated: 1 },
      ]);
    });

    it('takes the last registration of an id as its word, and counts it once', () => {
      const { store } = freshStore();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      store.setMapping('existing', src('001', 1), tgt('001', 7), 'Account');

      expect(store.mapping(src('001', 1))?.kind).toBe('existing');
      expect(store.targetOf(src('001', 1))).toBe(tgt('001', 7));
      expect(store.mappedSize).toBe(1);
      expect(store.countsByObject()).toEqual([{ objectApiName: 'Account', created: 0, linked: 1 }]);
      expect([...store.mappings()].map(({ sourceId, kind }) => [sourceId, kind])).toEqual([
        [src('001', 1), 'existing'],
      ]);
    });

    it('finds each of thousands of ids, its line read back once the cache has let it go', () => {
      const { store } = freshStore();
      for (let n = 0; n < 50_000; n++) {
        store.setMapping('created', src('001', n), tgt('001', n), 'Account');
      }
      expect(store.mappedSize).toBe(50_000);
      for (const n of [0, 1, 777, 25_000, 49_999]) {
        expect(store.targetOf(src('001', n))).toBe(tgt('001', n));
      }
      expect(store.targetOf(src('001', 50_000))).toBeUndefined();
      expect(store.targetOf(src('003', 5))).toBeUndefined();
    });

    it('gives every mapping back in the order of its last registration', () => {
      const { store } = freshStore();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      store.setMapping('created', src('003', 1), tgt('003', 1), 'Contact');
      store.setMapping('created', src('001', 2), tgt('001', 2), 'Account');
      expect([...store.mappings()].map(({ sourceId }) => sourceId)).toEqual([
        src('001', 1),
        src('003', 1),
        src('001', 2),
      ]);
    });
  });

  describe('a journal opened again, as a run that resumes it opens it', () => {
    /** The journal of a part that wrote two accounts, read a page, and owed. */
    function firstPart(): string {
      const { store, file } = freshStore();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      store.setMapping('created', src('001', 2), tgt('001', 2), 'Account');
      store.checkpoint('Account', { lastId: src('001', 2), read: 2 });
      // A page written and not yet checkpointed when the part stopped.
      store.setMapping('created', src('001', 3), tgt('001', 3), 'Account');
      store.owe({
        objectApiName: 'Account',
        newId: tgt('001', 1),
        sourceId: src('001', 1),
        fieldName: 'ParentId',
        sourceRefId: src('001', 5),
      });
      store.oweStatus('Contract', tgt('800', 1), 'Activated');
      store.noteRead(src('001', 4));
      store.close();
      return file.text();
    }

    it('says what an earlier part wrote: found, linked to, none of this part own', () => {
      const store = ForgeRunStore.open(memoryRunFile(firstPart()));
      expect(store.resumes).toBe(true);
      store.beginPart(at);

      expect(store.mapping(src('001', 1))).toEqual(
        expect.objectContaining({ kind: 'created', earlier: true }),
      );
      expect(store.earlierMapped).toBe(3);
      expect(store.countsByObject()).toEqual([]);
      expect(store.earlierRecordsOf('Account')).toBe(3);
      // The page written after the last checkpoint: its rows are read again.
      expect(store.earlierRecordsOf('Account', true)).toBe(1);
      expect(store.checkpoints()).toEqual(
        new Map([['Account', { lastId: src('001', 2), read: 2 }]]),
      );
      expect(store.owed).toBe(1);
      expect(store.statusesOwed()).toEqual(
        new Map([
          [
            'Contract',
            {
              count: 1,
              samples: [{ objectApiName: 'Contract', id: tgt('800', 1), status: 'Activated' }],
            },
          ],
        ]),
      );
      expect(store.wasRead(src('001', 4))).toBe(true);
      expect(store.partCount).toBe(2);

      store.setMapping('created', src('001', 6), tgt('001', 6), 'Account');
      expect(store.mapping(src('001', 6))?.earlier).toBe(false);
      expect(store.countsByObject()).toEqual([{ objectApiName: 'Account', created: 1, linked: 0 }]);
    });

    it('keeps an object read to its end as done', () => {
      const { store, file } = freshStore();
      store.checkpoint('Account', { lastId: src('001', 9), read: 10, done: true });
      store.close();
      expect(ForgeRunStore.open(memoryRunFile(file.text())).checkpoints().get('Account')).toEqual({
        lastId: src('001', 9),
        read: 10,
        done: true,
      });
    });

    it('leaves out a line a closed window cut short, and reads the others', () => {
      const text = `${firstPart()}["c","${src('001', 8)}","001T0`;
      const store = ForgeRunStore.open(memoryRunFile(text));
      expect(store.earlierMapped).toBe(3);
      expect(store.targetOf(src('001', 8))).toBeUndefined();
    });
  });

  describe('the ids read', () => {
    it('keeps an id read only when the run did not map it, once the page is through', () => {
      const { store, file } = freshStore();
      store.noteRead(src('001', 1));
      store.noteRead(src('001', 2));
      // Held: asked, it is read all the same.
      expect(store.wasRead(src('001', 2))).toBe(true);
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      store.settleReads();
      store.flush();

      expect(store.wasRead(src('001', 1))).toBe(true);
      expect(store.wasRead(src('001', 2))).toBe(true);
      expect(store.wasRead(src('001', 3))).toBe(false);
      expect(store.targetOf(src('001', 2))).toBeUndefined();
      const readLines = file
        .text()
        .split('\n')
        .filter((line) => line.startsWith('["i"'));
      expect(readLines).toEqual([`["i","${src('001', 2)}"]`]);
    });

    it('maps an id read once it is written', () => {
      const { store } = freshStore();
      store.noteRead(src('001', 1));
      store.settleReads();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      expect(store.targetOf(src('001', 1))).toBe(tgt('001', 1));
      expect(store.mappedSize).toBe(1);
    });
  });

  describe('what is owed', () => {
    it('gives the lookups owed back a page at a time, in the order owed, each with its kind', () => {
      const { store } = freshStore();
      for (let n = 0; n < 5; n++) {
        store.owe(
          {
            objectApiName: 'Account',
            newId: tgt('001', n),
            sourceId: src('001', n),
            fieldName: 'ParentId',
            sourceRefId: src('001', n + 1),
            ...(n === 4 ? { insertOnly: true as const } : {}),
          },
          n === 3,
        );
      }
      const pages = [...store.owedPages(2)];
      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(pages[1][1]).toEqual({
        update: {
          objectApiName: 'Account',
          newId: tgt('001', 3),
          sourceId: src('001', 3),
          fieldName: 'ParentId',
          sourceRefId: src('001', 4),
        },
        toRowWrittenBefore: true,
      });
      expect(pages[2][0].update.insertOnly).toBe(true);
    });

    it('gives the statuses owed back in the order owed, and counts each object with a few samples', () => {
      const { store } = freshStore();
      for (let n = 0; n < 5; n++) store.oweStatus('Order', tgt('801', n), 'Activated');
      store.oweStatus('Contract', tgt('800', 0), 'Activated');
      expect([...store.statusLines()].map(({ id }) => id)).toEqual([
        ...Array.from({ length: 5 }, (_, n) => tgt('801', n)),
        tgt('800', 0),
      ]);
      const owed = store.statusesOwed();
      expect(owed.get('Order')?.count).toBe(5);
      expect(owed.get('Order')?.samples).toHaveLength(3);
      expect(owed.get('Contract')?.count).toBe(1);
    });
  });

  describe('the file', () => {
    it('holds its lines until the calls under way are through, and every line once flushed', async () => {
      const { store, file } = freshStore();
      store.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
      expect(file.text()).not.toContain(src('001', 1));
      await Promise.resolve();
      expect(file.text()).toContain(`["c","${src('001', 1)}","${tgt('001', 1)}","Account"]`);
    });

    it('starts each part with a line of its own', () => {
      const { file } = freshStore();
      expect(file.text().split('\n')[1]).toBe(
        '{"part":{"n":0,"startedAt":"2026-10-14T08:00:00.000Z"}}',
      );
    });

    describe('on disk', () => {
      const dirs: string[] = [];
      afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      });

      it('adds to the file it opens, and reads back what it wrote there', () => {
        const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
        dirs.push(dir);
        const path = join(dir, 'run.ndjson');
        const first = ForgeRunStore.open(nodeRunFile(path));
        first.beginPart(at);
        first.setMapping('created', src('001', 1), tgt('001', 1), 'Account');
        first.close();

        const second = ForgeRunStore.open(nodeRunFile(path));
        second.beginPart(at);
        second.setMapping('created', src('001', 2), tgt('001', 2), 'Account');
        expect(second.targetOf(src('001', 1))).toBe(tgt('001', 1));
        expect(second.targetOf(src('001', 2))).toBe(tgt('001', 2));
        second.close();

        const lines = readFileSync(path, 'utf8').trim().split('\n');
        expect(lines.filter((line) => line.startsWith('{"part"'))).toHaveLength(2);
        expect(lines.filter((line) => line.startsWith('["c"'))).toHaveLength(2);
      });
    });
  });
});
