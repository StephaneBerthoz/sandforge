import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import { main } from './sandforge-clone';
import { nodeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import {
  forgeRunLockFileOf,
  forgeRunWriting,
  lockForgeRun,
  type ForgeRunLockHolder,
} from '../src/modules/forge/ForgeRunLock.js';
import type { LockSelf } from '../src/modules/checkpoint/linkedLock.js';
import {
  ROWS,
  TARGET_ORG,
  rootsSource,
  sourceConn,
  targetConn,
  type TargetCreate,
} from './testing/cloneRootsWorld.js';

/*
 * The lock a clone holds on its journal while it writes, as the command line
 * takes it and reads it: a run takes it as it begins its journal and lets it
 * go once its part has ended; a removal of the run, or its preview, and a run
 * that would take the same journal up are refused while another process
 * holds it, naming the run, before any org is reached.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** Run the command and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(['node', 'sandforge-clone.ts', ...args]);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

/** Another process of this machine, alive — the one that started the tests — writing a run. */
const ANOTHER_RUN: LockSelf = {
  host: hostname(),
  pid: process.ppid,
  startedAt: new Date().toISOString(),
};

/** A process of this machine that started before it did: gone, whatever holds its id now. */
const A_RUN_BEFORE_THE_BOOT: LockSelf = {
  host: hostname(),
  pid: process.ppid,
  startedAt: '2000-01-01T00:00:00.000Z',
};

const JOURNAL_ID = 'sandforge-clone-2026-11-20T01-30-00-000Z-0a1b2c3d';

let stdout: string[];
let stderr: string[];
let printed: string[];
let journalDir: string;
let held: Array<{ release(): void }>;

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  printed = [];
  held = [];
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-clone-lock-'));
  vi.stubEnv('SANDFORGE_JOURNAL_DIR', journalDir);
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    stderr.push(`${String(line)}\n`);
  });
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('sf org display reached');
  });
  vi.mocked(loadOrg).mockRejectedValue(new Error('an org was reached'));
});

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(journalDir, { recursive: true, force: true });
});

/** The journal of a run that began writing to the target, its part not ended. */
async function aJournal(): Promise<string> {
  const journals = nodeRunJournal(journalDir);
  await journals.begin(JOURNAL_ID, TARGET_ORG, new Date('2026-11-20T01:30:00.000Z'), {
    sourceOrgId: 'SRC',
    fingerprint: 'f',
    targetSalesforceOrgId: TARGET_ORG,
    recordId: ROWS.energyOne,
  });
  return journals.pathOf(JOURNAL_ID);
}

/** The summary a run writes as it goes (`--summary`), naming its journal. */
function aSummaryOf(journal: string): string {
  const file = join(journalDir, 'run.summary.json');
  writeFileSync(
    file,
    JSON.stringify({
      tool: 'sandforge-clone',
      version: 1,
      source: 'SRC',
      target: 'TGT',
      targetOrgId: TARGET_ORG,
      record: ROWS.energyOne,
      dryRun: false,
      running: true,
      elapsedMs: 1_000,
      journal,
      part: 0,
      result: {
        successCount: 0,
        remapTable: {},
        existingSourceIds: [],
        updatedSourceIds: [],
        createdByObject: [],
      },
    }),
  );
  return file;
}

/** Hold the lock of `journal` as `self` does, for the test's length. */
function writtenBy(journal: string, self: LockSelf, target = 'TGT'): void {
  const taken = lockForgeRun(
    journal,
    { journalId: JOURNAL_ID, ranFrom: 'commandLine', target },
    { self },
  );
  if (!('lock' in taken)) throw new Error('the lock was not taken');
  held.push(taken.lock);
}

describe('a removal of a run that still writes its journal', () => {
  it.each([
    ['its summary', (journal: string) => aSummaryOf(journal)],
    ['its journal', (journal: string) => journal],
  ])('is refused by %s, the run named, before any org is reached', async (_label, named) => {
    const journal = await aJournal();
    writtenBy(journal, ANOTHER_RUN);

    expect(await run(['--remove', named(journal), '--target', 'TGT', '--json'])).toBe(1);

    const said = stderr.join('');
    expect(said).toContain('refused (RUN_WRITING)');
    expect(said).toContain(`the run ${JOURNAL_ID} still writes this journal`);
    expect(said).toContain(`process ${ANOTHER_RUN.pid} on ${ANOTHER_RUN.host}`);
    expect(said).toContain('Ctrl-C in the terminal it runs in');
    expect(said).toContain('Nothing was read or deleted.');
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      tool: 'sandforge-clone',
      refused: { code: 'RUN_WRITING' },
    });
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('is refused for its preview too, which would say a removal of what is still written', async () => {
    const journal = await aJournal();
    writtenBy(journal, ANOTHER_RUN);

    expect(await run(['--remove', aSummaryOf(journal), '--target', 'TGT', '--preview'])).toBe(1);

    expect(stderr.join('')).toContain('refused (RUN_WRITING)');
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('goes on once the run let its journal go, or when its process is gone', async () => {
    const journal = await aJournal();
    writtenBy(journal, ANOTHER_RUN);
    held.splice(0).forEach((lock) => lock.release());

    expect(await run(['--remove', journal, '--target', 'TGT'])).toBeUndefined();
    expect(printed.join('\n')).toContain('there is nothing of it to remove');

    printed = [];
    writtenBy(journal, A_RUN_BEFORE_THE_BOOT);
    expect(await run(['--remove', journal, '--target', 'TGT'])).toBeUndefined();
    expect(printed.join('\n')).toContain('there is nothing of it to remove');
    expect(stderr.join('')).not.toContain('RUN_WRITING');
  });
});

describe('a removal, which holds the lock of the run’s journal while it deletes', () => {
  /** The journal of a run that created one account, its part not ended. */
  async function aJournalThatCreated(): Promise<string> {
    const journal = await aJournal();
    const store = nodeRunJournal(journalDir).openAt(journal);
    store.beginPart(new Date('2026-11-20T01:30:00.000Z'));
    store.setMapping('created', ROWS.energyOne, '001T00000000001AAA', 'Account');
    store.flush();
    store.close();
    return journal;
  }

  it('takes it before it reaches the org, as a removal, and lets it go once it ends', async () => {
    const journal = await aJournalThatCreated();
    const whileReaching: Array<ForgeRunLockHolder | undefined> = [];
    vi.mocked(loadOrg).mockImplementation(async () => {
      whileReaching.push(forgeRunWriting(journal));
      throw new Error('an org was reached');
    });

    await run(['--remove', journal, '--target', 'TGT']);

    expect(whileReaching).not.toEqual([]);
    for (const holder of whileReaching) {
      expect(holder).toMatchObject({
        journalId: JOURNAL_ID,
        ranFrom: 'commandLine',
        target: 'TGT',
        removes: true,
        pid: process.pid,
      });
    }
    expect(forgeRunWriting(journal)).toBeUndefined();
    expect(existsSync(forgeRunLockFileOf(journal))).toBe(false);
  });

  it('refuses a --resume given while it deletes, naming the removal, and nothing is written', async () => {
    const target = withOrgsOf();
    const journal = await aJournal();
    const before = readFileSync(journal, 'utf8');
    const removal = lockForgeRun(
      journal,
      { journalId: JOURNAL_ID, ranFrom: 'commandLine', target: 'TGT', removes: true },
      { self: ANOTHER_RUN },
    );
    if (!('lock' in removal)) throw new Error('the lock was not taken');
    held.push(removal.lock);

    expect(
      await run([
        '--record',
        ROWS.energyOne,
        '--source',
        'SRC',
        '--target',
        'TGT',
        '--skip-preflight',
        '--resume',
        journal,
      ]),
    ).toBe(1);

    const said = stderr.join('');
    expect(said).toContain(
      `refused (RUN_WRITING): --resume ${journal}: a removal of the run ${JOURNAL_ID} deletes ` +
        'what it wrote from TGT: started from the command line',
    );
    expect(said).toContain(`process ${ANOTHER_RUN.pid} on ${ANOTHER_RUN.host}`);
    expect(readFileSync(journal, 'utf8')).toBe(before);
    expect(target.creates).toEqual([]);
  });

  it('is refused while another removal deletes the same run’s records', async () => {
    const journal = await aJournalThatCreated();
    const removal = lockForgeRun(
      journal,
      { journalId: JOURNAL_ID, ranFrom: 'editor', removes: true },
      { self: ANOTHER_RUN },
    );
    if (!('lock' in removal)) throw new Error('the lock was not taken');
    held.push(removal.lock);

    expect(await run(['--remove', journal, '--target', 'TGT'])).toBe(1);

    const said = stderr.join('');
    expect(said).toContain('refused (RUN_WRITING)');
    expect(said).toContain(`a removal of the run ${JOURNAL_ID} deletes what it wrote`);
    expect(said).toContain('let it end on the Forge page that removes it');
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

/** Both orgs answering for SRC and TGT, as a clone that writes reaches them. */
function withOrgsOf(): ReturnType<typeof targetConn> {
  const target = targetConn();
  const conns = { SRC: sourceConn(rootsSource()), TGT: target.conn };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return target;
}

describe('a clone that writes', () => {
  /** Both orgs answering for SRC and TGT; `onCreate` hears each call to the target. */
  function withOrgs(onCreate?: (call: TargetCreate) => void) {
    const target = targetConn(onCreate);
    const conns = { SRC: sourceConn(rootsSource()), TGT: target.conn };
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
    return target;
  }

  /** The journals of the runs, by their file. */
  const journalsWritten = (): string[] => {
    const dir = join(journalDir, 'forge-runs');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith('.ndjson'))
          .map((name) => join(dir, name))
      : [];
  };

  it('holds the lock of its journal while it writes, and lets it go once its part ended', async () => {
    const writing: Array<ForgeRunLockHolder | undefined> = [];
    const target = withOrgs(() => {
      const [journal] = journalsWritten();
      writing.push(journal !== undefined ? forgeRunWriting(journal) : undefined);
    });

    expect(
      await run([
        '--record',
        ROWS.energyOne,
        '--source',
        'SRC',
        '--target',
        'TGT',
        '--skip-preflight',
        '--json',
      ]),
    ).toBeUndefined();

    expect(target.creates.length).toBeGreaterThan(0);
    const [journal] = journalsWritten();
    if (journal === undefined) throw new Error('the run wrote no journal');
    expect(writing.length).toBe(target.creates.length);
    for (const holder of writing) {
      expect(holder).toMatchObject({
        journalId: journal.replace(/^.*[\\/]/, '').replace(/\.ndjson$/, ''),
        ranFrom: 'commandLine',
        target: 'TGT',
        pid: process.pid,
      });
    }
    expect(existsSync(forgeRunLockFileOf(journal))).toBe(false);
    expect(forgeRunWriting(journal)).toBeUndefined();
  });

  it('refuses to take up a journal another run still writes, and writes nothing to it', async () => {
    const target = withOrgs();
    const journal = await aJournal();
    const before = readFileSync(journal, 'utf8');
    writtenBy(journal, ANOTHER_RUN, 'Sandbox UAT');

    expect(
      await run([
        '--record',
        ROWS.energyOne,
        '--source',
        'SRC',
        '--target',
        'TGT',
        '--skip-preflight',
        '--resume',
        journal,
      ]),
    ).toBe(1);

    const said = stderr.join('');
    expect(said).toContain(`refused (RUN_WRITING): --resume ${journal}: the run ${JOURNAL_ID}`);
    expect(said).toContain('to Sandbox UAT');
    expect(said).toContain('Two runs would write it at once');
    expect(readFileSync(journal, 'utf8')).toBe(before);
    expect(target.creates).toEqual([]);
  });
});
