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
  orgConnectCancelPayloadSchema,
  orgConnectPayloadSchema,
  orgDeviceConnectPayloadSchema,
  orgDisconnectPayloadSchema,
  orgJwtConnectPayloadSchema,
  orgSelectPayloadSchema,
  orgUpdatePayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getConnectionPool } from '../../core/connection/ConnectionHelper.js';
import { parseSalesforceLoginUrl } from '../../core/common/salesforceLoginHost.js';
import { DeviceLogin } from '../../core/connection/DeviceLogin.js';
import type {
  CliLogin,
  SfdxImportResult,
  SfdxUnreadableOrg,
} from '../../core/connection/SfdxBridge.js';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';

/** Message types handled by OrgHandler. */
const ORG_TYPES = new Set([
  'org:list',
  'org:connect',
  'org:connect:cancel',
  'org:disconnect',
  'org:select',
  'org:update',
]);

/** What OrgHandler reaches outside the extension through; tests pass stand-ins. */
export interface OrgHandlerServices {
  /** Opens the device flow's verification page. */
  browser?: ExternalBrowserAdapter;
  /** Speaks the device flow to Salesforce. */
  deviceLogin?: DeviceLogin;
}

/**
 * Domain handler for org-related webview-to-extension messages.
 *
 * Routes org:* message types to org listing, connection (sfdx import,
 * username/password, OAuth web, JWT bearer, OAuth device flow), metadata edits
 * and disconnection operations.
 */
export class OrgHandler implements DomainHandler {
  private readonly browser: ExternalBrowserAdapter;
  private readonly deviceLogin: DeviceLogin;

  /**
   * Device sign-ins still waiting, by the id of the `org:connect` request that
   * started them, so `org:connect:cancel` can stop one.
   */
  private readonly pendingSignIns = new Map<string, AbortController>();

  /**
   * @param deps - Injected handler dependencies.
   * @param services - Stand-ins for the browser and the device flow; the real ones by default.
   */
  constructor(
    private readonly deps: HandlerDeps,
    services: OrgHandlerServices = {},
  ) {
    this.browser = services.browser ?? new ExternalBrowserAdapter();
    this.deviceLogin = services.deviceLogin ?? new DeviceLogin();
  }

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
      case 'org:connect:cancel':
        this.handleConnectCancel(msg);
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
      case 'jwt':
        await this.handleJwt(msg);
        break;
      case 'oauth_device':
        await this.handleOAuthDevice(msg);
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

      const unreadable: SfdxUnreadableOrg[] = [];
      const results = await this.deps.sfdxBridge.listOrgs((org) => {
        unreadable.push(org);
      });
      if (results.length === 0 && unreadable.length > 0) {
        const message = this.reportUnreadable(unreadable);
        sendNotification(this.deps, 'error', 'Import Failed', message);
        this.failConnect(msg, message, 'SFDX_IMPORT_FAILED');
        return;
      }
      if (results.length === 0) {
        // Something to do before trying again, so the toast stays until it is
        // dismissed, and the banner that outlives it carries the same step: it
        // used to stop at "No connected orgs found in SF CLI."
        const message = 'No connected orgs found in SF CLI. Run "sf org login web" first.';
        sendNotification(this.deps, 'warning', 'Import', message, { autoDismissMs: null });
        this.failConnect(msg, message, 'NO_ORGS_FOUND');
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
      if (unreadable.length > 0) {
        // It stays up: it names orgs the user expected, and why they are missing.
        sendNotification(this.deps, 'warning', 'Import', this.reportUnreadable(unreadable), {
          autoDismissMs: null,
        });
      }
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
   * Log each org an import left out because the CLI gave no access token for
   * it, and word them for the user.
   *
   * @returns What the user reads: which orgs, and why.
   */
  private reportUnreadable(unreadable: readonly SfdxUnreadableOrg[]): string {
    for (const org of unreadable) {
      this.deps.log(
        `[WARN] org:import: no access token for ${org.alias ?? org.username}: ${org.reason}`,
      );
    }
    const orgs = unreadable.map((org) => `${org.alias ?? org.username} (${org.reason})`);
    return `No access token from the Salesforce CLI, so not imported: ${orgs.join('; ')}`;
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
    payload: Pick<OrgConnectRequest['payload'], 'loginUrl'>,
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
      const login = await this.deps.sfdxBridge.loginWeb(alias, loginUrl);

      const unreadable: SfdxUnreadableOrg[] = [];
      const results = await this.deps.sfdxBridge.listOrgs((org) => {
        unreadable.push(org);
      });
      if (results.length === 0 && unreadable.length === 0) {
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

      // The CLI lists its orgs sorted by alias: confirming the first one
      // confirmed whichever org came first, not the one the user had just
      // signed in to. The login's own answer names that org.
      const signedIn = results.findIndex((result) => result.org.orgId === login.orgId);
      if (signedIn === -1) {
        const hidden = unreadable.find((org) => org.orgId === login.orgId);
        throw new Error(
          hidden
            ? `Signed in as ${login.username}, but the Salesforce CLI gave no access token for it: ${hidden.reason}`
            : `Signed in as ${login.username}, but "sf org list" does not list that org as connected.`,
        );
      }

      sendNotification(
        this.deps,
        'success',
        'OAuth',
        `Authenticated via browser as ${login.username}. ${results.length} org(s) available.`,
      );
      if (unreadable.length > 0) {
        sendNotification(this.deps, 'warning', 'OAuth', this.reportUnreadable(unreadable), {
          autoDismissMs: null,
        });
      }
      this.ackConnect(msg, savedIds[signedIn]);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:oauth-web: ${message}`);
      sendNotification(this.deps, 'error', 'OAuth Failed', message);
      this.failConnect(msg, message, 'OAUTH_WEB_FAILED');
    }
  }

  /**
   * Sign in with the JWT bearer flow, through `sf org login jwt`.
   *
   * The private key never passes through SandForge: the webview sends the
   * file's path, the path reaches the CLI as one argv entry, and the CLI reads
   * the key. Nothing here opens, copies, logs or stores the file.
   */
  private async handleJwt(msg: InboundRequest): Promise<void> {
    const input = validatePayload(orgJwtConnectPayloadSchema, msg, 'org:error', this.deps);
    if (!input) return;
    const loginUrl = this.resolveLoginUrl(msg, input);
    if (!loginUrl) return;

    try {
      if (!(await this.requireCli(msg, 'JWT sign-in runs through it.'))) return;
      const login = await this.deps.sfdxBridge.loginJwt({
        username: input.username,
        clientId: input.clientId,
        keyFile: input.jwtKeyFile,
        loginUrl,
        alias: input.alias || undefined,
      });
      await this.importSignedInOrg(msg, login, 'JWT');
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:jwt: ${message}`);
      sendNotification(this.deps, 'error', 'JWT Sign-in Failed', message);
      this.failConnect(msg, message, 'JWT_LOGIN_FAILED');
    }
  }

  /**
   * Sign in with the OAuth device flow: show a code, let the user approve it
   * in the browser, then hand the session to the CLI and import the org.
   *
   * The CLI has no device command left (see DeviceLogin), so the code is
   * asked for and the approval awaited here; `sf org login sfdx-url` then
   * takes the session, and from there the org is the CLI's like any other.
   * The wait ends when the code is approved, refused or expires — ten minutes
   * at most — or when `org:connect:cancel` names this request.
   */
  private async handleOAuthDevice(msg: InboundRequest): Promise<void> {
    const input = validatePayload(orgDeviceConnectPayloadSchema, msg, 'org:error', this.deps);
    if (!input) return;
    const loginUrl = this.resolveLoginUrl(msg, input);
    if (!loginUrl) return;

    const controller = new AbortController();
    this.pendingSignIns.set(msg.id, controller);
    try {
      // Checked before any code is issued: the approval is lost if the CLI
      // that has to keep the session turns out to be missing afterwards.
      if (!(await this.requireCli(msg, 'The device sign-in hands its session to it.'))) return;

      const authorization = await this.deviceLogin.authorize(
        loginUrl,
        input.clientId,
        controller.signal,
      );
      const codeMsg = buildResponse(this.deps, msg, 'org:device-code', {
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresAt: authorization.expiresAt,
      });
      this.deps.broker.postToWebview(codeMsg);
      this.deps.log(`[TX] ${codeMsg.type} id=${codeMsg.id}`);

      // The page shows the link as well, so a browser that did not open
      // costs the user one click, not the sign-in.
      const opened = await this.browser.open(authorization.verificationUri);
      if (opened.status === 'error') {
        this.deps.log(`[WARN] org:oauth-device: verification page not opened: ${opened.message}`);
      }

      const approval = await this.deviceLogin.awaitApproval(
        loginUrl,
        input.clientId,
        authorization,
        controller.signal,
      );
      // A cancel that lands after the approval still wins: nothing has been
      // handed to the CLI yet.
      if (controller.signal.aborted) throw new Error('Sign-in cancelled.');

      const login = await this.deps.sfdxBridge.loginWithRefreshToken({
        clientId: input.clientId,
        refreshToken: approval.refreshToken,
        instanceUrl: approval.instanceUrl,
        alias: input.alias || undefined,
      });
      await this.importSignedInOrg(msg, login, 'Device Sign-in');
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        this.deps.log(`[INFO] org:oauth-device cancelled id=${msg.id}`);
        this.failConnect(msg, 'Sign-in cancelled.', 'CANCELLED');
        return;
      }
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] org:oauth-device: ${message}`);
      sendNotification(this.deps, 'error', 'Device Sign-in Failed', message);
      this.failConnect(msg, message, 'OAUTH_DEVICE_FAILED');
    } finally {
      this.pendingSignIns.delete(msg.id);
    }
  }

  /**
   * Stop the device sign-in an `org:connect` request is waiting on. That
   * request answers for itself, on `org:error` with `CANCELLED`; one that has
   * already finished is left as it ended.
   */
  private handleConnectCancel(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(orgConnectCancelPayloadSchema, msg, 'org:error', this.deps);
    if (!parsed) return;
    this.pendingSignIns.get(parsed.requestId)?.abort();
  }

  /**
   * Whether the CLI is on PATH. When it is not, says so — with the install
   * link — and answers the request.
   *
   * @param why - What the CLI is needed for, appended to the message.
   */
  private async requireCli(msg: InboundRequest, why: string): Promise<boolean> {
    if (await this.deps.sfdxBridge.isCliAvailable()) return true;
    this.notifyCliMissing(why);
    this.failConnect(msg, SF_CLI_MISSING_MESSAGE, 'SF_CLI_NOT_FOUND');
    return false;
  }

  /**
   * Register the org a CLI sign-in just authorized, the way an SFDX import
   * registers it: read back from `sf org list`, typed and tiered from the
   * CLI's entry, and left to the CLI to refresh — which is also why it is
   * recorded as an SFDX import, so Reconnect imports it again. Only this org
   * is saved; the other orgs the CLI holds wait for an import the user asks for.
   *
   * @param via - The sign-in's name, for the success toast title.
   */
  private async importSignedInOrg(
    msg: InboundRequest,
    login: CliLogin,
    via: string,
  ): Promise<void> {
    const imported = await this.deps.sfdxBridge.findOrg(login.username);
    if (!imported) {
      throw new Error(
        `Signed in as ${login.username}, but "sf org list" does not list that org as connected.`,
      );
    }
    // A sandbox signed into again after a refresh keeps its entry, as an
    // SFDX import of it does.
    const [savedId] = await this.saveImported([imported]);
    sendNotification(this.deps, 'success', via, `${imported.org.alias} connected.`);
    this.ackConnect(msg, savedId ?? imported.org.id);
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
