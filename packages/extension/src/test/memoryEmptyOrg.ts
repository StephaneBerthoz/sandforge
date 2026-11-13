/**
 * An org in miniature for an emptying from end to end: the dry run's org
 * (`EmptyFixtureOrg`) — describes with their relationships, counts read
 * through paths of lookups — over the removal tests' memory org
 * (`MemoryRestoreOrg`), which deletes, takes along what cascades, refuses
 * what the platform refuses, keeps a recycle bin and brings records back from
 * it. The counts read the rows the memory org holds now, so a count after a
 * delete counts what is left.
 *
 * Beside them, what an emptying reads of an org and nothing else does:
 *
 * - its Organization record, a sandbox unless told (`typeTarget`);
 * - the user's View All Data, Modify All Data and Bulk API Hard Delete, as
 *   `UserPermissionAccess` answers them — Bulk API Hard Delete false unless
 *   told, as it was for the admins of every test org (probes of 12/11);
 * - its Automated Process user, and an order's statuses;
 * - its `/limits`;
 * - Bulk API 2.0 delete jobs, each kept apart from the deletes over REST: a
 *   `hardDelete` job is refused as it is opened, `FEATURENOTENABLED` in the
 *   org's words, unless the user holds Bulk API Hard Delete; and what one
 *   deletes, its children taken along included, reads deleted through
 *   `queryAll` and never comes back (`UNDELETE_FAILED`), as probed live.
 *
 * Its rows are dated a day before its clock: an emptying never deletes what
 * was made after its preview read the org, and a row made in the second the
 * preview read it is no row a test means. Ids have the shape of real ones,
 * the counter padded with zeros.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { HARD_DELETE_NOT_ENABLED, type BulkDeleteAnswer } from '../core/removal/deleteRecords.js';
import type { LostBulkJob } from '../modules/forge/lostBulkJobs.js';
import type { EmptyOrg, EmptyQueryPage } from '../modules/dataops/empty/emptyOrg.js';
import { EmptyFixtureOrg, type FixtureObject, type FixtureRow } from './emptyFixtureOrg.js';
import {
  MEMORY_ORG_USER,
  orgStamp,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryRow,
} from './memoryRemovalOrg.js';
import { MemoryRestoreOrg } from './memoryRestoreOrg.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
export function fakeId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(12, '0')}AAA`;
}

/** The org's Organization Id. */
export const EMPTY_ORG_ID = fakeId('00D', 1);

/** The org's Automated Process user. */
export const AUTOMATED_PROCESS_USER = fakeId('005', 900);

/** The org's words when it refuses a hardDelete job, as asked live. */
export const NO_HARD_DELETE =
  'hardDelete operation requires special user profile permission, please contact your system administrator';

/** What the org is and what its user may do. */
export interface MemoryEmptyOrgOptions {
  /** The facts that differ from the probes' (`MEMORY_ORG_FACTS`). */
  facts?: Partial<MemoryOrgFacts>;
  /** Its clock, in ms since the epoch; a fixed day unless told. */
  now?: () => number;
  /** Not a sandbox: `IsSandbox` false, of this edition. */
  production?: { edition: string };
  viewAllData?: boolean;
  modifyAllData?: boolean;
  hardDelete?: boolean;
  /** The names its Tooling API serves. */
  tooling?: string[];
  /** What `/limits` answers in place of plenty. */
  limits?: unknown;
}

/** One delete as the org was sent it: over REST, or in a job of either kind. */
export interface SentDelete {
  via: 'rest' | 'delete' | 'hardDelete';
  objectApiName: string;
  ids: string[];
}

/** See the module's comment. */
export class MemoryEmptyOrg implements EmptyOrg {
  readonly memory: MemoryRestoreOrg;
  readonly fixture: EmptyFixtureOrg;
  /** Every delete sent, in order. */
  readonly sent: SentDelete[] = [];
  /** Jobs the org lost after their close, as a test says: what the run waits for. */
  lost: LostBulkJob[] = [];
  /** Jobs it was asked to wait for. */
  readonly waitedFor: LostBulkJob[][] = [];
  /** Called before each delete, a job's or a call's: what a test stops a run from. */
  beforeDelete?: (via: SentDelete['via'], objectApiName: string) => void;
  /**
   * The requests sent it, each call as the org counts one: a query and each
   * page after it, a describe, a write of up to 200 records, a SOAP call, a
   * job by the calls it answers it took.
   */
  private requests = 0;
  private readonly specs: FixtureObject[];
  private readonly options: MemoryEmptyOrgOptions;
  private clock: number;

  constructor(specs: readonly FixtureObject[], options: MemoryEmptyOrgOptions = {}) {
    this.options = options;
    this.clock = Date.parse('2026-11-12T10:00:00.000Z');
    const now = options.now ?? (() => this.clock);
    this.specs = specs.map((spec) => ({ ...spec, rows: [...(spec.rows ?? [])] }));
    const children: Record<string, MemoryChild[]> = {};
    for (const spec of this.specs) {
      children[spec.name] = (spec.children ?? []).map((child) => ({
        childSObject: child.childSObject,
        field: child.field,
        ...(child.cascadeDelete ? { cascadeDelete: true } : {}),
        ...(child.restrictedDelete ? { restrictedDelete: true } : {}),
      }));
    }
    // The probes' facts, a hard-deleted record still read deleted through queryAll among them.
    this.memory = new MemoryRestoreOrg(children, {
      now,
      ...(options.facts ? { facts: options.facts } : {}),
    });
    const dayBefore = orgStamp(now() - 86_400_000);
    for (const spec of this.specs) {
      for (const row of spec.rows ?? [])
        this.memory.add(spec.name, { ...row } as MemoryRow, dayBefore);
    }
    this.memory.add(
      'Organization',
      options.production
        ? { Id: EMPTY_ORG_ID, IsSandbox: false, OrganizationType: options.production.edition }
        : { Id: EMPTY_ORG_ID, IsSandbox: true },
      dayBefore,
    );
    this.memory.add(
      'UserPermissionAccess',
      {
        Id: fakeId('0PS', 1),
        PermissionsViewAllData: options.viewAllData ?? true,
        PermissionsModifyAllData: options.modifyAllData ?? true,
        PermissionsBulkApiHardDelete: options.hardDelete ?? false,
      },
      dayBefore,
    );
    this.memory.add(
      'User',
      { Id: AUTOMATED_PROCESS_USER, UserType: 'AutomatedProcess' },
      dayBefore,
    );
    this.memory.add(
      'OrderStatus',
      { Id: fakeId('0Q0', 1), ApiName: 'Draft', StatusCode: 'Draft' },
      dayBefore,
    );
    this.memory.add(
      'OrderStatus',
      { Id: fakeId('0Q0', 2), ApiName: 'Activated', StatusCode: 'Activated' },
      dayBefore,
    );
    this.fixture = new EmptyFixtureOrg(this.specs);
  }

  /** Move the org's clock on by `ms`. */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** The org's clock now, in ms. */
  get nowMs(): number {
    return this.options.now?.() ?? this.clock;
  }

  /** Whether the user holds Bulk API Hard Delete, from now on. */
  set hardDeletePermitted(permitted: boolean) {
    const [row] = this.memory.all('UserPermissionAccess');
    if (row) row.PermissionsBulkApiHardDelete = permitted;
  }

  get hardDeletePermitted(): boolean {
    return this.memory.all('UserPermissionAccess')[0]?.PermissionsBulkApiHardDelete === true;
  }

  /** The live ids of an object. */
  live(objectApiName: string): string[] {
    return this.memory.all(objectApiName).map((row) => row.Id);
  }

  /** Put a row in, made now: one the preview did not see when it was read before. */
  addNow(objectApiName: string, row: FixtureRow): void {
    this.memory.add(objectApiName, { ...row } as MemoryRow, orgStamp(this.nowMs));
  }

  /** The counts read the rows the memory org holds now, live and in the bin. */
  private sync(): void {
    for (const spec of this.specs) {
      spec.rows = [...this.memory.all(spec.name), ...this.memory.inBin(spec.name)] as FixtureRow[];
    }
  }

  /** Every request sent it so far: see {@link requests}. */
  requestsSent(): number {
    return this.requests;
  }

  describe(objectApiName: string): Promise<unknown> {
    this.requests++;
    return this.fixture.describe(objectApiName);
  }

  async count(soql: string): Promise<number> {
    this.requests++;
    this.sync();
    return this.fixture.count(soql);
  }

  async countAll(soql: string): Promise<number> {
    this.requests++;
    this.sync();
    return this.fixture.countAll(soql);
  }

  async readIds(soql: string, all: boolean): Promise<{ totalSize: number; ids: string[] }> {
    this.requests++;
    this.sync();
    return this.fixture.readIds(soql, all);
  }

  async query(soql: string, options?: { scanAll?: boolean }): Promise<EmptyQueryPage> {
    this.requests++;
    return this.memory.query(soql, options);
  }

  async queryMore(nextRecordsUrl: string): Promise<EmptyQueryPage> {
    this.requests++;
    return this.memory.queryMore(nextRecordsUrl);
  }

  queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    this.requests++;
    return this.memory.queryDeleted(soql);
  }

  async describeGlobal(): Promise<unknown> {
    this.requests++;
    return { sobjects: this.fixture.global() };
  }

  async toolingObjects(): Promise<string[]> {
    this.requests++;
    return this.options.tooling ?? ['ApexClass'];
  }

  async serverTime(): Promise<string> {
    this.requests++;
    return new Date(this.nowMs).toISOString();
  }

  async userId(): Promise<string> {
    this.requests++;
    return MEMORY_ORG_USER;
  }

  async limits(): Promise<unknown> {
    this.requests++;
    return (
      this.options.limits ?? {
        DailyApiRequests: { Max: 100_000, Remaining: 99_000 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
        DataStorageMB: { Max: 500, Remaining: 400 },
      }
    );
  }

  update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown> {
    this.requests += Math.max(1, Math.ceil(records.length / 200));
    return this.memory.update(objectApiName, records);
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.requests++;
    this.beforeDelete?.('rest', objectApiName);
    this.sent.push({ via: 'rest', objectApiName, ids: [...ids] });
    return this.memory.destroy(objectApiName, ids);
  }

  private async job(
    via: 'delete' | 'hardDelete',
    objectApiName: string,
    ids: readonly string[],
  ): Promise<BulkDeleteAnswer> {
    this.beforeDelete?.(via, objectApiName);
    this.sent.push({ via, objectApiName, ids: [...ids] });
    const answers = (await this.memory.destroy(objectApiName, [...ids])) as Array<{
      success: boolean;
      errors?: Array<{ statusCode: string; message: string }>;
    }>;
    const rows = answers.map((answer) => {
      if (answer.success) return { success: true as const };
      const [error] = answer.errors ?? [];
      return { success: false as const, error: `${error?.statusCode}:${error?.message}:--` };
    });
    if (via === 'hardDelete') {
      ids.forEach((id, at) => {
        if (rows[at].success) this.memory.hardDelete(objectApiName, id);
      });
    }
    this.requests += 7;
    return { kind: 'answered', rows, requests: 7 };
  }

  bulkDestroy(objectApiName: string, ids: readonly string[]): Promise<BulkDeleteAnswer> {
    return this.job('delete', objectApiName, ids);
  }

  async bulkHardDestroy(objectApiName: string, ids: readonly string[]): Promise<BulkDeleteAnswer> {
    if (!this.hardDeletePermitted) {
      this.requests++;
      this.sent.push({ via: 'hardDelete', objectApiName, ids: [] });
      return {
        kind: 'untouched',
        reason: NO_HARD_DELETE,
        code: HARD_DELETE_NOT_ENABLED,
        requests: 1,
      };
    }
    return this.job('hardDelete', objectApiName, ids);
  }

  undelete(ids: string[]): Promise<unknown> {
    this.requests++;
    return this.memory.undelete(ids);
  }

  lostJobs(): readonly LostBulkJob[] {
    return [...this.lost];
  }

  async stillRunning(jobs: readonly LostBulkJob[]): Promise<LostBulkJob[]> {
    this.waitedFor.push([...jobs]);
    return [];
  }
}

/** A lookup field of the fixture. */
function lookup(name: string, to: string | string[], relationshipName: string) {
  return { name, referenceTo: Array.isArray(to) ? to : [to], relationshipName };
}

/** The ids of {@link emptySalesSpecs}, by what they stand for. */
export const SALES = {
  account1: fakeId('001', 1),
  account2: fakeId('001', 2),
  contact1: fakeId('003', 1),
  contact2: fakeId('003', 2),
  contactAlone: fakeId('003', 3),
  standardBook: fakeId('01s', 1),
  customBook: fakeId('01s', 2),
  product: fakeId('01t', 1),
  standardPrice: fakeId('01u', 1),
  customPrice: fakeId('01u', 2),
  opportunity1: fakeId('006', 1),
  opportunityAlone: fakeId('006', 2),
  activatedOrder: fakeId('801', 1),
  draftOrder: fakeId('801', 2),
  orderItem: fakeId('802', 1),
  caseOfAccount2: fakeId('500', 1),
  taskOfAccount1: fakeId('00T', 1),
  taskAlone: fakeId('00T', 2),
  taskArchived: fakeId('00T', 3),
} as const;

/**
 * A sales org in miniature, every rule of an emptying's run met once: two
 * accounts, the first with two contacts, an opportunity, an activated order
 * and its product, a task; the second with a draft order and a case, which
 * its delete is refused for while it lives; a contact under no account and
 * an opportunity under none; the standard price book and a custom one, a
 * product, its standard price and a custom one; a task on nothing, and an
 * archived one.
 */
export function emptySalesSpecs(): FixtureObject[] {
  const s = SALES;
  return [
    {
      name: 'Account',
      fields: [{ name: 'Name' }, lookup('ParentId', 'Account', 'Parent')],
      children: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Order', field: 'AccountId', cascadeDelete: true, restrictedDelete: true },
        { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
        { childSObject: 'Account', field: 'ParentId' },
      ],
      rows: [
        { Id: s.account1, Name: 'First' },
        { Id: s.account2, Name: 'Second' },
      ],
    },
    {
      name: 'Contact',
      fields: [lookup('AccountId', 'Account', 'Account')],
      children: [
        { childSObject: 'Case', field: 'ContactId', restrictedDelete: true },
        { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
      ],
      rows: [
        { Id: s.contact1, AccountId: s.account1 },
        { Id: s.contact2, AccountId: s.account1 },
        { Id: s.contactAlone, AccountId: null },
      ],
    },
    {
      name: 'Pricebook2',
      fields: [{ name: 'IsStandard' }],
      children: [
        { childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'Pricebook2Id', restrictedDelete: true },
        { childSObject: 'Order', field: 'Pricebook2Id', restrictedDelete: true },
      ],
      rows: [
        { Id: s.standardBook, IsStandard: true },
        { Id: s.customBook, IsStandard: false },
      ],
    },
    {
      name: 'Product2',
      children: [
        {
          childSObject: 'PricebookEntry',
          field: 'Product2Id',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'OrderItem', field: 'Product2Id', restrictedDelete: true },
      ],
      rows: [{ Id: s.product }],
    },
    {
      name: 'PricebookEntry',
      fields: [
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        lookup('Product2Id', 'Product2', 'Product2'),
      ],
      children: [{ childSObject: 'OrderItem', field: 'PricebookEntryId', restrictedDelete: true }],
      rows: [
        { Id: s.standardPrice, Pricebook2Id: s.standardBook, Product2Id: s.product },
        { Id: s.customPrice, Pricebook2Id: s.customBook, Product2Id: s.product },
      ],
    },
    {
      name: 'Opportunity',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
      ],
      children: [{ childSObject: 'Task', field: 'WhatId', cascadeDelete: true }],
      rows: [
        { Id: s.opportunity1, AccountId: s.account1, Pricebook2Id: s.customBook },
        { Id: s.opportunityAlone, AccountId: null, Pricebook2Id: null },
      ],
    },
    {
      name: 'Order',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        { name: 'StatusCode' },
        { name: 'Status' },
      ],
      children: [{ childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true }],
      rows: [
        {
          Id: s.activatedOrder,
          AccountId: s.account1,
          Pricebook2Id: s.customBook,
          StatusCode: 'Activated',
          Status: 'Activated',
        },
        {
          Id: s.draftOrder,
          AccountId: s.account2,
          Pricebook2Id: s.standardBook,
          StatusCode: 'Draft',
          Status: 'Draft',
        },
      ],
    },
    {
      name: 'OrderItem',
      fields: [
        lookup('OrderId', 'Order', 'Order'),
        lookup('Product2Id', 'Product2', 'Product2'),
        lookup('PricebookEntryId', 'PricebookEntry', 'PricebookEntry'),
      ],
      rows: [
        {
          Id: s.orderItem,
          OrderId: s.activatedOrder,
          Product2Id: s.product,
          PricebookEntryId: s.customPrice,
        },
      ],
    },
    {
      name: 'Case',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('ContactId', 'Contact', 'Contact'),
      ],
      rows: [{ Id: s.caseOfAccount2, AccountId: s.account2, ContactId: null }],
    },
    {
      name: 'Task',
      fields: [
        lookup('WhatId', ['Account', 'Opportunity'], 'What'),
        lookup('WhoId', ['Contact'], 'Who'),
        { name: 'IsArchived' },
      ],
      rows: [
        { Id: s.taskOfAccount1, WhatId: s.account1, WhoId: null },
        { Id: s.taskAlone, WhatId: null, WhoId: null },
        { Id: s.taskArchived, WhatId: null, WhoId: null, IsArchived: true },
      ],
    },
    { name: 'ApexClass' },
  ];
}
