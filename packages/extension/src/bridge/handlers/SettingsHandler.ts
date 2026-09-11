import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import {
  validatePayload,
  settingsUpdatePayloadSchema,
  hintDismissPayloadSchema,
  telemetryTogglePayloadSchema,
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
  'telemetry:status',
  'telemetry:toggle',
  'connectivity:status',
]);

/**
 * Domain handler for settings, onboarding, telemetry,
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
  async handle(msg: InboundRequest): Promise<boolean> {
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

  private handleSettingsGet(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const settings = this.deps.configStore.getByCategory('settings');
    const response = buildResponse(this.deps, msg, 'settings:response', { settings });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private handleSettingsUpdate(msg: InboundRequest): void {
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

  private handleHintDismiss(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (this.hintTracker) {
      const parsed = validatePayload(hintDismissPayloadSchema, msg, 'settings:error', this.deps);
      if (!parsed) return;
      this.hintTracker.markHintSeen(parsed.hintId).catch((err) => {
        this.deps.log(`[ERR] Failed to mark hint seen: ${extractErrorMessage(err)}`);
      });
    }
  }

  private handleTelemetryStatus(msg: InboundRequest): void {
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
  private async handleTelemetryToggle(msg: InboundRequest): Promise<void> {
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

  private handleConnectivityStatus(msg: InboundRequest): void {
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
