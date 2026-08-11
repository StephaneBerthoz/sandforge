import type { SalesforceOrg } from '../org.types.js';
import type { BaseMessage } from './base.messages.js';

/** Org management messages */
export interface OrgListRequest extends BaseMessage {
  type: 'org:list';
}

/** Response containing the list of registered Salesforce orgs */
export interface OrgListResponse extends BaseMessage {
  type: 'org:list:response';
  payload: { orgs: SalesforceOrg[] };
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
  };
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
