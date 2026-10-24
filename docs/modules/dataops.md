# DataOps

Back up your org data, anonymize sensitive fields, find and erase one person's
records, and clean up the records nobody needs, from a single tabbed page.

> **Status.** Backup, Restore, Anonymize, Compliance, Cleanup and Data Quality
> are wired end to end. Each section below says what it does and where it stops.

## Quick Start

1. Navigate to **DataOps** from the sidebar
2. The KPI row shows records processed, error rate, and anonymization template count
3. Use the tab bar to switch between Backup, Restore, Anonymize, Compliance, Cleanup, and Quality
4. Start with a backup before other operations

## Features

### Backup

Take a snapshot of the objects an Anonymize writes over:

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
  incremental mode -- each backup is a new snapshot
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
  it brings back those records only
- One-click backup creation from the Backup Panel
- A backup is listed in Live Operations while it reads, and the Backup tab
  offers **Cancel run** meanwhile. It stops between two pages when either
  cancels it, the window closes or the extension deactivates, and what it
  wrote is removed, so a stopped run leaves no half-saved snapshot -- run it
  again for a complete one
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
  says until when. `sandforge-backup` and `sandforge-dataops` apply the same
  retention as they start, `--max-age-days` setting it (0 keeps them all), and
  name on stderr each snapshot they remove, a Sync run's said as the run's. A
  backup taken before
  that setting existed is kept until you delete it: the retention counts from
  the first start that had it, so an upgrade never takes a backup away. The Restore tab deletes
  one, or every backup of the org; disconnecting an org asks whether its
  backups go with it, and an erasure offers to delete those taken before it

### Restore

> **Wired since v1.18.0.** The tab sends `dataops:rollback`, the backup list it
> reads is populated, and the CRUD/FLS gate that used to refuse every restore
> now answers field by field. Before 1.18.0 the button reached the backend and
> the backend said no, on every object, every time.

Restore data from a previously saved backup:

- Browse available backups with timestamps and record counts, newest first
- Select a specific backup and restore it to the current org
- A restore puts the whole backup back: there is no choice of records, objects
  or moment in time, only of which snapshot
- The backup a Sync run kept of the records it wrote over is listed here too,
  marked as the run's and saying that removing the run in Sync puts the values
  back as well. Restored from here, a record the run's calls kept in more than
  one line is written once, each field as the run first found it; and, as the
  run's removal does, a record changed since the run — modified after its last
  write — or deleted since is left as it is, and counted per object with the
  result, unless **Also restore the records changed or deleted since the run**
  is ticked. `sandforge-backup --restore` and `sandforge-dataops anonymize
--restore` leave them as they are too, and end on exit code 3, unless
  `--include-changed` is given, as the run's own `sandforge-sync --remove
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
  `sandforge-backup --restore`, upserts every row, the unchanged ones included
- Reports progress per object, reading the backup 200 records at a time:
  backups taken before records went one to a line, and those kept in extension
  state before files, are read as they were written
- Says, with its result, when the backup held only part of an object -- the
  cap, a read that failed, a file no longer all there -- and that the rest of
  the object was left as it is
- Drops the fields _nobody_ may write — a backup is a verbatim
  `SELECT FIELDS(ALL)` snapshot, so it always carries `CreatedDate`,
  `SystemModstamp` and friends — and logs which ones it dropped
- Stops with an FLS error if a field _you_ may not write is in the payload,
  rather than restoring the record with that column silently missing

A restore is listed in Live Operations while it writes, and the Restore tab
offers **Cancel run** meanwhile. It stops between two batches when it is
cancelled — from either, by Ctrl-C at `sandforge-dataops --restore`, or as the
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
  restore of the latest backup can never bring back
- **What a run reads and writes.** It reads the `Id` and the fields the
  template names. It writes those fields where they hold a value, and nothing
  else of the record: an empty field stays empty rather than being given a
  made-up value, and a record none of whose named fields holds anything is not
  written at all
- **Keep the values first.** Apply's confirmation offers **Keep the values
  first, so Restore can put them back**, ticked unless you untick it, as the
  command line always does: before its first write, the run takes a backup of
  the fields it masks, held to the records it masks, listed with the backups.
  It writes nothing unless that backup holds every record it would mask --
  one stopped at the cap refuses the run, `SNAPSHOT_NOT_TAKEN`, and the tab
  says how to mask without one. Its result points to the backup, and **Open
  in Restore** opens the Restore tab on it. Unticked, the confirmation names
  instead the records a restore of the latest backup can never bring back. A
  resume takes no backup: the run it resumes took one
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
  refused more than 2,000 records of -- Apply masks those
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
  phone, a birthdate) are overwritten as an erasure overwrites them. Those
  rules mask person accounts only; a business account keeps its rules, a
  person account goes without a rule on `Name`, which the platform computes
  from its first and last names, and an org without person accounts is
  masked as before. A snapshot keeps each account's kind, and a restore
  writes each back with the fields its kind holds. A run that names no
  object -- Apply, or the command line without `--object` -- masks Account's
  person accounts too, in an org that has them, when the template masks
  contacts: planned from its rules alone, the CCPA template, whose rules name
  Contact and Lead, masked every contact and left every person account in
  clear. Its business accounts, which hold none of it, are neither counted,
  read nor kept in the snapshot
- **Preview before Apply.** **Preview** reads the first five records of each
  object the template masks, in `Id` order -- the ones a run masks first --
  and shows each masked field as the org holds it beside the value Apply
  would write, masked in this window as Apply masks it. It writes nothing,
  so it asks no confirmation. An empty field stays empty, as Apply leaves it;
  an object the org will not read is listed with what the org said, and a
  field the org does not have is named. A made-up name is the one Apply
  writes on the first object; on the next ones Apply may draw another for a
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
  key, and still gives none of the names the first run made up.

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
    field you may not edit is left as it is and named
  - **Delete**: the records go to the org's recycle bin, with what the org
    deletes along with them (a contact's tasks, an account's contacts and
    opportunities). Records stay in the recycle bin until it is emptied
- Both start with a review that writes nothing: the fields each object would
  have overwritten and how, or how many related records the org would delete
  along with them. Then a typed confirmation, then **Production Guard**:
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
  work with; the org's own history, sharing and feed rows are not), then a
  typed confirmation, then **Production Guard**. Deleted records go to the
  recycle bin. A delete is listed in Live Operations while it runs, where
  Cancel stops it before its next call of 200 records, the records deleted by
  then said. Every delete is recorded in the audit trail, one you cancelled as
  cancelled

An export or a delete takes **at most 1,000 records at a time** (stale records
the oldest first); run it again for the rest. The records are read again when
the delete runs, so a record modified since the scan is no longer stale and is
left alone. There is no scheduled cleanup, no archive, and no delete by a query
of your own.

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

## Tips

- Always create a backup before running anonymization: the mask is applied in
  place and cannot be undone
- A backup can only be restored into the org it was taken from, so keep one
  backup per org rather than one per project
- Check the KPI row for a quick overview of your DataOps activity and error rates
