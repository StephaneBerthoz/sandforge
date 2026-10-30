# Checkpoint & Rewind

Keep the state of an org's data at a moment on this machine, and return the org to it later. Take a checkpoint before a test session, a demo or a training; afterwards, Rewind puts the data of the org back as it was at the checkpoint, whoever changed it since -- you, your testers, flows or integrations. Records created since are deleted, records changed since get their checkpoint values back field by field, and records deleted since come back from the recycle bin with their original Ids -- or, once the bin no longer holds them and you accept it, are made again from the checkpoint with new Ids. Before it writes anything, Rewind shows what it will change, who last changed it, what the org runs in answer and what it cannot take back; it keeps what it changes, so a rewind can be undone; and once through, it reads the org again and names what still differs, with why.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.checkpoint in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick a sandbox, scratch org or Developer Edition in the org list at the top.
2. Click Take a checkpoint, read Before it runs, click Take the checkpoint, then Done.
3. To return the org to it, click Rewind… on the checkpoint's row: the preview writes nothing.
4. Tick any box the preview asks for, then click the Rewind button that names the org.
5. Type the name the dialog shows, then click Confirm.

**Tip:** Rewind undoes everyone's changes since the checkpoint, not only yours. Undo this rewind takes it back for up to 15 days.

<!-- how-to:end -->

A DataOps backup is a copy of some objects: its Restore writes the copy back and brings back deleted records, and never deletes what was added. A checkpoint is the state of an org's data at a moment: its Rewind deletes what was added, gives back what changed and brings back what was deleted, whoever did it -- with View All Data and Modify All Data; with View All and Modify All per object, a record another user deleted is named and left in the recycle bin, as only those two permissions restore it.

Before you start, know four things:

- **It undoes everyone's work since the checkpoint**, not only SandForge's runs: every record created, changed or deleted since, in the objects the checkpoint holds, by any user, flow or integration. The preview says who last changed what before anything is written.
- **Never on a production org.** A checkpoint is taken of, and a rewind writes to, a sandbox, a scratch org or a Developer Edition org only; the edition is read from the org itself as well as from SandForge's list of orgs, an edition it cannot tell counts as production, and no setting or flag lifts the refusal. The user SandForge connects as needs **View All Data and Modify All Data** to import, and for a rewind to put back what anyone changed, whoever it was: without them, a record the user cannot see would read as deleted. A take without them holds only the objects SandForge can prove the user sees and puts back whole, with **View All and Modify All per object** -- on the object, or, for an object with no permissions of its own such as a case's comments, on every record it hangs from -- and leaves out each other object, named with why: tasks and events, products and price books, files and custom settings always. An object picked by name that is not proven refuses the take. A preview, a rewind and an undo by such a user read those permissions again, whoever took the checkpoint: an object no longer held is not read, and is left as it is; what another user deleted since stays in the recycle bin, named, as Salesforce brings back someone else's deletion for a user with Modify All Data alone; a rewind whose deletions take along records of objects the user is not proven to see -- a private task under an account created since -- is refused until that is accepted; and an undo takes back the user's own rewind alone. A checkpoint that keeps custom settings asks for **Customize Application** too, at the take, the preview, the rewind and the undo: View All Custom Settings lets a user read them, never write them.
- **It rewinds data, not configuration.** Metadata, users, setup, the content of files and what already left the org are out of its reach; the files attached to the records it holds are rewound with them, their content aside: [What a rewind leaves as it is](#what-a-rewind-leaves-as-it-is) lists what it leaves.
- **A checkpoint holds the records' values unencrypted**, personal data among them, on this machine, readable by you alone, for 30 days unless you keep it: [Where checkpoints are kept](#where-checkpoints-are-kept).

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

The moment worth keeping is often right after filling an org. The results of a Seed run (a template, the wizard, a CSV import or a clone from another org), of a Forge clone and of a Frozen load that wrote to a sandbox, a scratch org or a Developer Edition offer **Take a checkpoint now**, which opens this take on that org, ready: the org as the run left it becomes the point to come back to before your testers start. The run itself is taken back from its own results; the checkpoint takes back what everyone does next. It is not offered for a production org, nor after a run that wrote nothing, a simulation included.

- **The name**: the date and time unless you write one, or one of the three names offered. A name is one line of 120 characters at most. **Keep until I delete it** keeps the checkpoint past its 30 days; **Clean baseline** ticks it for you.
- **What it keeps**:
  - **Everything people work in**, the default: every object of the org the user may query, create, edit and delete, empty ones included, so that what is created there later is caught too. **See the objects** lists them, how many hold records and how many are empty, and the objects of each managed package, by package: they are included, since an industry package's records are data like accounts.
  - **Only the objects I pick**: the objects you tick, filtered by name.
  - **Left out**, each with why, in the list of the objects left out under the scope. These rules hold for an object picked by name too, a page layout aside: a feed picked is still a feed.
    - Setup and configuration: users, permissions and the rest of setup; custom settings, which are configuration, unless you pick them (below); metadata, which is deployed rather than kept as data; and, in **Everything people work in**, the setup the org keeps as records (permissions, OAuth scopes, license assignments), told by its having no page layout, but for the few related-list objects people work in without one, such as account contact roles and case team members.
    - Chatter and the org's own bookkeeping: Chatter posts, comments and their attachments; history, sharing and change-event objects.
    - Kinds a rewind cannot handle: big objects, external objects, Data Cloud objects, Knowledge article versions and platform events.
    - Files: the documents of the Documents tab, shared content kept in folders, as setup is; and a file's versions and links, listed there as held with their file, which the checkpoint holds as it holds attachments.
    - What the user or the org does not allow: an object the user may not query, create, edit and delete; an object the org would not describe; an object the org will not read without a filter, which never fails the take.
    - What it could not keep track of: an object with no `SystemModstamp`, whose changes nothing could tell; an object without a recycle bin, whose deleted records nothing could tell nor bring back.
    - Too large: an object holding more records than the take's limit, left out whole rather than kept in part.
    - What you name: an object picked that the org does not have, a custom setting picked that the org does not have, and an object the command line's `--exclude-object` names.
    - What the user's permissions do not prove, for a user without View All Data and Modify All Data: each object the user does not have View All and Modify All on, nor on every record it hangs from, and tasks and events, products and price books, files and custom settings always, listed apart from the rest, each with why. With **Only the objects I pick**, such an object typed in the filter is named under the objects to pick, with why it can't be picked, rather than missing from the list.
  - **Custom settings (N)**, folded under the scope, none ticked, and not shown for an org that has none: the org's custom settings, each with its kind -- **Hierarchy**, a row for the org's default and one per profile or user, or **List**, rows known by their names -- and its rows, with **Select all**. The ones you tick are kept in either mode, as the command line's `--custom-setting <ApiName|all>` keeps them; a custom setting ticked among **Only the objects I pick** without being ticked here is still left out. Configuration a rewind sets back as the checkpoint holds it, whoever changed it since -- an integration's endpoint, a switch an admin flipped -- is kept only when you ask: once one is ticked, the sentence of what is always left out no longer names custom settings. Keeping them needs Customize Application, and a user without it is refused before anything is read. A user without View All Data and Modify All Data is told under the list, before any is ticked, that one ticked refuses the take; ticked all the same, the refusal names it before **Take the checkpoint**. A custom setting a managed package protects is not seen, and custom metadata types are metadata, never kept.
- **Before it runs**, computed before the button is enabled: about how long the take lasts, how many API requests it sends of the ones the org has left today, how much it takes on this machine and until when it is kept; that it holds the records' values unencrypted, readable by you alone; to ask people to stop working in the org while it is taken; the objects whose deleted records come back only with their parent record (OpportunityLineItem, PricebookEntry, CampaignMember and the like); the fields the checkpoint cannot hold -- a field hidden from the user by field-level security, a classic encrypted field the user cannot view decrypted -- which Rewind will not touch; and, for a user without View All Data and Modify All Data, that the checkpoint holds only the objects the user has View All and Modify All on, per object, and that a rewind by that user leaves what another user deleted since in the recycle bin.
- **Refused before a record is read**, each with its reason: a production org; a user without View All Data and Modify All Data who has View All and Modify All on none of the objects, or on an object picked by name, or, for a checkpoint that keeps custom settings, without Customize Application; another take, a rewind or an undo of the org, or a SandForge run writing to it; more records than the take's limit (500,000 unless the command line names another); more API requests than the org has left today.
- **The take**: its moment is the moment it starts, read on the org's clock. It reads the objects children first, each record as it was when its object was read, and shows its progress, also in Monitor's Live Operations, with **Stop**. A stopped take keeps nothing. Once through, it says how many records it holds in how many objects and how much it takes on disk, and warns when records changed while it was being taken: a rewind treats them as changed since. Take checkpoints when nobody is working in the org.
- **What it holds of each record**: the fields the user may create or edit, with its created and last modified dates and who set them, which are never written back; never a formula or a roll-up. Tasks and Events are read with the archived ones the platform hides from an ordinary query, so an activity archived since never reads as deleted. A person account's contact is never deleted, brought back nor given back on its own, as Salesforce allows none of it: its account alone is, compared whenever the contact moved.
- **What it holds of files**: the files attached to the records it holds -- Salesforce Files, enhanced notes among them, and classic attachments -- with the records each is attached to, how it is shared from each, its title, description, owner and sharing settings, and its latest version and size; never a file's content, nor its versions. A file attached to no record it holds -- a user's own, a library's -- is never acted on: a rewind counts it and leaves it. With **Only the objects I pick**, the objects of files (`ContentDocument`, `Attachment`) are added to the objects picked, unless the command line's `--exclude-object` names them, and **Before it runs** says so: without them, a rewind would leave the files attached since. A user without **Query All Files** sees another user's file only through a record it is attached to, or by its Id: the files of other users that no record of the checkpoint is attached to, in a library the user is not a member of say, are not seen, and **Before it runs** says so. The take does not ask for Query All Files, which few admins hold. Once through, it says how many files are attached to its records, by how many links.

## The list

The page lists the checkpoints of the org it shows, newest first, read from this machine: it never contacts the org. Each row says when it was taken, how many records it holds and until when it is kept, with **Rewind…**, **Keep until I delete it**, **Rename**, **Stop comparing fields…** and **Delete**. Its lines say, where they apply:

- Taken with View All and Modify All per object, for a checkpoint whose user had no View All Data and Modify All Data: it holds only the objects that user saw whole.
- Expires in 2 days, three days before its date, with **Keep**. Unticking **Keep until I delete it** gives a checkpoint 30 days from then.
- The date before which deleted records can no longer come back with their Id, once the checkpoint is more than 15 days old: the recycle bin keeps them 15 days, less if it fills, and a rewind makes them again, with new Ids, once you accept it. The rest of a rewind is not bound to that date: it works for as long as the checkpoint is kept.
- Rewound on a date, and until when it can be undone, on the checkpoint of the org's last rewind, with **Undo this rewind**.
- Why it can only be deleted, for a checkpoint of the org before a sandbox refresh -- a refreshed sandbox is another org, with another Organization Id -- for one of a scratch org that has expired, one whose take failed or never ended, and one whose file cannot be read.

**Delete** asks first: it deletes the checkpoint from this machine, the org can no longer be rewound to it, and, when its rewind can still be undone, that rewind can no longer be. The org is not touched. Home shows the selected org's last checkpoint, with **Rewind…**, or offers to take one before the next test session, and a checkpoint that expires within three days, with **Keep**; nothing for a production org.

## The preview

**Rewind…**, on a row or on Home, reads what changed in the org since the checkpoint, and writes nothing.

- **Three numbers**: **to delete**, the records added since -- created since, or brought back from the recycle bin since, which go back to it -- with what comes back with a parent and goes again; **to give back**, the records changed since; **to bring back**, the records deleted since. When the recycle bin no longer gives some back, a fourth: **to make again**, which come back with new Ids.
- **Last changed by**, with how many records each person last changed, and **People working in the org in the last hour**. When the user SandForge connects as is among them, it says that testers who sign in as that user cannot be told apart from the rewind: ask them to stop first.
- **What a rewind does, object by object**: Delete, Give back, Bring back, Make again when it makes any, and Cannot undo per object, then the details: the field values to give back; the lookups a deletion since cleared, which are given back; the records deleted while the checkpoint was taken, which come back with the values they had then; the records that come back with their parent record; the records the checkpoint does not hold that took records of it along when they were deleted since, which come back for a moment to bring those back, then go back to the recycle bin with what came back with them; the records touched since that hold their checkpoint values, with nothing to give back; and the records the checkpoint does not hold although they are dated before it, a load with back-dated creation dates say, which are left as they are -- a rewind deletes nothing it cannot prove was created since. Last, the objects nothing changed in, whose fields the preview did not check for changes: no record of them was created, changed, deleted or brought back since, so a rewind writes nothing there. An object that could not be read is named, and a rewind leaves it as it is: it is never taken for unchanged.
- **What a rewind cannot undo**: the records deleted since that the recycle bin no longer holds, or keeps for good, and that the rewind cannot make again either -- a file, whose body the checkpoint does not hold, and a record deleted while the checkpoint was taken, whose values it does not hold; the files given a new version since, which keep it: Salesforce deletes no version and won't make an older one the latest again, so the content each had is still in its version history, and its title is given back; the leads converted since, which Salesforce cannot unconvert, left converted and never given back; the contracts activated since, which Salesforce will not set back to Draft, left activated and never given back; the records deleted since with a record created since that Salesforce does not undelete on its own, which their delete took along: Salesforce brings them back with that record only; the records deleted since with their parent, a record of an object the checkpoint does not hold: Salesforce brings them back with that parent only, and a checkpoint that holds its object brings them back; read by a user without View All Data and Modify All Data, the records another user deleted since, left in the recycle bin and never made again, as Salesforce brings back someone else's deletion for a user with Modify All Data alone, and the records of an object held through what it hangs from that are neither in the org nor in what the recycle bin shows the user, out of reach, never made again: what others deleted of it may be there out of sight; of an object something changed in since -- the preview checks the fields of those alone, and of an object that lost records it makes again -- the fields deleted since, to restore from Deleted Fields within 15 days before rewinding again; the fields field-level security hides from the user since, which the describe and every query leave out as they do a deleted field, View All Data and Modify All Data notwithstanding: give the user read and edit access, then rewind again -- a standard field, which no one deletes, is always said hidden, and of a custom field the Tooling API's `FieldDefinition` tells, which still lists a hidden field and no longer a deleted one; one whose read of it the org refuses is said as either, with both remedies; none of them is read, compared or written; the fields added since, whose values stay; the fields whose type changed, tried field by field; the values the org computes or keeps itself; what already left the org; metadata.
- **What Undo could not bring back**, each reason in its own sentence: the records this rewind deletes in an object Salesforce undeletes only with its parent record, when that parent stays -- a product added since to an opportunity that existed at the checkpoint; and the records it deletes before a record they point at, which the rewind deletes next: Salesforce cannot bring them back after that. A case created since under an account created since is one: the case's account lookup forbids deleting an account that still has cases, as a scratch org showed, so the rewind deletes the case first, alone, and Salesforce cannot bring it back once the account is deleted after it. So is a record made while the checkpoint was taken, or brought back since, under a record the rewind deletes. The rewind is refused unless **Rewind even though Undo could not bring these back** is ticked, and so is `--accept-no-undo` on the command line. A record created since under a record the rewind deletes too, through a relationship whose delete takes it along, is not sent on its own: it goes with its parent, and Undo brings it back with it. Deleted on its own first, it would stay in the recycle bin for good once its parent was deleted after it.
- **Made again, with new Ids**: the records deleted since that the recycle bin no longer gives back -- emptied from it, or kept there for good: one deleted on its own, then a record it hangs from or points at deleted after it, as a case then its account -- whose values the checkpoint holds. The rewind makes them again from the checkpoint, and every lookup the checkpoint holds that named one names its new Id. Anything outside Salesforce that names their old Ids -- an integration, a link, a report filter -- no longer finds them. The rewind is refused unless **Make them again, with new Ids** is ticked, and so is `--accept-recreate` on the command line. Salesforce still lists a record emptied from the recycle bin as deleted, for minutes to hours: on a scratch org, five records emptied from it were still read there half an hour later, and no longer a day later, and no read tells such a record from one still in the bin -- a read by its Id answers the same for both. The preview counts it to bring back, and only the undelete's answer, that it is not in the recycle bin, tells it. The checkpoint keeps that answer: a later preview counts the record to make again, or, a file, among what a rewind cannot undo, gone for good, and never asks it back. So whenever the rewind brings records back, the preview offers the same box, under **If the recycle bin no longer holds them**, and `--accept-recreate` on the command line: ticked, a record Salesforce answers is no longer in the bin is made again in the same rewind, with the records that were to come back with it, as if the preview had counted them; unticked, it is left and named. That box holds the rewind only for the records the preview counts to make again.
- **Also deleted with them, outside the checkpoint**: records of objects the checkpoint does not hold, created under records the rewind deletes, which their delete takes along. A checkpoint of everything people work in deletes them with the records they hang from; one of the objects you picked deletes them only when **Delete these too** is ticked, and otherwise keeps the records they hang from, named once the rewind is through. A file the rewind deletes that is attached outside the checkpoint too -- to a library, a group or a record of another object -- is said here as well, since deleting it removes it from there: unticked, in a checkpoint of the objects you picked, it stays, removed only from the checkpoint's records.
- **Also deleted with them, out of sight**, for a user without View All Data and Modify All Data: for each object of records to delete, the objects whose records their delete takes along that the user is not proven to see -- tasks and events always, which have no View All -- and that no read counts, a private task of another user under an account created since, say. The rewind is refused unless **Delete them all the same, with what \<user\> can't see under them** is ticked, as `--accept-unseen` accepts it on the command line, and its typed confirmation says it deletes those too, uncounted. Such a preview says first that it read each object with View All and Modify All on it, and that a rewind leaves what another user deleted since in the recycle bin; an object the user no longer holds whole is among the objects it could not read, named with the user, and the rewind leaves it as it is.
- **Files and their links**, for a checkpoint that holds files: the files themselves are in the table, as `ContentDocument` -- added since and attached to a record of the checkpoint, deleted; deleted since, brought back with their links; their title and sharing settings given back -- and under it what the rewind does to the links between its files and its records, compared by the file and the record each ties: a link added since between a file and a record that both stay is removed, and the file stays; one removed since is put back, under a new Id, as Salesforce keeps no removed link in the recycle bin; one whose sharing changed gets it back -- who sees the file from the record, and with what access -- but for the access of a link to an account, which Salesforce does not let change. A file added since that no record of the checkpoint links to -- a user's own, a library's -- is kept, and counted; one deleted since is left in the recycle bin. Then the file storage the files it brings back take again -- a file in the recycle bin takes none, and its undelete counts it again -- against what the org has left, and what Undo would take again of the files the rewind deletes. Without Query All Files, it says that other users' files no record of the checkpoint is attached to are not seen, nor counted.
- **Not compared (you chose)**: the fields **Stop comparing fields…** set aside, neither compared nor written back.
- **What the org runs as the rewind writes**: the flows, Apex triggers, processes and workflow rules that run as it brings records back, gives them their values back and deletes them, `after undelete` triggers included. When any runs, or the org would not say, the rewind is refused unless **Rewind even though \<org\> runs automation** is ticked. Under it, the emails they send, per daily limit -- single emails, workflow emails -- about how many and by what, against what the org has left of each today; a Developer Edition, which sends 15 single emails a day, counts its email alerts among them. What sends emails and could not be read -- a flow, process or rule whose definition the org refused or the read left past its bound, a flow a package installed, which the org lets no one read -- is named as not counted, even when nothing else sends, and the box covers it: a rewind is never refused for it, which would refuse every rewind of an org whose package runs a flow on an object the checkpoint holds.
- **The cost**: about how long the rewind takes, and how many API requests of the ones the org has left today. Then: before it writes, Rewind keeps what it changes, so you can undo it for 15 days, and what it deletes comes back with the undo while the recycle bin holds it: 15 days, less if it fills.

Three refusals no box lifts: a SandForge run writing to the org, more API requests than the org has left today, and more emails than it has left today of a daily limit -- past them, Salesforce refuses each record whose flow fails in the save, and the org's own emails stop for the rest of the day: turn off what sends them, or give the user a bypass that keeps it quiet; the preview says them, and **Rewind \<org\>…** stays off. So it does when the files a rewind brings back from the recycle bin would take more file storage than the org has left, both sizes said: free file storage, then rewind again. A checkpoint taken before SandForge 1.70 holds no files, and the panel's preview says so: a rewind to it leaves the files attached since as they are, as 1.69 did. When nothing differs, the preview reads that the org is as it was at the checkpoint among the objects and fields it holds: nothing to rewind.

## Rewinding

**Rewind \<org\>…** asks for the org's alias, typed, under what the rewind does: it deletes the records added since, gives the records changed since their values from then back, brings back the records deleted since from the recycle bin and puts the links between files and records back as they were, whoever made these changes. The rewind then reads the org again and acts on what you confirmed that still differs. What changed after the preview is left as it is and listed under **Changed since the preview**: rewind again to take it. A busy org never makes it loop, and it never does more than you confirmed.

It runs in this order, shown on the page with its progress and **Stop the rewind**, and in Live Operations, whose Cancel stops it too:

1. **Bring back** the records deleted since, parents first, with their Ids; the children a parent's delete took along come back with it. A record of the checkpoint that left with a record the checkpoint does not hold -- a contact moved since under an account created since, which was then deleted -- comes back with that record only, so that record comes back for a moment, the record of the checkpoint is given its values back, its own account among them, and the second pass deletes that record again with what came back with it; a record of the checkpoint whose values the org refuses goes back to the recycle bin with it, named in the org's words, rather than keep it in the org. Stopped between the two passes, that record stays in the org until **Rewind again** deletes it. One the recycle bin no longer holds brings nothing back: what it had taken along is named among what still differs. A record Salesforce answers is no longer in the recycle bin -- emptied from it, though it still lists it as deleted, or kept there for good -- is made again in the next step, with the children named as coming back with it, once **Make them again, with new Ids** was ticked; left and named otherwise. One the checkpoint holds no values of is gone for good.
2. **Make again** the records the recycle bin no longer gives back, parents first, 200 an insert, with the checkpoint's values of the fields the user may set on a new record, and new Ids. A record made again names the records made before it by their new Ids; a lookup to one made after it -- an account's parent account -- is filled in once both are made. Each insert's records are named in the rewind's journal before it goes, and by their new Ids once it answered; from then on the checkpoint knows them by their new Ids, so a later preview never takes them for records created since. A record the org refuses to make is named, in its words.
3. **Give back** the values of the records changed since, 2,000 records at a time, each chunk's current values read just before it is written. Only the fields the checkpoint compares, the org still has and the user may write are read and written, and only those that differ. A record whose update the org refuses for one field is sent again without that field, which keeps its value, and the result counts it. An order that was Draft at the checkpoint gets its status back first, alone.
4. **Delete** the records added since, children first, into the recycle bin; a record created since under one it deletes goes with it, never on its own. What a record deleted by the rewind held in place -- an opportunity's price book and amount, while it had products added since -- is given back once the deletes are through.
5. **Check**: the org is read again. When the first pass wrote anything, a second pass takes what it left, and what the user SandForge connects as or the org's Automated Process created or changed in answer: automation that set a field again on save, a record that came back with its parent and goes again.

A row of a custom setting comes back only once no live row holds its key: a hierarchy's owner -- the org's default, a profile, a user -- or a list's name. Salesforce refuses to bring back a hierarchy's row over another of the same owner, but brings a list's row back beside another of its name, and the list then holds two. So when a row made since holds the owner or the name of a row to bring back, the first pass deletes the row made since, or gives a row of the checkpoint its own name back, and the second brings the row back, with its Id, as the checkpoint holds it: a preview read then finds nothing to rewind. A row still held then stays in the recycle bin, **Kept on purpose**, beside the row that holds its key. A row made again with a new Id is not held back: Salesforce refuses an insert of a key taken, and the second pass makes it.

In a checkpoint that holds files, the files go with these steps as records of `ContentDocument`: brought back with their links, given their title and sharing settings back, and, added since, deleted 200 a call, never by a Bulk API job, their links with them. A link between a file and a record goes with them too: one removed since is put back once the file and the record it ties are both back -- one to a record made again names its new Id --, one whose sharing changed gets it back, and one added since is removed. The check reads the links again: what the platform did not bring back with a file or a record is put back, and named if it still differs. The page lists these links as a step of their own, before the deletes; the org runs what it runs on a link as it is removed or put back, and the preview lists it.

Leaving the page does not stop the rewind: it goes on in the extension, as Live Operations shows. A window closed while it runs stops it, and leaves its journal: the next rewind to the checkpoint takes it up. A record someone else changes after the rewind began is left as they made it, and named. Where testers sign in as the user SandForge connects as, common on a Developer Edition or a scratch org, their changes during the rewind cannot be told from the rewind's own, and are rewound with the rest.

**The result**:

- Done: the org is back at the checkpoint; read again, nothing differs among the objects and fields it holds.
- Partial: the org is back at the checkpoint except the records listed, grouped by why:
  - **Kept by your automation**: records your automation set again on save after the second pass, with **Stop comparing these fields…** for a field it sets on every save;
  - **Changed during the rewind by someone else**, by whom, left as they made them;
  - **Changed since the preview**: rewind again to take them;
  - **No longer in the recycle bin**: records Salesforce still lists as deleted but will not bring back -- emptied from the recycle bin, or kept there for good -- left because **Make them again, with new Ids** was not ticked: rewind again with it ticked to make them again, with new Ids;
  - **Refused by \<org\>**, in the org's words: what a validation rule added since refuses, say, or a field the org no longer takes as it was, which kept its value. No validation rule is bypassed: turn it off or fix the data, then rewind again;
  - **Gone for good**: records the preview counted to bring back that Salesforce answered are no longer in the recycle bin, and that could not be made again -- a file, or a record deleted while the checkpoint was taken. A record the preview already named gone for good is not counted here, and does not make a rewind partial: nothing the rewind does reaches it;
  - **Kept on purpose**: records the rewind had to keep, with why: a record created since that records of the checkpoint still depend on, say, the parent of records outside the checkpoint you did not accept to delete, a lead converted since, which Salesforce cannot unconvert, a contract activated since, which it will not set back to Draft, or a record deleted with one created since that Salesforce does not undelete on its own, or with its parent of an object the checkpoint does not hold, left in the recycle bin.
- Unstable: someone kept writing to the org during the rewind; who, and how many records, left as they made them. Rewind again once they have stopped.
- Stopped part way: the org is between the checkpoint and now. **Rewind again** takes up the same journal, reads the org again and finishes from what still differs; Undo still returns the org to how it was before the rewind.
- Ended before it was through: what it did is listed, and **Rewind again** takes up from what still differs.

Any result but done offers **Rewind again**, which reads the org afresh for a new preview, and a rewind that wrote anything offers **Undo this rewind**, saying until when. Under it, per object, what was brought back, made again with new Ids, given back and deleted, what was refused, the links between files and records it removed, put back and gave their sharing back, and those the org refused, and the API requests the rewind used of the ones left today. A file attached to a record the rewind deleted stays when the checkpoint holds it, or when it is attached to a record outside the checkpoint too, and is named; a link to an account whose access changed keeps it, **Kept on purpose**. Each rewind, and each undo, is recorded in Reports → Audit Trail.

## Undo

**Undo this rewind**, on the rewind's result and on the list's line of the org's last rewind, takes that rewind back from its journal: what it deleted comes back from the recycle bin, what it wrote over gets its values from before back, and what it brought back goes back to the recycle bin -- what came back with a record, a contact with its account or a product with its opportunity, goes with that record, never on its own, so that the record brought back later from the bin brings it back too. What it made again with new Ids goes to the recycle bin as well, said as deleted again, with what went with it, never as brought back: the checkpoint still knows it by its new Id, and a rewind after the undo brings it back from the bin rather than making it a third time. What the rewind brought back for a moment and deleted again stays in the recycle bin, with what went back there with it; a record of the checkpoint it had taken along goes back to the bin on its own, under the parent the checkpoint gave it, and comes back alone -- Salesforce refuses a lookup to a record in the bin -- and Undo says so. What anyone changed in the org since the rewind stays as it is, and is named.

- Files: a file the rewind deleted comes back from the recycle bin with its links, and one it brought back goes back there; a link it removed is put back, under a new Id -- a link holds no more than its two ends and its sharing, so none is lost --, one it put back is removed, and one it gave its sharing back gets the sharing from before. The files it brings back take file storage again: an undo that would take more than the org has left is refused before it writes, both sizes said.
- Custom settings: Undo sends back to the bin the rows the rewind brought back before it brings back the rows the rewind deleted and gives back those it wrote over, so a row comes back once the row that held its key -- a hierarchy's owner, a list's name -- is gone: no owner is left without its row, and a list never holds two rows of one name. A row the rewind brought back that someone changed since stays, named, and keeps its key: a hierarchy's row of that owner is then refused by Salesforce, and named, and a list's row of that name comes back beside it. The other objects keep their order, what the rewind deleted back first: a record it deleted on its own would otherwise stay in the recycle bin for good once the record it hangs from went back there after it.
- It asks for the org's alias, typed, and lists what it could not bring back. **Undo even though \<org\> runs automation as records are updated, deleted or brought back** is never ticked for you: without it, an org that runs automation as the undo writes refuses it, and says what runs, and what of it sends emails that were not counted, as an undo has no preview to say it. An undo whose writes would send more emails than the org has left today of a daily limit is refused, as a rewind is.
- It is offered for the last rewind of an org, for 15 days after it, until it is undone: what the rewind deleted comes back while the recycle bin holds it, less long if the bin fills. Deleting the checkpoint, or its expiry, deletes the undo with it.
- A stopped undo is offered again, and takes up what it left. Once an undo has gone through, the checkpoint's next rewind starts a journal of its own.
- What Undo cannot bring back: the records a rewind deleted in an object Salesforce undeletes only with its parent, when that parent stayed, and those it deleted before a record they point at, which it deleted next -- the rewind needed both accepted, and its result says each with its reason -- the records the recycle bin no longer holds when Undo runs, and a record Salesforce still lists as deleted but will not bring back, emptied from the bin or kept there for good, which Undo names in those words, with the org's own answer, that it is not in the recycle bin, quoted after them. A record the org answers is not in the recycle bin because it came back with a record it hangs from, brought back after it, is counted back, never refused.

## Rewound runs in the histories

A rewind takes back what Seed, Sync and Forge runs wrote since the checkpoint, and their histories say so on each run it took back: **Earlier seeds** on the Seed page, the History tab of Sync, in a word in the table and in full in the run's detail, and **Recent runs** and **Older runs** on the Forge page. CSV imports and clones from another org are seeds, and marked as seeds are; Frozen, Autopilot and DataOps runs are not marked.

- **Rewound on \<date\> to “\<checkpoint\>”**: the run wrote between the end of the take and the start of the rewind, and the rewind took back what it wrote. Its removal then finds what it created already gone -- in the recycle bin, counted as already gone -- and leaves what the rewind gave back its values, which the org dates after the run, as changed since.
- **Rewound in part**: the run wrote as the checkpoint was taken or as the rewind ran. What the take read of it, the checkpoint holds and the rewind kept; what it wrote after the rewind began reading, the rewind may not have read. The run's removal preview counts what is left of it.
- **A rewind to “\<checkpoint\>” stopped part way**: the rewind was stopped before it was through, and took back what it reached.
- The mark adds that **the rewind left some records** when it ended partial or unstable, that it was **undone** on a date, when an Undo brought the records back, and the objects the run wrote that the checkpoint did not hold: **Not rewound: \<objects\>, outside the checkpoint**. A run that wrote only objects the checkpoint did not hold carries no mark, and neither does a run that ended before the take began: the checkpoint holds its records.
- Of several rewinds of the org that cover a run, the mark names the oldest that went through and was not undone, which took the run's writes back: a later one found them gone.
- **Its records came back with the undo of \<date\>, after its removal**: the run's removal found what it created gone -- the rewind had deleted it -- and an Undo of that rewind brought it back since. The run said nothing was left to remove, and a removal was refused as made already, the records back in the org. Its history now offers **Remove again**: a removal of every record the run created, not only of what its removals left, each read before it is deleted as any removal reads them, and the Production Guard asked as for any removal. The Undo dated each record anew, as its user, so they read as changed since the run and stay unless you tick the confirmation's box for the records changed since; the confirmation says so before you type the org's name. A record the run's own removal had deleted is in the recycle bin, and counted as already gone. It is offered when the Undo ended after the run's last removal and the rewind ended before that removal, two minutes either side: a removal made before the rewind deleted the records itself, and the Undo of a rewind that found them gone brought none back. Once it ran, what it kept is what is left, offered as any removal's leftovers are.
- **Told by dates, never by records**: the mark compares the run's start and end with the checkpoint's take and the rewind's, two minutes either side of each -- a run that close to one reads as rewound in part -- and the dates of the rewind, on the org's clock, are put on your machine's by how far apart the two clocks were at the rewind's last reading of the org's. No record id is compared, so a rewind from the command line marks the panel's runs as one from the panel does; the exact count of a run's records a rewind took is its removal's preview to give.
- **Where it is kept**: each rewind that wrote, as it ends -- gone through, stopped part way or ended before it was through; one a failed call to the org cut short, once the next rewind of its checkpoint takes it up -- and each Undo that went through adds a line to `rewinds.ndjson`, in the org's folder of the store beside its checkpoints, readable by you alone: the checkpoint's name, times and objects, the rewind's times, how it ended and how many records it deleted, gave back, brought back and made again, never a record's id or value. It outlives the checkpoint and the journal, and keeps the last 200 rewinds and undos once it passes 400. A rewind or an Undo it could not be written for says so in a note of its result, and went through all the same; a line it cannot read is left out, and named in the log. A rewind made with another store -- a CI step's `SANDFORGE_JOURNAL_DIR`, another machine -- is not in this one, and marks nothing here.

## What a rewind leaves as it is

- **Metadata.** Fields, flows, validation rules, layouts, record types and permissions are not rewound. Compare Org covers metadata.
- **Users and setup.** Users, profiles, permission set assignments, groups, queues and custom metadata are out of scope, and custom settings unless the checkpoint keeps them. A user created since stays: Salesforce does not delete users. A custom setting's row for a user or a profile created since is deleted, as any row added since.
- **What has left the org.** Emails, text messages, notifications, outbound messages, callouts, platform events and data other systems pulled stay sent. What a rewind's or an undo's writes would send is counted first, per daily limit, and an act past what the org has left today is refused: a Developer Edition sends 15 single emails a day, its email alerts among them. What an Apex trigger sends is not read; what a flow, process or rule whose definition could not be read sends is not counted, and the preview, and a refusal of the automation, name it.
- **The audit trail.** Field history, the Setup Audit Trail, login history, Chatter posts and tracked changes, the created and last modified dates and the auto-number counters keep the trace of the session and of the rewind: the last modified dates show the rewind, and new records never reuse the numbers of deleted ones.
- **The content of files.** A checkpoint holds the files attached to its records, their links and classic attachments, never their content: a file given a new version since keeps it, the content it had staying in its version history, and the content of a classic attachment replaced since stays; an enhanced note edited since keeps its new text, a new version of its file. A file purged from the recycle bin cannot come back. A file attached to no record of the checkpoint -- a user's own, a library's -- is left, and counted. A post that shared a file keeps its text without the file once the file goes: Chatter is out of scope. A public link to a file may not come back with it. Without Query All Files, other users' files that no record of the checkpoint is attached to are not seen. A checkpoint taken before SandForge 1.70 holds no files: files added since stay, and the result names those attached to the records it deleted.
- **Documents of the Documents tab**, shared content kept in folders, as setup is: left out of every checkpoint.
- **Approvals and queued automation.** Approval history, and automation scheduled or paused during the session, are not rewound.
- **Records outside the checkpoint's objects** are never compared, except those the rewind's deletes take along, which the preview counts first.
- **Atomicity.** A rewind is not a transaction and does not freeze the org: it converges, then verifies.
- **The original Ids of records gone from the recycle bin.** A record the recycle bin no longer holds, or keeps for good, is made again with a new Id once that is accepted: its original Id cannot come back. A file is not made again, the checkpoint holding none of its body, nor a record deleted while the checkpoint was taken, whose values it does not hold: both are named, gone for good.
- **Conversions and activations.** A lead converted since stays converted, and a contract activated since stays activated: Salesforce takes back neither. The preview counts a lead converted since and a contract activated since among what a rewind cannot undo, and the result names each kept, never given back.
- **Production orgs, and any org other than the checkpoint's own**, such as a sandbox refreshed since.
- **Unsupported object kinds**: big objects, external objects, Knowledge article versions, Data Cloud objects and platform events.
- **Backup or compliance archiving.** Checkpoints live on one machine, expire, and are readable by their owner alone.
- **Deletions Undo cannot bring back**, said in the preview and accepted first.

## Where checkpoints are kept

- **One store for the panel and the command line**: `~/.sandforge/checkpoints/`, or `checkpoints/` in the folder `SANDFORGE_JOURNAL_DIR` names. A checkpoint taken in the editor is rewound from the command line, and the other way round. Each org has a folder per Organization Id, so a refreshed sandbox starts a new one, and each checkpoint a folder of its own: its values, an index of them, the ids that were in the recycle bin when it was taken, the reads of its previews and the journals of its rewinds.
- **Readable by you alone**: every folder is made readable by its owner only, and every file likewise, on macOS and Linux; a store another user of the machine owns is refused, since that user could read the snapshots and replace them before a rewind writes them back. On Windows, it sits in your user profile, which other users of the computer cannot read by default.
- **For how long**: a checkpoint is kept 30 days unless kept until you delete it, the date written into it, so the panel and the command line delete it on the same day. It can be rewound to for as long as it is kept: only the records deleted since depend on the recycle bin, which keeps them 15 days, less long if it fills. Expired checkpoints, with every journal of their rewinds, and the journal of an org's last rewind once it can no longer be undone, are deleted as the first SandForge view of a window opens and as any command of `sandforge-checkpoint` starts, each named. Undo reaches an org's last rewind alone: once a rewind of the org has ended, the journals of its earlier rewinds, which hold the values they wrote over, are deleted, each named in the log and in the command's output -- but for one stopped part way, which the next rewind of its checkpoint takes up. A preview's reads are kept a day.
- **One lock per org**: a take, a rewind or an undo of an org holds a lock in `~/.sandforge/locks/`, whatever store is used, and another take, rewind or undo of it is refused until it has ended; a lock whose process is gone is taken over. In the panel, a run of the window writing to the org -- a Forge clone, a Frozen load or its removal, a DataOps restore, masking run or erasure, an Autopilot run, a Real-Time session that applies what it receives -- and a Sync or Seed run -- a CSV import and a clone from another org among them -- still writing to the org on this machine, refuse a take, a rewind and an undo too. A run of those of another window, a run on another machine, or of another user of this one, is not seen.
- **When an org goes**: disconnecting an org offers to delete its checkpoints with its backups, and a detected sandbox refresh lists its checkpoints as of the org before the refresh, which can only be deleted.

## What it costs

A take, a rewind and an undo each say before they start about how many API requests they send, and are refused when that is more than the org has left today; a preview says what its rewind would send. Up to five queries go in one call, which the org counts as one request. Past 10,000 records of an object, a rewind's or an undo's deletes go through Bulk API jobs, each one request per call it sends -- opened, its records sent, closed, each read of its state, its results read -- and none per record: a job of 200 deletes cost five on a scratch org. The take counts what it sent, phase by phase, beside what it estimated. Measured on a scratch org of about 200 objects holding 64 records: a take sent about 160 requests and lasted about 70 seconds, and took 0.84 MB on disk before checkpoints were compressed, most of it the list of the objects kept and left out, and the field prints; a preview sent about 80 requests in under a minute. A Developer Edition org has 15,000 API requests a day.

On disk, the take says before it runs about what it will take: the file that lists every object it keeps and every one it leaves out, counted as it will be written, the field prints, measured on them, and about 300 bytes a record for its values and their index. On an org of a few hundred objects, most of them empty, that list is most of it. The values and the field prints are compressed as they are read, gzip files any `gzip -dc` reads, never written plain first: compressed is not encrypted, and they stay readable by you alone. A checkpoint taken by an earlier SandForge holds them plain and is read as it is, never converted; an earlier SandForge lists a checkpoint taken since, says its index is damaged and writes nothing. A rewind's journal holds the values it wrote over, plain, for as long as it can be undone.

## From the command line

`sandforge-checkpoint` takes, lists, previews, rewinds, undoes, deletes, exports and imports checkpoints without the editor, over the same store, from a checkout of this repository (`pnpm install` and `pnpm build:shared` first):

| Command   | What it does                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `take`    | Reads the org's records and keeps them as a checkpoint: every object people work in, or the ones `--object` names; `--estimate` says the records, API requests, time and disk it would take, and stops          |
| `list`    | Names the checkpoints kept, newest first, with what a rewind and an undo can still reach; without `--org`, every org of the store. It never contacts the org                                                    |
| `preview` | Says what a rewind would delete, give back and bring back, who last changed it, and what it and an undo cannot take back; writes nothing. `--fail-on-change` exits `3` when the org differs from the checkpoint |
| `rewind`  | Shows the preview, asks you to type the org's alias, then rewinds from that preview as it read the org; `--dry-run` stops after the preview                                                                     |
| `undo`    | Takes back the org's last rewind; without `--checkpoint`, the rewind of the checkpoint the last rewind went back to                                                                                             |
| `delete`  | Deletes a checkpoint, or with `--all` every checkpoint of the org, from this machine, after asking; the org is not touched, and never contacted                                                                 |
| `export`  | Writes a checkpoint to a `.sfcheckpoint` file, encrypted under a key shown once on stderr, or the one `--key-env` names, for a teammate who rewinds the same org; the org is not contacted                      |
| `import`  | Keeps a `.sfcheckpoint` file as a checkpoint of the org on this machine once the org answers that it is the file's and its user sees all data, the key typed without echo or read from `--key-env`              |

- **Which checkpoint**: `--checkpoint` takes an id, a name or `latest`, the default. `rewind --yes` and `undo --yes`, which do not ask, need it named by its id or its name: `latest` could be a checkpoint taken since by someone else. A name two checkpoints share is refused, exit `2`, with their ids.
- **The acceptances**: `--accept-automation` for automation that runs as records are updated, deleted or brought back, `--accept-no-undo` for deletions Undo could not bring back, `--accept-recreate` for the records the recycle bin no longer gives back, made again with new Ids, `--accept-outside` for the records outside a checkpoint of picked objects, `--accept-unseen`, for a user without View All Data and Modify All Data, for the records of objects the user is not proven to see that the records it deletes take along. Without `--accept-outside`, the records they hang from stay; without any other, such a rewind writes nothing, exit `1`.
- **Fields not to compare**: `take --ignore-field Case.Last_Touched__c`, or `rewind --ignore-field …` once, kept in the checkpoint from then on: a field your automation sets on every save otherwise keeps every rewind partial.
- **What its write check sees**: the org's lock alone. A take, a rewind or an undo of the org under way on this machine, in the editor or in another command line, refuses a take, a rewind and an undo; the runs the panel sees writing to the org are not seen here. What any other run changes after the preview read the org is left as it made it, and said.
- **No terminal**: a rewind, an undo or a delete without `--yes` in a CI step stops at its question, exit `2`, having written nothing.
- **Stopping**: Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once, and leaves a checkpoint listed as never taken, which `delete` removes. Ctrl-C, SIGTERM or SIGHUP stops a rewind or an undo before its next call to the org, exit `130`, `143` or `129`, and leaves its journal: `rewind` again takes up from what still differs, and `undo` still returns the org to how it was before the rewind.

Exit codes: `0` done; `1` refused before it read or wrote, or nothing done; `2` a bad command line, a `--checkpoint` name several checkpoints have, `rewind` or `undo` with `--yes` and no checkpoint named, or a question with no terminal; `3` partial -- records still differ, each said with why; with `--fail-on-change`, the org differs; a `delete` kept some checkpoints, each said with why -- and fields set aside with `--ignore-field` do not count; `4` unstable, someone else changed records during the rewind or the undo. With `--json`, the answer goes alone on stdout and every other line on stderr; [Every flag](#every-flag) gives its shape for each command.

An AI agent runs these commands as the tools of the MCP server of this repository -- `checkpoint_take`, `checkpoint_list`, `checkpoint_preview`, `checkpoint_rewind`, `checkpoint_undo` and `checkpoint_delete` -- each answering with this script's JSON, a rewind, an undo or a delete only with the org's alias given again as `confirm`: [SandForge for AI agents](../mcp.md).

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
- The checkpoint holds the records' values unencrypted: keep `sandforge-journal/` in a cache only the pipeline reads, never in a public artifact. `undo` works in a pipeline as anywhere, but is seldom needed there: the journal of the checkpoint's last rewind is deleted once that rewind can no longer be undone, 15 days after it.

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
            since, and put the files attached to its records back as they were — whoever made the
            changes; keep what it changes so it can be undone; then read the org again
  undo      take back the org's last rewind: bring back what it deleted, give back what it wrote
            over, send back to the bin what it brought back; what anyone changed since the rewind
            stays, and is said
  delete    delete a checkpoint from this machine; the org is not touched
  export    write a checkpoint to a .sfcheckpoint file, encrypted, for a teammate who rewinds the
            same org from another machine; the org is not contacted
  import    keep a .sfcheckpoint file a teammate exported as a checkpoint of the org on this
            machine, once the org answers that it is the file's, and its user sees all data

Required:
  --org <alias>                  sf CLI alias of the org (list: every org of the store without it)

take:
  --name <text>                  what it is called (default: the date and time)
  --object <ApiName>             an object to keep; repeat for more (default: every object people
                                 work in, empty ones included, setup and log objects left out)
  --exclude-object <ApiName>     leave an object out; repeat for more
  --custom-setting <ApiName|all> keep a custom setting, or all of them, which a checkpoint leaves
                                 out unless named: a rewind sets their rows back, an integration's
                                 endpoint or an admin's switch among them; repeat for more; needs
                                 Customize Application
  --ignore-field <Object.Field>  do not compare a field, nor write it back (one your automation sets
                                 on every save); repeat for more
  --max-total <n>                refuse, before reading, more than <n> records (default: 500000)
  --keep-days <n>                when it expires (default: 30; 0 keeps it until deleted)
  --estimate                     say the records, API requests, time and disk it would take, then stop
preview, rewind, undo, delete, export:
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
  --accept-recreate              make again, with new Ids, the records deleted since that the
                                 recycle bin no longer gives back: what outside Salesforce names
                                 their old Ids no longer finds them; without it a rewind that
                                 counts such records writes nothing, exit 1, and one Salesforce
                                 answers is no longer in the bin as it brings it back is left,
                                 named
  --accept-outside               (a checkpoint of picked objects) also delete the records outside it
                                 created under records it deletes, and the files it deletes that are
                                 attached outside it too; without it those parents stay, and those
                                 files are only removed from its records
  --accept-unseen                (a user without View All Data and Modify All Data) delete records
                                 whose delete takes along records of objects the user is not
                                 proven to see whole — tasks and events always: the preview names
                                 those objects, and no count holds what goes with them; without it
                                 such a rewind writes nothing, exit 1
  --ignore-field <Object.Field>  stop comparing a field from now on; kept in the checkpoint
  --yes                          do not ask before writing; without it and with no terminal — a CI
                                 step — it stops at its question, exit 2, having written nothing
undo:
  --accept-automation            as for rewind
  --yes                          as for rewind
delete:
  --all                          every checkpoint of the org
  --yes                          do not ask
export:
  --out <file>                   the file to write; refused when one is there already
  --key-env <VAR>                encrypt under the key this environment variable holds, one an
                                 export showed (a CI step's secret); without it a new key is
                                 drawn and shown once, on stderr
import:
  --file <file>                  the .sfcheckpoint file
  --key-env <VAR>                read the key from this environment variable; without it the key
                                 is asked on the terminal, not echoed, and with no terminal it
                                 stops, exit 2, having imported nothing
  --keep-days <n>                when it expires on this machine (default: 30; 0 keeps it until
                                 deleted)
Options:
  --store <dir>                  where checkpoints live (default: ~/.sandforge/checkpoints, or
                                 checkpoints/ in the folder SANDFORGE_JOURNAL_DIR names)
  --json                         the answer alone on stdout, every other line on stderr
  --help                         this text

A production org is refused before anything is read or written, exit 1. No flag lifts it.
With View All Data and Modify All Data, the user the alias connects as sees every record and
rewinds whoever changed it; import needs both. Without them, take holds only the objects the
user has View All and Modify All on, or, for an object with no permissions of its own, on every
record it hangs from — never tasks and events, products and price books, files or custom
settings — and preview, rewind and undo read those permissions again: an object no longer held
is not read, and is left as it is; what another user deleted since stays in the recycle bin,
named; undo takes back the user's own rewind alone. A checkpoint that keeps custom settings
needs Customize Application too: View All Custom Settings reads them, never writes them.
A checkpoint holds the records' values as the org held them, personal data among them,
unencrypted, in files only you can read (on Windows: in your user profile). Expired checkpoints
are deleted as any command starts, each named.
list and delete read this machine alone and never contact the org. An org's checkpoints are the
ones taken under its alias or username, and the others kept of the same Organization Id.
export never writes a checkpoint unencrypted: AES-256-GCM, under a key of 52 letters and digits
shown once and kept nowhere. Anyone who has the file and its key reads every record it holds:
send the key another way than the file, and only to people who already see all data in the org.
The file does not expire: delete it once it has served. It carries neither the journals of
rewinds nor their undo, which stay on this machine.
import reads the file's header, then asks the org: another org, a production org, a user without
View All Data and Modify All Data, a file a newer SandForge made, are each refused before the key
is asked. A wrong key, or a file changed since it was exported, is refused before anything is
kept. A checkpoint kept already the same is left as it is, exit 0; another of its id is refused.
The lock against two rewinds at once is per machine: agree on who rewinds the org.
rewind shows its preview and asks you to type the org's alias before it writes, then rewinds from
that preview as it read the org: a record someone changes after it read is left as they made it,
and said. A take, a rewind or an undo of the org under way on this machine, in the editor or in
another command line, refuses a rewind and an undo; other runs writing to the org are not seen
here, and what one of them changes after the preview read the org is left and said the same way.
Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once,
and leaves a checkpoint listed as never taken, which delete removes. Ctrl-C stops a rewind or an
undo before its next call to the org, and leaves its journal: rewind again takes up from what still
differs, and undo still returns the org to how it was before the rewind.

A record deleted since that the recycle bin no longer gives back is made again from the
checkpoint, with a new Id, once --accept-recreate says so: the lookups the checkpoint holds that
named it name the new Id, and undo deletes it again. Salesforce still lists a record emptied from
the bin as deleted, for minutes to hours, and says the bin no longer holds it only as the rewind
asks it back: such a record, with what was to come back with it, is made again then, or left
and named without --accept-recreate.
A record the checkpoint does not hold that took records of it along when it was deleted since is
brought back for a moment with them, then deleted again with what came back with it.
A custom setting is kept only when --custom-setting names it. A rewind brings a row of one back
only once no other row holds its owner (a hierarchy: the org's default, a profile, a user) or
its name (a list): it deletes the row made since first, then brings the row back with its Id.
A checkpoint holds the files attached to its records, Salesforce Files and classic attachments:
which records each is attached to, its latest version and its size, never its content. A rewind
deletes the files attached to them since, brings back those deleted since with their links,
removes the links added since and puts back those removed since, under new Ids; a file
attached to no record of the checkpoint, a user's own or a library's, is left and counted.
Bringing files back from the recycle bin takes file storage again: a rewind or an undo that would
take more than the org has left is refused before it writes. Without Query All Files, other
users' files that no record of the checkpoint is attached to are not seen.
What a rewind cannot undo: a file deleted since and no longer in the recycle bin, whose body the
checkpoint does not hold, a file given a new version since, which keeps it, a lead converted
since, a contract activated since, a record deleted with a parent created since that Salesforce
does not undelete on its own, or with its parent of an object the checkpoint does not hold
(preview counts them); without View All Data and Modify All Data, a record another user deleted
since, and a record of an object held through what it hangs from that the recycle bin does not
show the user (preview counts them too); a field added since, deleted since, or hidden since from
the user by field-level security, which the preview tells apart and names; the values the org
computes or keeps itself (formulas, roll-ups, auto-numbers, created and modified dates); what left
the org (emails, callouts, outbound messages, platform events); metadata; the files of a
checkpoint taken before SandForge 1.70, which holds none. A record the org refuses to put back, or
to make again, is named by rewind, with its words.

JSON (--json), one value on stdout:
  list               [{id, name, org, organizationId, takenAt, records, bytes, expiresAt,
                       expiresSoon, binReachSince, lastRewind?, valid, why?, refreshedAt?}]
                     (name, org, takenAt, records and bytes are null for a damaged checkpoint;
                     expiresAt is null for one kept until deleted)
  take               {checkpoint, requests?, estimate}: the checkpoint as kept (its
                     checkpoint.json; files?, {documents, links, anchored, readByIds?}, for one
                     that holds files); requests, {total, byPhase}, the API requests the take sent
                     the org, SOAP calls among them; estimate, what it said before reading a record
  take --estimate    {mode, objects, leftOut, estimate, refusal?, files?, customSettings?}:
                     estimate.requestsByPhase splits the requests over a take's phases as
                     requests.byPhase does: guard, scope, start, counts, bin, snapshot, stability;
                     files, {held, queryAllFiles, addedToPicked}; customSettings, every custom
                     setting of the org, kept or not, [{objectApiName, label, kind?, records?}],
                     kind hierarchy or list, and objects[].customSetting for one kept; {mode,
                     refusal} for a take refused before its scope is read (a production org, a
                     user without the permissions)
  preview            {checkpoint: {id, name, takenAt, org}, toDelete, toGiveBack, toBringBack,
                      toRecreate, carriers, differs, diff, estimate, automation?, emails?,
                      emailsUncounted?, refusal?}: carriers, the records brought back for a
                     moment and deleted again, in none of the other numbers; diff, estimate,
                     automation and refusal as the extension answers them; refusal is the one a
                     rewind would meet now; emails, one per daily limit its writes send
                     against: {limit, emails, verdict, remaining?, max?, alertsCounted?,
                     objects: [{objectApiName, write, records, perRecord, sentBy}]};
                     emailsUncounted, what sends emails as it writes that could not be read — a
                     flow whose definition was refused, a package's, which no user reads — its
                     emails not counted, which --accept-automation covers;
                     diff.objects[].schemaDrift, of an object whose fields changed since:
                     {removed, added, changed, hidden?, uncertain?: {fields, reason?}}, removed
                     the custom fields deleted since, hidden those field-level security hides
                     from the user, uncertain those the org would not say which of; diff.files,
                     for a checkpoint that holds files: {unlink, relink, updateLinks,
                     outsideAdded, outsideDeleted, storage: {bringBack, remaining?, undo},
                     blindSpot?}, the links to remove, put back and give their sharing back, the
                     files left, and file storage in bytes; diff.access, {kind, requests?}, org
                     for a user with View All Data and Modify All Data, perObject for one read
                     object by object, with the API requests that read; diff.unseen, read
                     object by object: [{objectApiName, children, records}], of the records to
                     delete of an object, the objects whose records their delete takes along
                     out of the user's sight
  rewind --dry-run   as preview
  rewind             {checkpoint: {id, name, takenAt, org}, rewindId, status, deleted, givenBack,
                      broughtBack, recreated (each {planned, done, left}), cannotUndo: [{object,
                      reason, count}], carriers?: [{object, count}], undo?: {until, cannot:
                      [{object, count, reason?}]}, verify: {differences, stable, passes,
                      notCompared}, residual: [{object, reason, by?, count, message?}], unread:
                      [{object, reason}], objects: [{object, deleted, givenBack, broughtBack,
                      refused}], apiRequests: {used, leftToday}, result}:
                     status success, partial, unstable, failure or cancelled; result as the
                     extension answers it; undo.cannot's reason deletedBeforeParent: deleted
                     before a record they point at, which the rewind deleted next; carriers, of
                     what it brought back and deleted, the records brought back for a moment;
                     files?: {unlinked, relinked, linksUpdated, linksRefused}, the links between
                     files and records it wrote, when it wrote one
  undo               as rewind, without recreated, cannotUndo, carriers and undo, with
                     carriedAlone?: [{object, count}], the records sent back to the recycle bin
                     on their own that had gone there with a record the rewind brought back for
                     a moment
  delete             {deleted: [id], kept: [id]}
  export             {checkpoint: {id, name, takenAt, org}, file, bytes, sha256, records, objects,
                      keyShown}: keyShown, whether a new key was drawn and shown on stderr; never
                     the key itself
  import             {outcome, checkpoint: {id, name, takenAt, org}, records, objects, expiresAt,
                      warnings}: outcome imported, or alreadyKept for the same checkpoint kept here
                     already
  refused or failed  {refusal: {code, message}}
  A bad command line (exit 2) prints nothing on stdout.

Exit codes: 0 done (take: every record of its objects is kept; rewind and undo: read again, the
org matches among the objects and fields compared; preview, rewind --dry-run and list answered;
delete: every checkpoint named is deleted; export: the file is written; import: the checkpoint is
kept, or was already); 1 refused before it read or wrote (a production org,
missing permissions, automation without --accept-automation, deletions undo could not bring back
without --accept-no-undo, records to make again with new Ids without --accept-recreate,
deletions taking along records the user is not proven to see without --accept-unseen, more than
--max-total records, more API requests or emails than the org
has left today, files to bring back taking more file storage than it has left, a checkpoint of
the org before a refresh or of an expired scratch org, a SandForge run writing to it; an import
of another org's file, with the wrong key, of a file changed since its export), or nothing
done; 2 a bad command line, a --checkpoint name several checkpoints
have, rewind or undo with --yes and no checkpoint named, or a question with no terminal (give
--yes; import's key: --key-env); 3 partial (rewind and undo: records still differ, each said
with why; with
--fail-on-change, the org differs: records to delete, give back, bring back or make again,
links between files and records to remove, put back or give their sharing back, records the
rewind cannot take back or the checkpoint does not hold although they are dated before it, files
added or deleted since that no record of it is attached to, an object that
could not be read; delete: some were kept, each said with why); 4 unstable (someone else changed
records during the rewind or the undo: left as they made them); 130, 143, 129 Ctrl-C, SIGTERM or
SIGHUP stopped it — run rewind again: it takes up from what still differs, and undo still reaches
the state before it.
```
