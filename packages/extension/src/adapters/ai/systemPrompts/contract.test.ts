import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  DIAGNOSE_SYSTEM_PROMPT,
  ERROR_RESOLVE_SYSTEM_PROMPT,
  NL2SOQL_SYSTEM_PROMPT,
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

const MODULES = join(__dirname, '..', '..', '..', 'modules', 'ai');

/** The keys a module's parser reads off the model's JSON reply. */
function parsedKeys(file: string): string[] {
  const src = readFileSync(join(MODULES, file), 'utf8');
  return Array.from(src.matchAll(/obj\['([A-Za-z0-9_]+)'\]/g)).map((m) => m[1]);
}

describe('system prompt contracts', () => {
  it('every prompt carries the untrusted-data clause', () => {
    // Two independent defences: escapeUserData wraps the payload, this clause
    // tells the model what the wrapper means. Neither replaces the other.
    for (const prompt of [
      DIAGNOSE_SYSTEM_PROMPT,
      NL2SOQL_SYSTEM_PROMPT,
      ERROR_RESOLVE_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toMatch(/UNTRUSTED/);
      expect(prompt).toMatch(/strictly as DATA/);
    }
  });

  it('the NL2SOQL prompt asks for the fields NL2SOQL parses', () => {
    const keys = new Set(parsedKeys('NL2SOQL.ts'));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        NL2SOQL_SYSTEM_PROMPT,
        `NL2SOQL parses "${key}" but the prompt never names it`,
      ).toContain(key);
    }
  });

  it('the ErrorResolver prompt asks for the fields ErrorResolver parses', () => {
    const keys = new Set(parsedKeys('ErrorResolver.ts'));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        ERROR_RESOLVE_SYSTEM_PROMPT,
        `ErrorResolver parses "${key}" but the prompt never names it`,
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
