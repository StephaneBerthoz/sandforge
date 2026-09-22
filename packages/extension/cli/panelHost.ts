/**
 * The extension host a panel talks to, stood up without the editor.
 *
 * The backup runner builds its one handler by hand and chooses what it
 * receives. That is enough for a handler that holds its whole flow, but a
 * runner that wires its own pieces tests its own wiring: a handler that reads
 * a dependency the runner never thought to give it looks broken, and one that
 * reads a dependency the extension never gives it looks fine. Compare and
 * Monitor are driven through what the extension builds instead:
 * `ExtensionHandlers` constructs the handlers and the deps they share,
 * `registerAll` routes them, the `MessageBroker` checks each request's
 * envelope as it does for a webview, and orgs go through the product's own
 * registry.
 *
 * The stand-ins are only what VS Code hands over at activation: the memento
 * behind the ConfigStore (a JSON file, see `fileConfigStore`), the
 * SecretStorage behind the vault (memory, so a token never reaches the disk),
 * the Services bundle `createServices` builds from the VS Code API (only the
 * members these handlers read), and the webview at the far end of the broker.
 *
 * A request leaves the way the panel's hooks send one — built by the
 * webview's rules, enveloped, posted into the broker — and is answered the way
 * they take one: the first message of the response type, of the domain's
 * error channel, or a bridge refusal, that carries the request's id. Anything
 * else is not the panel's answer, however plausible it looks.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier, PROTOCOL_VERSION, SF_LIMITS } from '@sandforge/shared';
import { loadOrg } from './sfSession.js';
import type { SfOrg } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { ExtensionHandlers } from '../src/bridge/ExtensionHandlers.js';
import { MessageBroker } from '../src/bridge/MessageBroker.js';
import { MessageRouter } from '../src/bridge/MessageRouter.js';
import { WebviewStateSync } from '../src/bridge/WebviewStateSync.js';
import { SecretVault } from '../src/core/storage/SecretVault.js';
import { OrgManager } from '../src/core/connection/OrgManager.js';
import { OrgRegistry } from '../src/core/connection/OrgRegistry.js';
import { AuthProvider } from '../src/core/connection/AuthProvider.js';
import type { OrgIdentity } from '../src/core/connection/AuthProvider.js';
import { SfdxBridge } from '../src/core/connection/SfdxBridge.js';
import { CompareOrchestrator } from '../src/modules/compare/CompareOrchestrator.js';
import { LiveOperationTracker } from '../src/modules/monitor/LiveOperationTracker.js';
import type { Services } from '../src/services.js';

/** How long the panel's hooks wait for an answer unless told otherwise. */
export const PANEL_TIMEOUT_MS = 30_000;

/** A message as the host posts it: every reply carries a payload. */
export type PostedMessage = BaseMessage & { payload?: unknown };

/** How a request ended, read as the panel's hook would read it. */
export type PanelOutcome =
  /** The response type, correlated to the request. */
  | 'answered'
  /** The domain's error channel, correlated to the request. */
  | 'failed'
  /** The broker turned the request down before any handler saw it. */
  | 'refused'
  /** Nothing correlated arrived before the host stopped waiting. */
  | 'unanswered';

/** What a request came back with. */
export interface PanelAnswer {
  outcome: PanelOutcome;
  /** The message that settled the request; absent when none did. */
  message?: PostedMessage;
  /** From the request being posted to the message that settled it. */
  elapsedMs: number;
  /**
   * Settled after the hook's own timeout. The panel would have shown its
   * timeout banner by then and dropped this answer, whatever it says.
   */
  late: boolean;
}

/** A request, as a panel hook sends it. */
export interface PanelRequest {
  type: string;
  payload?: Record<string, unknown>;
  /** The hook's `responseType`; `<type>:response` when it names none. */
  responseType?: string;
  /** The hook's `timeoutMs`; {@link PANEL_TIMEOUT_MS} when it names none. */
  timeoutMs?: number;
}

/** The host, ready to take requests. */
export interface PanelHost {
  /** Register an org the way connecting it in the extension does. */
  connect(alias: string): Promise<SalesforceOrg>;
  /** Send one request and wait for what would answer it. */
  request(request: PanelRequest): Promise<PanelAnswer>;
  /** Every message the host posted to the panel, in order. */
  readonly posted: readonly PostedMessage[];
}

/** What the host needs from whoever runs it. */
export interface PanelHostOptions {
  /** Where the ConfigStore file lives; what one run stores, the next reads. */
  storeDir: string;
  /** Extension log lines and flagged messages go here. */
  log: (line: string) => void;
  /**
   * How long to keep listening past the hook's timeout, so an answer that
   * comes late is seen as late rather than as none. Default five minutes.
   */
  waitMs?: number;
}

/**
 * The org a connection registers, typed the way `OrgHandler` types it.
 *
 * The id is the org's own (`Organization.Id`), which is what every handler is
 * addressed with, and the type comes from `Organization.IsSandbox`, never from
 * the alias or the instance URL: a sandbox's My Domain says "sandbox" only
 * until someone renames it.
 */
export function orgFromIdentity(session: SfOrg, identity: OrgIdentity): SalesforceOrg {
  const sandbox = identity.isSandbox;
  return {
    id: identity.orgId,
    alias: session.alias,
    username: identity.username || session.username,
    instanceUrl: session.instanceUrl,
    orgId: identity.orgId,
    orgType: sandbox ? 'Sandbox' : 'Production',
    authMethod: 'sfdx_import',
    safetyTier: sandbox ? OrgSafetyTier.LOW : OrgSafetyTier.CRITICAL,
    appearance: { color: sandbox ? '#4a9eff' : '#e74c3c', icon: 'cloud', position: 0 },
    metadata: {
      apiVersion: SF_LIMITS.DEFAULT_API_VERSION,
      edition: identity.orgType,
      features: [],
    },
    status: 'connected',
    lastConnected: new Date().toISOString(),
    tags: [],
  };
}

/**
 * Whether a posted message settles the request `requestId`, and how.
 *
 * The rules of the webview's `useMessageResponse`: a message answers only the
 * request whose id it carries as `correlationId`. A reply of the right type
 * for another request, or one carrying no correlation at all, answers
 * nothing — the hook would keep waiting, and so does this.
 */
export function settles(
  message: PostedMessage,
  requestId: string,
  responseType: string,
  errorType: string,
): Exclude<PanelOutcome, 'unanswered'> | undefined {
  if (message.correlationId !== requestId) return undefined;
  if (message.type === responseType) return 'answered';
  if (message.type === errorType) return 'failed';
  if (message.type === 'bridge:error') return 'refused';
  return undefined;
}

/**
 * The line worth printing about a posted message that is not an answer: a
 * failure, a refusal, a notification. `undefined` for anything else.
 */
export function problemLine(message: PostedMessage): string | undefined {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  if (message.type.endsWith(':error') || message.type === 'operation:failed') {
    const text = payload.message ?? payload.error ?? payload.details ?? JSON.stringify(payload);
    return `! ${message.type}: ${String(text)}`;
  }
  if (message.type === 'notification') {
    return `! notification (${String(payload.level)}): ${String(payload.title)} — ${String(payload.message)}`;
  }
  return undefined;
}

/**
 * The Services bundle, cut down to what the routed handlers read.
 *
 * `createServices` builds it from the VS Code API, which is not here. The
 * compare factory is the one it declares; a setting reads as its manifest
 * default, which is what VS Code answers for a setting nobody changed.
 */
function headlessServices(configStore: ReturnType<typeof fileConfigStore>): Services {
  const services: Pick<
    Services,
    'compareOrchestrator' | 'getSandforgeSetting' | 'isAIEnabled' | 'configStore'
  > = {
    compareOrchestrator: (deps) => new CompareOrchestrator(deps),
    getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
    isAIEnabled: () => false,
    configStore,
  };
  return services as Services;
}

/** Stand up the host: stores, registry, broker, router and every handler. */
export function createPanelHost(options: PanelHostOptions): PanelHost {
  const { log } = options;
  const waitMs = options.waitMs ?? 5 * 60_000;

  // What `createCoreComposition` builds, with the two VS Code backends
  // replaced: a file for the memento, memory for SecretStorage.
  const configStore = fileConfigStore(join(options.storeDir, 'configStore.json'));
  const secrets = new Map<string, string>();
  const secretVault = new SecretVault({
    get: (key) => Promise.resolve(secrets.get(key)),
    store: (key, value) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      secrets.delete(key);
      return Promise.resolve();
    },
  });
  const orgManager = new OrgManager();
  const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);
  const sfdxBridge = new SfdxBridge();
  const authProvider = new AuthProvider();
  authProvider.setSfdxBridge(sfdxBridge);

  const broker = new MessageBroker();
  broker.setLogFunction(log);
  const router = new MessageRouter(broker);
  const handlers = new ExtensionHandlers({
    log,
    broker,
    stateSync: new WebviewStateSync(broker),
    orgManager,
    orgRegistry,
    configStore,
    secretVault,
    authProvider,
    sfdxBridge,
    services: headlessServices(configStore),
  });
  // The late service the Monitor reads (see composition/lateServices.ts).
  handlers.setLiveOperationTracker(new LiveOperationTracker());
  handlers.registerAll(router);

  // The webview at the far end: it records what it is sent and hands what it
  // sends to whichever listener the broker subscribed.
  const posted: PostedMessage[] = [];
  const waiters = new Set<(message: PostedMessage) => void>();
  let inbound: ((raw: unknown) => void) | undefined;
  const panel = {
    webview: {
      postMessage: (message: PostedMessage): Promise<boolean> => {
        posted.push(message);
        const line = problemLine(message);
        if (line) log(`  ${line}`);
        for (const waiter of [...waiters]) waiter(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (raw: unknown) => void) => {
        inbound = listener;
        return {
          dispose: () => {
            inbound = undefined;
          },
        };
      },
    },
  };
  broker.registerPanel(panel as unknown as Parameters<MessageBroker['registerPanel']>[0]);

  return {
    posted,

    async connect(alias: string): Promise<SalesforceOrg> {
      const session = loadOrg(alias);
      // The query OrgHandler types a connection from.
      const identity = await authProvider.validateConnection(
        session.accessToken,
        session.instanceUrl,
      );
      const org = orgFromIdentity(session, identity);
      await orgRegistry.saveOrg(org, {
        loginUrl: session.instanceUrl,
        instanceUrl: session.instanceUrl,
        accessToken: session.accessToken,
        username: session.username,
      });
      return org;
    },

    request(request: PanelRequest): Promise<PanelAnswer> {
      const send = inbound;
      if (!send) return Promise.reject(new Error('No panel is registered with the broker.'));
      const responseType = request.responseType ?? `${request.type}:response`;
      const errorType = `${request.type.split(':')[0]}:error`;
      const timeoutMs = request.timeoutMs ?? PANEL_TIMEOUT_MS;
      // `buildMessage` in the webview: a random id, the type, a timestamp,
      // and the payload only when there is one.
      const message: PostedMessage = {
        id: `wv-${randomUUID()}`,
        type: request.type,
        timestamp: Date.now(),
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
      };
      const startedAt = Date.now();

      return new Promise((resolve) => {
        const finish = (answer: PanelAnswer): void => {
          waiters.delete(waiter);
          clearTimeout(giveUp);
          resolve(answer);
        };
        const waiter = (reply: PostedMessage): void => {
          const outcome = settles(reply, message.id, responseType, errorType);
          if (!outcome) return;
          const elapsedMs = Date.now() - startedAt;
          finish({ outcome, message: reply, elapsedMs, late: elapsedMs > timeoutMs });
        };
        const giveUp = setTimeout(
          () => finish({ outcome: 'unanswered', elapsedMs: Date.now() - startedAt, late: true }),
          Math.max(waitMs, timeoutMs),
        );
        waiters.add(waiter);
        // `postEnvelopedMessage` in the webview.
        send({ protocolVersion: PROTOCOL_VERSION, payload: message });
      });
    },
  };
}
