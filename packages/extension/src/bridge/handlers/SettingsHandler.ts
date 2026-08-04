import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import {
  validatePayload,
  settingsUpdatePayloadSchema,
  hintDismissPayloadSchema,
  telemetryTogglePayloadSchema,
  pluginsLoadPayloadSchema,
  pluginsUnloadPayloadSchema,
} from '../validatePayload.js';
import type { OnboardingService } from '../../core/onboarding/OnboardingService.js';
import type { HintTracker } from '../../core/onboarding/HintTracker.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Message types handled by SettingsHandler. */
const SETTINGS_TYPES = new Set([
  'settings:get',
  'settings:update',
  'onboarding:complete',
  'onboarding:reset',
  'hint:dismiss',
  'plugins:list',
  'plugins:load',
  'plugins:unload',
  'telemetry:status',
  'telemetry:toggle',
  'connectivity:status',
]);

/**
 * Domain handler for settings, onboarding, plugins, telemetry,
 * and connectivity-related webview-to-extension messages.
 *
 * Groups all configuration and infrastructure-status operations
 * into a single cohesive handler.
 */
export class SettingsHandler implements DomainHandler {
  private onboardingService?: OnboardingService;
  private hintTracker?: HintTracker;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject onboarding services after construction. */
  setOnboardingServices(onboarding: OnboardingService, hints: HintTracker): void {
    this.onboardingService = onboarding;
    this.hintTracker = hints;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!SETTINGS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'settings:get':
        this.handleSettingsGet(msg);
        return true;
      case 'settings:update':
        this.handleSettingsUpdate(msg);
        return true;
      case 'onboarding:complete':
        this.handleOnboardingComplete(msg);
        return true;
      case 'onboarding:reset':
        this.handleOnboardingReset(msg);
        return true;
      case 'hint:dismiss':
        this.handleHintDismiss(msg);
        return true;
      case 'plugins:list':
        this.handlePluginsList(msg);
        return true;
      case 'plugins:load':
        await this.handlePluginsLoad(msg);
        return true;
      case 'plugins:unload':
        this.handlePluginsUnload(msg);
        return true;
      case 'telemetry:status':
        this.handleTelemetryStatus(msg);
        return true;
      case 'telemetry:toggle':
        await this.handleTelemetryToggle(msg);
        return true;
      case 'connectivity:status':
        this.handleConnectivityStatus(msg);
        return true;
      default:
        return false;
    }
  }

  private handleSettingsGet(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const settings = this.deps.configStore.getByCategory('settings');
    const response = buildResponse(this.deps, msg, 'settings:response', { settings });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private handleSettingsUpdate(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(settingsUpdatePayloadSchema, msg, 'settings:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    this.deps.configStore.set(payload.key, payload.value, 'settings');

    const settings = this.deps.configStore.getByCategory('settings');
    const response = buildResponse(this.deps, msg, 'settings:response', { settings });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private handleOnboardingComplete(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (this.onboardingService) {
      this.onboardingService.markOnboardingComplete().catch((err) => {
        this.deps.log(`[ERR] Failed to mark onboarding complete: ${extractErrorMessage(err)}`);
      });
    }
  }

  private handleOnboardingReset(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (this.onboardingService) {
      this.onboardingService.resetOnboarding().catch((err) => {
        this.deps.log(`[ERR] Failed to reset onboarding: ${extractErrorMessage(err)}`);
      });
    }
  }

  private handleHintDismiss(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (this.hintTracker) {
      const parsed = validatePayload(hintDismissPayloadSchema, msg, 'settings:error', this.deps);
      if (!parsed) return;
      this.hintTracker.markHintSeen(parsed.hintId).catch((err) => {
        this.deps.log(`[ERR] Failed to mark hint seen: ${extractErrorMessage(err)}`);
      });
    }
  }

  private handlePluginsList(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const response = buildResponse(this.deps, msg, 'plugins:list:response', {
      success: true,
      plugins: [] as unknown[],
    });
    this.deps.broker.postToWebview(response);
  }

  private async handlePluginsLoad(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(pluginsLoadPayloadSchema, msg, 'settings:error', this.deps);
    if (!parsed) return;
    const { pluginPath } = parsed;
    try {
      const { PluginManager } = await import('../../core/plugins/PluginManager.js');
      const fsImpl = {
        readFile: async (fp: string) => {
          const fsModule = await import('fs/promises');
          return fsModule.readFile(fp, 'utf-8');
        },
        exists: async (fp: string) => {
          const fsModule = await import('fs/promises');
          return fsModule
            .access(fp)
            .then(() => true)
            .catch(() => false);
        },
        readDir: async (dp: string) => {
          const fsModule = await import('fs/promises');
          return fsModule.readdir(dp);
        },
      };
      const moduleLoader = {
        load: async (entrypoint: string) => {
          return import(entrypoint) as Promise<
            import('../../core/plugins/PluginManager').SandForgePlugin
          >;
        },
      };
      const pm = new PluginManager(fsImpl, moduleLoader, pluginPath);
      const loaded = await pm.loadPlugins();
      const response = buildResponse(this.deps, msg, 'plugins:load:response', {
        success: true,
        loadedPlugins: loaded,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] plugins:load: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'plugins:load:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private handlePluginsUnload(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(pluginsUnloadPayloadSchema, msg, 'settings:error', this.deps);
    if (!parsed) return;
    const { pluginName } = parsed;
    const response = buildResponse(this.deps, msg, 'plugins:unload:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] plugins:unload:response (${pluginName})`);
  }

  /**
   * Report the real telemetry state: the `sandforge.telemetry` VS Code
   * setting (manifest default false) plus the count of telemetry events
   * actually emitted since activation. `bufferSize` is always 0 — Pino
   * writes synchronously to its destination, there is no event buffer.
   */
  private handleTelemetryStatus(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const enabled = this.deps.services?.getSandforgeSetting?.('telemetry', false) ?? false;
    const eventCount = this.deps.services?.telemetry.getTelemetryEventCount() ?? 0;
    const response = buildResponse(this.deps, msg, 'telemetry:status:response', {
      enabled,
      eventCount,
      bufferSize: 0,
    });
    this.deps.broker.postToWebview(response);
  }

  /**
   * Persist the telemetry opt-in to the `sandforge.telemetry` setting
   * (Global scope). Responds with the value actually persisted; when the
   * settings backend is unavailable (partial Services in tests), answers
   * honestly with success: false instead of pretending the toggle worked.
   */
  private async handleTelemetryToggle(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(telemetryTogglePayloadSchema, msg, 'settings:error', this.deps);
    if (!parsed) return;
    const { enabled } = parsed;

    if (!this.deps.services?.setSandforgeSetting) {
      const response = buildResponse(this.deps, msg, 'telemetry:toggle:response', {
        success: false,
        enabled: this.deps.services?.getSandforgeSetting?.('telemetry', false) ?? false,
        error: 'Settings backend not available — telemetry preference was not persisted.',
      });
      this.deps.broker.postToWebview(response);
      return;
    }

    try {
      await this.deps.services.setSandforgeSetting('telemetry', enabled);
      const persisted = this.deps.services.getSandforgeSetting?.('telemetry', enabled) ?? enabled;
      const response = buildResponse(this.deps, msg, 'telemetry:toggle:response', {
        success: true,
        enabled: persisted,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] telemetry:toggle: ${extractErrorMessage(err)}`);
      const response = buildResponse(this.deps, msg, 'telemetry:toggle:response', {
        success: false,
        enabled: this.deps.services.getSandforgeSetting?.('telemetry', false) ?? false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(response);
    }
  }

  private handleConnectivityStatus(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const offlineManager = this.deps.infraServices?.offlineManager;
    const status = offlineManager ? offlineManager.getStatus() : 'online';
    const response = buildResponse(this.deps, msg, 'connectivity:status:response', {
      online: status === 'online',
      lastChecked: new Date().toISOString(),
      queueSize: offlineManager ? offlineManager.getQueueSize() : 0,
    });
    this.deps.broker.postToWebview(response);
  }
}
