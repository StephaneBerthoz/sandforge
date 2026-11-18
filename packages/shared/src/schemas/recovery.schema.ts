import * as z from 'zod';

import { checkpointIdSchema, checkpointOrganizationIdSchema } from './checkpoint.schema.js';
import { auditEndpointsSchema, hostSchema } from './env.schema.js';
import { usersAddressSchema, usersConfigSchema, usersUsernameSchema } from './users.schema.js';

/**
 * What the Back into service page and the extension say to each other about a
 * sandbox after its refresh: the steps that bring it back, how far each is,
 * and what the page asks of the users and the audits.
 *
 * A step's status is deduced from what SandForge keeps — the users runs, the
 * checkpoints and their replays, the masking runs, the inventories of the
 * scheduled jobs —, never ticked by hand. Only a skip, and a mark done on the
 * two checks a person makes by eye, are kept, with the end of the recovery.
 * Every status says why by a code, which the page translates: never by the
 * English of the command line.
 */

// ─── The steps ───────────────────────────────────────────────────────────────

/** The steps, in the order the page lists them: that of `sandforge env apply`. */
export const RECOVERY_STEP_IDS = [
  'refresh',
  'users',
  'masking',
  'replay',
  'frozen',
  'testersCheckpoint',
  'deliverability',
  'scheduledJobs',
  'endpoints',
  'handoff',
] as const;

export type RecoveryStepId = (typeof RECOVERY_STEP_IDS)[number];

/**
 * How many steps a recovery has: N of a progress that knows none of them yet
 * applies or not, the refresh's alone.
 */
export const RECOVERY_STEP_COUNT = RECOVERY_STEP_IDS.length;

/**
 * The steps a person may skip: all but the refresh, which is what the page is
 * about.
 */
export const RECOVERY_SKIPPABLE_STEPS = [
  'users',
  'masking',
  'replay',
  'frozen',
  'testersCheckpoint',
  'deliverability',
  'scheduledJobs',
  'endpoints',
  'handoff',
] as const satisfies readonly RecoveryStepId[];

/**
 * The steps a person marks done: the deliverability and the endpoints, read by
 * SandForge and checked by eye in Setup. Every other step is done when what it
 * runs has run.
 */
export const RECOVERY_MARKABLE_STEPS = [
  'deliverability',
  'endpoints',
] as const satisfies readonly RecoveryStepId[];

/** What to keep before the next refresh, in the order the page lists it. */
export const RECOVERY_PREPARATION_IDS = [
  /** A checkpoint "Before refresh", kept until deleted. */
  'beforeRefreshCheckpoint',
  /** The inventory of the scheduled jobs, which the next recovery compares against. */
  'jobsInventory',
  /** The testers to bring back, kept for the sandbox. */
  'testersList',
  /** A pipeline the next refresh starts, from the Sandbox Refresh Post-Processing template. */
  'automation',
] as const;

export type RecoveryPreparationId = (typeof RECOVERY_PREPARATION_IDS)[number];

/** Where a step stands. */
export const RECOVERY_STEP_STATUSES = [
  'todo',
  'done',
  'skipped',
  'notApplicable',
  'refused',
] as const;

export type RecoveryStepStatus = (typeof RECOVERY_STEP_STATUSES)[number];

/**
 * Why a step stands where it does, each code with the one status it explains.
 * The page writes a step's line from its id and this code.
 */
export const RECOVERY_REASON_STATUS = {
  /** The refresh was noticed: by a connection, the Monitor or production's history. */
  refreshDetected: 'done',
  /** What the step runs ran on this org after the refresh: read from its runs. */
  ranAfterRefresh: 'done',
  /** A person marked it done: the deliverability, the endpoints. */
  markedDone: 'done',
  /** Kept for the next refresh: the checkpoint, the inventory, the list, the pipeline. */
  ready: 'done',
  toDo: 'todo',
  /** A person skipped it. */
  skipped: 'skipped',
  /** No refresh was noticed: the page opened on the sandbox all the same. */
  noRefreshDetected: 'notApplicable',
  /** A Developer or Developer Pro sandbox: no production data was copied, none to mask. */
  nothingCopied: 'notApplicable',
  /** No checkpoint of the sandbox was taken before the refresh. */
  noCheckpointBefore: 'notApplicable',
  /** No frozen dataset is kept on this machine. */
  noManifest: 'notApplicable',
  /** No inventory of the jobs was kept before the refresh: nothing to compare against. */
  noInventoryBefore: 'notApplicable',
  /** No user of the sandbox has an address under `.invalid`, nor is frozen or inactive. */
  noUserToBringBack: 'notApplicable',
  /** The sandbox is marked Staging, where a replay is refused. */
  stagingSandbox: 'refused',
} as const satisfies Record<string, RecoveryStepStatus>;

export type RecoveryReason = keyof typeof RECOVERY_REASON_STATUS;

export const RECOVERY_REASONS = Object.keys(RECOVERY_REASON_STATUS) as [
  RecoveryReason,
  ...RecoveryReason[],
];

/**
 * How far a recovery is, n of N: N counts the steps that apply, n those done
 * or skipped. A refused step counts in N and never in n: it is ended by
 * Finish, not by its own.
 */
export function recoveryProgressOf(steps: ReadonlyArray<{ status: RecoveryStepStatus }>): {
  done: number;
  total: number;
} {
  const applying = steps.filter((step) => step.status !== 'notApplicable');
  return {
    done: applying.filter((step) => step.status === 'done' || step.status === 'skipped').length,
    total: applying.length,
  };
}

/**
 * A refreshed sandbox's way back into service as the launcher shows it: one
 * per registered sandbox whose refresh was noticed and whose recovery is not
 * finished, sent raw on `sidebar:afterRefresh`.
 */
export interface RecoveryProgress {
  /** The sandbox's registered entry, its SandForge id. */
  orgId: string;
  /** Its name, as the launcher names it. */
  alias: string;
  /** When the refresh was noticed, ISO 8601. */
  detectedAt: string;
  /** Steps done or skipped. */
  done: number;
  /** Steps that apply. */
  total: number;
}

// ─── Shapes shared by the messages ───────────────────────────────────────────

/** A registered org's SandForge id, which every request names its org by. */
const entryIdSchema = z.string().min(1).max(128);

/** An instant, ISO 8601 with its zone. */
const instantSchema = z.iso.datetime({ offset: true });

const countSchema = z.number().int().nonnegative();

const reasonSchema = z.enum(RECOVERY_REASONS);

/** An object's API name, namespaced ones included. */
const objectApiNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { error: 'Not an object API name' })
  .max(80);

/** The most objects step 3 opens Masking with. */
export const RECOVERY_MASK_OBJECTS_MAX = 200;

/** A User Id, 15 or 18 characters. */
const userIdSchema = z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
  error: 'Not a User Id',
});

/** How a users run ended, as `sandforge users` says it. */
const usersRunStatusSchema = z.enum(['success', 'partial', 'failure', 'cancelled']);

/** One step: its status and the code of why. `at`: when it was done or marked. */
const recoveryStepSchema = z.strictObject({
  id: z.enum(RECOVERY_STEP_IDS),
  status: z.enum(RECOVERY_STEP_STATUSES),
  reason: reasonSchema,
  at: instantSchema.optional(),
});

/** One thing to keep before the next refresh: kept already, or to do. */
const recoveryPreparationSchema = z.strictObject({
  id: z.enum(RECOVERY_PREPARATION_IDS),
  status: z.enum(['todo', 'done']),
  reason: reasonSchema,
  at: instantSchema.optional(),
});

/** Of a list of steps or things to keep, the reason that explains another status. */
function reasonsAgainstStatus(
  items: ReadonlyArray<{ status: RecoveryStepStatus; reason: RecoveryReason }>,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  items.forEach((item, index) => {
    const explains = RECOVERY_REASON_STATUS[item.reason];
    if (explains === item.status) return;
    ctx.addIssue({
      code: 'custom',
      path: [path, index, 'reason'],
      message: `${item.reason} explains a step ${explains}, not one ${item.status}`,
    });
  });
}

/** Whether `ids` are `expected`, in that order. */
function inOrder(ids: readonly string[], expected: readonly string[]): boolean {
  return ids.length === expected.length && ids.every((id, index) => id === expected[index]);
}

// ─── What `recovery:status` answers ──────────────────────────────────────────

/**
 * Where a sandbox stands after its refresh: the facts the page shows and each
 * step's status, deduced as the page opens and after each thing it does.
 */
export const recoveryStatusSchema = z
  .strictObject({
    orgId: entryIdSchema,
    alias: z.string().min(1).max(255),
    /**
     * The Production Guard's tier of the org: Staging refuses the replay.
     * Never production, which the page refuses before it reads anything.
     */
    tier: z.enum(['development', 'staging', 'scratch']),
    /** Absent for a scratch org, a Developer Edition, or a sandbox whose type was never read. */
    sandboxType: z.enum(['Developer', 'DeveloperPro', 'Partial', 'Full']).optional(),
    /** The sandbox's My Domain host, which survives the refresh. */
    myDomainHost: hostSchema.optional(),
    /** The Organization Id the sandbox answered with last. */
    organizationId: checkpointOrganizationIdSchema.optional(),
    /** The refresh noticed last; absent when none was. */
    refresh: z
      .strictObject({
        detectedAt: instantSchema,
        evidence: z.enum(['connection', 'monitor', 'production']),
        /** The Organization Id before the refresh. */
        previousOrganizationId: checkpointOrganizationIdSchema.optional(),
        /** The one after, absent while only production's history has reported the refresh. */
        organizationId: checkpointOrganizationIdSchema.optional(),
        previousInstanceName: z.string().min(1).max(40).optional(),
        instanceName: z.string().min(1).max(40).optional(),
        /** The production org whose refresh history reported it, by its name. */
        reportedBy: z.string().min(1).max(255).optional(),
        /** Whether SandForge forgot what it had cached of the org before. */
        cachesForgotten: z.boolean(),
      })
      .optional(),
    /** The newest checkpoint taken of the sandbox before its refresh: what step 4 replays. */
    checkpointBefore: z
      .strictObject({
        checkpointId: checkpointIdSchema,
        name: z.string().min(1).max(255),
        takenAt: instantSchema,
      })
      .optional(),
    /** The frozen dataset kept on this machine: what step 5 loads. */
    frozenManifest: z
      .strictObject({
        frozenAt: instantSchema,
        /** The org it was extracted from, by its name. */
        sourceAlias: z.string().min(1).max(255).optional(),
        objects: countSchema,
        records: countSchema,
      })
      .optional(),
    /** The inventory of the scheduled jobs kept before the refresh, of the same host: what step 8 compares against. */
    inventoryBefore: z
      .strictObject({
        savedAt: instantSchema,
        organizationId: checkpointOrganizationIdSchema,
        jobs: countSchema,
      })
      .optional(),
    /**
     * The objects step 3 opens Masking with, picked: those the last masking
     * of the sandbox addressed (`org`), else those of the last masking run on
     * this machine (`machine`). Absent when none ran here, or the step does
     * not apply.
     */
    maskObjects: z
      .strictObject({
        objects: z.array(objectApiNameSchema).min(1).max(RECOVERY_MASK_OBJECTS_MAX),
        from: z.enum(['org', 'machine']),
      })
      .optional(),
    /** The newest handoff note of the org the sandbox is now, kept on this machine: what Open opens again. */
    handoffNote: z.strictObject({ writtenAt: instantSchema }).optional(),
    /** When a person finished the recovery: the launcher shows it no more, until Resume. */
    finishedAt: instantSchema.optional(),
    /** The last users run of the org the sandbox is now: what step 2 deduces from. */
    lastUsersRun: z
      .strictObject({
        run: z.number().int().positive().max(999_999),
        at: instantSchema,
        status: usersRunStatusSchema,
      })
      .optional(),
    /** The ten steps, in {@link RECOVERY_STEP_IDS}'s order. */
    steps: z.array(recoveryStepSchema),
    /** What to keep before the next refresh, in {@link RECOVERY_PREPARATION_IDS}'s order. */
    beforeNextRefresh: z.array(recoveryPreparationSchema),
    /** Of the steps, as {@link recoveryProgressOf} counts them. */
    done: countSchema,
    total: countSchema,
  })
  .superRefine((status, ctx) => {
    if (
      !inOrder(
        status.steps.map((step) => step.id),
        RECOVERY_STEP_IDS,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `the steps are ${RECOVERY_STEP_IDS.join(', ')}, in that order`,
      });
    }
    if (
      !inOrder(
        status.beforeNextRefresh.map((item) => item.id),
        RECOVERY_PREPARATION_IDS,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['beforeNextRefresh'],
        message: `what to keep is ${RECOVERY_PREPARATION_IDS.join(', ')}, in that order`,
      });
    }
    reasonsAgainstStatus(status.steps, 'steps', ctx);
    reasonsAgainstStatus(status.beforeNextRefresh, 'beforeNextRefresh', ctx);
    const said = recoveryProgressOf(status.steps);
    if (said.done !== status.done || said.total !== status.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['done'],
        message:
          `${status.done} of ${status.total} counted, ` +
          `where the steps say ${said.done} of ${said.total}`,
      });
    }
  });

export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;
export type RecoveryStep = z.infer<typeof recoveryStepSchema>;
export type RecoveryPreparation = z.infer<typeof recoveryPreparationSchema>;

// ─── What a person keeps ─────────────────────────────────────────────────────

/**
 * The key a sandbox's acknowledgements are kept under in the extension's
 * store: its entry, which a refresh keeps, and the org it was before the
 * refresh, which the next refresh changes — the key pipelines started by a
 * refresh are told apart by.
 *
 * @param entryId - The sandbox's registered entry.
 * @param before - The Organization Id before the refresh; when the refresh
 *   named none, the instant it was noticed.
 */
export function recoveryAckKey(entryId: string, before: string): string {
  return `recovery:${entryId}:${before}`;
}

/** Why a step cannot be marked done by hand, or undefined when it can. */
function notMarkable(step: RecoveryStepId, mark: string): string | undefined {
  if (mark !== 'done' || (RECOVERY_MARKABLE_STEPS as readonly string[]).includes(step)) {
    return undefined;
  }
  return (
    `${step} is deduced from what ran: only ` +
    `${RECOVERY_MARKABLE_STEPS.join(' and ')} are marked done by hand`
  );
}

/** A sandbox's acknowledgements, under {@link recoveryAckKey}. */
export const recoveryAcksSchema = z
  .strictObject({
    steps: z
      .partialRecord(z.enum(RECOVERY_SKIPPABLE_STEPS), z.enum(['skipped', 'done']))
      .default({}),
    /** When a person finished the recovery: the launcher shows it no more. */
    finishedAt: instantSchema.optional(),
  })
  .superRefine((acks, ctx) => {
    for (const [step, mark] of Object.entries(acks.steps)) {
      const why = notMarkable(step as RecoveryStepId, mark);
      if (why) ctx.addIssue({ code: 'custom', path: ['steps', step], message: why });
    }
  });

export type RecoveryAcks = z.infer<typeof recoveryAcksSchema>;

// ─── What the page asks ──────────────────────────────────────────────────────

/**
 * `recovery:status`, `recovery:users:list`, `recovery:handoff`,
 * `recovery:handoff:open`: the org asked about.
 */
export const recoveryOrgPayloadSchema = z.strictObject({ orgId: entryIdSchema });

/**
 * `recovery:users:plan` and `recovery:users:apply`: the users chosen, in the
 * format of `sandforge users --config`, and what the person accepts this time.
 * An acceptance is said at each run and kept nowhere; a run that does not say
 * one is refused.
 */
export const recoveryUsersRunPayloadSchema = z.strictObject({
  orgId: entryIdSchema,
  config: usersConfigSchema,
  /** The run this one replaces, converging from what it held: `--replaces`. */
  replaces: z.number().int().positive().max(999_999).optional(),
  /** Salesforce emails each person whose address is asked back: `--accept-user-emails`. */
  acceptUserEmails: z.boolean(),
  /** What runs in the org may email people: `--accept-emails`. */
  acceptEmails: z.boolean(),
  /** Write although the org runs automation on User: `--accept-automation`. */
  acceptAutomation: z.boolean(),
});

/** `recovery:users:config:save` and `recovery:users:config:export`: the list, as `users.json` holds it. */
export const recoveryUsersConfigPayloadSchema = z.strictObject({
  orgId: entryIdSchema,
  config: usersConfigSchema,
});

/**
 * `recovery:audit`: the audits to read, as `sandforge env audit` reads them,
 * and whether to keep the inventory of the jobs read now for the next refresh.
 */
export const recoveryAuditPayloadSchema = z.strictObject({
  orgId: entryIdSchema,
  asked: z.strictObject({
    deliverability: z.boolean(),
    schedules: z.boolean(),
    /** Not read, or read with production's other hosts and the fields that hold a URL. */
    endpoints: z.union([z.literal(false), auditEndpointsSchema.required()]),
  }),
  save: z.boolean(),
});

/**
 * `recovery:ack`: a step skipped, marked done or cleared, the recovery
 * finished, or resumed — its end taken back, the launcher leading with it
 * again.
 */
export const recoveryAckPayloadSchema = z.discriminatedUnion('what', [
  z
    .strictObject({
      orgId: entryIdSchema,
      what: z.literal('step'),
      step: z.enum(RECOVERY_SKIPPABLE_STEPS),
      mark: z.enum(['skipped', 'done', 'cleared']),
    })
    .superRefine((ack, ctx) => {
      const why = notMarkable(ack.step, ack.mark);
      if (why) ctx.addIssue({ code: 'custom', path: ['mark'], message: why });
    }),
  z.strictObject({ orgId: entryIdSchema, what: z.literal('finish') }),
  z.strictObject({ orgId: entryIdSchema, what: z.literal('resume') }),
]);

export type RecoveryOrgPayload = z.infer<typeof recoveryOrgPayloadSchema>;
export type RecoveryUsersRunPayload = z.infer<typeof recoveryUsersRunPayloadSchema>;
export type RecoveryUsersConfigPayload = z.infer<typeof recoveryUsersConfigPayloadSchema>;
export type RecoveryAuditPayload = z.infer<typeof recoveryAuditPayloadSchema>;
export type RecoveryAckPayload = z.infer<typeof recoveryAckPayloadSchema>;

// ─── What the users list answers ─────────────────────────────────────────────

/**
 * The most users the list reads: those to bring back, under `.invalid`,
 * frozen or inactive. A run takes `USERS_MAX` of them at most.
 */
export const RECOVERY_USERS_LISTED_MAX = 5_000;

/**
 * A user read in the sandbox: its address as read — under the copy's
 * `.invalid`, its change awaiting its owner's click, or without `.invalid` —,
 * and whether it is active and frozen. Never its address itself, nor the
 * person's name, which the extension does not read: a user is named by its
 * username, as a run file names it.
 */
export const recoveryUserSchema = z.strictObject({
  username: usersUsernameSchema,
  userId: userIdSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  address: usersAddressSchema.exclude(['kept']),
  active: z.boolean(),
  frozen: z.boolean(),
  /** Its profile, by `Name`. */
  profile: z.string().min(1).max(255).optional(),
});

/** `recovery:users:list:response`: the users read, and the list kept for the sandbox, when one is. */
export const recoveryUsersListSchema = z.strictObject({
  orgId: entryIdSchema,
  users: z.array(recoveryUserSchema).max(RECOVERY_USERS_LISTED_MAX),
  /**
   * Every user to bring back, those past the most the list holds included:
   * more than `users` holds when the sandbox has more than a run can take.
   */
  total: countSchema.optional(),
  /** The list kept for the sandbox, which a run starts from: `USERS_MAX` users at most. */
  saved: z.strictObject({ config: usersConfigSchema, savedAt: instantSchema }).optional(),
});

export type RecoveryUser = z.infer<typeof recoveryUserSchema>;
export type RecoveryUsersList = z.infer<typeof recoveryUsersListSchema>;

// ─── What an error says ──────────────────────────────────────────────────────

/**
 * Why a request of the page was not answered, by a code the page translates:
 * a malformed request, an org not registered or not connected, an org that is
 * not a sandbox, scratch org or Developer Edition — refused before anything is
 * read —, an org that changed between a simulation and its run, a handoff
 * note to open again that is no longer on this machine, a stop, or a failure.
 */
export const RECOVERY_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'ORG_NOT_FOUND',
  'NOT_CONNECTED',
  'NOT_A_DEVELOPMENT_ORG',
  'ORG_CHANGED',
  'NOTE_NOT_FOUND',
  'CANCELLED',
  'FAILED',
] as const;

export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number];

/** `recovery:error`: the code, the English for the log, and the step it is of, when one. */
export const recoveryErrorPayloadSchema = z.strictObject({
  code: z.enum(RECOVERY_ERROR_CODES),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
  step: z.enum(RECOVERY_STEP_IDS).optional(),
});

export type RecoveryErrorPayload = z.infer<typeof recoveryErrorPayloadSchema>;
