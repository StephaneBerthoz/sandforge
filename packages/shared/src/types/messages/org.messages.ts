import type { SalesforceOrg } from '../org.types.js';
import type { BaseMessage } from './base.messages.js';

/** Org management messages */
export interface OrgListRequest extends BaseMessage {
  type: 'org:list';
}

/**
 * Response containing the list of registered Salesforce orgs.
 *
 * `selectedOrgId` carries the extension-side selection so a surface that lost
 * its own state — the sidebar view, which VS Code recreates on hide/show —
 * restores the org every other surface is on. It is absent when the sender has
 * no selection to offer, and `null` when nothing is selected.
 */
export interface OrgListResponse extends BaseMessage {
  type: 'org:list:response';
  payload: { orgs: SalesforceOrg[]; selectedOrgId?: string | null };
}

/** Request to connect (authenticate) a Salesforce org */
export interface OrgConnectRequest extends BaseMessage {
  type: 'org:connect';
  payload: {
    orgId: string;
    authMethod: string;
    alias?: string;
    loginUrl?: string;
    username?: string;
    password?: string;
    securityToken?: string;
    /** JWT and device flow: the consumer key of the app the user signs in through. */
    clientId?: string;
    /**
     * JWT: the path of the private key file. The host hands the path to
     * `sf org login jwt` and never opens the file.
     */
    jwtKeyFile?: string;
  };
}

/**
 * What a device-flow sign-in shows while it waits for approval: the code to
 * type, the Salesforce page to type it on, and when the code stops working.
 */
export interface OrgDeviceCode {
  /** The code the user enters on the verification page. */
  userCode: string;
  /** Salesforce's verification page, on a Salesforce login host. */
  verificationUri: string;
  /** When Salesforce stops accepting the code, in epoch milliseconds. */
  expiresAt: number;
}

/**
 * Posted, correlated to its `org:connect` request, once Salesforce has issued a
 * device code. The request itself ends later, on `org:statusChanged` or
 * `org:error`, when the sign-in is approved, refused, expired or cancelled.
 */
export interface OrgDeviceCodeMessage extends BaseMessage {
  type: 'org:device-code';
  payload: OrgDeviceCode;
}

/**
 * Stop the sign-in an `org:connect` request started and is still waiting on.
 * That request then ends on `org:error` with code `CANCELLED`.
 */
export interface OrgConnectCancelRequest extends BaseMessage {
  type: 'org:connect:cancel';
  payload: { requestId: string };
}

/** Request to disconnect a Salesforce org */
export interface OrgDisconnectRequest extends BaseMessage {
  type: 'org:disconnect';
  payload: { orgId: string };
}

/** Request to select the active org (posted by panel org pickers). */
export interface OrgSelectRequest extends BaseMessage {
  type: 'org:select';
  payload: { orgId: string };
}

/**
 * Request to save what the edit dialog changes on a registered org: its alias,
 * its colour, its tags, and for a sandbox whether it is marked Staging. The
 * host writes them to the org registry and answers with a correlated
 * `org:list:response` carrying the saved list. The safety tier is not part of
 * it: the production guard reads the org type, and the Staging mark of a
 * sandbox, never a tier typed here.
 */
export interface OrgUpdateRequest extends BaseMessage {
  type: 'org:update';
  payload: { orgId: string; alias: string; color: string; tags: string[]; staging?: boolean };
}

/**
 * Open the org in the system browser, from its card on the Organizations
 * page. The page names the org and nothing else: the extension opens the
 * org's stored instance URL, bare, behind the HTTPS gate the
 * `sandforge.openOrgInBrowser` command uses, and its payload schema refuses
 * any other key. No session token goes into the address, so none lands in the
 * browser's history: the browser's own Salesforce session signs the user in,
 * or the login page asks.
 */
export interface OrgOpenInBrowserRequest extends BaseMessage {
  type: 'org:open-in-browser';
  payload: { orgId: string };
}

/**
 * What the browser did. A refused request (an unknown org, an instance URL
 * that is not HTTPS) is answered on `org:error` instead, correlated to the
 * request, with code `ORG_NOT_FOUND` or `INVALID_INSTANCE_URL`.
 */
export interface OrgOpenInBrowserResponse extends BaseMessage {
  type: 'org:open-in-browser:response';
  payload: { status: 'opened' } | { status: 'error'; message: string };
}

/**
 * Asked by the Organizations page as it opens: whether the Salesforce CLI is
 * installed, and how many orgs it holds. Two of the ways to connect run on the
 * CLI, and its absence was found only after a click on one of them.
 */
export interface OrgCliStatusRequest extends BaseMessage {
  type: 'org:cli-status';
}

/** Whether `sf` answers, and how many orgs an import from it would bring in. */
export interface OrgCliStatusResponse extends BaseMessage {
  type: 'org:cli-status:response';
  payload: { available: boolean; orgCount: number };
}

/**
 * Asked by a page that offers to mute the target's automation and reads none
 * of it before the run (Sync's Run, Quick Sync, Autopilot's review, a Frozen
 * load, a Seed run's removal, a checkpoint's Undo and replay, an emptying's
 * resume): whether the user SandForge writes to the org as may assign
 * permission sets, which muting does for the run. Such a page offered the box
 * to a user who could not, and the run it started was refused, nothing
 * written. Read by the statement the run's lease asks it with.
 */
export interface OrgAssignRightRequest extends BaseMessage {
  type: 'org:assign-right';
  payload: { orgId: string };
}

/**
 * `cannotAssign` when the org said its user has neither Assign Permission
 * Sets nor Manage Users. An org that would not say, or could not be reached,
 * is answered without it: the box is offered, and the run's lease asks again
 * as it starts and says why it refuses.
 */
export interface OrgAssignRightResponse extends BaseMessage {
  type: 'org:assign-right:response';
  payload: { orgId: string; cannotAssign?: true };
}

/** Notification that an org's connection status has changed */
export interface OrgStatusChanged extends BaseMessage {
  type: 'org:statusChanged';
  payload: { orgId: string; status: string };
}

/** Notification that the user selected an org in the sidebar (posted by extension.ts) */
export interface OrgSelected extends BaseMessage {
  type: 'org:selected';
  payload: { orgId: string };
}

/** Error response for org connect/disconnect failures (emitted via sendHandlerError). */
export interface OrgErrorResponse extends BaseMessage {
  type: 'org:error';
  payload: { message: string; code: string; retryable: boolean };
}
