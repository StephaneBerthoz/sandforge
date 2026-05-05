import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { StorageAdapter } from '../storage/StorageAdapter.js';

// ── SDK mocks ──────────────────────────────────────────────────────────────
// vi.mock is hoisted; everything it references must be defined inside the
// factory or via vi.hoisted (we use vi.hoisted for the spies so the test
// body can still drive them).
const hoisted = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn();
  const mockMessagesParse = vi.fn();
  const mockMessagesCountTokens = vi.fn();
  const ConstructorSpy = vi.fn();

  class MockAPIUserAbortError extends Error {
    constructor(msg = 'aborted') {
      super(msg);
      this.name = 'APIUserAbortError';
    }
  }

  return {
    mockMessagesCreate,
    mockMessagesParse,
    mockMessagesCountTokens,
    ConstructorSpy,
    MockAPIUserAbortError,
  };
});

const {
  mockMessagesCreate,
  mockMessagesParse,
  mockMessagesCountTokens,
  ConstructorSpy,
  MockAPIUserAbortError,
} = hoisted;

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = {
        create: hoisted.mockMessagesCreate,
        parse: hoisted.mockMessagesParse,
        countTokens: hoisted.mockMessagesCountTokens,
      };
      constructor(args: { apiKey: string }) {
        hoisted.ConstructorSpy(args);
      }
    },
    APIUserAbortError: hoisted.MockAPIUserAbortError,
  };
});

vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  zodOutputFormat: (schema: unknown) => ({ __zod: schema }),
}));

// Import AFTER vi.mock
import { AnthropicAdapter } from './AnthropicAdapter.js';

function makeStorage(...args: [] | [string | undefined]): {
  storage: StorageAdapter;
  getSecretSpy: ReturnType<typeof vi.fn>;
} {
  const resolved = args.length === 0 ? 'sk-ant-fake-test-key-1234567890' : args[0];
  const getSecretSpy = vi.fn();
  getSecretSpy.mockResolvedValue(resolved);
  const storage = {
    getSecret: getSecretSpy,
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  } as unknown as StorageAdapter;
  return { storage, getSecretSpy };
}

const mkOkChat = () => ({
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 5, output_tokens: 3 },
  model: 'claude-sonnet-4-5-20250929',
  stop_reason: 'end_turn',
});

beforeEach(() => {
  mockMessagesCreate.mockReset();
  mockMessagesParse.mockReset();
  mockMessagesCountTokens.mockReset();
  ConstructorSpy.mockReset();
});

describe('AnthropicAdapter — Plan 04-01 happy path', () => {
  it('lazy SecretStorage: construction does NOT call getSecret; first call does; subsequent calls re-use cached client', async () => {
    const { storage, getSecretSpy } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    expect(getSecretSpy).not.toHaveBeenCalled();
    expect(ConstructorSpy).not.toHaveBeenCalled();

    mockMessagesCreate.mockResolvedValue(mkOkChat());
    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(getSecretSpy).toHaveBeenCalledTimes(1);
    expect(getSecretSpy).toHaveBeenCalledWith('sandforge.ai.anthropic.key');
    expect(ConstructorSpy).toHaveBeenCalledTimes(1);

    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(getSecretSpy).toHaveBeenCalledTimes(1); // still 1 — cached
    expect(ConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it('missing API key fast-fails BEFORE any SDK HTTP call', async () => {
    const { storage } = makeStorage(undefined);
    const adapter = new AnthropicAdapter({ storage });
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /API key not configured/,
    );
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('chat: returns text + usage breakdown + model + stopReason', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue(mkOkChat());

    const result = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheCreate: 0,
      total: 8,
    });
    expect(result.model).toBe('claude-sonnet-4-5-20250929');
    expect(result.stopReason).toBe('end_turn');
  });

  it('complete: messages.parse + zodOutputFormat returns Zod-validated payload', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    const schema = z.object({ ok: z.boolean() });
    mockMessagesParse.mockResolvedValue({
      parsed_output: { ok: true },
      usage: { input_tokens: 10, output_tokens: 2 },
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
    });

    const result = await adapter.complete({ prompt: 'x', schema });
    expect(result.payload.ok).toBe(true);
    expect(result.usage.total).toBe(12);
    expect(mockMessagesParse).toHaveBeenCalledWith(
      expect.objectContaining({
        output_config: { format: { __zod: schema } },
        messages: [{ role: 'user', content: 'x' }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('usage breakdown sums all 4 fields including cache tokens (P-04.6)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
      model: 'm',
      stop_reason: 'end_turn',
    });
    const result = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheCreate: 2,
      total: 20,
    });
  });

  it('APIUserAbortError surfaces unwrapped (preserved instance)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    const abortError = new MockAPIUserAbortError();
    mockMessagesCreate.mockRejectedValue(abortError);
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBe(abortError);
  });

  it('SDK errors are re-wrapped with API-key shaped substrings redacted (P-04.7)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockRejectedValue(
      new Error(
        '401 Unauthorized: header authorization=Bearer sk-ant-abc12345678901234567890123456789012345',
      ),
    );
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/\*\*\*REDACTED\*\*\*/);
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.not.toThrow(/sk-ant-abc/);
  });

  it('countTokens: delegates to messages.countTokens and returns inputTokens', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCountTokens.mockResolvedValue({ input_tokens: 1234 });
    const result = await adapter.countTokens({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toEqual({ inputTokens: 1234 });
  });
});

describe('Plan 04-01 vertical slice — services.aiClient().complete() returns Zod-validated DiagnoseResult', () => {
  it('full round-trip from a mocked Anthropic SDK to a typed DiagnoseResult payload', async () => {
    const { DiagnoseResultSchema } = await import('@sandforge/shared');
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    mockMessagesParse.mockResolvedValue({
      parsed_output: {
        summary: 'Bulk job failed: REQUIRED_FIELD_MISSING on Account.Name',
        rootCause: 'CSV row 17 had blank Name; sObject create requires Name.',
        suggestedActions: [
          {
            label: 'Open file at row 17',
            kind: 'open-file',
            payload: 'data.csv:17',
            requiresApproval: false,
          },
        ],
        confidence: 'high',
      },
      usage: { input_tokens: 240, output_tokens: 95 },
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
    });

    const result = await adapter.complete({
      prompt: 'Diagnose this error',
      schema: DiagnoseResultSchema,
    });

    expect(result.payload.summary).toContain('Bulk job failed');
    expect(result.payload.confidence).toBe('high');
    expect(result.payload.suggestedActions).toHaveLength(1);
    expect(result.usage.total).toBe(335);
    expect(result.model).toMatch(/^claude-sonnet/);
  });
});
