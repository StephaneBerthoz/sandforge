import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { groupRecordErrors, translateError, type ErrorHintModule } from '@sandforge/shared';
import { ErrorExplanation } from './ErrorExplanation';

/** Groups shown open; the others are one click away. */
const OPEN_GROUPS = 3;

/** Props for the RecordErrorGroups section. */
export interface RecordErrorGroupsProps {
  /** The object whose records were refused, which names the test ids. */
  objectApiName: string;
  /** The refusals the run posted for it, one per record: at most the first ones. */
  errors: readonly string[];
  /** How many of its records the org refused, all of them, when the run counted them. */
  recordsFailed?: number;
  /**
   * Of those, how many `errors` says the refusals of, when the list holds
   * more than refusals — a Sync run's notes come after them. The list's own
   * length by default.
   */
  recordsListed?: number;
  /** The module the results are of, whose wording of a hint differs. */
  module?: ErrorHintModule;
  /** What every test id starts with: the results page the section is on. */
  testIdPrefix: string;
}

/**
 * The refusals of one object of a run, grouped by what refused them: "50 ×
 * STANDARD_PRICE_NOT_DEFINED" with one example, what it means and what to do,
 * in place of fifty identical red lines of ten pixels. The three largest
 * groups are open. When the run posted fewer refusals than it counted, the
 * groups say they are of the first ones only.
 *
 * Seed's results grouped this way; Sync's printed one line per refused record,
 * with no count, uncapped.
 */
export const RecordErrorGroups: React.FC<RecordErrorGroupsProps> = ({
  objectApiName,
  errors,
  recordsFailed,
  recordsListed = errors.length,
  module,
  testIdPrefix,
}) => {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      groupRecordErrors(errors).map((group) => ({
        ...group,
        hint: translateError(group.example, { code: group.code, module }),
      })),
    [errors, module],
  );
  if (groups.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 text-xs"
      data-testid={`${testIdPrefix}-errors-${objectApiName}`}
    >
      {groups.map((group, index) => (
        <details
          key={`${group.code ?? ''}:${group.fields.join(',')}:${group.example}`}
          open={index < OPEN_GROUPS}
          data-testid={`${testIdPrefix}-error-group-${objectApiName}-${index}`}
        >
          <summary className="cursor-pointer text-status-error">
            {t('common.recordErrors.group', {
              n: group.count,
              reason: group.code ?? group.example,
            })}
            {group.fields.length > 0 && (
              <span className="text-text-primary"> ({group.fields.join(', ')})</span>
            )}
          </summary>
          <div className="ml-3 mt-0.5 flex flex-col gap-1 text-text-primary">
            {/* A text with no code is its own reason, already read above. */}
            {group.code !== null && <p className="wrap-break-word">{group.example}</p>}
            {group.hint && <ErrorExplanation hint={group.hint} />}
          </div>
        </details>
      ))}
      {recordsFailed !== undefined && recordsListed < recordsFailed && (
        <p
          className="text-text-secondary"
          data-testid={`${testIdPrefix}-errors-listed-${objectApiName}`}
        >
          {t('common.recordErrors.listed', { listed: recordsListed, failed: recordsFailed })}
        </p>
      )}
    </div>
  );
};
