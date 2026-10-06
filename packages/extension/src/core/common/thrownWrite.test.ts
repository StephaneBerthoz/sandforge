import { describe, expect, it } from 'vitest';
import { whatTheWriteLeft } from './thrownWrite.js';

/** An error as jsforce's `HttpApiError` carries one: the code on `errorCode` and on `name`. */
function httpApiError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

/** A page from the edge in place of an API answer, as jsforce reads it. */
function edgePage(status: number): Error {
  return httpApiError(
    `ERROR_HTTP_${status}`,
    `HTTP response contains html content.\nCheck that the org exists and can be reached.\n\nHTTP status code: ${status}.`,
  );
}

/** A socket error as node-fetch hands it on, with the system error's code. */
function fetchError(code: string): Error {
  return Object.assign(
    new Error(
      `request to https://example.my.salesforce.com/services/data/v62.0/composite/sobjects failed, reason: ${code}`,
    ),
    { name: 'FetchError', type: 'system', code, errno: code },
  );
}

describe('whatTheWriteLeft', () => {
  it('reads a connection the org refused, or a host with no address, as a call that never reached it', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']) {
      expect(whatTheWriteLeft(fetchError(code)), code).toBe('not-received');
    }
  });

  it('reads the edge saying the org is unavailable, or asked too soon, as a call that never reached it', () => {
    expect(whatTheWriteLeft(edgePage(503))).toBe('not-received');
    expect(whatTheWriteLeft(edgePage(429))).toBe('not-received');
  });

  it('reads a reset, a timeout or a broken pipe once the request was out as a call that may have written', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ERR_STREAM_PREMATURE_CLOSE',
    ]) {
      expect(whatTheWriteLeft(fetchError(code)), code).toBe('may-have-written');
    }
    expect(
      whatTheWriteLeft(
        Object.assign(
          new Error(
            'The user aborted a request. Request was aborted due to timeout of 10 minutes.',
          ),
          { name: 'AbortError', type: 'aborted' },
        ),
      ),
    ).toBe('may-have-written');
  });

  it('reads a 502 from the edge as a call that may have written: the org may have dropped it after the commit', () => {
    expect(whatTheWriteLeft(edgePage(502))).toBe('may-have-written');
    expect(whatTheWriteLeft(edgePage(504))).toBe('may-have-written');
    expect(whatTheWriteLeft(edgePage(500))).toBe('may-have-written');
  });

  it('reads an error the org answered with, or the edge refusing the request, as nothing written', () => {
    expect(whatTheWriteLeft(httpApiError('INVALID_SESSION_ID', 'Session expired or invalid'))).toBe(
      'not-written',
    );
    expect(whatTheWriteLeft(httpApiError('UNKNOWN_EXCEPTION', 'An unexpected error'))).toBe(
      'not-written',
    );
    expect(whatTheWriteLeft(edgePage(413))).toBe('not-written');
  });

  it("tells the org's API request limit apart from any other refusal", () => {
    expect(
      whatTheWriteLeft(httpApiError('REQUEST_LIMIT_EXCEEDED', 'TotalRequests Limit exceeded.')),
    ).toBe('request-limit');
    expect(
      whatTheWriteLeft(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')),
    ).toBe('request-limit');
  });

  it('reads the system error undici hands over on cause', () => {
    const fetchFailed = (cause: unknown): Error =>
      Object.assign(new TypeError('fetch failed'), { cause });

    expect(whatTheWriteLeft(fetchFailed({ code: 'ECONNREFUSED' }))).toBe('not-received');
    expect(whatTheWriteLeft(fetchFailed({ code: 'UND_ERR_SOCKET' }))).toBe('may-have-written');
    // Failed with nothing to say where: it may have been out.
    expect(whatTheWriteLeft(new TypeError('fetch failed'))).toBe('may-have-written');
  });

  it('reads a message alone by the code or the words it carries', () => {
    expect(whatTheWriteLeft(new Error('connect ECONNREFUSED 10.0.0.1:443'))).toBe('not-received');
    expect(whatTheWriteLeft(new Error('ECONNRESET'))).toBe('may-have-written');
    expect(whatTheWriteLeft(new Error('socket hang up'))).toBe('may-have-written');
    expect(whatTheWriteLeft('network timeout at: https://example.invalid')).toBe(
      'may-have-written',
    );
  });

  it('reads an error thrown before any request went out as nothing written', () => {
    expect(whatTheWriteLeft(new Error('No authorization information found for the org'))).toBe(
      'not-written',
    );
    expect(whatTheWriteLeft(new Error('External ID is not found in record.'))).toBe('not-written');
    expect(whatTheWriteLeft(undefined)).toBe('not-written');
  });
});
