## Optimieren Sie Ihre Einstellungen

SandForge hält seine Einstellungen an zwei Orten:

- **Einstellungen öffnen** öffnet die Seite von SandForge: die Sprache seiner Panels und den optionalen KI-Assistenten, betrieben von Anthropic (Claude).
- **SandForge-Einstellungen in VS Code öffnen** öffnet die Einstellungen des Editors, auf SandForge gefiltert: die Standard-Batchgrößen für Seed und Sync, die Aufzeichnung der Entscheidungen von Production Guard, mit jedem Lauf im Audit-Protokoll (Berichte, `sandforge.safety.auditLogging`), und wie Forge einen großen Graphen zeigt — bis 25 Objekte gezeichnet und darüber in einer Tabelle gelistet, oder bis 150 Objekte auf eine Art, darüber und für einen Klon der ganzen Org in einer Tabelle (`sandforge.forge.graphView`).

[Einstellungen öffnen](command:sandforge.openSettings)

[SandForge-Einstellungen in VS Code öffnen](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> Forge, Ladevorgänge von Frozen Dataset, Prüfpunkte und das Deployment von Compare verweigern eine Produktions-Org; Löschungen werden dort ebenfalls verweigert; jedes andere Schreiben dort fragt zuerst, und keine Einstellung schaltet das ab. Eine Sandbox mit echten Daten (Vollkopie, Abnahmetest): Öffnen Sie auf der Seite Organisationen ihren Dialog **Bearbeiten** und setzen Sie den Haken bei **Staging**; Production Guard fragt dann vor jedem Löschen, jedem Deployment und jedem Schreiben von mehr als 10.000 Datensätzen.
