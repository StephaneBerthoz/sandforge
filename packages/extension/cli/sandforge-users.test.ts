import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
  usersRemoveAnswerSchema,
  type UsersConfig,
} from '@sandforge/shared';

/** What the org runs as users are written: nothing, unless a test says. */
const orgRuns = vi.hoisted(() => ({
  objects: [] as unknown[],
  unread: [] as unknown[],
  /** The objects each read was asked for, in order. */
  asked: [] as string[][],
  throws: undefined as Error | undefined,
}));

// What the org runs on the users a run writes, as Forge reads it: nothing,
// as an org with no flow or trigger on User answers, unless a test says.
vi.mock('../src/modules/forge/TargetAutomationReader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/forge/TargetAutomationReader.js')>()),
  TargetAutomationReader: class {
    read(_org: string, objects: readonly string[]) {
      orgRuns.asked.push([...objects]);
      if (orgRuns.throws) return Promise.reject(orgRuns.throws);
      return Promise.resolve({
        objectsRead: [...objects],
        objects: orgRuns.objects,
        unread: orgRuns.unread,
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 2,
      });
    }
  },
}));
// The session is the test's: no sf is run.
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import type { Connection } from 'jsforce';
import { EMAIL_NOT_PERMITTED } from '../src/modules/forge/targetDeliverability.js';
import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type UsersTestOrg,
  type UsersTestOrgSetup,
} from '../src/modules/users/usersOrg.fixtures.js';
import { UsersRunStore } from '../src/modules/users/usersRunStore.js';
import { commandOf } from './invocation.js';
import { loadOrg, makeConn, type SfOrg } from './sfSession.js';
import { HELP, main } from './sandforge-users.js';

/*
 * sandforge users: the users of a scratch org, a Developer Edition org or a
 * sandbox set up as a config asks — what `sandforge env` hands it for a
 * users resource — planned, applied and taken back by run. The org is a
 * miniature one that refuses what a scratch org refused when asked
 * (`usersOrg.fixtures.ts`), reached through the connection a run holds; the
 * Organization record, the deliverability's line of Apex and what runs on
 * User are answered beside it.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** The testers of the design's file, by their production usernames. */
const TESTERS: UsersConfig = {
  users: [
    {
      username: 'jane.qa@acme.com',
      email: 'restore',
      frozen: false,
      permissionSets: ['QA_Tools'],
      groups: ['QA_Team'],
    },
    {
      username: 'paul.qa@acme.com',
      active: true,
      profile: 'QA Tester',
      permissionSetGroups: ['Support_Bundle'],
    },
    { username: 'erp.integration@acme.com', email: 'keep', frozen: true },
  ],
};

/** What the Organization record says of the org. */
interface OrgKind {
  IsSandbox: boolean;
  OrganizationType?: string;
  /** sf shows a scratch org: `org display` names its Dev Hub. */
  scratch?: true;
  /** The Organization record cannot be read. */
  unreadable?: true;
}

const SANDBOX: OrgKind = { IsSandbox: true };

/** The org a test reaches, and what it was asked beside the users. */
interface Reached {
  org: UsersTestOrg;
  /** The statements of the Organization record, in order. */
  organization: string[];
  /** The requests sent past the queries: the deliverability's. */
  requests: string[];
  identity: ReturnType<typeof vi.fn>;
}

/**
 * Point the session at a miniature org: `loadOrg` gives its alias, `makeConn`
 * its connection, which answers the Organization record as `kind` says and
 * the line of Apex of the deliverability as `deliverability` says.
 */
function reach(
  setup: UsersTestOrgSetup,
  kind: OrgKind = SANDBOX,
  deliverability: 'open' | 'closed' = 'closed',
): Reached {
  const org = usersTestOrg(setup);
  const organization: string[] = [];
  const requests: string[] = [];
  const identity = vi.fn(org.connection.identity);
  const conn = {
    ...org.connection,
    identity,
    query: (soql: string) => {
      if (/FROM Organization\b/.test(soql)) {
        organization.push(soql);
        if (kind.unreadable) {
          return Promise.reject(
            Object.assign(new Error("sObject type 'Organization' is not supported."), {
              errorCode: 'INVALID_TYPE',
            }),
          );
        }
        const row = soql.includes('IsSandbox')
          ? { Id: org.organizationId, IsSandbox: kind.IsSandbox }
          : { OrganizationType: kind.OrganizationType };
        return Promise.resolve({ records: [row], done: true, totalSize: 1 });
      }
      return org.connection.query(soql);
    },
    request: ({ url }: { url: string }) => {
      requests.push(url);
      if (url.startsWith('/tooling/executeAnonymous')) {
        return Promise.resolve(
          deliverability === 'open'
            ? { compiled: true, success: true }
            : { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED },
        );
      }
      if (url.startsWith('/query?q=')) {
        return Promise.resolve({ records: [{ PermissionsEmailSingle: true }] });
      }
      return Promise.reject(new Error(`not a request of this test: ${url}`));
    },
  };
  const sfOrg: SfOrg = {
    alias: 'uat',
    username: 'admin@acme.com.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    accessToken: 'not-a-token',
    ...(kind.scratch ? { scratch: true as const } : {}),
  };
  vi.mocked(loadOrg).mockResolvedValue(sfOrg);
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return { org, organization, requests, identity };
}

const dirs: string[] = [];

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A config written to a file of its own, as `sandforge env` writes one. */
function configFile(config: unknown = TESTERS): string {
  const file = join(folder('sandforge-users-config-'), 'testers.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}

let stdout = '';
let stderr = '';
let journal = '';

beforeEach(() => {
  vi.mocked(loadOrg).mockReset();
  vi.mocked(makeConn).mockReset();
  vi.mocked(loadOrg).mockRejectedValue(new Error('no org of this test'));
  orgRuns.objects = [];
  orgRuns.unread = [];
  orgRuns.asked = [];
  orgRuns.throws = undefined;
  stdout = '';
  stderr = '';
  journal = folder('sandforge-users-journal-');
  vi.stubEnv('SANDFORGE_JOURNAL_DIR', journal);
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the command with `words` after its name: the code it ended on. */
async function run(...words: string[]): Promise<number> {
  stdout = '';
  stderr = '';
  try {
    await main(['node', 'sandforge-users.ts', ...words]);
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code ?? 0;
    throw err;
  } finally {
    // Read below, then cleared for the next run of the same test.
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return code;
}

/** What stdout carried: the answer, alone. */
function answer(): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('the line', () => {
  it('answers --help with the whole help, exit 0, from any verb, having reached nothing', async () => {
    for (const words of [['--help'], ['plan', '--help'], ['remove', '-h']]) {
      expect(await run(...words)).toBe(0);
      expect(stdout).toBe(HELP);
    }
    expect(loadOrg).not.toHaveBeenCalled();
    expect(HELP.startsWith('sandforge users — ')).toBe(true);
    for (const said of [
      'pnpm exec tsx packages/extension/cli/sandforge-users.ts plan --org <alias> --config <file.json>',
      'remove --org <alias> --run <n>',
      'sandforge env',
      '--accept-user-emails',
      '--accept-emails',
      '--accept-automation',
      '--replaces <n>',
      '--include-changed',
      '--dry-run',
      'USERS_EMAILS_NOT_ACCEPTED',
      'USERS_EMAILS_OPEN',
      'USERS_LICENSE',
      'USERS_SELF',
      'AUTOMATION_NOT_ACCEPTED',
      'USERS_RUN_NOT_FOUND',
      'Forgot your password?',
      'Exit codes:',
    ]) {
      expect(HELP, said).toContain(said);
    }
    // No line of it names the command by a name only a global install has.
    expect(HELP).not.toMatch(/(?:^|\s)sandforge-users\s/m);
  });

  it.each([
    ['no verb', []],
    ['a word that is no verb', ['deploy', '--org', 'uat']],
    ['a flag first', ['--no-such-flag']],
    ['a flag it does not read', ['plan', '--org', 'uat', '--config', 'x.json', '--force']],
    ['a plan without its config', ['plan', '--org', 'uat']],
    ['an apply without its org', ['apply', '--config', 'x.json', '--yes']],
    ['a removal without its run', ['remove', '--org', 'uat', '--yes']],
    ['a run that is no number', ['remove', '--org', 'uat', '--run', 'last']],
    ['a run of zero', ['remove', '--org', 'uat', '--run', '0']],
    ['a plan given a run', ['plan', '--org', 'uat', '--config', 'x.json', '--run', '2']],
    ['a plan told --yes', ['plan', '--org', 'uat', '--config', 'x.json', '--yes']],
    ['a plan told --dry-run', ['plan', '--org', 'uat', '--config', 'x.json', '--dry-run']],
    ['a removal given a config', ['remove', '--org', 'uat', '--run', '1', '--config', 'x.json']],
    [
      'a removal told to accept emails',
      ['remove', '--org', 'uat', '--run', '1', '--accept-user-emails'],
    ],
    [
      'an apply told --include-changed',
      ['apply', '--org', 'uat', '--config', 'x', '--include-changed'],
    ],
    ['an org no alias can be', ['plan', '--org', 'uat&dir', '--config', 'x.json']],
  ])('refuses %s, exit 2, before any org is reached', async (_label, words) => {
    expect(await run(...words)).toBe(2);
    expect(stderr).toMatch(/Nothing was run\./);
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('refuses a config it cannot read or the contract refuses, exit 2, naming where, before any org', async () => {
    expect(await run('plan', '--org', 'uat', '--config', join(journal, 'none.json'))).toBe(2);
    expect(stderr).toContain('could not be read');

    const twice = configFile({
      users: [{ username: 'jane.qa@acme.com' }, { username: 'JANE.QA@acme.com' }],
    });
    expect(await run('plan', '--org', 'uat', '--config', twice)).toBe(2);
    expect(stderr).toContain(
      'users[1].username: JANE.QA@acme.com is listed twice (also users[0]): one entry per user',
    );

    const password = configFile({ users: [{ username: 'jane.qa@acme.com', login: 'reset' }] });
    expect(await run('plan', '--org', 'uat', '--config', password)).toBe(2);
    expect(stderr).toContain('"login" is not a key of a user');

    const notJson = configFile();
    writeFileSync(notJson, 'users: [jane]');
    expect(await run('plan', '--org', 'uat', '--config', notJson)).toBe(2);
    expect(stderr).toContain('is not JSON');
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

describe('the org', () => {
  it.each([
    ['plan', ['plan', '--org', 'uat', '--config', '<config>', '--json']],
    ['apply', ['apply', '--org', 'uat', '--config', '<config>', '--yes', '--accept-user-emails']],
    ['remove', ['remove', '--org', 'uat', '--run', '1', '--yes']],
  ])(
    'refuses a production org on %s, exit 1, having read nothing of its users',
    async (_verb, words) => {
      const { org, organization, identity } = reach(acmeSetup(), {
        IsSandbox: false,
        OrganizationType: 'Enterprise Edition',
      });
      const line = words.map((word) => (word === '<config>' ? configFile() : word));

      expect(await run(...line)).toBe(1);
      expect(stderr).toContain(
        'uat is a production org (its Organization record says IsSandbox false, edition ' +
          'Enterprise Edition)',
      );
      expect(stderr).toContain('Nothing was read or written.');
      expect(stdout).toBe('');
      // The Organization record alone: no user, no identity, no write.
      expect(organization).toHaveLength(2);
      expect(org.queries).toEqual([]);
      expect(identity).not.toHaveBeenCalled();
      expect(org.writes).toEqual([]);
    },
  );

  it('refuses an org that would not say what it is, exit 1, having read nothing of its users', async () => {
    const { org, identity } = reach(acmeSetup(), { IsSandbox: true, unreadable: true });

    expect(await run('plan', '--org', 'uat', '--config', configFile())).toBe(1);
    expect(stderr).toContain('would not show its Organization record');
    expect(org.queries).toEqual([]);
    expect(identity).not.toHaveBeenCalled();
  });

  it('says why sf gave no session, exit 1', async () => {
    vi.mocked(loadOrg).mockRejectedValue(
      new Error('sf does not know uat: "sf org list" names the orgs it knows'),
    );

    expect(await run('plan', '--org', 'uat', '--config', configFile())).toBe(1);
    expect(stderr).toContain('sf does not know uat');
  });

  it.each([
    ['a scratch org', { IsSandbox: true, scratch: true } as OrgKind, 'scratch'],
    ['a sandbox', SANDBOX, 'sandbox'],
    [
      'a Developer Edition org',
      { IsSandbox: false, OrganizationType: 'Developer Edition' },
      'developer',
    ],
  ])('plans for %s, and names its kind', async (_label, kind, said) => {
    reach(acmeSetup(), kind);

    expect(
      await run('plan', '--org', 'uat', '--config', configFile(), '--accept-user-emails', '--json'),
    ).toBe(0);
    expect(answer()['org']).toEqual({
      organizationId: ACME.organizationId,
      kind: said,
      alias: 'uat',
      username: 'admin@acme.com.uat',
    });
  });
});

describe('a plan, and the dry run of an apply', () => {
  it('answers with --json what a run would change, the contract’s answer and nothing else on stdout', async () => {
    const { org } = reach(acmeSetup());

    expect(
      await run('plan', '--org', 'uat', '--config', configFile(), '--accept-user-emails', '--json'),
    ).toBe(0);
    const json = answer();
    expect(usersPlanAnswerSchema.parse(json)).toEqual(json);
    expect(json['users']).toEqual([
      {
        username: 'jane.qa@acme.com.uat',
        given: 'jane.qa@acme.com',
        userId: ACME.users.jane,
        address: 'invalid',
        changes: [
          { what: 'frozen', from: true, to: false },
          { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
          { what: 'email', to: 'awaiting' },
        ],
        emailsToPeople: 1,
      },
      {
        username: 'paul.qa@acme.com.uat',
        given: 'paul.qa@acme.com',
        userId: ACME.users.paul,
        changes: [
          { what: 'profile', from: 'Standard Platform User', to: 'QA Tester' },
          { what: 'active', from: false, to: true },
          { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
        ],
      },
      {
        username: 'erp.integration@acme.com.uat',
        given: 'erp.integration@acme.com',
        userId: ACME.users.erp,
        address: 'kept',
        changes: [{ what: 'frozen', from: false, to: true }],
      },
    ]);
    expect(json['emailsToPeople']).toBe(1);
    expect(json['refusals']).toBeUndefined();
    expect(org.writes).toEqual([]);
    // Every line but the answer went to stderr.
    expect(stderr).toContain('plan of the users of uat (sandbox, 00D000000000011EAA)');
    expect(stderr).toContain(
      '  jane.qa@acme.com.uat (jane.qa@acme.com in the config): unfrozen, permission set ' +
        'QA_Tools added, group QA_Team added, address asked back',
    );
    expect(stderr).toContain(
      '  paul.qa@acme.com.uat (paul.qa@acme.com in the config): profile QA Tester in place of ' +
        'Standard Platform User, activated, permission set group Support_Bundle added',
    );
    expect(stderr).toContain(
      '  erp.integration@acme.com.uat (erp.integration@acme.com in the config): frozen',
    );
    expect(stderr).toContain('licenses: Salesforce Platform 2 of 3 used, 1 more');
  });

  it('says a user the config sets up already has nothing to do', async () => {
    reach(acmeSetup());

    expect(
      await run(
        'plan',
        '--org',
        'uat',
        '--config',
        configFile({ users: [{ username: 'erp.integration@acme.com', active: true }] }),
      ),
    ).toBe(0);
    expect(stdout).toContain(
      '  erp.integration@acme.com.uat (erp.integration@acme.com in the config): as the config ' +
        'says already: nothing to do',
    );
  });

  it('writes nothing on a dry run, which answers the plan and counts what an apply then sends', async () => {
    const dry = reach(acmeSetup());
    const config = configFile();

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        config,
        '--dry-run',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(0);
    const planned = answer();
    expect(usersPlanAnswerSchema.parse(planned)).toEqual(planned);
    expect(dry.org.writes).toEqual([]);
    expect(dry.org.emailsSent()).toBe(0);
    expect(existsSync(join(journal, 'users'))).toBe(false);

    // The same org, applied: it sends what the dry run said it would.
    const real = reach(acmeSetup());
    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        config,
        '--yes',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(0);
    const applied = answer();
    expect(real.org.writes.length).toBeGreaterThan(0);
    expect(applied['apiRequests']).toBe(planned['apiRequests']);
    expect(stderr).toMatch(/^API requests: \d+$/m);
  });

  it('ends on 1 when a run would be refused, every refusal in its answer, nothing written', async () => {
    const { org } = reach(acmeSetup());
    const config = configFile({
      users: [...TESTERS.users, { username: 'nobody@acme.com', frozen: true }],
    });

    expect(await run('plan', '--org', 'uat', '--config', config, '--json')).toBe(1);
    const json = answer();
    expect(usersPlanAnswerSchema.parse(json)).toEqual(json);
    const codes = (json['refusals'] as Array<{ code: string }>).map((refusal) => refusal.code);
    expect(codes).toEqual(['USERS_NO_USER', 'USERS_EMAILS_NOT_ACCEPTED']);
    expect(stderr).toContain('a run now would be refused (USERS_NO_USER):');
    expect(stderr).toContain('a run now would be refused (USERS_EMAILS_NOT_ACCEPTED):');
    expect(org.writes).toEqual([]);
  });
});

describe('the emails Salesforce sends to people', () => {
  it('refuses an apply that asks an address back without --accept-user-emails, exit 1, nothing written', async () => {
    const { org, requests } = reach(acmeSetup());

    expect(await run('apply', '--org', 'uat', '--config', configFile(), '--yes', '--json')).toBe(1);
    const json = answer();
    expect(usersPlanAnswerSchema.parse(json)).toEqual(json);
    expect(json['refusals']).toEqual([
      expect.objectContaining({ code: 'USERS_EMAILS_NOT_ACCEPTED' }),
    ]);
    expect(stderr).toContain(
      'refused (USERS_EMAILS_NOT_ACCEPTED): Salesforce would email 1 person',
    );
    expect(stderr).toContain('Nothing was written.');
    expect(org.writes).toEqual([]);
    expect(org.emailsSent()).toBe(0);
    // Read all the same, for the dry run to say it: closed, nothing refuses there.
    expect(requests.filter((url) => url.startsWith('/tooling/executeAnonymous'))).toHaveLength(1);
  });

  it('asks the address back once accepted, and says it awaits its owner’s click, never restored', async () => {
    const { org } = reach(acmeSetup());

    expect(
      await run('apply', '--org', 'uat', '--config', configFile(), '--yes', '--accept-user-emails'),
    ).toBe(0);
    expect(org.emailsSent()).toBe(1);
    expect(stdout).toContain(
      "  jane.qa@acme.com.uat: address awaiting its owner's confirmation — Salesforce sent the " +
        'link to it; until it is clicked (72 h), the address stays .invalid',
    );
    expect(stdout).not.toContain('address restored');
    // Never a person's address or name in what it says.
    for (const said of [stdout, stderr]) {
      expect(said).not.toContain('jane.qa@acme.com.invalid');
      expect(said).not.toContain('Jane Tester');
    }
  });

  it('refuses the addresses asked back in an org that delivers all email, unless --accept-emails', async () => {
    const open = reach(acmeSetup(), SANDBOX, 'open');

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(1);
    expect((answer()['refusals'] as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'USERS_EMAILS_OPEN',
    ]);
    expect(stderr).toContain('deliverability: All email');
    // Refused by the plan it showed, not by the run's second read.
    expect(stderr).toContain('a run now would be refused (USERS_EMAILS_OPEN):');
    expect(stderr).not.toContain('changed since the plan');
    expect(open.org.writes).toEqual([]);

    const accepted = reach(acmeSetup(), SANDBOX, 'open');
    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--accept-emails',
      ),
    ).toBe(0);
    expect(accepted.org.emailsSent()).toBe(1);
  });

  it('says a closed deliverability, which refuses nothing', async () => {
    reach(acmeSetup(), SANDBOX, 'closed');

    expect(
      await run('plan', '--org', 'uat', '--config', configFile(), '--accept-user-emails'),
    ).toBe(0);
    expect(stdout).toContain(
      'deliverability: closed — System email only or No access: what runs there emails nobody',
    );
  });

  it('reads no deliverability when no address is asked back', async () => {
    const { requests } = reach(acmeSetup());

    expect(
      await run(
        'plan',
        '--org',
        'uat',
        '--config',
        configFile({ users: [{ username: 'erp.integration@acme.com', frozen: true }] }),
      ),
    ).toBe(0);
    expect(requests).toEqual([]);
    expect(stdout).not.toContain('deliverability');
  });
});

describe('a run', () => {
  it('sets the users up, ends on 0, answers the contract, and names the line that takes it back', async () => {
    const { org } = reach(acmeSetup());

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(0);
    const json = answer();
    expect(usersApplyAnswerSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ run: 1, status: 'success', emailsToPeople: 1 });
    expect(org.users.find((user) => user.id === ACME.users.paul)).toMatchObject({
      isActive: true,
      profileId: ACME.profiles.qa,
    });
    expect(stderr).toContain(`taken back by: ${commandOf('users')} remove --org uat --run 1 --yes`);
    // Kept where the store keeps an org's runs, and holding no address.
    const kept = new UsersRunStore({ root: join(journal, 'users') }).fileOf(ACME.organizationId, 1);
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, 'utf8')).not.toContain('jane.qa@acme.com.invalid');
  });

  it('ends on 3 when the org refuses a write the plan took for possible, the user named in its words', async () => {
    const { org } = reach(
      acmeSetup({
        refuse: ({ object, row }) =>
          object === 'User' && row['IsActive'] === true
            ? {
                code: 'LICENSE_LIMIT_EXCEEDED',
                message: 'License Limit Exceeded - Salesforce Platform',
              }
            : undefined,
      }),
    );

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(3);
    const json = answer();
    expect(usersApplyAnswerSchema.parse(json)).toEqual(json);
    expect(json['status']).toBe('partial');
    expect(stderr).toContain(
      '  paul.qa@acme.com.uat: refused activated: LICENSE_LIMIT_EXCEEDED License Limit Exceeded - ' +
        'Salesforce Platform',
    );
    // The others were set up all the same.
    expect(org.users.find((user) => user.id === ACME.users.erp)?.frozen).toBe(true);
  });

  it('asks before it writes, and with no terminal to answer stops on 2, nothing written', async () => {
    const { org } = reach(acmeSetup());

    expect(
      await run('apply', '--org', 'uat', '--config', configFile(), '--accept-user-emails'),
    ).toBe(2);
    expect(stderr).toContain('give --yes');
    expect(org.writes).toEqual([]);
  });

  it('converges from the run it replaces: what the config no longer names is taken back', async () => {
    const { org } = reach(acmeSetup());
    const first = configFile({
      users: [{ username: 'erp.integration@acme.com', permissionSets: ['QA_Tools'] }],
    });
    expect(await run('apply', '--org', 'uat', '--config', first, '--yes')).toBe(0);
    expect(org.assignments).toHaveLength(1);

    const second = configFile({
      users: [{ username: 'erp.integration@acme.com', permissionSets: [] }],
    });
    expect(
      await run('apply', '--org', 'uat', '--config', second, '--replaces', '1', '--yes', '--json'),
    ).toBe(0);
    expect(org.assignments).toEqual([]);
    const json = answer();
    expect(usersApplyAnswerSchema.parse(json)).toEqual(json);
    expect(json['run']).toBe(2);
  });

  it('refuses to replace a run this machine does not keep for the org, or one replaced already, exit 1', async () => {
    const { org } = reach(acmeSetup());

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--replaces',
        '9',
        '--yes',
        '--json',
      ),
    ).toBe(1);
    expect((answer()['refusals'] as Array<{ code: string }>)[0]?.code).toBe('USERS_RUN_NOT_FOUND');
    expect(org.writes).toEqual([]);

    const config = configFile({ users: [{ username: 'erp.integration@acme.com', frozen: true }] });
    expect(await run('apply', '--org', 'uat', '--config', config, '--yes')).toBe(0);
    expect(await run('apply', '--org', 'uat', '--config', config, '--replaces', '1', '--yes')).toBe(
      0,
    );
    const writes = org.writes.length;
    expect(
      await run('apply', '--org', 'uat', '--config', config, '--replaces', '1', '--yes', '--json'),
    ).toBe(1);
    const refused = (answer()['refusals'] as Array<{ code: string; message: string }>)[0];
    expect(refused?.code).toBe('USERS_RUN_REPLACED');
    expect(refused?.message).toContain('--replaces 2');
    expect(org.writes).toHaveLength(writes);
  });
});

describe('the automation the org runs as users are written', () => {
  const userTrigger = {
    objectApiName: 'User',
    flows: [],
    triggers: [{ name: 'UserTrigger', events: ['beforeUpdate', 'afterUpdate'] }],
  };

  it('refuses a run that fires it, exit 1, nothing written, unless --accept-automation', async () => {
    orgRuns.objects = [userTrigger];
    const { org } = reach(acmeSetup());

    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--json',
      ),
    ).toBe(1);
    const json = answer();
    expect(usersPlanAnswerSchema.parse(json)).toEqual(json);
    expect((json['refusals'] as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'AUTOMATION_NOT_ACCEPTED',
    ]);
    expect(stderr).toContain(
      'uat runs automation as users are written: User: Apex trigger UserTrigger (before and after save)',
    );
    expect(org.writes).toEqual([]);
    expect(orgRuns.asked).toEqual([['User', 'UserLogin']]);

    const accepted = reach(acmeSetup());
    expect(
      await run(
        'apply',
        '--org',
        'uat',
        '--config',
        configFile(),
        '--yes',
        '--accept-user-emails',
        '--accept-automation',
      ),
    ).toBe(0);
    expect(accepted.org.writes.length).toBeGreaterThan(0);
  });

  it('refuses a run whose automation could not be read, unless --accept-automation', async () => {
    orgRuns.throws = new Error('read ECONNRESET');
    reach(acmeSetup());

    expect(
      await run('plan', '--org', 'uat', '--config', configFile(), '--accept-user-emails', '--json'),
    ).toBe(1);
    const refusal = (answer()['refusals'] as Array<{ code: string; message: string }>)[0];
    expect(refusal?.code).toBe('AUTOMATION_NOT_ACCEPTED');
    expect(refusal?.message).toContain('could not be read (read ECONNRESET)');
  });

  it('reads it only on what a run writes: a login frozen, never a permission set given', async () => {
    reach(acmeSetup());
    const frozen = configFile({ users: [{ username: 'erp.integration@acme.com', frozen: true }] });
    expect(await run('plan', '--org', 'uat', '--config', frozen)).toBe(0);
    expect(orgRuns.asked).toEqual([['UserLogin']]);

    orgRuns.asked = [];
    const given = configFile({
      users: [{ username: 'erp.integration@acme.com', permissionSets: ['QA_Tools'] }],
    });
    expect(await run('plan', '--org', 'uat', '--config', given)).toBe(0);
    expect(orgRuns.asked).toEqual([]);
    expect(stdout).toContain('automation: none read: this run writes no user and no login');
  });
});

describe('a removal', () => {
  it('takes a run back, ends on 0, and answers the contract', async () => {
    const { org } = reach(acmeSetup());
    expect(
      await run('apply', '--org', 'uat', '--config', configFile(), '--yes', '--accept-user-emails'),
    ).toBe(0);

    expect(await run('remove', '--org', 'uat', '--run', '1', '--yes', '--json')).toBe(0);
    const json = answer();
    expect(usersRemoveAnswerSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ run: 1, status: 'success' });
    expect(org.users.find((user) => user.id === ACME.users.paul)).toMatchObject({
      isActive: false,
      profileId: ACME.profiles.platform,
    });
    expect(org.assignments).toEqual([]);
    expect(org.memberships).toEqual([]);
    expect(stderr).toContain('removal of run 1 of the users of uat: success');
  });

  it('refuses a run this machine does not keep, exit 1, asking nothing and writing nothing', async () => {
    const { org } = reach(acmeSetup());

    expect(await run('remove', '--org', 'uat', '--run', '7', '--json')).toBe(1);
    const json = answer();
    expect(usersRemoveAnswerSchema.parse(json)).toEqual(json);
    expect((json['refusals'] as Array<{ code: string }>)[0]?.code).toBe('USERS_RUN_NOT_FOUND');
    expect(org.writes).toEqual([]);
  });

  it('ends on 3 when the org refuses to put a user back, the user kept and named', async () => {
    const setup = acmeSetup();
    const { org } = reach(setup);
    expect(
      await run('apply', '--org', 'uat', '--config', configFile(), '--yes', '--accept-user-emails'),
    ).toBe(0);
    // The same org, now refusing to deactivate paul: a user a workflow names.
    const refusing = usersTestOrg({
      ...setup,
      users: org.users,
      assignments: org.assignments,
      memberships: org.memberships,
      refuse: ({ object, row }) =>
        object === 'User' && row['IsActive'] === false
          ? { code: 'CANNOT_UPDATE_DEFAULT_WORKFLOW_USER', message: 'the default workflow user' }
          : undefined,
    });
    const conn = vi.mocked(makeConn).mock.results[0]?.value as Record<string, unknown>;
    vi.mocked(makeConn).mockReturnValue({
      ...conn,
      ...refusing.connection,
      query: (soql: string) =>
        /FROM Organization\b/.test(soql)
          ? (conn['query'] as (s: string) => Promise<unknown>)(soql)
          : refusing.connection.query(soql),
    } as unknown as Connection);

    expect(await run('remove', '--org', 'uat', '--run', '1', '--yes', '--json')).toBe(3);
    const json = answer();
    expect(usersRemoveAnswerSchema.parse(json)).toEqual(json);
    expect(json['status']).toBe('partial');
    expect(stderr).toContain('CANNOT_UPDATE_DEFAULT_WORKFLOW_USER');
  });

  it('refuses a removal that fires the org’s automation, exit 1, unless --accept-automation', async () => {
    const { org } = reach(acmeSetup());
    expect(
      await run('apply', '--org', 'uat', '--config', configFile(), '--yes', '--accept-user-emails'),
    ).toBe(0);
    const writes = org.writes.length;
    orgRuns.objects = [
      {
        objectApiName: 'User',
        flows: [],
        triggers: [{ name: 'UserTrigger', events: ['afterUpdate'] }],
      },
    ];

    expect(await run('remove', '--org', 'uat', '--run', '1', '--yes', '--json')).toBe(1);
    const json = answer();
    expect(usersRemoveAnswerSchema.parse(json)).toEqual(json);
    expect((json['refusals'] as Array<{ code: string }>)[0]?.code).toBe('AUTOMATION_NOT_ACCEPTED');
    expect(org.writes).toHaveLength(writes);

    expect(await run('remove', '--org', 'uat', '--run', '1', '--yes', '--accept-automation')).toBe(
      0,
    );
  });
});
