import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeUndoObjectResult,
  ForgeUndoResult,
} from '@sandforge/shared';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));
// The removal is the real one, run against an org in miniature: what the
// panel hands it of the run's other parts is what this file is about.
vi.mock('../../modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/forge/ForgeRunRemoval.js')>();
  return { ...actual, removalOrg: vi.fn() };
});

import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { removalOrg, type RemovalOrg } from '../../modules/forge/ForgeRunRemoval.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { MEMORY_ORG_USER, MemoryRemovalOrg, type MemoryRow } from '../../test/memoryRemovalOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';

const TARGET_ORG = 'tgt-org';
/** A fake source id: the object's prefix, then a number. */
const SRC = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;
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
/** When the cut part wrote, and when the resume did, on the org's clock. */
const PART_0 = { first: at('10:00:01'), last: at('10:00:03') };
const PART_1 = { first: at('10:02:01'), last: at('10:02:03') };

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 6,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/**
 * The target as the gate's target answered: deleting a product line changes
 * its opportunity's amount, dated as modified by the user who deleted it, and
 * feed tracking records the change on it as created by that user; a feed item
 * keeps no `LastModifiedById`.
 */
class GateOrg extends MemoryRemovalOrg {
  private feeds = 0;

  constructor(now: () => number) {
    super(
      {
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
        Quote: [{ childSObject: 'Opportunity', field: 'SyncedQuoteId' }],
      },
      { now },
    );
    this.missingFields.set('FeedItem', new Set(['LastModifiedById']));
  }

  protected override removed(objectApiName: string, row: MemoryRow): void {
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

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('forge:undo of a run cut and taken up: its parts, removed from the panel in any order', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: ForgeHandler;
  let org: GateOrg;
  let clock: number;

  /** Move the clocks of this machine and of the org to `time`. */
  function setClock(time: string): void {
    clock = Date.parse(time);
    vi.setSystemTime(clock);
  }

  const history = (): ForgeExecutionResult[] =>
    store.get<ForgeExecutionResult[]>('forge:history') ?? [];

  /**
   * The run as the gate played it, kept in the history as the panel keeps a
   * part a cancel stopped and the part its resume wrote: the cut part wrote
   * the account, the contact and the opportunity, which owed its synced quote
   * to the second pass, and the platform wrote the contact role with the
   * opportunity. The resume wrote the quote, paid the opportunity its
   * `SyncedQuoteId`, linked the role and gave it the source's fields, then
   * wrote the product line.
   *
   * @param roleMadeAt - When the contact role was made: with the opportunity
   *   unless told.
   */
  function theRun(roleMadeAt = at('10:00:03')): void {
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
    setClock(at('10:02:01'));
    org.add('Quote', {
      Id: QUOTE.target,
      OpportunityId: OPPORTUNITY.target,
      ...byTheRun(at('10:02:01')),
    });
    org.edit('Opportunity', OPPORTUNITY.target, { SyncedQuoteId: QUOTE.target });
    setClock(at('10:02:02'));
    org.edit('OpportunityContactRole', ROLE.target, { Role: 'Decision Maker' });
    setClock(at('10:02:03'));
    org.add('OpportunityLineItem', {
      Id: LINE.target,
      OpportunityId: OPPORTUNITY.target,
      ...byTheRun(at('10:02:03')),
    });

    const table = Object.fromEntries(
      [ACCOUNT, CONTACT, OPPORTUNITY, QUOTE, LINE, ROLE].map((ids) => [ids.source, ids.target]),
    );
    const cut: ForgeExecutionResult = {
      forgeId: 'run-cut',
      status: 'partial',
      cancelled: true,
      graph: GRAPH,
      duration: 5_000,
      timestamp: at('10:00:05'),
      idRemapCount: 3,
      idRemapTable: {
        [ACCOUNT.source]: ACCOUNT.target,
        [CONTACT.source]: CONTACT.target,
        [OPPORTUNITY.source]: OPPORTUNITY.target,
      },
      idRemapExisting: [],
      idRemapCreated: [
        { objectApiName: 'Account', sourceIds: [ACCOUNT.source] },
        { objectApiName: 'Contact', sourceIds: [CONTACT.source] },
        { objectApiName: 'Opportunity', sourceIds: [OPPORTUNITY.source] },
      ],
      targetOrgId: TARGET_ORG,
      writtenBetween: PART_0,
      journalId: 'run-cut',
      journalPart: 0,
      runUserId: MEMORY_ORG_USER,
    };
    const resumed: ForgeExecutionResult = {
      forgeId: 'run-resumed',
      status: 'success',
      graph: GRAPH,
      duration: 6_000,
      timestamp: at('10:02:05'),
      idRemapCount: 6,
      idRemapTable: table,
      // What the cut part wrote, linked to as written before the run stopped,
      // and the role the platform wrote, linked to with its opportunity.
      idRemapExisting: [ACCOUNT.source, CONTACT.source, OPPORTUNITY.source, ROLE.source],
      idRemapWithTheirRecord: [ROLE.source],
      idRemapCreated: [
        { objectApiName: 'Quote', sourceIds: [QUOTE.source] },
        { objectApiName: 'OpportunityLineItem', sourceIds: [LINE.source] },
      ],
      targetOrgId: TARGET_ORG,
      writtenBetween: PART_1,
      retryOf: 'run-cut',
      resumed: true,
      // The lookup the cut part's opportunity owed, filled in by the resume.
      wroteToEarlierParts: [OPPORTUNITY.target],
      runUserId: MEMORY_ORG_USER,
    };
    store.set('forge:history', [resumed, cut], 'forge');
  }

  /** Remove the part `forgeId` at `time`, and say what the removal answered. */
  async function remove(forgeId: string, time: string): Promise<ForgeUndoResult | undefined> {
    setClock(time);
    vi.mocked(deps.broker.postToWebview).mockClear();
    await handler.handle(buildMsg('forge:undo', { forgeId }));
    const errors = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: { message?: string } })
      .filter((m) => m.type === 'forge:undo:error');
    expect(errors.map((e) => e.payload.message)).toEqual([]);
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: { result: ForgeUndoResult } })
      .find((m) => m.type === 'forge:undo:response')?.payload.result;
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
      'FeedItem',
    ]) {
      const count = org.all(object).length;
      if (count > 0) counts[object] = count;
    }
    return counts;
  }

  const kept = (objects: readonly ForgeUndoObjectResult[] | undefined) =>
    (objects ?? [])
      .filter((o) => o.keptChanged + o.keptDependents + o.refused > 0)
      .map((o) => [o.objectApiName, o.keptChanged, o.keptDependents]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    clock = Date.parse(at('10:00:00'));
    org = new GateOrg(() => clock);
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
        backgroundRegistry: new BackgroundOperationRegistry(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    vi.mocked(getJsforceConnection).mockResolvedValue({} as never);
    vi.mocked(removalOrg).mockReturnValue(org as unknown as RemovalOrg);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the resume first, then the cut part: nothing of the run is left, its contact role included', async () => {
    theRun();

    const resumed = await remove('run-resumed', at('10:05:00'));
    const cut = await remove('run-cut', at('10:08:00'));

    expect(resumed?.status).toBe('success');
    expect(kept(cut?.objects)).toEqual([]);
    expect(cut?.status).toBe('success');
    expect(left()).toEqual({});
  });

  it("the cut part first, held by the resume's records, then the resume, then the cut part again: nothing is left", async () => {
    theRun();

    const cut = await remove('run-cut', at('10:05:00'));
    const resumed = await remove('run-resumed', at('10:08:00'));
    const again = await remove('run-cut', at('10:10:00'));

    // The opportunity holds the resume's quote and product line, the account
    // the opportunity: kept for records of the run that stay, not as changed.
    expect(cut?.status).toBe('partial');
    expect(kept(cut?.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(cut?.objects.find((o) => o.objectApiName === 'Opportunity')?.heldBy).toEqual([
      'OpportunityLineItem',
      'Quote',
    ]);
    expect(resumed?.status).toBe('success');
    expect(again?.status).toBe('success');
    expect(kept(again?.objects)).toEqual([]);
    expect(left()).toEqual({});
    // Neither part has a record left for the history to offer.
    expect(history().map((e) => [e.forgeId, e.undo?.kept])).toEqual([
      ['run-resumed', 0],
      ['run-cut', 0],
    ]);
  });

  it("the cut part first says the run that took it up holds what it kept; that run's removal says what the cut part's left", async () => {
    theRun();

    const cut = await remove('run-cut', at('10:05:00'));

    // The page's own advice was to include what changed, which takes what
    // others added since too: the resume's removal takes the holders without
    // it, and the cut part's, asked again, the rest.
    expect(cut?.heldByOtherParts).toEqual([
      { forgeId: 'run-resumed', objects: ['OpportunityLineItem', 'Quote'] },
    ]);
    expect(cut).not.toHaveProperty('otherPartsLeft');
    const resumed = await remove('run-resumed', at('10:08:00'));
    expect(resumed?.status).toBe('success');
    expect(resumed).not.toHaveProperty('heldByOtherParts');
    expect(resumed?.otherPartsLeft).toEqual([{ forgeId: 'run-cut', records: 2 }]);
  });

  it('says nothing of the other part when the resume goes first and the cut part takes the rest', async () => {
    theRun();

    const resumed = await remove('run-resumed', at('10:05:00'));
    const cut = await remove('run-cut', at('10:08:00'));

    for (const result of [resumed, cut]) {
      expect(result).not.toHaveProperty('heldByOtherParts');
      expect(result).not.toHaveProperty('otherPartsLeft');
    }
  });

  it('keeps a contact a colleague changed between the parts, and the account it holds', async () => {
    theRun();
    setClock(at('10:01:00'));
    org.edit('Contact', CONTACT.target, { Title: 'Buyer' }, COLLEAGUE);

    await remove('run-resumed', at('10:05:00'));
    const cut = await remove('run-cut', at('10:08:00'));

    expect(kept(cut?.objects)).toEqual([
      ['Contact', 1, 0],
      ['Account', 0, 1],
    ]);
    expect(cut).not.toHaveProperty('heldByOtherParts');
    expect(left()).toEqual({ Account: 1, Contact: 1 });
  });

  it('keeps a contact role made between the parts, as the run’s user even, which the resume linked to, and what it hangs from', async () => {
    theRun(at('10:01:00'));

    await remove('run-resumed', at('10:05:00'));
    const cut = await remove('run-cut', at('10:08:00'));

    expect(kept(cut?.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(left()).toMatchObject({ OpportunityContactRole: 1, Opportunity: 1 });
  });

  it('keeps the contact role a colleague changed after the resume, and what it hangs from', async () => {
    theRun();
    setClock(at('10:03:00'));
    org.edit('OpportunityContactRole', ROLE.target, { Role: 'Economic Buyer' }, COLLEAGUE);

    await remove('run-resumed', at('10:05:00'));
    const cut = await remove('run-cut', at('10:08:00'));

    expect(kept(cut?.objects)).toEqual([
      ['Opportunity', 0, 1],
      ['Contact', 0, 1],
      ['Account', 0, 1],
    ]);
    expect(left()).toMatchObject({ OpportunityContactRole: 1, Opportunity: 1, Contact: 1 });
  });
});
