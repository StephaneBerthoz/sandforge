## Ajuste suas configurações

O SandForge guarda suas configurações em dois lugares:

- **Abrir Configurações** abre a página do SandForge: o idioma dos seus painéis e o assistente de IA opcional, com tecnologia da Anthropic (Claude).
- **Abrir as configurações do SandForge no VS Code** abre as configurações do editor, filtradas pelo SandForge: os tamanhos de lote padrão de Seed e Sync, o registro das decisões do Production Guard mantido com cada execução no registro de auditoria (Relatórios, `sandforge.safety.auditLogging`), e como o Forge mostra um grafo grande — desenhado até 25 objetos e listado em uma tabela acima disso, ou sempre de uma só forma (`sandforge.forge.graphView`).

[Abrir Configurações](command:sandforge.openSettings)

[Abrir as configurações do SandForge no VS Code](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> O Forge, as cargas do Frozen Dataset, os pontos de verificação e a implantação do Compare recusam uma org de produção; as exclusões também são recusadas lá; qualquer outra gravação lá pergunta antes, e nenhuma configuração desativa isso. Uma sandbox com dados reais (cópia completa, homologação): abra a caixa **Editar** dela na página Organizações e marque **Staging**; o Production Guard passa a perguntar antes de cada exclusão, cada implantação e cada gravação de mais de 10.000 registros.
