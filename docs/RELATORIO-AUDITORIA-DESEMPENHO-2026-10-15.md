# Relatório de auditoria de desempenho do Roadcraft

**Data da análise:** 15/10/2026  
**Projeto:** `C:/Codex-Shared/roadcraft-2`  
**Natureza:** análise e propostas, sem implementação de correções.

## Diagnóstico e cobertura

O principal problema é a atualização incremental incompleta: várias operações identificam corretamente o que mudou, mas depois percorrem, copiam ou reenviam dados da cidade inteira. Isso faz o custo de uma edição pequena crescer com o mapa.

A auditoria combinou análise estática de `src/`, leitura das cadeias de execução e testes existentes. Não houve leitura manual linha a linha de todos os 511 arquivos TypeScript nem medição atual no navegador. Os achados abaixo têm evidência no código, mas não representam garantia de identificação de todos os problemas possíveis. As prioridades refletem frequência e crescimento algorítmico; não são um ranking de milissegundos medidos.

Durante a análise, nenhum código, configuração ou documento foi alterado. O `git status` ao término da análise permaneceu igual ao inicial, incluindo alterações preexistentes. Este arquivo foi criado posteriormente, a pedido do usuário, para materializar o relatório apresentado no chat. Os relatórios anteriores foram preservados.

## Achados de prioridade alta

### 1. Validação de vias percorre a rede inteira

**Evidência:** [editRules.ts:143](C:/Codex-Shared/roadcraft-2/src/editor/editRules.ts:143) compara segmentos das duas versões usando JSON. Esse caminho também participa do veredito da prévia, por `RoadTool.verdict` e `commitRoadPath` em modo de validação.

**Consequência:** desenhar uma via curta pode pagar pelo total de vias e perfis da cidade.

**Solução:** obter os segmentos alterados diretamente da transação, incluindo incidentes dos nós modificados. Validar somente esses segmentos e seus vizinhos relevantes. Restringir também os testes de cruzamentos impossíveis e apertados aos nós afetados, preservando a comparação com a situação anterior.

### 2. Algumas ferramentas ainda clonam o documento inteiro

**Evidência:** [editRules.ts:114](C:/Codex-Shared/roadcraft-2/src/editor/editRules.ts:114), `streetObjects.ts:49,99` e `roundabout.ts:57`. `guardRoadEdit` cria o snapshot antes de saber se a edição mudou alguma coisa.

**Consequência:** cópias e construção de índices proporcionais ao mapa antes de pequenas alterações. Compartilhar prédios não elimina as cópias das demais coleções.

**Solução:** estender a transação incremental já existente às ferramentas restantes, com rollback por patches e reutilização dos produtos intactos da rede. Executar a edição protegida na transação em vez de clonar tudo para poder desfazê-la.

### 3. Solver de alturas recria estruturas globais apesar de reaproveitar soluções

**Evidência:** [elevation.ts:511](C:/Codex-Shared/roadcraft-2/src/world/elevation.ts:511), linhas 572, 644 e 867. A função percorre todos os ribbons, cria arrays de alturas, copia perfis mantidos e reconstrói o índice espacial.

**Consequência:** custo proporcional a estradas, estações e células do índice, mesmo quando poucas vias precisam de solução numérica. O reúso numérico atual não torna toda a operação local.

**Solução:** manter perfis, buffers, incidências e índice espacial persistentes. Atualizar somente segmentos afetados e propagar mudanças pelas dependências reais de altura. Conservar a identidade e os arrays dos perfis intocados.

### 4. Atualização do grafo ainda varre e copia caches completos

**Evidência:** [lanelets.ts:280](C:/Codex-Shared/roadcraft-2/src/world/lanelets.ts:280), linhas 328 e 343. Há varredura de `junctionCache`, materialização de todas as chaves de lanelets e cópia dos caches em `seedCaches`.

**Consequência:** uma edição local continua tendo componentes proporcionais ao total de faixas e cruzamentos, inclusive na preparação e adoção do grafo.

**Solução:** indexar caches por segmento/cruzamento, manter referências das chaves utilizadas e transferir somente entradas modificadas entre grafo preparado e grafo ativo. Remover somente entradas realmente substituídas.

### 5. Adoção da topologia revisita agentes e rotas da cidade inteira

**Evidência:** [pipeline.ts:167](C:/Codex-Shared/roadcraft-2/src/sim/pipeline.ts:167) e [walk.ts:1247](C:/Codex-Shared/roadcraft-2/src/sim/agents/walk.ts:1247). `rebindVehicles` percorre frota, runtime, reservas e rotas. Os pedestres já evitam parte dos reroteamentos, mas ainda verificam seus passos globalmente.

**Consequência:** uma edição distante pode exigir validação de toda a frota e dos passos das rotas dos pedestres.

**Solução:** manter índices reversos de dependências: faixa/via/cruzamento → agentes, rotas e reservas. Reconciliar apenas os afetados. Atualizar o índice em todas as mutações de rota, mudança de faixa e remoção. Manter reconstrução integral para abertura/reset.

### 6. Overlay de zoneamento recompõe e serializa todos os lotes por quadro

**Evidência:** [lotTool.ts:148](C:/Codex-Shared/roadcraft-2/src/editor/lotTool.ts:148). No modo de edição, `overlayKeyed` recompõe o overlay e usa JSON de todos os polígonos, linhas e pontos como chave. O chamador está no desenho do overlay em `main.ts`.

**Consequência:** trabalho e lixo de memória proporcionais aos lotes/propostas enquanto a ferramenta está ativa, mesmo sem mudança relevante.

**Solução:** persistir geometria por lote/célula. Separar geometria base, seleção e prévia do gesto; atualizar pelo diário e consultar apenas células visíveis. Substituir a serialização global por versões locais dos produtos.

### 7. Consultas locais do zoneamento percorrem listas globais repetidamente

**Evidência:** [lotTool.ts:263](C:/Codex-Shared/roadcraft-2/src/editor/lotTool.ts:263), linhas 324, 357 e 517. Há `findIndex` nas propostas, `find` nos lotes e cópia de cantos de todos os lotes no snap.

**Consequência:** um movimento pode repetir buscas globais em até 400 amostras. Arrastar um canto também copia dados de todos os lotes.

**Solução:** usar os índices espaciais existentes, indexar propostas e consultar candidatos da área do percurso. Usar a exclusão `apart` já oferecida pelo snapper, preservando a ordem e os desempates atuais. Aplicar a mesma correção às buscas equivalentes da demolição por caixa.

### 8. Planejamento de lotes reinicia globalmente após uma via mudar

**Evidência:** [lotTool.ts:224](C:/Codex-Shared/roadcraft-2/src/editor/lotTool.ts:224). A chave inclui revisão global da rede. Ao soltar o pincel, [linha 565](C:/Codex-Shared/roadcraft-2/src/editor/lotTool.ts:565) pode concluir todo o trabalho pendente com `advanceProposal(Infinity)`.

**Consequência:** custo proporcional à cidade e possibilidade de travamento no fim do gesto. Fatiar o processamento habitual não elimina essa causa.

**Solução:** persistir propostas por bloco/trecho/célula, com dependências espaciais. Recalcular e concluir somente as regiões atingidas pelo gesto. Levar o trabalho geométrico pesado necessário a worker com versões consistentes das entradas.

### 9. Alterações locais do terreno reenviam buffers inteiros

**Evidência:** [terrain.ts:2386](C:/Codex-Shared/roadcraft-2/src/render/terrain.ts:2386), linhas 2251 e 2492. Posições, normais, declividade e índices são marcados para atualização sem faixas. A implementação instalada de `WebGLAttributes` envia o array integral quando não há `updateRanges`.

**Consequência:** esses buffers podem subir integralmente após uma mudança pequena. A conta dos arrays é **5.342.748 bytes por placa**, caso os quatro buffers sejam enviados: posições e normais de 321² vértices, declividade e índices Uint32 de 320² × 6 entradas. É uma conta do código, não medição de tráfego.

**Solução:** acumular faixas alteradas por linha e aplicá-las aos quatro buffers, incluindo alterações ocorridas antes do próximo upload. Atualizar limites conservadores sem recalcular toda a placa quando possível. Os cálculos locais e a lista de vértices alterados já existem.

`addUpdateRange()` é o mecanismo documentado pelo Three.js para atualizar apenas partes do atributo. A proposta é aplicá-lo às regiões que o próprio código já identifica como alteradas. [Documentação do BufferAttribute](https://threejs.org/docs/pages/BufferAttribute.html).

### 10. Placas com carimbos rejeitam o resultado pré-calculado

**Evidência:** [terrain.ts:3084](C:/Codex-Shared/roadcraft-2/src/render/terrain.ts:3084). O caminho só aceita o resultado completo pré-calculado quando não há carimbos e também perde os dados de madeira nesse caso.

**Consequência:** a execução volta à reconstrução do terreno, triangulação e normais na thread principal.

**Solução:** incluir carimbos locais e demais entradas necessárias no trabalho do worker; aceitar o resultado completo quando suas versões coincidirem. Preservar a matemática e os vértices produzidos.

### 11. Pintura de cobertura reinicia uma varredura global

**Evidência:** [renderer.ts:2784](C:/Codex-Shared/roadcraft-2/src/render/renderer.ts:2784) chama novamente `coverSweep`, reconstruindo os conjuntos de candidatos. Pinturas comuns de solo/flores também podem avançar a revisão agregada de floresta.

**Consequência:** recria candidatos de florestas, arbustos e pedras, percorrendo regiões agregadas que também podem incluir grandes espaços vazios entre manchas. A nova coleção provoca reescrita ampla das células.

**Solução:** manter candidatos por célula e invalidar somente áreas das pinturas/água alteradas e suas dependências. Separar revisões conforme o tipo de cobertura afetado. O recorte posterior existente não evita a reconstrução anterior.

### 12. Residência dos prédios cresce com as regiões visitadas na perspectiva

**Evidência:** [renderer.ts:2997](C:/Codex-Shared/roadcraft-2/src/render/renderer.ts:2997) mantém alcance infinito na perspectiva; [layer.ts:656](C:/Codex-Shared/roadcraft-2/src/render/buildings/layer.ts:656) condiciona a liberação ao alcance finito.

**Consequência:** caminhar pode conservar detalhes de todas as células visitadas. Na ortográfica há descarte, mas o retorno solicita nova emissão.

**Solução:** separar armazenamento dos derivados e residência na GPU. Conservar resultados completos, versionados e comprimidos sem perdas; recarregar os mesmos dados, sem reemitir a geometria. O gerenciamento de residência não deve reduzir alcance visível, detalhe ou qualidade.

## Outros problemas confirmados

| Item e evidência | Consequência e solução proposta |
|---|---|
| **13. Terreno distante permanece integral quando contém conteúdo; outras placas descartam trabalho já calculado.** [flatAtlas.ts:288](C:/Codex-Shared/roadcraft-2/src/render/flatAtlas.ts:288). | Memória cresce com conteúdo e o retorno a outras regiões refaz trabalho. Separar presença de conteúdo, derivados persistidos e residência visual. Gerenciar memória por bytes e reutilizar os resultados ao retornar, mantendo a resolução necessária à imagem. |
| **14. Pintura percorre o histórico inteiro para cada placa.** [flatAtlas.ts:429](C:/Codex-Shared/roadcraft-2/src/render/flatAtlas.ts:429). | Custo proporcional a placas × pinturas por alteração. Manter índice pintura → placas e atualizar somente entradas adicionadas/removidas, incluindo undo e operações que cruzem fronteiras. |
| **15. Elementos são reconstruídos como camada global por alterações de elementos ou terreno.** [renderer.ts:3327](C:/Codex-Shared/roadcraft-2/src/render/renderer.ts:3327). [elements.ts:267](C:/Codex-Shared/roadcraft-2/src/render/elements.ts:267) agrupa instâncias por modelo sobre o mapa inteiro. | Reamostragem/reenvio global e recorte grosseiro de instâncias. Atualizar por identidade e região; dividir instâncias em células. Indexar emissores, que também são percorridos por quadro. Preservar modelos, densidade e efeitos. |
| **16. Renderização visita toda a frota antes do recorte e reenvia estacionados visíveis.** [agents.ts:2120](C:/Codex-Shared/roadcraft-2/src/render/agents.ts:2120), linhas 2160 e 2372. | Custo por quadro cresce com a frota e repete escrita de dados estáticos. Consultar candidatos pelo índice espacial. Manter estacionados em conjuntos persistentes, atualizados somente por mudança de pose, aparência, chão ou nível de detalhe. O cache atual já evita parte do cálculo dos estacionados. |
| **17. Estacionamentos recompõem baias e procuram veículos por varredura global.** [lotTraffic.ts:286](C:/Codex-Shared/roadcraft-2/src/sim/agents/lotTraffic.ts:286), linhas 309 e 362. Caminhões repetem parte desse padrão. | Chamadas repetidas custam baias + veículos, mesmo para buscar num raio local. Manter conjuntos incrementais de baias livres/ocupadas, seleção ponderada atualizável e índice espacial dos veículos elegíveis. Preservar ordem, desempates e sequência aleatória. |
| **18. Índices de cruzamentos e despertar de sinais ainda têm invalidação global.** [world.ts:533](C:/Codex-Shared/roadcraft-2/src/sim/world.ts:533), linhas 600 e 725. | Reordenação e reconstrução de mapas dos cruzamentos, com despertar amplo após edição local. Atualizar mapas e ordenação somente para cruzamentos alterados. Acordar sinais cujas entradas efetivamente mudaram. |
| **19. Transporte ainda percorre paradas e pontos ferroviários após alterações locais.** [transit.ts:268](C:/Codex-Shared/roadcraft-2/src/sim/transit/transit.ts:268). | Uma caixa ampla pode provocar reconstrução de passagens da linha inteira. Indexar paradas e trechos ferroviários espacialmente, manter parada → linhas e atualizar apenas interseções atingidas pelas faixas modificadas. O transporte já tem partes incrementais; não é reconstrução integral genérica. |
| **20. Autosave particiona prédios, mas serializa todo o restante em uma cabeça única.** [chunkedSave.ts:120](C:/Codex-Shared/roadcraft-2/src/editor/chunkedSave.ts:120), linha 150. | Uma árvore/lote/poste alterado pode copiar e serializar todo o conteúdo não predial. Particionar também outras coleções por registros/células, deixando no cabeçalho apenas valores pequenos. Usar manifesto transacional e compatibilidade com saves existentes. |
| **21. Histórico incremental ainda procura diferenças percorrendo listas.** [docImage.ts:181](C:/Codex-Shared/roadcraft-2/src/world/docImage.ts:181). | Inserir no fim pode percorrer todo o prefixo anterior. Registrar inserções, remoções e intervalos modificados diretamente nos mutadores. Gerar patches sem comparar o prefixo/sufixo inteiro, mantendo ordem e reversibilidade. Registros de prédios/lotes já usam IDs e não têm esse mesmo problema nas edições usuais. |
| **22. Exportação mantém cópias e strings do mapa; importação exige texto e parse integrais.** [mapExport.ts:38](C:/Codex-Shared/roadcraft-2/src/editor/mapExport.ts:38) e [persistence.ts:583](C:/Codex-Shared/roadcraft-2/src/editor/persistence.ts:583). | Picos de memória e CPU; arquivo exportado em pedaços ainda precisa caber numa string no importador atual. Adotar leitura/escrita incremental com validação progressiva e restauração atômica. Manter suporte aos arquivos JSON antigos. |
| **23. Ragdolls ativos criam matrizes, vetores e paletas repetidamente.** [ragdoll.ts:1988](C:/Codex-Shared/roadcraft-2/src/render/ragdoll.ts:1988). | Alocações por corpo/osso/fragmento em cada quadro ativo. Corpos independentes próximos também podem duplicar campos de altura. Reutilizar buffers por corpo e compartilhar colisores estáticos por célula, com referências e invalidação pelo diário. Fragmentos já compartilham parte desses dados; corpos adormecidos já reutilizam paletas. |
| **24. Há atributos sem uso por determinados materiais e índices sempre de 32 bits.** [surfaceMesh.ts:406](C:/Codex-Shared/roadcraft-2/src/render/surfaceMesh.ts:406) e [cellArrays.ts:128](C:/Codex-Shared/roadcraft-2/src/render/buildings/cellArrays.ts:128). | Armazenamento e upload sem contribuição à imagem nos materiais identificados. Definir atributos por material em toda a cadeia de montagem/armazenamento. Usar índices de 16 bits somente quando o maior índice couber. Não exige quantização. |
| **25. Existência de controladores é tratada como movimento visual.** [main.ts:2864](C:/Codex-Shared/roadcraft-2/src/main.ts:2864). Até cruzamentos sem semáforo podem ter controlador. | Pode manter pedidos contínuos de quadro sem movimento correspondente. Basear o agendamento em transições visuais reais. A presença de um controlador adormecido não deve manter pedidos contínuos. Preservar a passagem correta do tempo de simulação. |
| **26. Sinais adormecidos ainda são visitados em cada tick.** [pipeline.ts:92](C:/Codex-Shared/roadcraft-2/src/sim/pipeline.ts:92). | Trabalho proporcional ao total de sinais mesmo sem agentes próximos. Manter conjunto ativo e representar o tempo de repouso pelo tick inicial, materializando-o antes das leituras necessárias. A equivalência temporal precisa ser demonstrada. |

Serialização e processamento pesado podem ser deslocados para workers, acompanhados da redução dos dados processados e copiados. Transferir buffers evita cópias quando a propriedade pode ser entregue ao outro contexto. Para importação/exportação, streams permitem processar dados progressivamente. Referências: [Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [objetos transferíveis](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) e [Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API).

## Pontos que exigem medição antes de decidir

- **Contabilidade incompleta de VRAM:** [memoryCounters.ts:32](C:/Codex-Shared/roadcraft-2/src/render/memoryCounters.ts:32) inspeciona a cena, mas não contabiliza integralmente render targets, anexos MSAA, sombras e mipmaps. Primeiro é necessário completar o inventário. Não há base nesta sessão para declarar consumo total de VRAM.
- **Assinaturas arquitetônicas sem o mesmo caminho de LOD das células:** podem manter geometria completa quando um produto derivado seria suficiente. O impacto depende das assinaturas visíveis; qualquer substituição precisa de comparação visual.
- **GTAO com cópia e composição em passes separados:** há oportunidade de fusão, condicionada à preservação da fórmula, precisão e ordem de cor.
- **Instrumentação instalada mesmo com profiler desligado:** [profilerHooks.ts:39](C:/Codex-Shared/roadcraft-2/src/render/profilerHooks.ts:39) continua interceptando chamadas e calculando dados. Medir com e sem hooks antes de priorizar. Não se pode assumir que todas as alocações aparentes sobrevivam às otimizações do V8.
- **Falha parcial ao iniciar o pool de conflitos:** [conflictPool.ts:94](C:/Codex-Shared/roadcraft-2/src/conflictPool.ts:94) pode criar workers antes de uma criação posterior falhar. O `catch` deve encerrar os já criados. É um problema de liberação de recursos num caminho excepcional, não um gargalo contínuo comprovado.

Não se recomenda reduzir resolução, sombras, densidade, distância visível ou MSAA como correção automática. Essas decisões alteram a qualidade gráfica e precisam de avaliação específica.

## Melhorias atuais e falsos positivos descartados

A leitura atual confirmou emissão/montagem de células de prédios em worker, atualizações locais em diversos derivados da rede, índices espaciais efetivamente utilizados e transporte parcialmente incremental.

Foram descartadas recomendações antigas sem sustentação atual:

- Mover a emissão de células para worker: essa implementação já existe.
- Atribuir overdraw ao céu antes da cena: o chamador atual desliga sua visibilidade antes do desenho.
- Considerar a simples existência de um render target como prova de VRAM alocada: sua utilização efetiva precisa ser verificada.
- Afirmar genericamente que transporte, névoa ou todas as plantas são reconstruídos integralmente: há caminhos atuais com diário e células.
- Classificar toda operação JSON ou toda ordenação local como gargalo: frequência e cardinalidade precisam justificar o achado.

## Sequência de solução e critérios de aceitação

1. **Completar a medição:** contar registros visitados, bytes copiados e bytes enviados, incluindo manutenção de caches e sinais adormecidos. Os contadores atuais deixam parte desse trabalho de fora.
2. **Eliminar custos globais das edições:** validação, clones, alturas, caches do grafo, agentes afetados e propostas de lotes.
3. **Eliminar reconstrução/reenvio global visual:** zoneamento, terreno, cobertura, elementos e estacionados.
4. **Separar derivados persistidos de residência na GPU:** prédios e terreno, com reutilização do trabalho já feito.
5. **Concluir persistência incremental:** histórico, autosave e arquivos grandes.
6. **Otimizar os custos restantes medidos:** alocações de física, passes, assinaturas e instrumentação.

Para cada correção, a aceitação deve exigir:

- Mesma edição local em mapas progressivamente maiores, contabilizando todo o trabalho percorrido, inclusive manutenção de índices e caches.
- Equivalência funcional de rotas, reservas, alturas, undo/redo e saves.
- Comparação visual nas mesmas câmeras e configurações, sem perda gráfica não autorizada.
- Medição de tempos de quadro, pausas de GC, uploads e memória após visitar e revisitar regiões.
- Verificação de alterações/remissões/undo nas fronteiras de células e de resultados atrasados dos workers.

Fatiar reconstruções globais, aumentar intervalos ou ampliar limites de testes não resolve as causas apontadas. Mudanças arquiteturais e de formato de armazenamento são propostas; não foram executadas.

## Verificações executadas na sessão da análise

### TypeScript

```powershell
node scripts/run-limited.mjs node node_modules/typescript/bin/tsc --noEmit --incremental false
```

**Resultado:** código de saída `0`, sem diagnósticos.

### Analisador estático do projeto

```powershell
node scripts/run-limited.mjs node scripts/acusar.mjs --json
```

O comando foi executado em pipeline para leitura e agrupamento de seu JSON no PowerShell.

**Resultado:** execução concluída. Seus alertas foram usados como pistas; não foram considerados automaticamente problemas comprovados.

### Testes direcionados

```powershell
node scripts/run-limited.mjs node node_modules/vitest/vitest.mjs run -c vitest.scale.config.ts tests/scale/edit.spec.ts tests/scale/buildingEdit.spec.ts tests/perf/budgets.spec.ts tests/perf/simScale.spec.ts --cache=false
```

**Resultado real:** 3 arquivos aprovados, 1 com falha; 6 testes aprovados e 1 falhou. O processo terminou com código de saída `1`. A falha foi:

```text
tests/perf/simScale.spec.ts
Error: Test timed out in 10000ms.
```

Não foram alterados testes, limites ou configurações. A falha por timeout não demonstra isoladamente qual componente consumiu o tempo. Os testes aprovados também não demonstram ausência dos custos que seus contadores não cobrem.

## Pendências e limites

Nenhuma solução foi implementada, conforme solicitado. O único arquivo criado para esta entrega é este relatório.

**NÃO VERIFICADO:** FPS, impacto individual em milissegundos, heap/VRAM reais, comparação visual, build e suíte completa.

Permanecem lacunas de leitura aprofundada em partes dos geradores de prédios, shaders, efeitos e processamento de pessoas. Este relatório oferece soluções para os problemas identificados, sem afirmar exaustividade nem ganhos ainda não medidos. As referências de linha correspondem ao código examinado em 15/10/2026 e podem se deslocar em alterações posteriores.
