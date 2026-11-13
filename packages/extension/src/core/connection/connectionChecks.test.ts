import { describe, expect, it } from 'vitest';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import { connectionCheck, connectionCheckRequests } from './connectionChecks';

/** A connection the fake org answers, refusing the identity URL when told. */
function answeredConnection(refuseIdentity = false): Connection {
  const conn = new jsforce.Connection({
    instanceUrl: 'https://example.my.salesforce.com',
    accessToken: 'live-session-token',
    version: '66.0',
  });
  conn.request = (async (request: string | { url: string }) => {
    const url = typeof request === 'string' ? request : request.url;
    if (url.endsWith('/v66.0')) return { identity: 'https://example.my.salesforce.com/id/x' };
    if (url.includes('/id/')) {
      if (refuseIdentity) throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      return { user_id: '005000000000001AAA', organization_id: '00D000000000001AAA' };
    }
    return { totalSize: 1, done: true, records: [{ Id: '00D000000000001AAA' }] };
  }) as unknown as Connection['request'];
  return conn;
}

describe('connectionCheck', () => {
  it('counts every request a check sends through its connection: an identity reads the version root, then the identity URL, and the Organization read beside it', async () => {
    const before = connectionCheckRequests();
    const conn = answeredConnection();

    await connectionCheck(conn, async () => {
      await conn.identity();
      await conn.query('SELECT Id FROM Organization');
    });

    expect(connectionCheckRequests() - before).toBe(3);
  });

  it('counts a check the org refused too, and nothing the connection sends once it was handed over', async () => {
    const before = connectionCheckRequests();
    const refused = answeredConnection(true);
    const handed = answeredConnection();

    await expect(connectionCheck(refused, () => refused.identity())).rejects.toThrow(
      'INVALID_SESSION_ID',
    );
    await connectionCheck(handed, () => handed.identity());
    await handed.query('SELECT Id FROM Account');

    expect(connectionCheckRequests() - before).toBe(4);
  });
});
