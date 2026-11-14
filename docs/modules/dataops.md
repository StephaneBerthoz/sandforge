# DataOps

Back up your org data, anonymize sensitive fields, find and erase one person's
records, and clean up the records nobody needs, from a single tabbed page.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.dataops in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick the org in the list at the top of the page, then open the Anonymize tab.
2. Pick a template in Select a template; its card lists each field it masks.
3. Click Preview: the first records show Original beside Masked, and nothing is written.
4. Click Apply, tick Keep the values first and, if shown, Mask in slices, type the org's name, Confirm.
5. To empty objects or the whole org, open Cleanup: its preview says what goes before any delete.

**Tip:** Unless you untick Keep the values first, Apply backs up the values it masks: Open in Restore, then Restore, puts them back.

<!-- how-to:end -->

> **Status.** Backup, Restore, Anonymize, Compliance, Cleanup and Data Quality
> are wired end to end. Each section below says what it does and where it stops.

## Quick Start

1. Navigate to **DataOps** from the sidebar, and pick the org in the list at the top
   of the page: the one the status bar and the other panels follow
2. The KPI row shows the org's backups on this machine and the records they hold,
   how many of them are partial or failed, and how many anonymization templates
   are listed
3. Use the tab bar to switch between Backup, Restore, Anonymize, Compliance, Cleanup, and Quality
4. Before masking, leave **Keep the values first, so Restore can put them back** ticked in
   Apply's confirmation, or start with a backup: without either, the mask cannot be undone.
   An object holding more records than one backup does is masked in slices, each backed up
   just before it is masked, once **Mask in slices** is ticked there too
   ([Masking in slices](#masking-in-slices))

## Features

### Backup

Take a copy of the objects an Anonymize writes over:

- The objects follow the templates: a backup reads the objects the template
  picked on the Anonymize tab masks or, with none picked, every object a
  listed template masks -- Contact, Lead, Account and Opportunity for the
  templates that ship -- as a masking run of them plans them in the org:
  Account too for a template that masks contacts, in an org with person
  accounts. The Backup tab names them before the click. Each is
  read whole, every field, page after page -- 2,000 records a page on a
  sandbox, 500 on production or a Developer Edition -- up to a cap of
  records per object, `sandforge.backup.maxRecordsPerObject` (50,000 unless
  you set it, from 100 to 1,000,000). There is no object picker and no
  incremental mode -- each backup is a new copy
- **Back up in slices.** When an object the tab reads holds more records than
  one backup does -- the masking check of the template picked plans it in
  more than one slice, or the latest backup of it stopped at the cap -- the
  tab offers **Back up in slices**, unticked. Ticked, **Create Backup** backs
  up each object in slices of the cap's records, consecutive by `Id`, each
  slice a backup of its own: an object past the cap, or past 1,000,000, is
  held whole, up to 2,000 slices. The slices make a set, listed on one row
  here and in Restore, restored whole or a slice at a time, and deleted whole
  (see [Restoring and keeping a set](#restoring-and-keeping-a-set)). A slice
  the org will not read in time (`QUERY_TIMEOUT`, `OPERATION_TOO_LARGE`) is
  read again halved, three times at most and never under 100 records; past
  that, past 2,000 slices, or on any other failure, the backup stops there. A backup in slices stopped part way --
  that, or a cancel -- keeps the slices it took, says so, and holds part of
  its objects; it is not resumed: take another. The panel offers no filter:
  `sandforge backup` holds an object to one with `--where <Object>:<clause>`
  ([In slices from the command line](#in-slices-from-the-command-line))
- A classic encrypted field (`encryptedstring`) is not kept when the user
  SandForge connects as lacks View Encrypted Data, which the API answers
  masked: the Backup tab names it per object, and a restore leaves it as the
  org holds it. Kept, the mask was written back over the real value
- Each page is written to disk before the next is read, one record to a
  line, so a backup holds one page in memory whatever the object's size
- An object of hundreds of fields, too many for one query, is read in
  groups of columns merged by `Id`, each group naming the record's
  `SystemModstamp` when the object has one: a record saved between two
  groups is read again, and one deleted between them is left out, so no
  record is kept with the values of two saves
- Every backup is written to extension storage with per-object record counts,
  the records each object held when it was read, and the org id the org
  answered with, and listed newest-first in the Backup tab
- A backup that reached the cap on an object says so in the Backup and
  Restore tabs and in Apply's restore check, per object: the records it read,
  the records the object held, and that it stopped at the cap. A restore of
  it brings back those records only. Of an object past 1,000,000 records,
  which no backup holds whole, the tab names **Back up in slices** instead
  of the setting
- One-click backup creation from the Backup Panel
- A backup is listed in Live Operations while it reads, and the Backup tab
  offers **Cancel run** meanwhile. It stops between two pages when either
  cancels it, the window closes or the extension deactivates, and what it
  wrote is removed, so a stopped run leaves no half-saved backup -- run it
  again for a complete one. A backup in slices keeps the slices it took
  before the cancel, as said above
- A backup whose read the org fails part-way keeps the records it read,
  listed as failed and partial with the object it stopped on and each object
  it never reached, which it holds none of -- the Backup and Restore tabs and
  a restore's warning name them -- and says so; one the disk could not take a
  page of keeps nothing
- A backup holds the records' values unencrypted, personal data among them,
  in files only your user can read. It is kept until ten newer ones of the org
  push it out (`sandforge.backup.maxCount`), or for
  `sandforge.backup.maxAgeDays` days, 30 unless you set it (0 keeps them),
  removed as SandForge starts and after each backup. A Sync run keeps here,
  listed as a backup of the org it wrote to, the values it wrote over, which
  removing the run gives back: only their age takes those, and the run's card
  says until when. `sandforge backup` and `sandforge dataops` apply the same
  retention as they start, `--max-age-days` setting it (0 keeps them all), and
  name on stderr each backup they remove, a Sync run's said as the run's. A
  backup taken before
  that setting existed is kept until you delete it: the retention counts from
  the first start that had it, so an upgrade never takes a backup away. The Restore tab deletes
  one, or every backup of the org; disconnecting an org asks whether its
  backups go with it, and an erasure offers to delete those taken before it.
  A set of slices is never one of the ten: it goes whole, its age counted
  from when it last moved, and a slice is never deleted alone (see
  [Restoring and keeping a set](#restoring-and-keeping-a-set))

### Restore

> **Wired since v1.18.0.** The tab sends `dataops:rollback`, the backup list it
> reads is populated, and the CRUD/FLS gate that used to refuse every restore
> now answers field by field. Before 1.18.0 the button reached the backend and
> the backend said no, on every object, every time.

Restore data from a previously saved backup:

- Browse available backups with timestamps, record counts and the objects
  each holds, newest first
- Select a specific backup and restore it to the current org. **Restore** asks
  first, writing nothing until **Restore into _org_**: the question names the
  org, each object of the backup with its records, and that the rows changed
  since the backup get its values back, whoever changed them — of a Sync run's
  backup, that the records changed since the run are left as they are
- A restore puts the whole backup back: there is no choice of records, objects
  or moment in time, only of which backup -- of a set of slices, of every
  slice or one of them (see
  [Restoring and keeping a set](#restoring-and-keeping-a-set))
- The backup a Sync run kept of the records it wrote over is listed here too,
  marked as the run's and saying that removing the run in Sync puts the values
  back as well. Restored from here, a record the run's calls kept in more than
  one line is written once, each field as the run first found it; and, as the
  run's removal does, a record changed since the run — modified after its last
  write — or deleted since is left as it is, and counted per object with the
  result, unless **Also restore the records changed or deleted since the run**
  is ticked. `sandforge backup --restore` and `sandforge dataops anonymize
--restore` leave them as they are too, and end on exit code 3, unless
  `--include-changed` is given, as the run's own `sandforge sync --remove
--include-changed` gives them back. Its delete question says that removing
  the run will no longer put these values back. A run
  no longer kept on this machine has no known last write: every record of its
  backup reads as changed since

What a restore does, in order:

- Refuses a backup taken from a different org than the one selected
- Passes through Production Guard like every other write path: a blocked
  operation stops, and a write to a production org asks first
- Asks before writing when the org now answers with another org id than the
  one the backup recorded, as a sandbox does once refreshed: the records the
  backup saved belonged to the org it was, and the restore cannot put them
  back. Declined, nothing is written. A backup that recorded no org id is
  restored without the question
- Brings back from the recycle bin the records of the backup deleted since it
  was taken, so they return with their `Id` and what pointed at them; a record
  no longer in the recycle bin cannot, and is reported as refused
- Reads the org's values of each batch of 200, by `Id` and with the fields it
  would write, and upserts on `Id` only the rows where one of them differs from
  the backup; the others are counted as unchanged, and the result says how
  many. A row the org no longer holds goes too, and its answer says what became
  of it; a batch whose values cannot be read is written whole. **Write every
  row of the backup back** on the Restore tab, or `--rewrite-all` with
  `sandforge backup --restore`, upserts every row, the unchanged ones included
- Reports progress per object, reading the backup 200 records at a time:
  backups taken before records went one to a line, and those kept in extension
  state before files, are read as they were written
- Says, with its result, when the backup held only part of an object -- the
  cap, a read that failed, a file no longer all there -- and that the rest of
  the object was left as it is
- Says, with its result, what the active duplicate rules of the objects it
  put back wrote during it for the records it wrote, and keeps it, as a
  masking does (see [Anonymize](#anonymize)): a restore writes back the values
  a rule matches on. The page warns when they wrote something or it could not
  be read, and `--json` carries it under `duplicates`
- Drops the fields _nobody_ may write — a backup is a verbatim
  `SELECT FIELDS(ALL)` snapshot, so it always carries `CreatedDate`,
  `SystemModstamp` and friends — and logs which ones it dropped
- Stops with an FLS error if a field _you_ may not write is in the payload,
  rather than restoring the record with that column silently missing

A restore is listed in Live Operations while it writes, and the Restore tab
offers **Cancel run** meanwhile. It stops between two batches when it is
cancelled — from either, by Ctrl-C at `sandforge dataops --restore`, or as the
window closes — as a masking run does: the records it put back before are counted,
the audit trail records it cancelled with them, and the same restore run
again puts back the rest, writing only the rows that do not hold the backup's
values yet.

### Anonymize

Mask sensitive data using the built-in anonymization templates, or templates of
your own:

- Browse anonymization templates from the template library; each rule is
  listed by the `Object.Field` it masks and its method
- Apply a template to replace PII with realistic but fake data
- **Every record.** A run counts each object's records first
  (`SELECT COUNT()`), then masks them a page at a time, in `Id` order: 2,000
  records a page on a sandbox, 500 on production, each page written back in
  batches of 200 before the next is read. An object of any size is masked
  whole, and the progress counts records against what the counts said. The
  counts come before Production Guard is asked, so its confirmation says how
  many records the run writes over, and a sandbox run past 50,000 records is
  logged with the guard's volume warning. A backup holds at most its cap of
  records per object (see Backup), so on a larger object it cannot bring back
  every record a run masks: the restore check marks, per object, a backup
  that stopped at the cap or on a failed read and names the setting that
  raises the cap, and Apply's confirmation names, per object, the records a
  restore of the latest backup can never bring back. An object holding more
  records than one backup does is planned there in slices, which keep a
  backup of every record a run masks (see
  [Masking in slices](#masking-in-slices))
- **What a run reads and writes.** It reads the `Id` and the fields the
  template names. It writes those fields where they hold a value, and nothing
  else of the record: an empty field stays empty rather than being given a
  made-up value, and a record none of whose named fields holds anything is not
  written at all
- **Keep the values first.** Apply's confirmation offers **Keep the values
  first, so Restore can put them back**, ticked unless you untick it, as the
  command line always does: before its first write, the run takes a backup of
  the fields it masks, held to the records it masks, listed with the backups.
  It writes nothing unless that backup holds every record it would mask. An
  object holding more records than the cap is masked in slices once the
  confirmation's **Mask in slices** box is ticked too, each slice backed up
  just before it is masked (see [Masking in slices](#masking-in-slices));
  asked without slices, such a run is refused before Production Guard is
  asked, `SNAPSHOT_NOT_TAKEN`, nothing masked, and the tab names the box. A
  backup that cannot be taken refuses the run too, under the same code,
  nothing masked, and the tab says how to mask without one. Its result points to the backup, and **Open
  in Restore** opens the Restore tab on it. Unticked, the confirmation names
  instead the records a restore of the latest backup can never bring back,
  and nothing is masked in slices. A resume takes no backup: the run it
  resumes took one -- a run in slices resumed backs up each slice it has
  left
- **Every field of the template, or nothing.** Once the records are counted,
  and before Production Guard is asked, a run looks up every field its
  template names on the objects that hold records. A describe lists only what
  the connected user may read, so a field the org lacks and a field
  field-level security hides look alike: the run is refused, `MASKING_FIELDS_UNSEEN`,
  it names them and what may hide them, and it masks nothing. Give that user
  read and edit access to the field, or take the field out of the template; a
  template that ships is not edited, and **Create Template** starts from its
  rules. An object of which no field can be masked is named too, and an object
  whose rules mask nothing in this org refuses the run under
  `MASKING_MASKS_NOTHING`. A resume is held to the same check, and
  `sandforge dataops anonymize` ends on exit code 1. An object with no record
  holds nothing to mask, and refuses nothing
- **A run that stops before the end says what it left.** A cancel -- the
  Anonymize tab's **Cancel run** while the run masks, or Live Operations',
  where it is listed -- honoured between two batches, or before the first
  write while it counts, waits on Production Guard or takes its backup; the org's daily API requests reaching 95%, past which
  the run makes no further call; an error; records the org refuses. The run
  then ends partial -- failed when it masked nothing -- and says, per object,
  how many records still hold their original values: in its result, in the
  message the page shows, in the audit trail (Reports: refused records as
  failed, records never reached as not sent; a run you cancelled as
  cancelled, or as stopped under `RUN_CANCELLED` when it had masked nothing
  and the org had refused nothing) and in the output log.
- **Duplicate rules.** A masking writes one kind of value over every record
  -- the same `preserve_format` address, names drawn alike -- and an org's
  active duplicate rules then match the masked records with each other. Before
  its question, the read of what the org runs names, object by object, the
  active duplicate rules of what it writes over, as Restore's question and an
  erasure in place name them: a record a rule only alerts on is written, one a
  rule blocks is refused, and what a rule that reports writes, a duplicate
  record set and its items, stays. Only a record the org saved can be
  reported: once the org saved the first record of such an object, the run
  reads the org's clock, dated back to when that update went out; once its
  last write is in, it waits for what is left of 5 seconds after the last
  such record, the few seconds a rule's report takes to land, then reads the
  duplicate record items created since its first write that sit in a set
  holding one of the records it masked, and those sets created since: a query
  of the items, then a query of their sets for every 200 of them. An update
  whose answer never came counts as saved, since the org may have saved it.
  Its result says how many sets and items the rules wrote for the records it
  masked (at least that many past 2,000 items), that they wrote nothing, or
  that it could not be read, then how many requests that took, the clock
  included, and how long it waited (`requests`, `waitedMs`); a run that fails
  half way says it as well. What they wrote is kept, never removed: every
  item names a record that stays, and a masking deletes nothing. The page
  warns when they wrote something or it could not be read, and `--json`
  carries it under `duplicates`. A run that saved no record of an object with
  an active rule -- every one refused, or none holding anything to mask --
  sends none of these requests and waits for nothing. A restore and an
  erasure in place read theirs the same way
- **Resume where it stopped.** A run that stopped before the end keeps, on
  this machine, where it got: per object, whether it was read to the end, the
  last record it handled, and the records the org refused. The Anonymize tab
  then offers **Resume where it stopped** beside Apply: the resume first tries
  the refused records again, by `Id`, then reads each object on from where the
  run stopped, so no record the first run masked is masked again. The records
  of a write whose answer never came are read back first: those holding what
  the run sent are done, the others go again -- an address
  already hashed would be hashed once more, and no longer give the same
  pseudonym as on the objects masked once. Apply still masks every record. A
  run that leaves nothing unmasked forgets where the last one stopped; a
  template whose rules changed since cannot be resumed, nor can a run the org
  refused more than 2,000 records of -- Apply masks those. A run in slices
  resumes its set instead, with **Resume the run in slices**, whatever the
  org refused, and Apply waits for it (see
  [Stopped, resumed, given up](#stopped-resumed-given-up))
- **What the templates that ship write.** Sandbox Data Scrub replaces a
  website with `https://example.com`. HIPAA Health Data keeps the first three
  characters of a postal code, the region a ZIP code's first three digits
  name. CCPA California and HIPAA Health Data hash an email into an address at
  `example.invalid`, a domain that receives no mail: the same address becomes
  the same pseudonym on a contact and on a lead. GDPR Standard makes up an
  email at `example.invalid` too, as the Fake method does for every address
  it writes. A made-up person is drawn from ten thousand names: no two
  records of one run get the same name while names last, nor the same
  address, which carries a short token, `first.last.ab12`; a name given again
  once names run out says in its address how many times, `first.last2.cd34`.
  A resume carries on from the names the run it resumes made up -- the
  checkpoint keeps how many times each was given, and no value of any record
  -- so it gives none of them again, nor any of their addresses, until names
  run out. A run stopped before checkpoints kept them is resumed as before,
  and may give again a name that run gave; the output log says so
- **Person accounts.** On the accounts of an org with person accounts, a
  template masks a person account's own fields as it masks a contact's: each
  of its Contact rules applies to the field the person account holds it in
  -- `FirstName`, `LastName`, `Salutation` and `Phone` under their own names,
  `PersonEmail` for `Email`, `PersonMailingStreet` for `MailingStreet`, a
  custom field as `__pc` -- and the fields only a person account holds that
  the personal data detector names and no rule covers (a mobile or home
  phone, a birthdate) are overwritten as an erasure overwrites them. Field-level
  security on a contact's field hides the person account's too, and such a
  field refuses the run as a field the template names does,
  `MASKING_FIELDS_UNSEEN`, `--object Account` included; a contact's field that
  no person account holds, such as `Description`, masks nothing there. Those
  rules mask person accounts only; a business account keeps its rules, a
  person account goes without a rule on `Name`, which the platform computes
  from its first and last names, and an org without person accounts is
  masked as before. The backup a run keeps first holds each account's kind, and a restore
  writes each back with the fields its kind holds. A run that names no
  object -- Apply, or the command line without `--object` -- masks Account's
  person accounts too, in an org that has them, when the template masks
  contacts: planned from its rules alone, the CCPA template, whose rules name
  Contact and Lead, masked every contact and left every person account in
  clear. Its business accounts, which hold none of it, are neither counted,
  read nor kept in that backup
- **Preview before Apply.** **Preview** reads the first five records of each
  object the template masks, in `Id` order -- the ones a run masks first --
  and shows each masked field as the org holds it beside the value Apply
  would write, masked in this window as Apply masks it. It writes nothing,
  so it asks no confirmation. An empty field stays empty, as Apply leaves it;
  an object the org will not read is listed with what the org said. What Apply
  would be refused for is said first, in the words of the refusal, and again
  in its confirmation: a field the org does not show, an object with no field
  left, and what the connected user may read and not edit (`CRUD_FLS_DENIED`),
  which `anonymize --dry-run` and an environment's plan refuse as well. A
  made-up name is the one Apply writes on the first object; on the next ones Apply may draw another for a
  record whose name an earlier record of the run took first. Apply cannot be
  undone unless it keeps the values first (see above) or a backup holds them.
- **Your own templates.** **Create Template** opens an editor on the rules of
  the template on screen, or on none: change a rule's field or method, add or
  remove rules, name the set and save it. A rule names its field as
  `Object.Field`, one rule per field, and uses any of the methods: Fake, Mask,
  Hash, Nullify, Shuffle, Preserve Format, Constant or Truncate. Constant
  asks for the value it writes, Truncate for how many characters it keeps
  (1 to 255) and from which end, and the template cannot be saved while one
  is missing; a rule it starts from keeps its own -- the placeholder URL of
  Sandbox Data Scrub, the first three digits HIPAA keeps of a postal code. A
  name another template already goes by is refused.
- A saved template is kept in extension storage on this machine, listed after
  the ones that ship, marked as saved, and applied like them. It can be deleted;
  a template that ships cannot. There is no import or export.
- **Reproducibility.** No template carries a salt, neither those that ship
  nor those you save: a salt written into a template is readable by anyone
  who has the template. Every rule, a hash included, draws from a key the
  window generates when it starts and never writes down, so two runs in one
  window mask a record identically and the next window masks it differently.
  A resume in another window masks what the first run left with that window's
  key, and still gives none of the names the first run made up. A run in
  slices alone keeps its key, until its set ends, so that its resume in any
  window masks as it did (see
  [Stopped, resumed, given up](#stopped-resumed-given-up)).

### Masking in slices

A backup holds at most `sandforge.backup.maxRecordsPerObject` records of an
object, 50,000 unless you set it and 1,000,000 at most, and so does the backup
a masking run keeps first. An object holding more is masked in slices: up to
that many records each, consecutive by `Id`, each backed up just before it is
masked, and masked from that backup's file rather than from a fresh read of
the org, so that a record created after its slice was backed up is never
masked without a copy. The slices of a run make a set, which Restore puts back
whole or a slice at a time. The run writes over REST, 200 records a call, and
sends no Bulk API batch.

#### Asking for it

- **Apply's restore check plans it.** When an object the template masks
  holds more records than one backup does, the check adds an **In slices**
  column, each object's slices, and what the run would take:
  its requests -- the backups' pages and the org's clock before each slice,
  the updates, the reads of what an active duplicate rule wrote after each
  slice, and the counts of records created during the run -- against what
  the org has left today, unless that could not be read, said to fit, to
  come close, or to pass it, which is no refusal: the run then goes as far as
  the day allows, stops between two slices, and Resume carries on; no Bulk
  API batch; the disk the slices'
  backups take on this machine, and what is free there; and about how long it
  runs. An object the org gives up counting (`QUERY_TIMEOUT`,
  `OPERATION_TOO_LARGE`) is planned on the org's own figure of its records,
  said to be approximate: a run in slices reads by `Id`, and needs a count
  only to plan
- **The confirmation asks for it.** With **Keep the values first** ticked,
  Apply's confirmation shows that plan above a box, **Mask in slices, each
  backed up just before it is masked**, unticked: **Confirm** waits until it
  is ticked, and names the objects that need it. The confirmation says too
  that a slice that cannot be backed up whole stops the run there, the slices
  before it staying masked with their backups, and what the run's hold on the
  org covers (below). Unticked **Keep the values first** takes no backup and
  no slice: the run masks every record with no way back, as before
- **Refused before Production Guard is asked**, nothing masked: an object
  that would take more than 2,000 slices (`SLICES_EXCEEDED`), with the
  setting to raise; a disk that has less free than the plan's backups take
  and a tenth more (`SLICE_DISK_SHORT`), with what makes room; a run of the
  template still open on the org (`SLICE_RUN_OPEN`, below). Then the run reads
  what the org runs, asks Production Guard on every record it would mask,
  and takes its mute's lease, as any masking does

#### What a run in slices does

- **A slice after the other.** For each object, then each slice, the run
  checks that the slice would not take the org past 95% of its daily API
  requests, the rest being its integrations', and that the disk has room for
  it; reads the org's clock; backs the slice up, page after page as a backup
  reads;
  then masks its records from that backup, 200 a call. The progress says the
  slice and its step: _Backing up Contact, slice 2 of about 4_, then _Masking
  Contact, slice 2 of about 4: 412,000 of 1,000,000 records_. The slices'
  backups are not listed one by one in the activity feed or in Live
  Operations: the run is, with its progress
- **Each slice, its own duplicate rules and people.** As a slice ends, the
  run reads what the active duplicate rules wrote for its records (see
  [Anonymize](#anonymize)), then forgets the people it made up for them,
  keeping how many times each name was given: what it holds in memory is one
  slice, never the object
- **A slice the org will not read in time** (`QUERY_TIMEOUT`,
  `OPERATION_TOO_LARGE`) is read again halved, three times at most and never
  under 100 records, and the size it was read with is kept with the slice and
  shown beside its records. Past that, the run stops there,
  `SLICE_READ_TOO_HEAVY`, nothing of that slice masked, and names a filter on
  an indexed field from the command line, or a lower setting. A slice whose
  backup fails for any other reason stops the run the same way. Either way,
  the slice's backup is not kept, and the next run takes the slice again
- **Deleted since its backup.** A record the org answers as deleted
  (`ENTITY_IS_DELETED`) when its slice masks it is counted as deleted since,
  neither refused nor left; a restore brings it back from the recycle bin, as
  it does any record deleted since a backup
- **Created during the run.** Once every object was read to its end, the run
  counts the records created since it began, by the org's clock, in a range
  a slice had masked, and past the last slice: no backup holds them, and they
  were not masked. The result says how many, the run ends partial, and Resume
  masks them, each such range a slice of its own, marked late, backed up
  first. A count the org refuses is said with the object, as records that may
  have been left
- **What it says at the end.** One row per slice -- the records its backup
  holds, masked, refused, deleted since, and its state -- then the records
  created during the run, and **Open the set in Restore**. A run that left
  nothing ends its set, and forgets its key. The audit trail records each run
  once, its details naming the set, the records a slice holds and the slices
  that run masked, and the page notifies how the run ended

#### Stopped, resumed, given up

- **Left open.** A run stopped part way -- cancelled, the org's day, a slice
  not backed up, the disk, the window closed -- leaves its set open on this
  machine. While it is, Apply of that template on that org is greyed, the
  reason beside it, whatever objects or filter it would be given; a
  pipeline's Anonymize step with that template is refused too
  (`SLICE_RUN_OPEN`)
- **Resume the run in slices** carries it on, in this order: the records of
  an update whose answer never came, read back by `Id` as any resume reads
  them; the records the org refused, which each slice keeps beside its
  backup, however many; the rest of the slice it stopped in, from its
  backup's file past the last record it handled; then the records created
  late and the slices it did not reach, each slice backed up first. A run
  whose template's rules changed since cannot be resumed: the tab then
  offers Abandon alone
- **Its key.** The run hashes, and draws its people, with a key kept in the
  editor's secret storage until the set is done, given up or removed: a
  resume, in another window too, gives the same address the same digest
  and the same record the same person. The key adds nothing to what the
  machine holds already: the slices' backups hold the values unencrypted. A
  resume that does not find that key is refused (`SLICE_KEY_LOST`), nothing
  masked: give the set up, restore it if its values are wanted back, and
  mask again
- **Abandon the run** asks first, then gives the set up: nothing more is
  masked, and no resume carries it on. The slices it masked stay masked,
  each with its backup, which Restore puts back until the retention removes
  them; the records no slice reached keep their values. Its key and its
  checkpoint go: a new Apply masks with another key, and the same address
  gets another digest. Abandon writes nothing to the org, and is refused
  while the run still goes in this window
- **Its hold on the org lives in this window alone.** From its first backup
  to its end, the run holds the org's backups and restores in this window, so
  that no restore writes the values back over a slice said masked: another
  backup or restore of the org started there is refused. The hold is kept in
  memory, by this window: a restore from the command line or from another
  window is not held off. Start none until the run ends

#### Restoring and keeping a set

- **One row a set.** Backup lists a set on one row, whatever its slices --
  what took it, a masking run or a backup, when, its slices and records --
  with the way to it in Restore. Restore lists it on one row too, with any
  filter it was held to and where it stands, **Open**, **Done** or **Given
  up**, and shows its slices, each with its records and state: opened on the
  set a masking run's **Open the set in Restore** names
- **Restore all** puts back every slice not restored yet, **Restore slice
  _k_** that slice alone, again if it was. The question names the org, each
  object with its records, what the org runs as they are written back, and
  about two requests per 200 records, no Bulk API batch. Each slice then goes
  back in order, from its own backup, the way a backup's restore goes -- the
  records deleted since brought back from the recycle bin, only the rows that
  differ written -- under one read of what the org runs, one Production
  Guard question and one mute for the whole. Stopped part way, the same
  **Restore all** carries on from the first slice not restored; with **Write
  every row of the backup back** ticked, it puts every slice back again. A
  set whose every slice was put back already says when, and writes nothing
- **A masking set still open is not restored**: resumed, its run would mask
  again what a restore puts back. Resume it to its end, or abandon it, first
- **Retention.** A set is never one of the ten backups of an org
  `sandforge.backup.maxCount` keeps: it goes whole -- its slices, its
  manifest and its key together -- once `sandforge.backup.maxAgeDays` days
  passed since it last moved. An open set goes too, which ends its run: the
  next Resume says there is nothing to resume. **Delete the set** deletes it
  whole; a slice is never deleted alone (`SLICE_DELETE_ALONE`)
- **No export.** **Export** on the Backup tab writes a backup that is no set;
  nothing writes a set's slices to one file
- **Apply's restore check reads no set.** The latest backup it counts, and
  the records the confirmation says a restore could never bring back, are of
  a backup that is no set: a backup in slices is not counted there
- **The editor and the command line keep their own.** As their backups, the
  panel's sets live in the editor's storage, the command line's in its store:
  a set taken by one is not listed by the other, and a run is resumed, given
  up and restored where it began

#### In slices from the command line

`sandforge dataops anonymize --slices` masks in slices of `--max-records`
records, 50,000 unless given, from 100 to 1,000,000, and
`sandforge backup --slices` backs up in slices of that many:

```sh
npx sandforge dataops anonymize --org <alias> --object Contact --template tpl-ccpa-california --slices --dry-run
npx sandforge dataops anonymize --org <alias> --object Contact --template tpl-ccpa-california --slices --max-requests 200000 --yes
npx sandforge dataops anonymize --org <alias> --object Contact --template tpl-ccpa-california --resume --yes
npx sandforge dataops anonymize --org <alias> --object Contact --template tpl-ccpa-california --abandon
npx sandforge dataops anonymize --org <alias> --restore <set> --slice 2 --yes
npx sandforge backup --org <alias> --object Contact --where "Contact:CreatedDate >= 2025-01-01T00:00:00Z" --slices
```

- **Without `--slices`**, a run whose object holds more than `--max-records`
  is refused before Production Guard is asked, exit `1`, and names
  `--slices` with the slices it would take; its dry run says so, exit `1`
- **`--dry-run` with `--slices`** says each object's slices, then the run's
  requests against what the org has left today -- it fits, it comes near, or
  about how many slices go today, the rest left to `--resume` --, no Bulk API
  batch, the disk in the store with what is free there, and the time. What a
  run would be refused for -- more than 2,000 slices, the disk, a set left
  open -- ends it on exit `1`
- **`--max-requests <n>`**, with `--slices`, stops the run between two
  slices before the next would send more, exit `3`; 95% of the org's daily
  API requests stops it the same way. On a resume, it is given with
  `--slices` again
- **`--resume`** carries on the set of the template left open, with the same
  object and filter, `--slices` or not: in this process or another, on the
  same store, with the key the store keeps in `keys/`, one file per set that
  only its owner reads, removed once the set is done, given up or removed
- **`--abandon`** gives the set up, after a question unless `--yes`, and
  writes nothing to the org
- **`--restore <set>`** puts back every slice not put back yet, in their
  order, and the same line after a stop puts back the rest; `--slice <k[,k]>`
  those slices alone, again if they were; `--rewrite-all` every slice again.
  `sandforge backup --restore` takes a set the same way
- **`sandforge backup --where <Object>:<clause>`**, with `--object`, holds an
  object to a SOQL condition, read up to the first colon, one per object. The
  snapshot holds the records under it, not the object, and its listing says
  the filter; a masking run's check counts it only for a run under that same
  filter. `--list` names a set on one line, whatever its slices, with when the
  retention removes it; `--delete <set>` deletes it whole, its key with it,
  and refuses a slice alone
- **Exit codes**: `0` every record masked, `1` refused before anything was
  written, `3` partial -- slices not reached, `--max-requests` or the org's
  day, records refused or created during the run --, `130`, `143` or `129`
  stopped by a signal, the set left open for `--resume`. A backup in slices
  stopped short ends on `3`, its set holding part of its objects

#### Where slices are not

- **A pipeline's Anonymize step masks no slices**: an object past what one
  backup holds refuses it before its first write, naming the panel and
  `--slices`, and a run of its template in slices left open refuses it too.
  A pipeline's Backup step backs up no slices either: past the cap, it keeps
  the records up to it, as before
- **`sandforge.yaml`** masks in slices with `slices: true`, `maxRecords` and
  `maxRequests` on a mask resource ([A mask
  resource](../environments.md#a-mask-resource)). Its apply never resumes or
  gives up a set left open: the plan blocks the resource until
  `sandforge dataops anonymize --resume`, or `--abandon`, run on the
  resource's store with its object and rules, ends the set

### Compliance (GDPR/CCPA)

Find which fields hold personal data, then handle a data subject request: find
one person's records, export them, and erase them.

**Personal data inventory.** Pick up to 10 objects and **Find personal data**:

- The fields are named by the detector the Seed and Sync pre-flight checks
  run, from their API names, labels and types (an `email` or `phone` type, a
  name like `Birthdate` or `MailingStreet`)
- A sample then confirms them: the **last 200 records of each object by Id**,
  the newest ones. For each field the inventory says how many sampled records
  fill it, so a field the detector names but nobody fills shows as empty in
  the sample
- The sample's text values are handed to the same detector, which names the
  fields whose values look like an email address, a phone number, a card or
  an account number, whatever they are called. That is a pattern match: a
  company registration number reads as a phone number to it, and the
  inventory says how many of the sampled values matched
- Checkboxes and lookups are left out (they hold a flag or a pointer, not a
  value), and so are the values the org writes itself, such as a photo URL
- Only counts come back to the page: no value read leaves the extension

**Data subject request.** Type the person's email address, name, phone
number, or several, and **Search**. It looks in the objects the inventory read:

- An address is looked for in the email fields, a number in the phone fields
  (and in a text field named like one, such as a case's Web Phone), and a name
  in the record's name field. A number is compared by its **last 8 digits**,
  however it was typed: `+33 1 23 45 67 89` and `01.23.45.67.89` are the same
  number. An address and a name are compared whatever their case
- Each object is **counted first** (`SELECT COUNT()`), and only an object that
  holds something is read, **at most 200 records per object**. When more
  match, the result says so, and only the records listed can be exported or
  erased
- Records are found by what they hold, not by what points at them: a case
  whose contact is the person is found by its own email and phone fields, not
  through the contact
- **Export** writes every field of every record found to a JSON file you pick.
  The records go straight from the org to the file: they never reach the page
- **Erase** acts on the records you leave ticked, one of two ways:
  - **Anonymize in place**: the DataOps anonymizer overwrites the fields that
    hold personal data — those the detector names on these very records, by
    name, by type, or by an email address or social security number in their
    values — and the person's name (the name field where it can be written, an
    account's; else first, middle and last name). A made-up value where the
    anonymizer knows one (a name, an email, a phone, an address), nothing where
    the field may be empty. A field that held nothing is left empty, and a
    field you may not edit is left as it is and named. Made-up names and
    addresses can look like another record's: the result says what the
    org's active duplicate rules wrote during it for the records it
    overwrote, kept, as a masking says it (see [Anonymize](#anonymize))
  - **Delete**: the records go to the org's recycle bin, with what the org
    deletes along with them (a contact's tasks, an account's contacts and
    opportunities). Records stay in the recycle bin until it is emptied
- Both start with a review that writes nothing: the fields each object would
  have overwritten and how, or how many related records the org would delete
  along with them, counted over the first 30 relationships that cascade to an
  object people work with; past them, or where the org would not count, the
  objects are named as not counted, and they go all the same. What goes along
  runs none of its delete automation, and the review says so: Salesforce runs
  no flow or trigger on a record deleted with its parent (on a scratch org, a
  task deleted with its contact and contacts deleted with their account ran
  neither the before delete flow nor the delete trigger of their object, each
  of which ran on their own delete), so none of it is read or asked about,
  counted or not. Then a confirmation armed by typing the org's name, which
  lists what the org runs as the records themselves are written over or
  deleted, as a masking's or a cleanup's does (see
  [What the org runs as DataOps writes](#what-the-org-runs-as-dataops-writes)),
  then **Production Guard**:
  refused on production for a delete, a confirmation where the org's tier
  asks for one. An erasure is listed in Live Operations while it writes,
  where Cancel stops it before its next call to the org: what it did by then
  is logged with the request, and the rest is left as it is. Every erasure is
  recorded in the audit trail (Reports), one you cancelled as cancelled
- A backup taken before the erasure still holds the person's records;
  restoring it brings them back. Once anything was erased, the section says
  how many backups of the org this machine keeps and offers to delete them

**Request log.** Each request is logged on this machine: when it was opened,
what its searches found, when it was exported and how it was erased. Counts
and object names only — never an identifier, a record Id or a value — so the
log can be saved as a file and handed on. It keeps the last 500 requests.

What is typed in the search stays on the page: the extension searches with it
and keeps none of it, in the log or in its output channel. The records a
search found are held by Id, in memory, for the last 20 requests of the
window, so an export or an erasure only ever acts on what a search found;
after a restart, search again.

### Cleanup

Find the records nobody needs, and export or delete them. Pick up to 10
objects and a number of days, and **Scan**:

- **Not modified for a while**: records whose `LastModifiedDate` is older than
  `LAST_N_DAYS:n` (365 days by default)
- **Records without their parent**: a lookup counts as one the business relies
  on when **at least 90% of the object's records fill it**; the records that
  leave it empty are listed. Only a lookup a person fills, that points at one
  object, and that the org lets be empty, is looked at: a required lookup is
  never empty, and one to a user, a queue or a record type names no parent
- **Extra copies of a repeated value**: the duplicate search of the Quality
  tab, by `Email`, else the record's name, or any field picked. A delete keeps,
  for each value, the record modified last, and deletes the other copies. It
  does not merge them: what points at a copy is deleted with it or left
  without it

The scan counts with the Quality tab's own queries and reads no record.
Each recommendation can be:

- **Exported**: every field of the records it names, to a JSON file you pick
- **Deleted**: a review first says how many records go and how many records of
  other objects the org deletes along with them (counted per object people
  work with, as an erasure counts them; the org's own history, sharing and
  feed rows are not), and that what goes along runs none of its delete
  automation, then a confirmation armed by typing the org's name, which lists
  what the org runs as the records themselves go, then **Production Guard**.
  Deleted records go to the
  recycle bin. A delete is listed in Live Operations while it runs, where
  Cancel stops it before its next call of 200 records, the records deleted by
  then said. Every delete is recorded in the audit trail, one you cancelled as
  cancelled

A delete takes **at most 1,000 records at a time** (stale records the oldest
first); run it again for the rest. An export takes 1,000 at a time too, and
**Export the next 1,000** carries on past the records the last one took, in the
same order: run again, it exported the same first ones. The records are read again when
the delete runs, so a record modified since the scan is no longer stale and is
left alone. There is no scheduled cleanup, no archive, and no delete by a query
of your own.

### Empty objects and Empty the org

Two sections of **Cleanup** delete every record of whole objects, where the
recommendations above delete the records a scan found. Both read the org
first and say everything before a button to delete exists; both send the
records to the recycle bin unless asked to delete them for good, keep a
journal on this machine, and offer **Undo**.

#### Empty objects

Pick objects among the org's: every record of each goes, with what the org
deletes along with them (an account's contacts and opportunities, a contact's
tasks), counted per object. A record of an object you did not pick whose
lookup refuses the delete of its parent is named as blocking, with its object,
field and count: an account's entitlements among them, which the org refuses
the account's delete for though its describe says they go along, and its
opportunities closed won, which keep it as long as they live. What blocks
stays, and so do the records it names: neither is counted among what goes,
and the records of an object you picked that it keeps are said apart.

#### Empty the org

Every object people work in, read by the rule a checkpoint and a clone of the
whole org read it by, less what is never touched: users, profiles, permissions
and the rest of setup, Chatter, field history, sharing, change events, big,
external and Data Cloud objects, Knowledge versions, platform events, the
records only Salesforce creates, the org's configuration kept as records — its
flows and their versions, orchestrations, settings, definitions and libraries
of files, read from the describe (no record the data API creates) and from
the name — and the standard price book, kept whatever is asked. Custom settings, files and
attachments, the objects of managed packages, and the objects whose records
Salesforce does not bring back from the recycle bin on their own (a price, an
opportunity's product, a contact's role) are emptied only when asked; what
those last hold under a record emptied goes along with it all the same, and
comes back with it. Objects can be left out by name. Every object left out is
listed with why. A sandbox marked **Staging** is refused the whole org: pick
its objects instead, which Production Guard asks about. The command line,
which cannot see the mark, refuses the whole of any Partial Copy or Full
sandbox instead ([below](#from-the-command-line)).

#### Before anything is deleted

The dry run comes first, and says:

- per object, in the order the run takes them, the records it deletes, and
  per object the records the org deletes along with them — read first by
  each lookup to an object emptied, then by longer paths, a few per object:
  a count whose paths were not all read says at least, and through which
  objects they went;
- what blocks a delete — a case under an account, an entitlement, an
  opportunity closed won —: it stays, and so do the records it keeps and
  everything that hangs from those, which is neither counted among what goes
  nor said beyond Undo;
- what will likely be refused, or what the run does first so that it is not:
  an activated order is set back to Draft before any delete — never one under
  a record what blocks keeps, which stays as it is —, the standard
  price book is kept, a direct relation of a contact to its account goes with
  its contact, and a person account's contact with its account, never sent
  on its own;
- what no undo would bring back: records Salesforce requires to go before a
  record they name, such as an opportunity before the price book its lookup
  restricts, an entitlement before its account, or a custom price, which
  goes with its book before its product when both are emptied; and what an
  object whose records Salesforce does not bring back sends by its own pass.
  A record lost under two lookups is counted once. The run is refused until
  that is accepted;
- the API requests and Bulk API batches it takes against what the org has
  left today — the dry run's reads of the org, the run's own read again
  before its first delete, and its deletes — about how long it runs, and how
  many records it sends to the recycle bin, against what the bin is
  documented to hold;
- for a user without View All Data and Modify All Data, each object they are
  not proven to see whole: its records they cannot see are neither counted
  nor deleted, though those a deleted parent takes along go too;
- what the org runs as the records go, its emails, and what a mute would keep
  quiet, as every DataOps act reads them.

A run is refused before its first delete, every refusal said at once:

- a production org, by its registration or by what the org says it is, with
  no setting, override or flag that lifts it;
- another act of this machine writing to the org or holding its lock — a
  checkpoint's take, a rewind, an undo, another emptying;
- the org's last emptying stopped part way: resume it or undo it first;
- someone other than you changed records of these objects in the last hour,
  unless their work is accepted to go: the preview names each of them and
  when they last changed a record, beside the box that accepts it, and the run
  takes the work of those it named alone — anyone else at work by then
  refuses it;
- more API requests or Bulk API batches than the org has left today;
- what fires, or its emails, not accepted, or the mute refused;
- a checkpoint asked first that cannot be taken, past 500,000 records or the
  disk's room among them;
- the org changed since the preview beyond what it showed: an object it did
  not show, more records going along, more that no undo would bring back, or
  a user who now sees less. Records of the objects emptied made since the
  preview are left, and counted.

Then Production Guard is asked, a delete or a delete for good, and the run
holds the org's lock to its end. Each object goes by REST calls of 200 under
10,000 records, by Bulk API 2.0 jobs of at most 50,000 from there. A parent
goes before its children wherever they go along with it, so that **Undo**
brings the whole tree back; children go first only where Salesforce requires
it, and each such pair is kept in the journal. A delete Salesforce refuses for
a record still hanging from it is sent again in later rounds. The run is
listed in Live Operations, whose **Cancel** stops it before its next call or
job, and recorded in the audit trail as a cleanup delete, its details saying
an emptying; its undo is recorded as an emptying undo. The preview the run
acts on is kept a day on this machine, as a rewind's is: a window reloaded
meanwhile still empties as it showed.

#### Delete for good

Asked to delete for good, nothing goes to the recycle bin and no undo brings
anything back: what goes along goes for good too. It needs the user's **Bulk
API Hard Delete** permission, off by default, for administrators too: the dry run reads it, and without it the run is refused before
anything is deleted. A delete for good always goes by Bulk API job, which the
org refuses as it is opened without the permission.

#### Undo, and a run stopped part way

**Undo** brings back from the recycle bin what the org's last emptying
deleted, parents first, while the bin holds them, and names what could not
come back: records emptied from the bin since, records only Modify All Data
brings back, and, once the run went through, what its preview said no undo
would bring back. It reaches the org's last emptying alone: once a run ends,
the journals of the org's earlier ones go. It is refused for a run that
deleted for good.

A run stopped part way — cancelled, failed, its process gone — is open: the
org's next emptying is refused until it is taken up, which deletes what is
left of what its preview confirmed, or undone. Taken up, a run whose every
record left the org refuses again ends **partial**, each refusal named in the
org's words, and is closed: what stays stays, and Undo still brings back what
it deleted. The journals are kept in
`empty/` under the folder `SANDFORGE_JOURNAL_DIR` names (`~/.sandforge` by
default), where the panel and the command line both read them.

#### From the command line

`sandforge empty` runs the same handler, with the same guards, journals and
lock ([every flag](../../ci-examples/README.md)):

```sh
pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --objects Case,Contact --dry-run
pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --org --exclude-object Lead --yes
pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --undo <run> --yes
```

It asks no question: without `--dry-run` or `--yes` it is refused, exit `1`,
before any org is reached. With `--yes` it reads the org as its dry run does,
says it all, and empties only when nothing refuses it. `--hard-delete` deletes
for good, `--accept-no-undo` accepts what no undo would bring back,
`--accept-people-active` lets go the work of the people the dry run counts
at work in the last hour, each by user Id with their last change,
`--unrestorable` empties with the org the objects Salesforce does not bring
back from the recycle bin, and `--checkpoint-first` takes a checkpoint first.
With `--json`, `apiRequests` gives `estimate`, what the dry run priced — for
`--undo` and `--resume`, what they were priced at before their first write —,
and `sent`, every request the command sent the org — connecting it, its dry
run and its run, a mute's permission sets among them — counted as sent;
`--accept-automation`,
`--accept-emails` and `--mute-automation` are every DataOps script's. Exit
`0` done, `1` refused before anything was deleted, `2` a bad command line, `3`
records the org refused, `130`, `143` or `129` stopped by a signal, the journal
kept: `--resume <run> --yes` takes the run up. The command line never sees a
sandbox marked Staging in the extension: its registration of an org is the
org's own, made afresh at each run. So it refuses the whole of a Partial Copy
or Full sandbox, read from its data storage — past the 1 GB of a Developer
Pro sandbox — `--org` and a `--resume` of such a run alike (`COPY_SANDBOX`,
exit `1`, nothing read): empty it whole from DataOps Cleanup, which knows the
mark, or pick its objects with `--objects`, which Production Guard asks
about. A Developer or Developer Pro sandbox and a scratch org are emptied
whole as before, and `--undo` is never refused for it. The MCP server's `empty_preview`,
`empty_run` and `empty_undo` run it ([MCP](../mcp.md)).

### Data Quality

Measure how the records of a few objects are kept, read-only:

- Pick up to 10 objects of the selected org -- the list is the org's objects a
  record can be created in, the same one Seed offers -- and a number of days
- **Fill counts.** For every field a person or an integration fills in, how
  many records hold a value, and the share of the total. Fields filled on fewer
  than half of the records are listed as mostly empty, and a field no record
  fills is flagged. Checkboxes, formulas and the fields the org keeps itself
  (the Id, the audit stamps) are left out: a checkbox is never empty, and
  nobody types the others
- **Required fields left empty.** Fields the org requires on a new record --
  required at insert by the describe, or by the platform whatever the describe
  says -- that some existing records leave empty. Validation rules are not
  read, so a field only a validation rule requires is not flagged
- **Likely duplicates.** The values of a key that more than one record carries,
  most repeated first. The key is `Email` when the object has one, else the
  record's name; any field the org can group by can be picked instead, and
  picking one rescans that object alone. Records with no value are not
  duplicates of each other
- **Stale records.** How many records nobody has modified in the number of days
  given (`LastModifiedDate` older than `LAST_N_DAYS:n`, 365 by default)

How it counts, and where it stops:

- Every figure is a count the org makes: `SELECT COUNT()`, `COUNT(field)` and a
  `GROUP BY … HAVING COUNT(Id) > 1`. No query returns a record and nothing is
  written, so a scan needs neither a backup nor a confirmation, and the number
  of queries it sends depends on the fields, never on the number of records.
  The org still counts every record: on a very large object a count can run
  long enough for the org to stop it, and the result then says so
- Counts cover the records the connected user can see
- At most 100 fields are counted per query, the most one query may alias; an
  object with more takes several queries
- A multi-select picklist cannot be aggregated, only filtered, so it takes a
  query of its own; past 20 such fields per object the rest are listed as not
  counted rather than queried
- A field the org can neither aggregate nor filter -- a long or rich text area,
  an encrypted field -- is listed as not counted: only reading the records would
  tell, and the scan reads none
- A duplicate search reads at most 2,000 repeated values: an aggregate query
  cannot be paged, and the org refuses one past 2,000 rows. When the search
  reaches that limit the result says the counts are a floor. The 20 most
  repeated values are shown
- An object the org will not describe or count is reported as failed, and the
  others are still scanned; a check the org refuses on one object shows what
  the org said, next to the checks that ran

### What the org runs as DataOps writes

A masking updates every record of its objects, a restore brings back from the
recycle bin what was deleted since the backup and writes the backup's values
over the rest, and a cleanup deletes: each fires what the org runs on that
write, its record-triggered flows, Apex triggers, Process Builder processes and
workflow rules, emails among them. Before its first write, each reads it, as
Forge, Sync, Seed and Frozen Dataset do:

- **What fires**, object by object and write by write: on update for a masking
  and a restore, after undelete for what a restore brings back, before and
  after delete for a cleanup, and what could not be read. A Cleanup delete and
  an erasure by delete read it on the records they delete themselves, not on
  those the org deletes along with them, which their review counts: a record
  the platform deletes with its parent runs none of its delete automation. On
  a scratch org, a task that went with its contact ran neither its before
  delete trigger nor its before delete flow, though each refused the task's
  own delete; contacts that went with their account ran neither the before
  delete flow nor the after delete trigger of Contact; and Salesforce has no
  flow that starts after a delete. The same holds for what their review could
  not count. `sandforge cleanup` reads it on the objects it names, as the page
  does, and says that what the target deletes along with them goes too,
  uncounted, running none of its delete automation
- **Duplicate rules**: the active ones of what a masking, a restore or an
  erasure in place writes over, named; each then says what they wrote during
  it for the records it wrote (see [Anonymize](#anonymize))
- **The emails**, counted against what the org has left today of its single
  and workflow emails: past them, the write is refused (`EMAILS_EXCEEDED`),
  whatever is accepted
- **Whether the org delivers them**, read with one line of anonymous Apex that
  sends nothing, only when something that still runs may send one, never in a
  production org: see [Will a run make the target send emails?](../faq.md#will-a-run-make-the-target-send-emails)

In the panel, Apply's and Resume's confirmation, Restore's question, the
Cleanup delete's confirmation and a subject request's Erase confirmation list
it before the org's name is typed, and wait for it; the box **Mute the target's automation for this run** sits under it
when the org's own bypass silences something of it, on any org but a
production one, whose automation is never muted, and on an org that
delivers the emails, a box lets them go, which the confirmation itself never
stands for. On the command line, `sandforge dataops anonymize`, its
`--restore`, `sandforge backup --restore` and `sandforge cleanup` say it
before they ask or write, and write nothing without `--accept-automation` when
something fires or could not be read (`AUTOMATION_NOT_ACCEPTED`), nor without
`--accept-emails` when the org delivers what still runs sends
(`EMAILS_NOT_ACCEPTED`); an org the network did not reach as its automation
was read refuses whatever is accepted, to be tried again
(`ORG_TEMPORARILY_UNREACHABLE`); `--mute-automation` keeps quiet what the org's own
bypasses keep quiet, under a lease, as every other module's runs do (see
[Muting the target's automation for a run](../faq.md#muting-the-targets-automation-for-a-run)),
and is refused on a production org (`MUTE_PRODUCTION`), where no refusal
offers it.
A dry run says all of it, and what a real run would be refused for, exit `1`.
With `--json`, the masking's and the restore's answer carry it as
`dataops:automation:response`, the cleanup's under `automation`. A pipeline's
Anonymize step reads it before its first write too, and is refused the same
way, nothing masked, unless the step's own settings accept it:
`acceptAutomation`, `acceptEmails` and `muteAutomation`, each off by default,
as a Rewind step's; an Approval step stands for none of them (see
[Automation](automation.md)).

## Tips

- Leave **Keep the values first, so Restore can put them back** ticked in Apply's
  confirmation, or create a backup before running anonymization: the mask is
  applied in place and, without either, cannot be undone
- An object holding more records than one backup does is no reason to untick
  it: tick **Mask in slices** as well, and each slice is backed up just
  before it is masked
- A backup can only be restored into the org it was taken from, so keep one
  backup per org rather than one per project
- Check the KPI row for the backups this machine keeps of the org, and those a
  cap or a failed read left partial
- A backup reads only the objects the templates mask: before a Seed, Sync or
  Forge run, take a checkpoint instead (the Backup tab's **Take a checkpoint**
  opens Checkpoints on one), which **Rewind…** returns the org's data to
