# Sync

Synchronize data between two Salesforce orgs with field mapping, transforms, and conflict resolution.

## Quick Start

1. Navigate to **Sync** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org, then choose direction and conflict strategy
3. Configure the object set -- pick which objects to sync and set batch sizes
4. Map fields between source and target using the drag-and-drop Field Mapper or auto-match
5. Add transforms (optional), review the Sankey flow diagram, then simulate the run to see what it would write, and run it

## Features

### Org Selection and Configuration

- **Source and Target Orgs** -- Select from your connected orgs with OrgBadge indicators
- **One write direction** -- Records always flow source to target. _Bidirectional_
  reverses nothing: it adds a pass that reads the matching target records first
  and applies the conflict strategy before the write, which still goes to the
  target. To copy the other way, swap the source and target orgs: a
  configuration asking for _target to source_ is refused before it runs.
- **Full or delta** -- A full run reads every object whole, as its filter allows. A delta run of a saved configuration reads each object from the watermark its last good run recorded: the source's latest `SystemModstamp`, read from the org before that run read the object, less five minutes for saves committed during a read. The first run, a run after the object's filter, fields, key, mapping or the run's strategy changed or its files were turned on or off, and a run after **Run full next time** (Schedules tab, saved configurations) read the object whole, and the results say why. An object that failed, was cancelled, had a record or a deletion refused, or was read up to a bound keeps its previous watermark. What the overlap reads twice is written twice, so a delta configuration writes every object by upsert on an External ID or by update. With **Delete in the target what the source deleted** (off unless ticked) a delta run also reads the source's recycle bin and deletes the one target record each deleted record is tied to by that key -- never one it cannot tie to exactly one deleted record, or whose key a source record still holds; Production Guard judges such a run as a delete, which it refuses on a production-tier org. A configuration asking for incremental or CDC is refused before it runs, and no metadata is deployed
- **Real-Time and Conflicts tabs** -- Besides Sync, History and Schedules, the page offers Real-Time, which follows the change events (Change Data Capture) the source org publishes and writes each change to the target as it comes, and Conflicts, which lists the real-time changes held for a decision. See [Real-Time](#real-time)
- **Four conflict strategies, all of which act** -- Source wins, target wins, newest wins (the target record only when both sides carry a readable `LastModifiedDate` and the target's is later; the source whenever either side has no readable `LastModifiedDate`, or the two are equal), or a field-level merge that starts from the target record and takes the source value of every conflicting field that has one. A strategy is read on a bidirectional run, the pass that reads the matching target records before writing. Manual review is not offered for a run: no run shows its conflicts to anyone before it writes, so a configuration asking for it is refused before it runs, with the four it can pick from. A wizard draft saved when it was still offered reopens on target wins -- the strategy that writes no source value over a different target value -- and the page says so until a strategy is picked. The Conflicts tab lists only real-time changes

### What a run writes

- **The fields the target takes** -- each record goes with the fields the target lets the running user write, read from its describe once a run. An account goes with the fields of its kind, as Forge sends it: a business account without the fields only a person account holds (`FirstName`, `LastName`, `Salutation`, the `Person…` fields, the `__pc` fields), a person account without the `Name` the platform computes, and a person account the target takes as a business one -- it has no person accounts, or the record type it gets there is a business account's -- with its name and without the person fields
- **Record types** -- a record's `RecordTypeId` is mapped to the target's record type of the same object and API name, from both orgs' active record types, read once a run before the first object whose records carry one. A record whose type has no active counterpart in the target, or one the running user may not use there, is held back with the reason (`RECORD_TYPE_UNMAPPED`, `RECORD_TYPE_UNAVAILABLE`), as Forge holds them back: written without it, it would take the running user's default, a business account's type for a person account
- **Lookups at records the run wrote** -- a lookup at a record an earlier object of the run wrote names its copy in the target. A record whose lookup names a record the run set out to create -- an insert, or an upsert -- and the target refused, or the run held back, is held back too, counted and said once per lookup ("`PARENT_REFUSED`: 1 260 Contact records held back, not sent: the Account record their AccountId names was refused in this run"), never written without its parent; its own children are held back in turn. A record an update did not reach is the target's already, and its children name it as they did. Held-back records count as failed, and removing the run has nothing of them to remove
- **Lookups within one object** -- a lookup at another record of the same write -- an account's `ParentId`, any lookup of an object at itself -- is left out of the write that creates both and set by a second write once the record it names has its copy, as Forge's second pass sets it; two records that name each other are each given the other's copy. A record whose record there was held back is held back with it; one whose record the target refused stays without the lookup, and the results say how many, as they say an update the target refused
- **Lookups at records earlier runs wrote** -- a saved configuration keeps which record of the target each source record its runs inserted, upserted or linked became, between the same two orgs, and a later run -- a delta run, or any other -- points a lookup at that copy: contacts synced after their accounts, by another run, go under the accounts' copies rather than with the source's ids. A record the run refuses is not taken for refused while an earlier run's copy of it is in the target. Kept on disk beside the runs' creations, one file per configuration (200 000 records at most, the oldest going first), never in the settings VS Code saves whole; removing a run forgets the records it took, and deleting the configuration forgets them all
- **Linked to an existing record** -- a record the target refuses as a duplicate of one it holds, naming it -- a value of a field it keeps unique (`DUPLICATE_VALUE`), a duplicate rule that matched one record -- is linked to that record, as Forge links it: what hangs from it goes under the target's record rather than being held back. Counted as skipped, not failed, and said once ("`LINKED_TO_EXISTING`: 3 Account records linked to an existing record, not written"); the run did not create it, so removing the run leaves it
- **Currencies** -- between two orgs with several currencies, a record in a currency the target does not hold active, which it would refuse ("invalid currency code"), goes in the target's corporate currency, each of its currency fields converted into it at the source's rates -- divided by the source's rate of its currency, multiplied by the target's rate of the corporate one, rounded to the field's decimals -- as Forge and Autopilot write it. Both orgs' currencies are read once a run, before the first object whose records carry one; a currency the target holds goes as read. The results say it per object and currency ("4 row(s) in GBP written in USD, the target's corporate currency, GBP not being active there: amounts converted at the source's rates (Amount)"), and a simulation says the same before the run
- **Written again without a field** -- a record the target refused for a lookup holding an id it does not have -- the owner, a record no object of the run wrote -- is written once more without those lookups, never without one the run settled at a record it wrote, nor its record type; one refused on fields a validation rule or a restricted picklist named is written once more without them, as Forge and Frozen send it. The target names one refusal at a time, so a record goes again once for each of the two kinds, never twice for the same one, and one refused again is reported with the target's last refusal. The results say which fields, for how many records, and why

### Files

- **Copy the files of these records** (off unless ticked) -- once an object's records are written, the latest version of each Salesforce File linked to one of them, and the legacy attachments under them, are copied and linked to the records' copies in the target: a file is published on the first of its records the run wrote and linked to the others, an attachment written under its record. A file linked only to records the run did not write -- outside the filter, or refused by the target -- is not copied, and the results say how many. Files are read and written one call each way, as Forge copies them; a file kept outside Salesforce is skipped and counted
- **Never copied twice** -- files are copied by a saved configuration only, which keeps which file it copied where (5 000 at most). Running it again, in full or in delta, copies a file again only when the source holds a newer version, which is added as a version of the copy in the target, never as a second file; a copy is linked to the records it lacks. A legacy attachment, which has no versions, whose source changed since it was copied has its copy replaced: the new one is written under the target record, then the earlier one deleted -- one the target would not delete is counted as failed and named, the record then holding both. On a target where Production Guard allows no delete -- a production org, a Developer Edition included -- the earlier copy stays and the change is not copied: the run never deletes there, and its results say how many changed attachments it left as copied. The command line's run of a saved configuration replaces one by the same rule, on what the target says it is: a sandbox. A file the target already holds under the source's own id -- two sandboxes taken from the same production -- is taken as copied; such an attachment is the target's own, and is never replaced. Run full next time keeps that record. A configuration that is not saved is refused before anything is read, and the Execute step says to save it first
- **Delta** -- a delta run finds the files of the records changed since the watermark and, besides those, the files it copied before whose source has a version stamped after it: a new version reaches the target though its record did not change. It also finds the records of the object's filter whose files changed while nothing else of them did -- a Salesforce File linked to one since the watermark, or whose latest version was published since, and an attachment created or changed under one since -- and copies those files to the copies an earlier run made of them, found by the key the object is written on, as a deletion is: those records are not written again. One the key ties to no target record, or to more than one, keeps its new files for when it changes, or for a full read, and the results say how many. An object whose files were not all copied -- one failed, or was past the cap -- keeps its watermark, so the next run reads its records again. Its watermark keeps the newest stamp of a link, a file version or an attachment those lookups looked at, and the next run looks only past it: while the records do not change the watermark stays put, and the same files were found again, and counted unchanged, on every run
- **Caps and storage** -- the largest file copied (10 MB unless set, at most 35) and the most a run copies (100 MB unless set, at most 2 000). A larger file, and the files past what a run copies, are skipped and counted, never cut short; the next run copies the latter. Before the run writes anything, the target's file storage is read (`/limits`) and the files of every object are found and measured: a run whose files would not fit is refused, with both numbers, and nothing is written
- **Simulation** -- says, per object, how many files a run would copy, how many versions it would add and how much they take, what it would skip, and what they would take of the target's file storage
- **Results and history** -- "3 files, 1.2 MB copied, 1 skipped past the caps" for the run, and per object the files copied, the versions added, the changed attachments replaced, those unchanged, those skipped by each cap and those that failed
- **Removal** -- removing a run takes back the files it created with its records (see [Removing what a run created](#removing-what-a-run-created)): a Salesforce File's first copy and a legacy attachment the run wrote, the new copy of a replaced attachment included, never a version it added to an earlier copy. The configuration then forgets the copies removed, and its next run reads their objects whole and copies them again when they are still in its scope
- A file object -- `Attachment`, `ContentVersion`, `ContentDocument`, `Document` -- is still refused as an object of its own: files travel with the records they hang on

### Removing what a run created

- **What a run keeps** -- every run, from the page, a re-run, a schedule or a pipeline's Sync step, keeps what it creates in the target as it writes it: the records it inserted, or upserted where the target held none, as the org said for each, and the files it created. A record it updated was the target's before, and a version added to an earlier copy of a file is the copy's: neither is kept. They are kept in the extension's storage, one file per run written as each object is, never in the settings VS Code saves whole, so a run a closed window stopped stays removable. Past 4 MB the runs whose creations were all removed go first, oldest first; past 64 MB, the oldest runs
- **Remove what this run created** -- on the run's results, on its history entry, and, for a run a closed window stopped, under **Runs that never ended** on the History tab. Nothing is asked of the org until the removal is confirmed: the confirmation names the org, typed, and what goes per object -- the files first, then the objects in the reverse of the order the run wrote them, children before their parents -- into the recycle bin. A record changed since the run wrote it is kept unless you include it, and so is one that records staying in the org depend on; what the org refuses is counted with its reasons. A removal that left records is offered again, for those
- **Production Guard** judges the removal as the delete it is. It takes the target for what a Forge or a Frozen removal takes it for: on a production org the card offers nothing and says why, with the guard's reason, while a Developer Edition -- which Sync writes to once you confirm -- is not taken for one, and what a run created there can be removed; without a guard nothing is deleted. The removal is listed in Live Operations, and its Cancel, or the card's, stops it between two calls to the org; what it did not reach is offered again. The audit trail records it, as `cleanup_delete` from Sync with what it deleted and what the org refused -- as cancelled when it was stopped
- **What the configuration forgets** -- a delta configuration's next run reads whole each object whose copies the removal took ("Full read (a removal took back copies it had written)"), and the record of the files it copied forgets the copies deleted: a later delta run never takes a removed copy for still there, and the next full read copies again what is in its scope. Nor does a later run point a lookup at a record the removal took: it leaves the configuration's record of which copy each source record became
- **From the command line** -- `sandforge-sync --remove <summary.json> --target <alias> [--include-changed] [--store <dir>]` takes a run back from the summary it printed with `--json`, saved to a file, with the same removal; what it left on the run's records is kept beside the summary for the next one, and given the store of the configuration the run was of, the removal tells it what it took, as the page's does. The command has no Production Guard to ask: it removes from a sandbox or a Developer Edition org, and refuses any other

### Object Set Editor

- Add/remove objects to the sync scope
- Configure batch size per object
- Available objects are loaded from the source org schema, without the objects no copy writes -- the list Forge and Autopilot read: users and their access, metadata, files and the links to them, a record's history, feed or sharing rows, the platform's jobs and logs. A configuration naming one is refused before it runs. A managed package's objects, such as Vlocity's, which Forge's discovery does not walk into, are offered: a sync copies only the objects it is given
- A per-object WHERE filter may only filter: a clause carrying `LIMIT`, `OFFSET`, `ORDER BY`, `FOR UPDATE`, a subquery, a comment or a semicolon is refused, including one imported from an SFDMU `export.json`
- An upsert key (external ID) is a single field API name; an SFDMU composite key such as `Name;Parent.Name` is refused. An empty External ID box counts as no key

### Field Mapping

Two mapping interfaces work together:

- **Field Mapper** -- Visual drag-and-drop canvas showing source fields on the left and target fields on the right. Draw lines to create mappings, or click "Auto Match" to map fields with matching API names.
- **Field Mapping Canvas** -- Detailed table view with mapping type selection (Direct, Lookup, Formula, etc.) and per-mapping controls.

### Transforms

The Transform Builder lets you add data transformation rules that run during sync:

- String transforms (uppercase, lowercase, trim, regex replace)
- Date and number formatting
- A formula rule substitutes the field value into the token `VALUE` and
  evaluates the arithmetic; a field that is not a number, or a formula without
  `VALUE`, is left as it is. There is no conditional rule
- Every rule you add applies to all fields of all objects in the run, except
  `Id` and the external ID the run matches on, which are left as they are so a
  prefix or a truncate cannot send the write to a record that does not exist.
  Per-mapping rules exist in the configuration format, but no screen sets them
- Value mapping takes a table of replacements the builder has no box for, so a
  rule of that type leaves every value as it is

### Review and Sankey Flow

Before execution, the Review step shows:

- Summary badges for direction and conflict strategy
- Object count, field mapping count, and transform count
- PII warnings if sensitive fields are detected in the sync scope
- A **Sankey Flow Diagram** visualizing data flow from source objects through mappings to target objects
- A **Save** button, which stores the reviewed configuration under the two orgs it
  runs between. The configuration is checked as a run started by hand is, so one
  asking for _target to source_, for incremental or CDC, or for manual
  conflict review is refused and nothing is stored. While the Sync page stays
  open, saving the same configuration again updates its entry. Once the orgs,
  objects, mappings, transforms or strategy change, or after the page is
  reopened, saving creates a new entry, so a schedule built on the first keeps
  running what it was built on. The saved confirmation disappears as soon as the configuration on screen
  differs from the one saved.

### Saved configurations

- The Schedules tab lists the saved configurations. **Run now** runs one as it
  was saved, without a schedule: it is read back from where it is kept and
  checked as a run from the Sync tab is, Production Guard judges it before
  anything is written, and it runs on the Execute step with the same progress,
  Pause and Cancel, and the same results, saying which saved configuration it
  is. It needs no simulation first. **Run full next time** makes the next run
  of a delta configuration read every object whole.
- The sync history says what started each run: by hand, a re-run from the
  history, a schedule, or a pipeline's Sync step (see
  [Automation](automation.md)). A pipeline's Sync run is listed as such in
  Live Operations too, and is not cut by the pipeline's time budget.

### Schedules

- A schedule runs a **saved** configuration, chosen from the ones the Save button
  stored. Each is listed by its name and the time it was saved, since a changed
  configuration is saved under the same name as the one before it. Until one exists, the Schedules tab says so, and a schedule can be
  neither created nor edited: there is no default configuration behind one.
- Editing a schedule whose configuration has since been deleted opens with no
  configuration picked, says the previous one no longer exists, and cannot be
  saved until one is chosen. A schedule naming a configuration that was never
  saved is refused.
- The check runs every 60 seconds and fires each schedule whose cron time has
  passed, once, however long the editor was closed and however many VS Code
  windows are open: the windows of one machine share which of them makes each
  run, as they do for pipeline triggers.
- When the configuration a schedule names has since been deleted, the run is
  recorded as a failure at each of its run times, the next run time moves on, and
  -- if the schedule asks to be told about failures -- a notification says which
  configuration is missing. It is not retried every minute in silence.
- The two notification switches on a schedule raise a notification in each
  SandForge panel open at the time: with _Notify on completion_ on, one says the
  run started and another that it completed -- or, when some records failed, a
  warning that it completed with errors, with the first one, and when it was
  cancelled from Live Operations, that it was cancelled; with _Notify on
  failure_ on, one says it failed, with the first error the run reported or, when
  it reported none, a pointer to its entry in the sync history. A run that fails
  in the sync engine is reported as failed, not completed. With no panel open, the
  outcome is in the SandForge output channel and in the schedule's last result.
- The Automation page's Scheduler tab lists the same schedules by the day each
  next runs, with the same buttons. Both ask for the list again once the
  soonest run is past, so the next run and the last result follow the runs
  while the tab is open.
- A schedule is refused when it is saved, with the reason, if SandForge cannot
  read its cron expression or if no date of the coming year matches it: the
  31st of February or April never comes, and 29 February only once in four
  years.

### Real-Time

- **What it follows** -- The tab asks the source org which objects publish
  change events: the answer is the org's own list of Change Data Capture channel
  members, and each object is shown with the channel it is listed on. Only
  those can be watched: to add another, select it in Setup → Change Data
  Capture on the source org. When the org lists none, the tab says so and
  offers nothing to start.
- **What the org refuses** -- An object the org does not publish change events
  for is refused when the session starts, and the tab shows the org's answer
  word for word -- on a sandbox with Account unselected,
  `403::User not allowed to subscribe CDC without required permissions` --
  beside the objects it did accept.
- **Watched or written** -- A ticked object's changes appear in the feed as
  they come. Tick _Auto-Sync_ for it and they are also written to the target,
  through the path a Sync run writes with: only the fields the target lets the
  running user write, a change of a record type the user cannot use not
  written and said why, a lookup the target cannot take dropped rather than
  the record. A session
  that writes asks the Production Guard first, a deletion counting as
  destructive.
- **How the target record is found** -- by an external id of the target object,
  filled from the source field of the same name; by the record Id, which only
  finds the records that existed when the two orgs were copied from the same
  production (one made since is reported as not written, with that reason); or
  by the mapping of a Sync configuration saved between the same two orgs -- its
  external id, field mappings, transforms and add-on fields. A change is always
  upserted on that key, or updated by Id, whatever operation the saved
  configuration names.
- An update of a record the target does not have yet copies the whole source
  record, not the one field that changed.
- **Deletions** -- only for an object whose _Apply deletions_ box is ticked.
  The deleted record is read back from the source's recycle bin to find its
  key; one no longer there is reported as not written, with that reason.
- **A target edited after the change** -- Before writing, the target record is
  read. When it was edited after the change was made, and not by the session,
  the change collides with that edit and the conflict strategy decides: source
  wins writes it; target wins keeps the edit, and so does newest wins, since
  the target's edit is the newer one; merge writes only what the source did not
  clear; manual holds the change on the Conflicts tab, to be decided field by
  field or all at once. A held change is decided while its session runs:
  stopping the session drops it, and a notification says how many were
  dropped.
- **Its own writes** -- Every write of a session announces itself to the org
  as the `SandForgeRealtime` client, and the org records that in the change it
  causes. Such a change is shown as written by the session and never applied
  again, so a session between one org and itself, or two sessions writing
  toward each other, do not echo forever.
- **Stopping and resuming** -- After each batch the session stores, per
  channel, where it got to. The next session on the same source org resumes
  right after it, so changes made while nothing was listening are replayed;
  what was received and not yet written when a session stopped is replayed
  too. The org keeps change events for three days: a resume point it no longer
  holds is replaced by every change it still holds, and the tab says so. A
  sandbox refresh forgets the stored points.
- **One session at a time** -- It runs in the extension, not in the panel:
  closing the panel does not stop it, reopening the tab finds it, Live
  Operations lists it and its Cancel stops it. A connection the org closes --
  an expired session -- is reopened from the stored points, three times at
  most, before the session stops in error with the org's answer.
- The feed says what became of each change: written, not written (with the
  target's refusal), watched only, target edit kept, held for a decision,
  deletion left alone, or the session's own write coming back. A change the org
  could not describe in full arrives without its values and is read back from
  the source; an overflow notice in its place is reported as not written, and a
  Sync run brings the target up to date.

### Simulation

- **Simulate** on the Execute step reads both orgs as the run would and writes
  nothing. Each object is read with the same query, the rows the platform
  writes itself are set aside, and the mappings, transforms and add-ons are
  applied; on a bidirectional run the matching target records are read and
  compared as the run compares them. The target is then asked, a few hundred
  records at a time, whether it holds the key each record would be written on:
  the External ID for an upsert, the Id for an update or a delete.
- The results step shows, per object, the records the run would insert,
  update or delete, those it would skip (the rows the platform writes itself),
  those the target would refuse as asked -- an upsert record with no External
  ID value, an update or a delete naming an Id the target does not hold -- and,
  on a bidirectional run, those in conflict: records both orgs hold whose
  values differ on a field the run writes, with the fields and the strategy
  that decides. **Run the sync now** runs the configuration just simulated;
  change the configuration and the findings are put away, since they no
  longer say what a run would do.
- It counts as refused what the run then refuses before the target decides
  anything, from the same preparation: the records of a record type with no
  counterpart in the target or closed to the running user, and the records
  under one it counts refused. And what the target refuses on every record
  that carries it, known from its describe, as Forge's simulation finds it: a
  field the target requires left empty on a record it would create, a text
  longer than its field, a number larger than its field takes, a value of a
  field it keeps unique that a record sent before holds. Each is said once
  per object, with how many records it refuses. A record whose unique value
  one record of the target holds is counted as linked to it, as the run links
  it, and what hangs from it as the run sends it; a lookup at a record an
  earlier run of the configuration wrote names that copy, as in the run. A
  record in a currency the target does not hold active is said in the
  currency the run writes it in, its amounts converted, from the same
  preparation.
- A simulation checks the field types of both orgs as a run does, and stops at
  an object whose read fails, where a run would stop. It does not run the
  target's validation rules, duplicate rules or automations: a record one of
  them would refuse is counted as the run would send it. It lists, beside each
  object the run inserts, updates or upserts, the target's active validation
  rules on it -- name, the field each shows its error on, its message -- read
  from the target's Tooling API as Forge's pre-flight reads them, the field by
  its API name where a French org answers its label, and says
  when the target would not list them; on the results step and on the command
  line (`--dry-run`) alike. Each rule's formula is read too, five a request: a
  rule whose formula holds only on a change of a record (`ISCHANGED`,
  `PRIORVALUE`, a `NOT(ISNEW())` guard) is left out beside an object the run
  only inserts, and a note names it; an update or an upsert meets it, and it
  stays listed there, as does a rule whose formula cannot be read. A rule on the running user's profile or on a
  registration number's format refuses rows a simulation counts as written.
- It writes nothing to the target, to the audit trail or to the sync history.
  Like a run it is listed in Live Operations, and its Cancel -- or the page's
  -- stops it before its next object. Each lookup is an API request: about one
  per two hundred records of an upsert, an update or a delete.
- A configuration never carries a simulation: a saved, scheduled or replayed
  configuration asking for `dryRun: true` is refused, so no run can be taken
  for one that only reports.

### Execution and Results

- Before anything is written, both orgs are described and every field a mapping copies unchanged is compared (the same-named fields when the object has no mapping). A field that cannot hold the other's type -- text onto a date, a number onto a checkbox -- stops the run with the list of mismatched pairs, and nothing is written. A mapping whose value a transform rewrites is not judged on its source type
- Real-time progress bar with elapsed time
- **Pause** and **Cancel run** on the Execute step, and on Quick Sync's run.
  Cancel means what Live Operations' Cancel means: the run stops before its
  next object or batch, and what it wrote stays in the target org; it asks
  first. Pause holds the run before its next object, or its next batch of
  records -- a batch already sent, or a Bulk API job already closed, finishes
  first -- and nothing is written until **Resume**. A paused run is resumed
  from the page that paused it, or from Live Operations, where it is listed
  as paused and offers Pause and Resume too, its page open or closed
- Sequential per-object execution. With Grappe enabled and the source records,
  counted before the run, at or above `sandforge.grappe.autoActivateThreshold`,
  the run reports progress one partition per object over that same sequential
  loop -- nothing is split and nothing runs concurrently.
- That count costs API calls. With `sandforge.grappe.enabled` on, Sync sends one
  `SELECT COUNT()` per object of the run before anything is written, and each of
  those queries counts against the org's daily API request limit, production
  included. With the setting off, no count is sent.
- Per-object result breakdown: processed, succeeded, and failed counts
- A write of more than 200 records goes in one Bulk API 2.0 job, its rows
  with every field any of them carries. A field a row does not carry goes
  as an empty cell, which the platform reads as no value: an update leaves the
  field as it was, an insert gives it its default. Each row gets its own result
  back, with its record id, whatever fields it carries and whatever form the
  platform writes its values back in; a row the job answered nothing for says
  so, and names the records the job wrote that no row was matched to, which
  the SandForge output channel lists in full
- Detailed error messages per object for troubleshooting

## Tips

- Use "Auto Match" in the Field Mapper first, then manually adjust the few fields that do not match
- Narrow the object set and batch sizes for recurring syncs -- a full run reprocesses the full scope; save a recurring one in delta mode to read only what changed
- Files travel with their records, never as objects: `Attachment`, `ContentVersion` and `Document` are not offered in the object picker, are absent from the prebuilt templates, and a configuration naming one is refused before it runs -- Bulk API 2.0 rejects base64, so such a run used to break past 200 records. Tick **Copy the files of these records** instead (see [Files](#files))
- Simulate before a run that updates or deletes: an update or a delete cannot be taken back, and the simulation says how many records it would touch
- Always review PII warnings in the Review step before executing
- If sync fails on certain objects, check field-level security on the target org
- Use the Sankey diagram to verify data flow before execution
