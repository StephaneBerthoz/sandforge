## Klonen Sie Daten mit Forge

Kopieren Sie einen echten Datensatz und alles, was daran hängt, aus einer anderen Org in die Org, die Sie füllen:

1. Fügen Sie die ID eines Wurzeldatensatzes aus der Org, aus der Sie kopieren (etwa einer UAT-Sandbox), in **Datensatz-ID oder Salesforce-URL** ein — ein Account eignet sich gut.
2. Klicken Sie auf **Graph ermitteln** — Forge folgt dem Beziehungsgraphen des Datensatzes (Kontakte, Opportunities, Cases…).
3. Passen Sie **Tiefe**, **Datensätze pro Objekt** und **PII anonymisieren** an.
4. Klicken Sie auf **Überprüfen & Ausführen** in Richtung der Org, die Sie füllen. Die IDs werden beim Schreiben neu zugeordnet; ein Datensatztyp ohne aktiven Datensatztyp mit demselben API-Namen im Ziel behält seine Quell-Id, und das SandForge-Protokoll nennt ihn.

Eilig? **Direkt klonen**, unter **Graph ermitteln**, startet das Klonen, sobald die Ermittlung antwortet, ohne beim Graphen oder bei der Überprüfung anzuhalten: Der Metadatenvergleich zwischen den beiden Orgs wird dann nicht ausgeführt. Ein Graph mit mehr als 25 Objekten wird in einer Tabelle gelistet statt gezeichnet; der Umschalter **Graph-Ansicht** / **Tabellenansicht** und die Einstellung `sandforge.forge.graphView` entscheiden.

[Forge öffnen](command:sandforge.openForge)
