/**
 * What a sample of the whole org may take of the target, as the panel reads
 * it: the terms a run's plan is drawn against (`ForgeSampleStream.budget`),
 * and what Review says of a sample before it is simulated
 * (`ForgeSampleBudget`).
 *
 * The bytes are a fit's (`fitBudgetOf`): the share of what `/limits` says is
 * left past which a run's gate asks, once the margin for its rounding is off,
 * or the MB asked when lower. What the target's automation still creates
 * under the records kept is taken off as they are chosen, per record
 * (`automationBytes`), never guessed whole before the draw. The records a
 * run writes are held to the target's daily API requests and Bulk API
 * batches as the gate prices them (`sampleRequestsBoundOf`).
 */

import {
  BYTES_PER_MB,
  FORGE_SAMPLE_DEFAULTS,
  leftOutByTheUser,
  type ForgeGraph,
  type ForgeSampleBudget,
  type ForgeSampleOptions,
  type ForgeWholeOrgAllowanceCheck,
} from '@sandforge/shared';
import { SECONDS_PER_PAGE } from '../../checkpoint/rewindEstimate.js';
import {
  API_BUDGET_NEAR_SHARE,
  DELIVERABILITY_READ_MOST,
  STORAGE_NEAR_SHARE,
  apiBudgetCheckOf,
  countedStorageBytes,
  forgeRequestPartsOf,
  storageCheckOf,
  wholeOrgCostOf,
  type ApiBudget,
  type DataStorage,
} from '../ForgeRunGate.js';
import { STORAGE_ROUNDING_MARGIN_MB, fitBudgetOf, type RoomPerRecord } from '../fitBudget.js';
import type { SampleBudgetTerms } from './sampleDrawing.js';
import type { SampleBounds } from './sampleFit.js';
import { sampleLinksOf, type SampleObjectInput } from './sampleLinks.js';
import { rootScanRequestsOf } from './sampleReader.js';
import { rootsTheBudgetHolds } from './sampleRank.js';

/** The objects a run matches by name in the target and never writes, as a run is set up by default. */
const REFERENCE_DATA = new Set(['BusinessHours', 'OperatingHours']);

/**
 * What a sample's writes are held to beside the storage, as the target says
 * it as the sample is drawn: its daily API requests and Bulk API batches,
 * each read from the answer that gives its storage, or the requests on their
 * own when the storage could not be, or why they could not be; what was
 * sent the target before the run's gate prices it, which the gate counts
 * with the run's writes (`forgeRequestPartsOf`'s `sentBefore`); and the
 * objects whose records its second pass writes again, which it prices twice.
 */
export interface SampleAllowances {
  requests?: ApiBudget | { unread: string };
  bulkBatches?: ApiBudget | { unread: string };
  sentBefore?: number;
  updatedAfterInsert?: readonly string[];
}

/** What `allowance` leaves a run once a tenth of the day is kept and `taken` is off; undefined unread. */
function allowanceLeft(
  allowance: ApiBudget | { unread: string } | undefined,
  taken: number,
): number | undefined {
  if (!allowance || 'unread' in allowance) return undefined;
  return Math.floor(allowance.remaining - API_BUDGET_NEAR_SHARE * allowance.max - taken);
}

/**
 * The bounds on requests a sample is cut to (`SampleBounds.requests`): per
 * object, the records the run writes, priced as the gate of a clone of the
 * whole org prices them — its jobs and REST calls as the Bulk API sends them
 * and what it reads of the target for each object it writes
 * (`forgeRequestPartsOf`), the Bulk API batches its jobs take
 * (`wholeOrgCostOf`), the updates of its second pass among them — against
 * what each allowance leaves once a tenth of
 * the day is kept, as a fit's run requests are (`fitBudgetOf`): the requests
 * less what was sent the target before and the read of whether it delivers
 * its emails, at most (`DELIVERABILITY_READ_MOST`). Which objects a duplicate
 * rule of the target watches is not asked before the run: they go by REST,
 * as the writer takes those of the standard rules when the target will not
 * say, which prices them higher, never lower. Undefined when the target said
 * neither allowance: the gate says what it could not read.
 *
 * No producer gave these bounds: a sample was cut to the storage alone, and
 * a simulation offered one — every record of the org, said to fit — that its
 * gate then refused for the target's requests.
 */
export function sampleRequestsBoundOf(
  allowances: SampleAllowances,
): SampleBounds['requests'] | undefined {
  const requestsLeft = allowanceLeft(
    allowances.requests,
    Math.max(0, allowances.sentBefore ?? 0) + DELIVERABILITY_READ_MOST,
  );
  const batchesLeft = allowanceLeft(allowances.bulkBatches, 0);
  if (requestsLeft === undefined && batchesLeft === undefined) return undefined;
  const updated = allowances.updatedAfterInsert
    ? { updatedAfterInsert: allowances.updatedAfterInsert }
    : {};
  return (written) => {
    const objects = [...written].map(([objectApiName, rows]) => ({
      objectApiName,
      rows,
      storageBytes: 0,
    }));
    if (
      requestsLeft !== undefined &&
      forgeRequestPartsOf({ plan: { objects }, ...updated, bulk: {} }).run > requestsLeft
    ) {
      return 'targetRequests';
    }
    if (
      batchesLeft !== undefined &&
      wholeOrgCostOf({ plan: { objects }, ...updated, measures: {} }).bulkBatches > batchesLeft
    ) {
      return 'bulkBatches';
    }
    return undefined;
  };
}

/**
 * The terms a sample is drawn against: the bytes it may take and what gives
 * them — what the target has left (`storage`), or the MB asked (`within`) —,
 * the target's room before the MB asked, which the objects copied whole and
 * the roots set aside are chosen against, what the target's automation
 * that still runs creates under each record of an object the run writes,
 * and the bounds of its requests ({@link sampleRequestsBoundOf}).
 *
 * Undefined when the target would not say its data storage and no MB is
 * asked: nothing bounds the sample (`SAMPLE_STORAGE_UNREAD`).
 *
 * @param input.automation - What still runs creates under one record of each
 *   object, per act (`automationRoomOf`): an update of the second pass is of
 *   a record the run inserted, so both count under it.
 * @param input.allowances - The target's daily requests and Bulk API
 *   batches, and what was sent it before; none, the requests bound nothing.
 */
export function sampleBudgetTermsOf(input: {
  storage: Pick<DataStorage, 'maxMB' | 'remainingMB'> | { unread: string };
  withinMB?: number;
  automation?: readonly Pick<RoomPerRecord, 'objectApiName' | 'bytes'>[];
  allowances?: SampleAllowances;
}): SampleBudgetTerms | undefined {
  const { storage, withinMB } = input;
  const perRecord = new Map<string, number>();
  for (const room of input.automation ?? []) {
    perRecord.set(room.objectApiName, (perRecord.get(room.objectApiName) ?? 0) + room.bytes);
  }
  const bound = input.allowances ? sampleRequestsBoundOf(input.allowances) : undefined;
  const perRecordAndRequests = {
    ...(perRecord.size > 0
      ? { automationBytes: (objectApiName: string) => perRecord.get(objectApiName) ?? 0 }
      : {}),
    ...(bound ? { requests: bound } : {}),
  };
  if ('unread' in storage) {
    if (withinMB === undefined) return undefined;
    const bytes = Math.floor(Math.max(0, withinMB) * BYTES_PER_MB);
    return {
      budget: { bytes, withinMB, limitedBy: 'within' },
      bytesLimit: 'within',
      roomBytes: bytes,
      ...perRecordAndRequests,
    };
  }
  const fit = fitBudgetOf({ storage, ...(withinMB !== undefined ? { withinMB } : {}) });
  if ('unread' in fit) return undefined;
  const bytesLimit = fit.terms.limitedBy === 'within' ? 'within' : 'storage';
  // What the storage leaves the sample, the MB asked aside: past it, the
  // storage holds what the sample needs, whatever MB is asked.
  const storageBytes = Math.floor(
    STORAGE_NEAR_SHARE *
      Math.max(0, storage.remainingMB - STORAGE_ROUNDING_MARGIN_MB) *
      BYTES_PER_MB,
  );
  return {
    budget: {
      bytes: fit.bytes,
      remainingMB: storage.remainingMB,
      maxMB: storage.maxMB,
      share: STORAGE_NEAR_SHARE,
      roundingMB: STORAGE_ROUNDING_MARGIN_MB,
      ...(withinMB !== undefined ? { withinMB } : {}),
      limitedBy: bytesLimit,
    },
    bytesLimit,
    roomBytes: storageBytes,
    storageBytes,
    ...perRecordAndRequests,
  };
}

/**
 * The objects of a whole org's graph a run takes, as a sample reads them
 * before it is drawn: each with what discovery counted, and a lookup of each
 * relation the graph keeps, at its parent — required as the graph says it,
 * set or not as it says. The graph keeps one relation per pair of objects,
 * where the plan reads every lookup of each object's describe: what this
 * tells of the objects copied whole, the plan says again once drawn.
 */
function objectsOfTheGraph(
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>,
  excluded: ReadonlySet<string>,
): SampleObjectInput[] {
  const taken = graph.nodes.filter(
    (node) => node.included && !leftOutByTheUser(node) && !excluded.has(node.objectApiName),
  );
  const names = new Set(taken.map((node) => node.objectApiName));
  return taken.map((node) => ({
    objectApiName: node.objectApiName,
    rows: node.recordCountUnknown === true ? undefined : node.recordCount,
    fields: graph.edges
      .filter((edge) => edge.targetObject === node.objectApiName && names.has(edge.sourceObject))
      .map((edge, index) => ({
        name: `${edge.relationshipName || edge.sourceObject}${index}`,
        referenceTo: [edge.sourceObject],
        isMasterDetail: edge.type === 'master-detail',
        nillable: edge.required !== true && edge.type !== 'master-detail',
        createable: edge.settable !== false,
        updateable: edge.settable !== false,
      })),
  }));
}

/**
 * What Review says of a sample of the whole org before it is simulated
 * (`ForgeSampleBudget`), from discovery's graph and the limits of both orgs:
 *
 * - every record the run takes, at the sizes the gate documents, against
 *   the data storage the target has left: "about 412 MB for 4.5 MB left";
 * - what a sample may take with the options asked, their defaults when the
 *   config copies every record — nothing when the target would not say its
 *   storage and no MB is asked;
 * - the objects it copies whole of itself, and why, from the graph's
 *   relations ({@link objectsOfTheGraph}); those asked are the config's;
 * - about what drawing it reads of the source: a count of each object's
 *   roots, and the pages of their ids — every root's for a draw spread over
 *   the org, the newest the budget holds for a draw of the most recent —
 *   priced as if every record were a root, but of an object whose records
 *   cannot be written without the record above them, which has none,
 *   against a tenth of what the
 *   source has left, past which the draw is refused; and the seconds it
 *   takes, a page a second. The reads of the records the roots bring in are
 *   said once drawn (`WholeOrgSample.planRequests`). A window or filters on
 *   the roots add a count of each object they hold, and leave fewer roots
 *   than discovery counted: the estimate is then at most (`atMost`). An
 *   object stratified and drawn by date reads a statement per value
 *   besides, which no count of discovery tells: said once the values are
 *   counted, as the draw prices itself again before an id is read.
 */
export function sampleBudgetPreviewOf(input: {
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>;
  options: ForgeSampleOptions | undefined;
  excludedObjects?: readonly string[];
  storage: DataStorage | { unread: string };
  source: ApiBudget | { unread: string };
  /** The most records an object is read whole in (`sandforge.forge.maxRecordsPerObject`). */
  maxRecordsPerObject?: number;
}): ForgeSampleBudget {
  const options = input.options ?? {};
  const objects = objectsOfTheGraph(input.graph, new Set(input.excludedObjects ?? []));
  const everyRecord = objects.reduce(
    (sum, object) => sum + countedStorageBytes(object.objectApiName, { rows: object.rows ?? 0 }),
    0,
  );
  const storage = storageCheckOf({ storageBytes: everyRecord }, input.storage);
  const terms = sampleBudgetTermsOf({
    storage: input.storage,
    ...(options.withinMB !== undefined ? { withinMB: options.withinMB } : {}),
  });
  const links = sampleLinksOf({
    objects,
    referenceData: REFERENCE_DATA,
    ...(options.whole ? { whole: options.whole } : {}),
    roomBytes: terms?.roomBytes ?? 0,
    ...(input.maxRecordsPerObject !== undefined
      ? { maxRecordsPerObject: input.maxRecordsPerObject }
      : {}),
    wholeBytes: (objectApiName, rows) => countedStorageBytes(objectApiName, { rows }),
  });
  const draw = options.draw ?? FORGE_SAMPLE_DEFAULTS.draw;
  const most = terms ? rootsTheBudgetHolds(terms.budget.bytes, options.maxTotal) : 0;
  const rooted = objects.filter((object) => {
    const kind = links.classes.get(object.objectApiName);
    return kind?.kind === 'drawn' && kind.rooted;
  });
  // A window holds the roots of every object, a filter those of its own:
  // each object so held is counted a second time, without them, for the
  // roots of the source its report says beside those of the draw.
  const filtered = new Set(Object.keys(options.rootWhere ?? {}).map((name) => name.toLowerCase()));
  const restricts = (objectApiName: string): boolean =>
    options.window !== undefined || filtered.has(objectApiName.toLowerCase());
  const estimate = rooted.reduce((sum, object) => {
    // A record that cannot be written without the record above it always
    // names one: its object has no root, and its count reads none.
    const rootless = (links.linksOf.get(object.objectApiName) ?? []).some(
      (link) => link.carries && link.required,
    );
    const rows = rootless ? 0 : (object.rows ?? 0);
    return (
      sum +
      1 +
      (restricts(object.objectApiName) ? 1 : 0) +
      rootScanRequestsOf(
        { objectApiName: object.objectApiName, rows, exact: false },
        draw,
        Math.min(rows, most),
      )
    );
  }, 0);
  // Held to a window or filters, the roots of the draw are fewer than the
  // records discovery counted: what it reads is that at most.
  const restricted = options.window !== undefined || filtered.size > 0;
  return {
    wholeOrg: storage,
    ...(terms ? { budget: terms.budget } : {}),
    whole: links.whole.filter((entry) => entry.why !== 'asked'),
    planReads: {
      source: planReadsCheckOf(estimate, input.source),
      seconds: estimate * SECONDS_PER_PAGE,
      ...(restricted ? { atMost: true as const } : {}),
    },
  };
}

/**
 * The requests drawing a sample reads of the source, against what the
 * source has left today: `exceeds` past a tenth of it, where the draw is
 * refused before an id is read; otherwise as any of a run's requests are
 * weighed against what is left (`apiBudgetCheckOf`).
 */
function planReadsCheckOf(
  estimate: number,
  source: ApiBudget | { unread: string },
): ForgeWholeOrgAllowanceCheck {
  if ('unread' in source) return { verdict: 'unread', estimate, unread: source.unread };
  const check = apiBudgetCheckOf(estimate, source);
  if (check.verdict === 'unread') return check;
  const refused = estimate > Math.floor(API_BUDGET_NEAR_SHARE * source.remaining);
  return { ...check, verdict: refused ? 'exceeds' : check.verdict };
}
