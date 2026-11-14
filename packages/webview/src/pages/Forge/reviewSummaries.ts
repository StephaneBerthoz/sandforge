/**
 * What Review says of a run before it opens anything: the run in one sentence,
 * what is left to decide, and each row's line. All of it comes from what the
 * screen already holds: nothing here asks the org for anything.
 */
import type { TFunction } from 'i18next';
import { leftOutAsEmptyTable } from '@sandforge/shared';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';
import { soqlRootFilter } from './forgeUtils';

/** Where a row stands. */
export type ReviewRowState = 'decide' | 'ready' | 'working' | 'failed' | 'toRead';

/** What a row says of itself. */
export interface ReviewRowSaid {
  summary: string;
  state: ReviewRowState;
}

/** Default reference-data objects — must mirror ForgeExecutor's default. */
const REFERENCE_DATA_DEFAULTS = new Set(['BusinessHours', 'OperatingHours']);

/** What a run does with each object of its graph. */
export interface ForgeRunBuckets {
  cloneObjects: string[];
  cloneRecords: number;
  /** Whether an object to clone has a count nobody took, so the records it holds are not known. */
  cloneRecordsUnknown: boolean;
  mappedObjects: string[];
  skippedExcluded: string[];
  skippedOutOfScope: string[];
}

/** Sort every object of a graph into what the run does with it. */
export function forgeRunBuckets(graph: ForgeGraph): ForgeRunBuckets {
  const cloneObjects: string[] = [];
  const mappedObjects: string[] = [];
  const skippedExcluded: string[] = [];
  const skippedOutOfScope: string[] = [];
  let cloneRecords = 0;
  let cloneRecordsUnknown = false;

  for (const node of graph.nodes) {
    if (REFERENCE_DATA_DEFAULTS.has(node.objectApiName)) {
      mappedObjects.push(node.objectApiName);
      continue;
    }
    // An empty table discovery left out ("Skip empty objects") is empty, not
    // excluded: counted as excluded, the tables of a clone read as hundreds of
    // objects nobody had unchecked.
    if (!node.included) {
      (leftOutAsEmptyTable(node) ? skippedOutOfScope : skippedExcluded).push(node.objectApiName);
      continue;
    }
    // A count nobody took is not an empty table. A starter template's graph
    // skips discovery, and its zeros read "Will clone 0 objects" with every
    // object of the template "Skipped (empty)", for a run that reads them all.
    if (node.recordCountUnknown === true) {
      cloneObjects.push(node.objectApiName);
      cloneRecordsUnknown = true;
      continue;
    }
    if (node.recordCount === 0) {
      skippedOutOfScope.push(node.objectApiName);
      continue;
    }
    cloneObjects.push(node.objectApiName);
    cloneRecords += node.recordCount;
  }
  return {
    cloneObjects,
    cloneRecords,
    cloneRecordsUnknown,
    mappedObjects,
    skippedExcluded,
    skippedOutOfScope,
  };
}

/**
 * The most records the run can write, and whether that is less sure than the
 * count: Controls can cap the objects or filter one beside the sentence, after
 * the graph was counted, and the sentence would have gone on naming the whole
 * table. The filter of a query is the query's own, which the count holds.
 */
function recordsAtMost(
  graph: ForgeGraph,
  buckets: ForgeRunBuckets,
  config: Pick<ForgeConfig, 'maxRecordsPerObject' | 'objectSoqlFilters' | 'soqlQuery'> | null,
): { records: number; atMost: boolean } {
  const cap = config?.maxRecordsPerObject;
  const cloned = new Set(buckets.cloneObjects);
  const counts = graph.nodes
    .filter((node) => cloned.has(node.objectApiName))
    .map((node) => node.recordCount);
  const records = counts.reduce((sum, count) => sum + Math.min(count, cap ?? count), 0);
  const queryRoot = config?.soqlQuery ? soqlRootFilter(config.soqlQuery)?.objectApiName : undefined;
  const filtered = Object.keys(config?.objectSoqlFilters ?? {}).some(
    (object) => cloned.has(object) && object !== queryRoot,
  );
  return { records, atMost: filtered || records < buckets.cloneRecords };
}

/** What the sentence of a run is told. */
export interface RunSentenceInput {
  graph: ForgeGraph;
  buckets: ForgeRunBuckets;
  config: Pick<
    ForgeConfig,
    'maxRecordsPerObject' | 'objectSoqlFilters' | 'soqlQuery' | 'sample'
  > | null;
  /** The run clones one record's graph (`clonesOneRecord`). */
  oneRecord: boolean;
  /** The two orgs, as the user knows them. */
  source: string;
  target: string;
  /** The run clones the whole source org (`clonesWholeOrg`). */
  wholeOrg?: boolean;
}

/**
 * The run, in a sentence. A count is said only where one is known: the counts
 * of a clone of one record are its source tables' — one case's graph read "1.2 M
 * records" and read a few hundred —, and a starter template's graph holds none.
 */
export function runSentence(
  t: TFunction,
  { graph, buckets, config, oneRecord, source, target, wholeOrg = false }: RunSentenceInput,
): string {
  const orgs = { source, target };
  const objects = buckets.cloneObjects.length;
  // The whole org: every record of every object it takes, which a count says
  // as far as the org gave one.
  if (wholeOrg) {
    // A sample is drawn from those records, never all of them: the heading
    // says what the run copies.
    return t(
      config?.sample ? 'forgeRun.review.sentence.sample' : 'forgeRun.review.sentence.wholeOrg',
      {
        ...orgs,
        count: buckets.cloneRecords,
        formatted: buckets.cloneRecords.toLocaleString(uiLocale()),
        objects: objects.toLocaleString(uiLocale()),
      },
    );
  }
  if (buckets.cloneRecordsUnknown) {
    return t('forgeRun.review.sentence.notCounted', { ...orgs, count: objects });
  }
  if (oneRecord) return t('forgeRun.review.sentence.oneRecord', { ...orgs, count: objects });
  const { records, atMost } = recordsAtMost(graph, buckets, config);
  const count = { ...orgs, count: records, formatted: records.toLocaleString(uiLocale()) };
  return atMost
    ? t('forgeRun.review.sentence.atMost', count)
    : t('forgeRun.review.sentence.counted', count);
}

/** What the line under the sentence is told. */
export interface LeftToDecideInput {
  /** The gaps that will refuse rows with no decision taken. */
  undecided: number;
  /** The run waits for the files to be accepted as they are. */
  filesBlocked: boolean;
  /** The read of the target's gaps is under way. */
  reading: boolean;
  /** The read of the target's gaps could not run. */
  readFailed: boolean;
}

/**
 * What is left to decide before the run. "Nothing" is said only once the
 * target was read: while its gaps are on their way, or could not be read, it
 * is not known.
 */
export function leftToDecide(
  t: TFunction,
  { undecided, filesBlocked, reading, readFailed }: LeftToDecideInput,
): string {
  const decisions = undecided + (filesBlocked ? 1 : 0);
  if (decisions > 0) return t('forgeRun.review.left.decisions', { count: decisions });
  if (readFailed) return t('forgeRun.review.row.gaps.failed');
  if (reading) return t('forgeRun.review.gapsRead.pending');
  return t('forgeRun.review.left.none');
}

/** What the Gaps row is told. */
export interface GapsRowInput {
  undecided: number;
  reading: boolean;
  readFailed: boolean;
  /** The gaps the row lists. */
  shown: number;
  /** The parts of the target a read could not read. */
  unread: number;
}

/** The Gaps row: a decision first, then a read that is not there, then what it found. */
export function gapsRowSaid(
  t: TFunction,
  { undecided, reading, readFailed, shown, unread }: GapsRowInput,
): ReviewRowSaid {
  if (undecided > 0) {
    return {
      summary: t('forgeRun.review.row.gaps.undecided', { count: undecided }),
      state: 'decide',
    };
  }
  if (readFailed) return { summary: t('forgeRun.review.row.gaps.failed'), state: 'failed' };
  if (reading) return { summary: t('forgeRun.review.gapsRead.pending'), state: 'working' };
  if (shown > 0) {
    return { summary: t('forgeRun.review.row.gaps.found', { count: shown }), state: 'toRead' };
  }
  // A read that found nothing is not one that could not look.
  if (unread > 0) return { summary: t('forgeRun.review.row.gaps.partly'), state: 'toRead' };
  return { summary: t('forgeRun.gaps.none'), state: 'ready' };
}

/** The Anonymization row. */
export function anonymizationRowSaid(
  t: TFunction,
  { personalFields, anonymizes }: { personalFields: number; anonymizes: boolean },
): ReviewRowSaid {
  if (personalFields === 0) {
    return { summary: t('forgeRun.review.row.anonymization.none'), state: 'ready' };
  }
  return anonymizes
    ? {
        summary: t('forgeRun.review.row.anonymization.on', { count: personalFields }),
        state: 'ready',
      }
    : {
        summary: t('forgeRun.review.row.anonymization.off', { count: personalFields }),
        state: 'toRead',
      };
}

/** Where the Compliance tab stands, as it tells its row. */
export type ComplianceRowStatus =
  | { step: 'none' }
  | { step: 'loading' | 'failed' | 'waiting'; framework: string }
  | { step: 'report'; framework: string; verdict: string; passed: boolean };

/** The Compliance row. */
export function complianceRowSaid(t: TFunction, status: ComplianceRowStatus): ReviewRowSaid {
  switch (status.step) {
    case 'none':
      return { summary: t('forgeRun.review.row.compliance.none'), state: 'ready' };
    case 'loading':
      return { summary: t('forgeRun.review.complianceLoading'), state: 'working' };
    case 'waiting':
      return { summary: t('forgeRun.review.complianceWaiting'), state: 'working' };
    case 'failed':
      return { summary: t('forgeRun.review.row.compliance.failed'), state: 'failed' };
    case 'report':
      return {
        summary: t('forgeRun.review.row.compliance.report', {
          framework: status.framework,
          verdict: status.verdict,
        }),
        state: status.passed ? 'ready' : 'toRead',
      };
  }
}

/** The Metadata row. */
export function metadataRowSaid(
  t: TFunction,
  { pending, failed, differences }: { pending: boolean; failed: boolean; differences: number },
): ReviewRowSaid {
  if (failed) return { summary: t('forgeRun.review.row.metadata.failed'), state: 'failed' };
  if (pending) return { summary: t('forgeRun.review.diffsLoading'), state: 'working' };
  return differences > 0
    ? { summary: t('forgeRun.review.diffsFound', { count: differences }), state: 'toRead' }
    : { summary: t('forgeRun.review.noDiffs'), state: 'ready' };
}

/** What the Automation row is told. */
export interface AutomationRowInput {
  failed: boolean;
  /** The target's automation was read. */
  read: boolean;
  /** A part that lists what runs could not be read. */
  blind: boolean;
  /** What fires as the run inserts its records, on the objects it still writes. */
  firedAtInsert: number;
  /** The objects the run writes that run anything at all. */
  objectsWithAutomation: number;
  /** What still runs may send emails. */
  sendsEmails: boolean;
}

/** The Automation row. */
export function automationRowSaid(
  t: TFunction,
  { failed, read, blind, firedAtInsert, objectsWithAutomation, sendsEmails }: AutomationRowInput,
): ReviewRowSaid {
  if (failed) return { summary: t('forgeRun.review.row.automation.failed'), state: 'failed' };
  if (!read) return { summary: t('forgeRun.review.automation.loading'), state: 'working' };
  const emails = sendsEmails ? ` ${t('forgeRun.review.row.automation.emails')}` : '';
  if (firedAtInsert > 0) {
    const fires = t('forgeRun.review.row.automation.fires', { count: firedAtInsert });
    return { summary: `${fires}${emails}`, state: 'toRead' };
  }
  if (objectsWithAutomation > 0) {
    return {
      summary: `${t('forgeRun.review.row.automation.notOnInsert')}${emails}`,
      state: 'toRead',
    };
  }
  return blind
    ? { summary: t('forgeRun.review.automation.nothingSeen'), state: 'toRead' }
    : { summary: t('forgeRun.review.row.automation.none'), state: 'ready' };
}

/** How many settings of the run Controls holds: closed, it must still say they are there. */
export function controlsSet(
  config: Pick<
    ForgeConfig,
    | 'fieldExclusions'
    | 'objectSoqlFilters'
    | 'fieldMappings'
    | 'maxRecordsPerObject'
    | 'ownerMappings'
  > | null,
): number {
  if (!config) return 0;
  const entries = (held: object | undefined): number => Object.keys(held ?? {}).length;
  return (
    entries(config.fieldExclusions) +
    entries(config.objectSoqlFilters) +
    entries(config.fieldMappings) +
    entries(config.ownerMappings) +
    (config.maxRecordsPerObject === undefined ? 0 : 1)
  );
}
