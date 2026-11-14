/**
 * A jsforce connection of the panel, through the proxy the environment names
 * for its org, or straight to it: the rule the command lines keep since
 * NO_PROXY was read there ({@link proxyFor}).
 *
 * jsforce takes HTTPS_PROXY or HTTP_PROXY as the default of every request as
 * it loads, and never reads NO_PROXY: a connection built with no proxy of its
 * own went to that proxy, an org NO_PROXY names among them, while `sf`, which
 * reads NO_PROXY, signed in to it straight. A direct connection is given a
 * proxy transport with no proxy, which jsforce's request reads as none.
 *
 * Built through the lazy boundary the extension keeps jsforce behind
 * (`jsforceEntry.ts`), imported from this directory by that name.
 */

import type { Connection, ConnectionConfig } from 'jsforce';
import { proxyFor } from './proxyFor.js';

/** The address a connection reaches first: its instance, else where it signs in. */
const LOGIN_URL = 'https://login.salesforce.com';

/**
 * A connection for `config`, its proxy the one the environment names for the
 * org it reaches, none for a host NO_PROXY names.
 *
 * @param env - The environment read; this process's unless a test gives one.
 */
export async function proxiedConnection(
  config: ConnectionConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Connection> {
  const { jsforce, HttpProxyTransport } = await import('./jsforceEntry.js');
  const proxy = proxyFor(config.instanceUrl ?? config.loginUrl ?? LOGIN_URL, env);
  const conn = new jsforce.Connection({
    ...config,
    ...(proxy !== undefined ? { httpProxy: proxy } : {}),
  });
  if (proxy === undefined) conn._transport = new HttpProxyTransport('');
  return conn;
}
