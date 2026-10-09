import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connection } from 'jsforce';
import type { ForgeRunVerification } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

/** What the verifier was built with and asked. */
const verifierCalls: Array<{ deps: RunVerifierDeps; run: RunToVerify }> = [];
let verifierAnswer: ForgeRunVerification;
// The verification is the wizard's own, tested on its own: here, what the
// command hands it and what it makes of the answer.
vi.mock('../src/modules/forge/RunVerifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/forge/RunVerifier.js')>();
  return {
    ...actual,
    verifiedOrg: (conn: { alias: string }) => ({ org: conn.alias }),
    RunVerifier: class {
      constructor(private readonly deps: RunVerifierDeps) {}
      async verify(run: RunToVerify): Promise<ForgeRunVerification> {
        verifierCalls.push({ deps: this.deps, run });
        return verifierAnswer;
      }
    },
  };
});

import { loadOrg, makeConn } from './sfSession.js';
import type { RunToVerify, RunVerifierDeps } from '../src/modules/forge/RunVerifier.js';
import { main, verificationLines } from './sandforge-clone';

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

/** The org the run wrote to, by its own id. */
const TARGET_ORG = '00D000000000002AAA';

const SRC = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;
const TGT = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The summary a real run printed with `--json`: an account and a contact created, an account linked to. */
function runSummary(
  overrides: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tool: 'sandforge-clone',
    version: 1,
    source: 'SRC',
    target: 'TGT',
    targetOrgId: TARGET_ORG,
    record: SRC('001', 1),
    dryRun: false,
    result: {
      remapTable: {
        [SRC('001', 1)]: TGT('001', 1),
        [SRC('003', 1)]: TGT('003', 1),
        [SRC('001', 2)]: TGT('001', 2),
      },
      existingSourceIds: [SRC('001', 2)],
      updatedSourceIds: [],
      createdByObject: [
        { objectApiName: 'Account', sourceIds: [SRC('001', 1)] },
        { objectApiName: 'Contact', sourceIds: [SRC('003', 1)] },
      ],
      writtenBetween: { first: '2026-10-01T10:00:00.000Z', last: '2026-10-01T10:00:05.000Z' },
      writtenWithoutFields: [
        {
          objectApiName: 'Contact',
          rows: 1,
          fields: [{ field: 'ReportsToId', refusedBy: 'lookup-filter' }],
        },
      ],
      ...result,
    },
    elapsedMs: 9_000,
    finishedAt: '2026-10-01T10:00:06.000Z',
    ...overrides,
  };
}

/** A verification that found everything as the run wrote it. */
function verification(overrides: Partial<ForgeRunVerification> = {}): ForgeRunVerification {
  return {
    verdict: 'verified',
    verifiedAt: '2026-10-01T11:00:00.000Z',
    attempts: 2,
    objects: [
      {
        objectApiName: 'Contact',
        expected: 1,
        present: 1,
        deleted: 0,
        notVisible: 0,
        changed: 0,
        changedRecords: [],
        deletedIds: [],
        notVisibleIds: [],
        linksChecked: 1,
        linksBroken: 0,
        brokenLinks: [],
      },
    ],
    ...overrides,
  };
}

describe('sandforge-clone --verify', () => {
  let dir: string;
  let printed: string[];
  let stdout: string[];
  let stderr: string[];
  let organization: { Id: string; IsSandbox: boolean };
  let unreachable: Set<string>;

  function file(content: unknown, name = 'clone-summary.json'): string {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    return path;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    verifierCalls.length = 0;
    verifierAnswer = verification();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-verify-'));
    printed = [];
    stdout = [];
    stderr = [];
    organization = { Id: TARGET_ORG, IsSandbox: true };
    unreachable = new Set();
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.mocked(loadOrg).mockImplementation(async (alias) => {
      if (unreachable.has(alias))
        throw new Error(`No authorization information found for ${alias}.`);
      return {
        alias,
        username: '',
        instanceUrl: `https://${alias.toLowerCase()}.example.com`,
        accessToken: 'token',
      };
    });
    vi.mocked(makeConn).mockImplementation(
      (org) =>
        ({
          alias: org.alias,
          query: vi.fn(async () => ({ totalSize: 1, done: true, records: [organization] })),
        }) as unknown as Connection,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('its command line', () => {
    it.each([
      ['no org', ['--verify', 'clone-summary.json']],
      ['no summary', ['--verify', '--target', 'TGT']],
      ['a source with no alias', ['--verify', 'clone-summary.json', '--target', 'TGT', '--source']],
      [
        'a flag of a removal',
        ['--verify', 'clone-summary.json', '--target', 'TGT', '--include-changed'],
      ],
      ['a flag of the clone', ['--verify', 'clone-summary.json', '--target', 'TGT', '--dry-run']],
      [
        '--remove beside it',
        ['--verify', 'clone-summary.json', '--target', 'TGT', '--remove', 'x.json'],
      ],
    ])('exits 2 on %s, before anything is read', async (_label, args) => {
      expect(await run(args)).toBe(2);
      expect(loadOrg).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain('--verify takes');
    });
  });

  describe('the summary it reads', () => {
    it("refuses a dry run's summary, which wrote nothing, before contacting any org", async () => {
      const path = file(runSummary({ dryRun: true }, { createdByObject: [] }));
      expect(await run(['--verify', path, '--target', 'TGT'])).toBe(2);
      expect(stderr.join('')).toContain(
        `--verify ${path} is the summary of a dry run, which wrote nothing to the target: ` +
          'there is nothing of it to verify.',
      );
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses a file that is not a summary of the command', async () => {
      expect(await run(['--verify', file({ tool: 'sandforge-frozen' }), '--target', 'TGT'])).toBe(
        2,
      );
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses another alias than the one a summary without the org id names', async () => {
      const path = file(runSummary({ targetOrgId: undefined }));
      expect(await run(['--verify', path, '--target', 'OTHER'])).toBe(2);
      expect(stderr.join('')).toContain('give --target TGT');
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses an org that is not the one the run wrote to, before reading a record', async () => {
      organization = { Id: '00D000000000009AAA', IsSandbox: true };
      expect(await run(['--verify', file(runSummary()), '--target', 'TGT'])).toBe(1);
      expect(stderr.join('')).toContain('is not the org the run wrote to');
      expect(verifierCalls).toEqual([]);
    });
  });

  describe('the verification', () => {
    it('reads back the records the run created, dated as the target dated the run, against the summary’s source', async () => {
      expect(await run(['--verify', file(runSummary()), '--target', 'TGT'])).toBeUndefined();

      expect(verifierCalls).toHaveLength(1);
      const [{ deps, run: verified }] = verifierCalls;
      expect(deps).toEqual({ target: { org: 'TGT' }, source: { org: 'SRC' } });
      expect(verified.records).toEqual([
        { objectApiName: 'Contact', ids: [TGT('003', 1)] },
        { objectApiName: 'Account', ids: [TGT('001', 1)] },
      ]);
      expect(verified.runEndedAt).toEqual(new Date('2026-10-01T10:00:05.000Z'));
      expect(verified.writtenWithout).toEqual({ Contact: ['ReportsToId'] });
      expect(printed).toContain('verification: VERIFIED (2 readings of TGT)');
    });

    it('reads the source records in the org --source names', async () => {
      await run(['--verify', file(runSummary()), '--target', 'TGT', '--source', 'UAT-COPY']);
      expect(verifierCalls[0].deps.source).toEqual({ org: 'UAT-COPY' });
    });

    it('verifies without the lookups when the source cannot be reached, and says why', async () => {
      unreachable.add('SRC');
      expect(await run(['--verify', file(runSummary()), '--target', 'TGT'])).toBeUndefined();
      expect(verifierCalls[0].deps.source).toEqual({
        unavailable:
          'the org the run read from, SRC, could not be reached: No authorization information found for SRC.',
      });
    });

    it('dates a run the target did not date by when it ended', async () => {
      await run([
        '--verify',
        file(runSummary({}, { writtenBetween: undefined })),
        '--target',
        'TGT',
      ]);
      expect(verifierCalls[0].run.runEndedAt).toBeUndefined();
      expect(verifierCalls[0].run.runRecordedAt).toEqual(new Date('2026-10-01T10:00:06.000Z'));
    });

    it('takes what an earlier removal of the summary kept beside it as no change since the run', async () => {
      const path = file(runSummary());
      const stamps = { [TGT('001', 1)]: '2026-10-01T11:00:07.000+0000' };
      const { runKey } = await import('./sandforge-clone.js');
      file(
        {
          tool: 'sandforge-clone',
          version: 1,
          run: runKey([
            { objectApiName: 'Contact', ids: [TGT('003', 1)] },
            { objectApiName: 'Account', ids: [TGT('001', 1)] },
          ]),
          removalStamps: stamps,
          removalSpans: [],
        },
        'clone-summary.removals.json',
      );
      await run(['--verify', path, '--target', 'TGT']);
      expect(verifierCalls[0].run.removalStamps).toEqual(stamps);
    });

    it('looks only for the records an earlier --remove of the summary left, and for none when it took them all', async () => {
      // They read as missing: the verification looked for records the
      // removal had deleted, where the panel looks for what is left.
      const path = file(runSummary());
      const { runKey } = await import('./sandforge-clone.js');
      const key = runKey([
        { objectApiName: 'Contact', ids: [TGT('003', 1)] },
        { objectApiName: 'Account', ids: [TGT('001', 1)] },
      ]);
      const removals = (removalLeft: string[]) =>
        file(
          {
            tool: 'sandforge-clone',
            version: 1,
            run: key,
            removalStamps: {},
            removalSpans: [],
            removalLeft,
          },
          'clone-summary.removals.json',
        );

      removals([TGT('001', 1)]);
      await run(['--verify', path, '--target', 'TGT']);
      expect(verifierCalls[0].run.records).toEqual([
        { objectApiName: 'Account', ids: [TGT('001', 1)] },
      ]);

      verifierCalls.length = 0;
      removals([]);
      expect(await run(['--verify', path, '--target', 'TGT'])).toBeUndefined();
      expect(verifierCalls).toEqual([]);
      expect(printed).toContain(
        'An earlier --remove of this summary took every record the run created: there is nothing of it to verify.',
      );
    });

    it.each([
      ['partial', 3],
      ['unstable', 4],
    ] as const)('exits %s with %i', async (verdict, code) => {
      verifierAnswer = verification({ verdict });
      expect(await run(['--verify', file(runSummary()), '--target', 'TGT'])).toBe(code);
    });

    it('prints the verification as JSON alone on stdout under --json, every other line on stderr', async () => {
      verifierAnswer = verification({ verdict: 'partial' });
      expect(await run(['--verify', file(runSummary()), '--target', 'TGT', '--json'])).toBe(3);
      const out = JSON.parse(stdout.join('')) as Record<string, unknown>;
      expect(out).toMatchObject({
        tool: 'sandforge-clone',
        action: 'verify',
        target: 'TGT',
        targetOrgId: TARGET_ORG,
        source: 'SRC',
        result: verifierAnswer,
      });
      expect(printed).toEqual([]);
    });

    it('verifies nothing of a run that created no record', async () => {
      expect(
        await run(['--verify', file(runSummary({}, { createdByObject: [] })), '--target', 'TGT']),
      ).toBeUndefined();
      expect(verifierCalls).toEqual([]);
      expect(printed).toContain('The run created no record: there is nothing of it to verify.');
    });
  });
});

describe('sandforge-clone verification lines', () => {
  it('names what is not there, each lookup that does not hold, and the records changed since the run', () => {
    const lines = verificationLines(
      {
        verdict: 'partial',
        verifiedAt: '2026-10-01T11:00:00.000Z',
        attempts: 2,
        objects: [
          {
            objectApiName: 'Contact',
            expected: 3,
            present: 1,
            deleted: 1,
            notVisible: 1,
            changed: 1,
            changedRecords: [
              {
                recordId: TGT('003', 1),
                modifiedAt: '2026-10-01T10:30:00.000+0000',
                modifiedById: '005000000000002AAA',
              },
            ],
            deletedIds: [TGT('003', 2)],
            notVisibleIds: [TGT('003', 3)],
            linksChecked: 2,
            linksBroken: 2,
            brokenLinks: [
              {
                recordId: TGT('003', 1),
                field: 'AccountId',
                expected: TGT('001', 1),
                found: TGT('001', 7),
              },
              {
                recordId: TGT('003', 1),
                field: 'ReportsToId',
                expected: TGT('003', 9),
                found: null,
              },
            ],
          },
          {
            objectApiName: 'Invoice__c',
            expected: 1,
            present: 0,
            deleted: 0,
            notVisible: 0,
            changed: 0,
            changedRecords: [],
            deletedIds: [],
            notVisibleIds: [],
            linksChecked: 0,
            linksBroken: 0,
            brokenLinks: [],
            error: "INVALID_TYPE: sObject type 'Invoice__c' is not supported.",
          },
        ],
        linksUnchecked: undefined,
      },
      'TGT',
    );
    expect(lines).toEqual([
      'verification: PARTIAL (2 readings of TGT)',
      '  Contact: 1 of 3 there, 1 in the recycle bin, 1 neither there nor in the recycle bin, out of sight; lookups: 2 checked, 2 do not hold',
      `      ${TGT('003', 1)}: AccountId points at ${TGT('001', 7)}, the run set it to ${TGT('001', 1)}`,
      `      ${TGT('003', 1)}: ReportsToId is empty, the run set it to ${TGT('003', 9)}`,
      "  Invoice__c: not read (INVALID_TYPE: sObject type 'Invoice__c' is not supported.)",
      'changed since the run: 1 record(s), which --remove keeps unless --include-changed',
      `      Contact ${TGT('003', 1)}: modified 2026-10-01T10:30:00.000+0000 by 005000000000002AAA`,
    ]);
  });

  it('says an unstable verification as one to run again, and the lookups it could not check', () => {
    const lines = verificationLines(
      verification({ verdict: 'unstable', attempts: 3, linksUnchecked: 'not kept' }),
      'TGT',
    );
    expect(lines[0]).toBe(
      "verification: UNSTABLE — no two of 3 readings of TGT agreed: something still writes to the run's records; verify again once it is done",
    );
    expect(lines.at(-1)).toBe('lookups not checked: not kept');
  });
});
