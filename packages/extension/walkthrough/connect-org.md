## Connect your first org

SandForge works on top of your authenticated Salesforce orgs. Both paths below need the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on your PATH: the browser login is run by the CLI too.

1. Click **Import from SF CLI** to pull in every org already authenticated in the Salesforce CLI — the fastest path.
2. Or use **OAuth (Web)** to connect an org through your browser.

Once connected, each org shows up as a card with its alias, type badge (PROD/SBX), and status.

[Open Organizations](command:sandforge.openOrgs)

> Sandboxes and scratch orgs work out of the box. Production orgs are protected by a double-confirmation guard.
