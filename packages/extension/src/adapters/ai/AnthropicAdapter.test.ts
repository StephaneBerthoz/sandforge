import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_CONFIG } from '@sandforge/shared';

import type { StorageAdapter } from '../storage/StorageAdapter.js';

// ── SDK mocks ──────────────────────────────────────────────────────────────
// vi.mock is hoisted; everything it references must be defined inside the
// factory or via vi.hoisted (we use vi.hoisted for the spies so the test
// body can still drive them).
const hoisted = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn();
  const ConstructorSpy = vi.fn();

  class MockAPIUserAbortError extends Error {
    constructor(msg = 'aborted') {
      super(msg);
      this.name = 'APIUserAbortError';
    }
  }

  return {
    mockMessagesCreate,
    ConstructorSpy,
    MockAPIUserAbortError,
  };
});

const { mockMessagesCreate, ConstructorSpy, MockAPIUserAbortError } = hoisted;

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = {
        create: hoisted.mockMessagesCreate,
      };
      constructor(args: { apiKey: string }) {
        hoisted.ConstructorSpy(args);
      }
    },
    APIUserAbortError: hoisted.MockAPIUserAbortError,
  };
});

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
  ConstructorSpy.mockReset();
});

describe('AnthropicAdapter — happy path', () => {
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

  // The breaker counts one failure per chat() call. Left at the SDK default of
  // two retries, each counted failure would be up to three HTTP attempts, so a
  // 529 storm opened the breaker only after nine requests had hit the provider.
  it('builds the SDK client with its own retries turned off', async () => {
    const { storage } = makeStorage('sk-ant-key');
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue(mkOkChat());

    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(ConstructorSpy).toHaveBeenCalledWith({ apiKey: 'sk-ant-key', maxRetries: 0 });
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

  it('usage breakdown sums all 4 fields including cache tokens', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
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
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBe(
      abortError,
    );
  });

  it('SDK errors are re-wrapped with API-key shaped substrings redacted', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockRejectedValue(
      new Error(
        '401 Unauthorized: header authorization=Bearer sk-ant-abc12345678901234567890123456789012345',
      ),
    );
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /\*\*\*REDACTED\*\*\*/,
    );
    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.not.toThrow(
      /sk-ant-abc/,
    );
  });
});

// ── CircuitBreaker + per-request AbortController ──────────────────────────
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

describe('AnthropicAdapter — breaker + abort', () => {
  it('3x 529 trips the breaker; 4th call fast-fails without hitting the SDK', async () => {
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
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toBeTruthy();
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
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toBeTruthy();
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

  it('two concurrent calls share ONE client: one secret read, one SDK construction', async () => {
    // Regression: getClient() had no in-flight dedup, so parallel calls each
    // ran the whole construction — two SecretStorage round-trips, two SDK
    // module loads, two clients, and this.client left holding whichever
    // finished last. Under vitest the second concurrent dynamic import even
    // escaped the module mock and issued a live HTTPS request.
    const { storage, getSecretSpy } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    mockMessagesCreate.mockResolvedValue(mkOkChat());

    const [a, b] = await Promise.all([
      adapter.chat({ messages: [{ role: 'user', content: 'A' }] }),
      adapter.chat({ messages: [{ role: 'user', content: 'B' }] }),
    ]);

    expect(a.text).toBe('hello');
    expect(b.text).toBe('hello');
    expect(getSecretSpy).toHaveBeenCalledTimes(1);
    expect(ConstructorSpy).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('a failed client construction is not cached: the next call retries', async () => {
    const getSecretSpy = vi.fn();
    getSecretSpy.mockRejectedValueOnce(new Error('vault locked'));
    getSecretSpy.mockResolvedValue('sk-ant-fake-test-key-1234567890');
    const storage = {
      getSecret: getSecretSpy,
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } as unknown as StorageAdapter;
    const adapter = new AnthropicAdapter({ storage });

    mockMessagesCreate.mockResolvedValue(mkOkChat());

    await expect(adapter.chat({ messages: [{ role: 'user', content: 'A' }] })).rejects.toThrow();
    const ok = await adapter.chat({ messages: [{ role: 'user', content: 'B' }] });

    expect(ok.text).toBe('hello');
    expect(getSecretSpy).toHaveBeenCalledTimes(2);
  });

  it('aborting one user signal does NOT propagate to a sibling call', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });

    let aResolved = false;
    let bResolved = false;
    const seen: AbortSignal[] = [];
    mockMessagesCreate.mockImplementation((_body, opts) => {
      seen.push(opts.signal as AbortSignal);
      return new Promise((resolve, reject) => {
        const signal = opts.signal as AbortSignal;
        const onAbort = () => reject(new MockAPIUserAbortError('cancelled'));
        // The lazy SDK dynamic import adds an async hop, so the abort may
        // land BEFORE the SDK call starts — the real SDK rejects immediately
        // on an already-aborted signal; mirror that here.
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
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

describe('AnthropicAdapter — breaker lifecycle (3x 529 → open → fast reject → 5min reset)', () => {
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

// ── Token budget end-to-end ───────────────────────────────────────────────
describe('AnthropicAdapter — token budget end-to-end (5 calls → warn → preflight refuse)', () => {
  it('5 cumulative chats hit warn at 80% then 6th preflight refuses BEFORE the SDK call', async () => {
    const { SessionBudget } = await import('./tokenBudget/SessionBudget.js');
    const sentEnvelopes: Array<{ type: string }> = [];
    const notices: string[] = [];
    const broker = {
      send: vi.fn((m: { type: string }) => sentEnvelopes.push({ type: m.type })),
      notify: vi.fn((threshold: string) => notices.push(threshold)),
    };

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

    // the 80% notice was given exactly once, and the 5th call reaching 100% announced the refusal
    expect(notices).toEqual(['warn', 'exceeded']);

    // at least one state envelope per increment
    const stateCount = sentEnvelopes.filter((e) => e.type === 'ai:budget:state').length;
    expect(stateCount).toBeGreaterThanOrEqual(5);

    // 6th call: preflight projects 10k + ~75 (heuristic for "hi") → still < 10k? actually no, 10k already at limit. Increment a stub call to push it over.
    expect(budget.getState().used.total).toBe(10_000);

    // 6th call: preflight blocks because total is already AT 100% — adding ANY input puts it over.
    const callsBefore = mockMessagesCreate.mock.calls.length;
    const refused = adapter.chat({
      messages: [
        {
          role: 'user',
          content: 'this is a longer message that should be predicted at > 0 tokens',
        },
      ],
    });
    await expect(refused).rejects.toThrow(/budget exceeded/i);
    // The way out that needs no reload is named.
    await expect(refused).rejects.toThrow(/run SandForge: Reset AI Token Budget, to continue/);
    expect(mockMessagesCreate.mock.calls.length).toBe(callsBefore); // no SDK invocation
    // the refusal itself is not announced a second time
    expect(notices).toEqual(['warn', 'exceeded']);
  });
});

// ── The request each model is sent ────────────────────────────────────────

/** Ask `model` one question and return the body of the one request it sent. */
async function bodySentTo(model?: string): Promise<Record<string, unknown>> {
  const { storage } = makeStorage();
  const adapter = new AnthropicAdapter({ storage, ...(model ? { model } : {}) });
  mockMessagesCreate.mockResolvedValue(mkOkChat());
  await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
  expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  return mockMessagesCreate.mock.calls[0][0] as Record<string, unknown>;
}

describe('AnthropicAdapter — the request each model is sent', () => {
  // The default was written here, in the shared constant and in the manifest,
  // three strings nothing held together.
  it('asks claude-sonnet-5 when no model is configured, the default the manifest declares', async () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };

    const body = await bodySentTo();

    expect(body.model).toBe('claude-sonnet-5');
    expect(AI_CONFIG.MODEL).toBe('claude-sonnet-5');
    expect(manifest.contributes.configuration.properties['sandforge.ai.model'].default).toBe(
      AI_CONFIG.MODEL,
    );
  });

  it('asks the model it is configured with', async () => {
    expect((await bodySentTo('claude-opus-4-8')).model).toBe('claude-opus-4-8');
  });

  // A cleared sandforge.ai.model reached the API as the model's name, and the
  // 400 that came back named no setting.
  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t '],
  ])('asks the default model when the model it is given is %s', async (_label, model) => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage, model });
    mockMessagesCreate.mockResolvedValue(mkOkChat());

    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    const body = mockMessagesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(body.model).toBe(AI_CONFIG.MODEL);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  // A name pasted with the spaces around it went out as it was, and matched no
  // entry of the models told that thinking is off.
  it('asks a model given with spaces around its name by the name alone, thinking off', async () => {
    const body = await bodySentTo(' claude-sonnet-5 ');

    expect(body.model).toBe('claude-sonnet-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  // Claude Sonnet 5 thinks unless told not to, and its thinking counts against
  // max_tokens: the 4 096 tokens the features ask for could all go to thinking.
  it.each([
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ])('tells %s, which is documented to take it, that thinking is off', async (model) => {
    expect((await bodySentTo(model)).thinking).toEqual({ type: 'disabled' });
  });

  // The first six answer `disabled` with a 400. Claude Opus 5 takes it only
  // below effort xhigh, and a model named after the list was written may think
  // always: a request without the parameter is refused by none of them.
  it.each([
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-5',
    'claude-mythos-preview',
    'claude-opus-5',
    'claude-sonnet-6',
  ])('sends %s no thinking setting at all', async (model) => {
    expect(await bodySentTo(model)).not.toHaveProperty('thinking');
  });

  // Every model from Claude Opus 4.7 on, Claude Sonnet 5 among them, answers a
  // non-default temperature, top_p or top_k with a 400.
  it.each([
    ['the default model', undefined],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
  ])('sends no temperature, top_p or top_k to %s', async (_label, model) => {
    const body = await bodySentTo(model);

    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });
});

// ── An answer that cannot be used ─────────────────────────────────────────

/** A response the API sends back with HTTP 200, 100 tokens spent. */
function answer(stopReason: string, content: Array<Record<string, unknown>>) {
  return {
    content,
    usage: { input_tokens: 40, output_tokens: 60 },
    model: 'claude-sonnet-5',
    stop_reason: stopReason,
  };
}

describe('AnthropicAdapter — an answer that cannot be used', () => {
  // Claude Sonnet 5's safeguards decline with an HTTP 200. The empty text of
  // one was handed on as the answer: an empty chat bubble, kept as the
  // assistant's turn, and a JSON error from every feature that parses one.
  it.each([
    ['no text', []],
    ['the text written before the refusal', [{ type: 'text', text: 'Here are the first' }]],
  ])('rejects an answer the model declined to give, with %s', async (_label, content) => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue(answer('refusal', content));

    const call = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(call).rejects.toThrow(
      'The model declined to answer this request. Rephrase it, or choose another model in sandforge.ai.model.',
    );
    await expect(call).rejects.toMatchObject({
      aiErrorVerdict: { kind: 'refused', shouldTripBreaker: false },
    });
  });

  // Cut off, a JSON reply is not JSON: NL2SOQL and Seed personas then said the
  // model had answered in the wrong format, and a pipeline draft lost every step.
  it.each([
    ['max_tokens', [{ type: 'text', text: '{"soql": "SELECT Id, Name FROM Acc' }]],
    ['max_tokens', [{ type: 'thinking', thinking: '', signature: 'sig' }]],
    ['model_context_window_exceeded', [{ type: 'text', text: '[{"Description": "A long' }]],
  ])(
    'rejects an answer cut off by %s instead of handing on the part that came',
    async (stopReason, content) => {
      const { storage } = makeStorage();
      const adapter = new AnthropicAdapter({ storage });
      mockMessagesCreate.mockResolvedValue(answer(stopReason, content));

      const call = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

      await expect(call).rejects.toThrow(
        'The model stopped at its length limit before the answer was complete, so SandForge did not use it. Ask for less in one request.',
      );
      await expect(call).rejects.toMatchObject({ aiErrorVerdict: { kind: 'truncated' } });
    },
  );

  it.each([
    ['no content block', []],
    ['blank text', [{ type: 'text', text: ' \n ' }]],
    ['only a thinking block', [{ type: 'thinking', thinking: '', signature: 'sig' }]],
  ])('rejects an answer that ended normally with %s', async (_label, content) => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage });
    mockMessagesCreate.mockResolvedValue(answer('end_turn', content));

    const call = adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(call).rejects.toThrow('The model returned an empty answer. Try again.');
    await expect(call).rejects.toMatchObject({ aiErrorVerdict: { kind: 'empty' } });
  });

  it('writes the message in the words the host supplies', async () => {
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({
      storage,
      answerProblemMessage: (problem) => `translated ${problem}`,
    });
    mockMessagesCreate
      .mockResolvedValueOnce(answer('refusal', []))
      .mockResolvedValueOnce(answer('max_tokens', [{ type: 'text', text: '[' }]))
      .mockResolvedValueOnce(answer('end_turn', []));

    const messages: string[] = [];
    for (let i = 0; i < 3; i++) {
      messages.push(
        await adapter
          .chat({ messages: [{ role: 'user', content: 'hi' }] })
          .then(() => 'answered')
          .catch((err: Error) => err.message),
      );
    }

    expect(messages).toEqual(['translated refused', 'translated truncated', 'translated empty']);
  });

  // The provider answered each time: an answer it declined or cut off is no
  // outage, and three in a row must not lock every AI feature out for 5 min.
  it('counts the tokens a rejected answer spent, and keeps the breaker closed', async () => {
    const { SessionBudget } = await import('./tokenBudget/SessionBudget.js');
    const budget = new SessionBudget({ sessionId: 'panel-1', budget: 10_000 });
    const { storage } = makeStorage();
    const adapter = new AnthropicAdapter({ storage, budget });
    mockMessagesCreate.mockResolvedValue(answer('refusal', []));

    for (let i = 0; i < 3; i++) {
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
        /declined/,
      );
    }

    expect(budget.getState().used.total).toBe(300);
    expect(adapter.breaker.getState()).toBe('closed');
    mockMessagesCreate.mockResolvedValue(mkOkChat());
    await expect(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toMatchObject({ text: 'hello' });
  });
});
