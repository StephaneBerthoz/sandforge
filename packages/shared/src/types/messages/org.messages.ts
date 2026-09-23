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
 * its colour and its tags. The host writes them to the org registry and answers
 * with a correlated `org:list:response` carrying the saved list. The safety
 * tier is not part of it: the production guard reads the org type, never a
 * tier typed here.
 */
export interface OrgUpdateRequest extends BaseMessage {
  type: 'org:update';
  payload: { orgId: string; alias: string; color: string; tags: string[] };
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
