# Trap orgs

Two Developer Edition orgs that reproduce, on orgs we own and may break, what client orgs did to
SandForge. `SANDFORGE-SOURCE` holds synthetic records carrying values that `SANDFORGE-TRAP`
refuses. Both serve SandForge's tests alone.

```bash
test/scripts/trap-org.sh connect  # whether each alias leads to a Developer Edition, how to log in
test/scripts/trap-org.sh deploy   # metadata, field access, currencies
test/scripts/trap-org.sh seed     # synthetic data
test/scripts/trap-org.sh verify   # one probe per trap, with the HTTP status it gets
test/scripts/trap-org.sh wipe     # every record removed, sample data included; seed again to reset
```

Add `source` or `target` to act on one org. The script touches no alias but these two, refuses
either unless the org says it is a Developer Edition and no sandbox (a client org never is), and
prints no username, token or auth URL. It needs `sf` and `jq`.

A Developer Edition is signed up for by hand at <https://developer.salesforce.com/signup>, then
connected with `sf org login web --alias SANDFORGE-TRAP --instance-url https://login.salesforce.com`
(and the same for `SANDFORGE-SOURCE`).

## What the target does

| #   | Trap                                                                                                                                                                                                                          | `verify` expects                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Case record types on restricted picklists: `Trap_Main` is given A and B of `Trap_Reason__c`; `Trap_Empty` has no active value of `Trap_Late__c` left, while the UI API lists Y and Z for it                                   | 400 on C, on Y for `Trap_Empty` and on the retired X; 201 on A                   |
| 2   | `Trap_Subcategory__c` restricted and dependent on `Trap_Category__c`, on Case and on `Trap_Item__c`, which has no record type                                                                                                 | 400 on a pair the dependency refuses                                             |
| 3   | Contact rules: a phone format (`+33 X XX XX XX XX`), and an email requirement bypassed by `$Permission.Trap_Bypass_VR`, held by a set assigned to nobody                                                                      | 400 on each                                                                      |
| 4   | Duplicate rules: an Alert on Account name, a Block on Lead email                                                                                                                                                              | 400 without `allowSave`; the Block stays                                         |
| 5   | A required lookup filter: `Contact.Trap_Preferred_Account__c` takes Customer accounts only                                                                                                                                    | 400                                                                              |
| 6   | `Account.Trap_Target_Only__c`, required, absent from the source                                                                                                                                                               | 400                                                                              |
| 7   | `Account.Trap_Ext_Id__c`, unique here, not unique in the source                                                                                                                                                               | 400 on the second account                                                        |
| 8   | A before-delete flow on `Trap_Item__c` that refuses the delete with a custom error, unless `Trap_Allow_Delete__c` is checked                                                                                                  | 400, then 204 once let go                                                        |
| 9   | Messages on Contact creation: a flow that sends an email in the transaction and again on an asynchronous path, quiet for a holder of `$Permission.Trap_Bypass_Flow` (in the same set as trap 3's), and a workflow email alert | reports the status                                                               |
| 10  | An active Lead assignment rule that hands every lead to a queue                                                                                                                                                               | 201, and who owns the lead                                                       |
| 11  | Person accounts                                                                                                                                                                                                               | 201 where they are on                                                            |
| 12  | Multi-currency, EUR alone (the source has EUR and USD)                                                                                                                                                                        | 400 on USD where it is on                                                        |
| 13  | Deliverability, as the Send Email action meets it                                                                                                                                                                             | reports the status                                                               |
| 14  | A rehearsal's composite call holding an Account twin of `Trap Account 01` (Alert rule) and an account without `Trap_Target_Only__c`, the duplicate header sent nowhere, with the call, with the Collections request, or both  | the twin refused unless the Collections request carries the header; nothing left |
| 15  | The same with a Lead twin of a seeded email (Block rule)                                                                                                                                                                      | the twin refused in all four; nothing left                                       |
| 16  | Asynchronous work an insert starts, rolled back in a composite call beside the same insert committed (the async probe, `target/probes`)                                                                                       | after the rollback, only the event published at once; the control, all six       |
| 17  | A contact with an email (trap 9's flow) in a rolled-back composite call, beside one message sent for good                                                                                                                     | one single email taken, the control's                                            |

A Developer Edition sends 15 single emails a day. The flow of trap 9 sends two per contact, and
once the day's are spent it fails and the contact is refused (`CANNOT_EXECUTE_FLOW_TRIGGER`,
"Probably Limit Exceeded"): a clone of contacts needs the flow's bypass, held by `Trap_Bypass`.

A Developer Edition comes without person accounts and multi-currency. Both can be turned on in
Setup, and multi-currency never off again; until then traps 11 and 12 say they are off and the
seed leaves out person accounts and currency codes.

### What a rehearsal's rollback keeps (probes 14 to 17)

Read on 2026-10-09, with composite calls shaped as a rehearsal sends them: a Collections request
(`allOrNone: false`) and an update of a record that does not exist, which fails and rolls the
call back.

- **The duplicate header** (`Sforce-Duplicate-Rule-Header: allowSave=true`) is read only from a
  subrequest's own `httpHeaders`. Sent with the composite call alone, the Alert rule refused the
  twin (`DUPLICATES_DETECTED`); sent with the Collections request, or with both, it let it through.
  The Block rule refused the twin in all four. The rehearsal sends the header in both places.
- **Asynchronous work after the rollback.** Of a queueable job and a future call queued by an
  Apex trigger, a Flow's path after commit and its path scheduled zero minutes on, an event
  published at once (`PublishImmediately`) and one published after commit, only the event
  published at once was delivered, and the marker its subscribing Flow wrote stayed. No Apex job
  was queued. The same insert committed ran all six within the five minutes the probe waits.
- **Emails.** The single email trap 9's flow sends in the transaction did not count against the
  day's fifteen once the call was rolled back. `/limits` counts a send a minute or two late: the
  probe reads it once the control's message is counted.

The async probe has an object of its own, `Trap_Probe_Item__c`: on `Trap_Item__c`, its trigger
would meet every clone of the items, and a real clone refuses a target that runs an Apex trigger
on what it writes. `Trap_Probe_Access` opens its markers' fields to the admin.

### How trap 1 is built

A client record type refused every value of a restricted picklist while the UI API listed the
field's values for it. Salesforce gets there when a record type has no active value of the field
left. Deploying does not get there directly:

- a record type whose file leaves the picklist out is given every value;
- an entry for the picklist without values changes nothing;
- an entry with values replaces the record type's values with those.

So `Trap_Late__c` is deployed with X, Y and Z, `Trap_Empty` is given X alone, and `deploy` then
deploys the field again without X. `Trap_Empty` keeps the retired X and nothing else, and the UI
API answers the field's active values for it.

## Data

`seed` fills the source: 40 business accounts (10 repeat a name, 10 an external id; half are
Prospects; a quarter in USD where multi-currency is on), 10 person accounts where they are on,
1 200 contacts through Bulk API 2.0 (one in 25 without email, phones in shapes the target
refuses), 40 cases across both record types, 40 items and 20 leads in pairs that share an email.
`TRAP_CONTACTS` changes the number of contacts: a Developer Edition holds 5 MB, about 2 500
records, and 1 200 still outnumber the 500 rows a DataOps backup reads outside a sandbox. The
target gets 3 accounts and 2 leads that collide with source records: a duplicate rule compares a
record with those already saved, not with the rest of its batch.

Emails are on `example.invalid`, phones in the ARCEP fiction range `+33 6 39 98 XX XX`, names
made up.

## Layout

- `source/`: the fields the clones carry. The category pair is independent there, so a source
  record can hold a pair the target's dependency refuses.
- `target/main/`: deployed first, then `Trap_Late__c` again without X.
- `target/duplicates/`: deployed once the matching rules are active. The script sets each rule's
  sort order after the org's standard rules, whose number varies. A Block rule takes no
  operations.
- `target/legacy/`: a workflow rule with an email alert, deployed apart. Setup no longer creates
  workflow rules; the Metadata API still takes one.
- `target/probes/`: the async probe of probe 16, deployed last: an item object with an Apex trigger
  (and its test class) and a record-triggered Flow, two platform events with a Flow each, and the
  marker object they all write to.

## The Salesforce CLI

`sf api request rest` (2.152) refuses a DELETE without a body and with an empty `--body` alike
("No 'mode' found in 'body' entry"). The script sends those through a request file whose raw body
is empty.
