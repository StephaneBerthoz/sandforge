/**
 * Translates raw Salesforce API error messages from ForgeExecutionError
 * samples into a structured pair of i18n keys plus optional interpolation
 * variables. The wizard component is responsible for resolving the keys
 * via `t()` so locale changes don't require touching the translator.
 *
 * Returns `null` when no rule matches — the caller falls back to the raw
 * message in that case.
 */

/** Structured translation result, ready to feed into i18next `t()`. */
export interface TranslatedError {
  /** STATUS_CODE detected (or a SandForge-specific synthetic code). */
  code: string;
  /** i18n key for the human-readable explanation. */
  explanationKey: string;
  /** i18n key for the suggested next step. */
  actionKey: string;
  /** Optional interpolation variables for the explanation key. */
  vars?: Record<string, string | number>;
  /** Severity hint for the UI badge. */
  severity: 'info' | 'warning' | 'error';
}

interface Rule {
  /** Pattern matched against the raw message. */
  match: RegExp;
  build: (raw: string, captures: RegExpMatchArray) => TranslatedError;
}

const KEY = (code: string, leaf: 'explanation' | 'action'): string => `forge.error.${code}.${leaf}`;

const RULES: Rule[] = [
  {
    match: /^([A-Z_]+):\s*(.*?)(?:\.|$)/,
    build: (_raw, m) => {
      const code = m[1];
      const detail = m[2];
      switch (code) {
        case 'DUPLICATE_VALUE':
          return mapping('duplicateValue', code, 'warning');
        case 'INVALID_CROSS_REFERENCE_KEY':
          return mapping('invalidCrossReferenceKey', code, 'info');
        case 'REQUIRED_FIELD_MISSING':
          return mapping('requiredFieldMissing', code, 'error', { detail });
        case 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST':
          return mapping('invalidPicklist', code, 'warning');
        case 'INVALID_FIELD_FOR_INSERT_UPDATE':
          return mapping('invalidFieldForInsert', code, 'error');
        case 'FIELD_INTEGRITY_EXCEPTION':
          return mapping('fieldIntegrity', code, 'error', { detail });
        case 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY':
          return mapping('cannotInsertEntity', code, 'info');
        case 'INSUFFICIENT_ACCESS_OR_READONLY':
        case 'INSUFFICIENT_ACCESS':
          return mapping('insufficientAccess', code, 'error');
        case 'STORAGE_LIMIT_EXCEEDED':
          return mapping('storageLimit', code, 'error');
        case 'INVALID_TYPE':
          return mapping('invalidType', code, 'error');
        case 'NOT_FOUND':
          return mapping('notFound', code, 'warning');
        case 'STRING_TOO_LONG':
          return mapping('stringTooLong', code, 'warning', { detail });
        default:
          return {
            code,
            explanationKey: 'forge.error.unknown.explanation',
            actionKey: 'forge.error.unknown.action',
            vars: { detail: detail || code },
            severity: 'error',
          };
      }
    },
  },
  {
    match: /Cycle FK '([^']+)'.*?source ([0-9A-Za-z]+)/,
    build: (_raw, m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'forge.error.cycleFkUnresolved.explanation',
      actionKey: 'forge.error.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: m[2] },
      severity: 'warning',
    }),
  },
  {
    match: /Cycle FK '([^']+)' could not be resolved/,
    build: (_raw, m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'forge.error.cycleFkUnresolved.explanation',
      actionKey: 'forge.error.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: '' },
      severity: 'warning',
    }),
  },
  {
    match: /no parent in cache and not the root/,
    build: () => ({
      code: 'OUT_OF_SCOPE',
      explanationKey: 'forge.error.outOfScope.explanation',
      actionKey: 'forge.error.outOfScope.action',
      severity: 'info',
    }),
  },
];

function mapping(
  slug: string,
  code: string,
  severity: 'info' | 'warning' | 'error',
  vars?: Record<string, string | number>,
): TranslatedError {
  return {
    code,
    explanationKey: KEY(slug, 'explanation'),
    actionKey: KEY(slug, 'action'),
    vars,
    severity,
  };
}

/**
 * Translate a raw error message into structured i18n keys. Returns `null`
 * when no rule matches.
 */
export function translateForgeError(raw: string): TranslatedError | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const rule of RULES) {
    const m = trimmed.match(rule.match);
    if (m) {
      return rule.build(trimmed, m);
    }
  }
  return null;
}
