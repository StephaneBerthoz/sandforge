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

Take a full snapshot of Account and Contact:

- The objects are fixed: every backup reads Account and Contact, every field
  of each, up to the org's query limit (2,000 rows on a sandbox). There is no
  object picker and no incremental mode -- each backup is a new full snapshot
- Every backup is written to extension storage with per-object record counts
  and the org id the org answered with, and listed newest-first in the Backup
  tab
- One-click backup creation from the Backup Panel
- A backup stops between two objects when the window closes or the extension
  deactivates. Nothing is written until every object has been read, so a
  stopped run leaves no half-saved snapshot -- run it again for a complete one

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

What a restore does, in order:

- Refuses a backup taken from a different org than the one selected
- Passes through Production Guard like every other write path: a blocked
  operation stops, and `safety.requireProdConfirmation` asks first
- Asks before writing when the org now answers with another org id than the
  one the backup recorded, as a sandbox does once refreshed: the records the
  backup saved belonged to the org it was, and the restore cannot put them
  back. Declined, nothing is written. A backup that recorded no org id is
  restored without the question
- Brings back from the recycle bin the records of the backup deleted since it
  was taken, so they return with their `Id` and what pointed at them; a record
  no longer in the recycle bin cannot, and is reported as refused
- Upserts on `Id` in batches of 200, per object, reporting progress per object
- Drops the fields _nobody_ may write — a backup is a verbatim
  `SELECT FIELDS(ALL)` snapshot, so it always carries `CreatedDate`,
  `SystemModstamp` and friends — and logs which ones it dropped
- Stops with an FLS error if a field _you_ may not write is in the payload,
  rather than restoring the record with that column silently missing

A restore is **not** stopped when the window closes: it runs to the end. A
restore cut in the middle leaves the org with some records put back and some
not, and nothing records where it stopped, so finishing is the safer outcome.

### Anonymize

Mask sensitive data using the built-in anonymization templates, or templates of
your own:

- Browse anonymization templates from the template library; each rule is
  listed by the `Object.Field` it masks and its method
- Apply a template to replace PII with realistic but fake data
- **No preview.** The Preview button is disabled: the preview it used to run
  applied the mask to the org for real, so it was inerted rather than left in
  place. Apply is the only path, and it is irreversible -- back up first.
- **Your own templates.** **Create Template** opens an editor on the rules of
  the template on screen, or on none: change a rule's field or method, add or
  remove rules, name the set and save it. A rule names its field as
  `Object.Field`, one rule per field, and uses a method that needs no setting
  of its own -- Fake, Mask, Nullify, Shuffle or Preserve Format. Hash needs a
  salt, Constant a value and Truncate a length, and the editor sets none of
  them: a rule it starts from that uses one is shown with the reason, and the
  template cannot be saved until that rule is changed or removed. A name
  another template already goes by is refused.
- A saved template is kept in extension storage on this machine, listed after
  the ones that ship, marked as saved, and applied like them. It can be deleted;
  a template that ships cannot. There is no import or export.
- **Reproducibility.** A rule that carries a hash salt gives the same
  replacement for the same input on every run and on every machine: the salt
  is the whole key. A rule without one -- which is every rule in the templates
  that ship and in those you save -- draws from a key the window generates when
  it starts, so two runs in one window mask a record identically and the next
  window masks it differently.

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
  asks for one. Every erasure is recorded in the audit trail (Reports)
- A backup taken before the erasure still holds the person's records;
  restoring it brings them back

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
  recycle bin. Every delete is recorded in the audit trail

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
