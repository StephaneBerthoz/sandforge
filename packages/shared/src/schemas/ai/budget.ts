import { z } from 'zod';
import { AIUsageSchema } from './callResult.js';

/**
 * Per-panel-session token budget snapshot.
 *
 * `state` discriminator:
 *   - 'ok'        — percent < 80
 *   - 'warn'      — 80 <= percent < 100 (one-shot toast at first crossing)
 *   - 'exceeded'  — percent >= 100 (modal blocks input until panel reload)
 *
 * `percent` is clamped to <= 200 in the schema.
 */
export const TokenBudgetStateSchema = z
  .object({
    sessionId: z.string().min(1),
    used: AIUsageSchema,
    budget: z.number().int().positive(),
    percent: z.number().min(0).max(200),
    state: z.enum(['ok', 'warn', 'exceeded']),
  })
  .strict();
export type TokenBudgetState = z.infer<typeof TokenBudgetStateSchema>;
