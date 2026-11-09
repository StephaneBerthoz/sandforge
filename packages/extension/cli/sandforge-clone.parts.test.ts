import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connection } from 'jsforce';
import type { ForgeUndoObjectResult } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});
// The removal is the real one, run against an org in miniature: what the
// command hands it from the run's journal is what this file is about.
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/forge/ForgeRunRemoval.js')>();
  return { ...actual, removalOrg: vi.fn() };
});

import { loadOrg, makeConn } from './sfSession.js';
import { removalOrg, type RemovalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  type MemoryChild,
  type MemoryRow,
} from '../src/test/memoryRemovalOrg.js';
import { main } from './sandforge-clone';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** Run the command and return the exit code it stopped on: undefined when it ended on its own. */
async function run(args: string[]): Promise<number | undefined> {
  try {
    await main(['node', 'sandforge-clone.ts', ...args]);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  }
}

/** The org the run wrote to, by its own id. */
const TARGET_ORG = '00D000000000002AAA';
/** A fake source id: the object's prefix, then a number. */
const SRC = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
/** The record the run gave that source id in the target. */
const TGT = (prefix: string, n: number): string =>
  `${prefix}${String(n + 900).padStart(12, '0')}AAA`;

/** What the cut part wrote: the account, its contact, and the opportunity of both. */
const ACCOUNT = { source: SRC('001', 1), target: TGT('001', 1) };
const CONTACT = { source: SRC('003', 1), target: TGT('003', 1) };
const OPPORTUNITY = { source: SRC('006', 1), target: TGT('006', 1) };
/** What the resume wrote under the opportunity: the quote it syncs, and a product line. */
const QUOTE = { source: SRC('0Q0', 1), target: TGT('0Q0', 1) };
const LINE = { source: SRC('00k', 1), target: TGT('00k', 1) };
/** The product of the line, which the cut part wrote when told to. */
const PRODUCT = { source: SRC('01t', 1), target: TGT('01t', 1) };
/**
 * The quote line the platform copies from the resume's product line onto the
 * quote the opportunity syncs, paired with it: in no id map, it points at the
 * resume's quote and at the cut part's product.
 */
const QUOTE_LINE_COPY = TGT('0QL', 1);
/**
 * The contact role the platform wrote with the opportunity, for its contact,
 * as the cut part inserted it: the resume linked it and gave it the source's
 * fields it lacked.
 */
const ROLE = { source: SRC('00K', 1), target: TGT('00K', 1) };
/** The tracked change feed tracking writes on the opportunity as its amount changes. */
const FEED = (n: number): string => `0D5${String(n).padStart(12, '0')}AAA`;

/** A colleague, who writes in the target as someone other than the run's user. */
const COLLEAGUE = '005000000000077AAA';

const at = (time: string): string => `2026-10-01T${time}.000Z`;
/** When the cut part wrote, on the org's clock; the resume wrote two minutes later. */
const PART_0 = { first: at('10:00:01'), last: at('10:00:03') };

/**
 * The target as the run left it, as the gate's target answered: deleting a
 * product line changes its opportunity's amount, dated as modified by the
 * user who deleted it, and feed tracking records the change on it as created
 * by that user; a feed item keeps no `LastModifiedById`. Deleting the quote
 * the opportunity syncs clears the opportunity's `SyncedQuoteId`.
 */
const GATE_CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  Contact: [
    { childSObject: 'OpportunityContactRole', field: 'ContactId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'ContactId' },
  ],
  Opportunity: [
    { childSObject: 'OpportunityContactRole', field: 'OpportunityId', cascadeDelete: true },
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
    { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
    { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
  ],
  Quote: [
    { childSObject: 'Opportunity', field: 'SyncedQuoteId' },
    { childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true },
  ],
  Product2: [
    { childSObject: 'OpportunityLineItem', field: 'Product2Id', restrictedDelete: true },
    { childSObject: 'QuoteLineItem', field: 'Product2Id', restrictedDelete: true },
  ],
};

class GateOrg extends MemoryRemovalOrg {
  private feeds = 0;

  constructor(now: () => number) {
    super(GATE_CHILDREN, { now });
    this.missingFields.set('FeedItem', new Set(['LastModifiedById']));
  }

  /**
   * Described as the target describes them, as far as a sweep reads them:
   * deletable, with who created each record and when, who last changed it
   * and when, its name, and the lookups that tie it to what it hangs from.
   */
  override async describe(objectApiName: string): Promise<unknown> {
    const described = (await super.describe(objectApiName)) as Record<string, unknown>;
    const field = (name: string, type: string, more: Record<string, unknown> = {}) => ({
      name,
      label: name,
      type,
      ...more,
    });
    const lookups = Object.entries(GATE_CHILDREN).flatMap(([parent, children]) =>
      children
        .filter((child) => child.childSObject === objectApiName)
        .map((child) => field(child.field, 'reference', { referenceTo: [parent] })),
    );
    return {
      ...described,
      deletable: true,
      fields: [
        field('Id', 'id'),
        field('Name', 'string', { nameField: true }),
        field('CreatedById', 'reference', { referenceTo: ['User'] }),
        field('CreatedDate', 'datetime'),
        ...(objectApiName === 'FeedItem'
          ? []
          : [field('LastModifiedById', 'reference', { referenceTo: ['User'] })]),
        field('LastModifiedDate', 'datetime'),
        ...lookups,
      ],
    };
  }

  protected override removed(objectApiName: string, row: MemoryRow): void {
    // Deleting a quote line of a synced quote deletes the line item it is paired with.
    if (objectApiName === 'QuoteLineItem' && typeof row.OpportunityLineItemId === 'string') {
      this.trash('OpportunityLineItem', row.OpportunityLineItemId);
    }
    if (objectApiName !== 'OpportunityLineItem') return;
    const opportunity = this.liveRow('Opportunity', String(row.OpportunityId));
    if (!opportunity) return;
    this.restamp(opportunity, MEMORY_ORG_USER);
    this.feeds++;
    this.add('FeedItem', {
      Id: FEED(this.feeds),
      ParentId: opportunity.Id,
      Type: 'TrackedChange',
      CreatedById: MEMORY_ORG_USER,
    });
  }
}

/** The run's user, as the target names who created and last modified a record. */
const byTheRun = (time: string): Record<string, string> => ({
  CreatedDate: time,
  LastModifiedDate: time,
  SystemModstamp: time,
  CreatedById: MEMORY_ORG_USER,
  LastModifiedById: MEMORY_ORG_USER,
});

/** One line of the journal for a record a part created: the call that sent it, its id, its answer. */
function createdLines(call: string, object: string, ids: { source: string; target: string }) {
  return [
    ['x', call, object, at('10:00:00'), ['Name'], [[ids.source, 'fingerprint']], []],
    ['c', ids.source, ids.target, object],
    ['a', call],
  ];
}

describe('sandforge-clone --remove of a run cut and taken up: its parts, removed in any order', () => {
  let dir: string;
  let journal: string;
  let org: GateOrg;
  let clock: number;
  let stdout: string[];
  /** What the command said on stderr, its lines with --json. */
  let stderr: string[];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const tooling = {
    query: vi.fn(async () => page([])),
    queryMore: vi.fn(async () => page([])),
  };
  const targetConn = {
    query: vi.fn(async (soql: string) =>
      soql.includes(' FROM Organization ') ? page([{ Id: TARGET_ORG, IsSandbox: true }]) : page([]),
    ),
    queryMore: vi.fn(async () => page([])),
    identity: vi.fn(async () => ({ user_id: MEMORY_ORG_USER })),
    tooling,
    version: '66.0',
    // The data API's composite, which the sweep counts through, answered by
    // the org in miniature; the Tooling API's, which reads the target's
    // automation, as an org with none.
    request: vi.fn(async (request: { method: string; url: string; body?: string }) =>
      request.url.includes('/tooling/')
        ? { compositeResponse: [] }
        : await org.request({ ...request, method: request.method as 'GET' | 'POST' }),
    ),
  } as unknown as Connection;

  /** Move the clocks of this machine and of the org to `time`. */
  function setClock(time: string): void {
    clock = Date.parse(time);
    vi.setSystemTime(clock);
  }

  /**
   * The run as the gate played it: the cut part wrote the account, the
   * contact and the opportunity, which owed its synced quote to the second
   * pass, and the platform wrote the contact role with the opportunity; a
   * single interrupt stopped it. The resume wrote the quote, paid the
   * opportunity its `SyncedQuoteId`, linked the role and gave it the
   * source's fields, then wrote the product line.
   *
   * @param roleMadeAt - When the contact role was made: with the opportunity
   *   unless told.
   * @param resumedSoonerBy - How many seconds sooner than two minutes after
   *   the cut the resume wrote.
   * @param withProduct - Whether the cut part wrote the line's product, and
   *   the platform copied the line onto the quote as the resume wrote it.
   */
  function theRun(
    roleMadeAt = at('10:00:03'),
    resumedSoonerBy = 0,
    withProduct = false,
  ): { s1: string; s2: string } {
    const resumedAt = (time: string): string =>
      new Date(Date.parse(at(time)) - resumedSoonerBy * 1_000).toISOString();
    setClock(at('10:00:01'));
    org.add('Account', { Id: ACCOUNT.target, Name: 'A', ...byTheRun(at('10:00:01')) });
    org.add('Contact', {
      Id: CONTACT.target,
      AccountId: ACCOUNT.target,
      ...byTheRun(at('10:00:02')),
    });
    org.add('Opportunity', {
      Id: OPPORTUNITY.target,
      AccountId: ACCOUNT.target,
      ContactId: CONTACT.target,
      SyncedQuoteId: null,
      ...byTheRun(at('10:00:03')),
    });
    org.add('OpportunityContactRole', {
      Id: ROLE.target,
      OpportunityId: OPPORTUNITY.target,
      ContactId: CONTACT.target,
      ...byTheRun(roleMadeAt),
    });
    if (withProduct) org.add('Product2', { Id: PRODUCT.target, ...byTheRun(at('10:00:03')) });
    setClock(resumedAt('10:02:01'));
    org.add('Quote', {
      Id: QUOTE.target,
      OpportunityId: OPPORTUNITY.target,
      ...byTheRun(resumedAt('10:02:01')),
    });
    org.edit('Opportunity', OPPORTUNITY.target, { SyncedQuoteId: QUOTE.target });
    setClock(resumedAt('10:02:02'));
    org.edit('OpportunityContactRole', ROLE.target, { Role: 'Decision Maker' });
    setClock(resumedAt('10:02:03'));
    org.add('OpportunityLineItem', {
      Id: LINE.target,
      OpportunityId: OPPORTUNITY.target,
      ...(withProduct ? { Product2Id: PRODUCT.target } : {}),
      ...byTheRun(resumedAt('10:02:03')),
    });
    if (withProduct) {
      org.add('QuoteLineItem', {
        Id: QUOTE_LINE_COPY,
        QuoteId: QUOTE.target,
        Product2Id: PRODUCT.target,
        OpportunityLineItemId: LINE.target,
        ...byTheRun(resumedAt('10:02:03')),
      });
    }

    const lines: unknown[] = [
      {
        run: {
          journalId: 'sandforge-clone-parts',
          targetOrgId: TARGET_ORG,
          startedAt: at('10:00:00'),
        },
      },
      { part: { n: 0, startedAt: at('10:00:00') } },
      ...createdLines('0.1', 'Account', ACCOUNT),
      ...createdLines('0.2', 'Contact', CONTACT),
      ...createdLines('0.3', 'Opportunity', OPPORTUNITY),
      ...(withProduct ? createdLines('0.4', 'Product2', PRODUCT) : []),
      [
        'o',
        'Opportunity',
        OPPORTUNITY.target,
        OPPORTUNITY.source,
        'SyncedQuoteId',
        QUOTE.source,
        0,
      ],
      { end: { status: 'cancelled', forgeId: 'sandforge-clone-parts#0', at: at('10:00:05') } },
      { part: { n: 1, startedAt: resumedAt('10:01:59') } },
      ...createdLines('1.1', 'Quote', QUOTE),
      ['p', OPPORTUNITY.target, 'SyncedQuoteId'],
      ['e', ROLE.source, ROLE.target, 'OpportunityContactRole'],
      ...createdLines('1.2', 'OpportunityLineItem', LINE),
      { end: { status: 'success', forgeId: 'sandforge-clone-parts#1', at: resumedAt('10:02:05') } },
    ];
    mkdirSync(join(dir, 'journal', 'forge-runs'), { recursive: true });
    writeFileSync(journal, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    // Beside it, how its last part ended, as the run keeps it.
    writeFileSync(
      journal.replace(/\.ndjson$/, '.end.json'),
      `${JSON.stringify(lines.at(-1))}\n`,
      'utf8',
    );

    const summary = (part: number, writtenBetween: { first: string; last: string }) => ({
      tool: 'sandforge-clone',
      version: 1,
      source: 'SRC',
      target: 'TGT',
      targetOrgId: TARGET_ORG,
      record: OPPORTUNITY.source,
      dryRun: false,
      elapsedMs: 5_000,
      finishedAt: part === 0 ? at('10:00:05') : resumedAt('10:02:05'),
      journal,
      part,
      result: {
        remapTable: {},
        existingSourceIds: [],
        updatedSourceIds: [],
        createdByObject: [],
        ...(part === 1 ? { withTheirRecordSourceIds: [ROLE.source] } : {}),
        writtenBetween,
      },
    });
    const s1 = join(dir, 's1.json');
    const s2 = join(dir, 's2.json');
    writeFileSync(s1, JSON.stringify(summary(0, PART_0)), 'utf8');
    writeFileSync(
      s2,
      JSON.stringify(summary(1, { first: resumedAt('10:02:01'), last: resumedAt('10:02:03') })),
      'utf8',
    );
    return { s1, s2 };
  }

  /** Remove `file` at `time`, and say what its JSON says. */
  async function remove(
    file: string,
    time: string,
    ...more: string[]
  ): Promise<{
    exit: number | undefined;
    result: { status: string; objects: ForgeUndoObjectResult[] };
  }> {
    setClock(time);
    stdout = [];
    const exit = await run(['--remove', file, '--target', 'TGT', '--json', ...more]);
    const answer = JSON.parse(stdout.join('')) as {
      result: { status: string; objects: ForgeUndoObjectResult[] };
    };
    return { exit, result: answer.result };
  }

  /** What `--remove <file> --preview` says at `time`, per object: to delete, kept as changed. */
  async function previewOf(file: string, time: string): Promise<unknown[]> {
    setClock(time);
    stdout = [];
    const exit = await run(['--remove', file, '--target', 'TGT', '--preview', '--json']);
    expect(exit).toBeUndefined();
    const answer = JSON.parse(stdout.join('')) as {
      preview: { objects: Array<{ objectApiName: string; toDelete: number; keptChanged: number }> };
    };
    return answer.preview.objects.map((o) => [o.objectApiName, o.toDelete, o.keptChanged]);
  }

  /** What is left of the run's records, and of what the org made of them, in the target. */
  function left(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const object of [
      'Account',
      'Contact',
      'Opportunity',
      'OpportunityContactRole',
      'Quote',
      'OpportunityLineItem',
      'QuoteLineItem',
      'Product2',
      'FeedItem',
    ]) {
      const count = org.all(object).length;
      if (count > 0) counts[object] = count;
    }
    return counts;
  }

  const kept = (objects: readonly ForgeUndoObjectResult[]) =>
    objects
      .filter((o) => o.keptChanged + o.keptDependents + o.refused > 0)
      .map((o) => [o.objectApiName, o.keptChanged, o.keptDependents]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-parts-'));
    journal = join(dir, 'journal', 'forge-runs', 'sandforge-clone-parts.ndjson');
    clock = Date.parse(at('10:00:00'));
    org = new GateOrg(() => clock);
    stdout = [];
    stderr = [];
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockReturnValue(targetConn);
    vi.mocked(removalOrg).mockReturnValue(org as unknown as RemovalOrg);
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the resume first, then the cut part: nothing of the run is left, its contact role included', async () => {
    const { s1, s2 } = theRun();

    const resumed = await remove(s2, at('10:05:00'));
    const cut = await remove(s1, at('10:08:00'));

    expect(resumed.exit).toBeUndefined();
    expect(resumed.result.status).toBe('success');
    expect(kept(cut.result.objects)).toEqual([]);
    expect(cut.result.status).toBe('success');
    expect(cut.exit).toBeUndefined();
    expect(left()).toEqual({});
  });

  it("the cut part first, held by the resume's records, then the resume, which takes what it left: nothing is left", async () => {
    const { s1, s2 } = theRun();

    const cut = await remove(s1, at('10:05:00'));
    const resumed = await remove(s2, at('10:08:00'));

    // The opportunity holds the resume's quote and product line, the account
    // the opportunity: kept for records of the run that stay, nothing else.
    expect(cut.exit).toBe(3);
    expect(kept(cut.result.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(cut.result.objects.find((o) => o.objectApiName === 'Opportunity')?.heldBy).toEqual([
      'OpportunityLineItem',
      'Quote',
    ]);
    expect(resumed.exit).toBeUndefined();
    expect(resumed.result.status).toBe('success');
    expect(
      resumed.result.objects.map((o) => [o.objectApiName, o.planned, o.deleted + o.alreadyGone]),
    ).toEqual([
      ['OpportunityLineItem', 1, 1],
      ['Quote', 1, 1],
      ['Opportunity', 1, 1],
      ['Account', 1, 1],
    ]);
    expect(left()).toEqual({});
  });

  it("the cut part first says the resume's records may be what holds what it kept, and that the resume's removal takes them, in its lines and its JSON", async () => {
    const { s1, s2 } = theRun();

    const cut = await remove(s1, at('10:05:00'));

    // Its own advice was --include-changed, which takes what others added
    // since too: the resume's removal takes them without it, live as here.
    expect(cut.exit).toBe(3);
    expect(cut.result).toMatchObject({
      heldByOtherParts: [{ part: 1, objects: ['OpportunityLineItem', 'Quote'] }],
    });
    expect(stderr).toContain(
      'of what this removal kept for records that stay, what the run\'s part 1 (its summary\'s "part") ' +
        "holds — its OpportunityLineItem, Quote records — goes with --remove of that part's summary, " +
        "once that part's own records are gone, without --include-changed",
    );
    const resumed = await remove(s2, at('10:08:00'));
    expect(resumed.result.status).toBe('success');
    expect(resumed.result).not.toHaveProperty('heldByOtherParts');
    expect(left()).toEqual({});
  });

  it('the resume, then the journal: the journal takes the rest, and its preview says it would', async () => {
    const { s2 } = theRun();

    await remove(s2, at('10:05:00'));
    const preview = await previewOf(journal, at('10:07:00'));
    const whole = await remove(journal, at('10:08:00'));

    expect(preview).toEqual([
      ['Opportunity', 1, 0],
      ['Contact', 1, 0],
      ['Account', 1, 0],
    ]);
    expect(whole.result.status).toBe('success');
    expect(kept(whole.result.objects)).toEqual([]);
    expect(left()).toEqual({});
  });

  it('the preview of the cut part, once the resume is removed, says the opportunity goes', async () => {
    const { s1, s2 } = theRun();

    await remove(s2, at('10:05:00'));

    expect(await previewOf(s1, at('10:07:00'))).toEqual([
      ['Opportunity', 1, 0],
      ['Contact', 1, 0],
      ['Account', 1, 0],
    ]);
  });

  it('the journal first, then either part: nothing is left of the run to take', async () => {
    const { s1, s2 } = theRun();

    const whole = await remove(journal, at('10:05:00'));
    const cut = await remove(s1, at('10:06:00'));
    const resumed = await remove(s2, at('10:07:00'));

    expect(whole.result.status).toBe('success');
    expect(left()).toEqual({});
    expect([cut.result, resumed.result]).toEqual([
      { status: 'success', planned: 0, objects: [], removedEarlier: 3 },
      { status: 'success', planned: 0, objects: [], removedEarlier: 2 },
    ]);
  });

  it('keeps a contact a colleague changed between the parts, and the account it holds', async () => {
    const { s1, s2 } = theRun();
    setClock(at('10:01:00'));
    org.edit('Contact', CONTACT.target, { Title: 'Buyer' }, COLLEAGUE);

    await remove(s2, at('10:05:00'));
    const cut = await remove(s1, at('10:08:00'));

    expect(cut.exit).toBe(3);
    expect(kept(cut.result.objects)).toEqual([
      ['Contact', 1, 0],
      ['Account', 0, 1],
    ]);
    // The resume was removed first: nothing of another part is left to take them.
    expect(cut.result).not.toHaveProperty('heldByOtherParts');
    expect(left()).toEqual({ Account: 1, Contact: 1 });
  });

  it('keeps a contact role made between the parts, as the run’s user even, which the resume linked to, and what it hangs from', async () => {
    const { s1, s2 } = theRun(at('10:01:00'));

    await remove(s2, at('10:05:00'));
    const cut = await remove(s1, at('10:08:00'));

    expect(cut.exit).toBe(3);
    expect(kept(cut.result.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(left()).toMatchObject({ OpportunityContactRole: 1, Opportunity: 1 });
  });

  it('the journal alone keeps a contact a colleague changed between the parts, and the account it holds', async () => {
    theRun();
    setClock(at('10:01:00'));
    org.edit('Contact', CONTACT.target, { Title: 'Buyer' }, COLLEAGUE);

    const whole = await remove(journal, at('10:05:00'));

    // Dated over the run's whole window, the gap between its parts included,
    // the colleague's change read as the run's own write, and went.
    expect(whole.exit).toBe(3);
    expect(kept(whole.result.objects)).toEqual([
      ['Contact', 1, 0],
      ['Account', 0, 1],
    ]);
    expect(left()).toEqual({ Account: 1, Contact: 1 });
  });

  it('the journal alone keeps a contact role made between the parts, as the run’s user even, and what it hangs from', async () => {
    theRun(at('10:01:00'));

    const whole = await remove(journal, at('10:05:00'));

    expect(whole.exit).toBe(3);
    expect(kept(whole.result.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(left()).toMatchObject({ OpportunityContactRole: 1, Opportunity: 1 });
  });

  it('the preview of the journal alone says the contact a colleague changed between the parts stays', async () => {
    theRun();
    setClock(at('10:01:00'));
    org.edit('Contact', CONTACT.target, { Title: 'Buyer' }, COLLEAGUE);

    expect(await previewOf(journal, at('10:05:00'))).toEqual([
      ['OpportunityLineItem', 1, 0],
      ['Quote', 1, 0],
      ['Opportunity', 1, 0],
      ['Contact', 0, 1],
      ['Account', 1, 0],
    ]);
  });

  it('the journal alone takes the whole run, its contact role included', async () => {
    theRun();

    const whole = await remove(journal, at('10:05:00'));

    expect(whole.exit).toBeUndefined();
    expect(whole.result.status).toBe('success');
    expect(kept(whole.result.objects)).toEqual([]);
    expect(left()).toEqual({});
  });

  /**
   * A second contact role under the opportunity and its contact, made by hand
   * as the run's user eight seconds after the cut part ended by this
   * machine's clock, ten after its last write by the org's: the gate's
   * second role, which the org dated to the second.
   */
  const HAND_ROLE = TGT('00K', 2);
  function roleMadeByHandAfterTheCut(): void {
    setClock(at('10:00:13'));
    org.add('OpportunityContactRole', {
      Id: HAND_ROLE,
      OpportunityId: OPPORTUNITY.target,
      ContactId: CONTACT.target,
      Role: 'Influencer',
      ...byTheRun(at('10:00:13')),
    });
  }

  /** What holds the records of the run the removal kept, per object, from its JSON. */
  const heldBy = (objects: readonly ForgeUndoObjectResult[]) =>
    objects
      .filter((o) => o.keptDependents > 0)
      .map((o) => [o.objectApiName, o.heldBy, o.heldByAutomation ?? 0]);

  it('the journal alone keeps a contact role made by hand seconds after the cut, as the run’s user, and says what holds what it kept', async () => {
    theRun();
    roleMadeByHandAfterTheCut();

    const whole = await remove(journal, at('10:05:00'));

    // Dated by this machine's clock, ten seconds of leeway after the cut
    // part's end, the role read as the run's, and went with the opportunity.
    expect(whole.exit).toBe(3);
    expect(whole.result.status).toBe('partial');
    expect(heldBy(whole.result.objects)).toEqual([
      ['Opportunity', ['OpportunityContactRole'], 1],
      ['Contact', ['OpportunityContactRole'], 1],
      ['Account', ['Contact', 'Opportunity'], 0],
    ]);
    expect(org.all('OpportunityContactRole').map((r) => r.Id)).toContain(HAND_ROLE);
    // The org's tracked change for the line item the removal deleted stays
    // with the opportunity.
    expect(left()).toMatchObject({
      Account: 1,
      Contact: 1,
      Opportunity: 1,
      OpportunityContactRole: 2,
    });
    // Said as the gate's later role was: kept, and what holds it named.
    expect(stderr).toContainEqual(
      expect.stringContaining(
        '2 record(s) of the run kept for records created under them as its user, within a ' +
          "minute of them, likely by the target's automation (OpportunityContactRole)",
      ),
    );
  });

  it('the cut part, then the resume, which takes what the cut part left: the contact role made by hand right after the cut stays, and what it hangs from', async () => {
    const { s1, s2 } = theRun();
    roleMadeByHandAfterTheCut();

    const cut = await remove(s1, at('10:05:00'));
    const resumed = await remove(s2, at('10:08:00'));

    expect(cut.exit).toBe(3);
    expect(resumed.exit).toBe(3);
    expect(heldBy(resumed.result.objects)).toEqual([
      ['Opportunity', ['OpportunityContactRole'], 1],
      ['Contact', ['OpportunityContactRole'], 1],
      ['Account', ['Contact', 'Opportunity'], 0],
    ]);
    expect(org.all('OpportunityContactRole').map((r) => r.Id)).toContain(HAND_ROLE);
    expect(left()).toMatchObject({ Opportunity: 1, Contact: 1, Account: 1 });
  });

  it('the cut part, then the resume: each says the contact role made by hand after the cut part holds what it kept, and that the cut part’s own sweep takes it, never the resume’s', async () => {
    const { s1, s2 } = theRun();
    roleMadeByHandAfterTheCut();

    stderr = [];
    await remove(s1, at('10:05:00'));
    const cutLines = [...stderr];
    stderr = [];
    await remove(s2, at('10:08:00'));
    const resumedLines = [...stderr];

    // The cut part's removal: its own contact, held by the role, which its
    // sweep — a minute past its last write — would take as the automation's.
    expect(cutLines).toContain(
      '1 record(s) of the run kept for records created under them as its user after the last ' +
        "write of the run's part that wrote them, within a minute of them, by the target's " +
        'automation or by hand (OpportunityContactRole): --sweep takes them first (--sweep-list ' +
        "shows them); a record made by hand as the run's user under the run's records within a " +
        "minute of them reads as the automation's, and one changed by hand before the run's " +
        'last write as unchanged: check the names before a --sweep',
    );
    // The resume's removal took up the cut part's records the first left: the
    // role holds them, and the resume's sweep, looking in the resume's
    // window, would find nothing. Live, it said "created under them during
    // the run … --sweep takes them first".
    expect(resumedLines).toContain(
      '2 record(s) of the run\'s part 0 (its summary\'s "part") kept for records created under ' +
        "them as its user after that part's last write, within a minute of them, by the " +
        "target's automation or by hand (OpportunityContactRole): a sweep of this summary looks " +
        "in its own part's window alone, and leaves them; --remove of part 0's summary with " +
        "--sweep takes them first (--remove of part 0's summary with --sweep-list shows them; a " +
        "record made by hand as the run's user under the run's records within a minute of them " +
        "reads as the automation's, and one changed by hand before the run's last write as " +
        'unchanged: check the names before it), or delete them by hand, then remove the run ' +
        'again; --preview says what of it their delete leaves changed since, which ' +
        '--include-changed takes',
    );
    expect(resumedLines.join('\n')).not.toContain('during the run');
    expect(resumedLines.join('\n')).not.toMatch(/: --sweep takes them first/);
  });

  it('the cut part, the resume having written under its opportunity within the minute: the resume’s records hold it as the run’s, not as what a sweep takes, and the line counts the contact the hand-made role holds', async () => {
    // The gate's resume wrote 52 s after the cut part's opportunity; here 48.
    const { s1 } = theRun(at('10:00:03'), 70);
    roleMadeByHandAfterTheCut();

    stderr = [];
    const cut = await remove(s1, at('10:05:00'));
    const cutLines = [...stderr];

    // Live, its quote and line read as made for the run by the target's
    // automation, which --sweep takes first, while the same output named
    // them the resume's, and the cut part's --sweep-list did not list them:
    // a sweep leaves what the run's id map holds.
    expect(cut.exit).toBe(3);
    const opportunity = cut.result.objects.find((o) => o.objectApiName === 'Opportunity');
    expect(opportunity).toMatchObject({
      keptDependents: 1,
      heldBy: ['OpportunityContactRole', 'OpportunityLineItem', 'Quote'],
    });
    expect(opportunity).not.toHaveProperty('heldByAutomation');
    expect(opportunity).not.toHaveProperty('heldByAutomationAfterRun');
    expect(opportunity).not.toHaveProperty('automationHolders');
    expect(cut.result.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      heldBy: ['OpportunityContactRole'],
      heldByAutomation: 1,
      heldByAutomationAfterRun: 1,
      automationHolders: ['OpportunityContactRole'],
    });
    expect(cut.result).toMatchObject({
      heldByOtherParts: [{ part: 1, objects: ['OpportunityLineItem', 'Quote'] }],
    });
    expect(cutLines).toContain(
      '1 record(s) of the run kept for records created under them as its user after the last ' +
        "write of the run's part that wrote them, within a minute of them, by the target's " +
        'automation or by hand (OpportunityContactRole): --sweep takes them first (--sweep-list ' +
        "shows them); a record made by hand as the run's user under the run's records within a " +
        "minute of them reads as the automation's, and one changed by hand before the run's " +
        'last write as unchanged: check the names before a --sweep',
    );
  });

  /** What `--remove <file> --sweep-list --json` lists at `time`, per object: found, made, late. */
  async function sweepListOf(file: string, time: string): Promise<unknown[]> {
    setClock(time);
    stdout = [];
    stderr = [];
    expect(await run(['--remove', file, '--target', 'TGT', '--sweep-list', '--json'])).toBe(
      undefined,
    );
    const answer = JSON.parse(stdout.join('')) as {
      listing: {
        found: Array<{ objectApiName: string; count: number; classes: Record<string, number> }>;
      };
    };
    return answer.listing.found.map((o) => [
      o.objectApiName,
      o.count,
      o.classes.made,
      o.classes.late,
    ]);
  }

  /** What the cut part's sweep says of the resume's records, which it leaves. */
  const LEAVES_THE_RESUME =
    'a sweep of this summary leaves the 2 record(s) of the run\'s part 1 (its summary\'s "part"), ' +
    "the run's own, never the target's automation's: --remove of that part's summary takes them";

  it('the cut part’s --sweep-list, the resume having written under its opportunity within the minute: lists none of the resume’s records, and says the resume’s removal takes them', async () => {
    // The gate's resume wrote 51 s after the cut part's last write; here 48.
    const { s1 } = theRun(at('10:00:03'), 70);
    roleMadeByHandAfterTheCut();

    const listed = await sweepListOf(s1, at('10:05:00'));

    // Live, the cut part's list had the resume's lines, quote and prices
    // "made for the run", to delete, while its removal said they went with
    // the resume's. The resume linked the platform's role: the run's too.
    expect(listed).toEqual([['OpportunityContactRole', 1, 1, 0]]);
    expect(stderr).toContain(
      'it found 1 record(s) and would delete 1 of them, children first; per object, all it found:',
    );
    expect(stderr).toContain(LEAVES_THE_RESUME);
  });

  it('the cut part’s --sweep-list, the resume two minutes later: lists none of the resume’s records as made late, which --sweep-late would take', async () => {
    const { s1 } = theRun();
    roleMadeByHandAfterTheCut();

    const listed = await sweepListOf(s1, at('10:05:00'));

    expect(listed).toEqual([['OpportunityContactRole', 1, 1, 0]]);
    expect(stderr.join('\n')).not.toContain('--sweep-late takes them');
    expect(stderr).toContain(LEAVES_THE_RESUME);
  });

  it('the cut part’s --sweep-list, once the resume’s removal kept its quote: says the cut part’s removal takes it up', async () => {
    const { s1, s2 } = theRun(at('10:00:03'), 70);
    setClock(at('10:03:00'));
    org.edit('Quote', QUOTE.target, { Name: 'Edited' }, COLLEAGUE);
    await remove(s2, at('10:05:00'));

    const listed = await sweepListOf(s1, at('10:06:00'));

    expect(listed).toEqual([]);
    expect(stderr).toContain(
      "a sweep of this summary leaves the 1 record(s) of the run's part 1 (its summary's " +
        "\"part\"), the run's own, never the target's automation's: an earlier --remove of that " +
        'part left them, which the removal of this summary takes up once its own records are gone',
    );
  });

  it('the cut part’s --sweep-list, the resume within the minute: what hangs from the resume’s records alone is tied to nothing of the cut part, and --sweep-untied is refused, as the panel refuses it', async () => {
    const { s1 } = theRun(at('10:00:03'), 70);
    // A post the resume's automation, or a person as the run's user, made on
    // the resume's quote within the cut part's minute.
    setClock(at('10:00:54'));
    org.add('FeedItem', { Id: FEED(9), ParentId: QUOTE.target, ...byTheRun(at('10:00:54')) });

    setClock(at('10:05:00'));
    stdout = [];
    stderr = [];
    await run(['--remove', s1, '--target', 'TGT', '--sweep-list', '--sweep-untied', '--json']);
    const { listing } = JSON.parse(stdout.join('')) as {
      listing: {
        found: Array<{ objectApiName: string; classes: Record<string, number> }>;
        untied?: { objects: Array<{ objectApiName: string; count: number }>; refusal?: string };
      };
    };

    // Tied to the run through the resume's quote, it was made for the run,
    // which --sweep took; with the quote the run's own, it is tied to nothing
    // of the cut part, and may be the resume's.
    expect(listing.found.find((o) => o.objectApiName === 'FeedItem')?.classes).toMatchObject({
      made: 0,
      untied: 1,
    });
    expect(listing.untied?.objects).toEqual([{ objectApiName: 'FeedItem', count: 1 }]);
    expect(listing.untied?.refusal).toContain(
      'Another run of this machine wrote to the target in this run’s window',
    );
  });

  /** What the cut part's sweep says of the resume's records, the platform's copy of its line among them. */
  const LEAVES_THE_RESUME_AND_COPY =
    'a sweep of this summary leaves the 3 record(s) of the run\'s part 1 (its summary\'s "part"), ' +
    "the run's own, never the target's automation's: --remove of that part's summary takes them";

  it('the cut part’s --sweep-list, the resume within the minute: leaves the quote line the platform copied under the resume’s quote, though it points at the cut part’s product, and counts it the resume’s', async () => {
    // The gate's resume wrote 45 s after the cut part's product; here 48.
    const { s1, s2 } = theRun(at('10:00:03'), 70, true);

    const listed = await sweepListOf(s1, at('10:05:00'));
    const { listing } = JSON.parse(stdout.join('')) as { listing: { otherParts?: unknown } };
    const cutLines = [...stderr];
    const resumeListed = await sweepListOf(s2, at('10:05:30'));

    // Live, the copies were "made for the run" in the cut part's list, which
    // would have deleted them, and their line items with them, and in the
    // resume's: two parts claimed them.
    expect(listed).toEqual([]);
    expect(listing.otherParts).toEqual([
      { part: 1, objects: [{ objectApiName: 'QuoteLineItem', count: 1 }] },
    ]);
    expect(cutLines).toContain(LEAVES_THE_RESUME_AND_COPY);
    expect(resumeListed).toEqual([['QuoteLineItem', 1, 1, 0]]);
  });

  it('the cut part’s --sweep-list, the resume two minutes later: lists the platform’s copy of the resume’s line as made late no more', async () => {
    const { s1 } = theRun(at('10:00:03'), 0, true);

    const listed = await sweepListOf(s1, at('10:05:00'));

    expect(listed).toEqual([]);
    expect(stderr.join('\n')).not.toContain('--sweep-late takes them');
    expect(stderr).toContain(LEAVES_THE_RESUME_AND_COPY);
  });

  it('the cut part’s --sweep --sweep-late, the resume within the minute: deletes neither the platform’s copy of the resume’s line nor that line, which the resume’s removal takes', async () => {
    const { s1, s2 } = theRun(at('10:00:03'), 70, true);

    await remove(s1, at('10:05:00'), '--sweep', '--sweep-late');

    expect(left()).toMatchObject({ Quote: 1, OpportunityLineItem: 1, QuoteLineItem: 1 });
    const resumed = await remove(s2, at('10:08:00'));
    expect(resumed.result.status).toBe('success');
    expect(left()).toEqual({});
  });

  it('the cut part’s --sweep --sweep-late, the resume within the minute: deletes none of the resume’s records, which its own removal then takes', async () => {
    const { s1, s2 } = theRun(at('10:00:03'), 70);
    roleMadeByHandAfterTheCut();

    await remove(s1, at('10:05:00'), '--sweep', '--sweep-late');

    // The sweep took the role made by hand, as its list warns; the resume's
    // records stay for the resume's removal, which takes them.
    expect(org.all('OpportunityContactRole').map((r) => r.Id)).not.toContain(HAND_ROLE);
    expect(left()).toMatchObject({ Quote: 1, OpportunityLineItem: 1 });
    const resumed = await remove(s2, at('10:08:00'));
    expect(resumed.result.status).toBe('success');
    expect(left()).toEqual({});
  });

  it('the journal, the resume having written within the minute and its quote changed since: the quote holds the opportunity as the run’s, never as a record to delete by hand', async () => {
    theRun(at('10:00:03'), 70);
    roleMadeByHandAfterTheCut();
    setClock(at('10:01:30'));
    org.edit('Quote', QUOTE.target, { Name: 'Edited' });

    stderr = [];
    const whole = await remove(journal, at('10:05:00'));

    // The resume's removal kept its quote as changed since; the cut part's
    // read it as the automation's, and its line said to delete it by hand.
    expect(whole.exit).toBe(3);
    expect(kept(whole.result.objects)).toEqual([
      ['Quote', 1, 0],
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    const opportunity = whole.result.objects.find((o) => o.objectApiName === 'Opportunity');
    expect(opportunity?.heldBy).toEqual(['OpportunityContactRole', 'Quote']);
    expect(opportunity).not.toHaveProperty('heldByAutomation');
    expect(opportunity).not.toHaveProperty('automationHolders');
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^1 record\(s\) of the run kept for records created under them as its user, within a minute of them, likely by the target's automation \(OpportunityContactRole\):/,
      ),
    );
  });

  it('the resume, then the journal: the contact role made by hand right after the cut stays, and what it hangs from', async () => {
    const { s2 } = theRun();
    roleMadeByHandAfterTheCut();

    const resumed = await remove(s2, at('10:05:00'));
    const whole = await remove(journal, at('10:08:00'));

    expect(resumed.result.status).toBe('success');
    expect(whole.exit).toBe(3);
    expect(heldBy(whole.result.objects)).toEqual([
      ['Opportunity', ['OpportunityContactRole'], 1],
      ['Contact', ['OpportunityContactRole'], 1],
      ['Account', ['Contact', 'Opportunity'], 0],
    ]);
    expect(org.all('OpportunityContactRole').map((r) => r.Id)).toContain(HAND_ROLE);
    expect(left()).toMatchObject({ Opportunity: 1, Contact: 1, Account: 1 });
  });

  it('the journal alone still takes what the org made in the second of the cut part’s last write: the org dates to the second', async () => {
    theRun();
    // The org dated the opportunity 10:00:03; a role it made in that same
    // second cannot be told from one made with it.
    setClock(at('10:00:03'));
    org.add('OpportunityContactRole', {
      Id: HAND_ROLE,
      OpportunityId: OPPORTUNITY.target,
      ContactId: CONTACT.target,
      ...byTheRun(at('10:00:03')),
    });

    const whole = await remove(journal, at('10:05:00'));

    expect(whole.result.status).toBe('success');
    expect(left()).toEqual({});
  });

  /** The words the gate's target had a sweep refused with, its records that dated the run gone. */
  const SWEEP_REFUSED =
    'sweep refused: The target did not date this run’s writes: the window its automation ' +
    'wrote in cannot be told, and nothing is swept.';

  it('a --sweep-list a sweep would be refused for exits 3, as the refused sweep does, not 0 as an empty list', async () => {
    theRun();
    roleMadeByHandAfterTheCut();
    await remove(journal, at('10:05:00'));
    setClock(at('10:06:00'));
    stdout = [];
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });

    const listed = await run(['--remove', journal, '--target', 'TGT', '--sweep-list']);
    const swept = await run(['--remove', journal, '--target', 'TGT', '--sweep']);

    expect(printed).toContain(SWEEP_REFUSED);
    expect(listed).toBe(3);
    expect(swept).toBe(3);
  });

  it('a --sweep-list --json a sweep would be refused for exits 3, its JSON saying the refusal as before', async () => {
    theRun();
    roleMadeByHandAfterTheCut();
    await remove(journal, at('10:05:00'));
    setClock(at('10:06:00'));
    stdout = [];
    stderr = [];

    const listed = await run(['--remove', journal, '--target', 'TGT', '--sweep-list', '--json']);

    expect(stderr).toContain(SWEEP_REFUSED);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      tool: 'sandforge-clone',
      action: 'sweep-list',
      listing: { refusal: SWEEP_REFUSED.replace('sweep refused: ', ''), found: [] },
    });
    expect(listed).toBe(3);
  });

  it('keeps the contact role a colleague changed after the resume, and what it hangs from', async () => {
    const { s1, s2 } = theRun();
    setClock(at('10:03:00'));
    org.edit('OpportunityContactRole', ROLE.target, { Role: 'Economic Buyer' }, COLLEAGUE);

    await remove(s2, at('10:05:00'));
    const cut = await remove(s1, at('10:08:00'));

    expect(cut.exit).toBe(3);
    expect(kept(cut.result.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(left()).toMatchObject({ OpportunityContactRole: 1, Opportunity: 1, Contact: 1 });
  });
});
