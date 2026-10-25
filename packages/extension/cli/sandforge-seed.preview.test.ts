import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation } from '@sandforge/shared';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
/** What the target runs as the removal writes, as it reads it: nothing, unless a test says what. */
const automationRead = vi.fn(async (..._args: unknown[]): Promise<ForgeTargetAutomation> => ({
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 0,
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({ read: automationRead })),
}));

import { makeConn } from './sfSession.js';
import { removalOrg, type RemovalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  PREVIEW_UNREAD,
  main,
  parseRemoveArgs,
  removalPreviewLines,
  type SeedRemovalPreview,
} from './sandforge-seed.js';

/*
 * `--remove … --preview`: what a removal of a run would do, said and returned
 * with nothing written — to the org, or beside the summary — and nothing
 * asked. An environment's plan reads each applied run this way.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);
const COLLEAGUE = fakeId('005', 2);

const argv = (...args: string[]): string[] => ['node', 'sandforge-seed.ts', ...args];

/** A seed ten minutes ago that wrote two accounts, then two contacts under them. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'sandforge-seed',
    target: 'TGT',
    targetOrgId: ORG_ID,
    dryRun: false,
    seed: 1234,
    startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    result: {
      operationId: 'env-demo-accounts-1',
      status: 'success',
      objectResults: [
        { objectApiName: 'Account', recordsCreated: 2, createdIds: [A1, A2], errors: [] },
        { objectApiName: 'Contact', recordsCreated: 2, createdIds: [C1, C2], errors: [] },
      ],
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sandforge-seed --remove --preview: the command line', () => {
  it('reads --preview, and leaves it out of a removal’s line that does not give it', () => {
    expect(parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--preview'))).toEqual(
      expect.objectContaining({ preview: true }),
    );
    expect(parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT'))).not.toHaveProperty(
      'preview',
    );
  });

  it('refuses --dry-run on a removal, naming --preview, as a removal that ignored it would delete', () => {
    const exit = stubExit();

    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--dry-run')),
    ).toThrow('exit 2');

    expect(exit.stderr()).toContain('--remove does not take --dry-run');
    expect(exit.stderr()).toContain('--preview says what the removal would do');
  });

  it.each(['--sweep', '--sweep-list'])(
    'refuses %s with --preview, which writes nothing',
    (flag) => {
      const exit = stubExit();

      expect(() =>
        parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--preview', flag)),
      ).toThrow('exit 2');

      expect(exit.stderr()).toContain('give --preview without them');
    },
  );
});

describe('sandforge-seed --remove --preview', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let edition: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-preview-'));
    file = join(dir, 'seed.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('Contact', { Id: C2, AccountId: A2 }, at);
    org.add('User', { Id: COLLEAGUE, Name: 'A colleague' }, at);
    edition = 'Developer Edition';
    vi.mocked(removalOrg).mockReturnValue(org);
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT Id, IsSandbox')
          ? { records: [{ Id: ORG_ID, IsSandbox: false }] }
          : { records: [{ OrganizationType: edition }] },
      ),
    } as unknown as Connection);
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    automationRead.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints what a removal would do, per object, and writes nothing, to the org or beside the summary', async () => {
    const { session, writes } = readOnly(org);
    vi.mocked(removalOrg).mockReturnValue(session);
    // The account's delete clears the contact's lookup and restamps it as the
    // user who deleted it; the colleague's change comes after.
    org.trash('Account', A2);
    org.edit('Contact', C2, { Title: 'Changed since' }, COLLEAGUE);

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    expect(writes.destroy).not.toHaveBeenCalled();
    expect(writes.bulkDestroy).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
    expect(existsSync(join(dir, 'seed.removals.json'))).toBe(false);
    const answer = JSON.parse(stdout) as Record<string, unknown>;
    expect(answer).toEqual({
      tool: 'sandforge-seed',
      action: 'remove-preview',
      summary: file,
      target: 'TGT',
      includeChanged: false,
      preview: {
        planned: 4,
        objects: [
          expect.objectContaining({
            objectApiName: 'Contact',
            planned: 2,
            toDelete: 1,
            changedSince: 1,
            keptChanged: 1,
            changedBy: { [COLLEAGUE]: 1 },
          }),
          expect.objectContaining({
            objectApiName: 'Account',
            planned: 2,
            toDelete: 1,
            alreadyGone: 1,
          }),
        ],
        userNames: { [COLLEAGUE]: 'A colleague' },
      },
      refusals: [],
      notes: [PREVIEW_UNREAD],
      elapsedMs: expect.any(Number),
    });
    // Asked what fires as a removal would delete, as the removal asks.
    expect(automationRead).toHaveBeenCalledWith('TGT', ['Contact', 'Account']);
  });

  it('says what a removal would be refused for, asks nothing, and exits 0', async () => {
    automationRead.mockResolvedValueOnce({
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    });
    org.undeletable.add('Account');
    edition = 'Enterprise Edition';
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit');

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    expect(exit).not.toHaveBeenCalled();
    const answer = JSON.parse(stdout) as {
      refusals: string[];
      preview: SeedRemovalPreview;
    };
    expect(answer.refusals).toEqual([
      expect.stringContaining('TGT is a production org'),
      expect.stringContaining('TGT runs automation on the records this removal deletes'),
      expect.stringContaining(
        'may not delete the records of Account (2 records) in TGT: a removal stops before its ' +
          'first delete, unless given --leave-undeletable',
      ),
    ]);
    expect(answer.preview.undeletable).toEqual([{ objectApiName: 'Account', records: 2 }]);
    expect(answer.preview.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      undeletable: 2,
      toDelete: 0,
    });
    // The lines a removal says before its first delete, on stderr with --json.
    expect(stderr).toContain('  Account: before delete: Apex trigger AccountCleanup');
    expect(org.deletes).toEqual([]);
  });

  it('drops a refusal the line lifts: --accept-automation, --leave-undeletable', async () => {
    automationRead.mockResolvedValueOnce({
      objectsRead: ['Account'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    });
    org.undeletable.add('Account');
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    await main(
      argv(
        '--remove',
        file,
        '--target',
        'TGT',
        '--preview',
        '--accept-automation',
        '--leave-undeletable',
        '--json',
      ),
    );

    expect((JSON.parse(stdout) as { refusals: string[] }).refusals).toEqual([]);
  });

  it('counts the records changed since to delete with --include-changed', async () => {
    org.edit('Contact', C2, { Title: 'Changed since' }, COLLEAGUE);

    await main(
      argv('--remove', file, '--target', 'TGT', '--preview', '--include-changed', '--json'),
    );

    const answer = JSON.parse(stdout) as { includeChanged: boolean; preview: SeedRemovalPreview };
    expect(answer.includeChanged).toBe(true);
    expect(answer.preview.objects[0]).toMatchObject({
      objectApiName: 'Contact',
      toDelete: 2,
      keptChanged: 0,
      changedSince: 1,
    });
    expect(org.deletes).toEqual([]);
  });

  it('refuses an org that is not the one the run wrote to, exit 1, reading none of the run', async () => {
    writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'OTHER', '--preview'))).rejects.toThrow(
      'exit 1',
    );

    expect(exit.stderr()).toContain('is not the org the run wrote to');
    expect(org.requests).toBe(0);
  });

  it('answers a run already removed without reaching any org', async () => {
    writeFileSync(
      join(dir, 'seed.removals.json'),
      JSON.stringify({
        version: 1,
        runId: 'env-demo-accounts-1',
        undo: {
          removedAt: '2026-10-01T09:00:00.000Z',
          deleted: 4,
          alreadyGone: 0,
          kept: 0,
          refused: 0,
        },
        removalLeft: [],
      }),
    );
    vi.mocked(makeConn).mockClear();

    await main(argv('--remove', file, '--target', 'TGT', '--preview', '--json'));

    expect(makeConn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      preview: { planned: 0, objects: [] },
      notes: [expect.stringContaining('removed already'), PREVIEW_UNREAD],
    });
  });

  it('says it in lines without --json, who changed what by name, and what it cannot know', async () => {
    org.edit('Contact', C2, { Title: 'Changed since' }, COLLEAGUE);

    await main(argv('--remove', file, '--target', 'TGT', '--preview'));

    expect(stdout).toContain(
      [
        'preview: what a removal would do; nothing was written',
        '  Contact: 1 to delete, 1 kept, changed since the run of 2',
        '      last changed by: A colleague 1',
        '  Account: 2 to delete of 2',
        PREVIEW_UNREAD,
      ].join('\n'),
    );
    expect(org.deletes).toEqual([]);
  });
});

describe('the lines of a preview', () => {
  it('names the records changed since to delete with --include-changed, and every refusal', () => {
    const preview: SeedRemovalPreview = {
      planned: 3,
      objects: [
        {
          objectApiName: 'Contact',
          planned: 3,
          toDelete: 2,
          alreadyGone: 0,
          changedSince: 1,
          keptChanged: 0,
          changedBy: { [COLLEAGUE]: 1 },
          undeletable: 0,
          notVisible: 1,
          unread: 0,
          reasons: ['Not visible: 1 record(s) …'],
        },
      ],
      userNames: {},
    };

    expect(removalPreviewLines(preview, ['TGT is a production org'], ['a note'], true)).toEqual([
      'preview: what a removal would do; nothing was written',
      '  Contact: 2 to delete, 1 of them changed since the run, 1 not visible of 3',
      `      last changed by: ${COLLEAGUE} 1`,
      '      Not visible: 1 record(s) …',
      'a removal would be refused: TGT is a production org',
      'a note',
    ]);
  });
});
