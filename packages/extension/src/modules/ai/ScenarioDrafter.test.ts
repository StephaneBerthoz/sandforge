import { describe, it, expect, vi } from 'vitest';
import {
  RETAIL_ORDERS_PACK,
  ScenarioPackDraftSchema,
  type ScenarioPack,
  type ScenarioPackDraft,
} from '@sandforge/shared';

import {
  SCENARIO_PLAN_SYSTEM_PROMPT,
  SCENARIO_TOPIC_SYSTEM_PROMPT,
} from '../../adapters/ai/systemPrompts/index.js';
import { compileScenario, ScenarioCompileError } from '../seed/scenario/compileScenario.js';
import { ScenarioDrafter, maskScenarioText, type ScenarioDraftOutcome } from './ScenarioDrafter.js';
import type { AIProviderOptions } from './types.js';

const PACK = RETAIL_ORDERS_PACK;
const KEYS = PACK.topics.map((topic) => topic.key);

/** The plan the first call answers with: the pack less its topics' articles and cases. */
function planReply(pack: ScenarioPack = PACK): Record<string, unknown> {
  return {
    id: pack.id,
    name: pack.name,
    businessContext: pack.businessContext,
    customers: pack.customers,
    topics: pack.topics.map(({ key, label, utterances }) => ({ key, label, utterances })),
    decoy: pack.decoy,
    outOfScope: pack.outOfScope,
  };
}

/** What the call for a topic answers with: its article and its cases. */
function topicReply(key: string, pack: ScenarioPack = PACK): Record<string, unknown> {
  const topic = pack.topics.find((t) => t.key === key);
  if (!topic) throw new Error(`no topic ${key}`);
  return { article: topic.article, caseTemplates: topic.caseTemplates };
}

/** The topic a call is for, as its prompt names it. */
function topicAskedFor(prompt: string): string | undefined {
  return /<user-data label="topic">\{"key":"([^"]+)"/.exec(prompt)?.[1];
}

interface Call {
  prompt: string;
  system: string | undefined;
  signal: AbortSignal | undefined;
}

/**
 * A model that answers each call as `answer` says, by the topic the call is
 * for (`undefined` for the plan), and keeps every call it was asked.
 */
function model(
  answer: (topic: string | undefined, call: Call) => Promise<string> | string = (topic) =>
    JSON.stringify(topic === undefined ? planReply() : topicReply(topic)),
) {
  const calls: Call[] = [];
  const provider = vi.fn(
    async (prompt: string, system?: string, options?: AIProviderOptions): Promise<string> => {
      const call = { prompt, system, signal: options?.signal };
      calls.push(call);
      return answer(topicAskedFor(prompt), call);
    },
  );
  return { provider, calls };
}

/** A call that answers only once its signal aborts, by rejecting, as the SDK does. */
function untilStopped(call: Call): Promise<string> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
  });
}

const REQUEST = {
  text: 'An online shop selling home goods across Europe. Customers write about parcels.',
  language: 'en_US',
};

function expectKind<K extends ScenarioDraftOutcome['kind']>(
  outcome: ScenarioDraftOutcome,
  kind: K,
): Extract<ScenarioDraftOutcome, { kind: K }> {
  expect(outcome.kind).toBe(kind);
  return outcome as Extract<ScenarioDraftOutcome, { kind: K }>;
}

describe('ScenarioDrafter', () => {
  describe('the calls a pack is drafted in', () => {
    it('plans the pack in one call, then writes each topic in a call of its own, in the plan order', async () => {
      const { provider, calls } = model();

      const outcome = await new ScenarioDrafter(provider).draft(REQUEST);

      expect(calls.map((call) => call.system)).toEqual([
        SCENARIO_PLAN_SYSTEM_PROMPT,
        ...KEYS.map(() => SCENARIO_TOPIC_SYSTEM_PROMPT),
      ]);
      expect(calls.map((call) => topicAskedFor(call.prompt))).toEqual([undefined, ...KEYS]);
      const { pack } = expectKind(outcome, 'complete');
      expect(pack).toEqual(PACK);
    });

    it('gives back a pack that compiles, in the language the user chose', async () => {
      const { provider } = model();

      const outcome = await new ScenarioDrafter(provider).draft({ ...REQUEST, language: 'fr' });

      const { pack } = expectKind(outcome, 'complete');
      expect(pack.language).toBe('fr');
      expect(() => compileScenario(pack)).not.toThrow();
      expect(provider.mock.calls[0][0]).toContain('whose Salesforce code is fr.');
    });

    it('tells each topic call the titles the other articles already took', async () => {
      const { provider, calls } = model();

      await new ScenarioDrafter(provider).draft(REQUEST);

      const third = calls[3].prompt;
      expect(third).toContain(PACK.decoy.title);
      expect(third).toContain(PACK.topics[0].article.title);
      expect(third).toContain(PACK.topics[1].article.title);
      expect(third).not.toContain(PACK.topics[2].article.title);
    });
  });

  describe('what is sent', () => {
    const TYPED =
      'Customers call us on +33 6 12 34 56 78 or (415) 867-5309 and write to jane.doe@gmail.com about their parcels.';

    it('sends the scenario with its addresses and numbers rewritten, and says it as it was sent', async () => {
      const { provider, calls } = model();

      const outcome = await new ScenarioDrafter(provider).draft({ ...REQUEST, text: TYPED });

      expect(outcome.sentText).toBe(maskScenarioText(TYPED));
      expect(outcome.sentText).toContain('jane.doe@gmail.example');
      expect(calls).toHaveLength(1 + KEYS.length);
      for (const { prompt } of calls) {
        expect(prompt).not.toContain('gmail.com');
        expect(prompt).not.toContain('6 12 34 56 78');
        expect(prompt).not.toContain('867-5309');
        expect(prompt).toContain(outcome.sentText);
      }
    });

    it('rewrites a number the same way wherever it is, and leaves a text it rewrote as it is', () => {
      const once = maskScenarioText('Call +33 6 12 34 56 78. Again: +33 6 12 34 56 78.');

      const [first, second] = once.match(/\+33[\d ]+\d/g) ?? [];
      expect(first).toBeDefined();
      expect(first).not.toBe('+33 6 12 34 56 78');
      expect(second).toBe(first);
      expect(maskScenarioText(once)).toBe(once);
    });

    it('sends of the agent only the names, labels and descriptions of its topics and actions', async () => {
      const { provider, calls } = model();
      // The shape the agent catalog reads an agent in, ids and variables included.
      const agent = {
        id: '0Xx000000000001AAA',
        name: 'Store_Service_Agent',
        label: 'Store service agent',
        unnamedTopics: 0,
        variables: [{ name: 'VerifiedCustomerId', parameterName: 'customerRecordId' }],
        topics: [
          {
            name: 'Order_Tracking',
            localName: 'Order_Tracking_16jXX0000004CQb',
            label: 'Order tracking',
            description: 'Finds where an order is.',
            described: true,
            unnamedActions: 0,
            actions: [
              {
                name: 'Get_Order_Status',
                localName: 'Get_Order_Status_179XX0000004DLf',
                label: 'Get order status',
                description: 'Looks the order up by its number.',
                described: true,
              },
            ],
          },
        ],
      };

      await new ScenarioDrafter(provider).draft({ ...REQUEST, agent });

      const plan = calls[0].prompt;
      const block = /<user-data label="agent-topics">([^<]*)<\/user-data>/.exec(plan)?.[1];
      expect(JSON.parse(block ?? 'null')).toEqual([
        {
          name: 'Order_Tracking',
          label: 'Order tracking',
          description: 'Finds where an order is.',
          actions: [
            {
              name: 'Get_Order_Status',
              label: 'Get order status',
              description: 'Looks the order up by its number.',
            },
          ],
        },
      ]);
      for (const { prompt } of calls) {
        for (const unsent of [
          '0Xx000000000001AAA',
          'Store_Service_Agent',
          'VerifiedCustomerId',
          'customerRecordId',
          '16jXX0000004CQb',
          '179XX0000004DLf',
        ]) {
          expect(prompt).not.toContain(unsent);
        }
      }
      // The agent's topics are what the plan aligns its own with; the topics
      // written afterwards are not told them again.
      expect(calls.slice(1).some(({ prompt }) => prompt.includes('Order_Tracking'))).toBe(false);
    });

    it('carries nothing but the scenario, the plan, the titles, the picklists and the agent', async () => {
      const { provider, calls } = model();

      await new ScenarioDrafter(provider).draft({
        ...REQUEST,
        casePicklists: { Status: ['New', 'Working', 'Closed'], Origin: ['Web'], Type: [] },
        agent: { topics: [{ name: 'Delivery', actions: [] }] },
      });

      const labels = calls.flatMap(({ prompt }) =>
        [...prompt.matchAll(/<user-data label="([^"]+)">/g)].map((match) => match[1]),
      );
      expect(new Set(labels)).toEqual(
        new Set(['scenario', 'case-picklists', 'agent-topics', 'plan', 'topic', 'article-titles']),
      );
      const picklists = /<user-data label="case-picklists">([^<]*)<\/user-data>/.exec(
        calls[1].prompt,
      )?.[1];
      expect(JSON.parse(picklists ?? 'null')).toEqual({
        Status: ['New', 'Working', 'Closed'],
        Origin: ['Web'],
      });
    });

    it('names the first fifty values of a picklist, not a thousand', async () => {
      const { provider, calls } = model();
      const types = Array.from({ length: 1_000 }, (_, i) => `Type ${i}`);

      await new ScenarioDrafter(provider).draft({ ...REQUEST, casePicklists: { Type: types } });

      expect(calls[0].prompt).toContain('"Type 49"');
      expect(calls[0].prompt).not.toContain('"Type 50"');
    });
  });

  describe('a reply that does not fit the pack', () => {
    it('refuses a topic whose fact the article does not state, naming the field, and keeps the topics before it', async () => {
      const { provider, calls } = model((topic) => {
        if (topic === undefined) return JSON.stringify(planReply());
        const reply = topicReply(topic) as { article: { facts: string[] } };
        if (topic === KEYS[1]) {
          reply.article = {
            ...reply.article,
            facts: [
              'Refunds take a year.',
              reply.article.facts[1],
              'Parcels are refunded by carrier pigeon.',
            ],
          };
        }
        return JSON.stringify(reply);
      });

      const outcome = await new ScenarioDrafter(provider).draft(REQUEST);

      const failed = expectKind(outcome, 'failed');
      expect(failed.failedAt).toEqual({ call: 'topic', topicKey: KEYS[1] });
      expect(failed.error).toMatch(/^The AI reply is JSON, but not in the expected format: /);
      expect(failed.error).toContain('article.facts[0]: The fact "Refunds take a year."');
      expect(failed.issues).toEqual([
        expect.stringMatching(/^article\.facts\[0\]: /),
        expect.stringMatching(/^article\.facts\[2\]: /),
      ]);
      expect(failed.draft?.topics[0].article).toEqual(PACK.topics[0].article);
      expect(failed.draft?.topics[1].article).toBeUndefined();
      expect(calls).toHaveLength(3);
    });

    it('refuses a plan that leaves out what no topic covers, before any topic is asked for', async () => {
      const { provider } = model((topic) => {
        const plan = planReply();
        delete plan.outOfScope;
        return JSON.stringify(topic === undefined ? plan : topicReply(topic));
      });

      const outcome = await new ScenarioDrafter(provider).draft(REQUEST);

      const failed = expectKind(outcome, 'failed');
      expect(failed.failedAt).toEqual({ call: 'plan' });
      expect(failed.issues).toEqual([expect.stringMatching(/^outOfScope: /)]);
      expect(failed.draft).toBeUndefined();
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it('refuses a plan whose decoy resembles a topic it does not have', async () => {
      const { provider } = model(() =>
        JSON.stringify({ ...planReply(), decoy: { ...PACK.decoy, resembles: 'nothing-planned' } }),
      );

      const failed = expectKind(await new ScenarioDrafter(provider).draft(REQUEST), 'failed');

      expect(failed.issues).toEqual([
        expect.stringMatching(/^decoy\.resembles: The decoy resembles the topic "nothing-planned"/),
      ]);
    });

    it('refuses a pack whose written topics took one title twice, with the draft to correct', async () => {
      const { provider } = model((topic) => {
        if (topic === undefined) return JSON.stringify(planReply());
        const reply = topicReply(topic) as { article: { title: string } };
        if (topic === KEYS[2])
          reply.article = { ...reply.article, title: PACK.topics[0].article.title };
        return JSON.stringify(reply);
      });

      const failed = expectKind(await new ScenarioDrafter(provider).draft(REQUEST), 'failed');

      expect(failed.failedAt).toEqual({ call: 'pack' });
      expect(failed.issues).toEqual([expect.stringMatching(/^topics\[2\]\.article\.title: /)]);
      expect(failed.draft?.topics.every((topic) => topic.article !== undefined)).toBe(true);
    });

    it('makes an address or a number a reply wrote reach nobody', async () => {
      const { provider } = model((topic) => {
        if (topic === undefined) return JSON.stringify(planReply());
        const reply = topicReply(topic) as { article: { body: string } };
        if (topic === KEYS[0]) {
          reply.article = {
            ...reply.article,
            body: `${reply.article.body}\n\nWrite to help@homegoods.com or call (415) 867-5309.`,
          };
        }
        return JSON.stringify(reply);
      });

      const { pack } = expectKind(await new ScenarioDrafter(provider).draft(REQUEST), 'complete');

      const body = pack.topics[0].article.body;
      expect(body).toContain('help@homegoods.example');
      expect(body).not.toContain('867-5309');
    });
  });

  describe('a call that fails', () => {
    // The adapter's own words (AnthropicAdapter), which the draft passes on as they are.
    const CUT_OFF =
      'The model stopped at its length limit before the answer was complete, so SandForge did not use it. Ask for less in one request.';
    const DECLINED =
      'The model declined to answer this request. Rephrase it, or choose another model in sandforge.ai.model.';

    it.each([
      ['a reply cut off at its length limit', CUT_OFF],
      ['a declined request', DECLINED],
      [
        'the token budget',
        'AI token budget exceeded for this session (199000/200000 tokens used). Raise sandforge.ai.tokenBudgetMaxPerSession in Settings, or run SandForge: Reset AI Token Budget, to continue.',
      ],
    ])(
      'says %s in the words the provider failed with, and writes nothing in its place',
      async (_, said) => {
        const { provider, calls } = model((topic) => {
          if (topic === KEYS[2]) throw new Error(said);
          return JSON.stringify(topic === undefined ? planReply() : topicReply(topic));
        });

        const outcome = await new ScenarioDrafter(provider).draft(REQUEST);

        const failed = expectKind(outcome, 'failed');
        expect(failed.error).toBe(said);
        expect(failed.failedAt).toEqual({ call: 'topic', topicKey: KEYS[2] });
        expect(failed.draft?.topics.map((topic) => topic.article !== undefined)).toEqual([
          true,
          true,
          false,
          false,
          false,
        ]);
        expect(failed.draft?.topics[2].caseTemplates).toBeUndefined();
        expect(calls).toHaveLength(4);
      },
    );

    it('gives back no draft at all when the plan itself failed', async () => {
      const { provider } = model(() => {
        throw new Error(DECLINED);
      });

      const failed = expectKind(await new ScenarioDrafter(provider).draft(REQUEST), 'failed');

      expect(failed).toEqual({
        kind: 'failed',
        sentText: REQUEST.text,
        error: DECLINED,
        failedAt: { call: 'plan' },
      });
    });
  });

  describe('the Stop', () => {
    it('aborts the call in flight, starts none after it, and keeps the topics written before', async () => {
      const controller = new AbortController();
      const { provider, calls } = model((topic, call) => {
        if (topic === KEYS[1]) {
          queueMicrotask(() => controller.abort());
          return untilStopped(call);
        }
        return JSON.stringify(topic === undefined ? planReply() : topicReply(topic));
      });

      const outcome = await new ScenarioDrafter(provider).draft(REQUEST, {
        signal: controller.signal,
      });

      const stopped = expectKind(outcome, 'stopped');
      expect(calls.map((call) => topicAskedFor(call.prompt))).toEqual([
        undefined,
        KEYS[0],
        KEYS[1],
      ]);
      expect(calls[2].signal?.aborted).toBe(true);
      expect(stopped.draft?.topics[0].article).toEqual(PACK.topics[0].article);
      expect(stopped.draft?.topics.slice(1).map((topic) => topic.article)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('leaves a draft that can be handed back but never compiled for writing', async () => {
      const controller = new AbortController();
      const { provider } = model((topic, call) => {
        if (topic === KEYS[3]) {
          queueMicrotask(() => controller.abort());
          return untilStopped(call);
        }
        return JSON.stringify(topic === undefined ? planReply() : topicReply(topic));
      });

      const { draft } = expectKind(
        await new ScenarioDrafter(provider).draft(REQUEST, { signal: controller.signal }),
        'stopped',
      );

      expect(ScenarioPackDraftSchema.safeParse(draft).success).toBe(true);
      let refused: unknown;
      try {
        compileScenario(draft as unknown as ScenarioPack);
      } catch (err) {
        refused = err;
      }
      expect(refused).toBeInstanceOf(ScenarioCompileError);
      expect((refused as ScenarioCompileError).issues).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pack\.topics\[3\]\.article: /),
          expect.stringMatching(/^pack\.topics\[4\]\.caseTemplates: /),
        ]),
      );
    });

    it('stopped during the plan, asks nothing more and has no draft to give', async () => {
      const controller = new AbortController();
      const { provider } = model((_topic, call) => {
        queueMicrotask(() => controller.abort());
        return untilStopped(call);
      });

      const outcome = await new ScenarioDrafter(provider).draft(REQUEST, {
        signal: controller.signal,
      });

      expect(outcome).toEqual({ kind: 'stopped', sentText: REQUEST.text });
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it('applies no reply that came after the Stop', async () => {
      const controller = new AbortController();
      const { provider, calls } = model((topic) => {
        // A provider that does not hear the signal and answers all the same.
        if (topic === KEYS[0]) controller.abort();
        return JSON.stringify(topic === undefined ? planReply() : topicReply(topic));
      });

      const { draft } = expectKind(
        await new ScenarioDrafter(provider).draft(REQUEST, { signal: controller.signal }),
        'stopped',
      );

      expect(calls).toHaveLength(2);
      expect(draft?.topics.every((topic) => topic.article === undefined)).toBe(true);
    });
  });

  describe('going on with a draft', () => {
    /** The pack drafted as far as its first `written` topics. */
    function draftedTo(written: number): ScenarioPackDraft {
      return {
        version: 1,
        id: PACK.id,
        name: PACK.name,
        language: PACK.language,
        businessContext: PACK.businessContext,
        customers: PACK.customers,
        topics: PACK.topics.map((topic, index) =>
          index < written
            ? topic
            : { key: topic.key, label: topic.label, utterances: topic.utterances },
        ),
        decoy: PACK.decoy,
        outOfScope: PACK.outOfScope,
      };
    }

    it('asks for no plan and writes only the topics the draft lacks', async () => {
      const { provider, calls } = model();

      const outcome = await new ScenarioDrafter(provider).draft({ ...REQUEST, from: draftedTo(2) });

      expect(calls.map((call) => topicAskedFor(call.prompt))).toEqual(KEYS.slice(2));
      expect(expectKind(outcome, 'complete').pack).toEqual(PACK);
    });

    it('keeps the language of the draft it goes on with', async () => {
      const { provider, calls } = model();

      await new ScenarioDrafter(provider).draft({
        ...REQUEST,
        language: 'de',
        from: draftedTo(4),
      });

      expect(calls[0].prompt).toContain('whose Salesforce code is en_US.');
    });

    it('rewrites an address the user typed into the draft before it is sent again', async () => {
      const { provider, calls } = model();
      const from = draftedTo(1);
      from.businessContext = 'Write to the owner at owner@realshop.com about anything.';

      await new ScenarioDrafter(provider).draft({ ...REQUEST, from });

      expect(calls[0].prompt).toContain('owner@realshop.example');
      expect(calls[0].prompt).not.toContain('owner@realshop.com');
    });
  });
});
