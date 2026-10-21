# Forge: Dev Sandbox Quickstart

> **Goal:** clone a real record and the records around it from one org into another, a partial-copy sandbox into your dev sandbox say, in about a minute.

Forge needs two orgs: one that holds the records, and one to fill. With a single empty org and nothing to copy, start with [Seed's templates](modules/seed.md#quick-start) instead. The [Forge reference](forge-reference.md) says what each step below reads, checks, writes and keeps, and what the clone command takes.

## Why Forge?

Hand-crafting test data for a dev sandbox takes time. Pick a real record on a partial-copy / full-copy sandbox, and Forge clones it + the related records (Account, Contacts, Opportunities, Cases…) into your dev sandbox with full referential integrity.

What it handles for you ([in full](forge-reference.md#what-forge-handles-for-you)):

- **Record-scoped clone**: only the transitive closure of the root record (1 Case → ~50 records, instead of every row of every related table)
- **RecordType cross-org**: re-mapped automatically by `DeveloperName`
- **Reference data**: `BusinessHours` and `OperatingHours` mapped by `Name` instead of cloned
- **Person accounts**: written as person accounts where the target has them, and as business accounts by their name where it does not ([how](forge-record-scoped.md#person-accounts))
- **Picklist drift**: a value the target would refuse is replaced by its record type's default or left out, and the results say which
- **Currencies**: a currency the target does not hold active goes in one it does, the amounts converted at the source's rates ([how](forge-reference.md#simulate-a-run))
- **Validation rules of the target**: a record a rule refuses on a field it names is written again without that field, and the results say which field and why
- **Cycle FKs** (Account ↔ Contact): 2-pass insert + UPDATE
- **Required parents outside the graph**: read by id, with what they cannot be written without; "Auto-fetch parents" copies what that leaves
- **Upsert via External Id** (command line only, `--upsert`): re-runs patch existing rows instead of failing on `DUPLICATE_VALUE`; the wizard always inserts
- **Emails and phone numbers, neutralized by default**: addresses under `.invalid` and fictional phone numbers, so the target's automation reaches no one ([how](forge-reference.md#emails-and-phone-numbers))
- **GDPR / PHI presets**: one-click anonymization for Email, Phone, Address, Birthdate (4 starter presets)

## 60-second wizard quickstart

The main Forge journey, end to end — from a real record to a populated sandbox:

```
1. Connect your orgs with the Salesforce CLI import
     → Sidebar → SandForge → Organizations → "Import from SF CLI"
       (imports every org already authenticated with the Salesforce CLI)
2. Open Forge (sidebar) and paste a root record ID
     → "Record" tab → input "Record ID or Salesforce URL"
       (e.g. an Account from your UAT / partial-copy org)
     → pick the Source Org and the Target Org (your dev sandbox)
3. Click "Discover Graph"
     → Forge walks the relationship graph from your root record
       (Account → Contacts, Opportunities, Cases…)
     → or "Clone directly", to clone as soon as discovery answers,
       with no stop on the graph or on Review (see below)
4. Tune the options:
     • Depth: "Direct only" / "Full tree" / "Custom depth"
     • "Records per object" — cap rows per object (Smart / 10…1000 / All);
       Smart caps nothing of one record's graph and 100 of a SOQL run, and
       Results, a simulation and the confirmation before the write name
       the objects a cap stopped with rows left
     • "Anonymize PII" — protect sensitive fields on the way in
     • "Skip empty objects" / "Auto-fetch parents"
     • "Keep emails and phone numbers as they are" — off by default:
       every address goes in under .invalid and every phone number as
       a fictional one (see the reference)
     • (Optional) pick an anonymization preset on the Review screen:
       GDPR — default, GDPR — strict, Healthcare — PHI, Internal-test — minimal;
       its Anonymization tab turns anonymization on or off for the run,
       with no new discovery
5. Click "Review & Execute", check the plan, then "Simulate" to see first
   what the run would write and what the target would refuse (see below),
   then "Execute Forge"
     → the "Automation" tab says first what the target runs on the
       records: its flows, Apex triggers, processes and workflow rules,
       what of them sends messages or runs after commit, its assignment
       and duplicate rules, and what keeps a flow quiet (see the reference)
     → records are inserted into your target sandbox with their IDs
       remapped (see the "ID Remaps" tab in the results); a record type
       with no active record type of the same API name on the target
       keeps its source Id, and the SandForge log names it
     → (Optional) tick "Copy the files of the cloned records" on the
       Review screen first (see the reference)
```

The results screen groups any failures by object/stage with
Salesforce-code → human-friendly explanation + action hint. What counts no
failed record and skips no object — a lookup left empty because its record is
not in the clone, rows the platform writes itself, a check of the target that
could not be made — is listed apart, under **Execution notes**, with the same
hints: no total and no audit entry counts it as a failure.

> In a hurry? The "Template" tab ships starter graphs (Account 360,
> Case Workflow, Lead → Opportunity) and the "Quick start" button skips
> discovery entirely — record counts are then queried during execution.

## Clone directly

**Clone directly**, under **Discover Graph**, runs the discovery and, once it answers, the clone of what it found, without stopping on the graph or on the Review screen: it lands on the execution screen, which says the review was skipped. The run is sent as **Execute Forge** sends it when nothing was changed on Review:

- the objects discovery included, but those a template or a past run put back in the form leaves out, and, with **Anonymize PII** on, the personal fields it selected on each — narrowed to the preset a template or an earlier Review in the panel kept, then to the fields a template kept, if any — each anonymized with the method set for its category;
- the decisions a template or a past run brought ([Gaps](forge-reference.md#gaps-and-their-decisions));
- the email addresses and phone numbers neutralized, unless **Keep emails and phone numbers as they are** is on;
- no file: copying the files is an option of the Review screen;
- no simulation: **Simulate**, on the Review screen, runs one first ([below](#simulate-a-run)).

What the path skips, and what still guards it, is in [the reference](forge-reference.md#clone-directly): every check of [Before the run writes](forge-reference.md#before-the-run-writes) still runs.

## Simulate a run

**Simulate**, beside **Execute Forge** on the Review screen, sends the run as **Execute Forge** would, asking for a simulation. It reads what the real run reads and takes every record through the write stage the real run takes it through — the records held back for want of their parent or for a record type the user the run writes as may not use, the fields the target does not take, the record types and picklist values of the target, the emails and phone numbers neutralized, anonymization, the decisions taken on its gaps — with a writer that writes nothing: no insert, no update, no file. Its counts are what the real run would insert, link, hold back and fail before any write.

It puts no question to you: nothing fires in the target, and nothing is written to hold back. A production target is refused all the same. A simulation is kept neither in **Recent runs** nor in the audit trail, which record writes. Its results say it was a simulation and wrote nothing, count the records that **Would be inserted**, and go back to Review with **Back to Review**.

What the target would refuse or change goes to Review as gaps: a picklist value, a field only the target requires, a text or a number too long for its field, a record type the target lacks, a currency it does not hold active, a unique value it already holds. [The reference](forge-reference.md#simulate-a-run) lists what each says and the decisions each takes.

A lookup filter is not among them: which rows it refuses depends on the records the lookups point at in the target and on the user the run writes as, which a simulation does not evaluate. The read of the target's metadata lists each filter of a lookup the run writes as a warning ([reference](forge-reference.md#what-the-target-runs-as-the-clone-writes)), and a rehearsal names the rows a filter refuses ([below](#rehearse-a-run)).

## Rehearse a run

No Salesforce API validates a record without saving it: only a transaction that is rolled back gives the platform's own verdict — its validation rules, its triggers and flows, its duplicate rules, its restricted picklists. **Rehearse**, beside **Simulate** in Review's action bar, gets that verdict on the rows the run would write, and keeps none of them.

Up to 200 rows, every one is rehearsed; past that, one row per object, record type and set of fields given a value. Each call to the target is rolled back whole, and a VS Code confirmation says first what the rehearsal costs and what a rollback cannot take back: platform events published immediately and callouts already made. Each refusal joins the **Gaps** tab. [The reference](forge-reference.md#rehearse-a-run) says how the calls are made and what the audit trail records.

## Remove what a run created

The Forge page lists your recent runs under **Recent runs**. A run that created records offers **Remove the records this run created**: it deletes from the org the run wrote to the records that run created, and nothing else, children before their parents, into the recycle bin. A record the run linked to because the target already held it is never taken, and a record changed since the run is kept unless you tick **Also remove the records changed since the run, and what was added to them since**.

You type the org's name to go on, and Production Guard refuses a production org. A run past the last twenty whose records are still in the org is listed under **Older runs**, with the same removal. [The reference](forge-reference.md#remove-what-a-run-created) says what a removal takes, keeps and reports, and how **Sweep first** takes back what the target's automation created.

## Going further

- [Graph or table](forge-reference.md#graph-or-table): with `sandforge.forge.graphView` on `auto`, the default, the graph is drawn up to 25 objects and listed in a table past that
- [What the target runs as the clone writes](forge-reference.md#what-the-target-runs-as-the-clone-writes): the **Automation** tab, and what Review reads of the target's metadata
- [Emails and phone numbers](forge-reference.md#emails-and-phone-numbers), neutralized unless you keep them
- [Before the run writes](forge-reference.md#before-the-run-writes): the target, what fires, what the run is about to read and to write
- [Copy the files of the cloned records](forge-reference.md#copy-the-files-of-the-cloned-records)
- [Gaps and their decisions](forge-reference.md#gaps-and-their-decisions), and [Review's controls](forge-reference.md#reviews-controls)
- [Templates](forge-reference.md#templates), kept in the workspace's `.sandforge/forge-templates.json`
- [Verify what a run wrote](forge-reference.md#verify-what-a-run-wrote)
- [Resume a run that stopped](forge-reference.md#resume-a-run-that-stopped)
- [The run's audit entry](forge-reference.md#the-runs-audit-entry)

## From the command line

When you're scripting (CI, batch sandbox refresh), skip the wizard.

Forge's command line is two TypeScript scripts in this repository, `sandforge-clone` and `sandforge-cleanup`, not a published package: there is no `sandforge` command to install. Run them from the root of a checkout, after installing its dependencies and building the shared package they import:

```bash
git clone https://github.com/StephaneBerthoz/sandforge.git
cd sandforge
pnpm install
pnpm build:shared
```

Then, from that directory:

```bash
# Authenticate the orgs (one-time)
sf org login web --alias MY-PARTIAL-COPY
sf org login web --alias MY-DEV

# Clone a record graph (dry-run first, real second)
pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source MY-PARTIAL-COPY \
  --target MY-DEV \
  --depth custom --custom-depth 5 \
  --max 50 \
  --anonymize \
  --dry-run

# When happy, drop --dry-run, and keep the JSON summary of the run
pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source MY-PARTIAL-COPY \
  --target MY-DEV \
  --depth custom --custom-depth 5 \
  --max 50 \
  --json > clone-summary.json

# Take that run back: remove what it created, and nothing else
pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
  --remove clone-summary.json --target MY-DEV

# No summary kept? Clean up instead: preview first, it only prints counts
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV \
  --since today \
  --dry-run

# Then delete, limited to the objects the clone wrote
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV --since today \
  --objects Case,Contact,Account
```

The cleanup does not know what the clone wrote: it selects every record your user created on the target in the `--since` window, including records you made by hand. Read the counts from the preview, and name only the cloned objects in `--objects` before you drop `--dry-run`. A run made in the wizard can instead have exactly its own records removed from **Recent runs** ([above](#remove-what-a-run-created)), and a run of the clone whose `--json` summary you kept can have them removed with `--remove` ([reference](forge-reference.md#the-command-line)).

`--object <ApiName>`, repeated, clones whole tables in place of a record, each `--where <condition>` filtering the `--object` before it:

```bash
pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
  --object Account --where "Industry = 'Energy'" \
  --object Contact --where "Account.Industry = 'Energy'" \
  --source MY-PARTIAL-COPY --target MY-DEV \
  --depth direct --max-total 20000 --dry-run
```

Every flag, what the command prints before it writes, its journal, `--resume`, `--verify`, `--audit` and its exit codes are in [the reference](forge-reference.md#the-command-line). The eight other scripts — Seed, Sync, Autopilot, backups, masking, Frozen Dataset, Compare and Monitor — are in [Command line & CI](../ci-examples/README.md).

## Common errors and what they mean

| Error                                                                                                              | What it means                                                                                                                                                                                                                                                                  | What to do                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DUPLICATE_VALUE` <a name="error-duplicate-value"></a>                                                             | A record with this External Id already exists on target.                                                                                                                                                                                                                       | Re-run from the command line with `--upsert`, or run `sandforge-cleanup` first.                                                                                                                                                                                                                            |
| `INVALID_CROSS_REFERENCE_KEY` <a name="error-invalid-cross-reference-key"></a>                                     | A lookup points at a record the target does not have, often a user such as the owner.                                                                                                                                                                                          | Auto-handled for the owner: Salesforce assigns the running user. For another lookup, create or map that record in the target, or leave the lookup empty and set it after the clone.                                                                                                                        |
| `REQUIRED_FIELD_MISSING` <a name="error-required-field-missing"></a>                                               | A required FK pointed outside the scope.                                                                                                                                                                                                                                       | A record clone reads such a parent itself; otherwise enable "Auto-fetch parents" toggle in the wizard.                                                                                                                                                                                                     |
| `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` <a name="error-invalid-or-null-for-restricted-picklist"></a>             | Value not on target, or not allowed by its record type.                                                                                                                                                                                                                        | Auto-handled: replaced by its record type's default, or left out, and named; refused all the same, the record goes again without it.                                                                                                                                                                       |
| `FIELD_CUSTOM_VALIDATION_EXCEPTION` <a name="error-field-custom-validation-exception"></a>                         | A validation rule of the target refused the record.                                                                                                                                                                                                                            | Auto-handled when the rule names a field: the record goes again without it.                                                                                                                                                                                                                                |
| `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY` <a name="error-cannot-insert-update-activate-entity"></a>                   | A trigger, Flow or process of the target failed on it.                                                                                                                                                                                                                         | Fix or turn off that automation in the target, then retry; a read-only object (audit/history) is skipped pre-flight.                                                                                                                                                                                       |
| `FIELD_INTEGRITY_EXCEPTION` (Asset) <a name="error-field-integrity-exception"></a>                                 | Asset needs at least an Account or Contact.                                                                                                                                                                                                                                    | Enable "Auto-fetch parents" toggle.                                                                                                                                                                                                                                                                        |
| `FIELD_FILTER_VALIDATION_EXCEPTION` <a name="error-field-filter-validation-exception"></a>                         | A lookup filter of the target refuses the record the lookup points at: that record does not meet its criteria there, or the filter checks the running user.                                                                                                                    | Make the filter optional, or deactivate it while you clone, or give that record the values the filter asks for; then retry the failed objects.                                                                                                                                                             |
| `DUPLICATES_DETECTED` <a name="error-duplicates-detected"></a>                                                     | A duplicate rule of the target set to Block refused the record. The clone saves past every rule set to Allow, and links a row to the record it duplicates when the rule names just one.                                                                                        | Deactivate that rule while you clone, or set its action on create to Allow; then retry the failed objects.                                                                                                                                                                                                 |
| `INACTIVE_OWNER_OR_USER` <a name="error-inactive-owner-or-user"></a>                                               | The record would be owned by, or assigned to, a user inactive in the target. The clone leaves each record it creates to the running user: that user comes from an assignment rule or a Flow of the target, or from `--owner-map`.                                              | Point the rule or Flow at an active user or a queue, or reactivate the user, or map the owner to an active one; then retry the failed objects.                                                                                                                                                             |
| `ENTITY_IS_DELETED` <a name="error-entity-is-deleted"></a>                                                         | The record, or one it points at, was deleted in the target: written by an earlier run and linked to by a retry of it, or deleted while the run went on.                                                                                                                        | Restore it from the target's Recycle Bin and retry the failed objects, or run the clone again from Review rather than as a retry.                                                                                                                                                                          |
| `UNABLE_TO_LOCK_ROW` <a name="error-unable-to-lock-row"></a>                                                       | Another operation held the record, or the record it hangs from: a job, an integration, the target's own automation. Usually transient.                                                                                                                                         | Retry the failed objects. If it keeps coming back, wait for the target's jobs and integrations on those records to finish, then retry.                                                                                                                                                                     |
| `REQUEST_LIMIT_EXCEEDED` <a name="error-request-limit-exceeded"></a>                                               | The org has used its API requests for the last 24 hours, or runs too many long requests at once: every request is refused until some free up.                                                                                                                                  | Wait until requests free up (the Monitor page shows the usage), then retry. A write sends up to 200 records a request; a lower depth or fewer records per object takes fewer.                                                                                                                              |
| `INVALID_SESSION_ID` <a name="error-invalid-session-id"></a>                                                       | The session SandForge holds for the org expired, or was ended by a logout, a password change or an administrator: Salesforce refuses every request made with it.                                                                                                               | Authenticate the org again (**Connect Org**, or `sf org login web`), then retry the failed objects, or run the clone again from Review.                                                                                                                                                                    |
| `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY` <a name="error-insufficient-access-on-cross-reference-entity"></a> | The running user cannot read a record the lookup points at, or edit the master of a master-detail: a record it neither owns nor is shared, such as one the target already held, which the clone linked to.                                                                     | Share that record with the running user, give it View All or Modify All on the object, or connect the target with a user who has that access; then retry the failed objects.                                                                                                                               |
| `NUMBER_OUTSIDE_VALID_RANGE` <a name="error-number-outside-valid-range"></a>                                       | A number has more digits before the decimal point than the target's field allows.                                                                                                                                                                                              | Give the field the same length and decimal places in both orgs, or change the source value.                                                                                                                                                                                                                |
| `MALFORMED_ID` <a name="error-malformed-id"></a>                                                                   | A field the target takes as an ID got something else: a lookup on the target that is another type on the source, or a `--map` writing another field into it.                                                                                                                   | Give the field the same type in both orgs, or leave it out with `--exclude Object.Field`.                                                                                                                                                                                                                  |
| `CANNOT_EXECUTE_FLOW_TRIGGER` <a name="error-cannot-execute-flow-trigger"></a>                                     | A Flow of the target, or a process, failed on save; the message names it. A Send Email action fails the save when the org's email deliverability is No access and the action uses an email template or logs the email. A new or refreshed sandbox is set to System email only. | Deactivate or fix that Flow, or give the running user a custom permission its start condition skips (Review's **Automation** tab names them); then retry the failed objects. Deliverability set to All email lets a Send Email action through, and its emails then reach the people on the cloned records. |

The wizard's Errors and Notes panels show an explanation and an action hint under each message they recognize, in the SandForge interface language: English, French, German, Spanish, Japanese or Brazilian Portuguese, and so do the execution screen and the results under the error that stopped a run. A hint whose code has a row above links to that row. Each message the target gave ends with the fields its error named, in brackets, where the message does not already list them: a restricted picklist's refusal names the value it refused and not the field.

What the run answers itself, writing a record again without the fields a refusal names or sending again a call the target never got, is in [the reference](forge-reference.md#refusals-the-run-answers-itself).

## What's next?

- [Forge: Reference](./forge-reference.md)
- [Forge: Record-Scoped Clone (architecture)](./forge-record-scoped.md)
- Sample scenarios: see `packages/extension/examples/`
