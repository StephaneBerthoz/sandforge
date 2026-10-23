# Checkpoint & Rewind

Keep the state of an org's data at a moment on this machine, and return the org to it later. Take a checkpoint before a test session, a demo or a training; afterwards, Rewind puts the data of the org back as it was at the checkpoint, whoever changed it since -- you, your testers, flows or integrations. Records created since are deleted, records changed since get their checkpoint values back field by field, and records deleted since come back from the recycle bin with their original Ids. Before it writes anything, Rewind shows what it will change, who last changed it, what the org runs in answer and what it cannot take back; it keeps what it changes, so a rewind can be undone; and once through, it reads the org again and names what still differs, with why.

A DataOps backup is a copy of some objects: its Restore writes the copy back and brings back deleted records, and never deletes what was added. A checkpoint is the state of an org's data at a moment: its Rewind deletes what was added, gives back what changed and brings back what was deleted, whoever did it.

Before you start, know four things:

- **It undoes everyone's work since the checkpoint**, not only SandForge's runs: every record created, changed or deleted since, in the objects the checkpoint holds, by any user, flow or integration. The preview says who last changed what before anything is written.
- **Never on a production org.** A checkpoint is taken of, and a rewind writes to, a sandbox, a scratch org or a Developer Edition org only; the edition is read from the org itself as well as from the registry, an edition it cannot tell counts as production, and no setting or flag lifts the refusal. The user SandForge connects as needs **View All Data and Modify All Data**: without them, a record the user cannot see would read as deleted.
- **It rewinds data, not configuration.** Metadata, users, setup, files and what already left the org are out of its reach: [What a rewind leaves as it is](#what-a-rewind-leaves-as-it-is) lists them.
- **A checkpoint holds the records' values in clear**, personal data among them, on this machine, readable by you alone, for 30 days unless you keep it: [Where checkpoints are kept](#where-checkpoints-are-kept).

## Quick Start

The whole round trip on a Developer Edition org, in about a minute:

1. Open **Checkpoints**: third in the launcher's Modules list, after Seed and Forge, or **SandForge: Open Checkpoints** from the Command Palette, or `G` then `K` in the panel. Pick the org.
2. **Take a checkpoint**: keep the name it offers, or pick **Before UAT**, **Before demo** or **Clean baseline**; keep **Everything people work in**; read **Before it runs**, then **Take the checkpoint**.
3. In Salesforce, create a record, change two and delete one.
4. **Rewind…** on the checkpoint's row: the preview reads the org and writes nothing. It shows **1 to delete**, **2 to give back**, **1 to bring back**.
5. **Rewind \<org\>…**, type the org's alias, and confirm. The result reads that nothing differs among the objects and fields the checkpoint holds.
6. **Undo this rewind** puts the three changes back.

## Taking a checkpoint

**Take a checkpoint** opens the take. Nothing of the org's records is read until you start it: what it shows before is read from the org's descriptions and counts.

The moment worth keeping is often right after filling an org. The results of a Seed run (a template, the wizard, a CSV import or a clone from another org), of a Forge clone and of a Frozen load that wrote to a sandbox, a scratch org or a Developer Edition offer **Take a checkpoint now**, which opens this take on that org, ready: the org as the run left it becomes the point to come back to before your testers start. The run itself is taken back from its own results; the checkpoint takes back what everyone does next. It is not offered for a production org, nor after a run, a simulation among them, that wrote nothing.

- **The name**: the date and time unless you write one, or one of the three names offered. A name is one line of 120 characters at most. **Keep until I delete it** keeps the checkpoint past its 30 days; **Clean baseline** ticks it for you.
- **What it keeps**:
  - **Everything people work in**, the default: every object of the org the user may query, create, edit and delete, empty ones included, so that what is created there later is caught too. **See the objects** lists them, how many hold records and how many are empty, and the objects of each managed package, which stay: a party of an industry package is data like an account.
  - **Only the objects I pick**: the objects you tick, filtered by name.
  - **Left out**, each with why, in the list of the objects left out under the scope: users, permissions and the rest of setup -- in **Everything people work in**, every object the org gives no page layout, which is setup kept as records, but for the few related-list objects people work in, such as account contact roles and case team members; custom settings, which are configuration; Chatter posts, comments and their attachments; history, sharing and change-event objects, the org's own bookkeeping; big objects, external objects, Data Cloud objects, Knowledge article versions and platform events; files, their versions, documents and links, and attachments; metadata; an object the user may not query, create, edit and delete; an object the org would not describe; an object with no `SystemModstamp`, whose changes nothing could tell; an object without a recycle bin, whose deleted records nothing could tell nor bring back; an object the org will not read without a filter, which never fails the take; an object holding more records than the take's limit, left out whole rather than kept in part; an object picked that the org does not have; and an object the command line's `--exclude-object` names. These rules hold for an object picked by name too, a page layout aside: a feed picked is still a feed.
- **Before it runs**, computed before the button is enabled: about how long the take lasts, how many API requests it sends of the ones the org has left today, how much it takes on this machine and until when it is kept; that it holds the records' values in clear, readable by you alone; to ask people to stop working in the org while it is taken; the objects whose deleted records come back only with their parent record (OpportunityLineItem, PricebookEntry, CampaignMember and the like); and the fields the checkpoint cannot hold -- a field hidden from the user by field-level security, a classic encrypted field the user cannot view decrypted -- which Rewind will not touch.
- **Refused before a record is read**, each with its reason: a production org; a user without View All Data and Modify All Data; another take, a rewind or an undo of the org, or a SandForge run writing to it; more records than the take's limit (500,000 unless the command line names another); more API requests than the org has left today.
- **The take**: its moment is the moment it starts, read on the org's clock. It reads the objects children first, each record as it was when its object was read, and shows its progress, also in Monitor's Live Operations, with **Stop**. A stopped take keeps nothing. Once through, it says how many records it holds in how many objects and how much it takes on disk, and warns when records changed while it was being taken: a rewind treats them as changed since. Take checkpoints when nobody is working in the org.
- **What it holds of each record**: the fields the user may create or edit, with its created and last modified dates and who set them, which are never written back; never a formula or a roll-up. Tasks and Events are read with the archived ones the platform hides from an ordinary query, so an activity archived since never reads as deleted. A person account's contact is never deleted, brought back nor given back on its own, as Salesforce allows none of it: its account alone is, compared whenever the contact moved.

## The list

The page lists the checkpoints of the org it shows, newest first, read from this machine: it never contacts the org. Each row says when it was taken, how many records it holds and until when it is kept, with **Rewind…**, **Keep until I delete it**, **Rename**, **Stop comparing fields…** and **Delete**. Its lines say, where they apply:

- Expires in 2 days, three days before its date, with **Keep**. Unticking **Keep until I delete it** gives a checkpoint 30 days from then.
- Records deleted before a date cannot come back, once the checkpoint is more than 15 days old: the recycle bin keeps them 15 days, less if it fills.
- Rewound on a date, and until when it can be undone, on the checkpoint of the org's last rewind, with **Undo this rewind**.
- Why it can only be deleted, for a checkpoint of the org before a sandbox refresh -- a refreshed sandbox is another org, with another Organization Id -- for one of a scratch org that has expired, one whose take failed or never ended, and one whose file cannot be read.

**Delete** asks first: it deletes the checkpoint from this machine, the org can no longer be rewound to it, and, when its rewind can still be undone, that rewind can no longer be. The org is not touched. Home shows the selected org's last checkpoint, with **Rewind…**, or offers to take one before the next test session, and a checkpoint that expires within three days, with **Keep**; nothing for a production org.

## The preview

**Rewind…**, on a row or on Home, reads what changed in the org since the checkpoint, and writes nothing.

- **Three numbers**: **to delete**, the records added since -- created since, or brought back from the recycle bin since, which go back to it -- with what comes back with a parent and goes again; **to give back**, the records changed since; **to bring back**, the records deleted since.
- **Last changed by**, with how many records each person last changed, and **People working in the org in the last hour**. When the user SandForge connects as is among them, it says that testers who sign in as that user cannot be told apart from the rewind: ask them to stop first.
- **What a rewind does, object by object**: Delete, Give back, Bring back and Cannot undo per object, then the details: the field values to give back; the lookups a deletion since cleared, which are given back; the records deleted while the checkpoint was taken, which come back with the values they had then; the records that come back with their parent record; the records touched since that hold their checkpoint values, with nothing to give back; and the records the checkpoint does not hold although they are dated before it, a load with back-dated creation dates say, which are left as they are -- a rewind deletes nothing it cannot prove was created since. An object that could not be read is named, and a rewind leaves it as it is: it is never taken for unchanged.
- **What a rewind cannot undo**: the records deleted since that the recycle bin no longer holds, or that Salesforce keeps in it for good -- one deleted on its own, then a record it hangs from or points at deleted after it, as a case then its account -- which cannot come back with their Id; the leads converted since, which Salesforce cannot unconvert, left converted and never given back; the contracts activated since, which Salesforce will not set back to Draft, left activated and never given back; the records deleted since with a record created since, which their delete took along: Salesforce brings them back with that record only, which the rewind does not bring back; the fields deleted since, to restore from Deleted Fields within 15 days before rewinding again; the fields added since, whose values stay; the fields whose type changed, tried field by field; the values the org computes or keeps itself; what already left the org; metadata.
- **What Undo could not bring back**, each reason in its own sentence: the records this rewind deletes in an object Salesforce undeletes only with its parent record, when that parent stays -- a product added since to an opportunity that existed at the checkpoint; and the records it deletes before a record they point at, which the rewind deletes next: Salesforce cannot bring them back after that. A case created since under an account created since is one where the case's account lookup forbids deleting an account that still has cases, as it was seen to on a scratch org: the case must go first, alone. So is a record made while the checkpoint was taken, or brought back since, under a record the rewind deletes. The rewind is refused unless **Rewind even though Undo could not bring these back** is ticked, and so is `--accept-no-undo` on the command line. A record created since under a record the rewind deletes too, through a relationship whose delete takes it along, is not sent on its own: it goes with its parent, and Undo brings it back with it. Deleted on its own first, it would stay in the recycle bin for good once its parent was deleted after it.
- **Also deleted with them, outside the checkpoint**: records of objects the checkpoint does not hold, created under records the rewind deletes, which their delete takes along. A checkpoint of everything people work in deletes them with the records they hang from; one of the objects you picked deletes them only when **Delete these too** is ticked, and otherwise keeps the records they hang from, named once the rewind is through.
- **Not compared (you chose)**: the fields **Stop comparing fields…** set aside, neither compared nor written back.
- **What the org runs as the rewind writes**: the flows, Apex triggers, processes and workflow rules that run as it brings records back, gives them their values back and deletes them, `after undelete` triggers included. When any runs, or the org would not say, the rewind is refused unless **Rewind even though \<org\> runs automation** is ticked. Under it, the emails they send, per daily limit -- single emails, workflow emails -- about how many and by what, against what the org has left of each today; a Developer Edition, which sends 15 single emails a day, counts its email alerts among them.
- **The cost**: about how long the rewind takes, and how many API requests of the ones the org has left today. Then: before it writes, Rewind keeps what it changes, so you can undo it for 15 days, sooner if the recycle bin fills.

Three refusals no box lifts: a SandForge run writing to the org, more API requests than the org has left today, and more emails than it has left today of a daily limit -- past them, Salesforce refuses each record whose flow fails in the save, and the org's own emails stop for the rest of the day: turn off what sends them, or give the user a bypass that keeps it quiet; the preview says them, and **Rewind \<org\>…** stays off. When nothing differs, the preview reads that the org is as it was at the checkpoint among the objects and fields it holds: nothing to rewind.

## Rewinding

**Rewind \<org\>…** asks for the org's alias, typed, under what the rewind does: it deletes the records added since, gives the records changed since their values from then back and brings back the records deleted since from the recycle bin, whoever made these changes. The rewind then reads the org again and acts on what you confirmed that still differs. What changed since the preview is left as it is and named, changed since the preview: rewind again to take it. A busy org never makes it loop, and it never does more than you confirmed.

It runs in this order, shown on the page with its progress and **Stop the rewind**, and in Live Operations, whose Cancel stops it too:

1. **Bring back** the records deleted since, parents first, with their Ids; the children a parent's delete took along come back with it.
2. **Give back** the values of the records changed since, 2,000 records at a time, each chunk's current values read just before it is written. Only the fields the checkpoint compares, the org still has and the user may write are read and written, and only those that differ. A record whose update the org refuses for one field is sent again without that field, which keeps its value, and the result counts it. An order that was Draft at the checkpoint gets its status back first, alone.
3. **Delete** the records added since, children first, into the recycle bin; a record created since under one it deletes goes with it, never on its own. What a record deleted by the rewind held in place -- an opportunity's price book and amount, while it had products added since -- is given back once the deletes are through.
4. **Check**: the org is read again. When the first pass wrote anything, a second pass takes what it left, and what the user SandForge connects as or the org's Automated Process created or changed in answer: automation that set a field again on save, a record that came back with its parent and goes again.

Leaving the page does not stop the rewind: it goes on in the extension, as Live Operations shows. A window closed while it runs stops it, and leaves its journal: the next rewind to the checkpoint takes it up. A record someone else changes after the rewind began is left as they made it, and named. Where testers sign in as the user SandForge connects as, common on a Developer Edition or a scratch org, their changes during the rewind cannot be told from the rewind's own, and are rewound with the rest.

**The result**:

- Done: the org is back at the checkpoint; read again, nothing differs among the objects and fields it holds.
- Partial: the org is back at the checkpoint except the records listed, grouped by why:
  - **Kept by your automation**: records your automation set again on save after the second pass, with **Stop comparing these fields…** for a field it sets on every save;
  - **Changed during the rewind by someone else**, by whom, left as they made them;
  - **Changed since the preview**: rewind again to take them;
  - **Refused by \<org\>**, in the org's words: what a validation rule added since refuses, say, or a field the org no longer takes as it was, which kept its value. No validation rule is bypassed: turn it off or fix the data, then rewind again;
  - **Gone for good**: records deleted since that the recycle bin no longer holds, or that Salesforce keeps in it for good;
  - **Kept on purpose**: records the rewind had to keep, with why: a record created since that records of the checkpoint still depend on, say, the parent of records outside the checkpoint you did not accept to delete, a lead converted since, which Salesforce cannot unconvert, a contract activated since, which it will not set back to Draft, or a record deleted with one created since, left in the recycle bin.
- Unstable: someone kept writing to the org during the rewind; who, and how many records, left as they made them. Rewind again once they have stopped.
- Stopped part way: the org is between the checkpoint and now. **Rewind again** takes up the same journal, reads the org again and finishes from what still differs; Undo still returns the org to how it was before the rewind.
- Ended before it was through: what it did is listed, and **Rewind again** takes up from what still differs.

Any result but done offers **Rewind again**, which reads the org afresh for a new preview, and a rewind that wrote anything offers **Undo this rewind**, saying until when. Under it, per object, what was brought back, given back and deleted, what was refused, and the API requests the rewind used of the ones left today. Each rewind, and each undo, is recorded in Reports → Audit Trail.

## Undo

**Undo this rewind**, on the rewind's result and on the list's line of the org's last rewind, takes that rewind back from its journal: what it deleted comes back from the recycle bin, what it wrote over gets its values from before back, and what it brought back goes back to the recycle bin -- what came back with a record, a contact with its account or a product with its opportunity, goes with that record, never on its own, so that the record brought back later from the bin brings it back too. What anyone changed in the org since the rewind stays as it is, and is named.

- It asks for the org's alias, typed, and lists what it could not bring back. **Undo even though \<org\> runs automation as records are updated, deleted or brought back** is never ticked for you: without it, an org that runs automation as the undo writes refuses it, and says what runs. An undo whose writes would send more emails than the org has left today of a daily limit is refused, as a rewind is.
- It is offered for the last rewind of an org, for 15 days after it, until it is undone: what the rewind deleted comes back while the recycle bin holds it, less long if the bin fills. Deleting the checkpoint, or its expiry, deletes the undo with it.
- A stopped undo is offered again, and takes up what it left. Once an undo has gone through, the checkpoint's next rewind starts a journal of its own.
- What Undo cannot bring back: the records a rewind deleted in an object Salesforce undeletes only with its parent, when that parent stayed, and those it deleted before a record they point at, which it deleted next -- the rewind needed both accepted, and its result says each with its reason -- the records the recycle bin no longer holds when Undo runs, and a record Salesforce keeps in it for good, said as such rather than in the org's words, which say it is not there. A record the org answers is not in the recycle bin because it came back with a record it hangs from, brought back after it, is counted back, never refused.

## What a rewind leaves as it is

- **Metadata.** Fields, flows, validation rules, layouts, record types and permissions are not rewound. Compare Org covers metadata.
- **Users and setup.** Users, profiles, permission set assignments, groups, queues, custom settings and custom metadata are out of scope. A user created since stays: Salesforce does not delete users.
- **What has left the org.** Emails, text messages, notifications, outbound messages, callouts, platform events and data other systems pulled stay sent. What a rewind's or an undo's writes would send is counted first, per daily limit, and an act past what the org has left today is refused: a Developer Edition sends 15 single emails a day, its email alerts among them. What an Apex trigger sends is not read.
- **The audit trail.** Field history, the Setup Audit Trail, login history, Chatter posts and tracked changes, the created and last modified dates and the auto-number counters keep the trace of the session and of the rewind: the last modified dates show the rewind, and new records never reuse the numbers of deleted ones.
- **Files.** File contents, file versions and attachments are not covered: files added since stay, and the result names those attached to the records it deleted.
- **Approvals and queued automation.** Approval history, and automation scheduled or paused during the session, are not rewound.
- **Records outside the checkpoint's objects** are never compared, except those the rewind's deletes take along, which the preview counts first.
- **Atomicity.** A rewind is not a transaction and does not freeze the org: it converges, then verifies.
- **Records the recycle bin no longer holds, or keeps for good.** They are named, gone for good, and not recreated: their original Ids cannot come back.
- **Conversions and activations.** A lead converted since stays converted, and a contract activated since stays activated: Salesforce takes back neither. The preview counts a lead converted since and a contract activated since among what a rewind cannot undo, and the result names each kept, never given back.
- **Production orgs, and any org other than the checkpoint's own**, such as a sandbox refreshed since.
- **Unsupported object kinds**: big objects, external objects, Knowledge article versions, Data Cloud objects and platform events.
- **Backup or compliance archiving.** Checkpoints live on one machine, expire, and are readable by their owner alone.
- **Deletions Undo cannot bring back**, said in the preview and accepted first.

## Where checkpoints are kept

- **One store for the panel and the command line**: `~/.sandforge/checkpoints/`, or `checkpoints/` in the folder `SANDFORGE_JOURNAL_DIR` names. A checkpoint taken in the editor is rewound from the command line, and the other way round. Each org has a folder per Organization Id, so a refreshed sandbox starts a new one, and each checkpoint a folder of its own: its values, an index of them, the ids that were in the recycle bin when it was taken, the reads of its previews and the journals of its rewinds.
- **Readable by you alone**: every folder is made readable by its owner only, and every file likewise, on macOS and Linux; a store another user of the machine owns is refused, since that user could read the snapshots and replace them before a rewind writes them back. On Windows, it sits in your user profile, which other users of the computer cannot read by default.
- **For how long**: a checkpoint is kept 30 days unless kept until you delete it, the date written into it, so the panel and the command line delete it on the same day. It can be rewound to for as long as it is kept: only the records deleted since depend on the recycle bin, which keeps them 15 days, less long if it fills. Expired checkpoints, and the journals of rewinds that can no longer be undone, are deleted as the first SandForge view of a window opens and as any command of `sandforge-checkpoint` starts, each named. A preview's reads are kept a day.
- **One lock per org**: a take, a rewind or an undo of an org holds a lock in `~/.sandforge/locks/`, whatever store is used, and another take, rewind or undo of it is refused until it has ended; a lock whose process is gone is taken over. In the panel, a run of the window writing to the org -- a Forge clone, a Frozen load or its removal, a DataOps restore, masking run or erasure, an Autopilot run, a Real-Time session that applies what it receives -- and a Sync or Seed run -- a CSV import and a clone from another org among them -- still writing to the org on this machine, refuse a take, a rewind and an undo too. A run of those of another window, a run on another machine, or of another user of this one, is not seen.
- **When an org goes**: disconnecting an org offers to delete its checkpoints with its backups, and a detected sandbox refresh lists its checkpoints as of the org before the refresh, which can only be deleted.

## What it costs

A take, a rewind and an undo each say before they start about how many API requests they send, and are refused when that is more than the org has left today; a preview says what its rewind would send. Up to five queries go in one call, which the org counts as one request. The take counts what it sent, phase by phase, beside what it estimated. Measured on a scratch org of about 200 objects holding 64 records: a take sent about 160 requests and lasted about 70 seconds, and took 0.84 MB on disk, most of it the index and the field prints of the empty objects; a preview sent about 80 requests in under a minute. A Developer Edition org has 15,000 API requests a day.

On disk, the take says what it will take before it runs. A rewind's journal holds the values it wrote over, for as long as it can be undone.

## From the command line

`sandforge-checkpoint` takes, lists, previews, rewinds, undoes and deletes checkpoints without the editor, over the same store, from a checkout of this repository (`pnpm install` and `pnpm build:shared` first):

| Command   | What it does                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `take`    | Reads the org's records and keeps them as a checkpoint: every object people work in, or the ones `--object` names; `--estimate` says the records, API requests, time and disk it would take, and stops          |
| `list`    | Names the checkpoints kept, newest first, with what a rewind and an undo can still reach; without `--org`, every org of the store. It never contacts the org                                                    |
| `preview` | Says what a rewind would delete, give back and bring back, who last changed it, and what it and an undo cannot take back; writes nothing. `--fail-on-change` exits `3` when the org differs from the checkpoint |
| `rewind`  | Shows the preview, asks you to type the org's alias, then rewinds from that preview as it read the org; `--dry-run` stops after the preview                                                                     |
| `undo`    | Takes back the org's last rewind; without `--checkpoint`, the rewind of the checkpoint the last rewind went back to                                                                                             |
| `delete`  | Deletes a checkpoint, or with `--all` every checkpoint of the org, from this machine, after asking; the org is not touched, and never contacted                                                                 |

- **Which checkpoint**: `--checkpoint` takes an id, a name or `latest`, the default. `rewind --yes` and `undo --yes`, which do not ask, need it named by its id or its name: `latest` could be a checkpoint taken since by someone else. A name two checkpoints share is refused, exit `2`, with their ids.
- **The acceptances**: `--accept-automation` for automation that runs as records are updated, deleted or brought back, `--accept-no-undo` for deletions Undo could not bring back, `--accept-outside` for the records outside a checkpoint of picked objects. Without the first two, such a rewind writes nothing, exit `1`; without the third, the records they hang from stay.
- **Fields not to compare**: `take --ignore-field Case.Last_Touched__c`, or `rewind --ignore-field …` once, kept in the checkpoint from then on: a field your automation sets on every save otherwise keeps every rewind partial.
- **What its write check sees**: the org's lock alone. A take, a rewind or an undo of the org under way on this machine, in the editor or in another command line, refuses a take, a rewind and an undo; the runs the panel sees writing to the org are not seen here. What any other run changes after the preview read the org is left as it made it, and said.
- **No terminal**: a rewind, an undo or a delete without `--yes` in a CI step stops at its question, exit `2`, having written nothing.
- **Stopping**: Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once, and leaves a checkpoint listed as never taken, which `delete` removes. Ctrl-C, SIGTERM or SIGHUP stops a rewind or an undo before its next call to the org, exit `130`, `143` or `129`, and leaves its journal: `rewind` again takes up from what still differs, and `undo` still returns the org to how it was before the rewind.

Exit codes: `0` done; `1` refused before it read or wrote, or nothing done; `2` a bad command line, a `--checkpoint` name several checkpoints have, `rewind` or `undo` with `--yes` and no checkpoint named, or a question with no terminal; `3` partial -- records still differ, each said with why; with `--fail-on-change`, the org differs; a `delete` kept some checkpoints, each said with why -- and fields set aside with `--ignore-field` do not count; `4` unstable, someone else changed records during the rewind or the undo. With `--json`, the answer goes alone on stdout and every other line on stderr; [Every flag](#every-flag) gives its shape for each command.

### A pool of scratch orgs, rewound between suites

Rewinding a scratch org between two test suites -- UI or end-to-end tests, UAT, integrations, not Apex tests, which roll back on their own -- returns it to its seeded state without creating another, and so without spending the Dev Hub's daily scratch-org allocation:

```yaml
env:
  SANDFORGE_JOURNAL_DIR: sandforge-journal # in the workspace, in a cache only this pipeline reads
steps:
  # once per org of the pool
  - run: sf org create scratch --definition-file config/project-scratch-def.json --alias pool-1
  - run: pnpm exec tsx packages/extension/cli/sandforge-seed.ts --target pool-1 --template <id> --json
  - run: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts take --org pool-1 --name baseline --keep-days 0 --json
  # between two suites
  - run: npx playwright test
  - run: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts preview --org pool-1 --checkpoint baseline --json > drift.json
  - run: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts rewind --org pool-1 --checkpoint baseline --yes --accept-automation --accept-no-undo --json
```

- Exit `3` marks the org dirty: do not give it back to the pool. Exit `4` means something still writes to it, an integration say.
- One org per suite running at the same time: a rewind takes back a neighbouring suite's work with the rest.
- The checkpoint holds data in clear: keep `sandforge-journal/` in a cache only the pipeline reads, never in a public artifact. Its journals expire with the recycle bin, and Undo is never needed in CI.

### Every flag

What `pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts --help` prints:

```text
sandforge-checkpoint — take a checkpoint of an org's data, and rewind the org to it, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts <command> --org <alias> [options]

Commands:
  take      read the org's records and keep them as a checkpoint on this machine
  list      name the checkpoints kept, newest first, with what a rewind and an undo can still reach
  preview   say what a rewind would delete, give back and bring back, who last changed it, and what
            it and an undo cannot take back; writes nothing
  rewind    return the org to a checkpoint: bring back from the recycle bin the records deleted
            since, give the records changed since their values back, delete the records created
            since — whoever made the changes; keep what it changes so it can be undone; then read
            the org again
  undo      take back the org's last rewind: bring back what it deleted, give back what it wrote
            over, send back to the bin what it brought back; what anyone changed since the rewind
            stays, and is said
  delete    delete a checkpoint from this machine; the org is not touched

Required:
  --org <alias>                  sf CLI alias of the org (list: every org of the store without it)

take:
  --name <text>                  what it is called (default: the date and time)
  --object <ApiName>             an object to keep; repeat for more (default: every object people
                                 work in, empty ones included, setup and log objects left out)
  --exclude-object <ApiName>     leave an object out; repeat for more
  --ignore-field <Object.Field>  do not compare a field, nor write it back (one your automation sets
                                 on every save); repeat for more
  --max-total <n>                refuse, before reading, more than <n> records (default: 500000)
  --keep-days <n>                when it expires (default: 30; 0 keeps it until deleted)
  --estimate                     say the records, API requests, time and disk it would take, then stop
preview, rewind, undo, delete:
  --checkpoint <id|name|latest>  which one (default: latest, for undo the one the last rewind went
                                 back to; rewind and undo with --yes need it named, by id or name)
preview:
  --fail-on-change               exit 3 when the org differs from the checkpoint
rewind:
  --dry-run                      the preview, then stop
  --accept-automation            rewind even when the org runs flows, Apex triggers, processes or
                                 workflow rules as records are updated, deleted or brought back;
                                 without it such a rewind writes nothing, exit 1
  --accept-no-undo               rewind even when undo could not bring back some records it deletes
                                 (objects Salesforce undeletes only with their parent, such as
                                 OpportunityLineItem); without it such a rewind writes nothing, exit 1
  --accept-outside               (a checkpoint of picked objects) also delete the records outside it
                                 created under records it deletes; without it those parents stay
  --ignore-field <Object.Field>  stop comparing a field from now on; kept in the checkpoint
  --yes                          do not ask before writing; without it and with no terminal — a CI
                                 step — it stops at its question, exit 2, having written nothing
undo:
  --accept-automation            as for rewind
  --yes                          as for rewind
delete:
  --all                          every checkpoint of the org
  --yes                          do not ask
Options:
  --store <dir>                  where checkpoints live (default: ~/.sandforge/checkpoints, or
                                 checkpoints/ in the folder SANDFORGE_JOURNAL_DIR names)
  --json                         the answer alone on stdout, every other line on stderr
  --help                         this text

A production org is refused before anything is read or written, exit 1. No flag lifts it.
The user the alias connects as needs View All Data and Modify All Data.
A checkpoint holds the records' values as the org held them, personal data among them, in clear,
in files only you can read (on Windows: in your user profile). Expired checkpoints are deleted as
any command starts, each named.
list and delete read this machine alone and never contact the org. An org's checkpoints are the
ones taken under its alias or username, and the others kept of the same Organization Id.
rewind shows its preview and asks you to type the org's alias before it writes, then rewinds from
that preview as it read the org: a record someone changes after it read is left as they made it,
and said. A take, a rewind or an undo of the org under way on this machine, in the editor or in
another command line, refuses a rewind and an undo; other runs writing to the org are not seen
here, and what one of them changes after the preview read the org is left and said the same way.
Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once,
and leaves a checkpoint listed as never taken, which delete removes. Ctrl-C stops a rewind or an
undo before its next call to the org, and leaves its journal: rewind again takes up from what still
differs, and undo still returns the org to how it was before the rewind.

What a rewind cannot undo: a record deleted since and no longer in the recycle bin, a lead
converted since, a contract activated since, a record deleted with one created since (preview
counts them); a field added or removed since (preview names it); the values the org computes or
keeps itself (formulas, roll-ups, auto-numbers, created and modified dates); what left the org
(emails, callouts, outbound messages, platform events); metadata; files. A record the org refuses
to put back is named by rewind, with its words.

JSON (--json), one value on stdout:
  list               [{id, name, org, organizationId, takenAt, records, bytes, expiresAt,
                       expiresSoon, binReachSince, lastRewind?, valid, why?, refreshedAt?}]
                     (name, org, takenAt, records and bytes are null for a damaged checkpoint;
                     expiresAt is null for one kept until deleted)
  take               {checkpoint, requests?, estimate}: the checkpoint as kept (its
                     checkpoint.json); requests, {total, byPhase}, the API requests the take sent
                     the org, SOAP calls among them; estimate, what it said before reading a record
  take --estimate    {mode, objects, leftOut, estimate, refusal?}: estimate.requestsByPhase splits
                     the requests over a take's phases as requests.byPhase does: guard, scope,
                     start, counts, bin, snapshot, stability
  preview            {checkpoint: {id, name, takenAt, org}, toDelete, toGiveBack, toBringBack,
                      differs, diff, estimate, automation?, emails?, refusal?}: diff, estimate,
                     automation and refusal as the extension answers them; refusal is the one a
                     rewind would meet now; emails, one per daily limit its writes send against:
                     {limit, emails, verdict, remaining?, max?, alertsCounted?, objects:
                     [{objectApiName, write, records, perRecord, sentBy}]}
  rewind --dry-run   as preview
  rewind             {checkpoint: {id, name, takenAt, org}, rewindId, status, deleted, givenBack,
                      broughtBack (each {planned, done, left}), cannotUndo: [{object, reason,
                      count}], undo?: {until, cannot: [{object, count, reason?}]}, verify:
                      {differences, stable, passes, notCompared}, residual: [{object, reason,
                      by?, count, message?}], unread: [{object, reason}], objects: [{object,
                      deleted, givenBack, broughtBack, refused}], apiRequests: {used,
                      leftToday}, result}:
                     status success, partial, unstable, failure or cancelled; result as the
                     extension answers it; undo.cannot's reason deletedBeforeParent: deleted
                     before a record they point at, which the rewind deleted next
  undo               as rewind, without cannotUndo and undo
  delete             {deleted: [id], kept: [id]}
  refused or failed  {refusal: {code, message}}
  A bad command line (exit 2) prints nothing on stdout.

Exit codes: 0 done (take: every record of its objects is kept; rewind and undo: read again, the
org matches among the objects and fields compared; preview, rewind --dry-run and list answered;
delete: every checkpoint named is deleted); 1 refused before it read or wrote (a production org,
missing permissions, automation without --accept-automation, deletions undo could not bring back
without --accept-no-undo, more than --max-total records, more API requests or emails than the org
has left today, a checkpoint of the org before a refresh or of an expired scratch org, a SandForge
run writing to it), or nothing done; 2 a bad command line, a --checkpoint name several checkpoints
have, rewind or undo with --yes and no checkpoint named, or a question with no terminal (give
--yes); 3 partial (rewind and undo: records still differ, each said with why; with
--fail-on-change, the org differs: records to delete, give back or bring back, records the rewind
cannot take back or the checkpoint does not hold although they are dated before it, an object that
could not be read; delete: some were kept, each said with why); 4 unstable (someone else changed
records during the rewind or the undo: left as they made them); 130, 143, 129 Ctrl-C, SIGTERM or
SIGHUP stopped it — run rewind again: it takes up from what still differs, and undo still reaches
the state before it.
```
