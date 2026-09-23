import { describe, it, expect, vi } from 'vitest';
import {
  insertFile,
  readFileBody,
  remainingFileStorageMB,
  type FileTransport,
} from './fileTransfer.js';

const VERSION = '068000000000001AAA';

/** A connection answering one request as `answer` says. */
function transport(answer: (request: unknown, options?: object) => Promise<unknown>) {
  const request = vi.fn(answer);
  return { request, conn: { request } satisfies FileTransport };
}

/** How jsforce fails a request whose answer it was told to read as base64. */
function refusedAsBase64(body: unknown): Error {
  const error = new Error(Buffer.from(JSON.stringify(body)).toString('base64'));
  error.name = 'ERROR_HTTP_404';
  return error;
}

describe('readFileBody', () => {
  it('asks for the content as bytes and hands it back in base64, whole', async () => {
    const content = Buffer.from([0, 255, 128, 10]).toString('base64');
    const { request, conn } = transport(async () => content);

    await expect(readFileBody(conn, 'ContentVersion', VERSION)).resolves.toBe(content);
    expect(request).toHaveBeenCalledWith(
      { method: 'GET', url: `/sobjects/ContentVersion/${VERSION}/VersionData` },
      { encoding: 'base64', responseType: 'application/octet-stream' },
    );
  });

  it("reads an attachment's content from its body", async () => {
    const { request, conn } = transport(async () => 'AAAA');

    await readFileBody(conn, 'Attachment', '00P000000000001AAA');

    expect(request.mock.calls[0][0]).toEqual({
      method: 'GET',
      url: '/sobjects/Attachment/00P000000000001AAA/Body',
    });
  });

  it('says what the org said when it refuses the read, not its answer in base64', async () => {
    const { conn } = transport(async () => {
      throw refusedAsBase64([
        { errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' },
      ]);
    });

    await expect(readFileBody(conn, 'ContentVersion', VERSION)).rejects.toThrow(
      'NOT_FOUND: The requested resource does not exist',
    );
  });

  it('refuses an id that is not one before asking the org anything', async () => {
    const { request, conn } = transport(async () => '');

    await expect(readFileBody(conn, 'ContentVersion', '../limits')).rejects.toThrow(
      'Not a record id',
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe('insertFile', () => {
  it('writes the one record alone in its request, as JSON', async () => {
    const { request, conn } = transport(async () => ({ id: VERSION, success: true, errors: [] }));
    const record = { Title: 'Report', PathOnClient: 'report.pdf', VersionData: 'AAAA' };

    await expect(insertFile(conn, 'ContentVersion', record)).resolves.toEqual({
      id: VERSION,
      success: true,
      errors: [],
    });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/sobjects/ContentVersion',
      body: JSON.stringify(record),
      headers: { 'content-type': 'application/json' },
    });
  });

  it('turns a refusal into a failed result with its code', async () => {
    const { conn } = transport(async () => {
      throw Object.assign(new Error('storage limit exceeded'), {
        errorCode: 'STORAGE_LIMIT_EXCEEDED',
      });
    });

    await expect(insertFile(conn, 'Attachment', { Name: 'a.txt' })).resolves.toEqual({
      id: '',
      success: false,
      errors: ['STORAGE_LIMIT_EXCEEDED: storage limit exceeded'],
    });
  });
});

describe('remainingFileStorageMB', () => {
  it('reads what the file storage has left from the limits', async () => {
    const { request, conn } = transport(async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      FileStorageMB: { Max: 200, Remaining: 173 },
    }));

    await expect(remainingFileStorageMB(conn)).resolves.toBe(173);
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/limits' });
  });

  it('fails rather than guess when the limits do not say', async () => {
    const { conn } = transport(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } }));

    await expect(remainingFileStorageMB(conn)).rejects.toThrow();
  });
});
