# Compare

Compare metadata, permission names, and five Organization settings between two Salesforce orgs, from a single tabbed interface, and deploy to a sandbox what the source holds differently, validated first -- see [Deploy from Diff](#deploy-from-diff).

## Quick Start

1. Navigate to **Compare** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org using the org selector
3. Choose metadata component types to compare (fields, objects, flows, Apex classes, profiles, etc.)
4. Click **Run Compare** to execute the comparison
5. Browse results across five tabs: Diff, Permissions, Snapshots, Drift, and Deploy

## Features

### Metadata Diff

The primary tab shows a side-by-side comparison of metadata between the two orgs.

Each chosen type is listed in both orgs. A component only the source holds is
marked + in green: a deployment creates it in the target. One only the target
holds is marked - in red: a deployment leaves it there, since SandForge deploys
no deletion. A component both hold is read from each and its two
copies compared by content: Apex source by query, everything else through the
Metadata API. What differs between any two orgs by nature is set aside first --
line endings, the order of keys and of entries that state their own order,
ids, the user a dashboard runs as, the date inside a zip archive, and profile
or permission set entries that grant nothing. The component is modified (~)
only when what is left differs, and unchanged (=) when it does not.

A run reads at most 500 components from each org and starts no read after 90
seconds, those whose listings differ first, shared evenly across the chosen
types. A component both orgs hold that was not read is **not compared** (?),
with the reason: beyond what one run reads, content that cannot be read (the
Apex of a managed package is hidden), or a read that failed. It is neither a
change nor a match.

What a managed package installed -- a component an org lists under the
package's namespace prefix, as installed -- is compared with the rest while
**Include managed package components** is ticked, as it is by default.
Unticked, those components are left out of both orgs' listings before anything
is read, and the result says how many were left out: they are in no other
count. An org's own components stay in, even in an org with a namespace of its
own.

When a comparison finds no component only one org holds and none modified, the
Diff tab says that nothing differs; the line above it says how many components
were compared by content.

- **Summary Bar** -- Counts of the components only in the source (+), only in the target (-), modified (~), unchanged (=) and not compared (?), a line saying what each of the first three means for a deployment, and how many of the components both orgs hold were compared by content
- **Risk Score Card** -- An enriched risk assessment computed from the changes; components not compared are left out of it, and it does not call a comparison safe to deploy while some were
- **Diff Group Accordion** -- Changes grouped by type, expandable to see individual changes
- **Diff Detail Modal** -- Click any change to see it; for a modified component, the lines where the two copies first differ

### Permission Presence

Which permission sets and profiles exist on each side, by name:

- Permission sets on the source only, on the target only, and on both
- Profiles split the same three ways
- Names and labels, nothing about what a permission set or profile grants —
  object and field permissions are not read, so no record-level access is
  compared here

### Snapshots

A live capture of both orgs, taken with `describeGlobal` at the moment you open
the tab. Nothing is stored between runs, so there is no history to browse and no
earlier capture to compare against -- the tab compares the two orgs as they are
right now:

- Object counts per org: total, custom, standard, and queryable
- The objects that exist on only one side, listed per org, plus the shared count
- The capture timestamp, which is the time of the run that produced it

### Org Settings Drift

Five fields of the `Organization` record, read from both orgs when you open the
tab, and listed side by side with whether each one matches:

- Name, language, default locale, time zone, and the month the fiscal year
  starts
- One query per org, on request — nothing runs on a schedule and nothing is
  stored between runs
- No metadata is read, so a difference in security settings, sharing rules or
  any other configuration does not appear here

### Deploy from Diff

The Deploy tab deploys to the target the components the comparison found only
in the source, or different in it. Nothing is deployed that was not validated
first.

1. **Pick.** The tab lists each component a deployment can carry, marked
   _New_ (only the source holds it) or _Differs_, with the risk the Risk Score
   Card gives it. Below the list, it says which components the comparison
   found that cannot be deployed from it, and why:
   - only the target holds it: taking it out is a destructive change, and
     SandForge deploys none;
   - a managed package installed it, and the package owns it;
   - a profile or a permission set: retrieved on its own, it carries its
     label, a few settings and its access to what is deployed with it -- not
     the difference the comparison found;
   - its content cannot be read, as with the Apex of a managed package, or it
     was not compared.
2. **Validate.** SandForge retrieves the picked components from the source
   through the Metadata API, as one package, and deploys that package to the
   target check-only: the target compiles everything and runs the Apex tests
   you choose -- none, the target's own (what the Risk Score Card advises once
   Apex is picked), or the test classes you name -- and keeps nothing. The
   report lists every component the target reports on, with the line and
   column of each error, each failed test with its line, and the coverage the
   target found short. A component the source no longer holds is named and
   left out of the package, and a validation that lacks one is no ground for a
   deployment.
3. **Deploy.** Only a validation that succeeded can be deployed, and only
   after you type the target's name. SandForge deploys the package the target
   validated, with the same tests, once: to deploy again, validate again. A
   deployment is all or nothing: it rolls back on the first error.

Each report gives the deployment's id, under which the target lists it in
Setup › Deployment Status, validations included.

A production target is refused, validation included, and so is an org whose
type SandForge cannot tell: SandForge deploys metadata to sandboxes only. The
Production Guard decides it, as it decides every write.

### Schema Advice

The Schema Advice button reads your source org's describe and runs it through a
set of rules -- no model, no key, nothing leaves the machine:

- Field-level issues with severity badges (high/medium/low)
- Actionable recommendations for schema improvements
- Object-specific analysis

Rules cover naming conventions, labels duplicated across objects and missing
standard relationships. Each run returns a score out of 100.

## Tips

- Run a compare before any major deployment to understand the full scope of changes
- Use the Risk Score Card to quickly assess whether changes are safe to deploy
- Permission Presence answers "which permission sets and profiles is this org missing?", not "who can see what"
- Re-run the Drift tab after each release to see whether those five Organization settings still match
- Deploy a few components at a time: a validation of a handful says which one fails, and on which line
