import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { setDefaults as setRequestDefaults } from 'jsforce/lib/request';
import { connectionAnnouncing, sessionConnection } from './ConnectionHelper.js';
import { proxiedConnection } from './proxiedConnection.js';

/*
 * The panel's connections, held to the proxy rule the command lines keep: a
 * local server stands in for the org, and a local proxy that tunnels each
 * CONNECT to it counts what went through it.
 */

/** A server that answers every REST call with an empty list, counting them. */
async function salesforce(): Promise<{ url: string; calls: () => number; close: () => void }> {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ totalSize: 0, done: true, records: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls: () => calls, close: () => server.close() };
}

/** A proxy that tunnels each CONNECT to where it asks, counting the tunnels it opened. */
async function proxy(): Promise<{ url: string; tunnels: () => number; close: () => void }> {
  let tunnels = 0;
  const server = createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    tunnels += 1;
    const [host = '', port = ''] = (request.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    tunnels: () => tunnels,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('proxiedConnection', () => {
  it('sends the calls of the panel through the proxy, and around it for a host NO_PROXY names', async () => {
    const org = await salesforce();
    const relay = await proxy();
    try {
      const session = { instanceUrl: org.url, accessToken: 'token', version: '66.0' };

      await (
        await proxiedConnection(session, { HTTP_PROXY: relay.url })
      ).query('SELECT Id FROM Account');
      expect(relay.tunnels()).toBe(1);

      await (
        await proxiedConnection(session, { HTTP_PROXY: relay.url, NO_PROXY: '127.0.0.1' })
      ).query('SELECT Id FROM Account');
      await (await proxiedConnection(session, {})).query('SELECT Id FROM Account');
      expect(relay.tunnels()).toBe(1);
      expect(org.calls()).toBe(3);
    } finally {
      relay.close();
      org.close();
    }
  });

  it('goes around the proxy jsforce took from the environment as it loaded, for a host NO_PROXY names', async () => {
    // What jsforce 3.10.14 does as it loads (lib/transport.js): the proxy of
    // the environment becomes the default of every request, NO_PROXY unread.
    // The extension host loads it so, with the environment VS Code started in.
    const loaded = {
      httpProxy:
        process.env.https_proxy ??
        process.env.http_proxy ??
        process.env.HTTPS_PROXY ??
        process.env.HTTP_PROXY ??
        undefined,
      timeout: process.env.HTTP_TIMEOUT ? parseInt(process.env.HTTP_TIMEOUT, 10) : undefined,
      followRedirect: true,
    };
    const org = await salesforce();
    const relay = await proxy();
    setRequestDefaults({ ...loaded, httpProxy: relay.url });
    try {
      const connection = await proxiedConnection(
        { instanceUrl: org.url, accessToken: 'token', version: '66.0' },
        { HTTP_PROXY: relay.url, NO_PROXY: '127.0.0.1' },
      );
      await connection.query('SELECT Id FROM Account');

      expect(relay.tunnels()).toBe(0);
      expect(org.calls()).toBe(1);
    } finally {
      setRequestDefaults(loaded);
      relay.close();
      org.close();
    }
  });

  it('builds the panel’s own connections so: a session’s, an import’s, one that announces its client', async () => {
    const loaded = {
      httpProxy:
        process.env.https_proxy ??
        process.env.http_proxy ??
        process.env.HTTPS_PROXY ??
        process.env.HTTP_PROXY ??
        undefined,
      timeout: process.env.HTTP_TIMEOUT ? parseInt(process.env.HTTP_TIMEOUT, 10) : undefined,
      followRedirect: true,
    };
    const before = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
    const org = await salesforce();
    const relay = await proxy();
    setRequestDefaults({ ...loaded, httpProxy: relay.url });
    process.env.HTTP_PROXY = relay.url;
    process.env.NO_PROXY = '127.0.0.1';
    try {
      const session = { instanceUrl: org.url, accessToken: 'token', version: '66.0' };
      await (await sessionConnection(session)).query('SELECT Id FROM Account');
      await (await connectionAnnouncing(session, 'SandForge')).query('SELECT Id FROM Account');

      expect(relay.tunnels()).toBe(0);
      expect(org.calls()).toBe(2);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      setRequestDefaults(loaded);
      relay.close();
      org.close();
    }
  });
});
