import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import { countRequests, isProductionTarget, typeTarget } from './orgKindLive.js';

const ORG_ID = '00D000000000001AAA';
const RECORD_ID = '001000000000001AAA';
const ORG_CLOCK = '2026-10-22T20:17:20.966Z';

/** An org whose Organization record says `row`, and whose edition reads `edition`. */
function org(row: Record<string, unknown> | undefined, edition?: string | Error) {
  const asked: string[] = [];
  const conn = {
    query: vi.fn(async (soql: string) => {
      asked.push(soql);
      if (soql.startsWith('SELECT OrganizationType')) {
        if (edition instanceof Error) throw edition;
        return { records: [{ OrganizationType: edition }], totalSize: 1 };
      }
      return { records: row ? [row] : [], totalSize: row ? 1 : 0 };
    }),
  } as unknown as Pick<Connection, 'query'>;
  return { conn, asked };
}

describe('what an org says it is, read live', () => {
  it('types a sandbox by its IsSandbox alone, and an org that is not one by its edition', async () => {
    await expect(typeTarget(org({ Id: ORG_ID, IsSandbox: true }).conn)).resolves.toEqual({
      id: ORG_ID,
      sandbox: true,
    });
    await expect(
      typeTarget(org({ Id: ORG_ID, IsSandbox: false }, 'Developer Edition').conn),
    ).resolves.toEqual({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' });
    await expect(
      typeTarget(org({ Id: ORG_ID, IsSandbox: false }, new Error('INVALID_FIELD')).conn),
    ).resolves.toEqual({ id: ORG_ID, sandbox: false });
    await expect(typeTarget(org(undefined).conn)).rejects.toThrow('gave no Organization record');
  });

  it("takes a paid edition, and an org that names none, for a production org, as the panel's guard does", () => {
    expect(isProductionTarget({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' })).toBe(
      true,
    );
    expect(isProductionTarget({ id: ORG_ID, sandbox: false })).toBe(true);
    expect(isProductionTarget({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' })).toBe(
      false,
    );
    expect(isProductionTarget({ id: ORG_ID, sandbox: true })).toBe(false);
  });
});

describe('countRequests', () => {
  /** A connection whose every request the fake org answers, and what it was asked. */
  function answeredConnection(): { conn: Connection; asked: string[] } {
    const conn = new jsforce.Connection({
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'live-session-token',
      version: '66.0',
    });
    const asked: string[] = [];
    conn.request = (async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      asked.push(url);
      if (url.includes('/query')) return { totalSize: 0, done: true, records: [] };
      if (url.endsWith('/describe')) return { name: 'Account', fields: [], childRelationships: [] };
      return [{ id: RECORD_ID, success: true, errors: [] }];
    }) as unknown as Connection['request'];
    return { conn, asked };
  }

  it('counts each request a query, a describe and a write send, whichever method sent them', async () => {
    const { conn, asked } = answeredConnection();
    const sent = countRequests(conn);

    await conn.query('SELECT Id FROM Account');
    await conn.sobject('Account').describe();
    await conn.sobject('Account').create([{ Name: 'Acme' }]);

    expect(sent()).toBe(3);
    expect(asked).toHaveLength(3);
  });

  it('counts no request for a describe the connection already holds', async () => {
    const { conn } = answeredConnection();
    const sent = countRequests(conn);

    await conn.sobject('Account').describe();
    await conn.describe$('Account');

    expect(sent()).toBe(1);
  });

  it('counts nothing sent before it was asked to', async () => {
    const { conn } = answeredConnection();
    await conn.query('SELECT Id FROM Account');

    const sent = countRequests(conn);

    expect(sent()).toBe(0);
  });

  it('counts a stand-in connection with no transport of its own by its requests alone', async () => {
    const { conn } = answeredConnection();
    const standIn = { request: conn.request.bind(conn) } as unknown as Connection;

    const sent = countRequests(standIn);
    await standIn.request('/services/data/v66.0/limits');

    expect(sent()).toBe(1);
  });
});

describe('countRequests, under the whole of jsforce down to the wire', () => {
  /** The SOAP envelope the partner API answers `method` with, its result inside. */
  function soapAnswer(method: string, result: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      `<soapenv:Body><${method}Response><result>${result}</result></${method}Response>` +
      '</soapenv:Body></soapenv:Envelope>'
    );
  }

  /**
   * A connection whose transport — where every HTTP request jsforce sends ends
   * up, REST, SOAP or Bulk — the fake org answers, and the URL of each request
   * that reached it.
   */
  function wiredConnection(): { conn: Connection; wire: string[] } {
    const conn = new jsforce.Connection({
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'live-session-token',
      version: '66.0',
    });
    const wire: string[] = [];
    conn._transport.httpRequest = ((request: { url: string; body?: unknown }) => {
      wire.push(request.url);
      const body = typeof request.body === 'string' ? request.body : '';
      const response = request.url.includes('/services/Soap/')
        ? {
            statusCode: 200,
            headers: { 'content-type': 'text/xml;charset=UTF-8' },
            body: body.includes('<getServerTimestamp')
              ? soapAnswer('getServerTimestamp', `<timestamp>${ORG_CLOCK}</timestamp>`)
              : soapAnswer('undelete', `<id>${RECORD_ID}</id><success>true</success>`),
          }
        : {
            statusCode: 200,
            headers: { 'content-type': 'application/json;charset=UTF-8' },
            body: JSON.stringify({ totalSize: 0, done: true, records: [] }),
          };
      return Object.assign(Promise.resolve(response), { stream: () => new PassThrough() });
    }) as unknown as Connection['_transport']['httpRequest'];
    return { conn, wire };
  }

  it("counts the org's clock and an undelete, which jsforce sends over SOAP past the connection's request, once each", async () => {
    const { conn, wire } = wiredConnection();
    const sent = countRequests(conn);

    await conn.query('SELECT Id FROM Account');
    const clock = await conn.soap.getServerTimestamp();
    const undeleted = await conn.soap.undelete([RECORD_ID]);

    expect(clock.timestamp).toBe(ORG_CLOCK);
    expect(undeleted).toEqual([{ id: RECORD_ID, success: true, errors: [] }]);
    expect(wire).toHaveLength(3);
    expect(wire.filter((url) => url.includes('/services/Soap/u/66.0'))).toHaveLength(2);
    // One per request the org received: the query once, though it too
    // reached the transport, and each SOAP call once.
    expect(sent()).toBe(3);
  });
});
