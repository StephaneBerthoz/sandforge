/**
 * The decisions taken on Review's Gaps tab, as the run's config holds them.
 *
 * A decision lives in the config and nowhere else: `startForgeRun`, the Retry
 * of a run and Clone directly send the config the store holds, a template and
 * a past run keep it, and the tab reads back from it which decision answers
 * each gap. A template applied in the form therefore shows its decisions as
 * chosen on the gaps they answer, with nothing to keep in step.
 */
import type {
  ForgeConfig,
  ForgeDefaultValue,
  ForgeFieldRef,
  ForgeGap,
  ForgeGapDecisionKind,
  ForgeGapKind,
  ForgeGapSource,
  ForgeGraph,
  ForgePicklistValueMapping,
  ForgeRecordTypeMapping,
} from '@sandforge/shared';
import { mergeGaps } from '@sandforge/shared';

/** A decision on one gap, with what it needs to be written. */
export type ForgeGapChoice =
  | { kind: 'map_value'; to: string }
  | { kind: 'leave_empty' }
  | { kind: 'set_default'; value: string | number | boolean }
  | { kind: 'truncate' }
  | { kind: 'map_record_type'; to: string | null }
  | { kind: 'exclude_object' }
  | { kind: 'ignore' };

/** One decision a config holds, by the entry that holds it. */
export type ForgeKeptDecision =
  | { kind: 'picklist'; entry: ForgePicklistValueMapping }
  | { kind: 'record_type'; entry: ForgeRecordTypeMapping }
  | { kind: 'default'; entry: ForgeDefaultValue }
  | { kind: 'truncate'; entry: ForgeFieldRef }
  | { kind: 'field_excluded'; entry: ForgeFieldRef }
  | { kind: 'object_excluded'; object: string }
  | { kind: 'ignored'; gapId: string };

/** The gaps a read found, by the read; a source not read yet may be absent. */
export type ForgeGapsBySource = Partial<Record<ForgeGapSource, readonly ForgeGap[]>>;

/**
 * Kinds of gap about one value of a picklist (a currency code is one): their
 * `value` is what a mapping maps from, and leaving them empty leaves the field
 * out of the rows that hold that value alone. Any other kind's `value` names
 * a rule, a record type or a status code, and leaving it empty leaves the
 * whole field out.
 */
const VALUE_KINDS: ReadonlySet<ForgeGapKind> = new Set<ForgeGapKind>([
  'picklist_value_refused',
  'dependent_value_invalid',
  'picklist_value_absent',
  'currency_inactive',
]);

/** Kinds of gap about a source record type, which `value` names. */
const RECORD_TYPE_KINDS: ReadonlySet<ForgeGapKind> = new Set<ForgeGapKind>([
  'record_type_unmapped',
  'record_type_unavailable',
]);

/**
 * The objects the run does not write: those its config leaves out, and the
 * nodes of the graph left out, by the user or by discovery.
 */
export function objectsLeftOut(
  config: ForgeConfig | null,
  graph: ForgeGraph | null | undefined,
): Set<string> {
  return new Set([
    ...(config?.excludedObjects ?? []),
    ...(graph?.nodes ?? []).filter((node) => !node.included).map((node) => node.objectApiName),
  ]);
}

/**
 * Every gap the reads found, once each, the gravest first (`mergeGaps`), but
 * those of an object the run does not write. The read of the target's
 * metadata reads the objects left out too, as the automation read does, so
 * that one taken back in needs no second read; a gap of an object the run
 * leaves out refuses nothing.
 */
export function gapsToShow(
  gaps: ForgeGapsBySource | undefined,
  leftOut: ReadonlySet<string> = new Set(),
): ForgeGap[] {
  return mergeGaps(gaps?.metadata ?? [], gaps?.simulation ?? [], gaps?.rehearsal ?? []).filter(
    (gap) => !leftOut.has(gap.objectApiName),
  );
}

/** Whether a gap of `kind` names a picklist value in its `value`. */
export function isValueKind(kind: ForgeGapKind): boolean {
  return VALUE_KINDS.has(kind);
}

/** Whether `gap` is about one picklist value of one field. */
export function aboutAValue(gap: ForgeGap): gap is ForgeGap & { field: string; value: string } {
  return VALUE_KINDS.has(gap.kind) && gap.field !== undefined && gap.value !== undefined;
}

/** The source record type a record type gap is about, when it names one. */
function recordTypeFrom(gap: ForgeGap): string | undefined {
  return RECORD_TYPE_KINDS.has(gap.kind) ? (gap.value ?? gap.recordType) : undefined;
}

/** A list the gap's detail holds under the first of `keys` that holds one, or none. */
function detailList(gap: ForgeGap, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = gap.detail?.[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

/**
 * The values the target allows in the gap's field, as the read gave them. The
 * simulation names them `allowed`: read under that name too, or a gap it found
 * offered no value to map to.
 */
export function allowedValues(gap: ForgeGap): string[] {
  return detailList(gap, 'allowedValues', 'allowed');
}

/** The target's record types a record type gap may be mapped to; the simulation names them `mapTo`. */
export function targetRecordTypes(gap: ForgeGap): string[] {
  return detailList(gap, 'targetRecordTypes', 'mapTo');
}

/**
 * The decisions the tab offers on `gap`, in the order the read gave them: those
 * the config can hold with what the gap says. Skipping the refused rows is not
 * offered: no field of the config holds it, and a decision the run would not
 * apply would read as taken.
 */
export function offeredDecisions(gap: ForgeGap): ForgeGapDecisionKind[] {
  return gap.decisions.filter((kind) => {
    switch (kind) {
      case 'map_value':
        return aboutAValue(gap) && allowedValues(gap).length > 0;
      case 'leave_empty':
      case 'set_default':
      case 'truncate':
        return gap.field !== undefined;
      case 'map_record_type':
        return recordTypeFrom(gap) !== undefined;
      case 'exclude_object':
      case 'ignore':
        return true;
      case 'skip_rows':
        return false;
    }
  });
}

/** Whether two picklist mappings map the same value of the same field for the same record type. */
function samePicklistEntry(a: ForgePicklistValueMapping, b: ForgePicklistValueMapping): boolean {
  return (
    a.object === b.object &&
    a.field === b.field &&
    a.recordType === b.recordType &&
    a.from === b.from
  );
}

/** Whether two references name the same field of the same object. */
function sameField(a: ForgeFieldRef, b: ForgeFieldRef): boolean {
  return a.object === b.object && a.field === b.field;
}

/**
 * The entry of `config` that answers `gap`, or null while none does.
 *
 * A gap the user ignored, or one of an object the run leaves out, is answered
 * whatever else it is. Otherwise an entry answers the gap only when the read
 * offered its kind of decision on it: a default value given to a field does
 * not answer a value of that field the target refuses. A mapping of a value
 * for every record type answers the gap of one of them, after a mapping for
 * that record type.
 */
export function decisionOf(config: ForgeConfig | null, gap: ForgeGap): ForgeKeptDecision | null {
  if (!config) return null;
  if (config.ignoredGaps?.includes(gap.id)) return { kind: 'ignored', gapId: gap.id };
  if (config.excludedObjects?.includes(gap.objectApiName)) {
    return { kind: 'object_excluded', object: gap.objectApiName };
  }
  const offers = new Set(gap.decisions);
  const object = gap.objectApiName;
  if (aboutAValue(gap) && (offers.has('map_value') || offers.has('leave_empty'))) {
    const mappings = (config.picklistValueMappings ?? []).filter(
      (m) => m.object === object && m.field === gap.field && m.from === gap.value,
    );
    const entry =
      mappings.find((m) => m.recordType === gap.recordType) ??
      mappings.find((m) => m.recordType === undefined);
    if (entry && (entry.to === null ? offers.has('leave_empty') : offers.has('map_value'))) {
      return { kind: 'picklist', entry };
    }
  }
  const from = recordTypeFrom(gap);
  if (from !== undefined && offers.has('map_record_type')) {
    const entry = config.recordTypeMappings?.find((m) => m.object === object && m.from === from);
    if (entry) return { kind: 'record_type', entry };
  }
  const field = gap.field;
  if (field === undefined) return null;
  const ref = { object, field };
  if (offers.has('set_default')) {
    const entry = config.defaultValues?.find((d) => sameField(d, ref));
    if (entry) return { kind: 'default', entry };
  }
  if (offers.has('truncate')) {
    const entry = config.truncateFields?.find((f) => sameField(f, ref));
    if (entry) return { kind: 'truncate', entry };
  }
  if (offers.has('leave_empty') && config.fieldExclusions?.[object]?.includes(field)) {
    return { kind: 'field_excluded', entry: ref };
  }
  return null;
}

/** The decision a kept entry stands for, as the tab shows it chosen. */
export function choiceOf(kept: ForgeKeptDecision): ForgeGapChoice {
  switch (kept.kind) {
    case 'picklist':
      return kept.entry.to === null
        ? { kind: 'leave_empty' }
        : { kind: 'map_value', to: kept.entry.to };
    case 'record_type':
      return { kind: 'map_record_type', to: kept.entry.to };
    case 'default':
      return { kind: 'set_default', value: kept.entry.value };
    case 'truncate':
      return { kind: 'truncate' };
    case 'field_excluded':
      return { kind: 'leave_empty' };
    case 'object_excluded':
      return { kind: 'exclude_object' };
    case 'ignored':
      return { kind: 'ignore' };
  }
}

/** A key no other kept decision has, for lists and for telling two apart. */
export function keptDecisionKey(kept: ForgeKeptDecision): string {
  switch (kept.kind) {
    case 'picklist':
      return [
        kept.kind,
        kept.entry.object,
        kept.entry.field,
        kept.entry.recordType ?? '',
        kept.entry.from,
      ].join('|');
    case 'record_type':
      return [kept.kind, kept.entry.object, kept.entry.from].join('|');
    case 'default':
    case 'truncate':
    case 'field_excluded':
      return [kept.kind, kept.entry.object, kept.entry.field].join('|');
    case 'object_excluded':
      return [kept.kind, kept.object].join('|');
    case 'ignored':
      return [kept.kind, kept.gapId].join('|');
  }
}

/**
 * `config` with `key` set to `list`, or without `key` when the list is empty:
 * a config that holds no decision of a kind says nothing of it, as one that
 * never held any.
 */
function withList<K extends keyof ForgeConfig>(
  config: ForgeConfig,
  key: K,
  list: NonNullable<ForgeConfig[K]> & unknown[],
): ForgeConfig {
  const next: ForgeConfig = { ...config };
  if (list.length > 0) next[key] = list;
  else delete next[key];
  return next;
}

/** `config` with the field left out of its object's rows, or no longer. */
function withFieldExcluded(
  config: ForgeConfig,
  ref: ForgeFieldRef,
  excluded: boolean,
): ForgeConfig {
  const exclusions = { ...config.fieldExclusions };
  const fields = (exclusions[ref.object] ?? []).filter((f) => f !== ref.field);
  if (excluded) fields.push(ref.field);
  if (fields.length > 0) exclusions[ref.object] = fields;
  else delete exclusions[ref.object];
  const next: ForgeConfig = { ...config, fieldExclusions: exclusions };
  if (Object.keys(exclusions).length === 0) delete next.fieldExclusions;
  return next;
}

/** `config` with the object in its excluded objects, or no longer. */
export function withObjectExcluded(
  config: ForgeConfig,
  object: string,
  excluded: boolean,
): ForgeConfig {
  const others = (config.excludedObjects ?? []).filter((name) => name !== object);
  return withList(config, 'excludedObjects', excluded ? [...others, object] : others);
}

/** `config` without the entry `kept`. */
export function withoutKept(config: ForgeConfig, kept: ForgeKeptDecision): ForgeConfig {
  switch (kept.kind) {
    case 'picklist':
      return withList(
        config,
        'picklistValueMappings',
        (config.picklistValueMappings ?? []).filter((m) => !samePicklistEntry(m, kept.entry)),
      );
    case 'record_type':
      return withList(
        config,
        'recordTypeMappings',
        (config.recordTypeMappings ?? []).filter(
          (m) => m.object !== kept.entry.object || m.from !== kept.entry.from,
        ),
      );
    case 'default':
      return withList(
        config,
        'defaultValues',
        (config.defaultValues ?? []).filter((d) => !sameField(d, kept.entry)),
      );
    case 'truncate':
      return withList(
        config,
        'truncateFields',
        (config.truncateFields ?? []).filter((f) => !sameField(f, kept.entry)),
      );
    case 'field_excluded':
      return withFieldExcluded(config, kept.entry, false);
    case 'object_excluded':
      return withObjectExcluded(config, kept.object, false);
    case 'ignored':
      return withList(
        config,
        'ignoredGaps',
        (config.ignoredGaps ?? []).filter((id) => id !== kept.gapId),
      );
  }
}

/** `config` with no decision answering `gap`. */
export function withoutGapDecision(config: ForgeConfig, gap: ForgeGap): ForgeConfig {
  const kept = decisionOf(config, gap);
  return kept ? withoutKept(config, kept) : config;
}

/**
 * `config` with `choice` answering `gap`, in place of the decision that
 * answered it. A choice the gap cannot carry — a mapping of a value on a gap
 * about no value, a record type mapping with no record type — leaves the
 * config as it was.
 */
export function withGapDecision(
  config: ForgeConfig,
  gap: ForgeGap,
  choice: ForgeGapChoice,
): ForgeConfig {
  const base = withoutGapDecision(config, gap);
  const object = gap.objectApiName;
  const picklist = (to: string | null): ForgeConfig => {
    if (!aboutAValue(gap)) return config;
    const entry: ForgePicklistValueMapping = {
      object,
      field: gap.field,
      ...(gap.recordType !== undefined ? { recordType: gap.recordType } : {}),
      from: gap.value,
      to,
    };
    return withList(base, 'picklistValueMappings', [
      ...(base.picklistValueMappings ?? []).filter((m) => !samePicklistEntry(m, entry)),
      entry,
    ]);
  };
  switch (choice.kind) {
    case 'map_value':
      return picklist(choice.to);
    case 'leave_empty':
      if (aboutAValue(gap)) return picklist(null);
      return gap.field === undefined
        ? config
        : withFieldExcluded(base, { object, field: gap.field }, true);
    case 'set_default': {
      if (gap.field === undefined) return config;
      const ref = { object, field: gap.field };
      return withList(base, 'defaultValues', [
        ...(base.defaultValues ?? []).filter((d) => !sameField(d, ref)),
        { ...ref, value: choice.value },
      ]);
    }
    case 'truncate': {
      if (gap.field === undefined) return config;
      const ref = { object, field: gap.field };
      return withList(base, 'truncateFields', [
        ...(base.truncateFields ?? []).filter((f) => !sameField(f, ref)),
        ref,
      ]);
    }
    case 'map_record_type': {
      const from = recordTypeFrom(gap);
      if (from === undefined) return config;
      return withList(base, 'recordTypeMappings', [
        ...(base.recordTypeMappings ?? []).filter((m) => m.object !== object || m.from !== from),
        { object, from, to: choice.to },
      ]);
    }
    case 'exclude_object':
      return withObjectExcluded(base, object, true);
    case 'ignore':
      return withList(base, 'ignoredGaps', [
        ...(base.ignoredGaps ?? []).filter((id) => id !== gap.id),
        gap.id,
      ]);
  }
}

/** Every decision `config` holds, kind by kind. */
export function keptDecisions(config: ForgeConfig | null): ForgeKeptDecision[] {
  if (!config) return [];
  return [
    ...(config.picklistValueMappings ?? []).map((entry): ForgeKeptDecision => ({
      kind: 'picklist',
      entry,
    })),
    ...(config.recordTypeMappings ?? []).map((entry): ForgeKeptDecision => ({
      kind: 'record_type',
      entry,
    })),
    ...(config.defaultValues ?? []).map((entry): ForgeKeptDecision => ({ kind: 'default', entry })),
    ...(config.truncateFields ?? []).map((entry): ForgeKeptDecision => ({
      kind: 'truncate',
      entry,
    })),
    ...Object.entries(config.fieldExclusions ?? {}).flatMap(([object, fields]) =>
      fields.map((field): ForgeKeptDecision => ({
        kind: 'field_excluded',
        entry: { object, field },
      })),
    ),
    ...(config.excludedObjects ?? []).map((object): ForgeKeptDecision => ({
      kind: 'object_excluded',
      object,
    })),
    ...(config.ignoredGaps ?? []).map((gapId): ForgeKeptDecision => ({ kind: 'ignored', gapId })),
  ];
}

/**
 * The decisions `config` holds that answer none of `gaps`: brought by a
 * template or a past run, or taken on a gap no read has found again. The run
 * applies them all the same, so the tab lists them where they can be undone.
 */
export function decisionsAnsweringNoGap(
  config: ForgeConfig | null,
  gaps: readonly ForgeGap[],
): ForgeKeptDecision[] {
  const answering = new Set(
    gaps.flatMap((gap) => {
      const kept = decisionOf(config, gap);
      return kept ? [keptDecisionKey(kept)] : [];
    }),
  );
  return keptDecisions(config).filter((kept) => !answering.has(keptDecisionKey(kept)));
}

/** How many gaps that will refuse rows, on objects the run writes, no decision answers yet. */
export function undecidedBlockingGaps(
  gaps: ForgeGapsBySource | undefined,
  config: ForgeConfig | null,
  graph?: ForgeGraph | null,
): number {
  return gapsToShow(gaps, objectsLeftOut(config, graph)).filter(
    (gap) => gap.severity === 'blocking' && decisionOf(config, gap) === null,
  ).length;
}
