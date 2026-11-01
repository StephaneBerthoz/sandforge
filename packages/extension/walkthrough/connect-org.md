## Connect your first org

SandForge works on top of your authenticated Salesforce orgs. Both paths below need the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on your PATH: the browser login is run by the CLI too.

1. Click **Import from Salesforce CLI** to pull in every org already authenticated in the Salesforce CLI — the fastest path.
2. Or click **Log in with your browser** to connect an org through Salesforce's own login page.

Once connected, each org shows up as a card with its alias, type badge (PROD, DEVELOPER for a Developer Edition, SCRATCH, or a sandbox's kind: DEV, DEV PRO, PARTIAL, FULL), and status.

[Open Organizations](command:sandforge.openOrgs)

> Sandboxes, scratch orgs and Developer Edition orgs work out of the box. Forge, Frozen Dataset loads, Checkpoints and Compare's deploy refuse a production org; deletes are refused there too; every other write there asks first, and no setting turns that off. A sandbox holding real data (full copy, UAT): open its **Edit** dialog on Organizations and tick **Staging**, and Production Guard then asks before every delete, deployment and write over 10,000 records.
