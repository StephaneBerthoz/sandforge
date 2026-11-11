## Klonen Sie Daten mit Forge

Kopieren Sie einen echten Datensatz und alles, was daran hängt, aus einer anderen Org in die Org, die Sie füllen:

1. Verbinden Sie beide Orgs: die, aus der Sie kopieren (etwa eine UAT-Sandbox), und die, die Sie füllen. Die im Seitenpanel ausgewählte Org ist die **Quell-Org**.
2. Wählen Sie die **Ziel-Org**, die Org, die Sie füllen: **Graph ermitteln** bleibt bis dahin gesperrt.
3. Fügen Sie die ID oder URL eines Datensatzes in **Datensatz-ID oder Salesforce-URL** ein — ein Account eignet sich gut. **Tiefe** (bis **Tief (5 Ebenen)**), **Datensätze pro Objekt** und **PII anonymisieren** stehen über der Schaltfläche: Stellen Sie sie jetzt ein, denn sie bestimmen, was die Ermittlung liest. **ALL**, die letzte Tiefe, kopiert stattdessen die gesamte Quell-Org: kein Datensatz zum Einfügen und keine Obergrenze pro Objekt.
4. Klicken Sie auf **Graph ermitteln**, dann auf **Überprüfen & Ausführen**.
5. In der Überprüfung prüft **Simulieren** jeden Datensatz und sendet nichts; **Probelauf** lässt das Ziel eine Stichprobe testen, die zurückgesetzt wird, und kostet API-Aufrufe; **Forge ausführen** schreibt. **Die von diesem Durchlauf erstellten Datensätze entfernen**, in den Ergebnissen oder unter **Letzte Durchläufe**, nimmt den Durchlauf zurück. Ein Klon der gesamten Org (**ALL**) bietet noch weder **Simulieren** noch **Probelauf**: Die Bestätigung, die **Forge ausführen** immer vor dem Schreiben verlangt, nennt, was der Durchlauf schreibt.

Eilig? **Direkt klonen**, unter **Graph ermitteln**, startet das Klonen, sobald die Ermittlung antwortet, ohne beim Graphen oder bei der Überprüfung anzuhalten: Der Metadatenvergleich zwischen den beiden Orgs wird dann nicht ausgeführt. Ein Graph mit mehr als 25 Objekten wird in einer Tabelle gelistet statt gezeichnet; der Umschalter **Graph-Ansicht** / **Tabellenansicht** und die Einstellung `sandforge.forge.graphView` entscheiden.

[Forge öffnen](command:sandforge.openForge)
