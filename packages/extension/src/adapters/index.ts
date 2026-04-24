/**
 * Adapter layer — centralised IO facades shared across the extension.
 * Plans 01-03 / 01-04 wire these into the composition root.
 */
export { SalesforceAdapter } from './salesforce/index.js';
export type {
  SalesforceAdapterOptions,
  SalesforceLikeError,
  SalesforceLimitsSnapshot,
  WithLimitContext,
} from './salesforce/index.js';

export { TelemetryAdapter, stripSensitiveFields } from './telemetry/index.js';
export type { Logger, SentryModule, TelemetryAdapterOptions } from './telemetry/index.js';

export { StorageAdapter } from './storage/index.js';

export { FsAdapter } from './fs/index.js';
