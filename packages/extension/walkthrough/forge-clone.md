## Clone data with Forge

Populate a dev sandbox from a real record:

1. Paste a root record ID from your UAT org into **Record ID or Salesforce URL** — an Account works well.
2. Click **Discover Graph** — Forge walks the record's relationship graph (Contacts, Opportunities, Cases…).
3. Tune **Depth**, **Records per object**, and **Anonymize PII**.
4. Click **Review & Execute** toward your dev sandbox. IDs are remapped as the records are written; a record type with no active record type of the same API name on the target keeps its source Id, and the SandForge log names it.

[Open Forge](command:sandforge.openForge)
