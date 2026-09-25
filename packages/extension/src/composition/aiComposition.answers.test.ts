import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('vscode', () => ({
  // The display language the error resolver asks the model to answer in.
  env: { language: 'en' },
  workspace: {
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: sdk.create };
  },
  APIUserAbortError: class APIUserAbortError extends Error {},
}));

import { initAIComposition } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import { createAIClientFactory } from '../adapters/ai/AIClientFactory.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import type { AIAssistant } from '../modules/ai/AIAssistant.js';
import type { AIModules } from '../bridge/handlers/AIHandler.js';

/**
 * The assistant and the model-backed modules as the extension wires them —
 * the real closures, the real modules and the real adapter — over an SDK that
 * answers what each test says.
 */
async function wiredStack(): Promise<{ assistant: AIAssistant; modules: AIModules }> {
  const key = 'sk-ant-fake-test-key-1234567890';
  const handlers = { setAIAssistant: vi.fn(), setAIModules: vi.fn(), setRuleModules: vi.fn() };
  await initAIComposition({
    services: {
      isAIEnabled: () => true,
      getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      aiClient: createAIClientFactory({
        storage: { getSecret: vi.fn(async () => key) } as unknown as StorageAdapter,
        getProvider: () => 'anthropic',
      }),
      telemetry: { getLogger: () => ({}) },
    },
    secretVault: { getSecret: vi.fn(async () => key) },
    handlers,
    broker: { postToWebview: vi.fn() },
    log: vi.fn(),
  } as unknown as AICompositionDeps);
  const assistant = handlers.setAIAssistant.mock.calls.at(-1)?.[0] as AIAssistant | undefined;
  const modules = handlers.setAIModules.mock.calls.at(-1)?.[0] as AIModules | undefined;
  if (!assistant || !modules) throw new Error('the AI stack was not wired');
  return { assistant, modules };
}

/** A response the API sends back with HTTP 200. */
function reply(stopReason: string, text: string) {
  return {
    content: text ? [{ type: 'text', text }] : [],
    usage: { input_tokens: 30, output_tokens: 20 },
    model: 'claude-sonnet-5',
    stop_reason: stopReason,
  };
}

const CUT_OFF = 'The model stopped at its length limit before the answer was complete';

beforeEach(() => {
  sdk.create.mockReset();
});

describe('an answer the model declined, cut off or left empty, as each AI feature meets it', () => {
  it('fails the chat turn, and keeps neither the question nor an empty answer in the conversation', async () => {
    const { assistant } = await wiredStack();
    const conversation = assistant.createConversation('Seed help');
    sdk.create.mockResolvedValue(reply('refusal', ''));

    await expect(assistant.chat(conversation.id, 'how do I seed accounts?')).rejects.toThrow(
      'The model declined to answer this request.',
    );

    expect(assistant.getConversation(conversation.id)?.messages).toEqual([]);
  });

  // The declined question went out again with the next one, and the answer
  // that came back replied to both.
  it('sends the question asked after a declined one on its own', async () => {
    const { assistant } = await wiredStack();
    const conversation = assistant.createConversation('Seed help');
    sdk.create
      .mockResolvedValueOnce(reply('refusal', ''))
      .mockResolvedValueOnce(reply('end_turn', 'Open the Seed page and pick Account.'));

    await expect(assistant.chat(conversation.id, 'the question declined')).rejects.toThrow(
      'The model declined to answer this request.',
    );
    await assistant.chat(conversation.id, 'how do I seed accounts?');

    const [, next] = sdk.create.mock.calls.map(
      ([body]) => (body as { messages: Array<{ role: string; content: string }> }).messages,
    );
    expect(next).toEqual([{ role: 'user', content: 'how do I seed accounts?' }]);
  });

  it('does not show a chat answer cut off at the length limit as the whole answer', async () => {
    const { assistant } = await wiredStack();
    const conversation = assistant.createConversation('Seed help');
    sdk.create.mockResolvedValue(reply('max_tokens', 'Step 1: open the Seed page. Step 2: pick'));

    await expect(assistant.chat(conversation.id, 'walk me through a seed')).rejects.toThrow(
      CUT_OFF,
    );
  });

  // It said "AI response is not a valid JSON object. The AI model returned an
  // unexpected format", which Forge's query draft repeats as well.
  it('says an NL2SOQL draft was cut off, not that the model answered in the wrong format', async () => {
    const { modules } = await wiredStack();
    sdk.create.mockResolvedValue(reply('max_tokens', '{"soql": "SELECT Id, Name FROM Acc'));

    const draft = modules.nl2soql.generateSOQL('all accounts', { objects: [] });

    await expect(draft).rejects.toThrow(CUT_OFF);
  });

  // The draft came back with no step, and the page said the AI had returned a
  // pipeline with nothing to load.
  it('says a pipeline draft was cut off, instead of handing back one with no step', async () => {
    const { modules } = await wiredStack();
    sdk.create.mockResolvedValue(reply('max_tokens', '{"name": "Nightly", "steps": [{"name": "sy'));

    await expect(
      modules.pipelineGenerator.generatePipeline('keep the two orgs aligned', []),
    ).rejects.toThrow(CUT_OFF);
  });

  it('logs a fix suggestion the model declined as declined, not as a reply that is not JSON', async () => {
    const { modules } = await wiredStack();
    sdk.create.mockResolvedValue(reply('refusal', ''));

    await expect(
      modules.errorResolver?.resolveError(
        { errorCode: 'UNLISTED_ERROR', message: 'Something the table does not know' },
        { module: 'sync' },
      ),
    ).rejects.toThrow('The model declined to answer this request.');
  });
});

describe('the last turn of every request', () => {
  // Claude Sonnet 5 answers 400 to a request whose last message is the
  // assistant's. The chat sends the question just asked last, however long the
  // conversation; every other feature sends one user message.
  it('is the user turn, for the chat, NL2SOQL, pipeline drafts and error resolution', async () => {
    const { assistant, modules } = await wiredStack();
    sdk.create.mockResolvedValue(
      reply('end_turn', '{"soql": "SELECT Id FROM Account", "explanation": "", "confidence": 0.9}'),
    );
    const conversation = assistant.createConversation('Seed help');

    for (const question of ['first', 'second', 'third']) {
      await assistant.chat(conversation.id, question);
    }
    await modules.nl2soql.generateSOQL('all accounts', { objects: [] });
    await modules.pipelineGenerator.generatePipeline('keep the two orgs aligned', []);
    await modules.errorResolver?.resolveError(
      { errorCode: 'UNLISTED_ERROR', message: 'Something the table does not know' },
      { module: 'sync' },
    );

    const lastTurns = sdk.create.mock.calls.map(([body]) => {
      const { messages } = body as { messages: Array<{ role: string; content: string }> };
      return messages.at(-1);
    });
    expect(lastTurns.map((turn) => turn?.role)).toEqual([
      'user',
      'user',
      'user',
      'user',
      'user',
      'user',
    ]);
    expect(lastTurns.slice(0, 3).map((turn) => turn?.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
