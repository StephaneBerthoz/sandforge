import { z } from 'zod';
import type { SalesforceOrg } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { OrgManager } from '../../core/connection/OrgManager.js';
import type { SandboxRefreshEvent } from './SandboxRefreshTracker.js';

/**
 * Notices that a registered sandbox was refreshed, from the sandbox itself.
 *
 * A refresh replaces the sandbox with a new copy of production, and the copy
 * is a new org: Salesforce documents that the org ID of a sandbox changes each
 * time it is refreshed. The username and the My Domain stay, so the sf CLI —
 * and the token refresh SandForge runs through it — reconnect to the new org
 * without a word, and whatever SandForge held about the old one goes on
 * describing an org that no longer exists.
 *
 * The org id is the signal because it is the one thing a refresh is sure to
 * change. `Organization.CreatedDate` is not: read on two sandboxes of the same
 * production org, both answered the same instant to the second, so the date
 * is production's and a refresh copies it along. The instance can move with a
 * refresh and can move without one, so it is reported and never relied on.
 *
 * Only a production org or a dev hub can list refreshes (SandboxProcess), and
 * few users have one connected. The sandbox can always say which org it is:
 * every connection is checked with an identity call whose answer names the
 * org, and the Monitor reads the Organization row. This remembers, per
 * registered sandbox, which org those answers named last.
 */

/** How a refresh came to be noticed. */
export type RefreshEvidence =
  /** The identity check of a new connection named another org. */
  | 'connection'
  /** The Organization row the Monitor read named another org. */
  | 'monitor'
  /** The refresh history of the production org reported it completed. */
  | 'production';

/** One answer, from the org behind a registered entry, about which org it is. */
export interface OrgSighting {
  /** The identity check's `organization_id`, or `Organization.Id`. */
  organizationId: string;
  /** `Organization.InstanceName`, when the sighting read the org row. */
  instanceName?: string;
}

const refreshSchema = z.object({
  /** The registered org this happened to (its SandForge id). */
  orgId: z.string(),
  detectedAt: z.string(),
  evidence: z.enum(['connection', 'monitor', 'production']),
  /** 15-character org id before the refresh. */
  previousOrganizationId: z.string().optional(),
  /**
   * 15-character org id after it. Absent while only the production org has
   * reported the refresh: the sandbox names its new id when it next answers.
   */
  organizationId: z.string().optional(),
  previousInstanceName: z.string().optional(),
  instanceName: z.string().optional(),
  /** The sandbox name the production history gave. */
  sandboxName: z.string().optional(),
  /** The registered production org whose history reported it. */
  reportedBy: z.string().optional(),
});

/** A sandbox refresh SandForge noticed. */
export type DetectedSandboxRefresh = z.infer<typeof refreshSchema>;

const recordSchema = z.object({
  /** 15-character id of the org the entry reached at the last sighting. */
  organizationId: z.string(),
  instanceName: z.string().optional(),
  /**
   * The ids the entry reached before. Salesforce never gives an org id twice,
   * so seeing one of these again is not a refresh back: it is an answer read
   * before the refresh and served since, from a cache or a fallback.
   */
  formerOrganizationIds: z.array(z.string()),
  /** Newest first. */
  refreshes: z.array(refreshSchema),
});

type SandboxIdentityRecord = z.infer<typeof recordSchema>;

/** ConfigStore key prefix of the per-org records. */
const KEY_PREFIX = 'sandbox-refresh:';

/** ConfigStore category of the per-org records. */
const CATEGORY = 'sandbox-refresh';

/** Refreshes kept per org: enough for the panel, bounded like every history here. */
const MAX_REFRESHES = 10;

/** Former org ids kept per org. */
const MAX_FORMER_IDS = 20;

/** A Salesforce org id, in its 15- or 18-character form. */
const ORG_ID_PATTERN = /^00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

/**
 * The 15-character form of an org id, or `undefined` for anything else.
 *
 * The identity check and `Organization.Id` answer with 18 characters,
 * SandboxProcess with 15: the last three only encode the case of the first
 * fifteen, so the fifteen are what is compared.
 */
function toOrgKey(id: string | undefined): string | undefined {
  return id !== undefined && ORG_ID_PATTERN.test(id) ? id.slice(0, 15) : undefined;
}

/** The host of a URL, lower-cased, or `undefined` when it does not parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The My Domain of a production org: `acme` for `acme.my.salesforce.com`. */
function myDomainOf(production: SalesforceOrg): string | undefined {
  const host = hostOf(production.instanceUrl);
  const suffix = '.my.salesforce.com';
  return host?.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined;
}

/**
 * Whether `sandbox` is the sandbox `sandboxName` of `production`.
 *
 * Read from what Salesforce derives from both names: the sandbox's My Domain
 * (`acme--uat.sandbox.my.salesforce.com`, or an instance in place of
 * `sandbox` before enhanced domains) and the username a sandbox copy of a user
 * receives (`admin@acme.com.uat`). A match on the sandbox name alone would
 * take the `uat` of one production org for the `uat` of another.
 */
function isSandboxOf(
  production: SalesforceOrg,
  sandbox: SalesforceOrg,
  sandboxName: string,
): boolean {
  const name = sandboxName.toLowerCase();
  const domain = myDomainOf(production);
  if (domain && hostOf(sandbox.instanceUrl)?.startsWith(`${domain}--${name}.`)) return true;
  return sandbox.username.toLowerCase() === `${production.username.toLowerCase()}.${name}`;
}

/** Receives each refresh as it is noticed. */
export type RefreshListener = (refresh: DetectedSandboxRefresh) => void;

/** What {@link SandboxRefreshDetector} needs. */
export interface SandboxRefreshDetectorDeps {
  /** Where what each sandbox answered last is kept across restarts. */
  configStore: ConfigStore;
  /** The registered orgs: which are sandboxes, and the org id each was registered with. */
  orgManager: OrgManager;
  log?: (message: string) => void;
  /** Clock, injected by tests. */
  now?: () => Date;
}

/** Remembers which org each registered sandbox reached, and says when that changes. */
export class SandboxRefreshDetector {
  private readonly listeners = new Set<RefreshListener>();
  private readonly now: () => Date;

  constructor(private readonly deps: SandboxRefreshDetectorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Be told of each refresh noticed from now on.
   *
   * @returns A function that stops the listening.
   */
  onRefreshDetected(listener: RefreshListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Record what the org behind a registered sandbox answered, and report a
   * refresh when it is another org than the last one it answered as.
   *
   * With nothing recorded yet, the org id the entry was registered with is
   * the one compared: an entry imported before a refresh and used after it
   * is caught the first time it is checked. Nothing is written when nothing
   * changed — every connection lands here.
   *
   * @param orgId - The registered org (SandForge id).
   * @param sighting - What it answered.
   * @param evidence - Where the answer was read.
   * @returns The refresh, when this answer revealed one.
   */
  observe(
    orgId: string,
    sighting: OrgSighting,
    evidence: Exclude<RefreshEvidence, 'production'>,
  ): DetectedSandboxRefresh | undefined {
    const org = this.deps.orgManager.getOrg(orgId);
    if (org?.orgType !== 'Sandbox') return undefined;
    const seen = toOrgKey(sighting.organizationId);
    if (!seen) return undefined;

    const stored = this.read(orgId);
    const baseline = stored ?? this.baselineOf(org);
    if (!baseline) {
      this.write(orgId, {
        organizationId: seen,
        instanceName: sighting.instanceName,
        formerOrganizationIds: [],
        refreshes: [],
      });
      return undefined;
    }

    if (seen === baseline.organizationId) {
      const movedInstance =
        sighting.instanceName !== undefined && sighting.instanceName !== baseline.instanceName;
      if (!stored || movedInstance) {
        this.write(orgId, {
          ...baseline,
          instanceName: sighting.instanceName ?? baseline.instanceName,
        });
      }
      return undefined;
    }
    if (baseline.formerOrganizationIds.includes(seen)) return undefined;

    // The production org may have reported this refresh already: the sandbox
    // now names the org it became, and the report is completed, not repeated.
    const [latest, ...older] = baseline.refreshes;
    const pending =
      latest?.evidence === 'production' && latest.organizationId === undefined ? latest : undefined;
    const refresh: DetectedSandboxRefresh = {
      ...(pending ?? { orgId, detectedAt: this.now().toISOString(), evidence }),
      previousOrganizationId: baseline.organizationId,
      organizationId: seen,
      previousInstanceName: baseline.instanceName,
      instanceName: sighting.instanceName,
    };
    this.write(orgId, {
      organizationId: seen,
      instanceName: sighting.instanceName,
      formerOrganizationIds: [baseline.organizationId, ...baseline.formerOrganizationIds].slice(
        0,
        MAX_FORMER_IDS,
      ),
      refreshes: (pending ? [refresh, ...older] : [refresh, ...baseline.refreshes]).slice(
        0,
        MAX_REFRESHES,
      ),
    });
    this.deps.log?.(
      `[sandbox-refresh] ${org.alias}: org ${baseline.organizationId} is now ${seen} (${evidence})`,
    );
    if (!pending) this.emit(refresh);
    return refresh;
  }

  /**
   * Record a refresh a production org's history shows completed, on each
   * registered sandbox it names.
   *
   * The sandbox is not asked here: its connection may be the one the refresh
   * killed. What it became is filled in when it next answers (see
   * {@link observe}), without a second notice.
   *
   * @param event - The completed SandboxProcess, as the production org's tracker read it.
   * @returns The refreshes recorded, one per registered sandbox it matched.
   */
  noteCompletedRefresh(event: SandboxRefreshEvent): DetectedSandboxRefresh[] {
    const production = this.deps.orgManager.getOrg(event.orgId);
    if (!production) return [];
    const recorded: DetectedSandboxRefresh[] = [];
    for (const sandbox of this.deps.orgManager.getAllOrgs()) {
      if (sandbox.orgType !== 'Sandbox' || sandbox.id === production.id) continue;
      if (!isSandboxOf(production, sandbox, event.sandboxName)) continue;
      const baseline = this.read(sandbox.id) ?? this.baselineOf(sandbox);
      // Nothing is known of the org it was: there is no before to report.
      if (!baseline) continue;
      // The sandbox itself may have told first: a refresh it answered for
      // after this process was started is this one, or a later one.
      const startedAt = Date.parse(event.refreshDate);
      const alreadyTold = baseline.refreshes.some(
        (known) => known.evidence !== 'production' && Date.parse(known.detectedAt) >= startedAt,
      );
      if (alreadyTold) continue;
      const refresh: DetectedSandboxRefresh = {
        orgId: sandbox.id,
        detectedAt: this.now().toISOString(),
        evidence: 'production',
        sandboxName: event.sandboxName,
        reportedBy: production.id,
      };
      this.write(sandbox.id, {
        ...baseline,
        refreshes: [refresh, ...baseline.refreshes].slice(0, MAX_REFRESHES),
      });
      this.deps.log?.(
        `[sandbox-refresh] ${sandbox.alias}: ${production.alias} reports the refresh of "${event.sandboxName}"`,
      );
      recorded.push(refresh);
      this.emit(refresh);
    }
    return recorded;
  }

  /** The refreshes noticed on a registered org, newest first. */
  refreshesOf(orgId: string): DetectedSandboxRefresh[] {
    return this.read(orgId)?.refreshes ?? [];
  }

  /** The 15-character id of the org a registered sandbox reached last, when known. */
  organizationIdOf(orgId: string): string | undefined {
    return this.read(orgId)?.organizationId;
  }

  /**
   * Whether a refresh noticed on a registered org made it the org
   * `organizationId` names, in its 15- or 18-character form.
   *
   * Only a refresh the sandbox itself answered for says which org it became:
   * one only the production history reported names no org yet.
   *
   * @param orgId - The registered org (SandForge id).
   * @param organizationId - The org id to look for.
   */
  wasRefreshedTo(orgId: string, organizationId: string): boolean {
    const key = toOrgKey(organizationId);
    return (
      key !== undefined && this.refreshesOf(orgId).some((refresh) => refresh.organizationId === key)
    );
  }

  /** The record to compare against when none is stored: the org id the entry was registered with. */
  private baselineOf(org: SalesforceOrg): SandboxIdentityRecord | undefined {
    const registered = toOrgKey(org.orgId);
    return registered === undefined
      ? undefined
      : { organizationId: registered, formerOrganizationIds: [], refreshes: [] };
  }

  private read(orgId: string): SandboxIdentityRecord | undefined {
    const raw = this.deps.configStore.get<unknown>(`${KEY_PREFIX}${orgId}`);
    if (raw === undefined) return undefined;
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.log?.(`[sandbox-refresh] ignoring an unreadable record for ${orgId}`);
      return undefined;
    }
    return parsed.data;
  }

  private write(orgId: string, record: SandboxIdentityRecord): void {
    this.deps.configStore.set(`${KEY_PREFIX}${orgId}`, record, CATEGORY);
  }

  private emit(refresh: DetectedSandboxRefresh): void {
    for (const listener of this.listeners) {
      try {
        listener(refresh);
      } catch (err: unknown) {
        // A listener that throws must not cost the others their notice, nor
        // the connection whose identity check reported the refresh.
        this.deps.log?.(`[sandbox-refresh] a listener failed: ${String(err)}`);
      }
    }
  }
}
