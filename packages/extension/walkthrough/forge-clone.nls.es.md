## Clone datos con Forge

Copie un registro real, y lo que cuelga de él, desde otra org hacia la que rellena:

1. Pegue el ID de un registro raíz de la org desde la que copia (un sandbox de UAT, por ejemplo) en **ID de registro o URL de Salesforce**: una cuenta funciona bien.
2. Haga clic en **Descubrir grafo**: Forge recorre el grafo de relaciones del registro (contactos, oportunidades, casos…).
3. Ajuste **Profundidad**, **Registros por objeto** y **Anonimizar PII**.
4. Haga clic en **Revisar y ejecutar** hacia la org que rellena. Los ID se reasignan al escribir; un tipo de registro sin un tipo de registro activo con el mismo nombre de API en el destino conserva su Id de origen, y el log de SandForge lo indica.

¿Con prisa? **Clonar directamente**, bajo **Descubrir grafo**, lanza la clonación en cuanto responde el descubrimiento, sin detenerse en el grafo ni en la revisión: la comparación de metadatos entre las dos orgs no se ejecuta entonces. Un grafo de más de 25 objetos se enumera en una tabla en lugar de dibujarse; el selector **Vista de grafo** / **Vista de tabla** y el ajuste `sandforge.forge.graphView` deciden.

[Abrir Forge](command:sandforge.openForge)
