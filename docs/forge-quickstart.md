# Forge: Dev Sandbox Quickstart

> **Goal:** clone a real record graph from a partial-copy sandbox into your dev sandbox in 60 seconds.

## Why Forge?

Hand-crafting test data for a dev sandbox takes time. Pick a real record on a partial-copy / full-copy sandbox, and Forge clones it + the related records (Account, Contacts, Opportunities, Cases…) into your dev sandbox with full referential integrity.

What it handles for you:

- **Record-scoped clone**: only the transitive closure of the root record (1 Case → ~50 records, instead of every row of every related table)
- **RecordType cross-org**: re-mapped automatically by `DeveloperName`
- **Reference data**: `BusinessHours` and `OperatingHours` mapped by `Name` instead of cloned
- **Person Account quirks**: `__pc` and auto-`Name` fields stripped per-record
- **Picklist drift**: a value the target would refuse — not one of the field's values there, or not one the record type the row goes in with allows — is replaced by that record type's default or left out, and the results say which, per object and field
- **Validation rules of the target**: a record a rule refuses on a field it names is written again without that field, and the results say which field and why
- **Cycle FKs** (Account ↔ Contact): 2-pass insert + UPDATE
- **Required orphan parents**: single-hop fetch when an Asset references an Account outside the scope
- **Upsert via External Id** (command line only, `--upsert`): re-runs patch existing rows instead of failing on `DUPLICATE_VALUE`, and the summary counts the rows patched as `updated`, apart from the ones created. The wizard always inserts.
- **GDPR / PHI presets**: one-click anonymization for Email, Phone, Address, Birthdate (4 starter presets)

## 60-second wizard quickstart

The main Forge journey, end to end — from a real record to a populated sandbox:

```
1. Connect an org via SFDX import
     → Sidebar → SandForge → Organizations → "SFDX Import"
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
     • "Records per object" — cap rows per object (Smart / 10…1000 / All)
     • "Anonymize PII" — protect sensitive fields on the way in
     • "Skip empty objects" / "Auto-fetch parents"
     • (Optional) pick an anonymization preset on the Review screen:
       GDPR — default, GDPR — strict, Healthcare — PHI, Internal-test — minimal
5. Click "Review & Execute", check the plan, then "Execute Forge"
     → records are inserted into your target sandbox with their IDs
       remapped (see the "ID Remaps" tab in the results); a record type
       with no active record type of the same API name on the target
       keeps its source Id, and the SandForge log names it
     → (Optional) tick "Copy the files of the cloned records" on the
       Review screen first (see below)
```

The results screen groups any failures by object/stage with
Salesforce-code → human-friendly explanation + action hint.

> In a hurry? The "Template" tab ships starter graphs (Account 360,
> Case Workflow, Lead → Opportunity) and the "Quick start" button skips
> discovery entirely — record counts are then queried during execution.

## Clone directly

**Clone directly**, under **Discover Graph**, runs the discovery and, once it answers, the clone of what it found, without stopping on the graph or on the Review screen: it lands on the execution screen, which says the review was skipped. The run is sent as **Execute Forge** sends it when nothing was changed on Review:

- the objects discovery included and, with **Anonymize PII** on, the personal fields it selected on each — narrowed to the preset a template or an earlier Review in the panel kept, if any — each anonymized with the method set for its category;
- no file: copying the files is an option of the Review screen;
- no dry run.

What the path skips is said beside the button: the metadata diff between the two orgs, which runs on the Review screen, is not run. Everything that guards a run still does. The button is off whenever **Discover Graph** is: a source and a target that are two orgs, and an input the extension accepts. Production Guard, its confirmation for a production org and the duplicate-run cooldown answer the run as they answer one started from Review. The page can be left while the discovery runs — for another page of the panel, through the command palette or a shortcut: the run still starts as the discovery answers, and the page comes back on it. A discovery that fails stops on the discovery screen with its error, shown when the page comes back if it failed while the page was away, and one you leave with **Back** starts nothing; **Retry Discovery** then runs the discovery alone, and its graph waits for Review.

## Graph or table

The discovery, Review and execution screens show a graph's objects either as a graph, drawn with its relationships, or as a table. On discovery and Review, each row has the box that includes or leaves out its object. The execution's table gives each object a row with what its node on the graph says: its status, its progress while it is written, its records and fields, its personal fields and the errors discovery met, updated as the run goes. The `sandforge.forge.graphView` setting chooses between them:

- `auto` (the default): the graph up to 25 objects, the table past that;
- `graph` or `table`: always that view.

The **Graph View** / **Table View** switch on any of these screens overrides the setting on all three, for every run, until the panel is closed. Why 25: each progress event of a run redraws the whole execution graph, and past a few dozen objects the redraw takes longer than the time between two events the extension sends, so the panel stops answering until the run ends — a record clone can reach hundreds of objects. The table redraws only the row of the object an event is about.

## Copy the files of the cloned records

Off by default. On the **Review** screen, **Copy the files of the cloned records** copies, once the records they hang on are written:

- the **Salesforce Files** linked to a record the run clones, the latest version of each, published on the cloned record and linked to every other cloned record the file was linked to;
- the **attachments** whose parent the run clones, written under the cloned parent.

Nothing else: a file linked only to records outside the clone is never read, a library is not copied, and a file that hangs only on records the target already held, linked to rather than created, is left out.

- **Size.** The largest file copied is 10 MB unless you set another, up to 35 MB: what one call to Salesforce carries. A larger file is left out and listed in the results, never cut. Before anything is written, records included, the files together are checked against the file storage the target org has left (its limits, `FileStorageMB`): a run whose files do not fit writes nothing and says what they take and what is left. A run whose files could not all be looked up in the source writes nothing either, and says so.
- **Anonymization.** The content of a file cannot be anonymized. While the run anonymizes its records, the Review screen asks, in a confirmation of its own, that you accept the files are copied as they are, and **Execute Forge** stays off until you do. The acceptance is never kept with a template or a past run: each run asks again.
- **Afterwards.** The results say, per object, how many files were copied and their size, the links written, and every file left out with why. The files a run created are counted in its audit entry, a Salesforce File under `ContentDocument` and an attachment under `Attachment`, and **Remove the records this run created** removes them with the rest: deleting a document removes its versions and its links.

With or without this option, a field that holds a file's content — a quote document's `Document`, a custom field of that type — is left empty in the clone: read, it gives the address of its content, never the content, and that address is not written in its place. The results name those fields per object. Only this option copies a file's content: a Salesforce File's version and an attachment's body.

## Remove what a run created

The Forge page lists your recent runs under **Recent runs**. A run that created records offers **Remove the records this run created**: it deletes from the org the run wrote to the records that run created, and nothing else. That holds for a run that stopped part way too: one that failed, or that you cancelled, after it had written records is listed as **Failed** or **Cancelled** with the records it had created by then. The audit trail (Reports → Audit Trail) records a run you cancelled as **partial** once it had written records, and as **stopped**, under `RUN_CANCELLED`, when it had written none and nothing had failed yet. Its entry counts as **not sent**, per object, the records the cancel kept from the target: the rest of the object it was writing, and the emails that waited for their task. So does the entry of a run that failed before those emails. An object a run skipped whole is named in the entry too, as skipped — because a record it cannot be written without failed, or because the target takes no insert of it while the clone holds records of it: the records the run had read of it count as failed, as they do in its results, and one whose records it never counted is shown as skipped with its record count unknown.

- **What it takes.** The records the run created, as its history entry kept them, each object after the objects whose records point at it — the opportunity a run started from goes before its account and its price book — 200 per call. An order past Draft is set to Draft first, as the org deletes neither an activated order nor its products otherwise; one the removal then keeps, or does not reach, gets its status back, and the result names any it could not give back. A contract past Draft is deleted as it is, and its item prices go with it: the org deletes an activated contract, and a sandbox would not set one back to Draft. A record the org refuses while other records still hang from it is tried again once the rest has gone. A record the run linked to because the target already held it is never taken, and neither is the standard price book or reference data the run matched by name.
- **What it keeps.** A record is kept while records that stay in the org depend on it, since deleting it would take them along: a record from before the run moved under it, or one of the run's records the removal keeps or the org refuses. So is one that a record staying in the org points at through a lookup the org will not let it lose: a price an order line that stays still uses, a standard price that a custom price of its product that stays needs, a selling model option that an active price that stays is sold under. An order past Draft that the removal keeps keeps its products and actions with it, as the org deletes neither under an activated order: they are counted as kept for the order, not sent to be refused. So does an activated contract that stays keep its item prices, which the org will not delete under it. A record modified after the run ended is kept too, and so is one that records added or changed since the run depend on — a task logged on it, a tracked change in its feed, a record a colleague adds while the removal runs — unless you tick **Also remove the records changed since the run, and what was added to them since**. What the org adds in answer to the removal itself, or to an earlier removal of the same run, as the user that removal ran as, holds nothing back. What was created while the run went and not touched since, such as the contact of a person account, goes with its parent, and so does what the platform adds to a cloned record on its own, whenever it adds it: a duplicate rule's report that the record matches others, and a copied file's links. A few objects cannot be read by the record they depend on (a member of a sales engagement list is one): the result names them as not checked, and they go with their parent.
- **Whose clock.** Every date compared is the org's own: the run's span runs from its first record's creation to the last stamp it left, read back from the org as the run ends — from their system stamps where your user may set audit fields in both orgs, as the clone then copies the source's creation dates — and the removal's start is the org's time when it begins. A clock on your machine a few seconds off the org's changes nothing. A run recorded before runs kept those dates, or whose dates could not all be read back, is dated by when it was recorded, read on the org's clock: it ends then, give or take ten seconds, and starts as long before as the run took, or with its first record if that came later.
- **Before it runs.** The confirmation names the target org and the records per object, and you type the org's name to go on. Production Guard judges the delete as it judges every write, and refuses a production org. The removal is listed in Live Operations on the Monitor page, where **Cancel** stops it before its next call to the org, except the ones that give an order back its status and the reads of what it left on the records it leaves, and it is recorded in the audit trail (Reports → Audit Trail) as a cleanup delete, with its counts per object.
- **Afterwards.** The result says, per object, how many records were deleted, were already gone, were kept and why, and were refused, with the org's reason; a refusal does not stop the rest. It also names, per object, the files attached to the records it deleted that stay in the org — a confirmation the org generated for an order, say: the removal takes only what the run created, and a file loses its link to the record, not its place in the org. Deleted records go to the org's recycle bin. Once records went, whether the removal ended or was cancelled, the run says when, how many every removal deleted or found gone, and what the last one left. A removal that left none of the run's records in the org is not offered again. One that left some — kept for a change since or for records that stay, refused by the org, or not reached before you cancelled it — is followed by **Remove what is left of this run's records**, with or without the records changed since: its confirmation names only the records left, and which removal left them; its result and its audit entry say it picked up where that removal left off; and the run's line then counts what every removal took, a cancelled one's included. A removal that took nothing is offered again too. What a removal wrote to the records it left does not count as a change since the run.
- **Older runs.** A run recorded before runs kept what they created says so and offers no removal. `sandforge-cleanup` (below) remains for those.

## Headless quickstart (CLI)

When you're scripting (CI, batch sandbox refresh), skip the wizard.

The command line is two TypeScript scripts in this repository, not a published package: there is no `sandforge` command to install. Run them from the root of a checkout, after installing its dependencies and building the shared package they import:

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

# When happy, drop --dry-run
pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
  --record 500XX00000000001AAA \
  --source MY-PARTIAL-COPY \
  --target MY-DEV \
  --depth custom --custom-depth 5 \
  --max 50

# Cleanup later: preview first, it only prints counts
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV \
  --since today \
  --dry-run

# Then delete, limited to the objects the clone wrote
pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
  --target MY-DEV --since today \
  --objects Case,Contact,Account
```

The cleanup does not know what the clone wrote: it selects every record your user created on the target in the `--since` window, including records you made by hand. Read the counts from the preview, and name only the cloned objects in `--objects` before you drop `--dry-run`. A run made in the wizard can instead have exactly its own records removed from **Recent runs** ([above](#remove-what-a-run-created)).

With `--json`, the clone prints its summary as JSON. `remapTable` maps each source Id to its target Id; `existingSourceIds` names the rows the target already held (linked to, or matched by name) and `updatedSourceIds` the rows `--upsert` wrote over, so every other row of the table is a record the run created. A `--dry-run` creates nothing: what it would insert is counted in `wouldInsertCount`, and `successCount` stays at 0. `readByObject` gives, per object, the rows the run read to clone, where `--list-objects` counts each whole table. `failedReads` names the objects whose read failed: the clone never learned how many of their rows it held, so `failedCount` does not count them, but each is a failure of the run, for the exit code below as for the text summary's `failed:` line, which names them. An entry of `errors` carries `referenceData: true` for the reference data the target holds no match for by name, counted neither written nor failed, and `skipped: true` for an object the run skipped whole, whose `failedCount` is none when it never learned how many rows it held.

`--exclude-object <object>` leaves an object out of the clone, whether discovery reached it or the run would add it past `--max-nodes` — a line's price, an order's items. The records that cannot be written without one of its records are held back and named in the summary's errors, and an order past Draft left with no item stays a draft, said so.

`--files` copies the files of the cloned records, as the wizard's option does ([above](#copy-the-files-of-the-cloned-records)); `--max-file-size <MB>` sets the largest file copied, from 1 to 35 (default 10). With `--anonymize`, `--files` also needs `--files-as-is`, which accepts that the files are copied as they are. The summary counts the files per object, lists every file left out with why, and a `--dry-run` lists what it would copy and the size; with `--json` it is all under `files`. Whatever the flags, the summary names per object the fields left empty because they hold a file's content, under `fileContentFieldsLeftOut` with `--json`, and the picklist values replaced or left out because the target would refuse them, per object and field with why, under `picklistValuesChanged`.

The clone's exit code is `1` when the run produced **only** failures, or when its files do not fit in the target's file storage, that storage could not be read or the files could not all be looked up in the source (nothing is written then), and `0` otherwise; wire it as a CI gate. Both scripts exit `2` on a missing or invalid flag before any org is contacted. For the clone that is a malformed record ID, an unknown `--depth`, a name that is not an API name, `--files` with `--anonymize` and no `--files-as-is`, or a `--max-file-size` outside 1 to 35. For the cleanup it is an alias or object name that is not valid, a `--since` outside the accepted forms, or a `--max` that is not a whole number above 0.

## Common errors and what they mean

| Error                                     | What it means                                            | What to do                                                                      |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DUPLICATE_VALUE`                         | A record with this External Id already exists on target. | Re-run from the command line with `--upsert`, or run `sandforge-cleanup` first. |
| `INVALID_CROSS_REFERENCE_KEY: Owner ID`   | Source User doesn't exist on target.                     | Auto-handled: Salesforce assigns the running user.                              |
| `REQUIRED_FIELD_MISSING`                  | A required FK pointed outside the scope.                 | Enable "Auto-fetch parents" toggle in the wizard.                               |
| `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` | Value not on target, or not allowed by its record type.  | Auto-handled: replaced by its record type's default, or left out, and named.    |
| `FIELD_CUSTOM_VALIDATION_EXCEPTION`       | A validation rule of the target refused the record.      | Auto-handled when the rule names a field: the record goes again without it.     |
| `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`    | Object is read-only (audit/history table).               | Auto-handled: node is now skipped pre-flight.                                   |
| `FIELD_INTEGRITY_EXCEPTION` (Asset)       | Asset needs at least an Account or Contact.              | Enable "Auto-fetch parents" toggle.                                             |

The wizard's Errors panel shows an explanation and an action hint under each message it recognizes, in the SandForge interface language: English, French, German, Spanish, Japanese or Brazilian Portuguese. Each message the target gave ends with the fields its error named, in brackets, where the message does not already list them: a restricted picklist's refusal names the value it refused and not the field.

A record a validation rule of the target refuses on fields it names is written once more without them, once only. Taken that time, it counts as created and the records under it link to it; the object's line and the results page say which field it went without and why, as does the command line's summary (under `writtenWithoutFields` with `--json`), and the audit trail counts such records per object. A rule that names no field leaves the record failed, as does a second refusal, which the Errors panel shows with what the first one said.

## What's next?

- [Forge: Record-Scoped Clone (architecture)](./forge-record-scoped.md)
- Sample scenarios: see `packages/extension/examples/`
