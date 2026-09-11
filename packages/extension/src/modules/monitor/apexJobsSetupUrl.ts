import { parseHttpsUrl } from '../../core/common/parseHttpsUrl.js';
import type { HttpsUrlParse } from '../../core/common/parseHttpsUrl.js';

/**
 * Path of the Lightning Setup page "Apex Jobs", joined to the org's host.
 *
 * NOT VERIFIED: this is the conventional Lightning Setup node for Apex Jobs,
 * but it was checked neither against official Salesforce documentation nor
 * against a real org. If an org lands anywhere else, this is the one place to
 * fix, and `apexJobsSetupUrl.test.ts` pins the full address it produces.
 *
 * Why a link and not an abort: `AsyncApexJob` is not updateable (describe),
 * and the documented abort is Apex run in the user's org (Salesforce help
 * 000385103). The page aborts a job; SandForge does not.
 *
 * Scheduled jobs are the exception (Salesforce help): they are not aborted
 * from this page but from Setup > All Scheduled Jobs. The Monitor band never
 * names one — `ScheduledApex` is outside the job types its stall detection
 * models (MonitorOpsHandler) — so nothing sends a scheduled job here.
 */
export const APEX_JOBS_SETUP_PATH = '/lightning/setup/AsyncApexJobs/home';

/** The Apex Jobs address, or the HTTPS gate's refusal of the instance URL. */
export type ApexJobsSetupUrl = { ok: true; url: string } | Extract<HttpsUrlParse, { ok: false }>;

/**
 * Build the Setup > Apex Jobs address of an org from its stored instance URL.
 *
 * Only the origin of the instance URL is kept, so credentials, a path, a query
 * or a fragment in stored state never reach the address that is opened.
 *
 * @param instanceUrl - `SalesforceOrg.instanceUrl`, read from extension state.
 */
export function apexJobsSetupUrl(instanceUrl: string): ApexJobsSetupUrl {
  const parsed = parseHttpsUrl(instanceUrl);
  if (!parsed.ok) return parsed;
  return { ok: true, url: new URL(APEX_JOBS_SETUP_PATH, parsed.url.origin).toString() };
}
