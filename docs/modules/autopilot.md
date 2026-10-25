# Autopilot

Copy whole objects from one Salesforce org into another, in the order their dependencies set, with the records they reference. It is a copy, not a generator: it needs a source org that holds the records, and it writes what that org holds.

Before you start, know three things:

- **It copies whole tables.** Each object you select is read and written whole, every record of it, as selected; of the other objects, only the records the selection references are read. A run copies 50,000 records of a selected object at most: past that, its first 50,000 by Id are copied, with the records they reference, and the plan says so beside the count the source holds.
- **Masking is off by default.** Emails and phone numbers are neutralized unless you untick the box, but names, addresses and every other field go in as the source holds them unless you pick a compliance framework on the review step.
- **A run cannot be removed.** Autopilot keeps no list of the records it created, so nothing takes a run back: try it on an org you can refresh or throw away, such as a scratch org. To copy objects and be able to take a run back, use [Sync](sync.md); to copy one record and what hangs on it, [Forge](../forge-quickstart.md).

## Quick Start

1. Open **Autopilot** from the launcher's Modules list (it needs two connected orgs)
2. **Connect Source & Target**: the org the records come from, and the org they go into
3. **Select Objects**: the objects of the source to copy. An object the target does not have is listed, marked _Not in the target org_, and cannot be picked
4. **Review Plan**: the objects and records the plan copies, in waves, what it reads only by id, and the lookups it leaves empty; the personal fields it found; **Neutralize emails and phone numbers (recommended)**, ticked; and, under **Advanced: compliance framework**, the masking to apply
5. **Execute Autopilot**, then follow the run on the dependency graph and the control panel

## What a run copies

- **The objects you select**, copied whole: the plan says _Copied whole, as selected_ and names them. One holding more than the 50,000 records a run copies of a selected object, whether or not the plan follows its lookups, is named apart: the plan says how many of its records it copies, the first by Id, of how many the source holds, and copies the records those reference.
- **The records they reference**: of any other object, only the records the selected ones point at, read by id -- the accounts of the contacts you copy, say. The plan lists these objects apart from the ones copied whole.
- **What it leaves empty**: a lookup the plan does not follow -- too many lookups away from a selected object, or past the objects a plan holds -- is left empty, and the plan lists each with why. A lookup a record cannot be written without is named too: those records will be refused.
- **Dependency order**: parents go before the records that point at them, in waves; a lookup of a cycle goes in empty and is filled by a second pass. A record whose parent the target refused is held back rather than written without it, and statuses are applied after the records under them.
- **Accounts as their kind**: a person account as a person account, a business account as a business account, by the rule Forge and Sync share.
- **Currencies**: the plan lists the currencies the target does not hold active; a record in one of them is written in the target's corporate currency, its amounts converted at the source's rates.

## Masking

- **Emails and phone numbers** are neutralized by default, whatever the framework: every email address is written under `.invalid` and every phone number as a fictional one, so the target's automation reaches no one. Untick **Neutralize emails and phone numbers (recommended)** to copy them as the source holds them.
- **A compliance framework** -- GDPR, CCPA, HIPAA or PCI-DSS -- anonymizes the personal fields it covers. **None** is the default, on the review step and on the command line, and stays so: a copy holds the source's records as they are, its emails and phone numbers neutralized as a Sync run writes them. With **None**, nothing is anonymized beyond the emails and phone numbers, and the review step says so beside the framework picker: names, addresses and the other personal fields are copied as the source holds them until you pick a framework. The review step says, per object, which personal fields no rule of the framework covers, which would be copied as the source holds them, and the run ends with a **Compliance Report** you can export as JSON.

## Before a run writes

- **Production Guard** asks before a run writes to a production org; a sandbox, a scratch org and a Developer Edition org are not production orgs.
- **The volume**: past `sandforge.safety.confirmAboveRecords` records (2,000 unless you set it), or near the target's data storage, a confirmation lists the records per object; a plan whose records take more data storage, or more of the day's API requests, than the target has left is refused, and nothing is written.
- **Emails**: what the target's flows would send as the records go in is counted against the emails it has left today -- on a Developer Edition, 15 single emails a day, its email alerts among them -- and a run past them is asked about. So is a run whose target's automation -- or its flows, processes or workflow rules -- could not be read: the confirmation says their emails were not counted, and why, as a Sync run's does.

## While it runs

The review says, above **Execute Autopilot**, that SandForge cannot remove what the run writes. The page waits on the run for up to 12 hours, as Seed's and Sync's do; should it stop waiting, it stays on the run and says it may still be writing and that Monitor's Live Operations shows where it is. A second run on the same target is refused while one writes, `AUTOPILOT_RUNNING`, and nothing of it is written. The control panel shows the records processed, the API calls, the elapsed time and the current wave, and offers **Pause**, **Resume**, **Skip Node** and **Stop**; Live Operations lists the run, paused while it is paused, and its Cancel stops it as **Stop** does. A stopped run writes nothing after the stop and says what it did not write, or left unfinished: lookups a second pass would have filled, statuses not given back. The audit trail (Reports → Audit Trail) records each run, with what it wrote per object.

## From the command line

`sandforge-autopilot --source <alias> --target <alias> --object <ApiName>` runs the same copy without the editor, into a sandbox or a Developer Edition org -- a production target is refused before the scan --, with `--plan-only` to scan and plan without writing, `--compliance <name>` for a framework, `--keep-contact-points` to copy emails and phone numbers as read, and `--max-total <n>` for the most records it may write (10,000 by default). See [Command line & CI](../../ci-examples/README.md).
