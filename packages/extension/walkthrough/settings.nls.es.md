## Ajuste su configuración

SandForge guarda su configuración en dos lugares:

- **Abrir Configuración** abre la página de SandForge: el idioma de sus paneles y el asistente de IA opcional, con tecnología de Anthropic (Claude).
- **Abrir la configuración de SandForge en VS Code** abre la configuración del editor, filtrada por SandForge: los tamaños de lote predeterminados de Seed y Sync, la constancia de las decisiones de Production Guard guardada con cada ejecución en el registro de auditoría (Informes, `sandforge.safety.auditLogging`), y cómo muestra Forge un grafo grande — dibujado hasta 25 objetos y enumerado en una tabla por encima, o de una sola forma hasta 150 objetos, en una tabla por encima y para un clon de la org entera (`sandforge.forge.graphView`).

[Abrir Configuración](command:sandforge.openSettings)

[Abrir la configuración de SandForge en VS Code](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> Forge, las cargas de Frozen Dataset, los puntos de control y el despliegue de Compare rechazan una org de producción; allí también se rechazan las eliminaciones; cualquier otra escritura allí pregunta antes, y ningún ajuste lo desactiva. Un sandbox con datos reales (copia completa, pruebas de aceptación): abra su diálogo **Editar** en la página Organizaciones y marque **Staging**; Production Guard pregunta entonces antes de cada eliminación, cada despliegue y cada escritura de más de 10.000 registros.
