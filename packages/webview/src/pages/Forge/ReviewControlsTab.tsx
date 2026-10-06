import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeConfig, ForgeUsersResponse } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useForgeStore } from '../../stores/useForgeStore';
import { withFieldExcluded } from '../../utils/forgeGapDecisions';
import type { ForgeControlKey } from '../../utils/forgeRunControls';
import {
  controlRefused,
  filterAllowed,
  withFieldRename,
  withObjectFilter,
  withOwnerMapping,
  withRecordCap,
} from '../../utils/forgeRunControls';
import { soqlRootFilter } from './forgeUtils';
import { RECORD_LIMIT_PRESETS } from './useForgeForm';
import { uiLocale } from '../../utils/formatters';

/** A field of an object, as `sync:describe-fields` lists the createable ones of each org. */
interface DescribedField {
  apiName: string;
  label: string;
  type: string;
}

/** The createable fields of one object in both orgs. */
interface DescribedFields {
  objectApiName: string;
  sourceFields: DescribedField[];
  targetFields: DescribedField[];
}

/** How the inputs and lists of the tab look, as the Gaps tab's do. */
const INPUT_CLASS = cn(
  'rounded-sm px-2 py-1 text-xs',
  'bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)',
);

/** What a change to the config needs: the config, and the store's way to write it. */
interface ControlProps {
  config: ForgeConfig;
  /**
   * Write `next` into the config unless the schema refuses its part `key`, and
   * say which: true when written.
   */
  apply: (next: ForgeConfig, key: ForgeControlKey) => boolean;
}

/**
 * Review's Controls tab: what the run already supports and the page never
 * showed — the fields an object's rows leave out, a filter on its read, the
 * fields written under another name, a cap on every object's records, the
 * owners given to the target's users.
 *
 * Each control writes the run's config as it is set, keeping the plan, the
 * diffs and the gaps Review has read (`updateConfig`): Simulate, Execute, a
 * retry and a template saved from Review carry it, and a template brought
 * back shows it set. A change the run's schema would refuse is held back and
 * said, never written.
 */
export const ReviewControlsTab: React.FC = () => {
  const { t } = useTranslation();
  const config = useForgeStore((s) => s.config);
  const graph = useForgeStore((s) => s.graph);
  const updateConfig = useForgeStore((s) => s.updateConfig);
  const [said, setSaid] = useState('');
  const [refused, setRefused] = useState('');
  const objectId = useId();
  const objects = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((node) => node.included)
        .map((node) => node.objectApiName)
        .sort((a, b) => a.localeCompare(b)),
    [graph],
  );
  const [object, setObject] = useState('');

  if (!config) return null;

  const apply = (next: ForgeConfig, key: ForgeControlKey): boolean => {
    if (controlRefused(next, key)) {
      setSaid('');
      setRefused(t(`forge.controls.refused.${key}`));
      return false;
    }
    setRefused('');
    updateConfig(() => next);
    setSaid(t('forge.controls.kept'));
    return true;
  };

  return (
    <div data-testid="review-controls-tab" className="flex flex-col gap-4 text-xs">
      <p className="text-text-secondary">{t('forge.controls.hint')}</p>
      <section aria-labelledby={`${objectId}-title`} className="flex flex-col gap-2">
        <h3 id={`${objectId}-title`} className="font-semibold text-text-primary">
          {t('forge.controls.objectTitle')}
        </h3>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${objectId}-object`} className="text-text-secondary">
            {t('forge.controls.object')}
          </label>
          <select
            id={`${objectId}-object`}
            data-testid="controls-object"
            value={object}
            onChange={(e) => setObject(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{t('forge.controls.objectPlaceholder')}</option>
            {objects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {object !== '' && (
          <ObjectControls key={object} object={object} config={config} apply={apply} />
        )}
      </section>
      <RunControls config={config} apply={apply} />
      <p role="status" data-testid="controls-said" className="text-text-primary">
        {said}
      </p>
      {refused !== '' && (
        <p role="alert" data-testid="controls-refused" className="text-status-error">
          {refused}
        </p>
      )}
    </div>
  );
};

/** The controls of one object: its fields left out, its filter, its fields renamed. */
const ObjectControls: React.FC<ControlProps & { object: string }> = ({ object, config, apply }) => {
  const { t } = useTranslation();
  const id = useId();
  const fields = useBridgeMutation<DescribedFields>('sync:describe-fields', {
    responseType: 'sync:describe-fields:response',
  });
  const { mutate } = fields;
  const { sourceOrgId, targetOrgId } = config;
  useEffect(() => {
    mutate({ sourceOrgId, targetOrgId, objectApiName: object });
  }, [mutate, sourceOrgId, targetOrgId, object]);
  const described = fields.data?.objectApiName === object ? fields.data : null;

  return (
    <div data-testid={`controls-object-${object}`} className="flex flex-col gap-3">
      {fields.loading && (
        <p role="status" data-testid="controls-fields-reading" className="text-text-secondary">
          {t('forge.controls.fields.reading', { object })}
        </p>
      )}
      {fields.error && (
        <p role="alert" data-testid="controls-fields-error" className="text-status-error">
          {t('forge.controls.fields.error', { object, error: fields.error })}
        </p>
      )}
      <FieldsLeftOut
        object={object}
        config={config}
        apply={apply}
        sourceFields={described?.sourceFields ?? []}
        idPrefix={id}
      />
      <ObjectFilter object={object} config={config} apply={apply} idPrefix={id} />
      <FieldRenames
        object={object}
        config={config}
        apply={apply}
        sourceFields={described?.sourceFields ?? []}
        targetFields={described?.targetFields ?? []}
        idPrefix={id}
      />
    </div>
  );
};

/** The fields of an object the run leaves out of its rows, ticked among those the source lets a run write. */
const FieldsLeftOut: React.FC<
  ControlProps & { object: string; sourceFields: DescribedField[]; idPrefix: string }
> = ({ object, config, apply, sourceFields, idPrefix }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const leftOut = config.fieldExclusions?.[object] ?? [];
  // A field a template left out shows though the source no longer lists it:
  // the run leaves it out all the same.
  const names = [...new Set([...sourceFields.map((field) => field.apiName), ...leftOut])].sort(
    (a, b) => a.localeCompare(b),
  );
  const needle = search.trim().toLowerCase();
  const shown = needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names;

  return (
    <fieldset data-testid="controls-fields" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">
        {t('forge.controls.fields.legend', { object })}{' '}
        <span className="font-normal text-text-secondary">
          {t('forge.controls.fields.count', { count: leftOut.length })}
        </span>
      </legend>
      {names.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-field-search`} className="text-text-secondary">
            {t('forge.controls.fields.search')}
          </label>
          <input
            id={`${idPrefix}-field-search`}
            data-testid="controls-fields-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      )}
      {names.length > 0 && shown.length === 0 && (
        <p className="text-text-secondary">{t('forge.controls.fields.none')}</p>
      )}
      <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {shown.map((name) => {
          const checked = leftOut.includes(name);
          return (
            <li key={name}>
              <label className="flex items-center gap-1.5 text-text-primary">
                <input
                  type="checkbox"
                  data-testid={`controls-field-${name}`}
                  checked={checked}
                  onChange={() =>
                    apply(
                      withFieldExcluded(config, { object, field: name }, !checked),
                      'fieldExclusions',
                    )
                  }
                />
                {name}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
};

/** The filter an object's read is held to, as a WHERE clause the schema checks. */
const ObjectFilter: React.FC<ControlProps & { object: string; idPrefix: string }> = ({
  object,
  config,
  apply,
  idPrefix,
}) => {
  const { t } = useTranslation();
  const current = config.objectSoqlFilters?.[object] ?? '';
  const [where, setWhere] = useState(current);
  const [invalid, setInvalid] = useState(false);
  // A run of a query reads its root by the query's own WHERE clause: changed
  // here, the run would no longer be the query's, and cleared, it would read
  // the whole table.
  const fromQuery =
    config.soqlQuery !== undefined &&
    soqlRootFilter(config.soqlQuery)?.objectApiName === object &&
    current !== '';
  const hintId = `${idPrefix}-filter-hint`;
  const errorId = `${idPrefix}-filter-error`;

  return (
    <form
      data-testid="controls-filter"
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (where.trim() !== '' && !filterAllowed(where.trim())) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        apply(withObjectFilter(config, object, where), 'objectSoqlFilters');
      }}
    >
      <label htmlFor={`${idPrefix}-filter`} className="font-medium text-text-primary">
        {t('forge.controls.filter.label', { object })}
      </label>
      <p id={hintId} className="text-text-secondary">
        {t(fromQuery ? 'forge.controls.filter.fromQuery' : 'forge.controls.filter.hint')}
      </p>
      <textarea
        id={`${idPrefix}-filter`}
        data-testid="controls-filter-where"
        rows={2}
        maxLength={600}
        value={where}
        readOnly={fromQuery}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
        onChange={(e) => {
          setWhere(e.target.value);
          setInvalid(false);
        }}
        className={cn(INPUT_CLASS, 'font-mono', invalid && 'border-status-error/40')}
      />
      {invalid && (
        <p
          id={errorId}
          role="alert"
          data-testid="controls-filter-refused"
          className="text-status-error"
        >
          {t('forge.controls.filter.refused')}
        </p>
      )}
      {!fromQuery && (
        <div className="flex items-center gap-2">
          <Button type="submit" variant="secondary" size="sm" data-testid="controls-filter-apply">
            {t('forge.controls.filter.apply')}
          </Button>
          {current !== '' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="controls-filter-clear"
              onClick={() => {
                setWhere('');
                setInvalid(false);
                apply(withObjectFilter(config, object, null), 'objectSoqlFilters');
              }}
            >
              {t('forge.controls.filter.clear')}
            </Button>
          )}
        </div>
      )}
    </form>
  );
};

/** The fields of an object written under another name: a source field, and the target's it goes into. */
const FieldRenames: React.FC<
  ControlProps & {
    object: string;
    sourceFields: DescribedField[];
    targetFields: DescribedField[];
    idPrefix: string;
  }
> = ({ object, config, apply, sourceFields, targetFields, idPrefix }) => {
  const { t } = useTranslation();
  const renames = config.fieldMappings?.[object] ?? {};
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const sources = sourceFields
    .map((field) => field.apiName)
    .filter((name) => renames[name] === undefined)
    .sort((a, b) => a.localeCompare(b));
  const targets = targetFields.map((field) => field.apiName).sort((a, b) => a.localeCompare(b));

  return (
    <fieldset data-testid="controls-renames" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">{t('forge.controls.rename.legend')}</legend>
      {Object.keys(renames).length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {Object.entries(renames).map(([source, target]) => {
            const item = t('forge.controls.rename.item', { from: source, to: target });
            return (
              <li
                key={source}
                data-testid={`controls-rename-${source}`}
                className="flex items-center justify-between gap-2 text-text-primary"
              >
                <span>{item}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('forge.controls.removeLabel', { what: item })}
                  onClick={() =>
                    apply(withFieldRename(config, object, source, null), 'fieldMappings')
                  }
                >
                  {t('forge.controls.remove')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (from === '' || to === '') return;
          if (apply(withFieldRename(config, object, from, to), 'fieldMappings')) {
            setFrom('');
            setTo('');
          }
        }}
      >
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-rename-from`} className="text-text-secondary">
            {t('forge.controls.rename.from')}
          </label>
          <select
            id={`${idPrefix}-rename-from`}
            data-testid="controls-rename-from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{t('forge.controls.pick')}</option>
            {sources.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-rename-to`} className="text-text-secondary">
            {t('forge.controls.rename.to')}
          </label>
          <select
            id={`${idPrefix}-rename-to`}
            data-testid="controls-rename-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{t('forge.controls.pick')}</option>
            {targets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          data-testid="controls-rename-add"
          disabled={from === '' || to === ''}
        >
          {t('forge.controls.rename.add')}
        </Button>
      </form>
    </fieldset>
  );
};

/** The controls of the whole run: the cap on every object's records, and the owners mapped. */
const RunControls: React.FC<ControlProps> = ({ config, apply }) => {
  const { t } = useTranslation();
  const id = useId();
  const current = config.maxRecordsPerObject;
  // The caps the form's own list offers, so that a template saved with one
  // comes back to that list as it was; a cap set otherwise — a query's 200 —
  // is listed as it stands.
  const caps = [
    ...new Set([...RECORD_LIMIT_PRESETS, ...(current !== undefined ? [current] : [])]),
  ].sort((a, b) => a - b);

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-text-primary">
        {t('forge.controls.runTitle')}
      </h3>
      <div data-testid="controls-cap" className="flex flex-col gap-1">
        <label htmlFor={`${id}-cap`} className="font-medium text-text-primary">
          {t('forge.controls.cap.label')}
        </label>
        <select
          id={`${id}-cap`}
          data-testid="controls-cap-value"
          value={current !== undefined ? String(current) : ''}
          onChange={(e) =>
            apply(
              withRecordCap(config, e.target.value === '' ? undefined : Number(e.target.value)),
              'maxRecordsPerObject',
            )
          }
          className={cn(INPUT_CLASS, 'w-48')}
        >
          <option value="">{t('forge.controls.cap.none')}</option>
          {caps.map((cap) => (
            <option key={cap} value={String(cap)}>
              {cap.toLocaleString(uiLocale())}
            </option>
          ))}
        </select>
      </div>
      <OwnerMappings config={config} apply={apply} idPrefix={id} />
    </section>
  );
};

/**
 * The owners mapped: a source user's id, and the target's active user picked
 * by name, whose id the mapping keeps.
 */
const OwnerMappings: React.FC<ControlProps & { idPrefix: string }> = ({
  config,
  apply,
  idPrefix,
}) => {
  const { t } = useTranslation();
  const users = useBridgeMutation<ForgeUsersResponse['payload']>('forge:users:request', {
    responseType: 'forge:users:response',
    errorType: 'forge:users:error',
  });
  const { mutate } = users;
  const { targetOrgId } = config;
  useEffect(() => {
    mutate({ orgId: targetOrgId });
  }, [mutate, targetOrgId]);
  const listed = users.data?.orgId === targetOrgId ? users.data : null;
  const nameOf = new Map((listed?.users ?? []).map((user) => [user.id, user.name]));
  const owners = Object.entries(config.ownerMappings ?? {});
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');

  return (
    <fieldset data-testid="controls-owners" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">{t('forge.controls.owners.legend')}</legend>
      <p className="text-text-secondary">{t('forge.controls.owners.hint')}</p>
      {users.loading && (
        <p role="status" data-testid="controls-users-reading" className="text-text-secondary">
          {t('forge.controls.owners.reading')}
        </p>
      )}
      {users.error && (
        <p role="alert" data-testid="controls-users-error" className="text-status-error">
          {t('forge.controls.owners.error', { error: users.error })}
        </p>
      )}
      {listed?.truncated && (
        <p data-testid="controls-users-truncated" className="text-status-warning">
          {t('forge.controls.owners.truncated', { listed: listed.users.length })}
        </p>
      )}
      {owners.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {owners.map(([from, to]) => {
            const item = t('forge.controls.owners.item', {
              source: from,
              target: nameOf.has(to) ? `${nameOf.get(to)} (${to})` : to,
            });
            return (
              <li
                key={from}
                data-testid={`controls-owner-${from}`}
                className="flex items-center justify-between gap-2 text-text-primary"
              >
                <span>{item}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('forge.controls.removeLabel', { what: item })}
                  onClick={() => apply(withOwnerMapping(config, from, null), 'ownerMappings')}
                >
                  {t('forge.controls.remove')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim() === '' || target === '') return;
          if (apply(withOwnerMapping(config, source.trim(), target), 'ownerMappings')) {
            setSource('');
            setTarget('');
          }
        }}
      >
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-owner-source`} className="text-text-secondary">
            {t('forge.controls.owners.source')}
          </label>
          <input
            id={`${idPrefix}-owner-source`}
            data-testid="controls-owner-source"
            type="text"
            maxLength={18}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={cn(INPUT_CLASS, 'w-44 font-mono')}
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-owner-target`} className="text-text-secondary">
            {t('forge.controls.owners.target')}
          </label>
          <select
            id={`${idPrefix}-owner-target`}
            data-testid="controls-owner-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{t('forge.controls.pick')}</option>
            {(listed?.users ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.username ? `${user.name} — ${user.username}` : user.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          data-testid="controls-owner-add"
          disabled={source.trim() === '' || target === ''}
        >
          {t('forge.controls.owners.add')}
        </Button>
      </form>
    </fieldset>
  );
};
