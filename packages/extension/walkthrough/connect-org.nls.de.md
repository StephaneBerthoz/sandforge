## Verbinden Sie Ihre erste Org

SandForge setzt auf Ihren bereits authentifizierten Salesforce-Orgs auf. Beide Wege unten setzen die installierte [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) in Ihrem PATH voraus: Auch die Browser-Anmeldung wird von der CLI ausgeführt.

1. Klicken Sie auf **Aus der Salesforce CLI importieren**, um alle in der Salesforce CLI authentifizierten Orgs zu übernehmen — der schnellste Weg.
2. Oder klicken Sie auf **Im Browser anmelden**, um eine Org über die Anmeldeseite von Salesforce zu verbinden.

Nach der Verbindung erscheint jede Org als Karte mit Alias, Typ-Badge (PROD, DEVELOPER für eine Developer Edition, SCRATCH oder die Art einer Sandbox: DEV, DEV PRO, PARTIAL, FULL) und Status.

[Organisationen öffnen](command:sandforge.openOrgs)

> Sandboxes, Scratch-Orgs und Developer-Edition-Orgs funktionieren sofort. Forge, Ladevorgänge von Frozen Dataset, Prüfpunkte und das Deployment von Compare verweigern eine Produktions-Org; Löschungen werden dort ebenfalls verweigert; jedes andere Schreiben dort fragt zuerst, und keine Einstellung schaltet das ab. Eine Sandbox mit echten Daten (Vollkopie, Abnahmetest): Öffnen Sie auf der Seite Organisationen ihren Dialog **Bearbeiten** und setzen Sie den Haken bei **Staging**; Production Guard fragt dann vor jedem Löschen, jedem Deployment und jedem Schreiben von mehr als 10.000 Datensätzen.
