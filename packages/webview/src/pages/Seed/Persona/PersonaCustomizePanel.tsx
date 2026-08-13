import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PersonaMsg, PersonaFieldPatternMsg } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';

/** Props for the PersonaCustomizePanel component. */
export interface PersonaCustomizePanelProps {
  /** The persona to customize. */
  persona: PersonaMsg;
  /** Called when the user confirms customization. Receives a copy with modified dataPatterns. */
  onConfirm: (customized: PersonaMsg) => void;
  /** Called when the user cancels and returns to the gallery. */
  onCancel: () => void;
}

/** Internal state for a single field row edit. */
interface FieldEditState {
  min?: string;
  max?: string;
  values?: string;
}

/**
 * Panel for customizing a persona's field patterns before applying it.
 * Displays editable rows for each field in the persona's dataPatterns.
 * Range generators show min/max inputs, pick generators show comma-separated values,
 * and faker/other generators show read-only example values.
 */
export const PersonaCustomizePanel: React.FC<PersonaCustomizePanelProps> = ({
  persona,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();

  const [edits, setEdits] = useState<Record<string, FieldEditState>>(() => {
    const initial: Record<string, FieldEditState> = {};
    for (const [fieldName, pattern] of Object.entries(persona.dataPatterns)) {
      if (pattern.generator === 'range') {
        const params = pattern.params as Record<string, unknown> | undefined;
        initial[fieldName] = {
          min: String(params?.['min'] ?? ''),
          max: String(params?.['max'] ?? ''),
        };
      } else if (pattern.generator === 'random_pick' || pattern.generator === 'weighted_pick') {
        const params = pattern.params as Record<string, unknown> | undefined;
        if (pattern.generator === 'random_pick' && Array.isArray(params?.['values'])) {
          initial[fieldName] = { values: (params['values'] as string[]).join(', ') };
        } else if (
          pattern.generator === 'weighted_pick' &&
          typeof params?.['values'] === 'object'
        ) {
          initial[fieldName] = {
            values: Object.keys(params['values'] as Record<string, unknown>).join(', '),
          };
        }
      }
    }
    return initial;
  });

  const updateField = useCallback((fieldName: string, key: keyof FieldEditState, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [fieldName]: { ...prev[fieldName], [key]: value },
    }));
  }, []);

  const handleConfirm = useCallback(() => {
    const newPatterns: Record<string, PersonaFieldPatternMsg> = {};

    for (const [fieldName, pattern] of Object.entries(persona.dataPatterns)) {
      const edit = edits[fieldName];
      const newPattern = { ...pattern };

      if (pattern.generator === 'range' && edit) {
        const existingParams = (pattern.params ?? {}) as Record<string, unknown>;
        const min =
          edit.min !== undefined && edit.min !== '' ? Number(edit.min) : existingParams['min'];
        const max =
          edit.max !== undefined && edit.max !== '' ? Number(edit.max) : existingParams['max'];
        newPattern.params = { ...existingParams, min, max };
      } else if (
        (pattern.generator === 'random_pick' || pattern.generator === 'weighted_pick') &&
        edit?.values !== undefined
      ) {
        const existingParams = (pattern.params ?? {}) as Record<string, unknown>;
        const valueList = edit.values
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
        if (pattern.generator === 'random_pick') {
          newPattern.params = { ...existingParams, values: valueList };
        } else {
          const weight = valueList.length > 0 ? 1 / valueList.length : 1;
          const weightedValues: Record<string, number> = {};
          for (const v of valueList) {
            weightedValues[v] = weight;
          }
          newPattern.params = { ...existingParams, values: weightedValues };
        }
      }

      newPatterns[fieldName] = newPattern;
    }

    const customized: PersonaMsg = {
      ...persona,
      dataPatterns: newPatterns,
    };

    onConfirm(customized);
  }, [persona, edits, onConfirm]);

  return (
    <Card data-testid="persona-customize-panel">
      <CardHeader title={t('seed.persona.customize.title')} subtitle={persona.name} />
      <CardBody>
        <div className="flex flex-col gap-3">
          {Object.entries(persona.dataPatterns).map(([fieldName, pattern]) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              pattern={pattern}
              edit={edits[fieldName]}
              onUpdate={(key, value) => updateField(fieldName, key, value)}
              t={t}
            />
          ))}

          <div className="flex gap-2 pt-2 border-t border-[var(--sf-border-subtle)]">
            <Button
              variant="secondary"
              size="sm"
              onClick={onCancel}
              data-testid="customize-cancel-btn"
            >
              {t('seed.persona.customize.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              data-testid="customize-confirm-btn"
            >
              {t('seed.persona.customize.confirm')}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};

/** Props for a single field row in the customize panel. */
interface FieldRowProps {
  fieldName: string;
  pattern: PersonaFieldPatternMsg;
  edit?: FieldEditState;
  onUpdate: (key: keyof FieldEditState, value: string) => void;
  t: (key: string) => string;
}

/** Renders a single field pattern as an editable row. */
const FieldRow: React.FC<FieldRowProps> = ({ fieldName, pattern, edit, onUpdate, t }) => {
  return (
    <div
      className="flex flex-col gap-1 p-2 rounded bg-[var(--sf-bg-input)]"
      data-testid={`field-row-${fieldName}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[var(--sf-text-primary)] flex-1">
          {fieldName}
        </span>
        <Badge variant="default">{pattern.generator}</Badge>
        <Badge variant="default">{pattern.fieldType}</Badge>
      </div>

      {/* Input binds its own label to its input; the ids are scoped per field
          because the same captions repeat on every row of the panel. */}
      {pattern.generator === 'range' && edit && (
        <div className="flex gap-2 items-center mt-1">
          <Input
            type="number"
            id={`field-min-${fieldName}`}
            label={t('seed.persona.customize.rangeMin')}
            value={edit.min ?? ''}
            onChange={(e) => onUpdate('min', e.target.value)}
            className="w-20 text-xs"
            data-testid={`field-min-${fieldName}`}
          />
          <Input
            type="number"
            id={`field-max-${fieldName}`}
            label={t('seed.persona.customize.rangeMax')}
            value={edit.max ?? ''}
            onChange={(e) => onUpdate('max', e.target.value)}
            className="w-20 text-xs"
            data-testid={`field-max-${fieldName}`}
          />
        </div>
      )}

      {(pattern.generator === 'random_pick' || pattern.generator === 'weighted_pick') && edit && (
        <div className="flex flex-col gap-1 mt-1">
          <Input
            id={`field-values-${fieldName}`}
            label={t('seed.persona.customize.values')}
            value={edit.values ?? ''}
            onChange={(e) => onUpdate('values', e.target.value)}
            className="text-xs"
            placeholder="Value1, Value2, Value3"
            data-testid={`field-values-${fieldName}`}
          />
        </div>
      )}

      {pattern.generator !== 'range' &&
        pattern.generator !== 'random_pick' &&
        pattern.generator !== 'weighted_pick' && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {pattern.examples.slice(0, 3).map((ex, i) => (
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--sf-badge-bg)] text-[var(--sf-badge-fg)]"
              >
                {ex}
              </span>
            ))}
          </div>
        )}
    </div>
  );
};
