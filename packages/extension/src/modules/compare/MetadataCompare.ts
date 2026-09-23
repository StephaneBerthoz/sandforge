import { createHash } from 'node:crypto';
import type {
  CompareContentCoverage,
  CompareItem,
  MetadataComponentType,
  NotComparedReason,
} from '@sandforge/shared';
import type { DiffEngine } from './DiffEngine';
import type { ContentReader, ReadContent } from './ContentReader';
import { logger } from '../../logger.js';

/**
 * Function signature for listing one type in one org: each component's
 * fullName, with what listMetadata says about it serialised.
 */
export type FetchMetadataFn = (
  orgId: string,
  componentType: MetadataComponentType,
) => Promise<Map<string, string>>;

/** How much one comparison reads by content. */
export type ReadBudget = CompareContentCoverage['budget'];

/** What a comparison leaves out of the listings before it compares anything. */
export interface CompareScope {
  /** Whether the components a managed package installed are compared; see {@link installedByPackage}. */
  includeManaged: boolean;
}

/** The verdict on every component compared, and what the scope left out. */
export interface MetadataComparison {
  items: CompareItem[];
  /** Components a managed package installed, left out of both listings; 0 when they were compared. */
  managedLeftOut: number;
}

/**
 * The manageable states a namespaced org gives its own components. What a
 * package installed is `installed`, `installedEditable`, `deprecated` or
 * `deprecatedEditable`; an org with a namespace of its own lists its own
 * components under that namespace too, so the prefix alone would leave out
 * everything a packaging org holds.
 */
const OWN_MANAGEABLE_STATES: ReadonlySet<string> = new Set(['unmanaged', 'beta', 'released']);

/**
 * Whether a listing entry is a component a managed package installed: it
 * carries the package's namespace prefix, in a state that is not the org's
 * own. Two sandboxes listed their 22 Apex classes this way: 8 `installed`
 * under one namespace, 14 `unmanaged` with none; their standard objects carry
 * neither field.
 *
 * @param listing - The entry as `FetchMetadataFn` serialises it.
 */
export function installedByPackage(listing: string): boolean {
  let entry: unknown;
  try {
    entry = JSON.parse(listing);
  } catch {
    return false;
  }
  if (typeof entry !== 'object' || entry === null) return false;
  const { namespacePrefix, manageableState } = entry as Record<string, unknown>;
  if (typeof namespacePrefix !== 'string' || namespacePrefix === '') return false;
  return typeof manageableState !== 'string' || !OWN_MANAGEABLE_STATES.has(manageableState);
}

/**
 * Both listings of one type without what a managed package installed, and how
 * many components that was. A component either org lists as installed leaves
 * both: left out of one side alone, it would read as added or removed.
 */
function withoutManaged(
  source: Map<string, string>,
  target: Map<string, string>,
): { source: Map<string, string>; target: Map<string, string>; leftOut: number } {
  const managed = new Set<string>();
  for (const listing of [source, target]) {
    for (const [name, entry] of listing) {
      if (installedByPackage(entry)) managed.add(name);
    }
  }
  const keep = (listing: Map<string, string>) =>
    new Map([...listing].filter(([name]) => !managed.has(name)));
  return { source: keep(source), target: keep(target), leftOut: managed.size };
}

/**
 * Five hundred components from each org, and no read started after ninety
 * seconds.
 *
 * Reading everything is out of reach: "select all" between two sandboxes
 * listed 25,484 components, 24,442 of them custom fields, and readMetadata
 * takes ten a call. Between those two sandboxes, 374 components had listings
 * that differ, and 352 of those go through readMetadata: this budget reads
 * all of them. Measured there, ten profiles took 23 s to read, ten objects
 * 4.7 s, most batches about a second; listing everything took 87 s, and the
 * page stops waiting at five minutes. Ninety seconds of reads leaves room.
 */
export const DEFAULT_READ_BUDGET: ReadBudget = { components: 500, seconds: 90 };

/** Batches read at once, each from both orgs side by side. */
const READS_IN_FLIGHT = 4;

/** What the modal shows of a modified component: lines before the first difference, and from it. */
const EXCERPT_BEFORE = 3;
const EXCERPT_LINES = 30;
const EXCERPT_LINE_CHARS = 240;

/** One type, as each org lists it. */
interface Listing {
  componentType: MetadataComponentType;
  source: Map<string, string>;
  target: Map<string, string>;
}

/** What a comparison reads, and what it leaves out and why. */
export interface ReadPlan {
  toRead: Map<MetadataComponentType, string[]>;
  notCompared: Map<MetadataComponentType, Map<string, NotComparedReason>>;
}

/** What was read of one type: the answers of both orgs, and the names no read reached. */
interface TypeContent {
  source: ReadContent;
  target: ReadContent;
  unread: Set<string>;
}

/**
 * Compares metadata components between two Salesforce orgs.
 *
 * Presence comes from the listing; everything else from content. A listing
 * cannot say whether a component changed: it carries the component's id and
 * the dates and users of its last change, which differ between two orgs
 * whether or not anything else does. Judged on it, all 22 Apex classes two
 * sandboxes held were "modified"; read, 7 differed, 7 were the same, and 8
 * came from a managed package whose source neither org shows. So a component
 * both orgs hold is read from each, normalised, and hashed, and it is
 * `modified` only when the two hashes differ. One that was not read is
 * `not_compared`, never a change.
 */
export class MetadataCompare {
  private readonly fetchMetadata: FetchMetadataFn;
  private readonly diffEngine: DiffEngine;
  private readonly reader: ContentReader;
  /** The bound every run reads within; the result reports it. */
  readonly budget: ReadBudget;
  private readonly now: () => number;

  constructor(
    fetchMetadata: FetchMetadataFn,
    diffEngine: DiffEngine,
    reader: ContentReader,
    options: { budget?: ReadBudget; now?: () => number } = {},
  ) {
    this.fetchMetadata = fetchMetadata;
    this.diffEngine = diffEngine;
    this.reader = reader;
    this.budget = options.budget ?? DEFAULT_READ_BUDGET;
    this.now = options.now ?? Date.now;
  }

  /**
   * Compare metadata between source and target orgs for the given component types.
   * Lists each type in both orgs, leaves out what the scope excludes, reads
   * what both hold within the budget, and produces a unified diff list.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string,
    types: MetadataComponentType[],
    scope: CompareScope = { includeManaged: true },
  ): Promise<MetadataComparison> {
    const listings: Listing[] = [];
    let managedLeftOut = 0;
    for (const componentType of types) {
      const [listedInSource, listedInTarget] = await Promise.all([
        this.fetchMetadata(sourceOrgId, componentType),
        this.fetchMetadata(targetOrgId, componentType),
      ]);
      if (scope.includeManaged) {
        listings.push({ componentType, source: listedInSource, target: listedInTarget });
        continue;
      }
      const { source, target, leftOut } = withoutManaged(listedInSource, listedInTarget);
      managedLeftOut += leftOut;
      listings.push({ componentType, source, target });
    }

    const plan = planReads(
      listings,
      (componentType) => this.reader.batchSize(componentType),
      this.budget.components,
    );
    const contents = await this.readPlanned(sourceOrgId, targetOrgId, plan.toRead);

    const allItems: CompareItem[] = [];
    for (const { componentType, source, target } of listings) {
      allItems.push(
        ...this.judge(
          componentType,
          source,
          target,
          plan.toRead.get(componentType) ?? [],
          plan.notCompared.get(componentType) ?? new Map(),
          contents.get(componentType),
        ),
      );
    }
    return { items: allItems, managedLeftOut };
  }

  /** Read every planned batch from both orgs, a few at a time, until the time runs out. */
  private async readPlanned(
    sourceOrgId: string,
    targetOrgId: string,
    toRead: Map<MetadataComponentType, string[]>,
  ): Promise<Map<MetadataComponentType, TypeContent>> {
    const startedAt = this.now();
    const deadline = startedAt + this.budget.seconds * 1000;
    const contents = new Map<MetadataComponentType, TypeContent>();
    const batches: Array<() => Promise<void>> = [];

    for (const [componentType, names] of toRead) {
      const content: TypeContent = { source: new Map(), target: new Map(), unread: new Set() };
      contents.set(componentType, content);
      const size = this.reader.batchSize(componentType) ?? names.length;
      for (let i = 0; i < names.length; i += size) {
        const batch = names.slice(i, i + size);
        batches.push(async () => {
          if (this.now() >= deadline) {
            for (const name of batch) content.unread.add(name);
            return;
          }
          const [source, target] = await Promise.all([
            this.readOne(sourceOrgId, componentType, batch),
            this.readOne(targetOrgId, componentType, batch),
          ]);
          for (const [name, value] of source) content.source.set(name, value);
          for (const [name, value] of target) content.target.set(name, value);
        });
      }
    }

    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        await batch();
      }
    };
    await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, batches.length) }, lane));
    return contents;
  }

  /** One read; a failure leaves its names unread, which the verdict reports. */
  private async readOne(
    orgId: string,
    componentType: MetadataComponentType,
    batch: string[],
  ): Promise<ReadContent> {
    try {
      return await this.reader.read(orgId, componentType, batch);
    } catch (err: unknown) {
      logger.warn(
        `[compare] reading ${batch.length} ${componentType} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Map();
    }
  }

  /** The verdict on every component of one type. */
  private judge(
    componentType: MetadataComponentType,
    sourceListing: Map<string, string>,
    targetListing: Map<string, string>,
    planned: string[],
    notCompared: Map<string, NotComparedReason>,
    content: TypeContent | undefined,
  ): CompareItem[] {
    const source = new Map(sourceListing);
    const target = new Map(targetListing);
    const read = new Map<string, { source: string; target: string }>();
    const reasons = new Map(notCompared);

    for (const name of planned) {
      const sourceContent = content?.source.get(name);
      const targetContent = content?.target.get(name);
      if (content?.unread.has(name)) {
        reasons.set(name, 'over_budget');
      } else if (sourceContent === null || targetContent === null) {
        reasons.set(name, 'unreadable');
      } else if (sourceContent === undefined || targetContent === undefined) {
        reasons.set(name, 'read_failed');
      } else {
        // The engine compares what it is given: here, the hash of each copy.
        source.set(name, hash(sourceContent));
        target.set(name, hash(targetContent));
        read.set(name, { source: sourceContent, target: targetContent });
      }
    }

    return this.diffEngine.diff(source, target, componentType, reasons).map((item) => {
      if (item.status === 'modified') {
        const both = read.get(item.fullName);
        const excerpt = both ? firstDifference(both.source, both.target) : undefined;
        return { ...item, sourceValue: excerpt?.source, targetValue: excerpt?.target };
      }
      if (item.status === 'unchanged') {
        return { ...item, sourceValue: undefined, targetValue: undefined };
      }
      return item;
    });
  }
}

/**
 * Which components both orgs hold are read, within `budget` per org.
 *
 * Those whose listings differ come first: an identical listing (same id, same
 * last change) is a copy both orgs took of one version, while a differing one
 * says nothing either way. Within each of the two groups the budget is shared
 * evenly across types, a type needing less than its share leaving the rest to
 * the others, so one type of twenty-four thousand fields cannot crowd out the
 * flows. Past the budget, a component is `over_budget`; of a type that cannot
 * be read, `unreadable`.
 */
export function planReads(
  listings: ReadonlyArray<Pick<Listing, 'componentType' | 'source' | 'target'>>,
  batchSize: (componentType: MetadataComponentType) => number | undefined,
  budget: number,
): ReadPlan {
  const toRead = new Map<MetadataComponentType, string[]>();
  const notCompared = new Map<MetadataComponentType, Map<string, NotComparedReason>>();
  const differing: string[][] = [];
  const identical: string[][] = [];

  for (const { componentType, source, target } of listings) {
    const inBoth = [...source.keys()].filter((name) => target.has(name)).sort();
    const reasons = new Map<string, NotComparedReason>();
    notCompared.set(componentType, reasons);
    if (batchSize(componentType) === undefined) {
      for (const name of inBoth) reasons.set(name, 'unreadable');
      differing.push([]);
      identical.push([]);
      continue;
    }
    differing.push(inBoth.filter((name) => source.get(name) !== target.get(name)));
    identical.push(inBoth.filter((name) => source.get(name) === target.get(name)));
  }

  const first = shareOut(
    differing.map((names) => names.length),
    budget,
  );
  const spent = first.reduce((sum, n) => sum + n, 0);
  const second = shareOut(
    identical.map((names) => names.length),
    budget - spent,
  );

  listings.forEach(({ componentType }, index) => {
    const reasons = notCompared.get(componentType) ?? new Map<string, NotComparedReason>();
    const chosen = [
      ...differing[index].slice(0, first[index]),
      ...identical[index].slice(0, second[index]),
    ];
    for (const name of differing[index].slice(first[index])) reasons.set(name, 'over_budget');
    for (const name of identical[index].slice(second[index])) reasons.set(name, 'over_budget');
    if (chosen.length > 0) toRead.set(componentType, chosen);
  });

  return { toRead, notCompared };
}

/** Split `budget` across demands evenly, the smallest served first. */
function shareOut(demands: number[], budget: number): number[] {
  const shares = demands.map(() => 0);
  const order = demands.map((_, index) => index).sort((a, b) => demands[a] - demands[b]);
  let left = Math.max(0, budget);
  let waiting = order.length;
  for (const index of order) {
    const take = Math.min(demands[index], Math.floor(left / waiting));
    shares[index] = take;
    left -= take;
    waiting -= 1;
  }
  return shares;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Where two copies of a component part: a few lines before the first line
 * that differs and the lines from there, numbered, from each copy. A whole
 * class or profile side by side hides a one-line difference in its length.
 */
export function firstDifference(
  source: string,
  target: string,
): { source: string; target: string } {
  const a = source.split('\n');
  const b = target.split('\n');
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - EXCERPT_BEFORE);
  return { source: excerpt(a, from), target: excerpt(b, from) };
}

function excerpt(lines: string[], from: number): string {
  const to = Math.min(lines.length, from + EXCERPT_LINES);
  const width = String(to).length;
  const out = lines.slice(from, to).map((line, index) => {
    const text = line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS)}…` : line;
    return `${String(from + index + 1).padStart(width)}│ ${text}`;
  });
  if (from > 0) out.unshift('…');
  if (to < lines.length) out.push('…');
  return out.join('\n');
}
