import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The org is reached through these three, and through nothing else: the
// session the sf CLI hands over, the query the extension types an org with,
// and the connection the handler opens.
vi.mock('./sfSession.js', () => ({ loadOrg: vi.fn() }));
vi.mock('../src/core/connection/AuthProvider.js', () => ({
  AuthProvider: class {
    validateConnection = validateConnection;
  },
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

const validateConnection = vi.hoisted(() => vi.fn());

import { loadOrg } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import {
  dryRunLines,
  main,
  maskingInterruptedLine,
  parseArgs,
  restoreInterruptedLine,
  resultLines,
} from './sandforge-dataops';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-dataops.ts', ...args];
}

/** The fields of a contact the GDPR template masks, and one it leaves. */
const CONTACT_FIELDS = [
  'Id',
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingPostalCode',
  'Department',
];

/** `count` contacts, the first `scoped` of them under the last name the filter picks. */
function contactsOf(count: number, scoped: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003${String(i + 1).padStart(12, '0')}`,
    FirstName: `First${i + 1}`,
    LastName: i < scoped ? `Scoped${i + 1}` : `Other${i + 1}`,
    Email: `person${i + 1}@example.com`,
    Phone: `+33 1 00 00 ${String(i + 1).padStart(2, '0')}`,
    MailingStreet: `${i + 1} rue Example`,
    MailingCity: 'Example City',
    MailingPostalCode: '75000',
    Department: 'Unmasked',
  }));
}

/**
 * An org of contacts, read and written the way Salesforce does: a filter of
 * the shape `(Field LIKE 'prefix%')`, the rows past an Id, a LIMIT, the fields
 * a statement names, an update and an upsert on Id that change the rows.
 */
function orgOf(rows: Array<Record<string, unknown>>) {
  const kept = (soql: string): Array<Record<string, unknown>> => {
    const like = /\((\w+) LIKE '([^']*)%'\)/.exec(soql);
    const after = /\bId > '(\w+)'/.exec(soql)?.[1];
    const inList = /\bId IN \(([^)]*)\)/.exec(soql)?.[1];
    const ids = inList?.split(',').map((id) => id.trim().replace(/'/g, ''));
    return rows.filter(
      (r) =>
        (!like || String(r[like[1]]).startsWith(like[2])) &&
        (after === undefined || String(r.Id) > after) &&
        (ids === undefined || ids.includes(String(r.Id))),
    );
  };
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    if (soql.startsWith('SELECT COUNT() ')) {
      return { records: [], done: true, totalSize: kept(soql).length };
    }
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const limit = Number(/\bLIMIT (\d+)/.exec(soql)?.[1] ?? rows.length);
    const records = kept(soql)
      .slice(0, limit)
      .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const write = (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    });
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const describe = {
    name: 'Contact',
    label: 'Contact',
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: CONTACT_FIELDS.map((name) => ({
      name,
      label: name,
      type: name === 'Id' ? 'id' : 'string',
      createable: name !== 'Id',
      updateable: name !== 'Id',
      permissionable: name !== 'Id',
    })),
    recordTypeInfos: [],
    childRelationships: [],
  };
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query,
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue(describe),
    sobject: vi.fn(() => ({ update, upsert })),
    soap: { undelete: vi.fn(async () => []) },
  } as never);
  return { update, upsert };
}

/**
 * An org with person accounts: a business account and a person account, a
 * contact and a lead, each object described with its own fields and read by
 * the fields and the conditions a statement names.
 */
function personAccountOrg() {
  const personFields = ['FirstName', 'LastName', 'PersonEmail', 'PersonMailingStreet'];
  const rows: Record<string, Array<Record<string, unknown>>> = {
    Account: [
      { Id: '001000000000001AAA', IsPersonAccount: false, Name: 'Birchwood Dental' },
      {
        Id: '001000000000002AAA',
        IsPersonAccount: true,
        Name: 'Ottoline Quenneville',
        FirstName: 'Ottoline',
        LastName: 'Quenneville',
        PersonEmail: 'ottoline.q@example.com',
        PersonMailingStreet: '12 Harbour Row',
      },
    ],
    Contact: contactsOf(1, 0),
    Lead: [{ Id: '00Q000000000001AAA', Email: 'lead@example.com', Phone: '+33 1 00 00 99' }],
  };
  const fieldsOf: Record<string, string[]> = {
    Account: ['Id', 'IsPersonAccount', 'Name', 'Phone', ...personFields],
    Contact: CONTACT_FIELDS,
    Lead: ['Id', 'Email', 'Phone'],
  };
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    const object = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
    const persons = soql.includes('(IsPersonAccount = true)');
    const kept = (rows[object] ?? []).filter((r) => !persons || r.IsPersonAccount === true);
    if (soql.startsWith('SELECT COUNT() ')) {
      return { records: [], done: true, totalSize: kept.length };
    }
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const records = kept.map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null])));
    return { records, done: true, totalSize: records.length };
  });
  const update = vi.fn(async () => []);
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query,
    queryMore: vi.fn(),
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: (fieldsOf[object] ?? []).map((name) => ({
        name,
        label: name,
        type: name === 'Id' ? 'id' : name === 'IsPersonAccount' ? 'boolean' : 'string',
        nillable: true,
        createable: name !== 'Id' && name !== 'IsPersonAccount',
        updateable: name !== 'Id' && name !== 'IsPersonAccount',
        permissionable: name !== 'Id' && name !== 'IsPersonAccount',
      })),
      recordTypeInfos: [],
      childRelationships: [],
    })),
    sobject: vi.fn(() => ({ update, upsert: update })),
    soap: { undelete: vi.fn(async () => []) },
  } as never);
  return { update };
}

/** What the org says it is, as the extension's typing query reads it. */
function orgIs(edition: string, sandbox = false): void {
  validateConnection.mockResolvedValue({
    userId: '005000000000001AAA',
    username: 'user@example.com',
    displayName: 'User',
    orgId: '00D000000000001AAA',
    orgName: 'Example',
    orgType: edition,
    isSandbox: sandbox,
  });
}

describe('sandforge-dataops', () => {
  let stdout: string;
  let stderr: string;
  let store: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = '';
    stderr = '';
    store = mkdtempSync(join(tmpdir(), 'sandforge-dataops-test-'));
    process.exitCode = undefined;
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
    vi.mocked(loadOrg).mockResolvedValue({
      alias: 'ORG',
      username: 'user@example.com',
      instanceUrl: 'https://org.example.com',
      accessToken: 'token',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(store, { recursive: true, force: true });
  });

  /** Run a parse that is meant to be refused, and report the exit. */
  function refuse(...args: string[]): { code: number | undefined; message: string } {
    try {
      parseArgs(argv(...args));
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return { code: err.code, message: stderr };
      throw err;
    }
    return { code: undefined, message: stderr };
  }

  /** Run the command, and the exit code it ended on. */
  async function run(...args: string[]): Promise<number | undefined> {
    try {
      await main(argv(...args, '--store', store));
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : undefined;
  }

  describe('parseArgs', () => {
    it('reads a run of one object, its template and its filter', () => {
      const args = parseArgs(
        argv(
          'anonymize',
          '--org',
          'ORG',
          '--object',
          'Contact',
          '--template',
          'tpl-gdpr-standard',
          '--where',
          "LastName LIKE 'Scoped%'",
          '--dry-run',
        ),
      );
      expect(args).toMatchObject({
        org: 'ORG',
        mode: 'dry-run',
        object: 'Contact',
        templateId: 'tpl-gdpr-standard',
        where: "LastName LIKE 'Scoped%'",
        yes: false,
      });
    });

    it('reads a run of every object its template masks when it names none', () => {
      const args = parseArgs(
        argv('anonymize', '--org', 'ORG', '--template', 'tpl-ccpa-california'),
      );
      expect(args).toMatchObject({ org: 'ORG', mode: 'run', templateId: 'tpl-ccpa-california' });
      expect(args.object).toBeUndefined();
    });

    it('reads a resume and a restore', () => {
      expect(
        parseArgs(
          argv('anonymize', '--org', 'O', '--object', 'Contact', '--template', 't', '--resume'),
        ).mode,
      ).toBe('resume');
      expect(parseArgs(argv('anonymize', '--org', 'O', '--restore', 'snap-1'))).toMatchObject({
        mode: 'restore',
        restoreId: 'snap-1',
      });
    });

    it('reads a rules file as the panel saves rules, named after the file when it names none', () => {
      const file = join(store, 'contact-rules.json');
      writeFileSync(file, JSON.stringify([{ fieldPattern: 'Contact.Email', ruleType: 'hash' }]));
      const args = parseArgs(
        argv('anonymize', '--org', 'O', '--object', 'Contact', '--rules', file),
      );
      expect(args.rules).toEqual({
        name: 'Rules from contact-rules.json',
        rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash' }],
      });
    });

    it.each([
      ['no command', ['--org', 'O', '--object', 'Contact', '--template', 't']],
      ['no org', ['anonymize', '--object', 'Contact', '--template', 't']],
      [
        'an org that is not an alias',
        ['anonymize', '--org', 'O&x', '--object', 'Contact', '--template', 't'],
      ],
      [
        'a filter with no object to hold it to',
        ['anonymize', '--org', 'O', '--template', 't', '--where', "LastName LIKE 'S%'"],
      ],
      [
        'two objects',
        ['anonymize', '--org', 'O', '--object', 'Contact', '--object', 'Lead', '--template', 't'],
      ],
      [
        'an object that is not an API name',
        ['anonymize', '--org', 'O', '--object', 'Contact; x', '--template', 't'],
      ],
      ['no rules', ['anonymize', '--org', 'O', '--object', 'Contact']],
      [
        'a template and a rules file',
        ['anonymize', '--org', 'O', '--object', 'Contact', '--template', 't', '--rules', 'r.json'],
      ],
      [
        'a filter that goes on past the condition',
        [
          'anonymize',
          '--org',
          'O',
          '--object',
          'Contact',
          '--template',
          't',
          '--where',
          'Id != null LIMIT 1',
        ],
      ],
      [
        'a flag where the filter should be',
        [
          'anonymize',
          '--org',
          'O',
          '--object',
          'Contact',
          '--template',
          't',
          '--where',
          '--dry-run',
        ],
      ],
      [
        'a dry run and a resume',
        [
          'anonymize',
          '--org',
          'O',
          '--object',
          'Contact',
          '--template',
          't',
          '--dry-run',
          '--resume',
        ],
      ],
      [
        'a restore of a run of its own',
        ['anonymize', '--org', 'O', '--restore', 's', '--object', 'Contact'],
      ],
      [
        'a cap that is not a number of records',
        [
          'anonymize',
          '--org',
          'O',
          '--object',
          'Contact',
          '--template',
          't',
          '--max-records',
          'all',
        ],
      ],
    ])('refuses %s with exit 2', (_label, args) => {
      const { code, message } = refuse(...args);
      expect(code).toBe(2);
      expect(message).not.toBe('');
    });

    it('refuses a rules file with a method the panel does not save', () => {
      const file = join(store, 'bad.json');
      writeFileSync(
        file,
        JSON.stringify({
          name: 'Bad',
          rules: [{ fieldPattern: 'Contact.Email', ruleType: 'scramble' }],
        }),
      );
      const { code, message } = refuse(
        'anonymize',
        '--org',
        'O',
        '--object',
        'Contact',
        '--rules',
        file,
      );
      expect(code).toBe(2);
      expect(message).toContain('not rules the panel saves');
    });

    it('shows the command the script is really run with', () => {
      expect(refuse('--help').code).toBe(0);
      expect(stdout).toContain(
        'pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize',
      );
    });
  });

  describe('against an org', () => {
    it('says in a dry run what a run would mask — fields, records, new values — and writes nothing', async () => {
      orgIs('Developer Edition');
      const rows = contactsOf(30, 20);
      const before = rows.map((r) => ({ ...r }));
      const { update } = orgOf(rows);

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--where',
        "LastName LIKE 'Scoped%'",
        '--dry-run',
      );

      expect(code).toBeUndefined();
      expect(update).not.toHaveBeenCalled();
      expect(rows).toEqual(before);
      expect(stdout).toContain('dry run — nothing is written');
      expect(stdout).toContain('  Contact: 20 record(s) to mask');
      expect(stdout).toContain(
        '    fields: FirstName (fake), LastName (fake), Email (fake), Phone (mask), ' +
          'MailingStreet (fake), MailingCity (fake), MailingPostalCode (mask)',
      );
      // New values only: the records' own stay off the terminal.
      expect(stdout).toContain('the first records, masked as a run masks them');
      expect(stdout).not.toContain('person1@example.com');
    });

    it('masks the records its filter selects after a snapshot of them, and --restore puts their values back', async () => {
      orgIs('Developer Edition');
      const rows = contactsOf(30, 20);
      const before = rows.map((r) => ({ ...r }));
      const { update, upsert } = orgOf(rows);

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--where',
        "LastName LIKE 'Scoped%'",
        '--yes',
      );

      expect(code).toBeUndefined();
      expect(update).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('Anonymization completed: 20 records processed.');
      expect(stdout).toContain('Contact                      counted 20  masked 20  refused 0');
      // Masked: every email of the twenty changed, the ten others untouched.
      expect(rows.slice(0, 20).filter((r, i) => r.Email === before[i].Email)).toEqual([]);
      expect(rows.slice(20)).toEqual(before.slice(20));
      const snapshotId = /snapshot (\S+): 20 record\(s\)/.exec(stdout)?.[1];
      expect(snapshotId).toBeDefined();
      expect(stdout).toContain(`--restore ${snapshotId} --store ${store}`);

      stdout = '';
      const restored = await run('anonymize', '--org', 'ORG', '--restore', snapshotId!, '--yes');

      expect(restored).toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(rows).toEqual(before);
      expect(stdout).toContain('Rollback completed: 20 records restored');
    });

    it('stops a run at Ctrl-C before its next page, keeps what it masked to resume, and exits 130', async () => {
      // Killed outright, a run left no entry in the audit trail and no
      // checkpoint, its records half masked and nothing to say which.
      orgIs('Developer Edition');
      const rows = contactsOf(700, 700);
      const { update } = orgOf(rows);
      update.mockImplementationOnce(async (batch: Array<Record<string, unknown>>) => {
        process.emit('SIGINT');
        return batch.map((sent) => {
          Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
          return { success: true, id: sent.Id };
        });
      });

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--yes',
      );

      expect(code).toBe(130);
      expect(stdout).toContain('Anonymization cancelled');
      expect(stderr).toContain(maskingInterruptedLine());
      const masked = rows.filter((r) => !String(r.Email).startsWith('person')).length;
      expect(masked).toBeGreaterThan(0);
      expect(masked).toBeLessThan(700);
      expect(process.listenerCount('SIGINT')).toBe(0);

      stdout = '';
      process.exitCode = undefined;
      const resumed = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--resume',
        '--yes',
      );
      expect(resumed).toBeUndefined();
      expect(rows.filter((r) => String(r.Email).startsWith('person'))).toEqual([]);
    });

    it('stops a restore at Ctrl-C before its next batch, says what it restored, and the same line puts back the rest', async () => {
      // Its Ctrl-C reached a restore with no stop, and the process died part way.
      orgIs('Developer Edition');
      const rows = contactsOf(700, 700);
      const before = rows.map((r) => ({ ...r }));
      const { upsert } = orgOf(rows);
      await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--yes',
      );
      const snapshotId = /snapshot (\S+): 700 record\(s\)/.exec(stdout)?.[1];
      expect(snapshotId).toBeDefined();
      upsert.mockImplementationOnce(async (batch: Array<Record<string, unknown>>) => {
        process.emit('SIGINT');
        return batch.map((sent) => {
          Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
          return { success: true, id: sent.Id };
        });
      });

      stdout = '';
      const code = await run('anonymize', '--org', 'ORG', '--restore', snapshotId!, '--yes');

      expect(code).toBe(130);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('Rollback cancelled: 200 records restored before the cancel');
      expect(stderr).toContain(
        restoreInterruptedLine(
          'pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize --org ORG ' +
            `--restore ${snapshotId} --store ${store}`,
        ),
      );
      expect(rows.filter((r, i) => r.Email === before[i].Email)).toHaveLength(200);
      expect(process.listenerCount('SIGINT')).toBe(0);

      stdout = '';
      process.exitCode = undefined;
      expect(
        await run('anonymize', '--org', 'ORG', '--restore', snapshotId!, '--yes'),
      ).toBeUndefined();
      expect(rows).toEqual(before);
    });

    it('writes every row of a snapshot back with --rewrite-all, as sandforge-backup does', async () => {
      orgIs('Developer Edition');
      const rows = contactsOf(30, 20);
      const { upsert } = orgOf(rows);
      await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--where',
        "LastName LIKE 'Scoped%'",
        '--yes',
      );
      const snapshotId = /snapshot (\S+): 20 record\(s\)/.exec(stdout)?.[1];
      // Put back once: every row now holds the snapshot's values.
      await run('anonymize', '--org', 'ORG', '--restore', snapshotId!, '--yes');
      upsert.mockClear();

      stdout = '';
      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--restore',
        snapshotId!,
        '--rewrite-all',
        '--yes',
      );

      expect(code).toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0]).toHaveLength(20);
      expect(stdout).toContain(', every row written back…');
      expect(stdout).toContain('Rollback completed: 20 records restored');
    });

    it('refuses --rewrite-all without a restore', () => {
      expect(() =>
        parseArgs(
          argv(
            'anonymize',
            '--org',
            'O',
            '--object',
            'Contact',
            '--template',
            't',
            '--rewrite-all',
          ),
        ),
      ).toThrow(ExitCalled);
      expect(stderr).toContain('--rewrite-all goes with --restore.');
    });

    it('refuses a production org, and neither writes nor keeps a snapshot', async () => {
      orgIs('Enterprise Edition');
      const rows = contactsOf(5, 5);
      const before = rows.map((r) => ({ ...r }));
      const { update } = orgOf(rows);

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--yes',
      );

      expect(code).toBe(1);
      expect(update).not.toHaveBeenCalled();
      expect(rows).toEqual(before);
      expect(stdout).toContain(
        'refused: ORG is taken for a production org, and this command writes to none',
      );
      expect(stdout).not.toContain('snapshot ');
    });

    it('refuses a restore into a production org', async () => {
      orgIs('Developer Edition');
      const rows = contactsOf(3, 3);
      const { upsert } = orgOf(rows);
      await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--yes',
      );
      const snapshotId = /snapshot (\S+): 3 record\(s\)/.exec(stdout)?.[1];

      orgIs('Enterprise Edition');
      const code = await run('anonymize', '--org', 'ORG', '--restore', snapshotId!, '--yes');

      expect(code).toBe(1);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('saves a rules file as a template once, and masks with it', async () => {
      orgIs('Developer Edition');
      const rows = contactsOf(3, 3);
      orgOf(rows);
      const file = join(store, 'rules.json');
      writeFileSync(
        file,
        JSON.stringify({
          name: 'Emails only',
          rules: [{ fieldPattern: 'Contact.Email', ruleType: 'nullify' }],
        }),
      );

      await run('anonymize', '--org', 'ORG', '--object', 'Contact', '--rules', file, '--yes');
      expect(stdout).toContain('rules saved in the store as template "Emails only"');
      expect(rows.every((r) => r.Email === null && String(r.FirstName).startsWith('First'))).toBe(
        true,
      );

      stdout = '';
      await run('anonymize', '--org', 'ORG', '--object', 'Contact', '--rules', file, '--dry-run');
      expect(stdout).not.toContain('rules saved in the store');
      expect(stdout).toContain('template: Emails only (tpl-saved-');
    });

    it('says there is nothing to resume when no run stopped short', async () => {
      orgIs('Developer Edition');
      const { update } = orgOf(contactsOf(3, 3));

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--template',
        'tpl-gdpr-standard',
        '--resume',
        '--yes',
      );

      expect(code).toBe(1);
      expect(stderr).toContain('There is nothing to resume');
      expect(update).not.toHaveBeenCalled();
    });

    it('plans in a dry run with no object the person accounts of an org that has them, under the CCPA template', async () => {
      orgIs('Developer Edition');
      const { update } = personAccountOrg();

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--template',
        'tpl-ccpa-california',
        '--dry-run',
      );

      expect(code).toBeUndefined();
      expect(update).not.toHaveBeenCalled();
      expect(stdout).toContain('objects: every object the template masks');
      expect(stdout).toContain('  Contact: 1 record(s) to mask');
      expect(stdout).toContain('  Lead: 1 record(s) to mask');
      // The person account alone: the business account holds none of it.
      expect(stdout).toContain('  Account: 1 record(s) to mask');
      expect(stdout).toMatch(/fields: [^\n]*PersonEmail \(hash\)/);
    });

    it('takes --object Account under a template whose contact rules mask person accounts', async () => {
      orgIs('Developer Edition');
      personAccountOrg();

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Account',
        '--template',
        'tpl-ccpa-california',
        '--dry-run',
      );

      expect(code).toBeUndefined();
      expect(stderr).not.toContain('has no rule for Account');
      expect(stdout).toContain('  Account: 2 record(s) to mask');
    });

    it('refuses a template with no rule for the object, before anything is read', async () => {
      orgIs('Developer Edition');
      const { update } = orgOf([]);

      const code = await run(
        'anonymize',
        '--org',
        'ORG',
        '--object',
        'Case',
        '--template',
        'tpl-gdpr-standard',
        '--yes',
      );

      expect(code).toBe(1);
      expect(stderr).toContain('has no rule for Case');
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('what it prints', () => {
    it('gives a failed run its snapshot and the line that restores it', () => {
      const lines = resultLines(
        {
          message:
            'QUERY_TIMEOUT — 200 masked before it stopped; 300 still hold their original values (Contact 300).',
          objects: [
            { objectApiName: 'Contact', total: 500, processed: 200, failed: 0, notMasked: 300 },
          ],
          snapshot: { operationId: 'op-snapshot', totalRecords: 500 },
        },
        (id) => `restore ${id}`,
      );
      expect(lines).toEqual([
        'QUERY_TIMEOUT — 200 masked before it stopped; 300 still hold their original values (Contact 300).',
        '  Contact                      counted 500  masked 200  refused 0  still original 300',
        'snapshot op-snapshot: 500 record(s) as they were before the run. To put their values back:',
        '  restore op-snapshot',
      ]);
    });

    it('names in a dry run a field the org lacks, and a run a resume would carry on', () => {
      const lines = dryRunLines(
        {
          id: 't',
          name: 'T',
          rules: [
            { fieldPattern: 'Contact.Email', ruleType: 'hash' },
            { fieldPattern: 'Contact.Nickname__c', ruleType: 'fake' },
          ],
        },
        {
          objects: [{ objectApiName: 'Contact', count: 2 }],
          checkpoint: { id: 'cp', savedAt: '2026-10-01T10:00:00.000Z' },
        },
        {
          objects: [{ objectApiName: 'Contact', fields: ['Email'], rows: [] }],
          fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Nickname__c' }],
        },
      );
      expect(lines).toContain('    fields: Email (hash)');
      expect(lines).toContain('    Contact.Nickname__c: the org has no such field — masks nothing');
      expect(lines.at(-1)).toContain('--resume masks only what it left');
    });

    it("says in a dry run how a person account's fields the template does not name are masked", () => {
      const lines = dryRunLines(
        {
          id: 't',
          name: 'T',
          rules: [
            { fieldPattern: 'Account.Phone', ruleType: 'mask' },
            { fieldPattern: 'Contact.Email', ruleType: 'hash' },
          ],
        },
        { objects: [{ objectApiName: 'Account', count: 1 }] },
        {
          objects: [
            {
              objectApiName: 'Account',
              fields: ['Phone', 'PersonEmail', 'PersonBirthdate'],
              methods: { Phone: 'mask', PersonEmail: 'hash', PersonBirthdate: 'nullify' },
              rows: [],
            },
          ],
        },
      );
      expect(lines).toContain(
        '    fields: Phone (mask), PersonEmail (hash), PersonBirthdate (nullify)',
      );
    });
  });
});
