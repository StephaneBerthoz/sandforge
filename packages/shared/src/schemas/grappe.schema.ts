import { z } from 'zod';

/** Back-pressure configuration schema */
export const backPressureConfigSchema = z.object({
  enabled: z.boolean(),
  maxQueueDepth: z.number().int().positive().default(3),
  highWaterMark: z.number().min(0).max(100).default(80),
  lowWaterMark: z.number().min(0).max(100).default(60),
  strategy: z.enum(['pause', 'throttle', 'drop_priority']),
  monitoringInterval: z.number().positive().default(5000),
}).refine(
  (data) => data.lowWaterMark < data.highWaterMark,
  { message: 'lowWaterMark must be less than highWaterMark', path: ['lowWaterMark'] },
);

/** Grappe (cluster) configuration schema */
export const grappeConfigSchema = z.object({
  enabled: z.boolean(),
  autoActivateThreshold: z.number().int().positive().default(10000),
  maxWorkers: z.number().int().min(1).max(8).default(4),
  grappeSize: z.number().int().positive().default(5000),
  strategy: z.enum([
    'round_robin',
    'by_record_type',
    'by_parent',
    'by_date_range',
    'by_hash',
    'by_volume',
    'dependency_aware',
  ]),
  backPressure: backPressureConfigSchema,
  checkpointing: z.boolean().default(true),
  isolationLevel: z.enum(['none', 'per_object', 'per_grappe']).default('per_grappe'),
});

/** Inferred type for back-pressure configuration input */
export type BackPressureConfigInput = z.infer<typeof backPressureConfigSchema>;

/** Inferred type for grappe configuration input */
export type GrappeConfigInput = z.infer<typeof grappeConfigSchema>;
