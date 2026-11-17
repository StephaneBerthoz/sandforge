/**
 * The places of a sandbox that still name its production: the Named
 * Credentials, the Remote Sites, and the fields of Custom Metadata Types or
 * Custom Settings the file names. A copy of production holds production's
 * endpoints, and what runs there calls them until someone points them away.
 * Read and nothing written: Setup, `sf` or a deployment puts them right.
 *
 * **Production's hosts.** From a sandbox's host,
 * `acme--uat.sandbox.my.salesforce.com`, production's My Domain is `acme`:
 * `acme.my.salesforce.com` is deduced as `SandboxRefreshDetector` deduces a
 * sandbox of a production, and so are `acme.lightning.force.com` and
 * `acme.my.site.com`, the other hosts enhanced domains give it; a wrong one
 * of these only misses a place, which the answer's host list shows. To them
 * the audit adds `login.salesforce.com`, where production orgs sign in, and
 * the file's `productionHosts`. A host of another form — a scratch org's, a
 * Developer Edition's, a sandbox's before enhanced domains — deduces
 * nothing, and the answer says so: only `login.salesforce.com` and the
 * file's hosts are compared then. A host names itself alone: `erp.acme.com`
 * is not `api.erp.acme.com`.
 *
 * **Never a query nor a credential.** An endpoint may carry a key in its
 * query (`?key=…`), a token in its fragment, a user and a password in its
 * authority (`user:pass@`). A URL is named by its scheme, its host and its
 * path alone ({@link auditUrlOf}), and a value that does not read as a URL is
 * never named at all: whatever an audit says, answers or writes holds no more
 * of it. A Custom Metadata field read on a scratch org held such a key in
 * clear.
 *
 * Tooling `NamedCredential` (`DeveloperName`, `Endpoint`) and Tooling
 * `RemoteProxy` (`SiteName`, `EndpointUrl`, `IsActive`) were read on a scratch
 * org; `ApexDevNet` is a Remote Site every org holds. A Remote Site that is
 * not active lets no callout through and is not named. A Named Credential of
 * the newer kind, which leaves its authentication to an External Credential,
 * has not been read yet: one that answers no endpoint names none.
 *
 * It costs two requests, then one for each object the file's fields are of.
 */

import type { EnvAuditEndpoint, EnvAuditResult } from '@sandforge/shared';
import { booleanOf, fieldOf, textOf, unreadReasonOf, type AuditOrg } from './auditOrg.js';

/** Where production orgs sign in. */
export const LOGIN_HOST = 'login.salesforce.com';

/** A sandbox's host under enhanced domains: production's My Domain, two dashes, the sandbox's name. */
const SANDBOX_HOST =
  /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)--([a-z0-9]+)\.sandbox\.my\.salesforce\.com$/;

/** The scheme, the host and the path of a URL as the answer's schema takes them. */
const AUDIT_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/;

/** A host name, as a place is matched against production's by. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Why a host is production's. */
export type ProductionWhy = EnvAuditEndpoint['why'];

/** Why a host is production's, in words. */
export const ENDPOINT_WHY_WORDS: Readonly<Record<ProductionWhy, string>> = {
  listed: 'a production host the file lists',
  myDomain: "production's My Domain",
  lightning: "production's Lightning host",
  site: "production's sites host",
  login: 'where production orgs sign in',
};

/** What each place is, in words. */
export const ENDPOINT_SOURCE_WORDS: Readonly<Record<EnvAuditEndpoint['source'], string>> = {
  namedCredential: 'Named Credential',
  remoteSite: 'Remote Site',
  field: 'Field',
};

/** A host of production, and why it is one. */
export interface ProductionHost {
  host: string;
  why: ProductionWhy;
}

/** Production's hosts, and why none was deduced when none was. */
export interface ProductionHosts {
  hosts: ProductionHost[];
  notDeduced?: string;
}

/**
 * The hosts of production the org's endpoints are compared against: those
 * deduced from a sandbox's host, `login.salesforce.com`, and the file's.
 * Narrower than the My Domain `envTargetHost.ts` names a sandbox by, which
 * reads a host before enhanced domains too: production's hosts are deduced
 * from the one form whose production hosts enhanced domains fix.
 *
 * @param host - The host the org answered on.
 * @param listed - The file's `productionHosts`.
 */
export function productionHostsOf(
  host: string | undefined,
  listed: readonly string[] = [],
): ProductionHosts {
  const hosts: ProductionHost[] = [];
  const add = (one: string, why: ProductionWhy): void => {
    const key = one.toLowerCase().replace(/\.$/, '');
    if (!hosts.some((known) => known.host === key)) hosts.push({ host: key, why });
  };
  const match = host !== undefined ? SANDBOX_HOST.exec(host.toLowerCase()) : null;
  let notDeduced: string | undefined;
  if (match?.[1] !== undefined) {
    const domain = match[1];
    add(`${domain}.my.salesforce.com`, 'myDomain');
    add(`${domain}.lightning.force.com`, 'lightning');
    add(`${domain}.my.site.com`, 'site');
  } else {
    notDeduced =
      host === undefined
        ? "the org's host is not known: production's own hosts are not deduced"
        : `${host} is no sandbox's host of the form <domain>--<sandbox>.sandbox.my.salesforce.com: ` +
          "production's own hosts are not deduced";
  }
  add(LOGIN_HOST, 'login');
  for (const one of listed) add(one, 'listed');
  return { hosts, ...(notDeduced !== undefined ? { notDeduced } : {}) };
}

/**
 * A URL as an audit names it — its scheme, its host, its port when it has
 * one, and its path —, and its host; undefined for a value that does not read
 * as a URL with a host, which is then never named. The query, the fragment,
 * the user and the password are left out, whatever they hold.
 */
export function auditUrlOf(raw: string): { url: string; host: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!HOST_NAME.test(host)) return undefined;
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const authority = parsed.port !== '' ? `${host}:${parsed.port}` : host;
  const path = parsed.pathname.startsWith('/') ? parsed.pathname : '/';
  const url = `${scheme}://${authority}${path}`;
  if (AUDIT_URL.test(url)) return { url, host };
  // A path the answer cannot hold is left out: the host is what is named.
  const bare = `${scheme}://${authority}/`;
  return AUDIT_URL.test(bare) ? { url: bare, host } : undefined;
}

/** A place read, before it is matched against production's hosts. */
interface PlaceRead {
  source: EnvAuditEndpoint['source'];
  name: string;
  raw: string;
}

/** The fields the file names, by the object they are of, each object once whatever its case. */
export function fieldsByObject(
  fields: readonly string[],
): Array<{ object: string; fields: string[] }> {
  const out: Array<{ object: string; fields: string[] }> = [];
  for (const field of fields) {
    const at = field.indexOf('.');
    if (at <= 0) continue;
    const object = field.slice(0, at);
    const name = field.slice(at + 1);
    const known = out.find((one) => one.object.toLowerCase() === object.toLowerCase());
    if (known === undefined) out.push({ object, fields: [name] });
    else if (!known.fields.some((one) => one.toLowerCase() === name.toLowerCase())) {
      known.fields.push(name);
    }
  }
  return out;
}

/** A name an object's API name and its fields may hold, checked before it goes into a query. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The requests the endpoints audit sends: two, and one an object of the file's fields. */
export function endpointsRequestsOf(fields: readonly string[] = []): number {
  return 2 + fieldsByObject(fields).length;
}

/**
 * The places of the org that still name production. Never throws: a part
 * the org refuses is said in `unread`, the others read.
 *
 * @param input.host - The host the org answered on.
 * @param input.productionHosts - The file's `productionHosts`.
 * @param input.fields - The file's `fields`, `Object.Field`.
 */
export async function readEndpoints(
  org: AuditOrg,
  input: { host?: string; productionHosts?: readonly string[]; fields?: readonly string[] },
): Promise<NonNullable<EnvAuditResult['endpoints']>> {
  const production = productionHostsOf(input.host, input.productionHosts ?? []);
  const places: PlaceRead[] = [];
  const unread: string[] = [];
  const truncatedWords = (what: string): string =>
    `${what}: more than the pages read were there, and those past them were not read`;

  try {
    const named = await org.query('SELECT DeveloperName, Endpoint FROM NamedCredential', {
      tooling: true,
    });
    for (const row of named.records) {
      const name = textOf(row, 'DeveloperName');
      const raw = textOf(row, 'Endpoint');
      if (name !== undefined && raw !== undefined)
        places.push({ source: 'namedCredential', name, raw });
    }
    if (named.truncated) unread.push(truncatedWords('Named Credentials'));
  } catch (err: unknown) {
    unread.push(`Named Credentials: ${unreadReasonOf(err, org.timeout)}`);
  }

  try {
    const sites = await org.query('SELECT SiteName, EndpointUrl, IsActive FROM RemoteProxy', {
      tooling: true,
    });
    for (const row of sites.records) {
      const name = textOf(row, 'SiteName');
      const raw = textOf(row, 'EndpointUrl');
      if (booleanOf(row, 'IsActive') === false) continue;
      if (name !== undefined && raw !== undefined) places.push({ source: 'remoteSite', name, raw });
    }
    if (sites.truncated) unread.push(truncatedWords('Remote Sites'));
  } catch (err: unknown) {
    unread.push(`Remote Sites: ${unreadReasonOf(err, org.timeout)}`);
  }

  for (const { object, fields } of fieldsByObject(input.fields ?? [])) {
    if (!API_NAME.test(object) || !fields.every((field) => API_NAME.test(field))) continue;
    // A Custom Metadata record is named by its DeveloperName, a Custom
    // Setting's by its Name, or its Id when it has none.
    const metadata = object.toLowerCase().endsWith('__mdt');
    const key = metadata ? 'DeveloperName' : 'Name';
    const select = metadata ? ['DeveloperName', ...fields] : ['Id', 'Name', ...fields];
    try {
      const rows = await org.query(`SELECT ${select.join(', ')} FROM ${object}`, { maxPages: 1 });
      for (const row of rows.records) {
        const record = textOf(row, key) ?? textOf(row, 'Id') ?? '?';
        for (const field of fields) {
          const raw = fieldOf(row, field);
          if (typeof raw !== 'string' || raw.trim() === '') continue;
          places.push({ source: 'field', name: `${object}.${record}.${field}`, raw });
        }
      }
      if (rows.truncated) {
        unread.push(
          `${object}: more records than one page were there, and those past it were not read — ` +
            'a Custom Setting holds a few: is it one?',
        );
      }
    } catch (err: unknown) {
      unread.push(`${object}: ${unreadReasonOf(err, org.timeout)}`);
    }
  }

  const found: EnvAuditEndpoint[] = [];
  for (const place of places) {
    const named = auditUrlOf(place.raw);
    if (named === undefined) continue;
    const match = production.hosts.find((one) => one.host === named.host);
    if (match === undefined) continue;
    found.push({
      source: place.source,
      name: place.name.slice(0, 400),
      url: named.url,
      host: named.host,
      why: match.why,
    });
  }
  return {
    productionHosts: production.hosts.map((one) => one.host),
    found,
    ...(production.notDeduced !== undefined ? { notDeduced: production.notDeduced } : {}),
    ...(unread.length > 0 ? { unread: unread.join('; ').slice(0, 2_000) } : {}),
  };
}
