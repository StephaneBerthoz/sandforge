import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { groupRecordErrors } from '../../utils/recordErrorGroups';

/**
 * What to do about the refusals a seed meets most, by their status code. Each
 * says it for a seed, whose every value is generated: the hints Forge gives the
 * same codes speak of a source record and of a clone's depth, which a seed has
 * not. A code with no entry is shown with its example alone.
 */
const SEED_ERROR_HINTS: Readonly<Record<string, string>> = {
  REQUIRED_FIELD_MISSING: 'seed.results.errorHint.requiredFieldMissing',
  FIELD_CUSTOM_VALIDATION_EXCEPTION: 'seed.results.errorHint.validationRule',
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: 'seed.results.errorHint.restrictedPicklist',
  DUPLICATE_VALUE: 'seed.results.errorHint.duplicateValue',
  DUPLICATES_DETECTED: 'seed.results.errorHint.duplicateRule',
  STORAGE_LIMIT_EXCEEDED: 'seed.results.errorHint.storageFull',
  STANDARD_PRICE_NOT_DEFINED: 'seed.results.errorHint.standardPrice',
  CANNOT_EXECUTE_FLOW_TRIGGER: 'seed.results.errorHint.flowFailed',
};

/** Groups shown open; the others are one click away. */
const OPEN_GROUPS = 3;

/** Props for the SeedResultErrors section. */
export interface SeedResultErrorsProps {
  /** The object whose records were refused. */
  objectApiName: string;
  /** The refusals the run posted for it: at most the first thousand. */
  errors: readonly string[];
  /** How many of its records the org refused, all of them. */
  recordsFailed: number;
}

/**
 * The refusals of one object of a seed, grouped by what refused them: "50 ×
 * STANDARD_PRICE_NOT_DEFINED" with one example and what to do, in place of
 * fifty identical red lines. The three largest groups are open. When the run
 * posted fewer refusals than it counted, the groups say they are of the first
 * ones only.
 */
export const SeedResultErrors: React.FC<SeedResultErrorsProps> = ({
  objectApiName,
  errors,
  recordsFailed,
}) => {
  const { t } = useTranslation();
  const groups = useMemo(() => groupRecordErrors(errors), [errors]);
  if (groups.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 text-[10px]"
      data-testid={`seed-result-errors-${objectApiName}`}
    >
      {groups.map((group, index) => {
        const hint = group.code === null ? undefined : SEED_ERROR_HINTS[group.code];
        return (
          <details
            key={`${group.code ?? ''}:${group.fields.join(',')}:${group.example}`}
            open={index < OPEN_GROUPS}
            data-testid={`seed-result-error-group-${objectApiName}-${index}`}
          >
            <summary className="cursor-pointer text-status-error">
              {t('seed.results.errorGroup', {
                n: group.count,
                reason: group.code ?? group.example,
              })}
              {group.fields.length > 0 && (
                <span className="text-text-primary"> ({group.fields.join(', ')})</span>
              )}
            </summary>
            <div className="ml-3 flex flex-col gap-0.5 text-text-primary">
              {/* A text with no code is its own reason, already read above. */}
              {group.code !== null && <p className="wrap-break-word">{group.example}</p>}
              {hint && <p data-testid="seed-result-error-hint">{t(hint)}</p>}
            </div>
          </details>
        );
      })}
      {errors.length < recordsFailed && (
        <p
          className="text-text-secondary"
          data-testid={`seed-result-errors-listed-${objectApiName}`}
        >
          {t('seed.results.errorsListed', { listed: errors.length, failed: recordsFailed })}
        </p>
      )}
    </div>
  );
};
