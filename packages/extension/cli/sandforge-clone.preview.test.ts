import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { MemoryRemovalOrg, orgStamp } from '../src/test/memoryRemovalOrg.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(async (alias: string) => ({ alias, username: 'test-user@example.com' })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { loadOrg, makeConn } from './sfSession.js';
import { removalOrg, type RemovalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  CLONE_PREVIEW_UNREAD,
  clonePreviewLines,
  main,
  parseRemoveArgs,
  removalsPath,
  type CloneRemovalPreview,
} from './sandforge-clone.js';

/*
 * `--remove … --preview`: what a removal of a clone's run would do, said and
 * returned with nothing written — to the org, beside the summary, or to the
 * run's journal — and nothing asked. An environment's plan reads each forge
 * run it applied this way.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000002AAA';
const OTHER_ORG = '00D000000000003AAA';
const COLLEAGUE = fakeId('005', 2);
/** Source ids, and the target ids the run gave them. */
const SRC_ACCOUNT = fakeId('001', 1);
const SRC_CONTACTS = [fakeId('003', 1), fakeId('003', 2)];
const TGT_ACCOUNT = fakeId('001', 901);
const TGT_CONTACTS = [fakeId('003', 901), fakeId('003', 902)];

const argv = (...args: string[]): string[] => ['node', 'sandforge-clone.ts', ...args];

/** A clone ten minutes ago that wrote an account, then two contacts under it. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const first = new Date(Date.now() - 11 * 60_000);
  const last = new Date(Date.now() - 10 * 60_000);
  return {
    tool: 'sandforge-clone',
    version: 1,
    source: 'SRC',
    target: 'TGT',
    targetOrgId: ORG_ID,
    objects: [
      { objectApiName: 'Account', where: "Name LIKE 'SFENV%'" },
      { objectApiName: 'Contact' },
    ],
    dryRun: false,
    elapsedMs: 60_000,
    finishedAt: last.toISOString(),
    result: {
      remapTable: {
        [SRC_ACCOUNT]: TGT_ACCOUNT,
        [SRC_CONTACTS[0] ?? '']: TGT_CONTACTS[0],
        [SRC_CONTACTS[1] ?? '']: TGT_CONTACTS[1],
      },
      existingSourceIds: [],
      updatedSourceIds: [],
      createdByObject: [
        { objectApiName: 'Account', sourceIds: [SRC_ACCOUNT] },
        { objectApiName: 'Contact', sourceIds: SRC_CONTACTS },
      ],
      writtenBetween: { first: first.toISOString(), last: last.toISOString() },
    },
    ...overrides,
  };
}

/** Stop at `process.exit`, with its code and what was written to stderr. */
function stubExit(): { code: () => number | undefined; stderr: () => string } {
  let code: number | undefined;
  let stderr = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`exit ${c}`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  return { code: () => code, stderr: () => stderr };
}

/** `org` with every write it could be asked for thrown, and counted. */
function readOnly(org: MemoryRemovalOrg) {
  const refused = (): never => {
    throw new Error('a preview wrote to the org');
  };
  const writes = { destroy: vi.fn(refused), bulkDestroy: vi.fn(refused), update: vi.fn(refused) };
  const session: RemovalOrg = {
    query: (soql) => org.query(soql),
    queryDeleted: (soql) => org.queryDeleted(soql),
    describe: (objectApiName) => org.describe(objectApiName),
    describeGlobal: () => org.describeGlobal(),
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
    ...writes,
  };
  return { session, writes };
}

/**
 * The target as the command reaches it: its Organization record, and nothing
 * it runs as records go — no flow, no trigger, every Tooling read empty.
 */
function targetConn(organization: { Id: string; IsSandbox: boolean; OrganizationType?: string }) {
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  return {
    version: '62.0',
    query: vi.fn(async (soql: string) =>
      soql.includes(' FROM Organization ') ? page([organization]) : page([]),
    ),
    queryMore: vi.fn(async () => page([])),
    tooling: { query: vi.fn(async () => page([])), queryMore: vi.fn(async () => page([])) },
    request: vi.fn(async ({ body }: { body: string }) => ({
      compositeResponse: (
        JSON.parse(body) as { compositeRequest: Array<{ referenceId: string }> }
      ).compositeRequest.map((sub) => ({
        referenceId: sub.referenceId,
        httpStatusCode: 200,
        body: page([]),
      })),
    })),
  } as unknown as Connection;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sandforge-clone --remove --preview: the command line', () => {
  it('reads --preview, and leaves it out of a removal’s line that does not give it', () => {
    expect(parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--preview'))).toEqual(
      expect.objectContaining({ preview: true }),
    );
    expect(parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT'))).not.toHaveProperty(
      'preview',
    );
  });

  it('refuses --dry-run on a removal, naming --preview, before any org is reached', async () => {
    const exit = stubExit();

    await expect(
      main(argv('--remove', 'run.json', '--target', 'TGT', '--dry-run')),
    ).rejects.toThrow('exit 2');

    expect(exit.stderr()).toContain('--remove does not take --dry-run');
    expect(exit.stderr()).toContain('--preview says what the removal would do, and writes nothing');
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it.each(['--sweep', '--sweep-list', '--audit'])(
    'refuses %s with --preview, which writes nothing',
    (flag) => {
      const exit = stubExit();
      const line = argv('--remove', 'run.json', '--target', 'TGT', '--preview', flag);
      if (flag === '--audit') line.push('audit.json');

      expect(() => parseRemoveArgs(line)).toThrow('exit 2');

      expect(exit.stderr()).toContain(`--preview writes nothing: give it without ${flag}`);
    },
  );
});

describe('sandforge-clone --remove --preview', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let stdout: string;

  beforeEach(() => {
    vi.mocked(loadOrg).mockClear();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-preview-'));
    file = join(dir, 'clone-summary.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
    });
    const at = orgStamp(Date.now() - 10 * 60_000 - 30_000);
    org.add('Account', { Id: TGT_ACCOUNT }, at);
    for (const id of TGT_CONTACTS) org.add('Contact', { Id: id, AccountId: TGT_ACCOUNT }, at);
    org.add('User', { Id: COLLEAGUE, Name: 'A colleague' }, at);
    vi.mocked(removalOrg).mockReturnValue(org);
    vi.mocked(makeConn).mockReturnValue(targetConn({ Id: ORG_ID, IsSandbox: true }));
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints what a removal would do, per object, and writes nothing, to the org or beside the summary', async () => {
    const { session, writes } = readOnly(org);
    vi.mocked(removalOrg).mockReturnValue(session);
    // A colleague changed a contact since the run: a removal keeps it.
    org.edit('Contact', TGT_CONTACTS[1] ?? '', { LastName: 'Renamed' }, COLLEAGUE);

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    const answer = JSON.parse(stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      tool: 'sandforge-clone',
      version: 1,
      action: 'remove-preview',
      summary: file,
      target: 'TGT',
      targetOrgId: ORG_ID,
      includeChanged: false,
      refusals: [],
      preview: {
        planned: 3,
        objects: [
          expect.objectContaining({
            objectApiName: 'Contact',
            planned: 2,
            toDelete: 1,
            changedSince: 1,
            keptChanged: 1,
            changedBy: { [COLLEAGUE]: 1 },
          }),
          expect.objectContaining({ objectApiName: 'Account', planned: 1, toDelete: 1 }),
        ],
      },
    });
    expect((answer['notes'] as string[]).at(-1)).toBe(CLONE_PREVIEW_UNREAD);
    expect(writes.destroy).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(org.all('Contact')).toHaveLength(2);
    expect(existsSync(removalsPath(file))).toBe(false);
  });

  it('counts the records changed since among those to delete with --include-changed', async () => {
    org.edit('Contact', TGT_CONTACTS[1] ?? '', { LastName: 'Renamed' }, COLLEAGUE);

    await main(
      argv('--remove', file, '--target', 'TGT', '--preview', '--include-changed', '--json'),
    );

    const answer = JSON.parse(stdout) as { preview: CloneRemovalPreview; includeChanged: boolean };
    expect(answer.includeChanged).toBe(true);
    expect(answer.preview.objects[0]).toMatchObject({ toDelete: 2, keptChanged: 0 });
  });

  it('says the records gone already, the recycle bin’s among them', async () => {
    org.trash('Contact', TGT_CONTACTS[0] ?? '', COLLEAGUE);

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    const answer = JSON.parse(stdout) as { preview: CloneRemovalPreview };
    expect(answer.preview.objects[0]).toMatchObject({ toDelete: 1, alreadyGone: 1 });
  });

  it('reads a production org and says the refusal a removal would meet there, deleting nothing', async () => {
    const { session, writes } = readOnly(org);
    vi.mocked(removalOrg).mockReturnValue(session);
    vi.mocked(makeConn).mockReturnValue(targetConn({ Id: ORG_ID, IsSandbox: false }));

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    const answer = JSON.parse(stdout) as { refusals: string[] };
    expect(answer.refusals).toEqual([expect.stringContaining('TGT is a production org')]);
    expect(writes.destroy).not.toHaveBeenCalled();
  });

  it('says a removal would stop for objects the user may not delete, unless --leave-undeletable', async () => {
    org.undeletable.add('Contact');

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));
    const refused = JSON.parse(stdout) as { refusals: string[]; preview: CloneRemovalPreview };
    stdout = '';
    await main(
      argv('--remove', file, '--target', 'TGT', '--preview', '--leave-undeletable', '--json'),
    );
    const left = JSON.parse(stdout) as { refusals: string[] };

    expect(refused.refusals).toEqual([
      expect.stringContaining('may not delete the records of Contact (2 records)'),
    ]);
    expect(refused.preview.undeletable).toEqual([{ objectApiName: 'Contact', records: 2 }]);
    expect(left.refusals).toEqual([]);
  });

  it('refuses an org that is not the one the run wrote to, exit 1, having read none of the run', async () => {
    const exit = stubExit();
    vi.mocked(makeConn).mockReturnValue(targetConn({ Id: OTHER_ORG, IsSandbox: true }));
    const queried = vi.spyOn(org, 'query');

    await expect(main(argv('--remove', file, '--target', 'TGT', '--preview'))).rejects.toThrow(
      'exit 1',
    );

    expect(exit.stderr()).toContain(`TGT is not the org the run wrote to (${ORG_ID})`);
    expect(queried).not.toHaveBeenCalled();
  });

  it('says a run that created nothing has nothing to remove, without reaching the org', async () => {
    writeFileSync(
      file,
      JSON.stringify(
        summary({ result: { ...(summary()['result'] as object), createdByObject: [] } }),
      ),
    );

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    const answer = JSON.parse(stdout) as { preview: CloneRemovalPreview; notes: string[] };
    expect(answer.preview).toEqual({ planned: 0, objects: [], userNames: {} });
    expect(answer.notes).toContain('The run created no record: there is nothing of it to remove.');
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('prints its lines without --json, the changed records with who changed them', () => {
    const lines = clonePreviewLines(
      {
        planned: 2,
        objects: [
          {
            objectApiName: 'Contact',
            planned: 2,
            toDelete: 1,
            alreadyGone: 0,
            changedSince: 1,
            keptChanged: 1,
            changedBy: { [COLLEAGUE]: 1 },
            undeletable: 0,
            notVisible: 0,
            unread: 0,
            reasons: [],
          },
        ],
        userNames: { [COLLEAGUE]: 'A colleague' },
      },
      ['a refusal'],
      ['a note'],
      false,
    );

    expect(lines).toEqual([
      'preview: what a removal would do; nothing was written',
      '  Contact: 1 to delete, 1 kept, changed since the run of 2',
      '      last changed by: A colleague 1',
      'a removal would be refused: a refusal',
      'a note',
    ]);
  });
});
