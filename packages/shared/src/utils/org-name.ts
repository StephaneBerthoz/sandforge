/**
 * How an org is named wherever a person reads it or types it: a page, a
 * refusal, a confirmation, the audit trail.
 *
 * The registry keeps an alias for every org, and an org that had none — one
 * the Salesforce CLI holds without an alias, one connected by its username
 * and password without one typed — was given its username for it. Every
 * page then named the org by `alias || username`, which was the username:
 * the person's login, which a screenshot, a ticket or a channel a refusal is
 * pasted into carries with it, the Cleanup tab's confirmation had it typed.
 *
 * An org is named by its alias when it has one of its own; else by its own
 * name (`Organization.Name`), when SandForge read it; else by its
 * Organization Id. Never by a username: an alias that is the username, or is
 * shaped as one, is no alias.
 */

/** What names an org: as the registry holds it, or as a checkpoint or an entry kept it. */
export interface NamedOrg {
  alias?: string | undefined;
  /** The user SandForge connects as: never what names the org. */
  username?: string | undefined;
  /** `Organization.Name`, when it was read. */
  organizationName?: string | undefined;
  /** The Organization Id, `00D…`, as the registry keeps it. */
  orgId?: string | undefined;
  /** The Organization Id, as a checkpoint keeps it: read when `orgId` is absent. */
  organizationId?: string | undefined;
}

/** A Salesforce username is shaped as an email address. */
const USERNAME_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether `alias` is an alias of its own: neither the username, nor shaped as one. */
export function isOwnAlias(alias: string | undefined, username: string | undefined): boolean {
  const trimmed = alias?.trim();
  if (!trimmed) return false;
  if (USERNAME_SHAPED.test(trimmed)) return false;
  return username === undefined || trimmed.toLowerCase() !== username.trim().toLowerCase();
}

/**
 * The org's name, as a person reads and types it: its alias of its own, else
 * its own name, else its Organization Id; `fallback` when none of them is
 * known — no org, or one known by no more than a username.
 */
export function orgDisplayName(org: NamedOrg | null | undefined, fallback = ''): string {
  if (!org) return fallback;
  if (isOwnAlias(org.alias, org.username)) return (org.alias as string).trim();
  // A name read from elsewhere than the org — the CLI's listing — is held to
  // the same rule as an alias.
  const name = org.organizationName?.trim();
  if (name && isOwnAlias(name, org.username)) return name;
  const orgId = (org.orgId ?? org.organizationId)?.trim();
  if (orgId) return orgId;
  return fallback;
}
