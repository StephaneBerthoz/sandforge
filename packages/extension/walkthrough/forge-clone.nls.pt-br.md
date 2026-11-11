## Clone dados com o Forge

Copie um registro real, e o que depende dele, de outra org para a que você preenche:

1. Conecte as duas orgs: a org de onde você copia (uma sandbox de UAT, por exemplo) e a que você preenche. A org selecionada no painel lateral é a **Org de origem**.
2. Escolha a **Org de destino**, a que você preenche: **Descobrir grafo** fica desativado até lá.
3. Cole o ID ou a URL de um registro em **ID do registro ou URL do Salesforce** — uma conta funciona bem. **Profundidade** (até **Profundo (5 níveis)**), **Registros por objeto** e **Anonimizar PII** ficam acima do botão: ajuste-os agora, porque decidem o que a descoberta lê. **ALL**, a última profundidade, copia em vez disso a org de origem inteira: nenhum registro para colar e nenhum limite por objeto.
4. Clique em **Descobrir grafo** e depois em **Revisar e executar**.
5. Na revisão, **Simular** verifica cada registro e não envia nada; **Ensaiar** faz o destino testar uma amostra, revertida, e consome chamadas de API; **Executar Forge** grava. **Remover os registros que esta execução criou**, nos resultados ou em **Execuções recentes**, desfaz a execução. Um clone da org inteira (**ALL**) ainda não oferece **Simular** nem **Ensaiar**: a confirmação que **Executar Forge** sempre pede antes de gravar diz o que a execução grava.

Com pressa? **Clonar diretamente**, abaixo de **Descobrir grafo**, inicia a clonagem assim que a descoberta responde, sem parar no grafo nem na revisão: a comparação de metadados entre as duas orgs não é executada nesse caso. Um grafo com mais de 25 objetos é listado em uma tabela em vez de desenhado; o seletor **Visualização em grafo** / **Visualização em tabela** e a configuração `sandforge.forge.graphView` decidem.

[Abrir Forge](command:sandforge.openForge)
