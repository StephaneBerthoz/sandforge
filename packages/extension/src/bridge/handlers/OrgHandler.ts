import type { SalesforceOrg, OrgConnectRequest, UUID } from '@sandforge/shared';
import {
  OrgSafetyTier,
  SF_CLI_INSTALL_URL,
  SF_CLI_MISSING_MESSAGE,
  SF_LIMITS,
} from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendNotification, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  orgConnectPayloadSchema,
  orgDisconnectPayloadSchema,
  orgSelectPayloadSchema,
  orgUpdatePayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getConnectionPool } from '../../core/connection/ConnectionHelper.js';
import { parseSalesforceLoginUrl } from '../../core/common/salesforceLoginHost.js';
import type { SfdxImportResult } from '../../core/connection/SfdxBridge.js';

/** Message types handled by OrgHandler. */
const ORG_TYPES = new Set([
  'org:list',
  'org:connect',
  'org:disconnect',
  'org:select',
  'org:update',
]);

/**
 * Domain handler for org-related webview-to-extension messages.
 *
 * Routes org:* message types to org listing, connection (sfdx import,
 * username/password, OAuth web), metadata edits and disconnection operations.
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
  async handle(msg: InboundRequest): Promise<boolean> {
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
      case 'org:select':
        this.handleOrgSelect(msg);
        return true;
      case 'org:update':
        this.handleOrgUpdate(msg);
        return true;
      default:
        return false;
    }
  }

  private handleOrgList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const orgs = this.deps.orgManager.getAllOrgs();
    const response = buildResponse(this.deps, msg, 'org:list:response', {
      orgs: orgs as unknown as Record<string, unknown>[],
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private async handleOrgConnect(msg: InboundRequest): Promise<void> {
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
        await this.handleOAuthWeb(msg, payload);
        break;
      default:
        sendNotification(
          this.deps,
          'warning',
          'Auth Method',
          `${payload.authMethod} is not yet supported.`,
        );
        this.failConnect(msg, `${payload.authMethod} is not yet supported.`, 'UNSUPPORTED_AUTH');
        break;
    }

    this.syncOrgState();
  }

  /**
   * Terminate an `org:connect` round trip on the failure channel.
   *
   * Every branch of the connect flow has to answer the request the webview
   * correlated on. Without it the OrgManager mutation only ends on its own
   * 30 s timeout, and until then every auth button stays disabled — a toast
   * is not an answer, because `useMessageResponse` correlates on the request
   * id and ignores anything else.
   */
  private failConnect(request: InboundRequest, message: string, code: string): void {
    sendHandlerError(this.deps, 'org:connect', 'org:error', request, new Error(message), {
      code,
      retryable: false,
    });
  }

  /**
   * Tell the user the CLI is missing, and where to get it.
   *
   * A missing `sf` is the first-run blocker: two of the three working auth
   * methods go through it. The toast used to dismiss itself after five
   * seconds with an install URL nobody could click, so it stays up until it
   * is dismissed and carries the link as an action.
   *
   * @param why - What the CLI was needed for, appended to the message.
   */
  private notifyCliMissing(why: string): void {
    sendNotification(this.deps, 'error', 'Salesforce CLI', `${SF_CLI_MISSING_MESSAGE} ${why}`, {
      autoDismissMs: null,
      actions: [{ label: 'Install the CLI', command: 'sf-cli-install', url: SF_CLI_INSTALL_URL }],
    });
  }

  /** Terminate an `org:connect` round trip on the success channel. */
  private ackConnect(request: InboundRequest, orgId: string): void {
    const statusMsg = buildResponse(this.deps, request, 'org:statusChanged', {
      orgId,
      status: 'connected',
    });
    this.deps.broker.postToWebview(statusMsg);
    this.deps.log(`[TX] ${statusMsg.type} id=${statusMsg.id}`);
  }

  private async handleSfdxImport(msg: InboundRequest): Promise<void> {
    try {
      const available = await this.deps.sfdxBridge.isCliAvailable();
      if (!available) {
        this.notifyCliMissing('Importing orgs from the CLI needs it.');
        this.failConnect(msg, SF_CLI_MISSING_MESSAGE, 'SF_CLI_NOT_FOUND');
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
        this.failConnect(msg, 'No connected orgs found in SF CLI.', 'NO_ORGS_FOUND');
        return;
      }

      const savedIds = await this.saveImported(results);

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
      // The org:list:response above is not correlated to this request — the
      // mutation listens on org:statusChanged, so this is what ends it.
      this.ackConnect(msg, savedIds[0]);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:sfdx-import: ${message}`);
      sendNotification(this.deps, 'error', 'Import Failed', message);
      this.failConnect(msg, message, 'SFDX_IMPORT_FAILED');
    }
  }

  /**
   * Save the orgs the CLI listed, each under the entry it belongs to.
   *
   * An imported org's SandForge id is its org id, and a refresh gives a
   * sandbox a new one: imported again, a refreshed sandbox came in as a second
   * entry beside the one the user had set up, which still reached the same org
   * through the same username. When the refresh detector says an entry with
   * that username was refreshed into the org being imported, that entry is
   * updated instead, and its alias, colour, tags and everything kept under its
   * id stay. A username alone is not taken as proof: without the refresh on
   * record, the import is saved as it comes.
   *
   * @returns The id each listed org was saved under, in the CLI's order.
   */
  private async saveImported(results: SfdxImportResult[]): Promise<string[]> {
    const savedIds: string[] = [];
    for (const { org, credentials } of results) {
      const entry = this.refreshedEntryFor(org);
      if (entry) {
        this.deps.log(
          `[INFO] org:import: ${entry.alias} was refreshed into org ${org.orgId}; its entry is updated`,
        );
      }
      const target = entry ? { ...org, id: entry.id } : org;
      await this.deps.orgRegistry.saveOrg(target, credentials);
      savedIds.push(target.id);
    }
    return savedIds;
  }

  /** The registered entry an imported org is, after a refresh gave it a new org id. */
  private refreshedEntryFor(imported: SalesforceOrg): SalesforceOrg | undefined {
    const detector = this.deps.sandboxRefreshes;
    // An org already registered under its own id is updated there, as before.
    if (!detector || this.deps.orgManager.getOrg(imported.id)) return undefined;
    const username = imported.username.toLowerCase();
    return this.deps.orgManager
      .getAllOrgs()
      .find(
        (entry) =>
          entry.username.toLowerCase() === username &&
          detector.wasRefreshedTo(entry.id, imported.orgId),
      );
  }

  private async handleUsernamePassword(
    msg: InboundRequest,
    payload: OrgConnectRequest['payload'],
  ): Promise<void> {
    if (!payload.username || !payload.password) {
      sendNotification(this.deps, 'error', 'Auth', 'Username and password are required.');
      this.failConnect(msg, 'Username and password are required.', 'MISSING_CREDENTIALS');
      return;
    }

    // The username, password and token go to whatever host this names, so it
    // is checked against the Salesforce login hosts and reduced to its origin.
    const loginUrl = this.resolveLoginUrl(msg, payload);
    if (!loginUrl) return;

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
      this.failConnect(msg, authResult.error ?? 'Authentication failed', 'AUTH_FAILED');
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
          apiVersion: SF_LIMITS.DEFAULT_API_VERSION,
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
          loginUrl,
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
      this.failConnect(
        msg,
        `Auth succeeded but org validation failed: ${message}`,
        'ORG_VALIDATION_FAILED',
      );
    }
  }

  /**
   * The login URL of a connect request, checked and reduced to its origin.
   *
   * Answers the request on `org:error` with `INVALID_LOGIN_URL` and returns
   * `undefined` when the URL is not an `https:` Salesforce login host with
   * nothing after it.
   */
  private resolveLoginUrl(
    msg: InboundRequest,
    payload: OrgConnectRequest['payload'],
  ): string | undefined {
    const loginUrl = payload.loginUrl ?? 'https://login.salesforce.com';
    const parsed = parseSalesforceLoginUrl(loginUrl);
    if (parsed.ok) return parsed.origin;
    const reason =
      parsed.reason === 'not-https'
        ? 'Login URL must use HTTPS.'
        : parsed.reason === 'not-salesforce'
          ? `Login URL must be a Salesforce login host (login.salesforce.com, test.salesforce.com or a My Domain): "${loginUrl}". For an org on another Salesforce cloud, log in with "sf org login web --instance-url <url>", then add it with SFDX Import.`
          : parsed.reason === 'not-origin'
            ? `Login URL must name a host only, with no path, query or credentials: "${loginUrl}".`
            : `Invalid login URL: "${loginUrl}".`;
    sendNotification(this.deps, 'error', 'Auth', reason);
    this.failConnect(msg, reason, 'INVALID_LOGIN_URL');
    return undefined;
  }

  private async handleOAuthWeb(
    msg: InboundRequest,
    payload: OrgConnectRequest['payload'],
  ): Promise<void> {
    // Checked before the CLI runs: the URL goes into an `sf org login web`
    // command line, which on Windows is a shell string.
    const loginUrl = this.resolveLoginUrl(msg, payload);
    if (!loginUrl) return;

    try {
      const available = await this.deps.sfdxBridge.isCliAvailable();
      if (!available) {
        this.notifyCliMissing('OAuth web login runs through it.');
        this.failConnect(msg, SF_CLI_MISSING_MESSAGE, 'SF_CLI_NOT_FOUND');
        return;
      }

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
        this.failConnect(msg, 'Login completed but no org found.', 'NO_ORGS_FOUND');
        return;
      }

      const savedIds = await this.saveImported(results);

      sendNotification(
        this.deps,
        'success',
        'OAuth',
        `Authenticated via browser. ${results.length} org(s) available.`,
      );
      this.ackConnect(msg, savedIds[0]);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:oauth-web: ${message}`);
      sendNotification(this.deps, 'error', 'OAuth Failed', message);
      this.failConnect(msg, message, 'OAUTH_WEB_FAILED');
    }
  }

  private async handleOrgDisconnect(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgDisconnectPayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    // Drop the pooled entry FIRST: it caches the org's access token in memory
    // and `removeOrg` only clears the config store, the vault and OrgManager.
    // Without this the revoked org's token stayed live in the pool until the
    // extension host restarted, and any code path holding its UUID could still
    // build a working Connection from it. Done before the store removal so a
    // failing `removeOrg` cannot leave the credential behind either.
    getConnectionPool().remove(payload.orgId as UUID);

    await this.deps.orgRegistry.removeOrg(payload.orgId);

    const statusMsg = buildResponse(this.deps, msg, 'org:statusChanged', {
      orgId: payload.orgId,
      status: 'disconnected',
    });
    this.deps.broker.postToWebview(statusMsg);
    this.deps.log(`[TX] ${statusMsg.type} id=${statusMsg.id}`);

    this.syncOrgState();
  }

  /**
   * Select the active org from a panel org picker. Replays the same contract
   * as the sidebar's raw `sidebar:selectOrg` path: the late-injected callback
   * updates the status bar, and `org:selected` is broadcast so every webview
   * (sidebar included) syncs its store.
   */
  private handleOrgSelect(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgSelectPayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;
    const { orgId } = parsed;

    if (!this.deps.orgManager.getOrg(orgId as UUID)) {
      sendNotification(this.deps, 'warning', 'Orgs', `Unknown org: ${orgId}`);
      return;
    }

    this.deps.onOrgSelected?.(orgId);

    const selectedMsg = buildResponse(this.deps, msg, 'org:selected', { orgId });
    this.deps.broker.postToWebview(selectedMsg);
    this.deps.log(`[TX] ${selectedMsg.type} id=${selectedMsg.id}`);
  }

  /**
   * Save the alias, colour and tags typed in the org edit dialog.
   *
   * The dialog used to change only the panel's own copy of the org: the next
   * org list from the host put the old values back, and a reload lost them.
   * Everything else on the org — its type, safety tier and credentials — stays
   * as the host last saved it. The reply is the saved list, correlated to the
   * request, so the page shows what the registry now holds.
   */
  private handleOrgUpdate(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgUpdatePayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;

    const org = this.deps.orgManager.getOrg(parsed.orgId as UUID);
    if (!org) {
      sendHandlerError(
        this.deps,
        'org:update',
        'org:error',
        msg,
        new Error(`Unknown org: ${parsed.orgId}`),
        { code: 'ORG_NOT_FOUND', retryable: false },
      );
      return;
    }

    try {
      this.deps.orgRegistry.updateOrgMetadata({
        ...org,
        alias: parsed.alias,
        appearance: { ...org.appearance, color: parsed.color },
        tags: parsed.tags,
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'org:update', 'org:error', msg, err, {
        code: 'ORG_UPDATE_FAILED',
        retryable: true,
      });
      return;
    }

    const response = buildResponse(this.deps, msg, 'org:list:response', {
      orgs: this.deps.orgManager.getAllOrgs() as unknown as Record<string, unknown>[],
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);

    this.syncOrgState();
  }

  private syncOrgState(): void {
    const orgs = this.deps.orgManager.getAllOrgs();
    this.deps.stateSync.updateState({
      orgs: orgs as unknown as Record<string, unknown>[],
    });
  }
}
