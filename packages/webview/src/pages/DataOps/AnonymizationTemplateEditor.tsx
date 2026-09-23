import React, { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  SAVED_TEMPLATE_METHODS,
  TEMPLATE_FIELD_PATTERN,
  TEMPLATE_MAX_RULES,
  TEMPLATE_NAME_MAX_LENGTH,
  isSavedTemplateMethod,
} from '@sandforge/shared';
import type { AnonymizationTemplateRule, SavedTemplateMethod } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

/** What the editor hands over on Save: a name, and each rule's field and method. */
export interface AnonymizationTemplateDraft {
  name: string;
  rules: Array<{ fieldPattern: string; ruleType: SavedTemplateMethod }>;
}

/** The label key of each masking method a template rule can name. */
const RULE_TYPE_LABELS: Record<string, string> = {
  mask: 'dataops.ruleTypes.mask',
  hash: 'dataops.ruleTypes.hash',
  fake: 'dataops.ruleTypes.fake',
  nullify: 'dataops.ruleTypes.nullify',
  shuffle: 'dataops.ruleTypes.shuffle',
  truncate: 'dataops.ruleTypes.truncate',
  constant: 'dataops.ruleTypes.constant',
  preserve_format: 'dataops.ruleTypes.preserve_format',
};

/** A method in the reader's language; one no label names stays as the host wrote it. */
export function ruleTypeLabel(t: TFunction, method: string): string {
  const key = RULE_TYPE_LABELS[method];
  return key ? t(key) : method;
}

/** One row of the editor. */
interface RuleRow {
  key: number;
  fieldPattern: string;
  ruleType: string;
}

/** Why a row cannot be saved, as a translation key and its values; undefined when it can. */
function rowProblem(
  row: RuleRow,
  earlier: readonly RuleRow[],
): { key: string; values?: Record<string, string> } | undefined {
  const field = row.fieldPattern.trim();
  if (!TEMPLATE_FIELD_PATTERN.test(field)) return { key: 'dataops.templateEditor.fieldInvalid' };
  if (earlier.some((other) => other.fieldPattern.trim().toLowerCase() === field.toLowerCase())) {
    return { key: 'dataops.templateEditor.fieldDuplicate' };
  }
  if (!isSavedTemplateMethod(row.ruleType)) {
    return { key: 'dataops.templateEditor.methodUnavailable', values: { method: row.ruleType } };
  }
  return undefined;
}

/** AnonymizationTemplateEditor props. */
export interface AnonymizationTemplateEditorProps {
  /** The rules it starts from: the selected template's, or none. */
  initialRules: readonly AnonymizationTemplateRule[];
  /** The template those rules come from, named in the introduction. */
  startsFrom?: string;
  /** Names templates already go by, which the host refuses for a new one. */
  takenNames: readonly string[];
  /** Whether the save is on its way to the host. */
  saving?: boolean;
  onSave: (draft: AnonymizationTemplateDraft) => void;
  onCancel: () => void;
}

/**
 * Names a set of masking rules and saves it as a template of the user's.
 *
 * Each rule is an `Object.Field` and a method a DataOps run applies with no
 * setting of its own (SAVED_TEMPLATE_METHODS). A rule it starts from that uses
 * another method — the salted hash of the CCPA template, say — is kept on
 * screen with the reason, and the template cannot be saved until it is changed
 * or removed: carried over silently, it would fail the run it was saved for.
 */
export const AnonymizationTemplateEditor: React.FC<AnonymizationTemplateEditorProps> = ({
  initialRules,
  startsFrom,
  takenNames,
  saving = false,
  onSave,
  onCancel,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const nameErrorId = useId();
  const rulesHintId = useId();
  const nextKey = useRef(initialRules.length);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<RuleRow[]>(() =>
    initialRules.map((rule, index) => ({
      key: index,
      fieldPattern: rule.fieldPattern,
      ruleType: rule.ruleType,
    })),
  );

  const nameTaken = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    return wanted !== '' && takenNames.some((taken) => taken.trim().toLowerCase() === wanted);
  }, [name, takenNames]);
  const problems = rows.map((row, index) => rowProblem(row, rows.slice(0, index)));
  const canSave =
    name.trim() !== '' &&
    !nameTaken &&
    rows.length > 0 &&
    problems.every((problem) => problem === undefined) &&
    !saving;

  const updateRow = (key: number, change: Partial<RuleRow>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };

  const addRule = (): void => {
    const key = nextKey.current;
    nextKey.current += 1;
    setRows((current) => [...current, { key, fieldPattern: '', ruleType: 'fake' }]);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSave) return;
    onSave({
      name: name.trim(),
      rules: rows.map((row) => ({
        fieldPattern: row.fieldPattern.trim(),
        ruleType: row.ruleType as SavedTemplateMethod,
      })),
    });
  };

  // The Schedule Builder's fields, so the two editors read alike.
  const inputClass =
    'w-full px-2 py-1 text-xs rounded border border-[var(--sf-border-input)] bg-[var(--sf-bg-input)] text-[var(--sf-text-input)] focus:outline-none focus:border-[var(--sf-accent)]';

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-3"
      aria-labelledby={titleId}
      onSubmit={submit}
      data-testid="template-editor"
    >
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="text-sm font-semibold text-text-primary">
          {t('dataops.templateEditor.title')}
        </h3>
        <p className="text-xs text-text-secondary">
          {startsFrom
            ? t('dataops.templateEditor.startsFrom', { name: startsFrom })
            : t('dataops.templateEditor.intro')}
        </p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-text-primary">
        <span>{t('dataops.templateEditor.name')}</span>
        <input
          className={inputClass}
          value={name}
          maxLength={TEMPLATE_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={nameTaken || undefined}
          aria-describedby={nameTaken ? nameErrorId : undefined}
          data-testid="template-name-input"
        />
      </label>
      {nameTaken && (
        <p id={nameErrorId} className="text-xs text-status-error" data-testid="template-name-taken">
          {t('dataops.templateEditor.nameTaken')}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const problem = problems[index];
          const problemId = `${titleId}-rule-${row.key}-problem`;
          const methods: string[] = isSavedTemplateMethod(row.ruleType)
            ? [...SAVED_TEMPLATE_METHODS]
            : [row.ruleType, ...SAVED_TEMPLATE_METHODS];
          return (
            <fieldset
              key={row.key}
              className="flex flex-col gap-1 rounded border border-subtle p-2"
              data-testid={`template-rule-${index}`}
            >
              <legend className="sr-only">
                {t('dataops.templateEditor.rule', { n: index + 1 })}
              </legend>
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs text-text-primary">
                  <span>{t('dataops.templateEditor.field')}</span>
                  <input
                    className={inputClass}
                    value={row.fieldPattern}
                    placeholder="Contact.Email"
                    onChange={(event) => updateRow(row.key, { fieldPattern: event.target.value })}
                    aria-invalid={
                      problem !== undefined &&
                      problem.key !== 'dataops.templateEditor.methodUnavailable'
                        ? true
                        : undefined
                    }
                    aria-describedby={problem ? problemId : undefined}
                    data-testid={`template-rule-field-${index}`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-text-primary">
                  <span>{t('dataops.templateEditor.method')}</span>
                  <select
                    className={inputClass}
                    value={row.ruleType}
                    onChange={(event) => updateRow(row.key, { ruleType: event.target.value })}
                    aria-invalid={
                      problem?.key === 'dataops.templateEditor.methodUnavailable' ? true : undefined
                    }
                    aria-describedby={problem ? problemId : undefined}
                    data-testid={`template-rule-method-${index}`}
                  >
                    {methods.map((method) => (
                      <option key={method} value={method} disabled={!isSavedTemplateMethod(method)}>
                        {ruleTypeLabel(t, method)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)]"
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                  aria-label={t('dataops.templateEditor.removeRule', { n: index + 1 })}
                  data-testid={`template-rule-remove-${index}`}
                >
                  <Icon name="trash" />
                </button>
              </div>
              {problem && (
                <p id={problemId} className="text-xs text-status-error">
                  {t(problem.key, {
                    ...problem.values,
                    method: problem.values?.method
                      ? ruleTypeLabel(t, problem.values.method)
                      : undefined,
                  })}
                </p>
              )}
            </fieldset>
          );
        })}
        {rows.length === 0 && (
          <p
            id={rulesHintId}
            className="text-xs text-text-secondary"
            data-testid="template-no-rules"
          >
            {t('dataops.templateEditor.noRules')}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addRule}
            disabled={rows.length >= TEMPLATE_MAX_RULES}
            data-testid="template-add-rule"
          >
            {t('dataops.templateEditor.addRule')}
          </Button>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSave}
          loading={saving}
          aria-describedby={rows.length === 0 ? rulesHintId : undefined}
          data-testid="template-save"
        >
          {t('dataops.templateEditor.save')}
        </Button>
      </div>
    </form>
  );
};
