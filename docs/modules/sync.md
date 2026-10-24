# Sync

Synchronize data between two Salesforce orgs with field mapping, transforms, and conflict resolution.

## Quick Start

1. Navigate to **Sync** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org
3. Configure the object set -- pick which objects to sync and set batch sizes; once an object is written by upsert or update, choose what a run does when the target already holds the record
4. Map fields between source and target if their names differ (optional: with no mapping, fields with the same API name are copied)
5. Add transforms (optional), review the Sankey flow diagram, then simulate the run to see what it would write, and run it

## Features

### Org Selection and Configuration

- **Source and Target Orgs** -- Select from your connected orgs with OrgBadge indicators
- **One write direction** -- Records always flow source to target, and the
  page asks for no direction. To copy the other way, swap the source and
  target orgs: a configuration asking for _target to source_ is refused before
  it runs. A saved configuration's _bidirectional_ reverses nothing either: it
  adds a pass that reads the matching target records first and applies the
  strategy below before the write, which still goes to the target.
- **Full or delta** -- A full run reads every object whole, as its filter allows. A delta run of a saved configuration reads each object from the watermark its last good run recorded: the source's latest `SystemModstamp`, read from the org before that run read the object, less five minutes for saves committed during a read. The first run, a run after the object's filter, fields, key, mapping or the run's strategy changed or its files were turned on or off, and a run after **Run full next time** (Schedules tab, saved configurations) read the object whole, and the results say why. An object that failed, was cancelled, had a record or a deletion refused, or was read up to a bound keeps its previous watermark; so does one whose records the run left without a lookup it was to set once the record it names was written -- one of the same object, or of one written after it in a cycle -- the update refused or never sent, and the results say how many, so that the next run reads them again and sets it. An object of a cycle records its watermark once those lookups are set, never before. What the overlap reads twice is written twice, so a delta configuration writes every object by upsert on an External ID or by update. With **Delete in the target what the source deleted** (off unless ticked) a delta run also reads the source's recycle bin and deletes the one target record each deleted record is tied to by that key -- never one it cannot tie to exactly one deleted record, or whose key a source record still holds; Production Guard judges such a run as a delete, which it refuses on a production-tier org. The run keeps the ids of what it deleted, and its removal brings them back from the target's recycle bin while they are there. A configuration asking for incremental or CDC is refused before it runs, and no metadata is deployed
- **Real-Time and Conflicts tabs** -- Besides Sync, History and Schedules, the page offers Real-Time, which follows the change events (Change Data Capture) the source org publishes and writes each change to the target as it comes, and Conflicts, which lists the real-time changes held for a decision. See [Real-Time](#real-time)
- **When the target already holds the record** -- asked on the first step once an object is written by upsert or update, the writes that find a record the target holds (by its key, by its id), with four answers, all of which act. Source wins, the default, overwrites it with the source's values and reads nothing of the target first; target wins keeps the target's values; newest wins keeps whichever of the two was changed last (the target record only when both sides carry a readable `LastModifiedDate` and the target's is later; the source whenever either side has no readable `LastModifiedDate`, or the two are equal); merge takes the source's values and keeps the target's where the source has none (a field-level merge that starts from the target record and takes the source value of every conflicting field that has one). Any answer but the first is sent as a bidirectional run with that strategy: the pass that reads the matching target records before writing, for the objects written by upsert or update -- an insert creates a record whatever the target holds, and nothing of it is settled. Review and the history say the answer in the same words. Manual review is not offered for a run: no run shows its conflicts to anyone before it writes, so a configuration asking for it is refused before it runs, with the four it can pick from. A wizard draft saved when it was still offered reopens on target wins -- keep the target's values, which writes no source value over a different target value -- and the page says so until another answer is picked. The Conflicts tab lists only real-time changes

### What a run writes

- **Emails and phone numbers neutralized** -- unless the configuration says otherwise, every email address a run writes goes in under `.invalid` and every phone number as a fictional one, as Forge writes them, so the target's flows and automation reach no one; the results, Quick Sync's included, the history entry and the command line say once for the run how many it neutralized and in which fields, as Forge's results say it, in the panel's language and apart from every refusal -- or that it wrote them as the source holds them, as it was asked. The field a write matches on (its external id) is kept as read, so an upsert still finds the copy an earlier run wrote. Untick **Neutralize emails and phone numbers** on the Select Orgs & Objects step to copy them as the source holds them (`keepContactPoints` in a saved configuration, `--keep-contact-points` on the command line)
- **The fields the target takes** -- each record goes with the fields the target lets the running user write, read from its describe once a run. An account goes with the fields of its kind, as Forge sends it: a business account without the fields only a person account holds (`FirstName`, `LastName`, `Salutation`, the `Person…` fields, the `__pc` fields), a person account without the `Name` the platform computes, and a person account the target takes as a business one -- it has no person accounts, or the record type it gets there is a business account's -- with its name and without the person fields
- **Encrypted fields read masked** -- a classic encrypted field (`encryptedstring`) that the user SandForge reads the source as sees masked, lacking View Encrypted Data, is left out of every record a run writes -- and, on a bidirectional run, out of the comparison -- rather than copied as its mask (`***-**-1234`) over the target's value; Review warns of it per object, and the results, the simulation, the history entry and the command line name it
- **Record types** -- a record's `RecordTypeId` is mapped to the target's record type of the same object and API name, from both orgs' active record types, read once a run before the first object whose records carry one. A record whose type has no active counterpart in the target, or one the running user may not use there, is held back with the reason (`RECORD_TYPE_UNMAPPED`, `RECORD_TYPE_UNAVAILABLE`), as Forge holds them back: written without it, it would take the running user's default, a business account's type for a person account
- **Parents first** -- a run writes its objects in an order read from the target's describe of each: every object a lookup of another names -- the lookups its write carries, those of its mappings and add-ons when it has any -- before that other, and the configuration's order wherever no lookup decides. A case added before the contact it names is written after it, and its `ContactId` names the contact's copy. Objects whose lookups name each other -- an account's primary contact, the contacts' account -- keep the configuration's order among themselves: the records of the one written first go in without their lookups at the ones written after it, and once the last of them is written an update gives each record the copy its lookup names, as Forge's second pass does. A lookup the target requires goes in with the first write, as before, and so does any lookup of an update. A lookup at a record the run did not write goes in the update as the source holds it, as the first write sent it before: between two sandboxes of one production the target holds that record under the same id. The results say per object how many records were given their lookups so, and how many stayed without one, with why -- the record it names refused in this run, the update refused (with the target's words), or the run stopped first -- each on a line of its own beside the object's other lines, not among its refusals. The page's run, a re-run, a saved, scheduled or pipeline run, a Quick Sync, a simulation and the command line all write in this order; Review lists it, and the simulation says it
- **Records an earlier run copied** -- an insert of a saved configuration leaves as they are the records an earlier run of it copied whose copy is still in the target, found before the first write by the configuration's record of which copy each source record became, and the target asked by those ids: each run of it inserts only what the earlier ones did not copy. A copy deleted from the target since is inserted again. The results, the history and the simulation say per object how many it left so, counted as skipped. A run whose configuration's record cannot be read, with an object it inserts, is refused before it writes, since it would insert a second copy. An upsert finds its record by its key, and an update or a delete by the source record's id; a Quick Sync, which keeps no configuration, and a run of one that is not saved insert every record they read, and Quick Sync's preview and a history entry's **Run again** say first how many the last run between the same two orgs created that are still in the target
- **Lookups at records the run wrote** -- a lookup at a record an earlier object of the run wrote names its copy in the target. A record whose lookup names a record the run set out to create -- an insert, or an upsert -- and the target refused, or the run held back, is held back too, counted and said once per lookup ("`PARENT_REFUSED`: 1 260 Contact records held back, not sent: the Account record their AccountId names was refused in this run"), never written without its parent; its own children are held back in turn. A record an update did not reach is the target's already, and its children name it as they did. Held-back records count as failed, and removing the run has nothing of them to remove
- **Lookups within one object** -- a lookup at another record of the same write -- an account's `ParentId`, any lookup of an object at itself -- is left out of the write that creates both and set by a second write once the record it names has its copy, as Forge's second pass sets it; two records that name each other are each given the other's copy. A record whose record there was held back is held back with it; one whose record the target refused stays without the lookup, and the results say how many, as they say an update the target refused, on a line of their own, not among the refusals
- **Lookups at records earlier runs wrote** -- a saved configuration keeps which record of the target each source record its runs inserted, upserted or linked became, between the same two orgs, and a later run -- a delta run, or any other -- points a lookup at that copy: contacts synced after their accounts, by another run, go under the accounts' copies rather than with the source's ids. A record the run refuses is not taken for refused while an earlier run's copy of it is in the target. Kept on disk beside the runs' creations, one file per configuration (200 000 records at most, the oldest going first), never in the settings VS Code saves whole; removing a run forgets the records it took, a delta run forgets the records it deleted as the source had deleted theirs -- neither a later object of the run nor a later run points a lookup at them -- and deleting the configuration forgets them all
- **Linked to an existing record** -- a record the target refuses as a duplicate of one it holds, naming it -- a value of a field it keeps unique (`DUPLICATE_VALUE`), a duplicate rule that matched one record -- is linked to that record, as Forge links it: what hangs from it goes under the target's record rather than being held back. Counted as skipped, not failed, and said once on a line of its own beside the object's other lines, with the target's words, not among its refusals ("3 records linked to records the target org already holds, not written"); the run did not create it, so removing the run leaves it
- **Currencies** -- between two orgs with several currencies, a record in a currency the target does not hold active, which it would refuse ("invalid currency code"), goes in the target's corporate currency, each of its currency fields converted into it at the source's rates -- divided by the source's rate of its currency, multiplied by the target's rate of the corporate one, rounded to the field's decimals, an opportunity's at the dated rates of its close date where an org has advanced currency management on -- as Forge and Autopilot write it. A record whose currency is its parent's, which the target takes none of its own for -- an opportunity's products -- has its amounts converted as its parent's were. Both orgs' currencies are read once a run, before the first object whose records carry one -- whether advanced currency management is on from each org's currency settings, through the Tooling API -- and a currency the target holds goes as read. The run history says it per object and currency, in the panel's language and apart from the errors ("4 rows in GBP, written in USD, the target org's corporate currency — amounts converted at the source org's rates: Amount"), the command line as "4 row(s) in GBP written in USD, the target's corporate currency, GBP not being active there: amounts converted at the source's rates (Amount)", and a simulation says the same before the run
- **Price books and prices** -- the standard price book is matched to the target's, which no copy can create, and never written, which the price books' result says on a line of its own beside them, not among their refusals; the standard prices of a write of prices go in calls of their own before the custom ones, which the platform refuses for a product with no standard price; and a price in a currency the target does not hold active is left out where the run writes the source's own price of the same product and price book in the currency it would go in, the lines that pointed at it pointed at that one's copy; the object's result says how many went so, apart from its refusals (a **Prices in another currency** box in the history). Each line goes with one of its unit and total prices, the platform taking only one
- **Written again without a field** -- a record the target refused for a lookup holding an id it does not have -- the owner, a record no object of the run wrote -- is written once more without those lookups, never without one the run settled at a record it wrote, nor its record type; one refused on fields a validation rule or a restricted picklist named is written once more without them, as Forge and Frozen send it. The target names one refusal at a time, so a record goes again once for each of the two kinds, never twice for the same one, and one refused again is reported with the target's last refusal. The results say which fields, for how many records, and why -- the lookups and the owner left out, and the fields a validation rule, a restricted picklist or a lookup filter refused with the target's words, each on a line of their own beside the object's other lines, in the panel's language and not among its refusals, since the records were written. Once the target has refused an owner of the source so -- a record written again without its owner alone, or a refusal naming `OwnerId` -- the objects the run writes after send their records without that owner from the start, rather than a job the target refuses whole, and their results say so once; another owner still goes

### Files

- **Copy the files of these records** (off unless ticked) -- once an object's records are written, the latest version of each Salesforce File linked to one of them, and the legacy attachments under them, are copied and linked to the records' copies in the target: a file is published on the first of its records the run wrote and linked to the others, an attachment written under its record. A file linked only to records the run did not write -- outside the filter, or refused by the target -- is not copied, and the results say how many. Files are read and written one call each way, as Forge copies them; a file kept outside Salesforce is skipped and counted
- **Never copied twice** -- files are copied by a saved configuration only, which keeps which file it copied where (5 000 at most). Running it again, in full or in delta, copies a file again only when the source holds a newer version, which is added as a version of the copy in the target, never as a second file; a copy is linked to the records it lacks. A legacy attachment, which has no versions, whose source changed since it was copied has its copy replaced: the new one is written under the target record, then the earlier one deleted -- one the target would not delete is counted as failed and named, the record then holding both. On a target where Production Guard allows no delete -- a production org -- the earlier copy stays and the change is not copied: the run never deletes there, and its results say how many changed attachments it left as copied. The command line's run of a saved configuration replaces one by the same rule, on what the target says it is: a sandbox or a Developer Edition org. A file the target already holds under the source's own id -- two sandboxes taken from the same production -- is taken as copied; such an attachment is the target's own, and is never replaced. Run full next time keeps that record. A configuration that is not saved is refused before anything is read, and the Execute step says to save it first
- **Delta** -- a delta run finds the files of the records changed since the watermark and, besides those, the files it copied before whose source has a version stamped after it: a new version reaches the target though its record did not change. It also finds the records of the object's filter whose files changed while nothing else of them did -- a Salesforce File linked to one since the watermark, or whose latest version was published since, and an attachment created or changed under one since -- and copies those files to the copies an earlier run made of them, found by the key the object is written on, as a deletion is: those records are not written again. One the key ties to no target record, or to more than one, keeps its new files for when it changes, or for a full read, and the results say how many. An object whose files were not all copied -- one failed, or was past the cap -- keeps its watermark, so the next run reads its records again. Its watermark keeps the newest stamp of a link, a file version or an attachment those lookups looked at, and the next run looks only past it: while the records do not change the watermark stays put, and the same files were found again, and counted unchanged, on every run
- **Caps and storage** -- the largest file copied (10 MB unless set, at most 35) and the most a run copies (100 MB unless set, at most 2 000). A larger file, and the files past what a run copies, are skipped and counted, never cut short; the next run copies the latter. Before the run writes anything, the target's file storage is read (`/limits`) and the files of every object are found and measured: a run whose files would not fit is refused, with both numbers, and nothing is written
- **Simulation** -- says, per object, how many files a run would copy, how many versions it would add and how much they take, what it would skip, and what they would take of the target's file storage
- **Results and history** -- "3 files, 1.2 MB copied, 1 skipped past the caps" for the run, and per object the files copied, the versions added, the changed attachments replaced, those unchanged, those skipped by each cap and those that failed
- **Removal** -- removing a run takes back the files it created with its records (see [Removing what a run created](#removing-what-a-run-created)): a Salesforce File's first copy and a legacy attachment the run wrote, the new copy of a replaced attachment included, never a version it added to an earlier copy. The configuration then forgets the copies removed, and its next run reads their objects whole and copies them again when they are still in its scope
- A file object -- `Attachment`, `ContentVersion`, `ContentDocument`, `Document` -- is still refused as an object of its own: files travel with the records they hang on

### Removing what a run created

- **What a run keeps** -- every run, from the page, a re-run, a schedule or a pipeline's Sync step, keeps what it creates in the target as it writes it: the records it inserted, or upserted where the target held none, as the org said for each, and the files it created. A version added to an earlier copy of a file is the copy's, and is not kept. They are kept in the extension's storage, one file per run written as each call to the target answers -- each REST batch, each Bulk API job -- never in the settings VS Code saves whole, so a run a closed window stopped stays removable. A call under way when the window closed is named under **Runs that never ended**, with its object and its rows. A Bulk API job the org had opened runs on to its end on the org's side, whether the window closed or the run failed while it polled the job: the run keeps its id, reads it back by that id once the run is listed again or its removal is asked about, and the records it created are listed and removed with the run -- of an upsert, only those the org says it created. A REST batch cut off, or a job the org never opened, may have left rows in the target that are not listed, and the run's removal does not take them. Past 4 MB the runs whose creations were all removed go first, oldest first, once the records they wrote over were given back too; past 64 MB, the oldest runs
- **What a run writes over** -- a record the target held that an update wrote, or an upsert that found it by its key, was overwritten for good, and Review said it in words alone. Before each call that writes over records -- each REST batch, each Bulk API job -- the run now reads from the target the values those records hold, of the fields the call writes, and keeps them in the DataOps backup store before the call goes: on disk, readable by you alone, as a DataOps snapshot is, listed on the DataOps **Restore** tab as a backup of the target, marked as the Sync run's and saying that removing the run puts the values back too, where it can be restored -- a record two calls of the run wrote over is written once, each field as the run first found it -- or deleted, and kept for `sandforge.backup.maxAgeDays` (no number of DataOps backups pushes it out): the run's card says until when, and once its backup is gone, says before anything is asked that those values are no longer kept and offers nothing to give back. The backup's listing says how many records it holds as the run keeps them, marked partial until the run ends, so a run cut short is listed with what it kept. Each field of a record is kept once, as it was before the run first wrote it; a record the run created itself is not kept, since its removal deletes it. A classic encrypted field is not kept either when the run's user cannot view encrypted data, which the API answers masked: the run's file names it as not kept, and the card and the removal say it is left as the run wrote it. The run's file names the records written over and the backup, never a value. A call whose values cannot be read or kept is not sent: its rows are refused with why, and the run goes on with the next call. The run's results say how many records it wrote over, and offer the removal for them
- **Remove what this run created** -- on the run's results, Quick Sync's included -- which also open the run's history entry and say that a second Quick Sync inserts the records again -- on its history entry, and, for a run a closed window stopped, under **Runs that never ended** on the History tab. Nothing is asked of the org until the confirmation opens: it names the org, typed, what goes back per object, and what goes per object -- the files first, then the objects in the reverse of the order the run wrote them, children before their parents -- into the recycle bin, and what the target runs as the run is taken back, read as it opens, as a Forge removal's confirmation reads it: the Apex triggers that run after an undelete, as it brings back what the run deleted, what fires as it gives back what the run wrote over and as it sets an activated order back to Draft, and before and after each delete -- or that nothing does, or what could not be read. What a delta run deleted as the source had comes back from the recycle bin before anything else -- one emptied from it since is counted gone for good; a lookup the org puts back as it comes, on a record the run wrote over, dates that record anew, and the removal reads that date as its own doing, not as a change since the run. First, before anything is deleted, the records the run wrote over are given back the values they held before it, of the fields it wrote: only the fields that differ are written, and a record changed since the run -- modified, by the org's clock, after the run's last write -- stays as it is unless you include the changed ones; a record put back no longer names a record the run created, which then goes. A record changed since the run wrote it is kept unless you include it, and so is one that records staying in the org depend on; what the org refuses is counted with its reasons, and so are a record gone from the target and one whose values are no longer kept (its backup deleted, or past its retention). A record refused for a field whose value from before the org no longer takes -- a picklist value deactivated since, an owner no longer active, a lookup to a record deleted since -- is given back the rest of its values, and the field, left as the run wrote it, is named. A later run of the same target that wrote the run's records again is named on the card and in the confirmation: removed first, it stamps what it gives back on the earlier run, whose removal then reads those records as unchanged since it -- but for a record someone else changed between the two runs, which the later run read as last modified after the earlier one's last write, and not by the user the runs write as: it is given back that change, and the earlier run's removal reads it as changed since, kept unless you include the changed ones. A run another window is writing is not offered a removal, and its Bulk API job is never read back while that window runs. A removal that left records is offered again, for those
- **Sweep first** (off unless ticked) -- the confirmation offers to take back too what the target's automation created during the run, as the run's user, that the run did not write: a flow that opens a task on each contact a run wrote left those tasks behind once the run was removed. It is Forge's sweep, as Seed's and Frozen's removals make it, listed in the confirmation per object, a few by name, before the org's name is typed, and made before the run's records go. It looks in the objects whose records the run created, in tasks, events, feed, email messages, notes and case comments, and in the objects the target's flows on those objects and on the objects whose records it wrote over create, at what the run's user created from a second before the run's first write -- its first call to the target, an update before anything was created included, dated by this machine's clock as it went and read on the org's clock at the removal, or its first created record when that is earlier -- to a minute after its last write: the last record it created, read back from those records in the org or its recycle bin, or a later call, an update or the answer of a call included, dated and read as its first write is -- less the records the run created. A run that created nothing -- it only updated, or upserted onto records the target held -- is dated by its writes alone, and the user it wrote as is read from who last modified, in that window, the records it wrote over, before they are given their values back: on a Developer Edition, the feed items that tracking wrote as an upsert matched three accounts went with its removal. A record someone changed since is kept unless the removal includes the changed ones; a window in which the run's user created records on objects neither the run nor the target's automation reaches -- hand work, likely -- is not swept, and the listing says why. Production Guard judges it as a delete, and the audit trail records it beside the removal
- **Production Guard** judges the removal as the delete it is, and a removal that only gives back what the run wrote over as the update it is. It takes the target for what a Forge or a Frozen removal takes it for: on a production org the card offers nothing and says why, with the guard's reason, while a Developer Edition -- which Sync writes to as to a sandbox -- is not taken for one, and what a run created there can be removed; without a guard nothing is deleted. The removal is listed in Live Operations, and its Cancel, or the card's, stops it between two calls to the org, or two delete jobs; what it did not reach is offered again. The audit trail records it, as `cleanup_delete` from Sync with what it deleted, what it gave back (as updated) and what the org refused -- as cancelled when it was stopped
- **What the configuration forgets** -- a delta configuration's next run reads whole each object whose copies the removal took ("Full read (a removal took back copies it had written)"), and the record of the files it copied forgets the copies deleted: a later delta run never takes a removed copy for still there, and the next full read copies again what is in its scope. Nor does a later run point a lookup at a record the removal took: it leaves the configuration's record of which copy each source record became
- **From the command line** -- `sandforge-sync --remove <summary.json | run file | run id> --target <alias> [--include-changed] [--accept-automation] [--store <dir>] [--sweep | --sweep-list] [--leave-undeletable]` takes a run back from the summary it printed with `--json`, saved to a file, or from the file every run that writes keeps as it goes, as the page's runs do -- in `sync-runs/` of `SANDFORGE_JOURNAL_DIR` (`~/.sandforge` by default), named as the run begins -- with the same removal, what the run wrote over given back first from the backup store the run kept it in, `backups/` of `SANDFORGE_JOURNAL_DIR`, where `sandforge-backup` keeps its snapshots. A run killed, stopped by a Ctrl-C or ended by an error printed no summary, and its file takes it back all the same: a Bulk API job it had under way is read back from the target by its id first, and its records are removed with the rest. What the removal left on the run's records is kept beside the summary, or beside the run's file, for the next one, and given the store of the configuration the run was of, the removal tells it what it took, as the page's does. `--sweep` sweeps first, as the page's confirmation does; `--sweep-list` lists what it would take and deletes nothing. Before it writes, it says what the target runs as it takes the run back, step by step as the page's confirmation lists it -- the Apex triggers that run after an undelete as it brings back what the run deleted, what fires as it gives back what the run wrote over and as it sets an activated order back to Draft, and before and after each delete -- or that nothing does; when something fires, or could not be read, it writes nothing (exit `1`) unless given `--accept-automation`, as the clone's removal does. When the user it runs as may not delete the records of an object of the run, as the object's describe says, it names each before its first delete and stops, removing nothing (exit `1`); `--leave-undeletable` removes the rest instead, leaving those with the records they hang from. The command has no Production Guard to ask: it removes from a sandbox or a Developer Edition org, and refuses any other

### Object Set Editor

- Add/remove objects to the sync scope
- An operation per object: insert, update by Id, or upsert on an External ID. Delete is not offered: it deleted in the target the records holding the ids the source read, which between two sandboxes refreshed from one production are the target's own; a delta configuration carries the source's deletions instead. A row that comes with a delete, from a saved configuration or an SFDMU import, still shows it, and Review says what it does
- Configure batch size per object
- Available objects are loaded from the source org schema, without the objects no copy writes -- the list Forge and Autopilot read: users and their access, metadata, files and the links to them, a record's history, feed or sharing rows, the platform's jobs and logs. A configuration naming one is refused before it runs. A managed package's objects, such as Vlocity's, which Forge's discovery does not walk into, are offered: a sync copies only the objects it is given
- A per-object WHERE filter may only filter: a clause carrying `LIMIT`, `OFFSET`, `ORDER BY`, `FOR UPDATE`, a subquery, a comment or a semicolon is refused, including one imported from an SFDMU `export.json`
- An upsert key (external ID) is a single field API name; an SFDMU composite key such as `Name;Parent.Name` is refused. An empty External ID box counts as no key

### Field Mapping

The Field Mapping step is optional: an object with no mapping has its fields with the same API name copied, and the step says so. Its editor lists the mappings with a mapping type each (Direct, Rename, Transform, Constant, Formula, Exclude, Add-On) and a remove control; pick a source and a target field to add one, or click "Auto Map" to map every field whose API name is the same in both orgs.

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

- Summary badges for a delta run and for files, and, once an object finds a record the target holds, what the run does with it
- Object count, field mapping count, and transform count
- Each object, in the order the run writes it, with what it does -- insert, upsert on its key, update or delete by the source record's Id -- and why one is written later than listed ("Written after Contact, which its ContactId names"); and, when an object inserts, whether each run inserts every record again (a configuration not saved) or leaves what an earlier run copied as it is (a saved one); when an object updates or upserts, that what it writes over is kept first and put back by removing the run
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
- **Taken back as a run** -- A session that writes keeps what it writes as a
  Sync run does, from its first write to its stop, as the Auto-Sync box says:
  the records it creates, the values of the fields it writes over -- kept
  first in the DataOps backup store on this machine, for
  `sandforge.backup.maxAgeDays` -- and the records it deletes as the source
  deleted them. Once it has stopped, **Earlier sessions**, at the bottom of
  the tab, lists it with a run's removal card: the removal gives back what the
  session wrote over, brings back from the recycle bin what it deleted, and
  deletes what it created, a record changed since the session left as it is
  unless you include it; Production Guard refuses it on a production org. A
  session still writing, in this window or another, is not offered; one a
  closed window cut short is listed with the call it had under way, whose
  rows the target may hold and the list may lack.
- **Encrypted fields read masked** -- as a Sync run leaves them out, a classic
  encrypted field (`encryptedstring`) that the user SandForge reads the
  source as sees masked, lacking View Encrypted Data, goes in no change the
  session writes, rather than as its mask; the tab names those fields per
  object once the session starts, and again when the page opens on a session
  still running.
- **Emails and phone numbers neutralized** -- as a Sync run writes them, every
  email address a change writes goes in under `.invalid` and every phone
  number as a fictional one, the same number giving the same fictional one
  throughout the session, and the external id the change is found by kept as
  read. Untick **Neutralize emails and phone numbers** in the Auto-Sync box
  to have the objects found by their record Id or an external id written as
  the source holds them; an object found by the mapping of a saved
  configuration follows that configuration's choice (`keepContactPoints`).
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
  applied; on a bidirectional run the matching target records of an object
  written by upsert or update are read and compared as the run compares them. The target is then asked, a few hundred
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
- It says what a run would meet before its first write, as the run measures
  it: the order it writes the objects in, the records it writes, counted, those
  an earlier run copied that it leaves as they are, the data storage they take
  and the emails the target's automation sends for them against what the
  target has left, and whether the run writes, asks first or is refused.
- It writes nothing to the target, to the audit trail or to the sync history.
  Like a run it is listed in Live Operations, and its Cancel -- or the page's
  -- stops it before its next object. Each lookup is an API request: about one
  per two hundred records of an upsert, an update or a delete.
- A configuration never carries a simulation: a saved, scheduled or replayed
  configuration asking for `dryRun: true` is refused, so no run can be taken
  for one that only reports.

### Execution and Results

- Before anything is written, both orgs are described and every field a mapping copies unchanged is compared (the same-named fields when the object has no mapping). A field that cannot hold the other's type -- text onto a date, a number onto a checkbox -- stops the run with the list of mismatched pairs, and nothing is written. A mapping whose value a transform rewrites is not judged on its source type
- **Checked before its first write**, as Forge, Seed and Autopilot check theirs: the records each object's read returns are counted under its filter (`SELECT COUNT()`, a delta read from its watermark, the person accounts of an account or contact apart), less those an earlier run copied, and held to what the target has left. Past its data storage (`/limits`, a record at 2 KB, a person account at 4 KB) the run is refused with nothing written. Past `sandforge.safety.confirmAboveRecords` records, near that storage, when the storage cannot be read, past a daily email limit the target's automation -- read as Forge reads it -- would send against, or when what the target has left of such a limit, or its automation itself, cannot be read, a run started from the page, a re-run or a Quick Sync asks first, naming the records per object, the storage and the emails, those it could not count included; cancelled, or with nobody to ask, nothing is written. A scheduled or pipeline run, which nobody watches, is refused past a daily email limit -- each record past it would be refused by the Flow that sends -- and goes on otherwise; the command line is refused past either limit. A refusal is recorded in the audit trail as stopped, with its code, and is no run of the history
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
- That count costs API calls: one `SELECT COUNT()` per object of the run --
  two for an account or a contact, whose person accounts are counted apart --
  sent before anything is written, whether `sandforge.grappe.enabled` is on or
  off: Grappe's threshold is measured on the same count. Each counts against
  the org's daily API request limit, production included. An insert of a saved configuration that earlier runs wrote reads
  the ids its filter returns, and asks the target which of their copies it
  still holds, a request per two hundred.
- Per-object result breakdown: processed, succeeded, and failed counts
- A write of more than 200 records goes in one Bulk API 2.0 job, its rows
  with every field any of them carries. A field a row does not carry goes
  as an empty cell, which the platform reads as no value: an update leaves the
  field as it was, an insert gives it its default. Each row gets its own result
  back, with its record id, whatever fields it carries and whatever form the
  platform writes its values back in; a row the job answered nothing for says
  so, and names the records the job wrote that no row was matched to, which
  the SandForge output channel lists in full. A job cannot carry the header
  that lets a duplicate rule's matches be saved, so the rows a rule refused
  in it (`DUPLICATES_DETECTED`) go again through REST with it, 200 a call and
  only those: a rule that only alerts lets them be saved, one that blocks
  refuses them again, and the output channel says how many went again and
  were saved. A Frozen load, a clone from another org and a CSV import write
  through the same path
- Per object, the records refused grouped by reason -- the status code and the fields it named, how many records, one example in the org's words, and what it means and what to do; a run keeps the refusals of the first 1,000 records refused per object, its history entry the first 50, and both say when they kept fewer than were refused

## Tips

- Use "Auto Map" on the Field Mapping step first, then adjust the few fields that do not match
- Narrow the object set and batch sizes for recurring syncs -- a full run reprocesses the full scope; save a recurring one in delta mode to read only what changed
- Files travel with their records, never as objects: `Attachment`, `ContentVersion` and `Document` are not offered in the object picker, are absent from the prebuilt templates, and a configuration naming one is refused before it runs -- Bulk API 2.0 rejects base64, so such a run used to break past 200 records. Tick **Copy the files of these records** instead (see [Files](#files))
- Simulate before a run that updates or deletes: a delete cannot be taken back, an update can only by removing the run, and the simulation says how many records it would touch
- Always review PII warnings in the Review step before executing
- If sync fails on certain objects, check field-level security on the target org
- Use the Sankey diagram to verify data flow before execution
