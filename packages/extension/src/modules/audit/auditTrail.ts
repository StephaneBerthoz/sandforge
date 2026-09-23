import type {
  AuditAction,
  AuditFacets,
  AuditLogEntry,
  AuditObjectCounts,
  AuditOutcome,
  GuardDecision,
  LineageOrigin,
} from '@sandforge/shared';

import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { OrgManager } from '../../core/connection/OrgManager.js';
import type { Services } from '../../services.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { buildLineageGraph, LineageStore } from './lineage.js';

/** Entries kept; the oldest are dropped past it. */
export const AUDIT_TRAIL_LIMIT = 2_000;

/** Entries a page holds when the request does not say. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Where the trail lives: one array, oldest first, in ConfigStore — where every
 * history of this product is kept, so it survives a restart like the rest.
 */
const AUDIT_TRAIL_KEY = 'audit:trail';
const AUDIT_TRAIL_CATEGORY = 'audit';

/** A request for part of the trail. */
export interface AuditQuery {
  module?: string;
  orgId?: string;
  offset?: number;
  limit?: number;
}

/** One page of the trail, newest first. */
export interface AuditPage {
  entries: AuditLogEntry[];
  /** Entries the filter matches, before paging. */
  total: number;
  offset: number;
  facets: AuditFacets;
}

/**
 * The runs that wrote to an org, one entry each, kept across restarts.
 *
 * Append-only: an entry is added once, when its run ends, and never edited.
 * Bounded at {@link AUDIT_TRAIL_LIMIT}, the oldest dropped first, because
 * ConfigStore is one blob that VS Code serializes whole on every write — an
 * unbounded trail would grow the cost of every unrelated setting saved. An
 * entry holds counts, so two thousand of them stay small.
 */
export class AuditTrailStore {
  /**
   * @param configStore - The window's store.
   * @param limit - Entries kept; the oldest are dropped past it.
   */
  constructor(
    private readonly configStore: Pick<ConfigStore, 'get' | 'set'>,
    private readonly limit: number = AUDIT_TRAIL_LIMIT,
  ) {}

  /** Add one entry after the others. */
  append(entry: AuditLogEntry): void {
    const entries = this.read();
    entries.push(entry);
    this.configStore.set(AUDIT_TRAIL_KEY, entries.slice(-this.limit), AUDIT_TRAIL_CATEGORY);
  }

  /**
   * Part of the trail, newest first.
   *
   * @param query - Module and org to keep (both optional), and the page.
   * @returns The page, the number of entries the filter matches, and the
   *   modules and orgs of the whole trail — which a page cannot tell.
   */
  list(query: AuditQuery = {}): AuditPage {
    const newestFirst = this.read().reverse();
    const matching = newestFirst.filter(
      (entry) =>
        (query.module === undefined || entry.module === query.module) &&
        (query.orgId === undefined || entry.orgId === query.orgId),
    );
    const offset = query.offset ?? 0;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    return {
      entries: matching.slice(offset, offset + limit),
      total: matching.length,
      offset,
      facets: facetsOf(newestFirst),
    };
  }

  /** What is stored, oldest first, with anything unreadable left out. */
  private read(): AuditLogEntry[] {
    const raw = this.configStore.get<unknown>(AUDIT_TRAIL_KEY);
    return Array.isArray(raw) ? raw.filter(isAuditEntry) : [];
  }
}

/** Modules and orgs of the trail, an org under the alias it was last recorded with. */
function facetsOf(newestFirst: readonly AuditLogEntry[]): AuditFacets {
  const modules = new Set<string>();
  const orgs = new Map<string, string | undefined>();
  for (const entry of newestFirst) {
    modules.add(entry.module);
    if (entry.orgId !== undefined && !orgs.has(entry.orgId)) orgs.set(entry.orgId, entry.orgAlias);
  }
  return {
    modules: [...modules].sort(),
    orgs: [...orgs].map(([orgId, orgAlias]) => (orgAlias ? { orgId, orgAlias } : { orgId })),
  };
}

/**
 * Whether a stored value has the shape the page reads. An entry written by
 * an older build, or edited by hand, is skipped rather than handed to a view
 * that would fail on it.
 */
function isAuditEntry(value: unknown): value is AuditLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<AuditLogEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.action === 'string' &&
    typeof entry.module === 'string' &&
    typeof entry.timestamp === 'string'
  );
}

/** Where the records of a run came from. */
export type RunSource =
  | { origin: 'org'; orgId: string }
  | { origin: Exclude<LineageOrigin, 'org'>; label?: string };

/** One run that wrote to an org, as its write path reports it when it ends. */
export interface WriteRun {
  action: AuditAction;
  module: string;
  /** The id the run's `operation:*` messages carried. */
  operationId: string;
  /** The org the run wrote to. */
  orgId: string;
  outcome: AuditOutcome;
  /** Production Guard's decision, when the path consulted it. */
  guard?: GuardDecision;
  /** Per object, what the run did. */
  objects?: readonly AuditObjectCounts[];
  /** Where the records came from; no lineage is kept for a run without one. */
  source?: RunSource;
  /**
   * Per object, the records the run carried to the org, counted from the
   * run's own source→target id map where it keeps one. Left out, the lineage
   * counts what the run wrote: created, updated and upserted.
   */
  carried?: Readonly<Record<string, number>>;
}

/** What {@link recordWriteRun} needs from the window. */
export interface AuditDeps {
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  orgManager: Pick<OrgManager, 'getOrg'>;
  log: (msg: string) => void;
  /**
   * The window's settings, for `sandforge.safety.auditLogging`. Absent, the
   * setting reads as its default: on.
   */
  services?: Pick<Services, 'getSandforgeSetting'>;
}

/**
 * Record one write run: its entry in the audit trail, and its lineage.
 *
 * The one call every path that writes to an org makes, once per run, when
 * the run ends — or when Production Guard stops it before it starts. Nothing
 * of the data goes in: object names and counts, the org, the outcome and the
 * guard's decision. Error messages stay out too, because a Salesforce error
 * can quote the value it refused.
 *
 * Never throws. A run is over by the time it is recorded, and a failure to
 * record it is logged rather than turned into a failure of the run.
 *
 * @param deps - Store, org lookup and log.
 * @param run - What the run did.
 * @param now - When it ended (injected by tests).
 */
export function recordWriteRun(deps: AuditDeps, run: WriteRun, now: Date = new Date()): void {
  try {
    // `safety.auditLogging` is the switch a user turns off to have Production
    // Guard's decisions recorded nowhere. Off, a run is recorded without the
    // decision, and a run the guard stopped — nothing but its decision — is
    // not recorded at all.
    const decisionsKept =
      deps.services?.getSandforgeSetting?.<boolean>('safety.auditLogging', true) !== false;
    if (!decisionsKept && run.outcome === 'stopped') return;

    const timestamp = now.toISOString();
    const orgAlias = deps.orgManager.getOrg(run.orgId)?.alias;
    const sourceOrgId = run.source?.origin === 'org' ? run.source.orgId : undefined;
    const sourceOrgAlias =
      sourceOrgId !== undefined ? deps.orgManager.getOrg(sourceOrgId)?.alias : undefined;
    const objects = run.objects ?? [];

    new AuditTrailStore(deps.configStore).append({
      id: crypto.randomUUID(),
      action: run.action,
      module: run.module,
      orgId: run.orgId,
      ...(orgAlias ? { orgAlias } : {}),
      ...(sourceOrgId !== undefined ? { sourceOrgId } : {}),
      ...(sourceOrgAlias ? { sourceOrgAlias } : {}),
      operationId: run.operationId,
      outcome: run.outcome,
      ...(decisionsKept && run.guard ? { guard: run.guard } : {}),
      objects: [...objects],
      details: {},
      timestamp,
    });

    if (!run.source) return;
    const graph = buildLineageGraph({
      operationId: run.operationId,
      module: run.module,
      action: run.action,
      source:
        run.source.origin === 'org'
          ? {
              origin: 'org',
              orgId: run.source.orgId,
              label: sourceOrgAlias ?? run.source.orgId,
            }
          : { origin: run.source.origin, label: run.source.label ?? '' },
      target: { label: orgAlias ?? run.orgId, orgId: run.orgId },
      objects: carriedCounts(objects, run.carried),
      generatedAt: timestamp,
    });
    if (graph) new LineageStore(deps.configStore).save(graph);
  } catch (err: unknown) {
    deps.log(
      `[WARN] audit trail: run ${run.operationId} was not recorded — ${extractErrorMessage(err)}`,
    );
  }
}

/**
 * Per object, what the lineage counts: the run's id map when it has one,
 * otherwise what it wrote.
 */
function carriedCounts(
  objects: readonly AuditObjectCounts[],
  carried: Readonly<Record<string, number>> | undefined,
): Array<{ objectApiName: string; records: number }> {
  if (carried) {
    return Object.entries(carried).map(([objectApiName, records]) => ({ objectApiName, records }));
  }
  return objects.map((o) => ({
    objectApiName: o.objectApiName,
    records: o.created + o.updated + (o.upserted ?? 0),
  }));
}

/** An object's counts with nothing in them yet, to fill in. */
export function emptyCounts(objectApiName: string): AuditObjectCounts {
  return { objectApiName, created: 0, updated: 0, deleted: 0, failed: 0 };
}
