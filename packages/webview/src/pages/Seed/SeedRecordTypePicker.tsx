import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import { offersRecordTypes, recordTypesMixed, recordTypesPerson } from './seedRecordTypeChoices';

/** Props for {@link SeedRecordTypePicker}. */
export interface SeedRecordTypePickerProps {
  /** Per-object field configurations: where each object's record types come from. */
  fieldConfigs: ObjectFieldConfig[];
}

/**
 * The record types a seed gives each selected object's records, among those
 * the target offers the user, a person account's marked: none chosen, the
 * records take the user's default; several take turns at random. Person
 * accounts could be seeded from the command line only (`--record-type`).
 *
 * The rules are the command line's: a person account type writes person
 * accounts — a first and last name, the person's email and phones, no Name —
 * and a person type chosen with a business one is refused, the two kinds
 * taking different fields; the wizard says so and waits.
 */
export const SeedRecordTypePicker: React.FC<SeedRecordTypePickerProps> = ({ fieldConfigs }) => {
  const { t } = useTranslation();
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const choices = useSeedWizardStore((s) => s.recordTypeChoices);
  const choose = useSeedWizardStore((s) => s.setRecordTypeChoice);

  const offered = selectedObjects.flatMap((objectApiName) => {
    const options = fieldConfigs.find((c) => c.objectApiName === objectApiName)?.recordTypes;
    return options && offersRecordTypes(options) ? [{ objectApiName, options }] : [];
  });
  if (offered.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="seed-record-types">
      <span className="text-xs font-medium text-(--sf-text-primary)">
        {t('seed.recordTypes.title')}
      </span>
      <p className="text-[11px] text-(--sf-text-secondary)">{t('seed.recordTypes.help')}</p>
      {offered.map(({ objectApiName, options }) => {
        const chosen = choices[objectApiName] ?? [];
        const mixed = recordTypesMixed(options, chosen);
        const person = recordTypesPerson(options, chosen);
        const toggle = (recordTypeId: string, on: boolean): void =>
          choose(
            objectApiName,
            on ? [...chosen, recordTypeId] : chosen.filter((id) => id !== recordTypeId),
          );
        return (
          <fieldset
            key={objectApiName}
            className="flex flex-col gap-1 rounded-sm border border-subtle p-2"
            data-testid={`seed-record-types-${objectApiName}`}
          >
            <legend className="px-1 text-xs font-semibold text-(--sf-text-primary)">
              {objectApiName}
            </legend>
            {options.map((option) => (
              <label
                key={option.recordTypeId}
                className="flex items-center gap-2 text-xs text-(--sf-text-primary) cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={chosen.includes(option.recordTypeId)}
                  onChange={(e) => toggle(option.recordTypeId, e.target.checked)}
                  data-testid={`seed-record-type-${objectApiName}-${option.developerName}`}
                />
                <span>
                  {option.label}
                  {option.label !== option.developerName && (
                    <span className="text-(--sf-text-secondary)"> ({option.developerName})</span>
                  )}
                </span>
                {option.person && (
                  <span className="rounded-sm bg-surface-2 px-1 text-[10px] text-(--sf-text-secondary)">
                    {t('seed.recordTypes.person')}
                  </span>
                )}
                {option.isDefault && (
                  <span className="text-[10px] text-(--sf-text-secondary)">
                    {t('seed.recordTypes.yourDefault')}
                  </span>
                )}
              </label>
            ))}
            {mixed && (
              <p
                role="alert"
                className="text-[11px] text-status-error"
                data-testid={`seed-record-types-mixed-${objectApiName}`}
              >
                {t('seed.recordTypes.mixed', { object: objectApiName })}
              </p>
            )}
            {person && (
              <p
                className="text-[11px] text-(--sf-text-secondary)"
                data-testid={`seed-record-types-person-${objectApiName}`}
              >
                {t('seed.recordTypes.personNote', { object: objectApiName })}
              </p>
            )}
          </fieldset>
        );
      })}
    </div>
  );
};
