import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { SEED_RELATION_LIMITS } from '@sandforge/shared';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import type {
  SeedRelationDraft,
  SeedRelationDraftPatch,
  SeedRelationMode,
} from '../../stores/useSeedWizardStore';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { cn } from '../../theme';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import { useSeedRelations } from './useSeedRelations';
import { canDrawFromRun, draftForLookup, settledNumber, typedNumber } from './seedRelationDrafts';
import type { CheckedRelation, RelationLookup, SeedVolumes } from './seedRelationDrafts';

/** Props for the SeedRelationsEditor. */
export interface SeedRelationsEditorProps {
  /** Per-object field configurations: where the lookups come from. */
  fieldConfigs: ObjectFieldConfig[];
  /** Volume configuration per object: how many parents the run creates. */
  volumes: SeedVolumes;
}

/** Most children one parent receives, the bound of every number field of a spread. */
const MOST_PER_PARENT = SEED_RELATION_LIMITS.maxPerParent;

/** Most records already in the org a relation reads. */
const MOST_EXISTING = SEED_RELATION_LIMITS.maxExistingParents;

/** What a number field shows: nothing while it is being retyped. */
function shown(value: number): number | '' {
  return Number.isNaN(value) ? '' : value;
}

/** The line under a row: what it plans, or why it cannot be sent. */
function rowMessage(t: TFunction, draft: SeedRelationDraft, checked: CheckedRelation): string {
  const names = { child: draft.childObject, parent: draft.parentObject };
  switch (checked.problem) {
    case null:
      return draft.source === 'generated'
        ? t('seed.relations.plannedGenerated', {
            ...names,
            count: checked.children,
            parents: checked.parents,
          })
        : t('seed.relations.plannedExisting', {
            ...names,
            count: checked.children,
            parents: checked.parents,
          });
    case 'incomplete':
      return t('seed.relations.problemIncomplete');
    case 'duplicate':
      return t('seed.relations.problemDuplicate', names);
    case 'generatedParent':
      return t('seed.relations.problemGeneratedParent', names);
    case 'numbers':
      return t('seed.relations.problemNumbers');
    case 'noChildren':
      return t('seed.relations.problemNoChildren', names);
  }
}

/** Props for one relation row. */
interface RelationRowProps {
  index: number;
  draft: SeedRelationDraft;
  checked: CheckedRelation;
  lookups: RelationLookup[];
  selectedObjects: string[];
  onChange: (patch: SeedRelationDraftPatch) => void;
  onRemove: () => void;
}

/** One relation: the lookup it fills, where its parents come from, how children are spread. */
const RelationRow: React.FC<RelationRowProps> = ({
  index,
  draft,
  checked,
  lookups,
  selectedObjects,
  onChange,
  onRemove,
}) => {
  const { t } = useTranslation();
  const number = index + 1;
  // Ids come from the row's key, which stays when a row above it is removed.
  const id = (part: string): string => `${draft.key}-${part}`;
  const testId = (part: string): string => `relation-${index}-${part}`;

  const children = [...new Set(lookups.map((l) => l.childObject))];
  const childLookups = lookups.filter((l) => l.childObject === draft.childObject);
  const lookup = childLookups.find((l) => l.lookupField === draft.lookupField);
  const fromRun = canDrawFromRun(draft.childObject, draft.parentObject, selectedObjects);

  const modes: Array<{ value: SeedRelationMode; label: string }> = [
    { value: 'perParent', label: t('seed.relations.modePerParent') },
    { value: 'range', label: t('seed.relations.modeRange') },
    { value: 'ratio', label: t('seed.relations.modeRatio') },
  ];

  return (
    <fieldset
      className="flex flex-col gap-2 rounded border border-[var(--sf-border)] p-2"
      data-testid={`relation-${index}`}
    >
      <legend className="px-1 text-xs font-medium text-[var(--sf-text-primary)]">
        {t('seed.relations.legend', { number })}
      </legend>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Select
            id={id('child')}
            label={t('seed.relations.child')}
            value={draft.childObject}
            options={children.map((name) => ({ value: name, label: name }))}
            onChange={(e) => {
              const first = lookups.find((l) => l.childObject === e.target.value);
              if (first) onChange(draftForLookup(first, selectedObjects));
            }}
            data-testid={testId('child')}
          />
        </div>
        <div className="w-60">
          <Select
            id={id('lookup')}
            label={t('seed.relations.lookup')}
            value={draft.lookupField}
            options={childLookups.map((l) => ({
              value: l.lookupField,
              label: `${l.label} (${l.lookupField}) → ${l.parents.join(', ')}`,
            }))}
            onChange={(e) => {
              const next = childLookups.find((l) => l.lookupField === e.target.value);
              if (next) onChange(draftForLookup(next, selectedObjects));
            }}
            data-testid={testId('lookup')}
          />
        </div>
        {lookup && lookup.parents.length > 1 && (
          <div className="w-40">
            <Select
              id={id('parent')}
              label={t('seed.relations.parent')}
              value={draft.parentObject}
              options={lookup.parents.map((name) => ({ value: name, label: name }))}
              onChange={(e) => onChange(draftForLookup(lookup, selectedObjects, e.target.value))}
              data-testid={testId('parent')}
            />
          </div>
        )}
        <div className="w-44">
          <Select
            id={id('source')}
            label={t('seed.relations.source')}
            value={draft.source}
            options={[
              // Offered only when the run writes the parent object before
              // the child: an insert cannot point at records it is writing.
              {
                value: 'generated',
                label: t('seed.relations.sourceGenerated'),
                disabled: !fromRun,
              },
              { value: 'existing', label: t('seed.relations.sourceExisting') },
            ]}
            onChange={(e) => onChange({ source: e.target.value as SeedRelationDraft['source'] })}
            data-testid={testId('source')}
          />
        </div>
      </div>

      {draft.source === 'existing' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Input
              id={id('where')}
              label={t('seed.relations.where')}
              value={draft.where}
              placeholder="Industry = 'Energy'"
              onChange={(e) => onChange({ where: e.target.value })}
              data-testid={testId('where')}
            />
          </div>
          <div className="w-28">
            <Input
              id={id('limit')}
              type="number"
              min={1}
              max={MOST_EXISTING}
              step={1}
              label={t('seed.relations.limit')}
              value={shown(draft.limit)}
              onChange={(e) => onChange({ limit: typedNumber(e.target.value) })}
              onBlur={() => onChange({ limit: settledNumber(draft.limit, 1, MOST_EXISTING) })}
              data-testid={testId('limit')}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Select
            id={id('mode')}
            label={t('seed.relations.mode')}
            value={draft.mode}
            options={modes}
            onChange={(e) => onChange({ mode: e.target.value as SeedRelationMode })}
            data-testid={testId('mode')}
          />
        </div>
        {draft.mode === 'perParent' && (
          <div className="w-24">
            <Input
              id={id('count')}
              type="number"
              min={1}
              max={MOST_PER_PARENT}
              step={1}
              label={t('seed.relations.count')}
              value={shown(draft.count)}
              onChange={(e) => onChange({ count: typedNumber(e.target.value) })}
              onBlur={() => onChange({ count: settledNumber(draft.count, 1, MOST_PER_PARENT) })}
              data-testid={testId('count')}
            />
          </div>
        )}
        {draft.mode === 'range' && (
          <>
            <div className="w-24">
              <Input
                id={id('min')}
                type="number"
                min={0}
                max={MOST_PER_PARENT}
                step={1}
                label={t('seed.relations.min')}
                value={shown(draft.min)}
                onChange={(e) => onChange({ min: typedNumber(e.target.value) })}
                onBlur={() => {
                  const min = settledNumber(draft.min, 0, MOST_PER_PARENT);
                  onChange(min > draft.max ? { min, max: Math.max(1, min) } : { min });
                }}
                data-testid={testId('min')}
              />
            </div>
            <div className="w-24">
              <Input
                id={id('max')}
                type="number"
                min={1}
                max={MOST_PER_PARENT}
                step={1}
                label={t('seed.relations.max')}
                value={shown(draft.max)}
                onChange={(e) => onChange({ max: typedNumber(e.target.value) })}
                onBlur={() => {
                  const max = settledNumber(draft.max, 1, MOST_PER_PARENT);
                  onChange(max < draft.min ? { max, min: max } : { max });
                }}
                data-testid={testId('max')}
              />
            </div>
          </>
        )}
        {draft.mode === 'ratio' && (
          <div className="w-40">
            <Input
              id={id('ratio')}
              type="number"
              min={SEED_RELATION_LIMITS.minRatio}
              max={MOST_PER_PARENT}
              step={0.1}
              label={t('seed.relations.ratio')}
              hint={t('seed.relations.ratioHint')}
              value={shown(draft.ratio)}
              onChange={(e) => onChange({ ratio: typedNumber(e.target.value) })}
              onBlur={() =>
                onChange({
                  ratio: settledNumber(
                    draft.ratio,
                    SEED_RELATION_LIMITS.minRatio,
                    MOST_PER_PARENT,
                    false,
                  ),
                })
              }
              data-testid={testId('ratio')}
            />
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onRemove}
          data-testid={`remove-relation-${index}`}
        >
          {t('seed.relations.remove', { number })}
        </Button>
      </div>

      <p
        className={cn(
          'text-xs',
          checked.problem ? 'text-status-error' : 'text-[var(--sf-text-secondary)]',
        )}
        data-testid={testId(checked.problem ? 'problem' : 'planned')}
      >
        {rowMessage(t, draft, checked)}
      </p>
    </fieldset>
  );
};

/**
 * The relations of a Seed run: each fills a lookup of a selected object from a
 * parent object's records — the ones this run creates, or ones already in the
 * org picked by a filter — and decides how many children each parent gets,
 * which is how many records the child object gets.
 */
export const SeedRelationsEditor: React.FC<SeedRelationsEditorProps> = ({
  fieldConfigs,
  volumes,
}) => {
  const { t } = useTranslation();
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const {
    relations,
    lookups,
    checked,
    handleAddRelation,
    handleRemoveRelation,
    handleChangeRelation,
  } = useSeedRelations(fieldConfigs, volumes);
  // Until every object is described its lookups are unknown, not absent.
  const described = selectedObjects.every((o) => fieldConfigs.some((c) => c.objectApiName === o));

  return (
    <div className="flex flex-col gap-2" data-testid="seed-relations">
      <p className="text-xs text-[var(--sf-text-secondary)]">{t('seed.relations.help')}</p>
      {relations.map((draft, index) => (
        <RelationRow
          key={draft.key}
          index={index}
          draft={draft}
          checked={checked[index]}
          lookups={lookups}
          selectedObjects={selectedObjects}
          onChange={(patch) => handleChangeRelation(index, patch)}
          onRemove={() => handleRemoveRelation(index)}
        />
      ))}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleAddRelation}
          disabled={lookups.length === 0}
          data-testid="add-relation-btn"
        >
          {t('seed.relations.add')}
        </Button>
        {described && lookups.length === 0 && (
          <span
            className="text-xs text-[var(--sf-text-secondary)]"
            data-testid="seed-relations-no-lookup"
          >
            {t('seed.relations.noLookup')}
          </span>
        )}
      </div>
    </div>
  );
};
