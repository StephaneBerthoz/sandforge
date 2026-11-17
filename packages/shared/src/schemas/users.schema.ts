import * as z from 'zod';

import { checkpointOrganizationIdSchema } from './checkpoint.schema.js';

/**
 * Zod schemas of `sandforge users`: the users it sets up in a scratch org, a
 * Developer Edition org or a sandbox — an address the copy put under
 * `.invalid` restored, a user activated, frozen or unfrozen, a profile, the
 * permission sets, the groups of them, the groups and the queues it is given
 * — as a `kind: users` resource of `sandforge.yaml` asks, and what the script
 * answers with `--json`.
 *
 * Each answer holds ids, names and booleans, never a user's value: no
 * address, no name, no password. SandForge resets no password; once an
 * address is restored, its owner asks Salesforce for one with "Forgot your
 * password?".
 *
 * The API restores no address at once. A user's `Email` changed by an admin
 * stays as it was, under `.invalid`, and Salesforce sends a link to the new
 * address: the address changes once its owner clicks it. A run asks the
 * change, and the address awaits that click; a later plan reads it restored.
 *
 * A membership inserted twice is answered with the id of the one already
 * there, as if created. What a run created is therefore what its read before
 * the write did not find, and only that is taken back.
 */

// ─── Names and values ───────────────────────────────────────────────────────

/** The most users one users resource, or one config, lists. */
export const USERS_MAX = 200;
/** The most permission sets one user is given in one entry. */
export const USERS_MAX_PERMISSION_SETS = 50;
/** The most permission set groups one user is given in one entry. */
export const USERS_MAX_PERMISSION_SET_GROUPS = 20;
/** The most groups and queues one user joins in one entry. */
export const USERS_MAX_GROUPS = 50;

/**
 * A username, as Salesforce holds one: shaped like an email address, with no
 * space, 80 characters at most. Production's (`jane.qa@acme.com`) or the
 * sandbox's whole (`jane.qa@acme.com.uat`): the script reads it as given,
 * then as given followed by `.<sandbox>`, and takes exactly one user.
 */
export const usersUsernameSchema = z
  .string()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, {
    error: (issue) =>
      `${String(issue.input)} is not a username: a username is shaped like an email address, ` +
      'as jane.qa@acme.com, or the sandbox’s jane.qa@acme.com.uat',
  })
  .max(80, {
    error: (issue) =>
      `${String(issue.input)} is not a username: Salesforce holds 80 characters at most`,
  });

/** The key a username is compared by: Salesforce reads a username whatever its case. */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}

/** A User's Id, 15 or 18 characters. */
const userIdSchema = z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
  error: 'Not a User Id',
});

/** A Profile's Id. */
const profileIdSchema = z.string().regex(/^00e[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
  error: 'Not a Profile Id',
});

/** A PermissionSetAssignment's Id: what a removal deletes, by it. */
const permissionSetAssignmentIdSchema = z
  .string()
  .regex(/^0Pa[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
    error: 'Not a PermissionSetAssignment Id',
  });

/** A GroupMember's Id: what a removal deletes, by it. */
const groupMemberIdSchema = z.string().regex(/^011[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
  error: 'Not a GroupMember Id',
});

/** An API name: a permission set's `Name`, a group's `DeveloperName`, namespaced ones included. */
function apiNameOf(error: string) {
  return z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { error })
    .max(80);
}

const permissionSetNameSchema = apiNameOf(
  'A permission set is named by its API name, as QA_Tools (Setup > Permission Sets > API Name)',
);
const permissionSetGroupNameSchema = apiNameOf(
  'A permission set group is named by its API name, as Support_Bundle',
);
const groupNameSchema = apiNameOf(
  'A group or a queue is named by its API name (DeveloperName), as QA_Team',
);

/**
 * A profile, by its `Name`, exact: the org's own, in the org's language for a
 * standard profile, which an org set in French names in French. One line,
 * with no space at either end.
 */
const profileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name.trim() === name && !/\p{Cc}/u.test(name), {
    error:
      'A profile is named as Setup > Profiles names it, exactly: one line, no space at its ends',
  });

/** What becomes of a user's address: `restore` takes off the `.invalid` the copy added; `keep` leaves it. */
export const usersEmailChoiceSchema = z.enum(['restore', 'keep'], {
  error:
    'email is restore, which takes off the .invalid the copy added, or keep, the address as it is',
});

const countSchema = z.number().int().nonnegative();

/** A list of names, each once: a name given twice is refused where it stands the second time. */
function namesOnce<T extends z.ZodType<string>>(
  item: T,
  most: number,
  bound: string,
  what: string,
) {
  return z
    .array(item)
    .max(most, { error: bound })
    .superRefine((names, ctx) => {
      const seen = new Set<string>();
      names.forEach((name, index) => {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `${name} is listed twice: name ${what} once`,
          });
        }
        seen.add(key);
      });
    });
}

/**
 * What a user is set up with, all but who it is: the keys of a users
 * resource's `defaults` and of each of its users. Absent, a key leaves the
 * user as it is. A user's key replaces the defaults' whole, a list included:
 * nothing is merged unsaid.
 */
export const usersSettingsShape = {
  email: usersEmailChoiceSchema.optional(),
  active: z.boolean().optional(),
  frozen: z.boolean().optional(),
  profile: profileNameSchema.optional(),
  permissionSets: namesOnce(
    permissionSetNameSchema,
    USERS_MAX_PERMISSION_SETS,
    `A user is given ${USERS_MAX_PERMISSION_SETS} permission sets at most in one entry`,
    'a permission set',
  ).optional(),
  permissionSetGroups: namesOnce(
    permissionSetGroupNameSchema,
    USERS_MAX_PERMISSION_SET_GROUPS,
    `A user is given ${USERS_MAX_PERMISSION_SET_GROUPS} permission set groups at most in one entry`,
    'a permission set group',
  ).optional(),
  groups: namesOnce(
    groupNameSchema,
    USERS_MAX_GROUPS,
    `A user joins ${USERS_MAX_GROUPS} groups and queues at most in one entry`,
    'a group',
  ).optional(),
};

/**
 * The list of users of a users resource, or of a config: 1 to
 * {@link USERS_MAX}, a bound said with the count given and the way out.
 */
export const usersListSchema = <T extends z.ZodType>(user: T) =>
  z
    .array(user)
    .min(1, { error: 'A users resource lists one user at least: username, then what to set up' })
    .max(USERS_MAX, {
      error: (issue) =>
        `${Array.isArray(issue.input) ? issue.input.length : 'more than ' + USERS_MAX} users: ` +
        `a users resource holds ${USERS_MAX} at most: split it in two`,
    });

/**
 * Where each username stands the second time it is given, with where it stood
 * first: a user is named once, whatever its case.
 *
 * @param lists - Each list of users, with the words its place is named by.
 */
export function usernamesTwice(
  lists: ReadonlyArray<{
    at: string;
    path: ReadonlyArray<string | number>;
    users: ReadonlyArray<{ username: string }>;
  }>,
): Array<{ path: Array<string | number>; message: string }> {
  const first = new Map<string, string>();
  const twice: Array<{ path: Array<string | number>; message: string }> = [];
  for (const list of lists) {
    list.users.forEach((user, index) => {
      const key = usernameKey(user.username);
      const earlier = first.get(key);
      if (earlier !== undefined) {
        twice.push({
          path: [...list.path, index, 'username'],
          message: `${user.username} is listed twice (also ${earlier}): one entry per user`,
        });
        return;
      }
      first.set(key, `${list.at}[${index}]`);
    });
  }
  return twice;
}

// ─── The config ──────────────────────────────────────────────────────────────

/**
 * A strict object of the config, refusing a key it does not name with the
 * keys it does, as the file's objects refuse one.
 */
function strictConfigObject<T extends z.core.$ZodLooseShape>(what: string, shape: T) {
  const keys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const named = issue.keys.map((key) => `"${key}"`).join(', ');
      const verb = issue.keys.length === 1 ? 'is not a key' : 'are not keys';
      return `${named} ${verb} of ${what}, which takes ${keys}`;
    },
  });
}

/** One user of the config: who, by username, and what it is set up with. */
export const usersConfigUserSchema = strictConfigObject('a user', {
  username: usersUsernameSchema,
  ...usersSettingsShape,
});

/**
 * What `sandforge users --config <json>` reads: the users a users resource
 * lists, and its defaults, as the file writes them.
 */
export const usersConfigSchema = strictConfigObject('the config', {
  defaults: strictConfigObject('the defaults', usersSettingsShape).optional(),
  users: usersListSchema(usersConfigUserSchema),
}).superRefine((config, ctx) => {
  for (const { path, message } of usernamesTwice([
    { at: 'users', path: ['users'], users: config.users },
  ])) {
    ctx.addIssue({ code: 'custom', path, message });
  }
});

export type UsersEmailChoice = z.infer<typeof usersEmailChoiceSchema>;
export type UsersConfigUser = z.infer<typeof usersConfigUserSchema>;
export type UsersConfig = z.infer<typeof usersConfigSchema>;

/**
 * Each user of a config with the defaults it does not override: a key the
 * user gives, a list included, replaces the defaults' whole.
 */
export function usersWithDefaults(config: UsersConfig): UsersConfigUser[] {
  const defaults = config.defaults ?? {};
  return config.users.map((user) => ({ ...defaults, ...user }));
}

// ─── What changes ────────────────────────────────────────────────────────────

/** What an access does: added by the run, or taken back by it. */
const accessToSchema = z.enum(['added', 'removed']);

/**
 * One change to a user, by what it changes: never a value of the user beyond
 * the booleans and the names the file gives. An address change is asked, and
 * awaits its owner's confirmation: the API restores none at once.
 */
export const usersChangeSchema = z.discriminatedUnion('what', [
  z.strictObject({ what: z.literal('email'), to: z.literal('awaiting') }),
  z.strictObject({ what: z.literal('active'), from: z.boolean(), to: z.boolean() }),
  z.strictObject({ what: z.literal('frozen'), from: z.boolean(), to: z.boolean() }),
  z.strictObject({ what: z.literal('profile'), from: profileNameSchema, to: profileNameSchema }),
  z.strictObject({
    what: z.literal('permissionSet'),
    name: permissionSetNameSchema,
    to: accessToSchema,
  }),
  z.strictObject({
    what: z.literal('permissionSetGroup'),
    name: permissionSetGroupNameSchema,
    to: accessToSchema,
  }),
  z.strictObject({
    what: z.literal('group'),
    name: groupNameSchema,
    /** A public group, or a queue. */
    type: z.enum(['Regular', 'Queue']),
    to: accessToSchema,
  }),
]);

/**
 * A user's address, as read: still under the copy's `.invalid`; its change
 * asked and awaiting its owner's click, the address `.invalid` until then;
 * restored, read without `.invalid`; or kept, as `email: keep` leaves it.
 */
export const usersAddressSchema = z.enum(['invalid', 'awaiting', 'restored', 'kept']);

export type UsersChange = z.infer<typeof usersChangeSchema>;
export type UsersAddress = z.infer<typeof usersAddressSchema>;

/** The most changes one user takes in one run: every key, every access added and taken back. */
const USERS_MAX_CHANGES =
  4 + 2 * (USERS_MAX_PERMISSION_SETS + USERS_MAX_PERMISSION_SET_GROUPS + USERS_MAX_GROUPS);

/** What a refusal says: its code, a pipeline's word, and its words, with the user it is of. */
const usersRefusalSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z_]{1,40}$/),
  message: z.string().min(1).max(4_000),
  username: usersUsernameSchema.optional(),
});

/** The org the script reached: never a production org. */
const usersOrgSchema = z.strictObject({
  organizationId: checkpointOrganizationIdSchema,
  kind: z.enum(['scratch', 'developer', 'sandbox']),
  alias: z.string().min(1).max(255).optional(),
  /** The user connected, whom no change may lock out. */
  username: z.string().min(1).max(255),
});

// ─── What a plan answers ─────────────────────────────────────────────────────

/** One user of a plan: who the org says it is, its address as read, and what a run would change. */
export const usersPlanUserSchema = z.strictObject({
  /** The org's username, the sandbox's suffix included; as given when the org has none. */
  username: usersUsernameSchema,
  /** The username the file gave, where it is not the org's: production's form. */
  given: usersUsernameSchema.optional(),
  /** Absent when no user, or more than one, has the username. */
  userId: userIdSchema.optional(),
  /** Its address as read, where the file says what becomes of it. */
  address: usersAddressSchema.optional(),
  /** In the order a run writes them; none when the user is as the file says already. */
  changes: z.array(usersChangeSchema).max(USERS_MAX_CHANGES),
  /** The emails Salesforce would send to this person: the link of an address asked back. */
  emailsToPeople: countSchema.optional(),
});

/** The licenses the activations and the profiles of a plan take, as `UserLicense` counts them. */
const usersLicenseSchema = z.strictObject({
  name: z.string().min(1).max(255),
  total: countSchema,
  used: countSchema,
  /** The licenses a run would take more. */
  toUse: countSchema,
});

/** What `sandforge users plan --json` answers, and the dry run of an apply: what a run would do. */
export const usersPlanAnswerSchema = z.strictObject({
  org: usersOrgSchema,
  /** In the order the config lists them. */
  users: z.array(usersPlanUserSchema).max(USERS_MAX),
  licenses: z.array(usersLicenseSchema).max(100).optional(),
  /** The emails Salesforce would send to people, all users together. */
  emailsToPeople: countSchema,
  /** The requests a run would send. */
  apiRequests: countSchema,
  /** What refuses a run now: a run refused writes nothing. */
  refusals: z
    .array(usersRefusalSchema)
    .max(USERS_MAX + 20)
    .optional(),
});

export type UsersPlanUser = z.infer<typeof usersPlanUserSchema>;
export type UsersPlanAnswer = z.infer<typeof usersPlanAnswerSchema>;

// ─── What an apply answers ───────────────────────────────────────────────────

/** Records of access by their ids. */
const usersAccessIdsSchema = z.strictObject({
  permissionSetAssignments: z
    .array(permissionSetAssignmentIdSchema)
    .max(USERS_MAX_PERMISSION_SETS + USERS_MAX_PERMISSION_SET_GROUPS),
  groupMembers: z.array(groupMemberIdSchema).max(USERS_MAX_GROUPS),
});

/**
 * One user of a run: what it was before the run's first write — what a
 * removal puts back —, what the run did, in the order it wrote, the records
 * it created, those its read found there before, and the address as it left
 * it.
 */
export const usersAppliedUserSchema = z
  .strictObject({
    username: usersUsernameSchema,
    userId: userIdSchema,
    before: z.strictObject({
      isActive: z.boolean(),
      isFrozen: z.boolean(),
      profileId: profileIdSchema,
    }),
    done: z.array(usersChangeSchema).max(USERS_MAX_CHANGES),
    /** What the run created, which a removal deletes by id. */
    created: usersAccessIdsSchema,
    /** What the read before the write found there already: never taken back. */
    found: usersAccessIdsSchema.optional(),
    address: usersAddressSchema.optional(),
    /** What the org refused of the user, in its code and its words: the run is partial. */
    refused: z
      .array(
        z.strictObject({
          change: usersChangeSchema,
          code: z.string().min(1).max(64),
          message: z.string().min(1).max(4_000),
        }),
      )
      .max(USERS_MAX_CHANGES)
      .optional(),
  })
  .superRefine((user, ctx) => {
    const found = new Set([
      ...(user.found?.permissionSetAssignments ?? []),
      ...(user.found?.groupMembers ?? []),
    ]);
    for (const id of [...user.created.permissionSetAssignments, ...user.created.groupMembers]) {
      if (!found.has(id)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['created'],
        message: `${id} is both created and found there before: an id is one or the other`,
      });
    }
  });

/** How a run of `sandforge users` ended: 0, 1 refused before its first write, 3 partial. */
const usersStatusSchema = z.enum(['success', 'partial', 'failure', 'cancelled']);

/** What `sandforge users apply --json` answers. */
export const usersApplyAnswerSchema = z.strictObject({
  org: usersOrgSchema,
  /** The run's rank, which `remove --run <n>` takes back. */
  run: z.number().int().positive().max(999_999),
  status: usersStatusSchema,
  users: z.array(usersAppliedUserSchema).max(USERS_MAX),
  emailsToPeople: countSchema,
  apiRequests: countSchema,
  refusals: z
    .array(usersRefusalSchema)
    .max(USERS_MAX + 20)
    .optional(),
});

export type UsersAppliedUser = z.infer<typeof usersAppliedUserSchema>;
export type UsersApplyAnswer = z.infer<typeof usersApplyAnswerSchema>;

// ─── What a removal answers ──────────────────────────────────────────────────

/** One user of a removal: what it undid, and what it kept with why. */
const usersRemovedUserSchema = z.strictObject({
  username: usersUsernameSchema,
  userId: userIdSchema,
  undone: z.array(usersChangeSchema).max(USERS_MAX_CHANGES),
  kept: z
    .array(z.strictObject({ change: usersChangeSchema, why: z.string().min(1).max(2_000) }))
    .max(USERS_MAX_CHANGES)
    .optional(),
});

/** What `sandforge users remove --run <n> --json` answers. */
export const usersRemoveAnswerSchema = z.strictObject({
  org: usersOrgSchema,
  run: z.number().int().positive().max(999_999),
  status: usersStatusSchema,
  users: z.array(usersRemovedUserSchema).max(USERS_MAX),
  apiRequests: countSchema,
  refusals: z
    .array(usersRefusalSchema)
    .max(USERS_MAX + 20)
    .optional(),
});

export type UsersRemoveAnswer = z.infer<typeof usersRemoveAnswerSchema>;
