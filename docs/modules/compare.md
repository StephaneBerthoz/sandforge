# Compare

Compare metadata, permission names, and five Organization settings between two Salesforce orgs, from a single tabbed interface, and deploy to a sandbox, a scratch org or a Developer Edition org what the source holds differently, validated first -- see [Deploy from Diff](#deploy-from-diff).

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.compare in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick the Source Org and a different Target Org; Org overview then reads both, with no comparison.
2. Under Categories, click the types to compare, or Select All.
3. Click Run Comparison, then open a group on the Differences tab and click a change to see it.
4. On the Deploy from Diff tab, tick components and click the Validate button that names the target.
5. Once it succeeds, click the Deploy button that names the target, type its name and click Confirm.

**Tip:** Comparing writes nothing. Deploy from Diff validates in the target first, deletes nothing there and refuses a production target.

<!-- how-to:end -->

## Quick Start

1. Open **Compare Org** from the launcher's **Watch and compare** group (it needs at least 2 orgs in SandForge's list of orgs)
2. Select a source org and a target org using the org selector
3. Choose metadata component types to compare (fields, objects, flows, Apex classes, profiles, etc.)
4. Click **Run Comparison** to execute the comparison. Once it is in, the configuration folds to one line -- the two orgs, how many categories, and whether managed package components were left out -- with **Edit** to unfold it
5. The page has three tabs: Differences, Deploy from Diff, and Org overview

**Org overview** needs no comparison: pick the two orgs and open the tab.

## Features

### Differences

The first tab shows what the comparison found, side by side between the two orgs: the
Risk Score Card, the counts, and the changes grouped by type.

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
**Differences** tab says that nothing differs; the line above it says how many components
were compared by content.

- **Summary Bar** -- Counts of the components only in the source (+), only in the target (-), modified (~), unchanged (=) and not compared (?), a line saying what each of the first three means for a deployment, and how many of the components both orgs hold were compared by content
- **Risk Score Card** -- An enriched risk assessment of what a deployment would change: the components only in the source and the modified ones. Components not compared are left out of it, and it does not call a comparison safe to deploy while some were, nor while a change it deploys rates high or critical. The components only in the target are on a line of their own, with no risk level: a deployment leaves them, and removing them by hand may lose data
- **Diff Group Accordion** -- Changes grouped by type, expandable to see individual changes
- **Diff Detail Modal** -- Click any change to see it; for a modified component, the lines where the two copies first differ

### Deploy from Diff

The **Deploy from Diff** tab deploys to the target the components the comparison found only
in the source, or different in it. Nothing is deployed that was not validated
first. Opened before a comparison, the tab says that it deploys what a
comparison finds.

1. **Pick.** The tab lists each component a deployment can carry, marked
   _Only in the source_ or _Modified_, as the diff views name it, with the risk the Risk Score
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
type SandForge cannot tell: SandForge deploys metadata to a sandbox, a scratch
org or a Developer Edition org -- a Trailhead playground is one -- and to no
other. The Production Guard decides it, as it decides every write. With such a
target, the tab says so and names the orgs to pick as Target Org instead, and
offers nothing to pick, test or validate.

### Org overview

The two orgs side by side, read each time the tab opens, with no comparison to
run: it needs the two orgs alone, and none of the categories, which only a
comparison reads: they wait on the other tabs, as picked, and the tab starts
right under the two orgs. Until a source and a different target org are picked,
it says so and reads nothing. Each
section says when it read the two orgs, as a date and a time in the panel's
language. A section whose answer carries nothing to show says so, rather than
showing two orgs that match.

#### Objects

A live capture of the objects of both orgs, taken with `describeGlobal` at the
moment you open the tab: a list, not a saved state such as a checkpoint.
Nothing is stored between visits, so there is no history to browse and no
earlier capture to compare against -- the section compares the two orgs as they
are right now:

- Object counts per org: total, custom, standard, and queryable
- The objects that exist on only one side, listed per org, plus the shared count
- When the two orgs were read

#### Permission sets & profiles

Which permission sets and profiles exist on each side, by name:

- Permission sets on the source only, on the target only, and on both
- Profiles split the same three ways
- Names and labels, nothing about what a permission set or profile grants —
  object and field permissions are not read, so no record-level access is
  compared here

#### Organization settings

Five fields of the `Organization` record, read from both orgs when you open the
tab, and listed side by side with whether each one matches, under the share of
them that differ:

- Name, language, default locale, time zone, and the month the fiscal year
  starts
- One query per org, on request — nothing runs on a schedule and nothing is
  stored between visits
- No metadata is read, so a difference in security settings, sharing rules or
  any other configuration does not appear here

## Command line

`sandforge compare --source <alias> --target <alias>` sends the page's
requests without the editor: the diff (`--type`, `--all-types`), the
permission sets and profiles, the objects and the Organization settings of the
two orgs, and a validation (`--validate <Type:Name>`), check-only. None of them
writes to either org. [Command line & CI](../../ci-examples/README.md) lists
its flags and its exit codes.

The diff is signed as the page signs it: + for a component only the source
holds, which a deployment creates in the target, - for one only the target
holds, which it leaves there, ~ for one both hold differently, each named by
type. With `--json`, the page's own message keeps its words, `removed` for
what only the source holds and `added` for what only the target holds; beside
it, `changes` lists them as `onlyInSource`, `onlyInTarget` and `modified`,
each as `Type:Name`, the form `--deploy` takes.

`--deploy <Type:Name>`, given once per component, deploys as **Deploy from
Diff** does, through the same two requests: the components are validated in
the target first, then the package the target validated is deployed, with the
same tests, once the target's alias is typed. `--yes` stands in for the alias;
with neither a terminal nor `--yes`, the line is refused, exit `2`, before any
org is reached.

- **Before the validation**, it says the two orgs, the components and the
  tests. With no `--tests`, the target's own tests run when an Apex class or
  trigger is among the components, as the tab advises. `--dry-run` says the
  same and sends nothing to either org.
- **Each report** words each component as the tab does: the validation, which
  keeps nothing, says it _would be created_ or _would change_; the deployment
  says it was _created_ or _changed_.
- **A production target**, or one it cannot tell from one, is refused before
  anything is sent, `--dry-run` included, exit `1`. No flag lifts it.
- **It exits** `0` once deployed; `3` when the validation or the deployment
  came back with no success (the target rolls a failed deployment back whole);
  `1` when it was refused, the alias typed was not the target's, or a request
  failed. `--json` carries both reports and how the run ended.
- **It deletes nothing** from the target: a component it created stays there
  until it is deleted in the target itself.

## Tips

- Run a compare before any major deployment to understand the full scope of changes
- Use the Risk Score Card to quickly assess whether changes are safe to deploy
- **Permission sets & profiles** answers "which permission sets and profiles is this org missing?", not "who can see what"
- Open **Org overview** after each release to see whether those five Organization settings still match
- Deploy a few components at a time: a validation of a handful says which one fails, and on which line
