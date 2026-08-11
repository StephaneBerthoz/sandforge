import type { BaseMessage } from './base.messages.js';
import type { ActiveOperation } from '../execution.types.js';

/** Settings messages */
export interface SettingsGetRequest extends BaseMessage {
  type: 'settings:get';
}

/** Request to update a single setting value */
export interface SettingsUpdateRequest extends BaseMessage {
  type: 'settings:update';
  payload: { key: string; value: unknown };
}

/**
 * Response containing the current application settings.
 *
 * NOTE: `settings` is a flat key/value bag straight from
 * `ConfigStore.getByCategory('settings')` (e.g. `{ theme: 'dark' }`), NOT the
 * nested {@link AppSettings} structure from `settings.types.ts`.
 */
export interface SettingsResponse extends BaseMessage {
  type: 'settings:response';
  payload: { settings: Record<string, unknown> };
}

/** Notification message */
export interface NotificationMessage extends BaseMessage {
  type: 'notification';
  payload: {
    level: 'info' | 'success' | 'warning' | 'error';
    title: string;
    message: string;
    actions?: NotificationAction[];
    autoDismissMs?: number;
  };
}

/** Notification action button */
export interface NotificationAction {
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

/** Onboarding messages (WebView → Extension) */
export interface OnboardingCompleteRequest extends BaseMessage {
  type: 'onboarding:complete';
  payload: { skipped: boolean };
}

/** Request to reset the onboarding flow so it shows again */
export interface OnboardingResetRequest extends BaseMessage {
  type: 'onboarding:reset';
  payload: Record<string, never>;
}

/** Request to dismiss a contextual hint so it is not shown again */
export interface HintDismissRequest extends BaseMessage {
  type: 'hint:dismiss';
  payload: { hintId: string };
}

/** Onboarding messages (Extension → WebView) */
/** Instructs the WebView to display the onboarding wizard */
export interface OnboardingShowMessage extends BaseMessage {
  type: 'onboarding:show';
  payload: Record<string, never>;
}

/** Instructs the WebView to display the "What's New" panel for a version */
export interface WhatsNewShowMessage extends BaseMessage {
  type: 'whats-new:show';
  payload: { version: string };
}

/** Telemetry management */
export interface TelemetryStatusRequest extends BaseMessage {
  type: 'telemetry:status';
}

/** Response containing current telemetry status and buffer metrics */
export interface TelemetryStatusResponse extends BaseMessage {
  type: 'telemetry:status:response';
  payload: { enabled: boolean; eventCount: number; bufferSize: number };
}

/** Request to enable or disable telemetry collection */
export interface TelemetryToggleRequest extends BaseMessage {
  type: 'telemetry:toggle';
  payload: { enabled: boolean };
}

/** Response after toggling telemetry */
export interface TelemetryToggleResponse extends BaseMessage {
  type: 'telemetry:toggle:response';
  payload: { success: boolean; enabled: boolean; error?: string };
}

/** Connectivity status */
export interface ConnectivityStatusRequest extends BaseMessage {
  type: 'connectivity:status';
}

/** Response containing online/offline status and queued operation count */
export interface ConnectivityStatusResponse extends BaseMessage {
  type: 'connectivity:status:response';
  payload: { online: boolean; lastChecked: string; queueSize: number };
}

// ─── Config Profile Messages ─────────────────────────────────────────────────

/** Request to export a configuration profile. */
export interface ConfigExportRequest extends BaseMessage {
  type: 'config:export';
  payload: {
    categories: Array<
      'syncMappings' | 'forgePlans' | 'pipelines' | 'anonymizationTemplates' | 'settings'
    >;
  };
}

/** Response containing the exported profile JSON. */
export interface ConfigExportResponse extends BaseMessage {
  type: 'config:export:response';
  payload: {
    success: boolean;
    json?: string;
    categoriesExported: number;
    entriesExported: number;
    error?: string;
  };
}

/** Request to import a configuration profile. */
export interface ConfigImportRequest extends BaseMessage {
  type: 'config:import';
  payload: {
    json: string;
    overwrite: boolean;
  };
}

/** Response after importing a configuration profile. */
export interface ConfigImportResponse extends BaseMessage {
  type: 'config:import:response';
  payload: {
    success: boolean;
    categoriesImported: number;
    entriesImported: number;
    warnings: string[];
    error?: string;
  };
}

/** Request to list available config categories and their counts. */
export interface ConfigCategoriesRequest extends BaseMessage {
  type: 'config:categories';
}

/** Response containing config category counts. */
export interface ConfigCategoriesResponse extends BaseMessage {
  type: 'config:categories:response';
  payload: {
    categories: Array<{
      category: string;
      entryCount: number;
    }>;
  };
}

/** Request to validate a config profile JSON without importing. */
export interface ConfigValidateRequest extends BaseMessage {
  type: 'config:validate';
  payload: { json: string };
}

/** Response with validation results. */
export interface ConfigValidateResponse extends BaseMessage {
  type: 'config:validate:response';
  payload: {
    valid: boolean;
    categories?: string[];
    error?: string;
  };
}

// ─── State Synchronization Messages ─────────────────────────────────────────

/** State snapshot that gets pushed to connected webviews. */
export interface WebviewState {
  orgs: Record<string, unknown>[];
  settings: Record<string, unknown>;
  activeOperations: ActiveOperation[];
  extensionReady: boolean;
}

/** Message shape for state synchronization pushes (`state:sync`). */
export interface StateSyncMessage extends BaseMessage {
  type: 'state:sync';
  payload: WebviewState;
}

/** Error response for settings/hint/plugins/telemetry update failures (emitted via sendHandlerError). */
export interface SettingsErrorResponse extends BaseMessage {
  type: 'settings:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** Error response for config profile export/import/validate failures (emitted via sendHandlerError). */
export interface ConfigErrorResponse extends BaseMessage {
  type: 'config:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `easter-egg:show`. Extension -> WebView.
 *
 * Deliberately payload-less: broadcast by commandsComposition via
 * `WebviewPanelManager.postToAllPanels({ type: 'easter-egg:show' })` (a raw
 * postMessage outside the MessageBroker envelope, so no id/timestamp on the
 * wire). PanelApp listens on the bare `type` and shows the overlay.
 */
export interface EasterEggShowMessage extends BaseMessage {
  type: 'easter-egg:show';
  payload?: Record<string, never>;
}
