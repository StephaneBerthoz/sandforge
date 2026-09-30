## Klonen Sie Daten mit Forge

Füllen Sie eine Entwicklungs-Sandbox ausgehend von einem echten Datensatz:

1. Fügen Sie die ID eines Wurzeldatensatzes aus Ihrer UAT-Org in **Datensatz-ID oder Salesforce-URL** ein — ein Account eignet sich gut.
2. Klicken Sie auf **Graph ermitteln** — Forge folgt dem Beziehungsgraphen des Datensatzes (Kontakte, Opportunities, Cases…).
3. Passen Sie **Tiefe**, **Datensätze pro Objekt** und **PII anonymisieren** an.
4. Klicken Sie auf **Überprüfen & Ausführen** in Richtung Ihrer Entwicklungs-Sandbox. Die IDs werden beim Schreiben neu zugeordnet; ein Datensatztyp ohne aktiven Datensatztyp mit demselben API-Namen im Ziel behält seine Quell-Id, und das SandForge-Protokoll nennt ihn.

Eilig? **Direkt klonen**, unter **Graph ermitteln**, startet das Klonen, sobald die Ermittlung antwortet, ohne beim Graphen oder bei der Überprüfung anzuhalten: Der Metadatenvergleich zwischen den beiden Orgs wird dann nicht ausgeführt. Ein Graph mit mehr als 25 Objekten wird in einer Tabelle gelistet statt gezeichnet; der Umschalter **Graph-Ansicht** / **Tabellenansicht** und die Einstellung `sandforge.forge.graphView` entscheiden.

[Forge öffnen](command:sandforge.openForge)
