import type { z } from 'zod';

import { toolResultSchema, type ToolError } from '@sandforge/shared';

/**
 * Read-only naming convention enforced at construction. Pitfall #4 fence:
 * future PRs cannot smuggle a write tool past wrapTool().
 */
export const READ_ONLY_NAME_REGEX =
  /^(describe|query|get|list|count|validate|analyse|preview|fetch|read)_[a-z][a-z0-9_]*$/;

export type ToolTraceFn = (event: {
  name: string;
  status: 'start' | 'success' | 'error';
  durationMs?: number;
  errorCode?: string;
}) => void;

export interface WrappedTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: I;
  /**
   * Runs the tool with the validated input AND wraps the output in the
   * `{ ok: true, data } | { ok: false, error }` shape. Returns a JSON string
   * (the format the Anthropic toolRunner expects).
   */
  run: (input: unknown, ctx?: { signal?: AbortSignal }) => Promise<string>;
  /** Output schema kept for tests + introspection (NOT used by the SDK). */
  readonly outputSchema: O;
}

export interface WrapToolOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  onTrace?: ToolTraceFn;
  run: (
    args: z.infer<I>,
    ctx: { signal: AbortSignal },
  ) => Promise<z.infer<O>>;
}

/**
 * Build a strictly-read-only tool definition.
 *
 * - Throws at construction if `name` violates `READ_ONLY_NAME_REGEX`
 *   (RESEARCH Pitfall #4 — defense at the build step, not at call time).
 * - Validates `input` via the supplied Zod schema before running.
 * - Wraps the run body in try/catch and forces the output through
 *   `toolResultSchema(output)` (RESEARCH Pitfall #8).
 * - Calls `onTrace` with `start` / `success` / `error` events; the trace
 *   payload contains NO data — only timings + error codes.
 */
export function wrapTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  opts: WrapToolOptions<I, O>,
): WrappedTool<I, O> {
  if (!READ_ONLY_NAME_REGEX.test(opts.name)) {
    throw new Error(
      `Tool name "${opts.name}" violates read-only convention. Allowed verbs: describe|query|get|list|count|validate|analyse|preview|fetch|read.`,
    );
  }
  if (!opts.description.includes('READ-ONLY')) {
    throw new Error(
      `Tool "${opts.name}" description must contain the literal substring 'READ-ONLY' (intent declaration).`,
    );
  }

  const Result = toolResultSchema(opts.output);

  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.input,
    outputSchema: opts.output,
    run: async (input, ctx) => {
      const startedAt = Date.now();
      opts.onTrace?.({ name: opts.name, status: 'start' });
      const signal = ctx?.signal ?? new AbortController().signal;
      try {
        const parsedInput = opts.input.parse(input);
        const data = await opts.run(parsedInput as z.infer<I>, { signal });
        const result = Result.parse({ ok: true, data });
        const durationMs = Date.now() - startedAt;
        opts.onTrace?.({ name: opts.name, status: 'success', durationMs });
        return JSON.stringify(result);
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const code = classifyErrorCode(err);
        const messageRaw =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'tool error';
        const error: ToolError = { code, message: messageRaw.slice(0, 2000) };
        opts.onTrace?.({ name: opts.name, status: 'error', durationMs, errorCode: code });
        const result = Result.parse({ ok: false, error });
        return JSON.stringify(result);
      }
    },
  };
}

function classifyErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'TOOL_ERROR';
  const e = err as { name?: string; code?: string };
  if (e.name === 'ZodError') return 'OUTPUT_SCHEMA_MISMATCH';
  if (typeof e.code === 'string') return e.code;
  return 'TOOL_ERROR';
}
