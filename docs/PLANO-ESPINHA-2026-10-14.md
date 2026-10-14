# Plano: construir a espinha que falta (célula + derivado incremental) e acabar com a regeneração indevida

## Contexto
Roadcraft 2 é lento e pesado porque dezenas de produtos derivados do documento (malhas, índices,
listas da simulação, camadas) cobrem o mapa inteiro e se refazem por inteiro quando uma revisão
global muda. A arquitetura certa já está especificada no próprio repositório
(✔ `docs/PESQUISA-CIDADE-10KM.md` §8.1-8.2: células de 256 m como unidade de streaming, ladrilhos de
1.024 m com construção em worker, placas de 2.048 m; "todo o resto roda em worker") e o relatório
de 11/10 já recomendava a espinha (✔ `docs/source/relatorio-desempenho-mapas-enormes-2026-10-11.md:114`
"Uma única partição espacial do mundo ... como espinha de tudo"). Ninguém construiu a espinha:
três conversas e ~9 agentes remendaram ponto a ponto o código antigo. Resultado medido: 3 diários
de mudança (✔ `ChangeJournal`, `DeltaLog`, `GroundChanges`), 14 leituras do diário à mão em 12
arquivos (✔ grep de `.since(`), fórmulas próprias de chave de célula em 37 arquivos além de
`cells.ts` (✔ grep), 2 árvores de Fenwick (✔ `lotPlaces.ts`, `openLots.ts`), 4 heaps próprios ao
lado de `@core/heap` (✔ `tactical.ts:73`, `destination.ts:26`, `cycles.ts:186`, `lotNav.ts:175`) — e
o jogo a ~20 fps na fatia, com o governador cortando metade da população (✔ medido em 14/10,
`roadcraft-look/2026-10-14T20-33-55-428Z/relatorio.json`: quadro p50 50,3 ms, p95 116,7 ms, passo do
sim p50 18,8 ms, `share` 0,52). Objetivo: construir a espinha uma vez, migrar tudo para
ela, provar igual, e remover os remendos que escondiam o custo.

## A história que explica tudo (lida nos documentos do repositório)
- ✔ `docs/PLAN.md:227-238` (12/10) tinha a ordem certa: F2 documento por comandos (desfazer/salvar por
  diferenças) → **F3 derivados por célula** ("grade fixa alimentada pelo diário; superfícies, chão,
  grama, estruturas, postes, mobiliário, faixas e cruzamentos com remendo local, calçadas, vagas,
  pátios e docas, prédios por célula; trânsito remapeado sem parar") → F4 arquivos grandes →
  F5 catálogo de shaders compilado na carga → F6 veículos → F7 pessoas → F8 sombras → F9 memória →
  F11 simulação.
- ✔ `docs/ARCHITECTURE.md:81-86` §3.2 escreveu as regras de todo derivado: declara o que lê (tipos
  do diário + células com vizinhança), refaz só células sujas, nunca chaveia cache em contador global.
- ✔ Em 13/10 a etapa "S Escala da cidade" passou na frente (`docs/PLAN.md:226`, "← ATUAL, ordem do
  jogador, 2026-10-13"). Da F2 só saiu o desfazer (F2a); da F3 só a F3a (✔ relatório de 14/10,
  `docs/RELATORIO-DESEMPENHO-2026-10-14.md:226`). Desde então, todas as conversas atacam sintomas que a
  F3 resolve pela estrutura. O plano definitivo é retomar a F3 como projetada, agora com o inventário.

## Diagnóstico
**Meus erros:** agi sem ler a memória do projeto (repeti o enxame que o jogador proibiu em 13/10);
vi o padrão e respondi com correção ponto a ponto; lancei agentes sem conferir a base (4 sobre o
código de 80 commits atrás); confundi movimento com resultado; joguei decisões no jogador; disse
"já existe" por ter achado um nome (o `BatchedMesh`, que só aparecia num comentário).
**Ambiente:** memória partida por conversa (projeto, pastas temporárias); ✔ CLAUDE.md:51 e
ORDENS.md:17 ("Agentes livres") contradizem a memória do projeto; ✔ memory/ESTADO.md (14.665
bytes) importado em toda conversa; hook de pesquisa reabre a cada mensagem que chega no meio do
trabalho (ritual); três conversas no mesmo diretório, índice e servidor 5300; ✔ worktrees do Agent
tool nascem do ramo padrão, não do HEAD (doc oficial de subagentes), e o `origin/main` está 80
commits atrás (nunca enviado); ✔ `src/sim/CLAUDE.md` cita `sim/peds/state.ts`, `publish.ts`,
`behaviour.ts`, `corridor.ts`, que não existem (`sim/peds` só tem `sidewalk.ts`).

**Conferido por mim (comando → resultado):** `git rev-list --count origin/main..main` → 80;
`git reflog show worktree-agent-a799…` → "Created from origin/main"; `main.ts:4263`
`change.ids ?? []` + `store.ts:217/246/261` `this.changed(null, …)` → o desgaste ignora
limpar/carregar; `grep changesSince(` fora de network.ts → nenhum consumidor; CLAUDE.md:51 e
ORDENS.md:17 "Agentes livres" × memória do projeto "NÃO lançar agentes".

## Dados de execução (✔ recontados do arquivo `roadcraft-look/2026-10-14T20-21-01-230Z/10-sim.cpuprofile`, 16,3 s, cidade semente 1, fatia de 25%; tempo inclusivo por função)
- Desenho 44,4% (`draw` renderer.ts:2842 → `RenderPass` da cena 32,5%); tempo próprio em código
  nativo/GL 35,9% e dentro do three 21,3% (chamadas de desenho e troca de estado).
- Passo da simulação 28,4% (`step` pipeline.ts:39): caminhões (`lorryTraffic.step` 4,3% →
  `lorryDocks.step` 4,0% → `hybridAStar.run` 3,6%, o A* dentro do passo); admissão nos cruzamentos
  4,5% (`stepAdmission`); restrições longitudinais 5,0%; pedestres 4,4% (`walk.step`); integração
  3,9%; poses 2,1% (`vehiclePoseInto`).
- Desenho por quadro do lado da CPU: `agents.sync` 5,7%, `signals.sync` 1,3%, `deckHeight`
  (renderer.ts:688) 1,2%, simplificação de LOD das pessoas na página (`simplifyIndex`, chamada
  síncrona em `crowdLod.ts:256`) 1,2%.

## Arquitetura alvo (a espinha)
Fontes: Unity Entities change filter (versão por bloco e tipo; quem só lê não marca), Salsa (saída
igual não propaga), Jane Street Incremental (agregado pela diferença com inverso), Unreal World
Partition / 3D Tiles (célula como unidade de residência).
1. **Grade única** (`src/world/cells.ts`): 256 m alinhada às placas (chave Morton), com subdivisão
   64 m e ladrilho 1.024 m; `CellFiling` com tamanho de célula por instância, versão por célula
   ligada ao serial do diário e "células mudadas desde o serial".
2. **Um diário, um cursor** (`src/world/changes.ts`): `JournalCursor` com a semântica única
   (entrada sem ids = releitura; diário esquecido = releitura; documento trocado = releitura) e
   operação por id estruturada (added/removed/replaced/wear) em vez do texto de `detail`.
   `GroundChanges` e `DeltaLog` viram tipos do mesmo diário; `dirtyNodes/dirtySegments` saem.
3. **Derivado incremental** (arquivo novo `derived.ts` em `src/world`): `Derived<K,V>` declara os tipos que lê,
   como uma mudança vira chaves sujas (ids, ou células dos retângulos alargados pelo alcance),
   `compute(key)` e `equals` (corte); `refresh()` refaz só as chaves sujas e diz quais mudaram, para
   o derivado seguinte. `Aggregate` (somas e listas do mapa pela diferença), `OrderedIds` (uma ordem
   estável), `Fenwick` (uma), `expandNetworkDelta` (uma). **Instrumentação embutida**: cada
   `Derived` conta o que computou por evento, então todo produto convertido ganha de graça o teste
   de escala (N vs 4N) e o de quadro parado (zero computação sem mudança).
4. **Teste genérico de equivalência**: para qualquer `Derived`, edições aleatórias com semente,
   incremental igual ao recomputado do zero. Prova cada conversão sem teste novo escrito à mão.

## O controlador global (a espinha é um motor só, não vários remendos)
Fonte: Salsa, "algorithm" (salsa-rs.github.io/salsa/reference/algorithm.html): entrada que muda
avança a revisão; cada derivado guarda de que dependeu; só recalcula se uma dependência mudou; saída
igual à velha é "backdated" e não propaga. Unity Entities (filtro de mudança por bloco) e Jane
Street Incremental (um grafo, um `stabilize`) fazem o mesmo.
- **Um motor central** (arquivo novo `engine.ts` em `src/core`) é o ÚNICO que sabe o que mudou e o ÚNICO que manda
  recalcular. Entradas dele: o documento (pelo diário, por tipo e por célula), a câmera/vista, o
  relógio da simulação e a qualidade. Cada uma tem revisão própria.
- **Todo produto derivado se registra** (o que lê, como uma mudança vira chave suja, `compute`,
  `equals`). Nenhum produto agenda a própria refeitura nem lê revisão global: a API não as expõe, e a
  regra estática acusa `.revision`/`serialOf` fora do motor.
- **O laço chama `engine.refresh()`** uma vez por quadro (e o passo da simulação, uma vez por passo),
  em ordem de dependência; só as chaves sujas computam; saída igual corta a propagação. Isso cobre
  também o que hoje roda em todo quadro sem nada ter mudado (✔ conferidos: recorte dos jardins,
  `levelOfDetail` por célula, agentes parados, `playEffects.frame`, grama oculta): recorte,
  LOD, sombra e agentes parados dependem da vista, e a vista parada não suja nada.
- **Livro-razão embutido:** o motor conta cada computação por evento. Quadro parado = zero
  computações; um produto que computa sem dependência suja é acusado na hora, com o nome (em
  desenvolvimento e na checagem rápida). É o vigia global do trabalho desnecessário.
- **Não é freio:** o motor nunca adia, fatia ou espaça trabalho (isso é amortização, C8); ele faz
  o trabalho desnecessário não existir. O trabalho necessário e pesado vai para worker (C4).

## O gerenciador global de estado e de eventos (e os outros serviços centrais que faltam)
Fonte: Game Programming Patterns, "Event Queue" (gameprogrammingpatterns.com/event-queue.html):
desacoplar o envio do processamento; a fila é esvaziada pelo laço; o evento carrega os dados de
quando aconteceu; quem trata um evento não envia outro no mesmo passo.
**Estado e eventos.** ✔ `core/gameState.ts` nasceu do pedido do jogador em 08/10 (o próprio
cabeçalho cita o pedido) e cobre 30 chaves de ferramenta, seleção e sessão (✔ main.ts:367-405; as
escritas são todas em main.ts, onde há 40 chamadas de `set`/`watch`; ui/v2/shell.ts só observa, com 7
`watch`). Fora dele (✔ contado por grep em src/): o estado da ferramenta de prédios
(`sigOf` em JSON, shell.ts:2133), a câmera, a simulação, 24 variáveis de módulo em main.ts (`let`,
`Map` e `Set` no topo), e todo o fluxo de eventos: 72 `addEventListener` (15 arquivos) contra 5
`removeEventListener`, 8 `setInterval` (7 arquivos) e 23 `setTimeout` (14 arquivos), 9
`requestAnimationFrame` em 5 arquivos (mais de um laço de quadro), crescimento da cidade por
`setInterval` de 500 ms no relógio de parede (main.ts:2562). Correção:
- **Um estado:** `GameState` passa a guardar TODO o estado da aplicação (ferramentas, prédios,
  câmera/vista, simulação, qualidade, painéis), cada chave com revisão; ele é entrada do motor de
  mudanças (a vista parada não suja nada).
- **Uma fila de eventos:** ponteiro, teclado, roda, redimensionar e mensagens de worker entram numa
  fila (com os dados capturados na hora) e são tratados no início do quadro, na ordem; quem trata
  não emite evento no mesmo passo.
- **Um agendador, um laço:** um `requestAnimationFrame` só (o `FrameClock`), na ordem fixa entrada →
  simulação → `engine.refresh()` → desenho → envio à GPU. Nenhum `setInterval`/`setTimeout` de
  lógica: o que é periódico (crescimento, desgaste, painéis, incêndios) vira tarefa no relógio da
  SIMULAÇÃO (para com a pausa, segue a velocidade, é determinístico).
- **Dono para cada ouvinte e tarefa:** registro por dono que solta tudo no `dispose`.
**Os outros serviços centrais que faltam (cada um com a prova no inventário):**
| Serviço | Hoje | Correção |
|---|---|---|
| Recursos de GPU e CPU com dono | os vazamentos da lista C6, cada um conferido | registro por célula/produto; soltar a célula solta tudo |
| Um pool de workers | ✔ 10 `new Worker` em 10 arquivos; 2 sem tratamento de erro (`destruction.ts`, `people/lodPool.ts`); 3 desligam o worker pela sessão na primeira falha e jogam o trabalho na página (`garmentPaddingPool.ts:55-60`, `bakePool.ts:79-83`, `flatAtlas.ts:437`) | um pool com tipos de tarefa, erro que rejeita e registra, cancelamento, transferência |
| Determinismo | ✔ 166 `Math.random` em 13 arquivos (inclusive no documento, pela bomba, actionsWiring.ts:315, 328), ✔ RNG sem reinício, ✔ simulação dependente da câmera (walk.ts:1703) | um serviço de RNG (`@core/rng`) semeado por (mapa, sistema, id); tempo da lógica só do relógio da simulação |
| Um canal de erros | ✔ erros engolidos em `catch {}` (proxy.ts:203, renderer.ts:3091) e no 2º argumento de `then` (crowdLod.ts:92, personRig.ts:811) | `report(erro, onde)` para o F9 e o console; a regra no-silent-catch passa a ver o `then` |
| Fronteira de carga validada | ✔ nome e cor da linha de transporte vão ao `innerHTML` (shell.ts:1693; world/transit.ts:87, 107 aceita qualquer texto) | validar e sanear tudo o que vem do arquivo; texto só por `textContent`; regra que proíbe `innerHTML` com interpolação |
| Textos do jogador | ✔ F9 (healthWatch.ts:111, 145) e gestos (cameraGestures.ts:137) em português no código; ✔ inglês no pt-BR (pt-BR.ts:1432, 1810); ✔ 166 chaves `person.*` sem uso e `creator.*` só com `dock` e `pattern` (o Hook contou 559 mortas no total; conferi esses dois grupos) | todo texto visível pelo i18n; limpeza das chaves |
| Salvar pelo diário | ✔ autosave da cabeça inteira (chunkedSave.ts:91); ✔ exportar numa string só, indentada, sem `try` (persistence.ts:537) | salvar só as partes que o diário diz que mudaram; exportar em partes |
| Qualidade e orçamento | ✔ `QualityGovernor.sample` sem chamador, e o cabeçalho (quality.ts:5-7) diz o contrário de main.ts:645-646; ✔ tetos fixos por contagem (`FOREST_MAX` 4.000, `SCRUB_MAX` 12.000, `ROCK_MAX` 9.000, renderer.ts:2092, 2154, 2413) | LOD e sombra por tamanho na tela, residência por célula; nada por contagem global |

## Roteamento obrigatório: o caminho certo é o ÚNICO que compila
O que já existe e é contornado prova que arquivo e regra opcionais não servem (cada item ✔ aberto):
`GameState` (30 chaves, escrito só em main.ts), `CellFiling` (fórmulas próprias de chave de célula em 37
arquivos ao lado), `@core/rng` (a constante do mulberry32 em 8 arquivos), `@core/heap` (usado só
por hybridAStar e walk; 4 heaps próprios), o diário (leitores por revisão global), o analisador
(acusa e a linha de base deixa passar: findAnchor e snapPlacement em code-rules.baseline.json:266-269,
329-332, 366-367), `@perInput` (marca violada pelo próprio código marcado, snap.ts:99-132). Por isso cada
serviço central entra com o roteamento que torna o desvio IMPOSSÍVEL, em três camadas:
1. **Tipo e módulo (erro de compilação):** render, sim, editor e ui recebem só a vista pública do
   documento: `get(id)`, `near(retângulo)` e consultas por célula. `all()`, as coleções, `revision`,
   `serialOf` e `changes.since` saem dela e ficam numa interface interna que só o motor, a
   persistência e a carga importam. Escrita só por transação (F2), com coleções `ReadonlyMap` e
   `ReadonlyArray` no tipo público. Produto derivado só nasce por `engine.register`, e o `compute`
   recebe um contexto sem iteração do mapa.
2. **Lint duro, sem supressão e sem linha de base** (ESLint flat config, liberado só no arquivo do
   serviço por `files`): `no-restricted-globals` com `checkGlobalObject` para `setTimeout`,
   `setInterval`, `requestAnimationFrame` e `Worker`; `no-restricted-properties` para
   `Math.random`, `Date.now`, `addEventListener` de window/document e `innerHTML`;
   `no-restricted-imports` para a interface interna do documento e para qualquer grade, heap, RNG
   ou diário fora do oficial. A checagem falha se aparecer supressão de qualquer uma dessas regras.
3. **Em execução, no desenvolvimento e na checagem rápida:** o livro-razão do motor (quadro parado =
   zero computação; quem computa sem dependência suja é nomeado) e o registro de recursos (o que foi
   criado e não solto, por dono).
**Sem caminho paralelo:** cada serviço entra no MESMO commit que apaga as duplicatas dele (as
grades dos 37 arquivos viram `CellFiling`; os 4 heaps, o oficial; as 8 cópias do gerador,
`@core/rng`; os 10 workers, o pool). "Feito" exige zero duplicatas no grep, e o verificador confere.

## Paradigma: orientado a dados (ECS) no núcleo; objeto só como fachada e serviço
**Resposta:** para o núcleo deste jogo (milhares de veículos, pedestres, carros parados, prédios e
células numa cidade de 10 km), orientação a objetos NÃO é o melhor. O melhor é orientado a dados.
Prova, no caso mais parecido com o nosso: a cidade de demonstração da Epic (City Sample, da demo
Matrix) simula tráfego, carros parados e multidão com o MassEntity, "used for both the Traffic and
Crowd systems in City Sample" (dev.epicgames.com, City Sample). O MassEntity é orientado a dados:
fragmentos só de dados ("do not contain any logic"), processadores sem estado em lote por consulta,
mudança de estrutura num buffer de comandos (dev.epicgames.com, Mass Entity). A simulação do Cities:
Skylines II é toda em ECS (relato não oficial de alguém da equipe), no Unity Entities, em que entidade
é "units of data that the systems you create process". No Godot, os nós (objetos) são fachada
opcional sobre servers de dados com identificadores opacos, e a doc manda usar os servers direto para
dezenas de milhares de instâncias por quadro (docs.godotengine.org, using servers). A razão: dados
contíguos e processados em lote usam o cache (GPP "Data Locality", ~50× no teste do autor), e no
V8 objetos de forma variável, `delete` e arrays com buraco saem do caminho rápido (v8.dev, fast
properties).
**O nosso núcleo hoje é o contrário:** agentes como objetos com campo opcional criado depois
(`state.ts:66/113`), `delete` em array (`kerbStops.ts:613`), poses e obstáculos alocados por
quadro, lógica espalhada em métodos que varrem o mapa. Correção:
- **Entidades como dados:** veículos, pedestres, parados, instâncias de prédio e células em tabelas
  por tipo (arrays contíguos, campos quentes em arrays tipados, uma forma só, os vivos primeiro,
  remoção por troca com o último), identificadas por id.
- **Sistemas sem estado** (os estágios da simulação e as camadas do desenho) que leem as tabelas por
  consulta, em lote, na ordem do agendador; mudança de estrutura (nasce, morre, troca de faixa) num
  buffer de comandos aplicado no ponto fixo do passo.
- **Objeto só onde é fronteira:** o motor, o documento (campos privados), os estoques, os donos de
  recursos, o pool de workers e o estado global, que fazem o roteamento obrigatório compilar.
- **Paradigma não substitui LOD, recorte e residência:** o Cities: Skylines II tinha a simulação em
  ECS e rodou mal no desenho (fonte primária, Paavo Huhtala, blog.paavo.me/cities-skylines-2-performance:
  "only implements frustum culling and there's no sign of occlusion culling at all"; "none of the
  character meshes have any LOD variants"; a sombra é o passe mais lento, ~40 ms, com 4.828 das
  6.705 chamadas de desenho; quadro de 87,8 ms). Classe C5.

## Arquitetura de referência, peça por peça (o que os motores usam e o que vira aqui)
| Peça | Como os motores fazem (fonte lida) | Aqui |
|---|---|---|
| Controladores | processadores e sistemas sem estado que declaram a consulta (Mass, Unity, Bevy) | estágios da simulação e camadas do desenho como sistemas sobre as tabelas |
| Indexadores | arquétipos e chunks (Unity, Mass); grade de células por alcance (Unreal World Partition); corredores de faixas (ZoneGraph no City Sample) | `CellFiling` único (células 256 m), tabelas por tipo, o grafo de faixas |
| Portões | filtro de mudança por chunk (Unity `SetChangedVersionFilter`, e só quem declara escrita marca mudança); `Changed<T>` e condições de execução `run_if` (Bevy: sistema pulado se a condição é falsa) | o motor só chama quem tem chave suja; cada sistema com condição (sinal só na troca de fase, parado não roda); escrita só por transação, leitura declarada só leitura |
| Roteador | fila de eventos esvaziada pelo laço (GPP "Event Queue"); buffer de comandos para mudança de estrutura (Unity, `MassCommandBuffer`); registro de comandos de entrada | fila única de eventos; `CommandRegistry` (✔ core/commands.ts lido inteiro, usado por editor/gameKeys.ts) para a entrada; transação F2 e buffer de comandos da simulação |
| Agendador | grupos e fases com ordem explícita (Unity, Bevy; Bevy avisa que fora de ordem a mudança chega um quadro atrasada) | um laço: entrada → simulação → motor → desenho → envio à GPU |
| Servers e handles | servers de render e física com identificadores opacos; não consultar o server por quadro (Godot) | cada camada do desenho como server com handle por entidade e vaga estável |
| Residência e LOD | células carregadas pelo alcance da fonte e HLOD longe (World Partition); multidão com MetaHuman perto e malha animada por vértice longe (City Sample) | células residentes pela câmera; LOD por tamanho na tela; a multidão ✘ NÃO tem os dois níveis por distância: quem anda é a multidão procedural (um corpo por classe, esqueleto na GPU) e os corpos cozidos ficam para jogador, ocupantes, quem está dentro e arremessados (agents.ts:870-879); longe só há LOD de malha pelo tamanho na tela (`personPixels`, crowdLod.ts) — falta o nível de longe barato |
| Tirar da entidade o que é muito | itens das esteiras (versão 0.12), fumaça, decorativos e partículas fora do sistema de entidades: "A 10x reduction in the number of created entities, and about a 40% reduction in max update time", num teste que o autor chama de "not very scientific" (Factorio FFF #322) | parados, decais e efeitos como tabelas próprias, não agentes completos |

## Desempenho e qualidade além do three.js (navegador, motor JS, GPU, hardware)
| Camada | O que a fonte diz (lida) | O que o nosso código faz | Correção |
|---|---|---|---|
| Thread principal | tarefa acima de 50 ms trava a resposta; ceder a vez não reduz o trabalho: "do as little work as possible" (web.dev, optimize long tasks) | fatias e `hold*` (C8) só espalham o trabalho | tirar a causa (motor) e o pesado vai para worker |
| Desenho fora da página | `OffscreenCanvas` com `transferControlToOffscreen` desenha WebGL num worker, `requestAnimationFrame` no worker; amplamente suportado desde 03/2023 (MDN) | todo o desenho e a simulação na página | estado final: página só com entrada e ui; simulação num worker; desenho num worker (depois do motor e das tabelas, porque precisam de dados transferíveis) |
| Coletor do V8 | o custo segue o que sobrevive; a coleta jovem para o mundo (em paralelo); o que sobrevive é promovido e custa mais (v8.dev, trash talk). Forma fixa e array sem buraco (v8.dev, fast properties) | ✔ `{ v, a }` por chamada (drive/operational.ts:105), `Set` novo por veículo cruzando (vehicles/integrate.ts:74), chaves em texto nas reservas (crossings/permission.ts:97, 107, 110), pose de pedestre com 4 objetos (pose.ts:261-267), campos opcionais criados depois nos veículos (state.ts:66, 113), `delete` em array (kerbStops.ts:613), caches que só crescem (YARDS, `idByKey`, `MOVEMENT_TOKENS`) | nada alocado por quadro ou passo nos laços quentes; tabelas por tipo |
| Chamadas síncronas de GPU | evitar `readPixels` para a CPU e consultas de status; leitura assíncrona com PIXEL_PACK e fence (MDN, WebGL best practices) | ✔ checagem de shader só em desenvolvimento (renderer.ts:487); ✔ sem `getError`; ✘ `readRenderTargetPixels` síncrono (referenceModel.ts:122, 126) | leitura assíncrona |
| Compilação | compilar tudo e só depois consultar; `KHR_parallel_shader_compile` (MDN) | variantes compiladas no jogo (C5) | catálogo fechado compilado na carga com `compileAsync` |
| Texturas | formatos comprimidos (S3TC, ETC, ASTC, Basis) ocupam menos memória de vídeo e amostram mais rápido; `texStorage`; RGBA8 em vez de RGB8 (MDN) | ✔ nenhuma textura nem geometria comprimida (nenhum `KTX2Loader`, `CompressedTexture`, `DRACOLoader` ou `MeshoptDecoder` em src/); relevo HalfFloat 2048² × 2 camadas com mipmaps por superfície (terrainRelief.ts:300-310) | KTX2/Basis nas texturas de cor; relevo só nas placas residentes |
| Orçamento de memória de vídeo | fixar um teto para a máquina alvo, proporcional aos pixels da janela; soltar cedo; `invalidateFramebuffer` (MDN) | ✔ cada placa em detalhe cria a própria superfície e o próprio relevo (~89 MB; flatAtlas.ts:266, terrain.ts:2284), e o terreno de longe cria mais um que não usa (flatAtlas.ts:197, 226-228): até 26 relevos com a cidade nas 25 placas; ✔ MSAA de até 8 amostras num alvo HalfFloat (postprocess.ts:160-176); sem teto | teto por pixel da janela e residência por célula |
| Resolução | resolução dinâmica: reduzir o alvo de desenho quando o tempo de quadro sobe (Unity, dynamic resolution) | ✔ `QualityGovernor.sample` sem chamador; ✔ pixelRatio fixo pelo nível (1,5 no padrão `high`, quality.ts:130; main.ts:371) | resolução dinâmica pelo tempo de GPU (✔ o `gpuTimer` está certo, ver abaixo), a interface sempre nítida |
| Sombra | um mapa só para a vista inteira dá aliasing de perspectiva; cascatas dividem o frustum, cada uma com seu mapa (Microsoft, cascaded shadow maps) | ✔ um mapa só, 4096² no padrão `high` (quality.ts:134), sem LOD de sombra | sombra em cascata e projetor por tamanho na tela |
| Hardware alvo | memória de vídeo e taxa de preenchimento limitadas em placas integradas; canvas acima de 32.767 px falha | ✔ cadeia de pós: cena com MSAA, GTAO, canyon, bloom, nuvens (sempre, postprocess.ts:507-508), SMAA e saída com 5 tonemaps por pixel quando há nitidez (1363, 1380-1383), a pixelRatio 1,5; ✔ atlas de placas só dobra (signs.ts:266) | custo por pixel conforme o orçamento; atlas por página com limite |

## Steam e Windows, e o desempenho "nível assembly"
**O que existe:** `scripts/package-desktop.mjs` gera `release/Roadcraft-win32-x64/Roadcraft.exe`
(Electron 44, pasta solta); `desktop/main.cjs` já força a GPU de alto desempenho e desliga a
limitação em segundo plano, com `contextIsolation` e `sandbox` ligados. Electron leva o próprio
Chromium: o mesmo comportamento em todo PC, o que importa para um jogo vendido.
**Steam (fontes: partner.steamgames.com/doc/features/overlay; github.com/ceifa/steamworks.js):**
- Steamworks pelo `steamworks.js`, no processo principal, exposto ao jogo por preload e IPC. O
  README sugere `contextIsolation: false` e `nodeIntegration: true` para usá-lo na página; não,
  porque abre o jogo a código nativo.
- **Overlay, resolvido:** `electronEnableSteamOverlay()` no fim do `main`. Pelo código do
  steamworks.js, ele liga `in-process-gpu` e `disable-direct-composition` e chama
  `webContents.invalidate()` a 60 Hz em cada janela: o Chromium refaz a composição e apresenta o
  último quadro à Steam (que exige apresentação contínua), sem o jogo redesenhar a cena. O laço sob
  demanda e o quadro parado com zero computação continuam. Na implementação: medir o custo da
  composição a 60 Hz e do `in-process-gpu`, e conferir o overlay e as notificações no executável
  lançado pela Steam.
- Envio pela Steam: o README do steamworks.js manda copiar os arquivos de
  `sdk/redistributable_bin/<plataforma>` para a raiz do build. Como o executável vai aos depots é o
  que a doc do SteamPipe diz, e ela é lida antes de implementar o envio (não está lida ainda).
**Desempenho nativo, na ordem certa (depois da causa, nunca no lugar dela):**
1. **Isolamento de origem, resolvido** (web.dev/articles/coop-coep): `Cross-Origin-Opener-Policy:
   same-origin` e `Cross-Origin-Embedder-Policy: require-corp` na resposta do `protocol.handle` do
   `app://` (o `Response` do `net.fetch` refeito com os dois cabeçalhos) e no `server.headers` e
   `preview.headers` do Vite. Tudo vem da mesma origem `app://roadcraft`, então nada é bloqueado.
   Prova: `self.crossOriginIsolated === true` no executável e no servidor. Isso libera
   `SharedArrayBuffer` (tabelas da simulação lidas pelo desenho sem cópia), WebAssembly com threads
   e o `measureUserAgentSpecificMemory` para medir memória de verdade.
2. **WebAssembly com SIMD** (v8.dev/features/simd: tipo `v128` de 128 bits; compila de C/C++ com
   `-msimd128 -O3` ou de Rust com `+simd128`; Chrome 91+; no Electron o Chromium é sempre novo,
   então um build só) para os núcleos pesados: recorte de polígonos (hoje `clipper2-ts`, TypeScript
   puro; o Clipper2 original em C++ compilado), raster e flood fill dos lotes, A* dos pátios e
   rotas, rasters do terreno e da ecologia, emissão dos prédios. ✔ Jolt e meshoptimizer já são wasm
   (`import('jolt-physics/wasm-compat')`, ragdollJolt.ts:44; o simplificador, o clusterizador e o
   decodificador do pacote `meshoptimizer` carregam WebAssembly); ✔ `clipper2-ts` não tem `.wasm`. O
   pacote do Jolt traz também a versão multithread (`jolt-physics.multithread.wasm-compat.js`), que o
   isolamento de origem do item 1 torna possível.
3. **Código nativo de verdade** (C++ ou Rust com AVX2) só se o wasm com SIMD não bastar: addon
   N-API num `utilityProcess` do Electron, falando por `MessagePort` (electronjs.org, utility
   process). A doc não diz se addon nativo roda ali; isso é confirmado antes de usar.
4. **GPU compute com WebGPU** (Chrome 113+ no Windows sobre Direct3D 12): recorte e LOD na GPU,
   animação de multidão e veículos, terreno. ✔ O three r186 tem `WebGPURenderer`
   (referência local do three, `renderers/webgpu/WebGPURenderer.js:28`). É migração grande e
   vem depois do motor e das tabelas; o WebGL2 continua sendo a base.

## Técnicas avançadas de desenho e simulação (fonte lida, estado no nosso código)
| Técnica | O que a fonte diz | Hoje aqui | Uso no plano |
|---|---|---|---|
| Recorte por oclusão (Hi-Z e consultas) | mapa de profundidade em mips com o máximo, cada caixa testada no nível do seu tamanho, construção < 0,2 ms (rastergrid, Hi-Z culling); WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE`, resultado lido num quadro seguinte (MDN, beginQuery) | nenhum (consulta de GPU só no `gpuTimer.ts`); o Cities: Skylines II também não tinha e rodou mal | por célula: a caixa da célula testada com consulta assíncrona, resultado do quadro anterior; numa cidade os prédios escondem a maior parte das ruas e quarteirões |
| Clusters de malha e LOD por cluster | malha em clusters hierárquicos, LOD por cluster pela vista, sem fendas entre vizinhos, streaming do que é visível (Epic, Nanite); `meshopt_buildMeshlets` com esfera e cone por cluster, `meshopt_partitionClusters` para a hierarquia (meshoptimizer) | LOD por célula inteira (massa ou detalhe) | detalhe dos prédios em clusters, LOD e recorte por cluster; o meshoptimizer já está no projeto (wasm) |
| Menos chamadas de desenho | `WEBGL_multi_draw` (`gl_DrawID`), menos custo de ligação na CPU (MDN); `BatchedMesh` do three r186 aloca na CPU a capacidade inteira de cada atributo e, com os padrões, recorta e ordena todas as instâncias por quadro (fonte r186, `_initializeGeometry` e `onBeforeRender`) | ✘ NÃO usa `BatchedMesh` (o comentário de buildingMesh.ts:3468-3471 explica a retirada: 1,1 GB de heap); prédios são uma `Mesh` por acabamento por célula; o resto em `InstancedMesh` por tipo (24 arquivos) | lotes por célula com multi-draw próprio e buffers só na GPU (sem a cópia inteira na CPU), recorte por célula, sem ordenar todo quadro |
| Impostores | octaédricos usados no mapa do Fortnite para árvores longe (80.lv; fórum do three) | técnica ✔ conferida linha a linha (impostorShaders.ts 1-266: codificação e decodificação inversas, três quadros com pesos baricêntricos, raio no plano de cada quadro, rotações coerentes); uso ✘ (farForest.ts 1-401): 102.400 instâncias desenhadas todo quadro sem recorte (`frustumCulled=false`, 262, 288), quadros sem margem no atlas (sangria nos mips), mipmaps refeitos a cada foto no assado (342) | recorte e faixa de desenho por placa/célula, margem entre quadros, mipmap uma vez no fim; impostor do quarteirão e do bairro como HLOD da célula |
| Tempo de GPU | `TIME_ELAPSED_EXT`, disponibilidade antes, disjunção depois, resultado descartado quando disjunto (Khronos, EXT_disjoint_timer_query_webgl2) | ✔ conferido linha a linha (gpuTimer.ts 1-110; chamado em volta de `post.render`, renderer.ts:3527-3530) | base da resolução dinâmica |
| Upscaling | FSR 1 espacial, sem histórico nem vetores de movimento, código aberto MIT, 1,3× a 2× por eixo, 0,2–0,5 ms a 1440p (GPUOpen) | nenhum; pixelRatio fixo | desenhar abaixo da tela e reconstruir com FSR 1 (porte do shader), junto da resolução dinâmica |
| Luz em clusters | o frustum dividido em células 3D, cada célula com a lista das luzes que a tocam, o fragmento só avalia as dela (aortiz, clustered shading) | 8 PointLights em todo material iluminado | postes, faróis e janelas acesas sem limite à noite com custo pela luz que alcança o pixel |
| Compressão de geometria | codecs sem perda, 2–4× em vértices quantizados, ~1 byte por triângulo, decodificação 3–6 GB/s (meshoptimizer) | geometria em float sem compressão | células salvas e transmitidas comprimidas; menos memória e streaming rápido da cidade sem limite |
| Rotas em escala | hierarquias de contração: pré-processamento com atalhos, consultas em microssegundos; a variante customizável troca pesos (trânsito) sem refazer a ordem (Wikipedia, "Contraction hierarchies"; fonte secundária) | ✔ Dijkstra sem heurística, com chaves em texto (drive/tactical.ts:68-71); ✔ BFS do grafo por faixa de partida (routing/destination.ts:61-68) | rotas por hierarquia no worker, refeitas por edição só onde o grafo mudou; o artigo original (Geisberger 2008) é lido antes de implementar |

## 10 km leve e a cidade sem limite (o desenho próprio, sobre técnicas provadas)
Hoje o mapa é fixo: `world/bounds.ts` tem 5×5 placas de 2.048 m (10.240 m), e várias partes
assumem isso (25 placas do atlas e do relevo, `wear.ts` 2048² sobre o mapa, névoa 512², a grade
densa do `regionIndex` sobre o aglomerado). A cidade sem limite precisa de cinco peças, todas sobre
a célula de 256 m do motor:
1. **Mundo em células esparsas, sem borda:** a grade é uma tabela de hash de células (o
   `CellFiling` já é um `Map`), sem placas fixas; o documento é salvo e carregado por célula (o
   salvamento em partes dos prédios já existe e vira a regra para tudo).
2. **Coordenadas sem tremor** (Precisions, Precisions; CESIUM_RTC): a GPU trabalha em 32 bits
   (~7 dígitos). Cada malha fica na origem da sua célula, com vértices locais; o three r186 guarda
   `Matrix4.elements` num array de 64 bits (Matrix4.js:86) e calcula a modelo-vista na CPU
   (WebGLRenderer.js:2160), então só a matriz já relativa à câmera vai à GPU e a precisão vale a
   qualquer distância. As matrizes de instância são `Float32Array` (InstancedMesh.js:57): elas
   ficam relativas à origem da malha da célula, nunca em coordenada de mundo.
3. **Desenho por residência e HLOD:** células perto com detalhe; longe, o impostor da célula e,
   mais longe, o do bairro (quadtree de células, refinamento pelo erro de tela como no 3D Tiles: "If
   the introduced SSE exceeds the maximum allowed, then the tile is refined", e no HLOD da World
   Partition). Memória e triângulos crescem com a VISTA, não com o tamanho da cidade.
4. **Terreno em clipmap** (GPU Gems 2, cap. 2): grades aninhadas centradas no observador, só a
   faixa em L que muda é atualizada; troca as 25 placas fixas e o relevo de 89 MB por placa.
5. **Simulação em três níveis por célula, com a fronteira que conserva o fluxo:** micro (o modelo
   atual, por agente) nas células perto da câmera e das que o jogador marcou; meso (filas por
   trecho, o modelo do SUMO, até 100× mais rápido) no resto da área carregada; macro (fluxos
   agregados de origem e destino por bairro) no que não está carregado. Um veículo que cruza a
   fronteira troca de nível sem sumir: a fila meso entrega à faixa micro na ordem e no tempo
   certos, e a micro devolve. Essa passagem com conservação é o algoritmo nosso a desenhar e provar
   (número de veículos e tempo de viagem iguais entre os níveis num corredor de teste).
**Ordem:** depois do motor, das tabelas e da F2, porque cada peça depende de célula, diário e
dados contíguos. A cidade de 10 km fica leve já com as fases 2 a 5; a sem limite é a fase seguinte.

## Fases (ordem definitiva; o inventário está completo e conferido, seções abaixo)
**Quem faz (ordem do jogador): eu sigo sozinho, com os meus agentes; sem mais conversas em
sessões.** Na aprovação, aviso as conversas Auditoria e Hook para pararem de vez.
- O que elas deixaram pela metade passa para mim e é lido inteiro antes de qualquer decisão: a
  montagem da célula em worker da Auditoria, ainda não commitada (`cell.worker.ts`, `cellArrays.ts`,
  `cellPool.ts`, `cellRequests.ts`, `cellWork.ts`, `chunk.ts`, os testes e as mudanças em `layer.ts`,
  `layerCells.ts`, `buildingMesh.ts`, `townIndex.ts`), com os dois defeitos já achados nela
  (`disposeLanded` × fila de aquecimento; pedidos não cancelados no caminho inteiro); os ramos do
  Hook (sobreposição dos lotes, LOD, sombras em degrau); o desenho F2 da Auditoria, que eu executo.
- Os meus agentes (doc oficial de subagentes): só para ler em paralelo, no protocolo
  `lendo-o-codigo`, com ferramentas de leitura; eu confiro todos os achados no código antes de
  usar. Agente que edita trabalha nesta mesma pasta, em arquivos que só ele toca, nunca num
  worktree (o worktree nasce do ramo padrão, não do HEAD, e o `origin/main` está 80 commits atrás).
  Eu leio inteiro todo diff de agente antes do commit; commit com `git commit --only`.
- O verificador de "feito" vale para mim e para os agentes (`Stop` e `SubagentStop`).

**0. Ambiente e barreiras (primeiro, eu):**
- O verificador de "feito" (hook `agent` no Stop e SubagentStop) instalado e provado com os quatro
  casos do `claude -p`, a saída de cada um à vista.
- A skill `lendo-o-codigo`; o passo 1 da `investigando-desempenho` trocado; CLAUDE.md apontando.
- **Linha de base deixa de ser aceite:** as 485 entradas do `code-rules.baseline.json`, as 452
  supressões do eslint (em 158 arquivos), as 217 do knip e as 322 do refs (✔ contadas) são a lista
  de defeitos deste plano
  (cada uma cai na sua classe). "check-code sem achado novo" não é prova de nada; só entra entrada
  nova com o "pendente" escrito no commit, e o verificador cobra. Ao fim de cada classe, as
  entradas dela saem e a regra fica dura.
- Instruções numa fonte só: tirar "agentes livres" do CLAUDE.md:51 e ORDENS.md:17 e escrever "sigo
  sozinho com os meus agentes, sem conversas paralelas"; corrigir as notas falsas (✔ editor/CLAUDE.md
  trava do run-limited e "pincelada re-resolve a rede"; ✔ sim/CLAUDE.md:64-67 relógio e a lista de
  `sim/peds` com 4 arquivos inexistentes; ✔ world/CLAUDE.md acoplamento 4 com `sim/peds/clearance.ts`
  inexistente); ESTADO.md reduzido;
  regra de evidência no CLAUDE.md; o falso positivo do research-gate em comando só de leitura.

**1. Bugs de comportamento independentes (C7), cada um com o teste que falha antes e passa depois:**
os da lista C7 que não dependem de outra classe (segurança do innerHTML primeiro). Os que nascem de
outra classe (semáforos reiniciados, ônibus removidos) saem na conversão daquela classe.
Andamento: SEGURANÇA innerHTML corrigida em 2026-10-14 (nome e cor da linha de transporte: cor só
`#rrggbb` na carga, `world/transit.ts`; a linha do painel por `textContent`, `ui/v2/transitLine.ts`;
`tests/ui/transitLine.spec.ts` falhou antes e passa depois; conferido no jogo). Os outros 40 pontos
que escrevem HTML foram rastreados: nenhum recebe texto do arquivo. PENDENTE a barreira da classe
(todo HTML por um caminho só que escapa por padrão, e a regra de lint), na fase do roteamento.

**2. Diário e espinha (eu):** entrada com operação e tipo por id e retângulo antes ∪ depois
(corrige moveNode, pruneOrphanNodes, tetos gravando null, utilities null, restore 'traffic',
setMarkingStyle); `JournalCursor` único; `CellFiling` único parametrizado; `derived.ts`
(`Derived`, `Aggregate`, `OrderedIds`, `Fenwick`); teste genérico de equivalência e contador
embutido. Prova: `solidsOf` e `roadValue` convertidos.

**3. F2, edição como transação no documento vivo (eu, no desenho que a Auditoria escreveu e na ordem
dela; antes, eu leio as fontes dela, Immer patches e tldraw history):** escritores
únicos dos lotes; transação com patch vindo do escritor no lugar do DocImage (prova de
equivalência); nodeMover e guard por rollback; traços e prévia sem clone; `afterRoadEdit` e
`clearBulbs` dentro do passo (corrige o desfazer).

**4. C1 e C2 por família, na ordem do custo para o jogador:** (1) topologia e sinais da simulação;
(2) derivados por passo da simulação (vagas, parados, pátios, ciclos, admissão); (3) camada de
prédios; (4) derivados do desenho em `renderer.ts` (natureza, cobertura, cenário, mobiliário,
placas, névoa, elementos, transporte, estruturas, superfícies das vias, atlas do chão); (5) editor
por ponteiro (snap, lotes, prédios, paisagem); (6) agentes desenhados (parados por célula).

**5. C4 e C5:** worker por célula com transferência; catálogo de shaders compilado na carga; LOD e
sombra por tamanho na tela; residência por célula (placas de relevo, terreno); envio só da faixa
mudada (semáforos por atributo, agentes com vaga estável).

**6. C6** em cada arquivo tocado, e de uma vez no que sobrar (lista C6).

**7. C8, os remendos, só depois que a causa saiu:** governador, `SIM_FRAME_BUDGET_MS`, `frameWork`
10 ms, fatias e `hold*`, tetos de cache e de listas do jogador.

**8. C9 limpeza:** o morto e os comentários falsos da lista, grades e heaps duplicados.

## O método que achou os erros (vira a skill `lendo-o-codigo`)
Lendo o código inteiro e conferindo cada achado na linha, achei e provei em horas o que semanas de
testes, perfis e contadores não acharam. É o método de trabalho daqui em diante, para achar e para
corrigir; teste e perfil ficam para o que se destinam (provar que a correção funciona e medir).
Arquivo `.claude/skills/lendo-o-codigo/SKILL.md` (formato da doc oficial: frontmatter na 1ª linha,
`description` com o uso primeiro), criado na aprovação. Conteúdo:
- **Princípio:** o erro está no código. Teste, perfil e contador não acham a causa e não corrigem.
- **1 Escopo:** a lista dos arquivos com `wc -l`. Cada arquivo lido da primeira à última linha;
  anotar "lido 1-N".
- **2 Por arquivo, três blocos.** A) pistas de máquina (code-rules, eslint-suppressions, knip,
  refs): CONFIRMA/DERRUBA com a linha; entrada de linha de base é defeito a corrigir, nunca aceite.
  B) cada trabalho: onde | o quê | quando roda (FRAME, TICK, POINTER, EDIT, TIMER, LOAD) | o que o
  refaz (sempre, revisão global, diário, célula, tempo, teto) | alcance (mapa ou local) | custo O() |
  marcas (amortização, GPU, memória, thread principal, qualidade, OK). C) inconsistências:
  comentário × código; duplicação; diário mal lido (sem ids, esquecido, documento trocado);
  invalidação errada; determinismo; ciclo de vida (dispose, ouvintes, workers); regra do projeto
  violada; código morto; erro engolido; defeito de comportamento.
- **3 Seguir o chamador:** todo custo diz QUEM chama e QUANDO (grep até o quadro, o ponteiro, a
  edição). Foi o que pegou os jardins (o teste chamava a API; o renderer chama todo quadro).
- **4 Conferir:** cada achado com arquivo:linha aberto por mim, marcado ✔ ou ✘. Relato de agente ou
  de outra sessão só vira fato depois disso (nesta conferência caíram 12 relatos de agentes e
  sessões e 3 afirmações minhas; lista na seção de conferência).
- **5 Irmãos:** grep da mesma forma (mesma chave, mesma varredura, mesmo padrão) no projeto inteiro;
  a correção cobre todos.
- **6 Corrigir pela classe:** o mecanismo único da classe de causa (tabela abaixo), em todos os
  lugares; o teste vem depois, para provar a correção. "Feito" só quando a forma errada saiu do
  código em todos os lugares e a barreira da classe acusa a volta.
- **Nada existe por nome:** "já existe", "já usa", "já tem", "funciona" ou "está conforme" só depois
  de ler o código que USA a coisa (o chamador e o caminho em que ela roda), nunca por ter achado o
  nome numa busca. Nesta conferência o `BatchedMesh` "existia" só num comentário que explicava a
  retirada dele, e os impostores "existiam" com 102.400 instâncias desenhadas sem recorte.
- **Agentes:** só para ler em paralelo, no mesmo protocolo, com entrega por arquivo; eu confiro
  todos os achados antes de usar.
Na fase 0 também: o passo "1 Perfilar" da skill `investigando-desempenho` vira "1 Ler o código
inteiro" (o perfil só aponta onde começar a ler); o CLAUDE.md do projeto aponta a skill nova.

## Por que eu dizia "feito" sem estar (provado por mim no git, sem agente)
| Causa | Prova |
|---|---|
| 1. A prova testa a função, não o caminho real de chamada | `a4725ff` criou `setMap() { culledFor = null; }` (gardens.ts:513); renderer.ts:3148 chama `setMap` em todo quadro desde `7ff7726`. O commit editou renderer.ts e não leu a linha. O teste chamava a API direto |
| 2. Prova de saída igual anunciada como custo resolvido | `90524a3`: "o mesmo conjunto em 300 câmeras"; nada mostra QUANDO o recorte roda (todo quadro) |
| 3. O título generaliza o único gatilho medido | corpo de `c45806a` admite "caminho completo como antes ao trocar chão/corte/ruínas"; título e OTIMIZACAO dizem "custa as células"; toda edição de via muda o chão; a escala mediu só `building+1` |
| 4. A linha de base engole o defeito e o portão fica verde | `7fab1d2` registra 3 achados "pendentes" na baseline e se chama "varreduras trocadas por índices"; eu repassei "vagas e pátios x1" |
| 5. Corrige um, deixa os irmãos da mesma classe | `9292cfc` escreve "DO NOT key on buildings.revision" e deixa ambient.ts:837 e lotTraffic.ts:237 com a mesma chave; meu `cc04f0e` não leu o leitor main.ts:4263 (de `8d01b91`), que ignora entrada sem ids |
| 6. Relato de terceiro vira fato; o resumo da compactação herda o "feito" | agentes e sessões relatavam "x1, verde"; eu repassava sem abrir o código |
| 7. Nada no caminho lê a afirmação | `scripts/gate.mjs` só confere checagem verde; `research-gate.mjs` só conta WebFetch; `foto-vista.mjs` existe e não está ligado em nenhum settings |
| 8. "Existe" por ter achado o nome | nesta conversa, escrevi "✔ BatchedMesh nos prédios" porque a busca achou o nome em `buildingMesh.ts`; a linha 3468-3471 é um comentário que explica a retirada ("NOT a BatchedMesh"). Escrevi "a multidão já tem os dois níveis" sem abrir `agents.ts` |
| 9. Contagem herdada vira fato | o plano levava "~18 cursores, 10 grades, 7 ordens, regra do delta ×6", vindos de um levantamento de agente; recontados: 14 leituras do diário, 37 arquivos com chave de célula própria, 1 classe de ordem; o resto foi tirado |

## A barreira: um verificador inteligente no fim de cada turno (fase 0, primeiro item)
Fonte: code.claude.com/docs/en/hooks ("Agent-based hooks", "Stop"); code.claude.com/docs/en/headless.
- **Um hook só, `type: "agent"`, nos eventos `Stop` e `SubagentStop`**, no `~/.claude/settings.json`
  (vale para as três conversas, para os agentes delas e para qualquer projeto). `model` o mais forte
  (Opus 5.5), `timeout` 300 s. Recebe `last_assistant_message`, `transcript_path` e `cwd`.
- **O que ele faz (prompt em inglês, razão em português):** se a mensagem final não afirma nada
  ("feito", "corrigido", "funciona", "conferido", "verde", "x1", "igual", "sem defeito"), devolve
  `ok: true` na hora (barato). Se afirma, investiga ele mesmo, sem confiar no texto:
  a) abre o código citado e TODO chamador e gatilho (Grep do nome, da chave, da revisão lida):
     a propriedade vale no caminho real, inclusive por quadro? (pega a causa 1);
  b) a afirmação é mais larga que a prova (cenário do teste, gatilho medido)? (causas 2 e 3);
  c) o trabalho acrescentou entrada em linha de base (code-rules, eslint-suppressions, knip, refs,
     tests/scale)? então a mensagem tem de dizer "pendente" (causa 4);
  d) existem irmãos da mesma classe na mesma família (mesma chave, mesma varredura, mesmo arquivo)?
     afirmação sobre a classe é falsa enquanto um irmão restar (causa 5);
  e) "li", "rodei", "olhei a foto", "conferi": acha no `transcript_path` a chamada da ferramenta e o
     resultado; foto sem a lista do que foi olhado nela = falso (causa 6 e regra "Foto vista");
  f) relato de agente ou de outra sessão: só vale se eu abri o código depois, ou se a mensagem diz
     "não conferido" (causa 6);
  g) "já existe", "já usa", "já tem", "está conforme": acha no transcrito a leitura do código que
     USA a coisa (o chamador, o caminho em que roda); um nome achado por busca não basta (causa 8);
  h) número ("N leitores", "X%", "Y MB"): acha no transcrito o comando que mediu e o resultado; número
     herdado de relato ou de resumo é falso até ser medido de novo (causa 9).
  Devolve `{"ok": false, "reason": …}` com cada afirmação falsa ou sem prova, arquivo:linha e o
  caminho certo (corrigir o código, ou dizer com todas as letras que não está feito). Eu continuo o
  turno com essa razão: ele me barra E me direciona. Teto oficial de 8 continuações seguidas.
- **Nenhum hook de regex novo.** `foto-vista.mjs` (desligado) fica coberto pelo item e.
  `gate.mjs` (checagem verde) e `research-gate.mjs` ficam; o falso positivo do research-gate que
  bloqueia comando só de leitura (`git show`, `git blame`) é corrigido.
- **Plano B, decidido pelo teste e não por palpite:** a doc cita Read/Grep/Glob como ferramentas do
  agente do hook; se ele não tiver git, o mesmo prompt roda num hook `command` que chama
  `claude -p --allowedTools "Read,Grep,Glob,Bash(git log *),Bash(git show *),Bash(git diff *),Bash(git blame *)" --output-format json --json-schema '{ok,reason}'`
  e devolve `decision: "block"` com a razão.
- **Teste como o jogador usa, antes de dizer que funciona:** `claude -p` numa pasta de rascunho com
  o settings do hook, quatro casos: (1) afirmação falsa real ("os jardins não recortam mais por
  quadro": gardens.ts:513 + renderer.ts:3148) → barrada com essas linhas; (2) afirmação verdadeira
  com prova → passa; (3) mensagem sem afirmação → passa rápido; (4) "conferi a foto" sem Read da
  imagem → barrada. Depois, em turnos reais desta conversa.

## "Feitos" que não estão feitos (reconciliação com o código lido)
Dados como corrigidos em commits e no OTIMIZACAO.md, e o código ainda tem a causa:
| Dado como feito | O que o código ainda faz (prova) |
|---|---|
| Jardins incrementais e recorte hierárquico (a4725ff, bce5613, 90524a3; OTIMIZACAO 30/46) | ✔ recorte refeito a cada quadro com a câmera parada (`gardens.setMap` zera `culledFor`, gardens.ts:513, chamado em renderer.ts:3148); ✔ `update` zera `shown` de todos os estoques (504-507); ✔ os cards (`garden-…-cards`, 265, 270) nunca somem no mapa, porque `setMap` ignora o argumento |
| Camada de prédios incremental, x1 (c45806a; OTIMIZACAO 36) | ✔ caminho de cidade inteira com qualquer `rest` diferente: chão, corte, ruína, "ocultar outros" (layer.ts:505-506); ✔ `flyFlags` percorre todos os prédios mostrados (338-343); ✔ `anyLotHeightAt` percorre todos os prédios guardados por pedestre por quadro (697-702; renderer.ts:989) |
| Vagas e pátios x1, cenário por índices (7fab1d2, 0e30a3b) | ✔ `ambient.parking` (ambient.ts:837) e `readBays` (lotTraffic.ts:237) chaveados por `buildings.revision`, contra o "DO NOT" de ambient.ts:276; ✔ pedestres refazem as zonas de todos os estacionados quando um carro de lote ou caminhão anda (walk.ts:1670-1694); ✔ `yardKey` com `net.revision` (lorryDocks.ts:422) |
| Superfícies de via por ladrilho (ARCHITECTURE §3.1 "P2 fixed") | ✔ cada reconstrução monta as entradas do passe e o digest de cada ladrilho alcançado (roadSurfaces.ts:735-780, 877-910); ✔ união Clipper das calçadas do passe (560) |
| Calçadas sem varrer (OTIMIZACAO 29) | ✔ `onPaving` testa todos os furos do polígono (walkways.ts:317-318); ✔ o limite pela caixa de `stretch` nunca corta o anel externo, cuja caixa cobre tudo (467-479) |
| Desgaste como tipo próprio (cc04f0e) | ✔ `main.ts:4263` ignora entrada sem ids (limpar/carregar o estoque) |
| Sombras só quando algo se move (OTIMIZACAO 25) | ✔ projetam sombra sem limite de distância: gore (gore.ts:81, com frustumCulled=false), assinaturas (signature.ts:1773), massas longe (massCells.ts:137), bandeiras (flagLayer.ts:158), ruínas (destruction.ts:157, 164); ✘ os decais de sangue NÃO projetam (casualties.ts sem castShadow) |
| Shaders compilados antes do uso (OTIMIZACAO 23) | ✔ o aquecimento dos prédios cobre `shell`, `material`, mobília e `massing` (renderer.ts:1949) e não `dimShell`, `dimParts`, `ghostShell`, `ghostParts`; ✔ `riggedCitizens.ts` não chama `compileAhead`; ✔ material de pintura novo em cada rebuild (markings.ts:120; roadSurfaces.ts:361) |
| Materiais compartilhados (OTIMIZACAO 7) | ✔ material de pintura criado em cada rebuild das vias; ✔ assinaturas criam materiais na primeira montagem e material com textura de fachada por chave durante o jogo (signature.ts:182), nunca soltos (`disposeSignature` só solta geometria, 1789-1790) |
| Analisador "sem pontos cegos" (cf22f10, 4b20214) | ✔ nenhuma entrada em code-rules.baseline.json para o recorte dos jardins por quadro, o `anyLotHeightAt` por pedestre ou o reprocessamento dos estacionados (as de walk.ts são `gapOpen`, `publish`, `ensureGraph`) |

**Regra que sai disto:** um item só é "feito" quando (1) a forma errada saiu do código em TODOS os
lugares da mesma classe e (2) a forma errada ficou impossível de voltar pela estrutura: a API da
espinha não oferece o mapa inteiro ao código de derivado (só `allKeys` na montagem do zero), e a
regra do analisador que cobre aquela classe acusa a volta. Nada de "feito" por número.

## Classes de causa (do inventário) e o mecanismo único de cada uma
Cada achado do inventário cai numa classe; cada classe tem UM mecanismo de correção, aplicado a
todos os seus casos, e UMA barreira que impede a volta.

| Classe | Casos (exemplos do inventário) | Mecanismo de correção | Barreira |
|---|---|---|---|
| C1 Regeneração por revisão global (não lê o diário) | camada de prédios (caminho inteiro por chão/corte/ruína), mobiliário, atlas do chão, superfícies das vias (re-deriva tudo e compara digest), caminhos, faixas/conflitos/semáforos, alturas por componente, clearBulbs, pátios, vagas e carros parados, sólidos, paredes dos efeitos, gardenLists, relevo por placa, crossingSurface, ribbonOrder | espinha F3: cursor único do diário + derivado por célula/id (`Derived`) + agregados pela diferença; o produto declara o que lê e o alcance | regra `whole-map-on-revision` + contador embutido do `Derived` (N vs 4N, quadro parado = 0) |
| C2 Varredura do mapa para achar o que está perto | snap e buildingSnap por ponteiro, anyLotHeightAt por pedestre, stretch/onPaving, elenco das pessoas, mayGo dos caminhões, footwayRise, lotPlaces.pickFrom, admissão (todos os detentores), asphaltOf | consulta pela grade única (`CellFiling` parametrizado) e índices já existentes (`buildings.near`, `ribbonsMeeting`, `polesIn`) | regras per-input/per-frame/nested + `@mapWide` |
| C3 Edição que copia o documento (dívida F2) | `doc.clone` + `replaceWith` por via, `Network.adopt/copyState` 2× por via, `build.copyFrom` (15 `Map`, 1 `Set` e uma grade), prévia do traço (dryRun) com clone | F2: edição como comando com inverso aplicado no documento, operação por id no diário (added/removed/replaced); prévia sem cópia | regra: `clone/replaceWith/adopt` fora de carga = achado |
| C4 Trabalho pesado na página | massas (layer.ts:347-352), assinaturas, ladrilhos de via com Clipper, simplificação de LOD de gente (crowdLod.ts:256), física Jolt, heurística do A* no construtor, envio de fratura sem transferência (destruction.ts:240) | worker por célula (o pool da montagem em worker é o começo), transferência de buffers | regra THR (puro e pesado alcançável do quadro/edição) |
| C5 GPU: desenho, envio e compilação | buffers inteiros reenviados (bandeiras, decais, gore, morph), sem LOD/sombra de tudo (assinaturas, massas, bandeiras, ruínas), shaders em jogo (dim, ghost, sombra dos rigged, pintura), ~89 MB de relevo por placa em detalhe (provável causa do `GL_OUT_OF_MEMORY`, não provada), todas as placas com conteúdo em detalhe, folhas nunca escondidas (nome errado), jardins recortados todo quadro, impostores sem recorte | catálogo fechado compilado na carga (F5); LOD e sombra por tamanho na tela; residência por célula; só a faixa mudada sobe | acusar (buffer inteiro, compile/material em jogo) na checagem rápida |
| C6 Ciclo de vida de recursos | geometria das bandeiras, malhas aterrissadas descartadas na fila, materiais e texturas das assinaturas, pedidos de célula não cancelados, pátios nunca removidos, efeitos sem dispose, Jolt, workers sem tratamento de erro | dono único por recurso (a célula/produto que o criou) com dispose na liberação | regra: `new`/`clone` de geometria/material sem dispose no mesmo dono |
| C7 Defeitos de comportamento | desfazer sem os prédios demolidos, semáforos do mapa reiniciados por edição, faixa fantasma para sempre, reset sem limpar assessor/pedestres, elenco de 3.600, carga que falha para sempre, tampa do farol, Math.random nas texturas, janelas pela ordem dos workers, simulação depende da câmera, placa de cruzamento não plana até a borda em via com mais de ~800 m (elevation.ts:69, 81, 506-507) | corrigidos um a um, com teste do defeito antes (falha) e depois (passa) | o próprio teste |
| C8 Amortizações que escondem custo | governador de população, teto de 8 ms, fatias de topologia/mundo/emissão/lotes, `hold*`, LRU de 128 MB, CACHE=6 do atlas, ritmos | removidas DEPOIS que C1–C4 tiram a causa | regra: constante `*_SLICE_MS`/`*_BUDGET`/`hold*` nova = achado |
| C9 Duplicação, código morto, comentário falso | chave de célula própria em 37 arquivos, 14 leituras do diário à mão, 2 Fenwick, 2 árvores de recorte (jardins e instanceCull), 3 `merge` iguais, `tint` e `seatShell` em dobro, telhados ×2, 4 heaps; mortos (lightSlots.setLit, 6 do facadeKit, assembleBuildingMeshesSteps, DeltaLog…); dezenas de comentários falsos | unificar nas primitivas da espinha; apagar o morto; corrigir o comentário no mesmo commit | knip + check-refs + regra de duplicação de chave de célula |
| C10 Instruções e ambiente | CLAUDE.md/ORDENS contraditórios, ESTADO velho, editor/CLAUDE.md desatualizado, memória partida, hook de pesquisa ritual, worktree de origin/main | fase 0 do plano | regra de evidência + uma fonte de verdade |

## Lista de correção por classe (todos os casos, conferidos; detalhe e linhas no inventário)
- **C1 Regeneração por revisão global:** sim: syncControllers + rebuildController (todas as junções
  por edição e por troca do assessor), transit.rebuild, yardKey, ambient.parking e readBays
  (buildings.revision), entryLanes e signalsAsleep (doc.revision), destinos, armadilhas, ciclos,
  crossingSpans, calçadas, kerbBays, grafo e conflitos 2× por edição, topologia síncrona no quadro.
  world: lanelets (junções e ligações), elevação por componente e tooSteep antes/depois,
  carriageway, curbRamps, footwayRise, pavingIndex, walkways e WalkableSurface, levelPolygons 5×,
  solidsOf, openLots.rebuild, proposta de lotes, crossingAccesses, RoadContacts, derivedSigns,
  roadValue, siteGrading.forget, FloorCache, store.replaceWith, DocImage, adopt/copyFrom.
  render: camada de prédios (caminho inteiro, flyFlags, landCells, keptFor sem chão), natureKeep,
  coverKeep, buildScenery, mobiliário e placas, névoa, elementos, barreiras, transporte,
  estruturas, roomLamps, geometria dos semáforos, superfícies das vias (digest e união), flatAtlas,
  TerrainIndex e água/margem/ecologia por pincelada, canyonLight, lotOverlay, vagas por passe,
  chão dos ragdolls, jardins (setMap por quadro), inspetor. editor: clearBuildingsOnRoads,
  changedSegments, boreDeepCuts e draftStations, autosave da cabeça inteira, growPlants.
- **C2 Varredura para achar o perto:** findAnchor; snapPlacement (4 laços); snapBarrierPoint;
  lotAt × 400 passos e os snaps de lote; zoneLots; snapLandscape e a prévia da paisagem;
  transitTools.built; bulldozer (5); terrainBrush; corte do traço em commitDraftInPlace;
  materializeFree; reconcileMovedNode; overlapsAnother e segmentsThrough; pick e weldInto;
  anyLotHeightAt; footwayRiseShare; agents O(V+P); hailable; cycleFull; closedOn e crossingNearEnd;
  pedestrianAhead; laneClear; mayGo; greenWave; zonas dos parados no walk; elenco; strikeAt e
  explodeAt; streetNameOf; segmentStats; entrada do transporte; nearAny; railGraph; união das fitas
  O(S²) e faixas `[...kept, ...add]`; group em buildingsWiring.
- **C3 Edição que copia o documento:** clone em commitRoadPath (e na prévia), commitDraft,
  roundabout, streetObjects, snapshotRoads/guardRoadEdit; nodeMover toJSON/fromJSON; adopt 2×;
  replaceWith; DocImage; fromJSON O(n²); blocks (rede nova por linha); repair (até 64 rebuilds).
- **C4 Trabalho pesado na página:** simplificação de LOD (crowdLod.ts:256), corpos e expressões
  (um `Float32Array` do tamanho da malha por expressão, refeito a cada chamada, expressions.ts:24-31), trovão (125 a 270 mil amostras por raio,
  thunder.ts:22-31), terreno por pincelada, ecologia da placa, serializedDoc (main.ts:810) e exportar,
  uniões Clipper, heurística do A* no construtor (hybridAStar.ts:322), topologia (main.ts:2658-2660),
  geração da cidade, raster dos lotes, fratura enviada sem transferência (destruction.ts:240).
- **C5 GPU:** semáforos (frustumCulled=false com comentário falso, lentes todas por troca), fios numa
  Mesh, peças dos agentes reenviadas por quadro, decais e gore por quadro (quando há), todas as
  placas com conteúdo em detalhe e relevo de ~89 MB cada, atlas de placas além de 32.767 px,
  bandeiras e lotes com buffer inteiro (flagLayer.ts:157; lotOverlay.ts:255-262), canyonLight
  reenviando a textura inteira (canyonLight.ts:248-249), shaders em jogo (dimParts, dimShell, ghost,
  pintura por rebuild, assinaturas, corpos cozidos), 8 PointLights, cadeia de pós, sombra 4096² sem
  LOD, grama oculta criada e atualizada, impostores sem recorte, Math.random nas texturas.
- **C6 Ciclo de vida:** clone da geometria das bandeiras; InstancedMesh sem `dispose()` (estruturas
  structures.ts:827-829, postes das placas, prévia do transporte refeita a cada movimento do ponteiro
  renderer.ts:2693 e transit.ts:401, sombras de mancha blobShadows.ts:77-79, peças dos agentes); playEffects.dispose
  nunca chamado; dispose do terreno e do renderer incompletos; faceCardLayers; ShapeSettings do
  Jolt; disposeLanded × fila de aquecimento; YARDS e idByKey só crescem; setInterval e
  ConflictPool sem fim; workers sem tratamento de erro (LOD e fratura) e workers que desligam pela
  sessão na 1ª falha (roupa, bake, atlas); derivedCache preso; carga e bake rejeitados presos.
- **C7 Comportamento:** desfazer sem os demolidos; semáforos reiniciados; ghost eterno; reset sem
  assessor, pedestres e RNG; ônibus somem e trens saltam; pontos duplicados nos trilhos; pátio
  descartado; pessoas trocam de roupa; sobrancelhas opacas; placas somem; chuva pula; gêiser sem
  fim; pilar sobre a via; volante some; parado flutua e some após 1.200; walkDrunk; flip da seção;
  cidade sem coletoras; curva do lote fora do diário; projeções fora da validação; clique até
  160 m; vão nos muros; ecologia repetida; SEGURANÇA innerHTML; dois números de andar; tecla rouba
  a câmera; Shift-clique cria cerca; biblioteca de projetos apagada; exportar falha calado; dica com
  botão inexistente; inglês no pt-BR e F9 em português; bomba com Math.random no documento;
  poleLinesIn expulsa; simulação depende da câmera; furnishLot; overlay edita no desenho;
  desgaste ignora limpar/carregar; preço da prévia × cobrado (a provar no jogo).
- **C8 Amortizações (✔ cada constante aberta):** governador (sim/populationGovernor.ts),
  `SIM_FRAME_BUDGET_MS` 8 (sim/params.ts:21), `frameWork` 10 ms (core/frameWork.ts), TopologyCatchUp,
  fatias da camada (`WARM_SLICE_MS` 6, `LOADING_SLICE_MS` 50, `HIDDEN_SLICE_MS` 250,
  `STREAM_CELLS_PER_FRAME` 4, `STREAM_AHEAD` 8), dos lotes (`LAY_SLICE_MS` 12), da proposta
  (`PROPOSAL_BUDGET_MS`), das linhas de força, da bomba (4 prédios por quadro, actionsWiring.ts:399-408),
  `GROW_SLICE_MS` 100, uma textura por quadro (uploads.ts), `natureSweep` uma placa por quadro
  (renderer.ts:2956), ritmo do pincel (editor/CLAUDE.md), tetos de cache (facadeBays 1.024,
  poleLinesIn 64, turnPath 50.000, priced 50.000, chunks 128 MB) e das listas do jogador.
- **C9 Duplicação, morto, comentário falso:** chave de célula própria em 37 arquivos, 4 heaps,
  mulberry32 em 8 arquivos, `levelPolygons` do mapa em 5 lugares e três índices da mesma calçada
  (pavingIndex.ts, `pavingRings` de walkways.ts, walkable.ts), 3 diários; mortos: town/defaultTown/
  sampleTown, zoneGrid, zoning legado, fuseVolumes, Persistence.save/load, poleRouteWork, setLit, 6
  do facadeKit, assembleBuildingMeshesSteps, builderGizmos, passageiros do transit, rorCredit,
  clearClosures, QualityGovernor.sample, grama, dirtyNodes, changesSince e DeltaLog,
  surfaces/bands, poleLines(net), as chaves de i18n sem uso (166 `person.*` conferidas; o Hook contou
  559), ícones; comentários falsos por arquivo no inventário.
- **C10 Ambiente:** fase 0.

## Inventário (completo, por entrega)
### src/world — pistas de máquina (Auditoria, parte 0)
- ✔ code-rules: 187 entradas (per-input 112, per-frame 23, derived-per-frame 17, heavy-call 10,
  on-revision 9, derived-nested 9, nested 6, derived-per-item 1; recontado por grep). Por arquivo: doc.ts 56, lots.ts 47, solids.ts 10,
  elevation.ts 10, network.ts 8, junction/bulb.ts 8, roads/streetNames.ts 7, zoneGrid.ts 6, store.ts 5.
- ✔ on-revision: solids.ts solidsOf (5), carriageway indexOf, curbRamps rampSet, network ribbonOrder,
  footwayRise flushIndex. ✔ nested: junction/bulb clearBulbs (2), lots planLotsSteps (2), streetNames
  nameFor e streetNameOf.
- ✔ heavy-call: blocks.ts structuredClone (2), blueprints JSON (2), geometry facadeBays JSON, types
  cloneBuilding JSON (2), docImage copy/textBytes, roads/profile same JSON.
- ✔ lint: supressão de `roadcraft/no-module-state` em 23 arquivos de src/world (o relato dizia 26;
  elements 6, conflictPoints 4, elevation 4, poleLines 4, turnPaths 3); ✔ arquivos > 800 linhas: doc
  2.390, elevation 1.947, lots 1.044, lanelets 962, defaultTown 957, interior 906, procedural 813.

### src/editor — lido por mim (commit.ts 1-1083, editRules.ts 1-342, snap.ts 1-516, buildingSnap.ts 1-236)
- ✔ Cada via desenhada copia o documento INTEIRO (`commit.ts:120` `doc.clone()`, também :366 e
  `editRules.ts:113`) e o reescreve (`doc.replaceWith`, commit.ts:185/386, editRules.ts:136); a rede
  é reconstruída a cada pedaço (commit.ts:163) e o editor varre todos os nós/trechos (commit.ts
  422/698/745/767, editRules.ts 258/332). É a dívida da F2 (documento por comandos com inverso).
- ✔ `src/editor/CLAUDE.md`: "Every dab of the terrain brush re-solves the whole road network", contida
  por ritmo (amortização); e a regra velha da trava global do run-limited ("one at a time on the
  machine (a lock file)"), que não existe mais desde `03c2647`.

### src/render/buildings — lote 1 (34/34 arquivos lidos; conferidos por mim os marcados ✔)
- ✔ `layer.ts:697 anyLotHeightAt` varre todos os prédios por consulta; chamada por `renderer.ts:989`
  por pedestre a cada quadro → O(pedestres × prédios) por quadro.
- ✔ `buildingMesh.ts:458 Shell.face` triangula só 3–4 pontos; `emitLantern.disc` passa 8 e 24 →
  tampa do farol aberta (defeito visual).
- ✔ Caminho inteiro da camada disparado por qualquer mudança de chão, corte, ruína ou "ocultar
  outros" (a `rest` da chave, layer.ts:491); com corte aberto o diário nem é lido (`cutaway === null`
  na condição, 505-506).
- ✔ Pedidos de célula não cancelados no caminho inteiro (layer.ts:584-598; só há `drop` em 413-414 e
  `clear` em 708/718), no código ainda não commitado da Auditoria; ✘ "`signatureBodies` sem dispose"
  caiu: `keepOnly` chama `disposeSignature` (townIndex.ts:86-91); o que nunca é solto são os materiais
  e as texturas das assinaturas (signature.ts:182, 1789-1790); ✔ flagLayer reenvia o buffer inteiro
  (flagLayer.ts:157).
- ✔ Dado velho: `keptFor` compara só o texto do registro, não o chão (layer.ts:323-326); ✔
  `lotGroundAgain` usa o nível gravado na emissão (buildingMesh.ts:1895-1898).
- ✔ Por quadro e mapa inteiro: `landCells` (397) varre todas as células; `massCells.choose` (191-192)
  todas as células; `holdMass` + `setVisible` por todas as células (659-669).
- ✔ Variante instabilizada: `kit.dimParts` vê peças com e sem instanceColor (buildingMesh 3512/3557).
- ✔ Determinismo: números de luz (`slotFor`) dados na ordem dos pedidos (lightSlots.ts:29), que é a
  ordem em que os workers respondem.
- ✔ Código morto e comentários falsos: `assembleBuildingMeshesSteps` sem chamador; `streamCells`
  citado e inexistente; chave de célula em texto reparsada em 3 lugares (layer.ts:403, layerCells.ts:265,
  massCells.ts:158; o relato dizia 5).
- ✔ Amortizações: `STREAM_CELLS_PER_FRAME` 4, `STREAM_AHEAD` 8, `WARM_SLICE_MS` 6, `LOADING_SLICE_MS`
  50, `HIDDEN_SLICE_MS` 250, `CHUNK_CACHE_BYTES` 128 MB (layerCells.ts:37-66).

### src/render (Hook) — lote 1: scenery, vehicleModels, ragdollJolt, ragdollAxes, casualties, gore
- ✔ (conferido por mim) folhas das árvores nunca escondidas no zoom de mapa: o filtro procura
  `-leaves` (scenery.ts:740/790, renderer.ts:3152/3156/3159) e as malhas se chamam `…-cards`
  (scenery.ts:390/396). ✔ `exclude() {}` vazio nas duas implementações (619/793).
- ✔ `buildStreetFurniture` (scenery.ts:632) refaz o mobiliário do mapa inteiro a cada mudança de
  paisagismo, a cada hora com planta crescendo (renderer.ts:1586-1596) e a cada reconstrução do
  mundo; ✔ matriz montada 2× por item e duas cópias das esferas (scenery.ts:514-525, 545-550);
  ✘ "bounding sphere inútil" caiu: a esfera da geometria dá o alcance do recorte por instância (506-508).
- ✔ Duplicação vehicleModels.ts × carBody.ts (`tint`, `merge`, `seatShell`; um terceiro `merge` em
  propGeometry.ts:104).
- ✔ Vazamentos: casualties e gore só soltos por `playEffects.dispose`, que ninguém chama; ✔ ragdollJolt
  sem destroy dos `ShapeSettings` (ragdollJolt.ts:192, 198).
- ✔ Com sangue ou gore na tela, a faixa usada é reenviada todo quadro mesmo parado (casualties.ts:152-160,
  gore.ts:224-235); ✔ gore de passo variável (gore.ts:142); ✔ gore projeta sombra com frustumCulled=false
  (80-81); ✘ os decais não projetam sombra.

### src/sim — lote 1 (58 arquivos lidos; ✔ conferido por mim)
- ✔ BUG: toda edição de via perturba os semáforos da cidade inteira: `syncControllers` (world.ts:867)
  refaz todas as junções e `rebuildController` (fsm.ts:445) põe em ALL_RED/elapsed 0 quem estava em
  transição; a troca de controle do assessor (a cada 10 s) faz o mesmo (world.ts:631).
- ✔ BUG: `rt.ghost` só vira true (pipeline.ts:228/241); um id de faixa reusado (desfazer) fica morto
  para rota, vaga, troca de faixa, integração e surgimento.
- ✔ Pedestres comparam todos os carros estacionados por passo e refazem as zonas de todos quando um
  carro de lote ou caminhão se mexe (walk.ts:1660–1700).
- ✔ `yardKey` (lorryDocks.ts:422) com `net.revision`: qualquer via invalida todos os pátios (grade
  0,1 m + A* ~50 mil poses por doca); pátio de prédio apagado nunca sai (vazamento ~2 MB cada).
- ✔ `reset()` não limpa assessor/fluxo (world.ts:310-333); ✔ RNGs próprios não reiniciados
  (lotTraffic.ts:102, lorryTraffic.ts:86, ambient.ts:114, `readonly`, sem reseed).
- ✔ `rt()` cria o estado da faixa quando só lê (world.ts:351-357); ✔ `c.elapsed += DT` fora do
  controlador (pipeline.ts:91).
- ✔ Custos por passo: admissão pelos detentores por pedido; `cycleFull` todos os veículos por pedido
  (cycles.ts:64); `vehiclesInIdOrder` reordena a cada mudança da frota (world.ts:375-379);
  `enterLanelet` reordena a fila inteira (world.ts:902-904); rota de pedestre aloca três arrays do
  tamanho de todos os nós de calçada (walk.ts:538-554); `mayGo` dos caminhões O(pedestres)
  (lorryTraffic.ts:392).
- ✔ Determinismo: o ambiente depende da câmera (`w.focus`, walk.ts:1703-1711).
- ✔ Comentários falsos: hybridAStar.ts:31 × 397 ("No Reeds-Shepp shot" e tem), world.ts:612 ("rebuilds
  that junction's controller"), admission.ts:1094 ("falls through").

### src/world (Auditoria) — parte 1: rede, diário, caminhos, alturas 1–830, junções (✔ por mim)
- ✔ BUG desfazer: `history.end(doc)` (main.ts:829) fecha o passo antes de `afterRoadEdit` (837,
  demolição) e `clearBulbs` (839): desfazer a via não devolve os prédios demolidos.
- ✔ `Network.changesSince`/DeltaLog sem leitor (grep); ✔ `ribbonOrder` refeito por revisão
  (network.ts:61-66).
- ✔ `adopt`/`copyState` copia 7 coleções, 2 grades `CellFiling` inteiras e as polilinhas
  (network.ts:245-270), 2× por via desenhada (commit.ts:126, 186); ✔ `build.copyFrom` copia 15 `Map`,
  1 `Set` e uma grade (networkBuild.ts).
- ✔ A superfície de travessia e TODAS as distâncias de faixa jogadas fora a cada `adopt`
  (network.ts:268-269); ✔ `lanelets.buildLinks` pede a linha de parada das duas pontas de todo trecho
  (lanelets.ts:276-277), e o grafo é montado 2× por edição (sim world.ts:528-566).
- ✔ Alturas: a componente conexa inteira marcada como mudada (elevation.ts:599-614), e a prévia do
  traço refaz as alturas (dryRun, commit.ts:181 → draftStations 278-280).
- ✔ `setMarkingStyle` grava 'roads' com rects=null (doc.ts:914).
- ✔ Caminhos: grafo inteiro por revisão, duas cópias (sim `ensureGraph`, code-rules.baseline.json:235;
  editor transitTools.ts:81); ✔ `WalkingLines` une as linhas de cada deck com Clipper (walkways.ts:359);
  ✔ `stretch` e `onPaving` (walkways.ts:317-318, 467-479).
- ✔ `clearBulbs` (junction/bulb.ts) roda em toda edição (main.ts:839), varre todos os cruzamentos e
  copia postes e elementos por balão (139-144); não tira bancos/árvores, contra o comentário (124-127).
- ✔ Diário: documento trocado com serial maior devolve [] em silêncio (changes.ts:243). ✘ "leitor de
  diário continuado recebe null mesmo sem nada faltando" caiu: após `continueFrom`, quem viu tudo ou
  não tem entrada nova do seu tipo recebe [] (changes.ts:185-198, 241-252).

### src/render/buildings — lote 2 (✔ por mim)
- ✔ Vazamento de GPU: `flagLayer.set` clona a geometria (130) e `InstancedMesh.dispose` do three
  (r186 :396) não descarta a geometria → vaza a cada edição de prédio.
- ✔ Vazamento: `disposeLanded` descarta malhas ainda na fila de aquecimento, e `warmOne` as desenha
  sem checar (cellRequests.ts:129; uploads.ts:172-188).
- ✔ Código morto: `lightSlots.setLit` sem chamador (lightSlots.ts:63); `slotFor` tem teto
  (`SLOT_WIDTH * SLOT_ROWS`, lightSlots.ts:28); ✔ facadeKit mansard, marquise, quoins, rustication,
  shopfront e terraceGarden sem chamada (o `roofPlant` chamado em signature.ts é outra função).
- ✔ Shaders compilados em jogo: dimParts, dimShell, ghostShell e ghostParts fora do aquecimento
  (renderer.ts:1949); ✔ assinaturas criam material e textura em jogo (signature.ts:182), projetam
  sombra (1773), `Math.random` nas texturas (73-257), materiais nunca descartados (1789-1790).
- ✔ massing.ts repete o parapeito e o beiral do buildingMesh (massing.ts:55, 59, 278, 285).

### src/render (Hook) — lotes 2a e 2b (✔ por mim)
- ✔ `gardens.setMap` zera o recorte (gardens.ts:513) e é chamado no desenho de cada quadro
  (renderer.ts:3148): os jardins são recortados de novo a cada quadro com a câmera parada; cards dos
  jardins também nunca somem no mapa (`setMap` ignora o argumento); ✔ `update` zera `shown` de todos
  os estoques a cada prédio (gardens.ts:504-507); ✔ duas árvores de recorte (a dos jardins,
  gardens.ts:416, e a do `createInstanceCull`, instanceCull.ts:224), com as funções em comum.
- ✔ `riggedCitizens.ts:115 CAST_FORGET=3600` passado como teto `remember` (citizenCasting.ts:254,
  padrão 40.000): só 3.600 pessoas lembradas, as outras voltam com outra roupa.
- ✔ gardenLists: `site.seen` só avança quando replantado (gardenLists.ts:103-105), e `touches` relê o
  diário desde ele a cada pergunta (até 2.048 entradas por tipo, changes.ts:95, 267-277); diário
  esquecido replanta a cidade inteira (82-84).
- ✔ roadSurfaces: cada reconstrução monta as entradas e o digest de cada ladrilho alcançado
  (735-780, 877-910); união Clipper das calçadas por passe (560); material de pintura criado no
  rebuild (361). O "~10 mil malhas" e o "bloco 4×4" do relato não foram medidos e saem.
- ✔ flatAtlas: cada mudança lê o documento inteiro (326-339) e filtra todas as pinceladas por placa
  (392-401); todas as placas com conteúdo vão a "full" (303); o terreno de longe cria uma superfície
  só para usar o material, com um relevo alocado que não usa (197, 226-228). ✔ ~89 MB de relevo por
  placa em detalhe (terrainRelief.ts:300-310); a ligação com o `GL_OUT_OF_MEMORY` é provável, não provada.
- ✔ lowPolyTrees: as folhas de perto dependem da distância do olho no shader (706), e na vista
  isométrica o olho está longe.
- ✔ riggedCitizens (corpos cozidos: jogador, ocupantes, elenco do cenário): paleta montada na CPU por
  pessoa por quadro e copiada "para o caso de ragdoll" (889-898); textura de morph reenviada inteira
  (1076); carga que falha fica presa (659, 671-675); sem `compileAhead`. ✔ citizenCasting percorre os
  portadores por pessoa nova (374). ✔ crowdLod: simplificação síncrona na página (256); erro do
  meshopt engolido (92).
- ✔ playEffects: `frame` percorre todos os pedestres em todo quadro, mesmo sem tiro (387); `dispose`
  nunca chamado. ✔ Ruínas projetam sombra (destruction.ts:157, 164), sem LOD, e a troca de mapa não
  as limpa (sem `reset`); ✔ o worker da fratura não tem tratamento de erro.

### src/editor — por ponteiro (lido por mim)
- `snap.ts findAnchor` varre todos os nós (113) e trechos (132) a cada movimento do ponteiro;
  `buildingSnap.ts` varre todas as fitas (84, 127) e todos os prédios (160, 190) por movimento.

### src/sim — COMPLETO (66 arquivos, 21.854 linhas, S7; ✔ conferido por mim)
- ✔ Ônibus somem e trens teletransportam a cada edição de via em qualquer lugar: `transit.rebuild`
  pela chave com `topologyRevision` tira todos os ônibus (transit.ts:162-164) e repõe os trens;
  ✔ `points.push(...(points.length ? leg.slice(0) : leg))` (207): ponto duplicado em cada junta.
- ✔ `reset()` não esquece fluxo/assessor (world.ts:310-333).
- ✔ Caminhão: `yardFor(pick)` joga fora o pátio em planejamento (lorryTraffic.ts:204-206, 233).
- ✔ Por passo, O(mapa): `cycleFull` varre todos os veículos por pedido (cycles.ts:60-70; admission.ts:414);
  `bankerSafeAfterGrant` todos os detentores (admission.ts:910-912); `hailable` todos os pedestres por
  carro (walk.ts:931-946; kerbStops.ts:392, 426); `pedestrianAhead` todo veículo com alguém nas faixas
  (obstacles.ts:20-34); `closedOn/crossingNearEnd` todas as passagens de nível (transit.ts:395-420);
  re-sort das faixas ocupadas + `indexOf` (integrate.ts:168-176; leaderIndex.ts:34); `mayGo` O(P).
- ✔ Por edição: grafo e conflitos 2× (world.ts:528-566), sinais de todas as junções (870), calçadas
  (sidewalk.ts:83-90), destinos por faixa de partida (destination.ts:61-68), pátios (yardKey), vagas
  (ambient.ts:837), entradas e sinais dormindo pela chave `doc.revision` (spawn.ts:89, world.ts:470).
  ✔ Leitores do diário que confiro: buildingOrder (o único que confere o documento, buildingOrder.ts:42),
  ambientIndex (ambientIndex.ts:43-48), lotPlaces (lotPlaces.ts:160-164).
- ✔ Duplicação: chaves de célula próprias (parking, kerbBays, ambientIndex, lotPlaces, walk, kerbStops,
  lorryDocks estão entre os 37 arquivos), 4 heaps próprios (há @core/heap).
- ✔ Morto: API de passageiros do transit (sem chamador fora de transit.ts), `rorCredit`
  (`RIGHT_ON_RED_ALLOWED = false`), `pairOpposingGroups` (só sem `conflictsOf`, e world.ts:749 sempre
  passa), `clearClosures`. ✔ Comentários falsos: relógio (sim/CLAUDE.md:64-67 × clock.ts:23-29),
  hybridAStar "sem Reeds-Shepp" (31 × 397), "O(log n)" do sorteio de lugares (ambient.ts:670 ×
  lotPlaces.ts:275).

### Orquestração e desenho (S1: main, wiring, frameLoop, renderer, pós, 17 arquivos inteiros; ✔)
- ✔ `QualityGovernor.sample` sem chamador: o "auto" de qualidade não existe (quality.ts:5-7 mente).
- ✔ Toda edição de via refaz inteiros: natureKeep (chave com `net.revision`, renderer.ts:2381),
  coverKeep (até 25.000 candidatos, 2899-2903), buildScenery (1806), mobiliário e a camada de placas
  (1612-1622; ✘ "O(nomes × fitas)" caiu: as placas acham a rua por `ribbonsMeeting`, signs.ts:176),
  névoa (3453), elementos (3465), barreiras (2852-2860), transporte com pointInPolygon em todos os
  prédios (2870-2876); topologia síncrona no quadro (main.ts:2658-2660) além do TopologyCatchUp;
  `mutateBuilt` net.rebuild + afterRoadEdit + clearBulbs (main.ts:835-839).
- ✔ Crescimento O(n²): `lots.some` por lote recusado (main.ts:2130), `buildingsAreaOf` com todos os
  prédios a cada prédio crescido (renderer.ts:1334-1337, usado em 2819) e `tallestBox` (3276-3279).
  ✔ Grama criada e atualizada por quadro, nunca mostrada (`show = false`, 3343-3349).
- ✔ Pós: MSAA até 8× em HalfFloat, GTAO, canyon, bloom, nuvens sempre, SMAA, saída com 5 tonemaps
  por pixel com nitidez; ✔ 8 PointLights (2 de efeito + `ROOM_LIGHTS` 6, renderer.ts:99, 751-754,
  1203-1209) avaliadas em todo material iluminado; ✔ sombra 4096² no padrão, sem LOD.
- ✔ Defeitos: derivedCache preso após `versionchange` (derivedCache.ts:20-48); Math.random decide o
  que a bomba remove do documento (actionsWiring.ts:315, 328); dispose do renderer sem fumaça, grama,
  desgaste, barreiras, transporte, postes, placas, prévias, efeitos e `gpuTimer`; setInterval
  (main.ts:2562, 4278) e ConflictPool nunca encerrados.

### src/render (Hook, 113 arquivos inteiros + agents.ts e signals.ts pessoais; ✔)
- ✔ Semáforos: `frustumCulled=false` justificado por comentário falso (signals.ts:178); ✔ 532
  triângulos por cabeça (geometrias de signals.ts:124-134: poste e braço 32 cada, caixa 12, 6 lentes
  288, 2 halos 96, 6 viseiras 72), no mapa todo; ✔ uma troca de fase reescreve as lentes de todas as
  cabeças (350-368); ✔ refeitos por qualquer revisão da rede, do tráfego, do terreno ou da topologia
  (280-284).
- ✔ agents.sync O(veículos + TODOS os parados) por quadro, altura antes do teste de tela
  (agents.ts:2008-2023); ✔ todas as peças zeram `n` (1987) e reenviam o prefixo usado a cada quadro
  (2262-2264); ✔ pedestres pagam `footwayRiseShare` (todas as ruas rentes, footwayRise.ts:42-57).
  ✔ Bugs: volante some nos parados (1641-1655 × 1407), parado flutua após editar terreno (1825-1834),
  parados somem passados `MAX_VEHICLES = FLEET_CEILING` 1.200 desenhados (76, 2009).
- ✔ Terreno: todas as placas com conteúdo em detalhe (flatAtlas.ts:303), ~89 MB de relevo por placa;
  por pincelada, `TerrainIndex` inteiro (terrain.ts:3200), esfera sobre a grade inteira (3277) e de 3 a
  5 MB reenviados (posição, normal, inclinação e índice); água refeita fora do traço (3238, 3286).
- ✔ Multidão procedural: `takeRow(cls, false)` nunca reaproveita linha (proceduralCrowd.ts:1952, 1991),
  e `renderPalettes` passa todas as linhas em todo quadro (2312-2316).
- ✔ Bugs visíveis: sobrancelhas opacas após 24 cartões (skinAppearance.ts:47); placas com mais de 256
  nomes passam de 16.384 px e com mais de 512 passam de 32.767 px (8 colunas de 272 px, linhas
  dobrando, signs.ts:229-232, 266); chuva pula no zoom (rain.ts:73, 109, 124); gêiser sem fim
  (blast.ts:625); pilar sobre a via (structures.ts:285-299); água salta a cada 1.000 s (water.ts:220, 560).
- ✔ Travas: worker de LOD sem `onerror` (lodPool.ts) e sem `try` (lodWorker.ts:78-89); carga de corpo
  que falha fica presa (riggedCitizens.ts:659, 671-675); 3 workers desligam pela sessão na 1ª falha.
- ✔ Erros engolidos no 2º argumento de `then` ou em `catch` vazio (crowdLod.ts:92, personRig.ts:811,
  proxy.ts:203, renderer.ts:3091).

### src/world partes 2–4 (Auditoria; ✔ por mim os marcados)
- ✔ BUG `flipSection` × `sameRoadSection` (roadSection.ts:179/196/223): ordem de chaves diferente
  comparada por JSON; o editor não junta dois trechos iguais quando um está invertido.
- ✔ BUG `levelOf` (cityGen/plan.ts:56-60): cidade com n ímpar < 8 sai sem coletoras.
- ✔ `poleLinesIn` expulsa um retângulo sem relação mesmo com a chave presente (poleLines.ts:237/249).
- ✔ `pruneOrphanNodes` grava `null` = mapa inteiro (doc.ts:1196) a cada via apagada.
- ✔ `moveNode` grava o retângulo DEPOIS da mudança (doc.ts:800-802; a área antiga não vai ao diário).
- ✔ `lots.ts:569` splice com spread de todos os lotes; ✔ `doc.ts:2017` O(lotes²) em toda carga e em
  cada restauração; ✔ `facadeBays` JSON.stringify por chamada (geometry.ts:580); ✔ `interiorAt` sem
  cache (interior.ts:172); ✔ `homeUnits` deriva todos os andares para usar um (811); ✔
  `store.replaceWith` troca todos os registros e joga a grade fora (store.ts:279-290).
- ✔ Tetos que apagam o trabalho do jogador sem aviso e gravam `null` cheios: pinceladas 60.000,
  névoa 20.000, ravinas 20.000, elementos 60.000, carimbos 4.096, árvores 20.000, clareiras 10.000
  (doc.ts:982-1135 e as constantes em terrainPaint, fogPaint, gullies, elements, terrain, trees).
- ✔ `levelPolygons` do mapa em 5 lugares de produção (calçada: roadSurfaces.ts:560, lots.ts:740 e 969,
  walkways.ts:282; asfalto: lorryDocks.ts:457).
- ✔ Ecologia com coordenadas locais da placa e a semente do mapa (ecology.ts:393-421): o desenho se
  repete de placa em placa (por leitura; não fotografado).
- ✔ Morto: town/defaultTown/sampleTown (só se importam entre si), poleLines(net), sampleWire,
  buildZoneGrid, polePositions, poleArms (nenhuma chamada em src/); `Network.changesSince` sem leitor;
  `dirtyNodes/dirtySegments` sem leitor fora de doc.ts.
- ✔ **O caminho da edição hoje** (um traço), cada passada aberta no código: `doc.clone` do mapa
  (commit.ts:120, também na prévia), 2× `adopt` (126, 186; 7 coleções, 2 grades, 15 `Map` e 1 `Set`),
  `replaceWith` das vias (`roadDifferences` doc.ts:1358, `sameRoads` 1553, cópia dos nós 1560) e dos
  prédios (`toText` ×2, store.ts:279), DocImage comparando todos os registros (docImage.ts:169-171):
  pelo menos 6 passadas O(mapa) por traço.
- **Desenho F2 (Auditoria, fontes: Immer patches, tldraw history):** transação no documento vivo
  (`begin/commit/rollback`), cada escritor guarda a imagem de antes do registro que toca; o patch
  sai do escritor, não de comparar cópias; diário com operação e tipo por id e retângulo antes ∪
  depois; prévia, recusa e cancelamento por rollback; `afterRoadEdit`/`clearBulbs` dentro da
  transação (corrige o desfazer). Ordem: diário → escritores únicos dos lotes → transação no lugar
  do DocImage (com prova de equivalência) → nodeMover/guard → traços sem clone → leitores do delta.

### Conferência pessoal, achado por achado (abri arquivo:linha; ✔ confere, ✘ cai)
- **sim (S7):** ✔ syncControllers todas as junções (world.ts:870) + rebuildController ALL_RED
  (fsm.ts:468-474, currentGreenGroups [] fora de GREEN, 488) · ✔ reset sem flow/advisor (310-333) ·
  ✔ ghost nunca volta a false (pipeline.ts:222-244; só world.ts:354 cria false) · ✔ yardFor joga
  fora o pátio em planejamento (lorryTraffic.ts:204-206, 233) · ✔ yardKey global e YARDS sem
  delete (lorryDocks.ts:422, 432-436) · ✔ walk refaz zonas de todos os parados quando carro de
  lote/caminhão anda (walk.ts:1670-1694; lotTraffic.ts:160; lorryTraffic.ts:141) · ✔ spawn.ts:89 e
  world.ts:470 por doc.revision; ✘ "o envelhecimento move doc.revision": doc.revision =
  serialOf('roads') (doc.ts:386), só edição de via · ✔ CLAUDE.md:64-67 × clock.ts:23-29 ·
  ✔ hybridAStar.ts:31 × 397 · ✔ ambient.ts:670 "O(log n)" × lotPlaces.ts:275 · ✔ plan.ts:551-556 ·
  ✔ admission.ts:1094 × 1112-1118 · ✔ pedPose 4 objetos (pose.ts:261-267) · ✔ só buildingOrder.ts:42
  confere o documento · ✔ cycleFull todos os veículos (cycles.ts:64) · ✔ banker por detentores ·
  ✔ hailable todos os pedestres (walk.ts:935) · ✔ closedOn/crossingNearEnd todas as passagens
  (transit.ts:395-420) · ✔ integrate.ts:169 "O(1)" × indexOf (leaderIndex.ts:34) · ✔ void need
  (crossings/permission.ts:50) · ✔ indexReservations O(V) · ✔ vehiclesInIdOrder sort por versão ·
  ✔ kerbStops.ts:298 ternário igual · ✔ laneClear O(V) · ✔ greenWave.ts:26 todos os conectores ·
  ✔ destination cache por faixa de partida · ✔ mayGo O(P) (lotTraffic.ts:474, lorryTraffic.ts:392)
  · ✔ Rng sem reinício (readonly, nenhum reseed) · ✔ simulação depende da câmera (walk.ts:1703) ·
  ✔ API de passageiros sem chamador fora de transit.ts · ✔ transit.ts:162-164 e 207.
- **orquestração (S1):** ✔ rebuild + topologia no quadro (main.ts:2658-2660) · ✔ 40 ms × 100
  (2061 × 2142) · ✔ surfaceTop O(nós) por doc.revision (970-982) · ✔ crescimento por setInterval
  500 ms (2562); ✘ do Hook "lots.some a cada quadro" · ✔ decayWatch percorre o Map due inteiro ·
  ✔ grama show=false com update por quadro (renderer.ts:3343-3349) · ✔ chaves globais natureKeep
  (2381), coverKeep (2901), placas (1617), névoa (3453), elementos (3465) · ✔ buildScenery inteiro
  (1806) · ✔ transporte pointInPolygon em todos os prédios (2874) · ✔ QualityGovernor.sample sem
  chamador · ✔ postprocess 10 × 16 (1119 × 1125), `!= DEPTH_FAR` (1308), cloudsReady no finally
  (418) · ✔ setSmog × fog null + void smog (environment.ts:103, 377, 625) · ✔ blink DoubleSide
  transparente (renderer.ts:589) · ✔ derivedCache fechado em versionchange e preso (20-48) ·
  ✔ Math.random tira postes do documento (actionsWiring.ts:315, 328) · ✔ ConflictPool sem terminate.
- **render (Hook):** ✔ faceCardLayers sem delete, -1 após 24 (people/skinAppearance.ts:47) ·
  ✔ atlas de placas só dobra (signs.ts:266) · ✔ chuva pula no zoom (rain.ts:73, 109, 124) ·
  ✔ gêiser Infinity (blast.ts:625; actionsWiring.ts:343) · ✔ CasingIndex só nos vértices
  (structures.ts:285-299) · ✔ volante fora do recording (agents.ts:1641-1655 × 1407) ·
  ✔ offRoadDecks por (x, y) (1825-1834) · ✔ takeRow(cls,false) nunca reaproveita
  (proceduralCrowd.ts:1952/1991) · ✔ walkDrunk fora de gaitClipsOf (citizenGait.ts:184-211) ·
  ✔ lodPool sem onerror, lodWorker sem try · ✔ carga rejeitada fica em `loading`
  (riggedCitizens.ts:659, 671-675) · ✔ bake rejeitado prende `waiting` (733-740) · ✔ dispose do
  terreno sem verge/ecologia (3292-3300) · ✔ chave do chão dos ragdolls sem prédio movido
  (playEffects.ts:290) · ✔ água: drift das ondas pelo vento × volta de 1.000 s (water.ts:220, 560) ·
  ✔ flatAtlas `{home, ...content}` (303) · ✔ relevo HalfFloat 2048²×2 com mipmaps
  (terrainRelief.ts:300-310) · ✔ agents O(V+P) com altura antes da tela (2008-2023) ·
  ✔ footwayRiseShare linear (footwayRise.ts:42-57) · ✔ fios numa Mesh com castShadow
  (poleLayer.ts:227-230) · ✔ elenco percorre portadores (citizenCasting.ts:374) ·
  ✔ InstancedMesh.dispose não solta geometria (three r186 WebGLObjects onInstancedMeshDispose).
- **render/buildings (S2):** ✔ setLit sem chamador · ✔ streamCells só em comentário ·
  ✔ assembleBuildingMeshesSteps sem chamador · ✔ keptFor só pelo texto do registro, sem o chão
  (layer.ts:323-326) · ✔ flyFlags todos os mostrados (338-343) · ✔ landCells todas as células (397)
  · ✔ caminho inteiro com qualquer `rest` diferente (505-506) · ✔ levelOfDetail por célula por
  quadro (659-669) · ✔ dimParts com e sem instanceColor (buildingMesh.ts:3512, 3557) ·
  ✔ Math.random nas texturas de assinatura (signature.ts:73-257) · ✔ facadeKit mansard, marquise,
  quoins, rustication, shopfront, terraceGarden sem chamada, aceitos no knip.baseline.json.
- **world (Auditoria):** ✔ facadeBays JSON por chamada, LRU 1.024, comentário em português
  (geometry.ts:576-589) · ✔ store.replaceWith toText ×2, troca tudo, grade nula (279-290) ·
  ✔ splice com spread (lots.ts:569) · ✔ moveNode marca depois (doc.ts:800-802) · ✔ fromJSON O(n²)
  (2017) · ✔ utilities null por paisagismo (1555, 1368) · ✔ restore traffic sempre (1458) ·
  ✔ dirtyNodes/Segments enchidos com o mapa (1684-1686) · ✔ tetos com shift e null + resto de
  edição na linha (983, 989, 995) · ✔ snapLandscape todas as faixas (landscape.ts:413) ·
  ✔ changedSites caixa única (siteGrading.ts:93-95) · ✔ solidsOf com anéis que o único leitor pula
  (solids.ts:63-71; playEffects.ts:315) · ✔ validate caixa sem projeções (validate.ts:174-187) ·
  ✔ pick teto 160 m (pick.ts:65) · ✔ DocImage samePlain em todos (docImage.ts:169-171) ·
  ✔ shapeBounds de todos os pads (pads.ts:197) · ✔ vão de 2 m no muro (cityBuildings.ts:145) ·
  ✔ homeUnits deriveSpaces inteiro (interior.ts:811) · ✔ ecologia local + semente do mapa
  (ecology.ts:393-421; efeito não fotografado) · ✔ turnPaths memo esvazia (481) · ✔ roadValue todas
  as vias, cache esvazia (economy.ts:115-124) · ✔ carriageway por net.revision · ✔ junctionDetail sem
  view (comentário falso) · ✔ elevação marca a componente inteira (elevation.ts:599-614) ·
  ✔ curveLotSide controle fora do retângulo (lots.ts:876, 901) · ✔ store null se uma caixa falta ·
  ✔ idByKey só cresce · ✔ nada em sim lê postes/mobília · ✔ copyFrom Set por célula ·
  ✔ mainRoadLegs sem memo · ✔ roadSection, levelOf, poleLinesIn, pruneOrphanNodes (acima).
- **editor, ui, people, core (Hook):** ✔ snapBarrierPoint todas as fitas (barriers.ts:26) e
  Shift-clique sem muro põe ponto (114-119) · ✔ pincel de zona `lots.find` × 400 passos
  (lotTool.ts:305, 497-500) · ✔ zoneLots ids.includes (lots.ts:910) · ✔ grab toJSON inteiro
  (nodeMover.ts:54) · ✔ prévia da paisagem lê tudo (streetscapeTool.ts:105) · ✔ nearAny linear ·
  ✔ transitTools built() antes da distância (transitTools.ts:85) · ✔ SEGURANÇA innerHTML com nome e
  cor do mapa (shell.ts:1693; world/transit.ts:87, 107) · ✔ andar 590 × insideBar.ts:56 ·
  ✔ terrainBrush todos os carimbos (214) · ✔ export sem try, string única indentada
  (persistence.ts:537) · ✔ blueprintLibrary um try para a lista (37-59) · ✔ expressionShapes ignora
  o corpo e aloca por chamada · ✔ proxy.ts:203 catch calado · ✔ regionIndex comentário XOR × somas
  (142-151) · ✔ clipper cai calado no Martinez e repete o Clipper2 (123-146) · ✔ RESERVED sem
  w/a/s/d (ui/roads/keys.ts:16-18) · ✔ clearBuildingsOnRoads todos os prédios por edição
  (buildings.ts:657) · ✔ furnishLot só `return true` (lotPlan.ts:1266) contra o comentário 290-294 ·
  ✔ streetNameOf placas × fitas (streetNames.ts:41-58) · ✔ inspetor todas as faixas e chave global
  (inspector.ts:136, 228) · ✔ duas barras de andar (buildingsWiring.ts:159-160) · ✔ F9 em português
  (healthWatch.ts:111, 145) · ✔ autosave cabeça inteira (chunkedSave.ts:91) · ✔ bulldozer 5
  varreduras (bulldozer.ts:137-145) · ✔ blocks rede por linha · ✔ repair 64 rebuilds · ✔ powerLine
  fatiado · ✔ frameWork 10 ms · ✔ câmera heightUnder por quadro (cameraMotion.ts:229, 235).
- **lidos por mim inteiros:** editor/commit.ts 1-1083 (corte do traço sem índice 422-501,
  materializeFree 698, reconcileMovedNode todos os trechos e até 16 rebuilds 745-797,
  moveNodeChecked snapshot 811, boreDeepCuts e draftStations todas as vias 212, 268), editRules.ts
  1-342 (changedSegments JSON 142-156, tooSteep antes/depois 221-222, overlapsAnother 258,
  segmentsThrough 332, snapshot/guard clone 113, 136), snap.ts 1-516 (findAnchor `@perInput` com
  todos os nós 113 e trechos 132, roadProfile alocado antes da caixa 137-140), buildingSnap.ts 1-236
  (snapToRoad 84, cornerFlush 127, nearestBuilding 160, flush 190). **O analisador já acusa os
  quatro: estão aceitos em code-rules.baseline.json:266-269, 329-332, 366-367.**
- **mais render e sim:** ✔ lentes todas por troca (signals.ts:350-368) · ✔ união das calçadas
  (roadSurfaces.ts:560) · ✔ readContent e pintura por placa (flatAtlas.ts:326-339, 392-401) ·
  ✔ gardens.update zera tudo (504-507) · ✔ playEffects.dispose sem chamador · ✔ ShapeSettings do
  Jolt sem destroy (ragdollJolt.ts:192, 198) · ✔ growPlants por hora (renderer.ts:1586-1596) ·
  ✔ decais por quadro (casualties.ts:152-160) · ✔ gore passo variável (142) · ✔ destruction sem
  reset · ✔ paintMaterial novo por chamada (markings.ts:120; roadSurfaces.ts:361) · ✔ disposeLanded
  × toWarm sem checagem (cellRequests.ts:129; uploads.ts:172-188; código não commitado da
  Auditoria) · ✔ lightsOf nunca invalida · ✔ wear 5 m/texel × comentário 0,94 m, 48 MB (wear.ts:22-46)
  · ✔ folhas perto pela distância do olho (lowPolyTrees.ts:706) · ✔ slotFor pela ordem dos pedidos
  (lightSlots.ts:29) · ✔ massing repete o telhado do buildingMesh · ✔ prepGraph + graph 2× (sim
  world.ts:528-566) · ✔ history.end antes de afterRoadEdit com comentário falso (main.ts:829-839) ·
  ✔ setMarkingStyle null (doc.ts:914) · ✔ calçadas da sim do zero (sidewalk.ts:83-90) · ✔ openLots
  copia todos · ✔ queue.shift na geração · ✔ railGraph linear · ✔ união das fitas O(S²)
  (lots.ts:300-305) e `[...kept, ...add]` (476) · ✔ TerrainIndex por revisão (terrain.ts:3200) ·
  ✔ stopLineDistance 2 por trecho (lanelets.ts:276-277) · ✔ conflitos todas as junções
  (conflictPoints.ts:199, 261) · ✔ adopt 2× por traço (commit.ts:126, 186) · ✔ vagas do mapa por
  passe (render/markings.ts:214) · ✔ clone do prédio por movimento (buildingTool.ts:2297) ·
  ✔ cutView fica (serialize.ts:408; types.ts:435).
- **✘ caíram na conferência (relatos errados):** "o envelhecimento move doc.revision" (S7;
  doc.revision é o serial de 'roads'); "lots.some a cada quadro" (Hook; está no setInterval de
  500 ms); "toText a cada passo de desfazer" (Auditoria; history.serialize só no autosave,
  main.ts:810). Os leitores também derrubaram dezenas de pistas falsas das linhas de base.
- **cauda, também aberta por mim:** ✔ inglês no pt-BR (pt-BR.ts:1133, 1432, 1810-1811) · ✔ dica
  "Remover zona" × botão "Tirar zona" (61 × 15) · ✔ ícone FALLBACK · ✔ builderGizmos `handles: []` ·
  ✔ 166 chaves person.* sem uso, creator.* só dock/pattern · ✔ statechart não reentra ancestral ·
  ✔ perfBudget 2,5 s aceito · ✔ comentários de unidade velha (viewport.ts:119, wear.ts:22) · ✔ texto
  em português no código (cameraGestures.ts:137-139) · ✔ careca com cabelo (spec.ts:191 × 231) ·
  ✔ wornBy find · ✔ preço da prévia sem largura/perfil (roadTool.ts:437-485) · ✔ overlay edita no
  desenho (lotTool.ts:144, 644, 226-232) · ✔ zoning legado, fuseVolumes e poleRouteWork só com teste
  · ✔ terrainBrush teto de 12 · ✔ autosave por número de prédios (persistence.ts:153) · ✔ semáforos
  por qualquer revisão e DynamicDraw em estáticos · ✔ setHex por peça · ✔ rebuildWater fora do traço
  · ✔ renderPalettes todas as linhas · ✔ gaveta por innerHTML, sigOf, templates, connectorPanel ·
  ✔ forma dos veículos, array esparso, MOVEMENT_TOKENS · ✔ vehicleModels × carBody · ✔ gardenLists ·
  ✔ elenco a cada 240 · ✔ 55° × 30° (intenção a confirmar) · ✔ flushIndex · ✔ mulberry32 em 8
  arquivos · ✔ clearBulbs não tira paisagem · ✔ applyStyle · ✔ carimbos com shift e null ·
  ✔ comentário da varanda sem código · ✔ TUNNELS_DRAWN · ✔ section.ts e geometry.ts velhos ·
  ✔ profile por JSON · ✔ duas políticas de roupa de criança · ✔ erros engolidos (crowdLod.ts:92,
  personRig.ts:811) · ✔ painel do cruzamento por índice · ✔ halfWidth(Curb) com calçada nivelada.
- **Rodada de conferência do plano inteiro (todas as afirmações abertas no código, no git ou no
  documento):** ✔ o resto confere, com as linhas citadas em cada seção. ✘ Caíram e foram corrigidas:
  "BatchedMesh nos prédios" (meu, só um comentário); "metade dos workers sem onerror" (são 2 de 10);
  "a multidão já tem os dois níveis" (meu); "decais projetam sombra"; "bounding sphere inútil";
  "signatureBodies sem dispose"; "chave reparsada em 5 lugares" (são 3); "copyFrom 16 mapas" (15 `Map`,
  1 `Set` e uma grade); "buildSigns O(nomes × fitas)"; "leitor de diário continuado recebe null";
  "a fumaça é InstancedMesh" (é `Points`); "estado solto em 26 arquivos de src/world" (são 23);
  "~18 cursores, 10 grades, 7 ordens, delta ×6" (recontados
  ou tirados); "487 entradas" (485); "relatório de 11/10" (a citação estava certa, faltava o arquivo);
  o perfil (32,6 → 32,5; 28,5 → 28,4; A* 4,1 → 3,6; renderer.ts:689 → 688); "~5 MB por pincelada"
  (3 a 5 MB); "52 expressões" (não contado, tirado); "~10 mil malhas" e "bloco 4×4" (não medidos,
  tirados). Fontes lidas pela Auditoria para a F2 (Immer patches, tldraw history) eu leio antes de
  implementar a F2.
- **Por leitura, a provar no jogo antes de corrigir:** ecologia repetida por placa, dente da boca
  curva, vaga pintada sobre portão, preço da prévia × cobrado, placas espelhadas, placa de cruzamento
  com degrau em via longa. Toda linha é aberta de novo antes de ser corrigida; nada se corrige pelo
  relato.

### Cobertura (última linha lida = wc -l)
As contagens de arquivos conferem com o `find` que rodei (sim 66, render 158, world 126, editor 41,
ui 40, people 10, core 25, view 5). A leitura inteira de cada arquivo é declarada pelos leitores
("última linha = wc -l"); o que eles acharam eu conferi no código como está nas seções acima, e os
quatro arquivos do editor e os de impostores, `gpuTimer` e `farForest` eu li inteiros.
| Pasta | Arquivos | Estado |
|---|---|---|
| src/sim | 66 | completo (S7) |
| src/render | 158 | completo: 113 Hook, 34 buildings S2, 11 S1 |
| main.ts, wiring, frameLoop, pools | 7 | completo (S1) |
| src/world | 126 | completo (Auditoria, 34.317 linhas, conferido por script contra o wc -l) |
| src/editor | 41 | completo: 4 por mim (2.177 linhas), 37 pelo Hook (12.802) |
| src/ui, src/people, src/core, src/view | 80 | completo (Hook; core e view lidos por ela pessoalmente) |

## Verificação
- Cada conversão: teste genérico de equivalência verde; entradas somem de `whole-map-on-revision`
  (`node scripts/check-code.mjs`); contadores do `Derived` iguais em N e 4N; zero computação em
  quadro parado.
- Fim de cada família: o jogo na fatia de 25% (`node scripts/look.mjs`), quadro e passo do sim,
  fotos examinadas uma a uma.
- Critério final: governador removido com a população cheia, 60 fps no bairro na fatia.
