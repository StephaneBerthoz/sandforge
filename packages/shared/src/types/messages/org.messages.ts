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

/** Notification that an org's connection status has changed */
export interface OrgStatusChanged extends BaseMessage {
  type: 'org:statusChanged';
  payload: { orgId: string; status: string };
}
