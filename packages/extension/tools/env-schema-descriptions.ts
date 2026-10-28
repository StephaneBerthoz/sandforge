/**
 * What the editor says of each key of `sandforge.yaml` as it is hovered or
 * offered: one English text per node of the JSON Schema `write-env-schema.ts`
 * writes, by the node's path. The script lays each text on its node as both
 * `markdownDescription` and `description`.
 *
 * The texts live here rather than in the zod schema (`.describe()` or
 * `.meta()` in `env.schema.ts`): nothing of them reaches the bundle the
 * extension runs, `validate` refuses what it refused, and a text set on a
 * shared piece of the schema — the API name every object, field and table
 * key is — would say one key's meaning of all the others.
 *
 * A path names a node as a reader of the file names its key:
 *
 * - keys joined by dots, from the top: `targets.kinds`;
 * - `<word>` for a key of a mapping whose keys the file chooses, the word
 *   {@link ENV_SCHEMA_RECORD_KEYS} gives: `orgs.<role>.alias`;
 * - `[]` for an item of a list: `resources.<name>{seed}.objects[].count`. An
 *   item takes its list's text, and has no entry of its own;
 * - `{x}` for one of the shapes a key may take. A shape told apart by a key
 *   holding a constant is named by that constant, and has a text of its own:
 *   `resources.<name>{forge}`, `….distribution{range}`. Another is named by
 *   its type, `orgs.<role>.alias{object}.env`, and has none: the YAML
 *   extension shows the first text it meets on a hovered node, the shape's
 *   before the key's, and the key's says what each shape holds.
 *
 * A text may name a bound of its own node, `{maximum}`, `{maxItems}`,
 * `{maxLength}` and their like, which the script writes in from the schema:
 * a bound moved in `env.schema.ts` is never left stale in a hover. A key
 * whose values are listed (an `enum`, a `const`) names every one in
 * backticks, which the script checks.
 */
import { ENV_MAX_ORG_ROLES, ENV_MAX_RESOURCES, PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';

import { FORGE_DEFAULT_MAX_TOTAL } from '../cli/env/kinds/forge.js';
import { ANONYMIZATION_TEMPLATES } from '../src/bridge/templates/anonymizationTemplates.js';
import { DEFAULT_MAX_NODES, FULL_DEPTH } from '../src/modules/forge/GraphDiscoveryService.js';
import { LOCALE_DATA } from '../src/modules/seed/LocaleData.js';

/**
 * A whole number as the texts write it, its thousands grouped: `1,000,000`.
 * Done by hand, so the file the script writes is the same whatever locale
 * data the Node that runs it carries.
 */
export function figure(value: number): string {
  if (!Number.isInteger(value)) return String(value);
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return value < 0 ? `-${digits}` : digits;
}

/** Values in backticks, as a text lists them: `a`, `b` or `c`. */
function either(values: readonly string[], last = 'or'): string {
  const quoted = values.map((value) => `\`${value}\``);
  if (quoted.length < 2) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} ${last} ${quoted[quoted.length - 1] ?? ''}`;
}

/**
 * The word a path names a key of each mapping whose keys the file chooses,
 * by the path of the mapping: `orgs.<role>`. A mapping the schema gains
 * stops the script until it is given one here.
 */
export const ENV_SCHEMA_RECORD_KEYS: Readonly<Record<string, string>> = {
  orgs: 'role',
  masking: 'set',
  resources: 'name',
  'resources.<name>{forge}.anonymize.rules': 'category',
};

// ─── Texts several kinds of resource share ──────────────────────────────────

const KIND =
  'What the resource is, and the script that applies it: `seed`, records Seed generates; ' +
  '`forge`, records cloned from an org of `orgs`; `frozen`, a Frozen Dataset loaded; `mask`, ' +
  'records the org already holds, masked with DataOps rules. The keys a resource takes follow ' +
  'from it. A kind this SandForge does not apply is refused, with the kinds it does.';

const DEPENDS_ON =
  'Resources of this file applied before this one, and destroyed after it, by their names, ' +
  '{maxItems} at most. A name that is no resource of the file, the resource itself and a ' +
  'circle of dependencies are refused. When one of them runs again with new records, this ' +
  'one is replaced too. None by default.';

const ACCEPT =
  'Acceptances reviewed in the file, the flags a command line would be given: a pipeline ' +
  'has nobody to ask. None by default.';

const ACCEPT_AUTOMATION_REMOVAL =
  '`true` gives the removals of this resource the `--accept-automation` of the command ' +
  'line, reviewed in the file: the `apply` of a `replace` or a `delete`, and a `destroy`, ' +
  'take its records back although the org runs flows, Apex triggers, processes or workflow ' +
  'rules as they go. Without it, `false` by default, such a removal deletes nothing.';

const ACCEPT_AUTOMATION_UNASKED = (refusal: string): string =>
  `${refusal}: what the org runs as its records are written, it runs unasked. \`true\` here ` +
  'is warned of, and changes nothing.';

const ENV_VARIABLE = (holds: string, example: string): string =>
  `The name of the variable that holds ${holds}, in upper-case letters, digits and ` +
  `underscores, as \`${example}\`. The file holds no secret: never a password or a token.`;

/** A condition held as the clone holds its `--where`. */
const CONDITION_RULES =
  '{maxLength} characters at most, with no comment marker (`--`, `/*`, `*/`), no `;` at its ' +
  'end, and not starting with `-`.';

// ─── The texts ───────────────────────────────────────────────────────────────

const SEED_TEMPLATES = PREBUILT_SEED_TEMPLATES.map((template) => template.id);
const MASK_TEMPLATES = ANONYMIZATION_TEMPLATES.map((template) => template.id);
const SEED_LOCALES = Object.keys(LOCALE_DATA);

/** The text of each node of the schema of `sandforge.yaml`, by its path. */
export const ENV_SCHEMA_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // The file
  version:
    'The version of the file’s format: `1`, at the top of the file. A file written for a ' +
    'later SandForge is refused, and so is a file without it.',
  name:
    'The name of the environment: lower-case letters, digits and dashes, starting with a ' +
    'letter, 63 characters at most. Its state is kept under it for each org, so an ' +
    'environment renamed starts with none.',
  description:
    'What the environment is for, for those who read the file. {maxLength} characters at most.',
  targets:
    'The orgs an apply may write to: the kinds of org, the sandboxes by their Organization Id, ' +
    'and the orgs refused whatever else the file says. Scratch orgs and Developer Edition ' +
    'orgs unless it says otherwise. A production org is refused whatever it says, before ' +
    'anything is read, and no flag lifts it.',
  'targets.kinds':
    'The kinds of org an apply may write to, each once: `scratch`, `developer` (a Developer ' +
    'Edition org) and `sandbox`; `scratch` and `developer` by default. A sandbox is written ' +
    'to only once it is listed under `sandboxes` too. A scratch org says it is a sandbox, as ' +
    'a sandbox does: only the sf CLI tells them apart, by the Dev Hub `sf org display` names ' +
    'for it, so one logged in with an auth URL alone is taken for a sandbox.',
  'targets.sandboxes':
    'The Organization Ids (`00D…`, 15 or 18 characters) of the sandboxes an apply may write ' +
    'to, with `sandbox` among the `kinds`, {maxItems} at most; none by default. Nothing ' +
    'Salesforce says tells a sandbox holding a client’s records from a developer’s, so each ' +
    'one is listed and reviewed with the file. A refresh changes the Id: a sandbox is listed ' +
    'again after each refresh.',
  'targets.protect':
    'Organization Ids (`00D…`, 15 or 18 characters) the file refuses whatever else it says, ' +
    'as a shared sandbox nobody may fill. {maxItems} at most; none by default.',
  orgs:
    'The orgs the resources read from, by a role of your choosing: a forge resource names one ' +
    'as its `source`. A role is lower-case letters, digits and dashes, and none is shaped ' +
    `like a secret; ${ENV_MAX_ORG_ROLES} roles at most. The org to fill is never here: ` +
    '`--org` names it, on every command that reaches an org. None by default.',
  'orgs.<role>':
    'An org the resources read from, by its `alias`: a forge resource that names this role as ' +
    'its `source` clones from it.',
  'orgs.<role>.alias':
    'The sf CLI alias of the org, or `{ env: NAME }`, the variable that holds it, so each ' +
    'pipeline points the role at its own org. `--alias <role>=<alias>` on the command line ' +
    'wins over it, and an unset variable refuses every command but `validate`, exit `2`. An ' +
    'alias holds no space and does not start with `-`. Credentials stay with the sf CLI: log ' +
    'the org in there.',
  'orgs.<role>.alias{object}.env': ENV_VARIABLE('the alias', 'SF_UAT_ALIAS'),
  checkpoint:
    'Checkpoints of the org’s data the environment takes, with `sandforge-checkpoint`: ' +
    '`before` its first write, `after` an apply. Kept in `checkpoints/` of the journal ' +
    'directory, outside the repository, they hold the records’ values in clear. The ' +
    'checkpoint’s own guard refuses a production org and a user without View All Data and ' +
    'Modify All Data, before the first write. None unless asked.',
  'checkpoint.before':
    '`true`: a checkpoint of the org before the first write of the first apply, taken once, ' +
    'which `destroy --rewind` returns the org to. `false`, the default, takes none. A file ' +
    'with a mask resource takes none, exit `2`: it would hold in clear the values the masking ' +
    'writes over, and `destroy --rewind` would put them back.',
  'checkpoint.after':
    'The name of a checkpoint taken once an apply ended `0`, and taken again by each apply ' +
    'that writes: `reset` returns the org to it between two test suites, and `plan` compares ' +
    'the whole org with it. A name is lower-case letters, digits and dashes. `false`, as ' +
    'leaving it out, takes none.',
  'checkpoint.ignoreFields':
    'Fields the checkpoints neither compare nor write back, each once and named with its ' +
    'object, as `Case.Last_Touched__c`: what your automation sets on every save. {maxItems} ' +
    'at most; none by default.',
  masking:
    'Named sets of DataOps rules, which a mask resource names by the set’s name. A name is ' +
    'lower-case letters, digits and dashes, and none is shaped like a secret. None by default.',
  'masking.<set>':
    'A set of DataOps rules, as the DataOps panel saves a template’s: what a mask resource ' +
    'whose `rules` names this set masks with.',
  'masking.<set>.rules':
    'The rules of the set, each a field and the method that masks it: one at least, ' +
    '{maxItems} at most. Held to what the DataOps panel’s save refuses: a field given two ' +
    'rules, and a setting its method does not take.',
  'masking.<set>.rules[].fieldPattern':
    'The field the rule masks, named with its object, as `Contact.Email`. {maxLength} ' +
    'characters at most.',
  'masking.<set>.rules[].ruleType':
    'How the field is masked: `fake` writes a made-up value, an email under ' +
    '`example.invalid`; `mask` writes `*` over its characters but the last `maskKeepLast`; ' +
    '`hash` writes a pseudonym, the same value giving the same pseudonym across the run; ' +
    '`nullify` empties it; `shuffle` reorders its characters; `preserve_format` writes `x` ' +
    'for each letter and `0` for each digit; `constant` writes `constantValue`; `truncate` ' +
    'keeps `truncateLength` characters. No rule carries a salt: the run draws its own key.',
  'masking.<set>.rules[].config':
    'The settings the rule’s method takes, and only those: `constantValue` for `constant`, ' +
    '`maskKeepLast` for `mask`, `truncateLength` and `truncateKeep` for `truncate`. A setting ' +
    'of another method is refused. None by default.',
  'masking.<set>.rules[].config.constantValue':
    'With `constant`: the value written over the field, 1 to {maxLength} characters. A ' +
    '`constant` rule is refused without it.',
  'masking.<set>.rules[].config.maskKeepLast':
    'With `mask`: how many characters at the end it leaves as they are, {minimum} to ' +
    '{maximum}, as `4` for a phone number’s last four. None by default.',
  'masking.<set>.rules[].config.truncateLength':
    'With `truncate`: how many characters it keeps, {minimum} to {maximum}. A `truncate` rule ' +
    'is refused without it.',
  'masking.<set>.rules[].config.truncateKeep':
    'With `truncate`: which end it keeps the characters of, `first` or `last`; `last` by ' +
    'default, since the first characters of a name or an address are the ones that identify. ' +
    '`first` keeps a postal code’s region.',
  resources:
    'What the environment holds, by name: each resource says its `kind`, `seed`, `forge`, ' +
    '`frozen` or `mask`, and the keys that kind takes. Applied in the order `dependsOn` and ' +
    '`from` give, and destroyed the other way. A name is lower-case letters, digits and ' +
    `dashes, and none is shaped like a secret; ${ENV_MAX_RESOURCES} resources at most.`,
  'resources.<name>':
    'A resource of the environment: its `kind`, `seed`, `forge`, `frozen` or `mask`, says ' +
    'what it is and which keys it takes.',

  // The seed kind
  'resources.<name>{seed}':
    'A seed resource: records Seed generates, from one of its built-in templates ' +
    '(`template`) or from the objects, counts and field rules the file gives (`objects`, with ' +
    '`relations`), written by `sandforge-seed` and taken back by its own removal. `seed` keeps ' +
    'the draws, so the same file writes the same records again.',
  'resources.<name>{seed}.kind': KIND,
  'resources.<name>{seed}.dependsOn': DEPENDS_ON,
  'resources.<name>{seed}.accept': ACCEPT,
  'resources.<name>{seed}.accept.automation': ACCEPT_AUTOMATION_REMOVAL,
  'resources.<name>{seed}.template':
    `The id of one of Seed’s built-in templates, those of its gallery: ${either(SEED_TEMPLATES)}. ` +
    'It goes without `objects` and `relations`: the template brings its own. Its content, not ' +
    'its id, is what the state compares: a SandForge whose template changed replaces what ' +
    'the old one wrote.',
  'resources.<name>{seed}.objects':
    'The objects it writes, in this order, each listed once with its count: 1 to {maxItems}. ' +
    'A resource names its `objects` or a built-in `template`, not both.',
  'resources.<name>{seed}.objects[].object':
    'The object it writes, by its API name, as `Account` or `Invoice__c`.',
  'resources.<name>{seed}.objects[].count':
    'How many records of the object it writes, 1 to {maximum}.',
  'resources.<name>{seed}.objects[].fields':
    'Seed’s field rules for the object, as the Seed panel saves them: each a field, a ' +
    '`ruleType` and the `config` it reads. {maxItems} at most.',
  'resources.<name>{seed}.objects[].fields[].fieldApiName':
    'The API name of the field the rule fills, as `LastName` or `Region__c`.',
  'resources.<name>{seed}.objects[].fields[].fieldType':
    'The field’s type, as the Seed panel saves it, as `string` or `phone`; optional. An ' +
    '`ai_generate` rule is checked against it: AI Data Generation writes text, so the rule is ' +
    'refused on any type but `string`, `textarea` and `encryptedstring`.',
  'resources.<name>{seed}.objects[].fields[].ruleType':
    'How the field’s values are made: `static`, `staticValue` on every record; `random`, a ' +
    'whole number from `minValue` to `maxValue`; `sequence`, `sequencePrefix` then a number ' +
    'counted from `sequenceStart` by `sequenceStep`; `formula`, the text of `formula`; ' +
    '`reference`, a record of `referenceObject` the run wrote; `picklist_random`, one of ' +
    '`picklistValues`; `faker`, a value `fakerMethod` draws; `regex`, `regexPattern` with ' +
    'each `#` a digit; `ai_generate`, AI Data Generation, for which the command line that ' +
    'applies the file has no AI key, so give such a field `faker`; `from_csv`, a column of a ' +
    'CSV the Seed panel uploads, which a file has none of.',
  'resources.<name>{seed}.objects[].fields[].config':
    'The settings the rule’s `ruleType` reads, each named after it below. None by default.',
  'resources.<name>{seed}.objects[].fields[].config.staticValue':
    'With `static`: the value written on every record, text, a number, or `true` or `false`.',
  'resources.<name>{seed}.objects[].fields[].config.fakerMethod':
    'With `faker`: what is drawn, as `lastName`, `email`, `phone`, `company` or ' +
    '`futureDate`, or its faker.js name, as `person.lastName`. A method SandForge does not ' +
    'generate is refused before the first record is written.',
  'resources.<name>{seed}.objects[].fields[].config.fakerLocale':
    'With `faker`: the locale this rule draws in, as `fr_FR`, in place of the resource’s ' +
    '`locale`.',
  'resources.<name>{seed}.objects[].fields[].config.sequenceStart':
    'With `sequence`: the number of the first record, `1` by default.',
  'resources.<name>{seed}.objects[].fields[].config.sequenceStep':
    'With `sequence`: what each record adds to the number, `1` by default.',
  'resources.<name>{seed}.objects[].fields[].config.sequencePrefix':
    'With `sequence`: the text written before the number, as `INV-`; none by default.',
  'resources.<name>{seed}.objects[].fields[].config.formula':
    'With `formula`: the value written on every record, as it is written here.',
  'resources.<name>{seed}.objects[].fields[].config.referenceObject':
    'With `reference`, which needs it: the object the field points at, one of its records ' +
    'the run wrote, drawn at random.',
  'resources.<name>{seed}.objects[].fields[].config.referenceField':
    'Kept as the Seed panel saves it: a run does not read it.',
  'resources.<name>{seed}.objects[].fields[].config.picklistValues':
    'With `picklist_random`, which needs one at least: the values drawn from, one at random ' +
    'for each record.',
  'resources.<name>{seed}.objects[].fields[].config.regexPattern':
    'With `regex`, which needs it: the shape of the value, each `#` a digit and every other ' +
    'character written as it is, as `INV-####`. A pattern in regex syntax, without `#`, is ' +
    'written as it is.',
  'resources.<name>{seed}.objects[].fields[].config.csvColumn':
    'With `from_csv`, which needs it: the column of the CSV the Seed panel uploads. A file ' +
    'has no CSV: from the command line the field is left empty.',
  'resources.<name>{seed}.objects[].fields[].config.minValue':
    'With `random`, or a `faker` method that draws a number: the smallest value, `0` by ' +
    'default.',
  'resources.<name>{seed}.objects[].fields[].config.maxValue':
    'With `random`, or a `faker` method that draws a number: the largest value, `1000` by ' +
    'default.',
  'resources.<name>{seed}.objects[].fields[].config.minLength':
    'With `ai_generate`: the shortest value AI Data Generation is asked for.',
  'resources.<name>{seed}.objects[].fields[].config.maxLength':
    'With `ai_generate` or `faker`: the longest value written; a longer one is cut to it.',
  'resources.<name>{seed}.objects[].fields[].config.aiPrompt':
    'With `ai_generate`: what AI Data Generation is asked for the field. The command line ' +
    'that applies the file has no AI key: give such a field a `faker` rule.',
  'resources.<name>{seed}.objects[].recordTypes':
    'The record types its records take, by API name (DeveloperName), several taking turns ' +
    'at random: 1 to {maxItems}. One the object does not have, or the running user may not ' +
    'use, is refused before anything is written. Without it, the running user’s default. ' +
    'Accounts given a person account’s record type are written as person accounts.',
  'resources.<name>{seed}.objects[].batchSize':
    'How many records one REST API call writes, 1 to {maximum}; `200` by default. An object ' +
    'of more than 200 records goes in a Bulk API 2.0 job instead, unless an active duplicate ' +
    'rule of the org watches it.',
  'resources.<name>{seed}.relations':
    'How the records it writes hang from parents: each a lookup, where its parents come from, ' +
    'and how many children each gets. {maxItems} at most. They go with `objects`: a built-in ' +
    '`template` brings its own.',
  'resources.<name>{seed}.relations[].lookup':
    'The lookup the relation fills, named with its object, as `Contact.AccountId`: the child ' +
    'object is one this resource writes.',
  'resources.<name>{seed}.relations[].parents':
    'Where the parents come from: the records of `object` this resource writes; with ' +
    '`existing`, records the org already holds; with `from`, the records another resource ' +
    'of the file created, by their ids. Not `existing` and `from` both.',
  'resources.<name>{seed}.relations[].parents.object':
    'The parent object, by its API name, as `Account`. Given here, or after the resource in ' +
    '`from`, as `from: accounts.Account`; both, they name the same object.',
  'resources.<name>{seed}.relations[].parents.existing':
    'Parents the org already holds, read as the run starts: those `where` selects, `limit` ' +
    'of them at most. How one resource hangs its records from another’s by a value they ' +
    'share; `from` does it by their ids.',
  'resources.<name>{seed}.relations[].parents.existing.where':
    "A SOQL condition, without `WHERE`, selecting the parents, as `Name = 'CI account'`; " +
    'every record of the object without it. {maxLength} characters at most.',
  'resources.<name>{seed}.relations[].parents.existing.limit':
    'How many parents it reads at most, 1 to {maximum}.',
  'resources.<name>{seed}.relations[].parents.from':
    'Another resource of this file, a seed, a forge or a frozen one, whose records are the ' +
    'parents, by the ids its last run created: `accounts`, or `accounts.Account` with the ' +
    'object. This resource then runs after it and is taken back before it, and is replaced ' +
    'when it runs again. A name that is no resource of the file, or the resource itself, is ' +
    'refused.',
  'resources.<name>{seed}.relations[].parents.limit':
    'With `from`: how many of its records it draws at most, the first created first, 1 to ' +
    '{maximum}. A resource that created more than that of the object refuses the relation ' +
    'without it.',
  'resources.<name>{seed}.relations[].distribution':
    'How many children each parent gets: `mode: perParent` with `count`, the same for each; ' +
    '`range` with `min` and `max`, drawn for each; or `ratio` with `ratio`, an average spread ' +
    'evenly.',
  'resources.<name>{seed}.relations[].distribution{perParent}':
    '`perParent`: each parent gets `count` children.',
  'resources.<name>{seed}.relations[].distribution{perParent}.mode':
    'How the children are spread: `perParent`, `count` for each parent; `range`, from `min` ' +
    'to `max`, at random; `ratio`, `ratio` per parent on average.',
  'resources.<name>{seed}.relations[].distribution{perParent}.count':
    'How many children each parent gets, 1 to {maximum}.',
  'resources.<name>{seed}.relations[].distribution{range}':
    '`range`: each parent gets from `min` to `max` children, drawn at random.',
  'resources.<name>{seed}.relations[].distribution{range}.mode':
    'How the children are spread: `range`, from `min` to `max`, at random; `perParent`, ' +
    '`count` for each parent; `ratio`, `ratio` per parent on average.',
  'resources.<name>{seed}.relations[].distribution{range}.min':
    'The fewest children a parent gets, {minimum} to {maximum}, and not above `max`.',
  'resources.<name>{seed}.relations[].distribution{range}.max':
    'The most children a parent gets, 1 to {maximum}.',
  'resources.<name>{seed}.relations[].distribution{ratio}':
    '`ratio`: the children are spread evenly, `ratio` per parent on average.',
  'resources.<name>{seed}.relations[].distribution{ratio}.mode':
    'How the children are spread: `ratio`, `ratio` per parent on average; `perParent`, ' +
    '`count` for each parent; `range`, from `min` to `max`, at random.',
  'resources.<name>{seed}.relations[].distribution{ratio}.ratio':
    'How many children per parent on average, {minimum} to {maximum}, spread evenly: `0.5` ' +
    'gives a child to every other parent.',
  'resources.<name>{seed}.locale':
    'The country the names, addresses and phone numbers are drawn for: ' +
    `${either(SEED_LOCALES)}. Without it, the org’s default locale, or the nearest SandForge ` +
    'has names for.',
  'resources.<name>{seed}.seed':
    'The seed the draws are made with, {minimum} to {maximum}: the same seed writes the same ' +
    'names, companies, values and children per parent again. Without it, the run draws one, ' +
    'and the state keeps it.',

  // The forge kind
  'resources.<name>{forge}':
    'A forge resource: records `sandforge-clone` clones from the org a role of `orgs` names ' +
    '(`source`) into the org to fill, one `record` and what discovery reaches from it, or ' +
    'whole `tables`; taken back by the clone’s own removal. A source that is a production ' +
    'org is refused unless the resource gives `anonymize` or `accept: { realData: true }`.',
  'resources.<name>{forge}.kind': KIND,
  'resources.<name>{forge}.dependsOn': DEPENDS_ON,
  'resources.<name>{forge}.accept': ACCEPT,
  'resources.<name>{forge}.accept.automation': `${ACCEPT_AUTOMATION_REMOVAL} The clone that writes the resource is given it too.`,
  'resources.<name>{forge}.accept.realData':
    '`true`: clone a source that is a production org without anonymizing it, real people’s ' +
    'data written as read into an org built for tests. Without it, `false` by default, such ' +
    'a source is refused unless the resource gives `anonymize`. Emails and phone numbers ' +
    'are neutralized either way, unless `keepContactPoints: true`.',
  'resources.<name>{forge}.source':
    'The org role it clones from: a key of the file’s `orgs`, never the org to fill. A role ' +
    'the file does not declare is refused, with the roles it has. The source is known by ' +
    'its Organization Id: its role’s alias pointed at another org replaces the resource.',
  'resources.<name>{forge}.record':
    'The record it clones, and what discovery reaches from it: by its `id`, or by its ' +
    '`object` and a `where` its source answers with exactly one row, read at each plan. A ' +
    'resource clones a `record` or `tables`, not both.',
  'resources.<name>{forge}.record.id':
    'The record’s id in the source, 15 or 18 letters and digits, for a source that lives on. ' +
    'A scratch org made again gives the same record another id: name it by `object` and ' +
    '`where` then, which `id` goes without.',
  'resources.<name>{forge}.record.object':
    'With `where`: the object of the record, by its API name, as `Case`.',
  'resources.<name>{forge}.record.where':
    'With `object`: a SOQL condition, without `WHERE`, its source answers with exactly one ' +
    "row, as `Subject = 'Login fails'`. Read at each plan: no row, or more than one, blocks " +
    `the resource with the count. ${CONDITION_RULES}`,
  'resources.<name>{forge}.tables':
    'Whole tables it clones, each under its condition, the first the one discovery starts ' +
    'from: 1 to {maxItems}, each object once. A resource clones a `record` or `tables`, not ' +
    'both.',
  'resources.<name>{forge}.tables[].object':
    'The object of the table, by its API name, as `Account`.',
  'resources.<name>{forge}.tables[].where':
    'A SOQL condition, without `WHERE`, selecting the rows it clones; every row without it. ' +
    CONDITION_RULES,
  'resources.<name>{forge}.template':
    'A template the Forge panel’s Template tab saved, by its templates `file` and its `id`: ' +
    'its decisions, exclusions, filters and mappings. The resource’s depth, caps, ' +
    'anonymization and contact points apply over it.',
  'resources.<name>{forge}.template.file':
    'The project’s templates file, from the folder of the file, as ' +
    '`.sandforge/forge-templates.json`: never absolute, and never up out of that folder ' +
    'with `..`.',
  'resources.<name>{forge}.template.id':
    'The id of the template in that file. One it does not hold is refused, with the ids it ' +
    'holds.',
  'resources.<name>{forge}.depth':
    'How many levels of relationships discovery follows from the record or the first ' +
    `table: \`direct\`, one; \`full\`, ${FULL_DEPTH}; \`custom\`, \`customDepth\`. \`custom\` ` +
    'unless the resource or its template says otherwise.',
  'resources.<name>{forge}.customDepth':
    'With `depth: custom`: how many levels discovery goes, 1 to {maximum}; `3` unless the ' +
    'resource or its template says otherwise. Refused with another depth.',
  'resources.<name>{forge}.maxNodes':
    `The most objects discovery takes into the clone, {minimum} to {maximum}; ` +
    `\`${DEFAULT_MAX_NODES}\` by default. A parent an object requires is taken past it.`,
  'resources.<name>{forge}.anonymize':
    'Forge’s anonymization, as a template holds it: the method of each category of personal ' +
    'field (`rules`), and the personal fields of each object (`fields`). A source that is a ' +
    'production org is refused without it or `accept: { realData: true }`, and an ' +
    '`anonymize` that sets no method counts as none.',
  'resources.<name>{forge}.anonymize.presetId':
    'The preset picked in Forge’s Review, as a template keeps it, as `preset:gdpr-default`: ' +
    'where the methods came from. The clone reads `rules` and `fields`, not it.',
  'resources.<name>{forge}.anonymize.rules':
    'The method of each category of personal field, as `{ name: fake, email: fake }`: ' +
    '`email`, `phone`, `name`, `address`, `ssn_id`, `financial` and `other`.',
  'resources.<name>{forge}.anonymize.rules.<category>':
    'The method the fields of the category are anonymized by: `fake`, `mask`, `hash`, ' +
    '`nullify`, `redact`, `shuffle`, `truncate`, `preserve_format`, `age_band` or ' +
    '`generalize`.',
  'resources.<name>{forge}.anonymize.fields':
    'The personal fields anonymized on each object, as Forge’s Review left them, among those ' +
    'discovery finds personal on it, never another; an object it does not name keeps ' +
    'discovery’s choice. {maxItems} at most.',
  'resources.<name>{forge}.anonymize.fields[].objectApiName':
    'The object, by its API name, as `Contact`.',
  'resources.<name>{forge}.anonymize.fields[].fieldNames':
    'The fields of the object anonymized, by their API names, none included: {maxItems} at ' +
    'most.',
  'resources.<name>{forge}.keepContactPoints':
    '`true`: emails and phone numbers are written as read. Without it, `false` by default, ' +
    'the clone neutralizes them before writing, emails under `.invalid` and phone numbers in ' +
    'a fictional range, whatever the source.',
  'resources.<name>{forge}.maxTotal':
    `The most records a run of it may write, 1 to {maximum}; \`${figure(FORGE_DEFAULT_MAX_TOTAL)}\` ` +
    'by default. The plan’s dry run is held to it, and each run to its plan’s count below ' +
    'it: a source that grew between the plan and the run is refused before its first write.',

  // The frozen kind
  'resources.<name>{frozen}':
    'A frozen resource: a Frozen Dataset a person froze beforehand, extracted, pseudonymized ' +
    'and checked, loaded by `sandforge-frozen` and taken back by its own removal. Its ' +
    'configuration is committed (`config`); its dataset is not, and is pinned by its ' +
    'version and its digest (`dataset`).',
  'resources.<name>{frozen}.kind': KIND,
  'resources.<name>{frozen}.dependsOn': DEPENDS_ON,
  'resources.<name>{frozen}.accept':
    'Acceptances reviewed in the file. A frozen resource takes none: see `automation`.',
  'resources.<name>{frozen}.accept.automation': ACCEPT_AUTOMATION_UNASKED(
    'A Frozen load and its removal take no acceptance of automation',
  ),
  'resources.<name>{frozen}.config':
    'The project’s Frozen configuration, as the Frozen panel saves it, from the folder of ' +
    'the file, as `frozen/claims.frozen.json`: committed with the project, it holds no ' +
    'record. Held to Frozen’s own schema, strict, and to no key shaped like a secret: a load ' +
    'never reads the salt. Never absolute, and never up out of that folder with `..`.',
  'resources.<name>{frozen}.dataset':
    'The dataset it loads: where it is (`path`), pinned by its `version` and its `digest`. ' +
    'A dataset whose version or digest is not the file’s blocks the resource, both named: ' +
    'what was reviewed is what is loaded.',
  'resources.<name>{frozen}.dataset.path':
    'The dataset’s folder, by its path from the root, as `/data/claims`, or `{ env: NAME }`, ' +
    'the variable that holds it, where the pipeline downloaded it. It lives outside the ' +
    'repository: one inside the repository that holds the file is refused, exit `2`. A ' +
    'dataset moved keeps the resource: what it is known by is its digest.',
  'resources.<name>{frozen}.dataset.path{object}.env': ENV_VARIABLE(
    'the dataset’s path',
    'SANDFORGE_CLAIMS_DATASET',
  ),
  'resources.<name>{frozen}.dataset.version':
    'The dataset’s version, as its manifest stamps it, as `1.4.0`.',
  'resources.<name>{frozen}.dataset.digest':
    'The dataset’s digest, as `sandforge-frozen --json` gives it: `sha256:` and 64 ' +
    'hexadecimal digits, over the files a load reads, the same wherever the folder is moved.',

  // The mask kind
  'resources.<name>{mask}':
    'A mask resource: records the org already holds, a sandbox copied from production, ' +
    'masked by `sandforge-dataops` with DataOps rules, after a snapshot of the values it ' +
    'writes over, kept on this machine. It creates no record, and `destroy` never unmasks: ' +
    'it deletes the snapshots. Putting the values back is `sandforge-dataops anonymize ' +
    '--restore`, before a destroy.',
  'resources.<name>{mask}.kind': KIND,
  'resources.<name>{mask}.dependsOn': DEPENDS_ON,
  'resources.<name>{mask}.accept':
    'Acceptances reviewed in the file. A mask resource takes none: see `automation`.',
  'resources.<name>{mask}.accept.automation': ACCEPT_AUTOMATION_UNASKED(
    'A DataOps masking takes no acceptance of automation',
  ),
  'resources.<name>{mask}.rules':
    'The DataOps rules it masks with: a set of the file’s `masking`, by its name, as ' +
    '`rules: contact-points`, or a template that ships, as `rules: { template: ' +
    'tpl-gdpr-standard }`. A name that is no set of the file is refused, with the sets it has.',
  'resources.<name>{mask}.rules{object}.template': `The id of a DataOps template that ships: ${either(MASK_TEMPLATES)}.`,
  'resources.<name>{mask}.object':
    'The object it masks, by its API name, as `Contact`. Without it, every object its rules ' +
    'mask, Account’s person accounts among them where the org has them. A rule set with no ' +
    'rule for it is refused before any org is reached, exit `2`: a run would mask nothing.',
  'resources.<name>{mask}.where':
    'With `object`: a SOQL condition, without `WHERE`, selecting the records it masks, as ' +
    '`Email != null`; every record of the object without it. Select them by a field its ' +
    'rules leave as it is: once masked, records selected by a field the rules write over ' +
    `read as gone. ${CONDITION_RULES}`,
};
