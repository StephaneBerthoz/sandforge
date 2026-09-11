import { z } from 'zod';

export const AIUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative().default(0),
    cacheCreate: z.number().int().nonnegative().default(0),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type AIUsage = z.infer<typeof AIUsageSchema>;

export function aiCallResultSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z
    .object({
      payload: payloadSchema,
      usage: AIUsageSchema,
      model: z.string(),
      stopReason: z
        .enum(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'refusal'])
        .nullable(),
    })
    .strict();
}
