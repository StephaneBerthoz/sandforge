# Forge: Record-Scoped Clone

> Clone a coherent graph of records from a source sandbox (partial-copy or
> full-copy) into a dev sandbox, without copying every row of every table.

## Why

Before: `Forge` with `inputMode: 'record'` _discovered_ the graph from a root
record, then ran `SELECT * FROM Object` — no `WHERE` — for every node. Starting
from a single Case on a mid-sized org, that copied hundreds of thousands of
records. Not a dev dataset.

After: execution is _scope-aware_. From the root record the engine follows the
transitive closure (parents through foreign keys, children through
reverse-lookup) and issues only SOQL carrying `WHERE Id = …` or
`WHERE FK IN (cachedParentIds)`. In a dry run on an internal test dataset
built around one Case, the scoped plan read under 1 000 records where the
unscoped one read about 262 000. That is one measurement on one dataset, not
a guaranteed ratio: the reduction depends on how wide the root's graph is.

The catalog is the exception to "children through reverse-lookup". A price
book, a product, a selling model, a price, or a category products are
assigned to and the catalog that holds it, that the clone only reaches
through a lookup (an opportunity's price book, a line item's price, the
category a product's assignment names) is cloned for what points at it and
brings none of the rows under it: it is read once
those records have been read, and the clone takes the prices its line items
use, the standard price of each of their products under the same selling
model, those products and their selling model options, the selling models
and the books the prices belong to. It writes them in the order the platform
takes them: products and selling models, their options, standard prices,
custom prices, then the lines. A clone rooted at a price book or a product
still reads the prices under it, and a product's assignments to categories,
with the category and catalog each names, written before them — not the
other assignments of those categories, nor the other categories of the
catalog. The catalog comes whatever discovery
reached: when it stops at its cap before the catalog, the run adds the
objects its records cannot be written without — a line's price, and that
price's product, book and selling model; an assignment's category, and that
category's catalog — and reads them the same way. One the graph holds and
leaves out stays out. The items of an activated order come the same way: the
order is written as a draft and activated once the rest is written, and the
platform activates no order without a product, so when discovery stopped before
the items the run adds them — those of the orders past Draft, and their prices.
The records read after the catalog, under what its rows
name (the classification a product is based on), can name rows of it in turn:
the catalog is then read a second time, by id, for those rows only, and they
bring nothing under them. That read also follows a row of the catalog to the
rows of its own object it names — a category's parent, then that parent's
parent — up the tree as far as the rows name, ten reads at most. A clone that
leaves price books out takes the standard book alone, and reads no price in
another book under a product.

An object excluded by name (`ExecuteOptions.excludedObjects`, the clone
command's `--exclude-object`) stays out whether discovery reached it or the
run would add it: its node is left out, and none of it is added past the cap.
What that costs is said, not written: a record that cannot be written without
one of its records — a line whose price is excluded, a price whose product is —
is held back, named per object in the run's errors and counted as failed, in a
dry run too; a row of the catalog that only such records name — a product only
lines held back sell — is held back with them, not read when they were held
back before the catalog's read, not written when after; and an order past
Draft left with no item the run writes stays a draft, said so instead of
refused its status. An object unchecked on the Forge
page is excluded the same way (the node carries `leftOutByUser`), and Review
says before the run what it costs, as far as the graph can tell before a row is
read; the objects discovery left out itself — its empty tables, and those it
could not describe or count — are only skipped.

## Pipeline

```
ForgeOrchestrator.discover()  →  ForgeGraph (BFS schema)
ForgePlanGenerator.generate() →  ForgePlan  (waves by level, each cycle one node)
ForgeOrchestrator.execute(graph, config)
  └ ForgeExecutor.execute(graph, source, target, onProgress, options)
       │
       ├─ if rootRecordId provided → scope-aware mode
       │    RecordScopeCache + ScopedSoqlBuilder
       │
       ├─ before the node loop: isObjectCreatable for every included object
       │    but reference data (target), on a dry run too, six describes in
       │    flight at a time. An object the target refuses is skipped: at most
       │    one row of it is read, into no scope, and it is an error only when
       │    the clone holds records of it — an object skipped whole, which the
       │    audit entry names, its count unknown. An object the target does
       │    not have (its describe answers `NOT_FOUND`, as it does for one the
       │    user the run writes as cannot see) is not read at all: skipped
       │    whole, said once as not in the target org, its count unknown. A
       │    check that failed otherwise is reported for that object, which is
       │    still attempted. Reference data is matched by name, never
       │    inserted, so it is not asked about.
       │
       ├─ for each node (root-first, then topo; a node whose rows cannot be
       │  written without a parent whose turn is still to come waits for it,
       │  as the members of a cycle come in no order of their own, and a node
       │  read under such a waiting parent is read again under its rows once
       │  they are read — as is every node read before a parent put off
       │  because nothing had named it at its turn, or, when that parent is
       │  read after the catalog, every such node that cannot be written
       │  without it; what that adds is followed down the nodes read under
       │  it, three levels at most; neither the root's object nor the
       │  catalog is read again so):
       │    1. describeFields (source + target → intersect createable)
       │    2. ScopedSoqlBuilder.build → SOQL with WHERE (split into several
       │       statements when the ID lists outgrow one query URI)
       │    3. queryRecords(source) per statement, rows merged by Id
       │    4. (if reference-data object) ReferenceDataMapper.resolve(target by Name)
       │    5. seed cache (own IDs + FK values from results; an ID a lookup
       │       that can name several objects holds goes to the object its key
       │       prefix names); a record the rows cannot be written without, of
       │       an object whose read is over and did not take it, is read by
       │       its id, before anything is written (see "A record whose
       │       required parent was not read")
       │    6. clean records:
       │         - strip non-createable
       │         - strip Person Account __pc on Business Accounts
       │         - strip Name on Person Accounts (auto-computed); one the
       │           target takes as a business account keeps it, and goes
       │           without its person fields (see "Person accounts")
       │         - replace or leave out the picklist values the target
       │           would refuse, for the record type the row goes in with
       │           when the mapping knows it (see below)
       │         - omit nullified orphan FKs (don't send `null`); a lookup no
       │           write can set is owed nothing by the second pass, one
       │           only an insert sets is said to be left empty, never sent,
       │           and so is one at a record outside the clone
       │         - neutralize the email addresses and phone numbers, unless
       │           `keepContactPoints` (see "Emails and phone numbers")
       │         - apply RecordType mapping (DeveloperName)
       │         - anonymize the fields selected, with `anonymization`
       │    7. batch insert into target (never a person account's contact
       │       the target writes with its account: see "Person accounts");
       │       a row a validation rule, a restricted picklist or the lookup
       │       filter of a lookup the target lets be empty refuses on fields
       │       it names is sent again without them, three rounds at most —
       │       and a required parent copied from outside the graph once, its
       │       picklist values checked first; a call that never reached the
       │       target, and a row it could not lock a record for, go again
       │       after a wait; a call whose answer was lost is never sent again
       │
       ├─ once every node is read, before anything is written: a record the
       │    rows cannot be written without, of an object no node holds, is
       │    read by id with nothing under it, and so is what it cannot be
       │    written without in turn, five levels up at most; its object is
       │    written in a turn of its own, ahead of the rows that need it, and
       │    one the target refuses or lacks holds those rows back (see "A
       │    record whose required parent is outside the graph")
       │
       ├─ with `files`: before the first write, the files of the records read
       │    (the latest version of each document linked to one, and the
       │    attachments under them) are chosen, and their total checked
       │    against the target's FileStorageMB; after the records, each file
       │    is read and written in one request of its own (FileCopier)
       │
       └─ summary { successCount, failedCount, skippedCount, errors[],
                    readByObject[], failedReads[], files?,
                    fileContentFieldsLeftOut?, picklistValuesChanged?,
                    writtenWithoutFields?, contactPoints,
                    writtenBetween? }
```

### Emails and phone numbers

Every row the run writes — a node's, and a parent copied from outside the
graph, by the orphan expansion or by its id — has its contact points
neutralized as it is cleaned, whether the run anonymizes or not
(`stages/ContactPointNeutralizer.ts`). Run into a client's sandbox, a clone
met record-triggered flows that email and text the contacts they are created
for.

- An email field's address goes in under `.invalid`, the domain kept from ever
  resolving: `jane@acme.com` becomes `jane@acme.com.invalid`, as Salesforce
  leaves the users' addresses of a refreshed sandbox. One already under
  `.invalid` is left; one the field's length cannot hold with the suffix
  becomes a short address of its own under `example.invalid`.
- A phone field's number becomes a fictional one of the mobile range kept for
  fiction, `+3363998XXXX`, drawn as the Frozen dataset draws its numbers: the
  same number gives the same one throughout the run, another in the next, and
  two numbers never the same one. A field too short for the country code takes
  the national form, `063998XXXX`. Past the 10 000 numbers of the range, a
  number is left out, its field empty, and counted (`numbersExhausted`).
- A text field whose API name gives it to either — `Notification_Email__c`,
  `SMS_Number__c` — has each address, or each run of seven digits or more, in
  its value treated so; a checkbox or a picklist named like one is left alone.

`keepContactPoints` writes them as read. Anonymization runs on the values
already neutralized, and writes an email field's address under
`example.invalid` or `.invalid`, never `example.com`, and a fictional number in
a phone field whose method leaves one — the default mask, a fake, a shuffle,
the format redrawn — never the last digits of the real one. The summary's
`contactPoints` says whether the run neutralized them, and per object and
field how many values; a dry run counts what it would.

`readByObject` is, per object, the rows the run read to clone — on a dry run,
the rows it would insert — the standard price book left out and the standard
prices it adds counted in. The results measure what the run wrote against
these, not against the graph's counts: discovery counts each whole table, of
which a record-scoped clone reads a few rows. An object the run did not read —
left out, skipped before its read, or whose read failed — is not listed.

A dry run goes through the write stage as a real run does, with a writer that
writes nothing: each object ends on `Simulated Account: 3 would be inserted, 0
failed`, its counts what a real run would insert, link, hold back and fail, and
the summary's `gaps` says what the target would refuse or change, row by row
(see the quickstart's "Simulate a run"). The ids it gives the rows it would
have written stand in for the target's while their children are cleaned, and
never leave it: its `remapTable` keeps only what it found in the target.

`failedReads` names the objects whose read failed. A record-scoped run never
learned how many rows its scope held of them, so their `query` error counts
none and `failedCount` leaves them out; a run of whole tables counts the table
it meant to read, no more than `maxRecordsPerObject`. Either way a failed read
is a failure of the run: it ends partial when it settled other records, and
failed when it settled none. The run's history entry keeps them under the same
name, and its results name them next to the success rate, which counts the
records read and so leaves them out. So is an object skipped whole — for a
failed parent, or because the target takes no insert of it while the clone
holds records of it — though its report may count none: the run ends partial
or failed the same way, where it ended a success beside an audit entry naming
the object skipped.

A run asked to copy files reads every object before it writes one, whatever
its input mode: the files are measured against the target before anything is
written, which needs every record read. A file is published on the first
cloned record it hangs on and linked to the others; a file over the cap, one
kept outside Salesforce, or one hanging only on records the run did not create
is left out and listed. Each copied file is recorded under its document
(`ContentDocument`) or as an `Attachment`, so removing the run's records
removes it. While the run anonymizes, `files.acceptedAsIs` must say the files
are copied as they are, or the run is refused before it reads anything.

A field whose describe type is `base64` holds a file's content, and a read gives
the address of that content instead. No such field is read or written, on any
object, including an optional parent fetched from outside the graph; the ones
createable on an object with records to write are listed per object in
`fileContentFieldsLeftOut`. Files and attachments never reach the graph: their
content is the files stage's.

A picklist value is checked against what the target allows before its row is
written. The describe lists a field's active values for every record type at
once; a restricted picklist refuses at insert a value the record's type does not
keep, and a dependent one a value its controlling value does not allow
(`INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`). For a row whose record type the run's
record type mapping translates — known, then, in the target — each restricted
picklist value is checked against the values that record type keeps, and a
dependent one against those its controlling value allows, as that value is
written. The target's UI API answers both for every picklist field of a record
type in one request (`ui-api/object-info/{object}/picklist-values/{recordTypeId}`),
made once a run per object and record type, and only when a row of it holds a
value in a restricted picklist it is written with. A value the target would
refuse is replaced by the record type's default for the field; in a field the
target requires and the record type sets no default for, by the first value the
record type allows, since the row cannot go in without one; and otherwise it is
left out. A multi-select value keeps the values of its selection the record type
allows, and is replaced or left out only when none is left. Any other value of a
restricted picklist — the row's record type not mapped, or the field left out of
the record type's answer — is checked against the field's active values, one
value of a selection at a time, and left out when it is not one of them; so is a
value of a field whose describe does not say whether it is restricted. An
unrestricted picklist, single or multi-select, and a combobox keep the value
read: "The API doesn't enforce the list of values for advisory (unrestricted)
picklist fields on create() or update()", and the target adds a value it does
not hold to the field as an inactive one (Object Reference for the Salesforce
Platform, Picklist Field Type). The standard picklists whose values are records
of an object of their own — a case's, a lead's, a contract's or a solution's
status, an opportunity's stage, a task's status and priority, a partner's role —
the statuses whose values carry a category the platform acts on — an order's,
a work order's, a work order line item's, a service appointment's — and a
campaign member's, one of its campaign's statuses, are checked as a
restricted picklist is all the same: the describe calls them
unrestricted, and whether the API takes a value they do not hold is documented
nowhere, where left out the value takes the target's default. A record type
whose values could not be read is said once, in a `scope` report of the object
that counts no row, and its rows are checked against the fields' values; so is a
field its answer leaves out that its rows hold a value in. What a write did not
send as read is said on the object's line — `Completed Quote: 2 succeeded, 0
failed, picklist values not written as read: Status__c on 1 row: "Old" not
allowed for record type Retail, replaced by "New", the default of record type
Retail` — and listed per object, field and reason in `picklistValuesChanged`.
The rows are counted written or failed as the target answered them. A required
parent copied from outside the graph (`expandOrphanParents`) is checked the
same way, against the record type the mapping gives it, read once a run with
the run's own; what it changes is listed under its object in
`picklistValuesChanged`.

The check can let through a value the target then refuses. A record type that
was never given values of a field takes none of them, while the UI API answers
the field's every value for it; the record type's metadata (Tooling API
`RecordType.Metadata.picklistValues`) is no surer, holding no entry at all for a
field whose values a record type takes as well as for one it takes none of. No
read before the write tells the two apart: the answer to the write does, and
the row is written again without the field (below).

Once the run has written, it reads back from the target the `CreatedDate` and
`LastModifiedDate` of every record it created — the `SystemModstamp` of an
object whose audit dates both orgs let the run's user set, as the clone then
copies the source's — and keeps the earliest creation and the latest stamp as
`writtenBetween`, a stopped run included. A run whose dates could not all be
read back is left without it. Removing the run's records compares the org's
dates with those, and with the org's time as the removal starts, never with
this machine's clock; a run without `writtenBetween` is dated by when it was
recorded, read on the org's clock.

The removal deletes children before their parents, and the org refuses some
records while one the removal reaches later stands. Run for real on a sandbox,
a catalog clone's selling model options were refused (`UNKNOWN_EXCEPTION`,
"associated with an active price book entry") while the active prices they
are sold under stood; the prices went next, and the options, the products and
the products' classification stayed until a second removal took them. Once the
rest of its plan has gone, a removal sends every record the org refused once
more, whatever it refused it with, with the records held back for one of them,
and what the org still refuses for records hanging from it again while a round
of tries takes something more. The second answer counts: deleted, already gone
(`ENTITY_IS_DELETED`), or refused again, in the org's words of that answer.
The object's reasons say what the second try changed — `Refused at first, sent
again once the rest had gone: 35 deleted.` — and the run's line, its audit
entry, what is left of it and the clone command's `--remove` count the records
as that try left them. What is still refused is then read back: a record the
removal read before its first delete and no longer finds went with a parent,
and is already gone; when the read fails, it stays refused, said not checked.
A record of an object the removal could not read is counted refused, with
why, and never sent nor taken for gone: one out of the session's sight comes
back from a query no more than a deleted one. A record the first read of its
object does not find is looked for in the org's recycle bin: there, it is
already gone; nowhere, it is not visible to the user the removal runs as.

## ExecuteOptions

| Option                 | Default                                  | Effect                                                                         |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `rootRecordId`         | —                                        | enables scope-aware mode                                                       |
| `rootObjectApiName`    | —                                        | resolved from `recordId` keyPrefix; required with `rootRecordId`               |
| `dryRun`               | `false`                                  | runs every step except `insertRecords`, used by the recipe                     |
| `referenceFallback`    | `'nullify'` (scoped) / `'keep'` (legacy) | what to do with FK fields whose value isn't in the IdRemapper (see below)      |
| `recordTypeMappings`   | built by the extension before each run   | array of `{ sourceId, targetId, developerName }`; built via `RecordTypeMapper` |
| `maxRecordsPerObject`  | — (no cap)                               | append `LIMIT N` to every scoped query                                         |
| `referenceDataObjects` | `['BusinessHours', 'OperatingHours']`    | objects to map by Name instead of cloning                                      |
| `files`                | — (no file read)                         | `{ maxFileBytes, acceptedAsIs }`: copy the files of the cloned records         |
| `keepContactPoints`    | `false`                                  | write email addresses and phone numbers as read; off, each is neutralized      |

`'keep'` holds for the records the run does not write, whose ids a sandbox
refreshed from the same production can share with the source. A lookup at the
one object it can name, which the run writes, is emptied at insert and filled
in by the second pass whichever fallback is set: kept, a cycle's lookup at a
record written after it named the target's own record rather than the copy,
or nothing, and the platform refused the whole row. The plan's cycles say so
for either kind of run.

A lookup no write can set — neither createable nor updateable, as a person
account's `PersonContactId`, a quote's `AccountId` read from its opportunity,
or a converted lead's account — orders nothing: the platform fills it.
Discovery keeps its edge, which a scoped read follows to the rows under a
parent in scope, and marks it `settable: false`; the write order and the
plan's cycles leave it out, a parent that fails takes nothing down through it,
and the second pass owes it nothing. Where discovery did not walk the child's
lookups, the fields the run describes say it.

The second pass fills a lookup in by an update, as the user the run writes as:
what it is owed is read from the target's describe of each object written —
the one the run reads for its field sets, so no request more. A lookup the
user the run reads as may not set and the target's may is owed to it, even at
a record already written, which the insert could not carry; one the target's
user may not update is not, where its update was refused with the row's other
lookups in it. A lookup only an insert sets — createable, not updateable, as an
email's case or a master-detail whose parent cannot change — is written with
its row or never. Discovery marks its edge `insertOnly`, and the write order
puts its record first wherever the required lookups leave the order free,
breaking ties before the optional lookups do; it is no required edge, and a
row still goes in without it. In a cycle of such lookups, or against a required
one, one is written before its record whatever the order: the second pass
sends no update for it, says it is left empty (`Lookup 'X' left empty: only an
insert sets it, …` in `__pass2__`), and so does the plan's cycle. A row the run
retried wrote is owed only what an update can set.

A field the user excluded is owed nothing: never written, neither at insert
nor by the second pass, which filled it in once its record came after. A
renamed lookup is owed under the name the target has, the one the field map
writes it under, on every path: the insert, the second pass, and a row the run
retried wrote.

A lookup a row may leave empty, at a record no read of the run took — the
original policy a policy names, the policy of another asset — is no cycle and
no failure: the row goes in with it empty, and the second pass owes it nothing.
The object's report says it, counting no row (`Written with the lookup empty:
the InsurancePolicy record it points at is not in the clone.`, per lookup and
object, with how many rows went so), so the results page, the audit trail and
the clone command count no failed row for it, and the run's status does not
change. A lookup at a record the run read and could not write — refused, held
back, or of an object whose read failed — is reported in `__pass2__` as
before.

## A record whose required parent was not read

A scoped read goes outwards from the root, an object at a time: a record read
after its parent's object was read can name, through a lookup it may not leave
empty, a record that read did not take. Run between two sandboxes, a clone of a
case read the case's two accounts, then the insurance policy the case names,
whose named insured — an account the policy cannot be written without — was
neither of them: the policy was refused (`REQUIRED_FIELD_MISSING`), and its
three coverages were held back behind it.

Once a node is read, the ids its rows hold in such lookups — the ones the write
order treats as required: a lookup naming one object, not nillable and
settable, or one `platform-required-fields.ts` lists — at records of an object
already read and not among its rows are read by id, one statement per object
(split as any scoped read is), before anything is written. The record is
written in its object's turn, ahead of the rows that need it, or linked to the
one the target holds, as any row of its object is; a person account goes
through the person-account handling as any account does (see "Person
accounts"). What is read under it follows the rule for rows read late: the
nodes read before under its object are read again under its rows, and what
that adds, three levels below it at most; neither the root's object nor the
catalog is read again so. What it cannot be written without is read in turn.
A dry run says it: `[dry-run] Account: 1 more record(s) would be inserted, which
the InsurancePolicy records read after it cannot be written without`.

Each record is asked once a run, and only for the rows that would otherwise be
refused: a clone whose records name none sends no request more. Not asked: a
record the target already holds for the run, one the platform writes itself,
one held back for an object the user excluded; nor a record of the root's
object, read by the root's id alone, of the catalog, read by what the records
name once they are all read, of an object mapped by name, of one that failed
or that the target cannot take. The cap on each object holds, and so does the
user's filter on it. An optional lookup at a record outside the clone stays as
it was: left empty, and said so (above).

## A record whose required parent is outside the graph

The parent can belong to an object no node holds: discovery walks nothing of an
object at the depth asked. Run between two sandboxes, a direct clone of a case
read the case's invoice junction, a child of the case whose master-detail names
an invoice; the invoice's object was in no node, and every junction was refused
(`REQUIRED_FIELD_MISSING: Required fields are missing: [Invoice__c]`). Walking
such a parent in discovery is no way out: it becomes a node like any other, and
a node is a scope for the children the graph already holds — they are read
under the rows of each parent the graph has. Tried, the graph grew to a hundred
objects, a product added brought every coverage of the products in the org, and
the clone wrote some thirty-four thousand records.

Such a parent is read as the catalog's are, for the rows that need it and never
as a scope. Once every node has been read, the catalog included, the ids the
rows hold in lookups they may not leave empty (as above) at an object no node
holds are read by id, one statement per object, split as any scoped read is;
and so are the records those cannot be written without in turn — of an object
no node holds, or of one of the graph whose reads did not take them — five
levels up at most. Read last, by those ids alone, such a record brings nothing
under it, nor its files, and the nodes of the graph read what they read without
it. Its object is written in a turn of its own, ahead of the rows that need it,
and each record is linked to the one the target holds, as any row is matched; a
record of an object of the graph goes in that object's turn. It goes on the
user's choices for its object — fields excluded or renamed, record types
mapped, picklist values checked, its emails and phone numbers neutralized,
anonymized — and its optional lookups are
never followed: one at a record outside the clone is left empty, and said so as
any row's is; one at a record the clone writes anyway is set, as an order's
price book, which its items cannot be written without.

A dry run counts such records among what it would insert, and says why:
`[dry-run] Invoice__c: 2 record(s) would be inserted, which the InvoiceLink__c
records cannot be written without: read by id, nothing read under them`. A real
run says it on the object's line — `Completed Invoice__c: 2 succeeded, 0
failed, 2 read by id for the InvoiceLink__c records that cannot be written
without them` — and `readByObject` counts them, so the results list the object
beside the graph's.

An object the target refuses inserts of, or does not have (its describe
answers `NOT_FOUND`, as for one the user the run writes as cannot see), is not
read: the rows that need one of its records are held back before anything is
written, counted as failed and said as the rows an exclusion holds back are —
`Not written: Invoice__c may not be left empty, and the target org takes no
insert of Invoice__c.` — and so are the rows that cannot be written without
those. A row whose object in the target does not carry the lookup at all goes
in without it, as before.

Not asked, besides what is not asked of an object of the graph (above): a
record of an object the user excluded, whose rows are held back for it; one of
an object no copy writes (`User`, `RecordType` and the rest of
`excludedObjects.ts`); one a row the run retries wrote needs. A run that keeps
the source's ids of the records it does not write (`referenceFallback:
'keep'`) reads none: those ids name the target's own records. Each record is
asked once a run, the cap on each object holds, and so does the user's filter
on it. The orphan-parent expansion (`expandOrphanParents`) copies, one by one,
what this leaves: a parent a lookup naming several objects names, one past the
fifth level or the cap, and the parents of a run of whole tables.

## Person accounts

The platform writes a person account's contact (`Contact.IsPersonAccount`)
itself as it takes the account, and links the two by the account's
`PersonContactId`. The API takes an update of such a contact, never its insert
or its delete: "You can modify a person contact but you can't create or delete
a person contact … Instead, delete or modify the account" (SOAP API Developer
Guide, "Person Account Record Types"). In an org whose describes have person
accounts, the run writes the accounts before the contacts and never sends a
person account's contact the target writes one for. Once the accounts have had
their turn, it reads back the `PersonContactId` of every person account it has
in the target — written, linked to one the target already held, or written by
the run it retries — and maps the source contact onto the one the platform
wrote: what points at it (`Case.ContactId`, a contact role, a custom lookup) is
written against that one. The contact's own row is linked, counted with the
linked records, and never removed on its own — it goes with its account:
`Completed Contact: 3 succeeded, 2 written by the platform with their person
account, 0 failed`. Of an account the run created, the result lists the contact
under `idRemapWithTheirRecord`, and a removal's confirmation counts it among
neither the records it deletes nor those it keeps. One whose account the run
did not write, or whose contact was not found in the target, is not sent
either, and is counted as failed with why. A dry run says them apart from the
rows it would insert.

A target that wrote no contact with the account sends the source's as a contact
of its own, its account's lookup set as any contact's is (the platform takes a
contact on a business account): one with person accounts that holds the
account as a business one — linked to, or written in its place — and one
without person accounts, which is never asked for a `PersonContactId` it does
not have. There, a person account goes in as a business account, by the name
the source computed for it (its record type maps by API name as any does, or is
excluded on the object to take the target's default), and a dry run counts its
contact among the rows it would insert. So does a person account whose record
type in the target is a business account's, in a target with person accounts:
the one the mapping gives it, or the running user's default there when its
`RecordTypeId` is not written, read once a run from `RecordType.IsPersonType`.
Sent as a person account, without its name, the target refused it. It goes by
its name, without the fields only a person account holds ("If the
IsPersonAccount field has the value false, the following fields have a null
value and can't be modified": Object Reference, Account, IsPersonAccount
Fields) — its name parts, the `Person…` fields, the `__pc` ones — and its
contact as one of its own. A record type the mapping does not know, or record
types the run could not read, leave it a person account. A dry run counts its
contact among the rows it would insert when it reads the account first — a run
of whole tables, or one started from the account; one that reads the contact
first, its case before its account, says the platform would write it. The
object's line says it — `Completed Contact: 2 succeeded, 0 failed, 1 person
account's contact sent on their own: the target wrote none with their
account` — and a `scope` report of the object that counts no row says why:
only for the contacts its write sent, never for a node then held back whole.

A required parent copied from outside the graph goes in on the same rules: a
person account's contact is linked to the one the platform wrote with it, and
what points at it is written against that one; such a contact is copied on its
own only where the target wrote none with its account, and a person account
the target takes as a business one goes in as one. The user's choices for its
object hold too: a field excluded is left out, a renamed one goes under the
name the target has.

The platform deletes two more records with one the run created, which the run
links to and never writes: a contact's direct relation to its account — "To
remove a direct relationship between a contact and an account, change the
contact's primary account or delete the contact" (Salesforce Help,
"Considerations for Relating a Contact to Multiple Accounts") — and the task it
wrote with an email on no case: "Deleting an EmailMessage record automatically
deletes the associated Task" (Salesforce Help, knowledge article 000384885).
Of a contact or an email the run created, the result lists them under
`idRemapWithTheirRecord` too, and a removal's confirmation does not count them
among the records it keeps.

## Error structure

`ForgeExecutionResult.errors: ForgeExecutionError[]` is populated whenever any
record or object failed. An object the clone holds no record of — no record
read points at it or sits above it, or the target refuses it and there is none
to write — is counted among the skipped objects, not among the errors.

An object skipped because a record its rows cannot be written without failed
in this run is counted among the skipped objects and named among the errors,
its `scope` report flagged `skipped` and naming the objects it could not do
without. The rows the run had read of it — a record-scoped run reads every
object before it writes one — are counted as failed, in the report and in the
run's `failedCount`, as the rows held back one by one for want of their parent
are; its line says how many (`Skipped QuoteLineItem (parent failed): 1
failed`), and counts with them the rows an exclusion held back as they were
read, as its audit entry does (`2 failed, 1 of them held back for want of …,
excluded from this run`). Skipped before its read, as a run of whole tables
skips it, it counts none: the run never learned how many rows it held. An
object the target takes no insert of, whose records the clone holds, is flagged
the same way and counts none either, one row having been read to know; so is an
object the target does not have, which is not read at all (`Skipped X (not in
the target org)`), the run ending partial or failed as for any object skipped
whole. The run's audit entry names such an object either way, marked skipped —
`counted`, or `uncounted` when the run never learned its rows — and the Audit
Trail page says it was skipped, and that its record count is unknown when it
is. An object read with no row left to write lost nothing, and is only skipped.
Shape:

```ts
interface ForgeExecutionError {
  objectApiName: string;
  stage: 'query' | 'insert' | 'scope';
  failedCount: number;
  attemptedCount: number;
  samples: Array<{
    recordSummary: string; // first ~4 fields key=value
    messages: string[]; // STATUS_CODE: message [Field, …]
  }>;
  skipped?: boolean; // the object was skipped whole
}
```

A message the target gave names the fields its error named, after the code and
the message, unless the message already lists them so: a restricted picklist's
refusal names the value and not the field, and reads
`INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist
field: Gold [Rating__c]`. What reads the code still reads it first.

A row a validation rule of the target refuses (`FIELD_CUSTOM_VALIDATION_EXCEPTION`)
on fields it names, a restricted picklist refuses for a value the check above
let through (`INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`, naming the field), or
the lookup filter of a lookup refuses for the record it names
(`FIELD_FILTER_VALIDATION_EXCEPTION`), is sent again without them, once the
object's calls are through: rows of several calls go together, as many to a
call as the first write sent, through the same insert or upsert and after the
same cancel checkpoint, and each call counts among the run's. Only a refusal
whose every error is one of the three, each naming a field the row gives a
value to — other than the external id an upsert matches on — is retried, and
one that holds several leaves out every field they name. A lookup a filter
refused is left out only when the target's describe lets it be empty: one the
target requires, left out, would have the row refused for want of it
(`REQUIRED_FIELD_MISSING`), and a describe that cannot be read leaves none
out. An error that names no field, or only fields the row leaves empty, or an
error of another kind beside them, leaves the row failed as it was; a
validation rule's error on no field — the rule, or a trigger with its code,
put it on the record — says so in the row's sample. A row taken that time
counts as written and its children find it; the object's line says which
field it went without, what refused it and why (`Completed Contact: 1
succeeded, 0 failed, 1 written without Phone: a validation rule of the target
refused it, FIELD_CUSTOM_VALIDATION_EXCEPTION: …`, `…, 2 written without
Rating__c: a restricted picklist of the target refused its value,
INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist
field: Yes`, or `…, 1 written without Preferred_Account__c: a lookup filter of
the target refused the record it names, FIELD_FILTER_VALIDATION_EXCEPTION: …`),
the result lists it per object and field under `writtenWithoutFields`, each
field with what refused it in `refusedBy` (`validation-rule`,
`restricted-picklist` or `lookup-filter`; a run recorded before a picklist's
refusal was written again has none, and was a rule's), and the audit entry
counts the rows so written, never their values. A row refused again on fields
the refusals before did not name — a second rule speaking once the first is
out of the way — goes again without them too, in a round of its own, three
rounds at most: refused otherwise, or a fourth time, it fails with the last
refusal, its sample saying what each before was. A cancel before such a call,
or a call that throws — of the first write or of these — leaves the rows it
would have sent failed with their last refusal, saying why they were not
written again.

A call is sent again only when the target cannot have written any of its rows.
One that never reached it — no connection (`ECONNREFUSED`), no address for its
host (`ENOTFOUND`, `EAI_AGAIN`), the edge answering for the org that it is
unavailable (503) or asked too soon (429) — goes again after a wait of 1 to 2
seconds, doubled each time, half of it left to chance, three times at most,
each after the cancel checkpoint; past that, its rows are failed, not written.
A row refused for a record the target could not lock (`UNABLE_TO_LOCK_ROW`)
was not written either, a call committing each of its rows on its own: it goes
again on the same waits, alone, three times at most, before the object's next
call. A call whose answer never came back — a timeout, a connection reset once
the request was out, the edge saying the org failed it (502, 504) — may have
written any of its rows: the object stops there, as at any call that throws,
and the call is never sent again, since the rows the target wrote would be
written twice. Its sample comes first among the object's and says the target
may hold any of those rows and which is unknown; they are counted failed, are
not among the records the run created, and removing its records does not reach
them. A call the target refuses whole for its API request limit
(`REQUEST_LIMIT_EXCEEDED`) stops the object without a retry, and its sample
says so; one it refuses for anything else stops it as before, its rows not
written.

A picklist value the target refused under a record type is kept for the run:
a later row of the same object holding that value under that record type is
sent without it from its first call, and counted under `writtenWithoutFields`
with the refusal, as the rows refused for it were. An API write has its
restricted picklists checked before any trigger or rule runs, so the value
would have been refused again: the row ends as it would have, one refusal
sooner, and keeps its three rounds for anything else the target refuses it
on; a sample of such a row that fails says why it went without the value.
The value is what is kept, not the field: a record type that takes some of a
field's values refuses only the others. Nothing is kept of a row that names no
record type — an upsert that matches a record leaves it the one it has — nor of
a field the target's describe does not list, or makes depend on another, whose
value the refusal may hang on too.

A required parent copied from outside the graph is written again on the same
rule, once — without the fields a validation rule or a restricted picklist
refused, never without a lookup a filter refused — and counted under its object
in `writtenWithoutFields`; it goes in an insert of its own, and neither reads
nor adds to the values kept for the run. Refused, it is reported in the
`__expandOrphanParents__` report with what the target answered, and with its
first refusal when it was sent again.

The rows held back before the write are counted with the rows the target
refused on the object's line, as the run's totals and its audit entry count
them, and the line says how many of them each reason held back: a feed item
whose parent, one of several objects its lookup can name, was not written —
`Completed FeedItem: 1 succeeded, 2 failed, 2 of them held back for want of
their parent` — and a record that cannot be written without one of an object
excluded by name, said once, on the line that ends the object —
`Completed OpportunityLineItem: 2 succeeded, 2 failed, 2 of them held back for
want of ProductSellingModelOption, excluded from this run`. So do the lines of
a write that mostly failed (`4/5 FeedItem records failed (>50%), 2 of them
held back for want of their parent`) or failed whole (`Failed all FeedItem
records: 3 failed, 2 of them held back for want of their parent`). A line that
counts no failure of the object — a dry run's, or that of an email object whose
other emails the run never sent — says them failed on their own: `[dry-run]
OpportunityLineItem: 2 fewer would be inserted, 2 failed, held back for want of
ProductSellingModelOption, excluded from this run`.

An object held back whole — for a record type the running user cannot use in
the target, for want of the parents its rows point at, or because every row
needs an object excluded by name — says how many of its rows failed before it
says why, each reason counting only its own rows: `Held back Quote, nothing
written, 26 failed: 4 Quote records use record type …`. The line ends the
object, so the rows an exclusion held back as they were read are counted there
too, and said as the line of a write says them (`, 2 of them held back for want
of …, excluded from this run`).

The wizard webview consumes this via `forge:execute:response` and renders a
grouped error panel (see `ForgeResults.tsx`).

## Recipe

`packages/extension/tools/recipe-forge-grappe.ts` replays the production
pipeline against real orgs (sf CLI tokens). Configure `SCENARIO`:

```ts
const SCENARIO = {
  sourceAlias: 'SOURCE-UAT',
  targetAlias: 'TARGET-DEV',
  recordId: '500XX00000000001AAA',
  depth: 'custom',
  customDepth: 5,
  anonymizePII: true,
  skipEmpty: true,
  apiVersion: '66.0',
  dryRun: true, // flip to false to actually write to the target
  maxRecordsPerObject: 5,
};
```

Run with:

```bash
pnpm --filter @sandforge/extension exec tsx tools/recipe-forge-grappe.ts
```

## Known limitations

- **Large scopes are read in several queries**: a scoped query travels in
  the request URI, which holds roughly 500 quoted IDs. When an object's
  scope is larger — 1 300 Contacts under one Account, or one parent list
  repeated across several FK fields — `ScopedSoqlBuilder` splits the IDs
  over as many statements as needed (each kept under the URI budget, at
  most 500 IDs apiece) and the executor merges the rows, keeping one per
  `Id`. `maxRecordsPerObject` still caps the merged total. The one case
  still refused is an object whose field list alone leaves no room for an
  ID; exclude fields from that object to clone it.
- **Excluded objects**: discovery and orphan-parent expansion share one
  list (`excludedObjects.ts`) — system and hub objects such as `User`,
  `RecordType`, `Queue`, job and log tables (`AsyncApexJob`, `CronTrigger`,
  `LoginHistory`), history / feed / share / change-event variants, and
  every Vlocity package object (`vlocity_*` namespaces). Files are never
  nodes either: `Attachment`, `ContentVersion`, `Document`,
  `ContentDocument` and `ContentDocumentLink` are left out, and the `files`
  option copies files in a stage of its own.
- **FLS profile awareness**: `Asset.RecordType ID not valid for the user`
  errors come from the running user's profile lacking access. The cloner
  reports them; resolution is org-side (assign permission set).
- **A node read before a parent whose turn comes after its own**: in a cycle
  the order of the first pass is the graph's, and a node whose turn comes
  first is read under the parents in scope then; the parent, read at its own
  turn, does not have it read again under its rows unless it waited for that
  turn. A product's clone read a feed item on an opportunity so — a tracked
  change, which the platform writes itself; a post would be left out the same
  way. Read again under every such parent, the reference clones sent up to a
  sixth more requests and brought no row, so they are not. The other way
  round, a record read after its parent's object can name a record that read
  did not take: it is read by id when the row cannot be written without it
  (see "A record whose required parent was not read"), but for a record of
  the root's object, which stays the root alone — the row is refused for want
  of it, as before. Through a lookup the row may leave empty, it is not read:
  the row goes in with the lookup empty, and the object's report says so.
- **Rows followed down three levels**: the rows a parent read late brings are
  read again under by the nodes read before, and what that adds, three levels
  below the parent at most. Past that, the rows are as the order of the reads
  left them.
- **Parents outside the graph, five levels up**: a record read by id for the
  rows that cannot be written without it brings what it cannot be written
  without, five levels up at most — a chain of master-detail lookups is three
  deep. A record past the fifth goes to the target without its parent, which
  refuses it. Such a record brings nothing under it: its other children — the
  junction rows of another case, an invoice's lines — stay out of the clone.
- **A record no query finds when a removal begins** is never sent. It counts
  as already gone when the org's recycle bin holds it (`queryAll`, `IsDeleted
= true`); one found neither there nor in the org counts as not visible to
  the user the removal runs as (`notVisible`), never as removed, and the run
  stays offered for it. No read tells such a record out of the session's
  sight from one deleted for good: the org keeps no deleted price book entry
  or task relation in its recycle bin, and a record emptied from the bin, or
  past the fifteen days it keeps one, is not there either. Those count as not
  visible too, and a removal of what is left keeps offering them.
- **A person account whose record type the target does not tell**: one whose
  record type the mapping does not know, or in a target whose record types the
  run could not read, goes in as a person account, without its computed name:
  a business record type there refuses it.
