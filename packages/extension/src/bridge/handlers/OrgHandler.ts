import type { BaseMessage, SalesforceOrg, OrgConnectRequest } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendNotification } from './HandlerTypes.js';
import {
  validatePayload,
  orgConnectPayloadSchema,
  orgDisconnectPayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Message types handled by OrgHandler. */
const ORG_TYPES = new Set(['org:list', 'org:connect', 'org:disconnect']);

/**
 * Domain handler for org-related webview-to-extension messages.
 *
 * Routes org:* message types to org listing, connection (sfdx import,
 * username/password, OAuth web), and disconnection operations.
 */
export class OrgHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!ORG_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'org:list':
        this.handleOrgList(msg);
        return true;
      case 'org:connect':
        await this.handleOrgConnect(msg);
        return true;
      case 'org:disconnect':
        await this.handleOrgDisconnect(msg);
        return true;
      default:
        return false;
    }
  }

  private handleOrgList(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const orgs = this.deps.orgManager.getAllOrgs();
    const response = buildResponse(this.deps, msg, 'org:list:response', {
      orgs: orgs as unknown as Record<string, unknown>[],
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private async handleOrgConnect(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgConnectPayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;
    const payload: OrgConnectRequest['payload'] = parsed;

    switch (payload.authMethod) {
      case 'sfdx_import':
        await this.handleSfdxImport(msg);
        break;
      case 'usernamePassword':
        await this.handleUsernamePassword(msg, payload);
        break;
      case 'oauth_web':
        await this.handleOAuthWeb(payload);
        break;
      default:
        sendNotification(
          this.deps,
          'warning',
          'Auth Method',
          `${payload.authMethod} is not yet supported.`,
        );
        break;
    }

    this.syncOrgState();
  }

  private async handleSfdxImport(msg: BaseMessage): Promise<void> {
    try {
      const available = await this.deps.sfdxBridge.isCliAvailable();
      if (!available) {
        sendNotification(
          this.deps,
          'error',
          'SF CLI',
          'Salesforce CLI (sf) not found on PATH. Install it from https://developer.salesforce.com/tools/salesforcecli',
        );
        return;
      }

      const results = await this.deps.sfdxBridge.listOrgs();
      if (results.length === 0) {
        sendNotification(
          this.deps,
          'warning',
          'Import',
          'No connected orgs found in SF CLI. Run "sf org login web" first.',
        );
        return;
      }

      for (const { org, credentials } of results) {
        await this.deps.orgRegistry.saveOrg(org, credentials);
      }

      const orgs = this.deps.orgManager.getAllOrgs();
      const response = buildResponse(this.deps, msg, 'org:list:response', {
        orgs: orgs as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);

      sendNotification(
        this.deps,
        'success',
        'Import',
        `Imported ${results.length} org(s) from SF CLI.`,
      );
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:sfdx-import: ${message}`);
      sendNotification(this.deps, 'error', 'Import Failed', message);
    }
  }

  private async handleUsernamePassword(
    msg: BaseMessage,
    payload: OrgConnectRequest['payload'],
  ): Promise<void> {
    if (!payload.username || !payload.password) {
      sendNotification(this.deps, 'error', 'Auth', 'Username and password are required.');
      return;
    }

    const loginUrl = payload.loginUrl ?? 'https://login.salesforce.com';
    try {
      const parsed = new URL(loginUrl);
      if (parsed.protocol !== 'https:') {
        sendNotification(this.deps, 'error', 'Auth', 'Login URL must use HTTPS.');
        return;
      }
    } catch {
      sendNotification(this.deps, 'error', 'Auth', `Invalid login URL: "${loginUrl}".`);
      return;
    }

    const authResult = await this.deps.authProvider.authenticate({
      method: 'usernamePassword',
      loginUrl,
      username: payload.username,
      password: payload.password,
      securityToken: payload.securityToken,
    });

    if (!authResult.success || !authResult.accessToken || !authResult.instanceUrl) {
      sendNotification(
        this.deps,
        'error',
        'Auth Failed',
        authResult.error ?? 'Authentication failed',
      );
      return;
    }

    try {
      const identity = await this.deps.authProvider.validateConnection(
        authResult.accessToken,
        authResult.instanceUrl,
      );

      const org: SalesforceOrg = {
        id: identity.orgId,
        alias: payload.alias ?? payload.username ?? identity.username,
        username: identity.username,
        instanceUrl: authResult.instanceUrl,
        orgId: identity.orgId,
        orgType: identity.isSandbox ? 'Sandbox' : 'Production',
        authMethod: 'usernamePassword',
        safetyTier: identity.isSandbox ? OrgSafetyTier.LOW : OrgSafetyTier.CRITICAL,
        appearance: {
          color: identity.isSandbox ? '#4a9eff' : '#e74c3c',
          icon: 'cloud',
          position: 0,
        },
        metadata: {
          apiVersion: '62.0',
          edition: identity.orgType,
          features: [],
        },
        status: 'connected',
        lastConnected: new Date().toISOString(),
        tags: [],
      };

      const connectionConfig = this.deps.authProvider.buildConnectionConfig(
        {
          method: 'usernamePassword',
          loginUrl: payload.loginUrl ?? 'https://login.salesforce.com',
          username: payload.username,
          password: payload.password,
          securityToken: payload.securityToken,
        },
        authResult,
      );

      await this.deps.orgRegistry.saveOrg(org, connectionConfig);

      const statusMsg = buildResponse(this.deps, msg, 'org:statusChanged', {
        orgId: org.id,
        status: 'connected',
      });
      this.deps.broker.postToWebview(statusMsg);
      this.deps.log(`[TX] ${statusMsg.type} id=${statusMsg.id}`);

      sendNotification(
        this.deps,
        'success',
        'Connected',
        `${org.alias} connected (${identity.orgName}).`,
      );
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:username-password: ${message}`);
      sendNotification(
        this.deps,
        'error',
        'Validation Failed',
        `Auth succeeded but org validation failed: ${message}`,
      );
    }
  }

  private async handleOAuthWeb(payload: OrgConnectRequest['payload']): Promise<void> {
    try {
      const available = await this.deps.sfdxBridge.isCliAvailable();
      if (!available) {
        sendNotification(
          this.deps,
          'error',
          'SF CLI',
          'Salesforce CLI (sf) not found on PATH. Required for OAuth web login.',
        );
        return;
      }

      const loginUrl = payload.loginUrl ?? 'https://login.salesforce.com';
      const alias = payload.alias ?? '';
      await this.deps.sfdxBridge.loginWeb(alias, loginUrl);

      const results = await this.deps.sfdxBridge.listOrgs();
      if (results.length === 0) {
        sendNotification(
          this.deps,
          'warning',
          'OAuth',
          'Login completed but no org found. Try again.',
        );
        return;
      }

      for (const { org, credentials } of results) {
        await this.deps.orgRegistry.saveOrg(org, credentials);
      }

      sendNotification(
        this.deps,
        'success',
        'OAuth',
        `Authenticated via browser. ${results.length} org(s) available.`,
      );
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:oauth-web: ${message}`);
      sendNotification(this.deps, 'error', 'OAuth Failed', message);
    }
  }

  private async handleOrgDisconnect(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgDisconnectPayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    await this.deps.orgRegistry.removeOrg(payload.orgId);

    const statusMsg = buildResponse(this.deps, msg, 'org:statusChanged', {
      orgId: payload.orgId,
      status: 'disconnected',
    });
    this.deps.broker.postToWebview(statusMsg);
    this.deps.log(`[TX] ${statusMsg.type} id=${statusMsg.id}`);

    this.syncOrgState();
  }

  private syncOrgState(): void {
    const orgs = this.deps.orgManager.getAllOrgs();
    this.deps.stateSync.updateState({
      orgs: orgs as unknown as Record<string, unknown>[],
    });
  }
}
