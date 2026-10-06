import { parseHttpsUrl } from '../../core/common/parseHttpsUrl.js';
import type { HttpsUrlParse } from '../../core/common/parseHttpsUrl.js';

/** A Salesforce record id: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An object API name: a letter, then letters, digits and underscores. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The address of a record's page, or why none was built: the record or its
 * object does not have the shape of one, or the HTTPS gate refused the
 * instance URL.
 */
export type RecordPageUrl =
  | { ok: true; url: string }
  | { ok: false; reason: 'not-a-record' }
  | Extract<HttpsUrlParse, { ok: false }>;

/**
 * Build the Lightning Experience page of a record from its org's stored
 * instance URL: `/lightning/r/<object>/<id>/view`, the address Lightning gives
 * a record's page.
 *
 * Every part is checked before it goes into the address: the id and the
 * object by their shapes, so neither can carry a path, a query or another
 * host, and the instance URL by the HTTPS gate every path from org state to
 * the browser shares. Only the origin of the instance URL is kept, as for the
 * Apex Jobs page (`apexJobsSetupUrl`).
 *
 * @param instanceUrl - `SalesforceOrg.instanceUrl`, read from extension state.
 * @param objectApiName - The record's object, as the run that created it recorded it.
 * @param recordId - The record's id in that org.
 */
export function recordPageUrl(
  instanceUrl: string,
  objectApiName: string,
  recordId: string,
): RecordPageUrl {
  if (!RECORD_ID.test(recordId) || !OBJECT_NAME.test(objectApiName)) {
    return { ok: false, reason: 'not-a-record' };
  }
  const parsed = parseHttpsUrl(instanceUrl);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    url: new URL(`/lightning/r/${objectApiName}/${recordId}/view`, parsed.url.origin).toString(),
  };
}
