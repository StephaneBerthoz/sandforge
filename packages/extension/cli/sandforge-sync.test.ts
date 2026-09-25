import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Connection } from 'jsforce';
import { parseArgs, buildConfig, buildQueryFn } from './sandforge-sync.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-sync.ts', ...args];
}

const MINIMAL = ['--source', 'SRC', '--target', 'TGT', '--object', 'Account'];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `parseArgs` on a line that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads the three things a run cannot do without', () => {
    const args = parseArgs(argv(...MINIMAL));
    expect(args.source).toBe('SRC');
    expect(args.target).toBe('TGT');
    expect(args.objects).toEqual([{ objectApiName: 'Account', externalIdField: undefined }]);
  });

  it('keeps the objects in the order they were given, which is the insert order', () => {
    const args = parseArgs(
      argv('--source', 'S', '--target', 'T', '--object', 'Account', '--object', 'Contact'),
    );
    expect(args.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
  });

  it('reads an external Id off the object', () => {
    const args = parseArgs(
      argv('--source', 'S', '--target', 'T', '--object', 'Account:External_Id__c'),
    );
    expect(args.objects[0].externalIdField).toBe('External_Id__c');
  });

  it('refuses a line with nothing to sync', () => {
    expect(refuse('--source', 'S', '--target', 'T').code).toBe(2);
  });

  it('refuses an object name that is not one', () => {
    const { code, message } = refuse('--source', 'S', '--target', 'T', '--object', 'Account; DROP');
    expect(code).toBe(2);
    expect(message).toContain('Account; DROP');
  });

  it('refuses a field name that is not one', () => {
    expect(refuse('--source', 'S', '--target', 'T', '--object', 'Account:9bad').code).toBe(2);
  });

  it('refuses an operation it cannot perform', () => {
    expect(refuse(...MINIMAL, '--operation', 'truncate').code).toBe(2);
  });

  it('refuses a where clause with no object in front of it', () => {
    expect(refuse(...MINIMAL, '--where', 'BillingCity = 42').code).toBe(2);
  });

  it('refuses a batch size outside what a write accepts', () => {
    expect(refuse(...MINIMAL, '--batch-size', '0').code).toBe(2);
    expect(refuse(...MINIMAL, '--batch-size', '50000').code).toBe(2);
    expect(refuse(...MINIMAL, '--batch-size', 'lots').code).toBe(2);
  });

  it('keeps the whole clause, equals signs and all', () => {
    const args = parseArgs(argv(...MINIMAL, '--where', "Account=Name = 'A=B'"));
    expect(args.where.Account).toBe("Name = 'A=B'");
  });
});

describe('buildConfig', () => {
  it('numbers the objects so they are written in the order asked for', () => {
    const config = buildConfig(
      parseArgs(
        argv('--source', 'S', '--target', 'T', '--object', 'Account', '--object', 'Contact'),
      ),
    );
    expect(config.objects.map((o) => o.insertOrder)).toEqual([0, 1]);
  });

  it('turns an object with an external Id into an upsert, whatever --operation said', () => {
    const config = buildConfig(
      parseArgs(
        argv(
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account:External_Id__c',
          '--operation',
          'insert',
        ),
      ),
    );
    // Naming a match key and then not matching on it would be two settings
    // disagreeing about the same thing.
    expect(config.objects[0].operation).toBe('upsert');
    expect(config.objects[0].externalIdField).toBe('External_Id__c');
  });

  it('leaves an object without one on the operation that was asked for', () => {
    const config = buildConfig(parseArgs(argv(...MINIMAL, '--operation', 'update')));
    expect(config.objects[0].operation).toBe('update');
  });

  it('puts each where clause on its own object and nowhere else', () => {
    const config = buildConfig(
      parseArgs(
        argv(
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account',
          '--object',
          'Contact',
          '--where',
          "Account=BillingCountry = 'France'",
        ),
      ),
    );
    expect(config.objects[0].where).toBe("BillingCountry = 'France'");
    expect(config.objects[1].where).toBeUndefined();
  });

  it('names the orgs the run is between', () => {
    const config = buildConfig(parseArgs(argv(...MINIMAL)));
    expect(config.sourceOrgId).toBe('SRC');
    expect(config.targetOrgId).toBe('TGT');
    expect(config.direction).toBe('source_to_target');
  });
});

describe('the read of an object', () => {
  it('reads every page of the fields an org that refuses FIELDS(ALL) is asked for by name', async () => {
    // Asked by name, with no LIMIT, the fields come 2 000 records at most at
    // a time with a cursor to the rest: the command read the first page and
    // synced the object short.
    const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
    const conn = {
      query: vi.fn(async (soql: string) => {
        if (soql.includes('FIELDS(ALL)')) throw new Error('MALFORMED_QUERY: FIELDS not supported');
        return { records: [{ Id: '001000000000001AAA' }], done: false, nextRecordsUrl: NEXT };
      }),
      queryMore: vi.fn().mockResolvedValue({ records: [{ Id: '001000000000002AAA' }], done: true }),
      sobject: () => ({
        describe: async () => ({
          fields: [
            { name: 'Id', type: 'id' },
            { name: 'Name', type: 'string' },
            { name: 'BillingAddress', type: 'address' },
          ],
        }),
      }),
    };
    const [account] = buildConfig(parseArgs(argv(...MINIMAL))).objects;

    const rows = await buildQueryFn(conn as unknown as Connection)('SRC', account);

    expect(conn.query).toHaveBeenLastCalledWith('SELECT Id, Name FROM Account');
    expect(conn.queryMore).toHaveBeenCalledWith(NEXT);
    expect(rows).toEqual([{ Id: '001000000000001AAA' }, { Id: '001000000000002AAA' }]);
  });
});
