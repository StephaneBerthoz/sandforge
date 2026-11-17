/**
 * A saved pipeline exported as a pipeline file, with what the export dialog
 * says of it and the launchers that start it with VS Code closed.
 *
 * Pure: the handler hands it the pipeline as saved, how to read the orgs of
 * the registry, the Sync configurations, the Seed and masking templates and
 * the settings, and the editor's own check of each step. Nothing is written
 * here, and nothing asks an org or the Salesforce CLI anything.
 *
 * What the file holds and never holds is the format's rule
 * (`writePipelineFile` in shared): an org by its alias of its own or not at
 * all, never a username; no secret's value; the settings the steps read where
 * they differ from the defaults. Every note the file carries says what a run
 * of it asks of a person or of the machine it runs on.
 */

import type {
  PipelineDefinition,
  PipelineExport,
  PipelineExportOrg,
  PipelineExportOutcome,
  PipelineExportRefusalCode,
  PipelineExportStep,
  PipelineExportVariable,
  PipelineFileIssue,
  PipelineFileNote,
  PipelineFileNoteCode,
  PipelineFileOrg,
  PipelineFileOrgKind,
  PipelineFileSchedule,
  PipelineFileSettingKey,
  PipelineFileSettings,
  PipelineFileStored,
  PipelineFileSyncConfig,
  PipelineStep,
  PipelineStepType,
  PipelineVariable,
} from '@sandforge/shared';
import {
  PIPELINE_FILE_SETTINGS,
  PIPELINE_STEP_ORG_FIELDS,
  isOwnAlias,
  pipelineFileNameOf,
  registeredOrgType,
  writePipelineFile,
} from '@sandforge/shared';
import { pipelineLaunchers, type LauncherOrg, type LauncherVariable } from './pipelineRunners.js';
import { grantRefusalWords } from './RewindGrants.js';

/** An org as the registry holds it: what the export reads of it, and nothing it writes as it is. */
export interface ExportedOrgSource {
  alias?: string;
  /** Read to tell an alias of its own from the username, never written. */
  username?: string;
  /** The Organization Id, `00D…`. */
  orgId?: string;
  orgType?: string;
  metadata?: { edition?: unknown };
  staging?: boolean;
  organizationName?: string;
  /** How it was connected: every way but a username and password goes through the Salesforce CLI. */
  authMethod?: string;
}

/** What an export is made from. */
export interface PipelineExportInput {
  /** The pipeline as saved, never as the page holds it. */
  pipeline: PipelineDefinition;
  /** A registered org, by the id the registry gave it. */
  org(orgId: string): ExportedOrgSource | undefined;
  /** A saved Sync configuration, as stored, by id. */
  syncConfig(configId: string): unknown;
  /** A Seed template the Seed page saved, as stored, by id. */
  seedTemplate(templateId: string): unknown;
  /** A masking template the DataOps page saved, as stored, by id. */
  maskingTemplate(templateId: string): unknown;
  /** A setting of the extension (`sandforge.<key>`), or `fallback` where none is set. */
  setting<T>(key: string, fallback: T): T;
  sandforgeVersion: string;
  /** When it is exported, as an ISO date. */
  exportedAt: string;
  /** The zone this machine's clock reads: a schedule saved without one is read in it, as the editor reads it. */
  machineTimezone: string;
  /** Now, in epoch milliseconds. */
  now: number;
  /**
   * The editor's check of a step where it sits, as a run makes it before its
   * first step: why the step cannot run, or nothing. Left out, every step is
   * taken to pass it.
   */
  stepRefusal?(step: PipelineStep, index: number): string | undefined;
  /** Every refusal of the editor's check of the whole pipeline, steps' among them. */
  problems?: readonly string[];
  /**
   * Whether the check is made on the machine the file runs on: the command
   * line checks a file through the export before it runs it, and a Rewind
   * step not confirmed there is refused, as its run is. Left out, the export
   * is the page's, for a run on another machine, which confirms the step
   * itself.
   */
  checkedWhereItRuns?: boolean;
}

/**
 * The value every setting a pipeline file carries reads where nobody set it:
 * the manifest's default, which `sandforge.<key>` answers then. A setting at
 * its default is left out of the file, and read at its default where it runs.
 */
export const PIPELINE_SETTING_DEFAULTS: Readonly<Record<PipelineFileSettingKey, number | boolean>> =
  {
    'pipeline.timeout': 300_000,
    'sync.maxRecordsPerObject': 50_000,
    'sync.defaultBatchSize': 200,
    'seed.defaultBatchSize': 200,
    'backup.maxRecordsPerObject': 50_000,
    'backup.maxCount': 10,
    'backup.maxAgeDays': 30,
    'safety.auditLogging': true,
    'safety.confirmAboveRecords': 2_000,
    'grappe.enabled': false,
    'grappe.autoActivateThreshold': 10_000,
    'grappe.grappeSize': 5_000,
  };

/** The step types that write to the org they name. */
const WRITING_STEPS: ReadonlySet<string> = new Set([
  'seed',
  'anonymize',
  'rewind',
  'restore',
  'delete',
]);

/** The triggers only the editor watches, as a note names them. */
const EDITOR_TRIGGERS: Readonly<Record<string, string>> = {
  sandbox_refresh: 'sandbox refresh',
  event: 'event',
  webhook: 'webhook',
  deployment_complete: 'deployment',
};

/** The prefix of a Seed template SandForge ships, which the file names by its id alone. */
const SHIPPED_SEED_TEMPLATE = 'prebuilt-';

/** The prefix of a masking template SandForge ships, which the file names by its id alone. */
const SHIPPED_MASKING_TEMPLATE = 'tpl-';

/** The value of `value` as an object of named fields, or nothing. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A text that names something, or nothing. */
function named(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Whether `record` holds `key` of its own: a key from a saved pipeline is data, and `constructor` is no org. */
function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The org of the file under `key`, of its own: never what an object inherits. */
function fileOrg(orgs: Record<string, PipelineFileOrg>, key: string): PipelineFileOrg | undefined {
  return hasOwn(orgs, key) ? orgs[key] : undefined;
}

/** A value as plain data: what is saved goes out as it was read, and nothing of the store's objects. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** What a pipeline file calls the kind of a registered org. */
function kindOf(org: ExportedOrgSource): PipelineFileOrgKind {
  switch (registeredOrgType(org.orgType ?? '', org.metadata?.edition)) {
    case 'Sandbox':
      return 'sandbox';
    case 'Scratch':
      return 'scratch';
    case 'Developer':
      return 'developer';
    default:
      return 'production';
  }
}

/** An org of the registry as the file holds it: never its username. */
function fileOrgOf(org: ExportedOrgSource): PipelineFileOrg {
  const kind = kindOf(org);
  const alias = isOwnAlias(org.alias, org.username) ? org.alias?.trim() : undefined;
  const name = org.organizationName?.trim();
  return {
    ...(alias !== undefined ? { alias } : {}),
    organizationId: org.orgId ?? '',
    kind,
    // Read of a sandbox alone, as Production Guard reads the mark.
    staging: org.staging === true && kind === 'sandbox',
    ...(name && isOwnAlias(name, org.username) ? { name } : {}),
  };
}

/** How a comment and a note name an org of the file: its alias, its own name, or its key. */
function labelOf(key: string, org: PipelineFileOrg): string {
  return org.alias ?? org.name ?? key;
}

/** A refusal of the export, with nothing written. */
function refused(
  pipelineId: string,
  code: PipelineExportRefusalCode,
  message: string,
  issues?: PipelineFileIssue[],
): PipelineExportOutcome {
  return { exported: false, pipelineId, code, message, ...(issues ? { issues } : {}) };
}

/** An org a step or a Sync configuration names: by its registry id, with how the step uses it. */
interface OrgUse {
  orgId: string;
  /** The step, by its place in the pipeline: two steps may share a name. */
  stepIndex: number;
  stepName: string;
  writes: boolean;
}

/** The orgs each step names, in order: a Sync step's through its configuration. */
function orgUses(
  steps: readonly PipelineStep[],
  syncConfigs: ReadonlyMap<string, PipelineFileSyncConfig>,
): OrgUse[] {
  const uses: OrgUse[] = [];
  steps.forEach((step, stepIndex) => {
    const config = fieldsOf(step.config) ?? {};
    if (step.type === 'sync') {
      const syncConfig = syncConfigs.get(named(config['configId']) ?? '');
      const source = named(syncConfig?.sourceOrgId);
      const target = named(syncConfig?.targetOrgId);
      if (source !== undefined) {
        uses.push({ orgId: source, stepIndex, stepName: step.name, writes: false });
      }
      if (target !== undefined) {
        uses.push({ orgId: target, stepIndex, stepName: step.name, writes: true });
      }
      return;
    }
    const fields = hasOwn(PIPELINE_STEP_ORG_FIELDS, step.type)
      ? (PIPELINE_STEP_ORG_FIELDS[step.type as PipelineStepType] ?? [])
      : [];
    for (const field of fields) {
      const orgId = named(config[field]);
      if (orgId === undefined) continue;
      uses.push({ orgId, stepIndex, stepName: step.name, writes: WRITING_STEPS.has(step.type) });
    }
  });
  return uses;
}

/** A secret variable as the file holds it: without its value. */
function withoutValue({ defaultValue: _value, ...variable }: PipelineVariable): PipelineVariable {
  return variable;
}

/** The environment variable a variable is read from: `SANDFORGE_VAR_` and its name, once each. */
function envNames(variables: readonly PipelineVariable[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const variable of variables) {
    const stem = `SANDFORGE_VAR_${
      variable.name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'VALUE'
    }`;
    let env = stem;
    for (let n = 2; taken.has(env); n += 1) env = `${stem}_${n}`;
    taken.add(env);
    names.set(variable.name, env);
  }
  return names;
}

/** The schedule a file carries, or why there is more than one to carry. */
function scheduleOf(
  pipeline: PipelineDefinition,
  machineTimezone: string,
): PipelineFileSchedule | null | { many: number } {
  // A pipeline whose schedule was handed over at an export keeps its schedule
  // triggers off: an export again carries the schedule all the same.
  const schedules = (pipeline.triggers ?? []).filter(
    (trigger) =>
      trigger.type === 'schedule' &&
      (trigger.enabled || pipeline.runsOutside !== undefined) &&
      named(trigger.config?.cron) !== undefined,
  );
  if (schedules.length > 1) return { many: schedules.length };
  const [schedule] = schedules;
  if (!schedule) return null;
  return {
    cron: (schedule.config.cron ?? '').trim(),
    timezone: named(schedule.config.timezone)?.trim() ?? machineTimezone,
  };
}

/** The settings the file carries: each one the steps read that is not at its default. */
function settingsOf(input: PipelineExportInput): PipelineFileSettings {
  const settings: Record<string, number | boolean> = {};
  for (const key of Object.keys(PIPELINE_FILE_SETTINGS) as PipelineFileSettingKey[]) {
    const fallback = PIPELINE_SETTING_DEFAULTS[key];
    const value = input.setting<unknown>(key, fallback);
    if (value === fallback || value === undefined || value === null) continue;
    settings[key] = value as number | boolean;
  }
  return settings as PipelineFileSettings;
}

/** A note of the file, with the code a page translates it by. */
function note(
  code: PipelineFileNoteCode,
  text: string,
  about: { step?: string; org?: string } = {},
): PipelineFileNote {
  return { code, text, ...about };
}

/** What is gathered before the file is written: everything but the launchers. */
interface Gathered {
  pipelineId: string;
  fileName: string;
  schedule: PipelineFileSchedule | null;
  orgs: Record<string, PipelineFileOrg>;
  cliHolds: Map<string, boolean>;
  uses: OrgUse[];
  syncConfigs: Record<string, PipelineFileSyncConfig>;
  seedTemplates: Record<string, PipelineFileStored>;
  maskingTemplates: Record<string, PipelineFileStored>;
  settings: PipelineFileSettings;
  steps: PipelineStep[];
  variables: PipelineVariable[];
  envs: Map<string, string>;
}

/** Everything the file holds, read from the registry and the stores; or why the export is refused. */
function gather(input: PipelineExportInput): Gathered | PipelineExportOutcome {
  const { pipeline } = input;
  const pipelineId = pipeline.id;
  const steps = plain(pipeline.steps ?? []).map((step) => ({
    ...step,
    config: fieldsOf(step.config) ?? {},
  }));

  const schedule = scheduleOf(pipeline, input.machineTimezone);
  if (schedule !== null && 'many' in schedule) {
    return refused(
      pipelineId,
      'SCHEDULES_MANY',
      `Pipeline "${pipeline.name}" has ${schedule.many} schedules, and a pipeline file carries one: ` +
        'keep one schedule, save, and export again.',
    );
  }

  const syncConfigs: Record<string, PipelineFileSyncConfig> = {};
  const seedTemplates: Record<string, PipelineFileStored> = {};
  const maskingTemplates: Record<string, PipelineFileStored> = {};
  for (const step of steps) {
    const config = step.config;
    if (step.type === 'sync') {
      const configId = named(config['configId']);
      if (configId === undefined || hasOwn(syncConfigs, configId)) continue;
      const stored = fieldsOf(input.syncConfig(configId));
      if (!stored) {
        return refused(
          pipelineId,
          'SYNC_CONFIG_UNKNOWN',
          `Sync step "${step.name}" runs the configuration "${configId}", which is no longer saved: ` +
            'pick a saved configuration in the step, save the pipeline, and export again.',
        );
      }
      syncConfigs[configId] = { ...plain(stored), id: configId } as PipelineFileSyncConfig;
    }
    const templateId = named(config['templateId']);
    if (step.type === 'seed' && templateId && !templateId.startsWith(SHIPPED_SEED_TEMPLATE)) {
      const stored = fieldsOf(input.seedTemplate(templateId));
      // One no longer saved is refused by the step's own check, which names it.
      if (stored) seedTemplates[templateId] = { ...plain(stored), id: templateId };
    }
    if (
      step.type === 'anonymize' &&
      templateId &&
      !templateId.startsWith(SHIPPED_MASKING_TEMPLATE)
    ) {
      const stored = fieldsOf(input.maskingTemplate(templateId));
      if (stored) maskingTemplates[templateId] = { ...plain(stored), id: templateId };
    }
  }

  const uses = orgUses(steps, new Map(Object.entries(syncConfigs)));
  const orgs: Record<string, PipelineFileOrg> = {};
  const cliHolds = new Map<string, boolean>();
  for (const use of uses) {
    if (hasOwn(orgs, use.orgId)) continue;
    const org = input.org(use.orgId);
    if (!org) {
      return refused(
        pipelineId,
        'ORG_UNKNOWN',
        `Step "${use.stepName}" names an org that is no longer registered in SandForge: pick an org ` +
          'in the step, or in its Sync configuration, save, and export again.',
      );
    }
    orgs[use.orgId] = fileOrgOf(org);
    cliHolds.set(use.orgId, org.authMethod !== 'usernamePassword');
  }

  const envs = envNames(pipeline.variables ?? []);
  const variables = plain(pipeline.variables ?? []).map((variable) =>
    variable.type === 'secret' ? withoutValue(variable) : variable,
  );

  return {
    pipelineId,
    fileName: pipelineFileNameOf(pipeline.name),
    schedule,
    orgs,
    cliHolds,
    uses,
    syncConfigs,
    seedTemplates,
    maskingTemplates,
    settings: settingsOf(input),
    steps,
    variables,
    envs,
  };
}

/**
 * Whether `refusal` is a Rewind step's for want of this machine's
 * confirmation (`grantRefusalWords`) in a file for another machine: no
 * refusal of a run of it, which that machine confirms — `--confirm-rewind`
 * or `pipeline confirm` there, as the step's note says
 * (`REWIND_NEEDS_CONFIRMATION`); a confirmation made here does not travel
 * with the file. In the page's words, "open it and type the org's alias",
 * the export marked such a step refused, where a terminal has no page to
 * open. What the check reads after the confirmation, the checkpoint, the
 * run's machine reads in its own store. Checked where it runs, the step is
 * refused, as its run is (`checkedWhereItRuns`).
 */
function confirmedWhereItRuns(
  input: Pick<PipelineExportInput, 'checkedWhereItRuns'>,
  step: Pick<PipelineStep, 'type' | 'name'>,
  refusal: string | undefined,
): boolean {
  return (
    input.checkedWhereItRuns !== true &&
    step.type === 'rewind' &&
    refusal !== undefined &&
    (refusal === grantRefusalWords(step.name, 'never') ||
      refusal === grantRefusalWords(step.name, 'changed'))
  );
}

/** What the dialog and the notes say of each step, in order. */
function stepsOf(
  input: PipelineExportInput,
  gathered: Gathered,
): { steps: PipelineExportStep[]; notes: PipelineFileNote[] } {
  const notes: PipelineFileNote[] = [];
  const steps: PipelineExportStep[] = [];
  const writesOf = (stepIndex: number): string[] =>
    gathered.uses
      .filter((use) => use.stepIndex === stepIndex && use.writes)
      .map((use) => use.orgId);
  gathered.steps.forEach((step, index) => {
    const codes: PipelineFileNoteCode[] = [];
    const add = (code: PipelineFileNoteCode, text: string): void => {
      codes.push(code);
      notes.push(note(code, text, { step: step.name }));
    };
    const checked = input.stepRefusal?.(step, index);
    const refusal = confirmedWhereItRuns(input, step, checked) ? undefined : checked;
    const production = writesOf(index).find(
      (orgId) => fileOrg(gathered.orgs, orgId)?.kind === 'production',
    );
    let fate: PipelineExportStep['fate'] = 'runs';
    let why: string | undefined;
    if (refusal !== undefined) {
      fate = 'refused';
      why = refusal;
      add('STEP_REFUSED', refusal);
    } else if (production !== undefined) {
      fate = 'refused';
      const org = fileOrg(gathered.orgs, production);
      why =
        `Step "${step.name}" writes to "${org ? labelOf(production, org) : production}", a production ` +
        'org: the command line never writes to a production org, whatever an Approval answers.';
      add('STEP_REFUSED', why);
    } else if (step.type === 'approval') {
      fate = 'asks';
      const guardsStaging = gathered.uses.some(
        (use) =>
          use.stepIndex > index &&
          use.writes &&
          fileOrg(gathered.orgs, use.orgId)?.staging === true,
      );
      if (guardsStaging) {
        add(
          'STAGING_NEEDS_PERSON',
          `Approval step "${step.name}" stands before a write to a sandbox marked Staging: only a ` +
            'person at a terminal answers it, never --approve.',
        );
      } else {
        add(
          'APPROVAL_NEEDS_PERSON',
          `Approval step "${step.name}" asks a person: at the terminal of the run, or answered ahead ` +
            `with --approve "${step.name}" for a run with no one at a terminal.`,
        );
      }
    } else if (step.type === 'rewind') {
      fate = 'asks';
      const orgId = named(step.config['orgId']);
      const org = orgId !== undefined ? fileOrg(gathered.orgs, orgId) : undefined;
      add(
        'REWIND_NEEDS_CONFIRMATION',
        `Rewind step "${step.name}" runs once its org's alias is confirmed on the machine of the run: ` +
          `by "sandforge pipeline confirm" at a terminal, or with --confirm-rewind ${org?.alias ?? '<alias>'}.`,
      );
      add(
        'REWIND_CHECKPOINT_ELSEWHERE',
        `Rewind step "${step.name}" rewinds to a checkpoint kept on this machine: on another, ` +
          'import it first (sandforge checkpoint import).',
      );
    } else if (step.type === 'notification') {
      add(
        'NOTIFICATION_PRINTED',
        `Notification step "${step.name}" prints its message in the run's output: there is no ` +
          'VS Code window to show it in.',
      );
    }
    steps.push({
      stepId: step.id,
      name: step.name,
      type: step.type,
      fate,
      notes: codes,
      ...(why !== undefined ? { refusal: why } : {}),
    });
  });
  return { steps, notes };
}

/** What the notes say of each org, and of the variables and triggers that do not travel. */
function otherNotes(input: PipelineExportInput, gathered: Gathered): PipelineFileNote[] {
  const notes: PipelineFileNote[] = [];
  for (const [key, org] of Object.entries(gathered.orgs)) {
    if (org.alias === undefined) {
      notes.push(
        note(
          'ORG_NO_ALIAS',
          `Org "${labelOf(key, org)}" has no alias of its own: give it one with ` +
            `"sf alias set <alias>=<its username>", then run with --org ${key}=<alias>.`,
          { org: key },
        ),
      );
    }
    if (gathered.cliHolds.get(key) === false) {
      const loginUrl = org.kind === 'sandbox' ? ' --instance-url https://test.salesforce.com' : '';
      notes.push(
        note(
          'ORG_NOT_SIGNED_IN',
          `The Salesforce CLI of this machine does not hold org "${labelOf(key, org)}": SandForge ` +
            'connected it with a username and password. Sign in to it on the machine of the run: ' +
            `"sf org login web --alias ${org.alias ?? '<alias>'}${loginUrl}".`,
          { org: key },
        ),
      );
    }
  }
  for (const variable of input.pipeline.variables ?? []) {
    if (variable.type !== 'secret') continue;
    notes.push(
      note(
        'SECRET_NOT_EXPORTED',
        `Variable "${variable.name}" is a secret: its value is not in this file. Give it as the ` +
          `run starts with --var-env ${variable.name}=${gathered.envs.get(variable.name)}.`,
      ),
    );
  }
  for (const trigger of input.pipeline.triggers ?? []) {
    const what = EDITOR_TRIGGERS[trigger.type];
    if (!trigger.enabled || what === undefined) continue;
    notes.push(
      note(
        'TRIGGER_NOT_EXPORTED',
        `Its ${what} trigger starts it in the editor alone: a run of this file starts on its ` +
          'schedule, or by hand.',
      ),
    );
  }
  return notes;
}

/** The orgs as the dialog lists them, in the order the steps name them. */
function orgsOf(gathered: Gathered): PipelineExportOrg[] {
  return Object.entries(gathered.orgs).map(([key, org]) => {
    const uses = gathered.uses.filter((use) => use.orgId === key);
    const writing = new Set(uses.filter((use) => use.writes).map((use) => use.stepIndex));
    const writtenBy = [...new Set(uses.filter((use) => use.writes).map((use) => use.stepName))];
    const readBy = [
      ...new Set(uses.filter((use) => !writing.has(use.stepIndex)).map((use) => use.stepName)),
    ];
    return {
      key,
      ...(org.alias !== undefined ? { alias: org.alias } : {}),
      ...(org.name !== undefined ? { name: org.name } : {}),
      kind: org.kind,
      staging: org.staging,
      cliHolds: gathered.cliHolds.get(key) ?? false,
      writtenBy,
      readBy,
    };
  });
}

/** The variables as the dialog lists them, with the environment variable a launcher reads each from. */
function variablesOf(gathered: Gathered): PipelineExportVariable[] {
  return gathered.variables.map((variable) => {
    const valued = variable.type !== 'secret' && variable.defaultValue !== undefined;
    const fromEnv = variable.type === 'secret' || (variable.required && !valued);
    const env = gathered.envs.get(variable.name);
    return {
      name: variable.name,
      type: variable.type,
      required: variable.required,
      valued,
      ...(fromEnv && env !== undefined ? { env } : {}),
    };
  });
}

/** The file written from what was gathered, or the issues a reader would refuse it for. */
function written(
  input: PipelineExportInput,
  gathered: Gathered,
  notes: PipelineFileNote[],
): ReturnType<typeof writePipelineFile> {
  const { pipeline } = input;
  return writePipelineFile({
    exportedAt: input.exportedAt,
    sandforgeVersion: input.sandforgeVersion,
    pipeline: {
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description ?? '',
      // As saved, each field as it was written: an anonymous copy, which the
      // file's open step type takes as it is.
      steps: gathered.steps.map((step) => ({ ...step })),
      variables: gathered.variables,
      tags: pipeline.tags ?? [],
    },
    schedule: gathered.schedule,
    orgs: gathered.orgs,
    syncConfigs: gathered.syncConfigs,
    seedTemplates: gathered.seedTemplates,
    maskingTemplates: gathered.maskingTemplates,
    settings: gathered.settings,
    notes,
  });
}

/**
 * Export a saved pipeline: its file, what the dialog says of it, and the
 * three launchers. Refused, with what to do, when the file cannot say what
 * the pipeline does: an org or a configuration no longer there, two
 * schedules, a value a reader would refuse.
 */
export function buildPipelineExport(input: PipelineExportInput): PipelineExportOutcome {
  const pipelineId = input.pipeline.id;
  const gathered = gather(input);
  if ('exported' in gathered) return gathered;
  const { steps, notes: stepNotes } = stepsOf(input, gathered);
  const notes = [...stepNotes, ...otherNotes(input, gathered)];
  const file = written(input, gathered, notes);
  if (!file.ok) {
    return refused(
      pipelineId,
      'FILE_INVALID',
      `The pipeline file would not read: ${file.issues.length} ` +
        `${file.issues.length === 1 ? 'issue' : 'issues'}. Fix each where the pipeline, its orgs ` +
        'or the settings hold it, and export again.',
      file.issues,
    );
  }
  const orgs = orgsOf(gathered);
  const variables = variablesOf(gathered);
  const launcherOrgs: LauncherOrg[] = orgs.map((org) => ({
    key: org.key,
    ...(org.alias !== undefined ? { alias: org.alias } : {}),
    label: org.alias ?? org.name ?? org.key,
  }));
  const launcherVariables: LauncherVariable[] = variables.flatMap((variable) =>
    variable.env !== undefined
      ? [{ name: variable.name, env: variable.env, secret: variable.type === 'secret' }]
      : [],
  );
  const exported: PipelineExport = {
    fileName: gathered.fileName,
    text: file.text,
    digest: file.file.digest,
    schedule: gathered.schedule,
    steps,
    orgs,
    variables,
    launchers: pipelineLaunchers({
      pipelineId,
      pipelineName: input.pipeline.name,
      fileName: gathered.fileName,
      sandforgeVersion: input.sandforgeVersion,
      exportedAt: input.exportedAt,
      schedule: gathered.schedule,
      machineTimezone: input.machineTimezone,
      now: input.now,
      orgs: launcherOrgs,
      variables: launcherVariables,
      approvals: steps
        .filter((step) => step.type === 'approval' && step.fate === 'asks')
        .map((step) => ({ name: step.name, staging: step.notes.includes('STAGING_NEEDS_PERSON') })),
      rewinds: gathered.steps
        .filter((step) => step.type === 'rewind')
        .map((step) => {
          const orgId = named(step.config['orgId']);
          const alias = orgId !== undefined ? fileOrg(gathered.orgs, orgId)?.alias : undefined;
          return { name: step.name, ...(alias !== undefined ? { alias } : {}) };
        }),
    }),
    notes,
    // What a run of the file refuses too: a Rewind confirmed on the run's machine is not.
    problems: (input.problems ?? []).filter(
      (problem) => !gathered.steps.some((step) => confirmedWhereItRuns(input, step, problem)),
    ),
  };
  return { exported: true, pipelineId, ...exported };
}

/**
 * The digest an export of the pipeline writes now, or undefined when none can
 * be written: what a pipeline whose schedule was handed over is compared with,
 * to tell the page the file exported then lacks a change made since.
 */
export function pipelineExportDigest(input: PipelineExportInput): string | undefined {
  const gathered = gather(input);
  if ('exported' in gathered) return undefined;
  // The notes are no part of the digest: none is worked out here.
  const file = written(input, gathered, []);
  return file.ok ? file.file.digest : undefined;
}
