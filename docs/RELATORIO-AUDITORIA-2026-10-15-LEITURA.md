# Relatório de Auditoria Somente de Leitura — Roadcraft 2

**Data:** 15 de Outubro de 2026  
**Ambiente Auditado:** Worktree `C:/Codex-Shared/rc2-wt/workers-10km` (ramo `fix/workers-10km`, HEAD `3780807490b034571307152c0dcb409bd4fb2d59`)  
**Condição:** Auditoria 100% SOMENTE LEITURA. Nenhum código de projeto foi modificado, criado, apagado ou executado. Sem `npm`, `vite`, `vitest`, scripts ou servidores.  
**Aviso de Valores:** Todos os números de bytes, contagens de elementos e tempos em milissegundos citados neste relatório são **ESTIMATIVAS ESTÁTICAS** baseadas exclusivamente na leitura do código-fonte.

---

## 1. Tabela Consolidada dos 18 Itens Auditados

| Item | Veredito | Evidência (`arquivo:linha`) e Descrição | Custo Estimado | Gravidade (10 km) | Correção Certa em UMA Frase |
|---|---|---|---|---|---|
| **1a. snapshotRoads / clone** | **PROCEDE** | `src/editor/editRules.ts:114–129`, `src/world/doc.ts:1844–1897`. `snapshotRoads` chama `doc.clone()` clonando mapas, nós e segmentos inteiros em vez de copy-on-write (`fork()`). | $O(N + S + B + \text{lotes})$, dezenas de MB por chamada (estimativa). | **Alta** | Executar a validação da regra em um `RoadDoc.fork()` transitório e só aplicar o delta se a edição for aceita. |
| **1b. changedSegments fallback** | **PROCEDE** | `src/editor/editRules.ts:143–158`. Se `roadIdsChangedFrom` responder `null`, percorre `doc.segments.values()` ($O(S)$) chamando `segmentKey()` em todas as vias. | $O(S)$ serializações de chaves em fallback (estimativa). | **Média/Alta** | Propagar IDs modificados explicitamente no diário de alterações evitando o fallback global de segmentos. |
| **2. lotTool overlay JSON** | **DEFASADO** (para JSON integral) / **PROCEDE** (para varredura) | `src/editor/lotTool.ts:138–185`, `src/main.ts:2831`. A chave agora usa `liveKey` com configs locais, mas `this.overlay(editing)` varre `doc.lots` a cada movimento do mouse (`this.hover`). | $O(\text{lotes})$ por evento de movimento do ponteiro (estimativa). | **Alta** | Indexar espacialmente os lotes visíveis e separar o desenho da seleção/hover do overlay geométrico estável. |
| **3. Network.adopt** | **PROCEDE** | `src/world/network.ts:277–295`, `src/world/networkBuild.ts:172–180`. `copyState()` e `copyFrom()` clonam dezenas de `Map`s e `Set`s de toda a malha viária a cada pausa ou commit. | $O(N + S + J + \text{fitas})$ cópias de referências de todo o mapa (estimativa). | **Crítica** | Compartilhar estruturas imutáveis da rede via copy-on-write e aplicar deltas somente às vias e junções afetadas. |
| **4a. elevation.ts varredura** | **PROCEDE** | `src/world/elevation.ts:448–524`, `line 1177`. `buildRoadElevation` varre `net.ribbons` do mapa todo; linha 1177 faz `JSON.stringify(rt.materials)`. | $O(\text{fitas do mapa}) + O(\text{estações})$ a cada rebuild viário (estimativa). | **Alta** | Isolar o cálculo de elevação às fitas contidas na bounding box da alteração viária. |
| **4b. lanelets.ts adoção** | **DEFASADO** (rota normal) / **PROCEDE** (exceções) | `src/world/lanelets.ts:254–327, 508–536`. Usa deltas e `reach()` normalmente, mas cai em `takeWhole(from)` se `delta === null`. | $O(\text{lanelets do mapa})$ quando delta é nulo (estimativa). | **Média** | Garantir que operações de edição sempre forneçam deltas parciais, eliminando o fallback síncrono total. |
| **4c. walk.ts:1247 anyoneWithin** | **DEFASADO** | `src/sim/agents/walk.ts:1241–1247`. Consulta substituída por `nearNow(stateOf(w)).someIn(...)` sobre grade espacial `WalkerGrid`. | Consulta espacial local $O(1)$ por célula (estimativa). | **Baixa** | Manter a consulta espacial e auditar eventuais alocações de buffers no A*. |
| **5a. pipeline.ts controladores** | **PROCEDE** | `src/sim/pipeline.ts:92`, `src/sim/signals/fsm.ts:204–206`. `w.signalisedControllers()` percorre todos os controladores sinalizados da cidade a cada tick de simulação. | $O(\text{controladores})$ a 60 ticks/s (estimativa). | **Média/Alta** | Agendar ativação de controladores por fila de prioridade de tempo (`nextChangeTime`) em vez de varredura ativa. |
| **5b. pipeline.ts varreduras de tick** | **PROCEDE** | `src/sim/pipeline.ts:167–210`. `snapshotInto`, `longitudinalConstraints`, `integrateAll` percorrem toda a frota ativa a cada tick. | $O(V)$ a cada tick (estimativa). | **Média** | Manter particionamento espacial de veículos para ativar apenas agentes em vias dinamicamente ativas. |
| **6a. ragdoll.ts wallsNear** | **PROCEDE** (com frequência corrigida) | `src/render/ragdoll.ts:533`, `src/render/playEffects.ts:274–311`. Não roda a cada quadro, mas é invocado no spawn/criação de corpo (`createBody`). | $O(\text{corpos criados} \times (V + \text{estacionados}))$ na criação (estimativa). | **Média** | Consultar veículos e obstáculos através de grades espaciais locais em vez de varrer arrays no spawn. |
| **6b. ragdoll.ts Float32Array** | **PROCEDE** | `src/render/ragdoll.ts:1421, 2034`. Linha 1421 em `risePalette`; linha 2034 em `palettes` aloca `new Float32Array(64)` por peça a cada quadro para corpos ativos. | Centenas de arrays tipados alocados por quadro por ragdoll ativo (estimativa). | **Média** | Pré-alocar e reutilizar paletas de matrizes e quaternions por corpo, escrevendo in-place. |
| **7. JSON / spreads em sim/editor** | **PROCEDE** | `src/sim/agents/lotTraffic.ts:156`, `src/sim/agents/lorryTraffic.ts:136`, `src/editor/buildings.ts:110, 247, 720`. Spreads de coleções e `JSON.parse(JSON.stringify)` em rotas quentes. | Alocação de arrays temporários a cada tick de simulação e micro-pausas no editor (estimativa). | **Média** | Iterar iteradores diretamente sem `[...values()]` e substituir clones JSON por cópias rasas estruturadas. |
| **8a. terrain.ts updateRanges** | **DEFASADO** (atributos) / **PROCEDE** (texturas) | `src/render/terrain.ts:786–2462`, `src/render/mesh/updateRanges.ts:7–28`. Atributos geométricos usam `markBox`, mas texturas de dados mantêm `needsUpdate = true` de textura inteira. | 16 MB por textura RGBA32F/RGBA8 a cada reenvio global (estimativa). | **Alta** | Implementar `texSubImage2D` regional para atualizar apenas a região correspondente aos retângulos pintados. |
| **8b. terrain.ts prebuilt descartado** | **PROCEDE** | `src/render/terrain.ts:3125–3128`. Se `doc.terrainStamps.length > 0` (ex: 25 stamps na cidade padrão), a malha pré-construída pelo worker é DESCARTADA na thread principal. | Reconstrução síncrona de 90.601 vértices de terreno na abertura da cidade (estimativa). | **Crítica** | Passar os stamps para o worker de terreno para que a malha pré-construída venha pronta e seja aproveitada. |
| **9a. flatAtlas.ts CACHE=6** | **DEFASADO** (CACHE=6) / **PROCEDE** (descarte) | `src/render/flatAtlas.ts:49, 299–306`. `CACHE=6` foi substituído por `KEEP_MARGIN=1.25`, mas `letGo(p)` anula `p.mesh` e `heights`, forçando reconstrução ao voltar. | Recriação completa de placas de vias e terreno quando a câmera retorna (estimativa). | **Alta** | Manter buffers de geometria em cache de LRU com orçamento explícito de MB em vez de destruição imediata. |
| **9b. flatAtlas.ts revisões globais** | **PROCEDE** | `src/render/flatAtlas.ts:347, 428–437`. `contentKey` concatena 7 revisões globais e filtra todas as pinturas do mapa por placa. | $O(\text{placas} \times \text{pinturas})$ a cada edição de pintura (estimativa). | **Média/Alta** | Associar pinturas espacialmente às placas via bounding box em vez de filtragem global iterativa. |
| **10a. renderer.ts coverSweep** | **PROCEDE** | `src/render/renderer.ts:2982`. Reavalia manchas de cobertura vegetal por chave global `${forestRevision}:${waterRevision}` sobre retângulos extensos. | Até dezenas de milhões de testes de ponto em grade 2,4 m no mapa inteiro (estimativa). | **Alta** | Particionar a vegetação rasteira em células espaciais e invalidar apenas as células sobrepostas pelo diário. |
| **10b. renderer.ts reach=Infinity** | **PROCEDE** | `src/render/renderer.ts:3196`, `src/render/buildings/layer.ts:656`. Em câmera perspectiva, `reach = Infinity`, anulando `Number.isFinite(reach)` e NUNCA liberando células da GPU. | Vazamento cumulativo de VRAM de prédios até crash por `GL_OUT_OF_MEMORY` (estimativa). | **Crítica** | Definir um raio de descarte finito baseado no frustum e na distância de visão da câmera perspectiva. |
| **10c. renderer.ts transporte e árvores** | **DEFASADO** | `src/render/renderer.ts:1757, 3010`. Migrado para produtos incrementais (`createTransit`) e células espaciais (`plantCells.ts`). | Atualizações agora são particionadas por item/célula (estimativa). | **Baixa** | Preservar a arquitetura celular existente e monitorar custos de instâncias. |
| **11a. Céu e overdraw** | **NÃO PROCEDE** | `src/render/environment.ts:350–359`, `src/render/renderer.ts:3262–3270`. A esfera do céu tem `depthTest: false`, mas é ocultada antes do passe de pós-processamento. | Sem overdraw de tela cheia comprovado no pipeline final montado (estimativa). | **Baixa** | Não alterar a ordem de desenho do céu sob esta alegação. |
| **11b. GTAO alvos extras** | **PROCEDE** | `src/render/postprocess.ts:262, 287`, `three GTAOPass:491–578`. Criação de `normalRenderTarget` inutilizado e execução de dois passes adicionais em tela cheia. | ~16 MB de buffers e passes de cópia/blend full-res redundantes (estimativa). | **Média** | Fundir os passes de cópia e blend do ambient occlusion diretamente no passe final de composição. |
| **12a. gardens.ts bushFlowering** | **PROCEDE** | `src/render/gardens.ts:36–60, 284–287`. Capacidade de instâncias de `bushFlowering` dobra geometricamente alocando arrays paralelos para `body` e `cards`. | 52 MB + 52 MB = 104 MB de buffers em cidades médias (estimativa). | **Alta** | Dimensionar capacidade sob demanda ou combinar a geometria dos cartões na mesma chamada indexada. |
| **12b. Atributos mortos e não indexados** | **PROCEDE** | `src/render/roadGeometry.ts:150`, `src/render/structures.ts:413`, `src/render/vehicleModels.ts:296`. Atributos `color` e `roadSection` no verge (24 B/vert); malhas sem índice. | 30% a 50% de dados de vértices duplicados em estruturas e veículos (estimativa). | **Alta** | Indexar geometrias de modelos estáticos e remover atributos de vértice não consumidos pelos shaders. |
| **12c. Render targets fora do inventário** | **PROCEDE** | `src/render/inventory.ts`, `src/render/memoryCounters.ts`, alocações em `postprocess.ts` e sombras. Render targets e shadow maps somam ~770 MB a 1080p Ultra e não são contados. | ~770 MB de VRAM invisíveis aos medidores de diagnóstico interno (estimativa). | **Alta** | Registrar todos os `WebGLRenderTarget` e mapas de sombras no inventário central de memória de vídeo. |
| **13. Células de prédios longe na GPU** | **PROCEDE** | `src/render/buildings/layer.ts:656`, `src/render/renderer.ts:3196`. Não existe orçamento em bytes; em perspectiva (`reach = Infinity`), células distantes nunca saem da GPU. | Acúmulo de centenas de MB de VRAM ao explorar um mapa de 10 km (estimativa). | **Crítica** | Estabelecer teto rígido de VRAM (ex: 256 MB) com expulsão LRU de células fora do frustum visual. |
| **14a. chunkedSave.ts serialização** | **PROCEDE** | `src/editor/chunkedSave.ts:172, 179, 301–309`. `doc.withoutBuildings()` é serializado inteiro a cada alteração não predial; save inicial varre $O(B)$ prédios. | Compressão e serialização de dezenas de MB a cada salvamento com edição de vias (estimativa). | **Alta** | Particionar as coleções do cabeçalho (vias, lotes, postes) no IndexedDB da mesma forma que os prédios. |
| **14b. docImage.ts cópias de listas** | **PROCEDE** | `src/world/docImage.ts:117, 186–194`. Compara listas do documento por varredura ponta a ponta e duplica coleções com `structuredClone`. | $O(\text{tamanho da lista})$ em edições de árvores, barreiras e marcas (estimativa). | **Média/Alta** | Emitir patches pontuais diretamente das ações de mutação em listas em vez de diffing por varredura. |
| **15. conflictPool.ts catch de erros** | **NÃO PROCEDE** | `src/conflictPool.ts:98–99, 274, 283–287`, `src/world/waiting.ts:14–17`. Não há catch engolindo erros; rejeições de `Promise.all` são tratadas por `answered()` com fallback explícito. | Fallback devolve medições de pares de tráfego para a thread principal em caso de erro (estimativa). | **Baixa** | Manter o tratamento seguro e garantir encerramento gracioso de todos os workers em falha. |
| **16. profilerHooks.ts ativos** | **PROCEDE** | `src/render/profilerHooks.ts:18–60`, `src/main.ts:707`, `src/core/profiler.ts:88, 140–153`. Instalados incondicionalmente no boot; wrappers de WebGL rodam mesmo com profiler desligado. | Chamadas extras, alocação de closures (`a.find`) e leitura de `new Error().stack` por upload (estimativa). | **Média** | Envolver os métodos de WebGL apenas condicionalmente na inicialização do profiler ou usar flags atômicas inline. |
| **17. main.ts 60 FPS e revisões** | **PROCEDE** | `src/main.ts:2862–2871`, `src/render/renderer.ts:1127–3535`. `simShowsMotion()` força 60 FPS incondicionais se houver 1 semáforo; dezenas de gates de revisão rodam a cada quadro. | Queda de eficiência energética e avaliações redundantes em frames estáticos (estimativa). | **Alta** | Ativar o laço de desenho contínuo apenas se houver entidades dinâmicas realmente visíveis na câmera. |
| **18. Heap de JS por prédio** | **PROCEDE** (como estrutura) / **ESTIMATIVA** (bytes) | `src/world/buildings/types.ts:105–441`, `src/world/buildings/store.ts:20–60`, `src/render/buildings/layer.ts`. Árvores de objetos complexas retidas simultaneamente em 7+ subsistemas. | ~10 KB a 80 KB de heap por prédio retido; múltiplos GB em 80.000 prédios (estimativa). | **Crítica** | Unificar dicionários de bays e materiais em inteiros indexados e liberar buffers da CPU após envio à GPU. |

---

## 2. Detalhamento Técnico das Investigações

### 2.1. Simulação e Editor

#### Item 1: `src/editor/editRules.ts` — `snapshotRoads` e `changedSegments`
- **Leitura realizada:** Em `src/editor/editRules.ts:114–129`, a função `snapshotRoads(doc)` executa explicitamente:
  ```ts
  return { doc: doc.clone(), version: doc.revision };
  ```
- **Chamadores:** `guardRoadEdit` (`editRules.ts:129`) e `commitDraftSingle` (`src/editor/commit.ts:395`). A cada pausa do mouse durante o traçado de uma via (debounce de 120 ms) ou ao testar regras viárias, `doc.clone()` duplica integralmente todas as coleções do documento (`src/world/doc.ts:1844–1897`), incluindo nós, segmentos, árvores, barreiras, lotes e referências de prédios. Não utiliza `fork()` (copy-on-write).
- **changedSegments:** Em `editRules.ts:143–158`, se a chamada a `roadIdsChangedFrom` falhar (retornar `null`), o código cai em:
  ```ts
  for (const s of doc.segments.values()) keysNow.set(s.id, segmentKey(s));
  ```
  Isso percorre **todos** os segmentos do mapa ($O(S)$) e gera serializações em string para detectar mudanças.

#### Item 2: `src/editor/lotTool.ts` — Overlay de Lotes
- **Leitura realizada:** No commit `3780807`, a linha 150 foi atualizada com `liveKey`, que evita o `JSON.stringify` de todo o array geométrico do overlay.
- **Porém:** Em `src/editor/lotTool.ts:148–185`, o método `this.overlay(editing)` continua executando `for (const l of doc.lots)` ($O(\text{lotes})$). Como `main.ts:2831` chama o overlay a cada quadro em que o cursor se move (`this.hover` é atualizado a cada evento de mouse), a recomposição do overlay percorre todos os lotes cadastrados na cidade sem particionamento espacial.

#### Item 3: `Network.adopt` — Cópia Integral da Rede Viária
- **Leitura realizada:** Em `src/world/network.ts:277–295`:
  ```ts
  copyState(from: Network): void {
    copyMap(from.junctions, this.junctions);
    copyMap(from.ribbons, this.ribbons);
    copyMap(from.trims, this.trims);
    copyMap(from.scale2, this.scale2);
    // ... dezenas de mapas clonados
  ```
  E em `src/world/networkBuild.ts:172–180`, `this.build.copyFrom(from.build)` duplica índices espaciais, células e associações. A cada edição aceita ou preview viário, o estado completo de todas as vias de 10 km é clonado por valor nos dicionários.

#### Item 4: `elevation.ts`, `lanelets.ts`, `walk.ts`
- **elevation.ts:** `buildRoadElevation` (`src/world/elevation.ts:448`) itera sobre `net.ribbons` do mapa inteiro para sincronizar estações de vias, mesmo quando a alteração ocorre em uma única esquina. Na linha 1177, executa `JSON.stringify(rt.materials)`.
- **lanelets.ts:** O caminho comum foi otimizado com `reach()` e deltas, mas em `lanelets.ts:508–536`, se `delta === null`, recorre a `takeWhole(from)`, que refaz todas as conexões viárias do mapa.
- **walk.ts:** A acusação sobre `anyoneWithin` varrer todos os pedestres está **DEFASADA**. O código atual em `walk.ts:1241–1247` utiliza `WalkerGrid` (`nearNow(stateOf(w)).someIn(...)`) com busca espacial celular.

#### Item 5: `pipeline.ts` — Controladores de Sinal e Varreduras por Tick
- **Leitura realizada:** Em `src/sim/pipeline.ts:92`:
  ```ts
  for (const c of w.signalisedControllers()) c.tick(dt, ...);
  ```
  Todos os controladores semafóricos da cidade são iterados a cada tick (60 vezes por segundo), independentemente de estarem em repouso visual ou longe da câmera. Além disso, as etapas de integração física (`pipeline.ts:167–210`) varrem incondicionalmente todos os veículos da simulação.

#### Item 6: `ragdoll.ts` — Frequência Real de Alocações
- **wallsNear (`ragdoll.ts:533`):** Não é chamada a cada quadro; ocorre na criação/instanciação do corpo rígido (`createBody`). No entanto, varre veículos e obstáculos sem filtro espacial abrangente.
- **Float32Array (`ragdoll.ts:2034`):** Na função `palettes`, executada a cada quadro para corpos ativos:
  ```ts
  const palette = new Float32Array(64);
  ```
  Aloca um array tipado por osso/peça a cada frame de animação física, gerando pressão contínua no Garbage Collector.

#### Item 7: Padrões `[...values()]` e `JSON` em Sim/Editor
- Em `src/sim/agents/lotTraffic.ts:156`: `[...this.cars.values()]` aloca arrays a cada tick de simulação.
- Em `src/sim/agents/lorryTraffic.ts:136`: `[...this.lorries.values()]` a cada tick.
- Em `src/editor/buildings.ts:110, 247, 295, 720, 741`: `JSON.parse(JSON.stringify(...))` é utilizado reiteradamente para duplicar definições de volumes e materiais.

---

### 2.2. Renderização e GPU

#### Item 8: `terrain.ts` — Atualizações e Descarte de Prebuilt
- **Atributos de Vértices:** O helper `markBox` (`addUpdateRange`) foi integrado para `position`, `normal` e `steep` (commit `1b36572`).
- **Texturas de Terreno:** `paintArray`, `groundTexture` e `ecologyTexture` continuam utilizando `needsUpdate = true` de textura inteira (`terrain.ts:786–1066`), reenviando até 16 MB por textura à GPU mesmo para pequenas pinceladas de 2 metros.
- **Descarte de Prebuilt (Crítico):** Em `src/render/terrain.ts:3125–3128`:
  ```ts
  if (doc.terrainStamps.length === 0 && prebuilt) {
    // aproveita a malha do worker
  } else {
    // descarta o prebuilt e recalcula todos os 90.601 cantos síncronamente na thread principal!
  }
  ```
  Como o mapa padrão possui 25 stamps de terreno, a malha calculada pelo Web Worker durante a inicialização é sumariamente jogada fora, travando a thread principal no carregamento da cidade.

#### Item 9: `flatAtlas.ts` — Retenção e Expulsão de Placas
- O limite estático de `CACHE = 6` foi substituído pelo parâmetro `KEEP_MARGIN = 1.25` por distância.
- Porém, quando uma placa sai da margem de visão, `letGo(p)` anula `p.mesh = null` e `p.heights = null`, liberando a geometria da GPU. Ao retornar com a câmera, a placa precisa ser completamente solicitada e reconstruída pelo worker.
- Além disso, a chave `contentKey` concatena 7 revisões globais, invalidando placas de vias desnecessariamente.

#### Item 10: `renderer.ts` — Vazamento de Células de Prédios e Sweeps
- **reach = Infinity (Crítico):** Em `src/render/renderer.ts:3196`:
  ```ts
  const reach = view.isPerspective ? Infinity : reachOrtho;
  ```
  Em `src/render/buildings/layer.ts:656`:
  ```ts
  if (Number.isFinite(reach)) {
    // descarta células fora do raio
  }
  ```
  Como `Number.isFinite(Infinity)` é **falso**, o mecanismo de descarte de células de detalhe predial na GPU **nunca é executado em projeção perspectiva**! Ao navegar por um mapa de 10 km, toda célula de prédio visitada permanece eternamente na VRAM.
- **coverSweep (`renderer.ts:2982`):** Continua condicionado à revisão global `${forestRevision}:${waterRevision}`, disparando varreduras de cobertura vegetal sobre grandes áreas quando ativado.
- **Transporte e Árvores:** As acusações históricas sobre `transitAreaOf` e `buildGroundCover` estão **DEFASADAS**, pois já foram substituídas por arquiteturas celulares em commits anteriores.

#### Item 11: Céu e GTAOPass
- **Céu:** `environment.ts:350–359` cria o céu com `depthTest: false`, mas em `renderer.ts:3262–3270` o céu é desativado antes da passagem do pós-processamento, não produzindo overdraw residual contínuo.
- **GTAOPass:** Em `src/render/postprocess.ts:262, 287`, o passe aloca um `normalRenderTarget` ($1920 \times 1080 \times 8\text{ B} \approx 16\text{ MB}$) que não é utilizado na geração de cena padrão, além de executar dois passes adicionais de full-screen quad para cópia e mesclagem.

#### Item 12: Memória de Vídeo (VRAM)
- **gardens.ts:36–60:** `bushFlowering` aloca arrays paralelos de instâncias duplicando capacidade para `body` e `cards` (52 MB + 52 MB em cidades moderadas).
- **Verge de Vias (`roadGeometry.ts:150`):** Aloca incondicionalmente atributos de vértice `color` e `roadSection` (24 bytes por vértice) que não são manipulados pelos shaders principais.
- **Estruturas e Veículos não indexados:** Geometrias em `structures.ts:413` e `vehicleModels.ts:296` não utilizam indexBuffer, duplicando dados de posição e normais.
- **Render Targets e Shadow Maps:** Somam aproximadamente **770 MB de VRAM** em resolução 1080p Ultra e **NÃO** são monitorados por `inventory.ts` nem por `memoryCounters.ts`.

#### Item 13: Células de Detalhe sem Orçamento na GPU
- Em conjunto com o problema do Item 10b (`reach = Infinity`), não existe teto de memória de vídeo configurado para `massCells.ts`. O jogador que percorrer o mapa acumula milhares de matrizes de instâncias até que o driver de vídeo force a queda da aba com erro de contexto perdido (`GL_OUT_OF_MEMORY`).

---

### 2.3. Dados, I/O e Thread Principal

#### Item 14: `chunkedSave.ts` e `docImage.ts`
- **chunkedSave.ts (linha 179):**
  ```ts
  if (head) put.push([`${this.key}:head`, await gzip(JSON.stringify(doc.withoutBuildings()))]);
  ```
  Se qualquer elemento que não seja prédio mudar (vias, árvores, terreno, barreiras), a função `withoutBuildings()` serializa e compacta integralmente todos os nós, segmentos e elementos urbanos do mapa em um único bloco.
- **docImage.ts (linhas 117, 186–194):** Ao comparar alterações para undo/redo, listas como `trees` e `elements` são comparadas ponta a ponta com `samePlain` e clonadas com `structuredClone`. Para estimar o tamanho em bytes do patch (`bytesHeld`), invoca `JSON.stringify` sobre todas as mudanças.

#### Item 15: `conflictPool.ts` — Tratamento de Erros e Rejeição
- **Veredito: NÃO PROCEDE a acusação de que há `catch` engolindo erro silenciosamente.**
- **Leitura realizada:** Em `src/conflictPool.ts:98–99, 274, 283–287`:
  Se os workers não estiverem disponíveis, retorna `Promise.reject(new Error(...))`. Quando um worker falha, `this.fail(...)` encerra os workers e chama `job.reject(error)` em todas as promessas pendentes.
- **Quem trata a rejeição:** A função generator `answered()` em `src/world/waiting.ts:14–17`:
  ```ts
  asked.then((value) => { answer.value = value; }, (error: unknown) => {
    console.warn(`[traffic] the conflict workers failed; ${what} on the page`, error);
    answer.failed = true;
  });
  ```
  Ao detectar `answer.failed = true`, `answered()` cede e retorna `null`. O chamador (`conflictPoints.ts:205`) detecta `table === undefined` e executa o fallback computacional na thread principal. O erro é diagnosticado no console e tratado de forma resiliente.

#### Item 16: `profilerHooks.ts` — Overhead com Profiler Desligado
- **Leitura realizada:** `hookProfiler` é chamado incondicionalmente no boot em `src/main.ts:707`.
- Ele encapsula os métodos `gl.bufferData`, `gl.bufferSubData`, `gl.texImage2D`, `setAttribute` e `dispose`.
- O profiler vem ligado por padrão (`enabled = true` em `profiler.ts:88`), fazendo com que `stackHere()` invoque `new Error().stack` (leitura cara da engine V8) nas primeiras 48 chamadas de cada quadro e a cada 16 chamadas subsequentes.
- Mesmo se `profiler.enabled` for desativado, os wrappers em `gl.bufferData` continuam ativos, executando `bytesOf()`, alocação de closures (`a.find`) e desvios de método a cada upload.

#### Item 17: `src/main.ts` — Renderização On Demand vs 60 FPS Contínuos
- **Leitura realizada:** Em `src/main.ts:2862–2871`:
  ```ts
  const simMoving = !game.paused && simShowsMotion();
  if (!document.hidden && (simMoving || roadTool.draft || ...)) requestDraw();
  ```
  E a definição de `simShowsMotion()`:
  ```ts
  function simShowsMotion(): boolean {
    return sim.vehicles.size > 0 || sim.pedViews.length > 0 || sim.city.lots.moving() > 0 || sim.controllers.size > 0 || hasTransit(doc.transit);
  }
  ```
  Se houver **apenas 1 semáforo** na cidade inteira (`sim.controllers.size > 0`) ou 1 veículo, `simShowsMotion()` retorna verdadeiro, forçando renderização contínua a 60 quadros por segundo mesmo quando nada se move no campo de visão do jogador.
- A cada quadro dentro de `scene.draw()`, ocorrem mais de 10 leituras de gates de revisão global (`terrainRevision`, `paintRevision`, `utilityRevision`, `treeRevision`, `gullyRevision`, etc.), reavaliando sistemas inteiros na menor alteração do documento.

#### Item 18: Heap de JS por Prédio e Medição via CDP
- **Estruturas Retidas por Prédio:**
  1. `Building` em si: Árvore complexa de objetos contendo `Volume[]`, `Storeys[]`, `Facade` (com dicionários de strings para cada baia `"side:index"`), `MaterialSpec[]`, `RoofDetails[]` e `Elements[]`.
  2. `BuildingStore` (`doc.buildings`): Retido no mapa principal e nos conjuntos de células do grid espacial interno.
  3. `DocImage.records`: Duplicado integralmente por referência para controle de histórico.
  4. `BuildingLayer`: Mantido em `kept` (meshes ativas), `sent` (em processamento) e `groundDigests` (hashes de elevação de terreno).
  5. Índices de Simulação: `ambient.walls`, `ambient.places`, `ambient.buildingMix`, `BuildingOrder.ranks`, `sitesGraded` e `plantLists`.
  6. `massCells`: Dados de instâncias mantidos na memória da CPU antes do envio.
- **Tamanho Estimado:** Entre 10 KB e 80 KB de objetos JS associados por prédio. Numa cidade de 80.000 prédios, a retenção total ultrapassa facilmente 3 a 5 GB, atingindo o limite de heap do V8.
- **Forma Confiável de Medição (Proposta, sem execução):**
  Utilizar a amostragem de alocações da V8 via Chrome DevTools Protocol (CDP):
  ```json
  HeapProfiler.startSampling({ "samplingInterval": 32768 })
  ```
  Durante o carregamento ou geração de cidade, seguida de `HeapProfiler.stopSampling()`. Isso produz um perfil estatístico exato de alocação por função e tipo de dado sem incorrer no congelamento devastador de 30+ segundos do `takeHeapSnapshot`.

---

## 3. Lista de Achados Novos (Fora da Lista Inicial)

1. **Descarte Imediato da Malha de Terreno do Worker (`src/render/terrain.ts:3125`):**
   O Web Worker de terreno constrói a geometria prévia em segundo plano, mas se `doc.terrainStamps.length > 0`, a thread principal joga fora o resultado e recalcula todos os 90.601 vértices de terreno de forma síncrona. A cidade padrão possui 25 stamps, anulando o ganho do worker na inicialização.
2. **Desativação Total de Culling de Células de Prédios em Perspectiva (`src/render/renderer.ts:3196` + `src/render/buildings/layer.ts:656`):**
   `reach = Infinity` em câmera perspectiva faz com que `Number.isFinite(reach)` retorne `false`, bloqueando permanentemente a liberação de células de prédios da memória de vídeo.
3. **Alocação de Arrays Intermediários por Tick em Frotas Comerciais (`src/sim/agents/lotTraffic.ts:156` e `lorryTraffic.ts:136`):**
   Chamadas a `[...this.cars.values()]` e `[...this.lorries.values()]` criam novos arrays a cada passo da simulação, gerando lixo desnecessário no laço quente.
4. **Alocação Excessiva e Duplicada em Jardins (`src/render/gardens.ts:36–60`):**
   `bushFlowering` aloca arrays para `body` e `cards` com expansão geométrica desproporcional, consumindo mais de 100 MB de buffers para vegetação ornamental.
5. **Invisibilidade Total de Render Targets e Sombras no Diagnóstico (`src/render/inventory.ts`):**
   Cerca de 770 MB de alocações da GPU em alvos de renderização e shadow maps não constam nos contadores de memória do jogo, impossibilitando diagnósticos reais de consumo pelo HUD.

---

## 4. O Que Não Foi Possível Conferir e Por Quê

1. **Tempos Exatos de Execução em Milissegundos:** Não foi executado nenhum benchmark, profiling ativo ou comando `node/vite/vitest`, em estrito cumprimento ao mandato **somente de leitura**. Todos os tempos citados em relatórios anteriores são tratados como estimativas históricas não revalidadas.
2. **Consumo Físico de Memória do Driver de Vídeo:** A fragmentação interna de VRAM e o comportamento de alocação de buffers específicos das placas Nvidia/AMD/Intel dependem da execução do driver gráfico no sistema operacional, que não pôde ser aberto.
3. **Varredura Completa de Todas as Blueprints do Editor:** Ferramentas secundárias como `buildingTool.ts` possuem mais de 4.000 linhas com dezenas de ramificações para manipulação de telhados e varandas; nem todas as rotas de edição de elementos decorativos tiveram o rastreamento fechado de ponta a ponta.

---

## 5. Ordem Recomendada de Correção

Com base no critério de **viabilidade de escala para 10 km × 10 km** e eliminação de custos $O(\text{mapa})$:

1. **Corrigir `reach = Infinity` e adicionar Teto de VRAM nas Células de Prédios (`layer.ts` / `renderer.ts`):**
   Substituir `reach = Infinity` em perspectiva por um raio de corte baseado no frustum visual e implementar limite máximo de VRAM para evitar vazamento cumulativo e crash por `GL_OUT_OF_MEMORY`.
2. **Preservar a Malha Pré-construída de Terreno com Stamps (`terrain.ts` / `flatGround.worker.ts`):**
   Passar os `terrainStamps` para o Web Worker de terreno para que a geometria inicial seja aproveitada na íntegra, eliminando o congelamento síncrono de 90.601 vértices na thread principal ao abrir a cidade.
3. **Substituir `doc.clone()` em `snapshotRoads` e Cópia Total em `Network.adopt`:**
   Adotar semântica copy-on-write (`doc.fork()`) para validação de regras de tráfego e compartilhar referências imutáveis da rede viária, atualizando apenas as vias e cruzamentos modificados.
4. **Isolar Texturas de Terreno com Atualização Sub-regional (`terrain.ts`):**
   Substituir os `needsUpdate = true` de textura inteira em `paintArray`, `groundTexture` e `ecologyTexture` por atualizações parciais via `texSubImage2D` delimitadas pelas caixas de colisão das pinceladas.
5. **Particionar Coleções de Cabeçalho no Salvamento (`chunkedSave.ts`):**
   Evitar que qualquer alteração de vias ou postes force a serialização integral de `doc.withoutBuildings()`, particionando as coleções viárias em blocos assim como foi feito para os edifícios.
6. **Remover Wrappers Ativos do Profiler quando Desativado (`profilerHooks.ts`):**
   Restaurar as funções nativas de WebGL quando o profiler estiver desabilitado e remover leituras de stack trace (`new Error().stack`) em rotas comuns de upload de buffers.
7. **Eliminar Alocações em Laço Quente na Simulação (`ragdoll.ts`, `lotTraffic.ts`, `lorryTraffic.ts`):**
   Reutilizar paletas de `Float32Array` nos corpos rígidos e iterar diretamente sobre valores de mapas de tráfego sem intermediários `[...map.values()]`.
