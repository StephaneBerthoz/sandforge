## Clone dados com o Forge

Copie um registro real, e o que depende dele, de outra org para a que você preenche:

1. Cole o ID de um registro raiz da org de onde você copia (uma sandbox de UAT, por exemplo) em **ID do registro ou URL do Salesforce** — uma conta funciona bem.
2. Clique em **Descobrir grafo** — o Forge percorre o grafo de relacionamentos do registro (contatos, oportunidades, casos…).
3. Ajuste **Profundidade**, **Registros por objeto** e **Anonimizar PII**.
4. Clique em **Revisar e executar** apontando para a org que você preenche. Os IDs são remapeados na escrita; um tipo de registro sem um tipo de registro ativo com o mesmo nome de API no destino mantém o Id de origem, e o log do SandForge informa isso.

Com pressa? **Clonar diretamente**, abaixo de **Descobrir grafo**, inicia a clonagem assim que a descoberta responde, sem parar no grafo nem na revisão: a comparação de metadados entre as duas orgs não é executada nesse caso. Um grafo com mais de 25 objetos é listado em uma tabela em vez de desenhado; o seletor **Visualização em grafo** / **Visualização em tabela** e a configuração `sandforge.forge.graphView` decidem.

[Abrir Forge](command:sandforge.openForge)
