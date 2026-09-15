import { parseHttpsUrl } from './parseHttpsUrl.js';

/** Hosts that serve the Salesforce login page under their own name. */
const LOGIN_HOSTS: ReadonlySet<string> = new Set(['login.salesforce.com', 'test.salesforce.com']);

/**
 * Domains under which every host is a Salesforce org: My Domain (sandboxes and
 * scratch orgs included, as `*.sandbox.my.salesforce.com` and
 * `*.scratch.my.salesforce.com`), and the legacy `force.com` and
 * `cloudforce.com` instance names.
 */
const LOGIN_DOMAIN_SUFFIXES: readonly string[] = [
  '.my.salesforce.com',
  '.force.com',
  '.cloudforce.com',
];

/**
 * One DNS label: lowercase letters, digits and dashes. The URL parser lets `&`
 * and `"` through in a hostname, so a suffix match alone would accept
 * `a&calc.my.salesforce.com` — every label is checked instead.
 */
const LABEL_RE = /^[a-z0-9-]+$/;

/** What {@link parseSalesforceLoginUrl} made of a login URL. */
export type SalesforceLoginUrlParse =
  | { ok: true; origin: string }
  | { ok: false; reason: 'invalid' | 'not-https' | 'not-origin' | 'not-salesforce' };

/**
 * Whether a hostname belongs to Salesforce and can serve its login flow.
 *
 * Pure: no VS Code API, no I/O.
 *
 * @param hostname - A hostname as `URL.hostname` returns it (lowercase).
 */
export function isSalesforceLoginHost(hostname: string): boolean {
  if (!hostname.split('.').every((label) => LABEL_RE.test(label))) return false;
  if (LOGIN_HOSTS.has(hostname)) return true;
  // The label check above refuses empty labels, so a match here always has at
  // least one label in front of the suffix.
  return LOGIN_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Parse a login URL and reduce it to the origin that is actually used.
 *
 * The URL arrives in an `org:connect` message. Credentials were sent to any
 * `https:` host it named, and on Windows everything after the host went into
 * the `sf org login web` shell string unescaped. Only an `https:` URL on a
 * Salesforce login host, with nothing after the host — no path, query,
 * fragment, credentials or port — is accepted, and callers use the returned
 * origin rather than the raw string.
 *
 * Pure: no VS Code API, no I/O.
 *
 * @param raw - The login URL as received.
 * @returns The origin, or why the URL was refused.
 */
export function parseSalesforceLoginUrl(raw: string): SalesforceLoginUrlParse {
  const parsed = parseHttpsUrl(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const { url } = parsed;
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return { ok: false, reason: 'not-origin' };
  }
  if (!isSalesforceLoginHost(url.hostname)) return { ok: false, reason: 'not-salesforce' };
  return { ok: true, origin: `https://${url.hostname}` };
}
