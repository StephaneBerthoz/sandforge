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

export const DiagnoseSuggestedActionSchema = z
  .object({
    label: z.string().min(1).max(120),
    kind: z.enum(['copy-soql', 'open-file', 'run-anonymous', 'manual']),
    payload: z.string().max(8000).optional(),
    requiresApproval: z.boolean(),
  })
  .strict();
export type DiagnoseSuggestedAction = z.infer<typeof DiagnoseSuggestedActionSchema>;

export const DiagnoseResultSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    rootCause: z.string().min(1).max(4000),
    suggestedActions: z.array(DiagnoseSuggestedActionSchema).max(5),
    confidence: z.enum(['low', 'medium', 'high']),
    references: z.array(z.string().url()).max(10).optional(),
  })
  .strict();
export type DiagnoseResult = z.infer<typeof DiagnoseResultSchema>;
