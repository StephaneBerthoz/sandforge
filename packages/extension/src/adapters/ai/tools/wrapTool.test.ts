import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { wrapTool, READ_ONLY_NAME_REGEX } from './wrapTool.js';

const okOutput = z.object({ value: z.string() }).strict();

describe('wrapTool — read-only fence', () => {
  it('accepts a valid read-verb name', () => {
    const tool = wrapTool({
      name: 'describe_account',
      description: 'READ-ONLY describe',
      input: z.object({}),
      output: okOutput,
      run: async () => ({ value: 'x' }),
    });
    expect(tool.name).toBe('describe_account');
    expect(tool.name).toMatch(READ_ONLY_NAME_REGEX);
  });

  it('THROWS on apply_*', () => {
    expect(() =>
      wrapTool({
        name: 'apply_apex',
        description: 'READ-ONLY apply',
        input: z.object({}),
        output: okOutput,
        run: async () => ({ value: 'x' }),
      }),
    ).toThrow(/violates read-only convention/);
  });

  it('THROWS on update_*', () => {
    expect(() =>
      wrapTool({
        name: 'update_record',
        description: 'READ-ONLY update',
        input: z.object({}),
        output: okOutput,
        run: async () => ({ value: 'x' }),
      }),
    ).toThrow(/violates read-only convention/);
  });

  it('THROWS on delete_*', () => {
    expect(() =>
      wrapTool({
        name: 'delete_metadata',
        description: 'READ-ONLY delete',
        input: z.object({}),
        output: okOutput,
        run: async () => ({ value: 'x' }),
      }),
    ).toThrow(/violates read-only convention/);
  });

  it('THROWS when description lacks the READ-ONLY substring', () => {
    expect(() =>
      wrapTool({
        name: 'describe_account',
        description: 'normal describe',
        input: z.object({}),
        output: okOutput,
        run: async () => ({ value: 'x' }),
      }),
    ).toThrow(/READ-ONLY/);
  });
});

describe('wrapTool — runtime contract', () => {
  it('happy path: parses input, runs, returns JSON-encoded { ok:true, data }, fires start+success traces', async () => {
    const traces: string[] = [];
    const tool = wrapTool({
      name: 'describe_account',
      description: 'READ-ONLY describe',
      input: z.object({ x: z.number() }),
      output: okOutput,
      onTrace: (e) => traces.push(`${e.name}:${e.status}`),
      run: async ({ x }) => ({ value: `n=${x}` }),
    });
    const result = await tool.run({ x: 7 });
    expect(JSON.parse(result)).toEqual({ ok: true, data: { value: 'n=7' } });
    expect(traces).toEqual(['describe_account:start', 'describe_account:success']);
  });

  it('run throws → returns JSON { ok:false, error } and fires an error trace', async () => {
    const onTrace = vi.fn();
    const tool = wrapTool({
      name: 'describe_account',
      description: 'READ-ONLY describe',
      input: z.object({}),
      output: okOutput,
      onTrace,
      run: async () => {
        throw new Error('boom');
      },
    });
    const result = JSON.parse(await tool.run({}));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_ERROR');
    expect(result.error.message).toContain('boom');
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'describe_account', status: 'start' }),
    );
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'describe_account',
        status: 'error',
        errorCode: 'TOOL_ERROR',
      }),
    );
  });

  it('output schema mismatch → error code = OUTPUT_SCHEMA_MISMATCH', async () => {
    const tool = wrapTool({
      name: 'describe_account',
      description: 'READ-ONLY describe',
      input: z.object({}),
      output: okOutput,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ wrongShape: 1 }) as any,
    });
    const result = JSON.parse(await tool.run({}));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('OUTPUT_SCHEMA_MISMATCH');
  });

  it('input validation failure → wrapped as ok:false (does NOT throw out of wrapper)', async () => {
    const tool = wrapTool({
      name: 'describe_account',
      description: 'READ-ONLY describe',
      input: z.object({ x: z.number() }),
      output: okOutput,
      run: async () => ({ value: 'x' }),
    });
    const result = JSON.parse(await tool.run({ x: 'not-a-number' }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('OUTPUT_SCHEMA_MISMATCH');
  });
});
