/**
 * The counts a seed's template takes to fit what its target has left of its
 * data storage: proposed with the refusal of a seed that does not fit, and
 * seeded by `--fit` on the command line, the gate met again by what it seeds.
 *
 * Two of the five templates of the gallery do not fit a Developer Edition's
 * 5 MB — Service Cloud Starter takes about 7.6 MB, Sales Cloud Starter 14.9 —
 * and a new user who picked one was refused with "lower the records per
 * object", left to work the counts out by hand, children by their parents.
 * The template holds everything a fit needs: its counts, its relations, the
 * sizes Salesforce documents, and what `/limits` said at the gate. Fitting
 * it reads nothing more.
 *
 * - An object whose count no relation of the seed sets — no relation, or
 *   one to records the org holds — keeps about the share of its count, at
 *   least one.
 * - A child of a relation to the records the seed writes keeps no more than
 *   the share of its count, nor than the parents kept can hold
 *   (`plannedChildCount`): accounts with two contacts each, cut to 121
 *   accounts at a share of 0.2429, write the 242 contacts they hold, not the
 *   243 that share of 1,000 gives.
 * - Rows a template gives — a scenario's, a CSV's — and the children a
 *   relation places by key are kept whole: they are a scenario's cases, and
 *   its tests name them.
 * - The share is the largest that fits, to one record of the object it steps
 *   by — the root with the most records, a child following its parents: the
 *   records and what the target's automation that still runs creates under
 *   them within the budget, their API requests leaving a tenth of the day.
 *   One record more of that object, and they no longer fit.
 * - Caps, asked of the command line, come first: at most so many records of
 *   an object, or of every one, the children following their parents; the
 *   share, when asked too, is taken of what the caps leave.
 * - No count is ever raised: a fit only takes records away.
 *
 * The room kept for the target's automation is counted from what still runs
 * once the run's mute holds (`stillRunningOf`), one record of each object its
 * flows create per record they fire on. A seed inserts its records; the only
 * ones it writes again are the article versions a scenario publishes once
 * written, and what fires on their update is counted for them alone.
 */

import {
  BYTES_PER_MB,
  plannedChildCount,
  relationFor,
  stillRunningOf,
  type ForgeAutomationWrite,
  type ForgeTargetAutomation,
  type MutePlan,
  type SeedFitProposal,
  type SeedObjectConfig,
  type SeedRelation,
  type SeedRelationCountedDistribution,
  type SeedTemplate,
  type StillRunning,
} from '@sandforge/shared';
import {
  automationRoomOf,
  roomBytesOf,
  storageFitBudgetOf,
  type AutomationRoom,
  type FitBudget,
} from '../forge/fitBudget.js';
import { formatMB } from '../forge/ForgeRunGate.js';
import { ARTICLE_VERSION_OBJECT } from './seedKnowledge.js';
import { seedRequestsEstimate, seedStorageBytes } from './seedStorage.js';

/** The template a fit reads: its objects and their relations. */
type FitTemplate = Pick<SeedTemplate, 'objects' | 'relations'>;

/** At most so many records of an object (`objects`), and of every object not named (`all`). */
export interface SeedFitCaps {
  all?: number;
  objects?: Readonly<Record<string, number>>;
}

/** What a fit is asked: the largest share that fits, caps, or caps then the share. */
export interface SeedFitAsk {
  /** By share. Without caps, a fit is by share whatever this says. */
  share?: boolean;
  caps?: SeedFitCaps;
}

/** A seed's template fitted to its target: the proposal, and what held it. */
export interface SeedFit {
  proposal: SeedFitProposal;
  /**
   * What held the counts: what the target has left of its storage, the bound
   * asked (`within`), or today's API requests; `caps` when what the caps
   * leave fits as it is, `whole` when the template does, nothing cut.
   */
  heldBy: 'storage' | 'within' | 'apiRequests' | 'caps' | 'whole';
  /** The records proposed. */
  records: number;
  /** The API requests their writes make. */
  requests: number;
}

/** What still runs of the target's automation as a seed writes, and the room it takes under the records. */
export interface SeedRoom {
  /** Absent when the target's automation could not be read. */
  running?: StillRunning<ForgeTargetAutomation>;
  room: AutomationRoom;
  /** Why no room is kept: the target's automation was not read. */
  unread?: string;
}

/** The writes a seed makes of its records, as what still runs is read for them. */
export type SeedWrites = (objectApiName: string, write: ForgeAutomationWrite) => boolean;

/**
 * The writes a seed makes: it inserts the records of each object of its
 * template, and writes again, to publish them, the article versions of a
 * scenario's run — the only records it updates.
 *
 * @param publishes - Whether the run publishes its articles once written (a scenario's).
 */
export function seedWritesOf(
  template: Pick<SeedTemplate, 'objects'>,
  publishes = false,
): SeedWrites {
  const written = new Set(
    template.objects.filter((o) => o.recordCount > 0).map((o) => o.objectApiName),
  );
  return (objectApiName, write) =>
    written.has(objectApiName) &&
    (write === 'insert' ||
      (write === 'update' && publishes && objectApiName === ARTICLE_VERSION_OBJECT));
}

/**
 * What still runs of the target's automation as the seed writes, once its
 * mute's plan holds — nothing assigned — and the room the records it creates
 * take under the seed's: the one computation the fit counts its room from.
 * A read that failed keeps no room, and says why.
 *
 * @param plan - The sets the mute is to hold; absent for a seed that does not mute.
 */
export function seedRoomOf(
  read: ForgeTargetAutomation | { unread: string },
  plan: Pick<MutePlan, 'assign'> | undefined,
  writes: SeedWrites,
): SeedRoom {
  if (typeof read.unread === 'string') {
    return { room: { perRecord: [], notCounted: [] }, unread: read.unread };
  }
  const running = stillRunningOf(read as ForgeTargetAutomation, plan, writes);
  return { running, room: automationRoomOf(running, writes) };
}

/** Why an object's count is kept as the template gives it, if it is. */
function keptWholeOf(
  object: Pick<SeedObjectConfig, 'objectApiName' | 'rows'>,
  relations: readonly SeedRelation[] | undefined,
): 'rows' | 'byKey' | undefined {
  if (relationFor(object.objectApiName, relations)?.distribution.mode === 'byKey') return 'byKey';
  return object.rows !== undefined ? 'rows' : undefined;
}

/** The relation of `objectApiName` to the records the seed writes of another object of it, if any. */
function generatedRelationOf(
  objectApiName: string,
  template: FitTemplate,
): (SeedRelation & { distribution: SeedRelationCountedDistribution }) | undefined {
  const relation = relationFor(objectApiName, template.relations);
  if (
    !relation ||
    relation.parents.kind !== 'generated' ||
    relation.distribution.mode === 'byKey' ||
    relation.parentObject === objectApiName ||
    !template.objects.some((o) => o.objectApiName === relation.parentObject)
  ) {
    return undefined;
  }
  return relation as SeedRelation & { distribution: SeedRelationCountedDistribution };
}

/** An object's count once its cap holds. */
function cappedCount(
  object: Pick<SeedObjectConfig, 'objectApiName' | 'recordCount'>,
  caps?: SeedFitCaps,
): number {
  const cap = caps?.objects?.[object.objectApiName] ?? caps?.all;
  return cap !== undefined
    ? Math.min(object.recordCount, Math.max(1, Math.floor(cap)))
    : object.recordCount;
}

/**
 * Each object's count at `share` of what its caps leave, in the template's
 * order: a root about the share of its count, at least one; a child of a
 * relation to the records the seed writes no more than its parents kept can
 * hold; rows and keyed children as the template gives them. Never more than
 * the template asks.
 */
export function seedCountsAt(
  template: FitTemplate,
  share: number,
  caps?: SeedFitCaps,
): Map<string, number> {
  const byName = new Map(template.objects.map((o) => [o.objectApiName, o]));
  const counted = new Map<string, number>();
  const visiting = new Set<string>();
  const countOf = (objectApiName: string): number => {
    const known = counted.get(objectApiName);
    if (known !== undefined) return known;
    const object = byName.get(objectApiName) as SeedObjectConfig;
    if (keptWholeOf(object, template.relations)) {
      counted.set(objectApiName, object.recordCount);
      return object.recordCount;
    }
    visiting.add(objectApiName);
    const scaled = Math.round(share * cappedCount(object, caps));
    const relation = generatedRelationOf(objectApiName, template);
    const count =
      relation && !visiting.has(relation.parentObject)
        ? Math.max(
            1,
            Math.min(
              scaled,
              plannedChildCount(relation.distribution, countOf(relation.parentObject)),
            ),
          )
        : Math.max(1, scaled);
    visiting.delete(objectApiName);
    counted.set(objectApiName, count);
    return count;
  };
  return new Map(template.objects.map((o) => [o.objectApiName, countOf(o.objectApiName)]));
}

/**
 * The template with the counts of a fit: those it proposes, every other
 * part as it was. A proposal that cannot fit leaves it as it was.
 */
export function fittedTemplate<T extends Pick<SeedTemplate, 'objects'>>(
  template: T,
  proposal: Pick<SeedFitProposal, 'objects' | 'cannotFit'>,
): T {
  if (proposal.cannotFit !== undefined) return template;
  const after = new Map(proposal.objects.map((o) => [o.objectApiName, o.after]));
  return {
    ...template,
    objects: template.objects.map((object) => {
      const count = after.get(object.objectApiName);
      return count !== undefined && count < object.recordCount
        ? { ...object, recordCount: count }
        : object;
    }),
  };
}

/**
 * The object whose records the share steps by: of those the share scales,
 * the one with the most records once capped, a root first — a child follows
 * its parents. Absent when every count is kept whole.
 */
function stepObjectOf(
  template: FitTemplate,
  caps: SeedFitCaps | undefined,
): { objectApiName: string; records: number } | undefined {
  const scaled = template.objects.filter((o) => !keptWholeOf(o, template.relations));
  const roots = scaled.filter((o) => !generatedRelationOf(o.objectApiName, template));
  let best: { objectApiName: string; records: number } | undefined;
  for (const object of roots.length > 0 ? roots : scaled) {
    const records = cappedCount(object, caps);
    if (!best || records > best.records) best = { objectApiName: object.objectApiName, records };
  }
  return best;
}

/**
 * The largest `k` of `1 … top` for which `fits(k)` holds, `fits` holding up
 * to a point and no further; 0 when it does not hold at 1.
 */
function largestFitting(top: number, fits: (k: number) => boolean): number {
  if (!fits(1)) return 0;
  if (fits(top)) return top;
  let lo = 1;
  let hi = top;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** What counts take, as a fit measures them. */
interface Measure {
  counts: Map<string, number>;
  /** The records' bytes and the room's under them, together. */
  bytes: number;
  roomBytes: number;
  requests: number;
  records: number;
}

/** Records, as a sentence counts them. */
function recordsWords(n: number): string {
  return `${n} record${n === 1 ? '' : 's'}`;
}

/**
 * Fit a seed's template to its target: the largest share of every count —
 * after the caps, when asked — whose records, and what the target's
 * automation that still runs creates under them, take no more than the
 * budget, their writes no more API requests than leave a tenth of the
 * day. Proposed, never applied here: a person applies it, or `--fit`.
 *
 * What cannot be cut — rows a template gives, one record of each other
 * object, or what the caps leave when no share is asked — past the budget is
 * said in `cannotFit`, with the counts it would take and nothing proposed.
 */
export function fitSeedTemplate(input: {
  template: FitTemplate;
  personObjects: readonly string[];
  budget: FitBudget;
  room: Pick<AutomationRoom, 'perRecord' | 'notCounted'>;
  ask?: SeedFitAsk;
}): SeedFit {
  const { template, personObjects, budget, room } = input;
  const caps = input.ask?.caps;
  const byShare = input.ask?.share === true || caps === undefined;
  const measureAt = (share: number): Measure => {
    const counts = seedCountsAt(template, share, caps);
    const fitted = fittedTemplate(template, {
      objects: template.objects.map((o) => ({
        objectApiName: o.objectApiName,
        before: o.recordCount,
        after: counts.get(o.objectApiName) ?? o.recordCount,
      })),
    });
    const roomBytes = roomBytesOf(room, (objectApiName) => counts.get(objectApiName) ?? 0);
    return {
      counts,
      bytes: seedStorageBytes(fitted, personObjects) + roomBytes,
      roomBytes,
      requests: seedRequestsEstimate(fitted),
      records: [...counts.values()].reduce((sum, n) => sum + n, 0),
    };
  };
  const inStorage = (m: Measure): boolean => m.bytes <= budget.bytes;
  const inRequests = (m: Measure): boolean =>
    budget.runRequests === undefined || m.requests <= budget.runRequests;
  const fits = (m: Measure): boolean => inStorage(m) && inRequests(m);

  const proposalOf = (share: number, m: Measure, cannotFit?: string): SeedFitProposal => ({
    share,
    budget: storageFitBudgetOf(budget, m.roomBytes, room),
    objects: template.objects.map((object) => {
      const keptWhole = keptWholeOf(object, template.relations);
      return {
        objectApiName: object.objectApiName,
        before: object.recordCount,
        after: m.counts.get(object.objectApiName) ?? object.recordCount,
        ...(keptWhole ? { keptWhole } : {}),
      };
    }),
    estimateMB: m.bytes / BYTES_PER_MB,
    ...(cannotFit !== undefined ? { cannotFit } : {}),
  });
  const result = (
    share: number,
    m: Measure,
    heldBy: SeedFit['heldBy'],
    cannotFit?: string,
  ): SeedFit => ({
    proposal: proposalOf(share, m, cannotFit),
    heldBy,
    records: m.records,
    requests: m.requests,
  });
  /** Why `m` is past the budget, in words: its storage, or its requests. */
  const overWords = (m: Measure): string =>
    inStorage(m)
      ? `about ${m.requests} API requests, past the ${budget.runRequests ?? 0} that leave the ` +
        'org a tenth of its daily requests'
      : `${formatMB(m.bytes / BYTES_PER_MB)} MB` +
        (m.roomBytes > 0
          ? ", room for what the org's automation creates under them included"
          : '') +
        `, past the ${formatMB(budget.bytes / BYTES_PER_MB)} MB that fit`;
  const keptRows = template.objects
    .filter((o) => keptWholeOf(o, template.relations))
    .reduce((sum, o) => sum + o.recordCount, 0);

  const whole = measureAt(1);
  if (fits(whole)) {
    const cut = template.objects.some(
      (o) => (whole.counts.get(o.objectApiName) ?? 0) < o.recordCount,
    );
    return result(1, whole, cut ? 'caps' : 'whole');
  }
  if (!byShare) {
    return result(
      1,
      whole,
      budget.terms.limitedBy,
      `with these caps the seed takes ${overWords(whole)}: lower them, or fit by share`,
    );
  }
  const step = stepObjectOf(template, caps);
  if (!step) {
    return result(
      1,
      whole,
      budget.terms.limitedBy,
      `the ${keptRows} rows the template gives take ${overWords(whole)}, and rows are kept whole`,
    );
  }
  const at = (k: number): Measure => measureAt(k / step.records);
  const k = largestFitting(step.records, (n) => fits(at(n)));
  if (k === 0) {
    const least = at(1);
    return result(
      1 / step.records,
      least,
      budget.terms.limitedBy,
      `the least it can be cut to — one ${step.objectApiName} and what follows it` +
        (keptRows > 0 ? `, with the ${keptRows} rows the template gives kept whole` : '') +
        `, ${recordsWords(least.records)} — takes ${overWords(least)}`,
    );
  }
  // The requests held it when the storage alone would have let more through.
  const kStorage = largestFitting(step.records, (n) => inStorage(at(n)));
  return result(k / step.records, at(k), kStorage > k ? 'apiRequests' : budget.terms.limitedBy);
}

/**
 * The fit proposed with the refusal of a seed for its storage or its API
 * requests: by share, from what the gate read, room kept for what still runs
 * of the target's automation. Nothing when the target would not say its
 * storage: there is nothing to fit to.
 */
export function seedFitProposalOf(
  budget: FitBudget | { unread: string },
  template: FitTemplate,
  personObjects: readonly string[],
  room: Pick<AutomationRoom, 'perRecord' | 'notCounted'>,
): SeedFitProposal | undefined {
  if ('unread' in budget) return undefined;
  return fitSeedTemplate({ template, personObjects, budget, room }).proposal;
}
