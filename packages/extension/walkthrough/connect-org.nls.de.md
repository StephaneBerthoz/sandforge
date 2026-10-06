## Verbinden Sie Ihre erste Org

SandForge setzt auf Ihren bereits authentifizierten Salesforce-Orgs auf. Beide Wege unten setzen die installierte [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) in Ihrem PATH voraus: Auch die Browser-Anmeldung wird von der CLI ausgeführt.

1. Klicken Sie auf **Aus SF CLI importieren**, um alle in der Salesforce CLI authentifizierten Orgs zu übernehmen — der schnellste Weg.
2. Oder verbinden Sie eine Org über **OAuth (Web)** in Ihrem Browser.

Nach der Verbindung erscheint jede Org als Karte mit Alias, Typ-Badge (PROD/SBX) und Status.

[Organisationen öffnen](command:sandforge.openOrgs)

> Sandboxes, Scratch-Orgs und Developer-Edition-Orgs funktionieren sofort. Forge schreibt nie in eine Produktions-Org; die anderen Module fragen vor dem Schreiben nach und löschen dort nie.
