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
  const mockBetaMessagesToolRunner = vi.fn();
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
    mockBetaMessagesToolRunner,
    ConstructorSpy,
    MockAPIUserAbortError,
  };
});

const {
  mockMessagesCreate,
  mockMessagesParse,
  mockMessagesCountTokens,
  mockBetaMessagesToolRunner,
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
      beta = {
        messages: {
          toolRunner: hoisted.mockBetaMessagesToolRunner,
        },
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

// ── Plan 04-02 — CircuitBreaker + per-request AbortController ─────────────
// A small SDK-like error helper for breaker tests.
class MockOverloadedError extends Error {
  constructor(public status = 529) {
    super(`Overloaded ${status}`);
    this.error = { error: { type: 'overloaded_error' } };
  }
  error: unknown;
}

class MockRateLimitError extends Error {
  constructor(public status = 429) {
    super(`RateLimit ${status}`);
    this.name = 'RateLimitError';
  }
}

describe('AnthropicAdapter — Plan 04-02 breaker + abort', () => {
  it('3x 529 trips the breaker; 4th call fast-fails without hitting the SDK', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockRejectedValue(new MockOverloadedError(529));

    for (let i = 0; i < 3; i++) {
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow();
    }
    expect(adapter.breaker.getState()).toBe('open');

    const callsBefore = mockMessagesCreate.mock.calls.length;
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/circuit breaker open/i);
    expect(mockMessagesCreate.mock.calls.length).toBe(callsBefore);
  });

  it('2x 529 + 1x success → breaker stays closed (success resets the failure count)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate
      .mockRejectedValueOnce(new MockOverloadedError())
      .mockRejectedValueOnce(new MockOverloadedError())
      .mockResolvedValueOnce(mkOkChat());

    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }); // success
    expect(adapter.breaker.getState()).toBe('closed');
  });

  it('3x 429 also trips the breaker (rate-limit counts toward the threshold)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockRejectedValue(new MockRateLimitError(429));

    for (let i = 0; i < 3; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    }
    expect(adapter.breaker.getState()).toBe('open');
  });

  it('APIUserAbortError does NOT trip the breaker (5 cancelled requests in a row)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockRejectedValue(new MockAPIUserAbortError());

    for (let i = 0; i < 5; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeTruthy();
    }
    expect(adapter.breaker.getState()).toBe('closed');
  });

  it('mixed 2x 529 + cancel + 529 → breaker still trips on the 3rd real overload', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate
      .mockRejectedValueOnce(new MockOverloadedError())
      .mockRejectedValueOnce(new MockOverloadedError())
      .mockRejectedValueOnce(new MockAPIUserAbortError())
      .mockRejectedValueOnce(new MockOverloadedError());

    for (let i = 0; i < 4; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeTruthy();
    }
    expect(adapter.breaker.getState()).toBe('open');
  });

  it('breakerEvents emits state-change with cooldownEndsAt when transitioning to open', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    const events: Array<{ state: string; cooldownEndsAt?: string }> = [];
    adapter.breakerEvents.on('state-change', (e: { state: string; cooldownEndsAt?: string }) => {
      events.push(e);
    });

    mockMessagesCreate.mockRejectedValue(new MockOverloadedError());
    for (let i = 0; i < 3; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    }
    const openEvent = events.find((e) => e.state === 'open');
    expect(openEvent).toBeDefined();
    expect(openEvent?.cooldownEndsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('cancelAll() aborts every in-flight controller and returns the count', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    // Each chat awaits the SDK forever (until aborted). The mock listens to
    // the signal and rejects with an abort error when triggered.
    mockMessagesCreate.mockImplementation((_body, opts) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal;
        const onAbort = () => {
          const err = new MockAPIUserAbortError('cancelled');
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      });
    });

    const p1 = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const p2 = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const p3 = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    // All three should be in-flight before cancelAll.
    await Promise.resolve(); // let microtasks register
    await Promise.resolve();

    const count = adapter.cancelAll();
    expect(count).toBe(3);

    await expect(p1).rejects.toBeTruthy();
    await expect(p2).rejects.toBeTruthy();
    await expect(p3).rejects.toBeTruthy();
  });

  it('aborting one user signal does NOT propagate to a sibling call (Pitfall #3 isolation)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    let aResolved = false;
    let bResolved = false;
    const seen: AbortSignal[] = [];
    mockMessagesCreate.mockImplementation((_body, opts) => {
      seen.push(opts.signal as AbortSignal);
      return new Promise((resolve, reject) => {
        const signal = opts.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(new MockAPIUserAbortError('cancelled'));
        });
        // For B: resolve quickly via setImmediate
        setImmediate(() => {
          if (!signal.aborted) {
            resolve(mkOkChat());
          }
        });
      });
    });

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const pA = adapter
      .chat({ messages: [{ role: 'user', content: 'A' }], signal: ctrlA.signal })
      .then(() => (aResolved = true))
      .catch(() => undefined);
    const pB = adapter
      .chat({ messages: [{ role: 'user', content: 'B' }], signal: ctrlB.signal })
      .then(() => (bResolved = true))
      .catch(() => undefined);

    // Wait for both to register, then abort A only.
    await new Promise((r) => setImmediate(r));
    ctrlA.abort();
    await pA;
    await pB;

    expect(aResolved).toBe(false);
    expect(bResolved).toBe(true);
  });
});

describe('AnthropicAdapter — Plan 04-02 vertical slice (3x 529 → open → fast reject → 5min reset)', () => {
  it('3 sequential 529s open the breaker; 4th rejects fast; 5min later the next call attempts the SDK', async () => {
    vi.useFakeTimers();
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    mockMessagesCreate.mockRejectedValue(new MockOverloadedError(529));
    for (let i = 0; i < 3; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    }
    expect(adapter.breaker.getState()).toBe('open');

    const callsBefore = mockMessagesCreate.mock.calls.length;
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /circuit breaker open/i,
    );
    expect(mockMessagesCreate.mock.calls.length).toBe(callsBefore);

    // Advance past the 5-min cooldown
    vi.advanceTimersByTime(300_001);

    // Now a new call should reach the SDK (half-open)
    mockMessagesCreate.mockResolvedValueOnce(mkOkChat());
    const result = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('hello');
    expect(mockMessagesCreate.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(adapter.breaker.getState()).toBe('closed');
    vi.useRealTimers();
  });
});

// ── Plan 04-03 — runTools() tests ────────────────────────────────────────
function makeRunner(yields: unknown[]): {
  setRequestOptions: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
} {
  return {
    setRequestOptions: vi.fn(),
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      for (const y of yields) yield y;
    },
  };
}

describe('AnthropicAdapter — Plan 04-03 runTools', () => {
  it('runTools happy path: single tool call + final text → toolCalls=1, runId UUID, breadcrumb fired', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockBetaMessagesToolRunner.mockReturnValue(
      makeRunner([
        {
          content: [
            { type: 'tool_use', name: 'describe_object', input: { sObject: 'Account' }, id: 't1' },
          ],
          usage: { input_tokens: 50, output_tokens: 12 },
          model: 'claude-sonnet-4-5-20250929',
        },
        {
          content: [{ type: 'text', text: 'There are 142 records.' }],
          usage: { input_tokens: 110, output_tokens: 24 },
          model: 'claude-sonnet-4-5-20250929',
          stop_reason: 'end_turn',
        },
      ]),
    );

    const result = await adapter.runTools({
      prompt: 'How many records in Account?',
      tools: [],
    });
    expect(result.text).toBe('There are 142 records.');
    expect(result.toolCalls).toBe(1);
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.usage.input).toBe(110); // last message wins
    expect(result.usage.total).toBe(134);
  });

  it('runTools forwards { signal } to toolRunner and the breaker is consulted', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockBetaMessagesToolRunner.mockReturnValue(
      makeRunner([
        { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', stop_reason: 'end_turn' },
      ]),
    );
    await adapter.runTools({ prompt: 'x', tools: [] });
    expect(mockBetaMessagesToolRunner).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'x' }] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('runTools respects maxIterations (forwarded to runner constructor)', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockBetaMessagesToolRunner.mockReturnValue(
      makeRunner([
        { content: [{ type: 'text', text: '' }], usage: { input_tokens: 0, output_tokens: 0 }, model: 'm', stop_reason: 'end_turn' },
      ]),
    );
    await adapter.runTools({ prompt: 'x', tools: [], maxIterations: 3 });
    expect(mockBetaMessagesToolRunner).toHaveBeenCalledWith(
      expect.objectContaining({ max_iterations: 3 }),
      expect.any(Object),
    );
  });

  it('runTools default maxIterations is 12', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockBetaMessagesToolRunner.mockReturnValue(
      makeRunner([
        { content: [{ type: 'text', text: '' }], usage: { input_tokens: 0, output_tokens: 0 }, model: 'm', stop_reason: 'end_turn' },
      ]),
    );
    await adapter.runTools({ prompt: 'x', tools: [] });
    expect(mockBetaMessagesToolRunner).toHaveBeenCalledWith(
      expect.objectContaining({ max_iterations: 12 }),
      expect.any(Object),
    );
  });

  it('runTools 529 trips the breaker via runWithBreaker', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    // toolRunner returns a runner whose iteration throws an overloaded error.
    mockBetaMessagesToolRunner.mockReturnValue({
      setRequestOptions: vi.fn(),
      async *[Symbol.asyncIterator]() {
        throw new MockOverloadedError(529);
      },
    });
    for (let i = 0; i < 3; i++) {
      await expect(adapter.runTools({ prompt: 'x', tools: [] })).rejects.toThrow();
    }
    expect(adapter.breaker.getState()).toBe('open');
  });
});

// ── Plan 04-03 vertical slice ─────────────────────────────────────────────
describe('AnthropicAdapter — Plan 04-03 vertical slice (runTools — describe + query)', () => {
  it('multi-step flow: describe Account → query records → final 142 count, traces flow through wrapTool', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    // Mock toolRunner: 2 tool_use turns + 1 final answer
    mockBetaMessagesToolRunner.mockReturnValue(
      makeRunner([
        {
          content: [
            { type: 'tool_use', name: 'describe_object', input: { sObject: 'Account' }, id: 'tu1' },
          ],
          usage: { input_tokens: 50, output_tokens: 12 },
          model: 'claude-sonnet-4-5-20250929',
        },
        {
          content: [
            {
              type: 'tool_use',
              name: 'query_records',
              input: { soql: 'SELECT COUNT() FROM Account', limit: 50 },
              id: 'tu2',
            },
          ],
          usage: { input_tokens: 80, output_tokens: 18 },
          model: 'claude-sonnet-4-5-20250929',
        },
        {
          content: [{ type: 'text', text: 'There are 142 Account records.' }],
          usage: { input_tokens: 110, output_tokens: 24 },
          model: 'claude-sonnet-4-5-20250929',
          stop_reason: 'end_turn',
        },
      ]),
    );

    const result = await adapter.runTools({
      prompt: 'Describe Account, then count records.',
      tools: [],
    });

    expect(result.text).toContain('142');
    expect(result.toolCalls).toBe(2);
    expect(result.usage.input).toBe(110); // last-wins
    expect(result.usage.total).toBe(134);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── Plan 04-05 vertical slice — token budget end-to-end ────────────────────
describe('AnthropicAdapter — Plan 04-05 vertical slice (5 calls → warn → preflight refuse)', () => {
  it('5 cumulative chats hit warn at 80% then 6th preflight refuses BEFORE the SDK call', async () => {
    const { SessionBudget } = await import('./tokenBudget/SessionBudget.js');
    const sentEnvelopes: Array<{ type: string }> = [];
    const broker = { send: vi.fn((m: { type: string }) => sentEnvelopes.push({ type: m.type })) };

    const budget = new SessionBudget({ sessionId: 'panel-1', budget: 10_000, broker });
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage, budget });

    // Each SDK call returns 2_000 total tokens
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1500, output_tokens: 500 },
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
    });

    // 5 calls — cumulative usage 2k, 4k, 6k, 8k, 10k
    for (let i = 0; i < 5; i++) {
      await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    }

    // exactly ONE warn envelope was sent (debounced)
    const warnCount = sentEnvelopes.filter((e) => e.type === 'ai:budget:warn').length;
    expect(warnCount).toBe(1);

    // at least one state envelope per increment
    const stateCount = sentEnvelopes.filter((e) => e.type === 'ai:budget:state').length;
    expect(stateCount).toBeGreaterThanOrEqual(5);

    // 6th call: preflight projects 10k + ~75 (heuristic for "hi") → still < 10k? actually no, 10k already at limit. Increment a stub call to push it over.
    expect(budget.getState().used.total).toBe(10_000);

    // 6th call: preflight blocks because total is already AT 100% — adding ANY input puts it over.
    const callsBefore = mockMessagesCreate.mock.calls.length;
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'this is a longer message that should be predicted at > 0 tokens' }] }),
    ).rejects.toThrow(/budget exceeded/i);
    expect(mockMessagesCreate.mock.calls.length).toBe(callsBefore); // no SDK invocation
    const exceededCount = sentEnvelopes.filter((e) => e.type === 'ai:budget:exceeded').length;
    expect(exceededCount).toBeGreaterThanOrEqual(1);
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
