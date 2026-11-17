/**
 * The proxy a connection to an org goes through, as curl reads the
 * environment: one rule for the command lines (`cli/sfSession.ts`) and the
 * panel (`proxiedConnection.ts`). It imports nothing of jsforce, which the
 * extension loads off its activation path.
 *
 * `sf` does not read NO_PROXY: behind a local proxy, with the org's domain in
 * NO_PROXY (`salesforce.com` or `.salesforce.com`), sf 2.154.4 still sent its
 * own calls to the org through the proxy, where SandForge's went straight. A
 * proxy that refuses Salesforce fails sf's own read of the session (`sf org
 * display`) before SandForge sends a call, whatever NO_PROXY says.
 */

/** A variable of the environment as curl reads it: the lowercase name first, then the uppercase one. */
function variableOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name.toLowerCase()] ?? env[name.toUpperCase()] ?? '').trim();
  return value === '' ? undefined : value;
}

/**
 * Whether NO_PROXY sends `target` past the proxy: `*`, or an entry that is
 * its host or a domain above it (`salesforce.com`, `.salesforce.com` and
 * `*.salesforce.com` alike take `acme.my.salesforce.com`), on any port or the
 * one the entry names.
 */
function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false;
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return noProxy
    .split(/[\s,]+/)
    .filter((entry) => entry !== '')
    .some((entry) => {
      if (entry === '*') return true;
      const [, name = '', entryPort] = /^(.*?)(?::(\d+))?$/.exec(entry.toLowerCase()) ?? [];
      if (entryPort !== undefined && entryPort !== port) return false;
      const domain = name.replace(/^\*?\.?/, '');
      return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
    });
}

/**
 * The proxy a connection to `url` goes through, or nothing for a direct one:
 * HTTPS_PROXY for an https address, HTTP_PROXY otherwise and when HTTPS_PROXY
 * is not set, as jsforce reads them; none for a host NO_PROXY names.
 *
 * jsforce 3.10.14 reads HTTPS_PROXY and HTTP_PROXY itself as it loads
 * (`lib/transport.js`, its request defaults) and never NO_PROXY: with
 * Salesforce in NO_PROXY, every call of a connection built with no proxy of
 * its own still went to the proxy.
 */
export function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const proxy =
    target.protocol === 'https:'
      ? (variableOf(env, 'https_proxy') ?? variableOf(env, 'http_proxy'))
      : variableOf(env, 'http_proxy');
  if (proxy === undefined) return undefined;
  return bypassesProxy(target, variableOf(env, 'no_proxy')) ? undefined : proxy;
}
