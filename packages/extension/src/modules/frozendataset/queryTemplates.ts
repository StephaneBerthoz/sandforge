/**
 * SOQL query templates with `{{TOKEN}}` placeholders: templates committed
 * in configuration contain NO hard-coded IDs; token values
 * (ID lists, date bounds) are injected at execution time from the sas.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SasPathGuard } from './SasPathGuard.js';

/** `{{TOKEN_NAME}}` placeholder pattern. */
const TOKEN_REGEX = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Token names must be UPPER_SNAKE — enforced on injection keys too. */
const TOKEN_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/** Error thrown for unresolved or invalid template tokens. */
export class QueryTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryTemplateError';
  }
}

/**
 * Render a SOQL template by substituting `{{TOKEN}}` placeholders with
 * values loaded from the sas.
 *
 * @throws {QueryTemplateError} When a token name is invalid, a token has
 *         no value, or placeholders remain after substitution.
 */
export function renderQueryTemplate(
  template: string,
  tokens: Readonly<Record<string, string>>,
): string {
  for (const name of Object.keys(tokens)) {
    if (!TOKEN_NAME_REGEX.test(name)) {
      throw new QueryTemplateError(`Invalid token name ${JSON.stringify(name)}`);
    }
  }
  const referenced = new Set<string>();
  for (const match of template.matchAll(TOKEN_REGEX)) {
    referenced.add(match[1]);
  }
  const missing = [...referenced].filter((name) => !(name in tokens));
  if (missing.length > 0) {
    throw new QueryTemplateError(
      `Query template references token(s) without a value: ${missing.join(', ')}. ` +
        `Token values (ID lists, date bounds) must be provided from the sas at execution time.`,
    );
  }
  const rendered = template.replace(TOKEN_REGEX, (_all, name: string) => tokens[name]);
  const leftover = rendered.match(TOKEN_REGEX);
  if (leftover) {
    throw new QueryTemplateError(`Unresolved placeholder(s) after render: ${leftover.join(', ')}`);
  }
  return rendered;
}

/**
 * Load token values from a JSON file in the sas directory
 * (`{"TOKEN_NAME": "value"}`). The path is validated outside the repo —
 * token values carry source-org IDs and must never be read from (nor
 * written to) versioned files.
 */
export function loadTokensFromSas(
  sasDir: string,
  fileName: string,
  guard?: SasPathGuard,
): Record<string, string> {
  const effectiveGuard = guard ?? new SasPathGuard();
  const filePath = effectiveGuard.assertOutsideRepo(path.join(sasDir, fileName));
  const payload: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new QueryTemplateError(`Token file ${filePath} must contain a JSON object`);
  }
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload)) {
    if (!TOKEN_NAME_REGEX.test(name)) {
      throw new QueryTemplateError(`Invalid token name ${JSON.stringify(name)} in ${filePath}`);
    }
    if (typeof value !== 'string') {
      throw new QueryTemplateError(`Token ${name} in ${filePath} must be a string`);
    }
    tokens[name] = value;
  }
  return tokens;
}
