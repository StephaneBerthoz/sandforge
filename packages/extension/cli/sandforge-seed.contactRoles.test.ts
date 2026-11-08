import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));

import { makeConn } from './sfSession.js';
import { main } from './sandforge-seed.js';
import { readSeedDryRun, seedDryRunCount } from './env/kinds/seed.js';
import { contactRolesOfSoql } from '../src/core/common/platformRecords.js';

/*
 * A seed of a contact, an opportunity with that contact, and a role of the
 * contact on the opportunity, run through the command line against a sandbox
 * that answers as a real org did: the opportunity inserted with its
 * `ContactId` is given, as it is taken, a contact role of that contact,
 * primary, with no role. Before the run linked the role it generated to it,
 * the opportunity held the role of its contact twice.
 */

const field = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  createable: name !== 'Id',
  updateable: name !== 'Id' && name !== 'OpportunityId',
  nillable: true,
  length: 80,
  referenceTo: [],
  defaultedOnCreate: false,
  picklistValues: [],
  ...extra,
});

const DESCRIBES: Record<string, unknown> = {
  Contact: { fields: [field('Id', 'id'), field('LastName')] },
  Opportunity: {
    fields: [
      field('Id', 'id'),
      field('Name'),
      field('StageName'),
      field('CloseDate', 'date'),
      field('ContactId', 'reference', { referenceTo: ['Contact'] }),
    ],
  },
  OpportunityContactRole: {
    fields: [
      field('Id', 'id'),
      field('OpportunityId', 'reference', { referenceTo: ['Opportunity'] }),
      field('ContactId', 'reference', { referenceTo: ['Contact'] }),
      field('Role', 'picklist', {
        picklistValues: [{ value: 'Decision Maker', active: true }],
      }),
      field('IsPrimary', 'boolean'),
    ],
  },
};

const PREFIX: Record<string, string> = {
  Contact: '003',
  Opportunity: '006',
  OpportunityContactRole: '00K',
};

type Row = Record<string, unknown> & { Id: string };

/**
 * A sandbox that takes every record it is sent through REST and writes the
 * role of an opportunity's contact as it takes the opportunity; its reads of
 * an opportunity's roles answer from what it holds.
 */
function roleWritingSandbox() {
  let made = 0;
  const held: Array<{ objectApiName: string; record: Row }> = [];
  const sent: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  const updated: Array<Record<string, unknown>> = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const idOf = (objectApiName: string) =>
    `${PREFIX[objectApiName] ?? 'a0X'}${String(made++).padStart(12, '0')}AAA`;
  const describe = async (objectApiName: string) => ({
    name: objectApiName,
    createable: true,
    recordTypeInfos: [],
    ...(DESCRIBES[objectApiName] as object),
  });
  const conn = {
    sobject: (objectApiName: string) => ({
      describe: () => describe(objectApiName),
      create: async (records: Array<Record<string, unknown>>) => {
        sent.push({ objectApiName, records });
        return records.map((record) => {
          const id = idOf(objectApiName);
          held.push({ objectApiName, record: { ...record, Id: id } });
          if (objectApiName === 'Opportunity' && typeof record['ContactId'] === 'string') {
            held.push({
              objectApiName: 'OpportunityContactRole',
              record: {
                Id: idOf('OpportunityContactRole'),
                OpportunityId: id,
                ContactId: record['ContactId'],
                IsPrimary: true,
                Role: null,
              },
            });
          }
          return { success: true, id };
        });
      },
      update: async (records: Array<Record<string, unknown>>) => {
        updated.push(...records);
        return records.map((record) => {
          const found = held.find((h) => h.record.Id === record['Id']);
          if (found) Object.assign(found.record, record);
          return { success: Boolean(found), id: record['Id'] };
        });
      },
    }),
    describe,
    describeGlobal: async () => ({
      sobjects: Object.keys(DESCRIBES).map((name) => ({ name, createable: true })),
    }),
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      const roles = contactRolesOfSoql(soql);
      if (roles) {
        return page(
          held
            .filter(
              (h) =>
                h.objectApiName === 'OpportunityContactRole' &&
                roles.opportunities.includes(String(h.record['OpportunityId'])),
            )
            .map((h) => h.record),
        );
      }
      return page([]);
    },
    tooling: { query: async () => page([]) },
    request: async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    }),
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  const rolesHeld = () => held.filter((h) => h.objectApiName === 'OpportunityContactRole');
  return { sent, updated, rolesHeld };
}

const rule = (fieldApiName: string, ruleType: string, config: Record<string, unknown>) => ({
  fieldApiName,
  ruleType,
  config,
});

/** A contact, an opportunity with it, and a role of that contact on the opportunity. */
const TEMPLATE = {
  name: 'Deal and its contact',
  description: '',
  strategy: 'faker',
  objects: [
    {
      objectApiName: 'Contact',
      recordCount: 1,
      fieldRules: [rule('LastName', 'static', { staticValue: 'Doe' })],
      excludedFields: [],
      insertOrder: 0,
    },
    {
      objectApiName: 'Opportunity',
      recordCount: 1,
      fieldRules: [
        rule('Name', 'static', { staticValue: 'Deal' }),
        rule('StageName', 'static', { staticValue: 'Prospecting' }),
        rule('CloseDate', 'static', { staticValue: '2026-12-31' }),
      ],
      excludedFields: [],
      insertOrder: 1,
    },
    {
      objectApiName: 'OpportunityContactRole',
      recordCount: 1,
      fieldRules: [
        rule('ContactId', 'reference', { referenceObject: 'Contact' }),
        rule('Role', 'static', { staticValue: 'Decision Maker' }),
      ],
      excludedFields: [],
      insertOrder: 2,
    },
  ],
  relations: [
    {
      childObject: 'Opportunity',
      lookupField: 'ContactId',
      parentObject: 'Contact',
      parents: { kind: 'generated' },
      distribution: { mode: 'perParent', count: 1 },
    },
    {
      childObject: 'OpportunityContactRole',
      lookupField: 'OpportunityId',
      parentObject: 'Opportunity',
      parents: { kind: 'generated' },
      distribution: { mode: 'perParent', count: 1 },
    },
  ],
  tags: [],
};

let journal: string;
let journalBefore: string | undefined;
let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  journal = mkdtempSync(join(tmpdir(), 'sandforge-seed-roles-journal-'));
  process.env['SANDFORGE_JOURNAL_DIR'] = journal;
  dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-roles-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(journal, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** The command line, the template written to a file of its own. */
function line(...extra: string[]): string[] {
  const file = join(dir, 'deal.json');
  writeFileSync(file, JSON.stringify(TEMPLATE));
  return ['node', 'sandforge-seed.ts', '--target', 'TGT', '--template-file', file, ...extra];
}

const LINKED =
  '      1 record(s) linked to the contact role the platform wrote with their opportunity, ' +
  'for its contact, not written; 1 given the fields the seed generated for it.';

describe('sandforge-seed and the contact role the platform writes with an opportunity', () => {
  it('leaves one role of the opportunity’s contact, the platform’s with the role generated for it, and says so', async () => {
    const sandbox = roleWritingSandbox();
    await main(line('--seed', '7'));

    const out = stdout.join('');
    expect(sandbox.rolesHeld()).toHaveLength(1);
    expect(sandbox.rolesHeld()[0].record).toMatchObject({
      Role: 'Decision Maker',
      IsPrimary: true,
    });
    expect(sandbox.sent.map((call) => call.objectApiName)).toEqual(['Contact', 'Opportunity']);
    expect(sandbox.updated).toEqual([
      { Id: sandbox.rolesHeld()[0].record.Id, Role: 'Decision Maker' },
    ]);
    expect(out).toContain(`  OpportunityContactRole: 0 created, 0 failed\n${LINKED}\n`);
    expect(out).toContain('status:  success');
    expect(out).toContain('created: 2');
  });

  it('says the same on a dry run, writing nothing, and counts the role among the records it would insert at its gates', async () => {
    const sandbox = roleWritingSandbox();
    await main(line('--seed', '7', '--dry-run'));

    const out = stdout.join('');
    expect(sandbox.sent).toEqual([]);
    expect(sandbox.updated).toEqual([]);
    expect(out).toContain('  [dry-run] Contact: 1 record(s) (REST)');
    expect(out).toContain('  [dry-run] Opportunity: 1 record(s) (REST)');
    expect(out).not.toContain('[dry-run] OpportunityContactRole: 1 record(s) (REST)');
    expect(out).toContain(
      '  [dry-run] OpportunityContactRole: 1 record(s) the platform writes with their ' +
        'opportunity, given the fields generated for them (REST update)',
    );
    expect(out).toContain(`  OpportunityContactRole: 0 created, 0 failed\n${LINKED}\n`);
    // The storage the gate holds the run to counts the role as a record it
    // writes: too high by the roles the platform writes, never too low.
    expect(out).toMatch(/data storage: about [\d.]+ MB to write/);
  });

  it('is read by an environment with the roles it links, which its plan says beside the records to write', async () => {
    // An environment read the dry run through a schema without the field:
    // its plan said "OpportunityContactRole 0 to write" of a resource that
    // asks one role, and no word of the one the platform writes.
    roleWritingSandbox();
    await main(line('--seed', '7', '--dry-run', '--json'));

    const answer = readSeedDryRun(stdout.join(''));
    expect(answer.result.objectResults).toContainEqual(
      expect.objectContaining({
        objectApiName: 'OpportunityContactRole',
        recordsCreated: 0,
        writtenByThePlatform: { records: 1, given: 1 },
      }),
    );
    const count = seedDryRunCount(answer);
    expect(count.objects).toContainEqual({ object: 'OpportunityContactRole', wouldCreate: 0 });
    expect(count.notes).toEqual([
      'OpportunityContactRole: 1 record(s) linked to the contact role the platform writes with ' +
        'their opportunity, for its contact, not written: given the fields the seed generates ' +
        'for it',
    ]);
  });
});
