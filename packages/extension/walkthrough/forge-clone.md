## Clone data with Forge

Populate a dev sandbox from a real record:

1. Paste a root record ID from your UAT org into **Record ID or Salesforce URL** — an Account works well.
2. Click **Discover Graph** — Forge walks the record's relationship graph (Contacts, Opportunities, Cases…).
3. Tune **Depth**, **Records per object**, and **Anonymize PII**.
4. Click **Review & Execute** toward your dev sandbox. IDs are remapped as the records are written; a record type with no active record type of the same API name on the target keeps its source Id, and the SandForge log names it.

In a hurry? **Clone directly**, under **Discover Graph**, runs the clone as soon as discovery answers, with no stop on the graph or on Review: the metadata diff between the two orgs is then not run. A graph of more than 25 objects is listed in a table rather than drawn; the **Graph View** / **Table View** switch and the `sandforge.forge.graphView` setting choose.

[Open Forge](command:sandforge.openForge)
