/**
 * The calls a Forge run makes to move a file, over an org's REST API.
 *
 * The extension and the command-line clone both copy files, through the same
 * three requests: the content of a file read as it is stored, one record
 * written with a file's content, and the file storage an org has left. Kept
 * here once, over the one method of a connection they need, so neither
 * learns alone how a file comes back from the API.
 */
import { z } from 'zod';
import type { InsertResult } from './ForgeExecutor.js';
import { FILE_BODY_FIELDS, type FileBodyObject } from './stages/FileCopier.js';
import { formatSaveError, toSaveOutcome } from '../../core/common/existingRecordMatch.js';
import { isRecordId } from '../dataops/RecordRemoval.js';

/** The part of a jsforce connection moving a file needs. */
export interface FileTransport {
  request(
    request: {
      method: 'GET' | 'POST';
      url: string;
      body?: string;
      headers?: Record<string, string>;
    },
    options?: object,
  ): Promise<unknown>;
}

/** What `/limits` says of an org's file storage. */
const fileStorageSchema = z
  .object({ FileStorageMB: z.object({ Remaining: z.number() }).passthrough() })
  .passthrough();

/** The error body Salesforce answers a failed request with. */
const errorBodySchema = z.array(
  z.object({ errorCode: z.string().optional(), message: z.string().optional() }).passthrough(),
);

/**
 * The error of a read whose answer was taken as base64.
 *
 * The content of a file is asked for base64-encoded, and so is the answer
 * when the org refuses it: jsforce hands back a message that is the error
 * body in base64. Decoded, it says what the org said.
 */
function readableError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  try {
    const decoded = errorBodySchema.safeParse(
      JSON.parse(Buffer.from(err.message, 'base64').toString('utf8')),
    );
    const first = decoded.success ? decoded.data[0] : undefined;
    if (first?.message) {
      return new Error(first.errorCode ? `${first.errorCode}: ${first.message}` : first.message);
    }
  } catch {
    // Not an encoded error body: the message reads as it is.
  }
  return err;
}

/**
 * The content of one file, base64-encoded, as the org stores it: a document's
 * version, or an attachment.
 *
 * Asked for as bytes and handed back in base64 whole. Read as text, the way
 * the API's answers are read by default, a file comes back with every byte
 * that is not text replaced.
 */
export async function readFileBody(
  transport: FileTransport,
  objectApiName: FileBodyObject,
  id: string,
): Promise<string> {
  if (!isRecordId(id)) throw new Error(`Not a record id: ${id}`);
  try {
    const body = await transport.request(
      { method: 'GET', url: `/sobjects/${objectApiName}/${id}/${FILE_BODY_FIELDS[objectApiName]}` },
      { encoding: 'base64', responseType: 'application/octet-stream' },
    );
    if (typeof body !== 'string') throw new Error('The org answered with no file content.');
    return body;
  } catch (err) {
    throw readableError(err);
  }
}

/**
 * Write one record carrying a file's content, alone in its request: the most
 * Salesforce takes of a JSON body is what one file may be.
 */
export async function insertFile(
  transport: FileTransport,
  objectApiName: FileBodyObject,
  record: Record<string, unknown>,
): Promise<InsertResult> {
  try {
    const answer = await transport.request({
      method: 'POST',
      url: `/sobjects/${objectApiName}`,
      body: JSON.stringify(record),
      headers: { 'content-type': 'application/json' },
    });
    const outcome = toSaveOutcome(answer, objectApiName);
    return { id: outcome.id, success: outcome.success, errors: outcome.errors };
  } catch (err) {
    // A refused record comes back as an error answer, not as a save result.
    return { id: '', success: false, errors: [formatSaveError(err)] };
  }
}

/** The file storage the org has left, in MB, as its `/limits` say. */
export async function remainingFileStorageMB(transport: FileTransport): Promise<number> {
  const limits = fileStorageSchema.parse(
    await transport.request({ method: 'GET', url: '/limits' }),
  );
  return limits.FileStorageMB.Remaining;
}
