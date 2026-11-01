## Clone datos con Forge

Copie un registro real, y lo que cuelga de él, desde otra org hacia la que rellena:

1. Conecte las dos orgs: la org desde la que copia (un sandbox de UAT, por ejemplo) y la que rellena. La org seleccionada en el panel lateral es la **Org de origen**.
2. Elija la **Org de destino**, la que rellena: **Descubrir grafo** sigue desactivado hasta entonces.
3. Pegue el ID o la URL de un registro en **ID de registro o URL de Salesforce**: una cuenta funciona bien. **Profundidad** (hasta **Profundo (5 niveles)**), **Registros por objeto** y **Anonimizar PII** están encima del botón: ajústelos ahora, porque deciden lo que lee el descubrimiento.
4. Haga clic en **Descubrir grafo** y luego en **Revisar y ejecutar**.
5. En la revisión, **Simular** comprueba cada registro y no envía nada; **Ensayar** hace que el destino pruebe una muestra, revertida, y consume llamadas a la API; **Ejecutar Forge** escribe. **Eliminar los registros que creó esta ejecución**, en los resultados o en **Ejecuciones recientes**, deshace la ejecución.

¿Con prisa? **Clonar directamente**, bajo **Descubrir grafo**, lanza la clonación en cuanto responde el descubrimiento, sin detenerse en el grafo ni en la revisión: la comparación de metadatos entre las dos orgs no se ejecuta entonces. Un grafo de más de 25 objetos se enumera en una tabla en lugar de dibujarse; el selector **Vista de grafo** / **Vista de tabla** y el ajuste `sandforge.forge.graphView` deciden.

[Abrir Forge](command:sandforge.openForge)
