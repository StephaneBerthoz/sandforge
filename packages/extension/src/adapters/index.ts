/**
 * Adapter layer — centralised IO facades shared across the extension.
 * The composition root (services.ts) builds one of each.
 */
export { TelemetryAdapter } from './telemetry/index.js';
export type { Logger, TelemetryAdapterOptions } from './telemetry/index.js';

export { StorageAdapter } from './storage/index.js';

export { FsAdapter } from './fs/index.js';
