import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import type { AuditLogEntry, ForgeRunVerification } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});
// The removal and the verification are the wizard's own, tested on their own:
// here, what the command records of what they answered.
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/forge/ForgeRunRemoval.js')>();
  return { ...actual, removalOrg: vi.fn(), removeRunRecords: vi.fn() };
});
let verifierAnswer: ForgeRunVerification;
vi.mock('../src/modules/forge/RunVerifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/forge/RunVerifier.js')>();
  return {
    ...actual,
    verifiedOrg: () => ({}),
    RunVerifier: class {
      async verify(): Promise<ForgeRunVerification> {
        return verifierAnswer;
      }
    },
  };
});

import { loadOrg, makeConn } from './sfSession.js';
import { removeRunRecords } from '../src/modules/forge/ForgeRunRemoval.js';
import { AuditTrailStore, auditUserKey } from '../src/modules/audit/auditTrail.js';
import { selectRows, type FakeRow } from '../src/test/fakeSoql.js';
import { fileConfigStore } from './fileConfigStore.js';
import { main, parseArgs } from './sandforge-clone';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const ACCOUNT = '001000000000001AAA';
const CONTACT = '003000000000001AAA';
/** The orgs by their own ids, as their Organization record gives them. */
const SOURCE_ORG = '00D000000000001AAA';
const TARGET_ORG = '00D000000000002AAA';
/** The user both aliases are signed in as. */
const USERNAME = 'ci.user@example.com';

/** A clone of an account from SRC to TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--record',
    ACCOUNT,
    '--source',
    'SRC',
    '--target',
    'TGT',
    '--skip-preflight',
    ...extra,
  ];
}

/** An object as both fake orgs describe it. */
function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
): DescribeSObjectResult {
  return {
    name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false },
      ...fields.map((f) => ({ type: 'string', createable: true, nillable: true, ...f })),
    ].map((f) => ({ referenceTo: [], relationshipName: null, cascadeDelete: false, ...f })),
  } as unknown as DescribeSObjectResult;
}

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }],
    [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ]),
};

const ROWS: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Example' }],
  Contact: [{ Id: CONTACT, LastName: 'Key', AccountId: ACCOUNT }],
};

/** A flow of the target that starts after an account is created. */
const ACCOUNT_WELCOME = {
  ApiName: 'Account_Welcome',
  Label: 'Account welcome',
  TriggerType: 'RecordAfterSave',
  RecordTriggerType: 'Create',
  TriggerObjectOrEvent: { QualifiedApiName: 'Account' },
  ActiveVersionId: null,
};

/**
 * An org holding an account and its contact: `orgId` is its own id,
 * `sandbox` whether its Organization record says it is one, `flows` its
 * record-triggered flows. What it creates is listed in `written`.
 */
function fakeOrg(orgId: string, sandbox = true, flows: unknown[] = []) {
  const written: string[] = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: unknown[]) => {
        written.push(name);
        return records.map((_, i) => ({
          id: `${DESCRIBES[name].keyPrefix}00000000090${i}AAA`,
          success: true,
          errors: [],
        }));
      },
    }),
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: orgId, IsSandbox: sandbox }]);
      }
      if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') {
        return page([{ OrganizationType: 'Enterprise Edition' }]);
      }
      if (soql.includes(" ProcessType = 'Workflow'")) return page([]);
      if (soql.includes(' FROM FlowDefinitionView ')) return page(flows);
      if (soql.includes(' FROM DuplicateRule ')) return page([]);
      if (soql.includes(' FROM UserSetupEntityAccess ')) return page([]);
      if (soql.includes(' FROM RecordType ')) return page([]);
      const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
      if (counted) return { totalSize: (ROWS[counted[1]] ?? []).length, done: true, records: [] };
      // The dates the run reads back of what it wrote.
      if (/ FROM (Account|Contact) WHERE Id IN /.test(soql) && soql.includes('CreatedDate')) {
        return page([]);
      }
      return page(selectRows(ROWS, soql));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
    },
    request: async () => ({}),
    metadata: { read: async () => [] },
  };
  return { conn: conn as unknown as Connection, written };
}

describe('sandforge-clone --audit', () => {
  let dir: string;
  let auditPath: string;
  let stdout: string;
  let stderr: string;
  let orgs: Record<'SRC' | 'TGT', ReturnType<typeof fakeOrg>>;

  /** The two fake orgs answering for the aliases of `argv`. */
  function withOrgs(target = fakeOrg(TARGET_ORG)): void {
    orgs = { SRC: fakeOrg(SOURCE_ORG), TGT: target };
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: USERNAME,
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as 'SRC' | 'TGT'].conn);
  }

  /** Run the command; the exit code it stopped on, if it stopped on one. */
  async function run(args: string[]): Promise<number | undefined> {
    try {
      await main(args);
      return undefined;
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  /** The entries the audit trail in `auditPath` holds, oldest first. */
  const entries = (): AuditLogEntry[] =>
    new AuditTrailStore(fileConfigStore(auditPath)).list().entries.reverse();

  beforeEach(() => {
    vi.mocked(removeRunRecords).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-audit-'));
    auditPath = join(dir, 'clone-audit.json');
    stdout = '';
    stderr = '';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the flag', () => {
    it('takes the file the audit trail is kept in, and none without it', () => {
      expect(parseArgs(argv('--audit', auditPath)).audit).toBe(auditPath);
      expect(parseArgs(argv()).audit).toBeUndefined();
    });

    it('refuses no file, and a file there it cannot add to, before contacting any org', () => {
      expect(() => parseArgs(argv('--audit'))).toThrow(ExitCalled);
      expect(stderr).toContain('--audit wants a value. Nothing was run.');

      writeFileSync(auditPath, 'notes, not a trail', 'utf8');
      stderr = '';
      expect(() => parseArgs(argv('--audit', auditPath))).toThrow(ExitCalled);
      expect(stderr).toContain(`--audit ${auditPath} is not an audit trail the command can add to`);
      expect(readFileSync(auditPath, 'utf8')).toBe('notes, not a trail');
    });
  });

  it('records a clone as the panel does: one forge_execute entry, its objects, the orgs by their ids, the user as a hash', async () => {
    withOrgs();

    expect(await run(argv('--audit', auditPath))).toBeUndefined();

    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
    const [entry, ...more] = entries();
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      action: 'forge_execute',
      module: 'forge',
      orgId: TARGET_ORG,
      orgAlias: 'TGT',
      sourceOrgId: SOURCE_ORG,
      sourceOrgAlias: 'SRC',
      outcome: 'success',
      userId: auditUserKey(USERNAME),
      details: { contactPoints: 'neutralized' },
      context: { anonymized: false, contactPoints: 'neutralized', reviewSkipped: true },
    });
    expect(entry.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', created: 1, failed: 0 }),
      expect.objectContaining({ objectApiName: 'Contact', created: 1, failed: 0 }),
    ]);
    // A hash of the username, never the username.
    expect(readFileSync(auditPath, 'utf8')).not.toContain(USERNAME);
  });

  it('adds the entry of each run to the trail the file holds', async () => {
    withOrgs();
    expect(await run(argv('--audit', auditPath))).toBeUndefined();
    withOrgs();
    expect(await run(argv('--audit', auditPath))).toBeUndefined();

    expect(entries().map((e) => e.action)).toEqual(['forge_execute', 'forge_execute']);
    expect(new Set(entries().map((e) => e.operationId)).size).toBe(2);
  });

  it('records a production target refused stopped, under the gate code, with nothing written', async () => {
    withOrgs(fakeOrg(TARGET_ORG, false));

    expect(await run(argv('--audit', auditPath))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    expect(entries()).toEqual([
      expect.objectContaining({
        action: 'forge_execute',
        orgId: TARGET_ORG,
        outcome: 'stopped',
        objects: [],
        details: { code: 'PRODUCTION_TARGET' },
      }),
    ]);
  });

  it('records a clone stopped for what fires on insert without --accept-automation under its code', async () => {
    withOrgs(fakeOrg(TARGET_ORG, true, [ACCOUNT_WELCOME]));

    expect(await run(argv('--audit', auditPath))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    const [entry] = entries();
    expect(entry).toMatchObject({
      outcome: 'stopped',
      details: { code: 'AUTOMATION_NOT_ACCEPTED' },
      context: { firedOnInsert: expect.objectContaining({ flow: 1 }) },
    });
  });

  it('records what --accept-automation and --accept-emails let through as confirmed, and what was read of the emails', async () => {
    withOrgs(fakeOrg(TARGET_ORG, true, [ACCOUNT_WELCOME]));

    expect(
      await run(argv('--audit', auditPath, '--accept-automation', '--accept-emails')),
    ).toBeUndefined();

    expect(entries()[0]).toMatchObject({
      outcome: 'success',
      context: { confirmed: ['automation', 'emails'], deliverability: 'unread' },
    });
  });

  it('records a clone stopped for the emails it does not accept under its code, what was read beside it', async () => {
    withOrgs(fakeOrg(TARGET_ORG, true, [ACCOUNT_WELCOME]));

    expect(await run(argv('--audit', auditPath, '--accept-automation'))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    expect(entries()[0]).toMatchObject({
      outcome: 'stopped',
      details: { code: 'EMAILS_NOT_ACCEPTED' },
      context: { confirmed: ['automation'], deliverability: 'unread' },
    });
  });

  it('records a clone over --max-total stopped under its code, with nothing written', async () => {
    withOrgs();

    expect(await run(argv('--audit', auditPath, '--max-total', '1'))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    expect(entries()).toEqual([
      expect.objectContaining({ outcome: 'stopped', details: { code: 'MAX_TOTAL_EXCEEDED' } }),
    ]);
  });

  it('names every reason a clone is refused for at its gate under its own code, the others under alsoRefused', async () => {
    // Over --max-total and past the data storage the target has left: the
    // first code alone, a CI job told of one was refused again for the next.
    const target = fakeOrg(TARGET_ORG);
    Object.assign(target.conn, {
      request: async () => ({ DataStorageMB: { Max: 20, Remaining: 0 } }),
    });
    withOrgs(target);

    expect(await run(argv('--audit', auditPath, '--max-total', '1', '--json'))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    expect(stderr).toContain('refused (MAX_TOTAL_EXCEEDED): The run would write');
    expect(stderr).toContain('refused (STORAGE_EXCEEDED): ');
    const answer = JSON.parse(stdout) as {
      refused: { code: string; message: string };
      alsoRefused?: Array<{ code: string; message: string }>;
    };
    expect(answer.refused).toEqual({
      code: 'MAX_TOTAL_EXCEEDED',
      message: expect.stringMatching(/^The run would write .* Nothing was written\.$/) as string,
    });
    expect(answer.refused.message).not.toContain('data storage');
    expect(answer.alsoRefused).toEqual([
      {
        code: 'STORAGE_EXCEEDED',
        message: expect.stringMatching(/data storage.* Nothing was written\.$/) as string,
      },
    ]);
    expect(entries()).toEqual([
      expect.objectContaining({ outcome: 'stopped', details: { code: 'MAX_TOTAL_EXCEEDED' } }),
    ]);
  });

  it('refuses a clone whose files do not fit under its code, says it on stdout, and records it stopped', async () => {
    // A file of 2 KB on the account, and a target with no file storage left.
    const source = fakeOrg(SOURCE_ORG);
    const read = source.conn.query.bind(source.conn);
    const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    Object.assign(source.conn, {
      query: async (soql: string) => {
        if (soql.includes(' FROM ContentDocumentLink ')) {
          return page([
            {
              ContentDocumentId: '069000000000001AAA',
              LinkedEntityId: ACCOUNT,
              ShareType: 'V',
              Visibility: 'AllUsers',
            },
          ]);
        }
        if (soql.includes(' FROM ContentVersion ')) {
          return page([
            {
              Id: '068000000000001AAA',
              ContentDocumentId: '069000000000001AAA',
              Title: 'Spec',
              PathOnClient: 'spec.pdf',
              ContentSize: 2048,
              ContentLocation: 'S',
              SharingPrivacy: 'N',
            },
          ]);
        }
        if (soql.includes(' FROM Attachment ')) return page([]);
        return read(soql);
      },
    });
    const target = fakeOrg(TARGET_ORG);
    Object.assign(target.conn, {
      request: async () => ({ FileStorageMB: { Max: 20, Remaining: 0 } }),
    });
    withOrgs(target);
    orgs.SRC = source;

    expect(await run(argv('--audit', auditPath, '--files', '--json'))).toBe(1);

    expect(orgs.TGT.written).toEqual([]);
    // A sentence with no code on stderr and an empty stdout: a CI job could
    // not tell files too big from a crash.
    expect(stderr).toContain(
      'refused (FILE_STORAGE_EXCEEDED): The files to copy take 2 KB and the target has 0 B ' +
        'of file storage left.',
    );
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-clone',
      source: 'SRC',
      target: 'TGT',
      dryRun: false,
      refused: {
        code: 'FILE_STORAGE_EXCEEDED',
        message: expect.stringMatching(/Nothing was written\.$/) as string,
      },
    });
    expect(entries()).toEqual([
      expect.objectContaining({ outcome: 'stopped', details: { code: 'FILE_STORAGE_EXCEEDED' } }),
    ]);
  });

  /**
   * A target that holds `users`, each with its name and whether it is
   * active, and keeps every statement it is asked; and a source that keeps
   * every one it is asked, and every describe.
   */
  function withUsers(users: Record<string, { Name: string; IsActive: boolean }>) {
    const target = fakeOrg(TARGET_ORG);
    const read = target.conn.query.bind(target.conn);
    const asked: string[] = [];
    Object.assign(target.conn, {
      query: async (soql: string) => {
        asked.push(soql);
        if (!soql.startsWith('SELECT Id, Name, IsActive FROM User WHERE Id IN ('))
          return read(soql);
        const records = Object.entries(users)
          .filter(([id]) => soql.includes(`'${id}'`))
          .map(([Id, user]) => ({ Id, ...user }));
        return { totalSize: records.length, done: true, records };
      },
    });
    withOrgs(target);
    // The source's own Organization record aside, which --audit types it by
    // before anything: the statements and describes discovery sends.
    const sourceRead: string[] = [];
    const source = orgs.SRC.conn as unknown as Record<string, (...args: never[]) => unknown>;
    for (const method of ['query', 'describeGlobal', 'sobject'] as const) {
      const own = source[method]!.bind(source);
      source[method] = ((...args: never[]) => {
        const [first] = args as unknown[];
        if (typeof first !== 'string' || !first.includes(' FROM Organization ')) {
          sourceRead.push(typeof first === 'string' ? first : method);
        }
        return own(...args);
      }) as never;
    }
    return { asked, sourceRead };
  }

  it('refuses an --owner-map to a user the target holds inactive before it writes, names the user and its code, and records the stop', async () => {
    const SOURCE_OWNER = '005000000000001AAA';
    const INACTIVE_USER = '005000000000002AAA';
    const { asked, sourceRead } = withUsers({
      [INACTIVE_USER]: { Name: 'Former Admin', IsActive: false },
    });

    expect(
      await run(
        argv('--audit', auditPath, '--json', '--owner-map', `${SOURCE_OWNER}=${INACTIVE_USER}`),
      ),
    ).toBe(1);

    // Before discovery read the source, and before the target's automation
    // was read: refused at the executor, the clone had printed what the
    // target runs, then said that nothing was read.
    expect(sourceRead).toEqual([]);
    expect(asked.filter((soql) => soql.includes(' FROM FlowDefinitionView '))).toEqual([]);
    expect(orgs.TGT.written).toEqual([]);
    expect(stderr).toContain(
      'refused (OWNER_MAP_INACTIVE): Owners given to users the target holds inactive: ' +
        `Former Admin (${INACTIVE_USER}), given the records of ${SOURCE_OWNER}.`,
    );
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-clone',
      refused: {
        code: 'OWNER_MAP_INACTIVE',
        message: expect.stringMatching(/Nothing was read or written\.$/) as string,
      },
    });
    expect(entries()).toEqual([
      expect.objectContaining({ outcome: 'stopped', details: { code: 'OWNER_MAP_INACTIVE' } }),
    ]);
  });

  it('refuses an --owner-map to a user the target holds no user of before anything is read, naming the id under its own code', async () => {
    const SOURCE_OWNER = '005000000000001AAA';
    const ACTIVE_USER = '005000000000003AAA';
    const UNKNOWN_USER = '005000000000004AAA';
    const { sourceRead } = withUsers({ [ACTIVE_USER]: { Name: 'Current Admin', IsActive: true } });

    expect(
      await run(
        argv('--audit', auditPath, '--json', '--owner-map', `${SOURCE_OWNER}=${UNKNOWN_USER}`),
      ),
    ).toBe(1);

    expect(sourceRead).toEqual([]);
    expect(orgs.TGT.written).toEqual([]);
    expect(stderr).toContain(
      'refused (OWNER_MAP_UNKNOWN): Owners given to users the target does not hold: ' +
        `${UNKNOWN_USER}, given the records of ${SOURCE_OWNER}.`,
    );
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'OWNER_MAP_UNKNOWN' } });
    expect(entries()).toEqual([
      expect.objectContaining({ outcome: 'stopped', details: { code: 'OWNER_MAP_UNKNOWN' } }),
    ]);
  });

  it('refuses a dry run of such a mapping too, before anything is read, and records nothing', async () => {
    const { sourceRead } = withUsers({});

    expect(
      await run(
        argv(
          '--audit',
          auditPath,
          '--dry-run',
          '--owner-map',
          '005000000000001AAA=005000000000004AAA',
        ),
      ),
    ).toBe(1);

    expect(sourceRead).toEqual([]);
    expect(stderr).toContain('refused (OWNER_MAP_UNKNOWN): ');
    expect(existsSync(auditPath)).toBe(false);
  });

  it('runs an --owner-map to a user the target holds active', async () => {
    const ACTIVE_USER = '005000000000003AAA';
    withUsers({ [ACTIVE_USER]: { Name: 'Current Admin', IsActive: true } });

    expect(
      await run(
        argv('--audit', auditPath, '--json', '--owner-map', `005000000000001AAA=${ACTIVE_USER}`),
      ),
    ).toBeUndefined();

    expect(orgs.TGT.written).toContain('Account');
  });

  it('records nothing for a dry run, which writes nothing', async () => {
    withOrgs();

    expect(await run(argv('--audit', auditPath, '--dry-run'))).toBeUndefined();

    expect(existsSync(auditPath)).toBe(false);
  });

  it('creates no file without --audit', async () => {
    withOrgs();

    expect(await run(argv())).toBeUndefined();

    expect(existsSync(auditPath)).toBe(false);
  });

  it('keeps stdout to the JSON summary alone under --json', async () => {
    withOrgs();

    expect(await run(argv('--audit', auditPath, '--json'))).toBeUndefined();

    expect(JSON.parse(stdout)).toMatchObject({ tool: 'sandforge-clone', dryRun: false });
    expect(entries()).toHaveLength(1);
  });

  it('records a removal as cleanup_delete, and a verification as forge_verify', async () => {
    withOrgs();
    const summaryPath = join(dir, 'clone-summary.json');
    expect(await run(argv('--summary', summaryPath))).toBeUndefined();
    vi.mocked(removeRunRecords).mockResolvedValue({
      objects: [
        {
          objectApiName: 'Contact',
          planned: 1,
          deleted: 1,
          alreadyGone: 0,
          keptChanged: 0,
          keptDependents: 0,
          refused: 0,
          heldBy: [],
          unchecked: [],
          reasons: [],
        },
      ],
      cancelled: false,
      gone: ['003000000000900AAA'],
      left: async function* () {},
      stamps: {},
    });
    verifierAnswer = {
      verdict: 'verified',
      attempts: 2,
      objects: [],
    } as unknown as ForgeRunVerification;
    const tail = (...flags: string[]) => ['node', 'sandforge-clone.ts', ...flags];

    expect(
      await run(tail('--verify', summaryPath, '--target', 'TGT', '--audit', auditPath)),
    ).toBeUndefined();
    expect(
      await run(tail('--remove', summaryPath, '--target', 'TGT', '--audit', auditPath)),
    ).toBeUndefined();

    expect(entries()).toEqual([
      expect.objectContaining({
        action: 'forge_verify',
        orgId: TARGET_ORG,
        outcome: 'success',
        verdict: 'verified',
        userId: auditUserKey(USERNAME),
      }),
      expect.objectContaining({
        action: 'cleanup_delete',
        orgId: TARGET_ORG,
        outcome: 'success',
        objects: [expect.objectContaining({ objectApiName: 'Contact', deleted: 1 })],
      }),
    ]);
  });
});
