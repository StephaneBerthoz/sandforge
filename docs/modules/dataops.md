# DataOps

Back up your org data and anonymize sensitive fields from a single tabbed page.

> **Status.** Backup, Restore, Anonymize and Data Quality are wired end to end.
> Compliance and Cleanup ship as previews: the tabs render, but are not yet
> connected to a backend. Each section below says which it is.

## Quick Start

1. Navigate to **DataOps** from the sidebar
2. The KPI row shows records processed, error rate, and anonymization template count
3. Use the tab bar to switch between Backup, Restore, Anonymize, Compliance, Cleanup, and Quality (Backup, Restore, Anonymize and Quality are wired today)
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

> **Coming soon.** The tab shows a coming-soon notice and nothing else: there is no request form, no PII list and no backend behind it. PII _detection_ is live and already runs in the Seed and Sync pre-flight checks.

### Cleanup

> **Coming soon.** The tab shows a coming-soon notice: no scan finds stale, orphaned or duplicate records yet, and nothing deletes them from here.

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
