## Clone data with Forge

Copy a real record, and what hangs on it, from another org into the one you fill:

1. Connect both orgs: the one you copy from (a UAT sandbox, say) and the one you fill. The org selected in the side panel is the **Source Org**.
2. Pick the **Target Org**, the one you fill: **Discover Graph** stays off until you do.
3. Paste a record's Id or URL into **Record ID or Salesforce URL** — an Account works well. **Depth** (up to **Deep (5 levels)**), **Records per object** and **Anonymize PII** sit above the button: set them now, since they decide what discovery reads.
4. Click **Discover Graph**, then **Review & Execute**.
5. On Review, **Simulate** checks every record and sends nothing; **Rehearse** has the target try a sample, rolled back, and costs API calls; **Execute Forge** writes. **Remove the records this run created**, on the results or under **Recent runs**, takes the run back.

In a hurry? **Clone directly**, under **Discover Graph**, runs the clone as soon as discovery answers, with no stop on the graph or on Review: the metadata diff between the two orgs is then not run. A graph of more than 25 objects is listed in a table rather than drawn; the **Graph View** / **Table View** switch and the `sandforge.forge.graphView` setting choose.

[Open Forge](command:sandforge.openForge)
