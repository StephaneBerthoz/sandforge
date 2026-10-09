import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InsideRepoPathError, SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import {
  REFERENCEID_MAPPING_FILENAME,
  SasReferenceIdMappingStore,
  mappedOrgIds,
  referenceIdMappingFileName,
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

    // The file of the loads into the target org, which a load into another leaves alone.
    expect(store.filePath).toBe(path.join(dir, 'referenceid-mapping.00D-target.json'));
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
      orgId: '00D-target',
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
        fs.readFileSync(path.join(dir, referenceIdMappingFileName('org-target')), 'utf8'),
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
        fs.readFileSync(path.join(dir, referenceIdMappingFileName('org-target')), 'utf8'),
      ) as { organizationId?: string };
      expect(payload.organizationId).toBe(REFRESHED_TO);
    });
  });

  describe('what a load created, for its removal', () => {
    const ACCOUNT = '001XX00000AbCdEAAA';
    const CONTACT = '003XX00000AbCdEAAA';
    const BOOK = '01sXX00000AbCdEAAA';
    const STARTED = new Date('2026-09-24T10:00:00.000Z');
    const ENDED = '2026-09-24T10:02:00.000Z';

    /** A load that matched the standard book and inserted an account and a contact. */
    async function loaded(dir: string, now = ENDED): Promise<SasReferenceIdMappingStore> {
      const store = new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-dev',
        now: () => new Date(now),
      });
      await store.persist(
        new Map([
          ['Pricebook2-000001', BOOK],
          ['Account-000001', ACCOUNT],
          ['Contact-000001', CONTACT],
        ]),
        {
          created: [
            { objectApiName: 'Account', referenceIds: ['Account-000001'] },
            { objectApiName: 'Contact', referenceIds: ['Contact-000001', 'Contact-000404'] },
          ],
          startedAt: STARTED,
        },
      );
      return store;
    }

    it('keeps which records the load created, and when it began and ended', async () => {
      const store = await loaded(makeTmpDir());

      await expect(store.recorded()).resolves.toEqual({
        orgId: 'org-dev',
        mapping: new Map([
          ['Account-000001', ACCOUNT],
          ['Contact-000001', CONTACT],
          ['Pricebook2-000001', BOOK],
        ]),
        // A key the mapping does not hold is not kept as created.
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: STARTED.toISOString(),
        endedAt: ENDED,
        removalStamps: {},
        removalSpans: [],
      });
      expect((await store.previousLoads())[0]?.created).toHaveLength(2);
    });

    it('says nothing of what a load created in a file written before it was kept', async () => {
      const dir = makeTmpDir();
      const store = new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        now: () => new Date(ENDED),
      });
      await store.persist(new Map([['Account-000001', ACCOUNT]]));

      const recorded = await store.recorded();

      expect(recorded?.created).toBeUndefined();
      // The load is named by when its mapping was written.
      expect(recorded?.endedAt).toBe(ENDED);
      const [previous] = await store.previousLoads();
      expect(previous?.mapping).toEqual(new Map([['Account-000001', ACCOUNT]]));
      expect(previous?.created).toBeUndefined();
    });

    it('has no load to tell of before the first one', async () => {
      const store = new SasReferenceIdMappingStore(makeTmpDir(), {
        guard: new SasPathGuard(repoRoot),
      });
      await expect(store.recorded()).resolves.toBeUndefined();
    });

    it('forgets the records a removal took, keeps what it left on the others, and marks the load', async () => {
      const dir = makeTmpDir();
      await loaded(dir);
      const store = new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-dev',
        now: () => new Date('2026-09-24T11:00:00.000Z'),
      });
      const span = {
        first: '2026-09-24T10:59:00.000Z',
        last: '2026-09-24T11:00:10.000Z',
        userId: '005XX0000001AAA',
      };
      const mark = {
        removedAt: '2026-09-24T11:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 1,
        refused: 0,
      };

      const written = await store.recordRemoval(ENDED, {
        // Named by 15 characters: the same record.
        gone: [CONTACT.slice(0, 15)],
        stamps: { [ACCOUNT]: '2026-09-24T10:59:30.000Z' },
        span,
        mark,
      });

      expect(written).toBe(true);
      const recorded = await store.recorded();
      expect(recorded?.mapping).toEqual(
        new Map([
          ['Account-000001', ACCOUNT],
          ['Pricebook2-000001', BOOK],
        ]),
      );
      expect(recorded?.created).toEqual([
        { objectApiName: 'Account', referenceIds: ['Account-000001'] },
      ]);
      expect(recorded?.removalStamps).toEqual({ [ACCOUNT]: '2026-09-24T10:59:30.000Z' });
      expect(recorded?.removalSpans).toEqual([span]);
      expect(recorded?.removal).toEqual(mark);
      // Still the same load: its span is not the removal's.
      expect(recorded?.endedAt).toBe(ENDED);
    });

    it('reads back from the file what a cancelled removal did not reach, with its mark', async () => {
      const dir = makeTmpDir();
      const store = await loaded(dir);
      const mark = {
        removedAt: '2026-09-24T11:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
        notReached: 1,
      };

      await store.recordRemoval(ENDED, { gone: [CONTACT], stamps: {}, mark });

      expect((await store.recorded())?.removal).toEqual(mark);
    });

    it('drops a stamp a later removal left on a record that then went', async () => {
      const dir = makeTmpDir();
      const store = await loaded(dir);
      await store.recordRemoval(ENDED, {
        gone: [],
        stamps: { [ACCOUNT]: '2026-09-24T10:59:30.000Z' },
      });

      await store.recordRemoval(ENDED, { gone: [ACCOUNT], stamps: {} });

      const recorded = await store.recorded();
      expect(recorded?.removalStamps).toEqual({});
      expect(recorded?.removal).toBeUndefined();
    });

    it('writes nothing into the mapping of a load that ran since', async () => {
      const dir = makeTmpDir();
      await loaded(dir);
      // Another load wrote its own mapping meanwhile.
      const store = await loaded(dir, '2026-09-24T12:00:00.000Z');

      const written = await store.recordRemoval(ENDED, {
        gone: [ACCOUNT],
        stamps: {},
        mark: { removedAt: ENDED, deleted: 1, alreadyGone: 0, kept: 0, refused: 0 },
      });

      expect(written).toBe(false);
      const recorded = await store.recorded();
      expect(recorded?.removal).toBeUndefined();
      expect(recorded?.mapping.get('Account-000001')).toBe(ACCOUNT);
    });

    it('drops what an earlier removal kept once a load writes its own mapping', async () => {
      const dir = makeTmpDir();
      const store = await loaded(dir);
      await store.recordRemoval(ENDED, {
        gone: [CONTACT],
        stamps: { [ACCOUNT]: '2026-09-24T10:59:30.000Z' },
        mark: { removedAt: ENDED, deleted: 1, alreadyGone: 0, kept: 1, refused: 0 },
      });

      await loaded(dir, '2026-09-24T12:00:00.000Z');

      const recorded = await store.recorded();
      expect(recorded?.removal).toBeUndefined();
      expect(recorded?.removalStamps).toEqual({});
    });
  });

  describe("the person accounts' contacts a load linked", () => {
    const PERSON = '001XX00000PeRsNAAA';
    const PERSON_CONTACT = '003XX00000PeRsNAAA';
    const FOUND = '001XX00000FoUnDAAA';
    const CONTACT_OF_FOUND = '003XX00000FoUnDAAA';
    const OTHER = '001XX00000OtHeRAAA';
    const ENDED = '2026-09-24T10:02:00.000Z';

    function storeAt(dir: string, now = ENDED) {
      return new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-dev',
        now: () => new Date(now),
      });
    }

    /**
     * A load that created a person account and linked the contact the
     * platform wrote with it, and linked an account a reload found, with its
     * contact.
     */
    async function loaded(dir: string): Promise<void> {
      await storeAt(dir).persist(
        new Map([
          ['Account-000001', PERSON],
          ['Contact-000001', PERSON_CONTACT],
          ['Account-000002', FOUND],
          ['Contact-000002', CONTACT_OF_FOUND],
        ]),
        {
          created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
          startedAt: new Date('2026-09-24T10:00:00.000Z'),
          personContacts: {
            'Contact-000001': 'Account-000001',
            'Contact-000002': 'Account-000002',
            'Contact-000404': 'Account-000001',
          },
        },
      );
    }

    it('keeps each with the key of its account, of the contacts the mapping names', async () => {
      const dir = makeTmpDir();
      await loaded(dir);

      expect((await storeAt(dir).recorded())?.personContacts).toEqual({
        'Contact-000001': 'Account-000001',
        'Contact-000002': 'Account-000002',
      });
    });

    it('forgets a contact with its account once a removal took the account: the platform deleted it with the account', async () => {
      const dir = makeTmpDir();
      await loaded(dir);

      await storeAt(dir, '2026-09-24T11:00:00.000Z').recordRemoval(ENDED, {
        gone: [PERSON],
        stamps: {},
      });

      const recorded = await storeAt(dir).recorded();
      expect(recorded?.mapping).toEqual(
        new Map([
          ['Account-000002', FOUND],
          ['Contact-000002', CONTACT_OF_FOUND],
        ]),
      );
      expect(recorded?.personContacts).toEqual({ 'Contact-000002': 'Account-000002' });
    });

    it('forgets the contact of an account a reload purged, with the account, of the load it keeps', async () => {
      const dir = makeTmpDir();
      await storeAt(dir).persist(
        new Map([
          ['Account-000001', PERSON],
          ['Contact-000001', PERSON_CONTACT],
          ['Account-000003', OTHER],
        ]),
        {
          created: [
            { objectApiName: 'Account', referenceIds: ['Account-000001', 'Account-000003'] },
          ],
          startedAt: new Date('2026-09-24T10:00:00.000Z'),
          personContacts: { 'Contact-000001': 'Account-000001' },
        },
      );

      // A reload purged the person account, and nothing else of that load.
      await storeAt(dir, '2026-09-24T11:05:00.000Z').persist(new Map(), {
        created: [],
        startedAt: new Date('2026-09-24T11:00:00.000Z'),
        earlier: { settled: [PERSON] },
      });

      const [, earlier] = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
      expect(earlier.mapping).toEqual(new Map([['Account-000003', OTHER]]));
      expect(earlier.personContacts).toBeUndefined();
    });
  });

  describe('what the platform wrote with a record a load created', () => {
    const ACCOUNT = '001XX00000AcCnTAAA';
    const CONTACT = '003XX00000CoNtCAAA';
    const RELATION = '07kXX00000ReLaTAAA';
    const EMAIL = '02sXX00000EmAiLAAA';
    const TASK = '00TXX00000TaSkKAAA';
    const ENDED = '2026-09-24T10:02:00.000Z';
    /** A record's key, as an extraction writes it: its object, then its number on six digits. */
    const ref = (objectApiName: string, n = 1): string =>
      `${objectApiName}-${String(n).padStart(6, '0')}`;

    function storeAt(dir: string, now = ENDED) {
      return new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-dev',
        now: () => new Date(now),
      });
    }

    /**
     * A load that created an account, a contact and an email, and linked the
     * contact's direct relation and the email's task, which the platform
     * wrote with them.
     */
    async function loaded(dir: string): Promise<void> {
      await storeAt(dir).persist(
        new Map([
          ['Account-000001', ACCOUNT],
          ['Contact-000001', CONTACT],
          ['AccountContactRelation-000001', RELATION],
          ['EmailMessage-000001', EMAIL],
          [ref('Task'), TASK],
        ]),
        {
          created: [
            { objectApiName: 'Account', referenceIds: ['Account-000001'] },
            { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
            { objectApiName: 'EmailMessage', referenceIds: ['EmailMessage-000001'] },
          ],
          startedAt: new Date('2026-09-24T10:00:00.000Z'),
          withTheirRecord: {
            'AccountContactRelation-000001': 'Contact-000001',
            [ref('Task')]: 'EmailMessage-000001',
            [ref('Task', 404)]: 'EmailMessage-000001',
          },
        },
      );
    }

    it('keeps each with the key of the record it goes with, of those the mapping names', async () => {
      const dir = makeTmpDir();
      await loaded(dir);

      expect((await storeAt(dir).recorded())?.withTheirRecord).toEqual({
        'AccountContactRelation-000001': 'Contact-000001',
        [ref('Task')]: 'EmailMessage-000001',
      });
    });

    it('forgets each with its record once a removal took that record: the platform deleted it with it', async () => {
      const dir = makeTmpDir();
      await loaded(dir);

      await storeAt(dir, '2026-09-24T11:00:00.000Z').recordRemoval(ENDED, {
        gone: [CONTACT, EMAIL],
        stamps: {},
      });

      const recorded = await storeAt(dir).recorded();
      expect(recorded?.mapping).toEqual(new Map([['Account-000001', ACCOUNT]]));
      expect(recorded?.withTheirRecord).toBeUndefined();
    });

    it('forgets each with its record once a reload purged that record, of the load it keeps', async () => {
      const dir = makeTmpDir();
      await loaded(dir);

      // A reload purged the email, and nothing else of that load.
      await storeAt(dir, '2026-09-24T11:05:00.000Z').persist(new Map(), {
        created: [],
        startedAt: new Date('2026-09-24T11:00:00.000Z'),
        earlier: { settled: [EMAIL] },
      });

      const [, earlier] = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
      expect(earlier.mapping).toEqual(
        new Map([
          ['Account-000001', ACCOUNT],
          ['Contact-000001', CONTACT],
          ['AccountContactRelation-000001', RELATION],
        ]),
      );
      expect(earlier.withTheirRecord).toEqual({
        'AccountContactRelation-000001': 'Contact-000001',
      });
    });
  });

  describe('the loads before the last one', () => {
    const FIRST_ACCOUNT = '001XX00000FirStAAA';
    const FIRST_CONTACT = '003XX00000FirStAAA';
    const SECOND_ACCOUNT = '001XX00000SecNdAAA';
    const BOOK = '01sXX00000AbCdEAAA';
    const ORGANIZATION = '00DXX00000AbCdE2A1';

    function storeAt(dir: string, ended: string, organizationId = ORGANIZATION) {
      return new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId: 'org-dev',
        organizationId,
        now: () => new Date(ended),
      });
    }

    /** The first load: it matched the standard book, and created an account and a contact. */
    async function firstLoad(dir: string): Promise<void> {
      await storeAt(dir, '2026-09-24T10:05:00.000Z').persist(
        new Map([
          ['Pricebook2-000001', BOOK],
          ['Account-000001', FIRST_ACCOUNT],
          ['Contact-000001', FIRST_CONTACT],
        ]),
        {
          created: [
            { objectApiName: 'Account', referenceIds: ['Account-000001'] },
            { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
          ],
          startedAt: new Date('2026-09-24T10:00:00.000Z'),
          writtenBetween: {
            first: '2026-09-24T10:00:02.000Z',
            last: '2026-09-24T10:04:58.000Z',
          },
        },
      );
    }

    /** A second load, of an account, keeping the loads before it without `settled`. */
    async function secondLoad(dir: string, settled: string[], organizationId?: string) {
      await storeAt(dir, '2026-09-24T11:05:00.000Z', organizationId).persist(
        new Map([['Account-000001', SECOND_ACCOUNT]]),
        {
          created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
          startedAt: new Date('2026-09-24T11:00:00.000Z'),
          earlier: { settled },
        },
      );
    }

    it('keeps the load before, with its records and its dates, behind the last one', async () => {
      const dir = makeTmpDir();
      await firstLoad(dir);

      await secondLoad(dir, []);

      const loads = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
      expect(loads.map((load) => [load.endedAt, load.earlier === true])).toEqual([
        ['2026-09-24T11:05:00.000Z', false],
        ['2026-09-24T10:05:00.000Z', true],
      ]);
      expect(loads[1]).toMatchObject({
        orgId: 'org-dev',
        mapping: new Map([
          ['Account-000001', FIRST_ACCOUNT],
          ['Contact-000001', FIRST_CONTACT],
          ['Pricebook2-000001', BOOK],
        ]),
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: '2026-09-24T10:00:00.000Z',
        writtenBetween: { first: '2026-09-24T10:00:02.000Z', last: '2026-09-24T10:04:58.000Z' },
      });
      // The last load is still the one the mapping, and its verification, read.
      await expect(storeAt(dir, '2026-09-24T12:00:00.000Z').load()).resolves.toEqual(
        new Map([['Account-000001', SECOND_ACCOUNT]]),
      );
      // And a reload reads both, the last one first.
      const previous = await storeAt(dir, '2026-09-24T12:00:00.000Z').previousLoads();
      expect(previous.map((load) => [...load.mapping.values()])).toEqual([
        [SECOND_ACCOUNT],
        [FIRST_ACCOUNT, FIRST_CONTACT, BOOK],
      ]);
    });

    it('keeps of the load before only what the last one did not settle, and drops it once nothing is left', async () => {
      const dir = makeTmpDir();
      await firstLoad(dir);

      // Settled by 15 characters: the same record.
      await secondLoad(dir, [FIRST_CONTACT.slice(0, 15)]);

      const [, first] = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
      expect(first.created).toEqual([
        { objectApiName: 'Account', referenceIds: ['Account-000001'] },
      ]);
      expect(first.mapping.has('Contact-000001')).toBe(false);

      // A reload over both: each record they created settled.
      await secondLoad(dir, [FIRST_ACCOUNT, SECOND_ACCOUNT]);
      await expect(storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads()).resolves.toHaveLength(
        1,
      );
    });

    it('keeps nothing of a load written to another org than the target is', async () => {
      const dir = makeTmpDir();
      await firstLoad(dir);

      // The sandbox was refreshed: the first load's records went with it.
      await secondLoad(dir, [], '00Dxx00000FgHiJ3B2');

      await expect(
        storeAt(dir, '2026-09-24T12:00:00.000Z', '00Dxx00000FgHiJ3B2').recordedLoads(),
      ).resolves.toHaveLength(1);
    });

    it('keeps a load that does not say what it created whole, for the next reload to judge', async () => {
      const dir = makeTmpDir();
      await storeAt(dir, '2026-09-24T10:05:00.000Z').persist(
        new Map([['Account-000001', FIRST_ACCOUNT]]),
      );

      await secondLoad(dir, []);

      const previous = await storeAt(dir, '2026-09-24T12:00:00.000Z').previousLoads();
      // Named by when its mapping was written, which is what its removal dates it by.
      expect(previous[1]).toEqual({
        mapping: new Map([['Account-000001', FIRST_ACCOUNT]]),
        endedAt: '2026-09-24T10:05:00.000Z',
      });
    });

    it('records the removal of the load before in its own entry, and forgets what went everywhere', async () => {
      const dir = makeTmpDir();
      await firstLoad(dir);
      await secondLoad(dir, []);
      const mark = {
        removedAt: '2026-09-24T12:00:00.000Z',
        deleted: 2,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      };

      const written = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordRemoval(
        '2026-09-24T10:05:00.000Z',
        { gone: [FIRST_ACCOUNT, FIRST_CONTACT], stamps: {}, mark },
      );

      expect(written).toBe(true);
      const [last, first] = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
      expect(first.removal).toEqual(mark);
      expect(first.created).toEqual([]);
      expect(first.mapping).toEqual(new Map([['Pricebook2-000001', BOOK]]));
      // The last load is as it was: its own record, unmarked.
      expect(last.removal).toBeUndefined();
      expect(last.mapping).toEqual(new Map([['Account-000001', SECOND_ACCOUNT]]));
      expect(last.endedAt).toBe('2026-09-24T11:05:00.000Z');
    });

    describe('what a reload left on the records it did not delete', () => {
      const LEFT_AT = '2026-09-24T12:00:03.000+0000';

      it('keeps it with the load that names the record, and changes nothing else', async () => {
        const dir = makeTmpDir();
        await firstLoad(dir);
        await secondLoad(dir, []);
        const store = storeAt(dir, '2026-09-24T12:00:00.000Z');
        const file = path.join(dir, referenceIdMappingFileName('org-dev'));
        const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

        const written = await store.recordStamps({ [FIRST_ACCOUNT]: LEFT_AT });

        expect(written).toBe(true);
        const [last, first] = await store.recordedLoads();
        expect(first.removalStamps).toEqual({ [FIRST_ACCOUNT]: LEFT_AT });
        expect(last.removalStamps).toEqual({});
        // Both named as they were, and the mapping written when it was: a load
        // recorded before loads kept their span is named by that date.
        expect([last.endedAt, first.endedAt]).toEqual([
          '2026-09-24T11:05:00.000Z',
          '2026-09-24T10:05:00.000Z',
        ]);
        const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        expect(after.updatedAt).toBe(before.updatedAt);
        // And a reload is handed it with the load's dates, to judge the record by.
        const [, previous] = await store.previousLoads();
        expect(previous).toMatchObject({
          writtenBetween: { first: '2026-09-24T10:00:02.000Z', last: '2026-09-24T10:04:58.000Z' },
          removalStamps: { [FIRST_ACCOUNT]: LEFT_AT },
        });
      });

      it('replaces an older stamp of the record, whichever length its id is written in', async () => {
        const dir = makeTmpDir();
        await firstLoad(dir);
        const store = storeAt(dir, '2026-09-24T12:00:00.000Z');
        await store.recordStamps({ [FIRST_ACCOUNT.slice(0, 15)]: '2026-09-24T11:00:00.000+0000' });

        await store.recordStamps({ [FIRST_ACCOUNT]: LEFT_AT });

        expect((await store.recorded())?.removalStamps).toEqual({ [FIRST_ACCOUNT]: LEFT_AT });
      });

      it('writes nothing for a record no load names', async () => {
        const dir = makeTmpDir();
        await firstLoad(dir);
        const file = path.join(dir, referenceIdMappingFileName('org-dev'));
        const before = fs.readFileSync(file, 'utf8');

        const written = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordStamps({
          [SECOND_ACCOUNT]: LEFT_AT,
        });

        expect(written).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      });

      it('keeps the stamp when the reload then writes its own mapping', async () => {
        const dir = makeTmpDir();
        await firstLoad(dir);
        await storeAt(dir, '2026-09-24T12:00:00.000Z').recordStamps({ [FIRST_ACCOUNT]: LEFT_AT });

        await secondLoad(dir, [FIRST_CONTACT]);

        const [, first] = await storeAt(dir, '2026-09-24T12:00:00.000Z').recordedLoads();
        expect(first.removalStamps).toEqual({ [FIRST_ACCOUNT]: LEFT_AT });
      });
    });
  });

  describe('the loads of each target org', () => {
    // One file per sas, a load into a second org replaced the first org's
    // mapping: its loads were no longer named, and neither removed nor
    // purged by a reload.
    const A_ACCOUNT = '001XX00000OrgAaAAA';
    const B_ACCOUNT = '001XX00000OrgBbAAA';
    const A_ORGANIZATION = '00DXX00000OrgAa2A1';
    const B_ORGANIZATION = '00DXX00000OrgBb2A1';

    function storeOf(dir: string, orgId: string, organizationId: string, ended: string) {
      return new SasReferenceIdMappingStore(dir, {
        guard: new SasPathGuard(repoRoot),
        orgId,
        organizationId,
        now: () => new Date(ended),
      });
    }

    /** A load of one account into `orgId`, keeping the loads before it into that org. */
    async function loadInto(
      dir: string,
      orgId: string,
      organizationId: string,
      account: string,
      ended: string,
    ): Promise<void> {
      await storeOf(dir, orgId, organizationId, ended).persist(
        new Map([['Account-000001', account]]),
        {
          created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
          startedAt: new Date(Date.parse(ended) - 60_000),
          earlier: { settled: [] },
        },
      );
    }

    it('keeps the loads into one org whole when a load goes into another', async () => {
      const dir = makeTmpDir();
      await loadInto(dir, 'org-a', A_ORGANIZATION, A_ACCOUNT, '2026-09-24T10:05:00.000Z');

      await loadInto(dir, 'org-b', B_ORGANIZATION, B_ACCOUNT, '2026-09-24T11:05:00.000Z');

      const ofA = storeOf(dir, 'org-a', A_ORGANIZATION, '2026-09-24T12:00:00.000Z');
      const ofB = storeOf(dir, 'org-b', B_ORGANIZATION, '2026-09-24T12:00:00.000Z');
      const loadsOfA = await ofA.recordedLoads();
      expect(loadsOfA).toHaveLength(1);
      expect(loadsOfA[0]).toMatchObject({
        orgId: 'org-a',
        endedAt: '2026-09-24T10:05:00.000Z',
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
      });
      expect(loadsOfA[0].mapping).toEqual(new Map([['Account-000001', A_ACCOUNT]]));
      // A reload into the first org still purges what its load created.
      const previousOfA = await ofA.previousLoads();
      expect(previousOfA.map((load) => [...load.mapping.values()])).toEqual([[A_ACCOUNT]]);
      // And the second org's load stands on its own, with nothing of the first.
      const loadsOfB = await ofB.recordedLoads();
      expect(loadsOfB.map((load) => [load.orgId, load.earlier === true])).toEqual([
        ['org-b', false],
      ]);
      expect(loadsOfB[0].mapping).toEqual(new Map([['Account-000001', B_ACCOUNT]]));
      expect(ofA.filePath).not.toBe(ofB.filePath);
    });

    it('empties the mapping of a refreshed org only', async () => {
      const dir = makeTmpDir();
      await loadInto(dir, 'org-a', A_ORGANIZATION, A_ACCOUNT, '2026-09-24T10:05:00.000Z');
      await loadInto(dir, 'org-b', B_ORGANIZATION, B_ACCOUNT, '2026-09-24T11:05:00.000Z');

      // The first sandbox was refreshed: it answers with another id now.
      const refreshed = storeOf(dir, 'org-a', '00DXX00000NewAa2A1', '2026-09-24T12:00:00.000Z');

      await expect(refreshed.isStale()).resolves.toBe(true);
      await expect(refreshed.load()).resolves.toEqual(new Map());
      const ofB = storeOf(dir, 'org-b', B_ORGANIZATION, '2026-09-24T12:00:00.000Z');
      await expect(ofB.isStale()).resolves.toBe(false);
      await expect(ofB.load()).resolves.toEqual(new Map([['Account-000001', B_ACCOUNT]]));
    });

    describe('in a sas that kept one file for every org', () => {
      /** The one file of before, written by a load into `org-a`. */
      async function singleFileOfA(dir: string): Promise<void> {
        await loadInto(dir, 'org-a', A_ORGANIZATION, A_ACCOUNT, '2026-09-24T10:05:00.000Z');
        fs.renameSync(
          path.join(dir, referenceIdMappingFileName('org-a')),
          path.join(dir, REFERENCEID_MAPPING_FILENAME),
        );
      }

      it('reads it for the org it names, and for no other', async () => {
        const dir = makeTmpDir();
        await singleFileOfA(dir);

        const loadsOfA = await storeOf(
          dir,
          'org-a',
          A_ORGANIZATION,
          '2026-09-24T12:00:00.000Z',
        ).recordedLoads();
        expect(loadsOfA.map((load) => load.endedAt)).toEqual(['2026-09-24T10:05:00.000Z']);
        await expect(
          storeOf(dir, 'org-b', B_ORGANIZATION, '2026-09-24T12:00:00.000Z').recordedLoads(),
        ).resolves.toEqual([]);
        await expect(mappedOrgIds(dir, new SasPathGuard(repoRoot))).resolves.toEqual(['org-a']);
      });

      it('leaves it to its org when a load goes into another', async () => {
        const dir = makeTmpDir();
        await singleFileOfA(dir);

        await loadInto(dir, 'org-b', B_ORGANIZATION, B_ACCOUNT, '2026-09-24T11:05:00.000Z');

        expect(fs.existsSync(path.join(dir, REFERENCEID_MAPPING_FILENAME))).toBe(true);
        const [ofB] = await storeOf(
          dir,
          'org-b',
          B_ORGANIZATION,
          '2026-09-24T12:00:00.000Z',
        ).recordedLoads();
        expect(ofB.mapping).toEqual(new Map([['Account-000001', B_ACCOUNT]]));
        await expect(mappedOrgIds(dir, new SasPathGuard(repoRoot))).resolves.toEqual([
          'org-a',
          'org-b',
        ]);
      });

      it('rewrites it as the file of its org at the next load into that org', async () => {
        const dir = makeTmpDir();
        await singleFileOfA(dir);

        await loadInto(
          dir,
          'org-a',
          A_ORGANIZATION,
          '001XX00000OrgA2AAA',
          '2026-09-24T11:05:00.000Z',
        );

        expect(fs.existsSync(path.join(dir, REFERENCEID_MAPPING_FILENAME))).toBe(false);
        const loads = await storeOf(
          dir,
          'org-a',
          A_ORGANIZATION,
          '2026-09-24T12:00:00.000Z',
        ).recordedLoads();
        // The load before, which the single file held, is kept behind the new one.
        expect(loads.map((load) => [load.endedAt, load.earlier === true])).toEqual([
          ['2026-09-24T11:05:00.000Z', false],
          ['2026-09-24T10:05:00.000Z', true],
        ]);
        await expect(mappedOrgIds(dir, new SasPathGuard(repoRoot))).resolves.toEqual(['org-a']);
      });
    });

    it('lists no org of a sas that does not exist yet', async () => {
      await expect(
        mappedOrgIds(path.join(makeTmpDir(), 'not-yet'), new SasPathGuard(repoRoot)),
      ).resolves.toEqual([]);
    });

    it('refuses an org id that would name a file outside the sas', () => {
      const store = new SasReferenceIdMappingStore(makeTmpDir(), {
        guard: new SasPathGuard(repoRoot),
        orgId: '../elsewhere',
      });
      expect(() => store.filePath).toThrow(/Not an org id/);
    });
  });

  it('keeps the dates the target gave the records a load created', async () => {
    const dir = makeTmpDir();
    const store = new SasReferenceIdMappingStore(dir, { guard: new SasPathGuard(repoRoot) });
    const writtenBetween = { first: '2026-09-24T10:00:02.000Z', last: '2026-09-24T10:04:58.000Z' };

    await store.persist(new Map([['Account-000001', '001XX00000AbCdEAAA']]), {
      created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
      startedAt: new Date('2026-09-24T10:00:00.000Z'),
      writtenBetween,
    });

    await expect(store.recorded()).resolves.toMatchObject({ writtenBetween });
  });

  it('refuses a sas directory inside the repository', async () => {
    const store = new SasReferenceIdMappingStore(path.join(repoRoot, 'exports'), {
      guard: new SasPathGuard(repoRoot),
    });
    await expect(store.persist(new Map())).rejects.toThrow(InsideRepoPathError);
    await expect(store.load()).rejects.toThrow(InsideRepoPathError);
  });
});
