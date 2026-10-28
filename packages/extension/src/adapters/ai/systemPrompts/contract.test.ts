import { describe, it, expect } from 'vitest';
import {
  ErrorResolutionReplySchema,
  NL2SOQLReplySchema,
  ScenarioPackReplySchema,
  scenarioArticleSchema,
  scenarioCaseTemplateSchema,
  scenarioCustomersSchema,
  scenarioDecoyArticleSchema,
  scenarioUtteranceSchema,
} from '@sandforge/shared';

import {
  ERROR_RESOLVE_SYSTEM_PROMPT,
  NL2SOQL_SYSTEM_PROMPT,
  SCENARIO_PLAN_SYSTEM_PROMPT,
  SCENARIO_TOPIC_SYSTEM_PROMPT,
} from './index.js';

/**
 * A system prompt has to describe the task its caller performs and the output
 * its caller parses.
 *
 * NL2SOQL was briefly wired to a prompt written for reviewing a SOQL query the
 * user had pasted. NL2SOQL's payload is a natural-language request, so the
 * prompt's own "refuse if it is not SOQL" clause fired on every legitimate
 * call, and the system turn asked for review fields while the user turn asked
 * for `{soql, explanation, confidence, alternatives}` — the only shape the
 * parser reads. Every existing test passed: they checked that a system prompt
 * was on the wire, never that it was the right one.
 *
 * These assertions are deliberately about field names rather than wording.
 * Wording is a prompt-engineering decision; the contract is not.
 */

describe('system prompt contracts', () => {
  it('every prompt carries the untrusted-data clause', () => {
    // Two independent defences: escapeUserData wraps the payload, this clause
    // tells the model what the wrapper means. Neither replaces the other.
    for (const prompt of [
      NL2SOQL_SYSTEM_PROMPT,
      ERROR_RESOLVE_SYSTEM_PROMPT,
      SCENARIO_PLAN_SYSTEM_PROMPT,
      SCENARIO_TOPIC_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toMatch(/UNTRUSTED/);
      expect(prompt).toMatch(/strictly as DATA/);
    }
  });

  it('the NL2SOQL prompt asks for the fields NL2SOQL parses', () => {
    // NL2SOQL reads its reply through this schema, so its keys are the parsed ones.
    const keys = new Set(Object.keys(NL2SOQLReplySchema.shape));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        NL2SOQL_SYSTEM_PROMPT,
        `NL2SOQL parses "${key}" but the prompt never names it`,
      ).toContain(key);
    }
  });

  it('the ErrorResolver prompt asks for the fields ErrorResolver parses', () => {
    // ErrorResolver reads its reply through this schema, so its keys are the parsed ones.
    const keys = new Set(Object.keys(ErrorResolutionReplySchema.shape));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        ERROR_RESOLVE_SYSTEM_PROMPT,
        `ErrorResolver parses "${key}" but the prompt never names it`,
      ).toContain(key);
    }
  });

  // The pack is read through these schemas, a field at every level strict:
  // a field the prompt never names is one the model has to guess, and a
  // guess spelt otherwise refuses the whole reply.
  it('the scenario plan prompt asks for every field the plan is read with', () => {
    const keys = new Set([
      ...Object.keys(ScenarioPackReplySchema.plan.shape),
      ...Object.keys(scenarioCustomersSchema.shape),
      'key',
      'label',
      'utterances',
      ...Object.keys(scenarioUtteranceSchema.shape),
      ...Object.keys(scenarioDecoyArticleSchema.shape),
    ]);
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) {
      expect(
        SCENARIO_PLAN_SYSTEM_PROMPT,
        `the plan is read with "${key}" but the prompt never names it`,
      ).toContain(key);
    }
  });

  it('the scenario topic prompt asks for every field a topic is read with', () => {
    const keys = new Set([
      ...Object.keys(ScenarioPackReplySchema.topic.shape),
      ...Object.keys(scenarioArticleSchema.shape),
      ...Object.keys(scenarioCaseTemplateSchema.shape),
    ]);
    expect(keys.size).toBeGreaterThan(8);
    for (const key of keys) {
      expect(
        SCENARIO_TOPIC_SYSTEM_PROMPT,
        `a topic is read with "${key}" but the prompt never names it`,
      ).toContain(key);
    }
  });

  it('the NL2SOQL prompt describes generating a query, not reviewing one', () => {
    // The failure mode this guards is specific: a prompt whose refusal clause
    // is keyed to the payload being SOQL, attached to a caller whose payload is
    // never SOQL.
    expect(NL2SOQL_SYSTEM_PROMPT).not.toMatch(/The SOQL inside <user-data>/);
    expect(NL2SOQL_SYSTEM_PROMPT).toMatch(/natural-language/i);
  });
});
