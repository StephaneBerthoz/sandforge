/**
 * The host an org answers on, and what it says of the org: the My Domain an
 * environment lists a sandbox by, and the proof that a state kept under
 * another Organization Id is of the same sandbox, refreshed since.
 *
 * A refresh gives a sandbox a new Organization Id and keeps its My Domain
 * (`SandboxRefreshDetector`). A sandbox's My Domain is production's, two
 * dashes and the sandbox's name, and its host starts with it:
 * `acme--uat.sandbox.my.salesforce.com` with enhanced domains, an instance in
 * place of `sandbox` before them — the rule `SandboxRefreshDetector.isSandboxOf`
 * tells a production org's sandbox by. That function reads the name from
 * production's own host, and takes a username match too: a file names the
 * sandbox's My Domain alone, so the host rule is read here from that name.
 *
 * The host does not make a sandbox. A scratch org says `IsSandbox` true too,
 * and only the `sf` CLI tells it apart, by its Dev Hub; its host is
 * `<name>.scratch.my.salesforce.com`. A My Domain lists none: a scratch org
 * the CLI did not name a Dev Hub for is told by that label. A pod's host,
 * `cs42.salesforce.com`, is many orgs' and names none.
 */

import type { EnvTargetKind } from '@sandforge/shared';
import { sameSandboxRefreshed } from '../../src/modules/checkpoint/replay/replaySourceGuard.js';

/** What every My Domain host ends with, sandboxes' and scratch orgs' included. */
const MY_DOMAIN_SUFFIX = '.my.salesforce.com';

/** A sandbox's My Domain: production's, two dashes, the sandbox's name, as `acme--uat`. */
const SANDBOX_MY_DOMAIN = /^[a-z0-9-]+--[a-z0-9]+$/;

/** The label a scratch org's host carries between its name and `my.salesforce.com`. */
const SCRATCH_LABEL = 'scratch';

/**
 * The host of an org's instance URL when it is a My Domain's, lower-cased:
 * one org's alone. Undefined for a pod's host, which many orgs share, and for
 * what is no URL.
 */
export function myDomainHostOf(instanceUrl: string | undefined): string | undefined {
  if (instanceUrl === undefined || instanceUrl === '') return undefined;
  let host: string;
  try {
    host = new URL(instanceUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return host.endsWith(MY_DOMAIN_SUFFIX) && host.length > MY_DOMAIN_SUFFIX.length
    ? host
    : undefined;
}

/** The labels of a My Domain host before `my.salesforce.com`; none for another host. */
function labelsOf(host: string | undefined): string[] | undefined {
  if (host === undefined || !host.endsWith(MY_DOMAIN_SUFFIX)) return undefined;
  const labels = host.slice(0, -MY_DOMAIN_SUFFIX.length).split('.');
  return labels.every((label) => label !== '') ? labels : undefined;
}

/** Whether a host is a scratch org's: `<name>.scratch.my.salesforce.com`. */
export function isScratchHost(host: string | undefined): boolean {
  return labelsOf(host)?.slice(1).includes(SCRATCH_LABEL) === true;
}

/**
 * The My Domain of the sandbox a host is of, `acme--uat`: its first label,
 * then `sandbox`, an instance, or nothing before `my.salesforce.com`.
 * Undefined for a scratch org's host, a production org's, any other shape,
 * and no host.
 */
export function sandboxMyDomainOf(host: string | undefined): string | undefined {
  const labels = labelsOf(host);
  if (labels === undefined || labels.length > 2 || isScratchHost(host)) return undefined;
  const [name] = labels;
  return name !== undefined && SANDBOX_MY_DOMAIN.test(name) ? name : undefined;
}

/**
 * Whether an org on `host` is the one `targets.protect` names by its My
 * Domain. Read wider than a listing: any My Domain host that starts with it,
 * a scratch org's shape included, since a protected org is refused on the
 * least sign of it, never let through on a shape.
 */
export function hostIsMyDomain(host: string | undefined, myDomain: string): boolean {
  return labelsOf(host)?.[0] === myDomain;
}

/** An org as a state keeps it, or as the guards typed it: its Id, its kind, its host. */
export interface EnvHostedOrg {
  organizationId: string;
  kind: EnvTargetKind;
  /** Absent from a state written before 1.82, and for an org on no My Domain host. */
  host?: string;
  /** The user the state was applied as; absent for the org the line names. */
  username?: string;
}

/**
 * Whether the state kept of `kept` is of `target` before a refresh: both
 * sandboxes, as read live when each was applied to; the same sandbox host,
 * a scratch org's never; another Organization Id, which Salesforce gives no
 * two orgs. The host alone, as the replay tells the sandbox a checkpoint was
 * taken of (`sameSandboxRefreshed`), never its username: that rule would
 * take a state of another host — enhanced domains turned on between the
 * two — for proof. A state written before 1.82 kept no host, and proves
 * nothing.
 */
export function refreshedSince(kept: EnvHostedOrg, target: EnvHostedOrg): boolean {
  if (kept.kind !== 'sandbox' || target.kind !== 'sandbox') return false;
  if (kept.host === undefined || sandboxMyDomainOf(target.host) === undefined) return false;
  // Compared on the 15 characters both forms of an Id share.
  if (kept.organizationId.slice(0, 15) === target.organizationId.slice(0, 15)) return false;
  return (
    sameSandboxRefreshed(
      {
        tier: 'sandbox',
        organizationId: kept.organizationId,
        username: kept.username ?? '',
        instanceUrl: `https://${kept.host}`,
      },
      {
        name: target.organizationId,
        organizationId: target.organizationId,
        instanceUrl: `https://${target.host ?? ''}`,
      },
    ) === 'myDomain'
  );
}
