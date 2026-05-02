// Barrel for the `monitor` namespace introduced by Phase 03 Plan 03-01.
//
// Re-exports the MetricEvent discriminated union + Zod schemas + sample type
// + exhaustiveness helper so consumers can simply
// `import { MetricEvent, MetricEventSchema, assertNever } from '@sandforge/shared'`.
export * from './MetricEvent.js';
